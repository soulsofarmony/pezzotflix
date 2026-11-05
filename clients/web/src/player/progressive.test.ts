import { describe, expect, it, vi } from 'vitest';
import { createFakeVideo } from '../test/fakeVideo.ts';
import type { EngineCallbacks } from './engine.ts';
import { MEDIA_ERR } from './failures.ts';
import { AUDIO_CHECK_AFTER_S, createProgressiveEngine } from './progressive.ts';

const URL_ = '/video/media/sessions/s1/file?st=x';

/** status: what the media url answers to the probe; 'down' = no answer. */
function setup(hasAudio = true, status: number | 'down' = 206) {
  const video = createFakeVideo();
  const cb = { onFailure: vi.fn(), onTimelineOffset: vi.fn(), onBufferFull: vi.fn(), log: vi.fn() } satisfies EngineCallbacks;
  const fetchFn = vi.fn(() => (status === 'down' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response(null, { status }))));
  const engine = createProgressiveEngine(video, URL_, hasAudio, cb, { fetch: fetchFn });
  return { video, cb, engine, fetchFn };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Plays from `from` to `to` in 0.25 s timeupdate steps. */
function play(video: ReturnType<typeof createFakeVideo>, from: number, to: number) {
  video.media.paused = false;
  for (let t = from; t <= to + 1e-9; t += 0.25) video.advanceTo(t);
}

describe('progressive engine', () => {
  it('sets src and seeks to the start position once the metadata is there', () => {
    const { video, engine } = setup();
    engine.start(1234.5);
    expect(video.getAttribute('src')).toBe(URL_);
    expect(video.load).toHaveBeenCalled();
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(1234.5);
  });

  it('reports silent audio after 4 s of playback (Chromium counter)', () => {
    const { video, cb, engine } = setup();
    Object.assign(video, { webkitAudioDecodedByteCount: 0 });
    engine.start(0);
    play(video, 0, AUDIO_CHECK_AFTER_S - 0.5);
    expect(cb.onFailure).not.toHaveBeenCalled();
    play(video, AUDIO_CHECK_AFTER_S - 0.25, AUDIO_CHECK_AFTER_S + 1);
    expect(cb.onFailure).toHaveBeenCalledExactlyOnceWith({ kind: 'replan', suspect: 'audio', error: 'AUDIO_NOT_DECODED' });
  });

  it('does not count seeks as playback, and is silent when audio decodes or the counters are missing', () => {
    const decoding = setup();
    Object.assign(decoding.video, { webkitAudioDecodedByteCount: 4096 });
    decoding.engine.start(0);
    play(decoding.video, 0, 6);
    expect(decoding.cb.onFailure).not.toHaveBeenCalled();

    const seeking = setup();
    Object.assign(seeking.video, { mozHasAudio: false });
    seeking.engine.start(0);
    seeking.video.media.paused = false;
    // Big jumps (seeks) never add up to 4 s.
    for (const t of [0, 100, 200, 300, 400, 500]) seeking.video.advanceTo(t);
    expect(seeking.cb.onFailure).not.toHaveBeenCalled();

    const unknown = setup();
    unknown.engine.start(0);
    play(unknown.video, 0, 6);
    expect(unknown.cb.onFailure).not.toHaveBeenCalled();
  });

  it('skips the audio check without an audio track', () => {
    const { video, cb, engine } = setup(false);
    Object.assign(video, { webkitAudioDecodedByteCount: 0 });
    engine.start(0);
    play(video, 0, 6);
    expect(cb.onFailure).not.toHaveBeenCalled();
  });

  it('retries a network error once from the same point, then re-plans (the url answers)', async () => {
    const { video, cb, engine, fetchFn } = setup();
    engine.start(0);
    video.dispatchEvent(new Event('loadedmetadata'));
    video.media.currentTime = 42;
    video.media.error = { code: MEDIA_ERR.NETWORK, message: 'net' };
    video.dispatchEvent(new Event('error'));
    await flush();
    expect(fetchFn).toHaveBeenCalledWith(URL_, expect.objectContaining({ headers: { Range: 'bytes=0-0' } }));
    expect(cb.onFailure).not.toHaveBeenCalled();
    expect(video.load).toHaveBeenCalledTimes(2);
    video.media.currentTime = 0;
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(42);
    video.dispatchEvent(new Event('error'));
    await flush();
    expect(cb.onFailure).toHaveBeenCalledWith({ kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' });
  });

  it('a network error before loadedmetadata retries from the start position, not from 0', async () => {
    const { video, engine } = setup();
    engine.start(2000);
    video.media.error = { code: MEDIA_ERR.NETWORK, message: 'net' };
    video.dispatchEvent(new Event('error'));
    await flush();
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(2000);
  });

  it('maps a container error to the container suspect when the url answers', async () => {
    const { video, cb, engine } = setup();
    engine.start(0);
    video.media.error = { code: MEDIA_ERR.SRC_NOT_SUPPORTED, message: '' };
    video.dispatchEvent(new Event('error'));
    await flush();
    expect(cb.onFailure).toHaveBeenCalledWith({ kind: 'replan', suspect: 'container', error: 'MEDIA_ERR_SRC_NOT_SUPPORTED' });
  });

  it.each([
    ['410: the session is closed', 410, MEDIA_ERR.SRC_NOT_SUPPORTED, { kind: 'restart', error: 'HTTP_410' }],
    ['404 behind a NETWORK error', 404, MEDIA_ERR.NETWORK, { kind: 'restart', error: 'HTTP_404' }],
    ['500: the failure table, not a container problem', 500, MEDIA_ERR.SRC_NOT_SUPPORTED, { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' }],
    ['no answer: the network, as in HLS', 'down' as const, MEDIA_ERR.NETWORK, { kind: 'network', error: 'Failed to fetch' }],
  ])('%s', async (_name, status, code, expected) => {
    const { video, cb, engine } = setup(true, status);
    engine.start(0);
    video.media.error = { code, message: '' };
    video.dispatchEvent(new Event('error'));
    await flush();
    expect(cb.onFailure).toHaveBeenCalledExactlyOnceWith(expected);
    expect(video.load).toHaveBeenCalledTimes(1);
  });

  it('a decode error needs no probe', () => {
    const { video, cb, engine, fetchFn } = setup();
    engine.start(0);
    video.media.error = { code: MEDIA_ERR.DECODE, message: '' };
    video.dispatchEvent(new Event('error'));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(cb.onFailure).toHaveBeenCalledWith({ kind: 'replan', suspect: 'unknown', error: 'MEDIA_ERR_DECODE' });
  });

  it('a probe that answers after destroy does nothing', async () => {
    const { video, cb, engine } = setup(true, 410);
    engine.start(0);
    video.media.error = { code: MEDIA_ERR.NETWORK, message: '' };
    video.dispatchEvent(new Event('error'));
    engine.destroy();
    await flush();
    expect(cb.onFailure).not.toHaveBeenCalled();
  });

  it('destroy removes the source and every listener', () => {
    const { video, cb, engine } = setup();
    engine.start(0);
    engine.destroy();
    engine.destroy();
    expect(video.hasAttribute('src')).toBe(false);
    video.media.error = { code: MEDIA_ERR.DECODE, message: '' };
    video.dispatchEvent(new Event('error'));
    expect(cb.onFailure).not.toHaveBeenCalled();
  });
});
