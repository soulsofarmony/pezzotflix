// TMDB adapter on synthetic answers (ADR 0007 point 10): mapping of search, details, seasons and
// images; typed results for 429/401/5xx/timeouts; the token never leaves the Authorization header.
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createProviderCache } from '../src/modules/metadata/cache.ts';
import { createHostGate, type HttpDeps } from '../src/modules/metadata/http.ts';
import { bestImage, createTmdb, parseConfiguration, parseWork, sizesFor, type TmdbAdapter, workDetails } from '../src/modules/metadata/tmdb.ts';
import { type FakeClock, type FakeFetch, fakeClock, fakeFetch } from './helpers/metadata-fetch.ts';
import { MOVIE, SHOW, tmdbRoutes, TOKEN } from './helpers/tmdb-synthetic.ts';

const LANG = 'it-IT';
let db: Db;
let fetch: FakeFetch;
let clock: FakeClock;
let tmdb: TmdbAdapter;
let lines: string[];

function make(token = TOKEN) {
  const http: HttpDeps = { fetch, clock, log: pino({ level: 'trace' }, { write: (s: string) => void lines.push(s) }), userAgent: 'Pezzotflix/0.1 (x)', secrets: [token] };
  return createTmdb({
    api: createHostGate({ name: 'tmdb', ratePerSec: 20, burst: 4, concurrency: 4, timeoutMs: 1000 }, http),
    images: createHostGate({ name: 'tmdb-images', ratePerSec: 10, burst: 2, concurrency: 4, timeoutMs: 1000 }, http),
    cache: createProviderCache(db),
    now: clock.now,
    token,
  });
}

beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
  fetch = fakeFetch(tmdbRoutes());
  clock = fakeClock();
  lines = [];
  tmdb = make();
});
afterEach(() => closeDb(db));

const apiCalls = () => fetch.calls.filter((c) => c.url.startsWith('https://api.themoviedb.org/'));

describe('mapping (pure)', () => {
  it('images: it → null → en, then votes, then width; SVG logos are skipped', () => {
    const w = parseWork(MOVIE, 'movie', ['it', 'en']);
    expect(bestImage(w.images, 'poster', LANG)?.path).toBe('/posterIT.jpg');
    expect(bestImage(w.images.filter((i) => i.lang !== 'it'), 'poster', LANG)?.path).toBe('/posterNULL.jpg');
    expect(bestImage(w.images, 'logo', LANG)?.path).toBe('/logoEN.png');
    expect(w.images.some((i) => i.path.endsWith('.svg'))).toBe(false);
  });

  it('keeps only the asked translations, credits in billing order, directors from the crew', () => {
    const w = parseWork(MOVIE, 'movie', ['it', 'en']);
    expect(w.translations.map((t) => t.lang)).toEqual(['it', 'en']);
    expect(w.cast.map((c) => c.name)).toEqual(['Aldo Primo', 'Bruna Seconda']);
    expect(w.directors).toEqual([{ id: '7100', name: 'Regista Inventato' }]);
    expect(w.externalIds).toEqual({ imdb: 'tt9000001', wikidata: 'Q99000001' });
  });

  it('an Italian translation with an empty title gives no TMDB title (the Wikidata label shows); genre 99 → documentary', () => {
    const raw = {
      id: 900009,
      title: 'Default Title',
      original_title: 'Original Doc',
      release_date: '2020-05-01',
      genres: [{ id: 99, name: 'Documentario' }],
      translations: { translations: [{ iso_639_1: 'it', iso_3166_1: 'IT', data: { title: '', overview: 'Trama italiana.' } }] },
    };
    const d = workDetails(parseWork(raw, 'movie', ['it', 'en']), LANG, 0);
    // No top-level overview: the Italian translation's is used.
    expect(d.fields).toMatchObject({ title: null, originalTitle: 'Original Doc', overview: 'Trama italiana.', category: 'documentary' });
    expect(workDetails(parseWork({ ...raw, genres: [] }, 'movie', ['it', 'en']), LANG, 0).fields.category).toBeNull();
  });

  it('the image base URL of /configuration is pinned to image.tmdb.org', () => {
    expect(parseConfiguration({ images: { secure_base_url: 'https://image.tmdb.org/t/p/', poster_sizes: ['w342'] } })?.base).toBe('https://image.tmdb.org/t/p/');
    expect(parseConfiguration({ images: { secure_base_url: 'https://evil.example/t/p/' } })).toBeNull();
    expect(parseConfiguration({ images: { secure_base_url: 'http://image.tmdb.org/t/p/' } })).toBeNull();
  });

  it.each([
    [['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original'], [342, 780], ['w342', 'w780']],
    [['w300', 'w780', 'w1280', 'original'], [1280], ['w1280']],
    [['w300', 'w1000', 'original'], [1280], ['w1000']],
    [['w45', 'w500'], [500], ['w500']],
    [['original'], [300], ['original']],
    [[], [300], []],
  ])('sizesFor(%j, %j) = %j', (avail, wanted, out) => {
    expect(sizesFor(avail, wanted)).toEqual(out);
  });
});

