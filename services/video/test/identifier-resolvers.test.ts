// Resolver chain order and failure handling (doc 02 §3.3, ADR 0007 point 4), on an in-memory port.
import { describe, expect, it } from 'vitest';
import type { MetadataCandidate } from '../src/shared/metadata.ts';
import type { MetadataSearchPort } from '../src/shared/ports.ts';
import { parsePath } from '../src/modules/identifier/parser.ts';
import {
  DEFAULT_RESOLVERS,
  NO_PROVIDER_RETRY_MS,
  runChain,
  type WorkQuery,
} from '../src/modules/identifier/resolvers.ts';
import { byExternalId, byTitle, cand, fakeMetadata } from './helpers/fake-metadata.ts';

const NO_IDS = { tmdb: null, imdb: null, tvdb: null };
const query = (q: Partial<WorkQuery>): WorkQuery => ({ title: 'Dune', year: 2021, ids: NO_IDS, kind: 'movie', mode: 'filter', ...q });
const run = (metadata: MetadataSearchPort, q: Partial<WorkQuery> = {}) =>
  runChain(DEFAULT_RESOLVERS, { query: query(q), parsed: parsePath('Dune (2021)/Dune (2021).mkv', 'movies'), facts: null }, { metadata, lang: 'it' });

const wdDune = cand({ id: 'Q63985561', title: 'Dune', years: [2021], ids: { tmdb: '438631', imdb: 'tt1160419' } });
const wdDune84 = cand({ id: 'Q470283', title: 'Dune', years: [1984], ids: { tmdb: '841' } });
const tmdbDune = cand({ provider: 'tmdb', id: '438631', title: 'Dune', years: [2021], votes: 900, ids: { imdb: 'tt1160419' } });

describe('resolver chain order', () => {
  it('Wikidata decides first; TMDB is not called', async () => {
    const m = fakeMetadata({ wikidata: { search: byTitle({ dune: [wdDune, wdDune84] }) }, tmdb: { search: byTitle({ dune: [tmdbDune] }) } });
    const r = await run(m);
    expect(r).toMatchObject({ type: 'match', outcome: { resolver: 'wikidata', candidate: { ref: { id: 'Q63985561' } } } });
    expect(m.calls.map((c) => `${c.op}:${c.provider}`)).toEqual(['search:wikidata']);
  });

  it('a Wikidata review is final: TMDB does not overrule it', async () => {
    const m = fakeMetadata({ wikidata: { search: byTitle({ dune: [wdDune84] }) }, tmdb: { search: byTitle({ dune: [tmdbDune] }) } });
    expect(await run(m)).toMatchObject({ type: 'review', reason: 'low_score' });
    expect(m.calls.some((c) => c.provider === 'tmdb')).toBe(false);
  });

  it('TMDB is the fallback when Wikidata has no candidates', async () => {
    const m = fakeMetadata({ wikidata: {}, tmdb: { search: byTitle({ dune: [tmdbDune] }) } });
    expect(await run(m)).toMatchObject({ type: 'match', outcome: { resolver: 'tmdb', candidate: { ref: { provider: 'tmdb', id: '438631' } } } });
  });

  it('TMDB is the fallback when Wikidata is unavailable', async () => {
    const m = fakeMetadata({ wikidata: { search: () => ({ status: 'unavailable' }) }, tmdb: { search: byTitle({ dune: [tmdbDune] }) } });
    expect(await run(m)).toMatchObject({ type: 'match', outcome: { resolver: 'tmdb' } });
  });

  it('a Wikidata rate limit retries after its delay, without falling back', async () => {
    const m = fakeMetadata({ wikidata: { search: () => ({ status: 'rate_limited', retryAfterMs: 42_000 }) }, tmdb: { search: byTitle({ dune: [tmdbDune] }) } });
    expect(await run(m)).toEqual({ type: 'retry', retryAfterMs: 42_000, detail: 'wikidata: rate limited' });
    expect(m.calls.some((c) => c.provider === 'tmdb')).toBe(false);
  });

  it('every provider down → retry; nobody configured → long retry; nobody knows it → no_candidates', async () => {
    const down = fakeMetadata({ wikidata: { search: () => ({ status: 'unavailable' }) }, tmdb: { search: () => ({ status: 'unavailable' }) } });
    expect(await run(down)).toMatchObject({ type: 'retry', retryAfterMs: null });
    expect(await run(fakeMetadata({}))).toMatchObject({ type: 'retry', retryAfterMs: NO_PROVIDER_RETRY_MS });
    expect(await run(fakeMetadata({ wikidata: {}, tmdb: {} }))).toMatchObject({ type: 'review', reason: 'no_candidates' });
  });

  it('TMDB without results searches again without the year (off-by-one years)', async () => {
    const m = fakeMetadata({ tmdb: { search: (req) => ({ status: 'ok', value: req.year === null ? [tmdbDune] : [] }) } });
    expect(await run(m, { year: 2020 })).toMatchObject({ type: 'match', outcome: { resolver: 'tmdb' } });
    expect(m.calls.filter((c) => c.op === 'search').map((c) => ('year' in c.arg ? c.arg.year : undefined))).toEqual([2020, null]);
  });
});

