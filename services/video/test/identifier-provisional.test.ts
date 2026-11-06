// Provisional items (doc 02 §3.5): a file whose identification waits for a provider is shown and
// playable under the title of its name, then replaced by the identified item. Real modules over an
// in-memory DB (app harness, real profiles), a provider that can be down, weak or up; every response
// checked against the contract. Also migration 0004 on a database with data.
/* eslint-disable @typescript-eslint/no-unsafe-call -- response bodies are untyped JSON, checked against the contract by the harness */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobContext } from '../src/app/module.ts';
import { closeDb, openDb } from '../src/db/index.ts';
import { playbackModule } from '../src/modules/playback/index.ts';
import { profilesModule } from '../src/modules/profiles/index.ts';
import { DEFAULT_PREFS } from '../src/modules/profiles/rules.ts';
import type { MetadataCandidate } from '../src/shared/metadata.ts';
import { harness, type Harness, PROFILE, TOKEN } from './helpers/app-harness.ts';
import { seedFile, seedLink, seedRoot } from './helpers/catalog-seed.ts';
import { byExternalId, byTitle, cand, fakeMetadata } from './helpers/fake-metadata.ts';
import { chrome } from './playback-fixtures.ts';
import { FakeDelivery } from './playback-harness.ts';

const log = pino({ level: 'silent' });
const DUNE = cand({ id: 'Q63985561', title: 'Dune', original: ['Dune'], years: [2021], ids: { tmdb: '438631' } });
const DARK = cand({ id: 'Q24300155', kind: 'series', title: 'Dark', original: ['Dark'], years: [2017], ids: { tmdb: '70523' } });
const WEAK_DUNE = cand({ id: 'Q1', title: 'Dune: Part Two', years: [2024] });
const UP: Record<string, MetadataCandidate[]> = { dune: [DUNE], dark: [DARK] };

let provider: 'down' | 'weak' | 'up';
let h: Harness;
let film: string;
let serie: string;
let copia: string;

beforeEach(async () => {
  provider = 'down';
  const metadata = fakeMetadata({
    wikidata: {
      search: (req) => (provider === 'down' ? { status: 'unavailable' } : byTitle(provider === 'weak' ? { dune: [WEAK_DUNE] } : UP)(req)),
      lookup: (l) => (provider === 'down' ? { status: 'unavailable' } : byExternalId([DUNE, DARK])(l)),
    },
  });
  const roots = [
    { name: 'Film', path: '/media/Film' },
    { name: 'Serie', path: '/media/Serie', hint: 'series' as const },
    { name: 'Copia', path: '/media/Copia' },
  ];
  const delivery = () => ({ name: 'delivery', provides: { streamDelivery: new FakeDelivery() } });
  h = await harness({ metadata, roots, extra: [profilesModule({ tokenKey: randomBytes(32) }), delivery, playbackModule()] });
  h.db.$client.prepare('INSERT INTO profile (id, name, avatar, prefs, created_at) VALUES (?, ?, NULL, ?, 0)').run(PROFILE, 'Simone', JSON.stringify(DEFAULT_PREFS));
  film = seedRoot(h.db, 'Film');
  serie = seedRoot(h.db, 'Serie', { hint: 'series' });
  copia = seedRoot(h.db, 'Copia');
});
afterEach(async () => h.close());

// ---------------------------------------------------------------- helpers

const all = <T>(sql: string, ...a: unknown[]) => h.db.$client.prepare(sql).all(...a) as T[];
const one = <T>(sql: string, ...a: unknown[]) => h.db.$client.prepare(sql).get(...a) as T | undefined;
const count = (sql: string, ...a: unknown[]) => one<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...a)?.n ?? 0;
const linksOf = (fileId: string) => all<{ item_id: string; origin: string; confidence: number | null }>('SELECT item_id, origin, confidence FROM media_link WHERE file_id = ? ORDER BY item_id', fileId);
const itemOf = (fileId: string) => linksOf(fileId)[0]?.item_id ?? '';
const row = (id: string) => one<{ kind: string; title: string; year: number | null; parent_id: string | null; provisional: number }>('SELECT * FROM catalog_item WHERE id = ?', id);
const caseOf = (fileId: string) => {
  const c = one<{ id: string; state: string; reason: string | null; parsed: string }>('SELECT id, state, reason, parsed FROM identification_case WHERE file_id = ?', fileId);
  return c && { ...c, parsed: JSON.parse(c.parsed) as Record<string, unknown> };
};
const fileState = (fileId: string) => one<{ state: string }>('SELECT state FROM media_file WHERE id = ?', fileId)?.state;
const events = (type?: string) =>
  all<{ type: string; payload: string }>('SELECT type, payload FROM domain_event ORDER BY seq')
    .map((e) => ({ type: e.type, payload: JSON.parse(e.payload) as Record<string, unknown> }))
    .filter((e) => !type || e.type === type);
const provisionalCount = () => count("catalog_item WHERE provisional = 1");

const movie = (rel: string, root = film) => seedFile(h.db, root, rel, 'dune', { state: 'analyzed' });
const episode = (rel: string) => seedFile(h.db, serie, rel, 'dark', { state: 'analyzed' });

/** Runs identifier.identify once, as the job runner would; 'retry' when it asks to run again. */
async function identify(fileId: string): Promise<'done' | 'retry'> {
  const job = h.comp.jobTypes.get('identifier.identify');
  if (!job) throw new Error('identifier.identify not registered');
  const ctx: JobContext = { jobId: 'j', attempt: 1, log, signal: new AbortController().signal };
  try {
    await job.handler({ fileId }, ctx);
    return 'done';
  } catch (err) {
    if ((err as Error).name === 'RetryLaterError') return 'retry';
    throw err;
  }
}

