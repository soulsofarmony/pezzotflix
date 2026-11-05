// Read side on the S1 sample library: scan → probe → identify with real ffprobe and a fake
// MetadataSearchPort (Wikidata-like, CC0), then Home, ListItems, Search, GetItem and the review queue
// through the real Fastify app, every response checked against the contract. Needs ffprobe and the
// samples (PZF_MEDIA_SAMPLES, FFPROBE_PATH); skipped with a message otherwise.
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- response bodies are untyped JSON, checked against the contract by the harness */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import type { ModuleFactory } from '../src/app/module.ts';
import { buildServer } from '../src/app/server.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createAdminModule } from '../src/modules/admin/index.ts';
import { createAnalyzerModule } from '../src/modules/analyzer/index.ts';
import { createCatalogModule } from '../src/modules/catalog/index.ts';
import { createEventsModule } from '../src/modules/events/index.ts';
import { createIdentifierModule } from '../src/modules/identifier/index.ts';
import { normalizeTitle } from '../src/modules/identifier/normalize.ts';
import { createJobRunner, createJobsModule, type JobRunner } from '../src/modules/jobs/index.ts';
import { libraryModule } from '../src/modules/library/index.ts';
import { JOB_TYPES } from '../src/shared/job-types.ts';
import type { MetadataCandidate } from '../src/shared/metadata.ts';
import { contractErrors } from './helpers/contract.ts';
import { cand, fakeMetadata } from './helpers/fake-metadata.ts';

const SAMPLES =
  process.env.PZF_MEDIA_SAMPLES ?? resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'media-samples', 'library');
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

const haveSamples = existsSync(join(SAMPLES, 'movies')) && existsSync(join(SAMPLES, 'series'));
const haveFfprobe = haveSamples && (await execa(FFPROBE, ['-version'], { reject: false })).exitCode === 0;
const skipReason = !haveSamples
  ? `sample library not found at ${SAMPLES} (set PZF_MEDIA_SAMPLES)`
  : !haveFfprobe
    ? `ffprobe not runnable as "${FFPROBE}" (set FFPROBE_PATH or add it to PATH)`
    : null;
if (skipReason) process.stderr.write(`[catalog-admin] skipped: ${skipReason}\n`);

const WIKIDATA: Record<string, MetadataCandidate[]> = {
  'blade runner 2049': [
    cand({ id: 'Q21451539', title: 'Blade Runner 2049', original: ['Blade Runner 2049'], years: [2017], ids: { imdb: 'tt1856101' } }),
    cand({ id: 'Q184843', title: 'Blade Runner', original: ['Blade Runner'], years: [1982] }),
  ],
  dune: [cand({ id: 'Q63985561', title: 'Dune', original: ['Dune'], years: [2021, 2020] }), cand({ id: 'Q470283', title: 'Dune', original: ['Dune'], years: [1984] })],
  'buono brutto cattivo': [cand({ id: 'Q131390', title: 'Il buono, il brutto, il cattivo', original: ['Il buono, il brutto, il cattivo'], years: [1966] })],
  oppenheimer: [cand({ id: 'Q108839994', title: 'Oppenheimer', original: ['Oppenheimer'], years: [2023] })],
  dark: [cand({ id: 'Q24300155', kind: 'series', title: 'Dark', original: ['Dark'], years: [2017] }), cand({ id: 'Q1165470', title: 'Dark', years: [2015] })],
};
const metadata = fakeMetadata({
  wikidata: {
    search: (req) => {
      const words = normalizeTitle(req.query);
      const hit = Object.entries(WIKIDATA).find(([k]) => k.split(' ').every((w) => words.split(' ').includes(w)));
      return { status: 'ok', value: hit?.[1] ?? [] };
    },
  },
});
// The catalog enqueues metadata.enrich for new works (F1a.4); this fake has no Enricher, so it drops them.
const createFakeMetadataModule: ModuleFactory = () => ({
  name: 'metadata',
  provides: { metadataSearch: metadata },
  jobs: { [JOB_TYPES.metadataEnrich]: { concurrency: 1, handler: async () => undefined } },
});

const log = pino({ level: 'silent' });
let db: Db;
let app: FastifyInstance;
let runner: JobRunner;
let dataDir: string | undefined;

