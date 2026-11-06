// The software Transcode, pure parts (doc 04 P2, ADR 0003 D3): synthetic grid, forced keyframe list,
// H.264 level, tone-map chain, filter path escaping, the command of a run (seek, burn-in) and the blame.
import { describe, expect, it } from 'vitest';
import { FMP4_MOVFLAGS } from '../src/modules/delivery/ffmpeg-args.ts';
import { SegmentGrouper } from '../src/modules/delivery/segmenter.ts';
import {
  BURN_PREROLL_MS,
  DEINTERLACE,
  filterPathArg,
  forcedKeyframeList,
  h264Level,
  toneMapFilter,
  TRANSCODE_LATE_MIN_MS,
  transcodeArgs,
  transcodeBlame,
  transcodeGrid,
  transcodeLateMs,
  transcodeVideoBitrate,
} from '../src/modules/delivery/transcode-args.ts';
import type { TranscodePlan, VideoSource } from '../src/shared/playback-plan.ts';

const opts = { targetMs: 4000, maxMs: 6000, maxBytes: 32 * 1024 ** 2 };

const source: VideoSource = { streamIndex: 0, codec: 'hevc', profile: 'Main 10', width: 1920, height: 1080, frameRate: 23.976, bitDepth: 10, hdr: 'HDR10', hdrFallback: [], dolbyVisionProfile: null, bitRate: null, level: null };
const plan = (over: Partial<TranscodePlan> = {}): TranscodePlan => ({
  planVersion: 1,
  mode: 'transcode',
  protocol: 'hls-fmp4',
  file: { fileId: 'f', location: { rootName: 'Film', relPath: 'f.mkv' }, sizeBytes: 1, mtimeMs: 1, container: 'matroska', durationMs: 30_000 },
  video: { kind: 'transcode', source, codec: 'h264', width: 1280, height: 720, maxBitrateBps: 8_000_000, toneMap: 'to_sdr', causes: ['hdr_tonemap'] },
  audio: { source: { streamIndex: 1, trackId: 's1', codec: 'truehd', profile: null, language: 'ita', channels: 8, channelLayout: '7.1', sampleRate: 48_000, bitRate: null }, action: { kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 640_000, layout: '5.1' } },
  subtitles: { selected: null, served: [] },
  startPositionMs: 0,
  reasons: [],
  exclusions: [],
  ...over,
});
const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('synthetic grid and forced keyframes', () => {
  it('boundaries every target from 0; a last piece under 0.5 s is merged', () => {
    const g = transcodeGrid(30_300, opts);
    expect(g.starts).toEqual([0, 4000, 8000, 12_000, 16_000, 20_000, 24_000, 28_000]);
    expect(g.extinfMs).toEqual([4000, 4000, 4000, 4000, 4000, 4000, 4000, 2300]);
    expect(g.targetDurationS).toBe(4);
    expect(transcodeGrid(28_400, opts).starts.at(-1)).toBe(24_000);
    expect(() => transcodeGrid(0, opts)).toThrow();
    expect(() => transcodeGrid(1e12, opts)).toThrow();
  });

  it('transcodeLateMs: 1.5 frame intervals, never under 250 ms; 1 s with no frame rate', () => {
    const cases: [number | null, number][] = [
      [24, 250], // 62.5 ms, floored
      [24_000 / 1001, 250],
      [60, 250],
      [6, 250], // exactly 1.5 intervals = 250 ms
      [5, 300],
      [1, 1500],
      [0, 1000],
      [-1, 1000],
      [null, 1000],
    ];
    for (const [fps, ms] of cases) expect(transcodeLateMs(fps), String(fps)).toBeCloseTo(ms, 9);
    expect(TRANSCODE_LATE_MIN_MS).toBe(250);
  });

  it('the keyframe list of a run starts at its own boundary (an earlier entry would force each first frame), never empty (m1)', () => {
    const g = transcodeGrid(20_000, opts);
    expect(forcedKeyframeList(g, 0)).toBe('0.000,4.000,8.000,12.000,16.000');
    expect(forcedKeyframeList(g, 1)).toBe('4.000,8.000,12.000,16.000');
    expect(forcedKeyframeList(g, 3)).toBe('12.000,16.000');
    // A file of 4.5 s or less: one segment, the list still has B₀.
    expect(forcedKeyframeList(transcodeGrid(4_400, opts), 0)).toBe('0.000');
  });

  it('the grouper takes a forced IDR on the first frame after Bⱼ, up to the late tolerance, never early', () => {
    const starts = [0, 4000, 8000, 12_000];
    const g = new SegmentGrouper(starts, 2, 1, 2000);
    expect(g.place(7_998)).toEqual({ action: 'discard' });
    expect(g.place(8_041.708)).toEqual({ action: 'open', segment: 2, closes: null });
    expect(g.place(10_000)).toEqual({ action: 'append', segment: 2 }); // a scene-cut keyframe inside
    expect(g.place(12_041.7)).toEqual({ action: 'open', segment: 3, closes: 2 });
    const late = new SegmentGrouper(starts, 1, 1, 2000);
    expect(late.place(6_500)).toMatchObject({ action: 'mismatch', segment: 1 });
    // Direct Stream keeps the strict 1 ms rule.
    expect(new SegmentGrouper(starts, 1).place(4_041.7)).toMatchObject({ action: 'mismatch' });
  });
});

