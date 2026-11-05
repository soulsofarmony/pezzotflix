// Module 'metadata' (doc 02 §3.4, §3.5, §3.7): provider adapters (Wikidata, TMDB) behind the
// MetadataSearchPort, the Enricher (metadata.enrich), the Artwork Store and GetImage, and the
// refresh, expiry and purge of provider data (ADR 0007).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { typed } from '../../app/http.ts';
import type { ModuleContext, ModuleFactory } from '../../app/module.ts';
import { notFound } from '../../app/problem.ts';
import { JOB_TYPES } from '../../shared/job-types.ts';
import type { IdentificationMaintenancePort } from '../../shared/ports.ts';
import { createArtworkStore } from './artwork.ts';
import { createProviderCache } from './cache.ts';
import { ARTWORK_JOB, createEnricher, ENRICH_MAX_ATTEMPTS } from './enricher.ts';
import { createHostGate, type FetchFn, type HttpDeps } from './http.ts';
import { type Clock, realClock } from './limiter.ts';
import { createMaintenance, EXPIRE_JOB, PURGE_JOB, WIKIDATA_REFRESH_MS } from './maintenance.ts';
import { createRegistry } from './registry.ts';
import { createTmdb, type TmdbAdapter } from './tmdb.ts';
import { DAY_MS, type ProviderAdapter } from './types.ts';
import { createWikidata } from './wikidata.ts';

export const SERVICE_VERSION = '0.1';
export const WIKIMEDIA_HOSTS = /^(?:[a-z0-9-]+\.)*wikimedia\.org$/;
const FINGERPRINT_KEY = 'providers';

export interface MetadataModuleOptions {
  /** Tests pass a fake; production uses the global fetch (undici, keep-alive per host). */
  fetch?: FetchFn;
  /** Clock of the rate limiters; defaults to real timers with the module's now(). */
  clock?: Clock;
}

/** User-Agent of the Wikimedia policy: name/version (contact). */
export const userAgentOf = (contact: string): string => (contact.trim() ? `Pezzotflix/${SERVICE_VERSION} (${contact.trim()})` : `Pezzotflix/${SERVICE_VERSION}`);

