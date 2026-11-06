// Regression of S2 on the product stack (doc 05 §7.8.1): h1, h2, h6, c1, c4, c7 and s3 must keep playing with
// hls.js 1.7.4. If this fails, the fallback is hls.js 1.7.3, the version S2 measured.
import { expect, test } from '@playwright/test';
import { findItemId, mediaFacts, openAs, pgsCanvasHasPixels, player, type SampleId, samples, sampleOrSkip, skipUnlessDecodes, waitForPlayback } from './support.ts';

const CASES: SampleId[] = ['h1', 'h2', 'h6', 'c1', 'c4', 'c7'];

for (const id of CASES) {
  test.describe(() => {
    // A case without a sample is skipped before its browser context opens: headed Firefox can hang closing a
    // context it never used (Playwright 1.64, Firefox 157).
    test.skip(!samples[id], `sample "${id}" not configured (PZF_E2E_SAMPLES)`);

    test(`S2 ${id} plays`, async ({ page, request }) => {
      const sample = sampleOrSkip(test, id);
      const { token } = await openAs(page, request, '/');
      await skipUnlessDecodes(test, page, sample);
      const itemId = await findItemId(request, token, sample.title);
      test.skip(!itemId, `"${sample.title}" is not in the catalog`);

      let mimeType: string | null = null;
      page.on('response', (r) => {
        if (r.request().method() === 'POST' && /\/playback\/sessions(\/[^/]+\/(failure|tracks|version))?$/.test(r.url()) && r.ok()) {
          void r.json().then((s: { stream?: { mimeType?: string } }) => {
            mimeType = s.stream?.mimeType ?? mimeType;
          });
        }
      });
      await page.goto(`/watch/${itemId}?t=0`);
      await waitForPlayback(page, 5);
      const facts = await mediaFacts(page);
      expect(facts?.error).toBeNull();
      expect(facts?.frames ?? 0).toBeGreaterThan(0);
      // S2: 0–3 dropped frames per window in HLS; allow a margin for a cold start.
      expect(facts?.dropped ?? 0).toBeLessThan(30);
      if (facts?.audioBytes !== null) expect(facts?.audioBytes ?? 0).toBeGreaterThan(0);
      for (const c of sample.codecs ?? []) expect(mimeType ?? '').toContain(c);
      if (sample.mode) await expect(player(page)).toHaveAttribute('data-mode', sample.mode);
    });
  });
}

test('S2 s3: PGS on 4K HDR10 rendered by rVFC at its time', async ({ page, request }) => {
  const sample = sampleOrSkip(test, 's3');
  const { token } = await openAs(page, request, '/');
  await skipUnlessDecodes(test, page, sample);
  const itemId = await findItemId(request, token, sample.title);
  test.skip(!itemId, `"${sample.title}" is not in the catalog`);
  const cue = sample.cueAtMs ?? 5_000;
  await page.goto(`/watch/${itemId}?t=${Math.max(0, cue - 2_000)}`);
  await waitForPlayback(page, 1);
  await page.getByRole('button', { name: 'Audio e sottotitoli' }).click();
  const subs = page.getByRole('group', { name: 'Sottotitoli' });
  await subs.getByRole('radio').nth(1).check();
  await page.keyboard.press('Escape');
  await expect(player(page)).not.toHaveAttribute('data-subtitle', '');
  await expect.poll(() => pgsCanvasHasPixels(page), { timeout: 15_000 }).toBe(true);
});
