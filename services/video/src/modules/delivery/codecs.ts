// Codec strings and bitrates from the plan's source facts, for what delivery cannot read from an init
// segment: Direct Play serves the file as is (doc 05 §6.8), so its stream.mimeType comes from the facts.
// For hls-fmp4 the exact string is read from the init instead (bmff.ts).
import type { AudioAction, AudioSource, VideoSource } from '../../shared/playback-plan.ts';

const HEVC_PROFILES: Record<string, { idc: number; compat: string }> = {
  main: { idc: 1, compat: '6' },
  'main 10': { idc: 2, compat: '4' },
  'main still picture': { idc: 3, compat: '8' },
  rext: { idc: 4, compat: '10' },
};

const AVC_PROFILES: Record<string, string> = {
  baseline: '4200',
  'constrained baseline': '42E0',
  main: '4D00',
  extended: '5800',
  high: '6400',
  'high 10': '6E00',
  'high 4:2:2': '7A00',
  'high 4:4:4 predictive': 'F400',
};

/** HEVC general_level_idc (30 × level) estimated when the facts have none (VideoSource.level null). */
function hevcLevelGuess(v: VideoSource): number {
  const px = v.width * v.height;
  const fps = v.frameRate ?? 30;
  if (px > 4096 * 2304) return fps > 30 ? 183 : 180;
  if (px > 2048 * 1152) return fps > 30 ? 153 : 150;
  if (px > 1280 * 720) return fps > 30 ? 123 : 120;
  return 93;
}

/** AVC level_idc (10 × level) estimated when the facts have none. */
function avcLevelGuess(v: VideoSource): number {
  const px = v.width * v.height;
  const fps = v.frameRate ?? 30;
  if (px > 2048 * 1088) return fps > 30 ? 52 : 51;
  if (px > 1280 * 720) return fps > 30 ? 42 : 41;
  return 31;
}

/**
 * Approximate RFC 6381 string of a video stream from its facts.
 * APPROXIMATE: tier, compatibility and constraint flags are not in the facts (HEVC Main tier and 'B0'
 * assumed, AVC constraint flags 00). Verify canPlayType/isTypeSupported against real files in F1c.
 */
export function videoCodecFromFacts(v: VideoSource): string | null {
  const codec = v.codec.toLowerCase();
  const profile = (v.profile ?? '').toLowerCase();
  const level = typeof v.level === 'number' && v.level > 0 ? Math.round(v.level) : null;
  if (codec === 'hevc' || codec === 'h265') {
    const p = HEVC_PROFILES[profile] ?? (v.bitDepth && v.bitDepth > 8 ? HEVC_PROFILES['main 10']! : HEVC_PROFILES.main!);
    return `hvc1.${p.idc}.${p.compat}.L${level ?? hevcLevelGuess(v)}.B0`;
  }
  if (codec === 'h264' || codec === 'avc') {
    const pc = AVC_PROFILES[profile] ?? AVC_PROFILES.high!;
    const l = level ?? avcLevelGuess(v);
    return `avc1.${pc}${l.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (codec === 'av1') return 'av01';
  if (codec === 'vp9') return 'vp09';
  return null;
}

/** RFC 6381 string of a source audio codec as served by copy (Direct Play). */
export function audioCodecFromFacts(a: AudioSource): string | null {
  const codec = a.codec.toLowerCase();
  const profile = (a.profile ?? '').toLowerCase();
  switch (codec) {
    case 'aac':
      return profile.includes('he-aacv2') ? 'mp4a.40.29' : profile.includes('he-aac') ? 'mp4a.40.5' : 'mp4a.40.2';
    case 'ac3':
      return 'ac-3';
    case 'eac3':
      return 'ec-3';
    case 'flac':
      return 'flac';
    case 'opus':
      return 'opus';
    case 'mp3':
      return 'mp4a.40.34';
    case 'vorbis':
      return 'vorbis';
    case 'truehd':
      return 'mlpa';
    case 'dts':
      return 'dtsc';
    default:
      return null;
  }
}

/** stream.mimeType of a Direct Play file (doc 05 §6.8): the container type plus the codecs that are known. */
export function progressiveMimeType(container: string, video: VideoSource, audio: AudioSource | null): string {
  const base = container === 'matroska' ? 'video/x-matroska' : container === 'webm' ? 'video/webm' : 'video/mp4';
  const codecs = [videoCodecFromFacts(video), audio ? audioCodecFromFacts(audio) : null].filter((c): c is string => c !== null);
  return codecs.length ? `${base}; codecs="${codecs.join(', ')}"` : base;
}

/** stream.mimeType of hls-fmp4 segments, from the codec strings read in the init. */
export const fmp4MimeType = (codecs: readonly string[]): string => `video/mp4; codecs="${codecs.join(', ')}"`;

// Typical bitrates when the facts have none (bits/s).
const TYPICAL_AUDIO_BPS: Record<string, number> = {
  truehd: 4_500_000,
  dts: 3_000_000,
  eac3: 1_024_000,
  ac3: 640_000,
  aac: 256_000,
  opus: 256_000,
  flac: 2_500_000,
  mp3: 320_000,
};

/** Bitrate of the audio track as served, for the client's separate MSE audio quota (ADR 0003 D14). */
export function servedAudioBps(source: AudioSource, action: AudioAction): number {
  if (action.kind === 'convert' && action.bitrateBps !== null) return action.bitrateBps;
  if (action.kind === 'convert' && action.codec === 'flac') {
    // FLAC of a lossless source is about as large as the source; of a lossy one, ~60 % of 24-bit PCM.
    const lossless = /^(truehd|mlp|flac|pcm_|alac)/.test(source.codec) || /dts-hd ma/i.test(source.profile ?? '');
    if (lossless && source.bitRate) return source.bitRate;
    return Math.round(source.channels * (source.sampleRate ?? 48_000) * 24 * 0.6);
  }
  return source.bitRate ?? TYPICAL_AUDIO_BPS[source.codec] ?? Math.max(1, source.channels) * 192_000;
}
