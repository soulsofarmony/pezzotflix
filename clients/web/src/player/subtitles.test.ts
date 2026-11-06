import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionTrack } from '../api/types.ts';
import { createFakeVideo } from '../test/fakeVideo.ts';
import { isLocalTrack, type PgsLike, SUBTITLE_PREPARING_LIMIT_MS, SubtitleRenderer, type SubtitleDeps } from './subtitles.ts';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const track = (over: Partial<SessionTrack>): SessionTrack => ({
  id: 'sub-1',
  type: 'subtitle',
  index: 3,
  codec: 'hdmv_pgs_subtitle',
  language: 'ita',
  title: null,
  default: false,
  forced: false,
  sdh: false,
  commentary: false,
  channels: null,
  channelLayout: null,
  objectAudio: null,
  subtitleKind: 'image',
  selected: true,
  switchWithoutRestart: true,
  delivery: 'client_render',
  url: '/video/media/sessions/s1/subtitles/sub-1.sup?st=x',
  availability: 'complete',
  ...over,
});

interface FakePgs extends PgsLike {
  renders: number[];
  loads: string[];
  disposed: boolean;
  rejectReady(e: Error): void;
}

function pgsFactory() {
  const created: { opts: { subUrl: string; timeOffset: number }; pgs: FakePgs }[] = [];
  const factory = vi.fn((opts: { video: HTMLVideoElement; subUrl: string; timeOffset: number }) => {
    let reject: (e: Error) => void = () => undefined;
    const ready = new Promise<void>((_res, rej) => {
      reject = rej;
    });
    const pgs: FakePgs = {
      timeOffset: opts.timeOffset,
      ready,
      renders: [],
      loads: [],
      disposed: false,
      renderAtTimestamp(t) {
        this.renders.push(t);
      },
      loadFromUrl(url) {
        this.loads.push(url);
        return Promise.resolve();
      },
      dispose() {
        this.disposed = true;
      },
      rejectReady: (e) => reject(e),
    };
    created.push({ opts, pgs });
    return pgs;
  });
  return { factory, created };
}

/**
 * The status the subtitle url answers to the probe after a failed load (200 unless a test says otherwise);
 * with a code, a Problem body as the server sends it.
 */
const answering = (...statuses: { status: number; retryAfter?: string; code?: string }[]) => {
  const queue = [...statuses];
  return vi.fn(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const headers: Record<string, string> = next?.retryAfter ? { 'Retry-After': next.retryAfter } : {};
    const status = next?.status ?? 200;
    if (!next?.code) return Promise.resolve(new Response(null, { status, headers }));
    const body = JSON.stringify({ type: 'about:blank', title: 'Unavailable', status, code: next.code });
    return Promise.resolve(new Response(body, { status, headers: { ...headers, 'Content-Type': 'application/problem+json' } }));
  });
};

