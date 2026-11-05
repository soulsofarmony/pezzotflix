// The player's PlaybackApi port over openapi-fetch (ADR 0005 point 4). Sessions are narrowed to the strict type.
import type { PlaybackApi } from '../player/types.ts';
import { call, type VideoClient } from './client.ts';
import { toPlaybackSession } from './types.ts';

export function createPlaybackApi(c: VideoClient): PlaybackApi {
  const at = (sessionId: string) => ({ params: { path: { sessionId } } });
  return {
    start: async (body) => toPlaybackSession(await call(c.POST('/video/api/v1/playback/sessions', { body }))),
    reportProgress: (sessionId, body) => call(c.POST('/video/api/v1/playback/sessions/{sessionId}/progress', { ...at(sessionId), body })),
    stop: (sessionId, positionMs, opts) =>
      call(c.POST('/video/api/v1/playback/sessions/{sessionId}/stop', { ...at(sessionId), body: { positionMs: Math.max(0, Math.round(positionMs)) }, ...(opts?.keepalive ? { keepalive: true } : {}) })),
    changeTracks: async (sessionId, body) => toPlaybackSession(await call(c.POST('/video/api/v1/playback/sessions/{sessionId}/tracks', { ...at(sessionId), body: roundPosition(body) }))),
    changeVersion: async (sessionId, body) => toPlaybackSession(await call(c.POST('/video/api/v1/playback/sessions/{sessionId}/version', { ...at(sessionId), body: roundPosition(body) }))),
    reportFailure: async (sessionId, body) => toPlaybackSession(await call(c.POST('/video/api/v1/playback/sessions/{sessionId}/failure', { ...at(sessionId), body: roundPosition(body) }))),
    terminate: (sessionId) => call(c.DELETE('/video/api/v1/playback/sessions/{sessionId}', at(sessionId))),
  };
}

/** Positions are integers in the contract. */
function roundPosition<T extends { positionMs?: number }>(body: T): T {
  return body.positionMs === undefined ? body : { ...body, positionMs: Math.max(0, Math.round(body.positionMs)) };
}
