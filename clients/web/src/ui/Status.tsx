import type { ReactElement, ReactNode } from 'react';
import { ApiError } from '../api/problem.ts';
import { t } from '../i18n/t.ts';
import { errorMessage } from './errors.ts';
import styles from './Status.module.css';

export function Loading({ label }: { label?: string }): ReactElement {
  return (
    <div className={styles.loading} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <span>{label ?? t('app.loading')}</span>
    </div>
  );
}

/** retrying: the query is retrying by itself (it says so, under the message). */
export function ErrorView({ error, onRetry, retrying = false }: { error: unknown; onRetry?: () => void; retrying?: boolean }): ReactElement {
  // The code helps when the server answered; on a transient error it would only name the gateway's stand-in.
  const showCode = error instanceof ApiError && !error.transient;
  return (
    <div className={styles.error} role="alert">
      <p>{errorMessage(error)}</p>
      {retrying && <p>{t('error.retrying')}</p>}
      {showCode && <p className={styles.code}>{t('error.code', { code: error.code })}</p>}
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          {t('app.retry')}
        </button>
      )}
    </div>
  );
}

/** The parts of a TanStack query result that QueryFallback reads. */
export interface QueryLike {
  error: unknown;
  failureReason: unknown;
  refetch: () => unknown;
}

/**
 * What a query shows while it has no data: the spinner, the last failure while the query retries it by itself, or
 * the error with "Riprova". Callers render their data whenever it exists, so a failed background refetch does not
 * replace a page already shown.
 */
export function QueryFallback({ query }: { query: QueryLike }): ReactElement {
  const retry = () => void query.refetch();
  if (query.error) return <ErrorView error={query.error} onRetry={retry} />;
  if (query.failureReason) return <ErrorView error={query.failureReason} onRetry={retry} retrying />;
  return <Loading />;
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <p className={styles.empty}>{children}</p>;
}
