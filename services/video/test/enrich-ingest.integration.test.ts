// Ingest with enrichment: scan → probe → identify → enrich on the S1 sample library with real
// ffprobe, through compose() with the real library, analyzer, identifier, metadata and catalog
// modules. The providers answer through a fake fetch: Wikidata-like CC0 entities and synthetic
// TMDB bodies (ADR 0007 point 10). Needs ffprobe and the samples (PZF_MEDIA_SAMPLES, FFPROBE_PATH);
// skipped with a message otherwise.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createAnalyzerModule } from '../src/modules/analyzer/index.ts';
import { createCatalogModule } from '../src/modules/catalog/index.ts';
import { createEventsModule } from '../src/modules/events/index.ts';
import { createIdentifierModule } from '../src/modules/identifier/index.ts';
import { createJobRunner, createJobsModule } from '../src/modules/jobs/index.ts';
import { libraryModule } from '../src/modules/library/index.ts';
import { metadataModule } from '../src/modules/metadata/index.ts';
import { type FakeFetch, fakeClock, fakeFetch } from './helpers/metadata-fetch.ts';
import { MOVIE, SEASON_1, SHOW, tmdbRoutes, TOKEN } from './helpers/tmdb-synthetic.ts';
import { claim, wdEntity, wikidataRoutes } from './helpers/wikidata-entities.ts';

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
if (skipReason) process.stderr.write(`[enrich-ingest] skipped: ${skipReason}\n`);

// Wikidata side: CC0-style entities. Q21500755 is the real Blade Runner 2049; the Q970000xx ids are
// made up for the other sample works. TMDB ids point to the synthetic bodies.
const year = (y: number) => claim.time(`+${y}-01-01T00:00:00Z`);
const ENTITIES = [
  wdEntity('Q21500755', { it: 'Blade Runner 2049', en: 'Blade Runner 2049' }, { P31: [claim.item('Q11424')], P577: [year(2017)], P1476: [claim.text('Blade Runner 2049', 'en')], P4947: [claim.str(String(MOVIE.id))] }),
  wdEntity('Q97000001', { it: 'Dune', en: 'Dune' }, { P31: [claim.item('Q11424')], P577: [year(2021)], P1476: [claim.text('Dune', 'en')] }),
  wdEntity('Q97000002', { it: 'Il buono, il brutto, il cattivo' }, { P31: [claim.item('Q11424')], P577: [year(1966)], P1476: [claim.text('Il buono, il brutto, il cattivo', 'it')] }),
  wdEntity('Q97000003', { it: 'Oppenheimer', en: 'Oppenheimer' }, { P31: [claim.item('Q11424')], P577: [year(2023)] }),
  wdEntity('Q97000004', { it: 'Dark', en: 'Dark' }, { P31: [claim.item('Q5398426')], P580: [year(2017)], P4983: [claim.str(String(SHOW.id))] }),
  wdEntity('Q11424', { it: 'film', en: 'film' }),
  wdEntity('Q5398426', { it: 'serie televisiva', en: 'television series' }),
];
const SEARCH: Record<string, string[]> = {
  'blade runner 2049': ['Q21500755'],
  dune: ['Q97000001'],
  'il buono, il brutto, il cattivo': ['Q97000002'],
  oppenheimer: ['Q97000003'],
  dark: ['Q97000004'],
};

const BR2049 = 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv';
const TRAILER = 'Blade Runner 2049 (2017)/extras/Trailer.mkv';

const log = pino({ level: 'silent' });
let db: Db;
let comp: Composition;
let fetch: FakeFetch;
let dataDir: string | undefined;
const all = <T>(sql: string, ...a: unknown[]) => db.$client.prepare(sql).all(...a) as T[];
const itemOf = (rel: string) =>
  all<{ id: string; title: string; kind: string }>(
    'SELECT i.id, i.title, i.kind FROM media_file f JOIN media_link l ON l.file_id = f.id JOIN catalog_item i ON i.id = l.item_id WHERE f.rel_path = ? ORDER BY i.episode_number',
    rel,
  );

