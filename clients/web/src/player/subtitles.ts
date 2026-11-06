// Subtitles served separately (doc 05 §7.8.6). The client shows them on the original timeline:
// - client_render (PGS): libpgs in the S2 configuration (video + a requestVideoFrameCallback loop calling
//   renderAtTimestamp), with timeOffset and rVFC both shifted by timelineOffsetMs;
// - sidecar (WebVTT): a <track>, with cues shifted by −timelineOffsetMs (fallback: fetch + VTTCue);
// - embedded and burned: nothing to do here.
// A growing track is loaded as is; when it becomes complete (playback.subtitle_ready, or a session that reports
// it) the selected track re-reads its url. A url answering 503 (extraction not started, ADR 0003 D12 fallback) is
// not a failure: the renderer waits Retry-After and tries again, and the track shows "in preparazione". Except a
// 503 MEDIA_UNAVAILABLE without Retry-After on a complete track: the extraction failed for good, so it is a
// failure at once. A growing response cut short while its url still answers 2xx is read again, once until the
// read delivers again or the track completes.
import type { SessionTrack } from '../api/types.ts';
import { parseRetryAfter, problemCode, probeUrl, type UrlStatus } from './probe.ts';
import type { Logger } from './types.ts';
import { VttStreamParser } from './vtt.ts';

export interface PgsLike {
  timeOffset: number;
  readonly ready: Promise<void>;
  renderAtTimestamp(timeS: number): void;
  loadFromUrl(url: string): Promise<void>;
  dispose(): void;
}

export type PgsFactory = (opts: { video: HTMLVideoElement; subUrl: string; timeOffset: number }) => PgsLike;

/**
 * Which way a growing WebVTT track is read: <track> (ADR 0005) or fetch + VTTCue. The browser wiring uses fetch:
 * only fetch can abort the long response when the track is switched off.
 */
export type GrowingVttStrategy = 'track' | 'fetch';

export interface SubtitleDeps {
  /** Loads libpgs (player chunk). */
  loadPgs: () => Promise<PgsFactory>;
  /** A selected track failed to load (not a 503): the controller re-plans with suspect subtitle. */
  onFailure: (trackId: string, url: string | null) => void;
  /** The track's url answers 503: true while the renderer waits to try again, false when it loads or gives up. */
  onPreparing?: (trackId: string, preparing: boolean) => void;
  log: Logger;
  growingVtt?: GrowingVttStrategy;
  /** For the fetch fallback and for the status of a failed url. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Waiting on a 503 subtitle url stops here and becomes a failure. */
export const SUBTITLE_PREPARING_LIMIT_MS = 120_000;
const DEFAULT_RETRY_AFTER_MS = 2_000;

/**
 * Removes a <track>: its src goes first, so the browser drops the load it may still hold open (a growing file's
 * response can last most of the film). Growing tracks normally use the fetch strategy, which aborts for sure.
 */
function dropTrack(t: HTMLTrackElement): void {
  t.track.mode = 'disabled';
  t.removeAttribute('src');
  t.remove();
}

/** Tracks the client can show without restarting the stream. */
export const isLocalTrack = (t: SessionTrack) => !!t.url && t.switchWithoutRestart && (t.delivery === 'client_render' || t.delivery === 'sidecar');

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, md: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

interface Active {
  track: SessionTrack;
  dispose(): void;
  setOffset(offsetMs: number): void;
  reload(): void;
}

/** An HTTP answer of the fetch fallback: its status is known, no probe needed. */
class HttpStatusError extends Error {
  readonly status: UrlStatus;
  constructor(status: number, retryAfterMs: number | null, code: string | null) {
    super(`HTTP ${status}`);
    this.status = { kind: 'status', status, retryAfterMs, code };
  }
}

export class SubtitleRenderer {
  private readonly video: VideoWithRvfc;
  private readonly deps: SubtitleDeps;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;
  /** The track to show: loaded (active) or waiting for its url (503). */
  private selected: SessionTrack | null = null;
  private active: Active | null = null;
  private offsetMs = 0;
  /** Bumped on every change: async loads, probes and retries of an older selection are dropped. */
  private token = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private preparing: { trackId: string; since: number } | null = null;
  /**
   * A growing response was cut short and read again (m4): a second cut is a failure, unless the new read
   * delivered something or the track completed meanwhile (a server-side restart of the extraction).
   */
  private reloadedAfterCut = false;
  /**
   * TextTracks of the fetch strategy, by label and language. The element cannot drop a track made by addTextTrack,
   * and its label and language are read-only, so each one is reused by every later load with the same pair.
   */
  private readonly fetchTracks = new Map<string, TextTrack>();

