// The player across the seams with the server (F2 review): what happens when another device takes the slot, when
// the player gives up, when a 503 turns into a closed session, and when the server's attempts are used up. The
// real PlayerController with a fake PlaybackApi and fake engines. The second review adds the stop of a released
// session, heartbeats answered late, and the profile an automatic restart runs under.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCapabilities, PlaybackSession, SessionTrack } from '../api/types.ts';
import { createFakeVideo } from '../test/fakeVideo.ts';
import { CLOSED_REASON_TIMEOUT_MS, PlayerController, type PlayerDeps, STOP_WAIT_MS } from './controller.ts';
import type { Engine, EngineCallbacks } from './engine.ts';
import type { PlaybackApi, PlaybackApiError } from './types.ts';

function audio(id: string, selected: boolean): SessionTrack {
  return {
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
  };
}

let seq = 0;
function session(over: Partial<PlaybackSession> = {}): PlaybackSession {
  seq += 1;
  return {
    sessionId: `s${seq}`,
    expiresAt: Date.now() + 150_000,
    heartbeatIntervalMs: 10_000,
    itemId: 'item-1',
    fileId: 'file-1',
    mode: 'direct_stream',
    reasons: [],
    stream: {
      protocol: 'hls-fmp4',
      url: `/video/media/s/t${seq}/hls/main.m3u8`,
      mimeType: 'video/mp4; codecs="avc1.640028, flac"',
      mediaTimestampOffsetMs: 10_000,
      bitrate: { peakBps: null, averageBps: null, audioBps: null },
    },
    tracks: { audio: [audio('a1', true), audio('a2', false)], subtitles: [] },
    resumePositionMs: 0,
    durationMs: 7_200_000,
    chapters: [],
    ...over,
  };
}

