// Decision Engine table tests: one row per case of doc 04 §4 and the S2 measures (H1, H2, H3, H6, H7),
// plus exclusions (doc 04 §8), prefs (doc 04 §3.1) and the version choice (doc 04 §3, D2).
import { describe, expect, it } from 'vitest';
import { type ChoiceStrength, decide, type DecideInput, type Decision, explainActions, type TrackPick, type TrackSelection } from '../src/modules/playback/decision/index.ts';
import type { PlanExclusion, PlaybackPlan, ReasonCode } from '../src/shared/playback-plan.ts';
import type { ClientCapabilities, PlayableFile, ProfilePlaybackPrefs } from '../src/shared/ports.ts';
import { aac, ac3, audio, chrome, dv, edge, facts, file, firefox, googleTv, prefs, sdr1080, sidecar, srt, sub, video } from './playback-fixtures.ts';

const F1 = '01936f0e-0000-7000-8000-000000000001';
const F2 = '01936f0e-0000-7000-8000-000000000002';

function input(files: PlayableFile[], caps: ClientCapabilities, o: Partial<DecideInput> = {}): DecideInput {
  return {
    files,
    capabilities: caps,
    prefs: prefs(),
    selection: {},
    startPositionMs: 0,
    constraints: { transcode: 'available', transcodeMaxBitrateBps: 20_000_000 },
    exclusions: [],
    ...o,
  };
}

function plan(d: Decision): PlaybackPlan {
  if (!d.ok) throw new Error(`expected a plan, got ${d.code}: ${d.reasons.map((r) => r.message).join('; ')}`);
  return d.plan;
}
const codes = (d: Decision): ReasonCode[] => (d.ok ? d.plan.reasons : d.reasons).map((r) => r.code);
/** Reason codes as a set: the order of the reasons is presentation, not behaviour. */
const codeSet = (d: Decision): Set<ReasonCode> => new Set(codes(d));
/** A track pick; explicit and valid on any file by default. */
const pick = <Id extends string | null>(trackId: Id, strength: ChoiceStrength = 'explicit', fileId: string | null = null): TrackPick<Id> => ({ trackId, fileId, strength });

/** UHD Blu-ray remux: HEVC Main10 HDR10, TrueHD 7.1 eng (Atmos), PGS ita (S1 Blade Runner shape). */
const uhdRemux = () =>
  file(F1, facts([video(), audio(1, { objectAudio: 'atmos', profile: 'Dolby TrueHD + Dolby Atmos' }), sub(2)], { bitRate: 62_000_000 }));

describe('UHD HEVC HDR10 + TrueHD 7.1 + PGS in the three browsers (doc 04 §4.1–§4.4, S2 H1/H2/H6/H7)', () => {
  it.each([
    ['Chrome', chrome()],
    ['Edge', edge()],
    ['Firefox', firefox()],
  ])('%s: Direct Stream, hvc1, FLAC 7.1, PGS rendered by the client, P5 reason', (_name, caps) => {
    const d = decide(input([uhdRemux()], caps, { prefs: prefs({ audioLanguages: ['eng'], subtitleMode: 'always', subtitleLanguages: ['ita'] }) }));
    const p = plan(d);
    expect(p.mode).toBe('direct_stream');
    expect(p.protocol).toBe('hls-fmp4');
    expect(p.video).toMatchObject({ kind: 'copy', tag: 'hvc1', dolbyVision: 'none' });
    expect(p.audio).toEqual({
      source: expect.objectContaining({ trackId: 's1', codec: 'truehd', channels: 8 }),
      action: { kind: 'convert', codec: 'flac', channels: 8, bitrateBps: null, layout: null },
    });
    expect(p.subtitles.selected).toEqual({ trackId: 's2', source: { kind: 'embedded', streamIndex: 2 }, codec: 'hdmv_pgs_subtitle', delivery: 'client_render' });
    expect(p.subtitles.served).toEqual([
      { trackId: 's2', source: { kind: 'embedded', streamIndex: 2 }, codec: 'hdmv_pgs_subtitle', language: 'ita', forced: false, delivery: 'client_render', format: 'sup' },
    ]);
    expect(codeSet(d)).toEqual(new Set(['audio_converted', 'hdr_client_conversion', 'subtitle_client_render']));
    expect(p.reasons.find((r) => r.code === 'hdr_client_conversion')?.message).toBe('HDR10 on an SDR display: conversion left to the browser');
    expect(p.reasons.find((r) => r.code === 'audio_converted')?.message).toBe(
      'Audio TrueHD 7.1 (eng) is not decoded by the client: converted to FLAC 7.1',
    );
  });

  it('a display that shows HDR (or displayHdr absent) gives no conversion reason (P5, I5)', () => {
    for (const displayHdr of [true, undefined]) {
      const caps = { ...chrome(), displayHdr };
      if (displayHdr === undefined) delete caps.displayHdr;
      expect(codes(decide(input([uhdRemux()], caps)))).not.toContain('hdr_client_conversion');
    }
  });

  it('a non-browser client gets "left to the client" (P5)', () => {
    const caps = { ...googleTv(), displayHdr: false, audioTrackSelection: false };
    const p = plan(decide(input([uhdRemux()], caps)));
    expect(p.reasons.find((r) => r.code === 'hdr_client_conversion')?.message).toBe('HDR10 on an SDR display: conversion left to the client');
  });
});

