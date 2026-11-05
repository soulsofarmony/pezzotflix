import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRetryAfter, probeUrl } from './probe.ts';

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
    expect(st).toEqual({ kind: 'status', status: 503, retryAfterMs: 4000 });
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toEqual({ Range: 'bytes=0-0' });
    expect(signal?.aborted).toBe(true);
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