describe.skipIf(skipReason !== null)('ingest with enrichment (scan → probe → identify → enrich)', () => {
  beforeAll(async () => {
    db = await openDb({ path: ':memory:' });
    dataDir = mkdtempSync(join(tmpdir(), 'pzf-enrich-ingest-'));
    const clock = fakeClock(Date.now());
    fetch = fakeFetch([...wikidataRoutes({ entities: ENTITIES, search: SEARCH, episodes: { Q97000004: [{ season: 1, episode: 1, it: 'Segreti' }, { season: 1, episode: 3, en: 'Past and Present' }] } }), ...tmdbRoutes()]);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      FFPROBE_PATH: FFPROBE,
      TMDB_READ_TOKEN: TOKEN,
      LIBRARY_ROOTS: JSON.stringify([
        { name: 'Film', path: join(SAMPLES, 'movies'), hint: 'movies' },
        { name: 'Serie', path: join(SAMPLES, 'series'), hint: 'series' },
      ]),
    });
    comp = compose({
      config,
      db,
      log,
      now: clock.now,
      factories: [createEventsModule, createJobsModule, libraryModule({ stableAfterMs: 0 }), createAnalyzerModule, createIdentifierModule, metadataModule({ fetch, clock }), createCatalogModule],
    });
    for (const m of comp.modules) await m.start?.();
    const runner = createJobRunner({ db, log, jobTypes: comp.jobTypes, periodic: comp.periodic, now: clock.now });
    await comp.periodic.find((p) => p.name === 'library.scan')?.run();
    await runner.drain();
    clock.advance(5 * 60_000); // episode-triggered enrichments wait a minute to batch
    await runner.drain();
    await runner.stop();
  }, 180_000);
  afterAll(() => {
    if (db) closeDb(db);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs every job to completion, enrichment included', () => {
    expect(all('SELECT DISTINCT type, state FROM job ORDER BY type')).toEqual([
      { type: 'analyzer.probe', state: 'done' },
      { type: 'identifier.identify', state: 'done' },
      { type: 'library.scan', state: 'done' },
      { type: 'metadata.artwork', state: 'done' },
      { type: 'metadata.enrich', state: 'done' },
    ]);
  });

  it('films: TMDB Italian title where TMDB knows the work, Wikidata values elsewhere', () => {
    expect(itemOf(BR2049)[0]?.title).toBe(MOVIE.title);
    const titles = all<{ title: string }>("SELECT title FROM catalog_item WHERE kind = 'movie' ORDER BY sort_title").map((r) => r.title);
    expect(titles).toEqual(['Il buono, il brutto, il cattivo', 'Dune', 'Il Faro di Prova', 'Oppenheimer']);
    const film = itemOf(BR2049)[0]?.id ?? '';
    expect(all<{ type: string; source: string }>('SELECT type, source FROM artwork WHERE item_id = ? ORDER BY type', film)).toEqual([
      { type: 'backdrop', source: 'tmdb' },
      { type: 'logo', source: 'tmdb' },
      { type: 'poster', source: 'tmdb' },
    ]);
    expect(all<{ value: string }>("SELECT value FROM item_field WHERE item_id = ? AND field = 'overview' AND source = 'tmdb'", film)).toHaveLength(1);
  });

  it('Dark: series, season and episodes enriched; the episode stills downloaded', () => {
    const series = all<{ id: string; title: string }>("SELECT id, title FROM catalog_item WHERE kind = 'series'");
    expect(series.map((x) => x.title)).toEqual([SHOW.name]);
    const eps = all<{ episode_number: number; title: string }>("SELECT episode_number, title FROM catalog_item WHERE kind = 'episode' ORDER BY episode_number");
    expect(eps.map((e) => e.title)).toEqual([SEASON_1.episodes[0]?.name, 'Episodio 2', SEASON_1.episodes[2]?.name]);
    const stills = all<{ n: number }>("SELECT count(*) AS n FROM artwork a JOIN catalog_item i ON i.id = a.item_id WHERE i.kind = 'episode' AND a.type = 'still'");
    expect(stills).toEqual([{ n: 2 }]);
  });

  it('the trailer keeps its file title; nothing was written into the media roots', () => {
    expect(itemOf(TRAILER)).toMatchObject([{ kind: 'extra', title: 'Trailer' }]);
    expect(all<{ local_path: string }>('SELECT local_path FROM artwork').every((a) => !a.local_path.includes('..'))).toBe(true);
  });

  it('the token travelled only in the Authorization header', () => {
    expect(fetch.calls.some((c) => c.url.includes(TOKEN))).toBe(false);
    expect(fetch.calls.filter((c) => c.url.startsWith('https://api.themoviedb.org/')).every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});
