// Software Transcode, sources up to 1080p (doc 04 P2, ADR 0003 D3), pure: the segment grid, the forced
// keyframes, the ffmpeg command of one run, the bitrate and the blame of a failure. libx264 High 8-bit in
// fMP4, IDR keyframes forced on a fixed grid of HLS_SEGMENT_TARGET_S from 0, so no keyframe index is needed
// and every segment starts with an IDR (INDEPENDENT-SEGMENTS). A restart at k is a new encode from the
// boundary one segment earlier, Bₖ₋₁ (accurate seek), whose first segment is dropped: the encoder, the
// deinterlacer and the audio encoder are warmed up at Bₖ, so the restart is invisible (no AAC priming at the
// seam), and with the same keyframe rule its frames and PTS match a run from the start (bytes differ).
// Arguments are an array, never a shell string (ADR 0001 rule 3).
import type { HdrFormat } from '../../shared/media-facts.ts';
import type { PlanExclusion, SuspectDimension, TranscodePlan, VideoSource } from '../../shared/playback-plan.ts';
import type { StderrClass, StreamFailure, StreamFailureKind } from '../../shared/ports.ts';
import { audioArgs, FMP4_MOVFLAGS, OUTPUT_TS_OFFSET_MS, type RunSeek } from './ffmpeg-args.ts';
import { buildGrid, type GridOptions, type SegmentGrid } from './grid.ts';

export const X264_PRESET = 'veryfast';
export const X264_CRF = 21;
/** VBV buffer, in seconds of the max rate: a segment peaks at most at maxrate × (1 + this / target). */
export const VBV_BUFFER_S = 2;
/** A burned image track: the demuxer starts this far before Bₖ, so a cue already on screen at Bₖ is decoded. */
export const BURN_PREROLL_MS = 10_000;
/** Deinterlaces the frames flagged interlaced (field order from the frames), one frame out per frame in. */
export const DEINTERLACE = 'bwdif=mode=send_frame:parity=auto:deint=interlaced';
/** Longest film a synthetic grid accepts (a hostile duration must stay cheap). */
const MAX_DURATION_MS = 48 * 3_600_000;

const secs = (ms: number): string => (ms / 1000).toFixed(3);

// ---------------------------------------------------------------- grid and keyframes

/**
 * Boundaries every HLS_SEGMENT_TARGET_S from 0 (ADR 0003 D3): Bₖ = k·target, a last segment under 0.5 s
 * merged into the one before. The encoder puts an IDR on the first frame at or after each Bₖ, so the
 * segmenter accepts a boundary keyframe up to TRANSCODE_LATE_MS late (one frame interval in practice).
 */
export function transcodeGrid(durationMs: number, opts: GridOptions): SegmentGrid {
  if (!(durationMs > 0) || durationMs > MAX_DURATION_MS) throw new Error(`duration ${durationMs} ms out of range`);
  const times: number[] = [];
  for (let t = 0; t < durationMs; t += opts.targetMs) times.push(t);
  return buildGrid({ times, positions: times.map(() => null), durationMs, sizeBytes: 0, dataEndBytes: null }, { ...opts, maxMs: Number.POSITIVE_INFINITY });
}

/** Floor of transcodeLateMs: the frame rate is the stream's average, and a variable-rate source has longer gaps. */
export const TRANSCODE_LATE_MIN_MS = 250;
/**
 * Lateness the segmenter accepts for a forced keyframe: it lands on the first frame at or after Bₖ, so up to
 * one frame interval late; 1.5 intervals for timestamp jitter (never under TRANSCODE_LATE_MIN_MS), 1 s when the
 * frame rate is unknown.
 */
export const transcodeLateMs = (frameRate: number | null): number => Math.max(frameRate && frameRate > 0 ? 1500 / frameRate : 1000, TRANSCODE_LATE_MIN_MS);
/** A forced keyframe is never early: only rounding of the output time base (well under a microsecond). */
export const TRANSCODE_EARLY_MS = 0.01;

