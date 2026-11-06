// "File mancanti": the files a scan found gone (ListMediaFiles state=missing) with the titles they hold, and
// "Dimentica" (ForgetMediaFile), one file or every missing file of a library (ForgetMissingFiles), each behind an
// in-app confirmation. The root filter is in the URL; a stale one (a root no longer configured) falls back to every
// library. The automatic rule (autoRemoveAfterDays) is spelled out.
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../api/problem.ts';
import { useForgetFile, useForgetRootMissing, useMissingFiles, useRoots } from '../../api/queries.ts';
import type { FileItem, LibraryRoot, MediaFileEntry } from '../../api/types.ts';
import { formatBytes, formatDate, formatNumber } from '../../i18n/format.ts';
import { t } from '../../i18n/t.ts';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { errorMessage } from '../../ui/errors.ts';
import { Empty, QueryFallback } from '../../ui/Status.tsx';
import styles from './admin.module.css';

type Asking = { kind: 'file'; file: MediaFileEntry } | { kind: 'root'; root: LibraryRoot; count: number } | null;

/** The rule line: how many days a missing file waits before it is forgotten by itself, or that it never is. */
export function ruleLine(days: number): string {
  if (days <= 0) return t('files.ruleOff');
  return days === 1 ? t('files.ruleOne') : t('files.rule', { days: formatNumber(days) });
}

/** "Dark · S1E2 · Titolo", "Arrival (2016)", "Extra · Trailer". */
export function fileItemLabel(i: FileItem): string {
  const has = (n: number | null | undefined): n is number => n !== null && n !== undefined;
  if (i.kind === 'episode') {
    const code = has(i.seasonNumber) && has(i.episodeNumber) ? t('item.episodeCode', { season: i.seasonNumber, episode: i.episodeNumber }) : null;
    return [i.seriesTitle, code, i.title].filter(Boolean).join(' · ');
  }
  if (i.kind === 'season') return [i.seriesTitle, has(i.seasonNumber) ? t('item.season', { number: i.seasonNumber }) : i.title].filter(Boolean).join(' · ');
  const title = i.year ? `${i.title} (${i.year})` : i.title;
  return i.kind === 'extra' ? `${t('kind.extra')} · ${title}` : title;
}

/** A root whose missing files may be forgotten in bulk: online and not held (the server refuses otherwise). */
const settled = (root: LibraryRoot): boolean => root.status === 'online' && !root.held;

