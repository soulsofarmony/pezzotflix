// Data sources with their status and attribution notices, from GetServerInfo (ADR 0007 point 8).
import type { ReactElement } from 'react';
import { useServerInfo } from '../../api/queries.ts';
import { t, tMaybe } from '../../i18n/t.ts';
import { QueryFallback } from '../../ui/Status.tsx';
import { Attribution } from '../about/Attribution.tsx';
import styles from './admin.module.css';

export function ProvidersPage(): ReactElement {
  const server = useServerInfo();
  if (!server.data) return <QueryFallback query={server} />;
  return (
    <section aria-label={t('providers.title')} className={styles.stack}>
      <ul className={styles.cards}>
        {server.data.providers.map((p) => (
          <li key={p.name} className={styles.root}>
            <div className={styles.rootHead}>
              <strong>{p.name === 'tmdb' ? 'TMDB' : p.name === 'wikidata' ? 'Wikidata' : p.name}</strong>
              <span className={p.status === 'ok' ? styles.ok : styles.bad}>{tMaybe(`providers.status.${p.status}`, p.status)}</span>
            </div>
          </li>
        ))}
      </ul>
      <Attribution providers={server.data.providers} />
    </section>
  );
}
