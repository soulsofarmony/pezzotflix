// Capability vocabulary (doc 03 I6) and the checks of the source against what the client declares.
// The engine compares codec, profile, bit depth, resolution and frame rate, never level or tier:
// a level/tier rejection is caught by the client's stream.mimeType check and re-planned (doc 04 §8).
import type { AudioStreamFacts, HdrFormat, SubtitleStreamFacts, VideoStreamFacts } from '../../../shared/media-facts.ts';
import type { ClientCapabilities } from '../../../shared/ports.ts';

type VideoCap = ClientCapabilities['video'][number];

const lower = (s: string): string => s.trim().toLowerCase();

// ---------------------------------------------------------------- container

/** MediaFacts.container → the names a client may declare in `containers`. */
const CONTAINER_NAMES: Readonly<Record<string, readonly string[]>> = {
  matroska: ['mkv', 'matroska'],
  webm: ['webm'],
  mp4: ['mp4'],
  mov: ['mov', 'mp4'],
  mpegts: ['ts', 'mpegts'],
};

export function clientPlaysContainer(caps: ClientCapabilities, container: string): boolean {
  const names = CONTAINER_NAMES[container] ?? [container];
  return caps.containers.some((c) => names.includes(lower(c)));
}

export const hasProtocol = (caps: ClientCapabilities, protocol: 'progressive' | 'hls-fmp4'): boolean =>
  caps.protocols.some((p) => lower(p) === protocol);

/**
 * A browser cannot pick the audio track of a container (S2 H1); absent means false (contract).
 * The same flag marks a native player, which also renders embedded subtitles in Direct Play.
 */
export const selectsTracks = (caps: ClientCapabilities): boolean => caps.audioTrackSelection === true;

/** P5 wording: "left to the browser" for a browser, "left to the client" otherwise. */
export const isBrowser = (caps: ClientCapabilities): boolean =>
  /\b(chrome|chromium|edge|firefox|safari|opera)\b/i.test(caps.device.model ?? '');

// ---------------------------------------------------------------- video

/** ffprobe codec_name → contract vocabulary (h264 | hevc | av1 | vp9). Others never match a client. */
const VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'av1', 'vp9']);

/** ffprobe profile → vocabulary token: "Main 10" → main10, "High" → high, "Profile 0" → profile0. */
export const profileToken = (profile: string | null): string | null =>
  profile ? lower(profile).replace(/[\s_:-]+/g, '') : null;

/** Profiles a declared profile also decodes (decoder conformance), so "high" covers a Main stream. */
const PROFILE_COVERS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  h264: {
    high: ['high', 'main', 'baseline', 'constrainedbaseline'],
    main: ['main', 'constrainedbaseline'],
    baseline: ['baseline', 'constrainedbaseline'],
  },
  hevc: { main10: ['main10', 'main'] },
};

function profileMatches(codec: string, declared: readonly string[] | undefined, source: string | null): boolean {
  if (!declared || declared.length === 0 || source === null) return true;
  return declared.some((d) => {
    const t = lower(d);
    return (PROFILE_COVERS[codec]?.[t] ?? [t]).includes(source);
  });
}

/** Frame rates are compared with a small tolerance: 59.94 fits a declared 60. */
const fpsFits = (fps: number | null, max: number | undefined): boolean => fps === null || max === undefined || fps <= max + 0.01;

export type VideoFit = { ok: true } | { ok: false; why: 'codec' | 'profile' | 'bit_depth' | 'resolution' | 'frame_rate'; cap: VideoCap | null };

/** Does any declared decoder take this stream as is? The failure names the closest miss. */
export function videoFit(caps: ClientCapabilities, v: VideoStreamFacts): VideoFit {
  if (!VIDEO_CODECS.has(v.codec)) return { ok: false, why: 'codec', cap: null };
  const sameCodec = caps.video.filter((c) => lower(c.codec) === v.codec);
  if (sameCodec.length === 0) return { ok: false, why: 'codec', cap: null };
  const prof = profileToken(v.profile);
  const byProfile = sameCodec.filter((c) => profileMatches(v.codec, c.profiles, prof));
  if (byProfile.length === 0) return { ok: false, why: 'profile', cap: sameCodec[0] ?? null };
  const byDepth = byProfile.filter((c) => v.bitDepth === null || c.maxBitDepth === undefined || v.bitDepth <= c.maxBitDepth);
  if (byDepth.length === 0) return { ok: false, why: 'bit_depth', cap: byProfile[0] ?? null };
  const bySize = byDepth.filter((c) => (c.maxWidth === undefined || v.width <= c.maxWidth) && (c.maxHeight === undefined || v.height <= c.maxHeight));
  if (bySize.length === 0) return { ok: false, why: 'resolution', cap: largest(byDepth) };
  if (!bySize.some((c) => fpsFits(v.frameRate, c.maxFrameRate))) return { ok: false, why: 'frame_rate', cap: bySize[0] ?? null };
  return { ok: true };
}

const area = (c: VideoCap): number => (c.maxWidth ?? 1e5) * (c.maxHeight ?? 1e5);
const largest = (cs: readonly VideoCap[]): VideoCap | null => [...cs].sort((a, b) => area(b) - area(a))[0] ?? null;

/** The client's H.264 decoder for a Transcode output (High, 8 bit) at this frame rate, the largest one. */
export function h264Output(caps: ClientCapabilities, frameRate: number | null): VideoCap | null {
  const fits = caps.video.filter(
    (c) =>
      lower(c.codec) === 'h264' &&
      profileMatches('h264', c.profiles, 'high') &&
      (c.maxBitDepth === undefined || c.maxBitDepth >= 8) &&
      fpsFits(frameRate, c.maxFrameRate),
  );
  return largest(fits);
}

