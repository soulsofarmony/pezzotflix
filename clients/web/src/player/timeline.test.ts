import { describe, expect, it } from 'vitest';
import { timelineOffsetFromInitPts, toOriginalMs, toPlayerTimeS } from './timeline.ts';

/**
 * INIT_PTS_FOUND as hls.js 1.7.4 computes it for fMP4 (passthrough-remuxer.ts): the first fragment's decode time
 * (tfdt) minus the fragment's playlist start, in the track timescale:
 *   initPTS = baseOffsetSamples.start − frag.start · timescale
 * ADR 0003: the VOD playlist spans the whole film on the original timeline (EXTINF sums = Bₖ), and the segments
 * carry the original PTS + 10 s (mediaTimestampOffsetMs). So for any start, also a pipeline restart at 1 h,
 * initPTS/timescale ≈ 10 s and the offset is the small δ between the fragment's decode time and Bₖ.
 */
const initPtsOf = (decodeTimeS: number, fragStartS: number, timescale: number) => Math.round((decodeTimeS - fragStartS) * timescale);

describe('timeline offset (doc 05 §7.8.7)', () => {
  it.each([
    // name, first fragment decode time (s), its playlist start (s), timescale, mediaTimestampOffsetMs, offset (ms)
    ['start at 0: PTS 0 + 10 s at playlist time 0', 10, 0, 90_000, 10_000, 0],
    ['player started at 1:00:00: first fragment B = 3600 s, PTS 3600 + 10 s', 3610, 3600, 90_000, 10_000, 0],
    ['pipeline restart at 1:00:00, keyframe 120 ms after Bₖ', 3610.12, 3600, 90_000, 10_000, 120],
    ['open GOP: tfdt 125 ms before the keyframe PTS (ADR 0003 t4)', 3609.875, 3600, 90_000, 10_000, -125],
    ['restart at 1:00:00 with timescale 1000 and δ = 203 ms', 3610.203, 3600, 1000, 10_000, 203],
    ['progressive: offset 0', 0, 0, 90_000, 0, 0],
  ])('%s', (_name, decodeTimeS, fragStartS, timescale, mto, expected) => {
    expect(timelineOffsetFromInitPts(initPtsOf(decodeTimeS, fragStartS, timescale), timescale, mto)).toBeCloseTo(expected, 3);
  });

  it('a restart at 1 h never moves the timeline by the hour: currentTime already is the playlist time', () => {
    const offset = timelineOffsetFromInitPts(initPtsOf(3610.12, 3600, 90_000), 90_000, 10_000);
    // hls.js puts that frame at currentTime = 3600 s (its playlist time): the original time is 3600.12 s.
    expect(toOriginalMs(3600, offset)).toBe(3_600_120);
    expect(Math.abs(offset)).toBeLessThan(1000);
  });

  it('returns 0 for an invalid timescale', () => {
    expect(timelineOffsetFromInitPts(900_000, 0, 10_000)).toBe(0);
  });

  it('maps player time to the original timeline and back', () => {
    const offset = 120;
    expect(toOriginalMs(3612.3456, offset)).toBe(3_612_466);
    expect(toPlayerTimeS(3_612_466, offset)).toBeCloseTo(3612.346, 6);
    expect(toOriginalMs(toPlayerTimeS(5_000_000, offset), offset)).toBe(5_000_000);
  });

  it('clamps at 0', () => {
    expect(toOriginalMs(0, -500)).toBe(0);
    expect(toPlayerTimeS(100, 120)).toBe(0);
  });
});
