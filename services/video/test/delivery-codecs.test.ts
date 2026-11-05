// Codec strings from facts (Direct Play), served audio bitrates, the exact ffmpeg command lines,
// stderr classification and the new configuration keys.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/app/config.ts';
import { audioCodecFromFacts, progressiveMimeType, servedAudioBps, videoCodecFromFacts } from '../src/modules/delivery/codecs.ts';
import { audioArgs, audioFraming, directStreamArgs, seekSeconds } from '../src/modules/delivery/ffmpeg-args.ts';
import { classifyStderr, StderrRing } from '../src/modules/delivery/stderr.ts';
import type { AudioSource, DirectStreamPlan, VideoSource } from '../src/shared/playback-plan.ts';

const video = (over: Partial<VideoSource> = {}): VideoSource => ({
  streamIndex: 0,
  codec: 'hevc',
  profile: 'Main 10',
  width: 3840,
  height: 2160,
  frameRate: 23.976,
  bitDepth: 10,
  hdr: 'HDR10',
  hdrFallback: [],
  dolbyVisionProfile: null,
  bitRate: null,
  level: null,
  ...over,
});
const audio = (over: Partial<AudioSource> = {}): AudioSource => ({
  streamIndex: 1,
  trackId: 's1',
  codec: 'truehd',
  profile: null,
  language: 'ita',
  channels: 6,
  channelLayout: '5.1(side)',
  sampleRate: 48_000,
  bitRate: null,
  ...over,
});

describe('codec strings from facts (approximate, verified in F1c)', () => {
  it.each([
    ['HEVC Main 10 with the probed level', video({ level: 153 }), 'hvc1.2.4.L153.B0'],
    ['HEVC Main 10, level estimated (4K60)', video({ frameRate: 60 }), 'hvc1.2.4.L153.B0'],
    ['HEVC Main 10, level estimated (4K24)', video(), 'hvc1.2.4.L150.B0'],
    ['HEVC Main, 1080p', video({ profile: 'Main', width: 1920, height: 1080, bitDepth: 8, level: 123 }), 'hvc1.1.6.L123.B0'],
    ['AVC High 4.1', video({ codec: 'h264', profile: 'High', width: 1920, height: 1080, bitDepth: 8, level: 41 }), 'avc1.640029'],
    ['AVC Main, level estimated', video({ codec: 'h264', profile: 'Main', width: 1280, height: 720, bitDepth: 8 }), 'avc1.4D001F'],
    ['unknown codec', video({ codec: 'mpeg2video' }), null],
  ])('%s', (_l, v, want) => {
    expect(videoCodecFromFacts(v)).toBe(want);
  });

  it.each([
    ['aac', 'LC', 'mp4a.40.2'],
    ['aac', 'HE-AAC', 'mp4a.40.5'],
    ['ac3', null, 'ac-3'],
    ['eac3', null, 'ec-3'],
    ['flac', null, 'flac'],
    ['opus', null, 'opus'],
    ['truehd', null, 'mlpa'],
    ['pcm_s24le', null, null],
  ])('audio %s %s', (codec, profile, want) => {
    expect(audioCodecFromFacts(audio({ codec, profile }))).toBe(want);
  });

  it('progressive mimeType', () => {
    expect(progressiveMimeType('matroska', video({ codec: 'h264', profile: 'High', width: 1920, height: 1080, level: 41 }), audio({ codec: 'aac', profile: 'LC' }))).toBe(
      'video/x-matroska; codecs="avc1.640029, mp4a.40.2"',
    );
    expect(progressiveMimeType('mp4', video({ level: 153 }), null)).toBe('video/mp4; codecs="hvc1.2.4.L153.B0"');
    expect(progressiveMimeType('mp4', video({ codec: 'mpeg2video' }), null)).toBe('video/mp4');
  });

  it('served audio bitrate', () => {
    expect(servedAudioBps(audio(), { kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 640_000, layout: '5.1' })).toBe(640_000);
    expect(servedAudioBps(audio({ bitRate: 4_000_000 }), { kind: 'convert', codec: 'flac', channels: 6, bitrateBps: null, layout: null })).toBe(4_000_000);
    expect(servedAudioBps(audio({ codec: 'dts' }), { kind: 'convert', codec: 'flac', channels: 6, bitrateBps: null, layout: null })).toBe(Math.round(6 * 48_000 * 24 * 0.6));
    expect(servedAudioBps(audio({ codec: 'eac3', bitRate: 768_000 }), { kind: 'copy' })).toBe(768_000);
    expect(servedAudioBps(audio({ codec: 'ac3' }), { kind: 'copy' })).toBe(640_000);
  });
});

