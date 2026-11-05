// PlaybackPlan: what the Decision Engine (modules/playback, pure) outputs and Stream Delivery
// (modules/delivery) executes (doc 03 §8, doc 04 §3). Plain JSON data only: no functions, class
// instances, Dates, Maps or undefined-valued fields, because delivery may move into the
// video-worker container (C1) and the plan then crosses a process boundary as JSON.
// The plan is self-contained: delivery never reads the DB or the catalog to execute it.
import type { components } from '../contract/schema.d.ts';
import type { HdrFormat, MediaLocation } from './media-facts.ts';

type Schemas = components['schemas'];

/** Bump when the plan shape changes incompatibly; a worker rejects plans of another version. */
export const PLAN_VERSION = 1;

/** doc 04 §2; contract DeliveryMode. */
export type DeliveryMode = Schemas['DeliveryMode'];
/** ADR 0003 D1: direct_play = progressive, direct_stream and transcode = hls-fmp4. */
export type StreamProtocol = Schemas['PlaybackSession']['stream']['protocol'];
/** Dimensions the engine evaluates (doc 04 §3) and a failure can be blamed on (doc 04 §8). */
export type PlanDimension = 'container' | 'video' | 'audio' | 'subtitle';
/** contract FallbackRequest.suspect. */
export type SuspectDimension = NonNullable<Schemas['FallbackRequest']['suspect']>;
/** contract SessionTrack.delivery (doc 03 §4.3). */
export type SubtitleDelivery = NonNullable<Schemas['SessionTrack']['delivery']>;
/** contract SessionTrack.availability (ADR 0003 D12). */
export type SubtitleAvailability = NonNullable<Schemas['SessionTrack']['availability']>;

// ---------------------------------------------------------------- file

/**
 * The file to play, as (rootName, relPath) per media-path.ts, never a host path (doc 03 §8).
 * Delivery resolves it with resolveInsideRoot(config root path, relPath) (ADR 0003 D10).
 */
export interface PlanFile {
  fileId: string;
  location: MediaLocation;
  /**
   * Content stamp from MediaFacts. Delivery's caches (keyframe index, extracted subtitles,
   * ADR 0003 D8/D12) are keyed by fileId and invalid when size or mtime differ.
   */
  sizeBytes: number;
  mtimeMs: number;
  /** MediaFacts.container ('matroska', 'mp4' ...): picks the keyframe index source (Cues or probe, ADR 0003 D8). */
  container: string;
  durationMs: number | null;
}

// ---------------------------------------------------------------- video

/** Source facts delivery needs for playlists and bitrates (ADR 0003 D2: RESOLUTION, FRAME-RATE, VIDEO-RANGE). */
export interface VideoSource {
  /** ffprobe stream index (MediaFacts streams[].index); mapped as -map 0:<index>. */
  streamIndex: number;
  codec: string;
  profile: string | null;
  width: number;
  height: number;
  frameRate: number | null;
  bitDepth: number | null;
  hdr: HdrFormat;
  dolbyVisionProfile: number | null;
  bitRate: number | null;
}

/**
 * Dolby Vision towards a client that does not play DV (doc 04 §4.2, ADR 0003 D13):
 * - none: no DV in the source;
 * - keep_rpu: P8.1 copied as is and served as HDR10 with hvc1 (S2);
 * - remove_dovi: P7, -bsf:v hevc_metadata=remove_dovi=1, then hvc1. Provisional until H11 is
 *   measured; the plan must carry a 'dv_p7_remove_dovi' reason.
 * Never -strict unofficial, never a DV box. P5 cannot be copied: it needs a Transcode (≤ 1080p, P2).
 */
export type DolbyVisionHandling = 'none' | 'keep_rpu' | 'remove_dovi';

/** Direct Play: the file is served byte for byte, no process (doc 04 §2). */
export interface VideoOriginal {
  kind: 'original';
  source: VideoSource;
}

/** Direct Stream: bitstream copied, resolution, HDR and bitrate intact (doc 04 §2, ADR 0003 D4). */
export interface VideoCopy {
  kind: 'copy';
  source: VideoSource;
  /** ADR 0003 D4: -tag:v hvc1 for HEVC only; null for every other codec. */
  tag: 'hvc1' | null;
  dolbyVision: DolbyVisionHandling;
}

/** Why the video is re-encoded (doc 04 §4.2, §4.4, §4.5). */
export type TranscodeCause = 'codec' | 'resolution' | 'bitrate' | 'hdr_tonemap' | 'dv_p5' | 'burn_in' | 'excluded'; // excluded: lighter modes excluded by failures (doc 04 §8)

/**
 * Software Transcode, sources up to 1080p only (P2), at most MAX_TRANSCODES at once (P4).
 * Output H.264 High 8-bit in fMP4; IDR keyframes forced on the segment grid (ADR 0003 D3), so
 * segment boundaries need no keyframe index. Encoder preset and rate control are delivery's.
 */
