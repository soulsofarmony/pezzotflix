// Roving tabindex for a row (ADR 0005 point 5): one Tab stop per row, arrows move inside it, Home/End jump.
import { type KeyboardEvent, useCallback, useState } from 'react';

export interface RovingFocus {
  activeIndex: number;
  /** tabIndex for item i. */
  tabIndexOf: (i: number) => 0 | -1;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onFocusItem: (i: number) => void;
}

/** Items are found as [data-roving-item] descendants of the element that gets onKeyDown. */
export function useRovingFocus(count: number, orientation: 'horizontal' | 'vertical' = 'horizontal'): RovingFocus {
  const [active, setActive] = useState(0);
  const activeIndex = count === 0 ? 0 : Math.min(active, count - 1);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
      const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
      let i: number | null = null;
      if (e.key === next) i = Math.min(activeIndex + 1, count - 1);
      else if (e.key === prev) i = Math.max(activeIndex - 1, 0);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = count - 1;
      if (i === null || count === 0) return;
      e.preventDefault();
      setActive(i);
      const items = e.currentTarget.querySelectorAll<HTMLElement>('[data-roving-item]');
      const el = items[i];
      el?.focus();
      el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    },
    [activeIndex, count, orientation],
  );

  return {
    activeIndex,
    tabIndexOf: (i) => (i === activeIndex ? 0 : -1),
    onKeyDown,
    onFocusItem: setActive,
  };
}
