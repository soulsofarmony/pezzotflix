// One identification case: file facts, candidates with score, and the resolutions the contract allows
// (allowedResolutions): pick a candidate, search the provider again, create the item by hand, or ignore.
import { Link } from '@tanstack/react-router';
import { type FormEvent, type ReactElement, useId, useState } from 'react';
import { useCase, useIgnoreCase, useProviderSearch, useResolveCase } from '../../api/queries.ts';
import type { Candidate, IdentificationCase, ItemKind } from '../../api/types.ts';
import { formatRelative } from '../../i18n/format.ts';
import { t } from '../../i18n/t.ts';
import { errorMessage } from '../../ui/errors.ts';
import { ErrorView, Loading } from '../../ui/Status.tsx';
import styles from './admin.module.css';
import { reasonLabel } from './CasesPage.tsx';

type Resolution = 'link_candidate' | 'link_item' | 'create_manual' | 'ignore';
const ALL: readonly Resolution[] = ['link_candidate', 'link_item', 'create_manual', 'ignore'];

/** What the parser actually found: nulls, false flags and empty lists are noise in the facts list. */
function meaningful(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.values(v).some(meaningful);
  return true;
}

export function CaseDetailPage({ caseId }: { caseId: string }): ReactElement {
  const q = useCase(caseId);
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  return <CaseView c={q.data} />;
}

