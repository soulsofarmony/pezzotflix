// The "Da verificare" queue (ListIdentificationCases), filtered by state in the URL.
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactElement, useId } from 'react';
import { type CaseState, useCases } from '../../api/queries.ts';
import type { IdentificationCase } from '../../api/types.ts';
import { formatRelative } from '../../i18n/format.ts';
import { t, tMaybe } from '../../i18n/t.ts';
import { Empty, ErrorView, Loading } from '../../ui/Status.tsx';
import styles from './admin.module.css';

const STATES: readonly CaseState[] = ['needs_review', 'pending', 'auto_matched', 'resolved', 'ignored'];

export function reasonLabel(reason: IdentificationCase['reason']): string | null {
  if (!reason) return null;
  return tMaybe(`cases.reason.${reason}`, t('cases.reason.unknown', { reason }));
}

export function CasesPage(): ReactElement {
  const search = useSearch({ from: '/_shell/admin/cases' });
  const navigate = useNavigate({ from: '/admin/cases' });
  const state: CaseState = search.state ?? 'needs_review';
  const cases = useCases(state);
  const selectId = useId();
  const list = cases.data?.pages.flatMap((p) => p.cases) ?? [];

  return (
    <section aria-label={t('admin.cases')}>
      <div className={styles.toolbar}>
        <label className="field" htmlFor={selectId}>
          {t('cases.state')}
          <select id={selectId} className="select" value={state} onChange={(e) => void navigate({ search: { state: e.target.value as CaseState }, replace: true })}>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {t(`cases.state.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {cases.isPending && <Loading />}
      {cases.isError && <ErrorView error={cases.error} onRetry={() => void cases.refetch()} />}
      {cases.isSuccess && list.length === 0 && <Empty>{t('cases.empty')}</Empty>}
      <ul className={styles.cards}>
        {list.map((c) => {
          const meta = [c.rootName, reasonLabel(c.reason), c.linkedItem ? t('cases.linked', { title: c.linkedItem.title }) : null, t('cases.updated', { when: formatRelative(c.updatedAt) })]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={c.id}>
              {/* The name holds every visible line after "Apri il caso di", so it contains the visible label (WCAG 2.5.3). */}
              <Link to="/admin/cases/$caseId" params={{ caseId: c.id }} className={styles.caseLink} aria-label={`${t('cases.open', { path: c.relPath })} · ${meta}`}>
                <span className={styles.path}>{c.relPath}</span> <span className="muted">{meta}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {cases.hasNextPage && (
        <button type="button" className="btn" onClick={() => void cases.fetchNextPage()} disabled={cases.isFetchingNextPage}>
          {t('app.loadMore')}
        </button>
      )}
    </section>
  );
}
