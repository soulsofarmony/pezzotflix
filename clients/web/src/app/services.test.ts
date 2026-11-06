import { describe, expect, it, vi } from 'vitest';
import { VISIBLE_INTERVAL_MS } from '../api/events.ts';
import { keys } from '../api/keys.ts';
import { createServices } from './services.tsx';

describe('services', () => {
  it('a saved StopPlayback makes the item pages and rows stale, so the page the viewer goes back to offers the resume', async () => {
    let stopped = false;
    const fakeFetch = async (input: Request) => {
      if (input.method === 'POST' && input.url.endsWith('/stop')) stopped = true;
      return new Response(null, { status: 204 });
    };
    const s = createServices({ baseUrl: 'http://pzf.test', storage: null, onUnauthorized: () => undefined, fetch: fakeFetch as unknown as typeof fetch });
    const qc = s.queryClient;
    qc.setQueryData(keys.item('i1'), { id: 'i1' });
    qc.setQueryData(keys.home, { rows: [] });
    qc.setQueryData(keys.profiles, { profiles: [] });

    await s.playbackApi.stop('s1', 12_345);

    expect(stopped).toBe(true);
    await expect.poll(() => qc.getQueryState(keys.item('i1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.home)?.isInvalidated).toBe(true);
    // Unrelated queries are left alone.
    expect(qc.getQueryState(keys.profiles)?.isInvalidated).toBe(false);
  });

  it('a polled item removal is remembered with its replacement and reaches the player', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const removed = (itemId: string, replacedBy?: string) => ({ seq: polls, at: 0, type: 'library.item_removed', payload: { itemId, kind: 'movie', parentId: null, ...(replacedBy ? { replacedBy } : {}) } });
      const fakeFetch = async () => {
        polls += 1;
        const events = polls === 1 ? [] : [removed('m1', 'm2'), removed('m3')];
        return new Response(JSON.stringify({ events, nextCursor: `e${polls}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const s = createServices({ baseUrl: 'http://pzf.test', storage: null, onUnauthorized: () => undefined, fetch: fakeFetch });
      const seen: string[] = [];
      s.setActivePlayer({ hasActiveSession: () => true, onEvent: (e) => void seen.push(e.type) });
      s.poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(VISIBLE_INTERVAL_MS);
      s.poller.stop();
      expect(polls).toBe(2);
      expect(s.removals.resolve('m1')).toBe('m2');
      expect(s.removals.resolve('m3')).toBeNull();
      expect(s.removals.resolve('m2')).toBeUndefined();
      expect(seen).toEqual(['library.item_removed', 'library.item_removed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed StopPlayback rejects as before and invalidates nothing', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ type: 'x', title: 'Not found', status: 404, code: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/problem+json' } });
    const s = createServices({ baseUrl: 'http://pzf.test', storage: null, onUnauthorized: () => undefined, fetch: fakeFetch });
    s.queryClient.setQueryData(keys.item('i1'), { id: 'i1' });
    await expect(s.playbackApi.stop('s1', 0)).rejects.toBeTruthy();
    expect(s.queryClient.getQueryState(keys.item('i1'))?.isInvalidated).toBe(false);
  });
});
