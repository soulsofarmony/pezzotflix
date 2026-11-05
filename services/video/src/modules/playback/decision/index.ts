// Playback Decision Engine, pure (doc 03 §8): no I/O, no DB, no HTTP (dependency-cruiser rule).
export { decide, MAX_AUTOMATIC_ATTEMPTS, TRANSCODE_MAX_HEIGHT, TRANSCODE_MAX_WIDTH } from './engine.ts';
export { explainActions } from './explain.ts';
export { exclusionsForFile, rendersFromStream, subtitleTracks, subtitleWhenOff, type SubtitleTrack } from './subtitles.ts';
export {
  type CandidateOutcome,
  type ChoiceStrength,
  type DecideInput,
  type Decision,
  type DecisionConstraints,
  type TrackPick,
  type TrackSelection,
} from './types.ts';
