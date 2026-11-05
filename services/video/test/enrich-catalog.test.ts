// Catalog write additions of F1a.4: list-valued fields, the TMDB lock rule, credits, artwork rows,
// refresh state, expiry by cutoff, purge; and the identifier's case maintenance.
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { type CatalogWriter, createCatalogWriter } from '../src/modules/catalog/write.ts';
import { identifierModule } from '../src/modules/identifier/index.ts';
import { dropProviderCandidates, pullForwardPending } from '../src/modules/identifier/maintenance.ts';
import { enqueueJob } from '../src/modules/jobs/index.ts';
import type { ModuleContext } from '../src/app/module.ts';
import { loadConfig } from '../src/app/config.ts';
import type { ArtworkInput, SourcedFieldValues } from '../src/shared/ports.ts';

const DAY = 86_400_000;
const MAX_AGE = 180 * DAY;
let db: Db;
let clock: number;
let w: CatalogWriter;
let queued: { type: string; idempotencyKey?: string; runAt?: number }[];

beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
  clock = 1_000 * DAY;
  queued = [];
  w = createCatalogWriter({
    db,
    now: () => clock,
    events: () => ({ publish: () => undefined }),
    jobs: () => ({ enqueue: (j) => (queued.push(j), 'id') }),
    tmdbMaxAgeMs: MAX_AGE,
  });
});
afterEach(() => closeDb(db));

const src = (source: SourcedFieldValues['source'], values: SourcedFieldValues['values'], fetchedAt = clock): SourcedFieldValues => ({ source, fetchedAt, values });
const movie = () => w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q1' }, fields: [src('wikidata', { title: 'WD' })] }).itemId;
const value = (itemId: string, field: string, source: string) =>
  (db.$client.prepare('SELECT value FROM item_field WHERE item_id = ? AND field = ? AND source = ?').get(itemId, field, source) as { value: string } | undefined)?.value;
const title = (id: string) => (db.$client.prepare('SELECT title FROM catalog_item WHERE id = ?').get(id) as { title: string }).title;
const art = (over: Partial<ArtworkInput> = {}): ArtworkInput => ({
  type: 'poster',
  language: 'it',
  localPath: 'AB/ABCDEFGHIJ/w780.jpg',
  remoteRef: '/p.jpg',
  width: 780,
  height: 1170,
  fetchedAt: clock,
  ...over,
});

