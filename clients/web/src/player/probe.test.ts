import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRetryAfter, problemCode, probeUrl } from './probe.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('parseRetryAfter', () => {
  it.each([
    ['3', 3000],
    ['0', 0],
    ['1.5', 1500],
    ['', null],
    ['soon', null],
  ])('%j → %s', (v, ms) => {
    expect(parseRetryAfter(v)).toBe(ms);
  });

  it('reads an HTTP date and never goes negative', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    expect(parseRetryAfter('Thu, 05 Nov 2026 10:00:04 GMT', now)).toBe(4000);
    expect(parseRetryAfter('Thu, 05 Nov 2026 09:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('probeUrl', () => {
  it('asks one byte, returns status and Retry-After, and drops the body', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(new Response(null, { status: 503, headers: { 'Retry-After': '4' } }));
    });
    const st = await probeUrl('/video/media/s/tok/subtitles/3.sup', fetchFn as unknown as typeof fetch);
    expect(st).toEqual({ kind: 'status', status: 503, retryAfterMs: 4000, code: null });
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toEqual({ Range: 'bytes=0-0' });
    expect(signal?.aborted).toBe(true);
  });

  it("reads the code of an error answer's Problem body, never the body of a success", async () => {
    const problem = (code: unknown, type = 'application/problem+json') =>
      new Response(JSON.stringify({ type: 'about:blank', title: 'x', status: 503, code }), { status: 503, headers: { 'Content-Type': type } });
    const at = (res: Response) => probeUrl('/x', () => Promise.resolve(res));
    expect(await at(problem('MEDIA_UNAVAILABLE'))).toMatchObject({ status: 503, code: 'MEDIA_UNAVAILABLE' });
    expect(await at(problem('STREAM_PREPARING', 'application/json; charset=utf-8'))).toMatchObject({ code: 'STREAM_PREPARING' });
    expect(await at(problem(42))).toMatchObject({ code: null });
    expect(await at(problem('MEDIA_UNAVAILABLE', 'text/plain'))).toMatchObject({ code: null });
    expect(await at(new Response('{not json', { status: 503, headers: { 'Content-Type': 'application/problem+json' } }))).toMatchObject({ code: null });
    // A growing 206 may never end: its body is not read.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(1));
      },
    });
    const ok = new Response(endless, { status: 206, headers: { 'Content-Type': 'application/json' } });
    expect(await at(ok)).toEqual({ kind: 'status', status: 206, retryAfterMs: null, code: null });
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it('problemCode: null for a success', async () => {
    expect(await problemCode(new Response('{"code":"X"}', { status: 200, headers: { 'Content-Type': 'application/json' } }))).toBeNull();
  });

  it('no answer is an error; no headers in time is a timeout', async () => {
    const down = await probeUrl('/x', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(down).toEqual({ kind: 'error', error: 'Failed to fetch' });

    vi.useFakeTimers();
    const hanging = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const p = probeUrl('/x', hanging, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ kind: 'timeout' });
  });
});
