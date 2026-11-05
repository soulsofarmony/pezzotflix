// Enricher, Artwork Store and maintenance cases from the F1a.4 review: identifier-written TMDB rows
// through refresh and expiry, orphan collection, the store's critical sections, bad images, missing
// files, ids TMDB alone supplies, children added during a run, the provider fingerprint, and the
// providers of GetServerInfo.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModuleContext } from '../src/app/module.ts';
import { buildServer } from '../src/app/server.ts';
import { openDb, closeDb } from '../src/db/index.ts';
import { createCatalogWriter } from '../src/modules/catalog/write.ts';
import { contentKey, createArtworkStore, ORPHAN_AGE_MS } from '../src/modules/metadata/artwork.ts';
import { createSystemModule } from '../src/modules/system/index.ts';
import { JOB_TYPES } from '../src/shared/job-types.ts';
import { artworkPathOf, imageKeyOf, TMDB_NOTICE, WIKIDATA_NOTICE } from '../src/shared/metadata.ts';
import type { CatalogWritePort, WorkInput } from '../src/shared/ports.ts';
import { DAY, type Setup, setup, WD_SHOW } from './helpers/enrich-setup.ts';
import { testImage } from './helpers/metadata-fetch.ts';
import { MOVIE } from './helpers/tmdb-synthetic.ts';
import { claim } from './helpers/wikidata-entities.ts';

let s: Setup | undefined;
afterEach(() => {
  s?.close();
  s = undefined;
});

const log = pino({ level: 'silent' });
const cat = (x: Setup): CatalogWritePort => x.comp.ports.catalogWrite;
const all = <T>(x: Setup, sql: string, ...a: unknown[]) => x.db.$client.prepare(sql).all(...a) as T[];
const one = <T>(x: Setup, sql: string, ...a: unknown[]) => x.db.$client.prepare(sql).get(...a) as T;
const sweep = (x: Setup) => x.comp.periodic.find((p) => p.name === 'metadata.refresh_sweep')?.run();
const enrichState = (x: Setup, id: string) => one<{ state: string } | undefined>(x, 'SELECT state FROM job WHERE idempotency_key = ?', `enrich:${id}`)?.state;
const title = (x: Setup, id: string) => one<{ title: string }>(x, 'SELECT title FROM catalog_item WHERE id = ?', id).title;
const tmdbCredits = (x: Setup, id: string) => one<{ n: number }>(x, "SELECT count(*) AS n FROM credit WHERE item_id = ? AND source = 'tmdb'", id).n;
const tmdbRows = (x: Setup, id: string) => all<{ field: string; f: number }>(x, "SELECT field, fetched_at AS f FROM item_field WHERE item_id = ? AND source = 'tmdb' ORDER BY field", id);

async function runJob(x: Setup, type: string, key: string, payload: Record<string, unknown> = {}): Promise<void> {
  x.comp.ports.jobs.enqueue({ type, payload, idempotencyKey: key });
  await x.runner.drain();
}

/** Enrich an item again now (the job of a work enriched before is done). */
async function reenrich(x: Setup, itemId: string): Promise<void> {
  await runJob(x, JOB_TYPES.metadataEnrich, `enrich:${itemId}`, { itemId });
}

const wdMovie = (x: Setup, over: Partial<WorkInput> = {}): string =>
  cat(x).upsertWork({
    kind: 'movie',
    editionLabel: null,
    externalIds: { wikidata: 'Q99000001' },
    fields: [{ source: 'filename', fetchedAt: x.clock.now(), values: { title: 'il faro di prova', year: 2019 } }],
    ...over,
  }).itemId;

