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

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }): ReactElement {
  return (
    <div className={styles.error} role="alert">
      <p>{errorMessage(error)}</p>
      {error instanceof ApiError && error.code !== 'NETWORK' && <p className={styles.code}>{t('error.code', { code: error.code })}</p>}
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          {t('app.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <p className={styles.empty}>{children}</p>;
}
