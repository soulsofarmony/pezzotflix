// Field resolution of the catalog projection (ADR 0007 point 2, ADR 0002 M3). Pure.
// Shown value: manual > tmdb (not expired) > wikidata > filename > container, honouring field_lock.
// Original title and category prefer Wikidata (durable; ADR 0007 points 2 and 3).
import type { CatalogItemKind, FieldSource, ItemCategory } from '../../shared/ports.ts';

export const DEFAULT_ORDER: readonly FieldSource[] = ['manual', 'tmdb', 'wikidata', 'filename', 'container'];
export const WIKIDATA_FIRST: readonly FieldSource[] = ['manual', 'wikidata', 'tmdb', 'filename', 'container'];
const ORDER_OF: Readonly<Record<string, readonly FieldSource[]>> = { originalTitle: WIKIDATA_FIRST, category: WIKIDATA_FIRST };

export interface FieldRow {
  field: string;
  source: FieldSource;
  value: unknown;
  fetchedAt: number;
}

export interface Resolution {
  value: unknown;
  source: FieldSource;
}

/** A TMDB value older than the hard expiry (TMDB_MAX_AGE_DAYS) is never shown, even if locked. */
const usable = (row: FieldRow, now: number, tmdbMaxAgeMs: number): boolean =>
  row.value !== null && row.value !== undefined && (row.source !== 'tmdb' || now - row.fetchedAt <= tmdbMaxAgeMs);

export function resolveField(
  field: string,
  rows: readonly FieldRow[],
  lock: FieldSource | null,
  now: number,
  tmdbMaxAgeMs: number,
): Resolution | null {
  const of = rows.filter((r) => r.field === field && usable(r, now, tmdbMaxAgeMs));
  // A lock keeps its source while that source has a value; without one the field falls back (point 2).
  const locked = lock ? of.find((r) => r.source === lock) : undefined;
  if (locked) return { value: locked.value, source: locked.source };
  for (const source of ORDER_OF[field] ?? DEFAULT_ORDER) {
    const r = of.find((x) => x.source === source);
    if (r) return { value: r.value, source };
  }
  return null;
}

export interface ItemShape {
  kind: CatalogItemKind;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export interface Projection {
  title: string;
  originalTitle: string | null;
  sortTitle: string;
  year: number | null;
  durationMs: number | null;
  category: ItemCategory | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const category = (v: unknown): ItemCategory | null => (v === 'film' || v === 'documentary' ? v : null);

/** Title shown when no source has one (Italian UI, requirements §16). */
export function defaultTitle(item: ItemShape): string {
  if (item.kind === 'season') return item.seasonNumber === 0 ? 'Speciali' : `Stagione ${item.seasonNumber ?? '?'}`;
  if (item.kind === 'episode') return `Episodio ${item.episodeNumber ?? '?'}`;
  if (item.kind === 'extra') return 'Extra';
  return 'Senza titolo';
}

const SORT_ARTICLE = /^(?:il|lo|la|i|gli|le|un|uno|una|the|a|an)\s+|^(?:l|un)'\s*/;

/** Sort key: no diacritics, lower case, leading article dropped; seasons and episodes by number. */
export function sortTitleOf(title: string, item: ItemShape): string {
  if (item.kind === 'season') return String(item.seasonNumber ?? 0).padStart(4, '0');
  if (item.kind === 'episode') return String(item.episodeNumber ?? 0).padStart(4, '0');
  const folded = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/’/g, "'").trim();
  return folded.replace(SORT_ARTICLE, '') || folded;
}

export function project(item: ItemShape, rows: readonly FieldRow[], locks: ReadonlyMap<string, FieldSource>, now: number, tmdbMaxAgeMs: number): Projection {
  const get = (field: string) => resolveField(field, rows, locks.get(field) ?? null, now, tmdbMaxAgeMs)?.value;
  const title = str(get('title')) ?? defaultTitle(item);
  return {
    title,
    originalTitle: str(get('originalTitle')),
    sortTitle: sortTitleOf(title, item),
    year: int(get('year')),
    durationMs: int(get('durationMs')),
    category: category(get('category')) ?? (item.kind === 'movie' ? 'film' : null),
  };
}
