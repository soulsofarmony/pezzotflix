import { describe, expect, it } from 'vitest';
import { deliveredAudioCodec, estimateAudioBps, hlsBufferConfig, type BufferInput } from './buffer.ts';

const MIB = 1024 * 1024;
const input = (over: Partial<BufferInput>): BufferInput => ({
  peakBps: null,
  audioBps: null,
  bandwidthBps: null,
  audioCodec: null,
  audioChannels: null,
  targetDurationS: 6,
  ...over,
});

describe('hlsBufferConfig: the examples of doc 05 §7.8.4', () => {
  it.each([
    // name, input, maxBufferLength, warn
    ['100 Mbps, TD 4 s: T ≈ 8.8 s → 4 s', input({ peakBps: 100_000_000, audioBps: 640_000, targetDurationS: 4 }), 4, false],
    ['1080p 20 Mbps with AAC 5.1: T ≈ 44 s → cap 30 s', input({ peakBps: 20_000_000, audioBps: 384_000, targetDurationS: 6 }), 30, false],
    ['FLAC 7.1 at ~6 Mbit/s, TD 6 s: T audio ≈ 11.7 s → floor 5 raised to 6', input({ peakBps: 40_000_000, audioBps: 6_000_000, targetDurationS: 6 }), 6, true],
    ['100 Mbps, TD 6 s: T ≈ 8.8 s < 12 s → 6 s with a warning', input({ peakBps: 100_000_000, audioBps: 640_000, targetDurationS: 6 }), 6, true],
    ['128 Mbps, TD 6 s: T ≈ 6.9 s → 6 s with a warning', input({ peakBps: 128_000_000, audioBps: 640_000, targetDurationS: 6 }), 6, true],
  ])('%s', (_name, i, maxBufferLength, warn) => {
    const b = hlsBufferConfig(i);
    expect(b.maxBufferLength).toBe(maxBufferLength);
    expect(b.maxMaxBufferLength).toBe(maxBufferLength);
    expect(b.warn).toBe(warn);
    expect(b.maxBufferSize).toBe(Math.floor(0.7 * 150 * MIB));
    expect(b.estimated).toBe(false);
  });

  it('computes T from the binding quota', () => {
    expect(hlsBufferConfig(input({ peakBps: 100_000_000, audioBps: 640_000, targetDurationS: 4 })).fitSeconds).toBeCloseTo(8.86, 2);
    expect(hlsBufferConfig(input({ peakBps: 40_000_000, audioBps: 6_000_000 })).fitSeconds).toBeCloseTo(11.74, 2);
    expect(hlsBufferConfig(input({ peakBps: 128_000_000, audioBps: 640_000 })).fitSeconds).toBeCloseTo(6.92, 2);
  });

  it('keeps forward + one segment inside the margin at 100 Mbps / TD 4 s', () => {
    const b = hlsBufferConfig(input({ peakBps: 100_000_000, audioBps: 640_000, targetDurationS: 4 }));
    const bytes = ((b.maxBufferLength + 4) * 100_000_000) / 8;
    expect(bytes).toBeLessThan(0.7 * 150 * MIB);
  });

  it('sizes the back buffer as 10 % of the video quota, at least 2 s', () => {
    expect(hlsBufferConfig(input({ peakBps: 100_000_000, audioBps: 640_000 })).backBufferLength).toBe(2);
    expect(hlsBufferConfig(input({ peakBps: 20_000_000, audioBps: 384_000 })).backBufferLength).toBe(6);
    expect(hlsBufferConfig(input({ peakBps: 1_000_000_000, audioBps: 640_000 })).backBufferLength).toBe(2);
  });

  it('falls back to BANDWIDTH and the codec table when the session has no bitrate', () => {
    const b = hlsBufferConfig(input({ bandwidthBps: 100_000_000, audioCodec: 'eac3', audioChannels: 6, targetDurationS: 4 }));
    expect(b.estimated).toBe(true);
    expect(b.maxBufferLength).toBe(4);
  });

  it('without any bitrate only the audio quota binds, capped at 30 s', () => {
    const b = hlsBufferConfig(input({ audioCodec: 'aac', audioChannels: 2 }));
    expect(b.maxBufferLength).toBe(30);
    expect(b.backBufferLength).toBe(2);
    expect(b.estimated).toBe(true);
  });

  it('never goes under one target duration', () => {
    const b = hlsBufferConfig(input({ peakBps: 400_000_000, audioBps: 640_000, targetDurationS: 6 }));
    expect(b.maxBufferLength).toBe(6);
    expect(b.warn).toBe(true);
  });
});

describe('estimateAudioBps (judgment table)', () => {
  it.each([
    ['flac', 8, 6_000_000],
    ['flac', 6, 4_500_000],
    ['eac3', 6, 640_000],
    ['ac3', 6, 640_000],
    ['aac', 6, 384_000],
    ['opus', 6, 384_000],
    ['aac', null, 128_000],
    [null, null, 640_000],
  ])('%s × %s → %d', (codec, channels, bps) => {
    expect(estimateAudioBps(codec, channels)).toBe(bps);
  });
});

describe('deliveredAudioCodec: the estimate uses what the stream carries, not the source track', () => {
  it.each([
    ['TrueHD source converted to FLAC', 'video/mp4; codecs="hvc1.2.4.L153.B0, flac"', 'flac'],
    ['AAC 5.1', 'video/mp4; codecs="avc1.640028, mp4a.40.2"', 'aac'],
    ['E-AC-3 copied', 'video/mp4; codecs="hvc1.2.4.L153.B0, ec-3"', 'ec-3'],
    ['AC-3', 'video/mp4; codecs="avc1.640028, ac-3"', 'ac-3'],
    ['Opus', 'video/mp4; codecs="avc1.640028, opus"', 'opus'],
    ['video only', 'video/mp4; codecs="hvc1.2.4.L153.B0"', null],
    ['no mimeType', null, null],
  ])('%s', (_name, mime, codec) => {
    expect(deliveredAudioCodec(mime)).toBe(codec);
  });

  it('a TrueHD 7.1 source delivered as AAC is estimated as AAC, not as the source', () => {
    const codec = deliveredAudioCodec('video/mp4; codecs="avc1.640028, mp4a.40.2"');
    expect(estimateAudioBps(codec, 6)).toBe(384_000);
    expect(estimateAudioBps('ec-3', 6)).toBe(640_000);
  });
});
