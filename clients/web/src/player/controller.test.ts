import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, ClientCapabilities, PlaybackSession, SessionTrack, Stream } from '../api/types.ts';
import { createFakeVideo, type FakeVideo } from '../test/fakeVideo.ts';
import { isClosedRefusal, type PlayerController, PlayerController as Controller, type PlayerDeps, type PlayerPhase, PREPARING_LIMIT_MS } from './controller.ts';
import type { Engine, EngineCallbacks } from './engine.ts';
import type { PgsFactory, PgsLike } from './subtitles.ts';
import type { PlaybackApi, PlaybackApiError } from './types.ts';

// ---------------------------------------------------------------- fixtures

const audioTrack = (id: string, selected: boolean): SessionTrack => ({
  id,
  type: 'audio',
  index: 1,
  codec: 'flac',
  language: 'ita',
  title: null,
  default: selected,
  forced: false,
  sdh: false,
  commentary: false,
  channels: 6,
  channelLayout: '5.1(side)',
  objectAudio: null,
  subtitleKind: null,
  selected,
  switchWithoutRestart: false,
  delivery: null,
  url: null,
  availability: 'complete',
});

const subTrack = (id: string, over: Partial<SessionTrack> = {}): SessionTrack => ({
  ...audioTrack(id, false),
  type: 'subtitle',
  codec: 'hdmv_pgs_subtitle',
  channels: null,
  channelLayout: null,
  subtitleKind: 'image',
  switchWithoutRestart: true,
  delivery: 'client_render',
  url: `/video/media/sessions/s/subtitles/${id}.sup`,
  ...over,
});

const burned = (id: string, selected: boolean) => subTrack(id, { delivery: 'burned', url: null, switchWithoutRestart: false, selected });

const hlsStream = (url: string): Stream => ({
  protocol: 'hls-fmp4',
  url,
  mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, flac"',
  mediaTimestampOffsetMs: 10_000,
  bitrate: { peakBps: null, averageBps: null, audioBps: null },
});

let seq = 0;
function session(over: Partial<PlaybackSession> = {}): PlaybackSession {
  seq += 1;
  return {
    sessionId: `s${seq}`,
    expiresAt: Date.now() + 60_000,
    heartbeatIntervalMs: 10_000,
    itemId: 'item-1',
    fileId: 'file-1',
    mode: 'direct_stream',
    reasons: ['audio TrueHD → FLAC'],
    stream: hlsStream(`/video/media/sessions/s${seq}/main.m3u8`),
    tracks: { audio: [audioTrack('a1', true), audioTrack('a2', false)], subtitles: [] },
    resumePositionMs: 0,
    durationMs: 7_200_000,
    chapters: [],
    ...over,
  };
}

const withPgs = (over: Partial<PlaybackSession> = {}) => session({ tracks: { audio: [audioTrack('a1', true)], subtitles: [subTrack('p1', { selected: true })] }, ...over });

const apiError = (status: number, code: string, over: Partial<PlaybackApiError> = {}): PlaybackApiError => ({ status, code, detail: null, retryAfterMs: null, activeSessions: [], ...over });

/** The status a subtitle url answers to the renderer's probe, in order (the last one repeats). */
const answering = (...statuses: { status: number; retryAfter?: string }[]) => {
  const queue = [...statuses];
  return vi.fn(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve(new Response(null, { status: next?.status ?? 200, headers: next?.retryAfter ? { 'Retry-After': next.retryAfter } : {} }));
  });
};

interface FakeEngine extends Engine {
  cb: EngineCallbacks;
  session: PlaybackSession;
  startedAt: number | null;
  destroyed: boolean;
}

interface SetupOptions {
  preflightOk?: (t: string) => boolean;
  hlsSupported?: boolean;
  loadPgs?: () => Promise<PgsFactory>;
  /** libpgs `ready` of each new renderer (default: pending, as for a growing track). */
  pgsReady?: () => Promise<void>;
  subtitleFetch?: ReturnType<typeof answering>;
}