async function put(url: string): Promise<number> {
  return (await h.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${TOKEN}` } })).statusCode;
}
const watchlist = (itemId: string) => put(`/video/api/v1/watchlist/${itemId}`);
const watchlisted = () => all<{ item_id: string }>('SELECT item_id FROM watchlist_entry WHERE profile_id = ? ORDER BY item_id', PROFILE).map((r) => r.item_id);

/** A completed viewing, then a later one in progress: watched, two history rows, one progress row. */
function watch(itemId: string, fileId: string): void {
  const rec = (s: Parameters<typeof h.comp.ports.profilePlayback.recordProgress>[0]) => h.comp.ports.profilePlayback.recordProgress(s);
  rec({ profileId: PROFILE, itemId, fileId, positionMs: 29_000, durationMs: 30_000, at: 1_000, ended: true });
  rec({ profileId: PROFILE, itemId, fileId, positionMs: 10_000, durationMs: 30_000, at: 10_000_000, ended: false });
}
const stateOn = (itemId: string) => ({
  progress: one<{ position_ms: number }>('SELECT position_ms FROM playback_progress WHERE profile_id = ? AND item_id = ?', PROFILE, itemId)?.position_ms ?? null,
  watched: one<{ watched: number }>('SELECT watched FROM watch_state WHERE profile_id = ? AND item_id = ?', PROFILE, itemId)?.watched === 1,
  history: count('viewing_record WHERE profile_id = ? AND item_id = ?', PROFILE, itemId),
});

const getItem = (id: string) => h.call('getItem', 'GET', `/video/api/v1/items/${id}`);

// ---------------------------------------------------------------- tests

describe('a file waiting for a provider is shown under its name', () => {
  it('pending → a provisional movie: in Home, search and detail, playable, provisional: true', async () => {
    const f = movie('Dune (2021) {edition-Director’s Cut}/Dune (2021) {edition-Director’s Cut}.mkv');
    expect(await identify(f)).toBe('retry');
    const [link] = linksOf(f);
    expect(link).toMatchObject({ origin: 'auto', confidence: null });
    const id = link!.item_id;
    expect(row(id)).toMatchObject({ kind: 'movie', title: 'Dune', year: 2021, parent_id: null, provisional: 1 });
    expect([caseOf(f)?.state, fileState(f)]).toEqual(['pending', 'analyzed']);
    expect(caseOf(f)?.parsed.provisionalWorks).toEqual([id]);

    const home = (await h.call('getHome', 'GET', '/video/api/v1/home')).body;
    const recent = home.rows.find((r: { id: string }) => r.id === 'recently_added');
    expect(recent.items).toEqual([expect.objectContaining({ id, title: 'Dune', year: 2021, available: true, provisional: true, editionLabel: 'Director’s Cut' })]);
    expect(home.rows.find((r: { id: string }) => r.id === 'movies').items.map((i: { id: string }) => i.id)).toEqual([id]);

    const search = (await h.call('search', 'GET', '/video/api/v1/search?q=dune')).body;
    expect(search.items).toEqual([expect.objectContaining({ id, provisional: true })]);

    const detail = (await getItem(id)).body;
    expect(detail).toMatchObject({ id, provisional: true, available: true, externalIds: {}, attributions: [] });
    expect(detail.versions.map((v: { fileId: string }) => v.fileId)).toEqual([f]);
    expect(h.comp.ports.catalogRead.getPlayableItem(id)?.files.map((x) => x.fileId)).toEqual([f]);

    // Never enriched: no job, not in the refresh sweep.
    expect(count("job WHERE type = 'metadata.enrich'")).toBe(0);
    expect(h.comp.ports.catalogWrite.listWorkRefreshState()).toEqual([]);
    expect(events().map((e) => e.type)).toEqual(['library.item_added']);
  });

  it('retries change nothing while the name says the same', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const before = { links: linksOf(f), events: events().length };
    expect(await identify(f)).toBe('retry');
    expect(await identify(f)).toBe('retry');
    expect({ links: linksOf(f), events: events().length }).toEqual(before);
    expect(provisionalCount()).toBe(1);
  });

  it('episodes of one pending series share its provisional series; another series gets its own', async () => {
    const e1 = episode('Dark (2017)/Season 01/Dark (2017) - S01E01 - Segreti.mkv');
    const e23 = episode('Dark (2017)/Season 01/Dark (2017) - S01E02-E03.mkv');
    const e5 = episode('Dark (2017)/Season 02/Dark (2017) - S02E05.mkv');
    const other = episode('Other (2017)/Season 01/Other (2017) - S01E01.mkv');
    for (const f of [e1, e23, e5, other]) expect(await identify(f)).toBe('retry');

    const seriesOf = (fileId: string) => h.comp.ports.catalogWrite.findAncestor(itemOf(fileId), 'series');
    const dark = seriesOf(e1)!;
    expect([seriesOf(e23), seriesOf(e5)]).toEqual([dark, dark]);
    expect(seriesOf(other)).not.toBe(dark);
    expect(row(dark)).toMatchObject({ kind: 'series', title: 'Dark', year: 2017, provisional: 1 });
    expect(linksOf(e23)).toHaveLength(2); // a multi-episode file links to each
    expect(row(itemOf(e1))).toMatchObject({ kind: 'episode', title: 'Segreti', provisional: 1 });
    expect(count("catalog_item WHERE kind = 'series'")).toBe(2);
    expect(count('catalog_item WHERE kind = ? AND parent_id = ?', 'season', dark)).toBe(2);

    const series = (await h.call('listItems', 'GET', '/video/api/v1/items?kind=series')).body.items;
    expect(series.map((s: { title: string; provisional: boolean }) => [s.title, s.provisional])).toEqual([
      ['Dark', true],
      ['Other', true],
    ]);
    const seasons = (await h.call('getChildren', 'GET', `/video/api/v1/items/${dark}/children`)).body.items;
    expect(seasons.map((s: { seasonNumber: number; provisional: boolean }) => [s.seasonNumber, s.provisional])).toEqual([
      [1, true],
      [2, true],
    ]);
    const episodes = (await h.call('getChildren', 'GET', `/video/api/v1/items/${seasons[0].id}/children`)).body.items;
    expect(episodes.map((e: { episodeNumber: number; provisional: boolean }) => [e.episodeNumber, e.provisional])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
    expect((await getItem(itemOf(e1))).body).toMatchObject({ provisional: true, seriesTitle: 'Dark', available: true });
    expect(count("job WHERE type = 'metadata.enrich'")).toBe(0);
  });

  it('a file that already has links (new content at the same path) keeps them and gets no provisional item', async () => {
    const real = h.comp.ports.catalogWrite.upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q1' }, fields: [{ source: 'manual', fetchedAt: 0, values: { title: 'Old' } }] }).itemId;
    const f = movie('Dune (2021)/Dune (2021).mkv');
    seedLink(h.db, f, real);
    expect(await identify(f)).toBe('retry');
    expect(linksOf(f).map((l) => l.item_id)).toEqual([real]);
    expect(caseOf(f)?.state).toBe('pending');
    expect(caseOf(f)?.parsed.provisionalWorks).toBeUndefined();
    expect(provisionalCount()).toBe(0);
  });

  it('extras get no provisional item; a copy of a waiting file does not take its stand-in', async () => {
    const extra = movie('Dune (2021)/Trailers/Trailer.mkv');
    expect(await identify(extra)).toBe('retry');
    expect(linksOf(extra)).toEqual([]);

    const a = movie('Dune (2021)/Dune (2021).mkv');
    const b = movie('Dune (2021)/Dune (2021).mkv', copia);
    h.db.$client.prepare("UPDATE media_file SET fingerprint = 'same' WHERE id IN (?, ?)").run(a, b);
    await identify(a);
    expect(await identify(b)).toBe('retry'); // not "identified as a copy" of a provisional link
    expect(caseOf(b)?.state).toBe('pending');
    expect(itemOf(b)).not.toBe(itemOf(a));
    expect(row(itemOf(b))?.provisional).toBe(1);

    provider = 'up';
    await identify(a);
    await identify(b); // now a copy of an identified file
    expect(itemOf(b)).toBe(itemOf(a));
    expect(caseOf(b)?.parsed).toMatchObject({ copyOf: a });
    expect(provisionalCount()).toBe(0);
  });

  it('versions in one item folder share the provisional movie; it stays while one of them is left on it', async () => {
    const hd = movie('Dune (2021)/Dune (2021) - 1080p.mkv');
    const uhd = movie('Dune (2021)/Dune (2021) - 2160p.mkv');
    await identify(hd);
    await identify(uhd);
    const p = itemOf(hd);
    expect(itemOf(uhd)).toBe(p);
    expect((await getItem(p)).body.versions).toHaveLength(2);

    provider = 'up';
    await identify(hd);
    expect(row(p)?.provisional).toBe(1); // the 2160p is still shown there
    expect(events('library.item_removed')).toEqual([]);
    await identify(uhd); // its sibling's work, no provider call needed
    expect(itemOf(uhd)).toBe(itemOf(hd));
    expect(row(p)).toBeUndefined();
  });
});

describe('the identification arrives', () => {
  it('auto match: link, progress, watched, history and watchlist move; the provisional movie goes', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    watch(p, f);
    expect(await watchlist(p)).toBe(204);
    expect(stateOn(p)).toEqual({ progress: 10_000, watched: true, history: 2 });

    provider = 'up';
    expect(await identify(f)).toBe('done');
    const real = itemOf(f);
    expect(real).not.toBe(p);
    expect(linksOf(f)).toEqual([{ item_id: real, origin: 'auto', confidence: 1 }]);
    expect(row(real)).toMatchObject({ title: 'Dune', provisional: 0 });
    expect(row(p)).toBeUndefined();
    expect(stateOn(real)).toEqual({ progress: 10_000, watched: true, history: 2 });
    expect(count('playback_progress') + count('viewing_record WHERE item_id = ?', p)).toBe(1);
    expect(watchlisted()).toEqual([real]);
    expect([caseOf(f)?.state, fileState(f)]).toEqual(['auto_matched', 'identified']);
    expect(caseOf(f)?.parsed.provisionalWorks).toEqual([p]);
    expect(count('catalog_search WHERE item_id = ?', p)).toBe(0);
    expect(events().map((e) => [e.type, e.payload.itemId === p ? 'P' : e.payload.itemId === real ? 'R' : '?'])).toEqual([
      ['library.item_added', 'P'],
      ['library.item_added', 'R'],
      ['library.item_updated', 'P'], // media_unlinked
      ['library.item_removed', 'P'],
    ]);
    expect(events('library.item_removed')[0]?.payload).toEqual({ itemId: p, kind: 'movie', parentId: null, replacedBy: real });

    expect((await h.app.inject({ method: 'GET', url: `/video/api/v1/items/${p}`, headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(404);
    expect((await getItem(real)).body).toMatchObject({ provisional: false, state: { inWatchlist: true, watched: true, progressPercent: 33.3 } });
    // A real work is enriched as usual.
    expect(count("job WHERE type = 'metadata.enrich'")).toBe(1);
  });

  it('a series: episodes move one by one; season and series go with the last one, the watchlist follows', async () => {
    const e1 = episode('Dark (2017)/Season 01/Dark (2017) - S01E01.mkv');
    const e2 = episode('Dark (2017)/Season 01/Dark (2017) - S01E02.mkv');
    for (const f of [e1, e2]) await identify(f);
    const p1 = itemOf(e1);
    const ps = h.comp.ports.catalogWrite.findAncestor(p1, 'series')!;
    const season = row(p1)!.parent_id!;
    expect(await watchlist(ps)).toBe(204);
    h.comp.ports.profilePlayback.recordProgress({ profileId: PROFILE, itemId: p1, fileId: e1, positionMs: 10_000, durationMs: 30_000, at: 5_000, ended: false });

    provider = 'up';
    await identify(e1);
    const r1 = itemOf(e1);
    const dark = h.comp.ports.catalogWrite.findAncestor(r1, 'series')!;
    expect(row(dark)).toMatchObject({ title: 'Dark', provisional: 0 });
    expect(stateOn(r1).progress).toBe(10_000);
    expect(row(p1)).toBeUndefined();
    expect([row(season)?.provisional, row(ps)?.provisional]).toEqual([1, 1]); // E02 is still shown there
    expect(watchlisted()).toEqual([ps]);

    await identify(e2); // its sibling's series
    expect(h.comp.ports.catalogWrite.findAncestor(itemOf(e2), 'series')).toBe(dark);
    expect([row(season), row(ps)]).toEqual([undefined, undefined]);
    expect(provisionalCount()).toBe(0);
    expect(watchlisted()).toEqual([dark]);
    const r2 = itemOf(e2);
    const realSeason = row(r2)!.parent_id;
    expect(events('library.item_removed').map((e) => [e.payload.kind, e.payload.replacedBy])).toEqual([
      ['episode', r1],
      ['episode', r2],
      ['season', realSeason],
      ['series', dark],
    ]);
  });

  it('a series with one episode identified and one ignored: the ignored file does not count, the watchlist follows', async () => {
    const e1 = episode('Dark (2017)/Season 01/Dark (2017) - S01E01.mkv');
    const e2 = episode('Dark (2017)/Season 01/Dark (2017) - S01E02.mkv');
    for (const f of [e1, e2]) await identify(f);
    const ps = h.comp.ports.catalogWrite.findAncestor(itemOf(e1), 'series')!;
    await watchlist(ps);
    provider = 'up';
    await identify(e1);
    const dark = h.comp.ports.catalogWrite.findAncestor(itemOf(e1), 'series')!;
    const ignored = await h.call('ignoreCase', 'POST', `/video/api/v1/admin/cases/${caseOf(e2)!.id}/ignore`);
    expect(ignored.status).toBe(200);
    expect(row(ps)).toBeUndefined();
    expect(watchlisted()).toEqual([dark]);
    // The ignored episode has no replacement; the series has one.
    expect(events('library.item_removed').map((e) => [e.payload.kind, e.payload.replacedBy === undefined ? null : e.payload.replacedBy === dark ? 'dark' : 'other'])).toEqual([
      ['episode', 'other'],
      ['episode', null],
      ['season', null],
      ['series', 'dark'],
    ]);
  });

  it('a series whose files went to two different series: its watchlist entry goes with it', async () => {
    const e1 = episode('Dark (2017)/Season 01/Dark (2017) - S01E01.mkv');
    const e2 = episode('Dark (2017)/Season 01/Dark (2017) - S01E02.mkv');
    for (const f of [e1, e2]) await identify(f);
    const ps = h.comp.ports.catalogWrite.findAncestor(itemOf(e1), 'series')!;
    await watchlist(ps);
    provider = 'up';
    await identify(e1);
    const other = h.comp.ports.catalogWrite.upsertWork({ kind: 'series', editionLabel: null, externalIds: { wikidata: 'Q2' }, fields: [{ source: 'manual', fetchedAt: 0, values: { title: 'Other' } }] }).itemId;
    const season = h.comp.ports.catalogWrite.ensureSeason(other, 1).itemId;
    const ep = h.comp.ports.catalogWrite.ensureEpisode(season, 2).itemId;
    expect((await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseOf(e2)!.id}/resolve`, { action: 'link_item', itemId: ep })).status).toBe(200);
    expect(row(ps)).toBeUndefined();
    expect(watchlisted()).toEqual([]);
  });

  it('a renamed waiting file moves to the provisional item of its new name, with its state', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    watch(p, f);
    await watchlist(p);
    h.db.$client.prepare("UPDATE media_file SET rel_path = 'Arrival (2016)/Arrival (2016).mkv' WHERE id = ?").run(f);
    expect(await identify(f)).toBe('retry');
    const q = itemOf(f);
    expect(row(q)).toMatchObject({ title: 'Arrival', year: 2016, provisional: 1 });
    expect(row(p)).toBeUndefined();
    expect(stateOn(q)).toEqual({ progress: 10_000, watched: true, history: 2 });
    expect(watchlisted()).toEqual([q]);
    expect(caseOf(f)?.parsed.provisionalWorks).toEqual([p, q]);
  });
});

