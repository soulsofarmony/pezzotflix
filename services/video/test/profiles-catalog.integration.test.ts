// Profiles with the real catalog (app harness): watched propagation through listPlayableDescendants,
// next up through describeItems, and the profile state the catalog shows in GetItem and GetNextUp.
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- response bodies are untyped JSON, checked against the contract by the harness */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { profilesModule } from '../src/modules/profiles/index.ts';
import { DEFAULT_PREFS } from '../src/modules/profiles/rules.ts';
import { harness, type Harness, PROFILE, TOKEN } from './helpers/app-harness.ts';
import { seedCase, seedFile, seedLink, seedRoot } from './helpers/catalog-seed.ts';

let h: Harness;

beforeEach(async () => {
  h = await harness({ extra: [profilesModule({ tokenKey: randomBytes(32) })] });
  // The harness verifies its fixed token as PROFILE: give that profile a row.
  h.db.$client.prepare('INSERT INTO profile (id, name, avatar, prefs, created_at) VALUES (?, ?, NULL, ?, 0)').run(PROFILE, 'Simone', JSON.stringify(DEFAULT_PREFS));
});
afterEach(async () => h.close());

function seedSeries() {
  const w = h.comp.ports.catalogWrite;
  const root = seedRoot(h.db, 'Serie', { hint: 'series' });
  const dark = w.upsertWork({
    kind: 'series',
    editionLabel: null,
    externalIds: { wikidata: 'Q24300155' },
    fields: [{ source: 'wikidata', fetchedAt: h.clock.now, values: { title: 'Dark', year: 2017 } }],
  }).itemId;
  const ep = (season: number, n: number, linked = true) => {
    const seasonId = w.ensureSeason(dark, season).itemId;
    const id = w.ensureEpisode(seasonId, n).itemId;
    if (linked) seedLink(h.db, seedFile(h.db, root, `Dark (2017)/Season 0${season}/Dark - S0${season}E0${n}.mkv`, 'dark'), id);
    return id;
  };
  const special = ep(0, 1);
  const s1 = [ep(1, 1), ep(1, 2)];
  const s2e1 = ep(2, 1);
  const s2e2 = ep(2, 2, false); // no file: not playable
  return { dark, season1: w.ensureSeason(dark, 1).itemId, special, s1, s2e1, s2e2 };
}

