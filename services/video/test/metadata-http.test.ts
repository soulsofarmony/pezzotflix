// Rate limiting and the provider HTTP client (ADR 0007 point 7) on a fake clock and a fake fetch:
// token bucket spacing, Retry-After for the whole host, backoff, circuit breaker, timeouts, and
// the typed outcomes. Secrets never reach a log line or an error detail.
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MAX_MS,
  backoffMs,
  BREAKER_OPEN_MS,
  createHostGate,
  createRedactor,
  type HostSpec,
  MAX_REDIRECTS,
  parseRetryAfter,
  readCapped,
  RETRY_AFTER_CAP_MS,
} from '../src/modules/metadata/http.ts';
import { semaphore, tokenBucket } from '../src/modules/metadata/limiter.ts';
import { fakeClock, fakeFetch, host } from './helpers/metadata-fetch.ts';

const SPEC: HostSpec = { name: 'test', ratePerSec: 1, burst: 1, concurrency: 1, timeoutMs: 1000 };
const URL_OK = 'https://api.example.org/ok?q=1';

function captureLog() {
  const lines: string[] = [];
  const log = pino({ level: 'trace' }, { write: (s: string) => void lines.push(s) });
  return { log, lines };
}

function gate(routes: Parameters<typeof fakeFetch>[0], spec: HostSpec = SPEC, secrets: string[] = []) {
  const clock = fakeClock();
  const fetch = fakeFetch(routes);
  const { log, lines } = captureLog();
  const g = createHostGate(spec, { fetch, clock, log, userAgent: 'Pezzotflix/0.1 (https://example.org)', secrets });
  return { g, clock, fetch, lines };
}

describe('token bucket and semaphore (fake clock)', () => {
  it('1 req/s with burst 1: requests are spaced one second apart', async () => {
    const clock = fakeClock(0);
    const b = tokenBucket({ ratePerSec: 1, burst: 1, clock });
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await b.take();
      starts.push(clock.now());
    }
    expect(starts).toEqual([0, 1000, 2000, 3000]);
  });

  it('20 req/s with burst 4: four at once, then every 50 ms', async () => {
    const clock = fakeClock(0);
    const b = tokenBucket({ ratePerSec: 20, burst: 4, clock });
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 6 }, () => b.take().then(() => starts.push(clock.now()))));
    expect(starts).toEqual([0, 0, 0, 0, 50, 100]);
  });

  it('idle time refills up to the burst only', async () => {
    const clock = fakeClock(0);
    const b = tokenBucket({ ratePerSec: 10, burst: 2, clock });
    await b.take();
    await b.take();
    clock.advance(60_000);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await b.take();
      starts.push(clock.now() - 60_000);
    }
    expect(starts).toEqual([0, 0, 100]);
  });

  it('semaphore: at most N holders, released once', async () => {
    const s = semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    let third = false;
    const p = s.acquire().then((r) => {
      third = true;
      return r;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    r1();
    r1(); // a second release is a no-op
    const r3 = await p;
    expect(third).toBe(true);
    let fourth = false;
    void s.acquire().then(() => (fourth = true));
    await Promise.resolve();
    expect(fourth).toBe(false);
    r2();
    r3();
  });
});

describe('Retry-After and backoff', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  it.each([
    [null, null],
    ['', null],
    ['7', 7000],
    ['0', 0],
    ['100000', RETRY_AFTER_CAP_MS],
    ['Thu, 05 Nov 2026 12:00:30 GMT', 30_000],
    ['Thu, 05 Nov 2026 11:00:00 GMT', 0],
    ['soon', null],
  ] as const)('parseRetryAfter(%j) = %j', (v, ms) => {
    expect(parseRetryAfter(v, now)).toBe(ms);
  });

  it.each([
    [1, 0.5, 5000],
    [2, 0.5, 10_000],
    [3, 0, 16_000],
    [3, 0.999, 23_992],
    [20, 0.5, BACKOFF_MAX_MS],
  ])('backoff #%i (random %j) = %i ms', (n, r, ms) => {
    expect(backoffMs(n, r)).toBe(ms);
  });
});

