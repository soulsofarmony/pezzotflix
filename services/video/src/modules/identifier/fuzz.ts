// rapidfuzz-compatible similarity (ADR 0007 point 4): fuzz.ratio and fuzz.token_sort_ratio, both the
// normalised Indel similarity on code points, scaled 0..100. Written by hand, no dependency; the
// parity test checks them against rapidfuzz 3.14.6 within 1e-9.

const codePoints = (s: string): number[] => Array.from(s, (c) => c.codePointAt(0) ?? 0);

/** Length of the longest common subsequence (two-row dynamic programming). */
function lcsLength(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  let prev = new Array<number>(short.length + 1).fill(0);
  let cur = new Array<number>(short.length + 1).fill(0);
  for (const x of long) {
    for (let j = 1; j <= short.length; j++) {
      cur[j] = x === short[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[short.length] ?? 0;
}

function indelSimilarity(a: readonly number[], b: readonly number[]): number {
  const lensum = a.length + b.length;
  if (lensum === 0) return 100;
  const dist = lensum - 2 * lcsLength(a, b);
  return 100 * (1 - dist / lensum);
}

/** rapidfuzz fuzz.ratio (no processor). */
export const ratio = (a: string, b: string): number => indelSimilarity(codePoints(a), codePoints(b));

const byCodePoint = (x: string, y: string): number => {
  const a = codePoints(x);
  const b = codePoints(y);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return a.length - b.length;
};

/** Python's " ".join(sorted(s.split())). */
const sortedTokens = (s: string): string =>
  s
    .split(/\s+/u)
    .filter(Boolean)
    .sort(byCodePoint)
    .join(' ');

/** rapidfuzz fuzz.token_sort_ratio (no processor). */
export const tokenSortRatio = (a: string, b: string): number => ratio(sortedTokens(a), sortedTokens(b));
