// Catalog read side through the real app (compose + Fastify, in-memory DB): Home, ListItems with
// keyset pagination, Search (FTS5, accents, non-Latin), GetItem, GetChildren, GetNextUp, the
// CatalogReadPort, with and without a ProfileStatePort. Every response is checked against the contract.
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- response bodies are untyped JSON, checked against the contract by the harness */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogItemKind, ProfileItemState, ProfileStatePort, WorkInput } from '../src/shared/ports.ts';
import { sidecarTrackId } from '../src/shared/media-facts.ts';
import { DESCRIBE_CHUNK, TMDB_NOTICE, WIKIDATA_NOTICE } from '../src/modules/catalog/read.ts';
import { harness, type Harness, PROFILE } from './helpers/app-harness.ts';
import { seedArtwork, seedFile, seedLink, seedRoot } from './helpers/catalog-seed.ts';

const DAY = 86_400_000;

interface Lib {
  br2049: string;
  trailer: string;
  dune: string;
  duneFiles: [string, string];
  buono: string;
  chihiro: string;
  russian: string;
  planet: string;
  ghost: string;
  dark: string;
  season1: string;
  ep1: string;
  ep2: string;
  ep2File: string;
  specials: string;
  special1: string;
}

let h: Harness;
let lib: Lib;

function work(kind: 'movie' | 'series', title: string, extra: { originalTitle?: string; year?: number; category?: 'film' | 'documentary'; qid?: string } = {}): string {
  const input: WorkInput = {
    kind,
    editionLabel: null,
    externalIds: extra.qid ? { wikidata: extra.qid } : {},
    fields: [{ source: 'wikidata', fetchedAt: h.clock.now, values: { title, originalTitle: extra.originalTitle ?? null, year: extra.year ?? null, category: extra.category ?? null } }],
  };
  return h.comp.ports.catalogWrite.upsertWork(input).itemId;
}