export function metadataModule(options: MetadataModuleOptions = {}): ModuleFactory {
  return function createMetadataModule(ctx: ModuleContext) {
    const { config, db, log, ports, now } = ctx;
    const clock: Clock = options.clock ?? { ...realClock, now };
    const token = config.TMDB_PURGE ? undefined : config.TMDB_READ_TOKEN?.trim() || undefined;
    const http: HttpDeps = {
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      clock,
      log,
      userAgent: userAgentOf(config.WIKIDATA_CONTACT),
      // Raw and trimmed: either form could end up in a message.
      secrets: config.TMDB_READ_TOKEN ? [...new Set([config.TMDB_READ_TOKEN, config.TMDB_READ_TOKEN.trim()])] : [],
    };
    // Without a contact Wikimedia allows 10 requests per minute (ADR 0007 point 7).
    const wdRate = config.WIKIDATA_CONTACT.trim() ? 1 : 10 / 60;
    const cache = createProviderCache(db);
    const adapters: { wikidata?: ProviderAdapter; tmdb?: TmdbAdapter } = {};
    if (config.WIKIDATA_ENABLED) {
      adapters.wikidata = createWikidata({
        api: createHostGate({ name: 'wikidata', ratePerSec: wdRate, burst: 1, concurrency: 1, timeoutMs: 30_000 }, http),
        wdqs: createHostGate({ name: 'wdqs', ratePerSec: Math.min(1, wdRate), burst: 1, concurrency: 1, timeoutMs: 60_000 }, http),
        // Special:FilePath redirects to upload.wikimedia.org: redirects stay on Wikimedia hosts.
        commons: createHostGate({ name: 'commons', ratePerSec: wdRate, burst: 1, concurrency: 1, timeoutMs: 30_000, redirectHosts: WIKIMEDIA_HOSTS }, http),
        cache,
        now,
        enabled: true,
      });
    }
    if (token) {
      adapters.tmdb = createTmdb({
        api: createHostGate({ name: 'tmdb', ratePerSec: 20, burst: 4, concurrency: 4, timeoutMs: 10_000 }, http),
        images: createHostGate({ name: 'tmdb-images', ratePerSec: 10, burst: 2, concurrency: 4, timeoutMs: 30_000 }, http),
        cache,
        now,
        token,
      });
    }
    const registry = createRegistry(adapters);
    const store = createArtworkStore({ artworkDir: config.artworkDir, cacheDir: config.cacheDir, log, now });
    let providersChanged = false;
    const tmdbRefreshAfterMs = config.TMDB_REFRESH_AFTER_DAYS * DAY_MS;
    const enricher = createEnricher({
      catalog: () => ports.catalogWrite,
      jobs: () => ports.jobs,
      registry,
      store,
      now,
      lang: config.METADATA_LANGUAGE,
      imageRefreshMs: { tmdb: tmdbRefreshAfterMs, wikidata: WIKIDATA_REFRESH_MS },
    });
    const maintenance = createMaintenance({
      db,
      catalog: () => ports.catalogWrite,
      identification: (): IdentificationMaintenancePort | null => {
        try {
          return ports.identificationMaintenance;
        } catch {
          return null;
        }
      },
      jobs: () => ports.jobs,
      cache,
      store,
      registry,
      now,
      log,
      tmdbRefreshAfterMs,
      tmdbMaxAgeMs: config.TMDB_MAX_AGE_DAYS * DAY_MS,
      startedAt: now(),
      providersChanged: () => providersChanged,
    });

    /** ADR 0007 point 9: the set of usable providers, compared with the previous start. */
    function checkFingerprint(): void {
      const current = registry
        .status()
        .filter((p) => p.state === 'ok' || p.state === 'degraded')
        .map((p) => p.provider)
        .join(',');
      const previous = cache.get<string>('registry', FINGERPRINT_KEY, Number.MAX_SAFE_INTEGER, now())?.value ?? null;
      providersChanged = previous !== current;
      if (providersChanged) cache.put('registry', FINGERPRINT_KEY, current, now());
      if (providersChanged && previous !== null) log.info({ previous, current }, 'metadata providers changed: works without values of a new provider are enriched again');
    }

    async function getImage(req: FastifyRequest, reply: FastifyReply) {
      const { params, query } = typed<'getImage'>(req);
      const record = ports.catalogWrite.findArtworkByKey(params.imageKey);
      const image = record ? await store.serve(record, query.w) : null;
      if (!image) {
        // The row is there but its file is gone: the next enrichment downloads it again.
        if (record) ports.catalogWrite.markImageMissing(params.imageKey);
        throw notFound('image');
      }
      return reply.type(image.contentType).header('cache-control', image.cacheControl).header('x-content-type-options', 'nosniff').send(image.bytes);
    }

    return {
      name: 'metadata',
      provides: { metadataSearch: registry },
      handlers: { getImage },
      jobs: {
        [JOB_TYPES.metadataEnrich]: { concurrency: 1, maxAttempts: ENRICH_MAX_ATTEMPTS, handler: enricher.enrich },
        [ARTWORK_JOB]: { concurrency: 2, maxAttempts: ENRICH_MAX_ATTEMPTS, handler: enricher.artwork },
        [EXPIRE_JOB]: { concurrency: 1, handler: () => maintenance.expire() },
        [PURGE_JOB]: { concurrency: 1, handler: () => maintenance.purge() },
      },
      periodic: [
        { name: 'metadata.refresh_sweep', everyMs: DAY_MS, runAtStart: true, run: () => void maintenance.sweep() },
        { name: 'metadata.expire', everyMs: DAY_MS, runAtStart: true, run: () => void ports.jobs.enqueue({ type: EXPIRE_JOB, payload: {}, idempotencyKey: 'expire:tmdb' }) },
      ],
      async start() {
        if (!config.WIKIDATA_CONTACT.trim()) log.warn('WIKIDATA_CONTACT is empty: Wikidata is limited to 10 requests per minute');
        if (config.TMDB_PURGE) {
          log.warn('TMDB_PURGE is set: TMDB is disabled and every TMDB value will be purged');
          ports.jobs.enqueue({ type: PURGE_JOB, payload: {}, idempotencyKey: 'purge:tmdb' });
        }
        if (adapters.tmdb) {
          const state = await adapters.tmdb.validate().catch(() => adapters.tmdb?.state());
          if (state === 'invalid_credentials') log.error('TMDB_READ_TOKEN was refused by TMDB: TMDB is not used');
        }
        await store.cleanTemp().catch((err: unknown) => log.warn({ err: (err as Error)?.message }, 'artwork temp cleanup failed'));
        checkFingerprint();
        log.info({ providers: registry.status().map((p) => ({ provider: p.provider, state: p.state })) }, 'metadata providers');
      },
    };
  };
}

export const createMetadataModule: ModuleFactory = metadataModule();