describe('audio, quality first (doc 04 §4.3, P1, S2 H6)', () => {
  const multi = () => file(F1, facts([sdr1080(), audio(1), ac3(2, 'ita'), aac(3, 'ita', { commentary: true, title: 'Commento' })]));

  it('Edge with AC-3: the Italian AC-3 is copied in Direct Stream (several audio tracks)', () => {
    const d = decide(input([multi()], edge()));
    const p = plan(d);
    expect(p.mode).toBe('direct_stream');
    expect(p.audio?.source.trackId).toBe('s2');
    expect(p.audio?.action).toEqual({ kind: 'copy' });
    expect(codeSet(d)).toEqual(new Set(['audio_track_selection', 'audio_copy']));
  });

  it('Chrome with the same file: AC-3 5.1 → FLAC 5.1 (lossless step before any lossy one)', () => {
    const p = plan(decide(input([multi()], chrome())));
    expect(p.audio?.source.trackId).toBe('s2');
    expect(p.audio?.action).toEqual({ kind: 'convert', codec: 'flac', channels: 6, bitrateBps: null, layout: null });
  });

  it('the commentary comes last even when it is the only other Italian track', () => {
    const f = file(F1, facts([sdr1080(), aac(1, 'ita', { commentary: true, lossless: false }), ac3(2, 'ita')]));
    expect(plan(decide(input([f], edge()))).audio?.source.trackId).toBe('s2');
  });

  it('lossless beats lossy, then more channels, within the preferred language', () => {
    const f = file(F1, facts([sdr1080(), ac3(1, 'eng'), audio(2, { language: 'eng', channels: 6, channelLayout: '5.1(side)' }), audio(3, { language: 'eng' })]));
    expect(plan(decide(input([f], chrome(), { prefs: prefs({ audioLanguages: ['eng'] }) }))).audio?.source.trackId).toBe('s3');
  });

  it('no preferred language present: the default track', () => {
    const f = file(F1, facts([sdr1080(), ac3(1, 'eng', { default: false }), ac3(2, 'ger', { default: true })]));
    expect(plan(decide(input([f], edge(), { prefs: prefs({ audioLanguages: ['fre'] }) }))).audio?.source.trackId).toBe('s2');
  });

  it('639-1 preferences are normalised (it → ita)', () => {
    expect(plan(decide(input([multi()], edge(), { prefs: prefs({ audioLanguages: ['it'] }) }))).audio?.source.trackId).toBe('s2');
  });

  it('Chrome without FLAC: TrueHD 7.1 → AAC 5.1 with the 5.1 layout and a downmix reason', () => {
    const caps = { ...chrome(), audio: chrome().audio.filter((a) => a.codec !== 'flac') };
    const d = decide(input([uhdRemux()], caps));
    expect(plan(d).audio?.action).toEqual({ kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 640_000, layout: '5.1' });
    expect(codes(d)).toContain('audio_downmixed');
  });

  it('Edge without FLAC: E-AC-3 5.1 640k before AAC', () => {
    const caps = { ...edge(), audio: edge().audio.filter((a) => a.codec !== 'flac') };
    expect(plan(decide(input([uhdRemux()], caps))).audio?.action).toEqual({ kind: 'convert', codec: 'eac3', channels: 6, bitrateBps: 640_000, layout: '5.1' });
  });

  it('AAC 5.1 with a PCE (no standard layout) is never copied: converted to FLAC', () => {
    const f = file(F1, facts([sdr1080(), aac(1, 'ita', { channels: 6, channelLayout: null })], { container: 'mp4' }));
    const d = decide(input([f], chrome()));
    expect(plan(d).mode).toBe('direct_stream');
    expect(plan(d).audio?.action).toMatchObject({ kind: 'convert', codec: 'flac', channels: 6 });
    expect(plan(d).reasons.find((r) => r.code === 'audio_converted')?.message).toContain('PCE');
  });

  it('a stereo client gets AAC stereo, with a downmix reason', () => {
    const caps: ClientCapabilities = { ...chrome(), audio: [{ codec: 'aac', maxChannels: 2 }] };
    const d = decide(input([uhdRemux()], caps));
    expect(plan(d).audio?.action).toEqual({ kind: 'convert', codec: 'aac', channels: 2, bitrateBps: 192_000, layout: 'stereo' });
    expect(codes(d)).toContain('audio_downmixed');
  });

  it('a multichannel client never gets stereo: with every 5.1 output excluded there is no plan', () => {
    const ex: PlanExclusion[] = ['flac', 'aac', 'opus'].map((codec) => ({ dimension: 'audio', action: 'convert', codec, cause: 'client', error: 'x' }) as PlanExclusion);
    const d = decide(input([uhdRemux()], chrome(), { exclusions: ex }));
    expect(d.ok).toBe(false);
    expect(codes(d)).toContain('audio_unsupported');
  });

  it('no audio format at all for the only track: NO_COMPATIBLE_PLAN', () => {
    const caps: ClientCapabilities = { ...chrome(), audio: [{ codec: 'ac3', maxChannels: 6 }] };
    const d = decide(input([file(F1, facts([sdr1080(), audio(1)]))], caps));
    expect(d).toMatchObject({ ok: false, code: 'NO_COMPATIBLE_PLAN' });
    expect(codes(d)).toContain('audio_unsupported');
  });

  it('the best track without any format falls back to the next one in the same language (P1)', () => {
    const caps: ClientCapabilities = { ...chrome(), audio: [{ codec: 'ac3', maxChannels: 6 }] };
    const f = file(F1, facts([sdr1080(), audio(1, { language: 'ita' }), ac3(2, 'ita')]));
    const d = decide(input([f], caps));
    expect(plan(d).audio?.source.trackId).toBe('s2');
    expect(codes(d)).toContain('audio_unsupported');
  });

  it('an explicit audio track is honoured even if it costs a conversion', () => {
    const p = plan(decide(input([file(F1, facts([sdr1080(), ac3(1, 'ita'), audio(2)]))], edge(), { selection: { audio: pick('s2') } })));
    expect(p.audio?.source.trackId).toBe('s2');
    expect(p.audio?.action).toMatchObject({ codec: 'flac' });
  });

  it('a file without audio plays with audio null', () => {
    const p = plan(decide(input([file(F1, facts([sdr1080()], { container: 'mp4' }))], chrome())));
    expect(p.mode).toBe('direct_play');
    expect(p.audio).toBeNull();
  });
});

describe('container and Direct Play (doc 04 §4.1, S2 H1)', () => {
  it('a single-track MKV with AAC plays directly in Chrome (S2 d1)', () => {
    const d = decide(input([file(F1, facts([sdr1080(), aac(1, 'ita')]))], chrome()));
    const p = plan(d);
    expect(p.mode).toBe('direct_play');
    expect(p.protocol).toBe('progressive');
    expect(p.video).toEqual({ kind: 'original', source: expect.objectContaining({ codec: 'h264' }) });
    expect(p.audio?.action).toEqual({ kind: 'copy' });
    expect(codeSet(d)).toEqual(new Set(['direct_play']));
  });

  it('a single-track MKV with AC-3 plays directly in Edge (S2 d2/d3)', () => {
    expect(plan(decide(input([file(F1, facts([sdr1080(), ac3(1, 'ita')]))], edge()))).mode).toBe('direct_play');
  });

  it('a multi-track MKV goes to Direct Stream with the audio copied', () => {
    const d = decide(input([file(F1, facts([sdr1080(), aac(1, 'ita'), aac(2, 'eng')]))], chrome()));
    expect(plan(d).mode).toBe('direct_stream');
    expect(plan(d).video).toMatchObject({ kind: 'copy', tag: null });
    expect(plan(d).audio?.action).toEqual({ kind: 'copy' });
    expect(codes(d)[0]).toBe('audio_track_selection');
  });

  it('FLAC in MKV is not measured for Direct Play in the browser: Direct Stream with FLAC copied', () => {
    const d = decide(input([file(F1, facts([sdr1080(), audio(1, { codec: 'flac', language: 'ita', channels: 6, channelLayout: '5.1' })]))], chrome()));
    expect(plan(d).mode).toBe('direct_stream');
    expect(plan(d).audio?.action).toEqual({ kind: 'copy' });
    expect(codes(d)).toContain('container_unsupported');
  });

  it('a client that selects tracks plays a multi-track MKV directly, PGS from the stream (native player)', () => {
    const d = decide(input([uhdRemux()], googleTv(), { prefs: prefs({ audioLanguages: ['eng'], subtitleMode: 'always' }) }));
    const p = plan(d);
    expect(p.mode).toBe('direct_play');
    expect(p.audio?.source.codec).toBe('truehd');
    expect(p.subtitles).toEqual({ selected: { trackId: 's2', source: { kind: 'embedded', streamIndex: 2 }, codec: 'hdmv_pgs_subtitle', delivery: 'embedded' }, served: [] });
  });

  it('MP4 without progressive support goes to Direct Stream', () => {
    const caps = { ...chrome(), protocols: ['hls-fmp4'] };
    expect(plan(decide(input([file(F1, facts([sdr1080(), aac(1, 'ita')], { container: 'mp4' }))], caps))).mode).toBe('direct_stream');
  });
});

