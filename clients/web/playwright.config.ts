// Milestone e2e on the Compose stack (ADR 0005 point 6, doc 06 §4). One worker: the MVP allows one streaming
// session and the browser is a shared resource. Not part of `verify`: with the stack up, run
// `npm run e2e:smoke` (API only) or `npm run e2e` (smoke and the browsers), see deploy/README.md.
// Projects: `stack` (setup: health, scan, manual matches) runs first; `smoke` and every browser depend on it.
import { defineConfig, type Project } from '@playwright/test';

// No default: the suite creates an "E2E" profile and resolves "Da verificare" cases on the stack it runs against,
// so it must never land on the owner's stack by accident.
const baseURL = process.env.PZF_E2E_BASE_URL;
if (!baseURL) {
  throw new Error(
    'PZF_E2E_BASE_URL is not set: point it at a test stack, e.g. PZF_E2E_BASE_URL=http://localhost:18280 (deploy/README.md, "Test end-to-end"). ' +
      'There is no default, because the suite writes to the stack it runs against (an "E2E" profile, resolved cases).',
  );
}

// Real playback: autoplay with sound must not be blocked.
const chromiumArgs = ['--autoplay-policy=no-user-gesture-required'];
const BROWSER_ONLY = /\.spec\.ts$/;
const NOT_BROWSER = /(smoke\.spec|stack\.setup)\.ts$/;

const browsers: Project[] = [
  // Chrome for Testing as bundled by Playwright, in the full build (`channel: 'chromium'`): the default headless
  // shell has no HEVC decoder. Then the browsers installed on the host (`channel`).
  { name: 'chromium', use: { browserName: 'chromium', channel: 'chromium', launchOptions: { args: chromiumArgs } } },
  { name: 'edge', use: { channel: 'msedge', launchOptions: { args: chromiumArgs } } },
  { name: 'chrome', use: { channel: 'chrome', launchOptions: { args: chromiumArgs } } },
  // Firefox with a window, as S2 measured it: headless it drops most frames, and it says yes to HEVC without a
  // decoder (measured on Firefox 157, Windows 11).
  {
    name: 'firefox',
    use: { browserName: 'firefox', headless: false, launchOptions: { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } } },
  },
];

export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  use: {
    baseURL,
    locale: 'it-IT',
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'stack', testMatch: /stack\.setup\.ts$/ },
    { name: 'smoke', testMatch: /smoke\.spec\.ts$/, dependencies: ['stack'] },
    ...browsers.map((b) => ({ ...b, testMatch: BROWSER_ONLY, testIgnore: NOT_BROWSER, dependencies: ['stack'] })),
  ],
});
