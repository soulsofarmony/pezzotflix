// Title normalisation for matching (S4 v2, fixed per ADR 0007 point 4 / S4 Scoperta 13): letters of
// every script survive, so "Неизвестный 1917-й" no longer collapses to "1917".
// Mirrors tnorm() of spikes/s4-identification/dump_parity.py, which froze the parity fixture:
//   NFKD -> drop marks -> casefold -> '&' to ' and ' -> non letter/number to space -> one leading article off.

const MARKS = /\p{M}/gu;
const NOT_LETTER_OR_NUMBER = /[^\p{L}\p{N}]+/gu;
const DIGITS = /\p{Nd}+/gu;
const LEADING_ARTICLE = /^(?:il|lo|la|i|gli|le|l|un|uno|una|the|a|an|der|die|das|les) /;

/**
 * Python's str.casefold() for what titles contain. toLowerCase() differs on a few letters only:
 * sharp s (ß, ẞ lowers to ß) folds to "ss", final sigma folds to σ.
 */
export function casefold(s: string): string {
  return s.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

/** Unicode-aware, diacritics removed, case folded, punctuation as single spaces, no leading article. */
export function normalizeTitle(s: string | null | undefined): string {
  const folded = casefold((s ?? '').normalize('NFKD').replace(MARKS, '')).replace(/&/g, ' and ');
  const spaced = folded.replace(NOT_LETTER_OR_NUMBER, ' ').trim();
  return spaced.replace(LEADING_ARTICLE, '');
}

/** Distinct digit runs of the normalised title, sorted ("Blade Runner 2049" -> ["2049"]). */
export function titleNumbers(s: string | null | undefined): string[] {
  return [...new Set(normalizeTitle(s).match(DIGITS) ?? [])].sort();
}

/** Word set of a normalised title. */
export const titleWords = (s: string | null | undefined): Set<string> => new Set(normalizeTitle(s).split(' ').filter(Boolean));
