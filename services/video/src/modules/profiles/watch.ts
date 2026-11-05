// Watch state per profile (doc 01 §7.2, doc 02 §3.8): progress, watched, history, watchlist and the
// derived views (Continue watching, next up, last played). All state refers to the catalog item.
//
// Catalog structure comes only from CatalogReadPort: kinds and positions (describeItems), episodes
// of a series or season (listPlayableDescendants) and playable files (getPlayableItem).
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.ts';
import { notFound } from '../../app/problem.ts';
import { newId } from '../../shared/ids.ts';
import type { CatalogReadPort, ProfileItemState, ProgressSample, TrackChoice } from '../../shared/ports.ts';
import {
  type EpisodeActivity,
  isCompleted,
  isInProgress,
  pickNextUp,
  progressPercent,
  resumeFrom,
  VIEWING_RECORD_GAP_MS,
  viewingOrder,
} from './rules.ts';

interface ProgressRow {
  itemId: string;
  positionMs: number;
  durationMs: number;
  clientTs: number;
}
interface WatchRow {
  itemId: string;
  watched: number;
  watchedAt: number | null;
  playCount: number;
}
interface ViewingRow {
  id: string;
  startedAt: number;
  endedAt: number | null;
  maxPositionMs: number;
  completed: number;
}
const CONTAINER_KINDS = new Set(['series', 'season']);
/** subtitle_track_id value for "subtitles off": track ids are `s<index>` or `x:<id>`, so it cannot clash. */
const SUBTITLES_OFF = 'off';

/** `s<index>` → stream index; anything else is not an embedded audio track. */
export function audioStreamIndexOf(trackId: string): number | null {
  const m = /^s(\d+)$/.exec(trackId);
  return m ? Number(m[1]) : null;
}
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface WatchDeps {
  db: Db;
  now: () => number;
  catalog: () => CatalogReadPort;
  profileExists: (profileId: string) => boolean;
  log: FastifyBaseLogger;
}

