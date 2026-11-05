// Profiles with the real catalog (app harness): watched propagation through listPlayableDescendants,
// next up through describeItems, and the profile state the catalog shows in GetItem and GetNextUp.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { profilesModule } from '../src/modules/profiles/index.ts';
import { DEFAULT_PREFS } from '../src/modules/profiles/rules.ts';
import { harness, type Harness, PROFILE, TOKEN } from './helpers/app-harness.ts';
import { seedFile, seedLink, seedRoot } from './helpers/catalog-seed.ts';

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
});