function setup(extra: Partial<SubtitleDeps> = {}) {
  const video = createFakeVideo();
  const { factory, created } = pgsFactory();
  const deps: SubtitleDeps = { loadPgs: () => Promise.resolve(factory), onFailure: vi.fn(), onPreparing: vi.fn(), log: vi.fn(), fetch: answering({ status: 200 }), ...extra };
  const r = new SubtitleRenderer(video, deps);
  return { video, r, deps, created };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('isLocalTrack', () => {
  it.each([
    ['client_render with url', track({}), true],
    ['sidecar with url', track({ delivery: 'sidecar' }), true],
    ['without url', track({ url: null }), false],
    ['not switchable', track({ switchWithoutRestart: false }), false],
    ['burned', track({ delivery: 'burned' }), false],
    ['embedded', track({ delivery: 'embedded' }), false],
    ['unknown delivery', track({ delivery: null }), false],
  ])('%s → %s', (_n, t, expected) => {
    expect(isLocalTrack(t)).toBe(expected);
  });
});

describe('PGS with libpgs (S2 configuration)', () => {
  it('renders at every video frame on the original timeline', async () => {
    const { video, r, created } = setup();
    r.setOffset(3_600_000);
    r.show(track({}));
    await flush();
    const first = created[0];
    expect(first?.opts).toMatchObject({ subUrl: track({}).url, timeOffset: 3600 });
    video.runFrame(12.5);
    video.runFrame(12.54);
    expect(first?.pgs.renders).toEqual([3612.5, 3612.54]);
  });

  it('follows a new timeline offset in timeOffset and in the rVFC loop', async () => {
    const { video, r, created } = setup();
    r.show(track({}));
    await flush();
    r.setOffset(60_000);
    expect(created[0]?.pgs.timeOffset).toBe(60);
    video.runFrame(1);
    expect(created[0]?.pgs.renders).toEqual([61]);
  });

  it('re-reads the url when the track becomes complete, without a new renderer', async () => {
    const { r, created } = setup();
    const growing = track({ availability: 'growing' });
    r.show(growing);
    await flush();
    r.reload('sub-1', { ...growing, availability: 'complete' });
    expect(created).toHaveLength(1);
    expect(created[0]?.pgs.loads).toEqual([growing.url]);
    // Another track id: nothing.
    r.reload('sub-2', growing);
    expect(created[0]?.pgs.loads).toHaveLength(1);
  });

  it('reports a failed load of the .sup with its url, once, for the current selection only', async () => {
    const { r, deps, created } = setup({ fetch: answering({ status: 404 }) as unknown as typeof fetch });
    r.show(track({}));
    await flush();
    created[0]?.pgs.rejectReady(new Error('404'));
    await vi.waitFor(() => expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('sub-1', track({}).url));

    r.show(track({ id: 'sub-2', url: '/b.sup' }));
    await flush();
    r.show(null);
    created[1]?.pgs.rejectReady(new Error('late'));
    await flush();
    await flush();
    expect(deps.onFailure).toHaveBeenCalledTimes(1);
  });

  it('the session reporting complete for the loaded growing track re-reads it (a missed subtitle_ready)', async () => {
    const { r, created, deps } = setup();
    const growing = track({ availability: 'growing' });
    r.show(growing);
    await flush();
    r.show(growing);
    expect(created[0]?.pgs.loads).toEqual([]);
    r.show({ ...growing, availability: 'complete' });
    expect(created).toHaveLength(1);
    expect(created[0]?.pgs.loads).toEqual([growing.url]);
    expect(deps.log).toHaveBeenCalledWith('info', 'subtitle complete (from the session), reloading', { trackId: 'sub-1' });
    // Complete already: nothing more.
    r.show({ ...growing, availability: 'complete' });
    expect(created[0]?.pgs.loads).toHaveLength(1);
  });

  it('stops the frame loop and disposes on clear', async () => {
    const { video, r, created } = setup();
    r.show(track({}));
    await flush();
    r.clear();
    expect(created[0]?.pgs.disposed).toBe(true);
    expect(video.frameCallbacks.size).toBe(0);
    expect(r.trackId).toBeNull();
  });

  it('a failed libpgs import is a subtitle failure, without asking the url', async () => {
    const fetchFn = answering({ status: 503 });
    const { r, deps } = setup({ loadPgs: () => Promise.reject(new Error('chunk')), fetch: fetchFn as unknown as typeof fetch });
    r.show(track({}));
    await vi.waitFor(() => expect(deps.onFailure).toHaveBeenCalledWith('sub-1', track({}).url));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('a subtitle url answering 503 (extraction not started, ADR 0003 D12 fallback)', () => {
  it('is not a failure: "in preparazione", Retry-After, then a new load once the url answers', async () => {
    vi.useFakeTimers();
    const fetchFn = answering({ status: 503, retryAfter: '3' }, { status: 503, retryAfter: '3' }, { status: 200 });
    const { r, deps, created } = setup({ fetch: fetchFn as unknown as typeof fetch });
    r.show(track({ availability: 'growing' }));
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.pgs.rejectReady(new Error('503'));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onPreparing).toHaveBeenCalledWith('sub-1', true);
    expect(created[0]?.pgs.disposed).toBe(true);
    // Still 503 at the first retry: no loader is created, the wait goes on.
    await vi.advanceTimersByTimeAsync(3000);
    expect(created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(created).toHaveLength(2);
    expect(deps.onPreparing).toHaveBeenLastCalledWith('sub-1', false);
    expect(deps.onFailure).not.toHaveBeenCalled();
    expect(r.trackId).toBe('sub-1');
  });

  it('gives up after the limit with a failure', async () => {
    vi.useFakeTimers();
    const { r, deps, created } = setup({ fetch: answering({ status: 503, retryAfter: '10' }) as unknown as typeof fetch });
    r.show(track({}));
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.pgs.rejectReady(new Error('503'));
    await vi.advanceTimersByTimeAsync(SUBTITLE_PREPARING_LIMIT_MS + 10_000);
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('sub-1', track({}).url);
    expect(deps.onPreparing).toHaveBeenLastCalledWith('sub-1', false);
  });

  it('a new selection cancels the wait', async () => {
    vi.useFakeTimers();
    const fetchFn = answering({ status: 503, retryAfter: '3' });
    const { r, deps, created } = setup({ fetch: fetchFn as unknown as typeof fetch });
    r.show(track({}));
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.pgs.rejectReady(new Error('503'));
    await vi.advanceTimersByTimeAsync(0);
    r.show(null);
    expect(deps.onPreparing).toHaveBeenLastCalledWith('sub-1', false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it('m3: 503 MEDIA_UNAVAILABLE without Retry-After on a complete track (the extraction failed) is a failure at once, without the wait', async () => {
    vi.useFakeTimers();
    const fetchFn = answering({ status: 503, code: 'MEDIA_UNAVAILABLE' });
    const { r, deps, created } = setup({ fetch: fetchFn as unknown as typeof fetch });
    r.show(track({}));
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.pgs.rejectReady(new Error('503'));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('sub-1', track({}).url);
    expect(deps.onPreparing).not.toHaveBeenCalledWith('sub-1', true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('m3: STREAM_PREPARING, MEDIA_UNAVAILABLE with Retry-After on a complete track (a file briefly unreachable), or on a growing one, still waits', async () => {
    vi.useFakeTimers();
    for (const [t, code] of [
      [track({}), 'STREAM_PREPARING'],
      [track({}), 'MEDIA_UNAVAILABLE'],
      [track({ availability: 'growing' }), 'MEDIA_UNAVAILABLE'],
    ] as const) {
      const { r, deps, created } = setup({ fetch: answering({ status: 503, retryAfter: '2', code }) as unknown as typeof fetch });
      r.show(t);
      await vi.advanceTimersByTimeAsync(0);
      created[0]?.pgs.rejectReady(new Error('503'));
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.onPreparing, code).toHaveBeenCalledWith('sub-1', true);
      expect(deps.onFailure, code).not.toHaveBeenCalled();
      r.destroy();
    }
  });

  it('m3: a wait whose track becomes complete fails at the next retry that answers MEDIA_UNAVAILABLE', async () => {
    vi.useFakeTimers();
    const fetchFn = answering({ status: 503, retryAfter: '3', code: 'STREAM_PREPARING' }, { status: 503, code: 'MEDIA_UNAVAILABLE' });
    const { r, deps, created } = setup({ fetch: fetchFn as unknown as typeof fetch });
    const growing = track({ availability: 'growing' });
    r.show(growing);
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.pgs.rejectReady(new Error('503'));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onPreparing).toHaveBeenCalledWith('sub-1', true);
    // The extraction failed: the session (playback.subtitle_ready) now reports the track complete.
    r.show({ ...growing, availability: 'complete' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('sub-1', growing.url);
    expect(deps.onPreparing).toHaveBeenLastCalledWith('sub-1', false);
    expect(created).toHaveLength(1);
  });

  it('the fetch fallback reads the 503 from its own response', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => Promise.resolve(new Response('', { status: 503, headers: { 'Retry-After': '2' } })));
    const { video, r, deps } = setup({ growingVtt: 'fetch', fetch: fetchFn as unknown as typeof fetch });
    video.addTextTrack = vi.fn(() => new FakeTextTrack() as unknown as TextTrack);
    r.show(vtt({ availability: 'growing' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onPreparing).toHaveBeenCalledWith('vtt-1', true);
    // The load itself told the status: no probe before the wait.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("the fetch fallback reads the Problem's code from its own response too", async () => {
    vi.useFakeTimers();
    const fetchFn = answering({ status: 503, retryAfter: '2', code: 'MEDIA_UNAVAILABLE' }, { status: 503, code: 'MEDIA_UNAVAILABLE' });
    const { video, r, deps } = setup({ growingVtt: 'fetch', fetch: fetchFn as unknown as typeof fetch });
    video.addTextTrack = vi.fn(() => new FakeTextTrack() as unknown as TextTrack);
    const growing = vtt({ availability: 'growing' });
    r.show(growing);
    await vi.advanceTimersByTimeAsync(0);
    // Growing: a file briefly not readable, so it waits.
    expect(deps.onPreparing).toHaveBeenCalledWith('vtt-1', true);
    r.show({ ...growing, availability: 'complete' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('vtt-1', growing.url);
  });
});

describe('m4: a growing response cut short', () => {
  it('is read again once when its url still answers 2xx; a second cut is a failure; a new selection may again', async () => {
    const fetchFn = answering({ status: 206 });
    const { r, deps, created } = setup({ fetch: fetchFn as unknown as typeof fetch });
    const growing = track({ availability: 'growing' });
    r.show(growing);
    await flush();
    created[0]?.pgs.rejectReady(new Error('network error'));
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(created[0]?.pgs.disposed).toBe(true);
    expect(deps.onFailure).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('info', 'subtitle response cut short, reading it again', { trackId: 'sub-1', err: 'Error: network error' });
    created[1]?.pgs.rejectReady(new Error('network error'));
    await vi.waitFor(() => expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('sub-1', growing.url));
    expect(created).toHaveLength(2);

    const other = track({ id: 'sub-2', url: '/b.sup', availability: 'growing' });
    r.show(other);
    await flush();
    created[2]?.pgs.rejectReady(new Error('network error'));
    await vi.waitFor(() => expect(created).toHaveLength(4));
    expect(deps.onFailure).toHaveBeenCalledTimes(1);
  });

  it('the once is given back when the new read delivers, or the track completes (a server-side restart of pass 1)', async () => {
    const growing = vtt({ availability: 'growing' });
    {
      const { video, r, deps } = setup({ fetch: answering({ status: 206 }) as unknown as typeof fetch });
      const current = () => video.querySelector('track[src]') as HTMLTrackElement;
      const cutAndReread = async () => {
        const el = current();
        el.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(current()).not.toBe(el));
      };
      r.show(growing);
      await cutAndReread();
      // The new read delivers cues: a later cut is read again too.
      (current().track as unknown as FakeTextTrack).addCue({ startTime: 1, endTime: 2, text: 'a' });
      video.advanceTo(1);
      await cutAndReread();
      // A cut after a read that delivered nothing: a failure.
      current().dispatchEvent(new Event('error'));
      await vi.waitFor(() => expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('vtt-1', growing.url));
      r.destroy();
    }
    {
      const { video, r, deps } = setup({ fetch: answering({ status: 206 }) as unknown as typeof fetch });
      r.show(growing);
      const first = video.querySelector('track[src]') as HTMLTrackElement;
      first.dispatchEvent(new Event('error'));
      await vi.waitFor(() => expect(video.querySelector('track[src]')).not.toBe(first));
      const second = video.querySelector('track[src]') as HTMLTrackElement;
      // The session reports the track complete (its re-read is a new hidden <track>); then the growing read is
      // cut: read again (the complete file), not a failure.
      r.show({ ...growing, availability: 'complete' });
      second.dispatchEvent(new Event('error'));
      await vi.waitFor(() => expect(deps.log).toHaveBeenCalledTimes(3));
      expect(deps.log).toHaveBeenNthCalledWith(2, 'info', 'subtitle complete (from the session), reloading', { trackId: 'vtt-1' });
      expect(deps.log).toHaveBeenLastCalledWith('info', 'subtitle response cut short, reading it again', { trackId: 'vtt-1', err: 'Error: track load error' });
      expect(deps.onFailure).not.toHaveBeenCalled();
    }
  });

  it('a complete track, or an error status, is a failure without a second read', async () => {
    for (const [t, status] of [
      [track({}), 200],
      [track({ availability: 'growing' }), 404],
    ] as const) {
      const { r, deps, created } = setup({ fetch: answering({ status }) as unknown as typeof fetch });
      r.show(t);
      await flush();
      created[0]?.pgs.rejectReady(new Error('cut'));
      await vi.waitFor(() => expect(deps.onFailure).toHaveBeenCalledTimes(1));
      expect(created).toHaveLength(1);
    }
  });
});

// jsdom has no TextTrack: give <track> a minimal one so the WebVTT path can run.
interface FakeCue {
  startTime: number;
  endTime: number;
  text: string;
}
class FakeTextTrack {
  mode: TextTrackMode = 'disabled';
  list: FakeCue[] = [];
  get cues() {
    return Object.assign([...this.list], { length: this.list.length });
  }
  addCue(c: FakeCue) {
    this.list.push(c);
  }
  removeCue(c: FakeCue) {
    this.list = this.list.filter((x) => x !== c);
  }
}

beforeAll(() => {
  if (!('track' in HTMLTrackElement.prototype)) {
    const tracks = new WeakMap<HTMLTrackElement, FakeTextTrack>();
    Object.defineProperty(HTMLTrackElement.prototype, 'track', {
      configurable: true,
      get(this: HTMLTrackElement) {
        let t = tracks.get(this);
        if (!t) {
          t = new FakeTextTrack();
          tracks.set(this, t);
        }
        return t;
      },
    });
  }
});

const vtt = (over: Partial<SessionTrack> = {}) => track({ id: 'vtt-1', codec: 'subrip', subtitleKind: 'text', delivery: 'sidecar', url: '/video/media/sessions/s1/subtitles/vtt-1.vtt?st=x', ...over });

describe('WebVTT sidecar with <track>', () => {
  it('adds a showing <track> and shifts its cues by −timelineOffsetMs at load', () => {
    const { video, r } = setup();
    r.setOffset(3_600_000);
    r.show(vtt());
    const el = video.querySelector('track');
    expect(el?.getAttribute('src')).toBe(vtt().url);
    expect(el?.track.mode).toBe('showing');
    const tt = el?.track as unknown as FakeTextTrack;
    tt.addCue({ startTime: 3_610, endTime: 3_612, text: 'a' });
    el?.dispatchEvent(new Event('load'));
    expect(tt.list[0]).toMatchObject({ startTime: 10, endTime: 12 });
    // A new offset re-shifts from the original times, not cumulatively.
    r.setOffset(3_605_000);
    expect(tt.list[0]).toMatchObject({ startTime: 5, endTime: 7 });
  });

  it('shifts cues that arrive while the file grows, at timeupdate', () => {
    const { video, r } = setup();
    r.setOffset(1000);
    r.show(vtt({ availability: 'growing' }));
    const tt = video.querySelector('track')?.track as unknown as FakeTextTrack;
    tt.addCue({ startTime: 20, endTime: 21, text: 'late' });
    video.advanceTo(5);
    expect(tt.list[0]).toMatchObject({ startTime: 19, endTime: 20 });
  });

  it('reload: a new <track> stays hidden until loaded, then replaces the old one', () => {
    const { video, r } = setup();
    r.show(vtt({ availability: 'growing' }));
    const first = video.querySelector('track');
    first?.dispatchEvent(new Event('load'));
    r.reload('vtt-1', vtt());
    const all = video.querySelectorAll('track');
    expect(all).toHaveLength(2);
    const second = all[1];
    expect(second?.track.mode).toBe('hidden');
    second?.dispatchEvent(new Event('load'));
    expect(video.querySelectorAll('track')).toHaveLength(1);
    expect(second?.track.mode).toBe('showing');
  });

  it('a <track> loses its src before it is removed (switched off, or replaced by a reload), so the browser drops its load', () => {
    const { video, r } = setup();
    const srcAtRemoval: (string | null)[] = [];
    const watch = (el: HTMLTrackElement | null | undefined) => {
      if (!el) throw new Error('no track');
      const remove = el.remove.bind(el);
      el.remove = () => {
        srcAtRemoval.push(el.getAttribute('src'));
        remove();
      };
    };
    r.show(vtt({ availability: 'growing' }));
    const first = video.querySelector('track');
    watch(first);
    r.reload('vtt-1', vtt());
    const second = video.querySelectorAll('track')[1];
    watch(second);
    second?.dispatchEvent(new Event('load'));
    r.show(null);
    expect(srcAtRemoval).toEqual([null, null]);
    expect(video.querySelectorAll('track')).toHaveLength(0);
  });

  it('a <track> error is a subtitle failure; clear removes only its own tracks', async () => {
    const { video, r, deps } = setup();
    const other = document.createElement('track');
    video.appendChild(other);
    r.show(vtt());
    video.querySelector('track[src]')?.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(deps.onFailure).toHaveBeenCalledWith('vtt-1', vtt().url));
    r.clear();
    expect([...video.querySelectorAll('track')]).toEqual([other]);
  });
});

describe('WebVTT fetch fallback for a growing track', () => {
  class Cue {
    startTime: number;
    endTime: number;
    text: string;
    constructor(s: number, e: number, t: string) {
      this.startTime = s;
      this.endTime = e;
      this.text = t;
    }
  }

  it('streams the response into VTTCues on the original timeline', async () => {
    vi.stubGlobal('VTTCue', Cue);
    const textTrack = new FakeTextTrack();
    const { video, r } = setup({
      growingVtt: 'fetch',
      fetch: () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('WEBVTT\n\n00:00:11.000 --> 00:00:12.000\nUno\n\n00:00:'));
            c.enqueue(enc.encode('13.000 --> 00:00:14.000\nDue\n'));
            c.close();
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    });
    video.addTextTrack = vi.fn(() => textTrack as unknown as TextTrack);
    r.setOffset(10_000);
    r.show(vtt({ availability: 'growing' }));
    await vi.waitFor(() => expect(textTrack.list).toHaveLength(2));
    expect(textTrack.mode).toBe('showing');
    expect(textTrack.list.map((c) => [c.startTime, c.endTime, c.text])).toEqual([
      [1, 2, 'Uno'],
      [3, 4, 'Due'],
    ]);
    vi.unstubAllGlobals();
  });

  it('switching the growing track off, or to another track, aborts its open response (F2 review, point 8)', async () => {
    const signals: AbortSignal[] = [];
    const { video, r } = setup({
      growingVtt: 'fetch',
      fetch: (_url, init) => {
        if (init?.signal) signals.push(init.signal);
        // Pass 1 of the extraction: the response stays open while the file grows.
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { status: 200 }));
      },
    });
    video.addTextTrack = vi.fn(() => new FakeTextTrack() as unknown as TextTrack);
    r.show(vtt({ availability: 'growing' }));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    r.show(vtt({ id: 'vtt-2', availability: 'growing', url: '/video/media/sessions/s1/subtitles/vtt-2.vtt?st=x' }));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals.map((x) => x.aborted)).toEqual([true, false]);
    r.show(null);
    expect(signals[1]?.aborted).toBe(true);
  });

  it('every load reuses the TextTrack of its label and language: the element cannot drop one (F2 review 2, point 9)', async () => {
    vi.stubGlobal('VTTCue', Cue);
    const fetches: string[] = [];
    const { video, r } = setup({
      growingVtt: 'fetch',
      fetch: (url) => {
        fetches.push(url instanceof Request ? url.url : url.toString());
        return Promise.resolve(new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nUno\n', { status: 200 }));
      },
    });
    const made: FakeTextTrack[] = [];
    video.addTextTrack = vi.fn(() => {
      const t = new FakeTextTrack();
      made.push(t);
      return t as unknown as TextTrack;
    });
    const ita = vtt({ availability: 'growing' });
    const eng = vtt({ id: 'vtt-2', language: 'eng', availability: 'growing', url: '/video/media/sessions/s1/subtitles/vtt-2.vtt?st=x' });
    r.show(ita);
    await vi.waitFor(() => expect(made[0]?.list).toHaveLength(1));
    r.show(eng);
    await vi.waitFor(() => expect(made[1]?.list).toHaveLength(1));
    // Back to the first one, and the same track in the next session's stream (a re-plan): no new TextTrack.
    r.show(ita);
    r.show(null);
    r.show({ ...ita, url: '/video/media/sessions/s2/subtitles/vtt-1.vtt?st=y' });
    await vi.waitFor(() => expect(fetches).toHaveLength(4));
    await vi.waitFor(() => expect(made[0]?.list).toHaveLength(1));
    expect(video.addTextTrack).toHaveBeenCalledTimes(2);
    expect(made.map((t) => t.mode)).toEqual(['showing', 'disabled']);
    vi.unstubAllGlobals();
  });

  it('a response that arrives after its load was replaced leaves the shared TextTrack alone', async () => {
    vi.stubGlobal('VTTCue', Cue);
    const answers: ((res: Response) => void)[] = [];
    const { video, r } = setup({ growingVtt: 'fetch', fetch: () => new Promise<Response>((res) => answers.push(res)) });
    const textTrack = new FakeTextTrack();
    video.addTextTrack = vi.fn(() => textTrack as unknown as TextTrack);
    const ita = vtt({ availability: 'growing' });
    r.show(ita);
    r.show(null);
    r.show({ ...ita, url: '/video/media/sessions/s2/subtitles/vtt-1.vtt?st=y' });
    expect(answers).toHaveLength(2);
    answers[1]?.(new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNuovo\n', { status: 200 }));
    await vi.waitFor(() => expect(textTrack.list).toHaveLength(1));
    // The first fetch ignored its abort signal (a fake fetch): its late answer must not clear the cues.
    answers[0]?.(new Response('WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nVecchio\n', { status: 200 }));
    await new Promise((res) => setTimeout(res, 10));
    expect(textTrack.list.map((c) => c.text)).toEqual(['Nuovo']);
    vi.unstubAllGlobals();
  });

  it('reports an HTTP error as a subtitle failure', async () => {
    const { video, r, deps } = setup({ growingVtt: 'fetch', fetch: () => Promise.resolve(new Response('', { status: 500 })) });
    video.addTextTrack = vi.fn(() => new FakeTextTrack() as unknown as TextTrack);
    r.show(vtt({ availability: 'growing' }));
    await vi.waitFor(() => expect(deps.onFailure).toHaveBeenCalledWith('vtt-1', vtt({ availability: 'growing' }).url));
  });
});
