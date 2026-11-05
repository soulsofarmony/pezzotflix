// Port and shared types of the player engine (ADR 0005 point 4). The player is plain TypeScript: it talks to the
// server only through PlaybackApi, which the app implements over openapi-fetch.
import type {
  ActiveSession,
  ChangeTracksRequest,
  ClientCapabilities,
  FallbackRequest,
  PlaybackSession,
  ProgressReport,
  StartPlaybackRequest,
  Suspect,
} from '../api/types.ts';

export type { ClientCapabilities, PlaybackSession, Suspect };

/**
 * Error of a PlaybackApi call: HTTP status (0 when no answer came), stable problem code, Retry-After in ms.
 * ApiError of src/api satisfies it.
 */
export interface PlaybackApiError {
  status: number;
  code: string;
  detail: string | null;
  retryAfterMs: number | null;
  activeSessions: ActiveSession[];
  /** Problem extension of ChangeTracks/ChangeVersion 422s: the refusal also closed the session. */
  sessionClosed?: boolean;
}

export function isPlaybackApiError(e: unknown): e is PlaybackApiError {
  return typeof e === 'object' && e !== null && typeof (e as PlaybackApiError).status === 'number' && typeof (e as PlaybackApiError).code === 'string';
}

export interface PlaybackApi {
  start(body: StartPlaybackRequest): Promise<PlaybackSession>;
  reportProgress(sessionId: string, body: ProgressReport): Promise<void>;
  /** keepalive: the request must survive the page going away (pagehide). */
  stop(sessionId: string, positionMs: number, opts?: { keepalive?: boolean }): Promise<void>;
  changeTracks(sessionId: string, body: ChangeTracksRequest): Promise<PlaybackSession>;
  changeVersion(sessionId: string, body: { fileId: string; positionMs?: number }): Promise<PlaybackSession>;
  reportFailure(sessionId: string, body: FallbackRequest): Promise<PlaybackSession>;
  terminate(sessionId: string): Promise<void>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

export const consoleLogger: Logger = (level, msg, data) => {
  // The player's diagnostic log goes to the browser console, the place where a support check looks first.
  const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
  fn.call(console, `[player] ${msg}`, data ?? '');
};
