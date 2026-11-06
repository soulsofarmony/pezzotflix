// Item detail (doc 03 §3.4): movie, documentary, series → seasons → episodes, season, episode, extra. Never
// assumes a movie: what is shown follows the kind and what the item has (versions, children, extras).
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactElement, useId, useState } from 'react';
import { useChildren, useItem, useNextUp, useWatchState } from '../../api/queries.ts';
import type { ItemDetail, ItemSummary, MediaVersion } from '../../api/types.ts';
import { formatBytes, formatClock, formatDuration } from '../../i18n/format.ts';
import { t } from '../../i18n/t.ts';
import { Icon } from '../../ui/Icon.tsx';
import { itemSubtitle } from '../../ui/ItemCard.tsx';
import { pickImage } from '../../ui/images.ts';
import { errorMessage } from '../../ui/errors.ts';
import { QueryFallback } from '../../ui/Status.tsx';
import { trackLabel } from '../../ui/tracks.ts';
import { CardRow } from '../catalog/CardRow.tsx';
import styles from './item.module.css';

export function ItemPage({ itemId }: { itemId: string }): ReactElement {
  const item = useItem(itemId);
  // A cached item stays on screen when a background refetch fails.
  if (!item.data) {
    return (
      <div className="page">
        <QueryFallback query={item} />
      </div>
    );
  }
  return <Detail key={item.data.id} item={item.data} />;
}

function kindLabel(item: ItemSummary): string {
  if (item.category === 'documentary') return t('kind.documentary');
  switch (item.kind) {
    case 'movie':
    case 'series':
    case 'season':
    case 'episode':
    case 'extra':
      return t(`kind.${item.kind}`);
    default:
      return item.kind;
  }
}

