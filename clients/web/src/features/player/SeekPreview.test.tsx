import { act, fireEvent, render, screen } from '@testing-library/react';
import { type ReactElement, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trickplay } from '../../api/types.ts';
import { SeekPreview, useSeekHover } from './SeekPreview.tsx';

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
}

const loadSheet = (src: string, w = 3200, h = 1800) => {
  const img = FakeImage.all.find((i) => i.src === src);
  if (!img) throw new Error(`no image for ${src}`);
  act(() => {
    img.naturalWidth = w;
    img.naturalHeight = h;
    img.onload?.();
  });
};

const sheets = (token: string) => [`/video/media/s/${token}/trickplay/sheet-0.jpg`, `/video/media/s/${token}/trickplay/sheet-1.jpg`];
const TP: Trickplay = { intervalMs: 10_000, tileWidth: 320, tileHeight: 180, columns: 10, rows: 10, count: 105, sheets: sheets('a') };

// Layout (jsdom has none): player 0–1200, seek bar at x = 100, 1016 px wide (thumb centre 108–1108), 1 px per s.
const RECTS: Record<string, { left: number; width: number }> = { root: { left: 0, width: 1200 }, wrap: { left: 100, width: 1016 }, seek: { left: 100, width: 1016 } };
const DURATION = 1_000_000;

function rectOf(el: Element): DOMRect {
  const id = (el as HTMLElement).dataset.testid ?? '';
  const known = RECTS[id];
  // The preview box: the image width when it shows one, else the time label's.
  const r = known ?? { left: 0, width: id === 'seek-preview' ? (el.firstElementChild?.tagName === 'DIV' ? 320 : 60) : 0 };
  return { left: r.left, right: r.left + r.width, width: r.width, top: 0, bottom: 0, height: 0, x: r.left, y: 0, toJSON: () => r };
}

interface HarnessProps {
  trickplay: Trickplay | null;
  scrubMs?: number | null;
  visible?: boolean;
}

/** The seek row as PlayerPage wires it: hover handlers on the wrap, the preview inside it. */
function Harness({ trickplay, scrubMs = null, visible = true }: HarnessProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hover = useSeekHover(inputRef, DURATION, 1_000);
  return (
    <div ref={rootRef} data-testid="root">
      <div data-testid="wrap" {...hover.handlers}>
        <input ref={inputRef} data-testid="seek" type="range" aria-label="Posizione" min={0} max={DURATION} step={1000} defaultValue={0} />
        <SeekPreview trickplay={trickplay} valueMs={visible ? (scrubMs ?? hover.hoverMs) : null} maxMs={DURATION} inputRef={inputRef} boundsRef={rootRef} />
      </div>
    </div>
  );
}

/** Pointer over the bar at the position of a value (ms). */
const hoverAt = (ms: number) => fireEvent.pointerMove(screen.getByTestId('wrap'), { clientX: 108 + ms / 1000 });
const preview = () => screen.queryByTestId('seek-preview');
const image = () => preview()?.querySelector('div') ?? null;

