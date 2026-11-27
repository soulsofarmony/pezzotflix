// Seek-bar preview (ADR 0009 D6): the tile of the position under the pointer, or of the scrub value, above the
// bar with the time below it. Without trickplay, or while the sheet loads, only the time shows.
import { type PointerEvent, type ReactElement, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Trickplay } from '../../api/types.ts';
import { formatClock } from '../../i18n/format.ts';
import { clampBox, offsetForValue, SheetCache, tileAt, tileBackground, trickplayKey, valueAtPointer } from './trickplay.ts';
import styles from './player.module.css';

/** Gap between the preview and the player's left and right edges. */
const EDGE_MARGIN_PX = 12;

/**
 * Hover over the seek bar: the value the range input would take at the pointer. Pointer events only read the
 * position, so dragging, keyboard and aria stay the input's own.
 */
export function useSeekHover(inputRef: RefObject<HTMLInputElement | null>, maxMs: number, stepMs: number) {
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const input = inputRef.current;
    if (input) setHoverMs(valueAtPointer(e.clientX, input.getBoundingClientRect(), maxMs, stepMs));
  };
  const clear = () => setHoverMs(null);
  return { hoverMs, handlers: { onPointerMove, onPointerLeave: clear, onPointerCancel: clear } };
}

export interface SeekPreviewProps {
  trickplay: Trickplay | null;
  /** Position to preview on the original timeline; null hides the preview. */
  valueMs: number | null;
  /** The range input's max: the same scale the input maps to its width. */
  maxMs: number;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The player surface: the preview stays inside its left and right edges. */
  boundsRef: RefObject<HTMLElement | null>;
}

export function SeekPreview({ trickplay, valueMs, maxMs, inputRef, boundsRef }: SeekPreviewProps): ReactElement | null {
  const key = trickplayKey(trickplay);
  // One cache per set of sheet urls: a re-plan brings new ones.
  const cache = useMemo(() => new SheetCache(key), [key]);
  useEffect(() => () => cache.clear(), [cache]);
  useSyncExternalStore(cache.subscribe, cache.getVersion, cache.getVersion);

  const tile = trickplay && valueMs !== null ? tileAt(valueMs, trickplay) : null;
  const url = tile?.url ?? null;
  useEffect(() => {
    if (url !== null) cache.request(url);
  }, [cache, url]);
  const sheet = url !== null ? cache.get(url) : null;

  const boxRef = useRef<HTMLDivElement>(null);
  // The box is centred on the thumb position of the value and kept inside the player: measured after each render.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const input = inputRef.current;
    const bounds = boundsRef.current;
    const parent = box?.parentElement;
    if (!box || !input || !bounds || !parent || valueMs === null) return;
    const ir = input.getBoundingClientRect();
    const center = ir.left + offsetForValue(valueMs, ir.width, maxMs);
    const left = clampBox(center, box.getBoundingClientRect().width, bounds.getBoundingClientRect(), EDGE_MARGIN_PX);
    box.style.left = `${left - parent.getBoundingClientRect().left}px`;
  });

  if (valueMs === null) return null;
  return (
    <div ref={boxRef} className={styles.preview} aria-hidden="true" data-testid="seek-preview" data-tile={tile && sheet ? tile.index : undefined}>
      {trickplay && tile && sheet && (
        <div
          className={styles.previewImage}
          style={{ height: `calc(var(--preview-w) * ${trickplay.tileHeight / trickplay.tileWidth})`, ...tileBackground(tile, trickplay, sheet) }}
        />
      )}
      <span className={styles.previewTime}>{formatClock(valueMs)}</span>
    </div>
  );
}
