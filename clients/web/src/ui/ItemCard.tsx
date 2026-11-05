// Poster card of an item summary: image (or a generated placeholder), title, progress, watched mark, badges.
import type { ReactElement } from 'react';
import type { ItemSummary } from '../api/types.ts';
import { t } from '../i18n/t.ts';
import styles from './ItemCard.module.css';
import { Icon } from './Icon.tsx';
import { pickImage, placeholderHue } from './images.ts';

export function itemSubtitle(item: ItemSummary): string | null {
  if (item.kind === 'episode') {
    const se = item.seasonNumber !== null && item.seasonNumber !== undefined && item.episodeNumber !== null && item.episodeNumber !== undefined ? `S${item.seasonNumber} E${item.episodeNumber}` : null;
    return se;
  }
  if (item.kind === 'season') return item.seasonNumber !== null && item.seasonNumber !== undefined ? t('item.season', { number: item.seasonNumber }) : null;
  return item.year ? String(item.year) : null;
}

export interface ItemCardProps {
  item: ItemSummary;
  /** Rendered as a link by the caller (router-specific), this is its content. */
  wide?: boolean;
}

/** The visual part of a card; the caller wraps it in its link element. */
export function ItemCardBody({ item, wide = false }: ItemCardProps): ReactElement {
  const img = pickImage(item.images, wide ? ['backdrop', 'still', 'thumbnail', 'poster'] : ['poster', 'thumbnail', 'still'], wide ? 640 : 320);
  const sub = itemSubtitle(item);
  const progress = item.state?.progressPercent ?? 0;
  return (
    <div className={`${styles.card} ${wide ? styles.wide : ''}`}>
      <div className={styles.media} style={img ? undefined : { ['--hue' as string]: placeholderHue(item.title) }}>
        {img ? (
          <img src={img.src} srcSet={img.srcSet} sizes={wide ? '(min-width: 1200px) 22vw, 45vw' : '(min-width: 1200px) 12rem, 30vw'} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className={styles.placeholder} aria-hidden="true">
            {item.title}
          </span>
        )}
        {item.state?.watched && (
          <span className={styles.watched} title={t('item.watched')}>
            <Icon name="check" size={16} />
            <span className="visually-hidden">{t('item.watched')}</span>
          </span>
        )}
        {progress > 0 && progress < 100 && (
          <span className={styles.progress} aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </span>
        )}
        {!item.available && <span className={styles.unavailable}>!</span>}
      </div>
      <span className={styles.title}>{item.title}</span>
      {sub && <span className={styles.sub}>{sub}</span>}
      {progress > 0 && progress < 100 && <span className="visually-hidden">{t('item.progress', { percent: Math.round(progress) })}</span>}
    </div>
  );
}

