// Drizzle schema: single source of truth for the Video Service database (ADR 0002).
// Conventions: TEXT UUIDv7 ids, INTEGER ms UTC timestamps, INTEGER booleans, CHECK on enums,
// JSON in TEXT only for data that is never queried.
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const inList = (col: string, values: readonly string[]) =>
  sql.raw(`${col} IN (${values.map((v) => `'${v}'`).join(', ')})`);

const id = () => text('id').primaryKey();
const ts = (name: string) => integer(name, { mode: 'number' });
const bool = (name: string) => integer(name, { mode: 'boolean' });

// ---------------------------------------------------------------- enums
export const ROOT_HINTS = ['movies', 'series', 'mixed'] as const;
export const ROOT_STATUS = ['online', 'offline'] as const;
export const ROOT_HOLD_REASONS = ['empty_walk', 'mass_missing'] as const;
export const FILE_STATES = ['discovered', 'analyzed', 'identified', 'needs_review', 'missing', 'removed', 'ignored'] as const;
export const STREAM_TYPES = ['video', 'audio', 'subtitle', 'attachment', 'data'] as const;
export const ITEM_KINDS = ['movie', 'series', 'season', 'episode', 'extra'] as const;
export const ITEM_CATEGORIES = ['film', 'documentary'] as const;
export const EXTRA_TYPES = ['trailer', 'featurette', 'behind-the-scenes', 'deleted-scene', 'interview', 'other'] as const;
export const FIELD_SOURCES = ['manual', 'tmdb', 'wikidata', 'filename', 'container'] as const;
export const LINK_ORIGINS = ['auto', 'manual'] as const;
export const CASE_STATES = ['pending', 'auto_matched', 'needs_review', 'resolved', 'ignored'] as const;
export const CASE_REASONS = [
  'no_title', 'no_candidates', 'low_score', 'ambiguous', 'multi_part',
  'kind_mismatch', 'id_mismatch', 'disc_structure',
] as const;
export const ARTWORK_TYPES = ['poster', 'backdrop', 'logo', 'still', 'thumbnail'] as const;
export const ARTWORK_SOURCES = ['tmdb', 'wikidata', 'upload', 'generated'] as const;
export const JOB_STATES = ['queued', 'running', 'done', 'failed'] as const;

// ---------------------------------------------------------------- media
export const libraryRoot = sqliteTable('library_root', {
  id: id(),
  name: text('name').notNull(),
  mountPath: text('mount_path').notNull(),
  hint: text('hint', { enum: ROOT_HINTS }).notNull(),
  status: text('status', { enum: ROOT_STATUS }).notNull().default('online'),
  lastScanAt: ts('last_scan_at'),
  createdAt: ts('created_at').notNull(),
  /** Unmounted-root guard of the last scan (empty_walk | mass_missing): reachable, but held offline. No CHECK: adding one would rebuild the table. */
  holdReason: text('hold_reason', { enum: ROOT_HOLD_REASONS }),
  /** Files the held scan did not mark missing. */
  heldMissing: integer('held_missing'),
  /** Set by the owner (ConfirmRootContents): the next scan may mark up to this many files missing despite the guard. */
  confirmedMissing: integer('confirmed_missing'),
  /** When the owner confirmed (strictly increasing): a scan clears only the confirmation it saw. */
  confirmedAt: ts('confirmed_at'),
}, (t) => [
  uniqueIndex('library_root_mount_uq').on(t.mountPath),
  check('library_root_hint_ck', inList('hint', ROOT_HINTS)),
  check('library_root_status_ck', inList('status', ROOT_STATUS)),
]);

