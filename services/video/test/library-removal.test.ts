// Missing files forgotten (doc 01 §6.1, missing → removed) through the real app: the daily removal after the
// grace period, ForgetMediaFile, ForgetMissingFiles, ListMediaFiles, and what 'removed' means for the readers
// (hidden items, versions, next up, Continue watching), the "Da verificare" queue and provisional items.
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- response bodies are untyped JSON, checked against the contract by the harness */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOVE_MISSING_TASK } from '../src/modules/library/index.ts';
import { BATCH_SIZE } from '../src/modules/library/scan.ts';
import { pullForwardPending } from '../src/modules/identifier/maintenance.ts';
import { requeuePending } from '../src/modules/identifier/service.ts';
import { enqueueJob } from '../src/modules/jobs/index.ts';
import { profilesModule } from '../src/modules/profiles/index.ts';
import { DEFAULT_PREFS } from '../src/modules/profiles/rules.ts';
import { createSystemModule } from '../src/modules/system/index.ts';
import { harness, type Harness, PROFILE, TOKEN } from './helpers/app-harness.ts';
import { seedCase, seedFile, seedLink, seedRoot } from './helpers/catalog-seed.ts';

const DAY = 86_400_000;

let h: Harness;
afterEach(async () => h?.close());

async function setup(env: Record<string, string> = {}) {
  h = await harness({ env, extra: [profilesModule({ tokenKey: randomBytes(32) }), createSystemModule] });
  h.clock.now = 400 * DAY;
  h.db.$client.prepare('INSERT INTO profile (id, name, avatar, prefs, created_at) VALUES (?, ?, NULL, ?, 0)').run(PROFILE, 'Simone', JSON.stringify(DEFAULT_PREFS));
  const film = seedRoot(h.db, 'Film');
  const serie = seedRoot(h.db, 'Serie', { hint: 'series' });
  const archive = seedRoot(h.db, 'Archivio', { status: 'offline' });
  const held = seedRoot(h.db, 'Disco', { status: 'offline' });
  h.db.$client.prepare("UPDATE library_root SET hold_reason = 'mass_missing', held_missing = 30 WHERE id = ?").run(held);
  return { film, serie, archive, held };
}

const one = <T>(sql: string, ...a: unknown[]) => h.db.$client.prepare(sql).get(...a) as T;
const all = <T>(sql: string, ...a: unknown[]) => h.db.$client.prepare(sql).all(...a) as T[];
const fileRow = (id: string) => one<{ state: string; missing_since: number | null }>('SELECT state, missing_since FROM media_file WHERE id = ?', id);
const stateOf = (id: string) => fileRow(id).state;
/** A scan found the file gone `days` days ago. */
const goneFor = (fileId: string, days: number) =>
  h.db.$client.prepare("UPDATE media_file SET state = 'missing', missing_since = ? WHERE id = ?").run(h.clock.now - days * DAY, fileId);
const itemEvents = () =>
  all<{ payload: string }>("SELECT payload FROM domain_event WHERE type = 'library.item_updated' ORDER BY seq").map((e) => JSON.parse(e.payload) as Record<string, unknown>);
const progressEvents = () =>
  all<{ payload: string }>("SELECT payload FROM domain_event WHERE type = 'ingest.progress' ORDER BY seq").map((e) => JSON.parse(e.payload) as Record<string, unknown>);
const runRemoval = async () => h.comp.periodic.find((p) => p.name === REMOVE_MISSING_TASK)!.run();
const countIn = (state: string) => one<{ n: number }>('SELECT count(*) AS n FROM media_file WHERE state = ?', state).n;

function movie(title: string, year: number): string {
  return h.comp.ports.catalogWrite.upsertWork({
    kind: 'movie',
    editionLabel: null,
    externalIds: {},
    fields: [{ source: 'wikidata', fetchedAt: h.clock.now, values: { title, year } }],
  }).itemId;
}

/** A movie with one file per entry, linked to it. */
function movieWithFiles(rootId: string, title: string, year: number, count = 1): { itemId: string; files: string[] } {
  const itemId = movie(title, year);
  const files = Array.from({ length: count }, (_, i) => seedFile(h.db, rootId, `${title} (${year})/${title} - ${i}.mkv`, 'ilbuono'));
  for (const f of files) seedLink(h.db, f, itemId);
  return { itemId, files };
}

