// Catalog lists (ListItems): film, series, documentaries, watchlist. Filters and sort live in the URL.
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactElement, useId } from 'react';
import { useItems } from '../../api/queries.ts';
import type { BrowseSearch } from '../../app/search.ts';
import { t } from '../../i18n/t.ts';
import { Empty, QueryFallback } from '../../ui/Status.tsx';
import { CardGrid } from './CardRow.tsx';
import styles from './catalog.module.css';

const SORTS = ['title', 'year', 'added', 'duration', 'last_played'] as const;

function titleOf(s: BrowseSearch): string {
  if (s.inWatchlist) return t('browse.watchlist');
  if (s.category === 'documentary') return t('browse.documentaries');
  if (s.kind === 'series') return t('browse.series');
  if (s.kind === 'movie') return t('browse.movies');
  return t('browse.all');
}

export function BrowsePage(): ReactElement {
  const search = useSearch({ from: '/_shell/_profile/browse' });
  const navigate = useNavigate({ from: '/browse' });
  const items = useItems(search);
  const sortId = useId();
  const orderId = useId();
  const watchedId = useId();
  const title = titleOf(search);
  const all = items.data?.pages.flatMap((p) => p.items) ?? [];

  const update = (patch: Partial<BrowseSearch>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  return (
    <div className="page">
      <h1 className="page-title">{title}</h1>
      <div className={styles.toolbar}>
        <label className="field" htmlFor={sortId}>
          {t('browse.sort')}
          <select id={sortId} className="select" value={search.sort ?? 'title'} onChange={(e) => update({ sort: e.target.value as BrowseSearch['sort'] })}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`browse.sort.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor={orderId}>
          {t('browse.order')}
          <select id={orderId} className="select" value={search.order ?? 'asc'} onChange={(e) => update({ order: e.target.value as BrowseSearch['order'] })}>
            <option value="asc">{t('browse.order.asc')}</option>
            <option value="desc">{t('browse.order.desc')}</option>
          </select>
        </label>
        <label className="field" htmlFor={watchedId}>
          {t('browse.filterWatched')}
          <select
            id={watchedId}
            className="select"
            value={search.watched === undefined ? 'any' : search.watched ? 'watched' : 'unwatched'}
            onChange={(e) => update({ watched: e.target.value === 'any' ? undefined : e.target.value === 'watched' })}
          >
            <option value="any">{t('browse.filter.any')}</option>
            <option value="unwatched">{t('browse.filter.unwatched')}</option>
            <option value="watched">{t('browse.filter.watched')}</option>
          </select>
        </label>
      </div>
      {!items.data && <QueryFallback query={items} />}
      {items.data && all.length === 0 && <Empty>{t('browse.empty')}</Empty>}
      {all.length > 0 && <CardGrid items={all} label={title} />}
      {items.hasNextPage && (
        <div className={styles.more}>
          <button type="button" className="btn" onClick={() => void items.fetchNextPage()} disabled={items.isFetchingNextPage}>
            {t('app.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