beforeEach(() => {
  FakeImage.all = [];
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('seek-bar preview', () => {
  it('shows on hover and hides when the pointer leaves the bar', () => {
    render(<Harness trickplay={TP} />);
    expect(preview()).toBeNull();
    hoverAt(500_000);
    expect(preview()?.textContent).toBe('8:20');
    fireEvent.pointerLeave(screen.getByTestId('wrap'));
    expect(preview()).toBeNull();
  });

  it('loads only the sheet it needs; until it arrives only the time shows', () => {
    render(<Harness trickplay={TP} />);
    hoverAt(503_000);
    expect(FakeImage.all.map((i) => i.src)).toEqual([TP.sheets[0]]);
    expect(image()).toBeNull();
    loadSheet(TP.sheets[0]!);
    // 503 s → tile 50: sheet 0, column 0, row 5.
    expect(preview()?.dataset.tile).toBe('50');
    expect(image()?.style.backgroundImage).toBe(`url("${TP.sheets[0]}")`);
    expect(image()?.style.backgroundPosition).toBe('0px calc(var(--preview-w) * -2.8125)');
    expect(image()?.style.backgroundSize).toBe('calc(var(--preview-w) * 10) calc(var(--preview-w) * 5.625)');
    expect(preview()?.textContent).toBe('8:23');
    // Same sheet, another tile: no new load.
    hoverAt(237_000);
    expect(preview()?.dataset.tile).toBe('24');
    expect(image()?.style.backgroundPosition).toBe('calc(var(--preview-w) * -4) calc(var(--preview-w) * -1.125)');
    expect(FakeImage.all).toHaveLength(1);
  });

  it('at the end of the bar: a tile of the last sheet', () => {
    render(<Harness trickplay={TP} />);
    hoverAt(DURATION);
    expect(FakeImage.all.map((i) => i.src)).toEqual([TP.sheets[1]]);
    loadSheet(TP.sheets[1]!);
    expect(preview()?.dataset.tile).toBe('100');
  });

  it('the tile index is clamped to count − 1 on a partly filled last sheet', () => {
    render(<Harness trickplay={TP} scrubMs={1_090_000} />);
    loadSheet(TP.sheets[1]!);
    // 1090 s would be tile 109, which the last sheet may hold but count (105) excludes.
    expect(preview()?.dataset.tile).toBe('104');
    expect(image()?.style.backgroundPosition).toBe('calc(var(--preview-w) * -4) 0px');
  });

  it('centred on the thumb and kept inside the player', () => {
    render(<Harness trickplay={TP} />);
    hoverAt(500_000);
    loadSheet(TP.sheets[0]!);
    // Centre 608, box 320 wide → 448 in the page, 348 in the wrap.
    expect(preview()?.style.left).toBe('348px');
    hoverAt(0);
    expect(preview()?.style.left).toBe('-88px');
    hoverAt(DURATION);
    loadSheet(TP.sheets[1]!);
    expect(preview()?.style.left).toBe('768px');
  });

  it('without trickplay: only the time above the pointer, and no image request', () => {
    render(<Harness trickplay={null} />);
    hoverAt(930_000);
    expect(preview()?.textContent).toBe('15:30');
    expect(image()).toBeNull();
    // The 60 px label centred on 1038.
    expect(preview()?.style.left).toBe('908px');
    expect(FakeImage.all).toHaveLength(0);
  });

  it('a sheet that fails to load: time only, not retried', () => {
    render(<Harness trickplay={TP} />);
    hoverAt(10_000);
    act(() => FakeImage.all[0]!.onerror?.());
    hoverAt(20_000);
    expect(image()).toBeNull();
    expect(preview()?.textContent).toBe('0:20');
    expect(FakeImage.all).toHaveLength(1);
  });

  it('the scrub value wins over the hover, and nothing shows while hidden', () => {
    const { rerender } = render(<Harness trickplay={TP} scrubMs={120_000} />);
    hoverAt(500_000);
    expect(preview()?.textContent).toBe('2:00');
    rerender(<Harness trickplay={TP} scrubMs={120_000} visible={false} />);
    expect(preview()).toBeNull();
  });

  it('a re-plan (new token, new urls) resets the cache', () => {
    const { rerender } = render(<Harness trickplay={TP} />);
    hoverAt(500_000);
    loadSheet(TP.sheets[0]!);
    expect(image()).not.toBeNull();
    const replanned = { ...TP, sheets: sheets('b') };
    rerender(<Harness trickplay={replanned} />);
    // The old sheet is not reused: the new session's sheet loads, and until then only the time shows.
    expect(image()).toBeNull();
    expect(FakeImage.all.map((i) => i.src)).toEqual([TP.sheets[0], replanned.sheets[0]]);
    loadSheet(replanned.sheets[0]!);
    expect(image()?.style.backgroundImage).toBe(`url("${replanned.sheets[0]}")`);
    // The same trickplay again (a new object, as every snapshot brings): the cache stays.
    rerender(<Harness trickplay={{ ...replanned }} />);
    expect(image()).not.toBeNull();
    expect(FakeImage.all).toHaveLength(2);
  });

  it('does not block the range input: it is aria-hidden and the bar keeps its value and role', () => {
    render(<Harness trickplay={TP} />);
    hoverAt(500_000);
    expect(preview()?.getAttribute('aria-hidden')).toBe('true');
    const seek = screen.getByRole('slider', { name: 'Posizione' });
    fireEvent.change(seek, { target: { value: '42000' } });
    expect((seek as HTMLInputElement).value).toBe('42000');
  });
});