describe('ID tags ("fidati, ma controlla")', () => {
  it('an ID tag wins over the fuzzy search, resolved on Wikidata first', async () => {
    const m = fakeMetadata({ wikidata: { lookup: byExternalId([wdDune]), search: byTitle({ dune: [wdDune84] }) }, tmdb: {} });
    const r = await run(m, { ids: { ...NO_IDS, imdb: 'tt1160419' } });
    expect(r).toMatchObject({ type: 'match', outcome: { resolver: 'id_tag', confidence: 1, evidence: { idTag: 'imdb-tt1160419' } } });
    expect(m.calls).toEqual([{ op: 'lookup', provider: 'wikidata', arg: { ns: 'imdb', id: 'tt1160419', lang: 'it' } }]);
  });

  it('falls back to TMDB for the lookup; the namespace follows the kind of the file', async () => {
    const m = fakeMetadata({ wikidata: {}, tmdb: { lookup: byExternalId([tmdbDune]) } });
    expect(await run(m, { ids: { ...NO_IDS, tmdb: '438631' } })).toMatchObject({ type: 'match', outcome: { resolver: 'id_tag' } });
    expect(m.calls.map((c) => c.arg)).toEqual([
      { ns: 'tmdb_movie', id: '438631', lang: 'it' },
      { ns: 'tmdb_movie', id: '438631', lang: 'it' },
    ]);
  });

  it('an id nobody knows is id_mismatch; an incoherent name is id_mismatch', async () => {
    const m = fakeMetadata({ wikidata: { lookup: byExternalId([wdDune]) }, tmdb: {} });
    expect(await run(m, { ids: { ...NO_IDS, imdb: 'tt0000001' } })).toMatchObject({ type: 'review', reason: 'id_mismatch' });
    expect(await run(m, { title: 'Pulp Fiction', year: 1994, ids: { ...NO_IDS, imdb: 'tt1160419' } })).toMatchObject({ type: 'review', reason: 'id_mismatch' });
  });

  it('an id of the other kind is kind_mismatch (id_mismatch in a mixed root)', async () => {
    const dark = cand({ id: 'Q24300155', kind: 'series', title: 'Dark', years: [2017], ids: { imdb: 'tt5753856' } });
    const m = fakeMetadata({ wikidata: { lookup: byExternalId([dark]) } });
    const ids = { ...NO_IDS, imdb: 'tt5753856' };
    expect(await run(m, { title: 'Dark', year: 2017, ids })).toMatchObject({ type: 'review', reason: 'kind_mismatch' });
    expect(await run(m, { title: 'Dark', year: 2017, ids, mode: 'soft' })).toMatchObject({ type: 'review', reason: 'id_mismatch' });
  });

  it('a lookup that fails is retried, not reviewed', async () => {
    const m = fakeMetadata({ wikidata: { lookup: () => ({ status: 'rate_limited', retryAfterMs: 5_000 }) } });
    expect(await run(m, { ids: { ...NO_IDS, imdb: 'tt1160419' } })).toMatchObject({ type: 'retry', retryAfterMs: 5_000 });
    const down = fakeMetadata({ wikidata: { lookup: () => ({ status: 'unavailable' }) } });
    expect(await run(down, { ids: { ...NO_IDS, imdb: 'tt1160419' } })).toMatchObject({ type: 'retry', retryAfterMs: null });
    expect(await run(fakeMetadata({}), { ids: { ...NO_IDS, imdb: 'tt1160419' } })).toMatchObject({ type: 'retry', retryAfterMs: NO_PROVIDER_RETRY_MS });
  });
});

