// Neutral metadata types (doc 03 §8 MetadataProvider, ADR 0007 point 1): what crosses the boundary
// between modules/metadata (provider adapters), modules/identifier and modules/catalog.
// Plain serializable data; no provider type ever leaves an adapter.

/** Providers known to the Video Service, in identification order (ADR 0007: Wikidata first). */
export const METADATA_PROVIDERS = ['wikidata', 'tmdb'] as const;
export type MetadataProviderName = (typeof METADATA_PROVIDERS)[number];

/** Kind of a top-level work as providers know it. Seasons and episodes hang below a series. */
export type WorkKind = 'movie' | 'series';

/** Namespaces of an external id lookup. TMDB movies and TV shows are separate namespaces. */
export type ExternalNamespace = 'wikidata' | 'tmdb_movie' | 'tmdb_tv' | 'imdb' | 'tvdb';

/**
 * External ids of a work, as stored in external_id (provider = key). The TMDB id has no namespace
 * here: it is the movie id for a movie and the TV id for a series.
 */
export interface ExternalIds {
  wikidata?: string;
  tmdb?: string;
  imdb?: string;
  tvdb?: string;
}

export const EXTERNAL_ID_KEYS = ['wikidata', 'tmdb', 'imdb', 'tvdb'] as const satisfies readonly (keyof ExternalIds)[];

export type ProviderState = 'not_configured' | 'ok' | 'degraded' | 'invalid_credentials';

export interface ProviderStatus {
  provider: MetadataProviderName;
  state: ProviderState;
}

export interface CandidateRef {
  provider: MetadataProviderName;
  /** Provider id: a QID for Wikidata, the numeric id for TMDB (namespace given by kind). */
  id: string;
  kind: WorkKind;
}

export interface CandidateTitles {
  /** Title in the requested language (it-IT), if the provider has one. */
  localized: string | null;
  /** English title, if the provider has one (Wikidata label). */
  english: string | null;
  /** Original title(s) (Wikidata P1476, TMDB original_title). */
  original: string[];
  /** Aliases and alternative titles (Wikidata altLabel, TMDB alternative_titles). */
  aliases: string[];
}

/** One candidate work returned by a provider. */
export interface MetadataCandidate {
  ref: CandidateRef;
  titles: CandidateTitles;
  /** Release years, ascending (Wikidata may list several P577 dates). Empty if unknown. */
  years: number[];
  /** Category hint: true if the provider says it is a documentary, null if it does not say. */
  documentary: boolean | null;
  externalIds: ExternalIds;
  /** TMDB vote_count; null for providers without votes. */
  voteCount: number | null;
}

/** Typed result of a provider call (ADR 0007 point 1). */
export type ProviderResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'unavailable'; detail?: string }
  | { status: 'invalid_request'; detail: string };

export interface MetadataSearchRequest {
  query: string;
  /**
   * Expected kind, a hint only: providers may also return works of the other kind, so the
   * identifier can tell a file in the wrong folder (kind_mismatch, library standard §2).
   */
  kind: WorkKind | null;
  year: number | null;
  /** BCP 47, e.g. it-IT (config METADATA_LANGUAGE). */
  lang: string;
}

export interface ExternalIdLookup {
  ns: ExternalNamespace;
  id: string;
  lang: string;
}
