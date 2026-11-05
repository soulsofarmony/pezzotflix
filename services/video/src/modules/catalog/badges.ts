// Technical badges and version labels (doc 03 §3.3, §3.4) from MediaFacts streams. Pure.
import type { AudioStreamFacts, HdrFormat, MediaFacts, VideoStreamFacts } from '../../shared/media-facts.ts';

/** The stream facts badges and labels depend on (also readable from media_stream rows). */
export interface VideoSignal {
  width: number;
  height: number;
  hdr: HdrFormat;
  hdrFallback: readonly HdrFormat[];
}

export interface AudioSignal {
  codec: string;
  profile: string | null;
  channels: number;
  lossless: boolean;
  objectAudio: 'atmos' | 'dtsx' | null;
  commentary: boolean;
  language: string | null;
}

export interface Signals {
  video: VideoSignal[];
  audio: AudioSignal[];
}

/** Badge vocabulary, in display order. */
export const BADGES = ['4K', '1080p', 'DV', 'HDR10+', 'HDR10', 'HLG', 'Atmos', 'DTS:X', 'TrueHD', 'DTS-HD MA'] as const;
export type Badge = (typeof BADGES)[number];

// Scope or anamorphic crops keep the width: 3840x1600 is 4K, 1920x800 is 1080p.
const is4k = (v: VideoSignal) => v.width >= 3200 || v.height >= 2000;
const is1080 = (v: VideoSignal) => v.width >= 1700 || v.height >= 1000;

const isDtsHdMa = (a: AudioSignal) => a.codec === 'dts' && /dts-hd ma/i.test(a.profile ?? '');

/** Main video stream of a file: the first one that is not cover art. */
export function mainVideo(facts: MediaFacts): VideoStreamFacts | null {
  return facts.streams.find((s): s is VideoStreamFacts => s.type === 'video' && !s.attachedPic) ?? null;
}

export function signalsOf(facts: MediaFacts): Signals {
  const v = mainVideo(facts);
  return {
    video: v ? [{ width: v.width, height: v.height, hdr: v.hdr, hdrFallback: v.hdrFallback }] : [],
    audio: facts.streams
      .filter((s): s is AudioStreamFacts => s.type === 'audio')
      .map((a) => ({
        codec: a.codec,
        profile: a.profile,
        channels: a.channels,
        lossless: a.lossless,
        objectAudio: a.objectAudio,
        commentary: a.commentary,
        language: a.language,
      })),
  };
}

/**
 * Badges of an item across its files: the best resolution only, every HDR format (the base and
 * its fallback layers), object audio and lossless formats of non-commentary tracks.
 */
export function badgesOf(signals: readonly Signals[]): Badge[] {
  const out = new Set<Badge>();
  const video = signals.flatMap((s) => s.video);
  const audio = signals.flatMap((s) => s.audio).filter((a) => !a.commentary);
  if (video.some(is4k)) out.add('4K');
  else if (video.some(is1080)) out.add('1080p');
  for (const v of video) {
    for (const h of [v.hdr, ...v.hdrFallback]) {
      if (h === 'DV' || h === 'HDR10+' || h === 'HDR10' || h === 'HLG') out.add(h);
    }
  }
  for (const a of audio) {
    if (a.objectAudio === 'atmos') out.add('Atmos');
    if (a.objectAudio === 'dtsx') out.add('DTS:X');
    if (a.codec === 'truehd') out.add('TrueHD');
    if (isDtsHdMa(a)) out.add('DTS-HD MA');
  }
  return BADGES.filter((b) => out.has(b));
}

export function resolutionLabel(width: number, height: number): string {
  const v = { width, height, hdr: 'SDR' as const, hdrFallback: [] };
  if (is4k(v)) return '4K';
  if (is1080(v)) return '1080p';
  if (width >= 1200 || height >= 700) return '720p';
  return `${height}p`;
}

const HDR_LABEL: Readonly<Record<HdrFormat, string | null>> = { SDR: null, HDR10: 'HDR10', 'HDR10+': 'HDR10+', HLG: 'HLG', DV: 'Dolby Vision' };

export function audioCodecLabel(a: Pick<AudioSignal, 'codec' | 'profile' | 'objectAudio'>): string {
  const base =
    a.codec === 'truehd'
      ? 'TrueHD'
      : a.codec === 'eac3'
        ? 'E-AC-3'
        : a.codec === 'ac3'
          ? 'AC-3'
          : a.codec === 'dts'
            ? /dts-hd ma/i.test(a.profile ?? '')
              ? 'DTS-HD MA'
              : /dts-hd/i.test(a.profile ?? '')
                ? 'DTS-HD'
                : 'DTS'
            : a.codec.startsWith('pcm_')
              ? 'PCM'
              : a.codec.toUpperCase();
  if (a.objectAudio === 'atmos') return `${base} Atmos`;
  if (a.objectAudio === 'dtsx') return a.codec === 'dts' ? 'DTS:X' : `${base} DTS:X`;
  return base;
}

export function channelsLabel(channels: number): string {
  if (channels === 8) return '7.1';
  if (channels === 6) return '5.1';
  if (channels === 2) return '2.0';
  if (channels === 1) return '1.0';
  return `${channels}ch`;
}

/** Quality order of audio tracks for the label: lossless, object audio, channels. */
const audioRank = (a: AudioSignal): number => (a.lossless ? 100 : 0) + (a.objectAudio ? 50 : 0) + a.channels;

/** "4K · Dolby Vision · TrueHD Atmos 7.1 · ITA/ENG" (doc 03 §3.4). */
export function versionLabel(facts: MediaFacts): string {
  const parts: string[] = [];
  const v = mainVideo(facts);
  if (v) {
    parts.push(resolutionLabel(v.width, v.height));
    const hdr = HDR_LABEL[v.hdr];
    if (hdr) parts.push(hdr);
  }
  const audio = signalsOf(facts).audio.filter((a) => !a.commentary);
  const best = [...audio].sort((a, b) => audioRank(b) - audioRank(a))[0];
  if (best) parts.push(`${audioCodecLabel(best)} ${channelsLabel(best.channels)}`);
  const langs = [...new Set(audio.map((a) => a.language?.toUpperCase()).filter((l): l is string => !!l))];
  if (langs.length) parts.push(langs.join('/'));
  return parts.length ? parts.join(' · ') : facts.container;
}
