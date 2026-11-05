// Parity with the S4 spike (ADR 0007 point 4): rapidfuzz 3.14.6 scores, the product normalisation
// and the v2 decision, frozen by spikes/s4-identification/dump_parity.py on the corpus queries and
// the CC0 Wikidata snapshot. TS must match within 1e-9.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MetadataCandidate } from '../../shared/metadata.ts';
import { ratio, tokenSortRatio } from './fuzz.ts';
import { decideMatch, decideV2, scoreCandidate } from './matcher.ts';
import { normalizeTitle, titleNumbers } from './normalize.ts';

type Pair = [a: string, b: string, aNorm: string, bNorm: string, aNums: string[], bNums: string[], rawRatio: number, rawTsr: number, ratio: number, tsr: number];
interface SnapshotCandidate {
  ref: string;
  kind: 'movie' | 'tv';
  title_it: string | null;
  title_en: string | null;
  original: string[];
  aliases: string[];
  years: number[];
  tmdb: (string | null)[];
}
interface Query {
  key: string;
  title: string | null;
  year: number | null;
  kind: 'movie' | 'tv';
  candidates: SnapshotCandidate[];
  scores: Record<string, number>;
  decision: { outcome: 'auto' | 'review'; ref: string | null; reason: string };
}
const fixture = JSON.parse(readFileSync(new URL('../../../test/fixtures/identifier-parity.json', import.meta.url), 'utf8')) as {
  pairs: Pair[];
  queries: Query[];
};

const fromSnapshot = (c: SnapshotCandidate): MetadataCandidate => ({
  ref: { provider: 'wikidata', id: c.ref, kind: c.kind === 'tv' ? 'series' : 'movie' },
  titles: { localized: c.title_it, english: c.title_en, original: c.original, aliases: c.aliases },
  years: c.years,
  documentary: null,
  externalIds: { wikidata: c.ref, ...(c.tmdb[0] ? { tmdb: c.tmdb[0] } : {}) },
  voteCount: null,
});

const EPS = 1e-9;

describe('rapidfuzz parity', () => {
  it('has the frozen pairs', () => {
    expect(fixture.pairs.length).toBeGreaterThan(1000);
  });

  it('normalises titles like the frozen Python (letters of every script survive)', () => {
    const bad = fixture.pairs.filter(([a, b, an, bn]) => normalizeTitle(a) !== an || normalizeTitle(b) !== bn);
    expect(bad.map(([a, b, an, bn]) => ({ a, b, an, bn, tsA: normalizeTitle(a), tsB: normalizeTitle(b) }))).toEqual([]);
    expect(normalizeTitle('Неизвестный 1917-й')).toBe('неизвестныи 1917 и');
  });

  it('extracts title numbers like the frozen Python', () => {
    const bad = fixture.pairs.filter(([a, b, , , an, bn]) => JSON.stringify(titleNumbers(a)) !== JSON.stringify(an) || JSON.stringify(titleNumbers(b)) !== JSON.stringify(bn));
    expect(bad).toEqual([]);
  });

  it('ratio and token_sort_ratio match rapidfuzz within 1e-9, raw and normalised', () => {
    const bad = fixture.pairs.filter(
      ([a, b, an, bn, , , rr, rt, r, t]) =>
        Math.abs(ratio(a, b) - rr) > EPS ||
        Math.abs(tokenSortRatio(a, b) - rt) > EPS ||
        Math.abs(ratio(an, bn) - r) > EPS ||
        Math.abs(tokenSortRatio(an, bn) - t) > EPS,
    );
    expect(bad).toEqual([]);
  });
});

describe('v2 decision parity on the S4 Wikidata snapshot', () => {
  const queries = fixture.queries.filter((q) => q.title !== null);
  const kindOf = (q: Query): 'movie' | 'series' => (q.kind === 'tv' ? 'series' : 'movie');

  it('scores every candidate as the spike', () => {
    const bad: string[] = [];
    for (const q of queries) {
      for (const c of q.candidates) {
        const s = scoreCandidate({ title: q.title ?? '', year: q.year, kind: kindOf(q) }, fromSnapshot(c)).score;
        const exp = q.scores[c.ref] ?? NaN;
        if (Math.abs(s - exp) > EPS) bad.push(`${q.key} ${c.ref}: ${s} vs ${exp}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('decides as the spike rule (kind filter, falling back to every kind when none is left)', () => {
    const bad: string[] = [];
    for (const q of queries) {
      const mq = { title: q.title ?? '', year: q.year, kind: kindOf(q) };
      const cands = q.candidates.map(fromSnapshot);
      const same = cands.filter((c) => c.ref.kind === mq.kind);
      const d = decideV2(mq, same.length ? same : cands);
      const got = { outcome: d.outcome, ref: d.best?.candidate.ref.id ?? null, reason: d.outcome === 'auto' ? 'ok' : d.reason };
      if (JSON.stringify(got) !== JSON.stringify(q.decision)) bad.push(`${q.key}: ${JSON.stringify(got)} vs ${JSON.stringify(q.decision)}`);
    }
    expect(bad).toEqual([]);
    expect(queries.filter((q) => q.decision.outcome === 'auto')).toHaveLength(95);
  });

  it('the product rule auto-matches the same queries to the same works (no fallback to the other kind)', () => {
    const differ: string[] = [];
    for (const q of queries) {
      const mq = { title: q.title ?? '', year: q.year, kind: kindOf(q) };
      const d = decideMatch(mq, q.candidates.map(fromSnapshot), 'filter');
      const auto = d.outcome === 'auto' ? d.best.candidate.ref.id : null;
      const spikeAuto = q.decision.outcome === 'auto' ? q.decision.ref : null;
      if (auto !== spikeAuto) differ.push(`${q.key}: ${auto} vs ${spikeAuto}`);
    }
    expect(differ).toEqual([]);
  });
});
