// Matcher table tests with synthetic candidates: scores, the kind modes of the standard §2, the
// ID-tag coherence of §3.3 and each TMDB fallback rule of ADR 0007 point 4.3.
import { describe, expect, it } from 'vitest';
import {
  ACCEPT_SCORE,
  blockAuto,
  decideMatch,
  decideV2,
  idCoherence,
  LOW_VOTED_EXACT_TITLE_RATIO,
  lowVotedExactTitle,
  requireUniqueness,
  scoreCandidate,
  titleSimilarity,
  VOTE_TIEBREAK_RATIO,
  voteTiebreak,
  wikidataUniqueness,
  yearScore,
} from '../src/modules/identifier/matcher.ts';
import { cand } from './helpers/fake-metadata.ts';

describe('scores', () => {
  it.each([
    [2017, [2017], 1],
    [2017, [2016, 2030], 0.8],
    [2017, [2019], 0.3],
    [2017, [2010], 0],
    [null, [2017], 0.5],
    [2017, [], 0.3],
  ] as const)('yearScore(%j, %j) = %j', (q, ys, exp) => {
    expect(yearScore(q, ys)).toBe(exp);
  });

  it('compares the query with every title of the candidate', () => {
    const c = cand({ id: 'Q1', title: 'Heat - La sfida', original: ['Heat'], aliases: ['Heat 1995'] });
    expect(titleSimilarity('Heat', c)).toBe(1);
  });

  it('penalises different numbers (2049 vs 2048)', () => {
    const c = cand({ id: 'Q2', title: 'Blade Runner 2048' });
    expect(titleSimilarity('Blade Runner 2049', c)).toBeCloseTo(0.7 * (2 * 16) / 34, 9);
  });

  it('keeps non-Latin letters: a Cyrillic title is not the number it contains (Scoperta 13)', () => {
    const c = cand({ id: 'Q3', title: 'Неизвестный 1917-й', years: [2018] });
    expect(titleSimilarity('1917', c)).toBeLessThan(0.5);
  });

  it('weights title 0.55, year 0.35, kind 0.10', () => {
    const s = scoreCandidate({ title: 'Dune', year: 2021, kind: 'movie' }, cand({ id: 'Q4', title: 'Dune', years: [2021] }));
    expect(s).toMatchObject({ score: 1, signals: { title: 1, year: 1, kind: 1 } });
    const noYear = scoreCandidate({ title: 'Dune', year: null, kind: 'movie' }, cand({ id: 'Q4', title: 'Dune', years: [2021] }));
    expect(noYear.score).toBe(0.825); // the ceiling without a year: T 0.80 lets a unique title through (D6)
  });
});

describe('v2 decision', () => {
  const q = { title: 'Dune', year: 2021, kind: 'movie' as const };
  it('auto-matches a clear best', () => {
    const d = decideV2(q, [cand({ id: 'A', title: 'Dune', years: [2021] }), cand({ id: 'B', title: 'Dune', years: [1984] })]);
    expect(d).toMatchObject({ outcome: 'auto', best: { candidate: { ref: { id: 'A' } } } });
  });
  it('is ambiguous with a gap under M', () => {
    const d = decideV2(q, [cand({ id: 'A', title: 'Dune', years: [2021] }), cand({ id: 'B', title: 'Dűne', years: [2020] })]);
    expect(d).toMatchObject({ outcome: 'review', reason: 'ambiguous' });
  });
  it('is low_score under T', () => {
    expect(decideV2(q, [cand({ id: 'A', title: 'Arrival', years: [2016] })])).toMatchObject({ outcome: 'review', reason: 'low_score' });
  });
  it('without a year matches only a unique candidate (D6)', () => {
    const noYear = { ...q, year: null };
    expect(decideV2(noYear, [cand({ id: 'A', title: 'Dune', years: [2021] })])).toMatchObject({ outcome: 'auto' });
    expect(decideV2(noYear, [cand({ id: 'A', title: 'Dune', years: [2021] }), cand({ id: 'B', title: 'Dune', years: [1984] })])).toMatchObject({
      outcome: 'review',
      reason: 'ambiguous',
    });
  });
  it('without candidates is no_candidates', () => {
    expect(decideV2(q, [])).toMatchObject({ outcome: 'review', reason: 'no_candidates' });
  });
});

