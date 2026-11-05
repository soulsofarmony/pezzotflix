// Admin section of the web client (doc 02 C3, doc 03 §6): "Da verificare", libraries, ingest, data sources.
import { Link, Outlet } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { t } from '../../i18n/t.ts';
import styles from './admin.module.css';

const active = { className: styles.tabActive, 'aria-current': 'page' as const };

export function AdminLayout(): ReactElement {
  return (
    <div className="page">
      <h1 className="page-title">{t('admin.title')}</h1>
      <nav aria-label={t('admin.nav')} className={styles.tabs}>
        <Link to="/admin/cases" activeProps={active}>
          {t('admin.cases')}
        </Link>
        <Link to="/admin/roots" activeProps={active}>
          {t('admin.roots')}
        </Link>
        <Link to="/admin/ingest" activeProps={active}>
          {t('admin.ingest')}
        </Link>
        <Link to="/admin/providers" activeProps={active}>
          {t('admin.providers')}
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