function series(rootId: string, title: string, episodes: number) {
  const w = h.comp.ports.catalogWrite;
  const id = w.upsertWork({ kind: 'series', editionLabel: null, externalIds: {}, fields: [{ source: 'wikidata', fetchedAt: h.clock.now, values: { title, year: 2017 } }] }).itemId;
  const season = w.ensureSeason(id, 1).itemId;
  const eps = Array.from({ length: episodes }, (_, i) => {
    const ep = w.ensureEpisode(season, i + 1).itemId;
    const file = seedFile(h.db, rootId, `${title} (2017)/Season 01/${title} - S01E0${i + 1}.mkv`, 'dark');
    seedLink(h.db, file, ep);
    return { id: ep, file };
  });
  return { id, season, eps };
}

const post = (op: string, url: string) => h.call(op, 'POST', url);
const titles = (items: { title: string }[]) => items.map((i) => i.title);

describe('automatic removal after the grace period', () => {
  it('forgets files missing for longer than MISSING_REMOVE_AFTER_DAYS, only on roots online and not held', async () => {
    const r = await setup();
    const old = movieWithFiles(r.film, 'Old', 2001);
    const recent = movieWithFiles(r.film, 'Recent', 2002);
    const offline = movieWithFiles(r.archive, 'Offline', 2003);
    const held = movieWithFiles(r.held, 'Held', 2004);
    const present = movieWithFiles(r.film, 'Present', 2005);
    goneFor(old.files[0]!, 31);
    goneFor(recent.files[0]!, 29);
    goneFor(offline.files[0]!, 90);
    goneFor(held.files[0]!, 90);

    await runRemoval();
    expect(fileRow(old.files[0]!)).toEqual({ state: 'removed', missing_since: h.clock.now - 31 * DAY });
    expect([recent, offline, held].map((m) => stateOf(m.files[0]!))).toEqual(['missing', 'missing', 'missing']);
    expect(stateOf(present.files[0]!)).toBe('identified');
    expect(itemEvents()).toEqual([{ itemId: old.itemId, fileId: old.files[0], reason: 'media_removed' }]);
    // Clients hear about it without anyone at the admin page: the missing list and the queue refresh.
    expect(progressEvents()).toEqual([{ phase: 'remove_missing', forgotten: 1 }]);

    await runRemoval(); // nothing new
    expect(itemEvents()).toHaveLength(1);
    expect(progressEvents()).toHaveLength(1);

    h.clock.now += 2 * DAY;
    await runRemoval();
    expect(stateOf(recent.files[0]!)).toBe('removed');
  });

  it('"more than N days": exactly N days missing is not enough', async () => {
    const r = await setup();
    const exact = movieWithFiles(r.film, 'Exact', 2001);
    const over = movieWithFiles(r.film, 'Over', 2002);
    goneFor(exact.files[0]!, 30);
    h.db.$client.prepare("UPDATE media_file SET state = 'missing', missing_since = ? WHERE id = ?").run(h.clock.now - 30 * DAY - 1, over.files[0]);
    await runRemoval();
    expect([stateOf(exact.files[0]!), stateOf(over.files[0]!)]).toEqual(['missing', 'removed']);
    h.clock.now += 1;
    await runRemoval();
    expect(stateOf(exact.files[0]!)).toBe('removed');
  });

  it('a missing row without missing_since ages from its last change', async () => {
    const r = await setup();
    const old = movieWithFiles(r.film, 'Old', 2001);
    const recent = movieWithFiles(r.film, 'Recent', 2002);
    const setGone = h.db.$client.prepare("UPDATE media_file SET state = 'missing', missing_since = NULL, updated_at = ? WHERE id = ?");
    setGone.run(h.clock.now - 31 * DAY, old.files[0]);
    setGone.run(h.clock.now - 29 * DAY, recent.files[0]);
    await runRemoval();
    expect([stateOf(old.files[0]!), stateOf(recent.files[0]!)]).toEqual(['removed', 'missing']);
  });

  it('a root released from a hold forgets at the next run the files that aged meanwhile', async () => {
    const r = await setup();
    const m = movieWithFiles(r.film, 'Old', 2001);
    goneFor(m.files[0]!, 25);
    h.db.$client.prepare("UPDATE library_root SET status = 'offline', hold_reason = 'empty_walk', held_missing = 40 WHERE id = ?").run(r.film);
    h.clock.now += 20 * DAY;
    await runRemoval();
    expect(stateOf(m.files[0]!)).toBe('missing');
    h.db.$client.prepare("UPDATE library_root SET status = 'online', hold_reason = NULL, held_missing = NULL WHERE id = ?").run(r.film);
    await runRemoval();
    expect(stateOf(m.files[0]!)).toBe('removed');
  });

  it('a root whose contents the owner confirmed (no hold left) ages its files like any other', async () => {
    const r = await setup();
    const m = movieWithFiles(r.film, 'Old', 2001);
    goneFor(m.files[0]!, 40);
    h.db.$client.prepare('UPDATE library_root SET confirmed_missing = 3, confirmed_at = 1 WHERE id = ?').run(r.film);
    await runRemoval();
    expect(stateOf(m.files[0]!)).toBe('removed');
  });

  it('0 turns it off', async () => {
    const r = await setup({ MISSING_REMOVE_AFTER_DAYS: '0' });
    const m = movieWithFiles(r.film, 'Old', 2001);
    goneFor(m.files[0]!, 300);
    await runRemoval();
    expect(stateOf(m.files[0]!)).toBe('missing');
    const { body } = await h.call('listMediaFiles', 'GET', '/video/api/v1/admin/files?state=missing');
    expect(body.autoRemoveAfterDays).toBe(0);
  });
});