describe('B1: TMDB rows the identifier wrote', () => {
  it('one refresh renews every TMDB key; the work is not queued again the next day; expiry keeps fresh credits', async () => {
    s = await setup();
    const x = s;
    const t0 = x.clock.now();
    // The identifier's TMDB fallback writes these, category included (repro of the review).
    const { itemId } = cat(x).upsertWork({
      kind: 'movie',
      editionLabel: null,
      externalIds: { tmdb: String(MOVIE.id) },
      fields: [
        { source: 'tmdb', fetchedAt: t0, values: { title: 'Il Faro di Prova', year: 2019, category: 'film' } },
        { source: 'filename', fetchedAt: t0, values: { title: 'il faro di prova', year: 2019 } },
      ],
    });
    await x.runner.drain();
    expect(tmdbCredits(x, itemId)).toBeGreaterThan(0);
    // TMDB says "not a documentary": its category row goes, Wikidata decides (ADR 0007 point 3).
    expect(tmdbRows(x, itemId).map((r) => r.field)).not.toContain('category');

    x.clock.advance(101 * DAY);
    await sweep(x);
    expect(enrichState(x, itemId)).toBe('queued');
    await x.runner.drain();
    expect(tmdbRows(x, itemId).every((r) => x.clock.now() - r.f < DAY)).toBe(true);

    x.clock.advance(DAY);
    await sweep(x);
    expect(enrichState(x, itemId)).toBe('done');

    x.clock.advance(79 * DAY); // 181 days after t0, 80 after the refresh
    await runJob(x, 'metadata.expire', 'expire:tmdb');
    expect(tmdbCredits(x, itemId)).toBeGreaterThan(0);
    expect(tmdbRows(x, itemId).length).toBeGreaterThan(0);
    expect(title(x, itemId)).toBe('Il Faro di Prova');

    // TMDB unreachable from here on: past the maximum age (less the margin) every TMDB trace goes.
    x.fetch.offline = true;
    x.clock.advance(100 * DAY);
    await runJob(x, 'metadata.expire', 'expire:tmdb');
    expect(tmdbCredits(x, itemId)).toBe(0);
    expect(tmdbRows(x, itemId)).toEqual([]);
  });

  it('expiry runs two days before TMDB_MAX_AGE_DAYS', async () => {
    s = await setup();
    const x = s;
    const id = wdMovie(x);
    await x.runner.drain();
    x.fetch.offline = true;
    x.clock.advance(177 * DAY);
    await runJob(x, 'metadata.expire', 'expire:tmdb');
    expect(tmdbRows(x, id).length).toBeGreaterThan(0);
    x.clock.advance(2 * DAY); // 179 days: past 180 - 2
    await runJob(x, 'metadata.expire', 'expire:tmdb');
    expect(tmdbRows(x, id)).toEqual([]);
  });
});

describe('M1: orphan artwork', () => {
  it('a purge that stopped before deleting the files is completed by the next run, once the files are an hour old', async () => {
    s = await setup({ start: Date.now() });
    const x = s;
    const id = wdMovie(x);
    await x.runner.drain();
    const dirs = cat(x)
      .listArtwork(id)
      .filter((a) => a.source === 'tmdb')
      .map((a) => join(x.config.artworkDir, a.localPath, '..'));
    const wdDirs = cat(x)
      .listArtwork(id)
      .filter((a) => a.source === 'wikidata')
      .map((a) => join(x.config.artworkDir, a.localPath, '..'));
    expect(dirs.length).toBeGreaterThan(0);
    cat(x).purgeSource('tmdb'); // rows gone; the job "crashed" before removing the files
    expect(dirs.every((d) => existsSync(d))).toBe(true);
    await runJob(x, 'metadata.purge', 'purge:tmdb');
    expect(dirs.every((d) => existsSync(d))).toBe(true); // younger than an hour: a save may be in flight
    x.clock.advance(ORPHAN_AGE_MS + 60_000);
    await runJob(x, 'metadata.purge', 'purge:tmdb');
    expect(dirs.some((d) => existsSync(d))).toBe(false);
    expect(wdDirs.every((d) => existsSync(d))).toBe(true);
  });
});

