// Visible attribution of the data sources (ADR 0007 point 8, doc 05 §5.12): the TMDB notice unchanged, followed
// by its Italian translation, and "Dati da Wikidata (CC0)". The server lists TMDB when it is configured or when
// TMDB data is still in the catalog, so the client shows exactly what it gets.
import type { ReactElement } from 'react';
import type { ServerInfo } from '../../api/types.ts';
import { t } from '../../i18n/t.ts';
import styles from './about.module.css';

export function Attribution({ providers }: { providers: ServerInfo['providers'] }): ReactElement {
  const tmdb = providers.find((p) => p.name === 'tmdb');
  const wikidata = providers.find((p) => p.name === 'wikidata');
  return (
    <div className={styles.attribution}>
      {tmdb && (
        <section className={styles.provider} aria-label="TMDB">
          <p lang="en">{tmdb.attribution}</p>
          <p>{t('about.tmdbTranslation')}</p>
        </section>
      )}
      {wikidata && (
        <section className={styles.provider} aria-label="Wikidata">
          <p>{wikidata.attribution ?? t('about.wikidata')}</p>
        </section>
      )}
    </div>
  );
}
