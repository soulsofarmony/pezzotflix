// Library roots: status, file count, last scan, the unmounted-root guard (held) with its confirmation, and scans.
import { type ReactElement, useState } from 'react';
import { useConfirmRoot, useRoots, useTriggerScan } from '../../api/queries.ts';
import type { LibraryRoot } from '../../api/types.ts';
import { formatNumber, formatRelative } from '../../i18n/format.ts';
import { t, tMaybe } from '../../i18n/t.ts';
import { errorMessage } from '../../ui/errors.ts';
import { Icon } from '../../ui/Icon.tsx';
import { Empty, QueryFallback } from '../../ui/Status.tsx';
import styles from './admin.module.css';

export function RootsPage(): ReactElement {
  const roots = useRoots();
  const scan = useTriggerScan();
  return (
    <section aria-label={t('admin.roots')}>
      <div className={styles.toolbar}>
        <button type="button" className="btn" onClick={() => scan.mutate(undefined)} disabled={scan.isPending}>
          {t('roots.scanAll')}
        </button>
        {scan.isSuccess && <span role="status">{t('roots.scanQueued')}</span>}
        {scan.isError && <span role="alert">{errorMessage(scan.error)}</span>}
      </div>
      {!roots.data && <QueryFallback query={roots} />}
      {roots.data && roots.data.roots.length === 0 && <Empty>{t('roots.empty')}</Empty>}
      <ul className={styles.cards}>
        {roots.data?.roots.map((r) => (
          <li key={r.id}>
            <RootCard root={r} onScan={() => scan.mutate(r.id)} scanning={scan.isPending} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RootCard({ root, onScan, scanning }: { root: LibraryRoot; onScan: () => void; scanning: boolean }): ReactElement {
  const confirm = useConfirmRoot();
  const [asked, setAsked] = useState(false);
  const held = root.held ?? null;
  return (
    <div className={styles.root}>
      <div className={styles.rootHead}>
        <strong>{root.name}</strong>
        <span className={root.status === 'online' ? styles.ok : styles.bad}>{tMaybe(`roots.status.${root.status}`, root.status)}</span>
      </div>
      <span className="mono">{root.mountPath}</span>
      <span className="muted">
        {[
          tMaybe(`roots.hint.${root.hint}`, root.hint),
          root.fileCount !== undefined ? t('roots.files', { count: formatNumber(root.fileCount) }) : null,
          root.lastScanAt ? t('roots.lastScan', { when: formatRelative(root.lastScanAt) }) : t('roots.neverScanned'),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {held && (
        <div className={styles.held} role="note">
          <p>
            <Icon name="warning" size={18} /> <strong>{t('roots.held')}</strong>
          </p>
          <p>{tMaybe(`roots.held.${held.reason}`, held.reason)}</p>
          <p>{t('roots.heldMissing', { count: formatNumber(held.missingFiles) })}</p>
          {held.confirmed || confirm.isSuccess ? (
            <p role="status">{t('roots.confirmed')}</p>
          ) : asked ? (
            <div className={styles.inlineConfirm}>
              <p>{t('roots.confirmQuestion', { count: formatNumber(held.missingFiles) })}</p>
              <button type="button" className="btn btn-primary" onClick={() => confirm.mutate(root.id)} disabled={confirm.isPending}>
                {t('roots.confirm')}
              </button>
              <button type="button" className="btn" onClick={() => setAsked(false)}>
                {t('app.cancel')}
              </button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setAsked(true)}>
              {t('roots.confirm')}
            </button>
          )}
          {confirm.isError && <p role="alert">{errorMessage(confirm.error)}</p>}
        </div>
      )}
      <div>
        <button type="button" className="btn" onClick={onScan} disabled={scanning}>
          {t('roots.scan')}
        </button>
      </div>
    </div>
  );
}