describe('video (doc 04 §4.2, S2 H2/H3, H11, P2)', () => {
  it('DV P8.1 → Direct Stream with hvc1, RPU kept, never Direct Play', () => {
    const d = decide(input([file(F1, facts([dv(8, 1), aac(1, 'ita', { channels: 6, channelLayout: '5.1' })]))], chrome()));
    const p = plan(d);
    expect(p.mode).toBe('direct_stream');
    expect(p.video).toMatchObject({ kind: 'copy', tag: 'hvc1', dolbyVision: 'keep_rpu' });
    expect(codeSet(d)).toEqual(new Set(['dv_direct_play_unmeasured', 'dv_p81_as_hdr10', 'hdr_client_conversion', 'audio_copy']));
    expect(plan(d).reasons.find((r) => r.code === 'dv_p81_as_hdr10')?.message).toBe('Dolby Vision 8.1 served as HDR10 with hvc1, RPU kept');
  });

  it('the plan carries the ffprobe level and the HDR fallback for delivery (codec string, VIDEO-RANGE)', () => {
    const withLevel = plan(decide(input([file(F1, facts([dv(8, 4, { level: 153 }), aac(1, 'ita', { channels: 6, channelLayout: '5.1' })]))], chrome())));
    expect(withLevel.video.source).toMatchObject({ level: 153, hdrFallback: ['HLG'] });
    // Facts stored before F1b.3 have no level: null, never undefined.
    const noLevel = plan(decide(input([file(F1, facts([sdr1080(), aac(1, 'ita')]))], chrome())));
    expect(noLevel.video.source.level).toBeNull();
    expect(noLevel.video.source.hdrFallback).toEqual([]);
  });

  it('DV P7 → Direct Stream with remove_dovi and the provisional H11 reason', () => {
    const d = decide(input([file(F1, facts([dv(7, 6), audio(1)]))], edge()));
    expect(plan(d).video).toMatchObject({ kind: 'copy', tag: 'hvc1', dolbyVision: 'remove_dovi' });
    expect(codes(d)).toContain('dv_p7_remove_dovi');
  });

  it('DV P5 4K → NO_COMPATIBLE_PLAN (no base layer, no 4K Transcode)', () => {
    const d = decide(input([file(F1, facts([dv(5, 0), audio(1)]))], chrome()));
    expect(d).toMatchObject({ ok: false, code: 'NO_COMPATIBLE_PLAN' });
    expect(codes(d)).toEqual(expect.arrayContaining(['dv_p5_transcode', 'transcode_limited']));
  });

  it('DV P5 1080p → NO_COMPATIBLE_PLAN: the software Transcode cannot convert a base layer of no known format (m3)', () => {
    const d = decide(input([file(F1, facts([dv(5, 0, { width: 1920, height: 1080 }), audio(1)]))], chrome()));
    expect(d).toMatchObject({ ok: false, code: 'NO_COMPATIBLE_PLAN' });
    expect(codes(d)).toEqual(expect.arrayContaining(['dv_p5_transcode', 'transcode_limited']));
    expect(d.ok ? null : d.reasons.find((r) => r.code === 'transcode_limited')?.message).toBe(
      'Dolby Vision profile 5 has no HDR10, HLG or SDR base layer: the software Transcode cannot convert it',
    );
  });

  it('DV P8.4 (HLG base) 1080p on a client without HLG → tone-mapped Transcode: the base layer is known', () => {
    const p = plan(decide(input([file(F1, facts([dv(8, 4, { width: 1920, height: 1080 }), audio(1)]))], { ...chrome(), hdr: [] })));
    expect(p.video).toMatchObject({ kind: 'transcode', toneMap: 'to_sdr', causes: ['hdr_tonemap'] });
  });

  it('a DV client plays DV P8.1 directly (native)', () => {
    const caps = { ...googleTv(), hdr: ['HDR10', 'DV8.1'] };
    expect(plan(decide(input([file(F1, facts([dv(8, 1), audio(1)]))], caps))).mode).toBe('direct_play');
  });

  it('1080p H.264 High 10 → software Transcode to H.264 8-bit (P2: up to 1080p)', () => {
    const d = decide(input([file(F1, facts([sdr1080({ profile: 'High 10', bitDepth: 10 }), aac(1, 'ita')]))], chrome()));
    const p = plan(d);
    expect(p.mode).toBe('transcode');
    expect(p.video).toEqual({
      kind: 'transcode',
      source: expect.objectContaining({ codec: 'h264', bitDepth: 10 }),
      codec: 'h264',
      width: 1920,
      height: 1080,
      maxBitrateBps: 20_000_000,
      toneMap: 'none',
      causes: ['codec'],
    });
    expect(p.audio?.action).toEqual({ kind: 'copy' });
    expect(codes(d)).toContain('video_codec_unsupported');
  });

  it('1080p VC-1 → Transcode', () => {
    expect(plan(decide(input([file(F1, facts([sdr1080({ codec: 'vc1', profile: 'Advanced' }), ac3(1, 'ita')]))], chrome()))).mode).toBe('transcode');
  });

  it('4K HEVC on a browser without HEVC → NO_COMPATIBLE_PLAN with transcode_limited', () => {
    const caps = { ...firefox(), video: firefox().video.filter((v) => v.codec !== 'hevc') };
    const d = decide(input([uhdRemux()], caps));
    expect(d).toMatchObject({ ok: false, code: 'NO_COMPATIBLE_PLAN' });
    expect(codeSet(d)).toEqual(new Set(['video_codec_unsupported', 'transcode_limited']));
    expect(d.ok ? [] : d.reasons.map((r) => r.message)).toContain('Source 3840×2160 above 1080p: a Transcode would be needed and is not available for it (P2)');
  });

  it('HDR10 4K to a client without HDR → NO_COMPATIBLE_PLAN; HDR10 1080p → tone-mapped Transcode', () => {
    const caps = { ...chrome(), hdr: [] };
    expect(codes(decide(input([uhdRemux()], caps)))).toEqual(expect.arrayContaining(['hdr_tonemap', 'transcode_limited']));
    const p = plan(decide(input([file(F1, facts([video({ width: 1920, height: 1080 }), aac(1, 'ita')]))], caps)));
    expect(p.video).toMatchObject({ kind: 'transcode', toneMap: 'to_sdr', causes: ['hdr_tonemap'] });
  });

  it('resolution above the client maximum: 1080p downscaled to 720p', () => {
    const caps = { ...chrome(), video: [{ codec: 'h264', profiles: ['high'], maxBitDepth: 8, maxWidth: 1280, maxHeight: 720 }] };
    const p = plan(decide(input([file(F1, facts([sdr1080({ height: 800 }), aac(1, 'ita')]))], caps)));
    // VBV: the 20 Mb/s of a 1080p Transcode scaled by the output area, 1280×532 / 1920×1080.
    expect(p.video).toMatchObject({ kind: 'transcode', width: 1280, height: 532, causes: ['resolution'], maxBitrateBps: 6_567_901 });
  });

  it('bitrate above the client limit: 4K has no plan, 1080p is transcoded under the limit minus the audio', () => {
    const caps = { ...chrome(), limits: { maxBitrate: 10_000_000 } };
    const d4k = decide(input([uhdRemux()], caps));
    expect(codes(d4k)).toEqual(expect.arrayContaining(['video_bitrate_exceeded', 'transcode_limited']));
    const p = plan(decide(input([file(F1, facts([sdr1080(), aac(1, 'ita')], { bitRate: 30_000_000 }))], caps)));
    expect(p.video).toMatchObject({ kind: 'transcode', causes: ['bitrate'], maxBitrateBps: 10_000_000 - 192_000 });
  });

  it.each([
    ['disabled', 'A Transcode would be needed and is disabled (MAX_TRANSCODES = 0)'],
    ['busy', 'A Transcode would be needed and every transcode slot is taken (P4)'],
  ] as const)('Transcode %s (P4) → NO_COMPATIBLE_PLAN with transcode_disabled', (state, message) => {
    const d = decide(input([file(F1, facts([sdr1080({ codec: 'vc1' }), aac(1, 'ita')]))], chrome(), { constraints: { transcode: state, transcodeMaxBitrateBps: 20_000_000 } }));
    expect(d.ok).toBe(false);
    expect(d.ok ? [] : d.reasons.map((r) => r.message)).toContain(message);
  });
});

