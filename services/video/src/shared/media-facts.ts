// MediaFacts (doc 03 §8, MediaProbe): what the Media Analyzer knows about one file.
// Serializable plain data. Produced by modules/analyzer, stored in media_file.facts and
// normalised into media_stream/chapter; consumed by catalog (badges, versions) and playback.
// Never contains absolute host paths: a file is always (rootName, relPath).
import { createHash } from 'node:crypto';

export interface MediaLocation {
  rootName: string;
  relPath: string;
}

export type HdrFormat = 'SDR' | 'HDR10' | 'HDR10+' | 'HLG' | 'DV';

export interface DolbyVisionInfo {
  profile: number;
  level: number;
  /** dv_bl_signal_compatibility_id: 1 = HDR10, 2 = SDR, 4 = HLG, 6 = BT.2020 (P7), 0 = none. */
  blCompatId: number;
  hasEnhancementLayer: boolean;
  rpuPresent: boolean;
}

interface StreamBase {
  /** ffprobe stream index within the container. */
  index: number;
  codec: string; // ffprobe codec_name, lower case (hevc, h264, truehd, dts, hdmv_pgs_subtitle, subrip ...)
  profile: string | null; // ffprobe profile (Main 10, DTS-HD MA, ...)
  language: string | null; // ISO 639-2/B as tagged, normalised lower case; null if und/missing
  title: string | null;
  default: boolean;
  forced: boolean;
}

export interface VideoStreamFacts extends StreamBase {
  type: 'video';
  width: number;
  height: number;
  frameRate: number | null;
  bitDepth: number | null;
  pixFmt: string | null;
  colorTransfer: string | null; // smpte2084, arib-std-b67, bt709 ...
  colorPrimaries: string | null;
  hdr: HdrFormat;
  /** Additional HDR layers present besides the base (e.g. DV + HDR10 base => ['HDR10']). */
  hdrFallback: HdrFormat[];
  dolbyVision: DolbyVisionInfo | null;
  bitRate: number | null;
  attachedPic: boolean;
  /**
   * ffprobe level: HEVC general_level_idc (30 × level, e.g. 153 = 5.1), AVC level_idc (10 × level, 41).
   * Optional: facts stored before F1b.3 lack it. Used for the Direct Play codec string (ADR 0003 D10).
   */
  level?: number | null;
}

export interface AudioStreamFacts extends StreamBase {
  type: 'audio';
  channels: number;
  channelLayout: string | null;
  sampleRate: number | null;
  bitRate: number | null;
  lossless: boolean;
  /** Object audio detected from profile/title: 'atmos' (TrueHD/E-AC-3 JOC) or 'dtsx'. */
  objectAudio: 'atmos' | 'dtsx' | null;
  commentary: boolean;
  /**
   * Audio description for the visually impaired (disposition visual_impaired): ranked last with the
   * commentaries. Facts stored before this field read it as absent (false).
   */
  audioDescription: boolean;
}

export interface SubtitleStreamFacts extends StreamBase {
  type: 'subtitle';
  kind: 'text' | 'image';
  sdh: boolean;
  /** Commentary track (disposition comment or title), as for audio. Absent in older facts (false). */
  commentary: boolean;
  /** Number of events if cheaply known (e.g. from tags); null otherwise. */
  eventCount: number | null;
}

export type StreamFacts = VideoStreamFacts | AudioStreamFacts | SubtitleStreamFacts;

export interface ChapterFacts {
  index: number;
  title: string | null;
  startMs: number;
  endMs: number;
}

export interface SidecarSubtitleFacts {
  /** Stable id within the file: "x:" + first 8 hex chars of sha256(file name); survives sidecars being added/removed. */
  id: string;
  relPath: string;
  format: 'srt' | 'ass' | 'ssa' | 'vtt' | 'sup';
  language: string | null;
  forced: boolean;
  sdh: boolean;
}

export interface MediaFacts {
  location: MediaLocation;
  sizeBytes: number;
  mtimeMs: number;
  /** ffprobe format_name normalised: 'matroska' | 'mp4' | 'mpegts' | 'webm' | 'avi' ... */
  container: string;
  durationMs: number | null;
  bitRate: number | null;
  streams: StreamFacts[];
  chapters: ChapterFacts[];
  sidecars: SidecarSubtitleFacts[];
  /** ffprobe/analyzer version, for re-analysis when the analyzer changes. */
  analyzerVersion: number;
}

/** Track id as exposed by the API: "s<index>" for embedded streams, "x:<8 hex>" for sidecars. */
export const streamTrackId = (index: number): string => `s${index}`;

/** Track id of a sidecar (SidecarSubtitleFacts.id), from its file name only. */
export const sidecarTrackId = (relPath: string): string =>
  `x:${createHash('sha256').update(relPath.slice(relPath.lastIndexOf('/') + 1)).digest('hex').slice(0, 8)}`;
