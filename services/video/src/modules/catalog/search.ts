// Search query for catalog_search (ADR 0002 point 8). Pure.
// The FTS5 tokenizer (unicode61 remove_diacritics 2) folds case and diacritics on both sides, so the
// query only has to split the text the way the identifier does (letters and numbers of every script,
// normalize.ts) and keep the letters intact: "citta" finds "La città incantata", "Неизв" finds
// "Неизвестный". Every word must match, the last ones as a prefix.

const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const MAX_TERMS = 12;

/**
 * Words of a search text, at most MAX_TERMS. NFKC folds compatibility forms typed by the user
 * (full-width "ＤＵＮＥ", half-width katakana, ligatures) to the plain letters titles use.
 */
export function searchTerms(q: string): string[] {
  return (q.normalize('NFKC').match(WORD) ?? []).slice(0, MAX_TERMS);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * A query in a script written without spaces (Japanese, Chinese), typed without spaces: the FTS
 * index holds such a title as one token, so a word from its middle is only found by substring.
 */
export function needsSubstringSearch(q: string): boolean {
  const t = q.normalize('NFKC').trim();
  return CJK.test(t) && !/\s/u.test(t);
}

/** FTS5 MATCH expression: every term as a quoted prefix ("dune"* "part"*), or null if there is none. */
export function ftsQuery(q: string): string | null {
  const terms = searchTerms(q);
  if (!terms.length) return null;
  // Terms hold letters, numbers and marks only: no quote or FTS operator can get in.
  return terms.map((t) => `"${t}"*`).join(' ');
}

/** Lower-case, diacritics-free form for the substring fallback (scripts without spaces, e.g. Japanese). */
export function foldForContains(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
