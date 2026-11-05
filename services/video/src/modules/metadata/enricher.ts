// Metadata Enricher (doc 02 §3.5, ADR 0007): the metadata.enrich job. Fetches a work from Wikidata
// (durable CC0 facts) and, when configured, TMDB (Italian title, overview, images), then writes the
// values per source through CatalogWritePort: resolution, locks and the projection stay in the
// catalog. Series get their seasons and episodes too; extras keep their file-derived values.
// Offline-first: a provider that does not answer leaves the item as it is (filename values at
// worst) and the job is retried; nothing is deleted on a failure.
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { JobContext } from '../../app/module.ts';
import type { MetadataEnrichPayload } from '../../shared/job-types.ts';
import type { ExternalIdLookup, ExternalIds, MetadataProviderName, ProviderResult, WorkKind } from '../../shared/metadata.ts';
import type { ArtworkType, CatalogItemRef, CatalogWritePort, JobQueuePort, SourcedFieldValues } from '../../shared/ports.ts';
import type { ArtworkStore } from './artwork.ts';
import type { Registry } from './registry.ts';
import type { ImageRef, ProviderAdapter, SeasonDetails, WorkDetails } from './types.ts';

export const EnrichPayload: z.ZodType<MetadataEnrichPayload> = z.object({ itemId: z.string().min(1) });

/** Low-priority artwork of a work (logo, season posters, episode stills), after the Home images. */
export const ARTWORK_JOB = 'metadata.artwork';
export const ARTWORK_PRIORITY = 200;
/** Max attempts for real failures; rate limits are deferred without counting (jobs runner). */
export const ENRICH_MAX_ATTEMPTS = 20;
/** Seasons or episodes added while a series was enriched: the job runs again after this. */
export const CHILDREN_CHANGED_DELAY_MS = 60_000;

/** Thrown to retry later through job.run_at; retryAfterMs null = the runner's backoff. */
export class RetryLaterError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'RetryLaterError';
    this.retryAfterMs = retryAfterMs;
  }
}

type Failed = Extract<ProviderResult<unknown>, { status: 'rate_limited' | 'unavailable' }>;

/** Provider failures of one run: the job is retried after writing what did arrive. */
class Failures {
  private readonly list: string[] = [];
  private retryAfter: number | null = null;
  private unavailable = false;
  private readonly log: FastifyBaseLogger;
  constructor(log: FastifyBaseLogger) {
    this.log = log;
  }
  /** Returns true when the result is a failure to retry (it is recorded). */
  check(provider: MetadataProviderName, what: string, r: ProviderResult<unknown>): r is Failed {
    if (r.status === 'rate_limited') {
      this.retryAfter = Math.max(this.retryAfter ?? 0, r.retryAfterMs);
      this.list.push(`${provider} ${what}: rate limited`);
      return true;
    }
    if (r.status === 'unavailable') {
      this.unavailable = true;
      this.list.push(`${provider} ${what}: ${r.detail ?? 'unavailable'}`);
      return true;
    }
    if (r.status === 'invalid_request') this.log.warn({ provider, what, detail: r.detail }, 'provider rejected the request');
    return false;
  }
  throwIfAny(): void {
    if (!this.list.length) return;
    throw new RetryLaterError(this.list.join('; '), this.unavailable ? null : this.retryAfter);
  }
}

export interface EnricherDeps {
  catalog: () => CatalogWritePort;
  jobs: () => JobQueuePort;
  registry: Registry;
  store: ArtworkStore;
  now: () => number;
  lang: string;
  /** Downloaded images younger than this are not fetched again (TMDB: the refresh window). */
  imageRefreshMs: Record<'tmdb' | 'wikidata', number>;
}

interface Found {
  wikidata: WorkDetails | null;
  tmdb: WorkDetails | null;
}

const SOURCES = ['wikidata', 'tmdb'] as const;

