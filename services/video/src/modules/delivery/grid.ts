// Segment grid of the VOD playlist (ADR 0003 D3), pure. Boundaries are indexed keyframes on the original
// timeline (PTS − start_time): Bₙ = the last keyframe ≤ n·target, duplicates dropped, a segment under
// 0.5 s merged with its neighbour, and groups over HLS_SEGMENT_MAX_S or HLS_SEGMENT_MAX_BYTES (bytes
// estimated from the index positions, all tracks included) cut at inner keyframes.
// Every loop is bounded by the number of keyframes, never by the duration (a hostile Duration is cheap).

export interface GridIndex {
  /** Keyframe times, ms, ascending and unique. */
  times: readonly number[];
  /** File offsets of the keyframes (same length), or null when unknown. */
  positions: readonly (number | null)[];
  /** Zero-based duration of the file, ms. */
  durationMs: number;
  /** File size. */
  sizeBytes: number;
  /** End of the media data (the Cues offset when they follow the Clusters); sizeBytes when unknown. */
  dataEndBytes?: number | null;
}

export interface GridOptions {
  targetMs: number;
  maxMs: number;
  maxBytes: number;
  minMs?: number;
}

export interface SegmentGrid {
  /** Bⱼ in ms for j ≥ 1 (keyframe times); starts[0] is the first keyframe, but segment 0 starts at 0. */
  starts: number[];
  /** Index into GridIndex.times of each boundary keyframe. */
  keyframeIdx: number[];
  /** Cumulatively rounded EXTINF values, ms: their first k sum to round(Bₖ). */
  extinfMs: number[];
  targetDurationS: number;
  durationMs: number;
  /** Estimated from the index positions; null when positions are unknown. */
  peakBps: number | null;
  averageBps: number | null;
}

const MIN_SEGMENT_MS = 500;

export function buildGrid(index: GridIndex, opts: GridOptions): SegmentGrid {
  const { times, durationMs } = index;
  if (times.length === 0) throw new Error('keyframe index is empty');
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) throw new Error('duration unknown');
  if (!(opts.targetMs > 0)) throw new Error('segment target must be positive');
  const minMs = opts.minMs ?? MIN_SEGMENT_MS;
  const startOf = (b: number[], j: number) => (j === 0 ? 0 : times[b[j]!]!);

  // Bₙ = last keyframe ≤ n·target. n jumps to the next keyframe's slot: O(keyframes), not O(duration).
  const candidates: number[] = [0];
  let i = 0;
  let n = 1;
  while (n * opts.targetMs < durationMs) {
    const t = n * opts.targetMs;
    while (i + 1 < times.length && times[i + 1]! <= t) i++;
    if (i > candidates[candidates.length - 1]!) candidates.push(i);
    if (i + 1 >= times.length) break;
    n = Math.max(n + 1, Math.ceil(times[i + 1]! / opts.targetMs));
  }
  // Merge short segments into the previous one (the first into the next).
  const b: number[] = [candidates[0]!];
  for (let c = 1; c < candidates.length; c++) {
    const k = candidates[c]!;
    if (times[k]! - startOf(b, b.length - 1) < minMs) {
      if (b.length === 1) continue;
      b[b.length - 1] = k;
    } else {
      b.push(k);
    }
  }
  while (b.length > 1 && durationMs - times[b[b.length - 1]!]! < minMs) b.pop();

  // One byte rule for the cut and for BANDWIDTH: a segment spans from its first keyframe's position to
  // the next boundary's, the last one to the end of the media data.
  const dataEnd = index.dataEndBytes ?? index.sizeBytes;
  const posOf = (k: number | 'end'): number | null => (k === 'end' ? dataEnd : (index.positions[k] ?? null));
  const timeOf = (k: number | 'end', first: boolean): number => (k === 'end' ? durationMs : first ? 0 : times[k]!);

  // Caps: cut long or large groups at inner keyframes near the middle (explicit stack, no recursion).
  const keyframeIdx: number[] = [];
  for (let j = 0; j < b.length; j++) {
    const stack: { a: number; e: number | 'end'; first: boolean }[] = [{ a: b[j]!, e: j + 1 < b.length ? b[j + 1]! : 'end', first: j === 0 }];
    while (stack.length > 0) {
      const { a, e, first } = stack.pop()!;
      const ta = timeOf(a, first);
      const te = timeOf(e, false);
      const pa = posOf(a);
      const pe = posOf(e);
      const bytes = pa !== null && pe !== null ? pe - pa : null;
      const tooLong = te - ta > opts.maxMs;
      const tooBig = bytes !== null && bytes > opts.maxBytes;
      const last = e === 'end' ? times.length : e;
      let best = -1;
      if ((tooLong || tooBig) && last - a >= 2) {
        let bestScore = Number.POSITIVE_INFINITY;
        for (let k = a + 1; k < last; k++) {
          if (times[k]! - ta < minMs || te - times[k]! < minMs) continue;
          const score = tooLong ? Math.abs(times[k]! - (ta + te) / 2) : Math.abs((index.positions[k] ?? 0) - ((pa ?? 0) + (pe ?? 0)) / 2);
          if (score < bestScore) {
            bestScore = score;
            best = k;
          }
        }
      }
      if (best < 0) {
        keyframeIdx.push(a);
        continue;
      }
      // Right half first on the stack, so the left half is emitted first.
      stack.push({ a: best, e, first: false });
      stack.push({ a, e: best, first });
    }
  }

  const starts = keyframeIdx.map((k) => times[k]!);
  // EXTINF: differences of the boundaries rounded to the ms, so the first k sum to round(Bₖ) (hls.js
  // resets initPTS when the expected and real durations drift by max(duration, 1 s)).
  const extinfMs: number[] = [];
  let prev = 0;
  let maxExtinf = 0;
  for (let j = 1; j <= keyframeIdx.length; j++) {
    const r = j < keyframeIdx.length ? Math.round(times[keyframeIdx[j]!]!) : Math.round(durationMs);
    extinfMs.push(r - prev);
    if (r - prev > maxExtinf) maxExtinf = r - prev;
    prev = r;
  }
  const targetDurationS = Math.max(1, Math.ceil(maxExtinf / 1000));

  let peakBps: number | null = null;
  let averageBps: number | null = null;
  let total = 0;
  let peak = 0;
  let known = true;
  for (let j = 0; j < keyframeIdx.length && known; j++) {
    const start = posOf(keyframeIdx[j]!);
    const end = j + 1 < keyframeIdx.length ? posOf(keyframeIdx[j + 1]!) : posOf('end');
    if (start === null || end === null) {
      known = false;
      break;
    }
    const bytes = Math.max(0, end - start);
    total += bytes;
    peak = Math.max(peak, (bytes * 8000) / Math.max(extinfMs[j]!, 1));
  }
  if (known) {
    peakBps = Math.round(peak);
    averageBps = Math.round((total * 8000) / durationMs);
  }
  return { starts, keyframeIdx, extinfMs, targetDurationS, durationMs, peakBps, averageBps };
}

/** Segment that plays at positionMs (original timeline). */
export function segmentAt(grid: SegmentGrid, positionMs: number): number {
  let lo = 0;
  let hi = grid.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (grid.starts[mid]! <= positionMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Playlist start of segment j (ms): 0 for the first, Bⱼ after. */
export const segmentStartMs = (grid: SegmentGrid, j: number): number => (j === 0 ? 0 : grid.starts[j]!);
