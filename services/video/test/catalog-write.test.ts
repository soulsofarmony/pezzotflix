// Catalog write side: field resolution, locks, TMDB expiry, projection + FTS in the same transaction,
// work identity by external id (D2), the series hierarchy and extras.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { resolveField, sortTitleOf, type FieldRow } from '../src/modules/catalog/resolve.ts';
import { type CatalogWriter, createCatalogWriter, ITEM_ADDED, ITEM_UPDATED } from '../src/modules/catalog/write.ts';
import type { SourcedFieldValues, WorkInput } from '../src/shared/ports.ts';

const DAY = 86_400_000;
const MAX_AGE = 180 * DAY;
let db: Db;
let clock: number;
let events: { type: string; payload: Record<string, unknown> }[];
let w: CatalogWriter;

beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
  clock = 1_000 * DAY;
  events = [];
  w = createCatalogWriter({ db, now: () => clock, events: () => ({ publish: (type, payload) => events.push({ type, payload }) }), tmdbMaxAgeMs: MAX_AGE });
});
afterEach(() => closeDb(db));

const src = (source: SourcedFieldValues['source'], values: SourcedFieldValues['values'], fetchedAt = clock): SourcedFieldValues => ({ source, fetchedAt, values });
const movie = (over: Partial<WorkInput> = {}): WorkInput => ({
  kind: 'movie',
  editionLabel: null,
  externalIds: { wikidata: 'Q21451539', tmdb: '335984', imdb: 'tt1856101' },
  fields: [src('wikidata', { title: 'Blade Runner 2049', originalTitle: 'Blade Runner 2049', year: 2017 }), src('filename', { title: 'blade runner 2049', year: 2017 })],
  ...over,
});
const row = (id: string) =>
  db.$client.prepare('SELECT kind, parent_id, title, original_title, sort_title, year, category, duration_ms, season_number, episode_number, edition_label FROM catalog_item WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
const search = (q: string) => (db.$client.prepare('SELECT item_id FROM catalog_search WHERE catalog_search MATCH ?').all(q) as { item_id: string }[]).map((r) => r.item_id);
const count = (table: string) => (db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('field resolution (pure)', () => {
  const rows: FieldRow[] = [
    { field: 'title', source: 'filename', value: 'blade runner', fetchedAt: 0 },
    { field: 'title', source: 'wikidata', value: 'Blade Runner (wd)', fetchedAt: 0 },
    { field: 'title', source: 'tmdb', value: 'Blade Runner (tmdb)', fetchedAt: 900 },
    { field: 'originalTitle', source: 'tmdb', value: 'BR tmdb', fetchedAt: 900 },
    { field: 'originalTitle', source: 'wikidata', value: 'BR wd', fetchedAt: 0 },
  ];
  it.each([
    ['title', rows, null, 1_000, 'Blade Runner (tmdb)', 'tmdb'],
    ['title', [...rows, { field: 'title', source: 'manual', value: 'Mine', fetchedAt: 0 }], null, 1_000, 'Mine', 'manual'],
    ['title', rows, null, 900 + MAX_AGE + 1, 'Blade Runner (wd)', 'wikidata'], // TMDB expired
    ['title', rows, 'filename', 1_000, 'blade runner', 'filename'], // locked
    ['title', rows, 'manual', 1_000, 'Blade Runner (tmdb)', 'tmdb'], // lock without a value falls back
    ['title', rows, 'tmdb', 900 + MAX_AGE + 1, 'Blade Runner (wd)', 'wikidata'], // even locked, expired TMDB is never shown
    ['originalTitle', rows, null, 1_000, 'BR wd', 'wikidata'], // original title prefers Wikidata
    ['year', rows, null, 1_000, undefined, undefined],
  ] as const)('%s, lock %j at %j → %j', (field, rs, lock, now, value, source) => {
    const r = resolveField(field, rs, lock, now, MAX_AGE);
    expect(r?.value).toBe(value);
    expect(r?.source).toBe(source);
  });

  it.each([
    ['Il buono, il brutto, il cattivo', 'buono, il brutto, il cattivo'],
    ["L'ultimo samurai", 'ultimo samurai'],
    ['The Élite', 'elite'],
    ['A', 'a'],
  ])('sortTitle(%j) = %j', (t, exp) => {
    expect(sortTitleOf(t, { kind: 'movie', seasonNumber: null, episodeNumber: null })).toBe(exp);
  });
});

describe('works', () => {
  it('creates a work with projection, ids and search row, and publishes item_added', () => {
    const r = w.upsertWork(movie());
    expect(r.created).toBe(true);
    expect(row(r.itemId)).toMatchObject({ kind: 'movie', parent_id: null, title: 'Blade Runner 2049', original_title: 'Blade Runner 2049', year: 2017, category: 'film' });
    expect(search('runner')).toEqual([r.itemId]);
    expect(count('external_id')).toBe(3);
    expect(events).toEqual([{ type: ITEM_ADDED, payload: { itemId: r.itemId, kind: 'movie', parentId: null } }]);
  });

  it('D2: a second file of the same work ends on the same item, matched by any id in QID → TMDB → IMDb order', () => {
    const a = w.upsertWork(movie());
    const b = w.upsertWork(movie({ externalIds: { imdb: 'tt1856101' }, fields: [src('tmdb', { title: 'Blade Runner 2049 (TMDB)' })] }));
    expect(b).toEqual({ itemId: a.itemId, created: false });
    expect(count('catalog_item')).toBe(1);
    expect(row(a.itemId).title).toBe('Blade Runner 2049 (TMDB)');
    expect(events.at(-1)).toEqual({ type: ITEM_UPDATED, payload: { itemId: a.itemId, kind: 'movie' } });
    expect(w.findWork('movie', { tmdb: '335984' }, null)).toBe(a.itemId);
    expect(w.findWork('series', { tmdb: '335984' }, null)).toBeNull(); // TMDB movie and TV ids are different spaces
  });

  it('another edition of the same work is a separate item (different cuts are separate items)', () => {
    const theatrical = w.upsertWork(movie());
    const cut = w.upsertWork(movie({ editionLabel: "Director's Cut" }));
    expect(cut.created).toBe(true);
    expect(cut.itemId).not.toBe(theatrical.itemId);
    expect(w.upsertWork(movie({ editionLabel: "  director's   cut " })).itemId).toBe(cut.itemId);
    expect(row(cut.itemId).edition_label).toBe("Director's Cut");
  });

  it('writeFields replaces a source value, deletes on null, and refreshes the projection and FTS', () => {
    const { itemId } = w.upsertWork(movie());
    w.writeFields(itemId, [src('manual', { title: 'Il mio Blade Runner' })]);
    expect(row(itemId).title).toBe('Il mio Blade Runner');
    expect(search('mio')).toEqual([itemId]);
    expect(search('runner')).toEqual([itemId]); // original title still indexed
    w.writeFields(itemId, [src('manual', { title: null })]);
    expect(row(itemId).title).toBe('Blade Runner 2049');
    expect(search('mio')).toEqual([]);
    expect(count('catalog_search')).toBe(1);
  });

  it('a lock keeps its source; refresh applies the TMDB expiry', () => {
    const { itemId } = w.upsertWork(movie({ fields: [src('wikidata', { title: 'WD title' }), src('tmdb', { title: 'TMDB title' })] }));
    expect(row(itemId).title).toBe('TMDB title');
    db.$client.prepare("INSERT INTO field_lock (item_id, field, source, locked_at) VALUES (?, 'title', 'wikidata', 0)").run(itemId);
    w.refresh(itemId);
    expect(row(itemId).title).toBe('WD title');
    db.$client.prepare('DELETE FROM field_lock').run();
    clock += MAX_AGE + DAY;
    w.refresh(itemId);
    expect(row(itemId).title).toBe('WD title');
  });

  it('a documentary category from Wikidata wins over TMDB', () => {
    const { itemId } = w.upsertWork(movie({ fields: [src('tmdb', { title: 'X', category: 'film' }), src('wikidata', { category: 'documentary' })] }));
    expect(row(itemId).category).toBe('documentary');
  });

  it('all writes of one call are one transaction: a failure rolls back item, ids, fields and FTS', () => {
    const bad = movie({ fields: [src('wikidata', { title: 'X' }), { source: 'nonsense' as never, fetchedAt: clock, values: { title: 'Y' } }] });
    expect(() => w.upsertWork(bad)).toThrow();
    expect([count('catalog_item'), count('external_id'), count('item_field'), count('catalog_search')]).toEqual([0, 0, 0, 0]);
    expect(events).toEqual([]);
  });

  it('joins the caller transaction', () => {
    expect(() =>
      db.$client.transaction(() => {
        w.upsertWork(movie());
        throw new Error('caller failed');
      })(),
    ).toThrow('caller failed');
    expect(count('catalog_item')).toBe(0);
    expect(count('catalog_search')).toBe(0);
  });
});

describe('series hierarchy and extras', () => {
  const dark = (): string =>
    w.upsertWork({ kind: 'series', editionLabel: null, externalIds: { wikidata: 'Q24300155' }, fields: [src('wikidata', { title: 'Dark', year: 2017 })] }).itemId;

  it('Series → Season → Episode, idempotent, with default titles and padded sort keys', () => {
    const series = dark();
    const s1 = w.ensureSeason(series, 1);
    expect(s1.created).toBe(true);
    expect(w.ensureSeason(series, 1)).toEqual({ itemId: s1.itemId, created: false });
    const e2 = w.ensureEpisode(s1.itemId, 2);
    const e3 = w.ensureEpisode(s1.itemId, 3);
    expect(w.ensureEpisode(s1.itemId, 2).itemId).toBe(e2.itemId);
    expect(row(s1.itemId)).toMatchObject({ kind: 'season', parent_id: series, title: 'Stagione 1', sort_title: '0001', season_number: 1 });
    expect(row(e2.itemId)).toMatchObject({ kind: 'episode', parent_id: s1.itemId, title: 'Episodio 2', season_number: 1, episode_number: 2, category: null });
    expect(row(e3.itemId).sort_title).toBe('0003');
    expect(row(w.ensureSeason(series, 0).itemId).title).toBe('Speciali');
    expect(w.findAncestor(e3.itemId, 'series')).toBe(series);
    expect(w.findAncestor(series, 'season')).toBeNull();
    expect(w.getItem(e3.itemId)).toMatchObject({ kind: 'episode', parentId: s1.itemId, seasonNumber: 1, episodeNumber: 3 });
  });

  it('refuses a season under a non-series and an episode under a non-season', () => {
    const film = w.upsertWork(movie()).itemId;
    expect(() => w.ensureSeason(film, 1)).toThrow(/expected series/);
    expect(() => w.ensureEpisode(film, 1)).toThrow(/not a season/);
  });

  it('a filename episode title is shown until a provider has one', () => {
    const s1 = w.ensureSeason(dark(), 1).itemId;
    const e1 = w.ensureEpisode(s1, 1).itemId;
    w.writeFields(e1, [src('filename', { title: 'Segreti' })]);
    expect(row(e1).title).toBe('Segreti');
    w.writeFields(e1, [src('tmdb', { title: 'Geheimnisse' })]);
    expect(row(e1).title).toBe('Geheimnisse');
  });

  it('extras attach to their parent and are numbered when the title is taken; orphan extras are valid', () => {
    const film = w.upsertWork(movie()).itemId;
    const t1 = w.createExtra({ parentId: film, extraType: 'trailer', title: 'Trailer', numberIfTaken: true, fetchedAt: clock });
    const t2 = w.createExtra({ parentId: film, extraType: 'trailer', title: 'Trailer', numberIfTaken: true, fetchedAt: clock });
    const t3 = w.createExtra({ parentId: film, extraType: 'trailer', title: 'Trailer', numberIfTaken: true, fetchedAt: clock });
    expect([row(t1.itemId).title, row(t2.itemId).title, row(t3.itemId).title]).toEqual(['Trailer', 'Trailer 2', 'Trailer 3']);
    expect(row(t1.itemId)).toMatchObject({ kind: 'extra', parent_id: film });
    const orphan = w.createExtra({ parentId: null, extraType: 'featurette', title: 'Making of', numberIfTaken: true, fetchedAt: clock });
    expect(row(orphan.itemId)).toMatchObject({ kind: 'extra', parent_id: null, title: 'Making of' });
    expect(events.filter((e) => e.type === ITEM_ADDED).map((e) => e.payload.parentId)).toEqual([null, film, film, film, null]);
  });
});
