// Refresh, expiry and purge of provider data (ADR 0007 point 5).
// - Refresh sweep (daily and at start): works never enriched, with TMDB data due for refresh
//   (TMDB_REFRESH_AFTER_DAYS plus a per-item jitter) or Wikidata values older than 180 days, and,
//   when the set of active providers changed at this start (the fingerprint) and TMDB is active,
//   works without TMDB values: the backfill when the token appears (ADR 0007 point 9).
// - ExpireProviderValues (daily job): TMDB values, credits and artwork past TMDB_MAX_AGE_DAYS less a
//   2-day margin, the TMDB candidates of identification cases and the stale provider_cache rows.
// - PurgeProviderData(tmdb) (job, at start with TMDB_PURGE): every TMDB value, credit, artwork file,
//   cache row and case candidate. Idempotent. TMDB numeric ids in external_id stay (point 3).
// Both also delete artwork directories no row references (left by a crash before the file removal).
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.ts';
import { JOB_TYPES, type MetadataEnrichPayload } from '../../shared/job-types.ts';
import type { CatalogWritePort, IdentificationMaintenancePort, JobQueuePort, SourceRemoval } from '../../shared/ports.ts';
import type { ArtworkStore } from './artwork.ts';
import type { ProviderCache } from './cache.ts';
import type { Registry } from './registry.ts';
import { DAY_MS } from './types.ts';
import { WIKIDATA_CACHE_TTL_MS } from './wikidata.ts';
import { TMDB_CACHE_TTL_MS } from './tmdb.ts';

export const EXPIRE_JOB = 'metadata.expire';
export const PURGE_JOB = 'metadata.purge';
/** Wikidata values are refreshed every 180 days (ADR 0007 point 5). */
export const WIKIDATA_REFRESH_MS = 180 * DAY_MS;
/** Spread of the refresh dates, so a library ingested in one night is not refreshed in one night. */
export const REFRESH_JITTER_MS = 10 * DAY_MS;
/** Refreshes queue behind new items. */
export const REFRESH_PRIORITY = 150;
/**
 * Expiry runs this much before TMDB_MAX_AGE_DAYS: the identifier stamps its TMDB values with the
 * time of its own write, which can be up to a day after the cached response it used.
 */
export const EXPIRY_MARGIN_MS = 2 * DAY_MS;

/** Deterministic jitter in [0, span) for an item id. */
export function jitterOf(itemId: string, span: number): number {
  return (createHash('sha1').update(itemId).digest().readUInt32BE(0) / 2 ** 32) * span;
}

export interface MaintenanceDeps {
  db: Db;
  catalog: () => CatalogWritePort;
  identification: () => IdentificationMaintenancePort | null;
  jobs: () => JobQueuePort;
  cache: ProviderCache;
  store: ArtworkStore;
  registry: Registry;
  now: () => number;
  log: FastifyBaseLogger;
  tmdbRefreshAfterMs: number;
  tmdbMaxAgeMs: number;
  /** Time of this start: works without TMDB values enriched before it may be tried again. */
  startedAt: number;
  /** True when the active providers differ from the previous start (ADR 0007 point 9). */
  providersChanged: () => boolean;
}

export function createMaintenance(deps: MaintenanceDeps) {
  const { db, cache, store, registry, now, log } = deps;
  const enrichJobs = db.$client.prepare("SELECT idempotency_key AS key, state, updated_at AS updatedAt FROM job WHERE type = 'metadata.enrich'");

  /** Enqueues the enrichments due; returns how many were queued. */
  function sweep(): number {
    const tmdb = registry.active('tmdb') !== null;
    const wikidata = registry.active('wikidata') !== null;
    if (!tmdb && !wikidata) return 0;
    const jobs = new Map((enrichJobs.all() as { key: string; state: string; updatedAt: number }[]).map((j) => [j.key, j]));
    const t = now();
    let n = 0;
    for (const w of deps.catalog().listWorkRefreshState()) {
      const job = jobs.get(`enrich:${w.itemId}`);
      if (job && (job.state === 'queued' || job.state === 'running')) continue;
      const jitter = jitterOf(w.itemId, REFRESH_JITTER_MS);
      const due =
        !job ||
        job.state === 'failed' ||
        (tmdb && w.tmdbFetchedAt !== null && t - w.tmdbFetchedAt > deps.tmdbRefreshAfterMs + jitter) ||
        (tmdb && w.tmdbFetchedAt === null && deps.providersChanged() && job.updatedAt < deps.startedAt) ||
        (wikidata && w.wikidataFetchedAt !== null && t - w.wikidataFetchedAt > WIKIDATA_REFRESH_MS + jitter);
      if (!due) continue;
      const payload: MetadataEnrichPayload = { itemId: w.itemId };
      if (deps.jobs().enqueue({ type: JOB_TYPES.metadataEnrich, payload, priority: REFRESH_PRIORITY, idempotencyKey: `enrich:${w.itemId}` })) n++;
    }
    if (n) log.info({ queued: n }, 'metadata refresh queued');
    return n;
  }

  function dropCandidates(updatedBefore: number | null): number {
    const port = deps.identification();
    return port ? port.dropProviderCandidates('tmdb', updatedBefore) : 0;
  }

  /** Rows out and files removed in one critical section; then the orphans of earlier crashes. */
  const removeAndCollect = (drop: () => SourceRemoval): Promise<{ removed: SourceRemoval; orphans: number }> =>
    store.exclusive(async () => {
      const removed = drop();
      await store.remove(removed.unreferencedPaths);
      const orphans = await store.collectOrphans((key) => deps.catalog().findArtworkByKey(key) !== null);
      return { removed, orphans };
    });

  async function expire(): Promise<void> {
    const t = now();
    const cutoff = t - Math.max(DAY_MS, deps.tmdbMaxAgeMs - EXPIRY_MARGIN_MS);
    const { removed, orphans } = await removeAndCollect(() => deps.catalog().expireSource('tmdb', cutoff));
    const cases = dropCandidates(cutoff);
    const rows = cache.deleteOlderThan('tmdb', t - TMDB_CACHE_TTL_MS) + cache.deleteOlderThan('wikidata', t - WIKIDATA_CACHE_TTL_MS);
    if (removed.itemIds.length || cases || rows || orphans) log.info({ items: removed.itemIds.length, files: removed.unreferencedPaths.length, orphans, cases, cacheRows: rows }, 'expired provider data removed');
  }

  async function purge(): Promise<void> {
    const { removed, orphans } = await removeAndCollect(() => deps.catalog().purgeSource('tmdb'));
    const cases = dropCandidates(null);
    const rows = cache.deleteProvider('tmdb');
    log.warn({ items: removed.itemIds.length, files: removed.unreferencedPaths.length, orphans, cases, cacheRows: rows }, 'TMDB data purged');
  }

  return { sweep, expire, purge };
}