export interface VideoTranscode {
  kind: 'transcode';
  source: VideoSource;
  codec: 'h264';
  /** Even values, aspect ratio kept, never above the source and never above 1920×1080. */
  width: number;
  height: number;
  /** VBV max rate: min(client limits.maxBitrate minus audio, delivery default). */
  maxBitrateBps: number;
  /** HDR10/HLG to SDR (doc 04 §4.2): 'to_sdr' for every HDR source (8-bit H.264 output), 'none' for SDR sources. */
  toneMap: 'none' | 'to_sdr';
  causes: TranscodeCause[];
}

// ---------------------------------------------------------------- audio

export interface AudioSource {
  streamIndex: number;
  /** "s<index>", as in the contract Track.id. */
  trackId: string;
  codec: string;
  profile: string | null;
  language: string | null;
  channels: number;
  /** As probed; Blu-ray codecs decode to '5.1(side)' / '7.1' (doc 04 §4.3). */
  channelLayout: string | null;
  sampleRate: number | null;
  bitRate: number | null;
}

/**
 * Audio action, one step of the quality ladder of doc 04 §4.3 (ADR 0003 D11).
 * - copy: the client decodes the source codec (E-AC-3 copy needs delay_moov, ADR 0003 E4). Never
 *   for a source AAC with channelConfiguration 0 (PCE).
 * - flac: lossless at the source depth and layout (7.1 stays 7.1).
 * - eac3: 640 kb/s, only if the client declares it (Edge with the Dolby decoder).
 * - aac / opus: aformat=channel_layouts=<layout> before the encoder, always (5.1(side) → 5.1, 7.1 →
 *   5.1; never AAC with PCE). After the AAC encoder delivery checks channelConfiguration ≠ 0 in the
 *   init's esds; 0 is a format failure (ADR 0003 D7, D11). Stereo only for a client that is stereo.
 */
export type AudioAction =
  | { kind: 'copy' }
  | { kind: 'convert'; codec: 'flac'; channels: number; bitrateBps: null; layout: null }
  | { kind: 'convert'; codec: 'eac3'; channels: 6; bitrateBps: number; layout: '5.1' }
  | { kind: 'convert'; codec: 'aac' | 'opus'; channels: 6 | 2; bitrateBps: number; layout: '5.1' | 'stereo' };

/** Output codecs of a conversion. */
export type AudioOutputCodec = Extract<AudioAction, { kind: 'convert' }>['codec'];

/** One audio track per stream, muxed with the video (ADR 0003 D1); changing it is a re-plan. */
export interface PlanAudio {
  source: AudioSource;
  action: AudioAction;
}

// ---------------------------------------------------------------- subtitles

/** Where a subtitle track comes from. A sidecar relPath is relative to the same root as the file. */
export type SubtitleSource =
  | { kind: 'embedded'; streamIndex: number }
  | { kind: 'sidecar'; relPath: string; format: 'srt' | 'ass' | 'ssa' | 'vtt' | 'sup' };

/**
 * A subtitle track served separately at /subtitles/<trackId>.<format> (doc 03 §5, ADR 0003 D12):
 * - client_render: image track (PGS) as .sup for a client-side renderer (P3);
 * - sidecar: text track as WebVTT (SRT/ASS converted, ASS style lost).
 * Embedded sources are extracted, all tracks of the file in one process; sidecar files are
 * converted at request time.
 */
export interface ServedSubtitle {
  trackId: string;
  source: SubtitleSource;
  codec: string;
  language: string | null;
  forced: boolean;
  delivery: 'sidecar' | 'client_render';
  format: 'webvtt' | 'sup';
}

/** The selected track; trackId is "s<index>" (embedded) or "x:<id>" (sidecar), as in the contract Track.id. */
export interface SelectedSubtitle<D extends SubtitleDelivery> {
  trackId: string;
  source: SubtitleSource;
  codec: string;
  /** embedded: rendered by the client from the file (Direct Play only); burned: Transcode only, never 4K (P2). */
  delivery: D;
}

/**
 * Subtitle plan (doc 04 §4.4).
 * - served: every track the client must receive separately, so it can switch without a restart
 *   (switchWithoutRestart, doc 04 §6.3). Its embedded sources are the extraction set: delivery
 *   extracts exactly those stream indexes. Empty when the client renders all tracks from the stream.
 * - selected: null when subtitles are off; a served track is selected by its trackId.
 */
export interface PlanSubtitles<D extends SubtitleDelivery> {
  selected: SelectedSubtitle<D> | null;
  served: ServedSubtitle[];
}

// ---------------------------------------------------------------- reasons and exclusions

/**
 * Machine codes of the plan reasons. PlaybackSession.reasons and ExplainPlaybackDecision.reasons
 * are the `message` strings; the code keeps explain and tests stable (doc 04 §3, §8).
 */
