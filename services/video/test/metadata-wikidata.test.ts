// Wikidata adapter: mapping of wbgetentities / search / WDQS answers to neutral candidates and
// details, through a fake fetch. Wikidata data is CC0; these entities are trimmed by hand.
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createProviderCache } from '../src/modules/metadata/cache.ts';
import { createHostGate, type HttpDeps } from '../src/modules/metadata/http.ts';
import type { ProviderAdapter } from '../src/modules/metadata/types.ts';
import { candidateOf, createWikidata, durationMsOf, sanitizeQuery, trimEntity } from '../src/modules/metadata/wikidata.ts';
import { type FakeClock, type FakeFetch, fakeClock, fakeFetch, testImage } from './helpers/metadata-fetch.ts';
import { claim, entitiesReply, wdEntity } from './helpers/wikidata-entities.ts';

const LANG = 'it-IT';
const log = pino({ level: 'silent' });

const BR2049 = wdEntity('Q21500755', { it: 'Blade Runner 2049', en: 'Blade Runner 2049' }, {
  P31: [claim.item('Q11424')],
  P577: [claim.time('+2017-10-05T00:00:00Z'), claim.time('+2017-10-06T00:00:00Z')],
  P1476: [claim.text('Blade Runner 2049', 'en')],
  P4947: [claim.str('335984')],
  P345: [claim.str('tt1856101')],
  P57: [claim.item('Q1320696')],
  P161: [claim.item('Q83492', { P4633: ['K'] }), claim.item('Q81328', { P4633: ['Rick Deckard'] })],
  P136: [claim.item('Q471839'), claim.item('Q130232')],
  P2047: [claim.quantity(164, 'Q7727')],
  P18: [claim.str('Blade Runner 2049 logo.jpg')],
}, { it: ['BR 2049'] });
const DUNE_NOVEL = wdEntity('Q190192', { it: 'Dune', en: 'Dune' }, { P31: [claim.item('Q7725634')] });
const DARK = wdEntity('Q28443710', { it: 'Dark', en: 'Dark' }, {
  P31: [claim.item('Q5398426')],
  P580: [claim.time('+2017-12-01T00:00:00Z')],
  P577: [claim.time('+2017-12-01T00:00:00Z')],
  P4983: [claim.str('70523')],
  P4835: [claim.str('334824')],
  P170: [claim.item('Q29512371')],
});
const PLANET = wdEntity('Q23021297', { it: 'Pianeta Terra II', en: 'Planet Earth II' }, {
  P31: [claim.item('Q5398426')],
  P136: [claim.item('Q1146335')],
  P4983: [claim.str('68595')],
});
const LABELS = [
  wdEntity('Q1320696', { it: 'Denis Villeneuve', en: 'Denis Villeneuve' }),
  wdEntity('Q83492', { it: 'Ryan Gosling', en: 'Ryan Gosling' }),
  wdEntity('Q81328', { it: 'Harrison Ford', en: 'Harrison Ford' }),
  wdEntity('Q29512371', { en: 'Baran bo Odar' }),
  wdEntity('Q471839', { it: 'film di fantascienza', en: 'science fiction film' }, { P279: [claim.item('Q11424')] }),
  wdEntity('Q130232', { it: 'film drammatico', en: 'drama film' }, { P279: [claim.item('Q11424')] }),
  wdEntity('Q11424', { it: 'film', en: 'film' }),
  wdEntity('Q5398426', { it: 'serie televisiva', en: 'television series' }),
  wdEntity('Q1146335', { it: 'documentario naturalistico', en: 'nature documentary' }, { P279: [claim.item('Q93204')] }),
];
const ALL = [BR2049, DUNE_NOVEL, DARK, PLANET, ...LABELS];

let db: Db;
let fetch: FakeFetch;
let wd: ProviderAdapter;
let searchStatus: number;
let clock: FakeClock;

beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
  searchStatus = 200;
  fetch = fakeFetch([
    {
      match: (u) => u.host === 'www.wikidata.org' && u.searchParams.get('list') === 'search',
      reply: (u) => {
        if (searchStatus !== 200) return { status: searchStatus };
        const q = u.searchParams.get('srsearch') ?? '';
        if (q.startsWith('haswbstatement:P4947=335984')) return { json: { query: { search: [{ title: 'Q21500755' }] } } };
        if (q.startsWith('haswbstatement:')) return { json: { query: { search: [] } } };
        if (q.startsWith('Blade Runner 2049 ')) return { json: { query: { search: [{ title: 'Q21500755' }] } } };
        if (q.startsWith('Dark ')) return { json: { query: { search: [{ title: 'Q28443710' }, { title: 'Q21500755' }] } } };
        return { json: { query: { search: [] } } };
      },
    },
    {
      match: (u) => u.host === 'www.wikidata.org' && u.searchParams.get('action') === 'wbsearchentities',
      reply: () => ({ json: { search: [{ id: 'Q190192' }, { id: 'Q21500755' }] } }),
    },
    { match: (u) => u.host === 'www.wikidata.org' && u.searchParams.get('action') === 'wbgetentities', reply: (u) => ({ json: entitiesReply(ALL, u) }) },
    {
      match: (u) => u.host === 'query.wikidata.org',
      reply: () => ({
        json: {
          results: {
            bindings: [
              { sn: { value: '1' }, en: { value: '1' }, ll: { value: 'Segreti' }, enl: { value: 'Secrets' }, date: { value: '2017-12-01T00:00:00Z' } },
              { sn: { value: '1' }, en: { value: '2' }, enl: { value: 'Lies' } },
              { sn: { value: '1' }, en: { value: '2' }, enl: { value: 'Lies (dup)' } },
              { sn: { value: '2' }, en: { value: '1' }, ll: { value: 'Inizi e fini' } },
            ],
          },
        },
      }),
    },
    { match: (u) => u.host === 'commons.wikimedia.org' && u.pathname.endsWith('.jpg'), reply: async () => ({ bytes: await testImage(64, 36), contentType: 'image/jpeg' }) },
    { match: (u) => u.host === 'commons.wikimedia.org', reply: () => ({ bytes: Buffer.from('<svg/>'), contentType: 'image/svg+xml' }) },
  ]);
  clock = fakeClock();
  const http: HttpDeps = { fetch, clock, log, userAgent: 'Pezzotflix/0.1 (https://github.com/soulsofarmony/pezzotflix)', secrets: [] };
  const spec = (name: string) => ({ name, ratePerSec: 1, burst: 1, concurrency: 1, timeoutMs: 1000 });
  wd = createWikidata({
    api: createHostGate(spec('wikidata'), http),
    wdqs: createHostGate(spec('wdqs'), http),
    commons: createHostGate(spec('commons'), http),
    cache: createProviderCache(db),
    now: clock.now,
    enabled: true,
  });
});
afterEach(() => closeDb(db));

const calls = (pred: (u: URL) => boolean) => fetch.calls.filter((c) => pred(new URL(c.url)));

describe('entity mapping (pure)', () => {
  it('trimEntity drops deprecated claims, puts preferred first, keeps the character qualifier', () => {
    const raw = wdEntity('Q1', { it: 'X' }, {
      P577: [claim.time('+2001-01-01T00:00:00Z'), { ...claim.time('+1999-01-01T00:00:00Z'), rank: 'preferred' }, { ...claim.time('+1990-01-01T00:00:00Z'), rank: 'deprecated' }],
      P161: [claim.item('Q2', { P4633: ['Tizio'] })],
    });
    const e = trimEntity(raw, ['it', 'en']);
    expect(e?.claims.P577?.map((c) => c.v)).toEqual(['+1999-01-01T00:00:00Z', '+2001-01-01T00:00:00Z']);
    expect(e?.claims.P161).toEqual([{ v: 'Q2', q: { P4633: ['Tizio'] } }]);
    expect(trimEntity({ id: 'Q9', missing: '' }, ['it'])).toBeNull();
  });

  it('candidateOf: kind, titles, years, ids, documentary', () => {
    const e = trimEntity(BR2049, ['it', 'en']);
    expect(e && candidateOf(e, LANG)).toEqual({
      ref: { provider: 'wikidata', id: 'Q21500755', kind: 'movie' },
      titles: { localized: 'Blade Runner 2049', english: 'Blade Runner 2049', original: ['Blade Runner 2049'], aliases: ['BR 2049'] },
      years: [2017],
      documentary: false,
      externalIds: { wikidata: 'Q21500755', tmdb: '335984', imdb: 'tt1856101' },
      voteCount: null,
    });
    const dark = trimEntity(DARK, ['it', 'en']);
    expect(dark && candidateOf(dark, LANG)).toMatchObject({ ref: { kind: 'series' }, years: [2017], externalIds: { tmdb: '70523', tvdb: '334824' } });
    expect(e && durationMsOf(e)).toBe(164 * 60_000);
  });

  it.each([
    ['Il Buono, il Brutto, il Cattivo', 'Il Buono, il Brutto, il Cattivo'],
    ['"2012"', '2012'],
    ['-Up', 'Up'],
    ['haswbstatement:P31=Q5 film', 'P31=Q5 film'],
    ['  ', ''],
  ])('sanitizeQuery(%j) = %j', (q, out) => {
    expect(sanitizeQuery(q)).toBe(out);
  });
});