describe('subtitles (doc 04 §3.1, §4.4, P3)', () => {
  const withSubs = (v = sdr1080()) =>
    file(
      F1,
      facts(
        [
          v,
          ac3(1, 'ita'),
          audio(2),
          sub(3, { language: 'ita', forced: true }),
          sub(4, { language: 'ita' }),
          srt(5, 'eng'),
          sub(6, { codec: 'dvd_subtitle', language: 'fre' }),
          sub(7, { language: 'ita', sdh: true }),
        ],
        { sidecars: [sidecar({ id: 'x:1a2b3c4d', relPath: 'Film (2017)/Film (2017).en.srt' }), sidecar({ id: 'x:5e6f7a8b', relPath: 'Film (2017)/Film (2017).it.ass', format: 'ass', language: 'ita' })] },
      ),
    );
  const sel = (d: Decision) => plan(d).subtitles.selected?.trackId ?? null;

  it('served lists every track the client gets separately: PGS as .sup, text as WebVTT, VobSub not', () => {
    const p = plan(decide(input([withSubs()], edge())));
    expect(p.subtitles.served.map((s) => [s.trackId, s.delivery, s.format])).toEqual([
      ['s3', 'client_render', 'sup'],
      ['s4', 'client_render', 'sup'],
      ['s5', 'sidecar', 'webvtt'],
      ['s7', 'client_render', 'sup'],
      ['x:1a2b3c4d', 'sidecar', 'webvtt'],
      ['x:5e6f7a8b', 'sidecar', 'webvtt'],
    ]);
    expect(p.subtitles.served[4]?.source).toEqual({ kind: 'sidecar', relPath: 'Film (2017)/Film (2017).en.srt', format: 'srt' });
  });

  const rows: [string, Partial<ProfilePlaybackPrefs>, TrackSelection, string | null][] = [
    ['off', { subtitleMode: 'off' }, {}, null],
    ['forced: the forced track in the audio language', { subtitleMode: 'forced' }, {}, 's3'],
    ['forced with English audio: no forced English track', { subtitleMode: 'forced', audioLanguages: ['eng'] }, {}, null],
    ['always: full track first, not SDH', { subtitleMode: 'always', subtitleLanguages: ['ita'] }, {}, 's4'],
    ['always, English: the embedded SRT', { subtitleMode: 'always', subtitleLanguages: ['en'] }, {}, 's5'],
    ['always, French: VobSub is the only one (burn-in on 1080p)', { subtitleMode: 'always', subtitleLanguages: ['fre'] }, {}, 's6'],
    ['always, no language matches', { subtitleMode: 'always', subtitleLanguages: ['jpn'] }, {}, null],
    ['explicit choice beats the prefs', { subtitleMode: 'off' }, { subtitle: pick('x:5e6f7a8b') }, 'x:5e6f7a8b'],
    ['explicit off beats the prefs: only the forced track in the audio language (E-1)', { subtitleMode: 'always' }, { subtitle: pick(null) }, 's3'],
    ['off with English audio: no forced English track, nothing', { subtitleMode: 'always', audioLanguages: ['eng'] }, { subtitle: pick(null) }, null],
    ['remembered off: the forced track too', { subtitleMode: 'off' }, { subtitle: pick(null, 'remembered') }, 's3'],
  ];
  it.each(rows)('%s', (_n, p, selection, expected) => {
    expect(sel(decide(input([withSubs()], edge(), { prefs: prefs(p), selection })))).toBe(expected);
  });

  it('ASS served as WebVTT says the style is lost', () => {
    const d = decide(input([withSubs()], edge(), { selection: { subtitle: pick('x:5e6f7a8b') } }));
    expect(plan(d).reasons.find((r) => r.code === 'subtitle_sidecar')?.message).toBe('Subtitles ASS (ita) served as WebVTT (style lost)');
  });

  it('VobSub on a 1080p source is burned in: Transcode, cause burn_in', () => {
    const d = decide(input([withSubs()], edge(), { selection: { subtitle: pick('s6') } }));
    const p = plan(d);
    expect(p.mode).toBe('transcode');
    expect(p.subtitles.selected).toMatchObject({ trackId: 's6', delivery: 'burned' });
    expect(p.video).toMatchObject({ causes: ['burn_in'] });
    expect(codes(d)).toContain('subtitle_burn_in');
  });

  it('VobSub on a 4K source is never burned: dropped with the reason, Direct Stream goes on (P2)', () => {
    const d = decide(input([withSubs(video())], edge(), { selection: { subtitle: pick('s6') } }));
    const p = plan(d);
    expect(d.ok && d.droppedSubtitleTrackId).toBe('s6');
    expect(p.mode).toBe('direct_stream');
    expect(p.subtitles.selected).toBeNull();
    expect(p.reasons.find((r) => r.code === 'subtitle_dropped')?.message).toMatch(/^Subtitles VobSub \(fre\) cannot be shown: Source 3840×2160 above 1080p/);
  });

  it('Direct Play with an embedded PGS serves the .sup separately in the browser', () => {
    const d = decide(input([file(F1, facts([sdr1080(), aac(1, 'ita'), sub(2)]))], chrome(), { prefs: prefs({ subtitleMode: 'always' }) }));
    expect(plan(d).mode).toBe('direct_play');
    expect(plan(d).subtitles.selected).toMatchObject({ trackId: 's2', delivery: 'client_render' });
    expect(plan(d).subtitles.served).toHaveLength(1);
  });

  it('a sidecar .sup is never burned (m6): dropped with the reason on a client without a PGS renderer, no Transcode', () => {
    const caps = { ...chrome(), subtitles: { text: ['webvtt'], image: [] } };
    const f = file(F1, facts([sdr1080(), aac(1, 'ita')], { sidecars: [sidecar({ id: 'x:0a0b0c0d', relPath: 'Film (2017)/Film (2017).it.sup', format: 'sup', language: 'ita' })] }));
    const d = decide(input([f], caps, { selection: { subtitle: pick('x:0a0b0c0d') } }));
    const p = plan(d);
    expect(d.ok && d.droppedSubtitleTrackId).toBe('x:0a0b0c0d');
    expect(p.mode).toBe('direct_play');
    expect(p.subtitles.selected).toBeNull();
    expect(p.reasons.find((r) => r.code === 'subtitle_dropped')?.message).toMatch(/A sidecar image track \(\.sup\) cannot be burned in/);
  });

  it('a client without a PGS renderer: PGS burned in on 1080p', () => {
    const caps = { ...chrome(), subtitles: { text: ['webvtt'], image: [] } };
    const p = plan(decide(input([file(F1, facts([sdr1080(), aac(1, 'ita'), sub(2)]))], caps, { prefs: prefs({ subtitleMode: 'always' }) })));
    expect(p.mode).toBe('transcode');
    expect(p.subtitles).toEqual({ selected: { trackId: 's2', source: { kind: 'embedded', streamIndex: 2 }, codec: 'hdmv_pgs_subtitle', delivery: 'burned' }, served: [] });
  });
});

