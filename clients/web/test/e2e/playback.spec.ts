// Main flow (ADR 0005 point 6): profile → Home → detail → play → first frame → seek → progress → resume.
import { expect, test } from '@playwright/test';
import { API, bearer, clearProgress, ensureProfile, findItemId, openAs, PROFILE_NAME, player, positionMs, sampleOrSkip, skipUnlessDecodes, waitForPlayback } from './support.ts';

/** The "main" sample must be longer than this plus a margin (e.g. 2 minutes). */
const RESUME_PAST_MS = 35_000;

test('profile, Home, detail, play, seek, progress and resume', async ({ page, request }) => {
  const sample = sampleOrSkip(test, 'main');
  const { token } = await ensureProfile(request);
  const itemId = await findItemId(request, token, sample.title);
  test.skip(!itemId, `"${sample.title}" is not in the catalog`);
  await clearProgress(request, token, itemId ?? '');

  // Profile choice through the UI.
  await page.goto('/profiles');
  await skipUnlessDecodes(test, page, sample);
  await page.getByRole('button', { name: `Guarda come ${PROFILE_NAME}` }).click();
  await expect(page.getByRole('navigation', { name: 'Navigazione principale' })).toBeVisible();

  // Detail page and play.
  await page.goto(`/item/${itemId}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(sample.title);
  await page.getByRole('button', { name: 'Riproduci' }).click();
  await waitForPlayback(page, 2);

  // Seek +10 s from the keyboard, on the original timeline, until past the server's 30 s resume minimum
  // (profiles RESUME_MIN_POSITION_MS): a position before it is not offered as a resume.
  // The player has the focus since it opened. A short poll: plain playback must not pass for the seek.
  await expect(player(page)).toBeFocused();
  while ((await positionMs(page)) < RESUME_PAST_MS) {
    const before = await positionMs(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => positionMs(page), { timeout: 5_000 }).toBeGreaterThanOrEqual(before + 9_000);
  }
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

// Any sample that plays will do: the Direct Stream one, the one most browsers decode.
test('pagehide stops the session (keepalive)', async ({ page, request }) => {
  const sample = sampleOrSkip(test, 'directStream');
  const { token } = await openAs(page, request, '/');
  await skipUnlessDecodes(test, page, sample);
  const itemId = await findItemId(request, token, sample.title);
  test.skip(!itemId, `"${sample.title}" is not in the catalog`);
  await page.goto(`/watch/${itemId}?t=0`);
  await waitForPlayback(page, 1);
  await page.goto('about:blank');
  // The keepalive StopPlayback leaves with the page, so Playwright does not always see it as the page's request:
  // the server is asked instead. Without the stop the session would live until its timeout (SESSION_TIMEOUT_S, 60 s).
  const open = async () => {
    const res = await request.get(`${API}/playback/sessions`, { headers: bearer(token) });
    return ((await res.json()) as { sessions: unknown[] }).sessions.length;
  };
  await expect.poll(open, { timeout: 15_000 }).toBe(0);
});
