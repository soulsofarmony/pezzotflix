// MediaFacts mapping: ffprobe 8.1 outputs captured from the S1 fixtures (test/fixtures, metadata
// only) plus synthetic streams for what the fixtures cannot contain (Atmos, DTS:X, HDR10+, P7).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bitDepthOf,
  classifyHdr,
  isLossless,
  mapFacts,
  mayCarryHdr10Plus,
  normalizeContainer,
  objectAudioOf,
  parseFrameRate,
  titleSaysForced,
} from '../src/modules/analyzer/facts.ts';
import { FfprobeOutput, type FfprobeStream } from '../src/modules/analyzer/ffprobe.ts';
import type { AudioStreamFacts, SubtitleStreamFacts, VideoStreamFacts } from '../src/shared/media-facts.ts';

const fixture = (name: string): FfprobeOutput =>
  FfprobeOutput.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/analyzer-ffprobe-${name}.json`, import.meta.url)), 'utf8')),
  );

const map = (probe: FfprobeOutput, relPath = 'x/x.mkv', hdr10Plus: number[] = []) =>
  mapFacts({
    probe,
    location: { rootName: 'Film', relPath },
    sizeBytes: 1000,
    mtimeMs: 5,
    sidecars: [],
    hdr10PlusStreams: new Set(hdr10Plus),
  });

const one = (stream: Partial<FfprobeStream> & { codec_type: string }) =>
  map({ streams: [{ index: 0, ...stream }], chapters: [], format: { format_name: 'matroska,webm' } }).facts.streams[0];

const video = (i: number, probe: FfprobeOutput, hdr10Plus: number[] = []) =>
  map(probe, 'x/x.mkv', hdr10Plus).facts.streams[i] as VideoStreamFacts;

describe('MediaFacts from real ffprobe output (S1 fixtures)', () => {
  it('Blade Runner 2049: UHD HDR10, TrueHD lossless, commentary, PGS forced, SRT, ASS, chapters', () => {
    const { facts, others } = map(fixture('br2049'), 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv');
    expect(facts).toMatchObject({ container: 'matroska', durationMs: 30005, bitRate: 99569471, analyzerVersion: 2 });
    expect(facts.streams.map((s) => `${s.type}:${s.codec}`)).toEqual([
      'video:hevc', 'audio:truehd', 'audio:eac3', 'audio:ac3',
      'subtitle:hdmv_pgs_subtitle', 'subtitle:hdmv_pgs_subtitle', 'subtitle:subrip', 'subtitle:ass',
    ]);
    expect(others).toEqual([]);
    expect(facts.streams[0]).toMatchObject({
      width: 3840, height: 2160, frameRate: 60, bitDepth: 10, profile: 'Main 10', colorTransfer: 'smpte2084',
      colorPrimaries: 'bt2020', hdr: 'HDR10', hdrFallback: [], dolbyVision: null, attachedPic: false, default: true,
    });
    expect(facts.streams[1]).toMatchObject({
      language: 'ita', title: 'TrueHD 5.1', default: true, channels: 6, channelLayout: '5.1(side)', sampleRate: 48000,
      lossless: true, objectAudio: null, commentary: false,
    });
    expect(facts.streams[2]).toMatchObject({ language: 'eng', lossless: false, bitRate: 448000, default: false });
    expect(facts.streams[3]).toMatchObject({ language: 'ita', channels: 2, commentary: true, lossless: false });
    expect(facts.streams[4]).toMatchObject({ language: 'ita', kind: 'image', forced: true, sdh: false });
    expect(facts.streams[5]).toMatchObject({ kind: 'image', forced: false });
    expect(facts.streams[6]).toMatchObject({ kind: 'text', language: 'ita' });
    expect(facts.streams[7]).toMatchObject({ kind: 'text', language: 'eng', title: 'ASS styled' });
    expect(facts.chapters).toEqual([
      { index: 0, title: 'Capitolo 1', startMs: 0, endMs: 10000 },
      { index: 1, title: 'Capitolo 2', startMs: 10000, endMs: 20000 },
      { index: 2, title: 'Capitolo 3', startMs: 20000, endMs: 30000 },
    ]);
    expect(facts.location).toEqual({ rootName: 'Film', relPath: 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv' });
  });

  it('Dune: Dolby Vision 8.1 with HDR10 fallback (HDR10+ when found in the first frame)', () => {
    expect(video(0, fixture('dune'))).toMatchObject({
      hdr: 'DV',
      hdrFallback: ['HDR10'],
      dolbyVision: { profile: 8, level: 9, blCompatId: 1, hasEnhancementLayer: false, rpuPresent: true },
    });
    expect(video(0, fixture('dune'), [0]).hdrFallback).toEqual(['HDR10+', 'HDR10']);
    const subs = map(fixture('dune')).facts.streams.filter((s) => s.type === 'subtitle');
    expect(subs).toMatchObject([{ codec: 'subrip', language: 'ita', forced: true }]);
  });

  it('Oppenheimer: Dolby Vision 5 has no fallback; FLAC is lossless', () => {
    const { facts } = map(fixture('oppenheimer'));
    expect(facts.streams[0]).toMatchObject({
      hdr: 'DV', hdrFallback: [], colorTransfer: null,
      dolbyVision: { profile: 5, blCompatId: 0, hasEnhancementLayer: false },
    });
    expect(facts.streams[1]).toMatchObject({ codec: 'flac', lossless: true, channels: 6, language: 'eng' });
  });

  it('Il Buono: SDR AVC, DTS core is lossy, PGS SDH', () => {
    const { facts } = map(fixture('ilbuono'));
    expect(facts.streams[0]).toMatchObject({ codec: 'h264', hdr: 'SDR', bitDepth: 8, colorPrimaries: 'bt709', colorTransfer: null });
    expect(facts.streams[1]).toMatchObject({ codec: 'dts', profile: 'DTS', lossless: false, objectAudio: null, bitRate: 1411200 });
    expect(facts.streams[3]).toMatchObject({ kind: 'image', sdh: true, language: 'eng' });
  });

  it('Dark: German tagged as 639-2/T is normalised to /B', () => {
    const langs = map(fixture('dark')).facts.streams.map((s) => s.language);
    expect(langs).toEqual([null, 'ger', 'ita', 'ita']);
  });
});

describe('HDR classification', () => {
  const dovi = (profile: number, compat: number, el = 0) => ({
    side_data_type: 'DOVI configuration record',
    dv_profile: profile, dv_level: 6, rpu_present_flag: 1, el_present_flag: el, bl_present_flag: 1,
    dv_bl_signal_compatibility_id: compat,
  });
  const v = (over: Partial<FfprobeStream>): FfprobeStream => ({ index: 0, codec_type: 'video', codec_name: 'hevc', ...over });
  it.each([
    ['PQ → HDR10', v({ color_transfer: 'smpte2084' }), false, { hdr: 'HDR10', hdrFallback: [] }],
    ['PQ + dynamic metadata → HDR10+', v({ color_transfer: 'smpte2084' }), true, { hdr: 'HDR10+', hdrFallback: ['HDR10'] }],
    ['HLG', v({ color_transfer: 'arib-std-b67' }), false, { hdr: 'HLG', hdrFallback: [] }],
    ['BT.709', v({ color_transfer: 'bt709' }), false, { hdr: 'SDR', hdrFallback: [] }],
    ['untagged', v({}), false, { hdr: 'SDR', hdrFallback: [] }],
    ['DV P7 FEL (UHD Blu-ray)', v({ color_transfer: 'smpte2084', side_data_list: [dovi(7, 6, 1)] }), false,
      { hdr: 'DV', hdrFallback: ['HDR10'], dolbyVision: { profile: 7, blCompatId: 6, hasEnhancementLayer: true } }],
    ['DV P8.1', v({ color_transfer: 'smpte2084', side_data_list: [dovi(8, 1)] }), false, { hdr: 'DV', hdrFallback: ['HDR10'] }],
    ['DV P8.2', v({ color_transfer: 'bt709', side_data_list: [dovi(8, 2)] }), false, { hdr: 'DV', hdrFallback: ['SDR'] }],
    ['DV P8.4', v({ color_transfer: 'arib-std-b67', side_data_list: [dovi(8, 4)] }), false, { hdr: 'DV', hdrFallback: ['HLG'] }],
    ['DV P5 even if tagged PQ', v({ color_transfer: 'smpte2084', side_data_list: [dovi(5, 0)] }), false, { hdr: 'DV', hdrFallback: [] }],
    ['DV P8 without compat id: base layer from transfer', v({ color_transfer: 'smpte2084', side_data_list: [dovi(8, 0)] }), false,
      { hdr: 'DV', hdrFallback: ['HDR10'] }],
  ])('%s', (_label, stream, hdr10Plus, expected) => {
    expect(classifyHdr(stream, hdr10Plus)).toMatchObject(expected);
  });

  it('only PQ video streams get the first-frame probe', () => {
    expect(mayCarryHdr10Plus(v({ color_transfer: 'smpte2084' }))).toBe(true);
    expect(mayCarryHdr10Plus(v({ color_transfer: 'arib-std-b67' }))).toBe(false);
    expect(mayCarryHdr10Plus(v({ color_transfer: 'smpte2084', disposition: { attached_pic: 1 } }))).toBe(false);
  });
});

describe('audio: lossless and object audio', () => {
  it.each([
    ['truehd', null, true],
    ['truehd', 'Dolby TrueHD + Dolby Atmos', true],
    ['flac', null, true],
    ['pcm_s24le', null, true],
    ['dts', 'DTS-HD MA', true],
    ['dts', 'DTS-HD MA + DTS:X', true],
    ['dts', 'DTS-HD HRA', false],
    ['dts', 'DTS', false],
    ['dts', null, false],
    ['eac3', 'Dolby Digital Plus + Dolby Atmos', false],
    ['ac3', null, false],
    ['aac', 'LC', false],
  ])('%s / %s → lossless %s', (codec, profile, expected) => {
    expect(isLossless(codec, profile)).toBe(expected);
  });

  it.each([
    ['truehd', 'Dolby TrueHD + Dolby Atmos', null, 'atmos'],
    ['eac3', 'Dolby Digital Plus + Dolby Atmos', null, 'atmos'],
    ['truehd', null, 'TrueHD Atmos 7.1', 'atmos'],
    ['dts', 'DTS-HD MA + DTS:X', null, 'dtsx'],
    ['dts', 'DTS-HD MA + DTS:X IMAX', null, 'dtsx'],
    ['dts', 'DTS-HD MA', 'DTS:X 7.1.4', 'dtsx'],
    ['dts', 'DTS-HD MA', 'DTS-HD MA 7.1', null],
    ['ac3', null, 'Atmos', null], // AC-3 cannot carry Atmos
    ['truehd', null, 'TrueHD 7.1', null],
  ])('%s / %s / %s → %s', (codec, profile, title, expected) => {
    expect(objectAudioOf(codec, profile, title)).toBe(expected);
  });

  it('commentary from disposition or title, bitrate from Matroska statistics tags', () => {
    expect(one({ codec_type: 'audio', codec_name: 'ac3', tags: { title: "Director's Commentary" } })).toMatchObject({ commentary: true });
    expect(one({ codec_type: 'audio', codec_name: 'ac3', disposition: { comment: 1 } })).toMatchObject({ commentary: true });
    expect(one({ codec_type: 'audio', codec_name: 'ac3', tags: { title: 'Italiano 5.1' } })).toMatchObject({ commentary: false });
    expect(one({ codec_type: 'audio', codec_name: 'truehd', tags: { 'BPS-eng': '4521000' } })).toMatchObject({ bitRate: 4521000 });    expect(one({ codec_type: 'audio', codec_name: 'ac3', disposition: { visual_impaired: 1 } })).toMatchObject({ audioDescription: true, commentary: false });
    expect(one({ codec_type: 'audio', codec_name: 'ac3' })).toMatchObject({ audioDescription: false });
  });
});

describe('subtitles and other streams', () => {
  it('flags from disposition or title; event count from statistics tags', () => {
    const s = (over: Partial<FfprobeStream>) => one({ codec_type: 'subtitle', codec_name: 'subrip', ...over }) as SubtitleStreamFacts;
    expect(s({ tags: { title: 'Forzati' } })).toMatchObject({ forced: true, kind: 'text' });
    expect(s({ tags: { title: 'English SDH' } })).toMatchObject({ sdh: true });
    expect(s({ disposition: { captions: 1 } })).toMatchObject({ sdh: true });
    expect(s({ tags: { NUMBER_OF_FRAMES: '1234' } })).toMatchObject({ eventCount: 1234 });
    expect(s({ codec_name: 'dvd_subtitle' })).toMatchObject({ kind: 'image', eventCount: null });
    expect(s({ tags: { title: 'Commento del regista' } })).toMatchObject({ commentary: true });
    expect(s({ disposition: { comment: 1 } })).toMatchObject({ commentary: true });
    expect(s({ tags: { title: 'Italiano' } })).toMatchObject({ commentary: false });
  });

  it.each([
    ['Forced', true],
    ['Forzati', true],
    ['Italiano (forzati)', true],
    ['English (Non-Forced)', false],
    ['Completi (non forzati)', false],
    ['Not forced', false],
    ['senza forzati', false],
    ['no_forced', false],
    ['Full', false],
    [null, false],
  ] as const)('title %j says forced: %s', (title, forced) => {
    expect(titleSaysForced(title)).toBe(forced);
    const s = one({ codec_type: 'subtitle', codec_name: 'subrip', ...(title === null ? {} : { tags: { title } }) }) as SubtitleStreamFacts;
    expect(s.forced).toBe(forced);
  });

  it('keeps attachments out of MediaFacts.streams and reports commentary subtitles', () => {
    const r = map({
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'subtitle', codec_name: 'ass', disposition: { comment: 1 } },
        { index: 2, codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'Font.ttf', mimetype: 'font/ttf' } },
      ],
      chapters: [],
    });
    expect(r.facts.streams).toHaveLength(2);
    expect(r.others).toEqual([{ index: 2, type: 'attachment', codec: 'ttf', attrs: { filename: 'Font.ttf', mimeType: 'font/ttf' } }]);
    expect([...r.commentarySubtitles]).toEqual([1]);
  });

  it('language und is null', () => {
    expect((one({ codec_type: 'audio', codec_name: 'ac3', tags: { language: 'und' } }) as AudioStreamFacts).language).toBeNull();
  });
});

describe('small parsers', () => {
  it.each([
    ['24000/1001', 23.976],
    ['60/1', 60],
    ['25', 25],
    ['0/0', null],
    [undefined, null],
  ])('frame rate %s → %s', (rate, expected) => {
    expect(parseFrameRate(rate)).toBe(expected);
  });

  it.each([
    [{ bits_per_raw_sample: '10' }, 10],
    [{ pix_fmt: 'yuv420p10le' }, 10],
    [{ pix_fmt: 'p010le' }, 10],
    [{ pix_fmt: 'yuv420p12le' }, 12],
    [{ pix_fmt: 'yuv420p' }, 8],
    [{ pix_fmt: 'yuvj420p' }, 8],
    [{}, null],
  ])('bit depth %j → %s', (over, expected) => {
    expect(bitDepthOf({ index: 0, codec_type: 'video', ...over })).toBe(expected);
  });

  it.each([
    ['matroska,webm', 'a/b.mkv', 'matroska'],
    ['matroska,webm', 'a/b.webm', 'webm'],
    ['mov,mp4,m4a,3gp,3g2,mj2', 'a/b.mp4', 'mp4'],
    ['mov,mp4,m4a,3gp,3g2,mj2', 'a/b.m4v', 'mp4'],
    ['mpegts', 'a/b.m2ts', 'mpegts'],
    ['avi', 'a/b.avi', 'avi'],
    [undefined, 'a/b.mkv', 'unknown'],
  ])('container %s + %s → %s', (formatName, relPath, expected) => {
    expect(normalizeContainer(formatName, relPath)).toBe(expected);
  });

  it('chapters without a time base fall back to seconds; missing duration is null', () => {
    const { facts } = map({ streams: [], chapters: [{ start_time: '1.5', end_time: '3.25', tags: {} }], format: {} });
    expect(facts.chapters).toEqual([{ index: 0, title: null, startMs: 1500, endMs: 3250 }]);
    expect(facts.durationMs).toBeNull();
  });

  it.each([
    // Matroska's Duration is the last timestamp: zero-based, start_time comes off (the keyframe index rule).
    ['x/x.mkv', 'matroska,webm', '23.500', '3.500', 20_000],
    ['x/x.mkv', 'matroska,webm', '20.000', '0.000', 20_000],
    // Other containers already report the length.
    ['x/x.mp4', 'mov,mp4,m4a,3gp,3g2,mj2', '20.000', '3.500', 20_000],
    ['x/x.m2ts', 'mpegts', '20.000', '600.000', 20_000],
  ])('duration of %s (%s, duration %s, start_time %s) is %i ms', (relPath, format_name, duration, start_time, want) => {
    expect(map({ streams: [], chapters: [], format: { format_name, duration, start_time } }, relPath).facts.durationMs).toBe(want);
  });
});
