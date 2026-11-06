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
    `INSERT INTO viewing_record (id, profile_id, item_id, started_at, ended_at, max_position_ms, completed, file_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // The record follows the file of the latest sample until it completes; a completed one keeps the file it completed on.
  const updateViewing = sql.prepare(
    `UPDATE viewing_record SET ended_at = @endedAt, max_position_ms = @maxPositionMs,
       file_id = CASE WHEN completed = 1 THEN file_id ELSE @file END, completed = @completed WHERE id = @id`,
  );
  const addWatchlist = sql.prepare('INSERT OR IGNORE INTO watchlist_entry (profile_id, item_id, added_at) VALUES (?, ?, ?)');
  const removeWatchlist = sql.prepare('DELETE FROM watchlist_entry WHERE profile_id = ? AND item_id = ?');
  const watchlistEntriesOf = sql.prepare('SELECT profile_id AS profileId, added_at AS addedAt FROM watchlist_entry WHERE item_id = ? ORDER BY added_at, profile_id');
  const putWatchlist = sql.prepare('INSERT OR IGNORE INTO watchlist_entry (profile_id, item_id, added_at) VALUES (?, ?, ?)');
  const progressRowsOn = sql.prepare(
    `SELECT profile_id AS profileId, item_id AS itemId, position_ms AS positionMs, duration_ms AS durationMs, file_id AS fileId,
       audio_stream_index AS audio, subtitle_track_id AS sub, client_ts AS clientTs, updated_at AS updatedAt
     FROM playback_progress WHERE item_id = ?`,
  );
  const watchRowsOn = sql.prepare('SELECT profile_id AS profileId, watched, watched_at AS watchedAt, play_count AS playCount FROM watch_state WHERE item_id = ?');
  const deleteWatch = sql.prepare('DELETE FROM watch_state WHERE profile_id = ? AND item_id = ?');
  const moveViewingsOf = sql.prepare('UPDATE viewing_record SET item_id = ? WHERE item_id = ?');
  const progressFileTo = sql.prepare('UPDATE playback_progress SET file_id = ? WHERE file_id = ?');
  const viewingFileTo = sql.prepare('UPDATE viewing_record SET file_id = ? WHERE file_id = ?');

  const progressOnFile = sql.prepare(
    `SELECT profile_id AS profileId, item_id AS itemId, position_ms AS positionMs, duration_ms AS durationMs, file_id AS fileId,
       audio_stream_index AS audio, subtitle_track_id AS sub, client_ts AS clientTs, updated_at AS updatedAt
     FROM playback_progress WHERE file_id = @file AND item_id ${IN} ORDER BY client_ts DESC, item_id`,
  );
  const progressRowOf = sql.prepare('SELECT client_ts AS clientTs FROM playback_progress WHERE profile_id = ? AND item_id = ?');
  const watchedAtOf = sql.prepare('SELECT watched, watched_at AS watchedAt FROM watch_state WHERE profile_id = ? AND item_id = ?');
  const viewingsOnFile = sql.prepare(
    `SELECT id, profile_id AS profileId, item_id AS itemId, started_at AS startedAt, ended_at AS endedAt, completed
     FROM viewing_record WHERE file_id = @file AND item_id ${IN}`,
  );
  const moveViewing = sql.prepare('UPDATE viewing_record SET item_id = ? WHERE id = ?');
  const completionsOf = sql.prepare(
    `SELECT count(*) AS n, max(coalesce(ended_at, started_at)) AS lastAt FROM viewing_record
     WHERE profile_id = ? AND item_id = ? AND completed = 1`,
  );
  const watchRowOf = sql.prepare('SELECT watched, watched_at AS watchedAt, play_count AS playCount FROM watch_state WHERE profile_id = ? AND item_id = ?');
  const putWatch = sql.prepare(
    `INSERT INTO watch_state (profile_id, item_id, watched, watched_at, play_count) VALUES (@p, @item, @watched, @at, @plays)
     ON CONFLICT (profile_id, item_id) DO UPDATE SET watched = excluded.watched, watched_at = excluded.watched_at, play_count = excluded.play_count`,
  );
  const putProgress = sql.prepare(
    `INSERT OR REPLACE INTO playback_progress (profile_id, item_id, position_ms, duration_ms, file_id, audio_stream_index, subtitle_track_id, client_ts, updated_at)
     VALUES (@profileId, @itemId, @positionMs, @durationMs, @fileId, @audio, @sub, @clientTs, @updatedAt)`,
  );

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
    updateViewing.run({
      endedAt: Math.max(v.endedAt ?? v.startedAt, s.at),
      maxPositionMs: Math.max(v.maxPositionMs, s.positionMs),
      file: s.fileId,
      completed: completed || v.completed === 1 ? 1 : 0,
      id: v.id,
    });

  /** History: a sample extends the latest open, unfinished viewing of the item, or starts a new one. */
  function recordViewing(s: ProgressSample, completed: boolean): void {
    const v = openViewing(s);
    if (v && v.completed === 0) extendViewing(v, s, completed);
    else insertViewing.run(newId(), s.profileId, s.itemId, s.at, s.at, s.positionMs, completed ? 1 : 0, s.fileId);
  }

  const recordProgress = (sample: ProgressSample): void =>
    sql.transaction(() => {
      // The profile may have been deleted while a session was open.
      if (!profileExists(sample.profileId)) return;
      let s = sample;
      let kind = kinds([s.itemId]).get(s.itemId)?.kind;
      // A provisional item retired mid-session: the sample goes to the item that took its place for this file
      // (replacementFor). Playback sessions follow their file already; this covers a sample sent with the old id.
      const moved = kind ? null : catalog().replacementFor(s.itemId, s.fileId);
      if (moved) {
        s = { ...s, itemId: moved };
        kind = kinds([moved]).get(moved)?.kind;
      }
      // Never a foreign-key error: an item removed from the catalog mid-session is skipped. Progress
      // belongs to playable items, never to a series or season.
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

  /**
   * The file left fromItemIds for toItemId (admin resolution). What was recorded on that file follows it:
   * - progress: per profile the latest row by client_ts; a row toItemId already has wins if it is as
   *   recent, and a toItemId watched at or after the sample takes none (the recordProgress rules);
   * - history: viewing records with that file_id (rows from before migration 0003 have none and stay);
   * - watched: each moved completion is a play of toItemId, merged last-write-wins (latest watched_at,
   *   plays added, older progress cleared). An old item keeps "watched" only if a completion stays on it
   *   or a manual mark (no file) shows: watched_at set by none of the moved completions, or a play count
   *   above its completion records (a mark counts one play).
   * Returns the progress and viewing rows moved.
   */
  const moveFileState = (fileId: string, fromItemIds: readonly string[], toItemId: string): number =>
    sql.transaction(() => {
      const from = fromItemIds.filter((id) => id !== toItemId);
      if (!from.length) return 0;
      const kind = kinds([toItemId]).get(toItemId)?.kind;
      // State belongs to playable items: a series or season (or an unknown id) takes none.
      if (!kind || CONTAINER_KINDS.has(kind)) return 0;
      let moved = 0;

      type Row = { profileId: string; itemId: string; clientTs: number } & Record<string, unknown>;
      const done = new Set<string>();
      for (const r of progressOnFile.all({ file: fileId, ids: ids(from) }) as Row[]) {
        deleteProgress.run(r.profileId, r.itemId);
        // Rows come newest first: the first one of each profile is the candidate.
        if (done.has(r.profileId)) continue;
        done.add(r.profileId);
        const target = progressRowOf.get(r.profileId, toItemId) as { clientTs: number } | undefined;
        if (target && target.clientTs >= r.clientTs) continue;
        const w = watchedAtOf.get(r.profileId, toItemId) as { watched: number; watchedAt: number | null } | undefined;
        if (!target && w?.watched === 1 && w.watchedAt !== null && r.clientTs <= w.watchedAt) continue;
        putProgress.run({ ...r, itemId: toItemId });
        moved++;
      }

      type Viewing = { id: string; profileId: string; itemId: string; startedAt: number; endedAt: number | null; completed: number };
      type Watch = { watched: number; watchedAt: number | null; playCount: number };
      // Completions moved, per profile and old item, to settle both sides' watched state afterwards.
      const completions = new Map<string, Map<string, Viewing[]>>();
      for (const v of viewingsOnFile.all({ file: fileId, ids: ids(from) }) as Viewing[]) {
        moveViewing.run(toItemId, v.id);
        moved++;
        if (v.completed !== 1) continue;
        const byItem = completions.get(v.profileId) ?? new Map<string, Viewing[]>();
        completions.set(v.profileId, byItem);
        byItem.set(v.itemId, [...(byItem.get(v.itemId) ?? []), v]);
      }
      for (const [profileId, byItem] of completions) {
        let plays = 0;
        let at = -Infinity;
        for (const [itemId, list] of byItem) {
          const w = watchRowOf.get(profileId, itemId) as Watch | undefined;
          const watchedAt = w?.watchedAt ?? null;
          // A completion record spans the moment it set watched_at; otherwise its end stands for it.
          const explains = (v: Viewing) => watchedAt !== null && v.startedAt <= watchedAt && watchedAt <= (v.endedAt ?? v.startedAt);
          for (const v of list) at = Math.max(at, explains(v) && watchedAt !== null ? watchedAt : (v.endedAt ?? v.startedAt));
          plays += list.length;
          if (!w) continue;
          const left = completionsOf.get(profileId, itemId) as { n: number; lastAt: number | null };
          // A manual mark: watched_at set by none of the moved completions, or a play no record accounts for.
          const manual = w.watched === 1 && (!list.some(explains) || w.playCount > left.n + list.length);
          const still = w.watched === 1 && (manual || left.lastAt !== null);
          // The date changes only when a moved completion had set it; a manual mark keeps its own date.
          const keptAt = list.some(explains) ? (left.lastAt ?? watchedAt) : watchedAt;
          putWatch.run({ p: profileId, item: itemId, watched: still ? 1 : 0, at: still ? keptAt : null, plays: Math.max(0, w.playCount - list.length) });
        }
        const b = watchRowOf.get(profileId, toItemId) as Watch | undefined;
        const bAt = b?.watched === 1 && b.watchedAt !== null ? Math.max(b.watchedAt, at) : at;
        putWatch.run({ p: profileId, item: toItemId, watched: 1, at: bAt, plays: (b?.playCount ?? 0) + plays });
        // A completion clears older progress, as in recordProgress.
        const p = progressRowOf.get(profileId, toItemId) as { clientTs: number } | undefined;
        if (p && p.clientTs <= at) deleteProgress.run(profileId, toItemId);
      }
      return moved;
    })();

  /**
   * fromItemId is about to be removed and toItemId took its place (a provisional item replaced by the
   * identified one, doc 02 §3.5). Called after moveFileState: what is left on fromItemId belongs to no
   * moved file. It moves to toItemId, per profile:
   * - the watchlist entry, with the date it was added; an entry already on toItemId is kept as it is. The
   *   watchlist holds films, series and extras (doc 01): an episode or season passes it to its series;
   * - for playable items only (a series or season has no state of its own):
   *   - progress, as in moveFileState: toItemId's row wins if it is as recent, and a toItemId watched at
   *     or after it takes none;
   *   - history: every viewing record left;
   *   - watched, merged last-write-wins: watched if either is, the latest watched_at, the plays added;
   *     a toItemId progress older than the merged watched_at goes, as a completion clears it.
   * Returns the rows moved.
   */
  /** The item a watchlist entry for itemId goes to: itself, or the series of an episode or season. */
  function listableItem(itemId: string): string | null {
    let current: string | null = itemId;
    for (let depth = 0; current !== null && depth < 3; depth++) {
      const d = kinds([current]).get(current);
      if (!d) return null;
      if (d.kind !== 'season' && d.kind !== 'episode') return current;
      current = d.parentId;
    }
    return null;
  }

  /** ProfileStatePort.replaceFileId: the library merged the file into another row with its content. */
  const replaceFileId = (fromFileId: string, toFileId: string): number =>
    sql.transaction(() => (fromFileId === toFileId ? 0 : progressFileTo.run(toFileId, fromFileId).changes + viewingFileTo.run(toFileId, fromFileId).changes))();

  const moveItemState = (fromItemId: string, toItemId: string): number =>
    sql.transaction(() => {
      if (fromItemId === toItemId || !catalog().itemExists(toItemId)) return 0;
      let moved = 0;
      const listed = listableItem(toItemId);
      for (const e of watchlistEntriesOf.all(fromItemId) as { profileId: string; addedAt: number }[]) {
        if (listed) moved += putWatchlist.run(e.profileId, listed, e.addedAt).changes;
        removeWatchlist.run(e.profileId, fromItemId);
      }
      const k = kinds([fromItemId, toItemId]);
      const playable = (id: string) => {
        const kind = k.get(id)?.kind;
        return kind !== undefined && !CONTAINER_KINDS.has(kind);
      };
      if (!playable(fromItemId) || !playable(toItemId)) return moved;

      type Row = { profileId: string; clientTs: number } & Record<string, unknown>;
      type Watch = { profileId: string; watched: number; watchedAt: number | null; playCount: number };
      for (const r of progressRowsOn.all(fromItemId) as Row[]) {
        deleteProgress.run(r.profileId, fromItemId);
        const target = progressRowOf.get(r.profileId, toItemId) as { clientTs: number } | undefined;
        if (target && target.clientTs >= r.clientTs) continue;
        const w = watchedAtOf.get(r.profileId, toItemId) as { watched: number; watchedAt: number | null } | undefined;
        if (!target && w?.watched === 1 && w.watchedAt !== null && r.clientTs <= w.watchedAt) continue;
        putProgress.run({ ...r, itemId: toItemId });
        moved++;
      }
      moved += moveViewingsOf.run(toItemId, fromItemId).changes;
      for (const a of watchRowsOn.all(fromItemId) as Watch[]) {
        deleteWatch.run(a.profileId, fromItemId);
        const b = watchRowOf.get(a.profileId, toItemId) as Omit<Watch, 'profileId'> | undefined;
        const times = [a, b].filter((w) => w?.watched === 1 && w.watchedAt !== null).map((w) => w!.watchedAt!);
        const watched = a.watched === 1 || b?.watched === 1;
        const at = times.length ? Math.max(...times) : null;
        putWatch.run({ p: a.profileId, item: toItemId, watched: watched ? 1 : 0, at: watched ? at : null, plays: (b?.playCount ?? 0) + a.playCount });
        moved++;
        const p = progressRowOf.get(a.profileId, toItemId) as { clientTs: number } | undefined;
        if (watched && at !== null && p && p.clientTs <= at) deleteProgress.run(a.profileId, toItemId);
      }
      return moved;
    })();

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
    moveFileState,
    moveItemState,
    replaceFileId,
    clearProgress: (profileId: string, itemId: string): void => void deleteProgress.run(profileId, itemId),
    addToWatchlist(profileId: string, itemId: string): void {
      if (!catalog().itemExists(itemId)) throw notFound('item');
      addWatchlist.run(profileId, itemId, now());
    },
    removeFromWatchlist: (profileId: string, itemId: string): void => void removeWatchlist.run(profileId, itemId),
  };
}

export type WatchState = ReturnType<typeof createWatchState>;