export function MissingFilesPage(): ReactElement {
  const search = useSearch({ from: '/_shell/admin/files' });
  const navigate = useNavigate({ from: '/admin/files' });
  const roots = useRoots();
  const known = roots.data?.roots;
  // An old link or bookmark may name a root that is gone: list every library instead of a 404 with no way out.
  const stale = search.rootId !== undefined && known !== undefined && !known.some((r) => r.id === search.rootId);
  const rootId = stale ? undefined : search.rootId;
  const files = useMissingFiles(rootId);
  // The same, found by the list itself when it was asked before the roots arrived.
  const unknownRoot = rootId !== undefined && files.error instanceof ApiError && files.error.status === 404;
  const forgetFile = useForgetFile();
  const forgetRoot = useForgetRootMissing();
  const [asking, setAsking] = useState<Asking>(null);
  const [done, setDone] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const selectId = useId();

  useEffect(() => {
    if (stale || unknownRoot) void navigate({ search: {}, replace: true });
  }, [stale, unknownRoot, navigate]);

  const list = files.data?.pages.flatMap((p) => p.files) ?? [];
  const first = files.data?.pages[0];
  const root = rootId ? (roots.data?.roots.find((r) => r.id === rootId) ?? null) : null;
  const total = first?.total ?? 0;

  const ask = (next: NonNullable<Asking>) => {
    forgetFile.reset();
    forgetRoot.reset();
    setDone(null);
    setAsking(next);
  };

  const dialogError = (error: unknown, kind: 'file' | 'root'): string | null => {
    if (!error) return null;
    if (error instanceof ApiError && error.status === 409) return kind === 'file' ? t('files.conflictOne') : t('files.conflictAll');
    return errorMessage(error);
  };

  return (
    <section aria-label={t('admin.files')}>
      <div className={styles.toolbar}>
        <label className="field" htmlFor={selectId}>
          {t('files.root')}
          <select
            id={selectId}
            className="select"
            value={rootId ?? ''}
            onChange={(e) => {
              setDone(null);
              void navigate({ search: e.target.value ? { rootId: e.target.value } : {}, replace: true });
            }}
          >
            <option value="">{t('files.allRoots')}</option>
            {roots.data?.roots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {root && total > 0 && (
          <button type="button" className="btn" disabled={!settled(root) || forgetRoot.isPending} onClick={() => ask({ kind: 'root', root, count: total })}>
            {t('files.forgetAll')}
          </button>
        )}
      </div>

      {first && (
        <div className={styles.notes}>
          <p>{ruleLine(first.autoRemoveAfterDays)}</p>
          <p className="muted">{t('files.explain')}</p>
          {root && total > 0 && !settled(root) && <p role="note">{t('files.forgetAllBlocked', { root: root.name })}</p>}
        </div>
      )}

      <p ref={statusRef} role="status" tabIndex={-1} className={styles.done}>
        {done}
      </p>

      {!files.data && !unknownRoot && <QueryFallback query={files} />}
      {files.data && list.length === 0 && <Empty>{rootId ? t('files.emptyRoot') : t('files.empty')}</Empty>}
      {files.data && list.length > 0 && <p className="muted">{t('files.total', { count: formatNumber(total) })}</p>}
      <ul className={styles.cards}>
        {list.map((f) => (
          <li key={f.fileId} className={styles.candidate}>
            <MissingFile file={f} />
            <button type="button" className="btn" onClick={() => ask({ kind: 'file', file: f })} aria-label={t('files.forgetLabel', { path: f.relPath })}>
              {t('files.forget')}
            </button>
          </li>
        ))}
      </ul>
      {files.hasNextPage && (
        <button type="button" className="btn" onClick={() => void files.fetchNextPage()} disabled={files.isFetchingNextPage}>
          {t('app.loadMore')}
        </button>
      )}

      {asking?.kind === 'file' && (
        <ConfirmDialog
          title={t('files.forgetTitle')}
          confirmLabel={t('files.forget')}
          busy={forgetFile.isPending}
          error={dialogError(forgetFile.error, 'file')}
          onConfirm={(close) =>
            forgetFile.mutate(asking.file.fileId, {
              onSuccess: () => {
                setDone(t('files.forgottenOne'));
                close(statusRef.current);
              },
            })
          }
          onClosed={() => setAsking(null)}
          fallbackFocus={statusRef}
        >
          <p>{t('files.forgetQuestion')}</p>
          <p className={styles.path}>{asking.file.relPath}</p>
          <p>{t('files.forgetEffect')}</p>
        </ConfirmDialog>
      )}
      {asking?.kind === 'root' && (
        <ConfirmDialog
          title={t('files.forgetAllTitle', { root: asking.root.name })}
          confirmLabel={t('files.forgetAllConfirm', { count: formatNumber(asking.count) })}
          busy={forgetRoot.isPending}
          error={dialogError(forgetRoot.error, 'root')}
          onConfirm={(close) =>
            forgetRoot.mutate(asking.root.id, {
              onSuccess: (r) => {
                setDone(t('files.forgotten', { count: formatNumber(r.forgotten) }));
                close(statusRef.current);
              },
            })
          }
          onClosed={() => setAsking(null)}
          fallbackFocus={statusRef}
        >
          <p>{t('files.forgetAllQuestion', { root: asking.root.name, count: formatNumber(asking.count) })}</p>
          <p>{t('files.forgetEffect')}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function MissingFile({ file }: { file: MediaFileEntry }): ReactElement {
  const titles = file.items.map(fileItemLabel);
  return (
    <div className={styles.fileInfo}>
      <span className={styles.path}>{file.relPath}</span>
      <span className="muted">
        {[file.rootName, file.missingSince !== null ? t('files.missingSince', { date: formatDate(file.missingSince) }) : t('files.missingUnknown'), formatBytes(file.sizeBytes)].join(' · ')}
      </span>
      <span>{titles.length ? t('files.titles', { titles: titles.join(', ') }) : t('files.noTitles')}</span>
    </div>
  );
}