describe('host gate', () => {
  it('ok: JSON, User-Agent sent, keeps the request headers', async () => {
    const { g, fetch } = gate([{ match: host('api.example.org'), reply: () => ({ json: { a: 1 } }) }]);
    expect(await g.getJson(URL_OK, { Authorization: 'Bearer x' })).toEqual({ kind: 'ok', value: { a: 1 } });
    expect(fetch.calls[0]?.headers).toMatchObject({ 'User-Agent': 'Pezzotflix/0.1 (https://example.org)', Authorization: 'Bearer x', Accept: 'application/json' });
    expect(g.health()).toBe('ok');
  });

  it.each([
    [404, { kind: 'not_found' }],
    [401, { kind: 'unauthorized' }],
    [400, { kind: 'invalid_request', detail: 'test: HTTP 400' }],
    [422, { kind: 'invalid_request', detail: 'test: HTTP 422' }],
    [500, { kind: 'unavailable', detail: 'test: HTTP 500' }],
    [502, { kind: 'unavailable', detail: 'test: HTTP 502' }],
    [503, { kind: 'unavailable', detail: 'test: HTTP 503' }],
  ])('HTTP %i → %j', async (status, outcome) => {
    const { g } = gate([{ match: host('api.example.org'), reply: () => ({ status }) }]);
    expect(await g.getJson(URL_OK)).toEqual(outcome);
  });

  it('429 with Retry-After pauses the whole host: later calls do not reach the network', async () => {
    let n = 0;
    const { g, fetch, clock } = gate([{ match: host('api.example.org'), reply: () => (n++ === 0 ? { status: 429, headers: { 'Retry-After': '30' } } : { json: { ok: true } }) }]);
    expect(await g.getJson(URL_OK)).toEqual({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(g.health()).toBe('degraded');
    clock.advance(10_000);
    expect(await g.getJson('https://api.example.org/other')).toEqual({ kind: 'rate_limited', retryAfterMs: 20_000 });
    expect(fetch.calls).toHaveLength(1);
    clock.advance(20_000);
    expect(await g.getJson(URL_OK)).toEqual({ kind: 'ok', value: { ok: true } });
    expect(g.health()).toBe('ok');
  });

  it('503 with Retry-After (HTTP date) is a rate limit too', async () => {
    const { g, clock } = gate([{ match: host('api.example.org'), reply: () => ({ status: 503, headers: { 'Retry-After': new Date(clock.now() + 12_000).toUTCString() } }) }]);
    const r = await g.getJson(URL_OK);
    expect(r.kind).toBe('rate_limited');
    expect((r as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(10_000);
    expect((r as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(12_000);
  });

  it('429 without Retry-After: exponential backoff from 5 s', async () => {
    const { g, clock } = gate([{ match: host('api.example.org'), reply: () => ({ status: 429 }) }]);
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = (await g.getJson(URL_OK)) as { retryAfterMs: number };
      waits.push(r.retryAfterMs);
      clock.advance(r.retryAfterMs);
    }
    expect(waits).toEqual([5000, 10_000, 20_000]);
  });

  it('timeouts and network errors are unavailable; 5 in a row open the circuit for a minute', async () => {
    let mode: 'timeout' | 'network' | 'ok' = 'timeout';
    const { g, fetch, clock } = gate([{ match: host('api.example.org'), reply: () => (mode === 'ok' ? { json: {} } : { error: mode }) }]);
    expect(await g.getJson(URL_OK)).toEqual({ kind: 'unavailable', detail: 'test: timeout after 1000 ms' });
    mode = 'network';
    expect(await g.getJson(URL_OK)).toEqual({ kind: 'unavailable', detail: 'test: network error' });
    for (let i = 0; i < 3; i++) await g.getJson(URL_OK);
    expect(fetch.calls).toHaveLength(5);
    mode = 'ok';
    expect(await g.getJson(URL_OK)).toEqual({ kind: 'unavailable', detail: 'test: circuit open' });
    expect(fetch.calls).toHaveLength(5);
    expect(g.health()).toBe('degraded');
    clock.advance(BREAKER_OPEN_MS);
    expect(await g.getJson(URL_OK)).toEqual({ kind: 'ok', value: {} });
    expect(g.health()).toBe('ok');
  });

  it('a body that is not JSON is unavailable', async () => {
    const { g } = gate([{ match: host('api.example.org'), reply: () => ({ bytes: Buffer.from('<html>'), contentType: 'text/html' }) }]);
    expect(await g.getJson(URL_OK)).toEqual({ kind: 'unavailable', detail: 'test: response is not JSON' });
  });

  it('bytes: content type without parameters; too large is rejected', async () => {
    const { g } = gate([
      { match: host('img.example.org', '/a.jpg'), reply: () => ({ bytes: Buffer.from([1, 2, 3]), contentType: 'image/jpeg; charset=binary' }) },
      { match: host('img.example.org', '/big.jpg'), reply: () => ({ bytes: Buffer.alloc(2000), contentType: 'image/jpeg' }) },
    ]);
    expect(await g.getBytes('https://img.example.org/a.jpg')).toEqual({ kind: 'ok', value: { bytes: Buffer.from([1, 2, 3]), contentType: 'image/jpeg' } });
    expect(await g.getBytes('https://img.example.org/big.jpg', {}, 1000)).toEqual({ kind: 'invalid_request', detail: 'test: image too large' });
  });

  it('logs carry host and path, never headers, query or secrets', async () => {
    const secret = 'eyJhbGciOiJIUzI1NiJ9.SECRET-TOKEN-VALUE';
    const { g, lines } = gate(
      [
        { match: host('api.example.org', '/ok'), reply: () => ({ json: {} }) },
        { match: host('api.example.org', '/boom'), reply: () => ({ error: 'network' }) },
        { match: host('api.example.org', '/limited'), reply: () => ({ status: 429, headers: { 'Retry-After': '1' } }) },
      ],
      SPEC,
      [secret],
    );
    await g.getJson(`${URL_OK}&secret=${secret}`, { Authorization: `Bearer ${secret}` });
    const failed = await g.getJson('https://api.example.org/boom', { Authorization: `Bearer ${secret}` });
    await g.getJson('https://api.example.org/limited', { Authorization: `Bearer ${secret}` });
    const all = lines.join('\n');
    expect(all).toContain('api.example.org/ok');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('Authorization');
    expect(all).not.toContain('q=1');
    expect(JSON.stringify(failed)).not.toContain(secret);
  });

  it('the redactor hides every secret occurrence', () => {
    const r = createRedactor(['abcd1234', 'xy']);
    expect(r('a abcd1234 b abcd1234 xy')).toBe('a [REDACTED] b [REDACTED] xy');
  });
});

describe('body caps and redirects', () => {
  it('readCapped: the body up to the cap, null past it (counted while streaming, no Content-Length)', async () => {
    expect((await readCapped(new Response('x'.repeat(100)), 200))?.length).toBe(100);
    expect(await readCapped(new Response('x'.repeat(100)), 50)).toBeNull();
    expect(await readCapped(new Response('x', { headers: { 'content-length': '999' } }), 50)).toBeNull();
  });

  it('getBytes refuses an image past its cap even without Content-Length', async () => {
    const { g } = gate([{ match: () => true, reply: () => ({ bytes: Buffer.alloc(2048), contentType: 'image/jpeg' }) }]);
    expect(await g.getBytes('https://img.example.org/a.jpg', {}, 1024)).toEqual({ kind: 'invalid_request', detail: 'test: image too large' });
    expect((await g.getBytes('https://img.example.org/a.jpg', {}, 4096)).kind).toBe('ok');
  });

  it('a redirect is refused on a gate without redirect hosts (the TMDB and Wikidata APIs)', async () => {
    const { g, fetch } = gate([
      { match: (u) => u.host === 'api.example.org', reply: () => ({ status: 302, headers: { location: 'https://elsewhere.example.org/x' } }) },
      { match: () => true, reply: () => ({ json: { leaked: true } }) },
    ]);
    expect(await g.getJson(URL_OK)).toEqual({ kind: 'invalid_request', detail: 'test: redirect refused' });
    expect(fetch.calls.map((c) => new URL(c.url).host)).toEqual(['api.example.org']);
  });

  it('Commons-style gate: redirects followed only to allowed https hosts, at most MAX_REDIRECTS', async () => {
    const spec: HostSpec = { ...SPEC, redirectHosts: /^(?:[a-z0-9-]+\.)*wikimedia\.org$/ };
    const { g, fetch } = gate(
      [
        { match: (u) => u.pathname === '/wiki/Special:FilePath/A.jpg', reply: () => ({ status: 302, headers: { location: 'https://upload.wikimedia.org/a.jpg' } }) },
        { match: (u) => u.pathname === '/wiki/Special:FilePath/B.jpg', reply: () => ({ status: 302, headers: { location: 'https://evil.example.org/b.jpg' } }) },
        { match: (u) => u.pathname === '/wiki/Special:FilePath/C.jpg', reply: () => ({ status: 302, headers: { location: 'http://upload.wikimedia.org/c.jpg' } }) },
        { match: (u) => u.pathname.startsWith('/loop'), reply: (u) => ({ status: 302, headers: { location: `https://commons.wikimedia.org${u.pathname}x` } }) },
        { match: (u) => u.host === 'upload.wikimedia.org', reply: () => ({ bytes: Buffer.from('img'), contentType: 'image/jpeg' }) },
      ],
      spec,
    );
    expect((await g.getBytes('https://commons.wikimedia.org/wiki/Special:FilePath/A.jpg')).kind).toBe('ok');
    expect(fetch.calls.map((c) => c.url)).toEqual(['https://commons.wikimedia.org/wiki/Special:FilePath/A.jpg', 'https://upload.wikimedia.org/a.jpg']);
    expect((await g.getBytes('https://commons.wikimedia.org/wiki/Special:FilePath/B.jpg')).kind).toBe('invalid_request');
    expect((await g.getBytes('https://commons.wikimedia.org/wiki/Special:FilePath/C.jpg')).kind).toBe('invalid_request');
    const before = fetch.calls.length;
    expect((await g.getBytes('https://commons.wikimedia.org/loop')).kind).toBe('invalid_request');
    expect(fetch.calls.length - before).toBe(1 + MAX_REDIRECTS);
    expect(fetch.calls.every((c) => !new URL(c.url).host.endsWith('example.org'))).toBe(true);
  });
});
