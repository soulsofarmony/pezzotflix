// Job types that cross module boundaries: the producer enqueues, another module handles them.
// Modules never import each other, so both sides type-check against these names and payloads.
import type { MediaLocation } from './media-facts.ts';

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
} as const;

/**
 * Lower runs first (default 100). enqueue leaves a queued job with the same idempotency key alone and
 * does not raise its priority, so the urgent enqueue uses its own key `keyframes-now:<fileId>`; the
 * later background job then finds the index cached and returns at once.
 */
export const KEYFRAME_INDEX_URGENT_PRIORITY = 0;

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
