// Test doubles for identification: synthetic candidates and an in-memory MetadataSearchPort.
// No TMDB response is recorded anywhere (ADR 0007 point 10): TMDB-like candidates are invented,
// Wikidata-like ones may reuse CC0 data.
import type {
  ExternalIdLookup,
  ExternalIds,
  MetadataCandidate,
  MetadataProviderName,
  MetadataSearchRequest,
  ProviderResult,
  ProviderState,
  WorkKind,
} from '../../src/shared/metadata.ts';
import type { MetadataSearchPort } from '../../src/shared/ports.ts';

export interface CandidateSpec {
  provider?: MetadataProviderName;
  id: string;
  kind?: WorkKind;
  title: string;
  english?: string | null;
  original?: string[];
  aliases?: string[];
  years?: number[];
  documentary?: boolean | null;
  ids?: ExternalIds;
  votes?: number | null;
}

export function cand(s: CandidateSpec): MetadataCandidate {
  const provider = s.provider ?? 'wikidata';
  return {
    ref: { provider, id: s.id, kind: s.kind ?? 'movie' },
    titles: { localized: s.title, english: s.english ?? null, original: s.original ?? [], aliases: s.aliases ?? [] },
    years: s.years ?? [],
    documentary: s.documentary ?? null,
    externalIds: { ...(provider === 'wikidata' ? { wikidata: s.id } : { tmdb: s.id }), ...s.ids },
    voteCount: s.votes ?? (provider === 'tmdb' ? 0 : null),
  };
}

type Result<T> = ProviderResult<T>;

export interface FakeProvider {
  state?: ProviderState;
  /** Candidates for a query (normalised to lower case), or a failure. */
  search?: (req: MetadataSearchRequest) => Result<MetadataCandidate[]>;
  lookup?: (l: ExternalIdLookup) => Result<MetadataCandidate>;
}

export interface Call {
  op: 'search' | 'lookup';
  provider: MetadataProviderName;
  arg: MetadataSearchRequest | ExternalIdLookup;
}

/** A port answering from tables. Unknown queries return an empty list, unknown ids not_found. */
export function fakeMetadata(providers: Partial<Record<MetadataProviderName, FakeProvider>>): MetadataSearchPort & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    status: () =>
      (['wikidata', 'tmdb'] as const).map((p) => ({ provider: p, state: providers[p] ? (providers[p].state ?? 'ok') : 'not_configured' })),
    async search(provider, req) {
      calls.push({ op: 'search', provider, arg: req });
      return providers[provider]?.search?.(req) ?? { status: 'ok', value: [] };
    },
    async lookupByExternalId(provider, lookup) {
      calls.push({ op: 'lookup', provider, arg: lookup });
      return providers[provider]?.lookup?.(lookup) ?? { status: 'not_found' };
    },
  };
}

/** search() from a title → candidates table (keys compared case-insensitively). */
export const byTitle =
  (table: Record<string, MetadataCandidate[]>) =>
  (req: MetadataSearchRequest): Result<MetadataCandidate[]> => {
    const hit = Object.entries(table).find(([k]) => k.toLowerCase() === req.query.toLowerCase());
    return { status: 'ok', value: hit?.[1] ?? [] };
  };

/** lookupByExternalId() over a list of candidates, by namespace. */
export const byExternalId =
  (all: MetadataCandidate[]) =>
  (l: ExternalIdLookup): Result<MetadataCandidate> => {
    const hit = all.find((c) => {
      if (l.ns === 'wikidata') return c.externalIds.wikidata === l.id;
      if (l.ns === 'tmdb_movie') return c.ref.kind === 'movie' && c.externalIds.tmdb === l.id;
      if (l.ns === 'tmdb_tv') return c.ref.kind === 'series' && c.externalIds.tmdb === l.id;
      if (l.ns === 'imdb') return c.externalIds.imdb === l.id;
      return c.externalIds.tvdb === l.id;
    });
    return hit ? { status: 'ok', value: hit } : { status: 'not_found' };
  };
