// Resolver chain (doc 02 §3.3, doc 03 §8 Resolver): ID tags ("fidati, ma controlla"), fuzzy search
// on Wikidata, TMDB search as the fallback (ADR 0007 point 4). Every resolver has the same
// signature, so a future AI resolver plugs in without touching the others. A resolver either
// decides (match / review / retry) or passes to the next one with what it learnt.
import type { MediaFacts } from '../../shared/media-facts.ts';
import type { ExternalNamespace, MetadataCandidate, MetadataProviderName, ProviderResult, WorkKind } from '../../shared/metadata.ts';
import type { MetadataSearchPort } from '../../shared/ports.ts';
import {
  blockAuto,
  type Coherence,
  decideMatch,
  type Decision,
  idCoherence,
  type KindMode,
  lowVotedExactTitle,
  type MatchQuery,
  requireUniqueness,
  scoreAll,
  type ScoredCandidate,
  voteTiebreak,
  wikidataUniqueness,
} from './matcher.ts';
import type { IdTags, ParsedPath } from './parser.ts';

/** The work a file belongs to, as the chain searches it. */
export interface WorkQuery {
  title: string | null;
  year: number | null;
  ids: IdTags;
  /** Kind of work the file can be linked to. */
  kind: WorkKind;
  mode: KindMode;
}

export interface ResolverInput {
  query: WorkQuery;
  parsed: ParsedPath;
  /** Facts of the file, for resolvers that read the container (none yet). */
  facts: MediaFacts | null;
}

export type CaseReason = 'no_candidates' | 'low_score' | 'ambiguous' | 'kind_mismatch' | 'id_mismatch';

export interface Evidence {
  resolver: string;
  rule?: string;
  coherence?: Coherence;
  idTag?: string;
}

export type ResolverOutcome =
  | { type: 'match'; resolver: string; candidate: MetadataCandidate; confidence: number; scored: ScoredCandidate[]; evidence: Evidence }
  | { type: 'review'; resolver: string; reason: CaseReason; scored: ScoredCandidate[]; evidence: Evidence }
  | { type: 'retry'; resolver: string; retryAfterMs: number | null; detail: string }
  /** Not decided here: 'unavailable' lets the chain retry later if nobody decides. */
  | { type: 'pass'; resolver: string; why: 'not_applicable' | 'no_candidates' | 'unavailable'; candidates: MetadataCandidate[]; retryAfterMs?: number | null };

export interface ResolveContext {
  metadata: MetadataSearchPort;
  lang: string;
  /** Outcomes of the resolvers that passed before this one. */
  previous: readonly ResolverOutcome[];
  /**
   * Last attempt of the job: a review decided while a provider was down is accepted instead of
   * retried, so a query a provider always fails on (S4 "2012", HTTP 504) cannot loop forever.
   */
  finalAttempt?: boolean;
}

export interface Resolver {
  name: string;
  resolve(input: ResolverInput, ctx: ResolveContext): Promise<ResolverOutcome>;
}

/** Next attempt when no metadata provider is configured (or the metadata module is not there yet). */
export const NO_PROVIDER_RETRY_MS = 6 * 3600_000;

const active = (m: MetadataSearchPort, p: MetadataProviderName): boolean =>
  m.status().some((s) => s.provider === p && (s.state === 'ok' || s.state === 'degraded'));

const matchQuery = (q: WorkQuery): MatchQuery & { kind: WorkKind } => ({ title: q.title ?? '', year: q.year, kind: q.kind });

function fromDecision(resolver: string, d: Decision, evidence: Evidence = { resolver }): ResolverOutcome {
  if (d.outcome === 'auto') {
    return { type: 'match', resolver, candidate: d.best.candidate, confidence: d.best.score, scored: d.scored, evidence: { ...evidence, rule: d.rule } };
  }
  return { type: 'review', resolver, reason: d.reason, scored: d.scored, evidence };
}

/** A failed call: rate limits carry their own delay; anything else is "unavailable". */
function failure<T>(resolver: string, r: ProviderResult<T>): ResolverOutcome | null {
  if (r.status === 'rate_limited') return { type: 'retry', resolver, retryAfterMs: r.retryAfterMs, detail: `${resolver}: rate limited` };
  if (r.status === 'unavailable') return { type: 'pass', resolver, why: 'unavailable', candidates: [], retryAfterMs: null };
  return null;
}

// ---------------------------------------------------------------- 1. ID tags

const NS_OF_TAG = (q: WorkQuery): [tag: string, ns: ExternalNamespace, id: string][] => {
  const out: [string, ExternalNamespace, string][] = [];
  // "Struttura prima, poi hint" (§3.3): blocked means a series root without structure, so the hint says TV.
  const tv = q.kind === 'series' || q.mode === 'blocked';
  if (q.ids.tmdb) out.push([`tmdb-${q.ids.tmdb}`, tv ? 'tmdb_tv' : 'tmdb_movie', q.ids.tmdb]);
  if (q.ids.imdb) out.push([`imdb-${q.ids.imdb}`, 'imdb', q.ids.imdb]);
  if (q.ids.tvdb) out.push([`tvdb-${q.ids.tvdb}`, 'tvdb', q.ids.tvdb]);
  return out;
};

