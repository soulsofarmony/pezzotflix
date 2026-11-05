import { describe, expect, it, vi } from 'vitest';
import type { RetryConfig } from 'hls.js/light';
import type { HlsStream, SessionTrack } from '../api/types.ts';
import type { EngineCallbacks } from './engine.ts';
import { createFakeVideo } from '../test/fakeVideo.ts';
import { createHlsEngine, type HlsClass, no500Retry, PROVISIONAL_TARGET_DURATION_S, withNo500Retry } from './hls.ts';

// A fake hls.js: records config, calls and handlers, and lets the test emit events.
const EVENTS = { MANIFEST_PARSED: 'hlsManifestParsed', LEVEL_LOADED: 'hlsLevelLoaded', INIT_PTS_FOUND: 'hlsInitPtsFound', ERROR: 'hlsError' };
const POLICY = { default: { maxTimeToFirstByteMs: 1000, maxLoadTimeMs: 2000, timeoutRetry: null, errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 } } };

class FakeHls {
  static Events = EVENTS;
  static DefaultConfig = { manifestLoadPolicy: POLICY, playlistLoadPolicy: POLICY, fragLoadPolicy: POLICY };
  static instances: FakeHls[] = [];
  config: Record<string, unknown>;
  handlers = new Map<string, (e: string, data: unknown) => void>();
  calls: string[] = [];
  startLoadAt: number | null = null;
  constructor(config: Record<string, unknown>) {
    this.config = { ...config };
    FakeHls.instances.push(this);
  }
  on(ev: string, fn: (e: string, data: unknown) => void) {
    this.handlers.set(ev, fn);
  }
  emit(ev: string, data: unknown) {
    this.handlers.get(ev)?.(ev, data);
  }
  attachMedia() {
    this.calls.push('attachMedia');
  }
  loadSource(url: string) {
    this.calls.push(`loadSource ${url}`);
  }
  startLoad(at: number) {
    this.startLoadAt = at;
    this.calls.push('startLoad');
  }
  stopLoad() {
    this.calls.push('stopLoad');
  }
  destroy() {
    this.calls.push('destroy');
  }
}

const stream = (over: Partial<HlsStream> = {}): HlsStream => ({
  protocol: 'hls-fmp4',
  url: '/video/media/sessions/s1/main.m3u8?st=x',
  mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, flac"',
  mediaTimestampOffsetMs: 10_000,
  bitrate: { peakBps: 100_000_000, averageBps: 60_000_000, audioBps: 640_000 },
  ...over,
});

function setup(s: HlsStream = stream(), audio: SessionTrack | null = null) {
  FakeHls.instances = [];
  const cb = { onFailure: vi.fn(), onTimelineOffset: vi.fn(), onBufferFull: vi.fn(), log: vi.fn() } satisfies EngineCallbacks;
  const video = createFakeVideo();
  const engine = createHlsEngine(video, s, audio, cb, { Hls: FakeHls as unknown as HlsClass, workerPath: '/assets/hls.worker-abc.js', isTypeSupported: () => true });
  const hls = FakeHls.instances[0];
  if (!hls) throw new Error('no instance');
  return { cb, engine, hls, video };
}

/** initPTS as hls.js 1.7.4 computes it for fMP4: first decode time minus the fragment's playlist start. */
const initPtsOf = (decodeTimeS: number, fragStartS: number, timescale = 90_000) => Math.round((decodeTimeS - fragStartS) * timescale);