describe('search', () => {
  it('full text on works with a TMDB id, both kinds, then one batched wbgetentities; cached afterwards', async () => {
    const r = await wd.search({ query: 'Dark', kind: 'series', year: 2017, lang: LANG });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.value.map((c) => [c.ref.id, c.ref.kind])).toEqual([
      ['Q28443710', 'series'],
      ['Q21500755', 'movie'],
    ]);
    const s = calls((u) => u.searchParams.get('list') === 'search')[0];
    expect(new URL(s?.url ?? '').searchParams.get('srsearch')).toBe('Dark haswbstatement:P4947|P4983');
    expect(s?.headers['User-Agent']).toBe('Pezzotflix/0.1 (https://github.com/soulsofarmony/pezzotflix)');
    const g = calls((u) => u.searchParams.get('action') === 'wbgetentities');
    expect(g).toHaveLength(1);
    expect(new URL(g[0]?.url ?? '').searchParams.get('ids')).toBe('Q28443710|Q21500755');
    const before = fetch.calls.length;
    expect(await wd.search({ query: 'dark', kind: null, year: null, lang: LANG })).toEqual(r);
    expect(fetch.calls.length).toBe(before);
  });

  it('an unknown title is an empty list, not an error', async () => {
    expect(await wd.search({ query: 'Long Test', kind: 'movie', year: 2024, lang: LANG })).toEqual({ status: 'ok', value: [] });
  });

  it('a query that failed twice switches to the label search, keeping works with a TMDB id', async () => {
    searchStatus = 504;
    const q = { query: '2012', kind: 'movie' as const, year: 2009, lang: LANG };
    expect((await wd.search(q)).status).toBe('unavailable');
    expect((await wd.search(q)).status).toBe('unavailable');
    const r = await wd.search(q);
    expect(r.status === 'ok' && r.value.map((c) => c.ref.id)).toEqual(['Q21500755']); // the novel has no TMDB id
    expect(calls((u) => u.searchParams.get('action') === 'wbsearchentities')).toHaveLength(1);
  });

  it('an Action API error answered with HTTP 200 is unavailable', async () => {
    fetch.routes.unshift({ match: (u) => u.searchParams.get('list') === 'search', reply: () => ({ json: { error: { code: 'ratelimited', info: 'x' } } }) });
    expect(await wd.search({ query: 'Dune', kind: null, year: null, lang: LANG })).toEqual({ status: 'unavailable', detail: 'wikidata: ratelimited' });
  });
});

