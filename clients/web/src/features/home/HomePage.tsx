// Home: rows composed by the server (doc 03 I1). The client renders every row it gets, known or not.
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useHome } from '../../api/queries.ts';
import type { HomeRow } from '../../api/types.ts';
import type { BrowseSearch } from '../../app/search.ts';
import { browseSearch } from '../../app/search.ts';
import { t } from '../../i18n/t.ts';
import { QueryFallback } from '../../ui/Status.tsx';
import { CardRow } from '../catalog/CardRow.tsx';
import styles from '../catalog/catalog.module.css';

/** "See all": the row's query as ListItems parameters, when they are ones the browse view knows. */
function seeAllSearch(row: HomeRow): BrowseSearch | null {
  if (!row.query || Object.keys(row.query).length === 0) return null;
  const parsed = browseSearch.safeParse(row.query);
  return parsed.success ? parsed.data : null;
}

/** Rows of things to resume or play next: wide cards (backdrops, episode stills). */
const WIDE_ROWS: ReadonlySet<string> = new Set(['continue_watching', 'next_up']);

export function HomePage(): ReactElement {
  const home = useHome();
  // Cached rows stay on screen when a background refetch fails.
  if (!home.data) {
    return (
      <div className="page">
        <QueryFallback query={home} />
      </div>
    );
  }
  const rows = home.data.rows.filter((r) => r.items.length > 0);
  return (
    <div className={styles.home}>
      <h1 className="visually-hidden">{t('home.title')}</h1>
      {rows.length === 0 && <p className="page muted">{t('home.empty')}</p>}
      {rows.map((row) => {
        const search = seeAllSearch(row);
        return (
          <CardRow
            key={row.id}
            headingId={`row-${row.id}`}
            title={row.title}
            items={row.items}
            wide={WIDE_ROWS.has(row.id)}
            action={
              search && row.nextCursor ? (
                <Link to="/browse" search={search} className={styles.seeAll}>
                  {t('home.seeAll')}
                </Link>
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}
