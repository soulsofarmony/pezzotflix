// ffmpeg command of one Direct Stream run (ADR 0003 D4, D11, D13), pure. Video copied, fragmented MP4 on
// stdout. Arguments are an array: never a shell string (ADR 0001 rule 3).
import type { AudioAction, AudioSource, DirectStreamPlan } from '../../shared/playback-plan.ts';

/**
 * -output_ts_offset of every run, in ms: output timestamps are the zero-based original timeline plus
 * this (StreamHandle.mediaTimestampOffsetMs), so pre-roll and encoder priming never go negative.
 */
export const OUTPUT_TS_OFFSET_MS = 10_000;

/** ffmpeg backs the -ss target off by 3/23 s when the video has B-frames (E3); 0.135 s lands on the keyframe. */
export const SEEK_COMPENSATION_S = 0.135;

/** -ss value that lands exactly on the keyframe at keyframeMs, given the next indexed keyframe. */
export function seekSeconds(keyframeMs: number, nextKeyframeMs: number | null): number {
  const comp = nextKeyframeMs === null ? SEEK_COMPENSATION_S : Math.min(SEEK_COMPENSATION_S, (nextKeyframeMs - keyframeMs) / 2000);
  return Math.round((keyframeMs / 1000 + comp) * 1e6) / 1e6;
}

/** Where a run starts: the -ss value and the zero-based time (ms) of the keyframe it lands on. */
export interface RunSeek {
  seekS: number;
  keyframeMs: number;
}

/** Output rate and encoder frame size (samples) of a converted track. */
export function audioFraming(action: Extract<AudioAction, { kind: 'convert' }>, source: Pick<AudioSource, 'sampleRate'>): { rate: number; frameSamples: number } {
  const src = source.sampleRate ?? 48_000;
  switch (action.codec) {
    case 'flac':
      return { rate: src, frameSamples: FLAC_FRAME_SAMPLES };
    case 'aac':
      return { rate: src <= 96_000 ? src : 48_000, frameSamples: 1024 };
    case 'eac3':
      return { rate: src === 32_000 || src === 44_100 ? src : 48_000, frameSamples: 1536 };
    case 'opus':
      return { rate: 48_000, frameSamples: 960 };
  }
}

/** Fixed FLAC block size, so the frame grid is known (the encoder's default depends on the rate). */
const FLAC_FRAME_SAMPLES = 4608;

/**
 * Audio arguments. A conversion is anchored on the zero-based timeline (H-M1): aresample pads or trims
 * the decoded audio so its first sample sits on a whole encoder frame at or before the run's keyframe
 * (first_pts), so every run, whatever its seek, emits frames on the same PTS grid. Padding and priming
 * fall in the discarded pre-roll GOP. min_comp=1e-5 makes that start exact; later drift below
 * min_hard_comp (0.1 s) is left alone, as without the filter.
 *
 * The rate is always explicit (m1): the first aresample outputs exactly the rate the anchor is computed
 * in (the source rate, 48 kHz when unknown or when the codec needs it), whatever the decoder reports.
 *
 * Known limit (m6): a gap in the source audio shorter than min_hard_comp is not filled. A run that
 * starts after such a gap anchors on the grid and a run started before it carries the gap's offset, so
 * at a restart boundary after the gap the seam can reach the gap's length (up to 100 ms). Blu-ray
 * remuxes have continuous audio; broadcast captures may not.
 */
export function audioArgs(action: AudioAction, source: Pick<AudioSource, 'sampleRate' | 'codec'> = { sampleRate: 48_000, codec: '' }, anchorMs = 0): string[] {
  // AAC from MPEG-TS is ADTS, which MP4 does not take; the filter passes non-ADTS packets through.
  if (action.kind === 'copy') return source.codec === 'aac' ? ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc'] : ['-c:a', 'copy'];
  const { rate, frameSamples } = audioFraming(action, source);
  const firstPts = Math.max(0, Math.floor((anchorMs * rate) / 1000 / frameSamples)) * frameSamples;
  const filters = [
    `aresample=${rate}`,
    `aresample=async=1:min_comp=0.00001:first_pts=${firstPts}`,
    ...(action.codec !== 'flac' && action.layout ? [`aformat=channel_layouts=${action.layout}`] : []),
  ];
  const af = ['-af', filters.join(',')];
  switch (action.codec) {
    case 'flac':
      // The decoder's sample format keeps the source depth (s32 for 24 bit) and layout (7.1 stays 7.1).
      return [...af, '-c:a', 'flac', '-frame_size', String(FLAC_FRAME_SAMPLES)];
    case 'eac3':
      return [...af, '-c:a', 'eac3', '-b:a', String(action.bitrateBps)];
    case 'aac':
      return [...af, '-c:a', 'aac', '-b:a', String(action.bitrateBps)];
    case 'opus':
      return [...af, '-c:a', 'libopus', '-b:a', String(action.bitrateBps)];
  }
}

export const FMP4_MOVFLAGS = '+frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets';

/**
 * One run: from the start of the file (seek null) or from an indexed keyframe with -noaccurate_seek.
 * The stream indexes come from the plan (-map 0:<index>), which picks the same streams as the ADR's
 * -map 0:v:0 / -map 0:a:<n> without depending on the order of the other streams.
 */
export function directStreamArgs(plan: DirectStreamPlan, absPath: string, seek: RunSeek | null): string[] {
  const v = plan.video;
  return [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-loglevel', 'warning',
    ...(seek === null ? [] : ['-noaccurate_seek', '-ss', seek.seekS.toFixed(6)]),
    '-i', `file:${absPath}`,
    '-map', `0:${v.source.streamIndex}`,
    ...(plan.audio ? ['-map', `0:${plan.audio.source.streamIndex}`] : []),
    '-c:v', 'copy',
    ...(v.tag ? ['-tag:v', v.tag] : []),
    ...(v.dolbyVision === 'remove_dovi' ? ['-bsf:v', 'hevc_metadata=remove_dovi=1'] : []),
    ...(plan.audio ? audioArgs(plan.audio.action, plan.audio.source, seek?.keyframeMs ?? 0) : []),
    '-copyts',
    '-start_at_zero',
    '-avoid_negative_ts', 'disabled',
    '-output_ts_offset', String(OUTPUT_TS_OFFSET_MS / 1000),
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-sn',
    '-dn',
    '-fflags', '+bitexact',
    '-f', 'mp4',
    '-movflags', FMP4_MOVFLAGS,
    'pipe:1',
  ];
}
