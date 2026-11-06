// Search by localized and original title (FTS on the server). The query is in the URL, debounced while typing.
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useSearch as useSearchQuery } from '../../api/queries.ts';
import { t } from '../../i18n/t.ts';
import { Empty, QueryFallback } from '../../ui/Status.tsx';
import { CardGrid } from '../catalog/CardRow.tsx';
import styles from '../catalog/catalog.module.css';

type Kind = 'movie' | 'series' | 'episode' | 'extra';
const KINDS: readonly Kind[] = ['movie', 'series', 'episode', 'extra'];

export function SearchPage(): ReactElement {
  const search = useSearch({ from: '/_shell/_profile/search' });
  const navigate = useNavigate({ from: '/search' });
  const [text, setText] = useState(search.q ?? '');
  const inputId = useId();
  const kindId = useId();
  const q = search.q ?? '';
  const results = useSearchQuery(q, search.kind);
  // What is searched: the query skips a blank text (useSearch), so the page does too.
  const query = q.trim();

  // Debounce: the URL (and the query) follow the text after a short pause.
  useEffect(() => {
    if (text === q) return;
    const h = setTimeout(() => void navigate({ search: (prev) => ({ ...prev, q: text || undefined }), replace: true }), 250);
    return () => clearTimeout(h);
  }, [text, q, navigate]);

  // A cleared field shows the hint, not the previous results that placeholderData keeps.
  const items = query ? (results.data?.items ?? []) : [];

  return (
    <div className="page">
      <h1 className="page-title">{t('search.title')}</h1>
      <form role="search" className={styles.toolbar} onSubmit={(e) => e.preventDefault()}>
        <label className="field" htmlFor={inputId} style={{ flex: '1 1 20rem' }}>
          {t('search.label')}
          <input
            id={inputId}
            className="input"
            type="search"
            value={text}
            placeholder={t('search.placeholder')}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            // The page exists to type a query.
            // eslint-disable-next-line jsx-a11y-x/no-autofocus
            autoFocus
          />
        </label>
        <label className="field" htmlFor={kindId}>
          {t('search.kind')}
          <select
            id={kindId}
            className="select"
            value={search.kind ?? ''}
            onChange={(e) => void navigate({ search: (prev) => ({ ...prev, kind: (e.target.value || undefined) as Kind | undefined }), replace: true })}
          >
            <option value="">{t('search.kind.any')}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
      </form>
      {!query && <p className="muted">{t('search.hint')}</p>}
      {query && !results.data && <QueryFallback query={results} />}
      {query && results.isSuccess && (
        <p className="visually-hidden" role="status">
          {t('search.results', { count: items.length })}
        </p>
      )}
      {query && results.isSuccess && items.length === 0 && <Empty>{t('search.empty', { q: query })}</Empty>}
      {items.length > 0 && <CardGrid items={items} label={t('search.title')} />}
    </div>
  );
}
