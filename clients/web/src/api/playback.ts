// The player's PlaybackApi port over openapi-fetch (ADR 0005 point 2 and 4). Sessions are narrowed to the strict type.
// A session belongs to the profile that started it: every call on it carries the token StartPlayback was sent with,
// also after another tab switched the stored profile (else heartbeats get 404 and the stop is a silent no-op, and
// the old session keeps the only slot until its timeout).
import type { Middleware } from 'openapi-fetch';
import type { PlaybackApi } from '../player/types.ts';
import { call, type VideoClient } from './client.ts';
import { toPlaybackSession } from './types.ts';

/** Sessions whose token is kept: far more than one player ever opens before the oldest is long closed. */
const PINNED_SESSIONS = 32;

export function createPlaybackApi(c: VideoClient): PlaybackApi {
  /** Authorization header of each session's StartPlayback, by sessionId. */
  const pinned = new Map<string, string>();
  const pin = (sessionId: string, auth: string) => {
    pinned.delete(sessionId);
    pinned.set(sessionId, auth);
    while (pinned.size > PINNED_SESSIONS) {
      const oldest = pinned.keys().next().value;
      if (oldest === undefined) break;
      pinned.delete(oldest);
    }
  };
  // Request middleware runs after the client's own, so the session's token replaces the stored profile's.
  const asSession = (sessionId: string): { middleware?: Middleware[] } => {
    const auth = pinned.get(sessionId);
    if (!auth) return {};
    return {
      middleware: [
        {
          onRequest({ request }) {
            request.headers.set('Authorization', auth);
            return undefined;
          },
        },
      ],
    };
  };
  const at = (sessionId: string) => ({ params: { path: { sessionId } }, ...asSession(sessionId) });
  return {
    // A start that replaces a session (an automatic restart) belongs to that session's profile; the user's own
    // starts use the stored profile.
    start: async (body, opts) => {
      let auth: string | null = null;
      const capture: Middleware = {
        onRequest({ request }) {
          auth = request.headers.get('Authorization');
          return undefined;
        },
      };
      const middleware = [...((opts?.asSession !== undefined ? asSession(opts.asSession).middleware : undefined) ?? []), capture];
      const session = toPlaybackSession(await call(c.POST('/video/api/v1/playback/sessions', { body, middleware })));
      if (auth !== null) pin(session.sessionId, auth);
      return session;
    },
    reportProgress: (sessionId, body) => call(c.POST('/video/api/v1/playback/sessions/{sessionId}/progress', { ...at(sessionId), body })),
    stop: (sessionId, positionMs, opts) =>
      call(c.POST('/video/api/v1/playback/sessions/{sessionId}/stop', { ...at(sessionId), body: { positionMs: Math.max(0, Math.round(positionMs)) }, ...(opts?.keepalive ? { keepalive: true } : {}) })),
    changeTracks: async (sessionId, body) => toPlaybackSession(await call(c.POST('/video/api/v1/playback/sessions/{sessionId}/tracks', { ...at(sessionId), body: roundPosition(body) }))),
    changeVersion: async (sessionId, body) => toPlaybackSession(await call(c.POST('/video/api/v1/playback/sessions/{sessionId}/version', { ...at(sessionId), body: roundPosition(body) }))),
    reportFailure: async (sessionId, body) => toPlaybackSession(await call(c.POST('/video/api/v1/playback/sessions/{sessionId}/failure', { ...at(sessionId), body: roundPosition(body) }))),
    // Usually another profile's session (to free the slot): the stored profile's token, unless it is one of ours.
    terminate: (sessionId) => call(c.DELETE('/video/api/v1/playback/sessions/{sessionId}', at(sessionId))),
  };
}

/** Positions are integers in the contract. */
function roundPosition<T extends { positionMs?: number }>(body: T): T {
  return body.positionMs === undefined ? body : { ...body, positionMs: Math.max(0, Math.round(body.positionMs)) };
}
