import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trickplay } from '../../api/types.ts';
import { clampBox, offsetForValue, SheetCache, tileAt, tileBackground, tileIndex, trickplayKey, valueAtPointer } from './trickplay.ts';

const tp = (over: Partial<Trickplay> = {}): Trickplay => ({
  intervalMs: 10_000,
  tileWidth: 320,
  tileHeight: 180,
  columns: 10,
  rows: 10,
  count: 105,
  sheets: ['/s/a/trickplay/sheet-0.jpg', '/s/a/trickplay/sheet-1.jpg'],
  ...over,
});

describe('tileIndex: the nearest tile, clamped to count − 1', () => {
  it.each([
    [0, 0],
    [4_999, 0],
    // Tile i covers [i·I − I/2, i·I + I/2): the half rounds up.
    [5_000, 1],
    [14_999, 1],
    [15_000, 2],
    // With floor this would be the 10 s tile (ADR 0009, construction notes).
    [19_000, 2],
    [-500, 0],
    [1_040_000, 104],
    [1_045_000, 104],
    // Tiles 105–109 may exist on the last sheet: never shown.
    [1_090_000, 104],
    [1e9, 104],
  ])('%d ms → tile %d', (p, i) => {
    expect(tileIndex(p, tp())).toBe(i);
  });
});

describe('tileAt: sheet, column and row', () => {
  it.each([
    [0, { index: 0, sheet: 0, column: 0, row: 0 }],
    [570_000, { index: 57, sheet: 0, column: 7, row: 5 }],
    [990_000, { index: 99, sheet: 0, column: 9, row: 9 }],
    [1_000_000, { index: 100, sheet: 1, column: 0, row: 0 }],
    [1_040_000, { index: 104, sheet: 1, column: 4, row: 0 }],
    [5_000_000, { index: 104, sheet: 1, column: 4, row: 0 }],
  ])('10×10 grid, %d ms', (p, want) => {
    const t = tileAt(p, tp());
    expect(t).toMatchObject(want);
    expect(t?.url).toBe(tp().sheets[want.sheet]);
  });

  it('a non-square grid: row by row, left to right', () => {
    expect(tileAt(230_000, tp({ columns: 5, rows: 4, count: 40 }))).toMatchObject({ index: 23, sheet: 1, column: 3, row: 0 });
    expect(tileAt(390_000, tp({ columns: 5, rows: 4, count: 40 }))).toMatchObject({ index: 39, sheet: 1, column: 4, row: 3 });
  });

  it('a tile on a sheet the session does not list: null (time only)', () => {
    expect(tileAt(1_200_000, tp({ count: 150, sheets: ['/s/a/trickplay/sheet-0.jpg'] }))).toBeNull();
  });
});

describe('tileBackground: the sheet at its natural size, scaled to the box width', () => {
  it('in units of the box width W: offset −column·W and −row·W·th/tw', () => {
    const t = tileAt(230_000, tp())!;
    expect(t).toMatchObject({ column: 3, row: 2 });
    expect(tileBackground(t, tp(), { width: 3200, height: 1800 })).toEqual({
      backgroundImage: 'url("/s/a/trickplay/sheet-0.jpg")',
      backgroundSize: 'calc(var(--preview-w) * 10) calc(var(--preview-w) * 5.625)',
      backgroundPosition: 'calc(var(--preview-w) * -3) calc(var(--preview-w) * -1.125)',
    });
  });

  it('the first tile, and a sheet whose natural size is not the full grid', () => {
    const t = tileAt(0, tp())!;
    expect(tileBackground(t, tp({ tileHeight: 134 }), { width: 3200, height: 670 })).toMatchObject({
      backgroundSize: 'calc(var(--preview-w) * 10) calc(var(--preview-w) * 2.09375)',
      backgroundPosition: '0px 0px',
    });
  });
});

