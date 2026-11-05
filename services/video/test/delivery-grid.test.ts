// Segment grid (ADR 0003 D3), EXTINF rounding and the playlists (D2), pure.
import { describe, expect, it } from 'vitest';
import { buildGrid, type GridIndex, segmentAt, segmentStartMs } from '../src/modules/delivery/grid.ts';
import { mediaPlaylist, multivariantPlaylist, parseHlsResource, segmentName, videoRange } from '../src/modules/delivery/playlist.ts';

const OPTS = { targetMs: 4000, maxMs: 6000, maxBytes: 32 * 1024 * 1024 };
const every = (stepMs: number, endMs: number): number[] => Array.from({ length: Math.ceil(endMs / stepMs) }, (_, i) => Math.round(i * stepMs * 1000) / 1000);
/** Index with positions at a constant bitrate (bits/s). */
const ix = (times: number[], durationMs: number, bps = 8_000_000): GridIndex => ({
  times,
  positions: times.map((t) => Math.round((t / 1000) * (bps / 8))),
  durationMs,
  sizeBytes: Math.round((durationMs / 1000) * (bps / 8)),
});
const boundaries = (g: { starts: number[] }) => g.starts.slice(1);

describe('buildGrid', () => {
  it('closed 2 s GOPs on the grid: one boundary every 4 s', () => {
    const g = buildGrid(ix(every(2000, 30_000), 30_000), OPTS);
    expect(boundaries(g)).toEqual([4000, 8000, 12000, 16000, 20000, 24000, 28000]);
    expect(g.extinfMs).toEqual([4000, 4000, 4000, 4000, 4000, 4000, 4000, 2000]);
    expect(g.targetDurationS).toBe(4);
  });

  it('keyframes off the grid (23.976 fps, keyint 29): Bₙ is the last keyframe ≤ n·4 s', () => {
    const gop = (29 * 1001) / 24; // 1209.5 ms
    const times = every(gop, 30_000);
    const g = buildGrid(ix(times, 30_000), OPTS);
    for (const [n, b] of boundaries(g).entries()) {
      const want = Math.max(...times.filter((t) => t <= (n + 1) * 4000));
      expect(b).toBe(want);
    }
  });

  it('EXTINF are rounded cumulatively: the first k sum to round(Bₖ)', () => {
    const times = every((29 * 1001) / 24, 60_000);
    const g = buildGrid(ix(times, 60_000), OPTS);
    let sum = 0;
    for (let k = 1; k < g.starts.length; k++) {
      sum += g.extinfMs[k - 1]!;
      expect(sum).toBe(Math.round(g.starts[k]!));
    }
    expect(g.extinfMs.reduce((a, b) => a + b, 0)).toBe(60_000);
    expect(g.extinfMs.every((e) => Number.isInteger(e))).toBe(true);
  });

  it('drops duplicate boundaries when a GOP spans more than one target', () => {
    const g = buildGrid(ix(every(5000, 30_000), 30_000), OPTS);
    expect(boundaries(g)).toEqual([5000, 10000, 15000, 20000, 25000]);
  });

  it('merges a segment under 0.5 s into the previous one', () => {
    // B₁ = 3900, B₂ = 4300 (no keyframe in (4300, 8000]): [3900, 4300) is 0.4 s, so 3900 goes. Then
    // [4300, 11900) is 7.6 s and is cut at 8100.
    const g = buildGrid(ix([0, 3900, 4300, 8100, 11_900], 15_000), OPTS);
    expect(boundaries(g)).toEqual([4300, 8100, 11_900]);
  });

  it('merges a short last segment into the previous one', () => {
    const g = buildGrid(ix([0, 3900, 7900, 11_900], 12_200), OPTS);
    expect(boundaries(g)).toEqual([3900, 7900]);
    expect(g.extinfMs.at(-1)).toBe(12_200 - 7900);
  });

  it('merges a short first segment into the next', () => {
    const g = buildGrid(ix([0, 300, 4000, 8000], 10_000), { ...OPTS, targetMs: 300 });
    expect(g.starts[1]).not.toBe(300);
    expect(g.extinfMs.every((e) => e >= 500)).toBe(true);
  });

  it('cuts a group longer than HLS_SEGMENT_MAX_S at an inner keyframe near the middle', () => {
    // B₁ = 3900, B₂ = 3900 (dropped), B₃ = 11000: [3900, 11000) is 7.1 s, cut at 8100 (nearest 7450).
    const g = buildGrid(ix([0, 3900, 8100, 9000, 10_000, 11_000, 12_100, 16_000], 18_000), OPTS);
    expect(boundaries(g)).toEqual([3900, 8100, 11_000, 16_000]);
    expect(Math.max(...g.extinfMs)).toBeLessThanOrEqual(6000);
  });

  it('never cuts a single GOP: TARGETDURATION follows it', () => {
    const g = buildGrid(ix([0, 10_000], 20_000), OPTS);
    expect(boundaries(g)).toEqual([10_000]);
    expect(g.targetDurationS).toBe(10);
  });

  it('cuts groups over HLS_SEGMENT_MAX_BYTES (128 Mb/s, 1 s GOPs) and leaves low bitrates alone', () => {
    const high = buildGrid(ix(every(1000, 20_000), 20_000, 128_000_000), OPTS);
    expect(high.extinfMs.every((e) => e <= 2000)).toBe(true);
    for (const [j, e] of high.extinfMs.entries()) expect((e / 1000) * 16_000_000, `segment ${j}`).toBeLessThanOrEqual(OPTS.maxBytes);
    const low = buildGrid(ix(every(1000, 20_000), 20_000, 20_000_000), OPTS);
    expect(boundaries(low)).toEqual([4000, 8000, 12000, 16000]);
  });

  it('a probe index (boundaries only) cannot be cut further', () => {
    const g = buildGrid(ix([0, 3600, 7200, 10_800], 14_400, 128_000_000), OPTS);
    expect(boundaries(g)).toEqual([3600, 7200, 10_800]);
  });

  it('estimates peak and average bitrate from the positions', () => {
    const g = buildGrid(ix(every(2000, 30_000), 30_000, 40_000_000), OPTS);
    expect(g.averageBps).toBe(40_000_000);
    expect(g.peakBps).toBe(40_000_000);
    const unknown = buildGrid({ times: [0, 4000], positions: [null, null], durationMs: 8000, sizeBytes: 1 }, OPTS);
    expect(unknown.peakBps).toBeNull();
  });

  it('rejects an empty index or an unknown duration', () => {
    expect(() => buildGrid(ix([], 1000), OPTS)).toThrow();
    expect(() => buildGrid(ix([0], 0), OPTS)).toThrow();
    expect(() => buildGrid(ix([0], Number.POSITIVE_INFINITY), OPTS)).toThrow();
    expect(() => buildGrid(ix([0], Number.NaN), OPTS)).toThrow();
    expect(() => buildGrid(ix([0, 2000], 4000), { ...OPTS, targetMs: 0 })).toThrow();
  });

  it('a hostile duration costs O(keyframes): a few keyframes and 10¹⁵ ms', () => {
    const t0 = performance.now();
    const g = buildGrid({ times: [0, 2000, 4000], positions: [0, 100, 200], durationMs: 1e15, sizeBytes: 300 }, OPTS);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(g.starts.length).toBeLessThanOrEqual(3);
  });

  it('a million keyframes: no stack or argument-count limits (no spreads, no recursion)', () => {
    const times = every(40, 40_000_000);
    expect(times.length).toBe(1_000_000);
    const t0 = performance.now();
    const g = buildGrid(ix(times, 40_000_000), OPTS);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(g.starts.length).toBe(10_000);
    // One long GOP (no inner keyframe) is a single segment however long.
    const lone = buildGrid({ times: [0], positions: [0], durationMs: 3_600_000, sizeBytes: 1e9 }, OPTS);
    expect(lone.starts).toEqual([0]);
    expect(lone.targetDurationS).toBe(3600);
  });

  it('bytes: segment 0 from the first keyframe, the last up to the end of the media data (Cues after it)', () => {
    // 1 MB of headers before the first cluster, 4 MB per 4 s, then 50 MB of Cues and attachments.
    const MB = 1_000_000;
    const index: GridIndex = { times: [0, 4000, 8000], positions: [MB, 5 * MB, 9 * MB], durationMs: 12_000, sizeBytes: 63 * MB, dataEndBytes: 13 * MB };
    const g = buildGrid(index, OPTS);
    expect(g.peakBps).toBe(8 * MB);
    expect(g.averageBps).toBe(8 * MB);
    // Without dataEndBytes the file end counts: the last segment looks 54 MB large.
    const noEnd = buildGrid({ ...index, dataEndBytes: null }, OPTS);
    expect(noEnd.peakBps).toBe(Math.round((54 * MB * 8000) / 4000));
  });

  it('segmentAt and segmentStartMs', () => {
    const g = buildGrid(ix(every(2000, 30_000), 30_000), OPTS);
    expect([0, 3999, 4000, 4001, 29_999].map((p) => segmentAt(g, p))).toEqual([0, 0, 1, 1, 7]);
    expect(segmentStartMs(g, 0)).toBe(0);
    expect(segmentStartMs(g, 3)).toBe(12_000);
  });
});