describe('the owner decides', () => {
  it('review: the file stays visible under its provisional item; a manual resolution moves the state and retires it', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    watch(p, f);
    await watchlist(p);

    provider = 'weak';
    expect(await identify(f)).toBe('done');
    expect([caseOf(f)?.state, caseOf(f)?.reason, fileState(f)]).toEqual(['needs_review', 'low_score', 'needs_review']);
    expect(linksOf(f)).toEqual([{ item_id: p, origin: 'auto', confidence: null }]);
    expect((await getItem(p)).body).toMatchObject({ provisional: true, available: true });
    const queue = (await h.call('listIdentificationCases', 'GET', '/video/api/v1/admin/cases?state=needs_review')).body.cases;
    expect(queue[0]).toMatchObject({ fileId: f, linkedItem: { id: p, provisional: true }, parsed: { title: 'Dune', year: 2021 } });
    expect(queue[0].parsed).not.toHaveProperty('provisionalWorks');

    provider = 'up';
    const resolved = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseOf(f)!.id}/resolve`, { action: 'link_candidate', candidate: { provider: 'wikidata', id: DUNE.ref.id } });
    expect(resolved.status).toBe(200);
    const real = itemOf(f);
    expect(linksOf(f)).toEqual([{ item_id: real, origin: 'manual', confidence: null }]);
    expect(row(p)).toBeUndefined();
    expect(stateOn(real)).toEqual({ progress: 10_000, watched: true, history: 2 });
    expect(watchlisted()).toEqual([real]);
    expect(resolved.body).toMatchObject({ state: 'resolved', linkedItem: { id: real, provisional: false } });
  });

  it('a pending case resolved by hand works the same way', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    watch(p, f);
    const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseOf(f)!.id}/resolve`, { action: 'create_manual', manual: { kind: 'movie', title: 'Dune (mia)', year: 2021 } });
    expect(r.status).toBe(200);
    const real = itemOf(f);
    expect(row(real)).toMatchObject({ title: 'Dune (mia)', provisional: 0 });
    expect(row(p)).toBeUndefined();
    expect(stateOn(real).history).toBe(2);
  });

  it('ignore: the provisional item goes, with what profiles recorded on it', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    watch(p, f);
    await watchlist(p);
    const r = await h.call('ignoreCase', 'POST', `/video/api/v1/admin/cases/${caseOf(f)!.id}/ignore`);
    expect(r.status).toBe(200);
    expect([fileState(f), linksOf(f)]).toEqual(['ignored', []]);
    expect(row(p)).toBeUndefined();
    expect([count('playback_progress'), count('viewing_record'), count('watch_state'), count('watchlist_entry')]).toEqual([0, 0, 0, 0]);
    expect(events('library.item_removed').map((e) => e.payload.itemId)).toEqual([p]);
  });

  it('a provisional item the owner links another file to is adopted and never retired; the first file’s state follows it', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    watch(p, f);
    // Another file in review, linked by the owner to the provisional item.
    provider = 'weak';
    const g = movie('Dune (2021)/Dune (2021).mkv', copia);
    await identify(g);
    expect(caseOf(g)?.state).toBe('needs_review');
    const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseOf(g)!.id}/resolve`, { action: 'link_item', itemId: p });
    expect(r.status).toBe(200);
    expect(r.body.linkedItem).toMatchObject({ id: p, provisional: false });
    expect(row(p)?.provisional).toBe(0);

    // f is still pending: identified again, not left on the adopted item as if decided.
    provider = 'up';
    expect(await identify(f)).toBe('done');
    const real = itemOf(f);
    expect(real).not.toBe(p);
    expect([caseOf(f)?.state, fileState(f)]).toEqual(['auto_matched', 'identified']);
    expect(row(p)).toMatchObject({ title: 'Dune', provisional: 0 });
    expect(linksOf(g)).toEqual([{ item_id: p, origin: 'manual', confidence: null }]);
    // What was recorded on f follows it; the adopted item is not retired.
    expect(stateOn(real)).toEqual({ progress: 10_000, watched: true, history: 2 });
    expect(stateOn(p)).toEqual({ progress: null, watched: false, history: 0 });
    expect(events('library.item_removed')).toEqual([]);
  });

  it('a version in review whose provisional movie the owner adopted through its sibling is identified again (R1)', async () => {
    const hd = movie('Dune (2021)/Dune (2021) - 1080p.mkv');
    const uhd = movie('Dune (2021)/Dune (2021) - 2160p.mkv');
    await identify(hd);
    await identify(uhd);
    const p = itemOf(hd);
    provider = 'weak';
    await identify(hd);
    await identify(uhd);
    expect([caseOf(hd)?.state, caseOf(uhd)?.state]).toEqual(['needs_review', 'needs_review']);

    expect((await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseOf(uhd)!.id}/resolve`, { action: 'link_item', itemId: p })).status).toBe(200);
    expect(count("job WHERE type = 'identifier.identify' AND idempotency_key = ?", `identify:${hd}`)).toBe(1);
    expect(await identify(hd)).toBe('done');
    expect([caseOf(hd)?.state, fileState(hd), linksOf(hd)]).toEqual(['auto_matched', 'identified', [{ item_id: p, origin: 'auto', confidence: 1 }]]);
    const queue = (await h.call('listIdentificationCases', 'GET', '/video/api/v1/admin/cases?state=needs_review')).body.cases;
    expect(queue).toEqual([]);
  });

  it('a pending version follows its sibling to the adopted movie (R6)', async () => {
    const hd = movie('Dune (2021)/Dune (2021) - 1080p.mkv');
    const uhd = movie('Dune (2021)/Dune (2021) - 2160p.mkv');
    await identify(hd);
    await identify(uhd);
    const p = itemOf(hd);
    expect((await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseOf(uhd)!.id}/resolve`, { action: 'link_item', itemId: p })).status).toBe(200);
    expect(await identify(hd)).toBe('done'); // the sibling rule: no provider needed
    expect([caseOf(hd)?.state, fileState(hd), itemOf(hd), row(p)?.provisional]).toEqual(['auto_matched', 'identified', p, 0]);
  });

  it('adopting one episode adopts the whole provisional series (R2)', async () => {
    const e1 = episode('Dark (2017)/Season 01/Dark (2017) - S01E01.mkv');
    const e2 = episode('Dark (2017)/Season 01/Dark (2017) - S01E02.mkv');
    const e5 = episode('Dark (2017)/Season 02/Dark (2017) - S02E05.mkv');
    for (const f of [e1, e2, e5]) await identify(f);
    const [p1, p2, p5] = [itemOf(e1), itemOf(e2), itemOf(e5)];
    const ps = h.comp.ports.catalogWrite.findAncestor(p2, 'series')!;
    expect((await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseOf(e2)!.id}/resolve`, { action: 'link_item', itemId: p2 })).status).toBe(200);
    expect(provisionalCount()).toBe(0);
    for (const id of [p1, p5, ps]) expect((await getItem(id)).body.provisional).toBe(false);

    expect(await identify(e1)).toBe('done'); // its sibling's series, no provider call
    expect([caseOf(e1)?.state, fileState(e1), itemOf(e1)]).toEqual(['auto_matched', 'identified', p1]);
    expect(events('library.item_removed')).toEqual([]);
  });

  it('retirement re-checks links in the transaction: an item with any link is never removed', () => {
    const w = h.comp.ports.catalogWrite;
    const mk = (title: string) => w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: {}, provisional: true, fields: [{ source: 'filename', fetchedAt: 0, values: { title } }] }).itemId;
    const manual = mk('Manual');
    const auto = mk('Auto');
    const empty = mk('Empty');
    const real = w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q9' }, fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'Real' } }] }).itemId;
    // A manual link written straight to the table (no adoption): still never removed.
    seedLink(h.db, movie('a/a.mkv'), manual, 'manual');
    seedLink(h.db, movie('b/b.mkv'), auto, 'auto');
    expect(w.provisionalToRetire([manual, auto, empty, real])).toEqual([empty]);
    expect(row(empty)).toBeDefined(); // a dry run writes nothing
    expect(w.provisionalOrphans()).toEqual([empty]);
    expect(w.retireProvisional([manual, auto, empty, real, 'nope'])).toEqual([empty]);
    expect([row(manual), row(auto), row(real)].map((r) => r?.title)).toEqual(['Manual', 'Auto', 'Real']);
    expect(row(empty)).toBeUndefined();
    expect(() => w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: { tmdb: '1' }, provisional: true, fields: [] })).toThrow(/no external ids/);
  });
});