  constructor(video: HTMLVideoElement, deps: SubtitleDeps) {
    this.video = video;
    this.deps = deps;
    this.fetchFn = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
  }

  get trackId(): string | null {
    return this.selected?.id ?? null;
  }

  /**
   * Shows a track (or none). The same track at the same url keeps its render; if the loaded copy was growing and
   * the track is now complete, it re-reads the url (a missed playback.subtitle_ready).
   */
  show(track: SessionTrack | null): void {
    const cur = this.selected;
    if (track && cur && cur.id === track.id && cur.url === track.url) {
      const wasGrowing = (this.active?.track ?? cur).availability === 'growing';
      this.selected = track;
      if (track.availability === 'complete') this.reloadedAfterCut = false;
      if (this.active) {
        this.active.track = track;
        if (wasGrowing && track.availability === 'complete') {
          this.deps.log('info', 'subtitle complete (from the session), reloading', { trackId: track.id });
          this.active.reload();
        }
      }
      return;
    }
    this.clear();
    if (!track || !track.url) return;
    this.selected = track;
    this.load(track, ++this.token);
  }

  setOffset(offsetMs: number): void {
    this.offsetMs = offsetMs;
    this.active?.setOffset(offsetMs);
  }

  /** The selected track became complete (playback.subtitle_ready): re-read the url without stopping the render. */
  reload(trackId: string, track: SessionTrack): void {
    if (!this.active || this.active.track.id !== trackId) return;
    this.active.track = track;
    this.selected = track;
    this.reloadedAfterCut = false;
    this.deps.log('info', 'subtitle complete, reloading', { trackId });
    this.active.reload();
  }

  clear(): void {
    this.token += 1;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.active?.dispose();
    this.active = null;
    this.selected = null;
    this.reloadedAfterCut = false;
    this.setPreparing(null);
  }

  destroy(): void {
    this.clear();
  }

  private load(track: SessionTrack, token: number): void {
    if (track.delivery === 'client_render') void this.showPgs(track, token);
    else if (track.delivery === 'sidecar') this.active = track.availability === 'growing' && this.deps.growingVtt === 'fetch' ? this.showVttFetch(track, token) : this.showVttTrack(track, token);
  }

  private setPreparing(next: { trackId: string; since: number } | null): void {
    const prev = this.preparing;
    this.preparing = next;
    if (prev && prev.trackId !== next?.trackId) this.deps.onPreparing?.(prev.trackId, false);
    if (next && prev?.trackId !== next.trackId) this.deps.onPreparing?.(next.trackId, true);
  }

  /** The current load delivered data (cues, or the whole file): a later cut may be read again once more. */
  private delivered(token: number): void {
    if (token === this.token) this.reloadedAfterCut = false;
  }

  /** A load failed: a 503 waits and tries again, anything else is a failure of the track. */
  private fail(token: number, track: SessionTrack, err: unknown, known?: UrlStatus): void {
    if (token !== this.token) return;
    void this.afterFailure(token, track, err, known);
  }

  private async afterFailure(token: number, track: SessionTrack, err: unknown, known?: UrlStatus): Promise<void> {
    const st = known ?? (track.url ? await probeUrl(track.url, this.fetchFn) : null);
    if (token !== this.token) return;
    if (st?.kind === 'status' && st.status === 503 && !this.failedForGood(track, st) && this.wait(token, track, st.retryAfterMs)) return;
    // A growing response cut short (probed: the url is fine) is read again, once; the loader's own status is final.
    if (!known && st?.kind === 'status' && st.status >= 200 && st.status < 300 && track.availability === 'growing' && !this.reloadedAfterCut) {
      this.reloadedAfterCut = true;
      this.deps.log('info', 'subtitle response cut short, reading it again', { trackId: track.id, err: String(err) });
      this.active?.dispose();
      this.active = null;
      this.load(this.selected ?? track, token);
      return;
    }
    this.setPreparing(null);
    this.deps.log('warn', 'subtitle load failed', { trackId: track.id, err: String(err), status: st?.kind === 'status' ? st.status : st?.kind });
    this.deps.onFailure(track.id, track.url);
  }