describe('kind modes (standard §2, "conta, con paracadute")', () => {
  const movieQ = { title: 'Chernobyl', year: 2019, kind: 'movie' as const };
  const series = cand({ id: 'S', kind: 'series', title: 'Chernobyl', years: [2019] });
  const weakMovie = cand({ id: 'M', title: 'Chernobyl Diaries', years: [2012] });

  it('filter: only the expected kind matches; a strong other kind is kind_mismatch', () => {
    expect(decideMatch(movieQ, [series, weakMovie], 'filter')).toMatchObject({ outcome: 'review', reason: 'kind_mismatch', best: { candidate: { ref: { id: 'S' } } } });
    expect(decideMatch(movieQ, [series], 'filter')).toMatchObject({ outcome: 'review', reason: 'kind_mismatch' });
  });

  it('filter: a weak other kind is not a mismatch', () => {
    const weakSeries = cand({ id: 'S2', kind: 'series', title: 'Chernobyl: The Lost Tapes', years: [2022] });
    expect(decideMatch(movieQ, [weakSeries], 'filter')).toMatchObject({ outcome: 'review', reason: 'low_score' });
  });

  it('filter: the root kind recovers a match a soft kind would lose (S4: 7 queries)', () => {
    const q = { title: 'Inception', year: null, kind: 'movie' as const };
    const both = [cand({ id: 'M', title: 'Inception', years: [2010] }), cand({ id: 'S', kind: 'series', title: 'Inception', years: [2015] })];
    expect(decideMatch(q, both, 'filter')).toMatchObject({ outcome: 'auto', best: { candidate: { ref: { id: 'M' } } } });
  });

  it('soft (mixed root): no filter, no kind_mismatch; a series cannot take a single file', () => {
    expect(decideMatch(movieQ, [series], 'soft')).toMatchObject({ outcome: 'review', reason: 'ambiguous' });
    expect(decideMatch(movieQ, [cand({ id: 'M', title: 'Chernobyl', years: [2019] })], 'soft')).toMatchObject({ outcome: 'auto' });
  });

  it('blocked (single file in a series root): even a strong movie is kind_mismatch', () => {
    expect(decideMatch(movieQ, [cand({ id: 'M', title: 'Chernobyl', years: [2019] })], 'blocked')).toMatchObject({ outcome: 'review', reason: 'kind_mismatch' });
  });
});

describe('ID tag coherence ("fidati, ma controlla")', () => {
  const work = cand({ id: 'Q5', title: 'Il professore e il pazzo', original: ['The Professor and the Madman'], years: [2019] });
  it.each([
    [{ title: 'Il Professore', year: 2019 }, true, 'a short title contained in the long one'],
    [{ title: 'The Professor and the Madman', year: 2020 }, true, 'year ±1'],
    [{ title: 'Il Professore', year: 2015 }, false, 'year too far'],
    [{ title: 'Pulp Fiction', year: 2019 }, false, 'another title'],
    [{ title: null, year: null }, true, 'no title: only the id counts'],
  ] as const)('%j → %s (%s)', (name, coherent, _why) => {
    expect(idCoherence(name, work).coherent).toBe(coherent);
  });
});