describe('ffmpeg command of a run (ADR 0003 D4, D11, D13)', () => {
  const plan = (over: Partial<DirectStreamPlan> = {}): DirectStreamPlan => ({
    planVersion: 1,
    mode: 'direct_stream',
    protocol: 'hls-fmp4',
    file: { fileId: 'f', location: { rootName: 'Film', relPath: 'A/A.mkv' }, sizeBytes: 1, mtimeMs: 1, container: 'matroska', durationMs: 1000 },
    video: { kind: 'copy', source: video(), tag: 'hvc1', dolbyVision: 'none' },
    audio: { source: audio(), action: { kind: 'convert', codec: 'flac', channels: 6, bitrateBps: null, layout: null } },
    subtitles: { selected: null, served: [] },
    startPositionMs: 0,
    reasons: [],
    exclusions: [],
    ...over,
  });
  const TAIL = ['-copyts', '-start_at_zero', '-avoid_negative_ts', 'disabled', '-output_ts_offset', '10', '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-fflags', '+bitexact', '-f', 'mp4', '-movflags', '+frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets', 'pipe:1'];

  it('from the start of the file: no -ss', () => {
    expect(directStreamArgs(plan(), '/media/Film/A/A.mkv', null)).toEqual([
      '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'warning',
      '-i', 'file:/media/Film/A/A.mkv',
      '-map', '0:0', '-map', '0:1',
      '-c:v', 'copy', '-tag:v', 'hvc1',
      '-af', 'aresample=48000,aresample=async=1:min_comp=0.00001:first_pts=0', '-c:a', 'flac', '-frame_size', '4608',
      ...TAIL,
    ]);
  });

  it('a restart: -noaccurate_seek -ss Kₖ + 0.135, audio anchored on Kₖ; DV P7 gets remove_dovi; AVC no tag; no audio map without audio', () => {
    const p7 = directStreamArgs(plan({ video: { kind: 'copy', source: video(), tag: 'hvc1', dolbyVision: 'remove_dovi' } }), '/m/a.mkv', { seekS: seekSeconds(12_000, 14_000), keyframeMs: 12_000 });
    expect(p7.slice(5, 8)).toEqual(['-noaccurate_seek', '-ss', '12.135000']);
    // FLAC frames of 4608 samples at 48 kHz (96 ms): 12 s is frame 125, first_pts 576000.
    expect(p7).toEqual(expect.arrayContaining(['-af', 'aresample=48000,aresample=async=1:min_comp=0.00001:first_pts=576000']));
    expect(p7).toEqual(expect.arrayContaining(['-bsf:v', 'hevc_metadata=remove_dovi=1']));
    const avc = directStreamArgs(plan({ video: { kind: 'copy', source: video({ codec: 'h264' }), tag: null, dolbyVision: 'none' }, audio: null }), '/m/a.mkv', null);
    expect(avc).not.toContain('-tag:v');
    expect(avc.filter((a) => a === '-map')).toHaveLength(1);
    expect(avc).not.toContain('-c:a');
  });

  it('seek compensation: 0.135 s, or half the distance to the next keyframe when closer', () => {
    expect(seekSeconds(12_000, 14_000)).toBe(12.135);
    expect(seekSeconds(12_000, 12_200)).toBe(12.1);
    expect(seekSeconds(12_000, null)).toBe(12.135);
  });

  const A = 'aresample=async=1:min_comp=0.00001:first_pts=';
  // The rate is always explicit (m1): the anchor is computed in the rate the first aresample outputs.
  it.each([
    [{ kind: 'copy' }, 48_000, 5000, ['-c:a', 'copy']],
    [{ kind: 'convert', codec: 'flac', channels: 8, bitrateBps: null, layout: null }, 48_000, 0, ['-af', `aresample=48000,${A}0`, '-c:a', 'flac', '-frame_size', '4608']],
    // FLAC keeps 96 kHz: 5 s is 480000 samples = 104.17 frames of 4608 → frame 104.
    [{ kind: 'convert', codec: 'flac', channels: 6, bitrateBps: null, layout: null }, 96_000, 5000, ['-af', `aresample=96000,${A}479232`, '-c:a', 'flac', '-frame_size', '4608']],
    // Unknown source rate: 48 kHz, stated.
    [{ kind: 'convert', codec: 'flac', channels: 6, bitrateBps: null, layout: null }, null, 5000, ['-af', `aresample=48000,${A}239616`, '-c:a', 'flac', '-frame_size', '4608']],
    // AAC: 1024-sample frames; 5 s at 48 kHz is 240000 samples = 234.375 frames → frame 234.
    [{ kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 640_000, layout: '5.1' }, 48_000, 5000, ['-af', `aresample=48000,${A}239616,aformat=channel_layouts=5.1`, '-c:a', 'aac', '-b:a', '640000']],
    // AAC at 44.1 kHz: 220500 samples = 215.33 frames → 215 · 1024.
    [{ kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 640_000, layout: '5.1' }, 44_100, 5000, ['-af', `aresample=44100,${A}220160,aformat=channel_layouts=5.1`, '-c:a', 'aac', '-b:a', '640000']],
    // Opus is 48 kHz only: a 44.1 kHz source is resampled first; 960-sample frames.
    [{ kind: 'convert', codec: 'opus', channels: 6, bitrateBps: 448_000, layout: '5.1' }, 44_100, 5000, ['-af', `aresample=48000,${A}240000,aformat=channel_layouts=5.1`, '-c:a', 'libopus', '-b:a', '448000']],
    [{ kind: 'convert', codec: 'aac', channels: 2, bitrateBps: 256_000, layout: 'stereo' }, 48_000, 0, ['-af', `aresample=48000,${A}0,aformat=channel_layouts=stereo`, '-c:a', 'aac', '-b:a', '256000']],
    // E-AC-3: 1536-sample frames; a 96 kHz source goes to 48 kHz.
    [{ kind: 'convert', codec: 'eac3', channels: 6, bitrateBps: 640_000, layout: '5.1' }, 96_000, 5000, ['-af', `aresample=48000,${A}239616,aformat=channel_layouts=5.1`, '-c:a', 'eac3', '-b:a', '640000']],
  ] as const)('audio %j from %s Hz anchored at %i ms', (action, sampleRate, anchorMs, want) => {
    expect(audioArgs(action, { sampleRate, codec: 'truehd' }, anchorMs)).toEqual(want);
  });

  it('copied AAC goes through aac_adtstoasc (ADTS from MPEG-TS; other AAC passes unchanged)', () => {
    expect(audioArgs({ kind: 'copy' }, { sampleRate: 48_000, codec: 'aac' })).toEqual(['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc']);
    expect(audioArgs({ kind: 'copy' }, { sampleRate: 48_000, codec: 'ac3' })).toEqual(['-c:a', 'copy']);
  });

  it('encoder framing per codec', () => {
    const conv = (codec: 'flac' | 'aac' | 'eac3' | 'opus') => ({ kind: 'convert', codec, channels: 2, bitrateBps: null, layout: null }) as unknown as Parameters<typeof audioFraming>[0];
    expect(audioFraming(conv('flac'), { sampleRate: 96_000 })).toEqual({ rate: 96_000, frameSamples: 4608 });
    expect(audioFraming(conv('aac'), { sampleRate: 192_000 })).toEqual({ rate: 48_000, frameSamples: 1024 });
    expect(audioFraming(conv('eac3'), { sampleRate: 44_100 })).toEqual({ rate: 44_100, frameSamples: 1536 });
    expect(audioFraming(conv('opus'), { sampleRate: null })).toEqual({ rate: 48_000, frameSamples: 960 });
  });
});

