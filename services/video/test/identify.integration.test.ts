// Identification integration: scan → probe → identify on the S1 sample library with real ffprobe,
// through compose() with the real library, analyzer, identifier and catalog modules. Metadata comes
// from an in-memory port with Wikidata-like (CC0) candidates; no provider is called. Needs ffprobe
// and the samples (PZF_MEDIA_SAMPLES, FFPROBE_PATH); skipped with a message otherwise.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import type { ModuleFactory } from '../src/app/module.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createAnalyzerModule } from '../src/modules/analyzer/index.ts';
import { createCatalogModule } from '../src/modules/catalog/index.ts';
import { createEventsModule } from '../src/modules/events/index.ts';
import { createIdentifierModule } from '../src/modules/identifier/index.ts';
import { normalizeTitle } from '../src/modules/identifier/normalize.ts';
import { createJobRunner, createJobsModule } from '../src/modules/jobs/index.ts';
import { libraryModule } from '../src/modules/library/index.ts';
import type { MetadataCandidate } from '../src/shared/metadata.ts';
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
if (skipReason) process.stderr.write(`[identify] skipped: ${skipReason}\n`);

const BR2049 = 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv';
const TRAILER = 'Blade Runner 2049 (2017)/extras/Trailer.mkv';
const DUNE = 'Dune (2021)/Dune.2021.2160p.UHD.BluRay.REMUX.DV.HDR.mkv';
const BUONO = 'Il Buono, il Brutto, il Cattivo (1966)/Il.Buono.il.Brutto.il.Cattivo.1966.1080p.BluRay.REMUX.mkv';
const LONG = 'Long Test (2024)/Long Test (2024) - 2160p.mkv';
const BDMV = 'misc/BDMV_DISC1_t00.mkv';
const OPPENHEIMER = 'Oppenheimer (2023)/Oppenheimer (2023).mkv';
const DARK1 = 'Dark (2017)/Season 01/Dark - S01E01 - Segreti.mkv';
const DARK2 = 'Dark (2017)/Season 01/Dark - S01E02-E03.mkv';