describe('TMDB fallback rules (ADR 0007 point 4.3), synthetic candidates', () => {
  const t = (s: Parameters<typeof cand>[0]) => cand({ provider: 'tmdb', ...s });

  it('vote tie-break: with a year, the most voted within M wins with ≥ 10× the votes', () => {
    const q = { title: 'Arrival', year: 2016, kind: 'movie' as const };
    const famous = t({ id: '1', title: 'Arrival', years: [2016], votes: 18_000 });
    const obscure = t({ id: '2', title: 'Arrival', years: [2016], votes: 3 });
    const d = decideMatch(q, [famous, obscure], 'filter');
    expect(d).toMatchObject({ outcome: 'review', reason: 'ambiguous' });
    expect(voteTiebreak(q, d)).toMatchObject({ outcome: 'auto', rule: 'votes', best: { candidate: { ref: { id: '1' } } } });
  });

  it('vote tie-break: not with fewer than 10× the votes', () => {
    const q = { title: 'Arrival', year: 2016, kind: 'movie' as const };
    const a = t({ id: '1', title: 'Arrival', years: [2016], votes: 9 * VOTE_TIEBREAK_RATIO });
    const b = t({ id: '2', title: 'Arrival', years: [2016], votes: 10 });
    expect(voteTiebreak(q, decideMatch(q, [a, b], 'filter'))).toMatchObject({ outcome: 'review', reason: 'ambiguous' });
  });

  it('vote tie-break: only candidates that pass T can win', () => {
    const q = { title: 'Arrival', year: 2016, kind: 'movie' as const };
    const best = t({ id: '1', title: 'Arrivalzzz', years: [2017], votes: 5 });
    const near = t({ id: '2', title: 'Arrivalzzz', years: [2015], votes: 4 });
    const weak = t({ id: '3', title: 'Arrival', years: [], votes: 90_000 });
    const d = decideMatch(q, [best, near, weak], 'filter');
    const top = d.best?.score ?? 0;
    const weakScore = d.scored.find((s) => s.candidate === weak)?.score ?? 0;
    expect(top).toBeGreaterThanOrEqual(ACCEPT_SCORE);
    expect([weakScore < ACCEPT_SCORE, top - weakScore < 0.1]).toEqual([true, true]); // within M of the best, under T
    expect(voteTiebreak(q, d)).toMatchObject({ outcome: 'review', reason: 'ambiguous' });
  });

  it('blocked mode turns any auto-match into kind_mismatch', () => {
    const q = { title: 'Arrival', year: 2016, kind: 'movie' as const };
    const d = voteTiebreak(q, decideMatch(q, [t({ id: '1', title: 'Arrival', years: [2016], votes: 18_000 }), t({ id: '2', title: 'Arrival', years: [2016], votes: 3 })], 'blocked'));
    expect(d.outcome).toBe('auto');
    expect(blockAuto(d, 'blocked')).toMatchObject({ outcome: 'review', reason: 'kind_mismatch' });
    expect(blockAuto(d, 'filter')).toBe(d);
  });

  it('vote tie-break: never without a year (D6 untouched)', () => {
    const q = { title: 'Arrival', year: null, kind: 'movie' as const };
    const d = decideMatch(q, [t({ id: '1', title: 'Arrival', years: [2016], votes: 18_000 }), t({ id: '2', title: 'Arrival', years: [1996], votes: 1 })], 'filter');
    expect(voteTiebreak(q, d)).toBe(d);
  });

  it('exact title with far fewer votes than a same-year near title goes to review ("Il Professore")', () => {
    const q = { title: 'Il Professore', year: 2019, kind: 'movie' as const };
    const exact = t({ id: '1', title: 'Il professore', years: [2019], votes: 12 });
    const famous = t({ id: '2', title: 'Il professore e il pazzo', years: [2019], votes: 1_200 });
    const d = decideMatch(q, [exact, famous], 'filter');
    expect(d).toMatchObject({ outcome: 'auto', best: { candidate: { ref: { id: '1' } } } });
    expect(d.scored.find((s) => s.candidate === famous)?.score).toBeGreaterThanOrEqual(ACCEPT_SCORE);
    expect(lowVotedExactTitle(q, d)).toMatchObject({ outcome: 'review', reason: 'ambiguous' });
  });

  it('exact title: kept when the near title has fewer than the named ratio of votes', () => {
    const q = { title: 'Il Professore', year: 2019, kind: 'movie' as const };
    const exact = t({ id: '1', title: 'Il professore', years: [2019], votes: 100 });
    const near = t({ id: '2', title: 'Il professore e il pazzo', years: [2019], votes: 100 * LOW_VOTED_EXACT_TITLE_RATIO - 1 });
    expect(lowVotedExactTitle(q, decideMatch(q, [exact, near], 'filter'))).toMatchObject({ outcome: 'auto' });
  });

  it('without a year, uniqueness is confirmed on Wikidata ("Up")', () => {
    const q = { title: 'Up', year: null, kind: 'movie' as const };
    const tmdbUp = t({ id: '14160', title: 'Up', years: [2009], votes: 20_000 });
    const d = decideMatch(q, [tmdbUp], 'filter');
    expect(d.outcome).toBe('auto'); // the TMDB top results hide the other "Up"
    const wdTwoUps = [cand({ id: 'Q174811', title: 'Up', years: [2009], ids: { tmdb: '14160' } }), cand({ id: 'Q7897926', title: 'Up', years: [1984], ids: { tmdb: '244655' } })];
    expect(wikidataUniqueness(q, wdTwoUps, tmdbUp)).toBe('not_unique');
    expect(requireUniqueness(d, 'not_unique')).toMatchObject({ outcome: 'review', reason: 'ambiguous' });
    expect(wikidataUniqueness(q, [wdTwoUps[0]!], tmdbUp)).toBe('unique');
    expect(wikidataUniqueness(q, [], tmdbUp)).toBe('not_unique');
    expect(requireUniqueness(d, 'unique')).toBe(d);
  });
});
