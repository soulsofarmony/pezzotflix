// PlaybackSession.trickplay (ADR 0009 D4) composed from StreamHandle.locators.trickplay: null without previews,
// the sheets under the stream's token with them, and new urls after a re-plan. Responses checked against the
// contract by the harness.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aac, chrome, facts, file, sdr1080 } from './playback-fixtures.ts';
import { type PlaybackHarness, playbackHarness } from './playback-harness.ts';

const ITEM = '01936f0e-0000-7000-8000-0000000000b2';
const F2 = '01936f0e-0000-7000-8000-000000000f02';
const SESSIONS = '/video/api/v1/playback/sessions';
const GRID = { intervalMs: 10_000, tileWidth: 320, tileHeight: 180, columns: 10, rows: 10, count: 1000 };

let h: PlaybackHarness;
beforeEach(async () => {
  h = await playbackHarness();
  h.catalog.items.set(ITEM, { itemId: ITEM, kind: 'movie', title: 'Psyco', durationMs: 10_000_000, files: [file(F2, facts([sdr1080(), aac(1, 'ita')], { durationMs: 10_000_000 }))] });
});
afterEach(async () => h.close());

const start = () => h.call('startPlayback', 'POST', SESSIONS, { capabilities: chrome(), itemId: ITEM });

describe('PlaybackSession.trickplay', () => {
  it('is null while the file has no previews', async () => {
    const r = await start();
    expect(r.status).toBe(201);
    expect(r.body.trickplay).toBeNull();
  });

  it('carries the sheets of the stream, and new ones after a re-plan', async () => {
    h.delivery.trickplay = GRID;
    const r = await start();
    expect(r.body.trickplay).toEqual({ ...GRID, sheets: Array.from({ length: 10 }, (_, k) => `/video/media/s/token000000000001/trickplay/sheet-${k}.jpg`) });
    const id = r.body.sessionId as string;
    const again = await h.call('reportPlaybackFailure', 'POST', `${SESSIONS}/${id}/failure`, { positionMs: 60_000, error: 'MEDIA_ERR_DECODE', suspect: 'audio' });
    expect(again.status).toBe(200);
    expect(again.body.trickplay.sheets[0]).toBe('/video/media/s/token000000000002/trickplay/sheet-0.jpg');
    expect(again.body.trickplay.sheets).toHaveLength(10);
  });
});
