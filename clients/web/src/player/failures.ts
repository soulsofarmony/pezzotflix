// Failure table of the player (doc 04 §8, doc 05 §7.8.5). Pure: each runtime signal becomes one action.
import type { Suspect } from '../api/types.ts';
import { suspectFromCodecs } from './preflight.ts';
import type { UrlStatus } from './probe.ts';

export type FailureAction =
  /** Nothing to do: hls.js retries, or the signal is not a plan failure. */
  | { kind: 'ignore'; note?: 'buffer_full' | 'stalled' }
  /** Stop the engine and call reportPlaybackFailure, then play the returned session. */
  | { kind: 'replan'; suspect: Suspect; error: string }
  /** The session is closed on the data plane (401, 403, 404, 410): stopPlayback, then StartPlayback from here. */
  | { kind: 'restart'; error: string }
  /**
   * The engine is dead but the plan may be fine: recreate it on the same stream, once per stream. When the stream
   * already had its reload, the controller re-plans with `suspect` instead.
   */
  | { kind: 'reload'; error: string; suspect: Suspect }
  /** The network is gone: no automatic attempt, the user retries. */
  | { kind: 'network'; error: string };

/** The fields of hls.js ErrorData the table reads. */
export interface HlsErrorLike {
  type: string;
  details: string;
  fatal: boolean;
  sourceBufferName?: string | undefined;
  response?: { code?: number | undefined } | undefined;
  networkDetails?: unknown;
}

const SESSION_CLOSED = new Set([401, 403, 404, 410]);

/**
 * A 5xx of the data plane other than 503 (500 STREAM_FAILED, ADR 0003): the stream cannot be produced, retrying
 * the same url is useless. 503 is "not ready yet" (STREAM_PREPARING, or the gateway while the service restarts):
 * the contract says retry, so hls.js keeps its retries for it.
 */
export function isFailedStream(status: number): boolean {
  return status >= 500 && status !== 503;
}

function httpStatus(e: HlsErrorLike): number | null {
  const code = e.response?.code;
  if (typeof code === 'number' && code > 0) return code;
  const xhr = e.networkDetails as { status?: unknown } | null | undefined;
  return xhr && typeof xhr.status === 'number' && xhr.status > 0 ? xhr.status : null;
}

/**
 * `mediaElementError`: the <video> has an error set (video.error). hls.js 1.7.4 turns a stall into a fatal error
 * after nudgeMaxRetry, and mediaSourceRequiresReset can be fatal too: both get one reload, then a re-plan.
 */
export function classifyHlsError(e: HlsErrorLike, mimeType: string | null, isTypeSupported: ((t: string) => boolean) | null, mediaElementError = false): FailureAction {
  const decompose = (): Suspect => (mimeType ? suspectFromCodecs(mimeType, isTypeSupported) : 'unknown');

  if (e.details === 'bufferFullError') return { kind: 'ignore', note: 'buffer_full' };
  if (e.details === 'bufferStalledError' || e.details === 'bufferNudgeOnStall' || e.details === 'bufferSeekOverHole') {
    return e.fatal ? { kind: 'reload', error: e.details, suspect: 'unknown' } : { kind: 'ignore', note: 'stalled' };
  }
  if (e.details === 'mediaSourceRequiresReset') {
    if (!e.fatal) return { kind: 'ignore' };
    // A decoder error on the element is not cured by a reload.
    return mediaElementError ? { kind: 'replan', suspect: decompose(), error: e.details } : { kind: 'reload', error: e.details, suspect: decompose() };
  }

  if (e.type === 'networkError') {
    const status = httpStatus(e);
    if (status !== null && SESSION_CLOSED.has(status)) return { kind: 'restart', error: `HTTP_${status}` };
    // Already on the first, non-fatal error: with a single level hls.js retries a fragment up to six times
    // (about 31 s) whatever shouldRetry says, and a failed stream does not get better.
    if (status !== null && isFailedStream(status)) return { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' };
    if (!e.fatal) return { kind: 'ignore' };
    if (status !== null && status >= 500) return { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' };
    return { kind: 'network', error: e.details };
  }

  if (!e.fatal) return { kind: 'ignore' };

  switch (e.details) {
    case 'bufferAddCodecError':
    case 'bufferIncompatibleCodecsError': {
      const sb = e.sourceBufferName;
      const suspect: Suspect = sb === 'audio' ? 'audio' : sb === 'video' ? 'video' : sb === 'audiovideo' ? decompose() : 'unknown';
      return { kind: 'replan', suspect, error: e.details };
    }
    case 'bufferAppendError':
    case 'fragParsingError':
    case 'manifestIncompatibleCodecsError':
      return { kind: 'replan', suspect: decompose(), error: e.details };
    default:
      return { kind: 'replan', suspect: 'unknown', error: e.details };
  }
}

/** HTMLMediaElement error codes (MediaError). */
export const MEDIA_ERR = { ABORTED: 1, NETWORK: 2, DECODE: 3, SRC_NOT_SUPPORTED: 4 } as const;

/**
 * <video> errors in progressive. MEDIA_ERR_NETWORK: one new attempt by the browser (reload), the second becomes a
 * replan with unknown, like a fatal 5xx in hls.js.
 */
export function classifyMediaError(code: number, audioDecoded: boolean | null, networkRetried: boolean): FailureAction {
  switch (code) {
    case MEDIA_ERR.SRC_NOT_SUPPORTED:
      return { kind: 'replan', suspect: 'container', error: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
    case MEDIA_ERR.DECODE:
      return { kind: 'replan', suspect: audioDecoded ? 'video' : 'unknown', error: 'MEDIA_ERR_DECODE' };
    case MEDIA_ERR.NETWORK:
      return networkRetried ? { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' } : { kind: 'reload', error: 'MEDIA_ERR_NETWORK', suspect: 'unknown' };
    default:
      return { kind: 'ignore' };
  }
}

/**
 * Progressive: what the status of the media url says about a <video> error (NETWORK or SRC_NOT_SUPPORTED, which
 * carry no status). The same table as hls.js: closed session → restart, 5xx → re-plan, no answer → network.
 * Null: the url answers, so the element's own error decides.
 */
export function classifyProbe(st: UrlStatus): FailureAction | null {
  if (st.kind === 'error') return { kind: 'network', error: st.error };
  if (st.kind === 'timeout') return null;
  if (SESSION_CLOSED.has(st.status)) return { kind: 'restart', error: `HTTP_${st.status}` };
  if (st.status >= 500) return { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' };
  return null;
}

/** Non-standard audio counters of the element (S2): null when the browser has neither. */
export function audioDecoded(video: object): boolean | null {
  const v = video as { webkitAudioDecodedByteCount?: unknown; mozHasAudio?: unknown };
  if (typeof v.webkitAudioDecodedByteCount === 'number') return v.webkitAudioDecodedByteCount > 0;
  if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio;
  return null;
}

/** Automatic attempts per StartPlayback, re-plans and restarts together (doc 04 §8). */
export const MAX_AUTOMATIC_ATTEMPTS = 3;
