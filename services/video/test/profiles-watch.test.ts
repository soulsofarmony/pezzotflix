// Profiles and watch state on SQLite: prefs, progress samples (stale, idempotent, completion),
// history, resume, Continue watching, next up, watched propagation, watchlist, deletion.
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { RESUME_MIN_POSITION_MS } from '../src/modules/profiles/rules.ts';
import { createProfileStore, type ProfileStore } from '../src/modules/profiles/store.ts';
import { createWatchState, type WatchState } from '../src/modules/profiles/watch.ts';
import type { ProgressSample } from '../src/shared/ports.ts';
import { type FakeCatalog, fakeCatalogRead, type Seed, seedCatalog } from './profiles-fixtures.ts';

const MOVIE_MS = 7_200_000;
let db: Db;
let clock: number;
let store: ProfileStore;
let watch: WatchState;
let catalog: FakeCatalog;
let seed: Seed;
let pid: string;

beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
  clock = 1_000_000;
  store = createProfileStore({ db, now: () => clock });
  catalog = fakeCatalogRead(db);
  watch = createWatchState({ db, now: () => clock, catalog: () => catalog, profileExists: store.exists, log: pino({ level: 'silent' }) });
  seed = seedCatalog(db);
  pid = store.create({ name: 'Simone' }).id;
});
afterEach(() => closeDb(db));

const sample = (itemId: string, positionMs: number, at: number, over: Partial<ProgressSample> = {}): ProgressSample => ({
  profileId: pid,
  itemId,
  fileId: `f-${itemId}`,
  positionMs,
  durationMs: MOVIE_MS,
  at,
  ended: false,
  ...over,
});
const state = (itemId: string, profileId = pid) => watch.getStates(profileId, [itemId]).get(itemId)!;
const history = (itemId: string) =>
  db.$client
    .prepare('SELECT started_at AS startedAt, ended_at AS endedAt, max_position_ms AS maxPositionMs, completed FROM viewing_record WHERE item_id = ? ORDER BY started_at')
    .all(itemId);