  /**
   * A 503 MEDIA_UNAVAILABLE without Retry-After on a track the session reports complete: its extraction (or
   * its sidecar conversion) failed for good (contract getSubtitle 503), so waiting would only delay the
   * re-plan. With Retry-After (a file briefly unreachable), STREAM_PREPARING, or a growing track, it waits.
   */
  private failedForGood(track: SessionTrack, st: Extract<UrlStatus, { kind: 'status' }>): boolean {
    const cur = this.selected?.id === track.id ? this.selected : track;
    return st.code === 'MEDIA_UNAVAILABLE' && st.retryAfterMs === null && cur.availability === 'complete';
  }

  /** Waits Retry-After before the next try. False when the wait is over the limit. */
  private wait(token: number, track: SessionTrack, retryAfterMs: number | null): boolean {
    const now = this.now();
    const since = this.preparing?.trackId === track.id ? this.preparing.since : now;
    if (now - since >= SUBTITLE_PREPARING_LIMIT_MS) return false;
    this.active?.dispose();
    this.active = null;
    this.setPreparing({ trackId: track.id, since });
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        if (token === this.token) void this.retry(token, track);
      },
      Math.min(retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, SUBTITLE_PREPARING_LIMIT_MS),
    );
    return true;
  }

  /** While the url still answers 503, no loader is created: the probe alone keeps waiting. */
  private async retry(token: number, track: SessionTrack): Promise<void> {
    const st = track.url ? await probeUrl(track.url, this.fetchFn) : null;
    if (token !== this.token) return;
    if (st?.kind === 'status' && st.status === 503) {
      if (this.failedForGood(track, st) || !this.wait(token, track, st.retryAfterMs)) this.fail(token, track, new Error('still 503'), st);
      return;
    }
    this.setPreparing(null);
    this.load(this.selected ?? track, token);
  }

  private async showPgs(track: SessionTrack, token: number): Promise<void> {
    let factory: PgsFactory;
    try {
      factory = await this.deps.loadPgs();
    } catch (e) {
      // The libpgs chunk itself: the url is fine.
      this.fail(token, track, e, { kind: 'status', status: 200, retryAfterMs: null, code: null });
      return;
    }
    if (token !== this.token || !track.url) return;
    const video = this.video;
    const pgs = factory({ video, subUrl: track.url, timeOffset: this.offsetMs / 1000 });
    // ready resolves at the end of the file only: never awaited for a growing track, but a rejection is a failure.
    void pgs.ready.then(
      () => this.delivered(token),
      (e: unknown) => this.fail(token, track, e),
    );
    let handle: number | null = null;
    let running = true;
    const loop = (_now: number, md: { mediaTime: number }) => {
      if (!running) return;
      pgs.renderAtTimestamp(md.mediaTime + this.offsetMs / 1000);
      handle = video.requestVideoFrameCallback?.(loop) ?? null;
    };
    handle = video.requestVideoFrameCallback?.(loop) ?? null;
    this.active = {
      track,
      setOffset: (ms) => {
        pgs.timeOffset = ms / 1000;
      },
      reload: () => {
        const url = this.active?.track.url;
        if (!url) return;
        pgs.loadFromUrl(url).catch((e: unknown) => this.fail(token, track, e));
      },
      dispose: () => {
        running = false;
        if (handle !== null) video.cancelVideoFrameCallback?.(handle);
        pgs.dispose();
      },
    };
  }

  private shiftCues(textTrack: TextTrack, original: WeakMap<TextTrackCue, [number, number]>): void {
    const cues = textTrack.cues;
    if (!cues) return;
    const off = this.offsetMs / 1000;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      if (!cue) continue;
      let o = original.get(cue);
      if (!o) {
        o = [cue.startTime, cue.endTime];
        original.set(cue, o);
      }
      cue.startTime = o[0] - off;
      cue.endTime = o[1] - off;
    }
  }

  private showVttTrack(track: SessionTrack, token: number): Active {
    const video = this.video;
    const original = new WeakMap<TextTrackCue, [number, number]>();
    const own = new Set<HTMLTrackElement>();
    let el: HTMLTrackElement | null = null;
    let seen = 0;

    const attach = (url: string) => {
      const next = document.createElement('track');
      next.kind = 'subtitles';
      next.src = url;
      if (track.language) next.srclang = track.language;
      next.label = track.title ?? track.language ?? track.id;
      next.addEventListener('load', () => {
        if (token !== this.token) return;
        this.delivered(token);
        this.shiftCues(next.track, original);
        seen = next.track.cues?.length ?? 0;
        // The new <track> is complete: show it and drop the old one now, so there is no gap and no double cue.
        next.track.mode = 'showing';
        if (el && el !== next) {
          dropTrack(el);
          own.delete(el);
        }
        el = next;
      });
      next.addEventListener('error', () => this.fail(token, track, new Error('track load error')));
      video.appendChild(next);
      own.add(next);
      // 'hidden' still loads the cues; a reload stays hidden until it is complete.
      next.track.mode = el ? 'hidden' : 'showing';
      if (!el) el = next;
    };

    // Cues of a growing track may arrive before 'load': shift the new ones as playback goes.
    const onTimeUpdate = () => {
      const t = el?.track;
      const n = t?.cues?.length ?? 0;
      if (t && n !== seen) {
        if (n > seen) this.delivered(token);
        seen = n;
        this.shiftCues(t, original);
      }
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    if (track.url) attach(track.url);

    return {
      track,
      setOffset: () => {
        if (el) this.shiftCues(el.track, original);
      },
      reload: () => {
        if (track.url) attach(track.url);
      },
      dispose: () => {
        video.removeEventListener('timeupdate', onTimeUpdate);
        for (const t of own) dropTrack(t);
        own.clear();
      },
    };
  }

  private fetchTrack(track: SessionTrack): TextTrack {
    const label = track.title ?? track.language ?? track.id;
    const language = track.language ?? '';
    const key = JSON.stringify([label, language]);
    let t = this.fetchTracks.get(key);
    if (!t) {
      t = this.video.addTextTrack('subtitles', label, language);
      this.fetchTracks.set(key, t);
    }
    return t;
  }

  private showVttFetch(track: SessionTrack, token: number): Active {
    const shown = this.fetchTrack(track);
    shown.mode = 'showing';
    const original = new WeakMap<TextTrackCue, [number, number]>();
    let abort = new AbortController();
    const doFetch = this.fetchFn;

    const clearCues = () => {
      for (let c = shown.cues?.[0]; c; c = shown.cues?.[0]) shown.removeCue(c);
    };

    const load = async (url: string) => {
      const ctrl = abort;
      const res = await doFetch(url, { signal: ctrl.signal });
      // A response of a load already replaced must not clear the cues of the one that replaced it (same TextTrack).
      if (token !== this.token || ctrl.signal.aborted) return;
      if (!res.ok || !res.body) throw new HttpStatusError(res.status, parseRetryAfter(res.headers.get('Retry-After')), await problemCode(res));
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new VttStreamParser();
      const add = (cues: ReturnType<VttStreamParser['push']>) => {
        if (token !== this.token || ctrl.signal.aborted) return;
        if (cues.length > 0) this.delivered(token);
        const off = this.offsetMs / 1000;
        for (const c of cues) {
          const cue = new VTTCue(c.startS - off, c.endS - off, c.text);
          original.set(cue, [c.startS, c.endS]);
          shown.addCue(cue);
        }
      };
      clearCues();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        add(parser.push(value));
      }
      add(parser.end());
    };

    const start = (url: string) => {
      load(url).catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        this.fail(token, track, e, e instanceof HttpStatusError ? e.status : undefined);
      });
    };
    if (track.url) start(track.url);

    return {
      track,
      setOffset: () => this.shiftCues(shown, original),
      reload: () => {
        abort.abort();
        abort = new AbortController();
        if (track.url) start(track.url);
      },
      dispose: () => {
        abort.abort();
        clearCues();
        shown.mode = 'disabled';
      },
    };
  }
}
