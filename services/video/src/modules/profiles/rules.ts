// Watch-state rules (doc 01 §7.2, D3): thresholds and orderings, pure so they get table tests.
import type { ProfilePrefs } from '../../shared/ports.ts';

/** Watched at or past this share of the duration (D3). */
export const WATCHED_THRESHOLD = 0.9;
/** Continue watching from this share of the duration (D3). */
export const IN_PROGRESS_THRESHOLD = 0.02;
/** Below this position there is nothing worth resuming: playback starts from the beginning. */
export const RESUME_MIN_POSITION_MS = 30_000;
/** Samples of the same item closer than this extend the same history row (ViewingRecord). */
export const VIEWING_RECORD_GAP_MS = 30 * 60_000;

/** Prefs of a new profile when the client sends none. */
export const DEFAULT_PREFS: ProfilePrefs = {
  audioLanguages: ['ita', 'eng'],
  subtitleLanguages: ['ita'],
  subtitleMode: 'forced',
};

/** Percent of the item seen, 0 when the duration is unknown. */
export function progressPercent(positionMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(100, Math.max(0, (positionMs / durationMs) * 100));
}

/** A sample completes the item when the stream ended or the position crossed the threshold. */
export function isCompleted(positionMs: number, durationMs: number | null, ended: boolean): boolean {
  if (ended) return true;
  return durationMs !== null && durationMs > 0 && positionMs >= durationMs * WATCHED_THRESHOLD;
}

/**
 * In progress (Continue watching, D3): from 2 % to under 90 % of the duration. With an unknown
 * duration any position > 0 counts.
 */
export function isInProgress(positionMs: number, durationMs: number): boolean {
  if (positionMs <= 0) return false;
  if (durationMs <= 0) return true;
  return positionMs >= durationMs * IN_PROGRESS_THRESHOLD && positionMs < durationMs * WATCHED_THRESHOLD;
}

/** Resume position for a stored progress (≥ 30 s, under 90 %), or null to start from the beginning. */
export function resumeFrom(positionMs: number, durationMs: number): number | null {
  if (positionMs < RESUME_MIN_POSITION_MS) return null;
  if (durationMs > 0 && positionMs >= durationMs * WATCHED_THRESHOLD) return null;
  return positionMs;
}

export interface EpisodeRef {
  id: string;
  seasonNumber: number | null;
}

/**
 * Viewing order of a series: the catalog order (season, episode) with specials (season 0) moved
 * last, unless the series has only specials. The relative catalog order is otherwise kept.
 */
export function viewingOrder(episodes: readonly EpisodeRef[]): string[] {
  const regular = episodes.filter((e) => e.seasonNumber !== 0);
  if (regular.length === 0) return episodes.map((e) => e.id);
  return [...regular, ...episodes.filter((e) => e.seasonNumber === 0)].map((e) => e.id);
}

export interface EpisodeActivity {
  watched: boolean;
  inProgress: boolean;
  /** Last activity on the episode (ms UTC): watched mark or progress sample. */
  lastAt: number;
}

/**
 * Next episode to watch. The anchor is the episode with the most recent activity; when the series
 * has regular episodes, activity on specials (`isSpecial`) never anchors, so watching a special
 * does not end the series. In progress → the anchor itself (resume it). Watched → the first
 * unwatched episode after it, else the first unwatched one from the start (a re-watched finale with
 * earlier gaps). No activity → the first unwatched episode. `playable` filters episodes without media.
 */
export function pickNextUp(
  order: readonly string[],
  activity: ReadonlyMap<string, EpisodeActivity>,
  playable: (id: string) => boolean,
  isSpecial: (id: string) => boolean = () => false,
): string | null {
  const hasRegular = order.some((id) => !isSpecial(id));
  let anchor = -1;
  let anchorAt = -Infinity;
  order.forEach((id, i) => {
    const a = activity.get(id);
    if (!a || (!a.watched && !a.inProgress)) return;
    if (hasRegular && isSpecial(id)) return;
    // Ties go to the later episode: marking a whole season watched leaves one timestamp.
    if (a.lastAt >= anchorAt) {
      anchor = i;
      anchorAt = a.lastAt;
    }
  });
  const anchorId = anchor >= 0 ? order[anchor] : undefined;
  if (anchorId !== undefined && activity.get(anchorId)?.inProgress && playable(anchorId)) return anchorId;
  const unwatched = (i: number) => {
    const id = order[i]!;
    return !activity.get(id)?.watched && playable(id);
  };
  for (let i = anchor + 1; i < order.length; i++) if (unwatched(i)) return order[i]!;
  for (let i = 0; i <= anchor; i++) if (unwatched(i)) return order[i]!;
  return null;
}
