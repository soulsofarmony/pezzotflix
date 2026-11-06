// Direct Stream over HLS, a far seek that restarts the pipeline (timeline + PGS, doc 05 §7.8.7), and the automatic
// re-plan after a forced failure (doc 04 §8).
import { expect, test } from '@playwright/test';
import { mediaFacts, openAs, pgsCanvasHasPixels, player, positionMs, requireItem, requireSample, selectSubtitle, skipUnlessDecodes, waitForPlayback, watchSession } from './support.ts';

/**
 * |timelineOffsetMs| above this means the mapping to the original timeline is off: the offset only absorbs where
 * hls.js puts the first fragment it loads, a fraction of a segment. Forgetting mediaTimestampOffsetMs (10 s), or an
 * offset left from another fragment, shows up here.
 */
const MAX_TIMELINE_OFFSET_MS = 2_000;

test('Direct Stream: hls-fmp4 plays with the mode the server chose', async ({ page, request }) => {
  const sample = requireSample(test, 'directStream');
  const { token } = await openAs(page, request, '/');
  await skipUnlessDecodes(test, page, sample);
  const itemId = await requireItem(test, request, token, 'directStream', sample);
  await page.goto(`/watch/${itemId}?t=0`);
  await waitForPlayback(page, 3);
  await expect(player(page)).toHaveAttribute('data-protocol', 'hls-fmp4');
  if (sample.mode) await expect(player(page)).toHaveAttribute('data-mode', sample.mode);
  const facts = await mediaFacts(page);
  expect(facts?.error).toBeNull();
  expect(facts?.audioBytes ?? 1).toBeGreaterThan(0);

  // "Perché questa modalità?" explains the plan.
  await page.getByRole('button', { name: 'Perché questa modalità?' }).click();
  await expect(page.getByRole('region', { name: 'Perché questa modalità?' })).toBeVisible();
});

test('far seek: the pipeline restarts and positions stay on the original timeline', async ({ page, request }) => {
  const sample = requireSample(test, 'farSeek');
  const { token } = await openAs(page, request, '/');
  await skipUnlessDecodes(test, page, sample);
  const itemId = await requireItem(test, request, token, 'farSeek', sample);
  const session = watchSession(page);
  await page.goto(`/watch/${itemId}?t=0`);
  await waitForPlayback(page, 2);
  const offsetBefore = Number(await player(page).getAttribute('data-timeline-offset-ms'));

  // Seek far ahead, with the controller's mapping: currentTime = (X − timelineOffsetMs) / 1000.
  const target = sample.cueAtMs ?? 3_600_000;
  const landedS = await page.evaluate((ms) => {
    const v = document.querySelector('video');
    if (!v) throw new Error('no video');
    const off = Number(document.querySelector('[data-phase]')?.getAttribute('data-timeline-offset-ms') ?? 0);
    v.currentTime = (ms - off) / 1000;
    return v.currentTime;
  }, target);
  // Playback from the seek on, not the seconds played before it.
  await waitForPlayback(page, 1, landedS);
  await expect.poll(() => positionMs(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(target - 1_000);
  expect(await positionMs(page)).toBeLessThan(target + 15_000);

  // The offset stays a small correction, before and after the restart from the far position.
  const offsetAfter = Number(await player(page).getAttribute('data-timeline-offset-ms'));
  test.info().annotations.push({ type: 'timeline', description: `offset before ${offsetBefore} ms, after ${offsetAfter} ms` });
  for (const off of [offsetBefore, offsetAfter]) {
    expect(Number.isFinite(off)).toBe(true);
    expect(Math.abs(off)).toBeLessThan(MAX_TIMELINE_OFFSET_MS);
  }

  if (sample.subtitleLanguage) {
    await selectSubtitle(page, session, sample.subtitleLanguage, 'image');
    await expect.poll(() => pgsCanvasHasPixels(page), { timeout: 20_000 }).toBe(true);
  }
});

test('forced failure: the client re-plans on its own, without asking', async ({ page, request }) => {
  const sample = requireSample(test, 'replan');
  const { token } = await openAs(page, request, '/');
  await skipUnlessDecodes(test, page, sample);
  const itemId = await requireItem(test, request, token, 'replan', sample);
  // The first stream's media answers 500 STREAM_FAILED, a fatal data-plane error: the client must call
  // reportPlaybackFailure and play the plan it gets back. (forceMode cannot force a failure: the server refuses,
  // with 422, a forced mode that the declared capabilities rule out.)
  let failedToken: string | null = null;
  await page.route(/\/video\/media\/s\/[^/]+\/(file|hls\/(init|seg)-[^/]+)$/, async (route) => {
    const streamToken = /\/video\/media\/s\/([^/]+)\//.exec(route.request().url())?.[1] ?? null;
    failedToken ??= streamToken;
    if (streamToken !== failedToken) return route.continue();
    return route.fulfill({
      status: 500,
      contentType: 'application/problem+json',
      body: JSON.stringify({ type: 'https://pezzotflix.local/problems/stream-failed', title: 'Stream could not be produced', status: 500, code: 'STREAM_FAILED' }),
    });
  });
  const failures: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/failure$/.test(r.url())) failures.push(r.postData() ?? '');
  });
  await page.goto(`/watch/${itemId}?t=0`);
  await waitForPlayback(page, 2);
  expect(failures.length).toBeGreaterThanOrEqual(1);
  expect(Number(await player(page).getAttribute('data-attempts'))).toBeLessThanOrEqual(3);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
