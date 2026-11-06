// Provider response cache in provider_cache (ADR 0002, ADR 0007 point 2): one row per (provider,
// key), so expiry and purge are targeted DELETEs. Adapters store the trimmed part of a response they
// read, never request headers; keys are built from ids and queries, never from secrets.
import type { Db } from '../../db/index.ts';
import type { MetadataProviderName } from '../../shared/metadata.ts';

export interface CacheHit<T> {
  value: T;
  fetchedAt: number;
}

/** 'registry' holds the module's own small state (the provider fingerprint); it never expires. */
export type CacheOwner = MetadataProviderName | 'registry';

export interface ProviderCache {
  get<T>(provider: CacheOwner, key: string, ttlMs: number, now: number): CacheHit<T> | null;
  put(provider: CacheOwner, key: string, value: unknown, fetchedAt: number): void;
  /** Rows of the provider fetched before the cutoff; returns how many were deleted. */
  deleteOlderThan(provider: MetadataProviderName, cutoff: number): number;
  deleteProvider(provider: MetadataProviderName): number;
}

/**
 * Keys of free-text searches (identification and the admin's own searches): unlike ids, their number
 * has no bound, so each prefix keeps only its newest rows per provider. A search evicted early costs
 * one more provider call; works, seasons and lookups are never evicted this way.
 */
const SEARCH_KEY_PREFIXES = ['search:', 'label:'] as const;
export const SEARCH_ROWS_MAX = 5000;

/** [prefix, the first string after every key with that prefix): a range the primary key index serves. */
const prefixRange = (prefix: string): [string, string] => [prefix, prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)];

export function createProviderCache(db: Db, opts: { searchRowsMax?: number } = {}): ProviderCache {
  const searchRowsMax = opts.searchRowsMax ?? SEARCH_ROWS_MAX;
  // Trimmed in batches: once a range holds a tenth more than its bound, back to the bound.
  const searchRowsSlack = Math.max(1, Math.ceil(searchRowsMax / 10));
  const sel = db.$client.prepare('SELECT response, fetched_at AS fetchedAt FROM provider_cache WHERE provider = ? AND cache_key = ?');
  const upsert = db.$client.prepare(
    `INSERT INTO provider_cache (provider, cache_key, response, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider, cache_key) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at`,
  );
  // A search stored again gets a new rowid, so rowid order is fetch order: the trim never reads the
  // rows themselves (responses run to tens of KB), only the primary key index.
  const replace = db.$client.prepare('INSERT OR REPLACE INTO provider_cache (provider, cache_key, response, fetched_at) VALUES (?, ?, ?, ?)');
  const countRange = db.$client.prepare('SELECT count(*) FROM provider_cache WHERE provider = ? AND cache_key >= ? AND cache_key < ?').pluck();
  const trimOldest = db.$client.prepare(
    `DELETE FROM provider_cache WHERE rowid IN
       (SELECT rowid FROM provider_cache WHERE provider = ? AND cache_key >= ? AND cache_key < ? ORDER BY rowid LIMIT ?)`,
  );
  const ins = {
    run(provider: CacheOwner, key: string, response: string, fetchedAt: number): void {
      const prefix = SEARCH_KEY_PREFIXES.find((p) => key.startsWith(p));
      if (!prefix) return void upsert.run(provider, key, response, fetchedAt);
      replace.run(provider, key, response, fetchedAt);
      const [lo, hi] = prefixRange(prefix);
      const n = countRange.get(provider, lo, hi) as number;
      if (n > searchRowsMax + searchRowsSlack) trimOldest.run(provider, lo, hi, n - searchRowsMax);
    },
  };
  const delOld = db.$client.prepare('DELETE FROM provider_cache WHERE provider = ? AND fetched_at < ?');
  const delAll = db.$client.prepare('DELETE FROM provider_cache WHERE provider = ?');
  return {
    get<T>(provider: CacheOwner, key: string, ttlMs: number, now: number): CacheHit<T> | null {
      const row = sel.get(provider, key) as { response: string; fetchedAt: number } | undefined;
      if (!row || now - row.fetchedAt > ttlMs) return null;
      try {
        return { value: JSON.parse(row.response) as T, fetchedAt: row.fetchedAt };
      } catch {
        return null;
      }
    },
    put: (provider, key, value, fetchedAt) => void ins.run(provider, key, JSON.stringify(value), fetchedAt),
    deleteOlderThan: (provider, cutoff) => delOld.run(provider, cutoff).changes,
    deleteProvider: (provider) => delAll.run(provider).changes,
  };
}
