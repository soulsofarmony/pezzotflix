// Reason builders: the code is stable for tests and explain, the message is what the session shows
// (doc 04 §3). Messages depend only on their arguments, so the same input gives the same text.
import type { AudioStreamFacts, VideoStreamFacts } from '../../../shared/media-facts.ts';
import type { AudioAction, PlanExclusion, PlanReason, ReasonCode } from '../../../shared/playback-plan.ts';

export const reason = (code: ReasonCode, dimension: PlanReason['dimension'], message: string): PlanReason => ({
  code,
  dimension,
  message,
});

const CODEC_NAMES: Readonly<Record<string, string>> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg2video: 'MPEG-2',
  vc1: 'VC-1',
  truehd: 'TrueHD',
  mlp: 'MLP',
  dts: 'DTS',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  aac: 'AAC',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  subrip: 'SubRip',
  ass: 'ASS',
  ssa: 'SSA',
  webvtt: 'WebVTT',
  mov_text: 'MP4 text',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
};

export const codecName = (codec: string): string => (codec.startsWith('pcm_') ? 'PCM' : (CODEC_NAMES[codec] ?? codec));

const CONTAINER_NAMES: Readonly<Record<string, string>> = { matroska: 'MKV', mp4: 'MP4', mov: 'MOV', webm: 'WebM', mpegts: 'MPEG-TS' };
export const containerName = (c: string): string => CONTAINER_NAMES[c] ?? c;

export const channelsName = (n: number): string =>
  n === 1 ? '1.0' : n === 2 ? '2.0' : n === 6 ? '5.1' : n === 7 ? '6.1' : n === 8 ? '7.1' : `${n} channels`;

/** "TrueHD 7.1 (ita)", "DTS-HD MA 5.1", the profile naming the DTS variant. */
export function audioName(a: Pick<AudioStreamFacts, 'codec' | 'profile' | 'channels' | 'language'>): string {
  const codec = a.codec === 'dts' && a.profile ? a.profile : codecName(a.codec);
  return `${codec} ${channelsName(a.channels)}${a.language ? ` (${a.language})` : ''}`;
}

export function outputName(action: Extract<AudioAction, { kind: 'convert' }>): string {
  return `${codecName(action.codec)} ${channelsName(action.channels)}`;
}

/** "HEVC Main 10 3840×2160" */
export function videoName(v: Pick<VideoStreamFacts, 'codec' | 'profile' | 'width' | 'height'>): string {
  return `${codecName(v.codec)}${v.profile ? ` ${v.profile}` : ''} ${v.width}×${v.height}`;
}

export const subtitleName = (codec: string, language: string | null): string =>
  `${codecName(codec)}${language ? ` (${language})` : ''}`;

const MODE_NAMES = { direct_play: 'Direct Play', direct_stream: 'Direct Stream', transcode: 'Transcode' } as const;
export const modeName = (m: keyof typeof MODE_NAMES): string => MODE_NAMES[m];

export function exclusionMessage(e: PlanExclusion): string {
  const tail = 'excluded after a playback failure';
  switch (e.dimension) {
    case 'container':
    case 'video':
      return `${modeName(e.mode)} of this file ${tail} (${e.dimension}, ${e.error})`;
    case 'audio':
      return e.action === 'copy'
        ? `Copy of ${e.codec === 'dts' && e.profile ? e.profile : codecName(e.codec)} audio ${tail} (${e.error})`
        : `${codecName(e.codec)} audio ${tail} (${e.error})`;
    case 'subtitle':
      return `Subtitle track ${e.trackId} as ${e.delivery} ${tail} (${e.error})`;
  }
}

/** Dedupe by code and message, keeping the first occurrence: reasons stay in evaluation order. */
export function uniqueReasons(list: readonly PlanReason[]): PlanReason[] {
  const seen = new Set<string>();
  const out: PlanReason[] = [];
  for (const r of list) {
    const k = `${r.code}\u0000${r.message}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}
