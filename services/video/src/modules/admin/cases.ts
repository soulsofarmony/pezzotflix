// "Da verificare" queue (doc 03 §6, library standard §7.1): what the admin API reads from the
// identifier's case rows. Pure: stored JSON in, contract shapes out. The stored shapes are the
// identifier's (StoredCandidate, ParsedPath); they are parsed defensively, never imported.
import { z } from 'zod';
import type { ApiSchemas } from '../../shared/ports.ts';

export type Candidate = ApiSchemas['Candidate'];
export type Resolution = NonNullable<ApiSchemas['IdentificationCase']['allowedResolutions']>[number];
export type CaseReason = NonNullable<ApiSchemas['IdentificationCase']['reason']>;

const WorkKind = z.enum(['movie', 'series']);
const Provider = z.enum(['wikidata', 'tmdb']);

export const StoredCandidate = z.looseObject({
  ref: z.looseObject({ provider: Provider, id: z.string().min(1), kind: WorkKind.optional() }),
  provider: Provider.optional(),
  kind: WorkKind,
  title: z.string(),
  originalTitle: z.string().nullish(),
  year: z.number().int().nullish(),
  score: z.number(),
  voteCount: z.number().nullish(),
  externalIds: z.record(z.string(), z.string()).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});
export type StoredCandidate = z.infer<typeof StoredCandidate>;

/** What a resolution reads from the parser output stored in the case. */
export const ParsedCase = z.looseObject({
  kind: z.enum(['movie', 'episode', 'extra', 'disc']).catch('movie'),
  title: z.string().nullish(),
  year: z.number().int().nullish(),
  edition: z.string().nullish(),
  season: z.number().int().nullish(),
  episodes: z.array(z.number().int()).nullish(),
  episodeTitle: z.string().nullish(),
  extraType: z.enum(['trailer', 'featurette', 'behind-the-scenes', 'deleted-scene', 'interview', 'other']).nullish(),
  extraTitle: z.string().nullish(),
  extraTitleIsLabel: z.boolean().nullish(),
  extraOf: z.looseObject({ folder: z.string(), kind: WorkKind, season: z.number().int().nullable() }).nullish(),
  workFolder: z.string().nullish(),
  workKind: WorkKind.nullish(),
  warnings: z.array(z.string()).nullish(),
});
export type ParsedCase = z.infer<typeof ParsedCase>;

export function parseCase(parsed: unknown): ParsedCase {
  const r = ParsedCase.safeParse(parsed ?? {});
  return r.success ? r.data : ParsedCase.parse({});
}

export function storedCandidates(raw: unknown): StoredCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const r = StoredCandidate.safeParse(c);
    return r.success ? [r.data] : [];
  });
}

/**
 * Resolutions the queue offers per reason:
 * - disc_structure and multi_part: Ignore only (standard §7.1). Linking them by hand would link an
 *   unplayable file or rebuild an item over several files (D7); they are fixed outside Pezzotflix;
 * - every other reason: a candidate (stored or found with SearchProvider), an item, a manual item, Ignore.
 */
export function allowedResolutions(reason: CaseReason | null): Resolution[] {
  if (reason === 'disc_structure' || reason === 'multi_part') return ['ignore'];
  return ['link_candidate', 'link_item', 'create_manual', 'ignore'];
}

/** A stored candidate as the contract shows it: provider data beyond ref, kind and score go in evidence. */
export function toContractCandidate(c: StoredCandidate): Candidate {
  return {
    ref: { provider: c.ref.provider, id: c.ref.id },
    kind: c.kind,
    title: c.title,
    originalTitle: c.originalTitle ?? null,
    year: c.year ?? null,
    score: c.score,
    evidence: {
      ...(c.evidence ?? {}),
      ...(c.externalIds ? { externalIds: c.externalIds } : {}),
      ...(c.voteCount !== undefined && c.voteCount !== null ? { voteCount: c.voteCount } : {}),
    },
  };
}

// ---------------------------------------------------------------- SearchProvider scoring

const fold = (s: string): string[] =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Sørensen–Dice over word sets. */
function dice(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const sa = new Set(a);
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  return (2 * common) / (sa.size + sb.size);
}

/**
 * Score of a manual search hit, for ordering only (the identifier's matcher decides automatic
 * matches): best word overlap with any of its titles, and the year when one was given.
 */
export function searchScore(query: string, titles: readonly string[], years: readonly number[], year: number | null): number {
  const q = fold(query);
  const title = Math.max(0, ...titles.map((t) => dice(q, fold(t))));
  if (year === null) return Math.round(title * 1000) / 1000;
  const y = years.includes(year) ? 1 : years.some((x) => Math.abs(x - year) === 1) ? 0.5 : 0;
  return Math.round((0.8 * title + 0.2 * y) * 1000) / 1000;
}