export const mediaFile = sqliteTable('media_file', {
  id: id(),
  rootId: text('root_id').notNull().references(() => libraryRoot.id, { onDelete: 'cascade' }),
  relPath: text('rel_path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  mtimeMs: ts('mtime_ms').notNull(),
  fingerprint: text('fingerprint'),
  container: text('container'),
  durationMs: integer('duration_ms'),
  bitRate: integer('bit_rate'),
  state: text('state', { enum: FILE_STATES }).notNull().default('discovered'),
  /** Full MediaFacts (doc 03 §8) as produced by the analyzer; streams are also normalised below. */
  facts: text('facts', { mode: 'json' }),
  analyzedAt: ts('analyzed_at'),
  missingSince: ts('missing_since'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [
  uniqueIndex('media_file_root_path_uq').on(t.rootId, t.relPath),
  index('media_file_fingerprint_ix').on(t.fingerprint),
  check('media_file_state_ck', inList('state', FILE_STATES)),
]);

export const mediaStream = sqliteTable('media_stream', {
  id: id(),
  fileId: text('file_id').notNull().references(() => mediaFile.id, { onDelete: 'cascade' }),
  index: integer('stream_index').notNull(),
  type: text('type', { enum: STREAM_TYPES }).notNull(),
  codec: text('codec'),
  profile: text('profile'),
  language: text('language'),
  title: text('title'),
  isDefault: bool('is_default').notNull().default(false),
  isForced: bool('is_forced').notNull().default(false),
  isSdh: bool('is_sdh').notNull().default(false),
  isCommentary: bool('is_commentary').notNull().default(false),
  /** Type-specific attributes (resolution, hdr, channels, lossless, ...) as in MediaFacts. */
  attrs: text('attrs', { mode: 'json' }).notNull(),
}, (t) => [
  uniqueIndex('media_stream_file_idx_uq').on(t.fileId, t.index),
  check('media_stream_type_ck', inList('type', STREAM_TYPES)),
]);

export const chapter = sqliteTable('chapter', {
  fileId: text('file_id').notNull().references(() => mediaFile.id, { onDelete: 'cascade' }),
  index: integer('chapter_index').notNull(),
  title: text('title'),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
}, (t) => [primaryKey({ columns: [t.fileId, t.index] })]);

export const externalSubtitle = sqliteTable('external_subtitle', {
  id: id(),
  fileId: text('file_id').notNull().references(() => mediaFile.id, { onDelete: 'cascade' }),
  relPath: text('rel_path').notNull(),
  language: text('language'),
  isForced: bool('is_forced').notNull().default(false),
  isSdh: bool('is_sdh').notNull().default(false),
  format: text('format').notNull(), // srt | ass | sup
}, (t) => [uniqueIndex('external_subtitle_path_uq').on(t.fileId, t.relPath)]);

// ---------------------------------------------------------------- catalog
export const catalogItem = sqliteTable('catalog_item', {
  id: id(),
  kind: text('kind', { enum: ITEM_KINDS }).notNull(),
  category: text('category', { enum: ITEM_CATEGORIES }),
  parentId: text('parent_id'),
  seasonNumber: integer('season_number'),
  episodeNumber: integer('episode_number'),
  extraType: text('extra_type', { enum: EXTRA_TYPES }),
  editionLabel: text('edition_label'),
  /** Denormalised, resolved values for listing and sorting (recomputed from item_field). */
  title: text('title').notNull(),
  originalTitle: text('original_title'),
  sortTitle: text('sort_title').notNull(),
  year: integer('year'),
  durationMs: integer('duration_ms'),
  addedAt: ts('added_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  /**
   * Stand-in for a file whose identification waits for a provider (doc 02 §3.5): filename values only,
   * no external ids, never enriched; retired once no file and no child is left on it. Children inherit it.
   */
  provisional: bool('provisional').notNull().default(false),
}, (t) => [
  index('catalog_item_parent_ix').on(t.parentId),
  index('catalog_item_kind_sort_ix').on(t.kind, t.sortTitle, t.id),
  index('catalog_item_added_ix').on(t.addedAt, t.id),
  check('catalog_item_kind_ck', inList('kind', ITEM_KINDS)),
]);

/** One value per (item, field, source); resolution manual > tmdb (not expired) > wikidata > filename (ADR 0007). */
export const itemField = sqliteTable('item_field', {
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  field: text('field').notNull(),
  source: text('source', { enum: FIELD_SOURCES }).notNull(),
  value: text('value', { mode: 'json' }).notNull(),
  fetchedAt: ts('fetched_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.itemId, t.field, t.source] }),
  check('item_field_source_ck', inList('source', FIELD_SOURCES)),
]);

/** Locked field (doc 01 §3.5): the chosen source is kept and never overwritten automatically (ADR 0007, M6). */
export const fieldLock = sqliteTable('field_lock', {
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  field: text('field').notNull(),
  source: text('source', { enum: FIELD_SOURCES }).notNull(),
  lockedAt: ts('locked_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.itemId, t.field] }),
  check('field_lock_source_ck', inList('source', FIELD_SOURCES)),
]);

export const externalId = sqliteTable('external_id', {
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // wikidata | tmdb | imdb | tvdb
  externalId: text('external_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.itemId, t.provider] }),
  index('external_id_lookup_ix').on(t.provider, t.externalId),
]);

export const mediaLink = sqliteTable('media_link', {
  id: id(),
  fileId: text('file_id').notNull().references(() => mediaFile.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  origin: text('origin', { enum: LINK_ORIGINS }).notNull(),
  confidence: real('confidence'),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  uniqueIndex('media_link_file_item_uq').on(t.fileId, t.itemId),
  index('media_link_item_ix').on(t.itemId),
  check('media_link_origin_ck', inList('origin', LINK_ORIGINS)),
]);

export const identificationCase = sqliteTable('identification_case', {
  id: id(),
  fileId: text('file_id').notNull().references(() => mediaFile.id, { onDelete: 'cascade' }),
  state: text('state', { enum: CASE_STATES }).notNull(),
  reason: text('reason', { enum: CASE_REASONS }),
  /** Parser output (kind, title, year, season, episodes, warnings...). */
  parsed: text('parsed', { mode: 'json' }),
  /** Scored candidates with evidence. */
  candidates: text('candidates', { mode: 'json' }),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [
  uniqueIndex('identification_case_file_uq').on(t.fileId),
  index('identification_case_state_ix').on(t.state, t.updatedAt),
  index('identification_case_queue_ix').on(t.state, t.createdAt, t.id),
  check('identification_case_state_ck', inList('state', CASE_STATES)),
]);

export const artwork = sqliteTable('artwork', {
  id: id(),
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ARTWORK_TYPES }).notNull(),
  language: text('language'),
  source: text('source', { enum: ARTWORK_SOURCES }).notNull(),
  /** Path relative to the artwork volume. */
  localPath: text('local_path').notNull(),
  remoteRef: text('remote_ref'),
  width: integer('width'),
  height: integer('height'),
  selected: bool('selected').notNull().default(false),
  fetchedAt: ts('fetched_at').notNull(),
}, (t) => [
  index('artwork_item_type_ix').on(t.itemId, t.type),
  check('artwork_type_ck', inList('type', ARTWORK_TYPES)),
]);

export const person = sqliteTable('person', {
  id: id(),
  name: text('name').notNull(),
  source: text('source', { enum: FIELD_SOURCES }).notNull(),
  externalRef: text('external_ref'),
});

export const credit = sqliteTable('credit', {
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  character: text('character'),
  order: integer('sort_order').notNull().default(0),
  source: text('source', { enum: FIELD_SOURCES }).notNull(),
}, (t) => [primaryKey({ columns: [t.itemId, t.personId, t.role] })]);

/** Raw provider responses, per provider, so a purge is a targeted DELETE (ADR 0002/0007). */
export const providerCache = sqliteTable('provider_cache', {
  provider: text('provider').notNull(),
  key: text('cache_key').notNull(),
  response: text('response', { mode: 'json' }).notNull(),
  fetchedAt: ts('fetched_at').notNull(),
}, (t) => [primaryKey({ columns: [t.provider, t.key] })]);

// ---------------------------------------------------------------- profiles
export const profile = sqliteTable('profile', {
  id: id(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  /** { audioLanguages: string[], subtitleLanguages: string[], subtitleMode: 'off'|'forced'|'always' } */
  prefs: text('prefs', { mode: 'json' }).notNull(),
  createdAt: ts('created_at').notNull(),
});

export const playbackProgress = sqliteTable('playback_progress', {
  profileId: text('profile_id').notNull().references(() => profile.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  positionMs: integer('position_ms').notNull(),
  durationMs: integer('duration_ms').notNull(),
  fileId: text('file_id'),
  audioStreamIndex: integer('audio_stream_index'),
  subtitleTrackId: text('subtitle_track_id'),
  clientTs: ts('client_ts').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.profileId, t.itemId] }),
  index('playback_progress_recent_ix').on(t.profileId, t.updatedAt),
]);

export const watchState = sqliteTable('watch_state', {
  profileId: text('profile_id').notNull().references(() => profile.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  watched: bool('watched').notNull(),
  watchedAt: ts('watched_at'),
  playCount: integer('play_count').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.profileId, t.itemId] })]);

export const viewingRecord = sqliteTable('viewing_record', {
  id: id(),
  profileId: text('profile_id').notNull().references(() => profile.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at'),
  maxPositionMs: integer('max_position_ms').notNull().default(0),
  completed: bool('completed').notNull().default(false),
  /** File the viewing played (no FK: history outlives the file). NULL for rows recorded before 0003. */
  fileId: text('file_id'),
}, (t) => [index('viewing_record_profile_ix').on(t.profileId, t.startedAt), index('viewing_record_file_ix').on(t.fileId)]);

export const watchlistEntry = sqliteTable('watchlist_entry', {
  profileId: text('profile_id').notNull().references(() => profile.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => catalogItem.id, { onDelete: 'cascade' }),
  addedAt: ts('added_at').notNull(),
}, (t) => [primaryKey({ columns: [t.profileId, t.itemId] })]);

// ---------------------------------------------------------------- infrastructure
export const job = sqliteTable('job', {
  id: id(),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  priority: integer('priority').notNull().default(100),
  state: text('state', { enum: JOB_STATES }).notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  runAt: ts('run_at').notNull(),
  lastError: text('last_error'),
  idempotencyKey: text('idempotency_key'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [
  uniqueIndex('job_idempotency_uq').on(t.idempotencyKey),
  index('job_claim_ix').on(t.state, t.runAt, t.priority),
  check('job_state_ck', inList('state', JOB_STATES)),
]);

export const domainEvent = sqliteTable('domain_event', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => [index('domain_event_created_ix').on(t.createdAt)]);
