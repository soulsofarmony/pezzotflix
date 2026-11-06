// The segmenter's grouping rule (ADR 0003 D4), pure. ffmpeg writes one fragment per video keyframe; a
// run for segment k starts one GOP early (pre-roll). Fragments are placed by the PTS of their keyframe on
// the original timeline (tfdt + composition offset of the first sample, minus the constant offset), never
// by tfdt: on an open GOP the tfdt comes about 125 ms before the keyframe PTS (t4).
import { type InitInfo, isSyncSample, parseMoof } from './bmff.ts';
import { OUTPUT_TS_OFFSET_MS } from './ffmpeg-args.ts';

/** ADR 0003 D4: the first kept keyframe must be Bₖ within 1 ms. */
export const KEYFRAME_TOLERANCE_MS = 1;

/**
 * Keyframe PTS of a fragment on the original timeline (ms), or null when its video traf does not start
 * with a sync sample (a fragment without video, or a continuation).
 */
export function fragmentKeyframeMs(moof: Buffer, init: InitInfo, videoTrackId: number): number | null {
  const video = parseMoof(moof, init).find((t) => t.trackId === videoTrackId);
  const first = video?.samples[0];
  if (!video || !first || !isSyncSample(first.flags)) return null;
  const timescale = init.tracks.find((t) => t.id === videoTrackId)?.timescale ?? 1;
  return ((video.baseDecodeTime + first.cts) * 1000) / timescale - OUTPUT_TS_OFFSET_MS;
}

export type SegmentDecision =
  | { action: 'discard' }
  | { action: 'append'; segment: number }
  /** Opens a segment; the previous one (if any) is complete. */
  | { action: 'open'; segment: number; closes: number | null }
  | { action: 'mismatch'; segment: number; keyframeMs: number; expectedMs: number };

/**
 * Places the fragments of one run into segments.
 * - starts[j] is Bⱼ (ms, original timeline) for j ≥ 1; starts[0] is ignored (segment 0 starts the file).
 * - A run for k > 0 discards fragments whose keyframe is before Bₖ; its first kept keyframe must be Bₖ.
 * - Later keyframes open segment j+1 exactly at Bⱼ₊₁; a keyframe past a boundary that never came means
 *   the index and the stream disagree.
 * - lateMs: how far after Bⱼ a boundary keyframe may be. Direct Stream boundaries are indexed keyframes
 *   (tolerance only); a Transcode forces its IDR on the first frame at or after Bⱼ, up to a frame late.
 */
export class SegmentGrouper {
  private cur: number | null = null;
  private readonly starts: readonly number[];
  private readonly k: number;
  private readonly tol: number;
  private readonly late: number;

  constructor(starts: readonly number[], startSegment: number, toleranceMs = KEYFRAME_TOLERANCE_MS, lateMs = toleranceMs) {
    if (startSegment < 0 || startSegment >= starts.length) throw new RangeError(`segment ${startSegment} out of range`);
    this.starts = starts;
    this.k = startSegment;
    this.tol = toleranceMs;
    this.late = Math.max(toleranceMs, lateMs);
  }

  /** Segment receiving fragments, null while still in the pre-roll. */
  get current(): number | null {
    return this.cur;
  }

  /** keyframeMs: the fragment's keyframe PTS, or null for a fragment that does not start with one. */
  place(keyframeMs: number | null): SegmentDecision {
    if (this.cur === null) {
      if (keyframeMs === null) return { action: 'discard' };
      if (this.k === 0) {
        this.cur = 0;
        return { action: 'open', segment: 0, closes: null };
      }
      const b = this.starts[this.k]!;
      if (keyframeMs < b - this.tol) return { action: 'discard' };
      if (keyframeMs - b > this.late) return { action: 'mismatch', segment: this.k, keyframeMs, expectedMs: b };
      this.cur = this.k;
      return { action: 'open', segment: this.k, closes: null };
    }
    if (keyframeMs === null) return { action: 'append', segment: this.cur };
    const next = this.cur + 1;
    if (next < this.starts.length && keyframeMs >= this.starts[next]! - this.tol) {
      if (keyframeMs - this.starts[next]! > this.late) {
        return { action: 'mismatch', segment: next, keyframeMs, expectedMs: this.starts[next]! };
      }
      const closes = this.cur;
      this.cur = next;
      return { action: 'open', segment: next, closes };
    }
    if (this.cur > 0 && keyframeMs < this.starts[this.cur]! - this.tol) {
      return { action: 'mismatch', segment: this.cur, keyframeMs, expectedMs: this.starts[this.cur]! };
    }
    return { action: 'append', segment: this.cur };
  }
}
