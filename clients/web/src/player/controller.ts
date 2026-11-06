// PlayerController (doc 05 §7.8): owns the session, the engine and the subtitle renderer for one <video>.
// The UI reads it with useSyncExternalStore and calls its methods; it never touches hls.js or the element.
// - Engines and their callbacks: an engine's callbacks act only while its binding matches `generation`. Destroying
//   an engine bumps it; so does every call that makes the server replace the stream (track or version change,
//   re-plan after a subtitle failure): the old engine keeps playing, but its 404/410 and errors are no longer
//   failures. A change the server refuses (422) re-binds it.
// - Operations: every user operation and every automatic attempt claims `op`; async work of an older one stops.
//   A StartPlayback answered after its operation was superseded is stopped at once (no orphan session).
// - Positions: until the engine has put the element at its start (positioned), currentTime is not a position:
//   failures, heartbeats and stops report the start position, and timeupdate is ignored.
// - Automatic re-plan (doc 04 §8): no question to the user; at most 3 attempts per start, then reasons + "Riprova".
// - Closed sessions: a session closed by another device, after a failure or with its item removed (SESSION_EXPIRED
//   reason) ends the player there; an expired one, or one the server no longer knows, starts again. A stream that
//   answers 404/410 says nothing about why, so the control plane is asked once before starting again.
// - Giving up (failure dialogs, leaving the player, pagehide) stops the session on the server: it would otherwise
//   hold the only slot until the session timeout.
// - attach/detach and destroy are idempotent: React StrictMode's double mount leaves no hls.js instance behind.
import { type ActiveSession, type AppEvent, type ClientCapabilities, type PlaybackSession, type StartPlaybackRequest, type Suspect, UnsupportedProtocolError } from '../api/types.ts';
import type { Engine, EngineCallbacks } from './engine.ts';
import { type FailureAction, MAX_AUTOMATIC_ATTEMPTS } from './failures.ts';
import { type PreflightEnv, preflight } from './preflight.ts';
import { isLocalTrack, SubtitleRenderer, type SubtitleDeps } from './subtitles.ts';
import { toOriginalMs, toPlayerTimeS } from './timeline.ts';
import { closedReason, isPlaybackApiError, type Logger, type PlaybackApi, type PlaybackApiError } from './types.ts';

export type PlayerPhase =
  | 'idle'
  /** StartPlayback in flight. */
  | 'starting'
  /** 503 STREAM_PREPARING / MEDIA_UNAVAILABLE: waiting Retry-After, up to 60 s. */
  | 'preparing'
  /** An engine plays the session. */
  | 'ready'
  /** An automatic attempt is running. */
  | 'replanning'
  /** Automatic attempts exhausted, or STREAM_FAILED: reasons and "Riprova". */
  | 'failed'
  /** 422 NO_COMPATIBLE_PLAN, or a protocol this browser cannot play. */
  | 'no_plan'
  /** 409 SESSION_LIMIT_REACHED: the UI offers to stop another session. */
  | 'session_limit'
  /** The heartbeat found the session closed (SESSION_EXPIRED): offer to resume from the last position. */
  | 'expired'
  /** playback.session_terminated for this session. */
  | 'terminated'
  /** No answer from the server. */
  | 'network'
  /** Any other error. */
  | 'error'
  /** Stopped because the page was hidden for good (pagehide). */
  | 'stopped';

export interface FailureRecord {
  suspect: Suspect | null;
  error: string;
  at: number;
}

export interface PlayerSnapshot {
  phase: PlayerPhase;
  session: PlaybackSession | null;
  capabilities: ClientCapabilities | null;
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  playing: boolean;
  buffering: boolean;
  ended: boolean;
  volume: number;
  muted: boolean;
  autoplayBlocked: boolean;
  timelineOffsetMs: number;
  /** Subtitle track on screen (the session's selection), null = none. */
  subtitleTrackId: string | null;
  /** The user's own subtitle state: off after "Nessuno" even when the session still shows a forced track. */
  subtitleOn: boolean;
  /** A subtitle track whose url answers 503 (extraction not started): "in preparazione". */
  subtitlePreparing: string | null;
  attempts: number;
  failures: FailureRecord[];
  error: { code: string; detail: string | null } | null;
  activeSessions: ActiveSession[];
  terminatedReason: string | null;
  /** A non-blocking message, e.g. a track change the server refused. */
  notice: { code: string; detail: string | null } | null;
  busy: boolean;
}

export interface StartOptions {
  itemId: string;
  fileId?: string | undefined;
  audioTrackId?: string | undefined;
  subtitleTrackId?: string | null | undefined;
  /** Original timeline; absent = the profile's resume position. */
  startPositionMs?: number | undefined;
  forceMode?: StartPlaybackRequest['forceMode'];
  /** Versions of the item, when known: track ids without a fileId are valid only with a single version. */
  versionCount?: number | undefined;
}

export interface ProbeResult {
  capabilities: ClientCapabilities;
  preflightEnv: PreflightEnv;
  hlsSupported: boolean;
}

export interface PlayerDeps {
  api: PlaybackApi;
  /** Capability probe, at every StartPlayback (doc 05 §7.8.2). */
  probe(video: HTMLVideoElement): Promise<ProbeResult>;
  createEngine(video: HTMLVideoElement, session: PlaybackSession, cb: EngineCallbacks, preflightEnv: PreflightEnv): Promise<Engine>;
  subtitles: Omit<SubtitleDeps, 'onFailure' | 'onPreparing' | 'log'>;
  log: Logger;
  /** Window events for pagehide/pageshow; null in tests that do not need them. */
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  now?: () => number;
}

export const PREPARING_LIMIT_MS = 60_000;
export const DEFAULT_RETRY_AFTER_MS = 2_000;
/** How close currentTime must be to the start target for the element to count as positioned (one segment). */
export const POSITION_TOLERANCE_S = 6;