describe('Artwork Store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  async function storeSetup(now = Date.now) {
    const dataDir = mkdtempSync(join(tmpdir(), 'pzf-store-'));
    dirs.push(dataDir);
    const artworkDir = join(dataDir, 'artwork');
    const cacheDir = join(dataDir, 'cache');
    const db = await openDb({ path: ':memory:' });
    const w = createCatalogWriter({ db, now, events: () => ({ publish: () => undefined }), tmdbMaxAgeMs: 180 * DAY });
    const store = createArtworkStore({ artworkDir, cacheDir, log, now });
    const work = (label: string) => w.upsertWork({ kind: 'movie', editionLabel: label, externalIds: {}, fields: [{ source: 'filename', fetchedAt: 0, values: { title: label } }] }).itemId;
    return { db, w, store, work, artworkDir, cacheDir };
  }
  const file = async (seed: number) => ({ bytes: await testImage(64, 48, seed), contentType: 'image/jpeg', size: 'original', width: null, height: null });

  it('M2: removing a key another item is saving waits for that save and its row: the file survives', async () => {
    const { db, w, store, work, artworkDir } = await storeSetup();
    const a = work('A');
    const b = work('B');
    const img = await file(7);
    const row = (localPath: string) => ({ type: 'poster' as const, language: null, localPath, remoteRef: 'x.jpg', width: 64, height: 48, fetchedAt: 0 });
    await store.exclusive(async () => {
      const saved = await store.save([img]);
      w.setArtwork(a, 'wikidata', 'poster', [row(saved.localPath)]);
    });
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => (release = r));
    // B saves the same image, then (slowly) writes its row; A drops its row meanwhile.
    const bSide = store.exclusive(async () => {
      const saved = await store.save([img]);
      await gate;
      w.setArtwork(b, 'wikidata', 'poster', [row(saved.localPath)]);
    });
    const aSide = store.exclusive(async () => store.remove(w.setArtwork(a, 'wikidata', 'poster', [])));
    await new Promise((r) => setTimeout(r, 20));
    const key = contentKey(img.bytes);
    const path = join(artworkDir, artworkPathOf(key, 'original.jpg'));
    expect(existsSync(path)).toBe(true);
    release();
    await Promise.all([bSide, aSide]);
    expect(existsSync(path)).toBe(true);
    expect(w.findArtworkByKey(key)?.itemId).toBe(b);
    closeDb(db);
  });

  it('M3: an invalid image is rejected before anything is written; a truncated leftover is rewritten', async () => {
    const { db, store, artworkDir } = await storeSetup();
    const garbage = { bytes: Buffer.from('definitely not a jpeg'), contentType: 'image/jpeg', size: 'original', width: null, height: null };
    await expect(store.save([garbage])).rejects.toThrow();
    const good = await file(3);
    await expect(store.save([good, garbage])).rejects.toThrow();
    expect(existsSync(join(artworkDir, artworkPathOf(contentKey(good.bytes), 'original.jpg')))).toBe(false);
    const png = { ...good, contentType: 'image/png' }; // JPEG bytes declared as PNG
    await expect(store.save([png])).rejects.toThrow(/invalid image/);
    const path = join(artworkDir, artworkPathOf(contentKey(good.bytes), 'original.jpg'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, good.bytes.subarray(0, 10));
    await store.save([good]);
    expect(statSync(path).size).toBe(good.bytes.length);
    closeDb(db);
  });

  it('cleanTemp removes interrupted writes; collectOrphans only unreferenced key directories older than an hour', async () => {
    let t = Date.now();
    const { db, w, store, work, artworkDir, cacheDir } = await storeSetup(() => t);
    const kept = await store.save([await file(1)]);
    const orphan = await store.save([await file(2)]);
    w.setArtwork(work('K'), 'wikidata', 'poster', [{ type: 'poster', language: null, localPath: kept.localPath, remoteRef: null, width: 1, height: 1, fetchedAt: 0 }]);
    const variant = join(cacheDir, 'images', orphan.key.slice(0, 2), orphan.key);
    mkdirSync(variant, { recursive: true });
    writeFileSync(join(variant, 'w160.webp'), 'x');
    writeFileSync(join(artworkDir, kept.localPath.replace(/[^/]+$/, 'original.jpg.1.2.tmp')), 'half');
    expect(await store.cleanTemp()).toBe(1);
    const referenced = (key: string) => w.findArtworkByKey(key) !== null;
    expect(await store.collectOrphans(referenced)).toBe(0);
    t += ORPHAN_AGE_MS + 1000;
    expect(await store.collectOrphans(referenced)).toBe(2);
    expect(existsSync(join(artworkDir, kept.localPath))).toBe(true);
    expect(existsSync(join(artworkDir, orphan.localPath))).toBe(false);
    expect(existsSync(variant)).toBe(false);
    closeDb(db);
  });
});

