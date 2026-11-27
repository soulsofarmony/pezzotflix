// Job types that cross module boundaries: the producer enqueues, another module handles them.
// Modules never import each other, so both sides type-check against these names and payloads.
import type { HdrFormat, MediaLocation } from './media-facts.ts';

export const JOB_TYPES = {
  /** Handled by library: scan one root, or every configured root. */
  libraryScan: 'library.scan',
  /** Enqueued by library, handled by analyzer. */
  analyzerProbe: 'analyzer.probe',
  /** Enqueued by analyzer (after a probe) and library (after a rename), handled by identifier. */
  identifierIdentify: 'identifier.identify',
  /**
   * Enqueued by catalog when a work is created or gains external ids (auto match or manual
   * resolution), and by metadata's own refresh sweep; handled by metadata (Enricher).
   */
  metadataEnrich: 'metadata.enrich',
  /**
   * Mandatory after FileAnalyzed (ADR 0003 D8). Enqueued by analyzer after every successful probe
   * (key `keyframes:<fileId>`, default priority), and by delivery itself at priority
   * KEYFRAME_INDEX_URGENT_PRIORITY when start needs the slow probe (STREAM_PREPARING). Handled by delivery.
   */
  deliveryKeyframeIndex: 'delivery.keyframe_index',
  /**
   * Seek-bar preview sheets (ADR 0009 D5). Enqueued by analyzer after every successful probe of a file with
   * video and by its startup backfill, and by delivery at a session start without a valid cache, all under
   * trickplayJobKey. Handled by delivery.
   */
  deliveryTrickplay: 'delivery.trickplay',
} as const;

/**
 * Version of the trickplay parameters (format, interval, filters): part of the job key and of delivery's cache
 * stamp, so a bump makes every file's sheets stale and the analyzer's backfill queues them again.
 */
export const TRICKPLAY_VERSION = 1;

/** Idempotency key of delivery.trickplay: one job per content and parameter version (ADR 0009 D5). */
export const trickplayJobKey = (fileId: string, sizeBytes: number, mtimeMs: number): string =>
  `trickplay:v${TRICKPLAY_VERSION}:${fileId}:${sizeBytes}:${mtimeMs}`;

/**
 * Lower runs first (default 100). enqueue leaves a queued job with the same idempotency key alone and
 * does not raise its priority, so the urgent enqueue uses its own key `keyframes-now:<fileId>`; the
 * later background job then finds the index cached and returns at once.
 */
export const KEYFRAME_INDEX_URGENT_PRIORITY = 0;

/**
 * Start of job.last_error for a job the runner failed at start because the service stopped during
 * its last attempt twice in a row (it may kill the process). Sweeps that retry failed jobs skip these.
 */
export const JOB_INTERRUPTED_ERROR = 'interrupted on its last attempt';

/** Start of job.last_error for a job re-queued at start because the service stopped while it ran. */
export const JOB_INTERRUPTED_REQUEUED = 'interrupted, queued again';

export interface LibraryScanPayload {
  rootId?: string;
}

export interface AnalyzerProbePayload {
  fileId: string;
}

export interface IdentifierIdentifyPayload {
  fileId: string;
}

export interface MetadataEnrichPayload {
  itemId: string;
}

/**
 * Self-contained because delivery never reads the DB (C1): the producer copies these from MediaFacts.
 * The index is cached per fileId and invalid when sizeBytes or mtimeMs differ.
 */
export interface DeliveryKeyframeIndexPayload {
  fileId: string;
  location: MediaLocation;
  sizeBytes: number;
  mtimeMs: number;
  /** MediaFacts.container: 'matroska' reads the Cues, anything else uses the ffprobe probe. */
  container: string;
  /** Video stream to index (the plan's); null: the first video stream that is not cover art. */
  videoStreamIndex: number | null;
}

/**
 * Self-contained like the keyframe index payload (delivery never reads the DB): the facts of the video stream
 * the Decision Engine plays (the first video stream that is not cover art), copied from MediaFacts by the
 * analyzer or from the plan's VideoSource by delivery. The sample aspect ratio and the start time are not
 * needed: ffmpeg applies the stream's own SAR in the scale expression and zero-bases its timestamps on the
 * file's start_time by itself (ADR 0009 D1, D2).
 */
export interface DeliveryTrickplayPayload {
  fileId: string;
  location: MediaLocation;
  sizeBytes: number;
  mtimeMs: number;
  container: string;
  videoStreamIndex: number;
  /** Zero-based duration (MediaFacts.durationMs): sets the interval and the expected tile count. */
  durationMs: number | null;
  width: number;
  height: number;
  hdr: HdrFormat;
  /** The base layer under DV, as VideoSource.hdrFallback. */
  hdrFallback: HdrFormat[];
  dolbyVisionProfile: number | null;
}