describe('exclusions from earlier failures (doc 04 §8)', () => {
  const single = () => file(F1, facts([sdr1080(), aac(1, 'ita')]));
  const ex = (e: Record<string, unknown>): PlanExclusion => ({ ...e, cause: 'client', error: 'MEDIA_ERR_DECODE' }) as PlanExclusion;

  it.each([
    ['video', 'direct_play', 'direct_stream'],
    ['container', 'direct_play', 'direct_stream'],
    ['video', 'direct_stream', 'transcode'],
  ] as const)('%s exclusion of %s → %s, echoed in the plan', (dimension, mode, next) => {
    const exclusions = mode === 'direct_stream' ? [ex({ dimension, fileId: F1, mode: 'direct_play' }), ex({ dimension, fileId: F1, mode })] : [ex({ dimension, fileId: F1, mode })];
    const d = decide(input([single()], chrome(), { exclusions }));
    expect(plan(d).mode).toBe(next);
    expect(plan(d).exclusions).toEqual(exclusions);
    expect(codes(d)[0]).toBe('replanned_after_failure');
    expect(codes(d)).toContain('format_excluded');
  });

  it('Direct Stream excluded on a 4K source: no heavier mode → NO_COMPATIBLE_PLAN', () => {
    const d = decide(input([uhdRemux()], chrome(), { exclusions: [ex({ dimension: 'video', fileId: F1, mode: 'direct_stream' })] }));
    expect(d.ok).toBe(false);
    expect(codes(d)).toEqual(expect.arrayContaining(['format_excluded', 'transcode_limited']));
  });

  it('an exclusion of another file does not apply', () => {
    expect(plan(decide(input([single()], chrome(), { exclusions: [ex({ dimension: 'video', fileId: F2, mode: 'direct_play' })] }))).mode).toBe('direct_play');
  });

  it('audio copy excluded in Direct Play → Direct Stream with the audio converted (doc 04 §8, audio row)', () => {
    const d = decide(input([file(F1, facts([sdr1080(), ac3(1, 'ita')]))], edge(), { exclusions: [ex({ dimension: 'audio', action: 'copy', codec: 'ac3', profile: null })] }));
    expect(plan(d).mode).toBe('direct_stream');
    expect(plan(d).audio?.action).toMatchObject({ kind: 'convert', codec: 'flac', channels: 6 });
  });

  it('audio conversion excluded → one step down (FLAC → E-AC-3 in Edge, → AAC in Chrome)', () => {
    const exclusions = [ex({ dimension: 'audio', action: 'convert', codec: 'flac' })];
    expect(plan(decide(input([uhdRemux()], edge(), { exclusions }))).audio?.action).toMatchObject({ codec: 'eac3' });
    expect(plan(decide(input([uhdRemux()], chrome(), { exclusions }))).audio?.action).toMatchObject({ codec: 'aac', channels: 6 });
  });

  it('subtitle client_render excluded: 1080p → burned in, 4K → dropped', () => {
    const exclusions = [ex({ dimension: 'subtitle', trackId: 's2', delivery: 'client_render', fileId: null })];
    const opts = { prefs: prefs({ subtitleMode: 'always' as const }), exclusions };
    const p1080 = plan(decide(input([file(F1, facts([sdr1080(), aac(1, 'ita'), sub(2)]))], chrome(), opts)));
    expect(p1080.subtitles.selected).toMatchObject({ trackId: 's2', delivery: 'burned' });
    expect(p1080.subtitles.served).toEqual([]);
    const p4k = plan(decide(input([uhdRemux()], chrome(), opts)));
    expect(p4k.mode).toBe('direct_stream');
    expect(p4k.subtitles).toEqual({ selected: null, served: [] });
    expect(p4k.reasons.map((r) => r.code)).toContain('subtitle_dropped');
  });

  it('a subtitle exclusion pinned to a file applies to that file only (track ids are per file)', () => {
    const f1 = file(F1, facts([sdr1080(), aac(1, 'ita'), sub(2)]));
    const f2 = file(F2, facts([sdr1080(), aac(1, 'ita'), sub(2)]));
    const on = (fileId: string | null = null) => ex({ dimension: 'subtitle', trackId: 's2', delivery: 'client_render', fileId });
    const served = (f: PlayableFile, e: PlanExclusion) => plan(decide(input([f], chrome(), { exclusions: [e] }))).subtitles.served.map((s) => s.trackId);
    expect(served(f2, on(F1))).toEqual(['s2']);
    expect(served(f1, on(F1))).toEqual([]);
    expect(served(f2, on())).toEqual([]);
    expect(plan(decide(input([f2], chrome(), { exclusions: [on(F1)] }))).exclusions).toEqual([on(F1)]);
  });

  it('subtitle burn-in excluded → dropped', () => {
    const exclusions = [ex({ dimension: 'subtitle', trackId: 's2', delivery: 'client_render', fileId: null }), ex({ dimension: 'subtitle', trackId: 's2', delivery: 'burned', fileId: null })];
    const p = plan(decide(input([file(F1, facts([sdr1080(), aac(1, 'ita'), sub(2)]))], chrome(), { prefs: prefs({ subtitleMode: 'always' }), exclusions })));
    expect(p.mode).toBe('direct_play');
    expect(p.subtitles.selected).toBeNull();
  });
});

describe('version choice (orchestrator 2026-11-05: no video transcode, then quality, then lighter mode; Domain Model D2)', () => {
  const uhd = () => file(F1, facts([video(), audio(1, { language: 'ita' })]));
  const hd = (streams = [sdr1080(), audio(1, { language: 'ita' })]) => file(F2, facts(streams));

  it('both Direct Stream: the higher quality wins (4K)', () => {
    const d = decide(input([hd(), uhd()], chrome()));
    expect(plan(d).file.fileId).toBe(F1);
    expect(plan(d).reasons[0]).toEqual({ code: 'version_chosen', dimension: 'file', message: 'Version 2160p HEVC HDR10 chosen: higher quality than 1080p H.264' });
    expect(d.ok && d.candidates.map((c) => [c.fileId, c.mode])).toEqual([[F1, 'direct_stream'], [F2, 'direct_stream']]);
  });

  it('quality first: a 4K Direct Stream beats a 1080p Direct Play when the client fits 4K', () => {
    const d = decide(input([uhd(), hd([sdr1080(), aac(1, 'ita')])], chrome()));
    expect(plan(d).file.fileId).toBe(F1);
    expect(plan(d).mode).toBe('direct_stream');
    expect(plan(d).reasons[0]?.message).toBe('Version 2160p HEVC HDR10 chosen: higher quality than 1080p H.264');
  });

  it('a client limited to 1080p: the 1080p Direct Play wins', () => {
    const caps = { ...chrome(), video: chrome().video.map((v) => ({ ...v, maxWidth: 1920, maxHeight: 1080 })) };
    const d = decide(input([uhd(), hd([sdr1080(), aac(1, 'ita')])], caps));
    expect(plan(d).file.fileId).toBe(F2);
    expect(plan(d).mode).toBe('direct_play');
  });

  it('a video transcode always loses: 720p Direct Play over a 1080p version that needs a Transcode', () => {
    const caps = { ...chrome(), video: chrome().video.filter((v) => v.codec !== 'hevc') };
    const hevc1080 = file(F1, facts([sdr1080({ codec: 'hevc', profile: 'Main' }), aac(1, 'ita')]));
    const h264720 = file(F2, facts([sdr1080({ width: 1280, height: 720 }), aac(1, 'ita')]));
    expect(plan(decide(input([hevc1080], caps))).mode).toBe('transcode');
    const d = decide(input([hevc1080, h264720], caps));
    expect(plan(d).file.fileId).toBe(F2);
    expect(plan(d).mode).toBe('direct_play');
    expect(plan(d).reasons[0]?.message).toMatch(/^Version 720p H\.264 chosen: no video transcode, unlike 1080p HEVC/);
  });

  it('equal quality: the lighter mode breaks the tie', () => {
    const twoAudio = file(F1, facts([sdr1080(), aac(1, 'ita'), aac(2, 'eng')])); // multi-audio: Direct Stream in a browser
    const oneAudio = file(F2, facts([sdr1080(), aac(1, 'ita')]));
    const d = decide(input([twoAudio, oneAudio], chrome()));
    expect(plan(d).file.fileId).toBe(F2);
    expect(plan(d).mode).toBe('direct_play');
    expect(plan(d).reasons[0]?.message).toBe('Version 1080p H.264 chosen: lighter mode than 1080p H.264');
  });

  it('the 4K version without a plan leaves the 1080p one', () => {
    const caps = { ...chrome(), video: chrome().video.filter((v) => v.codec !== 'hevc') };
    const d = decide(input([uhd(), hd()], caps));
    expect(plan(d).file.fileId).toBe(F2);
    expect(plan(d).reasons[0]?.message).toBe('Version 1080p H.264 chosen: the only playable version');
  });

  it('an explicit fileId restricts the candidates', () => {
    expect(plan(decide(input([uhd(), hd()], chrome(), { fileId: F2 }))).file.fileId).toBe(F2);
  });

  it('unavailable files are skipped; none available → MEDIA_UNAVAILABLE', () => {
    expect(plan(decide(input([file(F1, uhd().facts, false), hd()], chrome()))).file.fileId).toBe(F2);
    expect(decide(input([file(F1, uhd().facts, false)], chrome()))).toMatchObject({ ok: false, code: 'MEDIA_UNAVAILABLE' });
  });

  it('several files without a plan: reasons are labelled per version', () => {
    const caps = { ...chrome(), video: [] };
    const d = decide(input([uhd(), hd()], caps));
    expect(d.ok ? [] : d.reasons.map((r) => r.message)).toContain('2160p HEVC HDR10: Source 3840×2160 above 1080p: a Transcode would be needed and is not available for it (P2)');
  });
});

