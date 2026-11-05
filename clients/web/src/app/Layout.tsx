// App shell: header with the main navigation, the "Da verificare" badge and the profile switch.
import { Link, Outlet } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useServerInfo } from '../api/queries.ts';
import { t } from '../i18n/t.ts';
import { Icon } from '../ui/Icon.tsx';
import styles from './Layout.module.css';
import { useProfile } from './services.tsx';

const active = { className: styles.active, 'aria-current': 'page' as const };

export function Layout(): ReactElement {
  const profile = useProfile();
  const server = useServerInfo();
  const needsReview = server.data?.ingest.needsReview ?? 0;
  return (
    <>
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          {t('app.name')}
        </Link>
        <nav aria-label={t('nav.main')} className={styles.nav}>
          {profile && (
            <>
              <Link to="/" activeOptions={{ exact: true, includeSearch: false }} activeProps={active}>
                {t('nav.home')}
              </Link>
              <Link to="/browse" search={{ kind: 'movie', category: 'film' }} activeOptions={{ includeSearch: true }} activeProps={active}>
                {t('nav.movies')}
              </Link>
              <Link to="/browse" search={{ kind: 'series' }} activeOptions={{ includeSearch: true }} activeProps={active}>
                {t('nav.series')}
              </Link>
              <Link to="/browse" search={{ category: 'documentary' }} activeOptions={{ includeSearch: true }} activeProps={active}>
                {t('nav.documentaries')}
              </Link>
              <Link to="/browse" search={{ inWatchlist: true }} activeOptions={{ includeSearch: true }} activeProps={active}>
                {t('nav.watchlist')}
              </Link>
            </>
          )}
          <Link to="/admin/cases" activeProps={active} className={styles.adminLink}>
            {t('nav.admin')}
            {needsReview > 0 && (
              <span className={styles.badge}>
                <span aria-hidden="true">{needsReview}</span>
                <span className="visually-hidden">{t('nav.adminBadge', { count: needsReview })}</span>
              </span>
            )}
          </Link>
        </nav>
        <div className={styles.tools}>
          {profile && (
            <Link to="/search" className={styles.iconLink} activeProps={active}>
              <Icon name="search" />
              <span className="visually-hidden">{t('nav.search')}</span>
            </Link>
          )}
          <Link to="/profiles" className={styles.profile} title={t('nav.switchProfile')}>
            <Icon name="user" size={20} />
            <span>{profile ? profile.name : t('nav.switchProfile')}</span>
            {profile && <span className="visually-hidden">{t('nav.switchProfile')}</span>}
          </Link>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
      <footer className={styles.footer}>
        <Link to="/about">{t('nav.about')}</Link>
      </footer>
    </>
  );
}