describe('playlists', () => {
  const g = buildGrid(ix([0, 1209.5, 2419, 3628.5, 4838, 6047.5], 7000), OPTS);

  it('media playlist: VOD of the whole film, cumulative EXTINF, the init map', () => {
    expect(mediaPlaylist(g, { independentSegments: false })).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-MAP:URI="init-0.mp4"',
        '#EXTINF:3.629,',
        'seg-0-00000.m4s',
        '#EXTINF:3.371,',
        'seg-0-00001.m4s',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
    expect(mediaPlaylist(g, { independentSegments: true })).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
  });

  it('multivariant playlist: one variant with bandwidths, codecs, resolution, frame rate and range', () => {
    expect(
      multivariantPlaylist({
        peakBps: 101_764_111.4,
        averageBps: 99_569_471,
        codecs: ['hvc1.2.4.L153.B0', 'flac'],
        width: 3840,
        height: 2160,
        frameRate: 23.976,
        videoRange: 'PQ',
        independentSegments: false,
      }),
    ).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-STREAM-INF:BANDWIDTH=101764111,AVERAGE-BANDWIDTH=99569471,CODECS="hvc1.2.4.L153.B0,flac",RESOLUTION=3840x2160,FRAME-RATE=23.976,VIDEO-RANGE=PQ',
        'media-0.m3u8',
        '',
      ].join('\n'),
    );
  });

  it.each([
    ['main.m3u8', { kind: 'main' }],
    ['media-0.m3u8', { kind: 'media' }],
    ['init-0.mp4', { kind: 'init' }],
    ['seg-0-00001.m4s', { kind: 'segment', index: 1 }],
    ['seg-0-00002.m4s', null],
    ['seg-0-1.m4s', null],
    ['media-1.m3u8', null],
    ['init-0.mp4.part', null],
  ])('parseHlsResource(%s)', (name, want) => {
    expect(parseHlsResource(name, 2)).toEqual(want);
  });

  it('names and ranges', () => {
    expect(segmentName(42)).toBe('seg-0-00042.m4s');
    // DV takes the range of its base layer: P8.4 is HLG, P8.1 PQ.
    expect([videoRange('DV', ['HLG']), videoRange('DV', ['HDR10'])]).toEqual(['HLG', 'PQ']);
    expect([videoRange('HDR10'), videoRange('HDR10+'), videoRange('DV'), videoRange('DV', ['SDR']), videoRange('HLG'), videoRange('SDR')]).toEqual([
      'PQ',
      'PQ',
      'PQ',
      'SDR',
      'HLG',
      'SDR',
    ]);
  });
});
