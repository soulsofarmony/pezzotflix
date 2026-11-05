// Matcher (pure): the S4 v2 rule (ADR 0007 point 4), the root-hint filter with its "paracadute"
// (kind_mismatch, library standard §2), the ID-tag coherence check (§3.3) and the extra conditions
// of the TMDB search fallback (ADR 0007 point 4.3). No I/O.
import type { MetadataCandidate, WorkKind } from '../../shared/metadata.ts';
import { ratio, tokenSortRatio } from './fuzz.ts';
import { normalizeTitle, titleNumbers, titleWords } from './normalize.ts';

export const W_TITLE = 0.55;
export const W_YEAR = 0.35;
export const W_KIND = 0.1;
/** T: minimum score of an auto-match (S4 v2, ADR 0007). */
export const ACCEPT_SCORE = 0.8;
/** M: minimum gap between the best and the second candidate (also D6 for names without a year). */
export const MIN_GAP = 0.1;
/** A title whose numbers differ ("2049" vs "2048", "Parte II") is penalised. */
export const NUMBER_PENALTY = 0.7;
/** ID-tag check: title similarity accepted besides the word-subset rule; looser than ACCEPT_SCORE. */
export const ID_TITLE_MIN = 0.6;
/** ID-tag check: the year in the name may differ by one from the work's. */
export const ID_YEAR_TOLERANCE = 1;
/** TMDB fallback, names with a year: an 'ambiguous' case goes to the most voted candidate within M if it has this many times the votes of the next. */
export const VOTE_TIEBREAK_RATIO = 10;
/**
 * TMDB fallback: an exact-title winner goes to review when a same-year candidate that also passes
 * T has at least this many times its votes ("Il Professore (2019)", S4). In-sample, to re-tune
 * on the real library (ADR 0007 "Da rivedere").
 */
export const LOW_VOTED_EXACT_TITLE_RATIO = 20;

export interface MatchQuery {
  title: string;
  year: number | null;
  /** Kind the file can be linked to; null scores every kind alike. */
  kind: WorkKind | null;
}

export interface ScoreSignals {
  title: number;
  year: number;
  kind: number;
}

export interface ScoredCandidate {
  candidate: MetadataCandidate;
  score: number;
  signals: ScoreSignals;
}

export type ReviewReason = 'no_candidates' | 'low_score' | 'ambiguous' | 'kind_mismatch';

export type Decision =
  | { outcome: 'auto'; best: ScoredCandidate; scored: ScoredCandidate[]; rule: 'v2' | 'votes' }
  | { outcome: 'review'; reason: ReviewReason; best: ScoredCandidate | null; scored: ScoredCandidate[] };

/** Python's round(x, 4) for the scores the spike compared (half-way ties aside). */
export const round4 = (x: number): number => Number(x.toFixed(4));

export const candidateTitles = (c: MetadataCandidate): string[] =>
  [c.titles.localized, c.titles.english, ...c.titles.original, ...c.titles.aliases].filter((t): t is string => !!t);

const sameNumbers = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Best of ratio and token_sort_ratio over every title of the candidate, number penalty applied (S4 v2). */
export function titleSimilarity(query: string, c: MetadataCandidate): number {
  const qt = normalizeTitle(query);
  const qn = titleNumbers(query);
  let best = 0;
  for (const t of candidateTitles(c)) {
    const ct = normalizeTitle(t);
    let s = Math.max(ratio(qt, ct), tokenSortRatio(qt, ct)) / 100;
    if (!sameNumbers(titleNumbers(t), qn)) s *= NUMBER_PENALTY;
    best = Math.max(best, s);
  }
  return best;
}

export function yearScore(queryYear: number | null, years: readonly number[]): number {
  if (queryYear === null) return 0.5;
  if (!years.length) return 0.3;
  const d = Math.min(...years.map((y) => Math.abs(queryYear - y)));
  return d === 0 ? 1 : d === 1 ? 0.8 : d === 2 ? 0.3 : 0;
}