describe('encoder settings', () => {
  it.each([
    [1920, 1080, 23.976, 20e6, 40e6, '4.1'],
    [1920, 1080, 60, 20e6, 40e6, '4.2'],
    [1920, 1080, null, 8e6, 16e6, '4.2'],
    [1280, 720, 30, 8e6, 16e6, '3.1'],
    [1280, 720, 60, 8e6, 16e6, '3.2'],
    [720, 576, 25, 4e6, 8e6, '3.0'],
    [1920, 1080, 24, 70e6, 140e6, '5.0'],
  ])('level of %ix%i at %s fps, %i b/s', (w, h, fps, rate, buf, level) => {
    expect(h264Level(w, h, fps, rate, buf)).toBe(level);
  });

  it('tone-maps PQ, HLG and DV by its base layer; nothing for SDR', () => {
    expect(toneMapFilter({ hdr: 'HDR10', hdrFallback: [] })).toBe(
      'zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,sidedata=mode=delete',
    );
    expect(toneMapFilter({ hdr: 'HLG', hdrFallback: [] })).toMatch(/^zscale=tin=arib-std-b67:/);
    expect(toneMapFilter({ hdr: 'DV', hdrFallback: ['HLG'] })).toMatch(/^zscale=tin=arib-std-b67:/);
    expect(toneMapFilter({ hdr: 'DV', hdrFallback: [] })).toMatch(/^zscale=tin=smpte2084:/);
    expect(toneMapFilter({ hdr: 'SDR', hdrFallback: [] })).toBeNull();
    expect(toneMapFilter({ hdr: 'DV', hdrFallback: ['SDR'] })).toBeNull();
    // The engine's order for the base layer: HDR10 (or HDR10+) before HLG before SDR.
    expect(toneMapFilter({ hdr: 'DV', hdrFallback: ['HLG', 'HDR10'] })).toMatch(/^zscale=tin=smpte2084:/);
    expect(toneMapFilter({ hdr: 'DV', hdrFallback: ['SDR', 'HLG'] })).toMatch(/^zscale=tin=arib-std-b67:/);
  });

  it('escapes a path for a filter option inside -filter_complex', () => {
    expect(filterPathArg('C:\\data\\cache\\f-1\\s6.ass')).toBe('C\\\\:/data/cache/f-1/s6.ass');
    expect(filterPathArg("/m/It's, [a];b.srt")).toBe("/m/It\\\\\\'s\\, \\[a\\]\\;b.srt");
  });

  it('bitrate: the VBV bounds a segment at maxrate × (1 + buffer / target)', () => {
    expect(transcodeVideoBitrate(8_000_000, 4000)).toEqual({ peakBps: 12_000_000, averageBps: 8_000_000 });
  });
});