describe('state recorded on the provisional item itself', () => {
  it('a watched mark set by hand moves to the real item, merged with what the file brought (R3)', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    h.clock.now = 2_000_000;
    expect(await put(`/video/api/v1/items/${p}/watched`)).toBe(204);
    provider = 'up';
    await identify(f);
    const real = itemOf(f);
    expect(one('SELECT watched, watched_at AS at, play_count AS plays FROM watch_state WHERE profile_id = ? AND item_id = ?', PROFILE, real)).toEqual({ watched: 1, at: 2_000_000, plays: 1 });
    expect((await getItem(real)).body.state).toMatchObject({ watched: true });
  });

  it('a series marked watched by hand: each episode’s mark moves to the episode that replaced it', async () => {
    const e1 = episode('Dark (2017)/Season 01/Dark (2017) - S01E01.mkv');
    const e2 = episode('Dark (2017)/Season 01/Dark (2017) - S01E02.mkv');
    for (const f of [e1, e2]) await identify(f);
    const ps = h.comp.ports.catalogWrite.findAncestor(itemOf(e1), 'series')!;
    expect(await put(`/video/api/v1/items/${ps}/watched`)).toBe(204);
    provider = 'up';
    for (const f of [e1, e2]) await identify(f);
    const dark = h.comp.ports.catalogWrite.findAncestor(itemOf(e1), 'series')!;
    expect([stateOn(itemOf(e1)).watched, stateOn(itemOf(e2)).watched]).toEqual([true, true]);
    expect((await getItem(dark)).body.state).toMatchObject({ watched: true, progressPercent: 100 });
  });

  it('a multi-episode file: its state moves episode by episode when the numbers pair', async () => {
    const f = episode('Dark (2017)/Season 01/Dark (2017) - S01E02-E03.mkv');
    await identify(f);
    const [a, b] = linksOf(f).map((l) => l.item_id);
    const byNumber = (id: string) => one<{ n: number }>('SELECT episode_number AS n FROM catalog_item WHERE id = ?', id)!.n;
    const [p2, p3] = byNumber(a!) === 2 ? [a!, b!] : [b!, a!];
    h.comp.ports.profilePlayback.recordProgress({ profileId: PROFILE, itemId: p2, fileId: f, positionMs: 10_000, durationMs: 30_000, at: 5_000, ended: false });
    expect(await put(`/video/api/v1/items/${p3}/watched`)).toBe(204);
    provider = 'up';
    await identify(f);
    const real = linksOf(f).map((l) => l.item_id);
    const [r2, r3] = byNumber(real[0]!) === 2 ? [real[0]!, real[1]!] : [real[1]!, real[0]!];
    expect(stateOn(r2)).toEqual({ progress: 10_000, watched: false, history: 1 });
    expect(stateOn(r3)).toMatchObject({ progress: null, watched: true });
    expect(provisionalCount()).toBe(0);
    expect(events('library.item_removed').filter((e) => e.payload.kind === 'episode').map((e) => e.payload.replacedBy).sort()).toEqual([r2, r3].sort());
  });

  it('a provisional movie whose file the owner links to an extra of another movie: its own state goes to that extra, never to the movie', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    expect(await put(`/video/api/v1/items/${p}/watched`)).toBe(204);
    expect(await watchlist(p)).toBe(204);
    const w = h.comp.ports.catalogWrite;
    const r = w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: 'Q7' }, fields: [{ source: 'manual', fetchedAt: 0, values: { title: 'Dune: Part Two' } }] }).itemId;
    const x = w.createExtra({ parentId: r, extraType: 'featurette', title: 'Dietro le quinte', numberIfTaken: false, fetchedAt: 0 }).itemId;
    h.db.$client.transaction(() => {
      const c = h.comp.ports.caseSettlement.settleCase(caseOf(f)!.id, 'resolved')!;
      h.comp.ports.catalogLinks.replaceManualLinks(f, [x]);
      h.comp.ports.caseSettlement.fileLeft(f, c.removedAutoLinks, [x]);
    })();
    expect(row(p)).toBeUndefined();
    expect([stateOn(x).watched, stateOn(r).watched]).toEqual([true, false]);
    expect(watchlisted()).toEqual([x]);
    expect(events('library.item_removed').map((e) => e.payload.replacedBy)).toEqual([x]);
  });

  it('a multi-episode file whose episodes do not pair keeps nothing of the file’s state (logged, not moved)', async () => {
    const f = episode('Dark (2017)/Season 01/Dark (2017) - S01E02-E03.mkv');
    await identify(f);
    const p2 = linksOf(f).map((l) => l.item_id).find((id) => one<{ n: number }>('SELECT episode_number AS n FROM catalog_item WHERE id = ?', id)!.n === 2)!;
    h.comp.ports.profilePlayback.recordProgress({ profileId: PROFILE, itemId: p2, fileId: f, positionMs: 10_000, durationMs: 30_000, at: 5_000, ended: false });
    // The owner links the file to two episodes numbered differently.
    const w = h.comp.ports.catalogWrite;
    const other = w.upsertWork({ kind: 'series', editionLabel: null, externalIds: { wikidata: 'Q3' }, fields: [{ source: 'manual', fetchedAt: 0, values: { title: 'Other' } }] }).itemId;
    const season = w.ensureSeason(other, 1).itemId;
    const targets = [w.ensureEpisode(season, 7).itemId, w.ensureEpisode(season, 8).itemId];
    h.db.$client.transaction(() => {
      const c = h.comp.ports.caseSettlement.settleCase(caseOf(f)!.id, 'resolved')!;
      h.comp.ports.catalogLinks.replaceManualLinks(f, targets);
      h.comp.ports.caseSettlement.fileLeft(f, c.removedAutoLinks, targets);
    })();
    expect(provisionalCount()).toBe(0);
    expect(targets.map((t) => stateOn(t).progress)).toEqual([null, null]);
  });
});

