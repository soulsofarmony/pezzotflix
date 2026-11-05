// Ingest status: running/queued, files per state, jobs per type and state, failed jobs with retry.
import type { ReactElement } from 'react';
import { useIngest, useRetryJob } from '../../api/queries.ts';
import { formatNumber } from '../../i18n/format.ts';
import { t, tMaybe } from '../../i18n/t.ts';
import { errorMessage } from '../../ui/errors.ts';
import { ErrorView, Loading } from '../../ui/Status.tsx';
import styles from './admin.module.css';

const JOB_STATES = ['queued', 'running', 'done', 'failed'] as const;

export function IngestPage(): ReactElement {
  const ingest = useIngest();
  const retry = useRetryJob();
  if (ingest.isPending) return <Loading />;
  if (ingest.isError) return <ErrorView error={ingest.error} onRetry={() => void ingest.refetch()} />;
  const s = ingest.data;
  const jobs = Object.entries(s.jobs ?? {});
  return (
    <section aria-label={t('admin.ingest')} className={styles.stack}>
      <p role="status">
        <strong>{s.running ? t('ingest.running') : t('ingest.idle')}</strong> · {t('ingest.queued', { count: formatNumber(s.queued) })}
      </p>

      <div>
        <h2 className={styles.h2}>{t('ingest.files')}</h2>
        <dl className={styles.facts}>
          {Object.entries(s.files).map(([state, n]) => (
            <div key={state}>
              <dt>{state}</dt>
              <dd>{formatNumber(n)}</dd>
            </div>
          ))}
        </dl>
      </div>

      {jobs.length > 0 && (
        <div>
          <h2 className={styles.h2}>{t('ingest.jobs')}</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('ingest.jobType')}</th>
                {JOB_STATES.map((st) => (
                  <th key={st} scope="col">
                    {t(`ingest.state.${st}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map(([type, counts]) => (
                <tr key={type}>
                  <th scope="row" className="mono">
                    {type}
                  </th>
                  {JOB_STATES.map((st) => (
                    <td key={st}>{formatNumber(counts[st] ?? 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h2 className={styles.h2}>{t('ingest.failed')}</h2>
        {retry.isError && <p role="alert">{errorMessage(retry.error)}</p>}
        {s.failed.length === 0 ? (
          <p className="muted">{t('ingest.noFailures')}</p>
        ) : (
          <ul className={styles.cards}>
            {s.failed.map((f) => (
              <li key={f.jobId} className={styles.candidate}>
                <span className="mono">{tMaybe(f.type, f.type)}</span>
                <span>{f.error}</span>
                {f.attempts !== undefined && <span className="muted">{t('ingest.attempts', { count: f.attempts })}</span>}
                <button type="button" className="btn" onClick={() => retry.mutate(f.jobId)} disabled={retry.isPending}>
                  {t('ingest.retry')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