describe('the command of a run', () => {
  it('from 0: tone-map, scale, libx264 High with forced IDRs from the list, audio anchored, fMP4 on stdout', () => {
    const args = transcodeArgs({ plan: plan(), absPath: '/m/f.mkv', seek: null, keyframeFile: '/s/keyframes-0.txt', burn: null });
    expect(args).not.toContain('-ss');
    expect(at(args, '-i')).toBe('file:/m/f.mkv');
    expect(at(args, '-filter_complex')).toBe(`[0:0]${DEINTERLACE},${toneMapFilter(source)},scale=w=1280:h=720,format=yuv420p[v]`);
    expect(at(args, '-loglevel')).toBe('level+warning');
    expect(args.join(' ')).toContain('-map [v] -map 0:1 -c:v libx264 -preset veryfast -profile:v high -level:v 3.1 -crf 21 -maxrate 8000000 -bufsize 16000000');
    expect(at(args, '-/force_key_frames:v')).toBe('/s/keyframes-0.txt');
    expect(at(args, '-forced-idr')).toBe('1');
    expect(at(args, '-enc_time_base:v')).toBe('filter');
    expect(at(args, '-fps_mode:v')).toBe('passthrough');
    expect(at(args, '-color_trc')).toBe('bt709');
    expect(at(args, '-af')).toBe('aresample=48000,aresample=async=1:min_comp=0.00001:first_pts=0,aformat=channel_layouts=5.1');
    expect(args.slice(-19)).toEqual([
      '-copyts', '-start_at_zero', '-avoid_negative_ts', 'disabled', '-output_ts_offset', '10',
      '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-fflags', '+bitexact',
      '-f', 'mp4', '-movflags', FMP4_MOVFLAGS, 'pipe:1',
    ]);
  });

  it('a run from Bⱼ: accurate seek on the boundary, audio anchored there; SDR at source size: no tone-map, no scale', () => {
    const sdr = plan({ video: { ...plan().video, source: { ...source, hdr: 'SDR', bitDepth: 8 }, width: 1920, height: 1080, toneMap: 'none' } });
    const args = transcodeArgs({ plan: sdr, absPath: '/m/f.mkv', seek: { seekS: 8, keyframeMs: 8000 }, keyframeFile: '/s/k.txt', burn: null });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-i') + 2)).toEqual(['-ss', '8.000', '-i', 'file:/m/f.mkv']);
    expect(args).not.toContain('-noaccurate_seek');
    expect(at(args, '-filter_complex')).toBe(`[0:0]${DEINTERLACE},format=yuv420p[v]`);
    expect(args).not.toContain('-color_trc');
    expect(at(args, '-af')).toContain('first_pts=384000');
  });

  it('burns an image track with sub2video + overlay; a restart reads the video and subtitles from Bₖ − 10 s and trims', () => {
    const burn = { kind: 'bitmap' as const, trackId: 's3', streamIndex: 3 };
    const zero = transcodeArgs({ plan: plan(), absPath: '/m/f.mkv', seek: null, keyframeFile: '/s/k.txt', burn });
    expect(at(zero, '-filter_complex')).toBe(
      `[0:0]${DEINTERLACE},${toneMapFilter(source)}[main];[0:3]scale=w=1920:h=1080:force_original_aspect_ratio=decrease[sub];[main][sub]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass,scale=w=1280:h=720,format=yuv420p[v]`,
    );
    const k = transcodeArgs({ plan: plan(), absPath: '/m/f.mkv', seek: { seekS: 40, keyframeMs: 40_000 }, keyframeFile: '/s/k.txt', burn });
    expect(k.slice(k.indexOf('-noaccurate_seek'), k.indexOf('-filter_complex'))).toEqual([
      '-noaccurate_seek', '-ss', ((40_000 - BURN_PREROLL_MS) / 1000).toFixed(3), '-i', 'file:/m/f.mkv',
      '-ss', '40.000', '-i', 'file:/m/f.mkv',
    ]);
    expect(at(k, '-filter_complex')).toContain(`[0:0]${DEINTERLACE},trim=start=40.000,zscale=`);
    expect(k.join(' ')).toContain('-map [v] -map 1:1 ');
  });

  it('burns a text track with libass from its file', () => {
    const args = transcodeArgs({ plan: plan(), absPath: '/m/f.mkv', seek: null, keyframeFile: '/s/k.txt', burn: { kind: 'text', trackId: 's6', path: 'C:\\cache\\s6.ass' } });
    expect(at(args, '-filter_complex')).toBe(`[0:0]${DEINTERLACE},${toneMapFilter(source)},subtitles=filename=C\\\\:/cache/s6.ass,scale=w=1280:h=720,format=yuv420p[v]`);
  });

  it('blames the burn-in, the audio chain or the video from the error lines only (m7)', () => {
    const burn = { kind: 'bitmap' as const, trackId: 's3', streamIndex: 3 };
    const blame = transcodeBlame(plan(), burn);
    expect(blame({ kind: 'process_exit', stderrClass: 'filter', stderr: '[Parsed_overlay_2 @ 0x1] [error] Failed to configure input pad\n' })).toEqual({
      class: 'format',
      suspect: 'subtitle',
      exclusion: { dimension: 'subtitle', trackId: 's3', delivery: 'burned', fileId: 'f', cause: 'server', error: 'process_exit' },
    });
    expect(blame({ kind: 'process_exit', stderrClass: 'filter', stderr: '[Parsed_aresample_0 @ 0x1] [error] Failed to configure\n' })).toMatchObject({ suspect: 'audio', exclusion: { dimension: 'audio', codec: 'aac' } });
    expect(blame({ kind: 'process_exit', stderrClass: 'filter', stderr: '[Parsed_zscale_0 @ 0x1] [error] code 3074: no path between colorspaces\n' })).toEqual({ class: 'stream', suspect: 'video', exclusion: null });
    // libass warns about fonts and goes on: a later failure of the video is not the burn-in's.
    const text = transcodeBlame(plan(), { kind: 'text', trackId: 's6', path: '/c/s6.ass' });
    const fontWarnings = '[Parsed_subtitles_1 @ 0x1] [warning] fontselect: failed to find any fallback with glyph 0x4E00 for font: (Arial, 400, 0)\n[Parsed_subtitles_1 @ 0x1] [warning] Error opening font: Arial\n';
    expect(text({ kind: 'process_exit', stderrClass: 'encode', stderr: `${fontWarnings}[libx264 @ 0x2] [error] malloc of size 4194304 failed\n[vost#0:0/libx264 @ 0x3] [error] Error while opening encoder\n` })).toEqual({ class: 'stream', suspect: 'video', exclusion: null });
    // The failing filter instance counts even when the last line is the generic one.
    expect(text({ kind: 'process_exit', stderrClass: 'filter', stderr: '[Parsed_subtitles_1 @ 0x1] [error] Unable to open /c/s6.ass\n[AVFilterGraph @ 0x2] [error] Error initializing filters\n' })).toMatchObject({ suspect: 'subtitle' });
    // Without level tags nothing is blamed beyond the video.
    expect(blame({ kind: 'process_exit', stderrClass: 'filter', stderr: '[Parsed_overlay_2 @ 0x1] Failed to configure input pad\n' })).toEqual({ class: 'stream', suspect: 'video', exclusion: null });
    expect(blame({ kind: 'process_exit', stderrClass: 'decode', stderr: 'Invalid NAL unit size\n' })).toBeNull();
    expect(blame({ kind: 'restart_mismatch', stderrClass: null, stderr: '' })).toBeNull();
  });
});
