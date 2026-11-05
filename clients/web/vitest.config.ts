// Unit and component tests (ADR 0005 point 6): Vitest with jsdom. Playwright specs live in test/e2e.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      setupFiles: ['./src/test/setup.ts'],
      restoreMocks: true,
    },
  }),
);