describe('M3: a bad image never stops the job', () => {
  it('a Commons poster with garbage bytes is skipped; the series and its episodes are still enriched', async () => {
    WD_SHOW.claims.P3383 = [claim.str('Bad poster.jpg')];
    try {
      s = await setup();
      const x = s;
      const garbage = Buffer.from('definitely not an image');
      x.fetch.routes.unshift({ match: (u) => u.host === 'commons.wikimedia.org' && u.pathname.includes('Bad_poster'), reply: () => ({ bytes: garbage, contentType: 'image/jpeg' }) });
      const c = cat(x);
      const { itemId: series } = c.upsertWork({ kind: 'series', editionLabel: null, externalIds: { wikidata: 'Q98000001' }, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'serie' } }] });
      const season = c.ensureSeason(series, 1).itemId;
      const eps = [1, 2, 3].map((n) => c.ensureEpisode(season, n).itemId);
      x.clock.advance(2 * 60_000);
      await x.runner.drain();
      expect(enrichState(x, series)).toBe('done');
      expect(eps.map((e) => title(x, e))).toEqual(['Segreti di prova', 'Lies', 'Terzo']);
      expect(c.listArtwork(series).map((a) => [a.type, a.source])).toEqual([['poster', 'tmdb']]); // no Wikidata poster
      const key = contentKey(garbage);
      expect(existsSync(join(x.config.artworkDir, key.slice(0, 2), key))).toBe(false);
    } finally {
      delete WD_SHOW.claims.P3383;
    }
  });
});

describe('M2: a row whose file is gone', () => {
  it('GetImage answers 404 and marks the row, so the next enrichment downloads the image again', async () => {
    s = await setup();
    const x = s;
    const id = wdMovie(x);
    await x.runner.drain();
    const poster = cat(x)
      .listArtwork(id)
      .find((a) => a.type === 'poster' && a.source === 'tmdb');
    if (!poster) throw new Error('no poster');
    rmSync(join(x.config.artworkDir, poster.localPath, '..'), { recursive: true, force: true });
    const app = await buildServer({ handlers: x.comp.handlers, profileTokens: { verify: () => null }, logger: false });
    try {
      expect((await app.inject({ method: 'GET', url: `/video/media/images/${imageKeyOf(poster.localPath) ?? ''}?w=320` })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
    expect(cat(x).listArtwork(id).find((a) => a.id === poster.id)?.fetchedAt).toBe(0);
    await reenrich(x, id);
    const again = cat(x)
      .listArtwork(id)
      .find((a) => a.type === 'poster' && a.source === 'tmdb');
    expect(existsSync(join(x.config.artworkDir, again?.localPath ?? 'x'))).toBe(true);
  });
});

describe('M6: ids only TMDB supplies', () => {
  it('are not stored; TMDB\'s Wikidata id finds the item only when Wikidata confirms the link', async () => {
    s = await setup();
    const x = s;
    // Wikidata's search index lags: the P4947 lookup finds nothing.
    x.fetch.routes.unshift({
      match: (u) => u.host === 'www.wikidata.org' && (u.searchParams.get('srsearch') ?? '').startsWith('haswbstatement:'),
      reply: () => ({ json: { query: { search: [] } } }),
    });
    const id = cat(x).upsertWork({ kind: 'movie', editionLabel: null, externalIds: { tmdb: String(MOVIE.id) }, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'faro' } }] }).itemId;
    await x.runner.drain();
    // Q99000001 has P4947 = 900001: confirmed, so its ids (CC0) are stored, IMDb from P345 included.
    expect(cat(x).getExternalIds(id)).toEqual({ tmdb: String(MOVIE.id), wikidata: 'Q99000001', imdb: 'tt9000001' });

    const original = MOVIE.external_ids.wikidata_id;
    MOVIE.external_ids.wikidata_id = 'Q99000002'; // an item whose P4947 is another film
    try {
      const other = cat(x).upsertWork({ kind: 'movie', editionLabel: 'B', externalIds: { tmdb: String(MOVIE.id) }, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'faro' } }] }).itemId;
      x.clock.advance(2 * DAY); // past the TMDB cache
      await x.runner.drain();
      expect(cat(x).getExternalIds(other)).toEqual({ tmdb: String(MOVIE.id) });
      expect(tmdbRows(x, other).length).toBeGreaterThan(0);
      expect(all(x, "SELECT field FROM item_field WHERE item_id = ? AND source = 'wikidata'", other)).toEqual([]);
    } finally {
      MOVIE.external_ids.wikidata_id = original;
    }
  });
});