describe('a playback session on a provisional item', () => {
  const SESSIONS = '/video/api/v1/playback/sessions';
  /** For the 204 answers, which the harness has no contract body for. */
  const post = async (url: string, payload: object) => (await h.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${TOKEN}` }, payload })).statusCode;
  const progress = (id: string, positionMs: number, clientTs: number) => post(`${SESSIONS}/${id}/progress`, { positionMs, state: 'playing', clientTs });

  it('survives the identification: it follows its file, and progress and completion land on the real item (R4)', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    const started = await h.call('startPlayback', 'POST', SESSIONS, { itemId: p, capabilities: chrome() });
    expect(started.status).toBe(201);
    const id = started.body.sessionId as string;
    expect(await progress(id, 10_000, 1)).toBe(204);

    provider = 'up';
    await identify(f);
    const real = itemOf(f);
    expect(row(p)).toBeUndefined();
    expect(events('library.item_removed')[0]?.payload.replacedBy).toBe(real);

    h.clock.now += 1_000;
    expect(await progress(id, 20_000, 2)).toBe(204);
    expect(stateOn(real).progress).toBe(20_000);
    // A re-plan path reads the session's item: it finds the real one instead of ending the session.
    const version = await h.call('changeVersion', 'POST', `${SESSIONS}/${id}/version`, { fileId: f });
    expect(version.status).toBe(200);
    expect(version.body.itemId).toBe(real);
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toEqual([expect.objectContaining({ sessionId: id, itemId: real, itemTitle: 'Dune' })]);

    h.clock.now += 1_000;
    const durationMs = h.comp.ports.catalogRead.getPlayableItem(real)!.files[0]!.facts.durationMs!;
    expect(await post(`${SESSIONS}/${id}/stop`, { positionMs: durationMs })).toBe(204);
    expect(stateOn(real)).toMatchObject({ watched: true, progress: null });
    expect(events('playback.session_terminated')).toEqual([]);
  });

  it('a session on one episode of a multi-episode file follows it to the episode it paired with', async () => {
    const f = episode('Dark (2017)/Season 01/Dark (2017) - S01E02-E03.mkv');
    await identify(f);
    const byNumber = (id: string) => one<{ n: number }>('SELECT episode_number AS n FROM catalog_item WHERE id = ?', id)!.n;
    const numbered = (ids: string[]) => new Map(ids.map((id) => [byNumber(id), id]));
    const p = numbered(linksOf(f).map((l) => l.item_id));
    const started = await h.call('startPlayback', 'POST', SESSIONS, { itemId: p.get(2), fileId: f, capabilities: chrome() });
    expect(started.status).toBe(201);
    const id = started.body.sessionId as string;
    expect(await progress(id, 10_000, 1)).toBe(204);

    provider = 'up';
    await identify(f);
    const r = numbered(linksOf(f).map((l) => l.item_id));
    expect(linksOf(f)).toHaveLength(2); // the file holds two episodes: no single item of the file to follow
    h.clock.now += 1_000;
    expect(await progress(id, 20_000, 2)).toBe(204);
    expect(stateOn(r.get(2)!).progress).toBe(20_000);
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toEqual([expect.objectContaining({ sessionId: id, itemId: r.get(2) })]);
    // A sample sent with the other retired id goes to its own pair.
    h.comp.ports.profilePlayback.recordProgress({ profileId: PROFILE, itemId: p.get(3)!, fileId: f, positionMs: 5_000, durationMs: 30_000, at: h.clock.now, ended: false });
    expect(stateOn(r.get(3)!).progress).toBe(5_000);
    expect(events('playback.session_terminated')).toEqual([]);
  });

  it('a sample sent with the retired id all the same lands on the item its file shows under now', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    h.comp.ports.profilePlayback.recordProgress({ profileId: PROFILE, itemId: p, fileId: f, positionMs: 10_000, durationMs: 30_000, at: 1_000, ended: false });
    provider = 'up';
    await identify(f);
    const real = itemOf(f);
    h.comp.ports.profilePlayback.recordProgress({ profileId: PROFILE, itemId: p, fileId: f, positionMs: 29_900, durationMs: 30_000, at: 2_000, ended: true });
    expect(stateOn(real)).toMatchObject({ watched: true, progress: null });
  });

  it('ends with item_removed when its file is linked to no item any more (ignored)', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    const id = (await h.call('startPlayback', 'POST', SESSIONS, { itemId: p, capabilities: chrome() })).body.sessionId as string;
    expect((await h.call('ignoreCase', 'POST', `/video/api/v1/admin/cases/${caseOf(f)!.id}/ignore`)).status).toBe(200);
    const r = await h.app.inject({ method: 'POST', url: `${SESSIONS}/${id}/version`, headers: { authorization: `Bearer ${TOKEN}` }, payload: { fileId: f } });
    expect([r.statusCode, r.json().reason]).toEqual([410, 'item_removed']);
    expect(events('playback.session_terminated').map((e) => e.payload.reason)).toEqual(['item_removed']);
  });
});

describe('maintenance', () => {
  it('an owner decision taken while the providers were asked is kept, and the job does not retry (R5)', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv');
    await identify(f);
    const p = itemOf(f);
    const search = h.comp.ports.metadataSearch.search.bind(h.comp.ports.metadataSearch);
    let decided = false;
    h.comp.ports.metadataSearch.search = async (...args) => {
      if (!decided) {
        decided = true;
        expect((await h.call('ignoreCase', 'POST', `/video/api/v1/admin/cases/${caseOf(f)!.id}/ignore`)).status).toBe(200);
      }
      return search(...args);
    };
    expect(await identify(f)).toBe('done');
    expect([caseOf(f)?.state, fileState(f), linksOf(f), row(p)]).toEqual(['ignored', 'ignored', [], undefined]);
  });

  it('the periodic sweep retires provisional items no file is on any more (a deleted root)', async () => {
    const f = movie('Dune (2021)/Dune (2021).mkv', copia);
    await identify(f);
    const p = itemOf(f);
    await watchlist(p);
    h.db.$client.prepare('DELETE FROM library_root WHERE id = ?').run(copia); // files, links and case: cascade
    expect(row(p)).toBeDefined();
    await h.comp.periodic.find((t) => t.name === 'identifier.sweep_provisional')!.run();
    expect(row(p)).toBeUndefined();
    expect(watchlisted()).toEqual([]);
    expect(events('library.item_removed').map((e) => e.payload)).toEqual([{ itemId: p, kind: 'movie', parentId: null }]);
  });
});

// ---------------------------------------------------------------- migration 0004

describe('migration 0004 (catalog_item.provisional)', () => {
  const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('adds the column to a database with data: existing rows are not provisional, nothing else changes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'pzf-0004-'));
    dirs.push(base);
    // The migrations as they were before 0004.
    const before = join(base, 'migrations');
    cpSync(MIGRATIONS, before, { recursive: true });
    rmSync(join(before, '0004_catalog_item_provisional.sql'));
    const journalPath = join(before, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag !== '0004_catalog_item_provisional');
    writeFileSync(journalPath, JSON.stringify(journal));

    const path = join(base, 'video.db');
    const old = await openDb({ path, migrationsFolder: before });
    const exec = (sql: string) => old.$client.exec(sql);
    exec("INSERT INTO library_root (id, name, mount_path, hint, created_at) VALUES ('r', 'Film', '/media/Film', 'movies', 0)");
    exec("INSERT INTO media_file (id, root_id, rel_path, size_bytes, mtime_ms, state, created_at, updated_at) VALUES ('f', 'r', 'Dune (2021)/Dune (2021).mkv', 1, 0, 'identified', 0, 0)");
    exec("INSERT INTO catalog_item (id, kind, title, sort_title, year, added_at, updated_at) VALUES ('m', 'movie', 'Dune', 'dune', 2021, 0, 0)");
    exec("INSERT INTO media_link (id, file_id, item_id, origin, confidence, created_at) VALUES ('l', 'f', 'm', 'auto', 1, 0)");
    exec("INSERT INTO profile (id, name, prefs, created_at) VALUES ('p', 'Simone', '{}', 0)");
    exec("INSERT INTO playback_progress (profile_id, item_id, position_ms, duration_ms, file_id, client_ts, updated_at) VALUES ('p', 'm', 5, 10, 'f', 0, 0)");
    exec("INSERT INTO watchlist_entry (profile_id, item_id, added_at) VALUES ('p', 'm', 0)");
    expect((old.$client.prepare('SELECT * FROM catalog_item').get() as Record<string, unknown>).provisional).toBeUndefined();
    closeDb(old);

    const db = await openDb({ path, migrationsFolder: MIGRATIONS, backupDir: join(base, 'backup') });
    const get = (sql: string) => db.$client.prepare(sql).get() as Record<string, unknown>;
    expect(get("SELECT id, title, provisional FROM catalog_item WHERE id = 'm'")).toEqual({ id: 'm', title: 'Dune', provisional: 0 });
    expect([get('SELECT count(*) AS n FROM media_link').n, get('SELECT count(*) AS n FROM playback_progress').n, get('SELECT count(*) AS n FROM watchlist_entry').n]).toEqual([1, 1, 1]);
    // NOT NULL DEFAULT 0: a row written without the column is not provisional.
    db.$client.exec("INSERT INTO catalog_item (id, kind, title, sort_title, added_at, updated_at) VALUES ('n', 'movie', 'X', 'x', 0, 0)");
    expect(get("SELECT provisional FROM catalog_item WHERE id = 'n'").provisional).toBe(0);
    expect(() => db.$client.exec("UPDATE catalog_item SET provisional = NULL WHERE id = 'n'")).toThrow(/NOT NULL/);
    closeDb(db);

    // The schema of the migrated database is the schema of a new one.
    const cols = (d: Database.Database) => d.prepare("SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('catalog_item') ORDER BY cid").all();
    const freshDb = await openDb({ path: ':memory:' });
    const migrated = new Database(path, { readonly: true });
    expect(cols(migrated)).toEqual(cols(freshDb.$client));
    migrated.close();
    closeDb(freshDb);
  });
});
