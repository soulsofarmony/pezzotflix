// Playback engines (doc 05 §7.8.1): progressive = native <video src>, hls-fmp4 = hls.js light via MSE.
// An engine belongs to one generation of the controller; the controller ignores callbacks of older generations.
import type { FailureAction } from './failures.ts';
import type { Logger } from './types.ts';

export interface EngineCallbacks {
  /** A runtime signal of the failure table that needs the controller (never 'ignore'). */
  onFailure(action: FailureAction): void;
  /** New timelineOffsetMs (hls-fmp4, at every INIT_PTS_FOUND of the main fragments). */
  onTimelineOffset(offsetMs: number): void;
  onBufferFull(): void;
  log: Logger;
}

export interface Engine {
  readonly protocol: 'progressive' | 'hls-fmp4';
  /** Starts loading at a player time (seconds). */
  start(startS: number): void;
  /** Idempotent. */
  destroy(): void;
}
