// Input and output of the Playback Decision Engine (doc 03 §8 PlaybackDecision, doc 04 §3).
// Plain data both ways: the engine is pure, so explain and re-plan are reproducible.
import type { DeliveryMode, PlanExclusion, PlanReason, PlaybackPlan } from '../../../shared/playback-plan.ts';
import type { ClientCapabilities, PlayableFile, ProfilePlaybackPrefs } from '../../../shared/ports.ts';

/**
 * How firmly a track choice holds (doc 04 §3.1):
 * - explicit: chosen by the user (StartPlayback, ChangeTracks). On its file it is hard: honoured or
 *   the plan fails (audio) or reports the track as dropped (subtitles).
 * - remembered: the profile's last choice (step 2) or a choice carried over by the server. Soft: a
 *   commentary or audio description is demoted as in the prefs ranking, a track without a format
 *   falls back to the next one (P1), and it never causes NO_COMPATIBLE_PLAN.
 */
export type ChoiceStrength = 'explicit' | 'remembered';

/**
 * One track choice. Track ids are file-local: trackId applies to `fileId` only (null: to any file
 * that has it). On any other file the track is matched by its descriptor (language, codec, channels
 * and roles), always as a remembered choice; when nothing matches, the prefs decide.
 */
export interface TrackPick<Id extends string | null = string> {
  trackId: Id;
  fileId: string | null;
  strength: ChoiceStrength;
}

/**
 * Track choice for a decision. Each pick carries its own file, because a StartPlayback can mix an
 * explicit track of the request with a remembered one from another version.
 */
export interface TrackSelection {
  audio?: TrackPick;
  /**
   * trackId null: off, no full subtitles (the forced track in the audio language is still shown).
   * Absent: from the profile prefs.
   */
  subtitle?: TrackPick<string | null>;
  /** A remembered audio language ranked before the profile's (ChangeVersion keeps the explicit one). */
  audioLanguage?: string;
}

/** Resource state the engine cannot know by itself (P4). */
export interface DecisionConstraints {
  /** available: MAX_TRANSCODES > 0 and a slot is free; disabled: MAX_TRANSCODES = 0; busy: every slot is taken. */
  transcode: 'available' | 'disabled' | 'busy';
  /** VBV max rate of a 1920×1080 Transcode; smaller outputs get a proportional share. */
  transcodeMaxBitrateBps: number;
}

export interface DecideInput {
  /** Every file linked to the item (Domain Model D2), available or not. */
  files: readonly PlayableFile[];
  /** Only this file is a candidate (StartPlayback.fileId, ChangeVersion, a pinned re-plan). */
  fileId?: string;
  /** As declared, after the server-side overrides (doc 03 I2). */
  capabilities: ClientCapabilities;
  prefs: ProfilePlaybackPrefs;
  selection: TrackSelection;
  /** Requested or resume position on the original timeline; clamped to the file duration. */
  startPositionMs: number;
  /** StartPlayback.forceMode, diagnostics only. */
  forceMode?: DeliveryMode;
  constraints: DecisionConstraints;
  /** Formats excluded by earlier failures of the session (doc 04 §8). */
  exclusions: readonly PlanExclusion[];
}

/** One evaluated file, for ExplainPlaybackDecision.candidates. */
export interface CandidateOutcome {
  fileId: string;
  /** null: no mode works for this file. */
  mode: DeliveryMode | null;
  reasons: PlanReason[];
}

export type Decision =
  | {
      ok: true;
      plan: PlaybackPlan;
      candidates: CandidateOutcome[];
      /** An explicitly chosen subtitle track that no treatment can show (doc 04 §8 subtitle row), else null. */
      droppedSubtitleTrackId: string | null;
    }
  | { ok: false; code: 'NO_COMPATIBLE_PLAN' | 'MEDIA_UNAVAILABLE'; reasons: PlanReason[]; candidates: CandidateOutcome[] };
