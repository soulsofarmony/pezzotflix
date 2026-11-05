// A jsdom <video> whose media state the test controls: jsdom has no media pipeline, so currentTime, paused,
// play() and the frame callbacks are faked on the instance. Events are real DOM events.
import { vi } from 'vitest';

type FrameCallback = (now: number, md: { mediaTime: number }) => void;

export interface MediaState {
  currentTime: number;
  paused: boolean;
  seeking: boolean;
  error: { code: number; message: string } | null;
  volume: number;
  muted: boolean;
  buffered: [number, number][];
  /** What play() does: resolve, or reject like a blocked autoplay. */
  playResult: 'ok' | 'blocked';
}

export interface FakeVideo extends HTMLVideoElement {
  media: MediaState;
  frameCallbacks: Map<number, FrameCallback>;
  /** Runs the pending requestVideoFrameCallback callbacks once, at a media time. */
  runFrame(mediaTimeS: number): void;
  /** Sets currentTime and fires timeupdate, as playback would. */
  advanceTo(timeS: number): void;
}

export function createFakeVideo(opts: { rvfc?: boolean } = {}): FakeVideo {
  const v = document.createElement('video') as FakeVideo;
  const media: MediaState = { currentTime: 0, paused: true, seeking: false, error: null, volume: 1, muted: false, buffered: [], playResult: 'ok' };
  v.media = media;
  Object.defineProperties(v, {
    currentTime: {
      configurable: true,
      get: () => media.currentTime,
      set: (x: number) => {
        media.currentTime = x;
      },
    },
    paused: { configurable: true, get: () => media.paused },
    seeking: { configurable: true, get: () => media.seeking },
    error: { configurable: true, get: () => media.error },
    volume: {
      configurable: true,
      get: () => media.volume,
      set: (x: number) => {
        media.volume = x;
        v.dispatchEvent(new Event('volumechange'));
      },
    },
    muted: {
      configurable: true,
      get: () => media.muted,
      set: (x: boolean) => {
        media.muted = x;
        v.dispatchEvent(new Event('volumechange'));
      },
    },
    buffered: {
      configurable: true,
      get: () => ({
        length: media.buffered.length,
        start: (i: number) => media.buffered[i]?.[0] ?? 0,
        end: (i: number) => media.buffered[i]?.[1] ?? 0,
      }),
    },
  });
  v.load = vi.fn();
  v.play = vi.fn(() => {
    if (media.playResult === 'blocked') return Promise.reject(new DOMException('autoplay', 'NotAllowedError'));
    media.paused = false;
    v.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  });
  v.pause = vi.fn(() => {
    if (media.paused) return;
    media.paused = true;
    v.dispatchEvent(new Event('pause'));
  });

  v.frameCallbacks = new Map();
  let nextHandle = 1;
  if (opts.rvfc !== false) {
    Object.assign(v, {
      requestVideoFrameCallback: (cb: FrameCallback) => {
        const h = nextHandle++;
        v.frameCallbacks.set(h, cb);
        return h;
      },
      cancelVideoFrameCallback: (h: number) => {
        v.frameCallbacks.delete(h);
      },
    });
  }
  v.runFrame = (mediaTimeS) => {
    const pending = [...v.frameCallbacks.entries()];
    v.frameCallbacks.clear();
    for (const [, cb] of pending) cb(performance.now(), { mediaTime: mediaTimeS });
  };
  v.advanceTo = (timeS) => {
    media.currentTime = timeS;
    v.dispatchEvent(new Event('timeupdate'));
  };
  return v;
}
