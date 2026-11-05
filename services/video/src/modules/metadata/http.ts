// HTTP client of the provider adapters (ADR 0007 point 7): per-host token bucket and concurrency,
// Retry-After honoured for the whole host, exponential backoff, circuit breaker, timeouts, and
// typed outcomes. Native fetch keeps one persistent connection per host (keep-alive).
// Secrets (the TMDB token) only travel in headers, which are never logged nor put in a message.
import type { FastifyBaseLogger } from 'fastify';
import { type Clock, semaphore, type Semaphore, tokenBucket, type TokenBucket } from './limiter.ts';

export interface HostSpec {
  name: string;
  ratePerSec: number;
  burst: number;
  concurrency: number;
  timeoutMs: number;
  /**
   * Hosts a redirect may lead to (followed by hand, at most MAX_REDIRECTS, https only). Absent: a
   * redirect is refused, as for the TMDB and Wikidata APIs.
   */
  redirectHosts?: RegExp;
}

export type HttpOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'not_found' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'unauthorized' }
  | { kind: 'invalid_request'; detail: string }
  | { kind: 'unavailable'; detail: string };

export interface Bytes {
  bytes: Buffer;
  contentType: string;
}

export interface HostGate {
  readonly spec: HostSpec;
  /** 'degraded' while the circuit is open, the host is paused or the last call failed. */
  health(): 'ok' | 'degraded';
  getJson(url: string, headers?: Record<string, string>): Promise<HttpOutcome<unknown>>;
  getBytes(url: string, headers?: Record<string, string>, maxBytes?: number): Promise<HttpOutcome<Bytes>>;
}

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'manual' }) => Promise<Response>;

/** Retry-After is capped (ADR 0007 point 7). */
export const RETRY_AFTER_CAP_MS = 10 * 60_000;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_MS = 60_000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** wbgetentities batches and WDQS answers stay well below this; anything larger is refused. */
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

/** The body, or null as soon as it passes max bytes (the stream is cancelled there). */
export async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (Number(res.headers.get('content-length') ?? '0') > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value: Uint8Array = chunk.value;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/** Retry-After in seconds or as an HTTP date, in ms from now; null if absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(RETRY_AFTER_CAP_MS, Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - now));
}

/** Backoff of the n-th consecutive rate limit without Retry-After (n ≥ 1): 5 s doubling to 5 min, ±20%. */
export function backoffMs(n: number, random: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (n - 1));
  return Math.round(base * (0.8 + 0.4 * random));
}

export interface HttpDeps {
  fetch: FetchFn;
  clock: Clock;
  log: FastifyBaseLogger;
  userAgent: string;
  /** Values that must never appear in a log line or an error detail. */
  secrets: readonly string[];
}

export function createRedactor(secrets: readonly string[]): (s: string) => string {
  const list = secrets.filter((s) => s.length >= 4);
  return (s) => list.reduce((acc, secret) => acc.split(secret).join('[REDACTED]'), s);
}

/** Path of a URL without its query, for logs. */
const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '<bad url>';
  }
};

