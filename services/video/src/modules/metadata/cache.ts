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

export function createProviderCache(db: Db): ProviderCache {
  const sel = db.$client.prepare('SELECT response, fetched_at AS fetchedAt FROM provider_cache WHERE provider = ? AND cache_key = ?');
  const ins = db.$client.prepare(
    `INSERT INTO provider_cache (provider, cache_key, response, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider, cache_key) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at`,
  );
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