describe('a provider failure never ends in review (ADR 0007 point 4)', () => {
  const wdDown = { search: () => ({ status: 'unavailable' }) as const };
  const weak = cand({ provider: 'tmdb', id: '9', title: 'Dune: Part Two', years: [2024], votes: 5000 });

  it('Wikidata down and TMDB without an auto-match: retry, review only on the last attempt', async () => {
    const m = fakeMetadata({ wikidata: wdDown, tmdb: { search: byTitle({ dune: [weak] }) } });
    expect(await run(m)).toMatchObject({ type: 'retry', retryAfterMs: null });
    const last = await runChain(DEFAULT_RESOLVERS, { query: query({}), parsed: parsePath('Dune (2021)/Dune (2021).mkv', 'movies'), facts: null }, { metadata: m, lang: 'it', finalAttempt: true });
    expect(last).toMatchObject({ type: 'review', reason: 'low_score' });
  });

  it('Wikidata down and a TMDB auto-match: final', async () => {
    const m = fakeMetadata({ wikidata: wdDown, tmdb: { search: byTitle({ dune: [tmdbDune] }) } });
    expect(await run(m)).toMatchObject({ type: 'match', outcome: { resolver: 'tmdb' } });
  });

  it('a failed alias lookup retries instead of deciding low_score', async () => {
    const hit = cand({ provider: 'tmdb', id: '11', title: 'Guerre stellari', years: [1977], votes: 20_000 });
    const title = 'Star Wars Episodio IV - Una nuova speranza';
    const search = byTitle({ [title.toLowerCase()]: [hit] });
    const limited = fakeMetadata({ tmdb: { search, lookup: () => ({ status: 'rate_limited', retryAfterMs: 7_000 }) } });
    expect(await run(limited, { title, year: 1977 })).toMatchObject({ type: 'retry', retryAfterMs: 7_000 });
    const down = fakeMetadata({ tmdb: { search, lookup: () => ({ status: 'unavailable' }) } });
    expect(await run(down, { title, year: 1977 })).toMatchObject({ type: 'retry', retryAfterMs: null });
  });
});