async function put(url: string) {
  const r = await h.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${TOKEN}` } });
  return r.statusCode;
}

describe('profiles + real catalog', () => {
  it('mark season 1 watched → next up is S2E1, the series is half watched', async () => {
    const lib = seedSeries();
    const before = await h.call('getNextUp', 'GET', `/video/api/v1/items/${lib.dark}/next-up`);
    expect(before.body.item.id).toBe(lib.s1[0]); // specials last

    expect(await put(`/video/api/v1/items/${lib.season1}/watched`)).toBe(204);

    const next = await h.call('getNextUp', 'GET', `/video/api/v1/items/${lib.dark}/next-up`);
    expect(next.body.item.id).toBe(lib.s2e1);

    const series = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.dark}`)).body;
    // 2 of 4 playable episodes watched (S2E2 has no file, so it is not counted).
    expect(series.state).toMatchObject({ watched: false, progressPercent: 50, inWatchlist: false });
    const season = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.season1}`)).body;
    expect(season.state).toMatchObject({ watched: true, progressPercent: 100 });
    const e1 = (await h.call('getItem', 'GET', `/video/api/v1/items/${lib.s1[0]}`)).body;
    expect(e1.state).toMatchObject({ watched: true, playCount: 1, resumePositionMs: null });
  });

  it('after S2E1 the remaining playable episode is the special', async () => {
    const lib = seedSeries();
    expect(await put(`/video/api/v1/items/${lib.season1}/watched`)).toBe(204);
    h.clock.now += 1000;
    expect(await put(`/video/api/v1/items/${lib.s2e1}/watched`)).toBe(204);
    const next = await h.call('getNextUp', 'GET', `/video/api/v1/items/${lib.dark}/next-up`);
    expect(next.body.item.id).toBe(lib.special);
  });

  it('Home: next up follows Continue watching, per played series, and never repeats an episode in progress', async () => {
    const lib = seedSeries();
    const rowIds = async () => (await h.call('getHome', 'GET', '/video/api/v1/home')).body.rows.map((r: { id: string }) => r.id);
    const sample = (itemId: string, positionMs: number, ended: boolean) =>
      h.comp.ports.profilePlayback.recordProgress({ profileId: PROFILE, itemId, fileId: 'f', positionMs, durationMs: 3_000_000, at: (h.clock.now += 1000), ended });
    expect(await rowIds()).not.toContain('next_up'); // nothing played yet

    sample(lib.s1[0]!, 3_000_000, true); // S1E1 watched to the end
    const home = (await h.call('getHome', 'GET', '/video/api/v1/home')).body;
    expect(home.rows.map((r: { id: string }) => r.id).slice(0, 2)).toEqual(['next_up', 'recently_added']);
    expect(home.rows[0]).toMatchObject({ title: 'Prossimi episodi', nextCursor: null });
    expect(home.rows[0].query).toBeUndefined();
    expect(home.rows[0].items).toMatchObject([{ id: lib.s1[1], kind: 'episode', seriesTitle: 'Dark', seasonNumber: 1, episodeNumber: 2 }]);

    sample(lib.s1[1]!, 600_000, false); // S1E2 in progress: Continue watching shows it, next up does not
    const after = (await h.call('getHome', 'GET', '/video/api/v1/home')).body;
    expect(after.rows.map((r: { id: string }) => r.id).slice(0, 2)).toEqual(['continue_watching', 'recently_added']);
    expect(after.rows[0].items.map((i: { id: string; seriesTitle?: string }) => [i.id, i.seriesTitle])).toEqual([[lib.s1[1], 'Dark']]);
  });

  it('a file re-linked by the admin takes its progress, history and watched state to the new item', async () => {
    const w = h.comp.ports.catalogWrite;
    const movie = (title: string, qid: string) =>
      w.upsertWork({ kind: 'movie', editionLabel: null, externalIds: { wikidata: qid }, fields: [{ source: 'wikidata', fetchedAt: 0, values: { title } }] }).itemId;
    const wrong = movie('Blade Runner', 'Q184843');
    const right = movie('Blade Runner 2049', 'Q21451539');
    const root = seedRoot(h.db, 'Film');
    const fileId = seedFile(h.db, root, 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv', 'br2049');
    seedLink(h.db, fileId, wrong, 'auto');
    const caseId = seedCase(h.db, fileId, { state: 'auto_matched', parsed: { kind: 'movie', title: 'Blade Runner 2049', year: 2017, workFolder: 'Blade Runner 2049 (2017)', workKind: 'movie', warnings: [] } });
    const playback = h.comp.ports.profilePlayback;
    // Watched to the end on the misidentified item, then a rewatch started hours later.
    const completedAt = (h.clock.now += 1000);
    playback.recordProgress({ profileId: PROFILE, itemId: wrong, fileId, positionMs: 30_005, durationMs: 30_005, at: completedAt, ended: true });
    playback.recordProgress({ profileId: PROFILE, itemId: wrong, fileId, positionMs: 3_000, durationMs: 30_005, at: (h.clock.now += 3 * 3_600_000), ended: false, audioTrackId: 's2' });
    const history = () => h.db.$client.prepare('SELECT item_id AS itemId, completed FROM viewing_record ORDER BY started_at').all();
    const watched = () => h.db.$client.prepare('SELECT item_id AS itemId, watched, watched_at AS at, play_count AS plays FROM watch_state ORDER BY watched').all();
    expect(history()).toEqual([{ itemId: wrong, completed: 1 }, { itemId: wrong, completed: 0 }]);

    const r = await h.call('resolveCase', 'POST', `/video/api/v1/admin/cases/${caseId}/resolve`, { action: 'link_item', itemId: right });
    expect(r.status).toBe(200);
    expect(playback.resumePositionMs(PROFILE, wrong)).toBeNull();
    expect(h.db.$client.prepare('SELECT item_id AS itemId, file_id AS fileId, position_ms AS pos FROM playback_progress').all()).toEqual([{ itemId: right, fileId, pos: 3_000 }]);
    expect(playback.lastTrackChoice(PROFILE, right)).toMatchObject({ fileId, audioTrackId: 's2' });
    expect((await h.call('getItem', 'GET', `/video/api/v1/items/${right}`)).body.state).toMatchObject({ watched: true, progressPercent: 10, playCount: 1 });
    expect(history()).toEqual([{ itemId: right, completed: 1 }, { itemId: right, completed: 0 }]);
    expect(watched()).toEqual([
      { itemId: wrong, watched: 0, at: null, plays: 0 },
      { itemId: right, watched: 1, at: completedAt, plays: 1 },
    ]);
  });
});
