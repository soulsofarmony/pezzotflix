// Milestone e2e on the Compose stack (ADR 0005 point 6): Edge and Chrome as installed on the host (`channel`),
// one worker because the MVP allows one streaming session and the browser is a shared resource. Not part of
// `verify`: run `npm run e2e -w @pezzotflix/web` with the stack up and the S2 samples ingested.
import { defineConfig } from '@playwright/test';

const baseURL = process.env.PZF_E2E_BASE_URL ?? 'http://localhost:8080';

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
    // Real playback: autoplay with sound must not be blocked, and the GPU decodes HEVC.
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [
    { name: 'edge', use: { channel: 'msedge' } },
    { name: 'chrome', use: { channel: 'chrome' } },
  ],
});