export function createHostGate(spec: HostSpec, deps: HttpDeps): HostGate {
  const { clock, log } = deps;
  const redact = createRedactor(deps.secrets);
  const bucket: TokenBucket = tokenBucket({ ratePerSec: spec.ratePerSec, burst: spec.burst, clock });
  const slots: Semaphore = semaphore(spec.concurrency);
  let pausedUntil = 0;
  let rateLimitStreak = 0;
  let failures = 0;
  let openUntil = 0;
  let lastFailed = false;

  const fail = (detail: string): HttpOutcome<never> => {
    failures++;
    lastFailed = true;
    if (failures >= BREAKER_FAILURES) openUntil = clock.now() + BREAKER_OPEN_MS;
    return { kind: 'unavailable', detail: redact(`${spec.name}: ${detail}`) };
  };
  const succeeded = () => {
    failures = 0;
    rateLimitStreak = 0;
    lastFailed = false;
  };

  /** Where a redirect may go: an https URL on an allowed host, within MAX_REDIRECTS; else null. */
  function redirectTarget(from: string, location: string, hop: number): string | null {
    if (!spec.redirectHosts || hop >= MAX_REDIRECTS) return null;
    try {
      const u = new URL(location, from);
      return u.protocol === 'https:' && spec.redirectHosts.test(u.hostname) ? u.toString() : null;
    } catch {
      return null;
    }
  }

  async function request<T>(url: string, headers: Record<string, string>, read: (r: Response) => Promise<HttpOutcome<T>>): Promise<HttpOutcome<T>> {
    if (clock.now() < openUntil) return { kind: 'unavailable', detail: `${spec.name}: circuit open` };
    if (clock.now() < pausedUntil) return { kind: 'rate_limited', retryAfterMs: pausedUntil - clock.now() };
    const release = await slots.acquire();
    try {
      await bucket.take();
      // A 429 seen by another request while this one waited pauses it too.
      if (clock.now() < pausedUntil) return { kind: 'rate_limited', retryAfterMs: pausedUntil - clock.now() };
      const started = clock.now();
      let res: Response;
      try {
        const signal = AbortSignal.timeout(spec.timeoutMs);
        const init = { headers: { 'User-Agent': deps.userAgent, ...headers }, signal, redirect: 'manual' as const };
        res = await deps.fetch(url, init);
        for (let hop = 0; res.status >= 300 && res.status < 400 && res.headers.has('location'); hop++) {
          const next = redirectTarget(url, res.headers.get('location') ?? '', hop);
          await res.body?.cancel().catch(() => undefined);
          if (!next) {
            log.debug({ host: spec.name, path: pathOf(url), status: res.status }, 'provider redirect refused');
            succeeded();
            return { kind: 'invalid_request', detail: `${spec.name}: redirect refused` };
          }
          url = next;
          res = await deps.fetch(url, init);
        }
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const timedOut = name === 'TimeoutError' || name === 'AbortError';
        log.debug({ host: spec.name, path: pathOf(url), err: timedOut ? 'timeout' : redact(String((err as Error)?.message ?? err)) }, 'provider request failed');
        return fail(timedOut ? `timeout after ${spec.timeoutMs} ms` : 'network error');
      }
      log.debug({ host: spec.name, path: pathOf(url), status: res.status, ms: clock.now() - started }, 'provider request');
      const s = res.status;
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), clock.now());
      if (s === 429 || (s === 503 && retryAfter !== null)) {
        rateLimitStreak++;
        const wait = retryAfter ?? backoffMs(rateLimitStreak, clock.random());
        pausedUntil = Math.max(pausedUntil, clock.now() + wait);
        lastFailed = true;
        await res.body?.cancel().catch(() => undefined);
        log.info({ host: spec.name, status: s, retryAfterMs: wait }, 'provider rate limited: host paused');
        return { kind: 'rate_limited', retryAfterMs: wait };
      }
      if (s >= 200 && s < 300) {
        const out = await read(res);
        if (out.kind === 'unavailable') return fail(out.detail);
        succeeded();
        return out;
      }
      await res.body?.cancel().catch(() => undefined);
      if (s === 404) {
        succeeded();
        return { kind: 'not_found' };
      }
      if (s === 401) {
        lastFailed = true;
        return { kind: 'unauthorized' };
      }
      if (s >= 500 || s === 403 || s === 408) return fail(`HTTP ${s}`);
      succeeded();
      return { kind: 'invalid_request', detail: `${spec.name}: HTTP ${s}` };
    } finally {
      release();
    }
  }

  return {
    spec,
    health: () => (clock.now() < openUntil || clock.now() < pausedUntil || lastFailed ? 'degraded' : 'ok'),
    getJson: (url, headers = {}) =>
      request(url, { Accept: 'application/json', ...headers }, async (res) => {
        let body: Buffer | null;
        try {
          body = await readCapped(res, MAX_JSON_BYTES);
        } catch {
          return { kind: 'unavailable', detail: 'body read failed' };
        }
        if (!body) return { kind: 'invalid_request', detail: `${spec.name}: response too large` };
        try {
          return { kind: 'ok', value: JSON.parse(body.toString('utf8')) as unknown };
        } catch {
          return { kind: 'unavailable', detail: 'response is not JSON' };
        }
      }),
    getBytes: (url, headers = {}, maxBytes = MAX_IMAGE_BYTES) =>
      request(url, headers, async (res) => {
        const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        try {
          const bytes = await readCapped(res, maxBytes);
          if (!bytes) return { kind: 'invalid_request', detail: `${spec.name}: image too large` };
          return { kind: 'ok', value: { bytes, contentType } };
        } catch {
          return { kind: 'unavailable', detail: 'body read failed' };
        }
      }),
  };
}
