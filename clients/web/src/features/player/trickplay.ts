// Seek-bar preview math (ADR 0009 D6 and its construction notes). Positions are on the original media timeline,
// the same as the seek bar's value and controller.seekTo: no timelineOffsetMs conversion anywhere here.
import type { Trickplay } from '../../api/types.ts';

/**
 * Half the width of the native range thumb, in CSS px. The thumb's centre travels from this inset to
 * width − inset, so the value under the pointer is measured on that span (Chrome and Firefox draw a 16 px thumb).
 */
export const RANGE_THUMB_INSET_PX = 8;

/** Tile i covers [i·I − I/2, i·I + I/2): the nearest tile, never one past count (the last sheet may hold more). */
export function tileIndex(positionMs: number, tp: Pick<Trickplay, 'intervalMs' | 'count'>): number {
  return Math.min(tp.count - 1, Math.max(0, Math.round(positionMs / tp.intervalMs)));
}

export interface TileRef {
  index: number;
  sheet: number;
  url: string;
  column: number;
  row: number;
}

/** The tile for a position, or null when the session lists no sheet for it. */
export function tileAt(positionMs: number, tp: Trickplay): TileRef | null {
  const index = tileIndex(positionMs, tp);
  const perSheet = tp.columns * tp.rows;
  const sheet = Math.floor(index / perSheet);
  const url = tp.sheets[sheet];
  if (url === undefined) return null;
  const within = index % perSheet;
  return { index, sheet, url, column: within % tp.columns, row: Math.floor(within / tp.columns) };
}

/**
 * Background of the preview box for a tile, as CSS lengths in units of the box width W (`var(--preview-w)`):
 * the sheet is drawn at its natural pixel size scaled by W / tileWidth, so the tile grid stays aligned.
 */
export function tileBackground(tile: TileRef, tp: Trickplay, sheet: { width: number; height: number }, widthVar = 'var(--preview-w)') {
  const w = (k: number) => (k === 0 ? '0px' : `calc(${widthVar} * ${round6(k)})`);
  return {
    backgroundImage: `url("${tile.url}")`,
    backgroundSize: `${w(sheet.width / tp.tileWidth)} ${w(sheet.height / tp.tileWidth)}`,
    backgroundPosition: `${w(-tile.column)} ${w((-tile.row * tp.tileHeight) / tp.tileWidth)}`,
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The value the range input takes for a pointer at clientX: the thumb-centre span maps linearly to [0, max],
 * snapped to the input's step and clamped like the browser does (the largest valid value is a step multiple ≤ max).
 */
export function valueAtPointer(clientX: number, input: { left: number; width: number }, maxMs: number, stepMs: number, insetPx = RANGE_THUMB_INSET_PX): number {
  const span = input.width - 2 * insetPx;
  const ratio = span > 0 ? clamp((clientX - input.left - insetPx) / span, 0, 1) : 0;
  const top = Math.floor(maxMs / stepMs) * stepMs;
  return clamp(Math.round((ratio * maxMs) / stepMs) * stepMs, 0, top);
}

/** Horizontal offset, from the input's left edge, of the thumb centre for a value. */
export function offsetForValue(valueMs: number, inputWidth: number, maxMs: number, insetPx = RANGE_THUMB_INSET_PX): number {
  const ratio = maxMs > 0 ? clamp(valueMs / maxMs, 0, 1) : 0;
  return insetPx + Math.max(0, inputWidth - 2 * insetPx) * ratio;
}

/** Left edge of a box centred on centerX, kept within [min + margin, max − margin]. */
export function clampBox(centerX: number, boxWidth: number, bounds: { left: number; right: number }, marginPx: number): number {
  const lo = bounds.left + marginPx;
  const hi = bounds.right - marginPx - boxWidth;
  if (hi < lo) return lo;
  return clamp(centerX - boxWidth / 2, lo, hi);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Loads each sheet once with new Image() on first need, for one trickplay: a re-plan brings new urls, so the
 * page makes a new cache and clears the old one.
 */
export class SheetCache {
  private readonly entries = new Map<string, { state: 'loading' | 'error' } | { state: 'ready'; width: number; height: number }>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<HTMLImageElement, string>();
  private version = 0;

  /** The trickplay the cache belongs to (trickplayKey). */
  readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  readonly getVersion = () => this.version;

  /** Natural size of a loaded sheet, or null while it loads or after it failed. */
  get(url: string): { width: number; height: number } | null {
    const e = this.entries.get(url);
    return e?.state === 'ready' ? { width: e.width, height: e.height } : null;
  }

  /** Starts loading a sheet unless it is loaded, loading or failed already (a failed sheet is not retried). */
  request(url: string): void {
    if (this.entries.has(url)) return;
    this.entries.set(url, { state: 'loading' });
    const img = new Image();
    this.pending.set(img, url);
    img.onload = () => this.settle(img, img.naturalWidth > 0 && img.naturalHeight > 0 ? { state: 'ready', width: img.naturalWidth, height: img.naturalHeight } : { state: 'error' });
    img.onerror = () => this.settle(img, { state: 'error' });
    img.src = url;
  }

  /** Forgets every sheet and drops pending loads. The cache stays usable (StrictMode runs effect cleanups twice). */
  clear(): void {
    for (const img of this.pending.keys()) {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
    }
    this.pending.clear();
    this.entries.clear();
  }

  private settle(img: HTMLImageElement, entry: { state: 'error' } | { state: 'ready'; width: number; height: number }) {
    const url = this.pending.get(img);
    if (url === undefined) return;
    this.pending.delete(img);
    this.entries.set(url, entry);
    this.version += 1;
    for (const fn of this.listeners) fn();
  }
}

/** Identity of a trickplay for the cache: a re-plan brings a new token, hence new sheet urls. */
export const trickplayKey = (tp: Trickplay | null) => (tp ? tp.sheets.join('\n') : '');