describe('ForgetMediaFile and ForgetMissingFiles', () => {
  it('forgets a missing file: links, case, missing_since and watch state stay', async () => {
    const r = await setup();
    const m = movieWithFiles(r.film, 'Arrival', 2016);
    const caseId = seedCase(h.db, m.files[0]!, { state: 'auto_matched' });
    h.db.$client.prepare('INSERT INTO watch_state (profile_id, item_id, watched, watched_at, play_count) VALUES (?, ?, 1, 5, 2)').run(PROFILE, m.itemId);
    goneFor(m.files[0]!, 1);

    const { status, body } = await post('forgetMediaFile', `/video/api/v1/admin/files/${m.files[0]}/forget`);
    expect(status).toBe(200);
    expect(body).toEqual({ forgotten: 1 });
    expect(fileRow(m.files[0]!)).toEqual({ state: 'removed', missing_since: h.clock.now - DAY });
    expect(all('SELECT item_id FROM media_link WHERE file_id = ?', m.files[0])).toEqual([{ item_id: m.itemId }]);
    expect(one<{ state: string }>('SELECT state FROM identification_case WHERE id = ?', caseId).state).toBe('auto_matched');
    expect(one('SELECT watched, play_count FROM watch_state WHERE item_id = ?', m.itemId)).toEqual({ watched: 1, play_count: 2 });
    expect(itemEvents()).toEqual([{ itemId: m.itemId, fileId: m.files[0], reason: 'media_removed' }]);
  });

  it('only a missing file can be forgotten: other states are a conflict, an unknown file is not found', async () => {
    const r = await setup();
    const present = movieWithFiles(r.film, 'Present', 2005);
    const gone = movieWithFiles(r.film, 'Gone', 2006);
    goneFor(gone.files[0]!, 1);
    await post('forgetMediaFile', `/video/api/v1/admin/files/${gone.files[0]}/forget`);
    for (const id of [present.files[0]!, gone.files[0]!]) {
      const { status, body } = await post('forgetMediaFile', `/video/api/v1/admin/files/${id}/forget`);
      expect([status, body.code]).toEqual([409, 'CONFLICT']);
    }
    const ignored = seedFile(h.db, r.film, 'Sample.mkv', null, { state: 'ignored' });
    expect((await post('forgetMediaFile', `/video/api/v1/admin/files/${ignored}/forget`)).status).toBe(409);
    const unknown = await post('forgetMediaFile', '/video/api/v1/admin/files/nope/forget');
    expect([unknown.status, unknown.body.code]).toEqual([404, 'NOT_FOUND']);
    expect(stateOf(present.files[0]!)).toBe('identified');
  });

  it('forgets every missing file of a root; refused while the root is offline or held', async () => {
    const r = await setup();
    const a = movieWithFiles(r.film, 'A', 2001);
    const b = movieWithFiles(r.film, 'B', 2002);
    const c = movieWithFiles(r.film, 'C', 2003);
    const elsewhere = movieWithFiles(r.serie, 'D', 2004);
    const offline = movieWithFiles(r.archive, 'E', 2005);
    const held = movieWithFiles(r.held, 'F', 2006);
    for (const m of [a, b, elsewhere, offline, held]) goneFor(m.files[0]!, 2);

    const done = await post('forgetMissingFiles', `/video/api/v1/admin/roots/${r.film}/forget-missing`);
    expect([done.status, done.body]).toEqual([200, { forgotten: 2 }]);
    expect([a, b, c, elsewhere].map((m) => stateOf(m.files[0]!))).toEqual(['removed', 'removed', 'identified', 'missing']);
    expect(itemEvents().map((e) => e.itemId).sort()).toEqual([a.itemId, b.itemId].sort());
    expect(progressEvents()).toEqual([{ phase: 'remove_missing', forgotten: 2 }]);
    expect((await post('forgetMissingFiles', `/video/api/v1/admin/roots/${r.film}/forget-missing`)).body).toEqual({ forgotten: 0 });
    expect(progressEvents()).toHaveLength(1);

    for (const root of [r.archive, r.held]) {
      const refused = await post('forgetMissingFiles', `/video/api/v1/admin/roots/${root}/forget-missing`);
      expect([refused.status, refused.body.code]).toEqual([409, 'CONFLICT']);
    }
    expect([offline, held].map((m) => stateOf(m.files[0]!))).toEqual(['missing', 'missing']);
    const unknown = await post('forgetMissingFiles', '/video/api/v1/admin/roots/nope/forget-missing');
    expect([unknown.status, unknown.body.code]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('every write re-checks what it decided on: a scan may run between two batches', () => {
  /** More files than one batch, all missing for 40 days on Film, and the one the last batch ends with. */
  async function manyMissing() {
    const r = await setup();
    const ids = Array.from({ length: BATCH_SIZE + 100 }, (_, i) => seedFile(h.db, r.film, `M${String(i).padStart(4, '0')}/M.mkv`, null));
    h.db.$client.prepare("UPDATE media_file SET state = 'missing', missing_since = ? WHERE root_id = ?").run(h.clock.now - 40 * DAY, r.film);
    // One missing time for all: the daily run and the bulk forget both go on by id.
    const last = [...ids].sort().at(-1)!;
    return { r, last };
  }
  /** Starts a run: its first batch is written before it first yields. */
  const start = (path: 'daily' | 'bulk', rootId: string): Promise<unknown> =>
    path === 'daily' ? runRemoval() : h.comp.ports.library.forgetRootMissing(rootId);

  it.each(['daily', 'bulk'] as const)('%s: a file revived meanwhile stays', async (path) => {
    const { r, last } = await manyMissing();
    const run = start(path, r.film);
    expect(countIn('removed')).toBe(BATCH_SIZE);
    // Revived by a scan; its old missing_since is left on purpose, so that only the state check protects it.
    h.db.$client.prepare("UPDATE media_file SET state = 'identified' WHERE id = ?").run(last);
    await run;
    expect(stateOf(last)).toBe('identified');
    expect(countIn('removed')).toBe(BATCH_SIZE + 99);
    expect(progressEvents()).toEqual([{ phase: 'remove_missing', forgotten: BATCH_SIZE + 99 }]);
  });

  it.each(['daily', 'bulk'] as const)('%s: a root held meanwhile keeps the rest', async (path) => {
    const { r } = await manyMissing();
    const run = start(path, r.film);
    expect(countIn('removed')).toBe(BATCH_SIZE);
    h.db.$client.prepare("UPDATE library_root SET status = 'offline', hold_reason = 'mass_missing', held_missing = 100 WHERE id = ?").run(r.film);
    await run;
    expect([countIn('removed'), countIn('missing')]).toEqual([BATCH_SIZE, 100]);
  });
});

describe('ListMediaFiles', () => {
  it('pages through ties and rows without missing_since, newest missing first, with no file skipped or repeated', async () => {
    const r = await setup();
    const ids = Array.from({ length: 9 }, (_, i) => seedFile(h.db, r.film, `M${i}/M${i}.mkv`, null));
    ids.forEach((f, i) => goneFor(f, i % 3)); // ties in threes
    // No missing_since: M0 counts from 5 days ago, M1 from now.
    const noSince = h.db.$client.prepare('UPDATE media_file SET missing_since = NULL, updated_at = ? WHERE id = ?');
    noSince.run(h.clock.now - 5 * DAY, ids[0]);
    noSince.run(h.clock.now, ids[1]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/video/api/v1/admin/files?state=missing&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const { status, body } = await h.call('listMediaFiles', 'GET', url);
      expect([status, body.total]).toEqual([200, 9]);
      seen.push(...body.files.map((f: { relPath: string }) => f.relPath));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['M1', 'M3', 'M6', 'M4', 'M7', 'M2', 'M5', 'M8', 'M0'].map((m) => `${m}/${m}.mkv`));
  });

  it('lists the missing files newest first, with their items and the automatic rule', async () => {
    const r = await setup();
    const older = movieWithFiles(r.film, 'Older', 1999);
    const dark = series(r.serie, 'Dark', 2);
    movieWithFiles(r.film, 'Present', 2005);
    const forgotten = movieWithFiles(r.film, 'Forgotten', 2000);
    goneFor(older.files[0]!, 10);
    goneFor(dark.eps[0]!.file, 3);
    goneFor(dark.eps[1]!.file, 3);
    goneFor(forgotten.files[0]!, 1);
    await post('forgetMediaFile', `/video/api/v1/admin/files/${forgotten.files[0]}/forget`);

    const { status, body } = await h.call('listMediaFiles', 'GET', '/video/api/v1/admin/files?state=missing');
    expect(status).toBe(200);
    expect(body.autoRemoveAfterDays).toBe(30);
    expect(body.nextCursor).toBeNull();
    expect(body.total).toBe(3);
    expect(body.files.map((f: { relPath: string }) => f.relPath)).toEqual([
      'Dark (2017)/Season 01/Dark - S01E01.mkv',
      'Dark (2017)/Season 01/Dark - S01E02.mkv',
      'Older (1999)/Older - 0.mkv',
    ]);
    expect(body.files[0]).toEqual({
      fileId: dark.eps[0]!.file,
      rootId: r.serie,
      rootName: 'Serie',
      relPath: 'Dark (2017)/Season 01/Dark - S01E01.mkv',
      state: 'missing',
      sizeBytes: 1_000_000,
      missingSince: h.clock.now - 3 * DAY,
      items: [{ id: dark.eps[0]!.id, kind: 'episode', title: 'Episodio 1', year: null, seriesTitle: 'Dark', seasonNumber: 1, episodeNumber: 1 }],
    });
    expect(body.files[2].items).toEqual([{ id: older.itemId, kind: 'movie', title: 'Older', year: 1999, seriesTitle: null, seasonNumber: null, episodeNumber: null }]);
  });

  it('filters by root and pages with a keyset cursor; a cursor of another filter, or an unknown root, is refused', async () => {
    const r = await setup();
    const ms = ['A', 'B', 'C'].map((t, i) => movieWithFiles(r.film, t, 2000 + i));
    const other = movieWithFiles(r.serie, 'Z', 2010);
    for (const m of [...ms, other]) goneFor(m.files[0]!, 5);

    const seen: string[] = [];
    let cursor: string | null = null;
    let first: string | null = null;
    do {
      const url: string = `/video/api/v1/admin/files?state=missing&rootId=${r.film}&limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const { body } = await h.call('listMediaFiles', 'GET', url);
      expect(body.total).toBe(3); // the root's, on every page
      seen.push(...body.files.map((f: { relPath: string }) => f.relPath));
      cursor = body.nextCursor;
      first ??= cursor;
    } while (cursor);
    expect(seen).toEqual(['A (2000)/A - 0.mkv', 'B (2001)/B - 0.mkv', 'C (2002)/C - 0.mkv']);

    const foreign = await h.call('listMediaFiles', 'GET', `/video/api/v1/admin/files?state=missing&cursor=${first}`);
    expect([foreign.status, foreign.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const unknown = await h.call('listMediaFiles', 'GET', '/video/api/v1/admin/files?state=missing&rootId=nope');
    expect([unknown.status, unknown.body.code]).toEqual([404, 'NOT_FOUND']);
    const noState = await h.call('listMediaFiles', 'GET', '/video/api/v1/admin/files');
    expect(noState.status).toBe(400);
  });
});

describe('what a forgotten file means for the readers', () => {
  it('an item whose files are all forgotten is hidden; one with a file still missing shows as unavailable', async () => {
    const r = await setup();
    const hidden = movieWithFiles(r.film, 'Hidden', 2001);
    const unavailable = movieWithFiles(r.film, 'Unavailable', 2002, 2);
    const kept = movieWithFiles(r.film, 'Kept', 2003, 2);
    const gone = series(r.serie, 'Gone', 1);
    const half = series(r.serie, 'Half', 2);
    for (const f of [hidden.files[0]!, ...unavailable.files, kept.files[0]!, gone.eps[0]!.file, half.eps[0]!.file]) goneFor(f, 1);
    for (const f of [hidden.files[0]!, unavailable.files[0]!, kept.files[0]!, gone.eps[0]!.file, half.eps[0]!.file]) {
      await post('forgetMediaFile', `/video/api/v1/admin/files/${f}/forget`);
    }

    const movies = (await h.call('listItems', 'GET', '/video/api/v1/items?kind=movie')).body.items;
    expect(movies.map((i: { title: string; available: boolean }) => [i.title, i.available])).toEqual([
      ['Kept', true],
      ['Unavailable', false],
    ]);
    expect(titles((await h.call('listItems', 'GET', '/video/api/v1/items?kind=series')).body.items)).toEqual(['Half']);
    expect(titles((await h.call('search', 'GET', '/video/api/v1/search?q=hidden')).body.items)).toEqual([]);
    expect(titles((await h.call('search', 'GET', '/video/api/v1/search?q=gone')).body.items)).toEqual([]);
    const home = (await h.call('getHome', 'GET', '/video/api/v1/home')).body.rows.flatMap((row: { items: { title: string }[] }) => titles(row.items));
    expect(home).not.toContain('Hidden');
    expect(home).not.toContain('Gone');

    // Versions and playback leave the forgotten file out; an item page still answers, like an item without files.
    const keptDetail = (await h.call('getItem', 'GET', `/video/api/v1/items/${kept.itemId}`)).body;
    expect(keptDetail.versions.map((v: { fileId: string }) => v.fileId)).toEqual([kept.files[1]]);
    expect(h.comp.ports.catalogRead.getPlayableItem(kept.itemId)?.files.map((f) => f.fileId)).toEqual([kept.files[1]]);
    expect((await h.call('getItem', 'GET', `/video/api/v1/items/${hidden.itemId}`)).body.versions).toEqual([]);
    expect((await h.call('getItem', 'GET', `/video/api/v1/items/${unavailable.itemId}`)).body.versions.map((v: { available: boolean }) => v.available)).toEqual([false]);

    // A season lists only the episodes with a file left; next up skips the forgotten one.
    expect((await h.call('getChildren', 'GET', `/video/api/v1/items/${half.season}/children`)).body.items.map((i: { id: string }) => i.id)).toEqual([half.eps[1]!.id]);
    expect(h.comp.ports.catalogRead.listPlayableDescendants(half.id)).toEqual([half.eps[1]!.id]);
    expect((await h.call('getNextUp', 'GET', `/video/api/v1/items/${half.id}/next-up`)).body.item.id).toBe(half.eps[1]!.id);
  });

  it('keeps every profile state; Continue watching skips a forgotten item until its file comes back', async () => {
    const r = await setup();
    const m = movieWithFiles(r.film, 'Arrival', 2016);
    const other = movieWithFiles(r.film, 'Dune', 2021);
    for (const x of [m, other]) {
      h.comp.ports.profilePlayback.recordProgress({ profileId: PROFILE, itemId: x.itemId, fileId: x.files[0]!, positionMs: 1_000_000, durationMs: 6_000_000, at: (h.clock.now += 1000), ended: false });
    }
    const watchlist = await h.app.inject({ method: 'PUT', url: `/video/api/v1/watchlist/${m.itemId}`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(watchlist.statusCode).toBe(204);
    const continueRow = async () =>
      titles((await h.call('getHome', 'GET', '/video/api/v1/home')).body.rows.find((row: { id: string }) => row.id === 'continue_watching')?.items ?? []);
    expect(await continueRow()).toEqual(['Dune', 'Arrival']);

    goneFor(m.files[0]!, 1);
    await post('forgetMediaFile', `/video/api/v1/admin/files/${m.files[0]}/forget`);
    expect(await continueRow()).toEqual(['Dune']);
    expect(titles((await h.call('listItems', 'GET', '/video/api/v1/items?inWatchlist=true')).body.items)).toEqual([]);
    expect(one('SELECT position_ms FROM playback_progress WHERE item_id = ?', m.itemId)).toEqual({ position_ms: 1_000_000 });
    expect(one('SELECT count(*) AS n FROM watchlist_entry WHERE item_id = ?', m.itemId)).toEqual({ n: 1 });

    // The scan revives the row (library-scan.test.ts); the item and its state are back.
    h.db.$client.prepare("UPDATE media_file SET state = 'identified', missing_since = NULL WHERE id = ?").run(m.files[0]);
    expect(await continueRow()).toEqual(['Dune', 'Arrival']);
    const detail = (await h.call('getItem', 'GET', `/video/api/v1/items/${m.itemId}`)).body;
    expect(detail.state).toMatchObject({ inWatchlist: true, resumePositionMs: expect.any(Number) });
  });

  it('the case of a forgotten file leaves the queue, the server count and the pending requeue', async () => {
    const r = await setup();
    const review = seedFile(h.db, r.film, 'Unknown (2001)/Unknown.mkv', 'ilbuono', { state: 'needs_review' });
    const pending = seedFile(h.db, r.film, 'Waiting (2002)/Waiting.mkv', 'ilbuono', { state: 'analyzed' });
    seedCase(h.db, review, { state: 'needs_review', reason: 'no_candidates' });
    seedCase(h.db, pending, { state: 'pending' });
    const queue = async () => (await h.call('listIdentificationCases', 'GET', '/video/api/v1/admin/cases')).body.cases.map((c: { fileId: string }) => c.fileId);
    const needsReview = async () => (await h.call('getServerInfo', 'GET', '/video/api/v1/server')).body.ingest.needsReview;
    const jobs = { enqueue: (j: Parameters<typeof enqueueJob>[2]) => enqueueJob(h.db, h.clock.now, j) };
    expect(await queue()).toEqual([review]);
    expect(await needsReview()).toBe(1);

    goneFor(review, 1);
    goneFor(pending, 1);
    expect(await queue()).toEqual([review]); // missing: still in the queue
    for (const f of [review, pending]) await post('forgetMediaFile', `/video/api/v1/admin/files/${f}/forget`);
    expect(await queue()).toEqual([]);
    expect(await needsReview()).toBe(0);
    expect(requeuePending(h.db, jobs)).toBe(0);
    expect(pullForwardPending(h.db, h.clock.now)).toBe(0);
    expect(all("SELECT id FROM job WHERE type = 'identifier.identify'")).toEqual([]);
  });

  it('a provisional item whose only file is forgotten is hidden, and the sweep keeps it with its stand-in link', async () => {
    const r = await setup();
    const file = seedFile(h.db, r.film, 'Waiting (2002)/Waiting.mkv', 'ilbuono', { state: 'analyzed' });
    const stand = h.comp.ports.catalogWrite.upsertWork({
      kind: 'movie',
      editionLabel: null,
      externalIds: {},
      provisional: true,
      fields: [{ source: 'filename', fetchedAt: h.clock.now, values: { title: 'Waiting', year: 2002 } }],
    }).itemId;
    seedLink(h.db, file, stand);
    seedCase(h.db, file, { state: 'pending', parsed: { kind: 'movie', title: 'Waiting', provisionalWorks: [stand] } });
    expect(titles((await h.call('listItems', 'GET', '/video/api/v1/items?kind=movie')).body.items)).toEqual(['Waiting']);

    goneFor(file, 1);
    await post('forgetMediaFile', `/video/api/v1/admin/files/${file}/forget`);
    await h.comp.periodic.find((p) => p.name === 'identifier.sweep_provisional')!.run();
    expect(one('SELECT provisional FROM catalog_item WHERE id = ?', stand)).toEqual({ provisional: 1 });
    expect(all('SELECT item_id FROM media_link WHERE file_id = ?', file)).toEqual([{ item_id: stand }]);
    expect(titles((await h.call('listItems', 'GET', '/video/api/v1/items?kind=movie')).body.items)).toEqual([]);
    expect(all("SELECT type FROM domain_event WHERE type = 'library.item_removed'")).toEqual([]);
  });
});