function setup(opts: SetupOptions = {}) {
  const video = createFakeVideo();
  const engines: FakeEngine[] = [];
  const pgs: (PgsLike & { loads: string[] })[] = [];
  const pgsFactory: PgsFactory = () => {
    const p = {
      timeOffset: 0,
      ready: opts.pgsReady?.() ?? new Promise<void>(() => undefined),
      loads: [] as string[],
      renderAtTimestamp: vi.fn(),
      loadFromUrl(url: string) {
        p.loads.push(url);
        return Promise.resolve();
      },
      dispose: vi.fn(),
    };
    pgs.push(p);
    return p;
  };
  const api = {
    start: vi.fn<PlaybackApi['start']>(() => Promise.resolve(session())),
    reportProgress: vi.fn<PlaybackApi['reportProgress']>(() => Promise.resolve()),
    stop: vi.fn<PlaybackApi['stop']>(() => Promise.resolve()),
    changeTracks: vi.fn<PlaybackApi['changeTracks']>(() => Promise.resolve(session())),
    changeVersion: vi.fn<PlaybackApi['changeVersion']>(() => Promise.resolve(session())),
    reportFailure: vi.fn<PlaybackApi['reportFailure']>(() => Promise.resolve(session())),
    terminate: vi.fn<PlaybackApi['terminate']>(() => Promise.resolve()),
  } satisfies PlaybackApi;
  const win = new EventTarget();
  const deps: PlayerDeps = {
    api,
    probe: vi.fn(() =>
      Promise.resolve({
        capabilities: { protocols: ['progressive', 'hls-fmp4'] } as ClientCapabilities,
        preflightEnv: { isTypeSupported: opts.preflightOk ?? (() => true), canPlayType: () => 'maybe' },
        hlsSupported: opts.hlsSupported ?? true,
      }),
    ),
    createEngine: vi.fn((_v: HTMLVideoElement, s: PlaybackSession, cb: EngineCallbacks) => {
      const e: FakeEngine = {
        protocol: s.stream.protocol,
        cb,
        session: s,
        startedAt: null,
        destroyed: false,
        start(at) {
          e.startedAt = at;
        },
        destroy() {
          // A real teardown detaches the source: the element falls back to 0 until the next engine seeks.
          if (!e.destroyed && e.startedAt !== null) video.media.currentTime = 0;
          e.destroyed = true;
        },
      };
      engines.push(e);
      return Promise.resolve(e);
    }),
    subtitles: {
      loadPgs: opts.loadPgs ?? (() => Promise.resolve(pgsFactory)),
      fetch: opts.subtitleFetch ?? answering({ status: 200 }),
    },
    log: vi.fn(),
    win,
  };
  const c = new Controller(deps);
  c.attach(video);
  return { c, api, deps, video, engines, pgs, win };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const last = <T,>(xs: T[]): T => {
  const x = xs[xs.length - 1];
  if (x === undefined) throw new Error('empty');
  return x;
};
/** Waits for a promise the test resolves itself (an in-flight server call). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const subtitleFailure = (c: PlayerController, trackId: string, url: string | null) => (c as unknown as { onSubtitleFailure(id: string, url: string | null): void }).onSubtitleFailure(trackId, url);

beforeEach(() => {
  vi.useFakeTimers();
  seq = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- start

describe('start', () => {
  it('probes, starts the session and plays it from the resume position', async () => {
    const { c, api, engines, video } = setup();
    api.start.mockResolvedValueOnce(session({ resumePositionMs: 600_000 }));
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'item-1', fileId: 'file-1', capabilities: { protocols: ['progressive', 'hls-fmp4'] } }));
    expect(api.start.mock.calls[0]?.[0]).not.toHaveProperty('startPositionMs');
    expect(engines).toHaveLength(1);
    expect(engines[0]?.startedAt).toBe(600);
    expect(c.getSnapshot().phase).toBe('ready');
    expect(video.play).toHaveBeenCalled();
  });

  it('sends an explicit start position, rounded, and forceMode', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1', startPositionMs: 1234.6, forceMode: 'transcode' });
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ startPositionMs: 1235, forceMode: 'transcode' }));
    expect(engines[0]?.startedAt).toBeCloseTo(1.2346, 6);
  });

  it('ignores the same start while it runs (StrictMode)', async () => {
    const { c, api } = setup();
    const p1 = c.start({ itemId: 'item-1' });
    const p2 = c.start({ itemId: 'item-1' });
    await Promise.all([p1, p2]);
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another audio track', { audioTrackId: 'a2', fileId: 'file-1' }],
    ['another forced mode', { forceMode: 'transcode' as const }],
  ])('a start with %s is a new start: the open session is stopped first', async (_name, extra) => {
    const { c, api, video } = setup();
    await c.start({ itemId: 'item-1' });
    video.advanceTo(12);
    await c.start({ itemId: 'item-1', ...extra });
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('s1', 12_000);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.stop.mock.invocationCallOrder[0]).toBeLessThan(api.start.mock.invocationCallOrder[1] ?? 0);
    expect(c.getSnapshot().session?.sessionId).toBe('s2');
  });

  it('flags a blocked autoplay', async () => {
    const { c, video } = setup();
    video.media.playResult = 'blocked';
    await c.start({ itemId: 'item-1' });
    await flush();
    expect(c.getSnapshot().autoplayBlocked).toBe(true);
  });
});

describe('the item on screen replaced in the library (a provisional item identified)', () => {
  const removed = (itemId: string, replacedBy: string | null): AppEvent => ({ seq: 1, at: 0, type: 'library.item_removed', itemId, replacedBy });

  it('playback goes on; "Riprova" and the same start from the page ask for the item that took its place', async () => {
    const { c, api, video } = setup();
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    c.onEvent(removed('other', 'item-9'));
    c.onEvent(removed('item-1', 'item-2'));
    expect(c.getSnapshot().phase).toBe('ready');
    expect(api.stop).not.toHaveBeenCalled();
    // The page still says item-1: the same start, not a new one.
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    expect(api.start).toHaveBeenCalledTimes(1);
    video.advanceTo(12);
    await c.retry();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ itemId: 'item-2', fileId: 'file-1' });
  });

  it('a removal with nothing in its place changes nothing here: the server ends the session (item_removed)', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1' });
    c.onEvent(removed('item-1', null));
    await c.retry();
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ itemId: 'item-1' });
  });
});

describe('503 STREAM_PREPARING', () => {
  it('shows "in preparazione" and retries after Retry-After', async () => {
    const { c, api } = setup();
    api.start.mockRejectedValueOnce(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 3000 })).mockRejectedValueOnce(apiError(503, 'STREAM_PREPARING'));
    const done = c.start({ itemId: 'item-1' });
    await flush();
    expect(c.getSnapshot().phase).toBe('preparing');
    await vi.advanceTimersByTimeAsync(2999);
    expect(api.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.start).toHaveBeenCalledTimes(2);
    // No Retry-After: 2 s.
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(api.start).toHaveBeenCalledTimes(3);
    expect(c.getSnapshot().phase).toBe('ready');
  });

  it('gives up after 60 s with an error', async () => {
    const { c, api } = setup();
    api.start.mockRejectedValue(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 5000 }));
    const done = c.start({ itemId: 'item-1' });
    await vi.advanceTimersByTimeAsync(PREPARING_LIMIT_MS + 5000);
    await done;
    expect(c.getSnapshot()).toMatchObject({ phase: 'error', error: { code: 'STREAM_PREPARING' } });
    expect(api.start.mock.calls.length).toBeLessThanOrEqual(13);
  });
});

describe('start errors', () => {
  it.each([
    [apiError(409, 'SESSION_LIMIT_REACHED', { activeSessions: [{ sessionId: 'other', profileId: 'p2', itemId: 'i2', startedAt: 0 } as never] }), 'session_limit'],
    [apiError(422, 'NO_COMPATIBLE_PLAN', { detail: '4K: serve un Transcode' }), 'no_plan'],
    [apiError(0, 'NETWORK'), 'network'],
    [apiError(500, 'INTERNAL'), 'error'],
  ])('%o → %s', async (err, phase) => {
    const { c, api } = setup();
    api.start.mockRejectedValueOnce(err);
    await c.start({ itemId: 'item-1' });
    expect(c.getSnapshot().phase).toBe(phase);
  });

  it('SESSION_LIMIT_REACHED: terminate the other session, then start again', async () => {
    const { c, api } = setup();
    api.start.mockRejectedValueOnce(apiError(409, 'SESSION_LIMIT_REACHED'));
    await c.start({ itemId: 'item-1', startPositionMs: 5000 });
    await c.terminateOther('other');
    expect(api.terminate).toHaveBeenCalledWith('other');
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ startPositionMs: 5000 });
    expect(c.getSnapshot().phase).toBe('ready');
  });

  it('hls-fmp4 without MSE is a client-side NO_COMPATIBLE_PLAN', async () => {
    const { c, engines } = setup({ hlsSupported: false });
    await c.start({ itemId: 'item-1' });
    expect(engines).toHaveLength(0);
    expect(c.getSnapshot()).toMatchObject({ phase: 'no_plan', error: { code: 'CLIENT_NO_MSE' } });
  });
});

describe('a StartPlayback answered after its operation was superseded (M1)', () => {
  it('leaving during "Avvio": the session that arrives later is stopped, not left to time out', async () => {
    const { c, api, engines } = setup();
    const start = deferred<PlaybackSession>();
    api.start.mockImplementationOnce(() => start.promise);
    const p = c.start({ itemId: 'item-1', startPositionMs: 90_000 });
    await flush();
    c.detach();
    await flush();
    start.resolve(session());
    await p;
    await flush();
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('s1', 90_000);
    expect(engines).toHaveLength(0);
  });

  it('session_terminated while the player asks why its stream closed: it ends there, nothing is started; "Riprova" starts afresh', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    const why = deferred<void>();
    api.reportProgress.mockImplementationOnce(() => why.promise);
    engines[0]?.cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(api.reportProgress).toHaveBeenCalledTimes(1);
    c.onEvent({ seq: 9, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'terminated' });
    expect(c.getSnapshot()).toMatchObject({ phase: 'terminated', terminatedReason: 'terminated' });
    why.resolve();
    await flush();
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.stop).not.toHaveBeenCalled();
    expect(engines).toHaveLength(1);
    await c.retry();
    // The server closed s1: no StopPlayback for it.
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('session_terminated for the session a restart already stopped is stale: the new session plays', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    const restart = deferred<PlaybackSession>();
    api.start.mockImplementationOnce(() => restart.promise);
    engines[0]?.cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(api.stop).toHaveBeenCalledWith('s1', 0);
    // The expiry that closed s1 reaches the poller while the new StartPlayback runs.
    c.onEvent({ seq: 9, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'expired' });
    expect(c.getSnapshot().phase).toBe('starting');
    restart.resolve(session());
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
    expect(api.stop.mock.calls).toEqual([['s1', 0]]);
    expect(engines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- failures and re-plan

describe('automatic re-plan (doc 04 §8)', () => {
  it('pre-start check: reportPlaybackFailure MIME_TYPE_UNSUPPORTED with the suspect, before any engine', async () => {
    // Chrome: E-AC-3 refused.
    const { c, api, engines } = setup({ preflightOk: (t) => !t.includes('ec-3') });
    const first = session({ stream: { ...hlsStream('/a.m3u8'), mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, ec-3"' } });
    api.start.mockResolvedValueOnce(first);
    api.reportFailure.mockResolvedValueOnce(session({ stream: hlsStream('/b.m3u8') }));
    await c.start({ itemId: 'item-1', startPositionMs: 30_000 });
    expect(api.reportFailure).toHaveBeenCalledWith(first.sessionId, { positionMs: 30_000, error: 'MIME_TYPE_UNSUPPORTED', suspect: 'audio' });
    expect(engines).toHaveLength(1);
    expect(engines[0]?.session.stream.url).toBe('/b.m3u8');
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', attempts: 1 });
  });

  it('engine failure: destroys the engine, reports with the position, plays the new session in a new generation', async () => {
    const { c, api, engines, video } = setup();
    await c.start({ itemId: 'item-1' });
    const old = engines[0];
    video.media.currentTime = 42;
    old?.cb.onFailure({ kind: 'replan', suspect: 'audio', error: 'bufferAddCodecError' });
    await flush();
    expect(old?.destroyed).toBe(true);
    expect(api.reportFailure).toHaveBeenCalledWith('s1', { positionMs: 42_000, error: 'bufferAddCodecError', suspect: 'audio' });
    expect(engines).toHaveLength(2);
    expect(engines[1]?.startedAt).toBe(42);
    // Late errors of the replaced engine are ignored: never a new reportPlaybackFailure.
    old?.cb.onFailure({ kind: 'replan', suspect: 'video', error: 'late' });
    old?.cb.onTimelineOffset(999_999);
    await flush();
    expect(api.reportFailure).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().timelineOffsetMs).toBe(0);
  });

  it('stops after 3 automatic attempts, shows the reasons, and "Riprova" starts fresh', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    for (let i = 0; i < 4; i++) {
      last(engines).cb.onFailure({ kind: 'replan', suspect: 'unknown', error: `E${i}` });
      await flush();
    }
    expect(api.reportFailure).toHaveBeenCalledTimes(3);
    expect(c.getSnapshot()).toMatchObject({ phase: 'failed', attempts: 3 });
    expect(c.getSnapshot().failures.map((f) => f.error)).toEqual(['E0', 'E1', 'E2', 'E3']);

    await c.retry();
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', attempts: 0, failures: [] });
  });

  it('a closed session (404/410 on the data plane): stopPlayback, then StartPlayback from the current position', async () => {
    const { c, api, engines, video } = setup();
    await c.start({ itemId: 'item-1' });
    video.media.currentTime = 100;
    engines[0]?.cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(api.stop).toHaveBeenCalledWith('s1', 100_000);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ startPositionMs: 100_000 });
    expect(c.getSnapshot().attempts).toBe(1);
  });

  it('reportPlaybackFailure on a closed session becomes a new start', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(410, 'SESSION_EXPIRED'));
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(api.start).toHaveBeenCalledTimes(2);
  });

  it('two failures in the same tick (engine and subtitle) run one automatic attempt', async () => {
    const { c, api, engines } = setup();
    api.start.mockResolvedValueOnce(withPgs());
    await c.start({ itemId: 'item-1' });
    const report = deferred<PlaybackSession>();
    api.reportFailure.mockImplementationOnce(() => report.promise);
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'video', error: 'a' });
    // The .sup of the stopped stream answers 410 meanwhile.
    subtitleFailure(c, 'p1', '/video/media/sessions/s/subtitles/p1.sup');
    await flush();
    report.resolve(session());
    await flush();
    expect(api.reportFailure).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().attempts).toBe(1);
    expect(engines.filter((e) => !e.destroyed)).toHaveLength(1);
  });

  it('network loss: no automatic attempt', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    engines[0]?.cb.onFailure({ kind: 'network', error: 'fragLoadTimeOut' });
    await flush();
    expect(api.reportFailure).not.toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe('network');
  });
});

describe('engine reloads: once per stream (M4, M5)', () => {
  it('a fatal stall reloads on the same stream; the same failure again re-plans with unknown', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    engines[0]?.cb.onFailure({ kind: 'reload', error: 'bufferStalledError', suspect: 'unknown' });
    await flush();
    expect(api.reportFailure).not.toHaveBeenCalled();
    expect(engines).toHaveLength(2);
    expect(engines[1]?.session.stream.url).toBe(engines[0]?.session.stream.url);
    expect(engines[1]?.session.sessionId).toBe('s1');
    engines[1]?.cb.onFailure({ kind: 'reload', error: 'bufferSeekOverHole', suspect: 'unknown' });
    await flush();
    expect(api.reportFailure).toHaveBeenCalledExactlyOnceWith('s1', { positionMs: 0, error: 'bufferSeekOverHole', suspect: 'unknown' });
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', attempts: 2 });
  });

  it('mediaSourceRequiresReset: one reload, then a re-plan from the decomposition; the new stream has its own reload', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockResolvedValueOnce(session({ sessionId: 's1', stream: hlsStream('/s1/replanned/main.m3u8') }));
    engines[0]?.cb.onFailure({ kind: 'reload', error: 'mediaSourceRequiresReset', suspect: 'audio' });
    await flush();
    engines[1]?.cb.onFailure({ kind: 'reload', error: 'mediaSourceRequiresReset', suspect: 'audio' });
    await flush();
    expect(api.reportFailure).toHaveBeenCalledWith('s1', expect.objectContaining({ error: 'mediaSourceRequiresReset', suspect: 'audio' }));
    expect(engines[2]?.session.stream.url).toBe('/s1/replanned/main.m3u8');
    engines[2]?.cb.onFailure({ kind: 'reload', error: 'mediaSourceRequiresReset', suspect: 'audio' });
    await flush();
    expect(api.reportFailure).toHaveBeenCalledTimes(1);
    expect(engines[3]?.session.stream.url).toBe('/s1/replanned/main.m3u8');
  });
});

// ---------------------------------------------------------------- positions before the element is positioned

describe('the start position until the engine has positioned the element (B1)', () => {
  it('a failure before hls.js seeks reports the start position, and the new engine starts there', async () => {
    const { c, api, engines, video } = setup();
    api.start.mockResolvedValueOnce(session({ resumePositionMs: 3_600_000 }));
    await c.start({ itemId: 'item-1' });
    expect(engines[0]?.startedAt).toBe(3600);
    // bufferAddCodecError at the init segment: currentTime is still 0.
    video.media.currentTime = 0;
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'audio', error: 'bufferAddCodecError' });
    await flush();
    expect(api.reportFailure).toHaveBeenCalledWith('s1', { positionMs: 3_600_000, error: 'bufferAddCodecError', suspect: 'audio' });
    expect(engines[1]?.startedAt).toBe(3600);
  });

  it('leaving before the first frame stops with the start position, so the resume point survives', async () => {
    const { c, api, video } = setup();
    api.start.mockResolvedValueOnce(session({ resumePositionMs: 3_600_000 }));
    await c.start({ itemId: 'item-1' });
    video.media.currentTime = 0;
    c.detach();
    await flush();
    expect(api.stop).toHaveBeenCalledWith('s1', 3_600_000);
  });

  it('heartbeats before the seek report the start position; timeupdate at 0 is ignored until then', async () => {
    const { c, api, video } = setup();
    api.start.mockResolvedValueOnce(session({ resumePositionMs: 3_600_000, heartbeatIntervalMs: 5000 }));
    await c.start({ itemId: 'item-1' });
    video.advanceTo(0);
    expect(c.getSnapshot().positionMs).toBe(3_600_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.reportProgress).toHaveBeenLastCalledWith('s1', expect.objectContaining({ positionMs: 3_600_000 }));
    // hls.js has seeked to the start: currentTime is the position from now on.
    video.advanceTo(3600.04);
    expect(c.getSnapshot().positionMs).toBe(3_600_040);
    video.advanceTo(3601);
    expect(c.getSnapshot().positionMs).toBe(3_601_000);
  });

  it("the old engine's teardown (currentTime 0 + timeupdate) does not move the position after a change", async () => {
    const { c, engines, video } = setup();
    await c.start({ itemId: 'item-1' });
    video.advanceTo(600);
    await c.selectAudio('a2');
    expect(engines[1]?.startedAt).toBe(600);
    video.advanceTo(0);
    expect(c.getSnapshot().positionMs).toBe(600_000);
    expect(c.positionMs()).toBe(600_000);
    video.advanceTo(600.5);
    expect(c.getSnapshot().positionMs).toBe(600_500);
  });

  it('progressive Direct Play: a failure before loadedmetadata re-plans from the resume position', async () => {
    const { c, api, engines } = setup();
    const dp = session({ resumePositionMs: 2_000_000, mode: 'direct_play', stream: { protocol: 'progressive', url: '/f.mkv', mimeType: 'video/x-matroska', mediaTimestampOffsetMs: 0, bitrate: { peakBps: null, averageBps: null, audioBps: null } } });
    api.start.mockResolvedValueOnce(dp);
    await c.start({ itemId: 'item-1' });
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'container', error: 'MEDIA_ERR_SRC_NOT_SUPPORTED' });
    await flush();
    expect(api.reportFailure.mock.calls[0]?.[1]).toEqual({ positionMs: 2_000_000, error: 'MEDIA_ERR_SRC_NOT_SUPPORTED', suspect: 'container' });
  });
});

// ---------------------------------------------------------------- timeline

describe('timeline and seek', () => {
  it('maps positions with the offset from INIT_PTS_FOUND and seeks on the original timeline', async () => {
    const { c, engines, video } = setup();
    await c.start({ itemId: 'item-1', startPositionMs: 3_600_000 });
    // The VOD playlist spans the film: the player time of the start is 3600 s.
    expect(engines[0]?.startedAt).toBe(3600);
    // hls.js 1.7.4: initPTS = decode time − frag.start = (3610.12 − 3600) s → offset 120 ms.
    engines[0]?.cb.onTimelineOffset(120);
    video.advanceTo(3600);
    expect(c.positionMs()).toBe(3_600_120);
    video.advanceTo(3610);
    expect(c.getSnapshot().positionMs).toBe(3_610_120);
    c.seekTo(3_700_000);
    expect(video.currentTime).toBeCloseTo(3699.88, 6);
    c.seekBy(-10_000);
    expect(video.currentTime).toBeCloseTo(3689.88, 6);
    c.seekTo(99_999_999);
    expect(c.getSnapshot().positionMs).toBe(7_200_000);
  });
});

// ---------------------------------------------------------------- heartbeat and stop

describe('heartbeat', () => {
  it('reports every heartbeatIntervalMs, also while paused, and at pause/seeked', async () => {
    const { c, api, video } = setup();
    api.start.mockResolvedValueOnce(session({ heartbeatIntervalMs: 5000 }));
    await c.start({ itemId: 'item-1' });
    video.media.currentTime = 3;
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.reportProgress).toHaveBeenCalledTimes(1);
    expect(api.reportProgress).toHaveBeenLastCalledWith('s1', { positionMs: 3000, state: 'playing', clientTs: Date.now() });
    video.pause();
    expect(api.reportProgress).toHaveBeenCalledTimes(2);
    expect(api.reportProgress).toHaveBeenLastCalledWith('s1', expect.objectContaining({ state: 'paused' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.reportProgress).toHaveBeenCalledTimes(3);
    video.dispatchEvent(new Event('waiting'));
    video.dispatchEvent(new Event('seeked'));
    expect(api.reportProgress).toHaveBeenLastCalledWith('s1', expect.objectContaining({ state: 'buffering' }));
  });

  it('a heartbeat on a closed session offers to resume (SESSION_EXPIRED)', async () => {
    const { c, api, engines, video } = setup();
    await c.start({ itemId: 'item-1' });
    video.media.currentTime = 50;
    api.reportProgress.mockRejectedValueOnce(apiError(410, 'SESSION_EXPIRED'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.getSnapshot()).toMatchObject({ phase: 'expired', positionMs: 50_000 });
    expect(engines[0]?.destroyed).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.reportProgress).toHaveBeenCalledTimes(1);
  });

  it('a pause while a restart waits on 503 reports nothing to the stopped session', async () => {
    const { c, api, engines, video } = setup();
    await c.start({ itemId: 'item-1' });
    api.start.mockRejectedValueOnce(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 5000 }));
    engines[0]?.cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(c.getSnapshot().phase).toBe('preparing');
    // The one heartbeat that asked why the stream closed, before the stop.
    expect(api.reportProgress).toHaveBeenCalledTimes(1);
    video.media.paused = false;
    video.pause();
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.reportProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('pagehide: stopPlayback with keepalive; pageshow from the bfcache starts again', async () => {
    const { c, api, win, video } = setup();
    await c.start({ itemId: 'item-1' });
    video.media.currentTime = 77;
    win.dispatchEvent(new Event('pagehide'));
    expect(api.stop).toHaveBeenCalledWith('s1', 77_000, { keepalive: true });
    expect(c.getSnapshot().phase).toBe('stopped');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.reportProgress).not.toHaveBeenCalled();

    const show = Object.assign(new Event('pageshow'), { persisted: true });
    win.dispatchEvent(show);
    await flush();
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ startPositionMs: 77_000 });
  });

  it('detach then attach (StrictMode) keeps the session; a real detach stops it', async () => {
    const { c, api, video, engines } = setup();
    await c.start({ itemId: 'item-1' });
    c.detach();
    c.attach(video);
    await flush();
    expect(api.stop).not.toHaveBeenCalled();
    c.detach();
    await flush();
    expect(api.stop).toHaveBeenCalledWith('s1', 0);
    expect(engines[0]?.destroyed).toBe(true);
    expect(c.getSnapshot().phase).toBe('idle');
  });

  it.each<[PlayerPhase, boolean]>([
    ['starting', true],
    ['preparing', true],
    ['ready', true],
    ['replanning', true],
    ['failed', false],
    ['no_plan', false],
    ['network', false],
    ['terminated', false],
  ])('the hidden page keeps polling in %s: %s', async (phase, polling) => {
    const { c } = setup();
    (c as unknown as { set(p: { phase: PlayerPhase }): void }).set({ phase });
    expect(c.hasActiveSession()).toBe(polling);
  });
});

// ---------------------------------------------------------------- tracks

describe('tracks', () => {
  it('audio always goes through ChangeTracks with the position; a new stream gets a new engine', async () => {
    const { c, api, engines, video } = setup();
    await c.start({ itemId: 'item-1' });
    video.media.currentTime = 20;
    await c.selectAudio('a2');
    expect(api.changeTracks).toHaveBeenCalledWith('s1', { audioTrackId: 'a2', positionMs: 20_000 });
    expect(engines).toHaveLength(2);
    expect(engines[1]?.startedAt).toBe(20);
  });

  it("a change the server cannot play (422) keeps the current playback with the server's reason", async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.changeTracks.mockRejectedValueOnce(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'E-AC-3 7.1: no decoder on this client' }));
    await c.selectAudio('a2');
    expect(engines).toHaveLength(1);
    expect(engines[0]?.destroyed).toBe(false);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', busy: false, notice: { code: 'NO_COMPATIBLE_PLAN', detail: 'E-AC-3 7.1: no decoder on this client' } });
  });

  it('a local subtitle shows at once and goes to ChangeTracks; the same stream keeps engine and render', async () => {
    const { c, api, engines, pgs } = setup();
    const tracks = (sel: string | null) => ({ audio: [audioTrack('a1', true)], subtitles: [subTrack('p1', { selected: sel === 'p1' }), subTrack('p2', { selected: sel === 'p2' })] });
    const first = session({ tracks: tracks(null) });
    api.start.mockResolvedValueOnce(first);
    const answer = deferred<PlaybackSession>();
    api.changeTracks.mockImplementationOnce(() => answer.promise);
    await c.start({ itemId: 'item-1' });
    expect(c.getSnapshot().subtitleOn).toBe(false);
    const p = c.selectSubtitle('p2');
    await flush();
    expect(c.getSnapshot()).toMatchObject({ subtitleTrackId: 'p2', subtitleOn: true });
    expect(pgs).toHaveLength(1);
    expect(api.changeTracks).toHaveBeenCalledWith('s1', { subtitleTrackId: 'p2', positionMs: 0 });
    // The server records the choice for the profile and does not touch the stream.
    answer.resolve({ ...first, tracks: tracks('p2') });
    await p;
    expect(engines).toHaveLength(1);
    expect(engines[0]?.destroyed).toBe(false);
    expect(pgs).toHaveLength(1);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', busy: false, subtitleTrackId: 'p2' });
    // Bound again: the engine's failures act.
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(api.reportFailure).toHaveBeenCalledTimes(1);
  });

  it('a local pick the server re-plans (new stream) replaces the engine; its 410 meanwhile is no failure', async () => {
    const { c, api, engines } = setup();
    const first = session({ tracks: { audio: [audioTrack('a1', true)], subtitles: [subTrack('p1')] } });
    api.start.mockResolvedValueOnce(first);
    const answer = deferred<PlaybackSession>();
    api.changeTracks.mockImplementationOnce(() => answer.promise);
    await c.start({ itemId: 'item-1' });
    const p = c.selectSubtitle('p1');
    await flush();
    engines[0]?.cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    answer.resolve({ ...first, stream: hlsStream('/s1/new/main.m3u8'), tracks: { audio: first.tracks.audio, subtitles: [subTrack('p1', { selected: true })] } });
    await p;
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(engines).toHaveLength(2);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', subtitleTrackId: 'p1' });
  });

  it('a burned track goes through ChangeTracks without showing anything first', async () => {
    const { c, api, pgs } = setup();
    api.start.mockResolvedValueOnce(session({ tracks: { audio: [audioTrack('a1', true)], subtitles: [burned('b1', false)] } }));
    await c.start({ itemId: 'item-1' });
    await c.selectSubtitle('b1');
    expect(api.changeTracks).toHaveBeenCalledWith('s1', { subtitleTrackId: 'b1', positionMs: 0 });
    expect(pgs).toHaveLength(0);
  });

  it('"Nessuno" goes to the server and shows the forced track the session keeps; the user\'s choice stays off', async () => {
    const { c, api, engines, pgs } = setup();
    const tracks = (selected: string | null) => ({
      audio: [audioTrack('a1', true)],
      subtitles: [subTrack('full', { selected: selected === 'full' }), subTrack('forced', { forced: true, selected: selected === 'forced' })],
    });
    const first = session({ tracks: tracks('full') });
    api.start.mockResolvedValueOnce(first);
    api.changeTracks.mockResolvedValueOnce({ ...first, tracks: tracks('forced') });
    await c.start({ itemId: 'item-1' });
    await flush();
    expect(c.getSnapshot()).toMatchObject({ subtitleTrackId: 'full', subtitleOn: true });
    await c.selectSubtitle(null);
    await flush();
    expect(api.changeTracks).toHaveBeenCalledWith('s1', { subtitleTrackId: null, positionMs: 0 });
    // Same stream: the engine stays; the forced track is on screen, but for "C" the subtitles are off.
    expect(engines).toHaveLength(1);
    expect(c.getSnapshot()).toMatchObject({ subtitleTrackId: 'forced', subtitleOn: false });
    expect(pgs.at(-1)).toBeDefined();
  });

  it('"Nessuno" refused (422): the previous track comes back, with the server\'s reason', async () => {
    const { c, api, pgs } = setup();
    api.start.mockResolvedValueOnce(withPgs());
    api.changeTracks.mockRejectedValueOnce(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'Forced subtitles cannot be turned off here.' }));
    await c.start({ itemId: 'item-1' });
    await flush();
    await c.selectSubtitle(null);
    await flush();
    expect(c.getSnapshot()).toMatchObject({ subtitleTrackId: 'p1', subtitleOn: true, notice: { detail: 'Forced subtitles cannot be turned off here.' } });
    expect(pgs).toHaveLength(2);
  });

  it('version change keeps the original position', async () => {
    const { c, api, video } = setup();
    await c.start({ itemId: 'item-1' });
    video.media.currentTime = 600;
    await c.selectVersion('file-2');
    expect(api.changeVersion).toHaveBeenCalledWith('s1', { fileId: 'file-2', positionMs: 600_000 });
  });

  it('a session that reports complete for the growing track on screen re-reads it (a missed subtitle_ready)', async () => {
    const { c, api, pgs } = setup();
    const growing = withPgs({ tracks: { audio: [audioTrack('a1', true)], subtitles: [subTrack('p1', { selected: true, availability: 'growing' })] } });
    api.start.mockResolvedValueOnce(growing);
    api.changeTracks.mockResolvedValueOnce({ ...growing, tracks: { audio: growing.tracks.audio, subtitles: [subTrack('p1', { selected: true, availability: 'complete' })] } });
    await c.start({ itemId: 'item-1' });
    await flush();
    await c.selectSubtitle('p1');
    await flush();
    expect(pgs).toHaveLength(1);
    expect(pgs[0]?.loads).toEqual(['/video/media/sessions/s/subtitles/p1.sup']);
  });

  it.each<[string, (c: PlayerController) => Promise<void>]>([
    ['audio', (c) => c.selectAudio('a2')],
    ['subtitles', (c) => c.selectSubtitle(null)],
    ['version', (c) => c.selectVersion('file-2')],
  ])('no %s change behind a failure or end dialog', async (_name, act) => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1' });
    c.onEvent({ seq: 3, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'terminated' });
    api.changeTracks.mockRejectedValueOnce(apiError(410, 'SESSION_EXPIRED'));
    await act(c);
    expect(api.changeTracks).not.toHaveBeenCalled();
    expect(api.changeVersion).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().phase).toBe('terminated');
  });
});

// ---------------------------------------------------------------- the engine during a change (B2)

describe('the engine while the server replaces its stream (B2)', () => {
  it('a 410 of the current engine while ChangeTracks runs: no stop, no new start, and the pick survives', async () => {
    const { c, api, engines, video } = setup();
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    video.advanceTo(20);
    const answer = deferred<PlaybackSession>();
    api.changeTracks.mockImplementationOnce(() => answer.promise);
    const p = c.selectAudio('a2');
    await flush();
    // The server stopped the old stream (new token): hls.js asks the next fragment and gets 410.
    engines[0]?.cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    engines[0]?.cb.onTimelineOffset(999);
    await flush();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.reportFailure).not.toHaveBeenCalled();
    answer.resolve(session({ sessionId: 's1', stream: hlsStream('/s1/newtoken/main.m3u8'), tracks: { audio: [audioTrack('a1', false), audioTrack('a2', true)], subtitles: [] } }));
    await p;
    expect(engines).toHaveLength(2);
    expect(engines[0]?.destroyed).toBe(true);
    expect(engines[1]).toMatchObject({ startedAt: 20, session: { stream: { url: '/s1/newtoken/main.m3u8' } } });
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', attempts: 0, timelineOffsetMs: 0 });
    // A later restart keeps the user's pick, with its fileId.
    engines[1]?.cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ fileId: 'file-1', audioTrackId: 'a2' });
  });

  it('a plain 422 binds the engine again: its failures act', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.changeVersion.mockRejectedValueOnce(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'HDR10 on SDR' }));
    await c.selectVersion('file-2');
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(api.reportFailure).toHaveBeenCalledTimes(1);
  });

  it('a subtitle failure while a change runs is stale', async () => {
    const { c, api } = setup();
    api.start.mockResolvedValueOnce(withPgs());
    await c.start({ itemId: 'item-1' });
    const answer = deferred<PlaybackSession>();
    api.changeTracks.mockImplementationOnce(() => answer.promise);
    const p = c.selectAudio('a2');
    await flush();
    subtitleFailure(c, 'p1', '/video/media/sessions/s/subtitles/p1.sup');
    await flush();
    expect(api.reportFailure).not.toHaveBeenCalled();
    answer.resolve(session());
    await p;
  });
});

// ---------------------------------------------------------------- subtitle failures (M2, M3)

describe('subtitle failures', () => {
  it('re-plan like any other failure: the video plays until the new stream, which gets a new engine', async () => {
    const { c, api, engines } = setup({ loadPgs: () => Promise.reject(new Error('chunk')) });
    const first = withPgs();
    api.start.mockResolvedValueOnce(first);
    const report = deferred<PlaybackSession>();
    api.reportFailure.mockImplementationOnce(() => report.promise);
    await c.start({ itemId: 'item-1' });
    await flush();
    expect(api.reportFailure).toHaveBeenCalledWith('s1', { positionMs: 0, error: 'SUBTITLE_LOAD_FAILED:p1', suspect: 'subtitle' });
    expect(engines[0]?.destroyed).toBe(false);
    expect(c.getSnapshot().phase).toBe('replanning');
    // The kept engine is detached: its 410 on the stopped stream is no failure.
    engines[0]?.cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    // As the server does: a re-plan issues a new token, so new locators; the subtitle is now burned in.
    report.resolve({ ...first, stream: hlsStream('/video/media/sessions/s1/replanned/main.m3u8'), tracks: { audio: first.tracks.audio, subtitles: [subTrack('p1', { selected: false }), burned('b1', true)] } });
    await flush();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(engines[0]?.destroyed).toBe(true);
    expect(engines[1]?.session.stream.url).toBe('/video/media/sessions/s1/replanned/main.m3u8');
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', subtitleTrackId: 'b1', attempts: 1 });
  });

  it('a 503 on the subtitle url is no failure: "in preparazione" for that track, then it loads', async () => {
    let n = 0;
    const { c, api, pgs } = setup({
      pgsReady: () => (++n === 1 ? Promise.reject(new Error('503')) : new Promise<void>(() => undefined)),
      subtitleFetch: answering({ status: 503, retryAfter: '3' }, { status: 206 }),
    });
    api.start.mockResolvedValueOnce(withPgs());
    await c.start({ itemId: 'item-1' });
    await flush();
    await flush();
    expect(c.getSnapshot().subtitlePreparing).toBe('p1');
    expect(c.getSnapshot().phase).toBe('ready');
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.getSnapshot().subtitlePreparing).toBeNull();
    expect(pgs).toHaveLength(2);
    expect(api.reportFailure).not.toHaveBeenCalled();
  });

  it('after the player gave up, a late subtitle failure does nothing', async () => {
    const pgsLoad = deferred<PgsFactory>();
    const { c, api, engines } = setup({ loadPgs: () => pgsLoad.promise });
    api.start.mockResolvedValueOnce(withPgs());
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(500, 'STREAM_FAILED'));
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(c.getSnapshot().phase).toBe('failed');
    pgsLoad.reject(new Error('410'));
    await flush();
    subtitleFailure(c, 'p1', '/video/media/sessions/s/subtitles/p1.sup');
    await flush();
    expect(api.reportFailure).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().phase).toBe('failed');
    expect(engines).toHaveLength(1);
  });

  it('a failure for a url that is not in the current session is stale', async () => {
    const { c, api } = setup();
    api.start.mockResolvedValueOnce(withPgs());
    await c.start({ itemId: 'item-1' });
    subtitleFailure(c, 'p1', '/video/media/sessions/OLD/subtitles/p1.sup');
    subtitleFailure(c, 'zz', '/video/media/sessions/s/subtitles/p1.sup');
    await flush();
    expect(api.reportFailure).not.toHaveBeenCalled();
  });

  it('a failure dialog removes the subtitles from the screen', async () => {
    const { c, api, pgs } = setup();
    api.start.mockResolvedValueOnce(withPgs());
    await c.start({ itemId: 'item-1' });
    await flush();
    api.changeTracks.mockRejectedValueOnce(apiError(500, 'STREAM_FAILED'));
    await c.selectAudio('a2');
    expect(c.getSnapshot().phase).toBe('failed');
    expect(pgs[0]?.dispose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- contract after F1b.2

describe('track ids, 503, 500 and 422 on session changes', () => {
  it('a restart after a closed session keeps the picked audio track with the fileId of its version', async () => {
    const { c, api, video } = setup();
    await c.start({ itemId: 'item-1' });
    video.media.currentTime = 30;
    api.changeTracks.mockRejectedValueOnce(apiError(410, 'SESSION_EXPIRED'));
    await c.selectAudio('a2');
    expect(api.stop).toHaveBeenCalledWith('s1', 30_000);
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ fileId: 'file-1', audioTrackId: 'a2', startPositionMs: 30_000 });
  });

  it('track ids without a fileId are dropped when the item may have several versions (400)', async () => {
    const { c, api, deps } = setup();
    await c.start({ itemId: 'item-1', audioTrackId: 'a2', subtitleTrackId: 'x', versionCount: 2 });
    const body = api.start.mock.calls[0]?.[0];
    expect(body).not.toHaveProperty('audioTrackId');
    expect(body).not.toHaveProperty('subtitleTrackId');
    expect(deps.log).toHaveBeenCalledWith('warn', 'track ids without fileId dropped', expect.anything());
    // An unknown version count counts as several.
    const other = setup();
    await other.c.start({ itemId: 'item-1', audioTrackId: 'a2' });
    expect(other.api.start.mock.calls[0]?.[0]).not.toHaveProperty('audioTrackId');
  });

  it('with a single version, track ids go without a fileId', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1', audioTrackId: 'a2', subtitleTrackId: 'x', versionCount: 1 });
    expect(api.start.mock.calls[0]?.[0]).toMatchObject({ audioTrackId: 'a2', subtitleTrackId: 'x' });
    expect(api.start.mock.calls[0]?.[0]).not.toHaveProperty('fileId');
  });

  it('"off" at start needs no fileId', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1', subtitleTrackId: null });
    expect(api.start.mock.calls[0]?.[0]).toMatchObject({ subtitleTrackId: null });
    expect(api.start.mock.calls[0]?.[0]).not.toHaveProperty('fileId');
  });

  it.each(['STREAM_PREPARING', 'MEDIA_UNAVAILABLE'])('503 %s on ChangeTracks: no stream meanwhile, "in preparazione", same call after Retry-After', async (code) => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.changeTracks.mockRejectedValueOnce(apiError(503, code, { retryAfterMs: 4000 }));
    const done = c.selectAudio('a2');
    await flush();
    expect(engines[0]?.destroyed).toBe(true);
    expect(c.getSnapshot().phase).toBe('preparing');
    await vi.advanceTimersByTimeAsync(3999);
    expect(api.changeTracks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(api.changeTracks).toHaveBeenCalledTimes(2);
    expect(api.changeTracks.mock.calls[1]).toEqual(api.changeTracks.mock.calls[0]);
    expect(engines).toHaveLength(2);
    expect(c.getSnapshot().phase).toBe('ready');
  });

  it('503 on a change gives up after 60 s with "Riprova"; the heartbeat kept the session alive meanwhile', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1' });
    api.changeTracks.mockRejectedValue(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 5000 }));
    const done = c.selectAudio('a2');
    await vi.advanceTimersByTimeAsync(PREPARING_LIMIT_MS + 5000);
    await done;
    expect(c.getSnapshot()).toMatchObject({ phase: 'error', error: { code: 'STREAM_PREPARING' } });
    expect(api.changeTracks.mock.calls.length).toBeLessThanOrEqual(13);
    expect(api.reportProgress).toHaveBeenCalledWith('s1', expect.objectContaining({ state: 'buffering' }));
  });

  it('a second change during a 503 wait replaces the first, which never repeats', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    api.changeTracks.mockRejectedValueOnce(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 5000 }));
    const first = c.selectAudio('a2');
    await flush();
    expect(c.getSnapshot().phase).toBe('preparing');
    api.changeVersion.mockResolvedValueOnce(session({ sessionId: 's1', fileId: 'file-2' }));
    await c.selectVersion('file-2');
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { fileId: 'file-2' } });
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(api.changeTracks).toHaveBeenCalledTimes(1);
    expect(engines).toHaveLength(2);
    expect(last(engines).session.fileId).toBe('file-2');
  });

  it('503 on reportPlaybackFailure waits too, then plays the new session', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 1000 }));
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'audio', error: 'x' });
    await flush();
    expect(c.getSnapshot().phase).toBe('preparing');
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(api.reportFailure).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot().phase).toBe('ready');
  });

  it.each([
    ['ChangeTracks', (c: PlayerController) => c.selectAudio('a2'), 'changeTracks'],
    ['ChangeVersion', (c: PlayerController) => c.selectVersion('file-2'), 'changeVersion'],
  ] as const)('500 STREAM_FAILED on %s: attempts used up, reasons and "Riprova"', async (_n, act, method) => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1' });
    api[method].mockRejectedValueOnce(apiError(500, 'STREAM_FAILED'));
    await act(c);
    expect(c.getSnapshot()).toMatchObject({ phase: 'failed', error: { code: 'STREAM_FAILED' } });
  });

  it('500 STREAM_FAILED on reportPlaybackFailure ends the automatic attempts', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(500, 'STREAM_FAILED'));
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(c.getSnapshot().phase).toBe('failed');
  });

  it('a 422 with sessionClosed closed the session, whatever its text', () => {
    expect(isClosedRefusal(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'Nessun piano.', sessionClosed: true }))).toBe(true);
    expect(isClosedRefusal(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'No plan.', sessionClosed: false }))).toBe(false);
    expect(isClosedRefusal(apiError(410, 'SESSION_EXPIRED', { sessionClosed: true }))).toBe(false);
  });

  it("fallback: the closed-session text of a server without the field is still matched", () => {
    // services/video/src/modules/playback/sessions.ts, refusedWhileWaiting(): `${why} The session was closed: …`
    const detail = 'No plan for file-2: HDR10 needs a Transcode. The session was closed: its previous tracks could not be played either.';
    expect(isClosedRefusal(apiError(422, 'NO_COMPATIBLE_PLAN', { detail }))).toBe(true);
    expect(isClosedRefusal(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'No plan for file-2: HDR10 needs a Transcode.' }))).toBe(false);
    expect(isClosedRefusal(apiError(410, 'SESSION_EXPIRED', { detail }))).toBe(false);
    // The same text since the reasons are Italian (F2b): `${why} La sessione è stata chiusa: …`
    const italian = 'Sottotitoli VobSub (fre) non visualizzabili. La sessione è stata chiusa: nemmeno le tracce precedenti si possono riprodurre.';
    expect(isClosedRefusal(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: italian }))).toBe(true);
  });

  it('a 422 that closed the session restarts; a plain 422 keeps the stream', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.changeVersion.mockRejectedValueOnce(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'No plan for this version. The session was closed: its previous tracks could not be played either.' }));
    await c.selectVersion('file-2');
    expect(api.start).toHaveBeenCalledTimes(2);
    // Track ids are file-local: the new version starts without the old picks.
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ fileId: 'file-2' });
    expect(api.start.mock.calls[1]?.[0]).not.toHaveProperty('audioTrackId');

    api.changeTracks.mockRejectedValueOnce(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'Track not playable.' }));
    await c.selectAudio('a2');
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(engines.at(-1)?.destroyed).toBe(false);

    api.changeTracks.mockRejectedValueOnce(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'No plan.', sessionClosed: true }));
    await c.selectAudio('a2');
    expect(api.start).toHaveBeenCalledTimes(3);
  });

  it('a 422 while the session waits for its stream: the server went back to the old tracks, the client fetches that stream', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.changeTracks.mockRejectedValueOnce(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 5000 }));
    void c.selectAudio('a2');
    await flush();
    api.changeVersion.mockRejectedValueOnce(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: 'HDR10 on SDR' }));
    api.changeTracks.mockResolvedValueOnce(session({ sessionId: 's1', stream: hlsStream('/s1/back/main.m3u8') }));
    await c.selectVersion('file-2');
    expect(api.changeTracks).toHaveBeenLastCalledWith('s1', { positionMs: 0 });
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', notice: { detail: 'HDR10 on SDR' } });
    expect(last(engines).session.stream.url).toBe('/s1/back/main.m3u8');
  });

  it('after a version change a restart uses the new fileId', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    api.changeVersion.mockResolvedValueOnce(session({ fileId: 'file-2' }));
    await c.selectVersion('file-2');
    engines.at(-1)?.cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(api.start.mock.calls.at(-1)?.[0]).toMatchObject({ fileId: 'file-2' });
  });
});

// ---------------------------------------------------------------- events

describe('events from the poller', () => {
  const ready = (sessionId: string, trackId: string): AppEvent => ({ seq: 1, at: 0, type: 'playback.subtitle_ready', sessionId, trackId, availability: 'complete' });

  it('playback.subtitle_ready re-reads the selected growing track', async () => {
    const { c, api, pgs } = setup();
    api.start.mockResolvedValueOnce(session({ tracks: { audio: [audioTrack('a1', true)], subtitles: [subTrack('p1', { selected: true, availability: 'growing' })] } }));
    await c.start({ itemId: 'item-1' });
    await flush();
    expect(pgs).toHaveLength(1);
    c.onEvent(ready('other-session', 'p1'));
    expect(pgs[0]?.loads).toEqual([]);
    c.onEvent(ready('s1', 'p1'));
    expect(pgs[0]?.loads).toEqual(['/video/media/sessions/s/subtitles/p1.sup']);
    expect(c.getSnapshot().session?.tracks.subtitles[0]?.availability).toBe('complete');
  });

  it('playback.session_terminated stops this session only', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    c.onEvent({ seq: 2, at: 0, type: 'playback.session_terminated', sessionId: 'other', reason: null });
    expect(c.getSnapshot().phase).toBe('ready');
    c.onEvent({ seq: 3, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'terminated' });
    expect(c.getSnapshot()).toMatchObject({ phase: 'terminated', terminatedReason: 'terminated' });
    expect(engines[0]?.destroyed).toBe(true);
    expect(c.hasActiveSession()).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.reportProgress).not.toHaveBeenCalled();
  });

  it("session_terminated never replaces a dialog already on screen (the no-plan reason stays)", async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(422, 'NO_COMPATIBLE_PLAN', { detail: '4K: serve un Transcode, non disponibile' }));
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(c.getSnapshot().phase).toBe('no_plan');
    // The server ended the session ('failed') when it refused the re-plan, and says so on the event feed.
    c.onEvent({ seq: 9, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'failed' });
    expect(c.getSnapshot()).toMatchObject({ phase: 'no_plan', error: { code: 'NO_COMPATIBLE_PLAN', detail: '4K: serve un Transcode, non disponibile' }, terminatedReason: null });
  });

  it.each([
    ['failed', apiError(500, 'STREAM_FAILED')],
    ['network', apiError(0, 'NETWORK')],
  ] as const)('session_terminated leaves %s as it is', async (phase, err) => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(err);
    engines[0]?.cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(c.getSnapshot().phase).toBe(phase);
    c.onEvent({ seq: 9, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'failed' });
    expect(c.getSnapshot().phase).toBe(phase);
  });

  it('session_terminated leaves an expired session as it is', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportProgress.mockRejectedValueOnce(apiError(410, 'SESSION_EXPIRED'));
    await vi.advanceTimersByTimeAsync(10_000);
    c.onEvent({ seq: 9, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'expired' });
    expect(c.getSnapshot().phase).toBe('expired');
  });
});

// Keeps the import of the helper type used only in annotations above.
export type { FakeVideo };
