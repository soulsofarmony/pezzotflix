// The player's PlaybackApi over the real openapi-fetch client: each session keeps the profile token it was started
// with (F2 review, point 9), also when another tab switches the stored profile meanwhile.
import { describe, expect, it, vi } from 'vitest';
import { createVideoClient } from './client.ts';
import { createPlaybackApi } from './playback.ts';
import { createProfileStore } from './profileStore.ts';
import type { RawPlaybackSession } from './types.ts';

const raw = (sessionId: string): RawPlaybackSession => ({
  sessionId,
  expiresAt: 0,
  heartbeatIntervalMs: 10_000,
  itemId: 'item-1',
  fileId: 'file-1',
  mode: 'direct_play',
  reasons: [],
  stream: { protocol: 'progressive', url: `/video/media/s/${sessionId}/file`, startOffsetMs: 0, mediaTimestampOffsetMs: 0 },
  tracks: { audio: [], subtitles: [] },
  resumePositionMs: 0,
  durationMs: 1_000,
  chapters: [],
});

function setup() {
  const seen: Request[] = [];
  let next = 0;
  const fetch = vi.fn((req: Request) => {
    seen.push(req);
    if (req.method === 'POST' && new URL(req.url).pathname === '/video/api/v1/playback/sessions') {
      next += 1;
      return Promise.resolve(new Response(JSON.stringify(raw(`s${next}`)), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    }
    if (/\/(tracks|version|failure)$/.test(new URL(req.url).pathname)) {
      return Promise.resolve(new Response(JSON.stringify(raw(`s${next}`)), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const store = createProfileStore(null);
  store.set({ id: 'p1', name: 'Simone', token: 'tok-1' });
  const client = createVideoClient({ baseUrl: 'http://pzf.test', store, onUnauthorized: vi.fn(), fetch: fetch as unknown as typeof globalThis.fetch });
  const api = createPlaybackApi(client);
  const auth = () => seen.map((r) => `${r.method} ${new URL(r.url).pathname.replace('/video/api/v1/playback/sessions', '')} ${r.headers.get('Authorization') ?? '-'}`);
  return { api, store, auth };
}

const capabilities = { protocols: ['progressive'] } as never;

describe('PlaybackApi: the token of a session', () => {
  it('every call on a session carries the token it was started with, after another tab switched the profile', async () => {
    const { api, store, auth } = setup();
    const s1 = await api.start({ itemId: 'item-1', capabilities });
    // Another tab picks another profile: localStorage changes under this player.
    store.set({ id: 'p2', name: 'Giulia', token: 'tok-2' });
    await api.reportProgress(s1.sessionId, { positionMs: 1, state: 'playing', clientTs: 1 });
    await api.changeTracks(s1.sessionId, { audioTrackId: 's2', positionMs: 1 });
    await api.changeVersion(s1.sessionId, { fileId: 'file-2', positionMs: 1 });
    await api.reportFailure(s1.sessionId, { positionMs: 1, error: 'x' });
    await api.stop(s1.sessionId, 1, { keepalive: true });
    expect(auth()).toEqual([
      'POST  Bearer tok-1',
      'POST /s1/progress Bearer tok-1',
      'POST /s1/tracks Bearer tok-1',
      'POST /s1/version Bearer tok-1',
      'POST /s1/failure Bearer tok-1',
      'POST /s1/stop Bearer tok-1',
    ]);
  });

  it('an automatic restart starts under the profile of the session it replaces, and the new session keeps it (F2 review 2, point 5)', async () => {
    const { api, store, auth } = setup();
    await api.start({ itemId: 'item-1', capabilities });
    store.set({ id: 'p2', name: 'Giulia', token: 'tok-2' });
    const s2 = await api.start({ itemId: 'item-1', capabilities }, { asSession: 's1' });
    await api.reportProgress(s2.sessionId, { positionMs: 1, state: 'playing', clientTs: 1 });
    // A session it does not know (its token was never seen): the stored profile.
    await api.start({ itemId: 'item-1', capabilities }, { asSession: 'unknown' });
    expect(auth().slice(1)).toEqual(['POST  Bearer tok-1', 'POST /s2/progress Bearer tok-1', 'POST  Bearer tok-2']);
  });

  it('a 401 on a call pinned to the old profile leaves the profile another tab picked', async () => {
    const seen: string[] = [];
    const fetch = vi.fn((req: Request) => {
      seen.push(req.headers.get('Authorization') ?? '-');
      if (new URL(req.url).pathname === '/video/api/v1/playback/sessions') {
        return Promise.resolve(new Response(JSON.stringify(raw('s1')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
      }
      // The old profile was deleted meanwhile: its token no longer verifies.
      const problem = { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'UNAUTHORIZED' };
      return Promise.resolve(new Response(JSON.stringify(problem), { status: 401, headers: { 'Content-Type': 'application/problem+json' } }));
    });
    const store = createProfileStore(null);
    store.set({ id: 'p1', name: 'Simone', token: 'tok-1' });
    const onUnauthorized = vi.fn();
    const api = createPlaybackApi(createVideoClient({ baseUrl: 'http://pzf.test', store, onUnauthorized, fetch: fetch as unknown as typeof globalThis.fetch }));
    await api.start({ itemId: 'item-1', capabilities });
    store.set({ id: 'p2', name: 'Giulia', token: 'tok-2' });
    await expect(api.reportProgress('s1', { positionMs: 1, state: 'playing', clientTs: 1 })).rejects.toMatchObject({ status: 401 });
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-1']);
    expect(store.get()?.token).toBe('tok-2');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("a start of the user's own after the switch uses the new token; terminating a session it does not know uses the stored one", async () => {
    const { api, store, auth } = setup();
    await api.start({ itemId: 'item-1', capabilities });
    store.set({ id: 'p2', name: 'Giulia', token: 'tok-2' });
    const s2 = await api.start({ itemId: 'item-1', capabilities });
    await api.reportProgress(s2.sessionId, { positionMs: 1, state: 'playing', clientTs: 1 });
    await api.terminate('someone-else');
    await api.terminate('s1');
    expect(auth().slice(1)).toEqual(['POST  Bearer tok-2', 'POST /s2/progress Bearer tok-2', 'DELETE /someone-else Bearer tok-2', 'DELETE /s1 Bearer tok-1']);
  });
});