export function createWatchState({ db, now, catalog, profileExists, log }: WatchDeps) {
  const sql = db.$client;
  const ids = (list: readonly string[]) => JSON.stringify(list);
  const IN = 'IN (SELECT value FROM json_each(@ids))';

  const progressOf = sql.prepare(
    `SELECT item_id AS itemId, position_ms AS positionMs, duration_ms AS durationMs, client_ts AS clientTs
     FROM playback_progress WHERE profile_id = @p AND item_id ${IN}`,
  );
  const watchOf = sql.prepare(
    `SELECT item_id AS itemId, watched, watched_at AS watchedAt, play_count AS playCount
     FROM watch_state WHERE profile_id = @p AND item_id ${IN}`,
  );
  const watchlistOf = sql.prepare(`SELECT item_id FROM watchlist_entry WHERE profile_id = @p AND item_id ${IN}`).pluck();
  const recentProgress = sql.prepare(
    `SELECT item_id AS itemId, position_ms AS positionMs, duration_ms AS durationMs, client_ts AS clientTs
     FROM playback_progress WHERE profile_id = ? AND position_ms > 0 ORDER BY updated_at DESC, item_id`,
  );
  const lastPlayedOf = sql.prepare(
    `SELECT item_id AS itemId, max(at) AS at FROM (
       SELECT item_id, coalesce(ended_at, started_at) AS at FROM viewing_record WHERE profile_id = @p AND item_id ${IN}
       UNION ALL SELECT item_id, client_ts AS at FROM playback_progress WHERE profile_id = @p AND item_id ${IN}
     ) GROUP BY item_id`,
  );

  // A null @audio or @sub (track unknown in the sample) keeps the stored choice of the same file.
  // Track ids are file-local: on a file change the sample's values are taken as they are, unknowns
  // included (SET expressions read the row before the update).
  const upsertProgress = sql.prepare(
    `INSERT INTO playback_progress (profile_id, item_id, position_ms, duration_ms, file_id, audio_stream_index, subtitle_track_id, client_ts, updated_at)
     VALUES (@p, @item, @pos, @dur, @file, @audio, @sub, @at, @now)
     ON CONFLICT (profile_id, item_id) DO UPDATE SET position_ms = excluded.position_ms, duration_ms = excluded.duration_ms,
       file_id = excluded.file_id, client_ts = excluded.client_ts, updated_at = excluded.updated_at,
       audio_stream_index = CASE WHEN file_id IS excluded.file_id
         THEN coalesce(excluded.audio_stream_index, audio_stream_index) ELSE excluded.audio_stream_index END,
       subtitle_track_id = CASE WHEN file_id IS excluded.file_id
         THEN coalesce(excluded.subtitle_track_id, subtitle_track_id) ELSE excluded.subtitle_track_id END`,
  );
  const tracksOf = sql.prepare(
    'SELECT file_id AS file, audio_stream_index AS audio, subtitle_track_id AS sub FROM playback_progress WHERE profile_id = ? AND item_id = ?',
  );
  const deleteProgress = sql.prepare('DELETE FROM playback_progress WHERE profile_id = ? AND item_id = ?');
  // A completed viewing counts one more play.
  const setWatchedPlayed = sql.prepare(
    `INSERT INTO watch_state (profile_id, item_id, watched, watched_at, play_count) VALUES (?, ?, 1, ?, 1)
     ON CONFLICT (profile_id, item_id) DO UPDATE SET watched = 1, watched_at = excluded.watched_at, play_count = play_count + 1`,
  );
  // A manual mark is not a play: the count goes from 0 to 1 at most.
  const setWatchedManual = sql.prepare(
    `INSERT INTO watch_state (profile_id, item_id, watched, watched_at, play_count) VALUES (?, ?, 1, ?, 1)
     ON CONFLICT (profile_id, item_id) DO UPDATE SET watched = 1, watched_at = excluded.watched_at, play_count = max(play_count, 1)`,
  );
  const setUnwatched = sql.prepare('UPDATE watch_state SET watched = 0, watched_at = NULL WHERE profile_id = ? AND item_id = ?');
  const lastViewing = sql.prepare(
    `SELECT id, started_at AS startedAt, ended_at AS endedAt, max_position_ms AS maxPositionMs, completed
     FROM viewing_record WHERE profile_id = ? AND item_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  const insertViewing = sql.prepare(
    `INSERT INTO viewing_record (id, profile_id, item_id, started_at, ended_at, max_position_ms, completed) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateViewing = sql.prepare('UPDATE viewing_record SET ended_at = ?, max_position_ms = ?, completed = ? WHERE id = ?');
  const addWatchlist = sql.prepare('INSERT OR IGNORE INTO watchlist_entry (profile_id, item_id, added_at) VALUES (?, ?, ?)');
  const removeWatchlist = sql.prepare('DELETE FROM watchlist_entry WHERE profile_id = ? AND item_id = ?');

  const byItem = <T extends { itemId: string }>(rows: T[]) => new Map(rows.map((r) => [r.itemId, r]));
  const progressMap = (p: string, list: readonly string[]) => byItem(progressOf.all({ p, ids: ids(list) }) as ProgressRow[]);
  const watchMap = (p: string, list: readonly string[]) => byItem(watchOf.all({ p, ids: ids(list) }) as WatchRow[]);
  const kinds = (list: readonly string[]) => catalog().describeItems(list);

  /** Episodes of a series or season; the item itself otherwise. An unknown item yields []. */
  function targetsOf(itemId: string): string[] {
    if (!catalog().itemExists(itemId)) throw notFound('item');
    const kind = kinds([itemId]).get(itemId)?.kind;
    return kind && CONTAINER_KINDS.has(kind) ? catalog().listPlayableDescendants(itemId) : [itemId];
  }

  function getStates(profileId: string, itemIds: readonly string[]): Map<string, ProfileItemState> {
    const out = new Map<string, ProfileItemState>();
    if (itemIds.length === 0) return out;
    const k = kinds(itemIds);
    const containers = new Map<string, string[]>();
    for (const id of itemIds) {
      const kind = k.get(id)?.kind;
      if (kind && CONTAINER_KINDS.has(kind)) containers.set(id, catalog().listPlayableDescendants(id));
    }
    const episodeIds = [...new Set([...containers.values()].flat())];
    const all = [...itemIds, ...episodeIds];
    const progress = progressMap(profileId, all);
    const watch = watchMap(profileId, all);
    const watchlist = new Set(watchlistOf.all({ p: profileId, ids: ids(itemIds) }) as string[]);

    for (const id of itemIds) {
      const episodes = containers.get(id);
      if (episodes && episodes.length > 0) {
        // Series and season state is derived from the episodes (doc 01 §7.2).
        const seen = episodes.filter((e) => watch.get(e)?.watched === 1).length;
        out.set(id, {
          watched: seen === episodes.length,
          progressPercent: round1((seen / episodes.length) * 100),
          resumePositionMs: null,
          inWatchlist: watchlist.has(id),
        });
        continue;
      }
      const p = progress.get(id);
      const w = watch.get(id);
      out.set(id, {
        watched: w?.watched === 1,
        progressPercent: p ? round1(progressPercent(p.positionMs, p.durationMs)) : 0,
        resumePositionMs: p ? resumeFrom(p.positionMs, p.durationMs) : null,
        inWatchlist: watchlist.has(id),
        playCount: w?.playCount ?? 0,
      });
    }
    return out;
  }

  function continueWatching(profileId: string, limit: number): string[] {
    const out: string[] = [];
    for (const r of recentProgress.iterate(profileId) as Iterable<ProgressRow>) {
      if (out.length >= limit) break;
      if (isInProgress(r.positionMs, r.durationMs)) out.push(r.itemId);
    }
    return out;
  }

  function nextUp(profileId: string, seriesId: string): string | null {
    const episodes = catalog().listPlayableDescendants(seriesId);
    if (episodes.length === 0) return null;
    const k = kinds(episodes);
    const order = viewingOrder(episodes.map((id) => ({ id, seasonNumber: k.get(id)?.seasonNumber ?? null })));
    const progress = progressMap(profileId, episodes);
    const watch = watchMap(profileId, episodes);
    const activity = new Map<string, EpisodeActivity>();
    for (const id of episodes) {
      const p = progress.get(id);
      const w = watch.get(id);
      const inProgress = p ? isInProgress(p.positionMs, p.durationMs) : false;
      const watched = w?.watched === 1;
      if (!inProgress && !watched) continue;
      activity.set(id, { watched, inProgress, lastAt: Math.max(p?.clientTs ?? -Infinity, w?.watchedAt ?? -Infinity) });
    }
    const playable = (id: string) => (catalog().getPlayableItem(id)?.files.length ?? 0) > 0;
    return pickNextUp(order, activity, playable, (id) => k.get(id)?.seasonNumber === 0);
  }

  function lastPlayed(profileId: string, itemIds: readonly string[]): Map<string, number> {
    const k = kinds(itemIds);
    const episodesOf = new Map<string, string[]>();
    for (const id of itemIds) {
      const kind = k.get(id)?.kind;
      if (kind && CONTAINER_KINDS.has(kind)) episodesOf.set(id, catalog().listPlayableDescendants(id));
    }
    const all = [...new Set([...itemIds, ...[...episodesOf.values()].flat()])];
    const at = new Map((lastPlayedOf.all({ p: profileId, ids: ids(all) }) as { itemId: string; at: number }[]).map((r) => [r.itemId, r.at]));
    const out = new Map<string, number>();
    for (const id of itemIds) {
      // A series or season was last played when one of its episodes was.
      const times = [id, ...(episodesOf.get(id) ?? [])].map((e) => at.get(e)).filter((t): t is number => t !== undefined);
      if (times.length) out.set(id, Math.max(...times));
    }
    return out;
  }

  /** The latest viewing still open for a sample: within the gap and not started later. */
  function openViewing(s: ProgressSample): ViewingRow | null {
    const v = lastViewing.get(s.profileId, s.itemId) as ViewingRow | undefined;
    if (!v || s.at < v.startedAt || s.at - (v.endedAt ?? v.startedAt) > VIEWING_RECORD_GAP_MS) return null;
    return v;
  }
  const extendViewing = (v: ViewingRow, s: ProgressSample, completed: boolean) =>
    updateViewing.run(Math.max(v.endedAt ?? v.startedAt, s.at), Math.max(v.maxPositionMs, s.positionMs), completed || v.completed === 1 ? 1 : 0, v.id);

  /** History: a sample extends the latest open, unfinished viewing of the item, or starts a new one. */
  function recordViewing(s: ProgressSample, completed: boolean): void {
    const v = openViewing(s);
    if (v && v.completed === 0) extendViewing(v, s, completed);
    else insertViewing.run(newId(), s.profileId, s.itemId, s.at, s.at, s.positionMs, completed ? 1 : 0);
  }

  const recordProgress = (s: ProgressSample): void =>
    sql.transaction(() => {
      // The profile may have been deleted while a session was open.
      if (!profileExists(s.profileId)) return;
      // Never a foreign-key error: an item removed from the catalog mid-session is skipped. Progress
      // belongs to playable items, never to a series or season.
      const kind = kinds([s.itemId]).get(s.itemId)?.kind;
      if (!kind || CONTAINER_KINDS.has(kind)) {
        log.warn({ itemId: s.itemId, kind: kind ?? null }, 'progress sample ignored: not a playable catalog item');
        return;
      }
      const p = progressMap(s.profileId, [s.itemId]).get(s.itemId);
      const w = watchMap(s.profileId, [s.itemId]).get(s.itemId);
      // Last write wins by `at`: an older sample, or one older than the completion that cleared the
      // progress, is ignored. The same sample twice changes nothing.
      if (p && s.at < p.clientTs) return;
      if (!p && w?.watched === 1 && w.watchedAt !== null && s.at <= w.watchedAt) return;
      const durationMs = s.durationMs ?? p?.durationMs ?? 0;
      const completed = isCompleted(s.positionMs, durationMs > 0 ? durationMs : null, s.ended);
      if (completed) {
        // Samples past the threshold keep coming until the credits end: while the viewing that
        // completed the item is open they extend it, without another play.
        const v = !p && w?.watched === 1 ? openViewing(s) : null;
        if (v && v.completed === 1) {
          extendViewing(v, s, true);
          return;
        }
        recordViewing(s, true);
        deleteProgress.run(s.profileId, s.itemId);
        setWatchedPlayed.run(s.profileId, s.itemId, s.at);
        return;
      }
      recordViewing(s, false);
      upsertProgress.run({
        p: s.profileId,
        item: s.itemId,
        pos: s.positionMs,
        dur: durationMs,
        file: s.fileId,
        audio: s.audioTrackId === undefined ? null : audioStreamIndexOf(s.audioTrackId),
        sub: s.subtitleTrackId === undefined ? null : (s.subtitleTrackId ?? SUBTITLES_OFF),
        at: s.at,
        now: now(),
      });
    })();

  /**
   * Tracks of the progress in course. The choice lives on the progress row (schema), so it goes
   * with it when the item is completed or its progress cleared. The column tells the subtitle
   * states apart: NULL is unknown (subtitleTrackId absent, the prefs decide), 'off' is off. fileId
   * is the file of the latest sample: the stored tracks always belong to it (see upsertProgress).
   */
  function lastTrackChoice(profileId: string, itemId: string): TrackChoice | null {
    const r = tracksOf.get(profileId, itemId) as { file: string | null; audio: number | null; sub: string | null } | undefined;
    if (!r || (r.audio === null && r.sub === null)) return null;
    const out: TrackChoice = { fileId: r.file, audioTrackId: r.audio === null ? null : `s${r.audio}` };
    if (r.sub !== null) out.subtitleTrackId = r.sub === SUBTITLES_OFF ? null : r.sub;
    return out;
  }

  function resumePositionMs(profileId: string, itemId: string): number | null {
    const p = progressMap(profileId, [itemId]).get(itemId);
    return p ? resumeFrom(p.positionMs, p.durationMs) : null;
  }

  /** Idempotent: an already watched episode keeps its date and play count. Clears progress. */
  const markWatched = (profileId: string, itemId: string): void =>
    sql.transaction(() => {
      const targets = targetsOf(itemId);
      const watch = watchMap(profileId, targets);
      const at = now();
      for (const t of targets) {
        if (watch.get(t)?.watched !== 1) setWatchedManual.run(profileId, t, at);
        deleteProgress.run(profileId, t);
      }
    })();

  /** Back to "not started": watched flag and progress go; play count and history stay. */
  const markUnwatched = (profileId: string, itemId: string): void =>
    sql.transaction(() => {
      for (const t of targetsOf(itemId)) {
        setUnwatched.run(profileId, t);
        deleteProgress.run(profileId, t);
      }
    })();

  return {
    getStates,
    continueWatching,
    nextUp,
    lastPlayed,
    recordProgress,
    resumePositionMs,
    lastTrackChoice,
    markWatched,
    markUnwatched,
    clearProgress: (profileId: string, itemId: string): void => void deleteProgress.run(profileId, itemId),
    addToWatchlist(profileId: string, itemId: string): void {
      if (!catalog().itemExists(itemId)) throw notFound('item');
      addWatchlist.run(profileId, itemId, now());
    },
    removeFromWatchlist: (profileId: string, itemId: string): void => void removeWatchlist.run(profileId, itemId),
  };
}

export type WatchState = ReturnType<typeof createWatchState>;
