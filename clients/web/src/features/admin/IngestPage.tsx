// Ingest status: running/queued, files per state, jobs per type and state, failed jobs with retry.
import type { ReactElement } from 'react';
import { useIngest, useRetryJob } from '../../api/queries.ts';
import type { IngestStatus } from '../../api/types.ts';
import { formatNumber } from '../../i18n/format.ts';
import { t, tMaybe } from '../../i18n/t.ts';
import { errorMessage } from '../../ui/errors.ts';
import { QueryFallback } from '../../ui/Status.tsx';
import styles from './admin.module.css';

const JOB_STATES = ['queued', 'running', 'done', 'failed'] as const;

/** Italian names of the open values the server reports, the raw value when the client does not know it. */
export const fileStateLabel = (state: string): string => tMaybe(`ingest.fileState.${state}`, state);
export const jobTypeLabel = (type: string): string => tMaybe(`ingest.jobType.${type}`, type);

const ERRNO = /\b(ENOENT|EACCES|EPERM|EIO|ENOSPC|ETIMEDOUT)\b/;

/**
 * An Italian line for a failed job's error, which is free server text: from the Node error code in it, or a
 * timeout. Null when neither is there; the page then shows the raw text.
 */
export function jobErrorLabel(error: string): string | null {
  const code = ERRNO.exec(error)?.[1];
  if (code) return tMaybe(`ingest.error.${code}`, '') || null;
  return /\btimed out\b/i.test(error) ? t('ingest.error.timeout') : null;
}

export function IngestPage(): ReactElement {
  const ingest = useIngest();
  const retry = useRetryJob();
  if (!ingest.data) return <QueryFallback query={ingest} />;
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
              <dt>{fileStateLabel(state)}</dt>
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
                  <th scope="row">{jobTypeLabel(type)}</th>
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
                <FailedJob job={f} />
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

function FailedJob({ job }: { job: IngestStatus['failed'][number] }): ReactElement {
  const label = jobErrorLabel(job.error);
  return (
    <>
      <strong>{jobTypeLabel(job.type)}</strong>
      <span>{label ?? job.error}</span>
      {label && <span className="mono muted">{t('ingest.errorDetail', { error: job.error })}</span>}
      {job.attempts !== undefined && <span className="muted">{t('ingest.attempts', { count: job.attempts })}</span>}
    </>
  );
}
