import { describe, expect, it } from 'vitest';
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

  it('a failed StopPlayback rejects as before and invalidates nothing', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ type: 'x', title: 'Not found', status: 404, code: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/problem+json' } });
    const s = createServices({ baseUrl: 'http://pzf.test', storage: null, onUnauthorized: () => undefined, fetch: fakeFetch });
    s.queryClient.setQueryData(keys.item('i1'), { id: 'i1' });
    await expect(s.playbackApi.stop('s1', 0)).rejects.toBeTruthy();
    expect(s.queryClient.getQueryState(keys.item('i1'))?.isInvalidated).toBe(false);
  });
});
