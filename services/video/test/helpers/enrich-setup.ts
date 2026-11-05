// A composed Video Service for Enricher tests: events, jobs, identifier, catalog and the real
// metadata module behind a fake fetch and a fake clock, on an in-memory DB and a temp data dir.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { compose, type Composition } from '../../src/app/compose.ts';
import { type Config, loadConfig } from '../../src/app/config.ts';
import { closeDb, type Db, openDb } from '../../src/db/index.ts';
import { createCatalogModule } from '../../src/modules/catalog/index.ts';
import { createEventsModule } from '../../src/modules/events/index.ts';
import { createIdentifierModule } from '../../src/modules/identifier/index.ts';
import { createJobRunner, createJobsModule, type JobRunner } from '../../src/modules/jobs/index.ts';
import { metadataModule } from '../../src/modules/metadata/index.ts';
import { claim, wdEntity, wikidataRoutes } from './wikidata-entities.ts';
import { type FakeClock, type FakeFetch, fakeClock, fakeFetch } from './metadata-fetch.ts';
import { MOVIE, MOVIE_NO_IT, SHOW, tmdbRoutes, TOKEN } from './tmdb-synthetic.ts';

export const DAY = 86_400_000;

// Wikidata side of the synthetic works (CC0-like data, invented ids): the bridge to TMDB is P4947/P4983.
export const WD_MOVIE = wdEntity('Q99000001', { it: 'Il faro (Wikidata)', en: 'The Test Lighthouse' }, {
  P31: [claim.item('Q11424')],
  P577: [claim.time('+2019-03-14T00:00:00Z')],
  P1476: [claim.text('The Test Lighthouse', 'en')],
  P4947: [claim.str(String(MOVIE.id))],
  P345: [claim.str('tt9000001')],
  P136: [claim.item('Q130232')],
  P57: [claim.item('Q99000100')],
  P18: [claim.str('Faro di prova.jpg')],
});
export const WD_MOVIE_NO_IT = wdEntity('Q99000002', { it: 'Cosa non tradotta', en: 'Untranslated Thing' }, {
  P31: [claim.item('Q11424')],
  P577: [claim.time('+2019-01-01T00:00:00Z')],
  P4947: [claim.str(String(MOVIE_NO_IT.id))],
});
export const WD_SHOW = wdEntity('Q98000001', { it: 'Serie di prova (WD)', en: 'Test Series' }, {
  P31: [claim.item('Q5398426')],
  P580: [claim.time('+2017-12-01T00:00:00Z')],
  P1476: [claim.text('Testserie', 'de')],
  P4983: [claim.str(String(SHOW.id))],
});
export const WD_LABELS = [
  wdEntity('Q130232', { it: 'film drammatico', en: 'drama film' }),
  wdEntity('Q11424', { it: 'film', en: 'film' }),
  wdEntity('Q5398426', { it: 'serie televisiva', en: 'television series' }),
  wdEntity('Q99000100', { it: 'Regista Inventato', en: 'Regista Inventato' }),
];

export interface Setup {
  db: Db;
  config: Config;
  comp: Composition;
  clock: FakeClock;
  fetch: FakeFetch;
  runner: JobRunner;
  dataDir: string;
  close(): void;
}

/**
 * reuse: a restart of that setup's service (same DB, data dir, clock and fetch). Close only the
 * last one: they share the DB.
 */
export async function setup(opts: { tmdb?: boolean; purge?: boolean; wikidata?: boolean; env?: Record<string, string>; start?: number; reuse?: Setup } = {}): Promise<Setup> {
  const db = opts.reuse?.db ?? (await openDb({ path: ':memory:' }));
  const dataDir = opts.reuse?.dataDir ?? mkdtempSync(join(tmpdir(), 'pzf-enrich-'));
  const clock = opts.reuse?.clock ?? fakeClock(opts.start ?? 1_000 * DAY);
  const fetch = opts.reuse?.fetch ?? fakeFetch([
    ...wikidataRoutes({
      entities: [WD_MOVIE, WD_MOVIE_NO_IT, WD_SHOW, ...WD_LABELS],
      episodes: { Q98000001: [{ season: 1, episode: 1, it: 'Segreti (WD)' }, { season: 1, episode: 2, en: 'Lies' }] },
    }),
    ...tmdbRoutes(),
  ]);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    LIBRARY_ROOTS: '[]',
    WIKIDATA_ENABLED: opts.wikidata === false ? 'false' : 'true',
    ...(opts.tmdb === false ? {} : { TMDB_READ_TOKEN: TOKEN }),
    ...(opts.purge ? { TMDB_PURGE: 'true' } : {}),
    ...opts.env,
  });
  const log = pino({ level: 'silent' });
  const comp = compose({
    config,
    db,
    log,
    now: clock.now,
    factories: [createEventsModule, createJobsModule, createIdentifierModule, metadataModule({ fetch, clock }), createCatalogModule],
  });
  for (const m of comp.modules) await m.start?.();
  const runner = createJobRunner({ db, log, jobTypes: comp.jobTypes, periodic: comp.periodic, now: clock.now });
  return {
    db,
    config,
    comp,
    clock,
    fetch,
    runner,
    dataDir,
    close() {
      closeDb(db);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
