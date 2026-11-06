// Regression of S2 on the product stack (doc 05 §7.8.1): h1, h2, h6, c1, c4, c7 and s3 must keep playing with
// hls.js 1.7.4. If this fails, the fallback is hls.js 1.7.3, the version S2 measured.
import { expect, test } from '@playwright/test';
import {
  mediaFacts,
  missingSampleError,
  missingSampleReason,
  openAs,
  pgsCanvasHasPixels,
  player,
  requireItem,
  requireSample,
  type SampleId,
  samples,
  selectSubtitle,
  skipAllowed,
  skipUnlessDecodes,
  waitForPlayback,
  watchSession,
} from './support.ts';

const CASES: SampleId[] = ['h1', 'h2', 'h6', 'c1', 'c4', 'c7'];

for (const id of CASES) {
  // A case without a sample fails, or skips when PZF_E2E_ALLOW_SKIP allows it, before any browser context opens:
  // headed Firefox can hang closing a context it never used (Playwright 1.64, Firefox 157).
  if (!samples[id] && !skipAllowed(id)) {
    test(`S2 ${id} plays`, () => {
      throw missingSampleError(id);
    });
    continue;
  }
  test.describe(() => {
    test.skip(!samples[id], missingSampleReason(id));

    test(`S2 ${id} plays`, async ({ page, request }) => {
      const sample = requireSample(test, id);
      const { token } = await openAs(page, request, '/');
      await skipUnlessDecodes(test, page, sample);
      const itemId = await requireItem(test, request, token, id, sample);

      const session = watchSession(page);
      await page.goto(`/watch/${itemId}?t=0`);
      await waitForPlayback(page, 5);
      const facts = await mediaFacts(page);
      expect(facts?.error).toBeNull();
      expect(facts?.frames ?? 0).toBeGreaterThan(0);
      // S2: 0–3 dropped frames per window in HLS; allow a margin for a cold start.
      expect(facts?.dropped ?? 0).toBeLessThan(30);
      if (facts?.audioBytes !== null) expect(facts?.audioBytes ?? 0).toBeGreaterThan(0);
      for (const c of sample.codecs ?? []) expect(session()?.stream.mimeType ?? '').toContain(c);
      if (sample.mode) await expect(player(page)).toHaveAttribute('data-mode', sample.mode);
    });
  });
}

test('S2 s3: PGS on 4K HDR10 rendered by rVFC at its time', async ({ page, request }) => {
  const sample = requireSample(test, 's3');
  const { token } = await openAs(page, request, '/');
  await skipUnlessDecodes(test, page, sample);
  const itemId = await requireItem(test, request, token, 's3', sample);
  expect(sample.subtitleLanguage, 'sample "s3" needs subtitleLanguage, the language of its PGS track').toBeTruthy();
  const cue = sample.cueAtMs ?? 5_000;
  const session = watchSession(page);
  await page.goto(`/watch/${itemId}?t=${Math.max(0, cue - 2_000)}`);
  await waitForPlayback(page, 1);
  await selectSubtitle(page, session, sample.subtitleLanguage ?? '', 'image');
  await expect.poll(() => pgsCanvasHasPixels(page), { timeout: 15_000 }).toBe(true);
});
