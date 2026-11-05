// "Informazioni / Crediti": versions, features and the provider attribution (ADR 0007 point 8).
import type { ReactElement } from 'react';
import { useServerInfo } from '../../api/queries.ts';
import { t } from '../../i18n/t.ts';
import { ErrorView, Loading } from '../../ui/Status.tsx';
import { Attribution } from './Attribution.tsx';

export function AboutPage(): ReactElement {
  const server = useServerInfo();
  return (
    <div className="page">
      <h1 className="page-title">{t('about.title')}</h1>
      {server.isPending && <Loading />}
      {server.isError && <ErrorView error={server.error} onRetry={() => void server.refetch()} />}
      {server.data && (
        <>
          <p>{t('about.version', { version: server.data.version, client: __APP_VERSION__ })}</p>
          <p className="muted">
            {t('about.transcode', { state: server.data.features.transcode ? t('about.on') : t('about.off') })} ·{' '}
            {t('about.directStream', { state: server.data.features.directStream ? t('about.on') : t('about.off') })}
          </p>
          <Attribution providers={server.data.providers} />
        </>
      )}
    </div>
  );
}