describe('calls', () => {
  it('search: both kinds without a kind, the year only when given, vote counts and genre 99', async () => {
    const r = await tmdb.search({ query: 'di prova', kind: null, year: null, lang: LANG });
    expect(r.status === 'ok' && r.value.map((c) => [c.ref.kind, c.ref.id, c.titles.localized, c.years, c.voteCount, c.documentary])).toEqual([
      ['movie', '900001', 'Il Faro di Prova', [2019], 4321, false],
      ['series', '800001', 'Serie di Prova', [2017], 999, false],
    ]);
    const urls = apiCalls().map((c) => new URL(c.url));
    expect(urls.map((u) => u.pathname)).toEqual(['/3/search/movie', '/3/search/tv']);
    expect(urls[0]?.searchParams.get('language')).toBe('it-IT');
    expect(urls[0]?.searchParams.has('year')).toBe(false);
    await tmdb.search({ query: 'faro', kind: 'series', year: 2017, lang: LANG });
    expect(new URL(apiCalls().at(-1)?.url ?? '').searchParams.get('first_air_date_year')).toBe('2017');
  });

  it('lookup by TMDB id fills the aliases from alternative_titles (the identifier re-scores low_score with them)', async () => {
    const r = await tmdb.lookupByExternalId({ ns: 'tmdb_movie', id: '900001', lang: LANG });
    expect(r.status === 'ok' && r.value).toMatchObject({
      ref: { provider: 'tmdb', id: '900001', kind: 'movie' },
      titles: { localized: 'Il Faro di Prova', english: 'The Test Lighthouse', original: ['The Test Lighthouse'], aliases: ['Faro di Prova', 'Test Lighthouse'] },
      // Only the TMDB id leaves the adapter: the others TMDB gives are hints, never stored.
      externalIds: { tmdb: '900001' },
    });
    const d = await tmdb.details('movie', '900001', LANG);
    expect(d.status === 'ok' && d.value.hints).toEqual({ imdb: 'tt9000001', wikidata: 'Q99000001' });
    const u = new URL(apiCalls()[0]?.url ?? '');
    expect(u.searchParams.get('append_to_response')).toBe('images,credits,translations,alternative_titles,external_ids');
    expect(u.searchParams.get('include_image_language')).toBe('it,null,en');
  });

  it('lookup by IMDb, TVDB or QID goes through /find; the series namespace is separate', async () => {
    expect((await tmdb.lookupByExternalId({ ns: 'imdb', id: 'tt8000001', lang: LANG })).status === 'ok').toBe(true);
    const tv = await tmdb.lookupByExternalId({ ns: 'tvdb', id: '880001', lang: LANG });
    expect(tv.status === 'ok' && tv.value.ref).toEqual({ provider: 'tmdb', id: '800001', kind: 'series' });
    expect(await tmdb.lookupByExternalId({ ns: 'tmdb_tv', id: '900001', lang: LANG })).toEqual({ status: 'not_found' });
    expect(await tmdb.lookupByExternalId({ ns: 'wikidata', id: 'Q1', lang: LANG })).toEqual({ status: 'not_found' });
    expect((await tmdb.lookupByExternalId({ ns: 'imdb', id: 'nope', lang: LANG })).status).toBe('invalid_request');
  });

  it('details: Italian title only from a translation, overview falls back to English, tagline does not', async () => {
    const it1 = await tmdb.details('movie', '900001', LANG);
    expect(it1.status === 'ok' && it1.value.fields).toEqual({
      title: 'Il Faro di Prova',
      originalTitle: 'The Test Lighthouse',
      year: 2019,
      overview: 'Un guardiano del faro scopre una luce che non dovrebbe esserci.',
      tagline: 'La luce mente.',
      genres: ['Dramma', 'Mistero'],
      category: null,
    });
    expect(it1.status === 'ok' && it1.value.credits.map((c) => [c.role, c.name, c.character, c.order])).toEqual([
      ['director', 'Regista Inventato', null, 0],
      ['actor', 'Aldo Primo', 'Il guardiano', 0],
      ['actor', 'Bruna Seconda', 'Marta', 1],
    ]);
    expect(it1.status === 'ok' && it1.value.images.map((i) => [i.type, i.ref, i.language])).toEqual([
      ['poster', '/posterIT.jpg', 'it'],
      ['backdrop', '/backdrop.jpg', null],
      ['logo', '/logoEN.png', 'en'],
    ]);
    const none = await tmdb.details('movie', '900002', LANG);
    expect(none.status === 'ok' && none.value.fields).toMatchObject({ title: null, overview: 'English only overview.', tagline: null });
  });

  it('details are cached 24 h with their fetch time, then fetched again', async () => {
    const a = await tmdb.details('movie', '900001', LANG);
    clock.advance(3600_000);
    const b = await tmdb.details('movie', '900001', LANG);
    expect(apiCalls()).toHaveLength(1);
    expect(a.status === 'ok' && b.status === 'ok' && b.value.fetchedAt).toBe(a.status === 'ok' && a.value.fetchedAt);
    clock.advance(24 * 3600_000);
    await tmdb.details('movie', '900001', LANG);
    expect(apiCalls()).toHaveLength(2);
  });

  it('seasons: "Episodio N" is no title; missing overviews come from en-US', async () => {
    const r = await tmdb.seasons(String(SHOW.id), [1, 2], LANG);
    expect(r).toMatchObject({
      status: 'ok',
      value: [
        {
          season: 1,
          fields: { title: 'Stagione 1', overview: null, year: 2017 },
          poster: { type: 'poster', ref: '/s1.jpg' },
          episodes: [
            { episode: 1, fields: { title: 'Segreti di prova', overview: 'Un ragazzo scompare.' }, still: { ref: '/e1.jpg' } },
            { episode: 2, fields: { title: null, overview: 'EN overview 2' }, still: { ref: '/e2.jpg' } },
            { episode: 3, fields: { title: 'Terzo', overview: 'Tre.' }, still: null },
          ],
        },
      ],
    });
  });

  it('images: the CDN sizes of /configuration, never resized', async () => {
    const r = await tmdb.fetchImage({ type: 'poster', ref: '/posterIT.jpg', language: 'it', width: 2000, height: 3000 });
    expect(r.status === 'ok' && r.value.map((f) => [f.size, f.width, f.height, f.contentType])).toEqual([
      ['w342', 342, 513, 'image/jpeg'],
      ['w780', 780, 1170, 'image/jpeg'],
    ]);
    expect(fetch.calls.filter((c) => c.url.startsWith('https://image.tmdb.org/')).map((c) => c.url)).toEqual([
      'https://image.tmdb.org/t/p/w342/posterIT.jpg',
      'https://image.tmdb.org/t/p/w780/posterIT.jpg',
    ]);
    expect((await tmdb.fetchImage({ type: 'poster', ref: '../etc/passwd', language: null, width: null, height: null })).status).toBe('invalid_request');
  });
});

