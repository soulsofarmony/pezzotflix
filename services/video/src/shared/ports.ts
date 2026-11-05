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

export type ApiSchemas = components['schemas'];
export type ItemSummary = ApiSchemas['ItemSummary'];
export type ProfileItemState = ApiSchemas['ProfileItemState'];
export type ProfilePrefs = ApiSchemas['ProfilePrefs'];
export type ClientCapabilities = ApiSchemas['ClientCapabilities'];

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
  /** Ids of episodes of a series/season (for watched propagation), in order. */
  listPlayableDescendants(itemId: string): string[];
  itemExists(itemId: string): boolean;
}

/** Implemented by modules/profiles. Used by catalog to compose Home and summaries. */
export interface ProfileStatePort {
  getStates(profileId: string, itemIds: readonly string[]): Map<string, ProfileItemState>;
  /** Items in progress (not watched, 0 < progress < 90%), most recent first. */
  continueWatching(profileId: string, limit: number): string[];
  /** Episode id to watch next in a series, or null. */
  nextUp(profileId: string, seriesId: string): string | null;
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

/** Values of one source. A key left out is not touched; null removes that source's value. */
export interface ItemFieldValues {
  title?: string | null;
  originalTitle?: string | null;
  year?: number | null;
  category?: ItemCategory | null;
  durationMs?: number | null;
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
}