function apiError(status: number, code: string, over: Partial<PlaybackApiError> = {}): PlaybackApiError {
  return { status, code, detail: null, retryAfterMs: null, activeSessions: [], ...over };
}
/** 410 SESSION_EXPIRED with the server's reason extension. */
const closed = (reason?: string) => apiError(410, 'SESSION_EXPIRED', reason ? { problem: { reason } } : {});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const video = createFakeVideo();
  const engines: (Engine & { cb: EngineCallbacks })[] = [];
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
  let hlsSupported = true;
  const deps: PlayerDeps = {
    api,
    probe: vi.fn(() =>
      Promise.resolve({
        capabilities: { protocols: ['progressive', 'hls-fmp4'] } as ClientCapabilities,
        preflightEnv: { isTypeSupported: () => true, canPlayType: () => 'maybe' as const },
        hlsSupported,
      }),
    ),
    createEngine: vi.fn((_v: HTMLVideoElement, s: PlaybackSession, cb: EngineCallbacks) => {
      const e = { protocol: s.stream.protocol, cb, start() {}, destroy() {} };
      engines.push(e);
      return Promise.resolve(e);
    }),
    subtitles: { loadPgs: () => Promise.reject(new Error('no')), fetch: vi.fn() as never },
    log: vi.fn(),
    win,
  };
  const c = new PlayerController(deps);
  c.attach(video);
  return {
    c,
    api,
    engines,
    video,
    win,
    noMse: () => {
      hlsSupported = false;
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
function lastOf<T>(xs: T[]): T {
  const x = xs[xs.length - 1];
  if (x === undefined) throw new Error('empty');
  return x;
}
/** Leaves the player: the page unmounts it (detach, then the teardown on the next macrotask). */
async function leave(c: PlayerController) {
  c.detach();
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  seq = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('point 1: "Interrompi l\'altra" ends the other player cleanly', () => {
  it('C1: the stream answers 410 and the control plane says terminated: "interrotta da un altro dispositivo", no new session', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportProgress.mockRejectedValueOnce(closed('terminated'));
    lastOf(engines).cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'terminated', terminatedReason: 'terminated', session: { sessionId: 's1' } });
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.stop).not.toHaveBeenCalled();
    // The event that follows changes nothing, and leaving sends nothing for the closed session.
    c.onEvent({ seq: 9, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'terminated' });
    await leave(c);
    expect(api.stop).not.toHaveBeenCalled();
  });

  it.each(['failed', 'item_removed'])('C1: a stream closed for %s ends the player with that reason', async (reason) => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportProgress.mockRejectedValueOnce(closed(reason));
    lastOf(engines).cb.onFailure({ kind: 'restart', error: 'HTTP_404' });
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'terminated', terminatedReason: reason });
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['expired (410 expired)', closed('expired')],
    ['unknown to the server (404, a restarted service)', apiError(404, 'NOT_FOUND')],
    ['a server without the reason (410)', closed()],
    ['still open (204: only its stream is gone)', null],
  ])('C2: a stream closed while the session is %s: stop, then a new session from the same position', async (_name, error) => {
    const { c, api, engines, video } = setup();
    await c.start({ itemId: 'item-1' });
    video.advanceTo(100);
    if (error) api.reportProgress.mockRejectedValueOnce(error);
    lastOf(engines).cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(api.reportProgress).toHaveBeenCalledWith('s1', expect.objectContaining({ positionMs: 100_000 }));
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('s1', 100_000);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ startPositionMs: 100_000 });
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('C2: a control plane that does not answer in time does not hold the player: it starts again', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportProgress.mockImplementationOnce(() => new Promise(() => undefined));
    lastOf(engines).cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await vi.advanceTimersByTimeAsync(CLOSED_REASON_TIMEOUT_MS - 1);
    expect(api.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.start).toHaveBeenCalledTimes(2);
  });

  it('C3: a paused player whose heartbeat finds the session terminated shows why, not "scaduta"', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportProgress.mockRejectedValueOnce(closed('terminated'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.getSnapshot()).toMatchObject({ phase: 'terminated', terminatedReason: 'terminated' });
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(engines).toHaveLength(1);
  });

  it('C3: a heartbeat that finds the session expired still offers to resume', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportProgress.mockRejectedValueOnce(closed('expired'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.getSnapshot().phase).toBe('expired');
  });

  it('C4: a track change on a terminated session ends the player; the change is not carried into "Riprendi"', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    api.changeTracks.mockRejectedValueOnce(closed('terminated'));
    await c.selectAudio('a2');
    expect(c.getSnapshot()).toMatchObject({ phase: 'terminated', terminatedReason: 'terminated' });
    expect(api.start).toHaveBeenCalledTimes(1);
    await c.retry();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1]?.[0].audioTrackId).toBeUndefined();
  });

  it('C4: reportPlaybackFailure on a session closed after a failure ends the player with that reason', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(closed('failed'));
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'terminated', terminatedReason: 'failed' });
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it('C5: "Riprova" after a failure is not cancelled by the late event about the session it replaced', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    // The server ends s1 after this failure and publishes the event; the poller delivers it late.
    api.reportFailure.mockRejectedValueOnce(apiError(500, 'STREAM_FAILED'));
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(c.getSnapshot().phase).toBe('failed');
    const start = deferred<PlaybackSession>();
    api.start.mockImplementationOnce(() => start.promise);
    const retry = c.retry();
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'starting', session: { sessionId: 's1' } });
    c.onEvent({ seq: 9, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'failed' });
    expect(c.getSnapshot().phase).toBe('starting');
    start.resolve(session());
    await retry;
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });
});