describe('failures and the secret', () => {
  it('429 with Retry-After: rate_limited with a real delay, the host paused', async () => {
    fetch.routes.unshift({ match: (u) => u.pathname === '/3/movie/900001', reply: () => ({ status: 429, headers: { 'Retry-After': '3' } }) });
    expect(await tmdb.details('movie', '900001', LANG)).toEqual({ status: 'rate_limited', retryAfterMs: 3000 });
    expect(await tmdb.details('movie', '900002', LANG)).toEqual({ status: 'rate_limited', retryAfterMs: 3000 });
    expect(apiCalls()).toHaveLength(1);
    expect(tmdb.state()).toBe('degraded');
  });

  it.each([
    [500, 'tmdb: HTTP 500'],
    [503, 'tmdb: HTTP 503'],
  ])('HTTP %i: unavailable', async (status, detail) => {
    fetch.routes.unshift({ match: (u) => u.host === 'api.themoviedb.org', reply: () => ({ status }) });
    expect(await tmdb.search({ query: 'x', kind: 'movie', year: null, lang: LANG })).toEqual({ status: 'unavailable', detail });
  });

  it('timeout: unavailable', async () => {
    fetch.routes.unshift({ match: (u) => u.host === 'api.themoviedb.org', reply: () => ({ error: 'timeout' }) });
    expect(await tmdb.details('movie', '900001', LANG)).toEqual({ status: 'unavailable', detail: 'tmdb: timeout after 1000 ms' });
  });

  it('401: invalid_credentials, so the identifier chain skips TMDB', async () => {
    tmdb = make('wrong-token-value-123456');
    expect(await tmdb.validate()).toBe('invalid_credentials');
    expect(await tmdb.search({ query: 'faro', kind: 'movie', year: null, lang: LANG })).toEqual({ status: 'unavailable', detail: 'tmdb: invalid credentials' });
    expect(tmdb.state()).toBe('invalid_credentials');
  });

  it('validate: ok with the right token', async () => {
    expect(await tmdb.validate()).toBe('ok');
  });

  it('the token is only in the Authorization header: not in URLs, cache keys, cache rows, logs or errors', async () => {
    await tmdb.validate();
    await tmdb.search({ query: 'faro', kind: null, year: 2019, lang: LANG });
    await tmdb.details('movie', '900001', LANG);
    await tmdb.lookupByExternalId({ ns: 'imdb', id: 'tt9000001', lang: LANG });
    await tmdb.seasons('800001', [1], LANG);
    await tmdb.fetchImage({ type: 'backdrop', ref: '/backdrop.jpg', language: null, width: 3840, height: 2160 });
    fetch.routes.unshift({ match: () => true, reply: () => ({ error: 'network' }) });
    const failed = await tmdb.details('movie', '424242', LANG);
    for (const c of fetch.calls) {
      expect(c.url).not.toContain(TOKEN);
      if (c.url.startsWith('https://api.themoviedb.org/')) expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      else expect(c.headers.Authorization).toBeUndefined(); // images need no token
    }
    const rows = db.$client.prepare('SELECT cache_key, response FROM provider_cache').all() as { cache_key: string; response: string }[];
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect(`${r.cache_key} ${r.response}`).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
  });
});
