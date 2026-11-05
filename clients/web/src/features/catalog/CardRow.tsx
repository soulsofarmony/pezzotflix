// A horizontal row of cards with arrow-key movement (roving tabindex) and a grid for list pages.
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import type { ItemSummary } from '../../api/types.ts';
import { ItemCardBody } from '../../ui/ItemCard.tsx';
import { useRovingFocus } from '../../ui/useRovingFocus.ts';
import styles from './catalog.module.css';

export function ItemLink({ item, wide, tabIndex, onFocus }: { item: ItemSummary; wide?: boolean; tabIndex?: number; onFocus?: () => void }): ReactElement {
  return (
    <Link to="/item/$itemId" params={{ itemId: item.id }} className={styles.cardLink} tabIndex={tabIndex} onFocus={onFocus} data-roving-item="" aria-label={item.title}>
      <ItemCardBody item={item} wide={wide ?? false} />
    </Link>
  );
}

export function CardRow({ title, items, wide, action, headingId }: { title: string; items: ItemSummary[]; wide?: boolean; action?: ReactNode; headingId: string }): ReactElement {
  const roving = useRovingFocus(items.length);
  return (
    <section className={styles.row} aria-labelledby={headingId}>
      <div className={styles.rowHeader}>
        <h2 id={headingId} className={styles.rowTitle}>
          {title}
        </h2>
        {action}
      </div>
      {/* The list handles the arrow keys for the links it contains (roving tabindex). */}
      {/* eslint-disable-next-line jsx-a11y-x/no-noninteractive-element-interactions */}
      <ul className={styles.rowList} onKeyDown={roving.onKeyDown}>
        {items.map((item, i) => (
          <li key={item.id}>
            <ItemLink item={item} wide={wide ?? false} tabIndex={roving.tabIndexOf(i)} onFocus={() => roving.onFocusItem(i)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CardGrid({ items, label }: { items: ItemSummary[]; label: string }): ReactElement {
  return (
    <ul className={styles.grid} aria-label={label}>
      {items.map((item) => (
        <li key={item.id}>
          <ItemLink item={item} />
        </li>
      ))}
    </ul>
  );
}