describe('catalog writes for the Enricher', () => {
  it('enqueues metadata.enrich for a new work, for new ids, and (delayed) for the series of a new episode', () => {
    const id = movie();
    w.addExternalIds(id, { wikidata: 'Q1' });
    w.addExternalIds(id, { imdb: 'tt1' });
    const series = w.upsertWork({ kind: 'series', editionLabel: null, externalIds: { wikidata: 'Q2' }, fields: [] }).itemId;
    const season = w.ensureSeason(series, 1).itemId;
    w.ensureEpisode(season, 1);
    w.ensureEpisode(season, 1); // existing: nothing
    expect(queued.map((j) => [j.idempotencyKey, j.runAt ? j.runAt - clock : 0])).toEqual([
      [`enrich:${id}`, 0],
      [`enrich:${id}`, 0],
      [`enrich:${series}`, 0],
      [`enrich:${series}`, 60_000],
      [`enrich:${series}`, 60_000],
    ]);
  });

  it('list values (genres) are stored as JSON; an empty list deletes', () => {
    const id = movie();
    w.writeFields(id, [src('tmdb', { genres: ['Dramma', 'Mistero'], overview: 'Trama' })]);
    expect(JSON.parse(value(id, 'genres', 'tmdb') ?? 'null')).toEqual(['Dramma', 'Mistero']);
    w.writeFields(id, [src('tmdb', { genres: [], overview: '  ' })]);
    expect([value(id, 'genres', 'tmdb'), value(id, 'overview', 'tmdb')]).toEqual([undefined, undefined]);
  });

  it('a lock on TMDB keeps the old value when TMDB sends another; the same value refreshes fetched_at', () => {
    const id = movie();
    w.writeFields(id, [src('tmdb', { title: 'Vecchio' }, clock - DAY)]);
    db.$client.prepare("INSERT INTO field_lock (item_id, field, source, locked_at) VALUES (?, 'title', 'tmdb', 0)").run(id);
    w.writeFields(id, [src('tmdb', { title: 'Nuovo' })]);
    expect(title(id)).toBe('Vecchio');
    w.writeFields(id, [src('tmdb', { title: null })]);
    expect(title(id)).toBe('Vecchio');
    w.writeFields(id, [src('tmdb', { title: 'Vecchio' })]);
    expect((db.$client.prepare("SELECT fetched_at AS t FROM item_field WHERE item_id = ? AND field = 'title' AND source = 'tmdb'").get(id) as { t: number }).t).toBe(clock);
    // A manual value is the owner's: a lock on manual never blocks the owner's edits.
    db.$client.prepare("UPDATE field_lock SET source = 'manual'").run();
    w.writeFields(id, [src('manual', { title: 'Mio' })]);
    w.writeFields(id, [src('manual', { title: 'Mio 2' })]);
    expect(title(id)).toBe('Mio 2');
  });

  it('credits per source: replaced, persons reused by ref, orphans removed', () => {
    const id = movie();
    w.replaceCredits(id, 'tmdb', [
      { name: 'A', role: 'actor', character: 'X', order: 0, personRef: '1' },
      { name: 'B', role: 'director', character: null, order: 0, personRef: '2' },
    ]);
    w.replaceCredits(id, 'tmdb', [{ name: 'A renamed', role: 'actor', character: 'X', order: 0, personRef: '1' }]);
    expect(db.$client.prepare('SELECT name, source FROM person ORDER BY name').all()).toEqual([{ name: 'A renamed', source: 'tmdb' }]);
    expect(db.$client.prepare('SELECT role, character FROM credit').all()).toEqual([{ role: 'actor', character: 'X' }]);
  });

  it('artwork rows: replaced per (item, source, type); a file still used elsewhere is not reported; owner choice kept', () => {
    const a = movie();
    const b = w.upsertWork({ kind: 'movie', editionLabel: 'Extended', externalIds: { wikidata: 'Q1' }, fields: [] }).itemId;
    expect(w.setArtwork(a, 'tmdb', 'poster', [art()])).toEqual([]);
    w.setArtwork(b, 'tmdb', 'poster', [art()]);
    db.$client.prepare('UPDATE artwork SET selected = 1 WHERE item_id = ?').run(a);
    expect(w.setArtwork(a, 'tmdb', 'poster', [art()])).toEqual([]);
    expect(w.listArtwork(a)[0]?.selected).toBe(true);
    expect(w.setArtwork(a, 'tmdb', 'poster', [art({ localPath: 'CD/CDEFGHIJKL/w780.jpg' })])).toEqual([]); // b still uses the old one
    // By key directory: another file of the same key still counts as a reference.
    w.setArtwork(a, 'wikidata', 'poster', [art({ localPath: 'AB/ABCDEFGHIJ/original.jpg' })]);
    expect(w.setArtwork(b, 'tmdb', 'poster', [])).toEqual([]);
    expect(w.setArtwork(a, 'wikidata', 'poster', [])).toEqual(['AB/ABCDEFGHIJ/original.jpg']);
    expect(w.findArtworkByKey('CDEFGHIJKL')?.itemId).toBe(a);
    expect(w.findArtworkByKey('ABCDEFGHIJ')).toBeNull();
    expect(w.findArtworkByKey('../etc')).toBeNull();
  });

  it('findArtworkByKey: a TMDB row of the file wins, so its cache policy applies', () => {
    const a = movie();
    const b = w.upsertWork({ kind: 'movie', editionLabel: 'B', externalIds: { wikidata: 'Q1' }, fields: [] }).itemId;
    w.setArtwork(a, 'wikidata', 'poster', [art({ localPath: 'ZZ/ZZZZZZZZZZ/original.jpg' })]);
    w.setArtwork(b, 'tmdb', 'poster', [art({ localPath: 'ZZ/ZZZZZZZZZZ/original.jpg' })]);
    expect(w.findArtworkByKey('ZZZZZZZZZZ')?.source).toBe('tmdb');
  });

  it('refresh state: the newest TMDB value (the last refresh), or older TMDB artwork of the work', () => {
    const id = movie();
    // A value no refresh rewrites (here: year, 5 days old) must not make the work due every day.
    w.writeFields(id, [src('tmdb', { title: 'T', overview: 'O' }, clock - 2 * DAY), src('tmdb', { year: 2000 }, clock - 5 * DAY)]);
    const series = w.upsertWork({ kind: 'series', editionLabel: null, externalIds: { wikidata: 'Q9' }, fields: [] }).itemId;
    w.ensureSeason(series, 1);
    expect(w.listWorkRefreshState()).toEqual([
      { itemId: id, kind: 'movie', tmdbFetchedAt: clock - 2 * DAY, wikidataFetchedAt: clock },
      { itemId: series, kind: 'series', tmdbFetchedAt: null, wikidataFetchedAt: null },
    ]);
    w.setArtwork(id, 'tmdb', 'poster', [art({ fetchedAt: clock - 9 * DAY })]);
    w.setArtwork(series, 'tmdb', 'poster', [art({ localPath: 'SE/SERIESPOSTER/w780.jpg', fetchedAt: clock - 3 * DAY })]);
    expect(w.listWorkRefreshState().map((r) => r.tmdbFetchedAt)).toEqual([clock - 9 * DAY, clock - 3 * DAY]);
  });

  it('a lock on any provider source keeps its value against automatic writes of that source', () => {
    const id = movie();
    db.$client.prepare("INSERT INTO field_lock (item_id, field, source, locked_at) VALUES (?, 'title', 'wikidata', 0)").run(id);
    w.writeFields(id, [src('wikidata', { title: 'WD changed' })]);
    expect(value(id, 'title', 'wikidata')).toBe('"WD"');
    w.writeFields(id, [src('filename', { title: 'file' })]); // other sources are not locked
    expect(value(id, 'title', 'filename')).toBe('"file"');
  });

  it('hasSourceData and markImageMissing', () => {
    const id = movie();
    expect(w.hasSourceData('tmdb')).toBe(false);
    w.setArtwork(id, 'tmdb', 'poster', [art()]);
    expect(w.hasSourceData('tmdb')).toBe(true);
    w.markImageMissing('ABCDEFGHIJ');
    expect(w.listArtwork(id)[0]?.fetchedAt).toBe(0);
  });

  it('expireSource drops only what is older than the cutoff and recomputes those items', () => {
    const old = movie();
    const fresh = w.upsertWork({ kind: 'movie', editionLabel: 'F', externalIds: { wikidata: 'Q1' }, fields: [src('wikidata', { title: 'WD2' })] }).itemId;
    w.writeFields(old, [src('tmdb', { title: 'TMDB old' }, clock - 200 * DAY)]);
    w.writeFields(fresh, [src('tmdb', { title: 'TMDB fresh' }, clock - DAY)]);
    w.replaceCredits(old, 'tmdb', [{ name: 'Old', role: 'actor', character: null, order: 0, personRef: '1' }]);
    w.replaceCredits(fresh, 'tmdb', [{ name: 'Fresh', role: 'actor', character: null, order: 0, personRef: '2' }]);
    w.setArtwork(old, 'tmdb', 'poster', [art({ fetchedAt: clock - 200 * DAY })]);
    w.setArtwork(fresh, 'tmdb', 'poster', [art({ localPath: 'FR/FRESHFRESH/w780.jpg' })]);
    const r = w.expireSource('tmdb', clock - MAX_AGE);
    expect(r).toEqual({ itemIds: [old], unreferencedPaths: ['AB/ABCDEFGHIJ/w780.jpg'] });
    expect([title(old), title(fresh)]).toEqual(['WD', 'TMDB fresh']);
    expect(db.$client.prepare('SELECT p.name FROM credit c JOIN person p ON p.id = c.person_id').all()).toEqual([{ name: 'Fresh' }]);
    expect(w.listArtwork(fresh)).toHaveLength(1);
    expect(w.purgeSource('tmdb')).toEqual({ itemIds: [fresh], unreferencedPaths: ['FR/FRESHFRESH/w780.jpg'] });
    expect(w.purgeSource('tmdb')).toEqual({ itemIds: [], unreferencedPaths: [] });
  });
});