/** Phases with a session the client plays or waits for: session events act, the hidden page keeps polling. */
const LIVE_PHASES: ReadonlySet<PlayerPhase> = new Set(['starting', 'preparing', 'ready', 'replanning']);
/** Phases with an open session: the heartbeat keeps it alive, also while a change waits for its stream. */
const HEARTBEAT_PHASES: ReadonlySet<PlayerPhase> = new Set(['ready', 'preparing', 'replanning']);
/** Phases where the user may change tracks or version. */
const CHANGE_PHASES: ReadonlySet<PlayerPhase> = new Set(['ready', 'preparing']);
/** Phases whose session the server already closed: nothing to stop. */
const CLOSED_PHASES: ReadonlySet<PlayerPhase> = new Set(['terminated', 'expired', 'stopped']);
/**
 * SESSION_EXPIRED reasons after which the player does not start a session by itself: another device took the slot,
 * nothing could play it, or the title left the library. The others (expired, stopped, shutdown, unknown) start again.
 */
const TERMINAL_REASONS: ReadonlySet<string> = new Set(['terminated', 'failed', 'item_removed']);
/** How long a stream's 404/410 waits for the control plane to say why, before starting again anyway. */
export const CLOSED_REASON_TIMEOUT_MS = 10_000;
/**
 * How long a new start waits for the stop of the session it replaces (one slot): a stop that does not answer by then
 * (a dead link) is sent again and the start goes on, so "Riprova" never waits for ever.
 */
export const STOP_WAIT_MS = 3_000;