/**
 * Library standard §3.3, ADR 0007 point 4.1. The TMDB namespace follows the kind of the file, so a
 * series id in a movie root does not resolve to that series (id_mismatch); an IMDb or TVDB id of a
 * work of the other kind gives kind_mismatch. Resolved on Wikidata first (works without a TMDB
 * key), then on TMDB.
 */
export const idTagResolver: Resolver = {
  name: 'id_tag',
  async resolve({ query }, { metadata, lang }) {
    const tags = NS_OF_TAG(query);
    const first = tags[0];
    if (!first) return { type: 'pass', resolver: 'id_tag', why: 'not_applicable', candidates: [] };
    const [tag, ns, id] = first;
    const providers = (['wikidata', 'tmdb'] as const).filter((p) => active(metadata, p) && !(p === 'tmdb' && ns === 'tvdb'));
    let failed: ResolverOutcome | null = null;
    let found: MetadataCandidate | null = null;
    for (const p of providers) {
      const r = await metadata.lookupByExternalId(p, { ns, id, lang });
      if (r.status === 'ok') {
        found = r.value;
        break;
      }
      failed ??= failure('id_tag', r);
    }
    const evidence: Evidence = { resolver: 'id_tag', idTag: tag };
    if (!found) {
      if (failed) return failed.type === 'retry' ? failed : { type: 'retry', resolver: 'id_tag', retryAfterMs: null, detail: `id_tag: ${tag} not resolvable now` };
      if (!providers.length) return { type: 'retry', resolver: 'id_tag', retryAfterMs: NO_PROVIDER_RETRY_MS, detail: 'no metadata provider configured' };
      return { type: 'review', resolver: 'id_tag', reason: 'id_mismatch', scored: [], evidence };
    }
    const scored = scoreAll(matchQuery(query), [found]);
    if (query.mode === 'blocked') {
      // Hint and structure disagree: a coherent work of either kind is still not linked (standard §2).
      const coherence = idCoherence(query, found);
      return { type: 'review', resolver: 'id_tag', reason: coherence.coherent ? 'kind_mismatch' : 'id_mismatch', scored, evidence: { ...evidence, coherence } };
    }
    if (found.ref.kind !== query.kind) {
      return { type: 'review', resolver: 'id_tag', reason: query.mode === 'soft' ? 'id_mismatch' : 'kind_mismatch', scored, evidence };
    }
    const coherence = idCoherence(query, found);
    if (!coherence.coherent) return { type: 'review', resolver: 'id_tag', reason: 'id_mismatch', scored, evidence: { ...evidence, coherence } };
    return { type: 'match', resolver: 'id_tag', candidate: found, confidence: 1, scored, evidence: { ...evidence, coherence } };
  },
};

// ---------------------------------------------------------------- 2. fuzzy search on Wikidata

/** S4 v2 on Wikidata, root kind as a filter (D6 for names without a year: v2 gap on a unique candidate). */
export const wikidataResolver: Resolver = {
  name: 'wikidata',
  async resolve({ query }, { metadata, lang }) {
    if (!query.title || !active(metadata, 'wikidata')) return { type: 'pass', resolver: 'wikidata', why: 'not_applicable', candidates: [] };
    const r = await metadata.search('wikidata', { query: query.title, kind: query.kind, year: query.year, lang });
    const f = failure('wikidata', r);
    if (f) return f;
    const cands = r.status === 'ok' ? r.value : [];
    // ADR 0007 point 4.3: TMDB is the fallback when Wikidata does not answer or has no candidates.
    if (!cands.length) return { type: 'pass', resolver: 'wikidata', why: 'no_candidates', candidates: [] };
    return fromDecision('wikidata', decideMatch(matchQuery(query), cands, query.mode));
  },
};

// ---------------------------------------------------------------- 3. TMDB search fallback

/** low_score: how many of the best candidates are looked up again for their alternative titles. */
export const ALIAS_RETRY_CANDIDATES = 3;