describe('identifier maintenance', () => {
  beforeEach(() => {
    db.$client.prepare("INSERT INTO library_root (id, name, mount_path, hint, created_at) VALUES ('r', 'Film', '/m', 'movies', 0)").run();
    for (const f of ['f1', 'f2', 'f3']) {
      db.$client.prepare("INSERT INTO media_file (id, root_id, rel_path, size_bytes, mtime_ms, state, created_at, updated_at) VALUES (?, 'r', ?, 1, 0, 'analyzed', 0, 0)").run(f, `${f}.mkv`);
    }
    const cands = JSON.stringify([
      { ref: { provider: 'tmdb', id: '1', kind: 'movie' }, provider: 'tmdb', title: 'T' },
      { ref: { provider: 'wikidata', id: 'Q1', kind: 'movie' }, provider: 'wikidata', title: 'W' },
    ]);
    const ins = db.$client.prepare("INSERT INTO identification_case (id, file_id, state, reason, candidates, created_at, updated_at) VALUES (?, ?, ?, 'ambiguous', ?, 0, ?)");
    ins.run('c1', 'f1', 'needs_review', cands, 10);
    ins.run('c2', 'f2', 'pending', cands, 1000);
    ins.run('c3', 'f3', 'pending', '[]', 1000);
  });
  const providers = (id: string) => (JSON.parse((db.$client.prepare('SELECT candidates FROM identification_case WHERE id = ?').get(id) as { candidates: string }).candidates) as { provider: string }[]).map((c) => c.provider);

  it('dropProviderCandidates: by age for expiry, all for purge; updated_at untouched', () => {
    expect(dropProviderCandidates(db, 'tmdb', 100)).toBe(1);
    expect([providers('c1'), providers('c2')]).toEqual([['wikidata'], ['tmdb', 'wikidata']]);
    expect(dropProviderCandidates(db, 'tmdb', null)).toBe(1);
    expect(providers('c2')).toEqual(['wikidata']);
    expect(dropProviderCandidates(db, 'tmdb', null)).toBe(0);
    expect(db.$client.prepare('SELECT updated_at AS u FROM identification_case ORDER BY id').all()).toEqual([{ u: 10 }, { u: 1000 }, { u: 1000 }]);
  });

  it('at start, deferred identify jobs of pending cases become due now; the periodic runs at start', async () => {
    // f4: pending, but its file is missing (not analyzed): left alone, like requeuePending does.
    db.$client.prepare("INSERT INTO media_file (id, root_id, rel_path, size_bytes, mtime_ms, state, created_at, updated_at) VALUES ('f4', 'r', 'f4.mkv', 1, 0, 'missing', 0, 0)").run();
    db.$client.prepare("INSERT INTO identification_case (id, file_id, state, reason, candidates, created_at, updated_at) VALUES ('c4', 'f4', 'pending', 'ambiguous', '[]', 0, 0)").run();
    for (const f of ['f1', 'f2', 'f4']) enqueueJob(db, 0, { type: 'identifier.identify', payload: { fileId: f }, idempotencyKey: `identify:${f}`, runAt: 6 * 3600_000 });
    expect(pullForwardPending(db, 5)).toBe(1); // f1 is in review, not pending
    expect(db.$client.prepare('SELECT idempotency_key AS k, run_at AS r FROM job ORDER BY k').all()).toEqual([
      { k: 'identify:f1', r: 6 * 3600_000 },
      { k: 'identify:f2', r: 5 },
      { k: 'identify:f4', r: 6 * 3600_000 },
    ]);
    const ctx = {
      config: loadConfig({ NODE_ENV: 'test', DATA_DIR: '/tmp/x' }),
      db,
      log: pino({ level: 'silent' }),
      now: () => 7,
      ports: { jobs: { enqueue: (j: Parameters<typeof enqueueJob>[2]) => enqueueJob(db, 7, j) } },
    } as unknown as ModuleContext;
    const task = identifierModule()(ctx).periodic?.find((p) => p.name === 'identifier.requeue_pending');
    expect(task?.runAtStart).toBe(true);
    await task?.run();
    expect(db.$client.prepare("SELECT idempotency_key AS k, run_at AS r FROM job WHERE idempotency_key = 'identify:f3'").get()).toEqual({ k: 'identify:f3', r: 7 });
  });
});