export function createEnricher(deps: EnricherDeps) {
  const { registry, store, now, lang } = deps;
  const catalog = () => deps.catalog();

  /** The work an item belongs to (a season or an episode enriches its series), or null for extras. */
  function workOf(itemId: string): CatalogItemRef | null {
    const cat = catalog();
    const ref = cat.getItem(itemId);
    if (!ref || ref.kind === 'extra') return null;
    if (ref.kind === 'movie' || ref.kind === 'series') return ref;
    const series = cat.findAncestor(itemId, 'series');
    return series ? cat.getItem(series) : null;
  }

  async function firstMatch(adapter: ProviderAdapter, kind: WorkKind, lookups: [ExternalIdLookup['ns'], string | undefined][], failures: Failures): Promise<string | null> {
    for (const [ns, id] of lookups) {
      if (!id) continue;
      const r = await adapter.lookupByExternalId({ ns, id, lang });
      if (r.status === 'ok' && r.value.ref.kind === kind) return r.value.ref.id;
      if (failures.check(adapter.name, `lookup ${ns}`, r)) return null;
    }
    return null;
  }

  async function fetchWork(work: CatalogItemRef, failures: Failures): Promise<Found> {
    const kind = work.kind as WorkKind;
    const ids = catalog().getExternalIds(work.id);
    const found: Found = { wikidata: null, tmdb: null };
    const tmdbNs = kind === 'movie' ? 'tmdb_movie' : 'tmdb_tv';
    const wd = registry.active('wikidata');
    let qid = ids.wikidata ?? null;
    if (wd) {
      qid ??= await firstMatch(wd, kind, [[tmdbNs, ids.tmdb], ['imdb', ids.imdb], ['tvdb', ids.tvdb]], failures);
      if (qid) {
        const r = await wd.details(kind, qid, lang);
        if (r.status === 'ok') found.wikidata = r.value;
        else failures.check('wikidata', 'details', r);
      }
    }
    const tm = registry.active('tmdb');
    if (tm) {
      const known = found.wikidata?.candidate.externalIds ?? {};
      const tid =
        ids.tmdb ??
        known.tmdb ??
        (await firstMatch(tm, kind, [['imdb', ids.imdb ?? known.imdb], ['wikidata', qid ?? undefined], ...(kind === 'series' ? [['tvdb', ids.tvdb ?? known.tvdb] as [ExternalIdLookup['ns'], string | undefined]] : [])], failures));
      if (tid) {
        const r = await tm.details(kind, tid, lang);
        if (r.status === 'ok') found.tmdb = r.value;
        else failures.check('tmdb', 'details', r);
      }
    }
    if (wd && !found.wikidata && found.tmdb) found.wikidata = await viaHints(wd, kind, found.tmdb, failures);
    return found;
  }

  /**
   * TMDB's own external_ids, used only to find the Wikidata item (never stored, ADR 0007 point 3).
   * The item counts only if Wikidata confirms the link: its P4947/P4983 is this TMDB id.
   */
  async function viaHints(wd: ProviderAdapter, kind: WorkKind, tmdb: WorkDetails, failures: Failures): Promise<WorkDetails | null> {
    const hints = tmdb.hints ?? {};
    const qid = hints.wikidata ?? (await firstMatch(wd, kind, [['imdb', hints.imdb], ...(kind === 'series' ? [['tvdb', hints.tvdb] as [ExternalIdLookup['ns'], string | undefined]] : [])], failures));
    if (!qid) return null;
    const r = await wd.details(kind, qid, lang);
    if (r.status !== 'ok') {
      failures.check('wikidata', 'details', r);
      return null;
    }
    return r.value.kind === kind && r.value.candidate.externalIds.tmdb === tmdb.id ? r.value : null;
  }

  function writeWork(work: CatalogItemRef, found: Found, log: FastifyBaseLogger): void {
    const cat = catalog();
    // Stored ids: Wikidata's (CC0) and the TMDB id itself (point 3); never the ids TMDB alone gave.
    const ids: ExternalIds = { ...(found.tmdb ? { tmdb: found.tmdb.id } : {}), ...found.wikidata?.candidate.externalIds };
    if (Object.keys(ids).length) cat.addExternalIds(work.id, ids);
    const fields: SourcedFieldValues[] = [];
    for (const s of SOURCES) {
      const d = found[s];
      if (!d) continue;
      fields.push({ source: s, fetchedAt: d.fetchedAt, values: d.fields });
      cat.replaceCredits(work.id, s, d.credits);
    }
    if (fields.length) cat.writeFields(work.id, fields);
    // ADR 0007 point 3: Wikidata decides the category; TMDB genre 99 only confirms it.
    const wdDoc = found.wikidata?.candidate.documentary;
    const tmDoc = found.tmdb?.candidate.documentary;
    if (found.wikidata && found.tmdb && wdDoc !== null && wdDoc !== undefined && wdDoc !== tmDoc) {
      log.info({ itemId: work.id, wikidata: wdDoc, tmdb: tmDoc }, 'documentary flag differs between Wikidata and TMDB: review');
    }
  }

  /** Drops the rows of (item, source, type) and the files no other row uses. */
  const clearImage = (itemId: string, source: 'tmdb' | 'wikidata', type: ArtworkType) =>
    store.exclusive(async () => store.remove(catalog().setArtwork(itemId, source, type, [])));

  /**
   * Downloads one image of (item, source, type) unless the same one is still fresh; clears it when
   * gone. A bad image never stops the job: it is logged and skipped.
   */
  async function applyImage(itemId: string, source: 'tmdb' | 'wikidata', type: ArtworkType, img: ImageRef | null, failures: Failures, log: FastifyBaseLogger): Promise<void> {
    try {
      const cat = catalog();
      const cur = cat.listArtwork(itemId).find((a) => a.source === source && a.type === type);
      if (!img) {
        if (cur) await clearImage(itemId, source, type);
        return;
      }
      const stale = !cur || now() - cur.fetchedAt >= deps.imageRefreshMs[source];
      if (cur && cur.remoteRef === img.ref && !stale) return;
      const adapter = registry.active(source);
      if (!adapter) return;
      const r = await adapter.fetchImage(img);
      if (r.status !== 'ok') {
        if (failures.check(source, `image ${type}`, r)) return;
        log.info({ itemId, source, type, status: r.status }, 'image not downloaded');
        // An image that cannot be renewed is not kept past its refresh window.
        if (cur && stale) await clearImage(itemId, source, type);
        return;
      }
      await store.exclusive(async () => {
        const saved = await store.save(r.value);
        const removed = cat.setArtwork(itemId, source, type, [
          { type, language: img.language, localPath: saved.localPath, remoteRef: img.ref, width: saved.width, height: saved.height, fetchedAt: now() },
        ]);
        await store.remove(removed);
      });
    } catch (err) {
      log.warn({ itemId, source, type, err: (err as Error)?.message ?? String(err) }, 'image skipped');
    }
  }

  interface Children {
    seasons: CatalogItemRef[];
    episodes: Map<string, CatalogItemRef[]>;
    ids: string[];
  }

  function children(seriesId: string): Children {
    const cat = catalog();
    const seasons = cat.listChildren(seriesId).filter((c) => c.kind === 'season' && c.seasonNumber !== null);
    const episodes = new Map(seasons.map((s) => [s.id, cat.listChildren(s.id).filter((c) => c.kind === 'episode' && c.episodeNumber !== null)]));
    return { seasons, episodes, ids: [...seasons.map((s) => s.id), ...[...episodes.values()].flat().map((e) => e.id)] };
  }

  /** Seasons of every provider, for the season numbers in the catalog. */
  async function fetchSeasons(found: Found, numbers: number[], failures: Failures): Promise<Partial<Record<'wikidata' | 'tmdb', SeasonDetails[]>>> {
    const out: Partial<Record<'wikidata' | 'tmdb', SeasonDetails[]>> = {};
    for (const s of SOURCES) {
      const d = found[s];
      const adapter = registry.active(s);
      if (!d || !adapter || !numbers.length) continue;
      const r = await adapter.seasons(d.id, numbers, lang);
      if (r.status === 'ok') out[s] = r.value;
      else failures.check(s, 'seasons', r);
    }
    return out;
  }

  /** Writes the season and episode values; returns the child ids it covered. */
  async function enrichEpisodes(seriesId: string, found: Found, failures: Failures): Promise<string[]> {
    const cat = catalog();
    const c = children(seriesId);
    const seasons = await fetchSeasons(found, c.seasons.map((s) => s.seasonNumber as number), failures);
    for (const s of SOURCES) {
      for (const sd of seasons[s] ?? []) {
        const season = c.seasons.find((x) => x.seasonNumber === sd.season);
        if (!season) continue;
        if (Object.keys(sd.fields).length) cat.writeFields(season.id, [{ source: s, fetchedAt: sd.fetchedAt, values: sd.fields }]);
        for (const ed of sd.episodes) {
          const ep = c.episodes.get(season.id)?.find((e) => e.episodeNumber === ed.episode);
          if (ep) cat.writeFields(ep.id, [{ source: s, fetchedAt: sd.fetchedAt, values: ed.fields }]);
        }
      }
    }
    return c.ids;
  }

  async function enrich(payload: unknown, ctx: JobContext): Promise<void> {
    const { itemId } = EnrichPayload.parse(payload);
    const log = ctx.log;
    const work = workOf(itemId);
    if (!work) return void log.info({ itemId }, 'enrich skipped: no work to enrich (unknown item or extra)');
    if (!registry.active('wikidata') && !registry.active('tmdb')) return void log.info({ itemId }, 'enrich skipped: no metadata provider active');
    const failures = new Failures(log);
    const found = await fetchWork(work, failures);
    writeWork(work, found, log);
    // Home needs poster and backdrop first (ADR 0007 point 6); the rest follows at low priority.
    for (const s of SOURCES) {
      const d = found[s];
      if (!d) continue;
      for (const type of ['poster', 'backdrop'] as const) await applyImage(work.id, s, type, d.images.find((i) => i.type === type) ?? null, failures, log);
    }
    const covered = work.kind === 'series' ? await enrichEpisodes(work.id, found, failures) : [];
    if (found.wikidata || found.tmdb) deps.jobs().enqueue({ type: ARTWORK_JOB, payload: { itemId: work.id }, priority: ARTWORK_PRIORITY, idempotencyKey: `artwork:${work.id}` });
    log.info({ itemId: work.id, wikidata: found.wikidata?.id ?? null, tmdb: found.tmdb?.id ?? null }, 'work enriched');
    failures.throwIfAny();
    // Children created while this job ran could not enqueue it again (it was running): run again.
    if (work.kind === 'series') {
      const current = new Set(children(work.id).ids);
      if (current.size !== covered.length || covered.some((id) => !current.has(id))) throw new RetryLaterError('seasons or episodes added during the enrichment', CHILDREN_CHANGED_DELAY_MS);
    }
  }

  async function artwork(payload: unknown, ctx: JobContext): Promise<void> {
    const { itemId } = EnrichPayload.parse(payload);
    const log = ctx.log;
    const work = workOf(itemId);
    if (!work) return;
    const failures = new Failures(log);
    const found = await fetchWork(work, failures);
    for (const s of SOURCES) {
      const d = found[s];
      if (d) await applyImage(work.id, s, 'logo', d.images.find((i) => i.type === 'logo') ?? null, failures, log);
    }
    if (work.kind === 'series') {
      const c = children(work.id);
      const seasons = await fetchSeasons(found, c.seasons.map((s) => s.seasonNumber as number), failures);
      for (const s of SOURCES) {
        for (const sd of seasons[s] ?? []) {
          const season = c.seasons.find((x) => x.seasonNumber === sd.season);
          if (!season) continue;
          await applyImage(season.id, s, 'poster', sd.poster, failures, log);
          for (const ed of sd.episodes) {
            const ep = c.episodes.get(season.id)?.find((e) => e.episodeNumber === ed.episode);
            if (ep) await applyImage(ep.id, s, 'still', ed.still, failures, log);
          }
        }
      }
    }
    failures.throwIfAny();
  }

  return { enrich, artwork };
}