describe('stderr', () => {
  it.each([
    ['[mp4 @ x] Could not write header (incorrect codec parameters ?): Experimental feature', 'mux'],
    ['file:/m/a.mkv: No such file or directory', 'io'],
    ['[aac @ x] Error while opening encoder - maybe incorrect parameters', 'encode'],
    ['[Parsed_aformat_0 @ x] Error initializing filter', 'filter'],
    ['[hevc @ x] Invalid NAL unit size\nError while decoding stream #0:0', 'decode'],
    ['[matroska,webm @ x] Invalid data found when processing input', 'demux'],
    ['something else entirely', 'unknown'],
    ['', 'unknown'],
    // The last line decides: an early warning does not hide the fatal error.
    ['[matroska @ x] Invalid data found when processing input\n[out#0] Error writing trailer', 'mux'],
  ])('%j → %s', (text, cls) => {
    expect(classifyStderr(text)).toBe(cls);
  });

  it('keeps a bounded tail', () => {
    const ring = new StderrRing(100);
    for (let i = 0; i < 50; i++) ring.push(Buffer.from(`line ${i}\n`));
    expect(ring.text().length).toBeLessThanOrEqual(100);
    expect(ring.tail(24).split('\n')).toEqual(['line 47', 'line 48', 'line 49']);
  });
});

describe('configuration (ADR 0003 D16)', () => {
  it('has the ADR defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      HLS_SEGMENT_TARGET_S: 4,
      HLS_SEGMENT_MAX_S: 6,
      HLS_SEGMENT_MAX_BYTES: 32 * 1024 * 1024,
      DELIVERY_AHEAD_S: 30,
      DELIVERY_BEHIND_S: 30,
      DELIVERY_IDLE_KILL_S: 120,
      DELIVERY_TOMBSTONE_TTL_S: 3600,
      SUBTITLE_EXTRACT_MAX_MBPS: 15,
      SUBTITLE_PREROLL_S: 60,
      SUBTITLE_PREEXTRACT: 'off',
      SUBTITLE_CACHE_MAX_BYTES: 20e9,
    });
  });

  it('accepts byte sizes with units', () => {
    expect(loadConfig({ HLS_SEGMENT_MAX_BYTES: '32MiB', SUBTITLE_CACHE_MAX_BYTES: '20GB' })).toMatchObject({ HLS_SEGMENT_MAX_BYTES: 33_554_432, SUBTITLE_CACHE_MAX_BYTES: 20e9 });
    expect(loadConfig({ HLS_SEGMENT_MAX_BYTES: '1000' }).HLS_SEGMENT_MAX_BYTES).toBe(1000);
    expect(loadConfig({ SCRATCH_MAX_BYTES: '20GiB' }).SCRATCH_MAX_BYTES).toBe(20 * 1024 ** 3);
    expect(loadConfig({ SCRATCH_MAX_BYTES: '512 MB' }).SCRATCH_MAX_BYTES).toBe(512e6);
    expect(() => loadConfig({ HLS_SEGMENT_MAX_BYTES: '32 parsecs' })).toThrow(/byte size/);
  });
});
