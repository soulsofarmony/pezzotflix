// One identification case: file facts, candidates with score, and the resolutions the contract allows
// (allowedResolutions): pick a candidate, search the provider again, create the item by hand, or ignore. A
// resolved or ignored case shows what it is now, and the same resolutions behind "Correggi".
import { Link } from '@tanstack/react-router';
import { type FormEvent, type ReactElement, useId, useState } from 'react';
import { ApiError } from '../../api/problem.ts';
import { useCase, useIgnoreCase, useProviderSearch, useResolveCase } from '../../api/queries.ts';
import type { Candidate, IdentificationCase, ItemKind, ResolveCaseRequest } from '../../api/types.ts';
import { formatRelative } from '../../i18n/format.ts';
import { t } from '../../i18n/t.ts';
import { errorMessage, problemDetails } from '../../ui/errors.ts';
import { cardLabel } from '../../ui/ItemCard.tsx';
import { ErrorView, Loading, QueryFallback } from '../../ui/Status.tsx';
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
  if (!q.data) return <QueryFallback query={q} />;
  return <CaseView c={q.data} />;
}

/** The file name has episode numbers: without them the file cannot be linked under a series. */
function hasEpisodes(parsed: IdentificationCase['parsed']): boolean {
  return Array.isArray(parsed?.episodes) && parsed.episodes.length > 0;
}

/**
 * The message of a failed resolution. A 400 on a series target is the file name without an episode number (the
 * server says so in errors[]); any other error gets the generic message by code. Validation details follow.
 */
function ResolveError({ error, target, c }: { error: unknown; target: ItemKind | null; c: IdentificationCase }): ReactElement {
  const details = problemDetails(error);
  const paths = error instanceof ApiError && Array.isArray(error.problem?.errors) ? error.problem.errors.map((x) => x.path) : [];
  const noEpisode = error instanceof ApiError && error.status === 400 && (paths.some((x) => /episode/i.test(x)) || (target === 'series' && !hasEpisodes(c.parsed)));
  return (
    <div role="alert" className={styles.error}>
      <p>{noEpisode ? t('cases.noEpisodeNumber') : errorMessage(error)}</p>
      {details.length > 0 && (
        <ul className="mono" aria-label={t('error.details')}>
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseView({ c }: { c: IdentificationCase }): ReactElement {
  const resolve = useResolveCase(c.id);
  const ignore = useIgnoreCase(c.id);
  const allowed = new Set<Resolution>(c.allowedResolutions ?? ALL);
  // A resolved or ignored case can be resolved again (the server checks only the reason): a wrong pick or an
  // accidental Ignore is corrected here, behind "Correggi".
  const settled = c.state === 'resolved' || c.state === 'ignored';
  const [correcting, setCorrecting] = useState(false);
  const controlsId = useId();
  const canLink = allowed.has('link_candidate');
  const canIgnore = allowed.has('ignore') && c.state !== 'ignored';
  const canCorrect = canLink || allowed.has('create_manual') || canIgnore;
  const busy = resolve.isPending || ignore.isPending;
  const error = resolve.error ?? ignore.error;
  // Kind of the item the last resolution links to (the candidate's or the manual one): it explains a 400.
  const [target, setTarget] = useState<ItemKind | null>(null);

  const parsedFacts = Object.entries(c.parsed ?? {}).filter(([, v]) => meaningful(v));

  const resolveWith = (body: ResolveCaseRequest, kind: ItemKind) => {
    ignore.reset();
    setTarget(kind);
    resolve.mutate(body);
  };
  const pick = (cand: Candidate) => resolveWith({ action: 'link_candidate', candidate: { provider: cand.ref.provider, id: cand.ref.id } }, cand.kind);

  const controls = (
    <>
      <section>
        <h3>{t('cases.candidates')}</h3>
        {c.candidates.length === 0 ? <p className="muted">{t('cases.noCandidates')}</p> : <CandidateList candidates={c.candidates} onPick={canLink && !busy ? pick : null} />}
      </section>

      {canLink && <ProviderSearch initial={typeof c.parsed?.title === 'string' ? c.parsed.title : ''} initialYear={typeof c.parsed?.year === 'number' ? c.parsed.year : undefined} onPick={busy ? null : pick} />}

      {allowed.has('create_manual') && <ManualForm busy={busy} onSubmit={(manual) => resolveWith({ action: 'create_manual', manual }, manual.kind)} />}

      {canIgnore && (
        <section>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(t('cases.ignoreConfirm'))) return;
              resolve.reset();
              ignore.mutate();
            }}
          >
            {t('cases.ignore')}
          </button>
        </section>
      )}
    </>
  );

  return (
    <article className={styles.case}>
      <Link to="/admin/cases" className="muted">
        ← {t('cases.backToList')}
      </Link>
      <h2 className={styles.path}>{c.relPath}</h2>
      <p className="muted">
        {[c.rootName, t(`cases.state.${c.state}`), reasonLabel(c.reason), t('cases.updated', { when: formatRelative(c.updatedAt) })].filter(Boolean).join(' · ')}
      </p>
      {c.state === 'ignored' ? (
        <p className={styles.current}>{t('cases.currentIgnored')}</p>
      ) : c.linkedItem ? (
        <p className={styles.current}>
          {t('cases.currentLink')}{' '}
          <Link to="/item/$itemId" params={{ itemId: c.linkedItem.id }}>
            {cardLabel(c.linkedItem)}
          </Link>
        </p>
      ) : null}
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

      {error && <ResolveError error={error} target={resolve.error ? target : null} c={c} />}
      {resolve.isSuccess && <p role="status">{t('cases.resolved')}</p>}
      {!settled && allowed.size === 1 && allowed.has('ignore') && <p className="muted">{t('cases.onlyIgnore')}</p>}

      {!settled
        ? controls
        : canCorrect && (
            <>
              <div>
                <button type="button" className="btn" aria-expanded={correcting} aria-controls={controlsId} onClick={() => setCorrecting((v) => !v)}>
                  {t('cases.correct')}
                </button>
              </div>
              <div id={controlsId} className={styles.case} hidden={!correcting}>
                <p className="muted">{c.state === 'ignored' ? t('cases.correctIgnored') : t('cases.correctResolved')}</p>
                {controls}
              </div>
            </>
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

/**
 * Only a film or a series: the server refuses a manual episode (it needs its series), and a manual extra would
 * belong to no item, reachable only through search.
 */
type ManualKind = 'movie' | 'series';

function ManualForm({ busy, onSubmit }: { busy: boolean; onSubmit: (m: { kind: ManualKind; title: string; year: number | null }) => void }): ReactElement {
  const [title, setTitle] = useState('');
  const [year, setYear] = useState('');
  const [kind, setKind] = useState<ManualKind>('movie');
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
          <select id={ids.kind} className="select" value={kind} onChange={(e) => setKind(e.target.value as ManualKind)}>
            <option value="movie">{t('kind.movie')}</option>
            <option value="series">{t('kind.series')}</option>
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || title.trim().length === 0}>
          {t('cases.manualSubmit')}
        </button>
      </form>
    </section>
  );
}