const INITIAL: PlayerSnapshot = {
  phase: 'idle',
  session: null,
  capabilities: null,
  positionMs: 0,
  durationMs: 0,
  bufferedMs: 0,
  playing: false,
  buffering: false,
  ended: false,
  volume: 1,
  muted: false,
  autoplayBlocked: false,
  timelineOffsetMs: 0,
  subtitleTrackId: null,
  subtitleOn: false,
  subtitlePreparing: null,
  attempts: 0,
  failures: [],
  error: null,
  activeSessions: [],
  terminatedReason: null,
  notice: null,
  busy: false,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when `p` settles within `ms`. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The StopPlayback of a session the player gave up on (release), while it runs. */
interface Release {
  sessionId: string;
  /** Settles (never rejects) when the stop answers. */
  done: Promise<void>;
  failed: boolean;
  /** A new start took it over (closeCurrent): it sends the stop again itself if this one fails. */
  adopted: boolean;
}

/** withPreparing's answer when a session call found the session closed (404/410, or a 422 that closed it). */
interface ClosedSignal {
  closed: PlaybackApiError;
}
const isClosedSignal = (r: PlaybackSession | ClosedSignal | null): r is ClosedSignal => r !== null && 'closed' in r;

interface ChangeHooks {
  /** The change is applied (also through a restart): track ids follow the new file. */
  onApplied?: () => void;
  /** The server refused it (422): undo what the client showed in advance. */
  onRefused?: () => void;
}

export class PlayerController {
  private readonly deps: PlayerDeps;
  private readonly now: () => number;
  private snapshot: PlayerSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();

  private video: HTMLVideoElement | null = null;
  private subtitles: SubtitleRenderer | null = null;
  private engine: Engine | null = null;
  /** The current engine's callbacks act while binding.gen === generation. */
  private binding: { gen: number } | null = null;
  private generation = 0;
  /** Claimed by every user operation, automatic attempt and destroy: async work of an older one stops. */
  private op = 0;
  /** Start of the current engine on the original timeline, and whether the element has got there. */
  private engineStartMs = 0;
  private positioned = false;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  private request: StartOptions | null = null;
  private probed: ProbeResult | null = null;
  /** A session this client stopped itself (restart, new start, giving up): no more reports, changes or events. */
  private closedSessionId: string | null = null;
  /** The StopPlayback of a session the player gave up on, while it runs: a new start waits for it (one slot). */
  private releasing: Release | null = null;
  /** The stream that already had its one engine reload. */
  private reloadedStreamUrl: string | null = null;
  /** The user's own subtitle choice: a track id, null for "Nessuno", undefined while they have not chosen. */
  private userSubtitle: string | null | undefined = undefined;
  private lastState: 'playing' | 'paused' | 'buffering' = 'paused';

  constructor(deps: PlayerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------ store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlayerSnapshot => this.snapshot;

  private set(patch: Partial<PlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** True while a session is live: the event poller keeps polling a hidden page at 15 s. */
  hasActiveSession(): boolean {
    return LIVE_PHASES.has(this.snapshot.phase);
  }

  /** The session the client still holds open on the server, if any. */
  private openSession(): PlaybackSession | null {
    const s = this.snapshot.session;
    return s && LIVE_PHASES.has(this.snapshot.phase) && s.sessionId !== this.closedSessionId ? s : null;
  }

  /**
   * The session the server may still hold for this client, also after the player gave up on it (a failure dialog):
   * the one to stop when leaving. StopPlayback is idempotent, so a session the server closed meanwhile is harmless.
   */
  private closableSession(): PlaybackSession | null {
    const s = this.snapshot.session;
    return s && s.sessionId !== this.closedSessionId && !CLOSED_PHASES.has(this.snapshot.phase) ? s : null;
  }

  /**
   * The player gives up on its session (a failure dialog): StopPlayback now, so the slot (and a transcode slot) frees
   * at once instead of at the session timeout; "Riprova" starts a new session anyway. A stop that does not go
   * through is sent again by the next close (Riprova, leaving the player).
   */
  private release(positionMs: number): void {
    const s = this.closableSession();
    if (!s) return;
    const id = s.sessionId;
    this.closedSessionId = id;
    const r: Release = { sessionId: id, done: Promise.resolve(), failed: false, adopted: false };
    r.done = this.deps.api.stop(id, positionMs).then(
      () => {
        if (this.releasing === r) this.releasing = null;
      },
      () => {
        r.failed = true;
        if (this.releasing === r) this.releasing = null;
        // Not through: the next close (Riprova, pagehide, leaving) sends it again.
        if (!r.adopted && this.closedSessionId === id) this.closedSessionId = null;
      },
    );
    this.releasing = r;
  }

  // ------------------------------------------------------------ element lifecycle

  /** Binds the <video>. Calling it again with the same element is a no-op, and it cancels a pending detach. */
  attach(video: HTMLVideoElement): void {
    if (this.teardownTimer !== null) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
    if (this.video === video) return;
    if (this.video) this.unbindVideo();
    this.destroyed = false;
    this.video = video;
    this.subtitles = new SubtitleRenderer(video, {
      ...this.deps.subtitles,
      log: this.deps.log,
      onFailure: (trackId, url) => this.onSubtitleFailure(trackId, url),
      onPreparing: (trackId, preparing) => {
        if (preparing) this.set({ subtitlePreparing: trackId });
        else if (this.snapshot.subtitlePreparing === trackId) this.set({ subtitlePreparing: null });
      },
    });
    for (const [ev, fn] of this.videoListeners) video.addEventListener(ev, fn);
    this.deps.win?.addEventListener('pagehide', this.onPageHide);
    this.deps.win?.addEventListener('pageshow', this.onPageShow);
    this.set({ volume: video.volume, muted: video.muted });
  }

  /** Releases the element on the next macrotask, unless attach() comes back first (StrictMode remount). */
  detach(): void {
    if (this.teardownTimer !== null) return;
    this.teardownTimer = setTimeout(() => {
      this.teardownTimer = null;
      this.destroy();
    }, 0);
  }

  /** Stops the session (StopPlayback) and frees everything. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.op += 1;
    // Also after a failure dialog: the server may still hold the session (and the only slot).
    const s = this.closableSession();
    if (s) {
      this.closedSessionId = s.sessionId;
      void this.deps.api.stop(s.sessionId, this.positionMs()).catch(() => undefined);
    }
    this.stopHeartbeat();
    this.destroyEngine();
    this.subtitles?.destroy();
    if (this.video) this.unbindVideo();
    this.video = null;
    this.subtitles = null;
    this.snapshot = { ...INITIAL };
  }

  private unbindVideo(): void {
    const v = this.video;
    if (!v) return;
    for (const [ev, fn] of this.videoListeners) v.removeEventListener(ev, fn);
    this.deps.win?.removeEventListener('pagehide', this.onPageHide);
    this.deps.win?.removeEventListener('pageshow', this.onPageShow);
  }

  // ------------------------------------------------------------ start

  /**
   * User-initiated start: resets the automatic attempts. Repeating the same start while it runs is a no-op
   * (StrictMode); a different one stops the open session first.
   */
  async start(opts: StartOptions): Promise<void> {
    await this.begin(opts, undefined);
  }

  /** asSession: the start replaces that session (back from the back/forward cache), under its profile. */
  private async begin(opts: StartOptions, asSession: string | undefined): Promise<void> {
    const r = this.request;
    const same =
      r !== null &&
      r.itemId === opts.itemId &&
      r.fileId === opts.fileId &&
      r.startPositionMs === opts.startPositionMs &&
      r.audioTrackId === opts.audioTrackId &&
      r.forceMode === opts.forceMode;
    if (same && LIVE_PHASES.has(this.snapshot.phase)) return;
    const op = ++this.op;
    if (this.snapshot.session) {
      await this.closeCurrent(this.positionMs());
      if (op !== this.op) return;
    }
    this.request = { ...opts };
    this.userSubtitle = opts.subtitleTrackId === null ? null : undefined;
    this.reloadedStreamUrl = null;
    this.set({ attempts: 0, failures: [], error: null, notice: null, terminatedReason: null, activeSessions: [] });
    await this.startSession(op, opts.startPositionMs, asSession);
  }

  /** "Riprova": a new StartPlayback from the current position, with fresh attempts. */
  async retry(): Promise<void> {
    if (!this.request) return;
    const pos = this.snapshot.session ? this.positionMs() : this.request.startPositionMs;
    const op = ++this.op;
    await this.closeCurrent(pos ?? 0);
    if (op !== this.op) return;
    this.request = { ...this.request, startPositionMs: pos };
    this.reloadedStreamUrl = null;
    this.set({ attempts: 0, failures: [], error: null, notice: null, terminatedReason: null, activeSessions: [] });
    await this.startSession(op, pos);
  }

  /** SESSION_LIMIT_REACHED: stop the other session, then start again. */
  async terminateOther(sessionId: string): Promise<void> {
    const op = ++this.op;
    try {
      await this.deps.api.terminate(sessionId);
    } catch (e) {
      if (op === this.op) this.fail(e);
      return;
    }
    if (op !== this.op || !this.request) return;
    this.set({ activeSessions: [] });
    await this.startSession(op, this.request.startPositionMs);
  }

  /**
   * StartPlayback from the current request. asSession: an automatic restart of that session, which runs under the
   * session's own profile even if another tab picked another one meanwhile (api/playback.ts).
   */
  private async startSession(op: number, startPositionMs: number | undefined, asSession?: string): Promise<void> {
    const video = this.video;
    const req = this.request;
    if (!video || !req) return;
    this.set({ phase: 'starting', busy: true });
    let probed: ProbeResult;
    try {
      probed = await this.deps.probe(video);
    } catch (e) {
      if (op === this.op) this.fail(e);
      return;
    }
    if (op !== this.op) return;
    this.probed = probed;
    this.set({ capabilities: probed.capabilities });
    // Track ids are file-local: on an item with several versions they need the fileId of their version (else 400).
    // Picks made in the player carry their session's fileId; ids without one are dropped unless the item has a
    // single version (an unknown count counts as several).
    const fileId = req.fileId ?? this.snapshot.session?.fileId ?? undefined;
    const subtitleId = typeof req.subtitleTrackId === 'string' ? req.subtitleTrackId : undefined;
    const idsAllowed = fileId !== undefined || req.versionCount === 1;
    if (!idsAllowed && (req.audioTrackId || subtitleId)) this.deps.log('warn', 'track ids without fileId dropped', { audioTrackId: req.audioTrackId, subtitleTrackId: subtitleId, versionCount: req.versionCount });
    const body: StartPlaybackRequest = {
      itemId: req.itemId,
      capabilities: probed.capabilities,
      ...(fileId ? { fileId } : {}),
      ...(idsAllowed && req.audioTrackId ? { audioTrackId: req.audioTrackId } : {}),
      ...(req.subtitleTrackId === null ? { subtitleTrackId: null } : idsAllowed && subtitleId ? { subtitleTrackId: subtitleId } : {}),
      ...(startPositionMs !== undefined ? { startPositionMs: Math.max(0, Math.round(startPositionMs)) } : {}),
      ...(req.forceMode ? { forceMode: req.forceMode } : {}),
    };
    // StartPlayback is not a session call: its 404 is an unknown item, never a closed session.
    const session = await this.withPreparing(op, () => (asSession !== undefined ? this.deps.api.start(body, { asSession }) : this.deps.api.start(body)));
    if (!session || isClosedSignal(session)) return;
    if (op !== this.op) {
      // Superseded while StartPlayback ran (the user left, the session was terminated): nobody plays this
      // session, so free its slot now instead of leaving it to the heartbeat timeout.
      void this.deps.api.stop(session.sessionId, startPositionMs ?? session.resumePositionMs).catch(() => undefined);
      return;
    }
    await this.playSession(op, session, startPositionMs ?? session.resumePositionMs);
  }

  /**
   * Repeats a session call while it answers 503 (STREAM_PREPARING or MEDIA_UNAVAILABLE), after Retry-After (2 s if
   * missing), for at most 60 s, showing "in preparazione". On a session call the session stays open without a
   * stream, so the engine goes at the first 503. An error `closed` recognises (the session closed meanwhile, e.g. the
   * Video Service restarted behind the gateway's 503) comes back as a ClosedSignal, at any retry; other errors go to
   * fail(). Returns null when the operation was superseded or failed; a result that arrives after its operation was
   * superseded is still returned.
   */
  private async withPreparing(
    op: number,
    call: () => Promise<PlaybackSession>,
    opts: { first?: unknown; closed?: (e: unknown) => boolean } = {},
  ): Promise<PlaybackSession | ClosedSignal | null> {
    const t0 = this.now();
    let pending: unknown = opts.first;
    for (;;) {
      if (pending === undefined) {
        try {
          return await call();
        } catch (e) {
          if (op !== this.op) return null;
          pending = e;
        }
      }
      const e = pending;
      pending = undefined;
      if (opts.closed?.(e) && isPlaybackApiError(e)) return { closed: e };
      if (isRetryLater(e)) {
        const left = PREPARING_LIMIT_MS - (this.now() - t0);
        if (left > 0) {
          this.destroyEngine();
          this.set({ phase: 'preparing', busy: true });
          await sleep(Math.min(e.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, left));
          if (op !== this.op) return null;
          continue;
        }
      }
      this.fail(e);
      return null;
    }
  }

  /** Maps an error of the control plane to a phase. The player gives up on the session: the server is told. */
  private fail(e: unknown): void {
    const positionMs = this.positionMs();
    this.stopHeartbeat();
    this.destroyEngine();
    this.release(positionMs);
    if (e instanceof UnsupportedProtocolError) {
      this.set({ phase: 'no_plan', busy: false, error: { code: 'CLIENT_UNSUPPORTED_PROTOCOL', detail: e.protocol } });
      return;
    }
    if (!isPlaybackApiError(e)) {
      this.deps.log('error', 'player error', { err: String(e) });
      this.set({ phase: 'error', busy: false, error: { code: 'UNEXPECTED', detail: e instanceof Error ? e.message : String(e) } });
      return;
    }
    const error = { code: e.code, detail: e.detail };
    if (e.status === 500 && e.code === 'STREAM_FAILED') {
      // The server used up the automatic attempts: reasons and "Riprova".
      this.set({ phase: 'failed', busy: false, error, failures: [...this.snapshot.failures, { suspect: null, error: e.code, at: this.now() }] });
    } else if (e.status === 409 && e.code === 'SESSION_LIMIT_REACHED') this.set({ phase: 'session_limit', busy: false, error, activeSessions: e.activeSessions });
    else if (e.status === 422) this.set({ phase: 'no_plan', busy: false, error });
    else if (e.status === 0) this.set({ phase: 'network', busy: false, error });
    else this.set({ phase: 'error', busy: false, error });
  }

  // ------------------------------------------------------------ engines

  /** Plays a session from an original position: pre-start check, then a new engine of a new generation. */
  private async playSession(op: number, session: PlaybackSession, startMs: number): Promise<void> {
    const video = this.video;
    const probed = this.probed;
    if (!video || !probed) return;
    this.destroyEngine();
    this.set({ session, durationMs: session.durationMs, positionMs: startMs, timelineOffsetMs: 0, ended: false, error: null });

    if (session.stream.protocol === 'hls-fmp4' && !probed.hlsSupported) {
      this.release(startMs);
      this.set({ phase: 'no_plan', busy: false, error: { code: 'CLIENT_NO_MSE', detail: null } });
      return;
    }
    const pre = preflight(session.stream, probed.preflightEnv);
    if (pre.ok && pre.skipped) this.deps.log('info', 'stream.mimeType missing: pre-start check skipped', { sessionId: session.sessionId });
    if (!pre.ok) {
      this.deps.log('warn', 'stream.mimeType refused before start', { mimeType: session.stream.mimeType, suspect: pre.suspect });
      await this.automatic({ kind: 'replan', suspect: pre.suspect, error: 'MIME_TYPE_UNSUPPORTED' }, startMs);
      return;
    }

    const binding = { gen: ++this.generation };
    const bound = () => binding.gen === this.generation;
    const cb: EngineCallbacks = {
      onFailure: (action) => {
        if (!bound()) return;
        void this.automatic(action, this.positionMs());
      },
      onTimelineOffset: (offsetMs) => {
        if (!bound()) return;
        this.subtitles?.setOffset(offsetMs);
        this.set({ timelineOffsetMs: offsetMs });
      },
      onBufferFull: () => undefined,
      log: this.deps.log,
    };
    let engine: Engine;
    try {
      engine = await this.deps.createEngine(video, session, cb, probed.preflightEnv);
    } catch (e) {
      if (bound() && op === this.op) this.fail(e);
      return;
    }
    if (!bound() || op !== this.op) {
      engine.destroy();
      return;
    }
    this.engine = engine;
    this.binding = binding;
    this.engineStartMs = startMs;
    this.positioned = false;
    this.subtitles?.setOffset(0);
    this.applySubtitles(session);
    engine.start(toPlayerTimeS(startMs, 0));
    this.set({ phase: 'ready', busy: false });
    this.startHeartbeat(session);
    this.tryPlay();
  }

  /** Destroys the engine and what renders on top of it. */
  private destroyEngine(): void {
    this.generation += 1;
    const e = this.engine;
    this.engine = null;
    this.binding = null;
    this.positioned = false;
    e?.destroy();
    this.subtitles?.clear();
  }

  /** The engine keeps playing, but its callbacks no longer act: the server is replacing its stream. */
  private detachEngine(): void {
    this.generation += 1;
  }

  /** The stream stays (same stream, or a refused change): the engine's callbacks act again. */
  private rebindEngine(): void {
    this.generation += 1;
    if (this.binding) this.binding.gen = this.generation;
  }

  private isBound(): boolean {
    return this.engine !== null && this.binding !== null && this.binding.gen === this.generation;
  }

  /**
   * One automatic attempt (doc 04 §8, doc 05 §7.8.5): re-plan from the suspect, restart a closed session, or
   * reload the engine (once per stream). After MAX_AUTOMATIC_ATTEMPTS the player stops and shows the reasons with
   * "Riprova". A subtitle failure leaves the video playing, detached, until the new stream arrives.
   */
  private async automatic(action: FailureAction, positionMs: number): Promise<void> {
    if (action.kind === 'ignore') return;
    const op = ++this.op;
    const session = this.openSession();
    const keepPlaying = action.kind === 'replan' && action.suspect === 'subtitle' && this.engine !== null;
    if (keepPlaying) this.detachEngine();
    else this.destroyEngine();
    const failures = [...this.snapshot.failures, { suspect: action.kind === 'replan' || action.kind === 'reload' ? action.suspect : null, error: action.error, at: this.now() }];
    if (action.kind === 'network') {
      this.stopHeartbeat();
      this.release(positionMs);
      this.set({ phase: 'network', failures, positionMs, busy: false, error: { code: 'NETWORK', detail: action.error } });
      return;
    }
    if (this.snapshot.attempts >= MAX_AUTOMATIC_ATTEMPTS || !session) {
      this.stopHeartbeat();
      this.destroyEngine();
      this.release(positionMs);
      this.set({ phase: 'failed', failures, positionMs, busy: false });
      return;
    }
    let act: FailureAction = action;
    if (act.kind === 'reload' && this.reloadedStreamUrl === session.stream.url) {
      // The reload did not cure it: the same failure again on this stream is a plan failure.
      act = { kind: 'replan', suspect: act.suspect, error: act.error };
    }
    this.set({ phase: 'replanning', busy: true, failures, attempts: this.snapshot.attempts + 1, positionMs });
    this.deps.log('warn', 'automatic attempt', { attempt: this.snapshot.attempts, action: act });

    if (act.kind === 'reload') {
      this.reloadedStreamUrl = session.stream.url;
      await this.playSession(op, session, positionMs);
      return;
    }
    if (act.kind === 'restart') {
      // From the data plane: its 404/410 does not say why the session closed.
      await this.restartClosed(op, positionMs, null);
      return;
    }
    if (act.kind !== 'replan') return;
    const body = { positionMs, error: act.error, suspect: act.suspect };
    let next: PlaybackSession | null;
    try {
      next = await this.deps.api.reportFailure(session.sessionId, body);
    } catch (e) {
      if (op !== this.op) return;
      if (isClosed(e) && isPlaybackApiError(e)) {
        await this.restartClosed(op, positionMs, e);
        return;
      }
      if (!isRetryLater(e)) {
        this.fail(e);
        return;
      }
      const r = await this.withPreparing(op, () => this.deps.api.reportFailure(session.sessionId, body), { first: e, closed: isClosed });
      if (isClosedSignal(r)) {
        if (op === this.op) await this.restartClosed(op, positionMs, r.closed);
        return;
      }
      next = r;
    }
    if (!next || op !== this.op) return;
    await this.applySession(op, next, positionMs);
  }

  /**
   * The session is closed on the server, or its stream answers 404/410. `cause`: the control-plane error that said
   * so; null when the data plane did, which says nothing about why, so one heartbeat asks the control plane first.
   * A terminal reason (another device took the slot, nothing could play it, the title left the library) ends the
   * player there with that reason. Otherwise (expired, stopped, a restarted service, a stream gone while the session
   * is open): StopPlayback (idempotent, frees the slot), then StartPlayback from here.
   */
  private async restartClosed(op: number, positionMs: number, cause: PlaybackApiError | null): Promise<void> {
    const old = this.snapshot.session;
    const pos = this.engine && this.positioned ? this.positionMs() : positionMs;
    this.stopHeartbeat();
    this.destroyEngine();
    let reason = cause ? closedReason(cause) : null;
    if (!cause && old && old.sessionId !== this.closedSessionId) {
      reason = await this.askWhyClosed(old.sessionId, pos);
      if (op !== this.op) return;
    }
    if (old && reason !== null && TERMINAL_REASONS.has(reason)) {
      this.closedSessionId = old.sessionId;
      this.set({ phase: 'terminated', terminatedReason: reason, positionMs: pos, busy: false, playing: false });
      return;
    }
    if (old) {
      this.closedSessionId = old.sessionId;
      await settlesWithin(this.deps.api.stop(old.sessionId, pos).catch(() => undefined), STOP_WAIT_MS);
    }
    if (op !== this.op || !this.request) return;
    this.request = { ...this.request, startPositionMs: pos };
    await this.startSession(op, pos, old?.sessionId);
  }

  /** One heartbeat: the reason of a closed session (410), or null when it is open, unknown (404) or does not answer in time. */
  private async askWhyClosed(sessionId: string, positionMs: number): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), CLOSED_REASON_TIMEOUT_MS);
    });
    const ask = this.deps.api.reportProgress(sessionId, { positionMs, state: 'buffering', clientTs: this.now() }).then(
      () => null,
      (e: unknown) => (isPlaybackApiError(e) && e.status === 410 ? closedReason(e) : null),
    );
    try {
      return await Promise.race([ask, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------ session changes

  /** Applies a session returned by a change or a re-plan. Same stream: keep the engine; else a new one from here. */
  private async applySession(op: number, next: PlaybackSession, positionMs: number): Promise<void> {
    const cur = this.snapshot.session;
    if (cur && this.engine && cur.stream.url === next.stream.url && cur.stream.protocol === next.stream.protocol) {
      this.rebindEngine();
      this.set({ session: next, busy: false, phase: 'ready' });
      this.applySubtitles(next);
      if (cur.sessionId !== next.sessionId || cur.heartbeatIntervalMs !== next.heartbeatIntervalMs) this.startHeartbeat(next);
      return;
    }
    // The old engine may have played on meanwhile: the new one starts where it is now.
    await this.playSession(op, next, this.engine ? this.positionMs() : positionMs);
  }

  /**
   * Session call for a track or version change (contract after F1b.2). The server stops the old stream before it
   * starts the new one, so the engine is detached for the call (its 410s are expected), then:
   * - 404/410, or a 422 with sessionClosed (the refusal closed the session): StartPlayback from here (also when it
   *   comes after a 503), unless the session was closed for a terminal reason (restartClosed);
   * - 503 STREAM_PREPARING or MEDIA_UNAVAILABLE: the session stays open without a stream, "in preparazione",
   *   the same call again after Retry-After;
   * - 422: refused before the server touched the stream: the engine is bound again, with a notice;
   * - 500 STREAM_FAILED: the server used up the attempts, reasons and "Riprova".
   * `update` carries the choice into the request, so a later StartPlayback keeps it (with its fileId).
   */
  private async change(call: (sessionId: string, positionMs: number) => Promise<PlaybackSession>, update: (req: StartOptions) => StartOptions, hooks: ChangeHooks = {}): Promise<void> {
    const session = this.openSession();
    if (!session || !CHANGE_PHASES.has(this.snapshot.phase)) return;
    const op = ++this.op;
    const positionMs = this.positionMs();
    this.detachEngine();
    this.set({ busy: true, notice: null });
    const closedChange = (e: unknown) => (isClosed(e) || isClosedRefusal(e)) && this.request !== null;
    /** The session closed under the change: a restart carries the change, a terminal reason ends the player. */
    const restart = async (e: PlaybackApiError, withChange: boolean): Promise<void> => {
      const terminal = TERMINAL_REASONS.has(closedReason(e) ?? '');
      if (withChange && !terminal && this.request) {
        this.request = update(this.request);
        hooks.onApplied?.();
      }
      await this.restartClosed(op, positionMs, e);
    };
    let next: PlaybackSession | null;
    try {
      next = await call(session.sessionId, positionMs);
    } catch (e) {
      if (op !== this.op) return;
      if (closedChange(e) && isPlaybackApiError(e)) {
        await restart(e, true);
        return;
      }
      if (isRetryLater(e)) {
        const r = await this.withPreparing(op, () => call(session.sessionId, positionMs), { first: e, closed: closedChange });
        if (isClosedSignal(r)) {
          if (op === this.op) await restart(r.closed, true);
          return;
        }
        next = r;
      } else if (isPlaybackApiError(e) && e.status === 422) {
        hooks.onRefused?.();
        this.set({ notice: { code: e.code, detail: e.detail } });
        if (this.engine) {
          this.rebindEngine();
          this.set({ busy: false });
          return;
        }
        // Refused while the session waited for a stream (503 before): the server went back to the previous tracks.
        // An empty ChangeTracks returns the session with its stream, or 503 while that one still prepares.
        const r = await this.withPreparing(op, () => this.deps.api.changeTracks(session.sessionId, { positionMs }), { closed: closedChange });
        if (isClosedSignal(r)) {
          // The refused change is not carried into the new session.
          if (op === this.op) await restart(r.closed, false);
          return;
        }
        if (!r || op !== this.op) return;
        await this.applySession(op, r, positionMs);
        return;
      } else {
        this.fail(e);
        return;
      }
    }
    if (!next || op !== this.op) return;
    if (this.request) this.request = { ...update(this.request), fileId: next.fileId ?? this.request.fileId };
    hooks.onApplied?.();
    this.set({ attempts: 0 });
    await this.applySession(op, next, positionMs);
  }

  private canChange(): PlaybackSession | null {
    return CHANGE_PHASES.has(this.snapshot.phase) ? this.openSession() : null;
  }

  /** Audio always goes through ChangeTracks: one muxed track per stream, and Direct Play cannot choose (S2). */
  async selectAudio(trackId: string): Promise<void> {
    const s = this.canChange();
    if (!s || s.tracks.audio.find((t) => t.selected)?.id === trackId) return;
    await this.change(
      (sid, positionMs) => this.deps.api.changeTracks(sid, { audioTrackId: trackId, positionMs }),
      (req) => ({ ...req, fileId: s.fileId ?? req.fileId, audioTrackId: trackId }),
    );
  }

  /**
   * Subtitles always go to the server, so the profile keeps the choice. A track served separately (also a growing
   * one) is shown at once; the server does not touch the stream for it. "Nessuno" hides at once; the server may
   * keep the forced track in the audio language, and the client then shows what the session reports. A refusal
   * (422) brings back what was shown before.
   */
  async selectSubtitle(trackId: string | null): Promise<void> {
    const s = this.canChange();
    if (!s) return;
    const track = trackId === null ? null : s.tracks.subtitles.find((t) => t.id === trackId);
    if (track === undefined) return;
    const prevUser = this.userSubtitle;
    this.userSubtitle = trackId;
    if (track === null) {
      this.subtitles?.show(null);
      this.set({ subtitleTrackId: null, subtitleOn: false });
    } else if (isLocalTrack(track)) {
      this.subtitles?.show(track);
      this.set({ subtitleTrackId: track.id, subtitleOn: true });
    }
    await this.change(
      (sid, positionMs) => this.deps.api.changeTracks(sid, { subtitleTrackId: trackId, positionMs }),
      (req) => ({ ...req, ...(trackId !== null ? { fileId: s.fileId ?? req.fileId } : {}), subtitleTrackId: trackId }),
      {
        onRefused: () => {
          this.userSubtitle = prevUser;
          const cur = this.snapshot.session;
          if (cur) this.applySubtitles(cur);
        },
      },
    );
  }

  /** Track ids are file-local: a new version drops the explicit picks and lets the server match them. */
  async selectVersion(fileId: string): Promise<void> {
    const s = this.canChange();
    if (!s || s.fileId === fileId) return;
    await this.change(
      (sid, positionMs) => this.deps.api.changeVersion(sid, { fileId, positionMs }),
      (req) => ({ ...req, fileId, audioTrackId: undefined, subtitleTrackId: req.subtitleTrackId === null ? null : undefined }),
      {
        onApplied: () => {
          if (this.userSubtitle !== null) this.userSubtitle = undefined;
        },
      },
    );
  }

  /** Shows what the session reports: the selected track if the client renders it (burned and embedded need nothing). */
  private applySubtitles(session: PlaybackSession): void {
    const selected = session.tracks.subtitles.find((t) => t.selected) ?? null;
    this.subtitles?.show(selected && isLocalTrack(selected) ? selected : null);
    const on = this.userSubtitle !== undefined ? this.userSubtitle !== null : selected !== null && !selected.forced;
    this.set({ subtitleTrackId: selected?.id ?? null, subtitleOn: on });
  }

  /** Only a track of the stream on screen, while it plays bound: anything else is a stale failure. */
  private onSubtitleFailure(trackId: string, url: string | null): void {
    const s = this.openSession();
    if (!s || this.snapshot.phase !== 'ready' || !this.isBound()) return;
    if (!s.tracks.subtitles.some((t) => t.id === trackId && t.url === url)) return;
    // Like any other failure (doc 04 §8): the server picks another subtitle treatment and a new stream.
    void this.automatic({ kind: 'replan', suspect: 'subtitle', error: `SUBTITLE_LOAD_FAILED:${trackId}` }, this.positionMs());
  }

  // ------------------------------------------------------------ events from the poller

  onEvent(e: AppEvent): void {
    const s = this.snapshot.session;
    if (!s) return;
    if (e.type === 'playback.subtitle_ready') {
      if (e.sessionId !== s.sessionId) return;
      const subtitles = s.tracks.subtitles.map((t) => (t.id === e.trackId ? { ...t, availability: e.availability } : t));
      const session = { ...s, tracks: { ...s.tracks, subtitles } };
      this.set({ session });
      const track = subtitles.find((t) => t.id === e.trackId);
      if (track && e.availability === 'complete') this.subtitles?.reload(e.trackId, track);
      return;
    }
    // Only a live session ends here: a failure, a missing plan or an expiry already on screen stays. A session this
    // client already closed itself (a restart from here, "Riprova") is stale news: the new start goes on.
    if (e.type === 'playback.session_terminated' && e.sessionId === s.sessionId && s.sessionId !== this.closedSessionId && LIVE_PHASES.has(this.snapshot.phase)) {
      const positionMs = this.positionMs();
      this.op += 1;
      this.stopHeartbeat();
      this.destroyEngine();
      this.set({ phase: 'terminated', terminatedReason: e.reason, positionMs, busy: false, playing: false });
    }
  }

  // ------------------------------------------------------------ transport

  /** Position on the original timeline; the start position until the engine has put the element there. */
  positionMs(): number {
    const v = this.video;
    if (!v || !this.engine) return this.snapshot.positionMs;
    if (!this.positioned) return this.engineStartMs;
    return toOriginalMs(v.currentTime, this.snapshot.timelineOffsetMs);
  }

  /**
   * hls.js seeks to startPosition when the first data is buffered, progressive at loadedmetadata; before that
   * (and while an old engine's teardown resets the element) currentTime is 0 or stale.
   */
  private checkPositioned(): void {
    const v = this.video;
    if (this.positioned || !v || !this.engine) return;
    if (Math.abs(v.currentTime - toPlayerTimeS(this.engineStartMs, 0)) <= POSITION_TOLERANCE_S) this.positioned = true;
  }

  private tryPlay(): void {
    const v = this.video;
    if (!v) return;
    let p: Promise<void> | undefined;
    try {
      p = v.play();
    } catch {
      return;
    }
    p?.then(
      () => this.set({ autoplayBlocked: false }),
      (e: unknown) => {
        if (e instanceof DOMException && e.name === 'NotAllowedError') this.set({ autoplayBlocked: true });
      },
    );
  }

  play(): void {
    this.tryPlay();
  }

  pause(): void {
    this.video?.pause();
  }

  togglePlay(): void {
    const v = this.video;
    if (!v) return;
    if (v.paused) this.tryPlay();
    else v.pause();
  }

  /** Seek to an original time: currentTime = (X − timelineOffsetMs) / 1000. */
  seekTo(originalMs: number): void {
    const v = this.video;
    if (!v || !this.engine) return;
    const target = Math.min(Math.max(0, originalMs), this.snapshot.durationMs || originalMs);
    this.positioned = true;
    v.currentTime = toPlayerTimeS(target, this.snapshot.timelineOffsetMs);
    this.set({ positionMs: target });
  }

  seekBy(deltaMs: number): void {
    this.seekTo(this.positionMs() + deltaMs);
  }

  setVolume(volume: number): void {
    const v = this.video;
    if (!v) return;
    v.volume = Math.min(1, Math.max(0, volume));
    if (v.volume > 0 && v.muted) v.muted = false;
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  toggleMute(): void {
    const v = this.video;
    if (v) v.muted = !v.muted;
  }

  // ------------------------------------------------------------ heartbeat

  private startHeartbeat(session: PlaybackSession): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.report(), session.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * ReportProgress: the heartbeat, also while paused. A closed session offers to resume (SESSION_EXPIRED), or shows
   * why it ended when the reason is terminal (another device, a failure, the title removed).
   */
  private report(): void {
    const s = this.snapshot.session;
    if (!s || !HEARTBEAT_PHASES.has(this.snapshot.phase) || s.sessionId === this.closedSessionId) return;
    const sessionId = s.sessionId;
    const positionMs = this.positionMs();
    // Without an engine (a change waiting for its stream) the session is open but nothing plays.
    const state = this.engine ? this.lastState : 'buffering';
    this.deps.api.reportProgress(sessionId, { positionMs, state, clientTs: this.now() }).catch((e: unknown) => {
      if (this.snapshot.session?.sessionId !== sessionId || !HEARTBEAT_PHASES.has(this.snapshot.phase)) return;
      // An answer that comes after an automatic attempt began (its own stop, or the closure it is handling): that
      // attempt decides, as for a late session_terminated event.
      if (sessionId === this.closedSessionId || this.snapshot.phase === 'replanning') return;
      if (isClosed(e) && isPlaybackApiError(e)) {
        this.op += 1;
        this.stopHeartbeat();
        this.destroyEngine();
        const reason = closedReason(e);
        if (reason !== null && TERMINAL_REASONS.has(reason)) this.set({ phase: 'terminated', terminatedReason: reason, positionMs, playing: false, busy: false });
        else this.set({ phase: 'expired', positionMs, playing: false, busy: false, error: { code: e.code, detail: null } });
      }
    });
  }

  // ------------------------------------------------------------ element events

  private readonly videoListeners: [string, () => void][] = [
    [
      'timeupdate',
      () => {
        const v = this.video;
        if (!v || !this.engine) return;
        this.checkPositioned();
        if (!this.positioned) return;
        const b = v.buffered;
        const end = b.length > 0 ? b.end(b.length - 1) : 0;
        this.set({ positionMs: this.positionMs(), bufferedMs: toOriginalMs(end, this.snapshot.timelineOffsetMs) });
      },
    ],
    [
      'playing',
      () => {
        this.checkPositioned();
        this.lastState = 'playing';
        this.set({ playing: true, buffering: false, ended: false, autoplayBlocked: false });
      },
    ],
    [
      'pause',
      () => {
        this.lastState = 'paused';
        this.set({ playing: false });
        this.report();
      },
    ],
    [
      'waiting',
      () => {
        this.lastState = 'buffering';
        this.set({ buffering: true });
      },
    ],
    [
      'seeked',
      () => {
        this.checkPositioned();
        this.report();
      },
    ],
    [
      'ended',
      () => {
        this.lastState = 'paused';
        this.set({ playing: false, ended: true });
        this.report();
      },
    ],
    [
      'volumechange',
      () => {
        const v = this.video;
        if (v) this.set({ volume: v.volume, muted: v.muted });
      },
    ],
  ];

  /**
   * pagehide: StopPlayback with fetch keepalive (sendBeacon cannot send Authorization), also for a session a failure
   * dialog still shows (the server may hold it). A live session ends as "stopped"; a dialog stays as it is.
   */
  private readonly onPageHide = (): void => {
    const live = LIVE_PHASES.has(this.snapshot.phase);
    const s = this.closableSession();
    const r = this.releasing;
    if (!live && !s && !r) return;
    const positionMs = this.positionMs();
    if (s) {
      this.closedSessionId = s.sessionId;
      void this.deps.api.stop(s.sessionId, positionMs, { keepalive: true }).catch(() => undefined);
    }
    // The stop sent when the player gave up may still be running, and dies with the page: again, with keepalive.
    if (r && r.sessionId !== s?.sessionId) void this.deps.api.stop(r.sessionId, positionMs, { keepalive: true }).catch(() => undefined);
    if (!live) return;
    this.op += 1;
    this.stopHeartbeat();
    this.destroyEngine();
    this.set({ phase: 'stopped', positionMs, playing: false, busy: false });
  };

  /** Back from the back/forward cache: the session was stopped, so start a new one from the same place. */
  private readonly onPageShow = (e: Event): void => {
    if (!(e as PageTransitionEvent).persisted || this.snapshot.phase !== 'stopped' || !this.request) return;
    this.request = { ...this.request, startPositionMs: this.snapshot.positionMs };
    void this.begin(this.request, this.snapshot.session?.sessionId);
  };

  /**
   * Before a new start: stops the current session unless it is already over (also after a failure: the server may
   * still hold it). A stop the player sent when it gave up is waited for, so the new start does not race it for the
   * slot; neither wait lasts more than STOP_WAIT_MS, and a stop that did not answer or failed is sent again.
   */
  private async closeCurrent(positionMs: number): Promise<void> {
    this.stopHeartbeat();
    this.destroyEngine();
    const r = this.releasing;
    if (r) r.adopted = true;
    const toStop = new Set<string>();
    const open = this.closableSession();
    if (open) toStop.add(open.sessionId);
    // From here the old session is over for this player: late news about it (an event, a heartbeat) is stale, and
    // one the server already closed (expired, terminated) is not stopped again by a later failure.
    const old = this.snapshot.session;
    if (old) this.closedSessionId = old.sessionId;
    this.set({ phase: 'starting', busy: true });
    if (r && (!(await settlesWithin(r.done, STOP_WAIT_MS)) || r.failed)) toStop.add(r.sessionId);
    if (toStop.size === 0) return;
    await settlesWithin(Promise.all([...toStop].map((id) => this.deps.api.stop(id, positionMs).catch(() => undefined))), STOP_WAIT_MS);
  }
}

/** 404 or 410 on a session operation: the session is closed. */
function isClosed(e: unknown): boolean {
  return isPlaybackApiError(e) && (e.status === 404 || e.status === 410);
}

/**
 * A 422 on ChangeTracks/ChangeVersion that closed the session: the problem's sessionClosed. A server from before
 * the field is recognised by its detail text: "<why> The session was closed: …" (English, before the Italian reasons)
 * or "<why> La sessione è stata chiusa: …".
 */
export function isClosedRefusal(e: unknown): boolean {
  if (!isPlaybackApiError(e) || e.status !== 422) return false;
  return e.sessionClosed === true || /the session was closed|la sessione è stata chiusa/i.test(e.detail ?? '');
}

/**
 * 503 STREAM_PREPARING or MEDIA_UNAVAILABLE: the same call again after Retry-After. Not when the 503 closed the
 * session (sessionClosed: the file went away during an automatic re-plan): that one is shown at once.
 */
function isRetryLater(e: unknown): e is PlaybackApiError {
  return isPlaybackApiError(e) && e.status === 503 && e.sessionClosed !== true && (e.code === 'STREAM_PREPARING' || e.code === 'MEDIA_UNAVAILABLE');
}
