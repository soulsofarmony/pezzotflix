// Opt-in live checks of the provider adapters against the real services, skipped by default.
//   PZF_LIVE_WIKIDATA=1  Wikidata, WDQS and Commons at 1 req/s, at most MAX_WIKIDATA_REQUESTS calls.
//   PZF_LIVE_TMDB=1      TMDB with TMDB_READ_TOKEN from the environment. The token is never printed:
//                        assertions compare only non-secret values, and no response body is kept.
// Responses stay in an in-memory provider_cache and are never written to the repo (ADR 0007 point 10).
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createProviderCache } from '../src/modules/metadata/cache.ts';
import { createHostGate, type FetchFn, type HttpDeps } from '../src/modules/metadata/http.ts';
import { userAgentOf, WIKIMEDIA_HOSTS } from '../src/modules/metadata/index.ts';
import { realClock } from '../src/modules/metadata/limiter.ts';
import { createTmdb, type TmdbAdapter } from '../src/modules/metadata/tmdb.ts';
import type { ProviderAdapter } from '../src/modules/metadata/types.ts';
import { createWikidata } from '../src/modules/metadata/wikidata.ts';

const LIVE_WIKIDATA = process.env.PZF_LIVE_WIKIDATA === '1';
const TOKEN = process.env.TMDB_READ_TOKEN?.trim() ?? '';
const LIVE_TMDB = process.env.PZF_LIVE_TMDB === '1' && TOKEN !== '';
const MAX_WIKIDATA_REQUESTS = 30;
const CONTACT = process.env.WIKIDATA_CONTACT ?? 'https://github.com/soulsofarmony/pezzotflix';
const LANG = 'it-IT';

if (!LIVE_WIKIDATA) process.stderr.write('[metadata-live] Wikidata skipped: set PZF_LIVE_WIKIDATA=1\n');
if (!LIVE_TMDB) process.stderr.write('[metadata-live] TMDB skipped: set PZF_LIVE_TMDB=1 and TMDB_READ_TOKEN\n');

let db: Db;
const calls: string[] = [];
/** Full request URLs, kept in memory only to check that no token is in them; never printed. */
const urls: string[] = [];
// Counts requests: host + path for the counts, the full URL for the token check.
const counting: FetchFn = (url, init) => {
  const u = new URL(url);
  calls.push(`${u.host}${u.pathname}`);
  urls.push(url);
  return fetch(url, init);
};
const http = (): HttpDeps => ({
  fetch: counting,
  clock: realClock,
  log: pino({ level: process.env.PZF_LIVE_LOG ?? 'silent' }),
  userAgent: userAgentOf(CONTACT),
  secrets: TOKEN ? [TOKEN] : [],
});
const ok = <T>(r: { status: string; value?: T }): T => {
  expect(r.status).toBe('ok');
  return r.value as T;
};

beforeAll(async () => {
  db = await openDb({ path: ':memory:' });
});
afterAll(() => {
  if (db) closeDb(db);
});