/**
 * -force_key_frames of a run that starts at segment k: the boundaries from Bₖ on (B₀ = 0 for k = 0, whose
 * first frame is an IDR anyway; the list is never empty). ffmpeg compares each frame with the next time of
 * the list, one entry per frame, on the absolute timeline (-copyts): an entry before the run's first frame
 * would force a keyframe on each of the first frames, so the list must start at the run's own boundary. The
 * expression form is no use here: its t counts from the run's first frame, so a restart would put its
 * keyframes on another grid.
 */
export function forcedKeyframeList(grid: SegmentGrid, k: number): string {
  return grid.starts
    .slice(Math.max(0, k))
    .map((ms) => secs(ms))
    .join(',');
}

// ---------------------------------------------------------------- encoder settings

interface H264Level {
  name: string;
  /** Macroblocks per second, per frame; bit rate and CPB in kbit/s and kbit (Baseline/Main; High ×1.25). */
  mbps: number;
  fs: number;
  br: number;
  cpb: number;
}

/** ITU-T H.264 Table A-1. */
const H264_LEVELS: readonly H264Level[] = [
  { name: '3.0', mbps: 40_500, fs: 1_620, br: 10_000, cpb: 10_000 },
  { name: '3.1', mbps: 108_000, fs: 3_600, br: 14_000, cpb: 14_000 },
  { name: '3.2', mbps: 216_000, fs: 5_120, br: 20_000, cpb: 20_000 },
  { name: '4.0', mbps: 245_760, fs: 8_192, br: 20_000, cpb: 25_000 },
  { name: '4.1', mbps: 245_760, fs: 8_192, br: 50_000, cpb: 62_500 },
  { name: '4.2', mbps: 522_240, fs: 8_704, br: 50_000, cpb: 62_500 },
  { name: '5.0', mbps: 589_824, fs: 22_080, br: 135_000, cpb: 135_000 },
  { name: '5.1', mbps: 983_040, fs: 36_864, br: 240_000, cpb: 240_000 },
  { name: '5.2', mbps: 2_073_600, fs: 36_864, br: 240_000, cpb: 240_000 },
];
const HIGH_FACTOR = 1.25;

/** Lowest High-profile level that fits the frame size, the frame rate (60 when unknown) and the VBV settings. */
export function h264Level(width: number, height: number, frameRate: number | null, maxrateBps: number, bufsizeBps: number): string {
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = fs * (frameRate && frameRate > 0 ? frameRate : 60);
  const side = Math.max(Math.ceil(width / 16), Math.ceil(height / 16));
  const fit = H264_LEVELS.find(
    (l) => fs <= l.fs && side <= Math.sqrt(l.fs * 8) && mbps <= l.mbps && maxrateBps <= l.br * HIGH_FACTOR * 1000 && bufsizeBps <= l.cpb * HIGH_FACTOR * 1000,
  );
  return (fit ?? H264_LEVELS.at(-1)!).name;
}

/**
 * Transfer of the HDR the decoder gets: DV as its base layer, in the engine's order (HDR10 or HDR10+, then
 * HLG, then SDR); the engine plans no Transcode for a DV file with none of them (PQ is assumed here).
 */
function transferOf(hdr: HdrFormat, fallback: readonly HdrFormat[]): 'smpte2084' | 'arib-std-b67' | null {
  const has = (f: HdrFormat) => fallback.includes(f);
  const served = hdr !== 'DV' ? hdr : has('HDR10') || has('HDR10+') ? 'HDR10' : has('HLG') ? 'HLG' : has('SDR') ? 'SDR' : 'HDR10';
  if (served === 'SDR') return null;
  return served === 'HLG' ? 'arib-std-b67' : 'smpte2084';
}

/**
 * HDR10/HLG to SDR BT.709 in software (doc 04 §4.2): zscale to linear light, Hable tone curve, zscale back to
 * BT.709 and to yuv420p, so the BT.709 matrix is zimg's: a later scale works on YUV and never converts from
 * RGB with swscale's default (BT.601) matrix. zscale (zimg) and tonemap are in jellyfin-ffmpeg and in the
 * Gyan build alike. Null for SDR. The frames' side data goes too: HDR metadata (content light level,
 * mastering display, DV RPU) would otherwise reach the SDR output (an mp4 clli box).
 */