describe('children added while a series is enriched', () => {
  it('the job runs again a minute later and covers them', async () => {
    s = await setup();
    const x = s;
    const c = cat(x);
    const { itemId: series } = c.upsertWork({ kind: 'series', editionLabel: null, externalIds: { wikidata: 'Q98000001' }, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'serie' } }] });
    const season = c.ensureSeason(series, 1).itemId;
    [1, 2].forEach((n) => c.ensureEpisode(season, n));
    let third: string | null = null;
    // The scan adds episode 3 while the enrichment is reading the seasons.
    x.fetch.routes.unshift({
      match: (u) => u.host === 'query.wikidata.org' && third === null,
      reply: () => {
        third = c.ensureEpisode(season, 3).itemId;
        return { json: { results: { bindings: [] } } };
      },
    });
    x.clock.advance(2 * 60_000);
    await x.runner.drain();
    expect(third).not.toBeNull();
    expect(enrichState(x, series)).toBe('queued');
    expect(all(x, "SELECT field FROM item_field WHERE item_id = ? AND source = 'tmdb'", third)).toEqual([]);
    x.clock.advance(2 * 60_000);
    await x.runner.drain();
    expect(enrichState(x, series)).toBe('done');
    expect(title(x, third ?? '')).toBe('Terzo');
  });
});

describe('provider fingerprint (ADR 0007 point 9)', () => {
  it('works without TMDB values are enriched again only at the start where TMDB appeared', async () => {
    const s1 = await setup({ tmdb: false });
    s = s1;
    const film = wdMovie(s1);
    const loner = cat(s1).upsertWork({ kind: 'movie', editionLabel: null, externalIds: {}, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'nessuno' } }] }).itemId;
    await s1.runner.drain();
    expect(title(s1, film)).toBe('Il faro (Wikidata)');
    s1.clock.advance(60_000);
    const s2 = await setup({ reuse: s1 }); // restart with the token
    await sweep(s2);
    expect([enrichState(s2, film), enrichState(s2, loner)]).toEqual(['queued', 'queued']);
    await s2.runner.drain();
    expect(title(s2, film)).toBe('Il Faro di Prova');
    s2.clock.advance(60_000);
    const s3 = await setup({ reuse: s1 }); // restart, same providers
    await sweep(s3);
    expect(enrichState(s3, loner)).toBe('done');
  });
});

describe('M5: providers of GetServerInfo', () => {
  async function providers(x: Setup) {
    const ctx = { config: x.config, db: x.db, log, ports: x.comp.ports, now: x.clock.now } as ModuleContext;
    const handler = createSystemModule(ctx).handlers?.getServerInfo;
    if (!handler) throw new Error('no getServerInfo');
    return ((await handler({} as never, {} as never)) as { providers: unknown[] }).providers;
  }

  it('TMDB configured: both, with the ADR 0007 notices', async () => {
    s = await setup();
    expect(await providers(s)).toEqual([
      { name: 'wikidata', status: 'ok', attribution: WIKIDATA_NOTICE },
      { name: 'tmdb', status: 'ok', attribution: TMDB_NOTICE },
    ]);
  });

  it('TMDB not configured: listed only while TMDB data is in the catalog', async () => {
    s = await setup({ tmdb: false });
    expect(await providers(s)).toEqual([{ name: 'wikidata', status: 'ok', attribution: WIKIDATA_NOTICE }]);
    const id = wdMovie(s);
    cat(s).writeFields(id, [{ source: 'tmdb', fetchedAt: s.clock.now(), values: { overview: 'resto' } }]);
    expect(await providers(s)).toEqual([
      { name: 'wikidata', status: 'ok', attribution: WIKIDATA_NOTICE },
      { name: 'tmdb', status: 'not_configured', attribution: TMDB_NOTICE },
    ]);
  });

  it('TMDB_PURGE: disabled; a refused token: invalid_credentials', async () => {
    s = await setup({ purge: true });
    expect((await providers(s))[1]).toEqual({ name: 'tmdb', status: 'disabled', attribution: TMDB_NOTICE });
    s.close();
    s = await setup({ env: { TMDB_READ_TOKEN: 'wrong-token-value-123456' } });
    expect((await providers(s))[1]).toEqual({ name: 'tmdb', status: 'invalid_credentials', attribution: TMDB_NOTICE });
  });
});