describe('blocked mode: a single unnumbered file in a series root is never linked (standard §2)', () => {
  const blocked = { mode: 'blocked' as const, kind: 'movie' as const };

  it('the vote tie-break does not turn it into a match', async () => {
    const famous = cand({ provider: 'tmdb', id: '1', title: 'Arrival', years: [2016], votes: 18_000 });
    const obscure = cand({ provider: 'tmdb', id: '2', title: 'Arrival', years: [2016], votes: 4 });
    const m = fakeMetadata({ wikidata: {}, tmdb: { search: byTitle({ arrival: [obscure, famous] }) } });
    expect(await run(m, { ...blocked, title: 'Arrival', year: 2016 })).toMatchObject({ type: 'review', reason: 'kind_mismatch' });
  });

  it('a coherent ID tag of either kind is kind_mismatch; an incoherent one id_mismatch', async () => {
    const arrival = cand({ id: 'Q20022010', title: 'Arrival', years: [2016], ids: { imdb: 'tt2543164' } });
    const m = fakeMetadata({ wikidata: { lookup: byExternalId([arrival]) } });
    expect(await run(m, { ...blocked, title: 'Arrival', year: 2016, ids: { ...NO_IDS, imdb: 'tt2543164' } })).toMatchObject({ type: 'review', reason: 'kind_mismatch' });
    expect(await run(m, { ...blocked, title: 'Pulp Fiction', year: 1994, ids: { ...NO_IDS, imdb: 'tt2543164' } })).toMatchObject({ type: 'review', reason: 'id_mismatch' });
  });

  it('a TMDB tag takes the namespace from the hint: "Serie/Chernobyl (2019) {tmdb-87108}.mkv" looks up a TV id', async () => {
    const chernobyl = cand({ provider: 'tmdb', id: '87108', kind: 'series', title: 'Chernobyl', years: [2019] });
    const m = fakeMetadata({ tmdb: { lookup: byExternalId([chernobyl]) } });
    const r = await run(m, { ...blocked, title: 'Chernobyl', year: 2019, ids: { ...NO_IDS, tmdb: '87108' } });
    expect(m.calls.map((c) => c.arg)).toEqual([{ ns: 'tmdb_tv', id: '87108', lang: 'it' }]);
    expect(r).toMatchObject({ type: 'review', reason: 'kind_mismatch' });
  });
});

describe('TMDB fallback rules in the chain', () => {
  it('low_score is retried with the alternative titles of the best candidates', async () => {
    const searchHit = cand({ provider: 'tmdb', id: '11', title: 'Guerre stellari', years: [1977], votes: 20_000 });
    const detailed: MetadataCandidate = { ...searchHit, titles: { ...searchHit.titles, aliases: ['Star Wars Episodio IV - Una nuova speranza'] } };
    const m = fakeMetadata({ tmdb: { search: byTitle({ 'star wars episodio iv - una nuova speranza': [searchHit] }), lookup: byExternalId([detailed]) } });
    const r = await run(m, { title: 'Star Wars Episodio IV - Una nuova speranza', year: 1977 });
    expect(r).toMatchObject({ type: 'match', outcome: { resolver: 'tmdb', candidate: { ref: { id: '11' } } } });
    expect(m.calls.map((c) => c.op)).toEqual(['search', 'lookup']);
  });

  it('a TMDB match without a year needs Wikidata to confirm uniqueness', async () => {
    const up = cand({ provider: 'tmdb', id: '14160', title: 'Up', years: [2009], votes: 20_000 });
    const tmdb = { search: byTitle({ up: [up] }) };
    // Wikidata answered with nothing: uniqueness not confirmed → review.
    expect(await run(fakeMetadata({ wikidata: {}, tmdb }), { title: 'Up', year: null })).toMatchObject({ type: 'review', reason: 'ambiguous' });
    // Wikidata down: try again later rather than guess.
    const wdDown = fakeMetadata({ wikidata: { search: () => ({ status: 'unavailable' }) }, tmdb });
    expect(await run(wdDown, { title: 'Up', year: null })).toMatchObject({ type: 'retry' });
    // With a year, TMDB decides alone.
    expect(await run(fakeMetadata({ wikidata: {}, tmdb }), { title: 'Up', year: 2009 })).toMatchObject({ type: 'match' });
  });

  it('the vote tie-break settles same-year homonyms on TMDB', async () => {
    const famous = cand({ provider: 'tmdb', id: '1', title: 'Arrival', years: [2016], votes: 18_000 });
    const obscure = cand({ provider: 'tmdb', id: '2', title: 'Arrival', years: [2016], votes: 4 });
    const m = fakeMetadata({ tmdb: { search: byTitle({ arrival: [obscure, famous] }) } });
    expect(await run(m, { title: 'Arrival', year: 2016 })).toMatchObject({ type: 'match', outcome: { candidate: { ref: { id: '1' } }, evidence: { rule: 'votes' } } });
  });
});