function seed(): Lib {
  const db = h.db;
  const w = h.comp.ports.catalogWrite;
  const film = seedRoot(db, 'Film');
  const serie = seedRoot(db, 'Serie', { hint: 'series' });
  const offline = seedRoot(db, 'Archivio', { status: 'offline' });
  const tick = () => (h.clock.now += 1000);

  const br2049 = work('movie', 'Blade Runner 2049', { originalTitle: 'Blade Runner 2049', year: 2017, qid: 'Q21451539' });
  seedLink(db, seedFile(db, film, 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv', 'br2049'), br2049);
  const trailer = w.createExtra({ parentId: br2049, extraType: 'trailer', title: 'Trailer', numberIfTaken: true, fetchedAt: h.clock.now }).itemId;
  seedLink(db, seedFile(db, film, 'Blade Runner 2049 (2017)/extras/Trailer.mkv', 'ilbuono'), trailer);
  tick();

  const dune = work('movie', 'Dune', { originalTitle: 'Dune', year: 2021, qid: 'Q63985561' });
  const sidecar = { id: sidecarTrackId('Dune.it.forced.srt'), relPath: 'Dune (2021)/Dune.it.forced.srt', format: 'srt' as const, language: 'ita', forced: true, sdh: false };
  const duneUhd = seedFile(db, film, 'Dune (2021)/Dune - 2160p.mkv', 'dune', { sidecars: [sidecar] });
  const duneHd = seedFile(db, film, 'Dune (2021)/Dune - 1080p.mkv', 'ilbuono');
  seedLink(db, duneUhd, dune);
  seedLink(db, duneHd, dune);
  tick();

  const buono = work('movie', 'Il buono, il brutto, il cattivo', { year: 1966 });
  seedLink(db, seedFile(db, offline, 'Il buono (1966)/Il buono.mkv', 'ilbuono'), buono);
  tick();

  const chihiro = work('movie', 'La città incantata', { originalTitle: '千と千尋の神隠し', year: 2001 });
  seedLink(db, seedFile(db, film, 'La citta incantata (2001)/x.mkv', 'oppenheimer'), chihiro);
  tick();

  const russian = work('movie', 'Неизвестный 1917-й', { year: 2017 });
  seedLink(db, seedFile(db, film, 'Neizvestnyj (2017)/x.mkv', 'ilbuono'), russian);
  tick();

  const planet = work('movie', 'Pianeta Terra', { year: 2006, category: 'documentary' });
  seedLink(db, seedFile(db, film, 'Planet Earth (2006)/x.mkv', 'ilbuono'), planet);
  tick();

  // A work left without files (e.g. after a re-link) is not listed.
  const ghost = work('movie', 'Ghost Movie', { year: 1990 });
  tick();

  const dark = work('series', 'Dark', { originalTitle: 'Dark', year: 2017, qid: 'Q24300155' });
  const season1 = w.ensureSeason(dark, 1).itemId;
  const ep1 = w.ensureEpisode(season1, 1).itemId;
  const ep2 = w.ensureEpisode(season1, 2).itemId;
  w.writeFields(ep1, [{ source: 'filename', fetchedAt: h.clock.now, values: { title: 'Segreti' } }]);
  seedLink(db, seedFile(db, serie, 'Dark (2017)/Season 01/Dark - S01E01.mkv', 'dark', { state: 'missing' }), ep1);
  const ep2File = seedFile(db, serie, 'Dark (2017)/Season 01/Dark - S01E02.mkv', 'dark');
  seedLink(db, ep2File, ep2);
  const specials = w.ensureSeason(dark, 0).itemId;
  const special1 = w.ensureEpisode(specials, 1).itemId;
  seedLink(db, seedFile(db, serie, 'Dark (2017)/Specials/Dark - S00E01.mkv', 'dark'), special1);
  tick();

  return { br2049, trailer, dune, duneFiles: [duneUhd, duneHd], buono, chihiro, russian, planet, ghost, dark, season1, ep1, ep2, ep2File, specials, special1 };
}

const titles = (items: { title: string }[]) => items.map((i) => i.title);

/** A ProfileStatePort over fixed tables. */
function fakeState(states: Record<string, Partial<ProfileItemState>>, cw: string[] = [], next: Record<string, string> = {}, lastPlayed?: Record<string, number>): ProfileStatePort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getStates(profileId, ids) {
      calls.push(`getStates:${profileId}`);
      const out = new Map<string, ProfileItemState>();
      for (const id of ids) {
        const s = states[id];
        if (s) out.set(id, { watched: false, progressPercent: 0, inWatchlist: false, ...s });
      }
      return out;
    },
    continueWatching: (_p, limit) => cw.slice(0, limit),
    nextUp: (_p, seriesId) => next[seriesId] ?? null,
    ...(lastPlayed ? { lastPlayed: (_p: string, ids: readonly string[]) => new Map(ids.filter((id) => id in lastPlayed).map((id) => [id, lastPlayed[id]!])) } : {}),
  };
}