describe('point 2: leaving a failure dialog stops the session (it would hold the only slot until the timeout)', () => {
  it('A1: the client attempts are used up: StopPlayback at once, once, with the position; leaving sends nothing more', async () => {
    const { c, api, engines, video } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockImplementation(() => Promise.resolve(session({ sessionId: 's1' })));
    video.advanceTo(1_234);
    for (let i = 0; i < 4; i++) {
      lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'unknown', error: `E${i}` });
      await flush();
    }
    expect(c.getSnapshot().phase).toBe('failed');
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('s1', 1_234_000);
    await leave(c);
    expect(api.stop).toHaveBeenCalledTimes(1);
  });

  it('A2: 503 on ChangeTracks for 60 s, then the error dialog: the waiting session is stopped; no heartbeat after', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    api.changeTracks.mockRejectedValue(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 5000 }));
    const done = c.selectAudio('a2');
    await vi.advanceTimersByTimeAsync(65_000);
    await done;
    expect(c.getSnapshot().phase).toBe('error');
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('s1', 0);
    const beats = api.reportProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.reportProgress.mock.calls.length).toBe(beats);
    await leave(c);
    expect(api.stop).toHaveBeenCalledTimes(1);
  });

  it('A3: the network dialog, then pagehide and leaving: the session is stopped once', async () => {
    const { c, api, engines, win } = setup();
    await c.start({ itemId: 'item-1' });
    lastOf(engines).cb.onFailure({ kind: 'network', error: 'fragLoadError' });
    await flush();
    expect(c.getSnapshot().phase).toBe('network');
    win.dispatchEvent(new Event('pagehide'));
    await leave(c);
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(api.stop.mock.calls[0]?.[0]).toBe('s1');
  });

  it('A4: a stop that did not get through at the failure is sent again at pagehide (keepalive) and not again when leaving', async () => {
    const { c, api, engines, win } = setup();
    await c.start({ itemId: 'item-1' });
    api.stop.mockRejectedValueOnce(apiError(0, 'NETWORK'));
    lastOf(engines).cb.onFailure({ kind: 'network', error: 'fragLoadError' });
    await flush();
    win.dispatchEvent(new Event('pagehide'));
    // The dialog stays as it was (a back/forward cache restore shows it again).
    expect(c.getSnapshot().phase).toBe('network');
    await leave(c);
    expect(api.stop.mock.calls).toEqual([
      ['s1', 0],
      ['s1', 0, { keepalive: true }],
    ]);
  });

  it('A4: without pagehide, leaving sends the stop that did not get through', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.stop.mockRejectedValueOnce(apiError(0, 'NETWORK'));
    lastOf(engines).cb.onFailure({ kind: 'network', error: 'fragLoadError' });
    await flush();
    await leave(c);
    expect(api.stop).toHaveBeenCalledTimes(2);
  });

  it('A5: "Riprova" waits for the stop sent at the failure, so the new StartPlayback does not race it for the slot', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    const stop = deferred<void>();
    api.stop.mockImplementationOnce(() => stop.promise);
    lastOf(engines).cb.onFailure({ kind: 'network', error: 'fragLoadError' });
    await flush();
    const retry = c.retry();
    await flush();
    expect(api.start).toHaveBeenCalledTimes(1);
    stop.resolve();
    await retry;
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('A6: a stream this browser cannot play (no MSE): the session is stopped at once', async () => {
    const { c, api, noMse } = setup();
    noMse();
    await c.start({ itemId: 'item-1', startPositionMs: 5_000 });
    expect(c.getSnapshot()).toMatchObject({ phase: 'no_plan', error: { code: 'CLIENT_NO_MSE' } });
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('s1', 5_000);
  });

  it('A7: a terminated or expired session is not stopped when leaving (the server closed it)', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1' });
    c.onEvent({ seq: 1, at: 0, type: 'playback.session_terminated', sessionId: 's1', reason: 'terminated' });
    await leave(c);
    expect(api.stop).not.toHaveBeenCalled();
  });
});

