// Ports between modules (doc 02, doc 03 §8). Plain serializable data only.
// Each port is implemented by exactly one module and consumed through the composition root
// (src/app/compose.ts); modules never import each other's internals.
import type { components } from '../contract/schema.d.ts';
import type { MediaFacts } from './media-facts.ts';
import type {
  ExternalIdLookup,
  ExternalIds,
  MetadataCandidate,
  MetadataProviderName,
  MetadataSearchRequest,
  ProviderResult,
  ProviderStatus,
  WorkKind,
} from './metadata.ts';
import type {
  DeliveryMode,
  PlanExclusion,
  PlaybackPlan,
  StreamProtocol,
  SubtitleAvailability,
  SuspectDimension,
} from './playback-plan.ts';

export type ApiSchemas = components['schemas'];
export type ItemSummary = ApiSchemas['ItemSummary'];
export type ProfileItemState = ApiSchemas['ProfileItemState'];
export type ProfilePrefs = ApiSchemas['ProfilePrefs'];
export type ClientCapabilities = ApiSchemas['ClientCapabilities'];
export type MediaVersion = ApiSchemas['MediaVersion'];

/** A playable file linked to an item, as the Playback module needs it. Implemented by catalog. */
export interface PlayableFile {
  fileId: string;
  available: boolean;
  facts: MediaFacts;
}

export interface PlayableItem {
  itemId: string;
  kind: ItemSummary['kind'];
  title: string;
  durationMs: number | null;
  files: PlayableFile[];
}

/** Implemented by modules/catalog. */
export interface CatalogReadPort {
  getPlayableItem(itemId: string): PlayableItem | null;
  /** Ids of the episodes of a series/season that have at least one linked file, in viewing order. */
  listPlayableDescendants(itemId: string): string[];
  itemExists(itemId: string): boolean;
  /**
   * Kind and position of each known item (unknown ids are left out). Lets profiles tell series,
   * seasons and episodes apart and order episodes without reading catalog tables.
   */
  describeItems(itemIds: readonly string[]): Map<string, CatalogItemPosition>;
}

