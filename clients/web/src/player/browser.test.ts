import { describe, expect, it, vi } from 'vitest';
import { browserPlayerDeps } from './browser.ts';
import type { PlaybackApi } from './types.ts';

describe('browser wiring of the player', () => {
  it('reads a growing WebVTT with fetch, the strategy that can abort its long response (F2 review, point 8)', () => {
    const deps = browserPlayerDeps({} as PlaybackApi, vi.fn());
    expect(deps.subtitles.growingVtt).toBe('fetch');
  });
});