function Detail({ item }: { item: ItemDetail }): ReactElement {
  const backdrop = pickImage(item.images, ['backdrop', 'still'], 1920);
  const poster = pickImage(item.images, ['poster'], 640);
  const playable = item.versions.length > 0;
  const hasChildren = item.kind === 'series' || item.kind === 'season';
  const [fileId, setFileId] = useState<string | null>(item.versions.find((v) => v.available)?.fileId ?? item.versions[0]?.fileId ?? null);
  const duration = item.durationMs ?? item.versions[0]?.durationMs ?? null;
  const meta = [kindLabel(item), itemSubtitle(item), duration ? formatDuration(duration) : null].filter(Boolean);

  return (
    <article className={styles.detail}>
      <div className={styles.hero}>
        {backdrop && <img className={styles.backdrop} src={backdrop.src} srcSet={backdrop.srcSet} sizes="100vw" alt="" />}
        <div className={styles.heroContent}>
          {poster && <img className={styles.poster} src={poster.src} srcSet={poster.srcSet} sizes="16rem" alt="" />}
          <div className={styles.heading}>
            {item.parent && (
              <Link to="/item/$itemId" params={{ itemId: item.parent.id }} className={styles.parent}>
                {t('item.partOf', { title: item.parent.title })}
              </Link>
            )}
            <h1 className={styles.title}>{item.title}</h1>
            <p className={styles.meta}>{meta.join(' · ')}</p>
            {item.originalTitle && item.originalTitle !== item.title && <p className="muted">{t('item.originalTitle', { title: item.originalTitle })}</p>}
            {item.editionLabel && <p className="muted">{t('item.edition', { label: item.editionLabel })}</p>}
            {item.badges.length > 0 && (
              <ul className={styles.badges}>
                {item.badges.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {!item.available && (
              <p className={styles.warning} role="note">
                <Icon name="warning" size={18} /> {t('item.unavailable')}
              </p>
            )}
            <Actions item={item} playable={playable} fileId={fileId} />
          </div>
        </div>
      </div>

      <div className={styles.body}>
        <section aria-labelledby="overview">
          <h2 id="overview" className={styles.sectionTitle}>
            {t('item.overview')}
          </h2>
          <p className={styles.overview}>{item.overview || t('item.noOverview')}</p>
          {item.genres.length > 0 && (
            <p>
              <span className="muted">{t('item.genres')}: </span>
              {item.genres.join(', ')}
            </p>
          )}
        </section>

        {hasChildren && <Children item={item} />}

        {item.versions.length > 0 && <Versions versions={item.versions} fileId={fileId} onSelect={setFileId} />}

        {item.credits.length > 0 && (
          <section aria-labelledby="credits">
            <h2 id="credits" className={styles.sectionTitle}>
              {t('item.credits')}
            </h2>
            <ul className={styles.credits}>
              {item.credits.slice(0, 30).map((c, i) => (
                <li key={`${c.name}-${c.role}-${i}`}>
                  <span className={styles.creditName}>{c.name}</span>
                  <span className="muted">{c.character ? t('item.as', { character: c.character }) : c.role}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {item.attributions && item.attributions.length > 0 && <p className={styles.sources}>{t('item.sources', { sources: item.attributions.join(' · ') })}</p>}
      </div>

      {item.extras.length > 0 && <CardRow headingId="extras" title={t('item.extras')} items={item.extras} wide />}
    </article>
  );
}

function Actions({ item, playable, fileId }: { item: ItemDetail; playable: boolean; fileId: string | null }): ReactElement {
  const watch = useWatchState(item.id);
  const navigate = useNavigate();
  const nextUp = useNextUp(item.id, item.kind === 'series');
  const state = item.state;
  const resume = state?.resumePositionMs ?? null;
  const play = (target: string, from: number | undefined, file: string | null) =>
    void navigate({ to: '/watch/$itemId', params: { itemId: target }, search: { ...(file ? { fileId: file } : {}), ...(from !== undefined ? { t: from } : {}) } });
  const next = nextUp.data?.item ?? null;
  const mutations = Object.values(watch);
  const busy = mutations.some((m) => m.isPending);
  const failed = mutations.find((m) => m.isError)?.error ?? null;
  // One error at a time: the alert is about the last action.
  const run = (m: (typeof mutations)[number]) => {
    for (const other of mutations) if (other !== m) other.reset();
    m.mutate();
  };
  // Doc 01: the watchlist holds films, series and extras; a season or an episode is reached through its series.
  const listable = item.kind !== 'season' && item.kind !== 'episode';

  return (
    <div className={styles.actions}>
      {playable && resume !== null && resume > 0 ? (
        <>
          <button type="button" className="btn btn-light" onClick={() => play(item.id, undefined, fileId)} disabled={!item.available}>
            <Icon name="play" /> {t('item.resume', { time: formatClock(resume) })}
          </button>
          <button type="button" className="btn" onClick={() => play(item.id, 0, fileId)} disabled={!item.available}>
            {t('item.fromStart')}
          </button>
        </>
      ) : playable ? (
        <button type="button" className="btn btn-light" onClick={() => play(item.id, undefined, fileId)} disabled={!item.available}>
          <Icon name="play" /> {t('item.play')}
        </button>
      ) : null}
      {next && (
        <button type="button" className="btn btn-light" onClick={() => play(next.id, undefined, null)} disabled={!next.available}>
          <Icon name="play" />
          {next.seasonNumber != null && next.episodeNumber != null ? t('item.playEpisode', { season: next.seasonNumber, episode: next.episodeNumber }) : t('item.nextUp')}
        </button>
      )}
      {listable && (
        <button
          type="button"
          className="btn"
          aria-pressed={state?.inWatchlist ?? false}
          disabled={busy}
          onClick={() => run(state?.inWatchlist ? watch.removeFromWatchlist : watch.addToWatchlist)}
        >
          <Icon name={state?.inWatchlist ? 'check' : 'plus'} size={20} />
          {state?.inWatchlist ? t('item.watchlistRemove') : t('item.watchlistAdd')}
        </button>
      )}
      <button type="button" className="btn" aria-pressed={state?.watched ?? false} disabled={busy} onClick={() => run(state?.watched ? watch.markUnwatched : watch.markWatched)}>
        <Icon name="check" size={20} />
        {state?.watched ? t('item.markUnwatched') : t('item.markWatched')}
      </button>
      {resume !== null && resume > 0 && (
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => run(watch.clearProgress)}>
          {t('item.clearProgress')}
        </button>
      )}
      {failed && (
        <p role="alert" className={styles.actionError}>
          {errorMessage(failed)}
        </p>
      )}
    </div>
  );
}

function Children({ item }: { item: ItemDetail }): ReactElement {
  const children = useChildren(item.id);
  const list = children.data?.pages.flatMap((p) => p.items) ?? (item.children.length ? item.children : []);
  const isSeries = item.kind === 'series';
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>
        {isSeries ? t('item.seasons') : t('item.episodes')}
      </h2>
      {!children.data && list.length === 0 && <QueryFallback query={children} />}
      <ol className={isSeries ? styles.seasons : styles.episodes}>
        {list.map((c) => (
          <li key={c.id}>
            <Link to="/item/$itemId" params={{ itemId: c.id }} className={styles.childLink}>
              <span className={styles.childTitle}>
                {isSeries
                  ? c.seasonNumber === 0
                    ? t('item.specials')
                    : c.seasonNumber != null
                      ? t('item.season', { number: c.seasonNumber })
                      : c.title
                  : `${c.episodeNumber != null ? `${c.episodeNumber}. ` : ''}${c.title}`}
              </span>
              <span className="muted">
                {[c.durationMs ? formatDuration(c.durationMs) : null, c.state?.watched ? t('item.watched') : null, c.state && c.state.progressPercent > 0 && c.state.progressPercent < 100 ? t('item.progress', { percent: Math.round(c.state.progressPercent) }) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {children.hasNextPage && (
        <button type="button" className="btn" onClick={() => void children.fetchNextPage()}>
          {t('app.loadMore')}
        </button>
      )}
    </section>
  );
}

function Versions({ versions, fileId, onSelect }: { versions: MediaVersion[]; fileId: string | null; onSelect: (id: string) => void }): ReactElement {
  const name = useId();
  return (
    <section aria-labelledby={`${name}-title`}>
      <h2 id={`${name}-title`} className={styles.sectionTitle}>
        {t('item.versions')}
      </h2>
      <fieldset className={styles.versions}>
        <legend className="visually-hidden">{t('item.chooseVersion')}</legend>
        {versions.map((v) => {
          const audio = v.tracks.filter((tr) => tr.type === 'audio');
          const subs = v.tracks.filter((tr) => tr.type === 'subtitle');
          return (
            <label key={v.fileId} className={`${styles.version} ${fileId === v.fileId ? styles.versionSelected : ''}`}>
              {versions.length > 1 && <input type="radio" name={name} value={v.fileId} checked={fileId === v.fileId} onChange={() => onSelect(v.fileId)} disabled={!v.available} />}
              <span className={styles.versionBody}>
                <span className={styles.versionLabel}>
                  {v.label}
                  {v.sizeBytes ? <span className="muted"> · {formatBytes(v.sizeBytes)}</span> : null}
                </span>
                {!v.available && <span className={styles.warning}>{t('item.unavailable')}</span>}
                <span className={styles.trackList}>
                  <span className="muted">{t('item.audioTracks')}: </span>
                  {audio.length ? audio.map((a) => trackLabel(a)).join(' | ') : t('item.noTracks')}
                </span>
                <span className={styles.trackList}>
                  <span className="muted">{t('item.subtitleTracks')}: </span>
                  {subs.length ? subs.map((s) => trackLabel(s)).join(' | ') : t('item.noTracks')}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}
