// Progressive engine: native <video src> (Direct Play of the original, or progressive fMP4). Range requests and
// seeks are the browser's (doc 04 §6.2). Watches the audio that disappears without an error (S2 H1).
// A NETWORK or SRC_NOT_SUPPORTED error carries no HTTP status: the url is probed, so a closed session (410), a
// server error (5xx) and a lost network get the same treatment as in hls.js.
import type { Engine, EngineCallbacks } from './engine.ts';
import { audioDecoded, classifyMediaError, classifyProbe, type FailureAction, MEDIA_ERR } from './failures.ts';
import { probeUrl } from './probe.ts';

/** Seconds of advancing playback before the silent-audio check (doc 05 §7.8.5). */
export const AUDIO_CHECK_AFTER_S = 4;

export interface ProgressiveEngineDeps {
  fetch: typeof fetch;
}

export function createProgressiveEngine(video: HTMLVideoElement, url: string, hasAudioTrack: boolean, cb: EngineCallbacks, deps: ProgressiveEngineDeps): Engine {
  let destroyed = false;
  let networkRetried = false;
  let pendingSeekS: number | null = null;
  let played = 0;
  let lastTime: number | null = null;
  let audioChecked = !hasAudioTrack;

  const onLoadedMetadata = () => {
    if (pendingSeekS !== null && pendingSeekS > 0) video.currentTime = pendingSeekS;
    pendingSeekS = null;
  };

  const onTimeUpdate = () => {
    const t = video.currentTime;
    if (lastTime !== null && !video.paused && !video.seeking) {
      const d = t - lastTime;
      if (d > 0 && d < 1) played += d;
    }
    lastTime = t;
    if (!audioChecked && played >= AUDIO_CHECK_AFTER_S) {
      audioChecked = true;
      if (audioDecoded(video) === false) {
        cb.log('warn', 'audio not decoded after playback started', { played });
        cb.onFailure({ kind: 'replan', suspect: 'audio', error: 'AUDIO_NOT_DECODED' });
      }
    }
  };

  const onSeeking = () => {
    lastTime = null;
  };

  const handle = (action: FailureAction, code: number) => {
    if (destroyed) return;
    cb.log('warn', 'media element error', { code, action: action.kind });
    if (action.kind === 'ignore') return;
    if (action.kind === 'reload') {
      // One new attempt by the browser, from where it stopped (or from the start target, if it never got there).
      networkRetried = true;
      pendingSeekS ??= video.currentTime;
      video.src = url;
      video.load();
      return;
    }
    cb.onFailure(action);
  };

  const onError = () => {
    if (destroyed) return;
    const err = video.error;
    if (!err) return;
    if (err.code !== MEDIA_ERR.NETWORK && err.code !== MEDIA_ERR.SRC_NOT_SUPPORTED) {
      handle(classifyMediaError(err.code, audioDecoded(video), networkRetried), err.code);
      return;
    }
    const code = err.code;
    void probeUrl(url, deps.fetch).then((st) => {
      if (destroyed) return;
      handle(classifyProbe(st) ?? classifyMediaError(code, audioDecoded(video), networkRetried), code);
    });
  };

  video.addEventListener('loadedmetadata', onLoadedMetadata);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('seeking', onSeeking);
  video.addEventListener('error', onError);

  return {
    protocol: 'progressive',
    start(startS) {
      if (destroyed) return;
      pendingSeekS = startS;
      video.preload = 'auto';
      video.src = url;
      video.load();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // jsdom and detached elements
      }
    },
  };
}
