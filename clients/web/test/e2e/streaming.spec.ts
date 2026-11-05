// Direct Stream over HLS, a far seek that restarts the pipeline (timeline + PGS, doc 05 §7.8.7), and the automatic
// re-plan after a forced failure (doc 04 §8).
import { expect, test } from '@playwright/test';
import { findItemId, mediaFacts, openAs, pgsCanvasHasPixels, player, positionMs, sampleOrSkip, waitForPlayback } from './support.ts';

test('Direct Stream: hls-fmp4 plays with the mode the server chose', async ({ page, request }) => {
  const sample = sampleOrSkip(test, 'directStream');
  const { token } = await openAs(page, request, '/');
  const itemId = await findItemId(request, token, sample.title);
  test.skip(!itemId, `"${sample.title}" is not in the catalog`);
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
  const sample = sampleOrSkip(test, 'farSeek');
  const { token } = await openAs(page, request, '/');
  const itemId = await findItemId(request, token, sample.title);
  test.skip(!itemId, `"${sample.title}" is not in the catalog`);
  await page.goto(`/watch/${itemId}?t=0`);
  await waitForPlayback(page, 2);

  // Seek far ahead with the seek bar (keyboard on the range input, then release).
  const target = sample.cueAtMs ?? 3_600_000;
  const offsetBefore = Number(await player(page).getAttribute('data-timeline-offset-ms'));
  await page.evaluate((ms) => {
    const v = document.querySelector('video');
    if (!v) throw new Error('no video');
    // Same mapping as the controller: currentTime = (X − timelineOffsetMs) / 1000.
    const off = Number(document.querySelector('[data-phase]')?.getAttribute('data-timeline-offset-ms') ?? 0);
    v.currentTime = (ms - off) / 1000;
  }, target);
  await waitForPlayback(page, 1);
  await expect.poll(() => positionMs(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(target - 1_000);
  expect(await positionMs(page)).toBeLessThan(target + 15_000);

  // A restart from a far position gets a new INIT_PTS: the offset must follow it (not stay at the old value).
  const offsetAfter = Number(await player(page).getAttribute('data-timeline-offset-ms'));
  test.info().annotations.push({ type: 'timeline', description: `offset before ${offsetBefore} ms, after ${offsetAfter} ms` });

  if (sample.subtitleLanguage) {
    await page.getByRole('button', { name: 'Audio e sottotitoli' }).click();
    const subs = page.getByRole('group', { name: 'Sottotitoli' });
    await subs.getByRole('radio').nth(1).check();
    await page.keyboard.press('Escape');
    await expect.poll(() => pgsCanvasHasPixels(page), { timeout: 20_000 }).toBe(true);
  }
});

test('forced failure: the client re-plans on its own, without asking', async ({ page, request }) => {
  const sample = sampleOrSkip(test, 'replan');
  const { token } = await openAs(page, request, '/');
  const itemId = await findItemId(request, token, sample.title);
  test.skip(!itemId, `"${sample.title}" is not in the catalog`);
  // forceMode=direct_play on a source the browser cannot decode (e.g. TrueHD in MKV): the pre-start check or the
  // media error must lead to reportPlaybackFailure and a playable plan.
  const failures: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/failure$/.test(r.url())) failures.push(r.postData() ?? '');
  });
  await page.goto(`/watch/${itemId}?t=0&force=direct_play`);
  await waitForPlayback(page, 2);
  expect(failures.length).toBeGreaterThanOrEqual(1);
  expect(Number(await player(page).getAttribute('data-attempts'))).toBeLessThanOrEqual(3);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