export interface CatalogItemPosition {
  id: string;
  kind: CatalogItemKind;
  parentId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/** A profile's playback preferences (contract `ProfilePrefs`), read by the Decision Engine. */
export type ProfilePlaybackPrefs = components['schemas']['ProfilePrefs'];

/** One progress sample from playback (reportProgress, stopPlayback, end of stream). */
export interface ProgressSample {
  profileId: string;
  /** The playable item (movie, episode, documentary, extra), not a series or season. */
  itemId: string;
  fileId: string;
  /** Original timeline, PTS − start_time (doc 04 §6.1, ADR 0003). */
  positionMs: number;
  durationMs: number | null;
  /** Server time of the sample; a sample older than the stored one is ignored. */
  at: number;
  /** True when the session ended at the end of the item (credits reached or stream finished). */
  ended: boolean;
  /** Audio track playing (`s<index>`), when known. Stored as the last choice for the item (doc 01 §7.2). */
  audioTrackId?: string;
  /** Subtitle track shown (`s<index>` or `x:<id>`), null when subtitles are off, absent when unknown. */
  subtitleTrackId?: string | null;
}

/** The last track choice of a profile on an item, reused by StartPlayback (doc 03, doc 01 §7.2). */
export interface TrackChoice {
  /**
   * File the choice was made on (the progress row's file). Track ids are file-local: on another
   * version playback matches the track by its descriptor instead. Null when unknown.
   */
  fileId: string | null;
  audioTrackId: string | null;
  /** Null: subtitles were off. Absent: unknown (never recorded on this file), the prefs decide. */
  subtitleTrackId?: string | null;
}

/**
 * Implemented by modules/profiles, used by modules/playback. Profiles owns progress, history and
 * the "watched" rule (threshold, propagation to series/season); playback only reports samples.
 */
export interface ProfilePlaybackPort {
  /** Null when the profile does not exist (deleted while a session was open). */
  getPrefs(profileId: string): ProfilePlaybackPrefs | null;
  /** Idempotent: last write wins by `at`. */
  recordProgress(sample: ProgressSample): void;
  /** Resume position for an item on the original timeline, or null to start from the beginning. */
  resumePositionMs(profileId: string, itemId: string): number | null;
  /** Last tracks chosen on this item, or null when never played with known tracks. */
  lastTrackChoice(profileId: string, itemId: string): TrackChoice | null;
}

/** Implemented by modules/profiles. Used by catalog to compose Home and summaries, and by admin (moveFileState). */
export interface ProfileStatePort {
  getStates(profileId: string, itemIds: readonly string[]): Map<string, ProfileItemState>;
  /** Items in progress (not watched, 0 < progress < 90%), most recent first. */
  continueWatching(profileId: string, limit: number): string[];
  /** Episode id to watch next in a series, or null. */
  nextUp(profileId: string, seriesId: string): string | null;
  /**
   * Last time (ms UTC) each item was played by the profile; items never played are left out.
   * Optional: ListItems sort=last_played falls back to the Continue watching order without it.
   */
  lastPlayed?(profileId: string, itemIds: readonly string[]): Map<string, number>;
  /**
   * A file moved from fromItemIds to the single item toItemId (admin resolution or re-link). What every
   * profile recorded on that file follows it, merged last-write-wins: progress, viewing records (history)
   * and the watched state their completions imply. An old item stays watched only through a completion
   * left on it or a manual mark (which records no file). Viewing records from before migration 0003 have
   * no file and stay. Synchronous: joins the caller's open transaction. Returns the progress and viewing
   * rows moved. Optional: admin skips it when no module provides it.
   */
  moveFileState?(fileId: string, fromItemIds: readonly string[], toItemId: string): number;
}

/** Implemented by modules/catalog: catalog views the admin API shows next to cases and files. */
export interface CatalogViewPort {
  /** Summaries without profile state, in the order of itemIds; unknown ids are left out. */
  summaries(itemIds: readonly string[]): ItemSummary[];
  /** Technical summary of one file, as GetItem shows it in versions, or null if unknown. */
  mediaVersion(fileId: string): MediaVersion | null;
}

/**
 * Implemented by modules/catalog: manual MediaLinks, which the catalog owns (doc 02 §4).
 * Synchronous: a call joins the caller's open transaction. Publishes library.item_updated.
 */
export interface CatalogLinkPort {
  /** The file's manual links become exactly itemIds (which must exist). Returns the items that lost a manual link. */
  replaceManualLinks(fileId: string, itemIds: readonly string[]): { removed: string[] };
  /** Removes the file's manual links; returns the items they pointed to. */
  removeManualLinks(fileId: string): string[];
}

/**
 * Implemented by modules/identifier, which owns IdentificationCase, the file state it implies and
 * the auto links. Synchronous: a call joins the caller's open transaction.
 */
export interface CaseSettlementPort {
  /**
   * The owner's decision: the case takes that state, the file follows ('identified' or 'ignored';
   * a missing or removed file keeps its state) and the file's auto links are removed.
   * Null if the case does not exist.
   */
  settleCase(caseId: string, decision: 'resolved' | 'ignored'): { fileId: string; removedAutoLinks: string[] } | null;
}

/** Implemented by modules/library (Library Monitor). */
export interface LibraryControlPort {
  /** Enqueues library.scan for one root or all, at most one queued plus one follow-up. Returns the job id or null. */
  requestScan(rootId?: string): string | null;
  /**
   * The owner confirms that the files a held root lacks were really removed: the next scan may
   * mark up to that many files missing despite the unmounted-root guard. Queues that scan.
   */
  confirmRootContents(
    rootId: string,
  ): { status: 'queued'; jobId: string | null } | { status: 'not_found' } | { status: 'not_configured' } | { status: 'not_held' };
}

export interface JobStats {
  /** Jobs per type, then per state. */
  counts: Record<string, Record<string, number>>;
  /** Failed jobs, most recent first. */
  failed: { jobId: string; type: string; error: string; attempts: number; updatedAt: number }[];
}

/** Implemented by modules/jobs: what the admin API needs on top of JobQueuePort. */
export interface JobAdminPort {
  /** A failed job goes back to queued with attempts 0. */
  retry(jobId: string): 'requeued' | 'not_failed' | 'not_found';
  stats(failedLimit: number): JobStats;
}

/** Implemented by modules/profiles. Used by the HTTP security handler. */
export interface ProfileTokenVerifier {
  /** Returns the profile id for a valid profile token, null otherwise. */
  verify(token: string): string | null;
}

/** Implemented by modules/jobs (doc 03 §8 JobRunner). */
export interface JobQueuePort {
  enqueue(job: {
    type: string;
    payload: unknown;
    priority?: number;
    idempotencyKey?: string;
    runAt?: number;
  }): string | null;
}

/** Implemented by modules/events (table domain_event); all modules may publish. */
export interface EventPublisher {
  publish(type: string, payload: Record<string, unknown>): void;
}

// ---------------------------------------------------------------- identification and catalog writes (F1a.2)

/**
 * Implemented by modules/metadata (F1a.4): the neutral provider contract of doc 03 §8 and ADR 0007
 * point 1, limited to what identification needs. The registry holds only configured providers.
 * The caller picks the provider, so the identifier owns the order (Wikidata first, TMDB as the
 * fallback, ADR 0007 point 4). Adapters own rate limits, retries, caching and the User-Agent.
 */
export interface MetadataSearchPort {
  /** Every known provider and its state; only 'ok' and 'degraded' providers are used. */
  status(): ProviderStatus[];
  /** Full-text search. An empty list and not_found both mean "no candidates". */
  search(provider: MetadataProviderName, request: MetadataSearchRequest): Promise<ProviderResult<MetadataCandidate[]>>;
  /**
   * One work by external id (Wikidata: haswbstatement P4947/P4983/P345/P4835; TMDB: by id or /find).
   * The candidate carries its aliases (TMDB: alternative_titles): the TMDB fallback re-scores a
   * low_score case with them.
   */
  lookupByExternalId(provider: MetadataProviderName, lookup: ExternalIdLookup): Promise<ProviderResult<MetadataCandidate>>;
}

/** Sources of a field value (schema FIELD_SOURCES). Resolution: manual > tmdb > wikidata > filename > container. */
export type FieldSource = 'manual' | 'tmdb' | 'wikidata' | 'filename' | 'container';
export type CatalogItemKind = 'movie' | 'series' | 'season' | 'episode' | 'extra';
export type ExtraType = 'trailer' | 'featurette' | 'behind-the-scenes' | 'deleted-scene' | 'interview' | 'other';
export type ItemCategory = 'film' | 'documentary';

/**
 * Values of one source. A key left out is not touched; null (or an empty string or list) removes
 * that source's value. overview, tagline and genres are stored in item_field under these keys and
 * resolved on read (they are not projected onto catalog_item).
 */
export interface ItemFieldValues {
  title?: string | null;
  originalTitle?: string | null;
  year?: number | null;
  category?: ItemCategory | null;
  durationMs?: number | null;
  overview?: string | null;
  tagline?: string | null;
  genres?: string[] | null;
}

export interface SourcedFieldValues {
  source: FieldSource;
  fetchedAt: number;
  values: ItemFieldValues;
}

export interface WorkInput {
  kind: WorkKind;
  /** {edition-…} label: the same work in another edition is a distinct item (doc 01 §3.4). */
  editionLabel: string | null;
  externalIds: ExternalIds;
  fields: SourcedFieldValues[];
}

export interface CatalogItemRef {
  id: string;
  kind: CatalogItemKind;
  parentId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  editionLabel: string | null;
  title: string;
}

export interface CatalogWriteResult {
  itemId: string;
  created: boolean;
}

/**
 * Implemented by modules/catalog: the writes identification needs, reused by the Enricher (F1a.4).
 * Synchronous on purpose: every call joins the caller's open transaction, so a case, its links and
 * the catalog writes commit together. Every write recomputes the resolved projection on
 * catalog_item and its search row in the same transaction (ADR 0002 M3). Only the catalog writes
 * item_field, field_lock and external_id.
 */
export interface CatalogWritePort {
  /** Work item with one of these ids, looked up by QID, then TMDB, then IMDb, then TVDB. */
  findWork(kind: WorkKind, externalIds: ExternalIds, editionLabel: string | null): string | null;
  /** Finds (as findWork) or creates the work item, adds the missing external ids, writes the fields. */
  upsertWork(input: WorkInput): CatalogWriteResult;
  ensureSeason(seriesId: string, seasonNumber: number): CatalogWriteResult;
  ensureEpisode(seasonId: string, episodeNumber: number): CatalogWriteResult;
  /**
   * New extra below parentId, or an orphan (null). With numberIfTaken, a title a sibling extra
   * already uses gets a number ("Trailer", "Trailer 2"): the Plex-suffix labels of the standard §5.
   */
  createExtra(input: { parentId: string | null; extraType: ExtraType; title: string; numberIfTaken: boolean; fetchedAt: number }): CatalogWriteResult;
  writeFields(itemId: string, fields: readonly SourcedFieldValues[]): void;
  /** Adds the ids the item has no value for; an existing id of the same provider is kept. */
  addExternalIds(itemId: string, externalIds: ExternalIds): void;
  getItem(itemId: string): CatalogItemRef | null;
  /** The item itself if it has that kind, else its nearest ancestor of that kind. */
  findAncestor(itemId: string, kind: CatalogItemKind): string | null;