describe('start position, forced mode, determinism', () => {
  const single = () => file(F1, facts([sdr1080(), aac(1, 'ita')]));

  it.each([
    [0, 0],
    [3_723_000, 3_723_000],
    [9_999_999, 7_200_000],
  ])('start %i → %i on the original timeline, clamped to the duration', (from, to) => {
    expect(plan(decide(input([single()], chrome(), { startPositionMs: from }))).startPositionMs).toBe(to);
  });

  it('forceMode direct_stream on a Direct Play file', () => {
    const d = decide(input([single()], chrome(), { forceMode: 'direct_stream' }));
    expect(plan(d).mode).toBe('direct_stream');
    expect(codes(d)[0]).toBe('forced_mode');
  });

  it('forceMode transcode on a 4K source has no plan', () => {
    expect(decide(input([uhdRemux()], chrome(), { forceMode: 'transcode' })).ok).toBe(false);
  });

  it('same input, same output (messages included), and the plan survives JSON', () => {
    const i = input([uhdRemux(), file(F2, facts([sdr1080(), ac3(1, 'ita'), sub(2)]))], edge(), {
      prefs: prefs({ subtitleMode: 'always' }),
      exclusions: [{ dimension: 'audio', action: 'convert', codec: 'eac3', cause: 'server', error: 'aac_channel_config' }],
      startPositionMs: 1234,
    });
    const a = decide(i);
    const b = decide(structuredClone(i));
    expect(b).toStrictEqual(a);
    expect(JSON.parse(JSON.stringify(plan(a)))).toStrictEqual(plan(a));
  });

  it('explain actions per dimension', () => {
    expect(explainActions(plan(decide(input([uhdRemux()], chrome(), { prefs: prefs({ subtitleMode: 'always' }) }))))).toEqual({
      container: 'remux',
      video: 'none',
      audio: 'convert:flac',
      subtitles: 'remux',
    });
    expect(explainActions(plan(decide(input([single()], chrome()))))).toEqual({ container: 'none', video: 'none', audio: 'none', subtitles: 'none' });
  });
});

describe('track ids across versions (E1: ids are file-local, doc 04 §3.1)', () => {
  /** 4K: TrueHD eng s1, AC-3 ita s2, PGS ita s3, PGS eng s4. */
  const v4k = () => file(F1, facts([video(), audio(1, { language: 'eng' }), ac3(2, 'ita'), sub(3, { language: 'ita' }), sub(4, { language: 'eng' })]));
  /** 1080p: the same tracks in another order: AC-3 ita s1, TrueHD eng s2, PGS eng s3, PGS ita s4. */
  const v1080 = (ita = ac3(1, 'ita')) => file(F2, facts([sdr1080(), ita, audio(2, { language: 'eng' }), sub(3, { language: 'eng' }), sub(4, { language: 'ita' })]));
  const on1080 = (selection: TrackSelection, p = prefs({ audioLanguages: ['eng'] })) => plan(decide(input([v4k(), v1080()], chrome(), { fileId: F2, selection, prefs: p })));

  it('a pick of the 4K version is matched by descriptor on the 1080p one, never by id', () => {
    const p = on1080({ audio: pick('s2', 'remembered', F1), subtitle: pick('s3', 'remembered', F1) });
    expect(p.audio?.source.trackId).toBe('s1'); // AC-3 ita, not the TrueHD eng that is s2 here
    expect(p.subtitles.selected?.trackId).toBe('s4'); // PGS ita
    expect(on1080({ audio: pick('s1', 'explicit', F1) }).audio?.source.trackId).toBe('s2'); // TrueHD eng
  });

  it('nothing matches on the other version: the prefs decide', () => {
    const p = plan(decide(input([v4k(), v1080(aac(1, 'ita'))], chrome(), { fileId: F2, selection: { audio: pick('s2', 'explicit', F1) }, prefs: prefs({ audioLanguages: ['eng'] }) })));
    expect(p.audio?.source.trackId).toBe('s2'); // eng from the prefs: AAC 2.0 ita is not AC-3 5.1 ita
  });

  it('on its own file the id applies; fileId null applies to any file that has it', () => {
    expect(on1080({ audio: pick('s1', 'explicit', F2) }).audio?.source.trackId).toBe('s1');
    expect(on1080({ audio: pick('s1') }).audio?.source.trackId).toBe('s1');
  });

  it('remembered subtitles off carry over to another version', () => {
    expect(on1080({ subtitle: pick(null, 'remembered', F1) }, prefs({ subtitleMode: 'always', subtitleLanguages: ['ita'] })).subtitles.selected).toBeNull();
  });
});

describe('remembered choices are soft, explicit ones hard (E1, doc 04 §3.1 step 2)', () => {
  it('a remembered commentary is demoted; an explicit one is honoured', () => {
    const f = file(F1, facts([sdr1080(), ac3(1, 'ita', { default: false }), ac3(2, 'ita', { commentary: true })]));
    expect(plan(decide(input([f], edge(), { selection: { audio: pick('s2', 'remembered', F1) } }))).audio?.source.trackId).toBe('s1');
    expect(plan(decide(input([f], edge(), { selection: { audio: pick('s2', 'explicit', F1) } }))).audio?.source.trackId).toBe('s2');
  });

  it('a remembered track without any format falls back (P1); the same explicit track has no plan', () => {
    const caps: ClientCapabilities = { ...chrome(), audio: [{ codec: 'ac3', maxChannels: 6 }] };
    const f = file(F1, facts([sdr1080(), audio(1, { language: 'ita' }), ac3(2, 'ita')]));
    expect(plan(decide(input([f], caps, { selection: { audio: pick('s1', 'remembered', F1) } }))).audio?.source.trackId).toBe('s2');
    expect(decide(input([f], caps, { selection: { audio: pick('s1', 'explicit', F1) } }))).toMatchObject({ ok: false, code: 'NO_COMPATIBLE_PLAN' });
  });

  it('a remembered subtitle that needs a burn-in gives way to the prefs; an explicit one is burned', () => {
    const f = file(F1, facts([sdr1080(), aac(1, 'ita'), sub(2, { codec: 'dvd_subtitle', language: 'fre' })]));
    expect(plan(decide(input([f], chrome(), { selection: { subtitle: pick('s2', 'remembered', F1) } }))).subtitles.selected).toBeNull();
    expect(plan(decide(input([f], chrome(), { selection: { subtitle: pick('s2', 'explicit', F1) } }))).subtitles.selected).toMatchObject({ delivery: 'burned' });
  });
});

