// Poster card of an item summary: image (or a generated placeholder), title, progress, watched mark, badges.
import type { ReactElement } from 'react';
import type { ItemSummary } from '../api/types.ts';
import { t } from '../i18n/t.ts';
import styles from './ItemCard.module.css';
import { Icon } from './Icon.tsx';
import { pickImage, placeholderHue } from './images.ts';

/** "S1E3", or null without both numbers. */
export function episodeCode(item: ItemSummary): string | null {
  const { seasonNumber: season, episodeNumber: episode } = item;
  return season !== null && season !== undefined && episode !== null && episode !== undefined ? t('item.episodeCode', { season, episode }) : null;
}

const seriesOf = (item: ItemSummary): string | null => (item.kind === 'episode' && item.seriesTitle ? item.seriesTitle : null);

/** Second line of a card or of the item page: "Serie · S1E3" for an episode, the year for a work. */
export function itemSubtitle(item: ItemSummary): string | null {
  if (item.kind === 'episode') {
    const code = episodeCode(item);
    const series = seriesOf(item);
    if (series && code) return t('item.episodeOf', { series, code });
    return series ?? code;
  }
  if (item.kind === 'season') return item.seasonNumber !== null && item.seasonNumber !== undefined ? t('item.season', { number: item.seasonNumber }) : null;
  return item.year ? String(item.year) : null;
}

export interface ItemCardProps {
  item: ItemSummary;
  /** Rendered as a link by the caller (router-specific), this is its content. */
  wide?: boolean;
}

/** The two text lines of a card. An episode card leads with its series: "Serie" over "S1E3 · Titolo episodio". */
function cardLines(item: ItemSummary): { heading: string; sub: string | null } {
  const series = seriesOf(item);
  const code = episodeCode(item);
  const heading = series ?? item.title;
  const sub = series ? (code ? t('item.episodeLine', { code, title: item.title }) : item.title) : itemSubtitle(item);
  return { heading, sub };
}

/**
 * Accessible name of a card link: its visible lines, in order ("Blade Runner 2049 · 2017"), so that the name
 * contains the visible label (WCAG 2.5.3, axe label-content-name-mismatch).
 */
export function cardLabel(item: ItemSummary): string {
  const { heading, sub } = cardLines(item);
  return sub ? `${heading} · ${sub}` : heading;
}

/** The visual part of a card; the caller wraps it in its link element. */
export function ItemCardBody({ item, wide = false }: ItemCardProps): ReactElement {
  const img = pickImage(item.images, wide ? ['backdrop', 'still', 'thumbnail', 'poster'] : ['poster', 'thumbnail', 'still'], wide ? 640 : 320);
  const { heading, sub } = cardLines(item);
  const progress = item.state?.progressPercent ?? 0;
  return (
    <div className={`${styles.card} ${wide ? styles.wide : ''}`}>
      <div className={styles.media} style={img ? undefined : { ['--hue' as string]: placeholderHue(item.title) }}>
        {img ? (
          <img src={img.src} srcSet={img.srcSet} sizes={wide ? '(min-width: 1200px) 22vw, 45vw' : '(min-width: 1200px) 12rem, 30vw'} alt="" loading="lazy" decoding="async" />
        ) : (
          // The title on the placeholder is drawn by CSS (attr): text here would repeat the title in the visible
          // label of the link and break label-in-name.
          <span className={styles.placeholder} data-text={heading} aria-hidden="true" />
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
      <span className={styles.title}>{heading}</span>
      {/* The space keeps the lines apart in the visible text ("Titolo 2017", not "Titolo2017"); the flex layout
          does not render it. */}
      {sub && (
        <>
          {' '}
          <span className={styles.sub}>{sub}</span>
        </>
      )}
      {progress > 0 && progress < 100 && <span className="visually-hidden">{t('item.progress', { percent: Math.round(progress) })}</span>}
    </div>
  );
}