// Wikidata-like candidates (CC0): each search returns the work and a homonym or two.
const WIKIDATA: Record<string, MetadataCandidate[]> = {
  'blade runner 2049': [
    cand({ id: 'Q21451539', title: 'Blade Runner 2049', original: ['Blade Runner 2049'], years: [2017], ids: { imdb: 'tt1856101' } }),
    cand({ id: 'Q184843', title: 'Blade Runner', original: ['Blade Runner'], years: [1982] }),
  ],
  dune: [
    cand({ id: 'Q63985561', title: 'Dune', original: ['Dune'], years: [2021, 2020] }),
    cand({ id: 'Q470283', title: 'Dune', original: ['Dune'], years: [1984] }),
    cand({ id: 'Q1197640', kind: 'series', title: 'Dune - Il destino dell’universo', original: ['Frank Herbert’s Dune'], years: [2000] }),
  ],
  'buono brutto cattivo': [cand({ id: 'Q131390', title: 'Il buono, il brutto, il cattivo', original: ['Il buono, il brutto, il cattivo'], years: [1966] })],
  oppenheimer: [cand({ id: 'Q108839994', title: 'Oppenheimer', original: ['Oppenheimer'], years: [2023] })],
  dark: [
    cand({ id: 'Q24300155', kind: 'series', title: 'Dark', original: ['Dark'], years: [2017] }),
    cand({ id: 'Q1165470', title: 'Dark', years: [2015] }),
  ],
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
const createFakeMetadataModule: ModuleFactory = () => ({ name: 'metadata', provides: { metadataSearch: metadata } });

const log = pino({ level: 'silent' });
let db: Db;
let dataDir: string | undefined;

const all = <T>(sql: string, ...a: unknown[]) => db.$client.prepare(sql).all(...a) as T[];
interface Linked {
  rel_path: string;
  state: string;
  item_id: string | null;
  kind: string | null;
  parent_id: string | null;
  title: string | null;
  year: number | null;
  episode_number: number | null;
  duration_ms: number | null;
}
const linked = (rel: string) =>
  all<Linked>(
    `SELECT f.rel_path, f.state, i.id AS item_id, i.kind, i.parent_id, i.title, i.year, i.episode_number, i.duration_ms
     FROM media_file f LEFT JOIN media_link l ON l.file_id = f.id LEFT JOIN catalog_item i ON i.id = l.item_id
     WHERE f.rel_path = ? ORDER BY i.episode_number`,
    rel,
  );
const caseOf = (rel: string) =>
  all<{ state: string; reason: string | null }>('SELECT c.state, c.reason FROM identification_case c JOIN media_file f ON f.id = c.file_id WHERE f.rel_path = ?', rel)[0];
const itemsOf = (kind: string) => all<{ id: string; title: string; parent_id: string | null }>('SELECT id, title, parent_id FROM catalog_item WHERE kind = ? ORDER BY sort_title', kind);

describe.skipIf(skipReason !== null)('identification of the sample library (scan → probe → identify)', () => {
  beforeAll(async () => {
    db = await openDb({ path: ':memory:' });
    dataDir = mkdtempSync(join(tmpdir(), 'pzf-identify-'));
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
      ],
    });
    for (const m of comp.modules) await m.start?.();
    const runner = createJobRunner({ db, log, jobTypes: comp.jobTypes, periodic: comp.periodic });
    await comp.periodic.find((p) => p.name === 'library.scan')?.run();
    await runner.drain();
    await runner.stop();
  }, 180_000);
  afterAll(() => {
    if (db) closeDb(db);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs every job to completion', () => {
    expect(all("SELECT DISTINCT type, state FROM job WHERE type <> 'delivery.keyframe_index' ORDER BY type")).toEqual([
      { type: 'analyzer.probe', state: 'done' },
      { type: 'identifier.identify', state: 'done' },
      { type: 'library.scan', state: 'done' },
      // Enqueued by the catalog for the new works; the fake metadata module here has no Enricher.
      { type: 'metadata.enrich', state: 'queued' },
    ]);
    // The analyzer enqueues the keyframe index for delivery, which is not composed here.
    expect(all("SELECT DISTINCT state FROM job WHERE type = 'delivery.keyframe_index'")).toEqual([{ state: 'queued' }]);
  });

  it('identifies the films, each once, with the container duration', () => {
    expect(itemsOf('movie').map((m) => m.title)).toEqual(['Blade Runner 2049', 'Il buono, il brutto, il cattivo', 'Dune', 'Oppenheimer']);
    for (const rel of [BR2049, DUNE, BUONO, OPPENHEIMER]) {
      const [l, ...rest] = linked(rel);
      expect(rest).toEqual([]);
      expect(l).toMatchObject({ state: 'identified', kind: 'movie', parent_id: null });
      expect(caseOf(rel)).toEqual({ state: 'auto_matched', reason: null });
    }
    expect(linked(DUNE)[0]).toMatchObject({ title: 'Dune', year: 2021 });
    expect(linked(BR2049)[0]?.duration_ms).toBe(30_005);
  });

  it('builds Dark → season 1 → episodes 1, 2, 3; the double episode is linked twice', () => {
    const [series, ...moreSeries] = itemsOf('series');
    expect(moreSeries).toEqual([]);
    expect(series).toMatchObject({ title: 'Dark', parent_id: null });
    const seasons = itemsOf('season');
    expect(seasons).toEqual([{ id: seasons[0]?.id, title: 'Stagione 1', parent_id: series?.id }]);
    expect(itemsOf('episode').map((e) => [e.title, e.parent_id])).toEqual([
      ['Segreti', seasons[0]?.id],
      ['Episodio 2', seasons[0]?.id],
      ['Episodio 3', seasons[0]?.id],
    ]);
    expect(linked(DARK1).map((l) => l.episode_number)).toEqual([1]);
    expect(linked(DARK2).map((l) => [l.state, l.episode_number])).toEqual([
      ['identified', 2],
      ['identified', 3],
    ]);
  });

  it('attaches the trailer to Blade Runner 2049', () => {
    const film = linked(BR2049)[0]?.item_id;
    expect(linked(TRAILER)).toMatchObject([{ state: 'identified', kind: 'extra', parent_id: film, title: 'Trailer' }]);
    expect(itemsOf('extra')).toHaveLength(1);
  });

  it('sends the disc rip and the unknown title to review, without catalog items', () => {
    expect(caseOf(BDMV)).toEqual({ state: 'needs_review', reason: 'no_title' });
    expect(caseOf(LONG)).toEqual({ state: 'needs_review', reason: 'no_candidates' });
    for (const rel of [BDMV, LONG]) expect(linked(rel)).toMatchObject([{ state: 'needs_review', item_id: null }]);
    expect(all("SELECT count(*) AS n FROM domain_event WHERE type = 'identification.needs_review'")).toEqual([{ n: 2 }]);
  });

  it('keeps projection and search in step, and never asked TMDB', () => {
    const search = (q: string) => all<{ title: string }>('SELECT title FROM catalog_search WHERE catalog_search MATCH ? ORDER BY title', q).map((r) => r.title);
    expect(search('runner')).toEqual(['Blade Runner 2049']);
    expect(search('dark')).toEqual(['Dark']);
    expect(all('SELECT count(*) AS n FROM catalog_search')).toEqual(all('SELECT count(*) AS n FROM catalog_item'));
    expect(metadata.calls.every((c) => c.provider === 'wikidata')).toBe(true);
  });
});