/** GET or POST through the app; the body must match the contract of the operation. */
async function call(operationId: string, method: 'GET' | 'POST', url: string, payload?: object): Promise<any> {
  const r = await app.inject({ method, url, headers: { authorization: 'Bearer tok' }, ...(payload ? { payload } : {}) });
  expect(contractErrors(operationId, r.statusCode, r.json()), `${operationId} ${r.body.slice(0, 300)}`).toEqual([]);
  expect(r.statusCode, r.body.slice(0, 300)).toBeLessThan(300);
  return r.json();
}
const titles = (items: { title: string }[]) => items.map((i) => i.title);

describe.skipIf(skipReason !== null)('catalog and review queue over the sample library', () => {
  beforeAll(async () => {
    db = await openDb({ path: ':memory:' });
    dataDir = mkdtempSync(join(tmpdir(), 'pzf-catalog-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      FFPROBE_PATH: FFPROBE,
      LIBRARY_ROOTS: JSON.stringify([
        { name: 'Film', path: join(SAMPLES, 'movies'), hint: 'movies' },
        { name: 'Serie', path: join(SAMPLES, 'series'), hint: 'series' },
      ]),
    });
    const comp = compose({
      config,
      db,
      log,
      factories: [
        createEventsModule,
        createJobsModule,
        libraryModule({ stableAfterMs: 0 }),
        createAnalyzerModule,
        createIdentifierModule,
        createFakeMetadataModule,
        createCatalogModule,
        createAdminModule,
      ],
    });
    for (const m of comp.modules) await m.start?.();
    runner = createJobRunner({ db, log, jobTypes: comp.jobTypes, periodic: comp.periodic });
    await comp.periodic.find((p) => p.name === 'library.scan')?.run();
    await runner.drain();
    app = await buildServer({ logger: false, handlers: comp.handlers, profileTokens: { verify: (t) => (t === 'tok' ? 'p1' : null) } });
    await app.ready();
  }, 180_000);
  afterAll(async () => {
    await runner?.stop();
    await app?.close();
    if (db) closeDb(db);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('composes Home from the identified library', async () => {
    const home = await call('getHome', 'GET', '/video/api/v1/home');
    expect(home.rows.map((r: { id: string }) => r.id)).toEqual(['recently_added', 'movies', 'series']);
    const movies = home.rows.find((r: { id: string }) => r.id === 'movies');
    expect(titles(movies.items)).toEqual(['Blade Runner 2049', 'Il buono, il brutto, il cattivo', 'Dune', 'Oppenheimer']);
    const dune = movies.items.find((i: { title: string }) => i.title === 'Dune');
    expect(dune).toMatchObject({ year: 2021, available: true, badges: expect.arrayContaining(['4K', 'DV']) });
    expect(titles(home.rows.find((r: { id: string }) => r.id === 'series').items)).toEqual(['Dark']);
  });

  it('lists, searches and details a film with its versions, tracks and extra', async () => {
    const page = await call('listItems', 'GET', '/video/api/v1/items?kind=movie&limit=2');
    expect(page.items).toHaveLength(2);
    const next = await call('listItems', 'GET', `/video/api/v1/items?kind=movie&limit=2&cursor=${page.nextCursor}`);
    expect(titles([...page.items, ...next.items])).toEqual(['Blade Runner 2049', 'Il buono, il brutto, il cattivo', 'Dune', 'Oppenheimer']);

    const found = await call('search', 'GET', '/video/api/v1/search?q=blade%20run');
    expect(titles(found.items)).toEqual(['Blade Runner 2049']);
    const br = await call('getItem', 'GET', `/video/api/v1/items/${found.items[0].id}`);
    expect(br).toMatchObject({ kind: 'movie', year: 2017, externalIds: { wikidata: 'Q21451539', imdb: 'tt1856101' } });
    expect(br.versions).toHaveLength(1);
    expect(br.versions[0].label).toMatch(/^4K/);
    expect(br.versions[0].tracks.filter((t: { type: string }) => t.type === 'audio').length).toBeGreaterThan(1);
    expect(br.versions[0].tracks.every((t: { id: string }) => /^s\d+$|^x:[0-9a-f]{8}$/.test(t.id))).toBe(true);
    expect(br.extras.map((e: { title: string; extraType: string }) => [e.title, e.extraType])).toEqual([['Trailer', 'trailer']]);
    const trailer = await call('getItem', 'GET', `/video/api/v1/items/${br.extras[0].id}`);
    expect(trailer.parent.id).toBe(br.id);
    expect(trailer.versions).toHaveLength(1);
  });

  it('details the Dark series down to its episodes', async () => {
    const [dark] = (await call('search', 'GET', '/video/api/v1/search?q=dark')).items;
    expect(dark).toMatchObject({ kind: 'series', title: 'Dark', available: true });
    const series = await call('getItem', 'GET', `/video/api/v1/items/${dark.id}`);
    expect(titles(series.children)).toEqual(['Stagione 1']);
    const episodes = await call('getChildren', 'GET', `/video/api/v1/items/${series.children[0].id}/children`);
    expect(episodes.items.map((e: { episodeNumber: number }) => e.episodeNumber)).toEqual([1, 2, 3]);
    expect(episodes.items[0].title).toBe('Segreti');
    const next = await call('getNextUp', 'GET', `/video/api/v1/items/${dark.id}/next-up`);
    expect(next.item.id).toBe(episodes.items[0].id);
  });

  it('shows the review queue and resolves a case manually', async () => {
    const queue = await call('listIdentificationCases', 'GET', '/video/api/v1/admin/cases');
    const reasons = queue.cases.map((c: { reason: string; relPath: string }) => [c.reason, c.relPath]).sort();
    expect(reasons).toEqual([
      ['no_candidates', 'Long Test (2024)/Long Test (2024) - 2160p.mkv'],
      ['no_title', 'misc/BDMV_DISC1_t00.mkv'],
    ]);
    const long = queue.cases.find((c: { reason: string }) => c.reason === 'no_candidates');
    expect(long.allowedResolutions).toEqual(['link_candidate', 'link_item', 'create_manual', 'ignore']);
    const details = await call('getMediaFileDetails', 'GET', `/video/api/v1/admin/files/${long.fileId}`);
    expect(details.version.tracks.length).toBeGreaterThan(0);

    const resolved = await call('resolveCase', 'POST', `/video/api/v1/admin/cases/${long.id}/resolve`, { action: 'create_manual', manual: { kind: 'movie', title: 'Long Test', year: 2024 } });
    expect(resolved).toMatchObject({ state: 'resolved', linkedItem: { kind: 'movie', title: 'Long Test', year: 2024, available: true } });
    const movies = await call('listItems', 'GET', '/video/api/v1/items?kind=movie');
    expect(titles(movies.items)).toContain('Long Test');
    expect((await call('listIdentificationCases', 'GET', '/video/api/v1/admin/cases')).cases).toHaveLength(1);

    const roots = await call('listLibraryRoots', 'GET', '/video/api/v1/admin/roots');
    expect(roots.roots.map((r: { name: string; status: string; held: unknown }) => [r.name, r.status, r.held])).toEqual([
      ['Film', 'online', null],
      ['Serie', 'online', null],
    ]);
    const ingest = await call('getIngestStatus', 'GET', '/video/api/v1/admin/ingest');
    expect(ingest).toMatchObject({ running: false, failed: [] });
    // Only enrichments wait: the one of the manual work and the series one, delayed a minute after
    // its episodes (F1a.4). Ingest itself is done.
    expect(ingest.queued).toBe(ingest.jobs['metadata.enrich']?.queued ?? 0);
    expect(ingest.jobs['identifier.identify'].done).toBeGreaterThan(0);
  });

  it('resolves a case of a missing file; the scan that finds it again revives it as identified', async () => {
    const [disc] = (await call('listIdentificationCases', 'GET', '/video/api/v1/admin/cases')).cases;
    expect(disc.relPath).toBe('misc/BDMV_DISC1_t00.mkv');
    // The disk was out when the last scan ran (simulated in the DB: the sample library is read only).
    db.$client.prepare("UPDATE media_file SET state = 'missing', missing_since = 1 WHERE id = ?").run(disc.fileId);
    const resolved = await call('resolveCase', 'POST', `/video/api/v1/admin/cases/${disc.id}/resolve`, { action: 'create_manual', manual: { kind: 'movie', title: 'Disco uno' } });
    expect(resolved.state).toBe('resolved');
    const fileState = () => (db.$client.prepare('SELECT state FROM media_file WHERE id = ?').get(disc.fileId) as { state: string }).state;
    expect(fileState()).toBe('missing');
    expect(resolved.linkedItem).toMatchObject({ title: 'Disco uno', available: false });

    await call('triggerScan', 'POST', '/video/api/v1/admin/scan', {});
    await runner.drain();
    expect(fileState()).toBe('identified');
    const item = await call('getItem', 'GET', `/video/api/v1/items/${resolved.linkedItem.id}`);
    expect(item).toMatchObject({ title: 'Disco uno', available: true });
    expect((await call('listIdentificationCases', 'GET', '/video/api/v1/admin/cases')).cases).toEqual([]);
  });
});