describe('without a ProfileStatePort (profiles arrive in F1b)', () => {
  beforeEach(async () => {
    h = await harness();
    lib = seed();
  });
  afterEach(async () => h.close());

  it('composes Home without Continue watching and without state', async () => {
    expect(() => h.comp.ports.profileState).toThrow(/not provided/);
    const { status, body } = await h.call('getHome', 'GET', '/video/api/v1/home');
    expect(status).toBe(200);
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(['recently_added', 'movies', 'series', 'documentaries']);
    const recently = body.rows[0];
    expect(titles(recently.items)).toEqual(['Dark', 'Pianeta Terra', 'Неизвестный 1917-й', 'La città incantata', 'Il buono, il brutto, il cattivo', 'Dune', 'Blade Runner 2049']);
    expect(recently.query).toEqual({ sort: 'added', order: 'desc' });
    expect(titles(body.rows[1].items)).toEqual(['Blade Runner 2049', 'Il buono, il brutto, il cattivo', 'La città incantata', 'Dune', 'Неизвестный 1917-й']);
    expect(titles(body.rows[2].items)).toEqual(['Dark']);
    expect(titles(body.rows[3].items)).toEqual(['Pianeta Terra']);
    for (const row of body.rows) for (const item of row.items) expect(item.state).toBeUndefined();
  });

  it('marks unavailable items and keeps listing them', async () => {
    const { body } = await h.call('listItems', 'GET', '/video/api/v1/items?kind=movie');
    const byTitle = Object.fromEntries(body.items.map((i: { title: string; available: boolean }) => [i.title, i.available]));
    expect(byTitle['Il buono, il brutto, il cattivo']).toBe(false); // root offline
    expect(byTitle['Dune']).toBe(true);
    expect(byTitle['Ghost Movie']).toBeUndefined();
    // A series is available if one episode is: S01E01 is missing, S01E02 is there.
    const dark = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.dark}`)).body;
    expect(dark.available).toBe(true);
    const ep1 = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.ep1}`)).body;
    expect(ep1).toMatchObject({ title: 'Segreti', available: false, episodeNumber: 1, seasonNumber: 1 });
  });

  it('filters and sorts ListItems', async () => {
    const get = async (qs: string) => titles((await h.call('listItems', 'GET', `/video/api/v1/items?${qs}`)).body.items);
    // Sort titles drop the leading article: "Il buono" sorts as "buono", "La città" as "citta".
    expect(await get('')).toEqual(['Blade Runner 2049', 'Il buono, il brutto, il cattivo', 'La città incantata', 'Dark', 'Dune', 'Pianeta Terra', 'Неизвестный 1917-й']);
    expect(await get('kind=series')).toEqual(['Dark']);
    expect(await get('kind=episode')).toEqual(['Segreti', 'Episodio 1', 'Episodio 2']);
    expect(await get('kind=extra')).toEqual(['Trailer']);
    expect(await get('category=documentary')).toEqual(['Pianeta Terra']);
    expect(await get('year=2017')).toEqual(['Blade Runner 2049', 'Dark', 'Неизвестный 1917-й']);
    // Ties on the key follow the id, in the same direction (keyset on (key, id)).
    expect(await get('kind=movie&sort=year&order=desc')).toEqual(['Dune', 'Неизвестный 1917-й', 'Blade Runner 2049', 'Pianeta Terra', 'La città incantata', 'Il buono, il brutto, il cattivo']);
    expect((await get('kind=movie&sort=duration')).length).toBe(6);
    // No profile state: nothing is watched, in the watchlist or in progress; the opposite filters keep everything.
    expect(await get('watched=true')).toEqual([]);
    expect(await get('inWatchlist=true')).toEqual([]);
    expect(await get('continueWatching=true')).toEqual([]);
    expect((await get('watched=false')).length).toBe(7);
    expect((await get('sort=last_played')).length).toBe(7);
  });

  it('pages with a stable keyset cursor, also when items are added meanwhile', async () => {
    for (let i = 1; i <= 23; i++) {
      const id = work('movie', `Zeta ${String(i).padStart(2, '0')}`, { year: 2000 + (i % 5) });
      seedLink(h.db, seedFile(h.db, seedRoot(h.db, `R${i}`), `z${i}.mkv`, null, { state: 'analyzed' }), id);
    }
    for (const sort of ['title', 'year', 'added'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const full = (await h.call('listItems', 'GET', `/video/api/v1/items?kind=movie&sort=${sort}&order=${order}&limit=200`)).body.items.map((i: { id: string }) => i.id);
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const qs: string = `kind=movie&sort=${sort}&order=${order}&limit=4${cursor ? `&cursor=${cursor}` : ''}`;
          const { body } = await h.call('listItems', 'GET', `/video/api/v1/items?${qs}`);
          seen.push(...body.items.map((i: { id: string }) => i.id));
          cursor = body.nextCursor;
          if (pages++ === 1) {
            // A new item and a renamed one while paging: what was already returned is never repeated.
            work('movie', `Aaa ${sort}${order}`, { year: 1999 });
          }
        } while (cursor && pages < 50);
        expect(new Set(seen).size).toBe(seen.length);
        expect(full.every((id: string) => seen.includes(id))).toBe(true);
      }
    }
  });

  it('rejects a cursor of another ordering or a broken one', async () => {
    const { body } = await h.call('listItems', 'GET', '/video/api/v1/items?limit=2');
    expect(body.nextCursor).toBeTruthy();
    const other = await h.call('listItems', 'GET', `/video/api/v1/items?limit=2&sort=year&cursor=${body.nextCursor}`);
    expect(other.status).toBe(400);
    expect(other.body.code).toBe('VALIDATION_FAILED');
    expect((await h.call('listItems', 'GET', '/video/api/v1/items?cursor=%25%25')).status).toBe(400);
  });

  it('searches titles with prefixes, accents and non-Latin scripts', async () => {
    const s = async (q: string, extra = '') => titles((await h.call('search', 'GET', `/video/api/v1/search?q=${encodeURIComponent(q)}${extra}`)).body.items);
    expect(await s('citta')).toEqual(['La città incantata']);
    expect(await s('CITTÀ inc')).toEqual(['La città incantata']);
    expect(await s('cittè'.slice(0, 4))).toEqual(['La città incantata']); // "citt"
    expect(await s('千と千尋')).toEqual(['La città incantata']); // original title, FTS prefix
    expect(await s('神隠し')).toEqual(['La città incantata']); // middle of a CJK token: substring fallback
    expect(await s('неизв')).toEqual(['Неизвестный 1917-й']);
    expect(await s('1917')).toEqual(['Неизвестный 1917-й']);
    expect(await s('blade run')).toEqual(['Blade Runner 2049']);
    expect(await s('buono brutto')).toEqual(['Il buono, il brutto, il cattivo']);
    expect(await s('dark')).toEqual(['Dark']); // never the season
    expect(await s('segreti')).toEqual(['Segreti']);
    expect(await s('segreti', '&kind=movie')).toEqual([]);
    expect(await s('ghost')).toEqual([]);
    expect(await s('!!!')).toEqual([]);
    expect(await s('ＣＩＴＴＡ')).toEqual(['La città incantata']); // full-width, NFKC
  });

  it('passes FTS5 metacharacters as plain text, never as query syntax', async () => {
    const s = async (q: string) => {
      const r = await h.call('search', 'GET', `/video/api/v1/search?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
      return titles(r.body.items);
    };
    expect(await s('"')).toEqual([]);
    expect(await s('*')).toEqual([]);
    expect(await s('blade"')).toEqual(['Blade Runner 2049']);
    expect(await s('blade*')).toEqual(['Blade Runner 2049']);
    expect(await s('^dune')).toEqual(['Dune']);
    expect(await s('-dune')).toEqual(['Dune']);
    expect(await s('dune:')).toEqual(['Dune']);
    expect(await s('title:dune')).toEqual([]);
    expect(await s('NEAR(')).toEqual([]);
    expect(await s('NEAR(blade runner)')).toEqual([]);
  });

  it('merges substring hits after the FTS hits for a CJK query without spaces', async () => {
    const other = work('movie', 'Antologia', { originalTitle: '映画千と千尋の記録', year: 2010 });
    seedLink(h.db, seedFile(h.db, seedRoot(h.db, 'Altro', { path: '/media/Altro' }), 'Antologia (2010)/a.mkv', 'ilbuono'), other);
    const s = async (q: string) => titles((await h.call('search', 'GET', `/video/api/v1/search?q=${encodeURIComponent(q)}`)).body.items);
    // "千と千尋" is a prefix of Chihiro's single FTS token and the middle of the other one.
    expect(await s('千と千尋')).toEqual(['La città incantata', 'Antologia']);
    expect(await s('記録')).toEqual(['Antologia']);
  });

  it('details a movie: versions, tracks, chapters, extras, ids, images, attributions', async () => {
    const db = h.db;
    seedArtwork(db, lib.dune, 'poster', 'aa/aaaaaaaaaaaaaaa1/original.webp', { language: 'en' });
    seedArtwork(db, lib.dune, 'poster', 'aa/aaaaaaaaaaaaaaa2/original.webp', { language: 'it' });
    seedArtwork(db, lib.dune, 'backdrop', 'bb/bbbbbbbbbbbbbbb1/original.webp', { language: null, source: 'tmdb' });
    db.$client.prepare("INSERT INTO item_field (item_id, field, source, value, fetched_at) VALUES (?, 'overview', 'tmdb', ?, ?)").run(lib.dune, JSON.stringify('Paul Atreides…'), h.clock.now);
    db.$client.prepare("INSERT INTO item_field (item_id, field, source, value, fetched_at) VALUES (?, 'genres', 'wikidata', ?, ?)").run(lib.dune, JSON.stringify(['fantascienza', 'avventura']), h.clock.now);
    db.$client.prepare("INSERT INTO person (id, name, source) VALUES ('p-dv', 'Denis Villeneuve', 'wikidata'), ('p-tc', 'Timothée Chalamet', 'wikidata')").run();
    db.$client
      .prepare("INSERT INTO credit (item_id, person_id, role, character, sort_order, source) VALUES (?, 'p-tc', 'actor', 'Paul Atreides', 0, 'wikidata'), (?, 'p-dv', 'director', NULL, 0, 'wikidata')")
      .run(lib.dune, lib.dune);

    const { status, body } = await h.call('getItem', 'GET', `/video/api/v1/items/${lib.dune}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: lib.dune, kind: 'movie', category: 'film', title: 'Dune', year: 2021, available: true, overview: 'Paul Atreides…', parent: null });
    expect(body.badges).toEqual(['4K', 'DV', 'HDR10', 'TrueHD']);
    expect(body.genres).toEqual(['fantascienza', 'avventura']);
    expect(body.credits).toEqual([
      { name: 'Denis Villeneuve', role: 'director', character: null },
      { name: 'Timothée Chalamet', role: 'actor', character: 'Paul Atreides' },
    ]);
    expect(body.images.map((i: { type: string; url: string }) => [i.type, i.url])).toEqual([
      ['poster', '/video/media/images/aaaaaaaaaaaaaaa2'], // it before en (ADR 0007 point 3)
      ['backdrop', '/video/media/images/bbbbbbbbbbbbbbb1'],
    ]);
    expect(body.externalIds).toEqual({ wikidata: 'Q63985561' });
    expect(body.attributions).toEqual([TMDB_NOTICE, WIKIDATA_NOTICE]);
    expect(body.versions.map((v: { fileId: string; label: string }) => [v.fileId, v.label])).toEqual([
      [lib.duneFiles[0], '4K · Dolby Vision · TrueHD 5.1 · ENG/ITA'],
      [lib.duneFiles[1], '1080p · DTS 5.1 · ENG/ITA'],
    ]);
    const uhd = body.versions[0];
    expect(uhd.tracks.map((t: { id: string; type: string }) => `${t.id}:${t.type}`)).toEqual(['s0:video', 's1:audio', 's2:audio', 's3:subtitle', `${sidecarTrackId('Dune.it.forced.srt')}:subtitle`]);
    expect(uhd.tracks[0]).toMatchObject({ codec: 'hevc', width: 3840, hdr: 'DV', external: false });
    expect(uhd.tracks[0].dolbyVision).toMatchObject({ profile: 8 });
    expect(uhd.tracks[1]).toMatchObject({ codec: 'truehd', language: 'eng', channels: 6, lossless: true });
    expect(uhd.tracks[4]).toMatchObject({ codec: 'subrip', language: 'ita', forced: true, external: true, subtitleKind: 'text' });
    expect(uhd.chapters).toHaveLength(3);
    expect(uhd).toMatchObject({ container: 'matroska', sizeBytes: 1_000_000, available: true });
    expect(body.extras).toEqual([]);

    const br = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.br2049}`)).body;
    expect(br.extras.map((e: { id: string; extraType: string }) => [e.id, e.extraType])).toEqual([[lib.trailer, 'trailer']]);
    expect(br.attributions).toEqual([WIKIDATA_NOTICE]);
    const trailer = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.trailer}`)).body;
    expect(trailer.parent.id).toBe(lib.br2049);
    expect(trailer.versions).toHaveLength(1);
  });

  it('hides expired TMDB values from the detail', async () => {
    h.db.$client.prepare("INSERT INTO item_field (item_id, field, source, value, fetched_at) VALUES (?, 'overview', 'tmdb', ?, ?)").run(lib.dune, JSON.stringify('old'), h.clock.now - 181 * DAY);
    const body = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.dune}`)).body;
    expect(body.overview).toBeNull();
    expect(body.attributions).toEqual([WIKIDATA_NOTICE]);
  });

  it('details a series and a season with their children', async () => {
    const dark = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.dark}`)).body;
    expect(dark.children.map((c: { title: string }) => c.title)).toEqual(['Speciali', 'Stagione 1']);
    expect(dark.versions).toEqual([]);
    expect(dark.badges).toEqual(['1080p']);
    const season = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.season1}`)).body;
    expect(season.parent.id).toBe(lib.dark);
    expect(season.children.map((c: { id: string }) => c.id)).toEqual([lib.ep1, lib.ep2]);
  });

  it('pages GetChildren and answers 404 for an unknown item', async () => {
    const first = (await h.call('getChildren', 'GET', `/video/api/v1/items/${lib.dark}/children?limit=1`)).body;
    expect(titles(first.items)).toEqual(['Speciali']);
    const second = (await h.call('getChildren', 'GET', `/video/api/v1/items/${lib.dark}/children?limit=1&cursor=${first.nextCursor}`)).body;
    expect(titles(second.items)).toEqual(['Stagione 1']);
    expect(second.nextCursor).toBeNull();
    expect((await h.call('getChildren', 'GET', `/video/api/v1/items/${lib.dune}/children`)).body).toEqual({ items: [], nextCursor: null });
    const missing = await h.call('getChildren', 'GET', '/video/api/v1/items/nope/children');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
    expect((await h.call('getItem', 'GET', '/video/api/v1/items/nope')).status).toBe(404);
  });

  it('answers next up with the first regular episode when nothing is watched', async () => {
    expect((await h.call('getNextUp', 'GET', `/video/api/v1/items/${lib.dark}/next-up`)).body.item.id).toBe(lib.ep1);
    expect((await h.call('getNextUp', 'GET', `/video/api/v1/items/${lib.dune}/next-up`)).body).toEqual({ item: null });
    expect((await h.call('getNextUp', 'GET', '/video/api/v1/items/nope/next-up')).status).toBe(404);
  });

  it('provides CatalogReadPort for playback', () => {
    const read = h.comp.ports.catalogRead;
    const dune = read.getPlayableItem(lib.dune);
    expect(dune).toMatchObject({ itemId: lib.dune, kind: 'movie', title: 'Dune' });
    expect(dune?.files.map((f) => [f.fileId, f.available, f.facts.location.relPath])).toEqual([
      [lib.duneFiles[0], true, 'Dune (2021)/Dune - 2160p.mkv'],
      [lib.duneFiles[1], true, 'Dune (2021)/Dune - 1080p.mkv'],
    ]);
    expect(read.getPlayableItem(lib.buono)?.files.map((f) => f.available)).toEqual([false]);
    expect(read.getPlayableItem(lib.ep1)?.files.map((f) => f.available)).toEqual([false]);
    expect(read.getPlayableItem(lib.dark)?.files).toEqual([]);
    expect(read.getPlayableItem('nope')).toBeNull();
    expect(read.listPlayableDescendants(lib.dark)).toEqual([lib.special1, lib.ep1, lib.ep2]);
    expect(read.listPlayableDescendants(lib.season1)).toEqual([lib.ep1, lib.ep2]);
    expect(read.listPlayableDescendants(lib.dune)).toEqual([]);
    expect(read.itemExists(lib.ghost)).toBe(true);
    expect(read.itemExists('nope')).toBe(false);
  });

  it('describes items for profiles: kind and position, unknown ids left out, chunked batches', () => {
    const read = h.comp.ports.catalogRead;
    const got = read.describeItems([lib.ep2, lib.dark, 'nope', lib.season1, lib.dune, lib.ep2]);
    expect([...got.keys()].sort()).toEqual([lib.ep2, lib.dark, lib.season1, lib.dune].sort());
    expect(got.get(lib.ep2)).toEqual({ id: lib.ep2, kind: 'episode', parentId: lib.season1, seasonNumber: 1, episodeNumber: 2 });
    expect(got.get(lib.season1)).toEqual({ id: lib.season1, kind: 'season', parentId: lib.dark, seasonNumber: 1, episodeNumber: null });
    expect(got.get(lib.dark)).toEqual({ id: lib.dark, kind: 'series', parentId: null, seasonNumber: null, episodeNumber: null });
    expect(got.get(lib.dune)?.kind).toBe('movie');
    expect(read.describeItems([]).size).toBe(0);
    // More ids than one chunk: the known ones sit in different chunks.
    const many = [lib.special1, ...Array.from({ length: DESCRIBE_CHUNK * 2 }, (_, i) => `x${i}`), lib.ep1];
    expect([...read.describeItems(many).keys()].sort()).toEqual([lib.special1, lib.ep1].sort());
  });

  it('gives episodes and seasons the title of their series, and nothing to other kinds', async () => {
    const eps = (await h.call('listItems', 'GET', '/video/api/v1/items?kind=episode')).body.items;
    expect(eps.map((i: { seriesTitle?: string | null }) => i.seriesTitle)).toEqual(['Dark', 'Dark', 'Dark']);
    const dark = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.dark}`)).body;
    expect(dark).not.toHaveProperty('seriesTitle');
    expect(dark.children.map((c: { seriesTitle?: string | null }) => c.seriesTitle)).toEqual(['Dark', 'Dark']);
    expect((await h.call('getItem', 'GET', `/video/api/v1/items/${lib.dune}`)).body).not.toHaveProperty('seriesTitle');
    // An episode straight under the series (the read side allows it) and one without a parent.
    const ins = h.db.$client.prepare("INSERT INTO catalog_item (id, kind, parent_id, episode_number, title, sort_title, added_at, updated_at) VALUES (?, 'episode', ?, 9, 'X', 'x', 0, 0)");
    ins.run('direct', lib.dark);
    ins.run('orphan', null);
    expect(h.comp.ports.catalogViews.summaries(['direct', 'orphan']).map((x) => x.seriesTitle)).toEqual(['Dark', null]);
  });

  it('provides CatalogViewPort summaries in the asked order', () => {
    const views = h.comp.ports.catalogViews;
    expect(views.summaries([lib.dark, 'nope', lib.dune]).map((s) => s.id)).toEqual([lib.dark, lib.dune]);
    expect(views.mediaVersion(lib.ep2File)?.label).toBe('1080p · AC-3 5.1 · GER/ITA');
    expect(views.mediaVersion('nope')).toBeNull();
  });
});

