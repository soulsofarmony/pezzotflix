// The segmenter's rule (ADR 0003 D4) on synthetic fragments: keyframe PTS = tfdt + composition offset,
// discard the pre-roll, group by keyframe PTS (never tfdt), first kept keyframe = Bₖ within 1 ms.
import { describe, expect, it } from 'vitest';
import { parseInit } from '../src/modules/delivery/bmff.ts';
import { fragmentKeyframeMs, SegmentGrouper } from '../src/modules/delivery/segmenter.ts';
import { fakeInit, fragment, NON_SYNC, SYNC, traf } from './helpers/delivery-builders.ts';

const init = parseInit(fakeInit());
const TS = 16_000;
/** A video fragment whose keyframe PTS is ptsMs; on an open GOP the tfdt is earlier (cts > 0). */
const videoFrag = (ptsMs: number, ctsMs = 0, firstSync = true) =>
  fragment(
    [traf(1, ((ptsMs + 10_000 - ctsMs) * TS) / 1000, [{ duration: 640, size: 1, flags: firstSync ? SYNC : NON_SYNC, cts: (ctsMs * TS) / 1000 }])],
    1,
  ).subarray(0, -9); // moof only
const audioOnly = () => fragment([traf(2, 480_000, [{ duration: 1024, size: 1 }])], 1).subarray(0, -9);

describe('fragmentKeyframeMs', () => {
  it('is tfdt + composition offset of the first sample, minus the 10 s offset', () => {
    expect(fragmentKeyframeMs(videoFrag(4000), init, 1)).toBe(4000);
    // Open GOP (t4): tfdt 13.504 s, keyframe PTS 13.629 s.
    expect(fragmentKeyframeMs(videoFrag(3629, 125), init, 1)).toBe(3629);
    // negative_cts_offsets: an IDR's PTS equals its DTS shifted back.
    expect(fragmentKeyframeMs(videoFrag(8000, -33), init, 1)).toBe(8000);
  });

  it('is null without a video traf or when the first video sample is not a sync sample', () => {
    expect(fragmentKeyframeMs(audioOnly(), init, 1)).toBeNull();
    expect(fragmentKeyframeMs(videoFrag(4000, 0, false), init, 1)).toBeNull();
  });
});

describe('SegmentGrouper', () => {
  // B₀ = 0, B₁ = 3629, B₂ = 7258, B₃ = 10887 (off-grid keyframes), inner keyframes in between.
  const starts = [0, 3629, 7258, 10_887];

  it('run from 0: opens segment 0 at once, then each boundary keyframe', () => {
    const g = new SegmentGrouper(starts, 0);
    expect(g.place(null)).toEqual({ action: 'discard' }); // audio before the first keyframe
    expect(g.place(42)).toEqual({ action: 'open', segment: 0, closes: null });
    expect(g.place(1209)).toEqual({ action: 'append', segment: 0 });
    expect(g.place(null)).toEqual({ action: 'append', segment: 0 });
    expect(g.place(3629.4)).toEqual({ action: 'open', segment: 1, closes: 0 });
    expect(g.place(7258)).toEqual({ action: 'open', segment: 2, closes: 1 });
    expect(g.place(10_887)).toEqual({ action: 'open', segment: 3, closes: 2 });
    expect(g.place(12_000)).toEqual({ action: 'append', segment: 3 });
  });

  it('restart at k: discards the pre-roll GOP, keeps from Bₖ', () => {
    const g = new SegmentGrouper(starts, 2);
    expect(g.place(6048)).toEqual({ action: 'discard' }); // Kₖ, the keyframe before B₂
    expect(g.place(null)).toEqual({ action: 'discard' });
    expect(g.current).toBeNull();
    expect(g.place(7258.9)).toEqual({ action: 'open', segment: 2, closes: null });
    expect(g.current).toBe(2);
    expect(g.place(8467)).toEqual({ action: 'append', segment: 2 });
    expect(g.place(10_887)).toEqual({ action: 'open', segment: 3, closes: 2 });
  });

  it('a first kept keyframe more than 1 ms from Bₖ is a mismatch', () => {
    expect(new SegmentGrouper(starts, 2).place(7259.5)).toEqual({ action: 'mismatch', segment: 2, keyframeMs: 7259.5, expectedMs: 7258 });
    expect(new SegmentGrouper(starts, 2).place(8467)).toMatchObject({ action: 'mismatch', segment: 2 });
  });

  it('a keyframe past a boundary that never came is a mismatch (index and stream disagree)', () => {
    const g = new SegmentGrouper(starts, 0);
    g.place(0);
    expect(g.place(3700)).toEqual({ action: 'mismatch', segment: 1, keyframeMs: 3700, expectedMs: 3629 });
  });

  it('groups by keyframe PTS, not by tfdt: an open-GOP fragment whose tfdt is before Bₖ is kept', () => {
    const g = new SegmentGrouper(starts, 1);
    const kf = fragmentKeyframeMs(videoFrag(3629, 125), init, 1);
    expect(g.place(kf)).toEqual({ action: 'open', segment: 1, closes: null });
  });

  it('rejects a start segment outside the grid', () => {
    expect(() => new SegmentGrouper(starts, 4)).toThrow(RangeError);
  });
});