function CaseView({ c }: { c: IdentificationCase }): ReactElement {
  const resolve = useResolveCase(c.id);
  const ignore = useIgnoreCase(c.id);
  const allowed = new Set<Resolution>(c.allowedResolutions ?? ALL);
  const open = c.state !== 'resolved' && c.state !== 'ignored';
  const canLink = open && allowed.has('link_candidate');
  const busy = resolve.isPending || ignore.isPending;
  const error = resolve.error ?? ignore.error;

  const parsedFacts = Object.entries(c.parsed ?? {}).filter(([, v]) => meaningful(v));

  const pick = (cand: Candidate) => resolve.mutate({ action: 'link_candidate', candidate: { provider: cand.ref.provider, id: cand.ref.id } });

  return (
    <article className={styles.case}>
      <Link to="/admin/cases" className="muted">
        ← {t('cases.backToList')}
      </Link>
      <h2 className={styles.path}>{c.relPath}</h2>
      <p className="muted">
        {[c.rootName, t(`cases.state.${c.state}`), reasonLabel(c.reason), t('cases.updated', { when: formatRelative(c.updatedAt) })].filter(Boolean).join(' · ')}
      </p>
      {c.linkedItem && (
        <p>
          <Link to="/item/$itemId" params={{ itemId: c.linkedItem.id }}>
            {t('cases.linked', { title: c.linkedItem.title })}
          </Link>
        </p>
      )}
      {parsedFacts.length > 0 && (
        <section>
          <h3>{t('cases.parsed')}</h3>
          <dl className={styles.facts}>
            {parsedFacts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="mono">{typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {c.warnings && c.warnings.length > 0 && (
        <section>
          <h3>{t('cases.warnings')}</h3>
          <ul>
            {c.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p role="alert" className={styles.error}>
          {errorMessage(error)}
        </p>
      )}
      {resolve.isSuccess && <p role="status">{t('cases.resolved')}</p>}
      {open && allowed.size === 1 && allowed.has('ignore') && <p className="muted">{t('cases.onlyIgnore')}</p>}

      <section>
        <h3>{t('cases.candidates')}</h3>
        {c.candidates.length === 0 ? <p className="muted">{t('cases.noCandidates')}</p> : <CandidateList candidates={c.candidates} onPick={canLink && !busy ? pick : null} />}
      </section>

      {canLink && <ProviderSearch initial={typeof c.parsed?.title === 'string' ? c.parsed.title : ''} initialYear={typeof c.parsed?.year === 'number' ? c.parsed.year : undefined} onPick={busy ? null : pick} />}

      {open && allowed.has('create_manual') && <ManualForm busy={busy} onSubmit={(manual) => resolve.mutate({ action: 'create_manual', manual })} />}

      {open && allowed.has('ignore') && (
        <section>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('cases.ignoreConfirm'))) ignore.mutate();
            }}
          >
            {t('cases.ignore')}
          </button>
        </section>
      )}
    </article>
  );
}

function CandidateList({ candidates, onPick }: { candidates: Candidate[]; onPick: ((c: Candidate) => void) | null }): ReactElement {
  return (
    <ul className={styles.cards}>
      {candidates.map((cand) => (
        <li key={`${cand.ref.provider}:${cand.ref.id}`} className={styles.candidate}>
          <span>
            <strong>{cand.title}</strong>
            {cand.year ? ` (${cand.year})` : ''}
            {cand.originalTitle && cand.originalTitle !== cand.title ? <span className="muted"> · {cand.originalTitle}</span> : null}
          </span>
          <span className="muted">
            {t(`cases.provider.${cand.ref.provider}`)} {cand.ref.id} · {t('cases.score', { score: cand.score.toFixed(2) })}
          </span>
          {onPick && (
            <button type="button" className="btn btn-primary" onClick={() => onPick(cand)}>
              {t('cases.pick')}
              <span className="visually-hidden">: {cand.title}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ProviderSearch({ initial, initialYear, onPick }: { initial: string; initialYear: number | undefined; onPick: ((c: Candidate) => void) | null }): ReactElement {
  const [form, setForm] = useState({ q: initial, year: initialYear ? String(initialYear) : '', kind: '' as '' | 'movie' | 'series' });
  const [query, setQuery] = useState<{ q: string; year: number | undefined; kind: 'movie' | 'series' | undefined } | null>(null);
  const results = useProviderSearch(query?.q ?? '', query?.kind, query?.year);
  const ids = { q: useId(), year: useId(), kind: useId() };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const year = Number(form.year);
    setQuery({ q: form.q, year: form.year && Number.isInteger(year) ? year : undefined, kind: form.kind || undefined });
  };

  return (
    <section>
      <h3>{t('cases.searchAgain')}</h3>
      <form className={styles.toolbar} onSubmit={submit}>
        <label className="field" htmlFor={ids.q}>
          {t('cases.searchQuery')}
          <input id={ids.q} className="input" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} required maxLength={200} />
        </label>
        <label className="field" htmlFor={ids.year}>
          {t('cases.searchYear')}
          <input id={ids.year} className="input" inputMode="numeric" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} size={6} />
        </label>
        <label className="field" htmlFor={ids.kind}>
          {t('cases.searchKind')}
          <select id={ids.kind} className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as '' | 'movie' | 'series' })}>
            <option value="">{t('search.kind.any')}</option>
            <option value="movie">{t('kind.movie')}</option>
            <option value="series">{t('kind.series')}</option>
          </select>
        </label>
        <button type="submit" className="btn">
          {t('cases.searchSubmit')}
        </button>
      </form>
      {query && results.isFetching && <Loading />}
      {results.isError && <ErrorView error={results.error} />}
      {results.data && (
        <>
          <h4 className="visually-hidden">{t('cases.searchResults')}</h4>
          {results.data.candidates.length === 0 ? <p className="muted">{t('cases.noCandidates')}</p> : <CandidateList candidates={results.data.candidates} onPick={onPick} />}
        </>
      )}
    </section>
  );
}

function ManualForm({ busy, onSubmit }: { busy: boolean; onSubmit: (m: { kind: ItemKind; title: string; year: number | null }) => void }): ReactElement {
  const [title, setTitle] = useState('');
  const [year, setYear] = useState('');
  const [kind, setKind] = useState<ItemKind>('movie');
  const ids = { title: useId(), year: useId(), kind: useId() };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const y = Number(year);
    onSubmit({ kind, title: title.trim(), year: year && Number.isInteger(y) ? y : null });
  };
  return (
    <section>
      <h3>{t('cases.createManual')}</h3>
      <form className={styles.toolbar} onSubmit={submit}>
        <label className="field" htmlFor={ids.title}>
          {t('cases.manualTitle')}
          <input id={ids.title} className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <label className="field" htmlFor={ids.year}>
          {t('cases.manualYear')}
          <input id={ids.year} className="input" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} size={6} />
        </label>
        <label className="field" htmlFor={ids.kind}>
          {t('cases.manualKind')}
          <select id={ids.kind} className="select" value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
            <option value="movie">{t('kind.movie')}</option>
            <option value="series">{t('kind.series')}</option>
            <option value="episode">{t('kind.episode')}</option>
            <option value="extra">{t('kind.extra')}</option>
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || title.trim().length === 0}>
          {t('cases.manualSubmit')}
        </button>
      </form>
    </section>
  );
}