describe('valueAtPointer: the value the range input takes under the pointer', () => {
  // Input at x = 100, 1016 px wide: the thumb centre spans 108–1108.
  const input = { left: 100, width: 1016 };
  it.each([
    [108, 1_000_000, 0],
    [50, 1_000_000, 0],
    [608, 1_000_000, 500_000],
    [608.4, 1_000_000, 500_000],
    [609, 1_000_000, 501_000],
    [1_108, 1_000_000, 1_000_000],
    [1_500, 1_000_000, 1_000_000],
    // A max that is not a step multiple: the browser's top value is the last multiple below it.
    [1_108, 1_000_500, 1_000_000],
    [358, 7_200_000, 1_800_000],
  ])('x = %d, max %d → %d', (x, max, want) => {
    expect(valueAtPointer(x, input, max, 1_000)).toBe(want);
  });

  it('a range narrower than its thumb: 0', () => {
    expect(valueAtPointer(105, { left: 100, width: 10 }, 1_000_000, 1_000)).toBe(0);
  });

  it('offsetForValue is its inverse', () => {
    expect(offsetForValue(0, 1016, 1_000_000)).toBe(8);
    expect(offsetForValue(500_000, 1016, 1_000_000)).toBe(508);
    expect(offsetForValue(1_000_000, 1016, 1_000_000)).toBe(1008);
    expect(offsetForValue(2_000_000, 1016, 1_000_000)).toBe(1008);
    expect(valueAtPointer(100 + offsetForValue(1_234_000, 1016, 7_200_000), input, 7_200_000, 1_000)).toBe(1_234_000);
  });
});

describe('clampBox: inside the player, with a margin', () => {
  const bounds = { left: 0, right: 1200 };
  it.each([
    [600, 440],
    [50, 12],
    [1_190, 868],
  ])('centre %d → left %d', (c, want) => {
    expect(clampBox(c, 320, bounds, 12)).toBe(want);
  });
  it('a box wider than the player: at the left margin', () => {
    expect(clampBox(100, 300, { left: 0, right: 200 }, 12)).toBe(12);
  });
});

class FakeImage {
  static all: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  src = '';
  constructor() {
    FakeImage.all.push(this);
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load(w = 3200, h = 1800) {
    this.naturalWidth = w;
    this.naturalHeight = h;
    this.onload?.();
  }
}

describe('SheetCache', () => {
  beforeEach(() => {
    FakeImage.all = [];
    vi.stubGlobal('Image', FakeImage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('loads a sheet once, on request, and notifies when it is ready', () => {
    const c = new SheetCache('k');
    const fn = vi.fn();
    c.subscribe(fn);
    c.request('/a.jpg');
    c.request('/a.jpg');
    expect(FakeImage.all.map((i) => i.src)).toEqual(['/a.jpg']);
    expect(c.get('/a.jpg')).toBeNull();
    FakeImage.all[0]!.load();
    expect(c.get('/a.jpg')).toEqual({ width: 3200, height: 1800 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(c.getVersion()).toBe(1);
  });

  it('a failed sheet stays failed (no retry), and an empty image counts as failed', () => {
    const c = new SheetCache('k');
    c.request('/a.jpg');
    FakeImage.all[0]!.onerror?.();
    c.request('/a.jpg');
    c.request('/b.jpg');
    FakeImage.all[1]!.load(0, 0);
    expect(FakeImage.all).toHaveLength(2);
    expect(c.get('/a.jpg')).toBeNull();
    expect(c.get('/b.jpg')).toBeNull();
  });

  it('clear() forgets the sheets and ignores loads still in flight', () => {
    const c = new SheetCache('k');
    const fn = vi.fn();
    c.subscribe(fn);
    c.request('/a.jpg');
    c.request('/b.jpg');
    FakeImage.all[0]!.load();
    const inFlight = FakeImage.all[1]!;
    const late = inFlight.onload;
    c.clear();
    expect(inFlight.onload).toBeNull();
    expect(inFlight.src).toBe('');
    late?.();
    expect(c.get('/a.jpg')).toBeNull();
    expect(c.get('/b.jpg')).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    c.request('/a.jpg');
    expect(FakeImage.all).toHaveLength(3);
  });
});

describe('trickplayKey', () => {
  it('changes with the sheet urls (a re-plan brings a new token)', () => {
    expect(trickplayKey(null)).toBe('');
    expect(trickplayKey(tp())).toBe(trickplayKey(tp()));
    expect(trickplayKey(tp({ sheets: ['/s/b/trickplay/sheet-0.jpg', '/s/b/trickplay/sheet-1.jpg'] }))).not.toBe(trickplayKey(tp()));
  });
});