// ---------------------------------------------------------------- HDR

/** HDR10+ plays as its HDR10 base everywhere (S2 H2), so a client declaring HDR10 takes it. */
export function clientPresentsHdr(caps: ClientCapabilities, format: HdrFormat): boolean {
  if (format === 'SDR') return true;
  const hdr = (caps.hdr ?? []).map((h) => h.trim().toUpperCase());
  if (format === 'HDR10') return hdr.includes('HDR10') || hdr.includes('HDR10+');
  if (format === 'HDR10+') return hdr.includes('HDR10+') || hdr.includes('HDR10');
  if (format === 'HLG') return hdr.includes('HLG');
  return false;
}

/** DV of this profile declared by the client ("DV5", "DV8.1", "DV8", "DV"); no browser declares DV (S2 H3). */
export function clientPlaysDolbyVision(caps: ClientCapabilities, profile: number, blCompatId: number): boolean {
  const hdr = (caps.hdr ?? []).map((h) => h.trim().toUpperCase().replace(/\s+/g, ''));
  return hdr.some((h) => h === 'DV' || h === `DV${profile}` || h === `DV${profile}.${blCompatId}`);
}

/** displayHdr absent means true when `hdr` is not empty (contract I5): the reason then claims no conversion. */
export const displayIsSdr = (caps: ClientCapabilities): boolean => caps.displayHdr === false;

// ---------------------------------------------------------------- audio

/** ffprobe codec (+ profile for DTS) → contract vocabulary (aac | ac3 | eac3 | flac | opus | truehd | dts | dtshd | pcm). */
export function audioToken(a: Pick<AudioStreamFacts, 'codec' | 'profile'>): string {
  if (a.codec === 'dts') return /dts-hd|dts:x|dts-x/i.test(a.profile ?? '') ? 'dtshd' : 'dts';
  if (a.codec.startsWith('pcm_')) return 'pcm';
  if (a.codec === 'mlp') return 'truehd';
  return a.codec;
}

const AUDIO_ALIASES: Readonly<Record<string, string>> = { 'ac-3': 'ac3', 'ec-3': 'eac3', 'e-ac-3': 'eac3', 'dts-hd': 'dtshd', lpcm: 'pcm' };
const declaredAudio = (codec: string): string => AUDIO_ALIASES[lower(codec)] ?? lower(codec);

/**
 * The client decodes (or passes through) this codec at this channel count. maxChannels absent means
 * no declared limit. A DTS-HD decoder also takes a DTS core; passthrough and decode both accept the
 * bitstream as far as the server is concerned (doc 03 §4.1).
 */
export function clientDecodesAudio(caps: ClientCapabilities, token: string, channels: number): boolean {
  return caps.audio.some((a) => {
    const c = declaredAudio(a.codec);
    return (c === token || (c === 'dtshd' && token === 'dts')) && (a.maxChannels === undefined || a.maxChannels >= channels);
  });
}

/** The client declares some multichannel lossy output (E-AC-3, AAC or Opus at 6+ channels). */
export const clientHasMultichannelLossy = (caps: ClientCapabilities): boolean =>
  ['eac3', 'aac', 'opus'].some((t) => clientDecodesAudio(caps, t, 6));

/** ffmpeg AAC layouts that map to a standard channelConfiguration (1–7); anything else carries a PCE. */
const AAC_STANDARD_LAYOUTS: ReadonlySet<string> = new Set(['mono', 'stereo', '3.0', '4.0', '5.0', '5.1', '7.1', '7.1(wide)']);

/**
 * A multichannel AAC source whose layout ffprobe cannot name is AAC with a PCE (channelConfiguration 0,
 * S2 H6): Chromium rejects it and Firefox plays it mute, so it is never copied to a client (doc 04 §4.3).
 */
export const aacWithPce = (a: Pick<AudioStreamFacts, 'codec' | 'channels' | 'channelLayout'>): boolean =>
  a.codec === 'aac' && a.channels > 2 && !AAC_STANDARD_LAYOUTS.has(a.channelLayout ?? '');

// ---------------------------------------------------------------- subtitles

/** ffprobe subtitle codec → the name a client declares for in-stream rendering. */
const SUBTITLE_NAMES: Readonly<Record<string, string>> = {
  subrip: 'srt',
  ass: 'ass',
  ssa: 'ssa',
  webvtt: 'webvtt',
  mov_text: 'tx3g',
  hdmv_pgs_subtitle: 'pgs',
  dvd_subtitle: 'vobsub',
  dvb_subtitle: 'dvb',
};

/** Text codecs delivery converts to WebVTT (ADR 0003 D12). */
export const TEXT_TO_WEBVTT: ReadonlySet<string> = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

export const clientRendersWebVtt = (caps: ClientCapabilities): boolean =>
  caps.subtitles.text.some((t) => ['webvtt', 'vtt'].includes(lower(t)));

/** P3: PGS rendered client-side from a .sup (libpgs in the browser). */
export const clientRendersPgs = (caps: ClientCapabilities): boolean => caps.subtitles.image.some((t) => lower(t) === 'pgs');

/** A native player (audioTrackSelection) renders this embedded track from the file itself in Direct Play. */
export function clientRendersEmbedded(caps: ClientCapabilities, s: SubtitleStreamFacts): boolean {
  if (!selectsTracks(caps)) return false;
  const name = SUBTITLE_NAMES[s.codec] ?? s.codec;
  if (name === 'ass' || name === 'ssa') return caps.subtitles.ass === true;
  const list = s.kind === 'image' ? caps.subtitles.image : caps.subtitles.text;
  return list.some((t) => lower(t) === name);
}
