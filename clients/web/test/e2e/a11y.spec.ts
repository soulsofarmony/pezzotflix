// axe on the main pages (ADR 0005 point 5): the second net behind eslint-plugin-jsx-a11y-x. Serious and critical
// violations fail the test; the others are attached to the report.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { findItemId, openAs, samples } from './support.ts';

const PAGES = ['/', '/browse?kind=movie', '/search?q=a', '/admin/cases', '/admin/roots', '/admin/ingest', '/admin/providers', '/about'];

async function check(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  await test.info().attach(`axe-${name}`, { body: JSON.stringify(result.violations, null, 2), contentType: 'application/json' });
  const blocking = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('profile choice', async ({ page }) => {
  await page.goto('/profiles');
  await expect(page.getByRole('heading', { name: 'Chi guarda?' })).toBeVisible();
  await check(page, 'profiles');
});

for (const path of PAGES) {
  test(`page ${path}`, async ({ page, request }) => {
    await openAs(page, request, path);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await check(page, path);
  });
}

test('item detail and player', async ({ page, request }) => {
  const title = samples.main?.title;
  test.skip(!title, 'sample "main" not configured (PZF_E2E_SAMPLES)');
  const { token } = await openAs(page, request, '/');
  const itemId = await findItemId(request, token, title ?? '');
  test.skip(!itemId, `"${title}" is not in the catalog`);
  await page.goto(`/item/${itemId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await check(page, 'item');
  await page.goto(`/watch/${itemId}?t=0`);
  await expect(page.locator('[data-phase="ready"]')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('k');
  await check(page, 'player');
});