export function scoreCandidate(q: MatchQuery, c: MetadataCandidate): ScoredCandidate {
  const signals = {
    title: titleSimilarity(q.title, c),
    year: yearScore(q.year, c.years),
    kind: q.kind === null || c.ref.kind === q.kind ? 1 : 0,
  };
  return { candidate: c, score: round4(W_TITLE * signals.title + W_YEAR * signals.year + W_KIND * signals.kind), signals };
}

/** Highest score first; ties as Python's sorted((score, ref), reverse=True). */
const byScore = (a: ScoredCandidate, b: ScoredCandidate): number =>
  b.score - a.score || (a.candidate.ref.id < b.candidate.ref.id ? 1 : a.candidate.ref.id > b.candidate.ref.id ? -1 : 0);

export const scoreAll = (q: MatchQuery, cands: readonly MetadataCandidate[]): ScoredCandidate[] => cands.map((c) => scoreCandidate(q, c)).sort(byScore);

/** The v2 decision on one pool of candidates: auto if best ≥ T and best − second ≥ M. */
export function decideV2(q: MatchQuery, cands: readonly MetadataCandidate[]): Decision {
  const scored = scoreAll(q, cands);
  const best = scored[0];
  if (!best) return { outcome: 'review', reason: 'no_candidates', best: null, scored };
  const second = scored[1]?.score ?? 0;
  if (best.score < ACCEPT_SCORE) return { outcome: 'review', reason: 'low_score', best, scored };
  if (best.score - second < MIN_GAP) return { outcome: 'review', reason: 'ambiguous', best, scored };
  return { outcome: 'auto', best, scored, rule: 'v2' };
}

/**
 * How the kind is used (standard §2):
 * - filter: only candidates of the expected kind can match; a strong one of the other kind gives
 *   kind_mismatch ("conta, con paracadute"). Roots with a movies/series hint, and structure anywhere.
 * - soft: no filter and no kind_mismatch (mixed roots); the kind only weighs in the score.
 * - blocked: the hint and the structure disagree (a single file without episode numbers in a series
 *   root): nothing is matched, a strong candidate of either kind gives kind_mismatch.
 */
export type KindMode = 'filter' | 'soft' | 'blocked';

export function decideMatch(q: MatchQuery & { kind: WorkKind }, cands: readonly MetadataCandidate[], mode: KindMode): Decision {
  const all = scoreAll(q, cands);
  if (mode === 'soft') {
    const d = decideV2(q, cands);
    if (d.outcome === 'auto' && d.best.candidate.ref.kind !== q.kind) return { outcome: 'review', reason: 'ambiguous', best: d.best, scored: all };
    return { ...d, scored: all };
  }
  const same = cands.filter((c) => c.ref.kind === q.kind);
  const other = cands.filter((c) => c.ref.kind !== q.kind);
  const d = same.length ? decideV2(q, same) : null;
  if (d?.outcome === 'auto') {
    if (mode === 'filter') return { ...d, scored: all };
    return { outcome: 'review', reason: 'kind_mismatch', best: d.best, scored: all };
  }
  if (other.length) {
    // The other kind scored as if it were the expected one: is it a clear match on its own?
    const o = decideV2({ ...q, kind: null }, other);
    const sameBest = d?.best?.score ?? 0;
    if (o.outcome === 'auto' && o.best.score - sameBest >= MIN_GAP) {
      const best = all.find((s) => s.candidate === o.best.candidate) ?? null;
      return { outcome: 'review', reason: 'kind_mismatch', best, scored: all };
    }
  }
  if (d) return { ...d, scored: all };
  return other.length
    ? { outcome: 'review', reason: 'low_score', best: all[0] ?? null, scored: all }
    : { outcome: 'review', reason: 'no_candidates', best: null, scored: all };
}

// ---------------------------------------------------------------- ID tags (standard §3.3)

export interface Coherence {
  coherent: boolean;
  title: number;
  /** One title's words contain the other's. */
  subset: boolean;
  yearDelta: number | null;
}

const isSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size > 0 && [...a].every((w) => b.has(w));