describe('hls engine', () => {
  it('creates hls.js with the worker, no autostart and the provisional buffer', () => {
    const { hls } = setup();
    expect(hls.config).toMatchObject({ enableWorker: true, workerPath: '/assets/hls.worker-abc.js', autoStartLoad: false, maxBufferLength: 6, maxMaxBufferLength: 6 });
  });

  it('loads after MANIFEST_PARSED at the start position, then resizes at the first LEVEL_LOADED', () => {
    const { engine, hls } = setup();
    engine.start(3600);
    expect(hls.calls).toEqual(['attachMedia', 'loadSource /video/media/sessions/s1/main.m3u8?st=x']);
    hls.emit(EVENTS.MANIFEST_PARSED, { levels: [{ bitrate: 100_000_000 }] });
    expect(hls.startLoadAt).toBe(3600);
    expect(hls.config.maxBufferLength).toBe(6);
    // Real TARGETDURATION 4 s: 100 Mbps gives 4 s (doc 05 §7.8.4).
    hls.emit(EVENTS.LEVEL_LOADED, { details: { targetduration: 4 } });
    expect(hls.config.maxBufferLength).toBe(4);
    // Later playlists do not change it again.
    hls.emit(EVENTS.LEVEL_LOADED, { details: { targetduration: 6 } });
    expect(hls.config.maxBufferLength).toBe(4);
  });

  it('uses BANDWIDTH when the session has no bitrate', () => {
    // Delivered as AAC (stream.mimeType): its 384 kbit/s estimate does not bind the audio quota.
    const aac = 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"';
    const { engine, hls } = setup(stream({ mimeType: aac, bitrate: { peakBps: null, averageBps: null, audioBps: null } }), {
      codec: 'aac',
      channels: 6,
    } as SessionTrack);
    engine.start(0);
    hls.emit(EVENTS.MANIFEST_PARSED, { levels: [{ bitrate: 20_000_000 }] });
    hls.emit(EVENTS.LEVEL_LOADED, { details: { targetduration: PROVISIONAL_TARGET_DURATION_S } });
    expect(hls.config.maxBufferLength).toBe(30);
  });

  it('reports the timeline offset at INIT_PTS_FOUND of the main fragments only', () => {
    const { cb, hls } = setup();
    hls.emit(EVENTS.INIT_PTS_FOUND, { id: 'audio', initPTS: 0, timescale: 90_000 });
    expect(cb.onTimelineOffset).not.toHaveBeenCalled();
    // Pipeline restarted at 1:00:00: fragment at playlist time 3600 s, keyframe PTS 3600.12 s + 10 s.
    hls.emit(EVENTS.INIT_PTS_FOUND, { id: 'main', initPTS: initPtsOf(3610.12, 3600), timescale: 90_000 });
    expect(cb.onTimelineOffset).toHaveBeenLastCalledWith(expect.closeTo(120, 3));
    // hls.js resets initPTS later (drift of at least one segment): the offset follows.
    hls.emit(EVENTS.INIT_PTS_FOUND, { id: 'main', initPTS: initPtsOf(5410.04, 5400), timescale: 90_000 });
    expect(cb.onTimelineOffset).toHaveBeenLastCalledWith(expect.closeTo(40, 3));
  });

  it('fatal mediaSourceRequiresReset: reload while the element is fine, re-plan when video.error is set', () => {
    const a = setup();
    a.hls.emit(EVENTS.ERROR, { type: 'mediaError', details: 'mediaSourceRequiresReset', fatal: true });
    expect(a.cb.onFailure).toHaveBeenCalledWith({ kind: 'reload', error: 'mediaSourceRequiresReset', suspect: 'unknown' });
    const b = setup();
    b.video.media.error = { code: 3, message: 'decode' };
    b.hls.emit(EVENTS.ERROR, { type: 'mediaError', details: 'mediaSourceRequiresReset', fatal: true });
    expect(b.cb.onFailure).toHaveBeenCalledWith({ kind: 'replan', suspect: 'unknown', error: 'mediaSourceRequiresReset' });
  });

  it('a fatal stall gets a reload, a non-fatal one is left to hls.js', () => {
    const { cb, hls } = setup();
    hls.emit(EVENTS.ERROR, { type: 'mediaError', details: 'bufferStalledError', fatal: false });
    expect(cb.onFailure).not.toHaveBeenCalled();
    hls.emit(EVENTS.ERROR, { type: 'mediaError', details: 'bufferStalledError', fatal: true });
    expect(cb.onFailure).toHaveBeenCalledWith({ kind: 'reload', error: 'bufferStalledError', suspect: 'unknown' });
  });

  it('estimates the audio bitrate from the delivered codec in stream.mimeType, not the source track', () => {
    const noBitrate = { peakBps: null, averageBps: null, audioBps: null };
    // TrueHD 7.1 source delivered as FLAC: 6 Mbit/s binds the audio quota (T about 11.7 s < 12 s).
    const flac = setup(stream({ bitrate: noBitrate }), { codec: 'truehd', channels: 8 } as SessionTrack);
    flac.engine.start(0);
    flac.hls.emit(EVENTS.MANIFEST_PARSED, { levels: [{ bitrate: 40_000_000 }] });
    flac.hls.emit(EVENTS.LEVEL_LOADED, { details: { targetduration: 6 } });
    expect(flac.cb.log).toHaveBeenCalledWith('warn', 'buffer floor above the margin (T < 2·TD)', expect.objectContaining({ fitSeconds: expect.closeTo(11.74, 1) }));
    // The same source delivered as AAC: 384 kbit/s, the audio quota no longer binds.
    const aac = setup(stream({ mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"', bitrate: noBitrate }), { codec: 'truehd', channels: 8 } as SessionTrack);
    aac.engine.start(0);
    aac.hls.emit(EVENTS.MANIFEST_PARSED, { levels: [{ bitrate: 40_000_000 }] });
    aac.hls.emit(EVENTS.LEVEL_LOADED, { details: { targetduration: 6 } });
    expect(aac.cb.log.mock.calls.filter((c) => c[0] === 'warn')).toHaveLength(0);
    expect(aac.hls.config.maxBufferLength).toBe(16);
  });

  it('warns about T < 2·TD only at LEVEL_LOADED, never with the provisional TD', () => {
    const bitrate = { peakBps: 100_000_000, averageBps: null, audioBps: 640_000 };
    const { cb, engine, hls } = setup(stream({ bitrate }));
    engine.start(0);
    hls.emit(EVENTS.MANIFEST_PARSED, { levels: [{ bitrate: 100_000_000 }] });
    // 100 Mbps with the provisional 6 s would warn (T about 8.8 s < 12 s).
    expect(cb.log.mock.calls.filter((c) => c[0] === 'warn')).toHaveLength(0);
    hls.emit(EVENTS.LEVEL_LOADED, { details: { targetduration: 4 } });
    expect(cb.log.mock.calls.filter((c) => c[0] === 'warn')).toHaveLength(0);
    const late = setup(stream({ bitrate }));
    late.engine.start(0);
    late.hls.emit(EVENTS.MANIFEST_PARSED, { levels: [{ bitrate: 100_000_000 }] });
    late.hls.emit(EVENTS.LEVEL_LOADED, { details: { targetduration: 6 } });
    expect(late.cb.log.mock.calls.filter((c) => c[0] === 'warn')).toHaveLength(1);
  });

  it('stops loading at once on a plan failure and hands it to the controller', () => {
    const { cb, hls } = setup();
    hls.emit(EVENTS.ERROR, { type: 'mediaError', details: 'bufferAddCodecError', fatal: true, sourceBufferName: 'audio' });
    expect(hls.calls).toContain('stopLoad');
    expect(cb.onFailure).toHaveBeenCalledWith({ kind: 'replan', suspect: 'audio', error: 'bufferAddCodecError' });
  });

  it('counts bufferFullError without failing', () => {
    const { cb, hls } = setup();
    hls.emit(EVENTS.ERROR, { type: 'mediaError', details: 'bufferFullError', fatal: false });
    expect(cb.onBufferFull).toHaveBeenCalledTimes(1);
    expect(cb.onFailure).not.toHaveBeenCalled();
    expect(hls.calls).not.toContain('stopLoad');
  });

  it('ignores everything after destroy', () => {
    const { cb, engine, hls } = setup();
    engine.destroy();
    engine.destroy();
    expect(hls.calls.filter((c) => c === 'destroy')).toHaveLength(1);
    hls.emit(EVENTS.ERROR, { type: 'mediaError', details: 'bufferAppendError', fatal: true });
    hls.emit(EVENTS.INIT_PTS_FOUND, { id: 'main', initPTS: 900_000, timescale: 90_000 });
    expect(cb.onFailure).not.toHaveBeenCalled();
    expect(cb.onTimelineOffset).not.toHaveBeenCalled();
  });

  it('turns off the hls.js retries on 500, keeps them on 503, in the three load policies', () => {
    const { hls } = setup();
    for (const key of ['manifestLoadPolicy', 'playlistLoadPolicy', 'fragLoadPolicy']) {
      const p = hls.config[key] as { default: { errorRetry: RetryConfig } };
      const retry = p.default.errorRetry;
      expect(retry.maxNumRetry).toBe(6);
      const shouldRetry = retry.shouldRetry;
      if (!shouldRetry) throw new Error(key + ': no shouldRetry');
      // hls.js calls it with (retryConfig, retryCount, isTimeout, loaderResponse, defaultDecision).
      expect(shouldRetry(retry, 0, false, { code: 500, text: 'Internal Server Error', url: '/seg-0-00012.m4s' }, true)).toBe(false);
      expect(shouldRetry(retry, 0, false, { code: 503, text: 'Service Unavailable', url: '/seg-0-00012.m4s' }, true)).toBe(true);
      expect(shouldRetry(retry, 6, false, { code: 503, text: 'Service Unavailable', url: '/seg-0-00012.m4s' }, false)).toBe(false);
    }
  });
});

describe('no500Retry', () => {
  const cfg = POLICY.default.errorRetry as never;
  it.each([
    [500, true, false],
    [503, true, true],
    [503, false, false],
    [404, false, false],
  ])('HTTP %d with default %s → %s', (code, retry, expected) => {
    expect(no500Retry(cfg, 0, false, { code, text: '', url: '' }, retry)).toBe(expected);
  });

  it('keeps a policy without errorRetry as is', () => {
    expect(withNo500Retry({ default: { ...POLICY.default, errorRetry: null } }).default.errorRetry).toBeNull();
  });
});
