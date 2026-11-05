// Real-browser wiring of the player: hls.js light and libpgs load on demand, in their own chunks.
import { browserCapabilityEnv, outputChannels, probeCapabilities } from './capabilities.ts';
import type { PlayerDeps } from './controller.ts';
import { createHlsEngine, type HlsClass } from './hls.ts';
import { createProgressiveEngine } from './progressive.ts';
import type { PgsFactory } from './subtitles.ts';
import { consoleLogger, type Logger, type PlaybackApi } from './types.ts';

let hlsLoad: Promise<{ Hls: HlsClass; workerPath: string }> | null = null;

/** hls.js light (ESM) with the transmux worker passed as workerPath (doc 05 §7.8.1). */
export function loadHls(): Promise<{ Hls: HlsClass; workerPath: string }> {
  hlsLoad ??= Promise.all([import('hls.js/light'), import('hls.js/dist/hls.worker.js?url')]).then(([m, w]) => ({ Hls: m.default, workerPath: w.default }));
  return hlsLoad;
}

let pgsLoad: Promise<PgsFactory> | null = null;

/** libpgs 0.9.0 in the S2 configuration: the renderer gets the video, the worker url and the .sup url. */
export function loadPgs(): Promise<PgsFactory> {
  pgsLoad ??= Promise.all([import('libpgs'), import('libpgs/dist/libpgs.worker.js?url')]).then(
    ([m, w]): PgsFactory =>
      (opts) =>
        new m.PgsRenderer({ video: opts.video, subUrl: opts.subUrl, timeOffset: opts.timeOffset, workerUrl: w.default }),
  );
  return pgsLoad;
}

export function browserPlayerDeps(api: PlaybackApi, log: Logger = consoleLogger): PlayerDeps {
  return {
    api,
    async probe(video) {
      const { Hls } = await loadHls();
      const hlsSupported = Hls.isSupported();
      const env = browserCapabilityEnv(video, () => hlsSupported, __APP_VERSION__);
      const capabilities = await probeCapabilities(env);
      log('info', 'capabilities', { capabilities, outputChannels: outputChannels() });
      return { capabilities, preflightEnv: { isTypeSupported: env.isTypeSupported, canPlayType: env.canPlayType }, hlsSupported };
    },
    async createEngine(video, session, cb, pre) {
      const audio = session.tracks.audio.find((t) => t.selected) ?? null;
      if (session.stream.protocol === 'hls-fmp4') {
        const { Hls, workerPath } = await loadHls();
        return createHlsEngine(video, session.stream, audio, cb, { Hls, workerPath, isTypeSupported: pre.isTypeSupported });
      }
      return createProgressiveEngine(video, session.stream.url, session.tracks.audio.length > 0, cb, { fetch: globalThis.fetch.bind(globalThis) });
    },
    subtitles: { loadPgs, growingVtt: 'track', fetch: globalThis.fetch.bind(globalThis) },
    log,
    win: window,
  };
}