/** "Fidati, ma controlla": the name agrees with the work of its ID tag (title vs every title, year ±1). */
export function idCoherence(name: { title: string | null; year: number | null }, c: MetadataCandidate): Coherence {
  let title = 0;
  let subset = false;
  if (name.title) {
    const qt = normalizeTitle(name.title);
    const qw = titleWords(name.title);
    for (const t of candidateTitles(c)) {
      const ct = normalizeTitle(t);
      title = Math.max(title, ratio(qt, ct) / 100, tokenSortRatio(qt, ct) / 100);
      const cw = titleWords(t);
      if (isSubset(qw, cw) || isSubset(cw, qw)) subset = true;
    }
  }
  const yearDelta = name.year !== null && c.years.length ? Math.min(...c.years.map((y) => Math.abs(y - (name.year ?? y)))) : null;
  const titleOk = name.title === null || subset || title >= ID_TITLE_MIN;
  const yearOk = yearDelta === null || yearDelta <= ID_YEAR_TOLERANCE;
  return { coherent: titleOk && yearOk, title, subset, yearDelta };
}

// ---------------------------------------------------------------- TMDB search fallback (ADR 0007 point 4.3)

const votes = (s: ScoredCandidate): number => s.candidate.voteCount ?? 0;

/**
 * Names with a year: an 'ambiguous' case is won by the most voted candidate within M of the best,
 * if it has at least VOTE_TIEBREAK_RATIO times the votes of the next one.
 */
export function voteTiebreak(q: MatchQuery, d: Decision): Decision {
  if (d.outcome !== 'review' || d.reason !== 'ambiguous' || q.year === null || !d.best) return d;
  const top = d.best.score;
  const pool = d.scored.filter((s) => (q.kind === null || s.candidate.ref.kind === q.kind) && s.score >= ACCEPT_SCORE && top - s.score < MIN_GAP);
  const byVotes = [...pool].sort((a, b) => votes(b) - votes(a));
  const [first, second] = byVotes;
  if (!first || !second) return d;
  if (votes(first) < VOTE_TIEBREAK_RATIO * Math.max(votes(second), 1)) return d;
  return { outcome: 'auto', best: first, scored: d.scored, rule: 'votes' };
}

/** An exact title with far fewer votes than a same-year near title that also passes T goes to review. */
export function lowVotedExactTitle(q: MatchQuery, d: Decision): Decision {
  if (d.outcome !== 'auto' || d.best.signals.title < 1) return d;
  const best = d.best;
  const rival = d.scored.find(
    (s) =>
      s !== best &&
      (q.kind === null || s.candidate.ref.kind === q.kind) &&
      s.score >= ACCEPT_SCORE &&
      s.candidate.years.some((y) => best.candidate.years.includes(y)) &&
      votes(s) >= LOW_VOTED_EXACT_TITLE_RATIO * Math.max(votes(best), 1),
  );
  return rival ? { outcome: 'review', reason: 'ambiguous', best, scored: d.scored } : d;
}

/** Blocked mode (standard §2): whatever rule produced an auto-match, the file is not linked. */
export function blockAuto(d: Decision, mode: KindMode): Decision {
  if (mode !== 'blocked' || d.outcome !== 'auto') return d;
  return { outcome: 'review', reason: 'kind_mismatch', best: d.best, scored: d.scored };
}

export type Uniqueness = 'unique' | 'not_unique';

/**
 * Names without a year (D6): the TMDB top results can hide homonyms ("Up"), so the winner must
 * also be the unique match on Wikidata, the same work by TMDB id.
 */
export function wikidataUniqueness(q: MatchQuery & { kind: WorkKind }, wikidata: readonly MetadataCandidate[], winner: MetadataCandidate): Uniqueness {
  const d = decideMatch(q, wikidata, 'filter');
  return d.outcome === 'auto' && d.best.candidate.externalIds.tmdb === winner.ref.id ? 'unique' : 'not_unique';
}

export function requireUniqueness(d: Decision, uniqueness: Uniqueness): Decision {
  if (d.outcome !== 'auto' || uniqueness === 'unique') return d;
  return { outcome: 'review', reason: 'ambiguous', best: d.best, scored: d.scored };
}