describe('lookupByExternalId', () => {
  it('haswbstatement on the namespace property, with aliases', async () => {
    const r = await wd.lookupByExternalId({ ns: 'tmdb_movie', id: '335984', lang: LANG });
    expect(r.status === 'ok' && r.value).toMatchObject({ ref: { id: 'Q21500755', kind: 'movie' }, titles: { aliases: ['BR 2049'] } });
    expect(new URL(fetch.calls[0]?.url ?? '').searchParams.get('srsearch')).toBe('haswbstatement:P4947=335984');
  });

  it('not found is cached; a QID is read directly; a malformed id is rejected', async () => {
    expect(await wd.lookupByExternalId({ ns: 'imdb', id: 'tt0000001', lang: LANG })).toEqual({ status: 'not_found' });
    const n = fetch.calls.length;
    expect(await wd.lookupByExternalId({ ns: 'imdb', id: 'tt0000001', lang: LANG })).toEqual({ status: 'not_found' });
    expect(fetch.calls.length).toBe(n);
    const q = await wd.lookupByExternalId({ ns: 'wikidata', id: 'Q28443710', lang: LANG });
    expect(q.status === 'ok' && q.value.ref.kind).toBe('series');
    expect((await wd.lookupByExternalId({ ns: 'imdb', id: '1856101', lang: LANG })).status).toBe('invalid_request');
  });

  it('a missing entity is asked again after a day, not after the 30-day cache TTL', async () => {
    const entityCalls = () => fetch.calls.filter((c) => c.url.includes('wbgetentities')).length;
    expect(await wd.details('movie', 'Q404404', LANG)).toEqual({ status: 'not_found' });
    const n = entityCalls();
    clock.advance(12 * 3600_000);
    expect(await wd.details('movie', 'Q404404', LANG)).toEqual({ status: 'not_found' });
    expect(entityCalls()).toBe(n);
    clock.advance(13 * 3600_000);
    await wd.details('movie', 'Q404404', LANG);
    expect(entityCalls()).toBe(n + 1);
  });
});

describe('details, seasons, images', () => {
  it('film: fields, genres from labels, director and cast with characters, images', async () => {
    const r = await wd.details('movie', 'Q21500755', LANG);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.value.fields).toEqual({ title: 'Blade Runner 2049', originalTitle: 'Blade Runner 2049', year: 2017, category: 'film', genres: ['film di fantascienza', 'film drammatico'] });
    expect(r.value.credits).toEqual([
      { name: 'Denis Villeneuve', role: 'director', character: null, order: 0, personRef: 'Q1320696' },
      { name: 'Ryan Gosling', role: 'actor', character: 'K', order: 0, personRef: 'Q83492' },
      { name: 'Harrison Ford', role: 'actor', character: 'Rick Deckard', order: 1, personRef: 'Q81328' },
    ]);
    expect(r.value.images).toEqual([{ type: 'backdrop', ref: 'Blade Runner 2049 logo.jpg', language: null, width: null, height: null }]);
  });

  it('series: creator (English label fallback) and documentary through a subclass of documentary film', async () => {
    const dark = await wd.details('series', 'Q28443710', LANG);
    expect(dark.status === 'ok' && dark.value.credits).toEqual([{ name: 'Baran bo Odar', role: 'creator', character: null, order: 0, personRef: 'Q29512371' }]);
    expect(dark.status === 'ok' && dark.value.fields.category).toBeNull();
    const planet = await wd.details('series', 'Q23021297', LANG);
    expect(planet.status === 'ok' && [planet.value.fields.category, planet.value.candidate.documentary]).toEqual(['documentary', true]);
  });

  it('episodes from one WDQS query: numbers, Italian label or English, first row per episode', async () => {
    const r = await wd.seasons('Q28443710', [1, 3], LANG);
    expect(r).toMatchObject({
      status: 'ok',
      value: [
        {
          season: 1,
          episodes: [
            { episode: 1, fields: { title: 'Segreti', year: 2017 }, still: null },
            { episode: 2, fields: { title: 'Lies', year: null }, still: null },
          ],
        },
      ],
    });
    expect(calls((u) => u.host === 'query.wikidata.org')[0]?.headers.Accept).toBe('application/sparql-results+json');
  });

  it('Commons images: a thumbnail of the file; non-raster answers are refused', async () => {
    const ok = await wd.fetchImage({ type: 'backdrop', ref: 'Blade Runner 2049 logo.jpg', language: null, width: null, height: null });
    expect(ok.status === 'ok' && ok.value[0]?.contentType).toBe('image/jpeg');
    expect(fetch.calls.at(-1)?.url).toBe('https://commons.wikimedia.org/wiki/Special:FilePath/Blade_Runner_2049_logo.jpg?width=1920');
    expect((await wd.fetchImage({ type: 'logo', ref: 'Logo.svg', language: null, width: null, height: null })).status).toBe('invalid_request');
  });

  it('state follows the API host health', async () => {
    expect(wd.state()).toBe('ok');
    fetch.offline = true;
    await wd.search({ query: 'Nothing cached', kind: null, year: null, lang: LANG });
    expect(wd.state()).toBe('degraded');
  });
});