describe('Dolby Vision on a native player without DV (E2, doc 04 §4.1–4.2)', () => {
  // Google TV declaring HDR10 and HLG only, with audioTrackSelection: plays the base layer of the file.
  it.each([
    ['P7 FEL', dv(7, 6)],
    ['P8.1', dv(8, 1)],
  ])('%s: Direct Play of the HDR10 base layer', (_n, v) => {
    const d = decide(input([file(F1, facts([v, audio(1)]))], googleTv()));
    expect(plan(d).mode).toBe('direct_play');
    expect(plan(d).video.kind).toBe('original');
    expect(codeSet(d)).toEqual(new Set(['direct_play', 'dv_base_layer']));
  });

  it('P7 in Direct Stream on a native player keeps the RPU: remove_dovi is for browsers only', () => {
    const p = plan(decide(input([file(F1, facts([dv(7, 6), audio(1)]))], googleTv(), { forceMode: 'direct_stream' })));
    expect(p.video).toMatchObject({ kind: 'copy', tag: 'hvc1', dolbyVision: 'keep_rpu' });
  });

  it('AV1 DV in the browser: Direct Stream without the hvc1 wording', () => {
    const caps = { ...chrome(), video: [...chrome().video, { codec: 'av1', profiles: ['main'], maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160 }] };
    const p = plan(decide(input([file(F1, facts([dv(10, 1, { codec: 'av1', profile: 'Main' }), aac(1, 'ita')]))], caps)));
    expect(p.video).toMatchObject({ kind: 'copy', tag: null, dolbyVision: 'keep_rpu' });
    expect(p.reasons.find((r) => r.code === 'dv_p81_as_hdr10')?.message).toBe('Dolby Vision 10.1 served as HDR10, RPU kept');
  });
});

describe('bitrate limit per mode (E3, doc 04 §4.5)', () => {
  it('Direct Play compares the file rate, Direct Stream the video rate plus the audio served', () => {
    const caps = { ...googleTv(), limits: { maxBitrate: 20_000_000 } };
    // Video rate unknown: 25 Mb/s file − 8.192 Mb/s of audio tracks = 16.808 Mb/s, + AAC 192 kb/s served.
    const f = file(F1, facts([sdr1080(), aac(1, 'ita'), audio(2, { bitRate: 8_000_000 })], { bitRate: 25_000_000 }));
    const p = plan(decide(input([f], caps)));
    expect(p.mode).toBe('direct_stream');
    expect(p.reasons.map((r) => r.message)).toContain('File bitrate 25 Mb/s above the client limit 20 Mb/s');
  });

  it('video and audio above the limit: Transcode with cause bitrate', () => {
    const caps = { ...googleTv(), limits: { maxBitrate: 10_000_000 } };
    const f = file(F1, facts([sdr1080({ bitRate: 12_000_000 }), aac(1, 'ita')]));
    const d = decide(input([f], caps));
    expect(plan(d).video).toMatchObject({ kind: 'transcode', causes: ['bitrate'] });
    expect(d.ok ? d.plan.reasons.map((r) => r.message) : []).toContain('Video and audio bitrate 12.2 Mb/s above the client limit 10 Mb/s');
  });
});

