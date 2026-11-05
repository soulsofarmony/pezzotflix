// The neutral adapter contract inside modules/metadata (doc 03 §8 MetadataProvider, ADR 0007
// point 1). Only the registry's MetadataSearchPort leaves the module; these types stay inside, and
// nothing provider-specific crosses them.
import type { ExternalIdLookup, ExternalIds, MetadataCandidate, MetadataProviderName, MetadataSearchRequest, ProviderResult, ProviderState, WorkKind } from '../../shared/metadata.ts';
import type { ArtworkType, CreditInput, ItemFieldValues } from '../../shared/ports.ts';
import type { ProviderCache } from './cache.ts';
import type { HttpOutcome } from './http.ts';

/** An image a provider offers: TMDB file_path or Commons file name, with its language. */
export interface ImageRef {
  type: ArtworkType;
  ref: string;
  language: string | null;
  /** Size of the original, when the provider says it. */
  width: number | null;
  height: number | null;
}

/** One downloaded file of an image. TMDB gives several CDN sizes; other providers one original. */
export interface DownloadedFile {
  bytes: Buffer;
  contentType: string;
  /** 'w342'… for TMDB sizes, 'original' otherwise. */
  size: string;
  width: number | null;
  height: number | null;
}

export interface WorkDetails {
  provider: MetadataProviderName;
  id: string;
  kind: WorkKind;
  /** When the provider data was fetched (from the cache row): values never outlive it. */
  fetchedAt: number;
  candidate: MetadataCandidate;
  /** Every field this provider is responsible for; null clears an old value. */
  fields: ItemFieldValues;
  /**
   * Ids of other namespaces the provider suggests (TMDB external_ids). For lookups only, never
   * stored: an id is stored when Wikidata or the filename confirms it (ADR 0007 point 3).
   */
  hints?: ExternalIds;
  credits: CreditInput[];
  /** Best image per type, in download order (poster and backdrop first). */
  images: ImageRef[];
}

export interface EpisodeDetails {
  episode: number;
  fields: ItemFieldValues;
  still: ImageRef | null;
}

export interface SeasonDetails {
  season: number;
  fetchedAt: number;
  fields: ItemFieldValues;
  poster: ImageRef | null;
  episodes: EpisodeDetails[];
}

export interface ProviderTerms {
  /** durable (CC0) or a maximum age in days (TMDB §1.C). */
  retention: 'durable' | { maxAgeDays: number };
  attribution: string;
  purgeOnTermination: boolean;
  /** TTL of the raw responses in provider_cache. */
  cacheTtlMs: number;
}

export interface ProviderAdapter {
  readonly name: MetadataProviderName;
  state(): ProviderState;
  terms(): ProviderTerms;
  search(req: MetadataSearchRequest): Promise<ProviderResult<MetadataCandidate[]>>;
  lookupByExternalId(lookup: ExternalIdLookup): Promise<ProviderResult<MetadataCandidate>>;
  details(kind: WorkKind, id: string, lang: string): Promise<ProviderResult<WorkDetails>>;
  /** Seasons of a series that the provider knows, among the numbers asked. */
  seasons(seriesId: string, numbers: readonly number[], lang: string): Promise<ProviderResult<SeasonDetails[]>>;
  fetchImage(image: ImageRef): Promise<ProviderResult<DownloadedFile[]>>;
}

export const DAY_MS = 24 * 3600_000;

/** Base language of a BCP 47 tag: it-IT → it. */
export const langBase = (lang: string): string => (lang.split('-')[0] ?? lang).toLowerCase();

/** HTTP outcome → typed provider result (401 is the adapter's to interpret first). */
export function toResult<T>(o: Exclude<HttpOutcome<unknown>, { kind: 'ok' }>): ProviderResult<T> {
  if (o.kind === 'not_found') return { status: 'not_found' };
  if (o.kind === 'rate_limited') return { status: 'rate_limited', retryAfterMs: o.retryAfterMs };
  if (o.kind === 'invalid_request') return { status: 'invalid_request', detail: o.detail };
  if (o.kind === 'unauthorized') return { status: 'unavailable', detail: 'invalid credentials' };
  return { status: 'unavailable', detail: o.detail };
}

/** A not_found is cached for at most a day: someone may add the missing id upstream. */
export const NEGATIVE_TTL_MS = DAY_MS;

/**
 * Cached provider call: a fresh row answers without the network; otherwise `load` runs and a
 * success (or a not_found) is stored with its fetch time. Returns the value with that time.
 */
export async function cached<T>(
  cache: ProviderCache,
  provider: MetadataProviderName,
  key: string,
  ttlMs: number,
  now: () => number,
  load: () => Promise<ProviderResult<T>>,
): Promise<ProviderResult<{ value: T; fetchedAt: number }>> {
  const hit = cache.get<{ nf: true } | { v: T }>(provider, key, ttlMs, now());
  if (hit) {
    if ('nf' in hit.value) {
      if (now() - hit.fetchedAt <= NEGATIVE_TTL_MS) return { status: 'not_found' };
    } else {
      return { status: 'ok', value: { value: hit.value.v, fetchedAt: hit.fetchedAt } };
    }
  }
  const r = await load();
  const t = now();
  if (r.status === 'ok') {
    cache.put(provider, key, { v: r.value }, t);
    return { status: 'ok', value: { value: r.value, fetchedAt: t } };
  }
  if (r.status === 'not_found') cache.put(provider, key, { nf: true }, t);
  return r;
}