export type ReasonCode =
  | 'direct_play'
  | 'forced_mode' // StartPlayback.forceMode, diagnostics only
  | 'version_chosen' // another file of the item won (D2): no video transcode, higher quality, lighter mode or lower cost
  | 'container_unsupported'
  | 'audio_track_selection' // multi-audio container on a client without audioTrackSelection (doc 04 §4.1)
  | 'dv_direct_play_unmeasured' // DV in MKV never Direct Play in the browser (doc 04 §4.1)
  | 'video_codec_unsupported'
  | 'video_resolution_exceeded'
  | 'video_bitrate_exceeded'
  | 'hdr_client_conversion' // P5: HDR10 on an SDR display, converted by the client
  | 'hdr_tonemap'
  | 'dv_p81_as_hdr10'
  | 'dv_p7_remove_dovi' // H11, provisional
  | 'dv_p5_transcode'
  | 'dv_base_layer' // native player without DV: plays the HDR10/HLG base layer of the file (doc 04 §4.1–4.2)
  | 'audio_copy'
  | 'audio_converted'
  | 'audio_downmixed' // 7.1 → 5.1 for a lossy output, or → stereo
  | 'audio_unsupported' // no step of the audio ladder serves the track (doc 04 §4.3)
  | 'subtitle_client_render'
  | 'subtitle_sidecar'
  | 'subtitle_burn_in'
  | 'subtitle_dropped' // no next treatment (e.g. burn-in on 4K): playback goes on without the track (doc 04 §8)
  | 'transcode_limited' // P2 deviation: a 4K source that would need a Transcode
  | 'transcode_disabled' // MAX_TRANSCODES = 0 or the transcode slot is taken (P4)
  | 'format_excluded' // a format excluded by an earlier failure of this session (doc 04 §8)
  | 'replanned_after_failure'
  | 'file_unavailable'; // explain candidates: the file is missing or its root offline

export interface PlanReason {
  code: ReasonCode;
  dimension: PlanDimension | 'file';
  /** Human-readable, as shown in the session and in diagnostics. */
  message: string;
}

/**
 * A format excluded for the rest of the session after a failure (doc 04 §8: "the failed format
 * stays excluded"). The Session Manager accumulates them and passes them to every re-plan, and the
 * plan echoes the set it was computed with, so explain and re-plan are reproducible.
 * - mode: this file can no longer use this mode (video, container or unknown suspect → heavier mode);
 * - audio: this audio output can no longer be used, for any track ('copy' + source codec and profile,
 *   so a DTS-HD MA copy does not exclude a DTS core; or a conversion);
 * - subtitle: this treatment of this track can no longer be used (→ next treatment of doc 04 §4.4).
 *   fileId names the file the track belongs to (track ids are per file); null = any file.
 *   Not optional: the plan carries no undefined-valued fields (JSON across C1).
 */
export type PlanExclusion = (
  | { dimension: 'container' | 'video'; fileId: string; mode: DeliveryMode }
  | { dimension: 'audio'; action: 'copy'; codec: string; profile: string | null }
  | { dimension: 'audio'; action: 'convert'; codec: AudioOutputCodec }
  | { dimension: 'subtitle'; trackId: string; delivery: SubtitleDelivery; fileId: string | null }
) & {
  /** Who blamed it: the client (reportPlaybackFailure) or delivery's own failure record (ADR 0003 D7). */
  cause: 'client' | 'server';
  /** FallbackRequest.error or StreamFailure.kind. */
  error: string;
};

// ---------------------------------------------------------------- plan

interface PlanBase {
  planVersion: typeof PLAN_VERSION;
  file: PlanFile;
  /** null for a file without audio (ADR 0003 D4: the audio map is optional). */
  audio: PlanAudio | null;
  /**
   * Where playback starts, original timeline = PTS − start_time of the file (doc 04 §6.1, ADR 0003
   * D5), already clamped to [0, duration]. The stream still covers the whole film
   * (stream.startOffsetMs = 0): delivery uses it to prepare the first segments and to place the
   * first subtitle pass at max(0, X − SUBTITLE_PREROLL_S) (ADR 0003 D12).
   */
  startPositionMs: number;
  reasons: PlanReason[];
  exclusions: PlanExclusion[];
}

export interface DirectPlayPlan extends PlanBase {
  mode: 'direct_play';
  protocol: 'progressive';
  video: VideoOriginal;
  /** In Direct Play the audio action is always copy: the file is served as is. */
  audio: (PlanAudio & { action: { kind: 'copy' } }) | null;
  subtitles: PlanSubtitles<'embedded' | 'sidecar' | 'client_render'>;
}

export interface DirectStreamPlan extends PlanBase {
  mode: 'direct_stream';
  protocol: 'hls-fmp4';
  video: VideoCopy;
  /** fMP4 segments carry no subtitles (-sn): every track is served separately or not at all. */
  subtitles: PlanSubtitles<'sidecar' | 'client_render'>;
}

export interface TranscodePlan extends PlanBase {
  mode: 'transcode';
  protocol: 'hls-fmp4';
  video: VideoTranscode;
  /** burned: the selected track is burned into the video; never for a source above 1080p (P2). */
  subtitles: PlanSubtitles<'sidecar' | 'client_render' | 'burned'>;
}

export type PlaybackPlan = DirectPlayPlan | DirectStreamPlan | TranscodePlan;