describe.skipIf(!LIVE_WIKIDATA)('live Wikidata (1 req/s)', () => {
  let wd: ProviderAdapter;
  beforeAll(() => {
    const gate = (name: string, redirectHosts?: RegExp) => createHostGate({ name, ratePerSec: 1, burst: 1, concurrency: 1, timeoutMs: 60_000, ...(redirectHosts ? { redirectHosts } : {}) }, http());
    wd = createWikidata({ api: gate('wikidata'), wdqs: gate('wdqs'), commons: gate('commons', WIKIMEDIA_HOSTS), cache: createProviderCache(db), now: Date.now, enabled: true });
  });
  afterAll(() => {
    const own = calls.filter((c) => !c.startsWith('api.themoviedb.org') && !c.startsWith('image.tmdb.org'));
    process.stderr.write(`[metadata-live] Wikidata requests: ${own.length}\n`);
    expect(own.length).toBeLessThanOrEqual(MAX_WIKIDATA_REQUESTS);
  });

  it('search finds Blade Runner 2049 (Q21500755) with its year', async () => {
    const found = ok(await wd.search({ query: 'Blade Runner 2049', kind: 'movie', year: 2017, lang: LANG }));
    const hit = found.find((c) => c.ref.id === 'Q21500755');
    expect(hit?.years).toContain(2017);
  }, 60_000);

  it('lookup by TMDB movie id 335984 gives the same QID', async () => {
    const c = ok(await wd.lookupByExternalId({ ns: 'tmdb_movie', id: '335984', lang: LANG }));
    expect(c.ref.id).toBe('Q21500755');
  }, 60_000);

  it('details: Italian title, director, genres, at least one image', async () => {
    const d = ok(await wd.details('movie', 'Q21500755', LANG));
    expect(d.fields.title).toBeTruthy();
    expect(d.credits.some((c) => c.role === 'director')).toBe(true);
    expect(d.fields.genres?.length ?? 0).toBeGreaterThan(0);
    expect(d.images.length).toBeGreaterThan(0);
    process.stderr.write(`[metadata-live] Q21500755: title=${String(d.fields.title)} credits=${d.credits.length} images=${d.images.map((i) => i.type).join(',')}\n`);
  }, 120_000);

  it('Dark (TMDB tv 70523): series by id, season 1 episodes from WDQS', async () => {
    const c = ok(await wd.lookupByExternalId({ ns: 'tmdb_tv', id: '70523', lang: LANG }));
    expect(c.ref.kind).toBe('series');
    const seasons = ok(await wd.seasons(c.ref.id, [1], LANG));
    const s1 = seasons.find((s) => s.season === 1);
    expect(s1?.episodes.length ?? 0).toBeGreaterThanOrEqual(10);
    process.stderr.write(`[metadata-live] Dark ${c.ref.id}: season 1 has ${s1?.episodes.length ?? 0} episodes\n`);
  }, 120_000);

  it('a Commons image downloads', async () => {
    const d = ok(await wd.details('movie', 'Q21500755', LANG)); // cached: no request
    const image = d.images[0];
    if (!image) throw new Error('no image');
    const files = ok(await wd.fetchImage(image));
    expect(files[0]?.bytes.length ?? 0).toBeGreaterThan(1000);
  }, 120_000);
});

describe.skipIf(!LIVE_TMDB)('live TMDB', () => {
  let tmdb: TmdbAdapter;
  beforeAll(() => {
    tmdb = createTmdb({
      api: createHostGate({ name: 'tmdb', ratePerSec: 20, burst: 4, concurrency: 4, timeoutMs: 10_000 }, http()),
      images: createHostGate({ name: 'tmdb-images', ratePerSec: 10, burst: 2, concurrency: 4, timeoutMs: 30_000 }, http()),
      cache: createProviderCache(db),
      now: Date.now,
      token: TOKEN,
    });
  });

  it('the token is accepted', async () => {
    expect(await tmdb.validate()).toBe('ok');
  }, 30_000);

  it('search, details with Italian title and credits, poster sizes', async () => {
    const found = ok(await tmdb.search({ query: 'Blade Runner 2049', kind: 'movie', year: 2017, lang: LANG }));
    expect(found.some((c) => c.ref.id === '335984')).toBe(true);
    const d = ok(await tmdb.details('movie', '335984', LANG));
    // No Italian translated title (Blade Runner 2049 has an empty one): then the Wikidata label shows.
    expect(d.fields.title ?? d.fields.originalTitle).toBeTruthy();
    expect(d.credits.some((c) => c.role === 'director')).toBe(true);
    const poster = d.images.find((i) => i.type === 'poster');
    if (!poster) throw new Error('no poster');
    const files = ok(await tmdb.fetchImage(poster));
    expect(files.map((f) => f.size)).toEqual(['w342', 'w780']);
  }, 60_000);

  it('Dark season 1 has its episodes', async () => {
    const seasons = ok(await tmdb.seasons('70523', [1], LANG));
    expect(seasons[0]?.episodes.length ?? 0).toBeGreaterThanOrEqual(10);
  }, 60_000);

  it('no request URL carried the token', () => {
    // A boolean only: the assertion message never contains the URL or the token.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes(TOKEN))).toBe(false);
  });
});