const count = (table: string) => (db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('profiles', () => {
  it('creates a profile with the default prefs', () => {
    expect(store.get(pid)).toEqual({
      id: pid,
      name: 'Simone',
      avatar: null,
      prefs: { audioLanguages: ['ita', 'eng'], subtitleLanguages: ['ita'], subtitleMode: 'forced' },
    });
  });

  it('normalises languages and rejects unknown ones', () => {
    const p = store.create({ name: 'Anna', prefs: { audioLanguages: ['en', 'ITA', 'eng'], subtitleLanguages: ['it-IT'], subtitleMode: 'always' } });
    expect(p.prefs).toEqual({ audioLanguages: ['eng', 'ita'], subtitleLanguages: ['ita'], subtitleMode: 'always' });
    expect(() => store.create({ name: 'Bad', prefs: { audioLanguages: ['klingonese'], subtitleLanguages: [], subtitleMode: 'off' } })).toThrow(/unknown language/);
  });

  it('compares names case-insensitively beyond ASCII', () => {
    store.create({ name: 'Élodie' });
    expect(() => store.create({ name: 'élodie' })).toThrow(/already exists/);
    expect(() => store.create({ name: 'ÉLODIE' })).toThrow(/already exists/);
  });

  it('rejects a duplicate or blank name', () => {
    expect(() => store.create({ name: ' simone ' })).toThrow(/already exists/);
    expect(() => store.create({ name: '   ' })).toThrow(/blank/);
    const other = store.create({ name: 'Anna' });
    expect(() => store.update(other.id, { name: 'SIMONE' })).toThrow(/already exists/);
    expect(store.update(pid, { name: 'simone' }).name).toBe('simone'); // renaming itself is fine
  });

  it('update keeps fields left out', () => {
    store.update(pid, { name: 'S', avatar: 'cat' });
    const p = store.update(pid, { name: 'S2' });
    expect(p).toMatchObject({ name: 'S2', avatar: 'cat', prefs: { subtitleMode: 'forced' } });
    expect(store.update(pid, { name: 'S3', avatar: null }).avatar).toBeNull();
  });

  it('deleting a profile removes its state and nobody else\'s', () => {
    const m = seed.item('m1');
    const other = store.create({ name: 'Anna' }).id;
    watch.recordProgress(sample(m, 600_000, 10));
    watch.recordProgress({ ...sample(m, 600_000, 10), profileId: other });
    watch.markWatched(pid, seed.item('m2'));
    watch.addToWatchlist(pid, m);
    store.remove(pid);
    expect(store.get(pid)).toBeNull();
    for (const t of ['playback_progress', 'viewing_record']) {
      expect(db.$client.prepare(`SELECT DISTINCT profile_id AS p FROM ${t}`).all()).toEqual([{ p: other }]);
    }
    expect(count('watch_state')).toBe(0);
    expect(count('watchlist_entry')).toBe(0);
    expect(() => store.remove(pid)).toThrow(/not found/);
  });

  it('deletion is one transaction: a failure leaves everything in place', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 10));
    db.$client.exec(`CREATE TRIGGER no_delete BEFORE DELETE ON profile BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => store.remove(pid)).toThrow(/boom/);
    expect(count('playback_progress')).toBe(1);
    expect(count('viewing_record')).toBe(1);
  });
});

describe('recordProgress', () => {
  it('stores progress and a history row', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 10));
    expect(state(m)).toEqual({ watched: false, progressPercent: 8.3, resumePositionMs: 600_000, inWatchlist: false, playCount: 0 });
    expect(history(m)).toEqual([{ startedAt: 10, endedAt: 10, maxPositionMs: 600_000, completed: 0 }]);
  });

  it('is idempotent and ignores a stale sample', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 20));
    watch.recordProgress(sample(m, 600_000, 20));
    watch.recordProgress(sample(m, 300_000, 15)); // older
    expect(watch.resumePositionMs(pid, m)).toBe(600_000);
    expect(history(m)).toEqual([{ startedAt: 20, endedAt: 20, maxPositionMs: 600_000, completed: 0 }]);
  });

  it('a seek back with a newer sample wins', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 20));
    watch.recordProgress(sample(m, 120_000, 30));
    expect(watch.resumePositionMs(pid, m)).toBe(120_000);
    expect(history(m)).toEqual([{ startedAt: 20, endedAt: 30, maxPositionMs: 600_000, completed: 0 }]);
  });

  it('extends one viewing within the gap, starts another after it', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 60_000, 0));
    watch.recordProgress(sample(m, 120_000, 29 * 60_000));
    watch.recordProgress(sample(m, 180_000, 29 * 60_000 + 31 * 60_000));
    expect(history(m)).toHaveLength(2);
  });

  it.each([
    ['at 90 %', { positionMs: MOVIE_MS * 0.9 }],
    ['when ended', { positionMs: 1_000_000, ended: true }],
    ['when ended without a duration', { positionMs: 1_000_000, ended: true, durationMs: null }],
  ])('marks watched %s and clears the progress', (_n, over) => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 10));
    watch.recordProgress(sample(m, 0, 20, over));
    expect(state(m)).toMatchObject({ watched: true, progressPercent: 0, resumePositionMs: null, playCount: 1 });
    expect(count('playback_progress')).toBe(0);
    expect(history(m)).toEqual([{ startedAt: 10, endedAt: 20, maxPositionMs: over.positionMs, completed: 1 }]);
    expect(watch.continueWatching(pid, 10)).toEqual([]);
  });

  it('a repeated or stale sample after completion changes nothing', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, MOVIE_MS, 20, { ended: true }));
    watch.recordProgress(sample(m, MOVIE_MS, 20, { ended: true }));
    watch.recordProgress(sample(m, 600_000, 15));
    expect(state(m)).toMatchObject({ watched: true, playCount: 1, resumePositionMs: null });
    expect(count('playback_progress')).toBe(0);
    expect(history(m)).toHaveLength(1);
  });

  it('samples past the threshold until the end count one play and one viewing', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, MOVIE_MS * 0.5, 10));
    watch.recordProgress(sample(m, MOVIE_MS * 0.91, 20));
    watch.recordProgress(sample(m, MOVIE_MS * 0.95, 30));
    watch.recordProgress(sample(m, MOVIE_MS, 40, { ended: true }));
    expect(state(m)).toMatchObject({ watched: true, playCount: 1 });
    expect(history(m)).toEqual([{ startedAt: 10, endedAt: 40, maxPositionMs: MOVIE_MS, completed: 1 }]);
  });

  it('a completion after the gap is a new play', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, MOVIE_MS, 10, { ended: true }));
    const later = 10 + 31 * 60_000;
    watch.recordProgress(sample(m, MOVIE_MS, later, { ended: true }));
    expect(state(m).playCount).toBe(2);
    expect(history(m)).toHaveLength(2);
  });

  it('a rewatch counts again', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, MOVIE_MS, 20, { ended: true }));
    watch.recordProgress(sample(m, 3_600_000, 100));
    expect(state(m)).toMatchObject({ watched: true, resumePositionMs: 3_600_000 });
    watch.recordProgress(sample(m, MOVIE_MS, 200, { ended: true }));
    expect(state(m)).toMatchObject({ watched: true, playCount: 2 });
    expect(history(m)).toHaveLength(2);
  });

  it('keeps the known duration when a sample has none', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 10));
    watch.recordProgress(sample(m, MOVIE_MS * 0.95, 20, { durationMs: null }));
    expect(state(m).watched).toBe(true);
  });

  it('ignores, without a foreign-key error, a sample for an item not in the catalog', () => {
    expect(() => watch.recordProgress(sample('gone', 600_000, 10))).not.toThrow();
    expect(count('playback_progress') + count('viewing_record')).toBe(0);
  });

  it('ignores a sample for a series or season', () => {
    const sr = seed.series('dark', { 1: 1 });
    watch.recordProgress(sample(sr.seriesId, 600_000, 10));
    watch.recordProgress(sample(sr.seasonId(1), 600_000, 10));
    expect(count('playback_progress') + count('viewing_record')).toBe(0);
  });

  it('ignores samples of a deleted profile', () => {
    const m = seed.item('m1');
    store.remove(pid);
    expect(() => watch.recordProgress(sample(m, 600_000, 10))).not.toThrow();
    expect(count('viewing_record')).toBe(0);
  });
});

describe('lastTrackChoice', () => {
  it('stores the tracks of the progress; an absent track keeps the stored one', () => {
    const m = seed.item('m1');
    expect(watch.lastTrackChoice(pid, m)).toBeNull();
    watch.recordProgress(sample(m, 600_000, 10)); // tracks unknown
    expect(watch.lastTrackChoice(pid, m)).toBeNull();
    watch.recordProgress(sample(m, 610_000, 20, { audioTrackId: 's2', subtitleTrackId: 'x:ita-forced' }));
    expect(watch.lastTrackChoice(pid, m)).toEqual({ fileId: `f-${m}`, audioTrackId: 's2', subtitleTrackId: 'x:ita-forced' });
    watch.recordProgress(sample(m, 620_000, 30));
    expect(watch.lastTrackChoice(pid, m)).toEqual({ fileId: `f-${m}`, audioTrackId: 's2', subtitleTrackId: 'x:ita-forced' });
    watch.recordProgress(sample(m, 630_000, 40, { subtitleTrackId: null })); // subtitles turned off
    expect(watch.lastTrackChoice(pid, m)).toEqual({ fileId: `f-${m}`, audioTrackId: 's2', subtitleTrackId: null });
    watch.recordProgress(sample(m, 640_000, 50, { audioTrackId: 's1', subtitleTrackId: 's5' }));
    expect(watch.lastTrackChoice(pid, m)).toEqual({ fileId: `f-${m}`, audioTrackId: 's1', subtitleTrackId: 's5' });
    const row = db.$client.prepare('SELECT audio_stream_index AS a, subtitle_track_id AS s FROM playback_progress').get();
    expect(row).toEqual({ a: 1, s: 's5' });
  });

  it('carries the file of the latest sample (track ids are file-local)', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 10, { audioTrackId: 's1', subtitleTrackId: null }));
    watch.recordProgress(sample(m, 610_000, 20, { fileId: 'f-other', audioTrackId: 's2', subtitleTrackId: 's3' }));
    expect(watch.lastTrackChoice(pid, m)).toEqual({ fileId: 'f-other', audioTrackId: 's2', subtitleTrackId: 's3' });
  });

  it('an unknown subtitle choice is absent, never read as off (E-1)', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 10, { audioTrackId: 's2' }));
    const choice = watch.lastTrackChoice(pid, m);
    expect(choice).toEqual({ fileId: `f-${m}`, audioTrackId: 's2' });
    expect(choice).not.toHaveProperty('subtitleTrackId');
  });

  it('never carries one file’s tracks under another file (E-2)', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 10, { audioTrackId: 's1', subtitleTrackId: 's5' }));
    watch.recordProgress(sample(m, 610_000, 20, { fileId: 'f-other', audioTrackId: 's2' })); // subtitle unknown on f-other
    expect(watch.lastTrackChoice(pid, m)).toEqual({ fileId: 'f-other', audioTrackId: 's2' });
    watch.recordProgress(sample(m, 620_000, 30, { fileId: 'f-other' })); // same file: the stored tracks stay
    expect(watch.lastTrackChoice(pid, m)).toEqual({ fileId: 'f-other', audioTrackId: 's2' });
    watch.recordProgress(sample(m, 630_000, 40, { subtitleTrackId: null })); // back on the first file: audio unknown
    expect(watch.lastTrackChoice(pid, m)).toEqual({ fileId: `f-${m}`, audioTrackId: null, subtitleTrackId: null });
    watch.recordProgress(sample(m, 640_000, 50, { fileId: 'f-third' })); // nothing known on a third file
    expect(watch.lastTrackChoice(pid, m)).toBeNull();
  });

  it('subtitles off alone is a choice', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 600_000, 10, { subtitleTrackId: null }));
    expect(watch.lastTrackChoice(pid, m)).toEqual({ fileId: `f-${m}`, audioTrackId: null, subtitleTrackId: null });
  });

  it('goes with the progress on completion and is per profile', () => {
    const m = seed.item('m1');
    const other = store.create({ name: 'Anna' }).id;
    watch.recordProgress(sample(m, 600_000, 10, { audioTrackId: 's1' }));
    expect(watch.lastTrackChoice(other, m)).toBeNull();
    watch.recordProgress(sample(m, MOVIE_MS, 20, { ended: true }));
    expect(watch.lastTrackChoice(pid, m)).toBeNull();
  });
});

describe('resume and Continue watching', () => {
  it.each([
    ['not started', null, null],
    ['under the minimum', RESUME_MIN_POSITION_MS - 1, null],
    ['at the minimum', RESUME_MIN_POSITION_MS, RESUME_MIN_POSITION_MS],
    ['midway', 3_600_000, 3_600_000],
  ] as const)('resumePositionMs: %s', (_n, pos, out) => {
    const m = seed.item('m1');
    if (pos !== null) watch.recordProgress(sample(m, pos, 10));
    expect(watch.resumePositionMs(pid, m)).toBe(out);
  });

  it('is null once watched', () => {
    const m = seed.item('m1');
    watch.recordProgress(sample(m, 3_600_000, 10));
    watch.markWatched(pid, m);
    expect(watch.resumePositionMs(pid, m)).toBeNull();
  });

  it('lists items in progress, most recent first, up to the limit', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => seed.item(id));
    clock = 1;
    watch.recordProgress(sample(a!, 600_000, 1));
    clock = 2;
    watch.recordProgress(sample(b!, 600_000, 2));
    clock = 3;
    watch.recordProgress(sample(c!, 0, 3)); // started, at 0: not in progress
    clock = 4;
    watch.recordProgress(sample(d!, MOVIE_MS * 0.02 - 1, 4)); // under 2 % (D3): not listed, yet resumable
    expect(watch.resumePositionMs(pid, d!)).toBe(MOVIE_MS * 0.02 - 1);
    clock = 5;
    watch.recordProgress(sample(c!, MOVIE_MS * 0.02, 5)); // at 2 %: listed
    expect(watch.continueWatching(pid, 10)).toEqual([c, b, a]);
    expect(watch.continueWatching(pid, 2)).toEqual([c, b]);
    watch.clearProgress(pid, b!);
    expect(watch.continueWatching(pid, 10)).toEqual([c, a]);
  });

  it('is per profile', () => {
    const m = seed.item('m1');
    const other = store.create({ name: 'Anna' }).id;
    watch.recordProgress(sample(m, 600_000, 1));
    expect(watch.continueWatching(other, 10)).toEqual([]);
    expect(state(m, other)).toMatchObject({ progressPercent: 0, resumePositionMs: null });
  });

  it('lastPlayed covers progress, history and series through their episodes', () => {
    const m = seed.item('m1');
    const s = seed.series('dark', { 1: 2 });
    seed.item('never');
    watch.recordProgress(sample(m, MOVIE_MS, 50, { ended: true }));
    watch.recordProgress(sample(s.ep(1, 1), 600_000, 70));
    expect(watch.lastPlayed(pid, [m, s.seriesId, s.seasonId(1), 'never'])).toEqual(
      new Map([
        [m, 50],
        [s.seriesId, 70],
        [s.seasonId(1), 70],
      ]),
    );
  });
});

describe('watched propagation and derived series state', () => {
  it('marks every episode of a series, and the series is watched', () => {
    const s = seed.series('dark', { 0: 1, 1: 2, 2: 1 });
    watch.recordProgress(sample(s.ep(1, 2), 600_000, 10));
    watch.markWatched(pid, s.seriesId);
    const st = watch.getStates(pid, [s.seriesId, s.seasonId(1), s.ep(1, 2)]);
    expect(st.get(s.seriesId)).toEqual({ watched: true, progressPercent: 100, resumePositionMs: null, inWatchlist: false });
    expect(st.get(s.seasonId(1))?.watched).toBe(true);
    expect(st.get(s.ep(1, 2))).toMatchObject({ watched: true, resumePositionMs: null, playCount: 1 });
    expect(count('playback_progress')).toBe(0);
  });

  it('a season only marks its own episodes; the series shows partial progress', () => {
    const s = seed.series('dark', { 1: 2, 2: 2 });
    watch.markWatched(pid, s.seasonId(1));
    const st = watch.getStates(pid, [s.seriesId, s.seasonId(1), s.seasonId(2)]);
    expect(st.get(s.seriesId)).toMatchObject({ watched: false, progressPercent: 50 });
    expect(st.get(s.seasonId(1))).toMatchObject({ watched: true, progressPercent: 100 });
    expect(st.get(s.seasonId(2))).toMatchObject({ watched: false, progressPercent: 0 });
  });

  it('a manual mark never counts beyond one play', () => {
    const m = seed.item('m1');
    watch.markWatched(pid, m);
    expect(state(m).playCount).toBe(1);
    watch.markUnwatched(pid, m);
    watch.markWatched(pid, m);
    expect(state(m).playCount).toBe(1);
    watch.recordProgress(sample(m, 600_000, 2_000_000));
    watch.recordProgress(sample(m, MOVIE_MS, 2_000_100, { ended: true }));
    expect(state(m).playCount).toBe(2);
    watch.markUnwatched(pid, m);
    watch.markWatched(pid, m);
    expect(state(m).playCount).toBe(2);
  });

  it('markWatched is idempotent: date and play count stay', () => {
    const s = seed.series('dark', { 1: 2 });
    clock = 100;
    watch.markWatched(pid, s.ep(1, 1));
    clock = 200;
    watch.markWatched(pid, s.seriesId);
    const rows = db.$client.prepare('SELECT item_id AS id, watched_at AS at, play_count AS n FROM watch_state ORDER BY item_id').all();
    expect(rows).toEqual([
      { id: s.ep(1, 1), at: 100, n: 1 },
      { id: s.ep(1, 2), at: 200, n: 1 },
    ]);
  });

  it('markUnwatched propagates and resets progress, keeping history', () => {
    const s = seed.series('dark', { 1: 2 });
    watch.recordProgress(sample(s.ep(1, 1), MOVIE_MS, 10, { ended: true }));
    watch.recordProgress(sample(s.ep(1, 2), 600_000, 20));
    watch.markUnwatched(pid, s.seriesId);
    expect(state(s.seriesId)).toMatchObject({ watched: false, progressPercent: 0 });
    expect(state(s.ep(1, 1))).toMatchObject({ watched: false, playCount: 1 });
    expect(watch.continueWatching(pid, 10)).toEqual([]);
    expect(count('viewing_record')).toBe(2);
  });

  it('unknown items are not found; a series without episodes is a no-op', () => {
    expect(() => watch.markWatched(pid, 'nope')).toThrow(/not found/);
    expect(() => watch.markUnwatched(pid, 'nope')).toThrow(/not found/);
    expect(() => watch.addToWatchlist(pid, 'nope')).toThrow(/not found/);
    const s = seed.series('empty', {});
    watch.markWatched(pid, s.seriesId);
    expect(count('watch_state')).toBe(0);
    expect(state(s.seriesId)).toMatchObject({ watched: false });
  });
});

describe('nextUp', () => {
  it('first regular episode when nothing is watched, specials last', () => {
    const s = seed.series('dark', { 0: 2, 1: 2 });
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(1, 1));
  });

  it('follows season and episode order across seasons, then specials', () => {
    const s = seed.series('dark', { 0: 1, 1: 2, 2: 1 });
    watch.markWatched(pid, s.ep(1, 1));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(1, 2));
    clock += 1;
    watch.markWatched(pid, s.ep(1, 2));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(2, 1));
    clock += 1;
    watch.markWatched(pid, s.ep(2, 1));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(0, 1));
    clock += 1;
    watch.markWatched(pid, s.ep(0, 1));
    expect(watch.nextUp(pid, s.seriesId)).toBeNull();
  });

  it('a special watched after a regular episode does not end the series', () => {
    const s = seed.series('dark', { 0: 2, 1: 3 });
    watch.markWatched(pid, s.ep(1, 1));
    clock += 10;
    watch.recordProgress(sample(s.ep(0, 1), 3_000_000, clock, { durationMs: 3_000_000, ended: true }));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(1, 2));
  });

  it('a re-watched finale falls back to the first gap', () => {
    const s = seed.series('dark', { 1: 4 });
    watch.markWatched(pid, s.ep(1, 1));
    watch.markWatched(pid, s.ep(1, 3));
    clock += 10;
    watch.markWatched(pid, s.ep(1, 4));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(1, 2));
  });

  it('a series of only specials is watched in its own order', () => {
    const s = seed.series('specials', { 0: 3 });
    watch.markWatched(pid, s.ep(0, 1));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(0, 2));
  });

  it('an in-progress episode is next; the latest activity is the anchor', () => {
    const s = seed.series('dark', { 1: 4 });
    clock = 10;
    watch.markWatched(pid, s.ep(1, 3));
    watch.recordProgress(sample(s.ep(1, 1), 600_000, 20, { durationMs: 3_000_000 }));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(1, 1));
    watch.recordProgress(sample(s.ep(1, 1), 3_000_000, 30, { durationMs: 3_000_000, ended: true }));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(1, 2));
  });

  it('a whole season marked at once anchors on its last episode', () => {
    const s = seed.series('dark', { 1: 3, 2: 2 });
    watch.markWatched(pid, s.seasonId(1));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(2, 1));
  });

  it('skips episodes without media', () => {
    const s = seed.series('dark', { 1: 3 });
    watch.markWatched(pid, s.ep(1, 1));
    catalog.noMedia.add(s.ep(1, 2));
    expect(watch.nextUp(pid, s.seriesId)).toBe(s.ep(1, 3));
  });

  it('null for a movie or an unknown id', () => {
    expect(watch.nextUp(pid, seed.item('m1'))).toBeNull();
    expect(watch.nextUp(pid, 'nope')).toBeNull();
  });
});

describe('watchlist', () => {
  it('adds and removes idempotently', () => {
    const m = seed.item('m1');
    watch.addToWatchlist(pid, m);
    watch.addToWatchlist(pid, m);
    expect(state(m).inWatchlist).toBe(true);
    expect(count('watchlist_entry')).toBe(1);
    watch.removeFromWatchlist(pid, m);
    watch.removeFromWatchlist(pid, m);
    expect(state(m).inWatchlist).toBe(false);
  });

  it('a series can be in the watchlist', () => {
    const s = seed.series('dark', { 1: 1 });
    watch.addToWatchlist(pid, s.seriesId);
    expect(state(s.seriesId).inWatchlist).toBe(true);
  });
});

describe('moveFileState (a file re-linked by the admin)', () => {
  const HOUR = 3_600_000;
  const progress = (itemId: string, profileId = pid) =>
    db.$client
      .prepare(
        `SELECT position_ms AS pos, file_id AS file, audio_stream_index AS audio, subtitle_track_id AS sub, client_ts AS ts, updated_at AS upd
         FROM playback_progress WHERE profile_id = ? AND item_id = ?`,
      )
      .get(profileId, itemId);
  const watchRow = (itemId: string, profileId = pid) =>
    db.$client.prepare('SELECT watched, watched_at AS at, play_count AS plays FROM watch_state WHERE profile_id = ? AND item_id = ?').get(profileId, itemId);
  const viewings = (itemId: string) =>
    db.$client.prepare('SELECT file_id AS file, completed FROM viewing_record WHERE item_id = ? ORDER BY started_at').all(itemId);
  const complete = (itemId: string, fileId: string, at: number, profileId = pid) =>
    watch.recordProgress(sample(itemId, MOVIE_MS, at, { fileId, ended: true, profileId }));

  it('records the file on every viewing, following the latest sample until it completes', () => {
    seed.item('a');
    watch.recordProgress(sample('a', 600_000, 100, { fileId: 'F' }));
    watch.recordProgress(sample('a', 700_000, 200, { fileId: 'G' })); // version changed mid-viewing
    expect(viewings('a')).toEqual([{ file: 'G', completed: 0 }]);
    complete('a', 'G', 300);
    watch.recordProgress(sample('a', MOVIE_MS, 400, { fileId: 'H', ended: true })); // credits after completion
    expect(viewings('a')).toEqual([{ file: 'G', completed: 1 }]);
  });

  it('moves progress (with its tracks) and history on that file; a manual mark stays on the old item', () => {
    seed.item('a');
    seed.item('b');
    clock = 5_000;
    watch.recordProgress(sample('a', 600_000, 100, { fileId: 'F', audioTrackId: 's2', subtitleTrackId: null }));
    db.$client.prepare("INSERT INTO watch_state (profile_id, item_id, watched, watched_at, play_count) VALUES (?, 'a', 1, 50, 1)").run(pid);
    clock = 9_000;

    expect(watch.moveFileState('F', ['a'], 'b')).toBe(2); // one progress row, one viewing record
    expect(progress('a')).toBeUndefined();
    expect(progress('b')).toEqual({ pos: 600_000, file: 'F', audio: 2, sub: 'off', ts: 100, upd: 5_000 });
    expect(state('b')).toMatchObject({ watched: false, resumePositionMs: 600_000 });
    expect(watch.lastTrackChoice(pid, 'b')).toEqual({ fileId: 'F', audioTrackId: 's2', subtitleTrackId: null });
    expect(viewings('a')).toEqual([]);
    expect(viewings('b')).toEqual([{ file: 'F', completed: 0 }]);
    expect(watchRow('a')).toEqual({ watched: 1, at: 50, plays: 1 });
  });

  it('leaves what was recorded on another file of the old item', () => {
    seed.item('a');
    seed.item('b');
    watch.recordProgress(sample('a', 600_000, 100, { fileId: 'OTHER' }));
    expect(watch.moveFileState('F', ['a'], 'b')).toBe(0);
    expect(progress('a')).toMatchObject({ file: 'OTHER' });
    expect(viewings('a')).toEqual([{ file: 'OTHER', completed: 0 }]);
    expect(progress('b')).toBeUndefined();
  });

  it.each([
    ['the target has a newer progress: it stays', 300, 'target'],
    ['the target has the same timestamp: it stays', 200, 'target'],
    ['the target has an older progress: the moved one wins', 100, 'moved'],
  ] as const)('progress, last write wins: %s', (_name, targetTs, winner) => {
    seed.item('a');
    seed.item('b');
    watch.recordProgress(sample('a', 600_000, 200, { fileId: 'F' }));
    watch.recordProgress(sample('b', 900_000, targetTs, { fileId: 'G' }));
    expect(watch.moveFileState('F', ['a'], 'b')).toBe(winner === 'moved' ? 2 : 1);
    expect(progress('a')).toBeUndefined();
    expect(progress('b')).toMatchObject(winner === 'moved' ? { pos: 600_000, file: 'F', ts: 200 } : { pos: 900_000, file: 'G', ts: targetTs });
  });

  it('a target watched after the progress sample takes no progress; one watched before does', () => {
    seed.item('a');
    seed.item('b');
    watch.recordProgress(sample('a', 600_000, 200, { fileId: 'F' }));
    db.$client.prepare("INSERT INTO watch_state (profile_id, item_id, watched, watched_at, play_count) VALUES (?, 'b', 1, 200, 1)").run(pid);
    watch.moveFileState('F', ['a'], 'b');
    expect(progress('a')).toBeUndefined();
    expect(progress('b')).toBeUndefined();

    watch.recordProgress(sample('a', 600_000, 300, { fileId: 'F' }));
    watch.moveFileState('F', ['a'], 'b');
    expect(progress('b')).toMatchObject({ ts: 300 });
  });

  it('a completion moves: the new item is watched, the old one is not any more', () => {
    seed.item('a');
    seed.item('b');
    complete('a', 'F', 200);
    expect(watchRow('a')).toEqual({ watched: 1, at: 200, plays: 1 });
    expect(watch.moveFileState('F', ['a'], 'b')).toBe(1);
    expect(watchRow('a')).toEqual({ watched: 0, at: null, plays: 0 });
    expect(watchRow('b')).toEqual({ watched: 1, at: 200, plays: 1 });
    expect(viewings('a')).toEqual([]);
    expect(viewings('b')).toEqual([{ file: 'F', completed: 1 }]);
  });

  it('the old item stays watched with another completion, dated by it', () => {
    seed.item('a');
    seed.item('b');
    complete('a', 'G', 1_000);
    complete('a', 'F', 1_000 + 2 * HOUR); // a second viewing, on the misidentified file
    watch.moveFileState('F', ['a'], 'b');
    expect(watchRow('a')).toEqual({ watched: 1, at: 1_000, plays: 1 });
    expect(watchRow('b')).toEqual({ watched: 1, at: 1_000 + 2 * HOUR, plays: 1 });
  });

  it('the old item stays watched with a manual mark made before the completion', () => {
    seed.item('a');
    seed.item('b');
    clock = 50;
    watch.markWatched(pid, 'a');
    clock = 1_000_000;
    // A rewatch after the mark: recordProgress counts the play and dates watched_at with it.
    complete('a', 'F', 200);
    expect(watchRow('a')).toEqual({ watched: 1, at: 200, plays: 2 });
    watch.moveFileState('F', ['a'], 'b');
    expect(watchRow('a')).toMatchObject({ watched: 1, plays: 1 });
    expect(watchRow('b')).toEqual({ watched: 1, at: 200, plays: 1 });
  });

  it('a target already watched later keeps its date, adds the play, and drops older progress', () => {
    seed.item('a');
    seed.item('b');
    complete('a', 'F', 200);
    complete('b', 'G', 500);
    watch.recordProgress(sample('b', 600_000, 600, { fileId: 'G' })); // b rewatched after its completion
    watch.moveFileState('F', ['a'], 'b');
    expect(watchRow('b')).toEqual({ watched: 1, at: 500, plays: 2 });
    expect(progress('b')).toMatchObject({ ts: 600 }); // newer than the moved completion: kept

    seed.item('c');
    watch.recordProgress(sample('c', 600_000, 100, { fileId: 'H' }));
    complete('a', 'F', 2 * HOUR);
    watch.moveFileState('F', ['a'], 'c');
    expect(watchRow('c')).toEqual({ watched: 1, at: 2 * HOUR, plays: 1 });
    expect(progress('c')).toBeUndefined(); // older than the moved completion: cleared, as recordProgress does
  });

  it('rows recorded before migration 0003 have no file and never move', () => {
    seed.item('a');
    seed.item('b');
    complete('a', 'F', 200);
    db.$client.prepare('UPDATE viewing_record SET file_id = NULL').run();
    expect(watch.moveFileState('F', ['a'], 'b')).toBe(0);
    expect(watchRow('a')).toEqual({ watched: 1, at: 200, plays: 1 });
    expect(viewings('a')).toEqual([{ file: null, completed: 1 }]);
    expect(watchRow('b')).toBeUndefined();
  });

  it('per profile, the latest progress of several old items wins; other profiles move too', () => {
    seed.item('a1');
    seed.item('a2');
    seed.item('b');
    const other = store.create({ name: 'Anna' }).id;
    watch.recordProgress(sample('a1', 100_000, 100, { fileId: 'F' }));
    watch.recordProgress(sample('a2', 200_000, 150, { fileId: 'F' }));
    watch.recordProgress(sample('a1', 300_000, 120, { fileId: 'F', profileId: other }));
    complete('a2', 'F', 3 * HOUR, other);
    watch.moveFileState('F', ['a1', 'a2'], 'b');
    expect(progress('b')).toMatchObject({ pos: 200_000 });
    expect(progress('b', other)).toBeUndefined(); // its completion on b is newer
    expect(watchRow('b', other)).toEqual({ watched: 1, at: 3 * HOUR, plays: 1 });
    expect(watchRow('a2', other)).toEqual({ watched: 0, at: null, plays: 0 });
    expect(count('playback_progress')).toBe(1);
  });

  it('a series, a season, an unknown item or the same item take nothing', () => {
    seed.item('a');
    const s = seed.series('dark', { 1: 1 });
    complete('a', 'F', 100);
    watch.recordProgress(sample('a', 600_000, 2 * HOUR, { fileId: 'F' }));
    for (const to of [s.seriesId, s.seasonId(1), 'nope', 'a']) expect(watch.moveFileState('F', ['a'], to)).toBe(0);
    expect(progress('a')).toMatchObject({ file: 'F' });
    expect(watchRow('a')).toMatchObject({ watched: 1 });
  });
});