describe('with a ProfileStatePort', () => {
  let port: ReturnType<typeof fakeState>;
  afterEach(async () => h.close());

  async function setup(lastPlayed?: (l: Lib) => Record<string, number>) {
    // The port is created after the seed, so it can name the seeded ids.
    let current: ProfileStatePort | null = null;
    h = await harness({
      profileState: {
        getStates: (p, ids) => current!.getStates(p, ids),
        continueWatching: (p, n) => current!.continueWatching(p, n),
        nextUp: (p, s) => current!.nextUp(p, s),
        lastPlayed: (p, ids) => current!.lastPlayed?.(p, ids) ?? new Map<string, number>(),
      },
    });
    lib = seed();
    port = fakeState(
      { [lib.dune]: { progressPercent: 40, resumePositionMs: 12_000 }, [lib.br2049]: { watched: true, playCount: 2 }, [lib.dark]: { inWatchlist: true }, [lib.ep2]: { progressPercent: 10 } },
      [lib.ep2, lib.dune],
      { [lib.dark]: lib.ep2 },
      lastPlayed?.(lib),
    );
    current = port;
  }

  it('adds Continue watching first, in the port order, and states on every summary', async () => {
    await setup();
    const { body } = await h.call('getHome', 'GET', '/video/api/v1/home');
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(['continue_watching', 'recently_added', 'movies', 'series', 'documentaries']);
    expect(body.rows[0].items.map((i: { id: string }) => i.id)).toEqual([lib.ep2, lib.dune]);
    expect(body.rows[0].query).toEqual({ continueWatching: 'true', sort: 'last_played', order: 'desc' });
    const dune = body.rows[2].items.find((i: { id: string }) => i.id === lib.dune);
    expect(dune.state).toEqual({ watched: false, progressPercent: 40, resumePositionMs: 12_000, inWatchlist: false });
    expect(port.calls.every((c) => c === `getStates:${PROFILE}`)).toBe(true);
  });

  it('filters by watched, watchlist and progress, and sorts by last played', async () => {
    await setup((l) => ({ [l.dark]: 300, [l.dune]: 200, [l.br2049]: 100 }));
    const get = async (qs: string) => (await h.call('listItems', 'GET', `/video/api/v1/items?${qs}`)).body.items.map((i: { id: string }) => i.id);
    expect(await get('watched=true')).toEqual([lib.br2049]);
    expect(await get('watched=false')).not.toContain(lib.br2049);
    expect(await get('inWatchlist=true')).toEqual([lib.dark]);
    // The watchlist lists what the profile added, of any kind: an extra too.
    const states = port.getStates.bind(port);
    port.getStates = (p, ids) => {
      const out = states(p, ids);
      if (ids.includes(lib.trailer)) out.set(lib.trailer, { watched: false, progressPercent: 0, inWatchlist: true });
      return out;
    };
    expect(await get('inWatchlist=true')).toEqual([lib.dark, lib.trailer]);
    expect(await get('inWatchlist=false')).not.toContain(lib.trailer); // browsing: works only
    port.getStates = states;
    expect(await get('continueWatching=true&sort=last_played&order=desc')).toEqual([lib.dune, lib.ep2]);
    expect((await get('sort=last_played&order=desc')).slice(0, 3)).toEqual([lib.dark, lib.dune, lib.br2049]);
    // Paging the in-memory path uses the same keyset.
    const p1 = (await h.call('listItems', 'GET', '/video/api/v1/items?sort=last_played&order=desc&limit=2')).body;
    const p2 = (await h.call('listItems', 'GET', `/video/api/v1/items?sort=last_played&order=desc&limit=2&cursor=${p1.nextCursor}`)).body;
    expect([...p1.items, ...p2.items].map((i: { id: string }) => i.id).slice(0, 3)).toEqual([lib.dark, lib.dune, lib.br2049]);
  });

  it('adds next up right after Continue watching, skipping an episode already in progress', async () => {
    await setup((l) => ({ [l.dark]: 300 }));
    const rows = async () => (await h.call('getHome', 'GET', '/video/api/v1/home')).body.rows;
    // Next up of Dark is S01E02, which Continue watching already shows.
    expect((await rows()).map((r: { id: string }) => r.id)).toEqual(['continue_watching', 'recently_added', 'movies', 'series', 'documentaries']);
    port.continueWatching = (_p, n) => [lib.dune].slice(0, n);
    const home = await rows();
    expect(home.map((r: { id: string }) => r.id)).toEqual(['continue_watching', 'next_up', 'recently_added', 'movies', 'series', 'documentaries']);
    expect(home[1]).toMatchObject({ title: 'Prossimi episodi', nextCursor: null, items: [{ id: lib.ep2, seriesTitle: 'Dark', state: { progressPercent: 10 } }] });
  });

  it('answers next up from the port', async () => {
    await setup();
    expect((await h.call('getNextUp', 'GET', `/video/api/v1/items/${lib.dark}/next-up`)).body.item).toMatchObject({ id: lib.ep2, state: { progressPercent: 10 } });
  });
});

// Keeps the kinds in step with the schema enum used by the summaries.
export const KINDS: CatalogItemKind[] = ['movie', 'series', 'season', 'episode', 'extra'];