describe('gap cases', () => {
  const dtsHd = (o = {}) => audio(1, { codec: 'dts', profile: 'DTS-HD MA', language: 'ita', ...o });
  const dtsCore = () => audio(1, { codec: 'dts', profile: 'DTS', language: 'ita', channels: 6, channelLayout: '5.1(side)', lossless: false, bitRate: 1_509_000 });

  it('1080p H.264 + DTS-HD MA and a DTS core on a DTS-HD client: both copied in Direct Play', () => {
    for (const a of [dtsHd(), dtsCore()]) {
      const p = plan(decide(input([file(F1, facts([sdr1080(), a]))], googleTv())));
      expect(p.mode).toBe('direct_play');
      expect(p.audio?.action).toEqual({ kind: 'copy' });
    }
  });

  it('DTS-HD MA on a client with a DTS core decoder only: converted, never copied', () => {
    const caps: ClientCapabilities = { ...googleTv(), audio: [{ codec: 'dts', maxChannels: 6, mode: 'passthrough' }, { codec: 'aac', maxChannels: 6, mode: 'decode' }] };
    expect(plan(decide(input([file(F1, facts([sdr1080(), dtsHd()]))], caps))).audio?.action).toMatchObject({ kind: 'convert', codec: 'aac', channels: 6 });
  });

  it('a DTS-HD MA copy exclusion leaves a DTS core alone (codec and profile)', () => {
    const exclusions: PlanExclusion[] = [{ dimension: 'audio', action: 'copy', codec: 'dts', profile: 'DTS-HD MA', cause: 'client', error: 'x' }];
    expect(plan(decide(input([file(F1, facts([sdr1080(), dtsCore()]))], googleTv(), { exclusions }))).audio?.action).toEqual({ kind: 'copy' });
    expect(plan(decide(input([file(F1, facts([sdr1080(), dtsHd()]))], googleTv(), { exclusions }))).audio?.action.kind).toBe('convert');
  });

  it('E-AC-3 7.1 on Edge (E-AC-3 up to 5.1): FLAC 7.1', () => {
    const f = file(F1, facts([sdr1080(), audio(1, { codec: 'eac3', language: 'ita', lossless: false })]));
    expect(plan(decide(input([f], edge()))).audio?.action).toEqual({ kind: 'convert', codec: 'flac', channels: 8, bitrateBps: null, layout: null });
  });

  it('MP4 with two audio tracks in a browser: Direct Stream (audio_track_selection)', () => {
    const d = decide(input([file(F1, facts([sdr1080(), aac(1, 'ita'), aac(2, 'eng')], { container: 'mp4' }))], chrome()));
    expect(plan(d).mode).toBe('direct_stream');
    expect(codeSet(d)).toContain('audio_track_selection');
  });

  it('Atmos beats DTS-HD MA at 7.1 (object audio, P1)', () => {
    const f = file(F1, facts([sdr1080(), dtsHd({ language: 'eng' }), audio(2, { objectAudio: 'atmos', default: false })]));
    expect(plan(decide(input([f], chrome(), { prefs: prefs({ audioLanguages: ['eng'] }) }))).audio?.source.trackId).toBe('s2');
  });

  it('at equal quality the track the client copies wins (minimal conversion, P1)', () => {
    const f = file(F1, facts([sdr1080(), ac3(1, 'eng', { default: true }), aac(2, 'eng', { channels: 6, channelLayout: '5.1', default: false })]));
    const p = plan(decide(input([f], chrome(), { prefs: prefs({ audioLanguages: ['eng'] }) })));
    expect(p.audio).toMatchObject({ source: { trackId: 's2' }, action: { kind: 'copy' } });
  });

  it('an audio description is demoted like a commentary', () => {
    const f = file(F1, facts([sdr1080(), audio(1, { language: 'ita', audioDescription: true }), ac3(2, 'ita', { default: false })]));
    expect(plan(decide(input([f], edge()))).audio?.source.trackId).toBe('s2');
  });

  it('a commentary subtitle comes last', () => {
    const f = file(F1, facts([sdr1080(), aac(1, 'ita'), sub(2, { commentary: true }), sub(3)]));
    expect(plan(decide(input([f], chrome(), { prefs: prefs({ subtitleMode: 'always' }) }))).subtitles.selected?.trackId).toBe('s3');
  });

  it('forced sidecar subtitles in the audio language', () => {
    const f = file(F1, facts([sdr1080(), aac(1, 'ita')], { sidecars: [sidecar({ id: 'x:aaaa0001', relPath: 'Film (2017)/Film (2017).it.forced.srt', language: 'ita', forced: true })] }));
    expect(plan(decide(input([f], chrome(), { prefs: prefs({ subtitleMode: 'forced' }) }))).subtitles.selected).toMatchObject({ trackId: 'x:aaaa0001', delivery: 'sidecar' });
  });

  it("'always' when the only track in the language is forced: that track", () => {
    const f = file(F1, facts([sdr1080(), aac(1, 'ita'), sub(2, { forced: true })]));
    expect(plan(decide(input([f], chrome(), { prefs: prefs({ subtitleMode: 'always' }) }))).subtitles.selected?.trackId).toBe('s2');
  });

  it('an embedded exclusion on a native player: the PGS is served as .sup instead', () => {
    const f = file(F1, facts([sdr1080(), ac3(1, 'ita'), sub(2)]));
    const exclusions: PlanExclusion[] = [{ dimension: 'subtitle', trackId: 's2', delivery: 'embedded', fileId: F1, cause: 'client', error: 'x' }];
    const p = plan(decide(input([f], googleTv(), { prefs: prefs({ subtitleMode: 'always' }), exclusions })));
    expect(p.mode).toBe('direct_play');
    expect(p.subtitles.selected).toMatchObject({ trackId: 's2', delivery: 'client_render' });
    expect(p.subtitles.served.map((s) => s.trackId)).toEqual(['s2']);
  });

  it('a Direct Play exclusion on a TV: Direct Stream with TrueHD still copied', () => {
    const exclusions: PlanExclusion[] = [{ dimension: 'video', fileId: F1, mode: 'direct_play', cause: 'client', error: 'x' }];
    const p = plan(decide(input([uhdRemux()], googleTv(), { exclusions })));
    expect(p.mode).toBe('direct_stream');
    expect(p.audio?.action).toEqual({ kind: 'copy' });
  });

  it('burn-in with the transcode slot busy: dropped, Direct Play goes on', () => {
    const f = file(F1, facts([sdr1080(), aac(1, 'ita'), sub(2, { codec: 'dvd_subtitle' })]));
    const d = decide(input([f], chrome(), { selection: { subtitle: pick('s2') }, constraints: { transcode: 'busy', transcodeMaxBitrateBps: 20_000_000 } }));
    expect(plan(d).mode).toBe('direct_play');
    expect(d.ok && d.droppedSubtitleTrackId).toBe('s2');
    expect(plan(d).reasons.map((r) => r.message).join(' ')).toContain('every transcode slot is taken');
  });

  it('a Transcode forced only by failures gets the cause excluded', () => {
    const ex = (mode: 'direct_play' | 'direct_stream'): PlanExclusion => ({ dimension: 'video', fileId: F1, mode, cause: 'client', error: 'x' });
    const p = plan(decide(input([file(F1, facts([sdr1080(), aac(1, 'ita')]))], chrome(), { exclusions: [ex('direct_play'), ex('direct_stream')] })));
    expect(p.video).toMatchObject({ kind: 'transcode', causes: ['excluded'], toneMap: 'none' });
  });

  it('one hdr_tonemap reason for an HDR10 1080p Transcode', () => {
    const d = decide(input([file(F1, facts([video({ width: 1920, height: 1080 }), aac(1, 'ita')]))], { ...chrome(), hdr: [] }));
    expect(codes(d).filter((c) => c === 'hdr_tonemap')).toHaveLength(1);
  });

  it("no plan: Direct Play's own blockers are explained too", () => {
    const caps = { ...chrome(), containers: ['mp4'], protocols: ['progressive'] };
    const d = decide(input([file(F1, facts([sdr1080(), aac(1, 'ita')]))], caps));
    expect(d.ok ? [] : d.reasons.map((r) => r.message)).toEqual(
      expect.arrayContaining(['The client does not play HLS fMP4', 'MKV is not played directly by the client: remux to fMP4']),
    );
  });

  it('decide leaves its input unmutated, and the plan shares no object with it', () => {
    const i = input([uhdRemux(), file(F2, facts([sdr1080(), ac3(1, 'ita'), sub(2)]))], edge(), {
      prefs: prefs({ subtitleMode: 'always' }),
      selection: { audio: pick('s1', 'remembered', F1) },
      exclusions: [{ dimension: 'audio', action: 'convert', codec: 'eac3', cause: 'server', error: 'aac_channel_config' }],
    });
    const before = structuredClone(i);
    const p = plan(decide(i));
    expect(i).toStrictEqual(before);
    const f = i.files.find((x) => x.fileId === p.file.fileId)!;
    expect(p.file.location).not.toBe(f.facts.location);
    expect(p.exclusions[0]).not.toBe(i.exclusions[0]);
  });

  it('explain actions use the contract vocabulary; the details are in the reasons', () => {
    const tc = plan(decide(input([file(F1, facts([sdr1080({ profile: 'High 10', bitDepth: 10 }), aac(1, 'ita'), sub(2, { codec: 'dvd_subtitle' })]))], chrome(), { selection: { subtitle: pick('s2') } })));
    expect(explainActions(tc)).toEqual({ container: 'remux', video: 'transcode', audio: 'none', subtitles: 'burn_in' });
    const srtSidecar = file(F1, facts([sdr1080(), aac(1, 'ita')], { sidecars: [sidecar({ id: 'x:1a2b3c4d', relPath: 'Film (2017)/Film (2017).en.srt' })] }));
    expect(explainActions(plan(decide(input([srtSidecar], chrome(), { selection: { subtitle: pick('x:1a2b3c4d') } }))))).toEqual({
      container: 'none',
      video: 'none',
      audio: 'none',
      subtitles: 'convert:webvtt',
    });
  });
});

describe('version ties (quality criteria in order)', () => {
  const hevc = (o = {}) => video({ width: 1920, height: 1080, ...o });
  const winner = (a: PlayableFile, b: PlayableFile) => plan(decide(input([a, b], chrome()))).file.fileId;

  it('HDR kept beats SDR at equal pixels', () => {
    expect(winner(file(F1, facts([hevc({ hdr: 'SDR' }), aac(1, 'ita')])), file(F2, facts([hevc(), aac(1, 'ita')])))).toBe(F2);
  });

  it('10 bit beats 8 bit at equal pixels and HDR', () => {
    expect(winner(file(F1, facts([hevc({ hdr: 'SDR', profile: 'Main', bitDepth: 8 }), aac(1, 'ita')])), file(F2, facts([hevc({ hdr: 'SDR' }), aac(1, 'ita')])))).toBe(F2);
  });

  it('lossless audio beats a lossy source converted to FLAC (FLAC does not make it lossless)', () => {
    const lossy = file(F1, facts([sdr1080(), ac3(1, 'ita')]));
    const lossless = file(F2, facts([sdr1080(), audio(1, { language: 'ita', channels: 6, channelLayout: '5.1(side)' })]));
    const d = decide(input([lossy, lossless], chrome()));
    expect(plan(d).file.fileId).toBe(F2);
    expect(plan(d).reasons[0]?.message).toBe('Version 1080p H.264 chosen: higher quality than 1080p H.264');
  });

  it('at equal everything else the higher video bitrate wins', () => {
    const at = (id: string, bitRate: number) => file(id, facts([sdr1080({ bitRate }), aac(1, 'ita')]));
    expect(winner(at(F1, 20_000_000), at(F2, 30_000_000))).toBe(F2);
  });
});