export function toneMapFilter(source: Pick<VideoSource, 'hdr' | 'hdrFallback'>): string | null {
  const tin = transferOf(source.hdr, source.hdrFallback);
  if (!tin) return null;
  return [
    `zscale=tin=${tin}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0',
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p',
    'sidedata=mode=delete',
  ].join(',');
}

/**
 * A path as the value of a filter option inside -filter_complex: '/' separators (ffmpeg takes them on
 * Windows), then the two escaping levels of ffmpeg-filters §"Notes on filtergraph escaping": the option
 * value (\ ' :), then the graph (\ ' [ ] , ;).
 */
export function filterPathArg(path: string): string {
  const level1 = path.replace(/\\/g, '/').replace(/[\\':]/g, (c) => `\\${c}`);
  return level1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------- command

/** The selected track burned into the video. */
export type BurnSource =
  /** Embedded image track (PGS, VobSub, DVB): sub2video from the same input, then overlay. */
  | { kind: 'bitmap'; trackId: string; streamIndex: number }
  /** Text: a sidecar file, or the embedded track extracted to ASS; rendered by libass (subtitles filter). */
  | { kind: 'text'; trackId: string; path: string };

export interface TranscodeRun {
  plan: TranscodePlan;
  absPath: string;
  /** null: from the start of the file; else the run starts at Bₖ (keyframeMs) with an accurate seek. */
  seek: RunSeek | null;
  /** File holding forcedKeyframeList for this run (read by ffmpeg with -/force_key_frames). */
  keyframeFile: string;
  burn: BurnSource | null;
}

/**
 * One run from seek.keyframeMs (Bⱼ, the boundary before the segment asked for) or from the start. Video and
 * an image track to burn come from input 0; with a burn and j > 0 input 0 starts BURN_PREROLL_MS early (fast
 * seek) and trim drops the frames before Bⱼ, and the audio comes from input 1 with an accurate seek, so its
 * anchor is the same as without a burn. bwdif comes first: it deinterlaces the frames flagged interlaced and
 * passes the others through.
 */
export function transcodeArgs(r: TranscodeRun): string[] {
  const { plan, absPath, seek, burn } = r;
  const v = plan.video;
  const src = v.source;
  const startMs = seek?.keyframeMs ?? 0;
  const prerolled = burn?.kind === 'bitmap' && startMs > 0;
  const audioInput = prerolled ? 1 : 0;

  const inputs = prerolled
    ? ['-noaccurate_seek', '-ss', secs(Math.max(0, startMs - BURN_PREROLL_MS)), '-i', `file:${absPath}`, ...(plan.audio ? ['-ss', secs(startMs), '-i', `file:${absPath}`] : [])]
    : [...(startMs > 0 ? ['-ss', secs(startMs)] : []), '-i', `file:${absPath}`];

  const head = [
    DEINTERLACE,
    ...(prerolled ? [`trim=start=${secs(startMs)}`] : []),
    ...(v.toneMap === 'to_sdr' ? [toneMapFilter(src)].filter((f): f is string => f !== null) : []),
  ];
  const tail = [...(v.width !== src.width || v.height !== src.height ? [`scale=w=${v.width}:h=${v.height}`] : []), 'format=yuv420p'];
  let graph: string;
  if (burn?.kind === 'bitmap') {
    // The subtitle canvas fitted into the picture and centred (a canvas of another size than the video).
    graph =
      `[0:${src.streamIndex}]${head.join(',')}[main];` +
      `[0:${burn.streamIndex}]scale=w=${src.width}:h=${src.height}:force_original_aspect_ratio=decrease[sub];` +
      `[main][sub]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass,${tail.join(',')}[v]`;
  } else {
    const text = burn?.kind === 'text' ? [`subtitles=filename=${filterPathArg(burn.path)}`] : [];
    graph = `[0:${src.streamIndex}]${[...head, ...text, ...tail].join(',')}[v]`;
  }

  const bufsize = Math.round(v.maxBitrateBps * VBV_BUFFER_S);
  return [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    // Level tags ([error]): only error lines count for the blame (libass warns about fonts and goes on).
    '-loglevel', 'level+warning',
    ...inputs,
    '-filter_complex', graph,
    '-map', '[v]',
    ...(plan.audio ? ['-map', `${audioInput}:${plan.audio.source.streamIndex}`] : []),
    '-c:v', 'libx264',
    '-preset', X264_PRESET,
    '-profile:v', 'high',
    '-level:v', h264Level(v.width, v.height, src.frameRate, v.maxBitrateBps, bufsize),
    '-crf', String(X264_CRF),
    '-maxrate', String(v.maxBitrateBps),
    '-bufsize', String(bufsize),
    '-/force_key_frames:v', r.keyframeFile,
    '-forced-idr', '1',
    // Timestamps of the filter output, not snapped to 1/frame rate: the keyframe list and the trim compare
    // them with Bₖ, and a run from the start and a restart must agree on every frame.
    '-enc_time_base:v', 'filter',
    '-fps_mode:v', 'passthrough',
    ...(v.toneMap === 'to_sdr' ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'] : []),
    ...(plan.audio ? audioArgs(plan.audio.action, plan.audio.source, startMs) : []),
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

/** BANDWIDTH estimate: the VBV bounds a segment at maxrate × (1 + buffer / target); CRF averages below maxrate. */
export function transcodeVideoBitrate(maxBitrateBps: number, targetMs: number): { peakBps: number; averageBps: number } {
  return { peakBps: Math.round(maxBitrateBps * (1 + (VBV_BUFFER_S * 1000) / targetMs)), averageBps: maxBitrateBps };
}

// ---------------------------------------------------------------- failures

export type Blame = Pick<StreamFailure, 'class' | 'suspect' | 'exclusion'>;
export type BlameFn = (f: { kind: StreamFailureKind; stderrClass: StderrClass | null; stderr: string }) => Blame | null;

// Filter instances log as [Parsed_<name>_<n> @ …]: no word boundary around the name.
const SUBTITLE_STDERR = /subtitles|libass|overlay|sub2video|fontconfig|\bass\b|\bfont/i;
const AUDIO_STDERR = /aresample|aformat|\b(?:aac|flac|libopus|opus|eac3|ac3|audio)\b/i;
/** A line logged at error level or worse (-loglevel level+…): `[ctx @ 0x…] [error] …` or `[fatal] …`. */
const ERROR_LINE = /^(?:\[([^\]]*?)(?: @ [^\]]*)?\] )?\[(?:error|fatal|panic)\] /;

/**
 * What a failure names, from the error-level lines only (warnings, such as libass's about fonts, never
 * count): the last error line, and the context of every error line (the failing filter instance or encoder).
 */
function failingParts(stderr: string): string {
  const parts: string[] = [];
  let last = '';
  for (const line of stderr.split(/\r?\n/)) {
    const m = ERROR_LINE.exec(line.trim());
    if (!m) continue;
    if (m[1]) parts.push(m[1]);
    last = line.trim();
  }
  return [...parts, last].join('\n');
}

/**
 * Who a failed Transcode run blames (doc 04 §8), from ffmpeg's error lines. A filter or encoder error from
 * the burn-in (libass, overlay, sub2video) excludes burning that track; one from the audio chain excludes
 * that conversion; anything else stays a stream failure of the video (one retry, then terminal).
 * Null: the stream's default rule (restart/init mismatch, AAC channel configuration).
 */
export function transcodeBlame(plan: TranscodePlan, burn: BurnSource | null): BlameFn {
  return ({ kind, stderrClass, stderr }) => {
    if (kind !== 'process_exit' || (stderrClass !== 'filter' && stderrClass !== 'encode')) return null;
    const last = failingParts(stderr);
    if (burn && SUBTITLE_STDERR.test(last)) {
      const exclusion: PlanExclusion = { dimension: 'subtitle', trackId: burn.trackId, delivery: 'burned', fileId: plan.file.fileId, cause: 'server', error: kind };
      return { class: 'format', suspect: 'subtitle', exclusion };
    }
    if (plan.audio?.action.kind === 'convert' && AUDIO_STDERR.test(last)) {
      return { class: 'stream', suspect: 'audio', exclusion: { dimension: 'audio', action: 'convert', codec: plan.audio.action.codec, cause: 'server', error: kind } };
    }
    const suspect: SuspectDimension = 'video';
    return { class: 'stream', suspect, exclusion: null };
  };
}