describe('point 3: a 404/410 after a 503 is a closed session, not an error', () => {
  it('B1: reportPlaybackFailure 503 (Video Service restarting behind the gateway), then 404: a new session', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(503, 'MEDIA_UNAVAILABLE', { retryAfterMs: 5000 })).mockRejectedValueOnce(apiError(404, 'NOT_FOUND'));
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' });
    await flush();
    expect(c.getSnapshot().phase).toBe('preparing');
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.reportFailure).toHaveBeenCalledTimes(2);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' }, error: null });
  });

  it('B2: ChangeTracks 503, then 410: a new session that keeps the change', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    api.changeTracks.mockRejectedValueOnce(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 5000 })).mockRejectedValueOnce(closed('expired'));
    const p = c.selectAudio('a2');
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1]?.[0]).toMatchObject({ fileId: 'file-1', audioTrackId: 'a2' });
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('B3: ChangeTracks 503, then a 422 that closed the session: a new session too', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1', fileId: 'file-1' });
    api.changeTracks.mockRejectedValueOnce(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 1000 })).mockRejectedValueOnce(apiError(422, 'NO_COMPATIBLE_PLAN', { sessionClosed: true }));
    const p = c.selectAudio('a2');
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot().phase).toBe('ready');
  });

  it('B4: a 410 terminated after a 503 ends the player like any terminated session', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(503, 'STREAM_PREPARING', { retryAfterMs: 1000 })).mockRejectedValueOnce(closed('terminated'));
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'audio', error: 'x' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.getSnapshot()).toMatchObject({ phase: 'terminated', terminatedReason: 'terminated' });
    expect(api.start).toHaveBeenCalledTimes(1);
  });
});

describe('point 4: the file went away during an automatic re-plan', () => {
  it('503 MEDIA_UNAVAILABLE with sessionClosed: "file non raggiungibile" at once, no wait, no retry', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(503, 'MEDIA_UNAVAILABLE', { sessionClosed: true, detail: 'root Film offline' }));
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' });
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'error', error: { code: 'MEDIA_UNAVAILABLE', detail: 'root Film offline' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.reportFailure).toHaveBeenCalledTimes(1);
  });

  it('a 503 MEDIA_UNAVAILABLE without sessionClosed still waits ("in preparazione")', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(503, 'MEDIA_UNAVAILABLE', { retryAfterMs: 2000 }));
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' });
    await flush();
    expect(c.getSnapshot().phase).toBe('preparing');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.getSnapshot().phase).toBe('ready');
  });
});

describe('point 5: the server used up its attempts', () => {
  it('D1: 500 STREAM_FAILED from reportPlaybackFailure: the failed dialog (with "Riprova"), not "no compatible mode"', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportFailure.mockRejectedValueOnce(apiError(500, 'STREAM_FAILED', { detail: 'The playback failed again (x) and the 3 automatic attempts of this playback are used up.' }));
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'video', error: 'x' });
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'failed', error: { code: 'STREAM_FAILED' } });
    await c.retry();
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', attempts: 0 });
  });
});