  // ---- F1a.4: Enricher, artwork, expiry and purge (ADR 0007 points 2, 5, 6)

  /** Recomputes the projection and the search row of one item. */
  refresh(itemId: string): void;
  getExternalIds(itemId: string): ExternalIds;
  /** Direct children (seasons of a series, episodes of a season, extras), by number then title. */
  listChildren(itemId: string): CatalogItemRef[];
  /** Replaces the credits of one source on the item (persons of that source are reused by ref). */
  replaceCredits(itemId: string, source: FieldSource, credits: readonly CreditInput[]): void;
  /**
   * Replaces the artwork rows of (item, source, type) with these. Returns the local paths no
   * artwork row references any more, so the Artwork Store can delete the files.
   */
  setArtwork(itemId: string, source: ArtworkSource, type: ArtworkType, images: readonly ArtworkInput[]): string[];
  listArtwork(itemId: string): ArtworkRecord[];
  /** Any artwork row whose file is the image with this key (contract imageKey), or null. */
  findArtworkByKey(imageKey: string): ArtworkRecord | null;
  /** Every artwork row of this image key gets fetched_at 0, so the next enrichment downloads it again. */
  markImageMissing(imageKey: string): void;
  /** True if any value, credit or artwork row of the source exists (one-row EXISTS, ADR 0007 point 8). */
  hasSourceData(source: 'tmdb'): boolean;
  /** Top-level works (movie, series) with the age of their provider values, for the refresh sweep. */
  listWorkRefreshState(): WorkRefreshState[];
  /**
   * ExpireProviderValues (ADR 0007 point 5): drops the values, credits and artwork rows of the
   * source fetched before the cutoff, even if locked, and recomputes the affected items.
   */
  expireSource(source: 'tmdb', fetchedBefore: number): SourceRemoval;
  /** PurgeProviderData (ADR 0007 point 5): drops every value, credit and artwork row of the source. Idempotent. */
  purgeSource(source: 'tmdb'): SourceRemoval;
}

export type ArtworkType = 'poster' | 'backdrop' | 'logo' | 'still' | 'thumbnail';
export type ArtworkSource = 'tmdb' | 'wikidata' | 'upload' | 'generated';
export type CreditRole = 'director' | 'creator' | 'actor';

export interface CreditInput {
  name: string;
  role: CreditRole;
  character: string | null;
  /** Billing order within the role, 0 first. */
  order: number;
  /** Provider person id (Wikidata QID, TMDB person id), so a person is stored once per source. */
  personRef: string | null;
}

export interface ArtworkInput {
  type: ArtworkType;
  language: string | null;
  /** Relative to the artwork volume: `<key[0..2]>/<key>/<file>` (see imageKeyOf in shared/metadata.ts). */
  localPath: string;
  remoteRef: string | null;
  width: number | null;
  height: number | null;
  fetchedAt: number;
}

export interface ArtworkRecord extends ArtworkInput {
  id: string;
  itemId: string;
  source: ArtworkSource;
  selected: boolean;
}

export interface WorkRefreshState {
  itemId: string;
  kind: WorkKind;
  /**
   * Age of the work's TMDB data: the newest fetched_at of its values (the last refresh), or the
   * oldest fetched_at of its own TMDB artwork if that is older. Null if it has neither.
   */
  tmdbFetchedAt: number | null;
  /** Newest fetched_at of the work's Wikidata values (the last refresh), null if it has none. */
  wikidataFetchedAt: number | null;
}

export interface SourceRemoval {
  /** Items whose projection was recomputed. */
  itemIds: string[];
  /** Artwork files no row references any more. */
  unreferencedPaths: string[];
}

/** Implemented by modules/identifier: maintenance of identification_case data (ADR 0007 point 5). */
export interface IdentificationMaintenancePort {
  /**
   * Removes the candidates of a provider from the stored cases (TMDB candidates are TMDB Content).
   * With updatedBefore, only cases last written before it (expiry); null = every case (purge).
   * Returns how many cases changed.
   */
  dropProviderCandidates(provider: MetadataProviderName, updatedBefore: number | null): number;
}

// ---------------------------------------------------------------- stream delivery (F1b)

/** One started stream. A re-plan stops it and starts a new one, with a new token (ADR 0003 D7). */
export interface StreamRef {
  streamId: string;
}

/** A subtitle track served separately: one per plan.subtitles.served, in the same order. */
export interface SubtitleLocator {
  trackId: string;
  /** Relative data-plane URL: /video/media/s/<token>/subtitles/<trackId>.<sup|vtt>. */
  url: string;
  availability: SubtitleAvailability;
}

/** contract stream.bitrate (ADR 0003 D14), estimated from the keyframe index for the stream as served. */
export interface StreamBitrate {
  peakBps: number;
  averageBps: number;
  audioBps: number;
}

/** Result of StreamDeliveryPort.start: what the Session Manager needs for PlaybackSession.stream and the subtitle tracks. */
export interface StreamHandle extends StreamRef {
  sessionId: string;
  mode: DeliveryMode;
  protocol: StreamProtocol;
  locators: {
    /** Relative data-plane URL: /video/media/s/<token>/file (progressive) or …/hls/main.m3u8 (hls-fmp4). */
    stream: string;
    subtitles: SubtitleLocator[];
  };
  /** RFC 6381 type of what is served; for hls-fmp4 the segments' type, both codecs read from the init (ADR 0003 D1, D11). */
  mimeType: string;
  bitrate: StreamBitrate;
  /** 10000 for hls-fmp4, 0 for progressive (ADR 0003 D5). stream.startOffsetMs is always 0. */
  mediaTimestampOffsetMs: number;
  startedAt: number;
}

/**
 * What went wrong, classified by delivery from the process exit, its stderr and its own checks:
 * - process_exit: ffmpeg exited with a code ≠ 0;
 * - restart_mismatch: a restart's first kept keyframe is more than 1 ms from Bₖ (ADR 0003 D4);
 * - init_mismatch: a restart's init segment differs from the first one (ADR 0003 D4, t1);
 * - aac_channel_config: the AAC encoder wrote channelConfiguration 0 (PCE) in the esds (ADR 0003 D11);
 * - no_output: no init segment within the start timeout;
 * - file_unavailable: root offline, file missing, or size/mtime differ from the plan;
 * - io_error: a scratch or cache write failed (quota, disk).
 */
export type StreamFailureKind =
  | 'process_exit'
  | 'restart_mismatch'
  | 'init_mismatch'
  | 'aac_channel_config'
  | 'no_output'
  | 'file_unavailable'
  | 'io_error';

export type StderrClass = 'demux' | 'decode' | 'filter' | 'encode' | 'mux' | 'io' | 'unknown';

/**
 * Delivery's own record of a failure (doc 04 §8, ADR 0003 D7, doc 02 §3.11). The Session Manager
 * re-plans from this record, never from the client's suspect.
 */
export interface StreamFailure {
  at: number;
  kind: StreamFailureKind;
  /** format: the plan's format cannot work (re-plan excluding it); stream: producing the stream failed. */
  class: 'format' | 'stream';
  suspect: SuspectDimension;
  /** The minimal exclusion delivery can name (cause 'server'), or null; the Session Manager decides. */
  exclusion: PlanExclusion | null;
  exitCode: number | null;
  signal: string | null;
  stderrClass: StderrClass | null;
  /** Last stderr lines, at most 4 KiB, for diagnostics only: playback never parses it. */
  stderrTail: string;
  /** Original-timeline position of the failed segment or request, if known. */
  positionMs: number | null;
  segment: number | null;
  /** True once the data plane answers 500 STREAM_FAILED for this stream, after delivery's one automatic retry. */
  terminal: boolean;
}

/**
 * Typed outcome of start. Codes are the contract's Problem codes, so playback maps them 1:1.
 * - STREAM_PREPARING (503 + Retry-After): only the slow probe can build the keyframe index; delivery
 *   has already enqueued delivery.keyframe_index at urgent priority (ADR 0003 D8). Also a start whose
 *   ffmpeg wrote no init segment in time without exiting (an overloaded host): bounded, the same file
 *   and stream shape timing out twice in a row is STREAM_FAILED, and the Session Manager caps the
 *   total wait (PLAYBACK_PREPARING_MAX_S). Also an embedded text track to burn in, until its
 *   extraction completes (F1b.4).
 * - MEDIA_UNAVAILABLE (503): root not configured or offline, file missing or changed, unsafe path; also
 *   the host's faults at start: scratch full or not writable, ffmpeg missing or not spawnable.
 * - STREAM_FAILED: no usable init segment after delivery's automatic retry. With failure.class
 *   'format' (e.g. aac_channel_config) the Session Manager re-plans at once with failure.exclusion,
 *   within the 3 automatic attempts of doc 04 §8.
 * A plan of another planVersion is a programming error and throws.
 */
export type StreamStartResult =
  | { ok: true; handle: StreamHandle }
  | { ok: false; code: 'STREAM_PREPARING'; retryAfterMs: number }
  | { ok: false; code: 'MEDIA_UNAVAILABLE'; detail: string }
  | { ok: false; code: 'STREAM_FAILED'; failure: StreamFailure };

/** Why a stream stops. For replanned and expired the output is discarded, so the process is killed at once (ADR 0003 D7). */
export type StreamStopReason = 'stopped' | 'terminated' | 'expired' | 'replanned' | 'shutdown';

export interface StreamStatus extends StreamRef {
  sessionId: string;
  /** active also covers an idle-killed process that restarts on the next request (DELIVERY_IDLE_KILL_S). */
  state: 'active' | 'failed' | 'stopped';
  /** Latest failure record, also one delivery's automatic retry recovered from; null if none. */
  failure: StreamFailure | null;
  subtitles: { trackId: string; availability: SubtitleAvailability }[];
  /** Last data-plane request for this stream (ms UTC), null if none yet. */
  lastRequestAt: number | null;
}

/**
 * Implemented by modules/delivery, consumed by the Session Manager in modules/playback (doc 03 §8,
 * ADR 0003 D9). Plain JSON in and out, and every call is async, so the port becomes an RPC
 * unchanged when delivery moves into video-worker (C1).
 *
 * Tokens: delivery owns the token table (ADR 0003 D9), so there is no token port. start mints a
 * random token, keeps only its SHA-256 and returns the token inside the locators. The data-plane
 * handlers look the hash up in the map, resolve {track} against the plan's served tracks (never
 * joined into a path), and answer 410 for a tombstoned token (stop, re-plan) until its TTL ends,
 * 404 after that.
 *
 * Failures are pulled, not pushed: every recovery starts either in start (typed result) or in the
 * client's reportPlaybackFailure, which then reads status(ref).failure. A pull keeps the port
 * one-directional for an RPC, with no callback across the C1 boundary.
 */
export interface StreamDeliveryPort {
  /** sessionId is the session's current id: delivery uses it in playback.subtitle_ready events. */
  start(plan: PlaybackPlan, sessionId: string): Promise<StreamStartResult>;
  /** Idempotent. Kills the process, clears the scratch, tombstones the token. Subtitle extraction is per file and keeps running. */
  stop(ref: StreamRef, reason: StreamStopReason): Promise<void>;
  /** null for an unknown stream, or a stopped one past its tombstone TTL. */
  status(ref: StreamRef): Promise<StreamStatus | null>;
}