export const tmdbResolver: Resolver = {
  name: 'tmdb',
  async resolve({ query }, { metadata, lang, previous, finalAttempt = false }) {
    if (!query.title || !active(metadata, 'tmdb')) return { type: 'pass', resolver: 'tmdb', why: 'not_applicable', candidates: [] };
    const q = matchQuery(query);
    const wd = previous.find((o) => o.resolver === 'wikidata');
    const wdDown = wd?.type === 'pass' && wd.why === 'unavailable' ? wd : null;
    let r = await metadata.search('tmdb', { query: query.title, kind: query.kind, year: query.year, lang });
    // The year in the name may be off by one for TMDB: without results, search again without it (S4).
    if (r.status === 'ok' && !r.value.length && query.year !== null) r = await metadata.search('tmdb', { query: query.title, kind: query.kind, year: null, lang });
    const f = failure('tmdb', r);
    if (f) return f;
    let cands = r.status === 'ok' ? r.value : [];
    if (!cands.length) return { type: 'pass', resolver: 'tmdb', why: 'no_candidates', candidates: [] };

    let d = voteTiebreak(q, decideMatch(q, cands, query.mode));
    if (d.outcome === 'review' && d.reason === 'low_score') {
      // The search does not return aliases, which saved "Star Wars Episodio IV" and "Le Mans 66" on Wikidata.
      const top = d.scored.slice(0, ALIAS_RETRY_CANDIDATES).map((s) => s.candidate);
      const detailed = new Map<MetadataCandidate, MetadataCandidate>();
      for (const c of top) {
        const lr = await metadata.lookupByExternalId('tmdb', { ns: c.ref.kind === 'series' ? 'tmdb_tv' : 'tmdb_movie', id: c.ref.id, lang });
        // A failed lookup is not an answer: deciding low_score now would turn an outage into a review.
        if (lr.status === 'rate_limited') return { type: 'retry', resolver: 'tmdb', retryAfterMs: lr.retryAfterMs, detail: 'tmdb: alias lookup rate limited' };
        if (lr.status === 'unavailable') return { type: 'retry', resolver: 'tmdb', retryAfterMs: null, detail: 'tmdb: alias lookup unavailable' };
        if (lr.status === 'ok') detailed.set(c, { ...c, titles: { ...c.titles, aliases: [...new Set([...c.titles.aliases, ...lr.value.titles.aliases])] } });
      }
      if (detailed.size) {
        cands = cands.map((c) => detailed.get(c) ?? c);
        d = voteTiebreak(q, decideMatch(q, cands, query.mode));
      }
    }
    d = lowVotedExactTitle(q, d);
    if (d.outcome === 'auto' && query.year === null) {
      // D6 on TMDB: uniqueness is checked on Wikidata, whose top results do not hide homonyms ("Up").
      if (wdDown && !finalAttempt) return { type: 'retry', resolver: 'tmdb', retryAfterMs: wdDown.retryAfterMs ?? null, detail: 'tmdb: uniqueness needs Wikidata, which is unavailable' };
      // TMDB only runs when Wikidata had no candidates, so this always finds 'not_unique': inside the
      // chain a TMDB match without a year never auto-matches. Deliberate (D6, conservative).
      const wdCands = wd?.type === 'pass' ? wd.candidates : [];
      d = requireUniqueness(d, wikidataUniqueness(q, wdCands, d.best.candidate));
    }
    // After the TMDB rules: the vote tie-break could otherwise turn a blocked 'ambiguous' into auto.
    d = blockAuto(d, query.mode);
    // ADR 0007 point 4: a provider failure never ends in needs_review. With Wikidata down, only a
    // TMDB auto-match is final; anything else waits for Wikidata, except on the job's last attempt.
    if (d.outcome !== 'auto' && wdDown && !finalAttempt) {
      return { type: 'retry', resolver: 'tmdb', retryAfterMs: wdDown.retryAfterMs ?? null, detail: 'tmdb: no match while Wikidata is unavailable' };
    }
    return fromDecision('tmdb', d);
  },
};

export const DEFAULT_RESOLVERS: readonly Resolver[] = [idTagResolver, wikidataResolver, tmdbResolver];

export type ChainResult =
  | { type: 'match'; outcome: Extract<ResolverOutcome, { type: 'match' }> }
  | { type: 'review'; reason: CaseReason; scored: ScoredCandidate[]; evidence: Evidence }
  | { type: 'retry'; retryAfterMs: number | null; detail: string };

/** Runs the resolvers in order until one decides; otherwise retry (a provider failed) or no_candidates. */
export async function runChain(resolvers: readonly Resolver[], input: ResolverInput, ctx: Omit<ResolveContext, 'previous'>): Promise<ChainResult> {
  const previous: ResolverOutcome[] = [];
  for (const r of resolvers) {
    const o = await r.resolve(input, { ...ctx, previous });
    if (o.type === 'match') return { type: 'match', outcome: o };
    if (o.type === 'review') return { type: 'review', reason: o.reason, scored: o.scored, evidence: o.evidence };
    if (o.type === 'retry') return { type: 'retry', retryAfterMs: o.retryAfterMs, detail: o.detail };
    previous.push(o);
  }
  const down = previous.filter((o) => o.type === 'pass' && o.why === 'unavailable');
  if (down.length) {
    return { type: 'retry', retryAfterMs: null, detail: `provider unavailable: ${down.map((o) => o.resolver).join(', ')}` };
  }
  if (!previous.some((o) => o.type === 'pass' && o.why !== 'not_applicable')) {
    return { type: 'retry', retryAfterMs: NO_PROVIDER_RETRY_MS, detail: 'no metadata provider configured' };
  }
  return { type: 'review', reason: 'no_candidates', scored: [], evidence: { resolver: 'chain' } };
}
