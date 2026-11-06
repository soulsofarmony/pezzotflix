// Status of a media or subtitle url, for errors that carry none (<video>, <track>, libpgs): a one-byte Range
// request, aborted as soon as the headers arrive, because a growing resource may stream without an end; only
// an error answer's Problem body (small, complete) is read, for its code.
// Session urls carry their token, so no header is needed (doc 03: native players cannot set one).

export type UrlStatus =
  /** code: the contract Problem.code of an error answer (e.g. MEDIA_UNAVAILABLE or STREAM_PREPARING), null without one. */
  | { kind: 'status'; status: number; retryAfterMs: number | null; code: string | null }
  /** No headers within the time limit: e.g. a queued subtitle extraction that holds the response open. */
  | { kind: 'timeout' }
  /** No answer at all (the network). */
  | { kind: 'error'; error: string };

export const PROBE_TIMEOUT_MS = 10_000;

/** Retry-After in seconds or as an HTTP date, in ms; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000));
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** The code of an error answer's Problem body (application/problem+json); null for a success or any other body. */
export async function problemCode(res: Response): Promise<string | null> {
  if (res.ok || !/json/i.test(res.headers.get('Content-Type') ?? '')) return null;
  try {
    const body: unknown = await res.json();
    const code = body !== null && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export async function probeUrl(url: string, fetchFn: typeof fetch, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<UrlStatus> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetchFn(url, { headers: { Range: 'bytes=0-0' }, signal: ctrl.signal, cache: 'no-store' });
    return { kind: 'status', status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('Retry-After')), code: await problemCode(res) };
  } catch (e) {
    return timedOut ? { kind: 'timeout' } : { kind: 'error', error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    // Only the status was needed: drop the body.
    ctrl.abort();
  }
}
