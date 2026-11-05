// Main flow (ADR 0005 point 6): profile → Home → detail → play → first frame → seek → progress → resume.
import { expect, test } from '@playwright/test';
import { clearProgress, ensureProfile, findItemId, openAs, PROFILE_NAME, player, positionMs, sampleOrSkip, waitForPlayback } from './support.ts';

test('profile, Home, detail, play, seek, progress and resume', async ({ page, request }) => {
  const sample = sampleOrSkip(test, 'main');
  const { token } = await ensureProfile(request);
  const itemId = await findItemId(request, token, sample.title);
  test.skip(!itemId, `"${sample.title}" is not in the catalog`);
  await clearProgress(request, token, itemId ?? '');

  // Profile choice through the UI.
  await page.goto('/profiles');
  await page.getByRole('button', { name: `Guarda come ${PROFILE_NAME}` }).click();
  await expect(page.getByRole('navigation', { name: 'Navigazione principale' })).toBeVisible();

  // Detail page and play.
  await page.goto(`/item/${itemId}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(sample.title);
  await page.getByRole('button', { name: 'Riproduci' }).click();
  await waitForPlayback(page, 2);

  // Seek +10 s from the keyboard, on the original timeline.
  const before = await positionMs(page);
  await player(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => positionMs(page)).toBeGreaterThanOrEqual(before + 9_000);
  await waitForPlayback(page, 1);

  // Pause: reportProgress goes at once; leave the player (stopPlayback).
  await page.keyboard.press('k');
  await expect(player(page)).toHaveAttribute('data-phase', 'ready');
  const paused = await positionMs(page);
  await page.getByRole('button', { name: 'Esci dalla riproduzione' }).click();

  // The detail page now offers to resume near the paused position, and resume starts there.
  const resume = page.getByRole('button', { name: /^Riprendi da / });
  await expect(resume).toBeVisible();
  await resume.click();
  await waitForPlayback(page, 1);
  expect(Math.abs((await positionMs(page)) - paused)).toBeLessThan(5_000);
});

test('pagehide stops the session (keepalive)', async ({ page, request }) => {
  const sample = sampleOrSkip(test, 'main');
  const { token } = await openAs(page, request, '/');
  const itemId = await findItemId(request, token, sample.title);
  test.skip(!itemId, `"${sample.title}" is not in the catalog`);
  await page.goto(`/watch/${itemId}?t=0`);
  await waitForPlayback(page, 1);
  const stop = page.waitForRequest((r) => r.method() === 'POST' && /\/playback\/sessions\/[^/]+\/stop$/.test(r.url()));
  await page.goto('about:blank');
  await stop;
  const sessions = await request.get('/video/api/v1/playback/sessions', { headers: { Authorization: `Bearer ${token}` } });
  const body = (await sessions.json()) as { sessions?: unknown[] } | unknown[];
  expect(Array.isArray(body) ? body : (body.sessions ?? [])).toHaveLength(0);
});