describe('second review: the stop of a released session, late heartbeats, the profile of a restart', () => {
  it('R1: "Riprova" behind a release stop that never answers waits STOP_WAIT_MS with feedback, sends the stop again and starts', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.stop.mockImplementationOnce(() => new Promise<void>(() => undefined));
    lastOf(engines).cb.onFailure({ kind: 'network', error: 'fragLoadError' });
    await flush();
    expect(c.getSnapshot().phase).toBe('network');
    const retry = c.retry();
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'starting', busy: true });
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS - 1);
    expect(api.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(api.stop.mock.calls.map((x) => x[0])).toEqual(['s1', 's1']);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', busy: false, session: { sessionId: 's2' } });
  });

  it('R1: a new start of another item is not held by it either', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.stop.mockImplementationOnce(() => new Promise<void>(() => undefined));
    lastOf(engines).cb.onFailure({ kind: 'network', error: 'fragLoadError' });
    await flush();
    const start = c.start({ itemId: 'item-2' });
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS);
    await start;
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('a stop that answers before STOP_WAIT_MS is not sent again', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    const stop = deferred<void>();
    api.stop.mockImplementationOnce(() => stop.promise);
    lastOf(engines).cb.onFailure({ kind: 'network', error: 'fragLoadError' });
    await flush();
    const retry = c.retry();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.start).toHaveBeenCalledTimes(1);
    stop.resolve();
    await retry;
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledTimes(2);
  });

  it('an automatic restart behind a stop that never answers starts after STOP_WAIT_MS', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    api.stop.mockImplementationOnce(() => new Promise<void>(() => undefined));
    lastOf(engines).cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'replanning', busy: true });
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('R2: pagehide while the release stop runs sends it again with keepalive', async () => {
    const { c, api, engines, win } = setup();
    await c.start({ itemId: 'item-1' });
    api.stop.mockImplementationOnce(() => new Promise<void>(() => undefined));
    api.reportFailure.mockRejectedValueOnce(apiError(500, 'STREAM_FAILED'));
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'unknown', error: 'x' });
    await flush();
    expect(c.getSnapshot().phase).toBe('failed');
    win.dispatchEvent(new Event('pagehide'));
    expect(api.stop.mock.calls).toEqual([
      ['s1', 0],
      ['s1', 0, { keepalive: true }],
    ]);
    // The failure dialog stays as it is.
    expect(c.getSnapshot().phase).toBe('failed');
  });

  it('R6: a heartbeat sent before the stream closed, answering 410 "stopped" (the restart\'s own stop) once it ran, is stale', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    const beat = deferred<void>();
    api.reportProgress.mockImplementationOnce(() => beat.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.reportProgress).toHaveBeenCalledTimes(1);
    const stop = deferred<void>();
    api.stop.mockImplementationOnce(() => stop.promise);
    lastOf(engines).cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(api.stop).toHaveBeenCalledWith('s1', 0);
    beat.reject(closed('stopped'));
    await flush();
    stop.resolve();
    await flush();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('R6: a heartbeat answering 410 "expired" while a re-plan runs leaves the re-plan to decide', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    const beat = deferred<void>();
    api.reportProgress.mockImplementationOnce(() => beat.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    const replan = deferred<PlaybackSession>();
    api.reportFailure.mockImplementationOnce(() => replan.promise);
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'audio', error: 'x' });
    await flush();
    expect(c.getSnapshot().phase).toBe('replanning');
    beat.reject(closed('expired'));
    await flush();
    expect(c.getSnapshot().phase).toBe('replanning');
    replan.resolve(session());
    await flush();
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('point 5: an automatic restart starts as the session it replaces (its profile), a "Riprova" as the stored profile', async () => {
    const { c, api, engines } = setup();
    await c.start({ itemId: 'item-1' });
    expect(api.start.mock.calls[0]).toHaveLength(1);
    lastOf(engines).cb.onFailure({ kind: 'restart', error: 'HTTP_410' });
    await flush();
    expect(api.start.mock.calls[1]?.[1]).toEqual({ asSession: 's1' });
    api.reportFailure.mockRejectedValueOnce(apiError(500, 'STREAM_FAILED'));
    lastOf(engines).cb.onFailure({ kind: 'replan', suspect: 'unknown', error: 'x' });
    await flush();
    await c.retry();
    expect(api.start.mock.calls[2]).toHaveLength(1);
  });

  it('point 5: back from the back/forward cache, the new session starts as the stopped one', async () => {
    const { c, api, win } = setup();
    await c.start({ itemId: 'item-1' });
    win.dispatchEvent(new Event('pagehide'));
    expect(c.getSnapshot().phase).toBe('stopped');
    win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await flush();
    expect(api.start.mock.calls[1]?.[1]).toEqual({ asSession: 's1' });
    expect(c.getSnapshot()).toMatchObject({ phase: 'ready', session: { sessionId: 's2' } });
  });

  it('R4: "Riprova" on an expired session that then gets 409 does not stop the closed session again', async () => {
    const { c, api } = setup();
    await c.start({ itemId: 'item-1' });
    api.reportProgress.mockRejectedValueOnce(closed('expired'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.getSnapshot().phase).toBe('expired');
    api.start.mockRejectedValueOnce(apiError(409, 'SESSION_LIMIT_REACHED'));
    await c.retry();
    expect(c.getSnapshot().phase).toBe('session_limit');
    expect(api.stop).not.toHaveBeenCalled();
  });
});
