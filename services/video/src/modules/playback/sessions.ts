// Session Manager (doc 02 §3.10, doc 03 §4.2, doc 04 §6–§8, ADR 0003 D7/D9): sessions in memory,
// admission (sessions and transcodes, P4), heartbeats, re-plans with exclusions and the budget of
// automatic attempts. The sessionId stays stable across re-plans; each re-plan gets a new stream and
// so a new token from delivery.
import type { FastifyBaseLogger } from 'fastify';
import type { Ports } from '../../app/module.ts';
import { notFound, ProblemError } from '../../app/problem.ts';
import type { components } from '../../contract/schema.d.ts';
import { newId } from '../../shared/ids.ts';
import { streamTrackId } from '../../shared/media-facts.ts';
import type { DeliveryMode, PlanExclusion, PlaybackPlan, SubtitleAvailability, SuspectDimension } from '../../shared/playback-plan.ts';
import type { ClientCapabilities, PlayableFile, PlayableItem, ProfilePlaybackPrefs, StreamFailure, StreamHandle, StreamStatus } from '../../shared/ports.ts';
import {
  type DecideInput,
  type Decision,
  type DecisionConstraints,
  decide,
  exclusionsForFile,
  explainActions,
  MAX_AUTOMATIC_ATTEMPTS,
  rendersFromStream,
  subtitleTracks,
  subtitleWhenOff,
  type TrackSelection,
} from './decision/index.ts';
import { applyOverrides, type CapabilityOverride, validateOverrides } from './overrides.ts';
import { type PlaybackSessionView, sessionView } from './view.ts';

type Schemas = components['schemas'];
type ActiveSession = Schemas['ActiveSession'];

/** VBV max rate of a 1080p H.264 Transcode before the client limit (VideoTranscode.maxBitrateBps). */
export const TRANSCODE_MAX_BITRATE_BPS = 20_000_000;
/** A session that stopped this close to the end ended there (ProgressSample.ended). */
const END_TOLERANCE_MS = 5_000;
/** Closed sessions answer 410 instead of 404 for this long. */
export const TOMBSTONE_TTL_MS = 6 * 3600_000;
const NO_PREFS: ProfilePlaybackPrefs = { audioLanguages: [], subtitleLanguages: [], subtitleMode: 'off' };

/** STREAM_PREPARING: the handler copies retryAfterS into the Retry-After header. */
export class RetryLater extends ProblemError {
  readonly retryAfterS: number;
  constructor(retryAfterMs: number, detail: string) {
    super('STREAM_PREPARING', detail);
    this.retryAfterS = Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
}

export interface SessionManagerOptions {
  maxSessions: number;
  maxTranscodes: number;
  sessionTimeoutMs: number;
  overrides: readonly CapabilityOverride[];
  transcodeMaxBitrateBps?: number;
  /** PLAYBACK_PREPARING_MAX_S: longest wait without a stream (STREAM_PREPARING), then STREAM_FAILED. Default 900 s. */
  preparingMaxMs?: number;
}

export interface SessionManagerDeps {
  /** Resolved lazily (compose wires ports after every module is created). */
  ports: Pick<Ports, 'catalogRead' | 'profilePlayback' | 'streamDelivery' | 'events'>;
  now: () => number;
  log: FastifyBaseLogger;
  newId?: () => string;
  /** Test hook: an operation joined a session's queue or a profile's start chain (synchronously). */
  onQueued?: (key: string) => void;
}

type EndKind = 'stopped' | 'terminated' | 'expired' | 'failed' | 'shutdown';

interface ReplanOptions {
  automatic: boolean;
  /** A failure that is not the plan's fault (m7): no exclusion, 500 STREAM_FAILED once the budget is used. */
  transient?: boolean;
  exclusion?: PlanExclusion;
  selection: TrackSelection;
  fileId?: string;
  fileChosen: boolean;
  positionMs: number;
  /** Replaces the session's exclusions. */
  exclusions?: PlanExclusion[];
  /** An explicit subtitle the client asked for: a plan that cannot show it is refused (422). */
  requireSubtitle?: string;
  /** For the failure log (m9). */
  failure?: { cause: 'client' | 'server'; error: string };
  /** The re-plan back to the last working tracks after a refused change (no further fallback). */
  fallback?: boolean;
}

interface Session {
  sessionId: string;
  profileId: string;
  itemId: string;
  itemTitle: string;
  itemDurationMs: number | null;
  file: PlayableFile;
  capabilities: ClientCapabilities;
  prefs: ProfilePlaybackPrefs;
  /** Track choices kept by every re-plan (request, last choice, ChangeTracks). */
  selection: TrackSelection;
  /** The client chose the file (StartPlayback.fileId, ChangeVersion): re-plans never leave it. */
  fileChosen: boolean;
  forceMode: DeliveryMode | undefined;
  plan: PlaybackPlan;
  /** null while a re-plan waits for its stream after the old one stopped (S3). */
  handle: StreamHandle | null;
  /** The re-plan to run again while handle is null. */
  waiting: ReplanOptions | null;
  /** When the session started waiting without a stream (STREAM_PREPARING), null with a stream. */
  waitingSince: number | null;
  exclusions: PlanExclusion[];
  /** Automatic attempts used since StartPlayback (doc 04 §8). */
  attempts: number;
  /**
   * The track shown after a local switch since the plan (null: none); undefined: the plan's. With
   * a selection of off it can be the forced track: what was chosen is in `selection`.
   */
  subtitleSelected: string | null | undefined;
  availability: Map<string, SubtitleAvailability>;
  startedAt: number;
  lastSeenAt: number;
  positionMs: number;
  lastClientTs: number | null;
  ended: boolean;
  queue: Promise<unknown>;
}

interface Tombstone {
  profileId: string;
  itemId: string;
  fileId: string;
  durationMs: number | null;
  kind: EndKind;
  at: number;
  detail: string | null;
}

/** State of one StartPlayback or re-plan while it looks for a stream that starts. */
interface Attempt {
  sessionId: string;
  item: PlayableItem;
  capabilities: ClientCapabilities;
  prefs: ProfilePlaybackPrefs;
  selection: TrackSelection;
  /** The client's file: never left. */
  explicitFileId: string | undefined;
  /** The file of the current plan: tried first, then the other files (minimum change, doc 04 §8). */
  pinnedFileId: string | undefined;
  forceMode: DeliveryMode | undefined;
  startPositionMs: number;
  exclusions: PlanExclusion[];
  attempts: number;
  requireSubtitle: string | undefined;
}

/** Identity of an exclusion: everything but who blamed it and why. */
const exclusionKey = (e: PlanExclusion): string =>
  JSON.stringify(Object.entries(e).filter(([k]) => k !== 'cause' && k !== 'error').sort(([a], [b]) => (a < b ? -1 : 1)));

const hasExclusion = (list: readonly PlanExclusion[], e: PlanExclusion): boolean => list.some((x) => exclusionKey(x) === exclusionKey(e));

/** Short name of an excluded format, for logs. */
function excludedFormat(e: PlanExclusion | undefined): { dimension: string | null; format: string | null } {
  if (!e) return { dimension: null, format: null };
  switch (e.dimension) {
    case 'container':
    case 'video':
      return { dimension: e.dimension, format: `mode:${e.mode}` };
    case 'audio':
      return { dimension: 'audio', format: e.action === 'copy' ? `copy:${e.codec}${e.profile ? `/${e.profile}` : ''}` : `convert:${e.codec}` };
    case 'subtitle':
      return { dimension: 'subtitle', format: `${e.trackId}/${e.delivery}` };
  }
}

/** Producing the stream failed for a reason the plan cannot fix: retry the same plan (m7). */
const notPlanFault = (f: StreamFailure): boolean =>
  f.kind === 'io_error' || (f.kind === 'process_exit' && f.exitCode === null && f.signal === null); // spawn failure

function problemOf(d: Exclude<Decision, { ok: true }>): ProblemError {
  if (d.code === 'MEDIA_UNAVAILABLE') return new ProblemError('MEDIA_UNAVAILABLE', 'No file of the item is available');
  // The NO_COMPATIBLE_PLAN detail is shown to the viewer (web client "no plan" dialog): Italian, like the reasons.
  return new ProblemError('NO_COMPATIBLE_PLAN', d.reasons.map((r) => r.message).join('; ') || 'Nessun modo compatibile di riprodurre questo titolo');
}

const isPlayable = (item: PlayableItem): boolean => item.kind === 'movie' || item.kind === 'episode' || item.kind === 'extra';
const shuttingDown = (): ProblemError => new ProblemError('MEDIA_UNAVAILABLE', 'The video service is shutting down');
const isOff = (sel: TrackSelection): boolean => sel.subtitle !== undefined && sel.subtitle.trackId === null;

/** E-3: track ids are file-local, so with several versions they need the file they belong to. */
function requireFileForTracks(item: PlayableItem, body: { fileId?: string; audioTrackId?: string; subtitleTrackId?: string | null }): void {
  const namesTracks = body.audioTrackId !== undefined || typeof body.subtitleTrackId === 'string';
  if (namesTracks && body.fileId === undefined && item.files.length > 1) {
    throw new ProblemError('VALIDATION_FAILED', 'fileId is required with track ids when the item has several versions');
  }
}

export function createSessionManager(opts: SessionManagerOptions, deps: SessionManagerDeps) {
  const { ports, now, log } = deps;
  const makeId = deps.newId ?? newId;
  const queued = deps.onQueued ?? (() => undefined);
  const overrides = validateOverrides(opts.overrides, (rule, err) => log.warn({ err, override: rule.id }, 'capability override ignored: invalid modelPattern'));
  const sessions = new Map<string, Session>();
  /** StartPlayback and re-plans in flight: they hold a session slot and, once planned, maybe a transcode slot. */
  const pending = new Map<string, { mode: DeliveryMode | null; isNew: boolean }>();
  const tombstones = new Map<string, Tombstone>();
  /** One StartPlayback per profile at a time (m5). */
  const startChains = new Map<string, Promise<unknown>>();
  let closing = false;
  const preparingMaxMs = opts.preparingMaxMs ?? 900_000;
  /**
   * StartPlayback calls answered STREAM_PREPARING, per profile and item: since when, and the last one.
   * A pause longer than the session timeout starts a new wait.
   */
  const startWaits = new Map<string, { since: number; last: number }>();
  const tooLongPreparing = (sinceMs: number): ProblemError =>
    new ProblemError('STREAM_FAILED', `The stream was still not ready after ${Math.round((now() - sinceMs) / 1000)} s of waiting (PLAYBACK_PREPARING_MAX_S).`);
  const heartbeatIntervalMs = Math.max(2_000, Math.min(10_000, Math.floor(opts.sessionTimeoutMs / 4)));

  // ------------------------------------------------------------ helpers

  const constraints = (sessionId: string | null): DecisionConstraints => {
    const holders = new Set<string>();
    // A session waiting without a stream (S3) holds no slot; during a re-plan its pending entry does.
    for (const s of sessions.values()) if (s.plan.mode === 'transcode' && s.handle) holders.add(s.sessionId);
    for (const [id, p] of pending) {
      if (p.mode === 'transcode') holders.add(id);
      else if (p.mode !== null) holders.delete(id);
    }
    if (sessionId) holders.delete(sessionId);
    const transcode = opts.maxTranscodes === 0 ? 'disabled' : holders.size >= opts.maxTranscodes ? 'busy' : 'available';
    return { transcode, transcodeMaxBitrateBps: opts.transcodeMaxBitrateBps ?? TRANSCODE_MAX_BITRATE_BPS };
  };

  /**
   * The subtitle to store as the last choice (S5): null when subtitles were turned off (even with
   * the forced track shown), the track shown, the selected id when the plan dropped it, nothing when
   * the prefs found nothing.
   */
  function recordedSubtitle(s: Session): string | null | undefined {
    if (isOff(s.selection)) return null;
    if (s.subtitleSelected !== undefined) return s.subtitleSelected;
    const shown = s.plan.subtitles.selected?.trackId;
    if (shown) return shown;
    const pick = s.selection.subtitle;
    if (!pick) return undefined;
    if (pick.trackId === null) return null;
    return pick.fileId === null || pick.fileId === s.plan.file.fileId ? pick.trackId : undefined;
  }

  /**
   * The session's selection anchored to the file it plays: the tracks actually playing become
   * remembered picks of this file (an explicit pick of this file stays explicit), so a re-plan keeps
   * them (minimum change, doc 04 §8) and a fallback to another file matches them by descriptor.
   */
  function anchored(s: Session): TrackSelection {
    const fileId = s.plan.file.fileId;
    const sel = s.selection;
    const own = (p: { fileId: string | null } | undefined): boolean => p !== undefined && (p.fileId === null || p.fileId === fileId);
    const out: TrackSelection = sel.audioLanguage === undefined ? {} : { audioLanguage: sel.audioLanguage };
    if (s.plan.audio) {
      const trackId = s.plan.audio.source.trackId;
      out.audio = { trackId, fileId, strength: own(sel.audio) && sel.audio!.trackId === trackId && sel.audio!.strength === 'explicit' ? 'explicit' : 'remembered' };
    }
    // Off stays off on any file, whatever forced track it shows.
    if (sel.subtitle && sel.subtitle.trackId === null) out.subtitle = { ...sel.subtitle, fileId };
    else if (s.subtitleSelected !== undefined) out.subtitle = { trackId: s.subtitleSelected, fileId, strength: 'explicit' };
    else if (sel.subtitle && own(sel.subtitle)) out.subtitle = { ...sel.subtitle, fileId };
    else if (s.plan.subtitles.selected) out.subtitle = { trackId: s.plan.subtitles.selected.trackId, fileId, strength: 'remembered' };
    return out;
  }

  const view = (s: Session): PlaybackSessionView => {
    if (!s.handle) throw new RetryLater(1_000, 'The stream of this session is being prepared');
    return sessionView({
      sessionId: s.sessionId,
      itemId: s.itemId,
      facts: s.file.facts,
      itemDurationMs: s.itemDurationMs,
      capabilities: s.capabilities,
      plan: s.plan,
      handle: s.handle,
      subtitleSelected: s.subtitleSelected,
      availability: s.availability,
      expiresAt: s.lastSeenAt + opts.sessionTimeoutMs,
      heartbeatIntervalMs,
    });
  };

  const active = (s: Session): ActiveSession => ({
    sessionId: s.sessionId,
    profileId: s.profileId,
    itemId: s.itemId,
    itemTitle: s.itemTitle,
    mode: s.plan.mode,
    startedAt: s.startedAt,
    positionMs: s.positionMs,
  });

  const clampToDuration = (ms: number, durationMs: number | null): number => Math.max(0, durationMs === null ? ms : Math.min(ms, durationMs));

  function record(s: Session, positionMs: number, at = now()): void {
    const durationMs = s.plan.file.durationMs ?? s.itemDurationMs;
    const sub = recordedSubtitle(s);
    try {
      ports.profilePlayback.recordProgress({
        profileId: s.profileId,
        itemId: s.itemId,
        fileId: s.plan.file.fileId,
        positionMs,
        durationMs,
        at,
        ended: durationMs !== null && positionMs >= durationMs - END_TOLERANCE_MS,
        ...(s.plan.audio ? { audioTrackId: s.plan.audio.source.trackId } : {}),
        ...(sub === undefined ? {} : { subtitleTrackId: sub }),
      });
    } catch (err) {
      log.warn({ err, sessionId: s.sessionId }, 'progress not recorded');
    }
  }

  function publish(type: string, payload: Record<string, unknown>): void {
    try {
      ports.events.publish(type, payload);
    } catch (err) {
      log.warn({ err, type }, 'event not published');
    }
  }

  /** Runs one operation of a session at a time: re-plans, stops, expiry and shutdown never interleave. */
  function serial<T>(s: Session, fn: () => Promise<T>): Promise<T> {
    const run = s.queue.then(() => {
      if (s.ended) throw gone(s.sessionId);
      return fn();
    });
    s.queue = run.catch(() => undefined);
    queued(s.sessionId);
    return run;
  }

  function gone(sessionId: string): ProblemError {
    const t = tombstones.get(sessionId);
    const detail =
      t?.detail ?? (t?.kind === 'terminated' ? 'Session terminated' : t?.kind === 'failed' ? 'Session ended after a playback failure' : 'Session closed');
    return new ProblemError('SESSION_EXPIRED', detail);
  }

  /** The live session of this profile; 410 for a closed one, 404 otherwise. */
  function live(sessionId: string, profileId: string): Session {
    const s = sessions.get(sessionId);
    if (s && s.profileId === profileId) return s;
    const t = tombstones.get(sessionId);
    if (t && t.profileId === profileId) throw gone(sessionId);
    throw notFound('Playback session');
  }

  const touch = (s: Session): void => {
    s.lastSeenAt = now();
  };

  /** reason: the playback.session_terminated reason when it is more specific than kind (contract Event). */
  async function end(s: Session, kind: EndKind, o: { positionMs?: number; streamStopped?: boolean; detail?: string; reason?: 'item_removed' } = {}): Promise<void> {
    if (s.ended) return;
    s.ended = true;
    sessions.delete(s.sessionId);
    const at = now();
    tombstones.set(s.sessionId, { profileId: s.profileId, itemId: s.itemId, fileId: s.plan.file.fileId, durationMs: s.plan.file.durationMs, kind, at, detail: o.detail ?? null });
    const handle = s.handle;
    s.handle = null;
    if (handle && !o.streamStopped) {
      try {
        await ports.streamDelivery.stop(handle, kind === 'failed' ? 'stopped' : kind);
      } catch (err) {
        log.warn({ err, sessionId: s.sessionId }, 'stream stop failed');
      }
    }
    record(s, o.positionMs ?? s.positionMs, at);
    if (kind === 'expired' || kind === 'terminated' || kind === 'failed') {
      publish('playback.session_terminated', { sessionId: s.sessionId, profileId: s.profileId, itemId: s.itemId, reason: o.reason ?? kind });
    }
  }

  function playableItem(itemId: string): PlayableItem {
    const item = ports.catalogRead.getPlayableItem(itemId);
    if (!item || !isPlayable(item)) throw notFound('Playable item');
    return item;
  }

  /** The session's item, or the session ends with 410 when it left the catalog (m11). */
  async function sessionItem(s: Session, positionMs: number): Promise<PlayableItem> {
    const item = ports.catalogRead.getPlayableItem(s.itemId);
    if (item && isPlayable(item)) return item;
    await end(s, 'failed', { positionMs, detail: 'The item was removed from the library', reason: 'item_removed' });
    throw gone(s.sessionId);
  }

  function logFailure(s: Pick<Session, 'sessionId' | 'capabilities'>, f: { cause: 'client' | 'server'; error: string }, e: PlanExclusion | undefined, attempt: number, modeBefore: DeliveryMode, modeAfter: DeliveryMode | null): void {
    // Structured, without tokens or URLs (m9).
    log.info(
      {
        event: 'playback.failure',
        sessionId: s.sessionId,
        deviceModel: s.capabilities.device.model ?? null,
        deviceClass: s.capabilities.device.class,
        excluded: excludedFormat(e),
        cause: f.cause,
        error: f.error,
        attempt,
        modeBefore,
        modeAfter,
      },
      'playback failure',
    );
  }

  // ------------------------------------------------------------ planning

  function decideFor(a: Attempt): Decision {
    const base: DecideInput = {
      files: a.item.files,
      capabilities: a.capabilities,
      prefs: a.prefs,
      selection: a.selection,
      startPositionMs: a.startPositionMs,
      constraints: constraints(a.sessionId),
      exclusions: a.exclusions,
      ...(a.forceMode ? { forceMode: a.forceMode } : {}),
    };
    const fileId = a.explicitFileId ?? a.pinnedFileId;
    const d = decide(fileId === undefined ? base : { ...base, fileId });
    if (d.ok || a.explicitFileId !== undefined || a.pinnedFileId === undefined) return d;
    // The picks carry their own file: on the other files they match by descriptor, never by id.
    const other = decide(base);
    return other.ok ? other : d;
  }

  /**
   * The exclusion for a failure blamed on a dimension (doc 04 §8): audio → that audio output; subtitle
   * → that treatment of the selected track (null when none is shown); video, container, unknown → this
   * mode of this file, so the next plan takes a heavier one.
   */
  function exclusionFor(s: Pick<Session, 'plan' | 'subtitleSelected'>, suspect: SuspectDimension, cause: 'client' | 'server', error: string): PlanExclusion | null {
    const plan = s.plan;
    const modeEx = (dimension: 'video' | 'container'): PlanExclusion => ({ dimension, fileId: plan.file.fileId, mode: plan.mode, cause, error });
    if (suspect === 'audio') {
      if (!plan.audio) return modeEx('video');
      const a = plan.audio;
      return a.action.kind === 'copy'
        ? { dimension: 'audio', action: 'copy', codec: a.source.codec, profile: a.source.profile, cause, error }
        : { dimension: 'audio', action: 'convert', codec: a.action.codec, cause, error };
    }
    if (suspect === 'subtitle') {
      const id = s.subtitleSelected === undefined ? (plan.subtitles.selected?.trackId ?? null) : s.subtitleSelected;
      if (id === null) return null;
      const delivery = plan.subtitles.served.find((x) => x.trackId === id)?.delivery ?? (plan.subtitles.selected?.trackId === id ? plan.subtitles.selected.delivery : null);
      return delivery ? { dimension: 'subtitle', trackId: id, delivery, fileId: plan.file.fileId, cause, error } : null;
    }
    return modeEx(suspect === 'container' ? 'container' : 'video');
  }

  /** A format already excluded (a stale record), or none derivable: fall back to a heavier mode. */
  function freshExclusion(plan: PlaybackPlan, e: PlanExclusion | null, list: readonly PlanExclusion[], cause: 'client' | 'server', error: string): PlanExclusion {
    // Track ids are per file: pin a subtitle exclusion from delivery to the file it was planned on.
    const pinned = e?.dimension === 'subtitle' && e.fileId === null ? { ...e, fileId: plan.file.fileId } : e;
    if (pinned && !hasExclusion(list, pinned)) return pinned;
    return { dimension: 'video', fileId: plan.file.fileId, mode: plan.mode, cause, error };
  }

  function droppedRequired(a: Attempt, d: Extract<Decision, { ok: true }>): ProblemError | null {
    if (a.requireSubtitle === undefined || d.droppedSubtitleTrackId !== a.requireSubtitle) return null;
    return new ProblemError('NO_COMPATIBLE_PLAN', d.plan.reasons.find((r) => r.code === 'subtitle_dropped')?.message ?? 'La traccia di sottotitoli non si può visualizzare');
  }

  /**
   * Starts a stream for the attempt, re-planning server-side when delivery reports STREAM_FAILED,
   * within the budget of automatic attempts (doc 04 §8, ADR 0003 D7).
   */
  async function run(a: Attempt, log0: Pick<Session, 'sessionId' | 'capabilities'>, first?: Decision): Promise<{ plan: PlaybackPlan; handle: StreamHandle }> {
    let decision = first ?? decideFor(a);
    for (;;) {
      if (!decision.ok) throw problemOf(decision);
      const refused = droppedRequired(a, decision); // m8: also after a server-side re-plan
      if (refused) throw refused;
      const plan = decision.plan;
      const slot = pending.get(a.sessionId);
      if (slot) slot.mode = plan.mode;
      const res = await ports.streamDelivery.start(plan, a.sessionId);
      if (res.ok) return { plan, handle: res.handle };
      if (res.code === 'STREAM_PREPARING') throw new RetryLater(res.retryAfterMs, 'The stream is being prepared (keyframe index or a subtitle to burn in)');
      if (res.code === 'MEDIA_UNAVAILABLE') throw new ProblemError('MEDIA_UNAVAILABLE', res.detail);
      const f = res.failure;
      const transient = notPlanFault(f);
      if (a.attempts >= MAX_AUTOMATIC_ATTEMPTS) {
        logFailure(log0, { cause: 'server', error: f.kind }, undefined, a.attempts, plan.mode, null);
        // STREAM_FAILED's detail is technical (the client shows its own text); NO_COMPATIBLE_PLAN's reaches the viewer.
        if (transient) throw new ProblemError('STREAM_FAILED', `The stream could not be produced (${f.kind}) and the ${MAX_AUTOMATIC_ATTEMPTS} automatic attempts are used up.`);
        throw new ProblemError(
          'NO_COMPATIBLE_PLAN',
          `Lo stream non è stato prodotto (${f.kind}) e i ${MAX_AUTOMATIC_ATTEMPTS} tentativi automatici sono esauriti. ${plan.reasons.map((r) => r.message).join('; ')}`,
        );
      }
      a.attempts += 1;
      a.pinnedFileId = plan.file.fileId;
      let excluded: PlanExclusion | undefined;
      if (!transient) {
        excluded = freshExclusion(plan, f.exclusion ?? exclusionFor({ plan, subtitleSelected: undefined }, f.suspect, 'server', f.kind), a.exclusions, 'server', f.kind);
        a.exclusions = [...a.exclusions, excluded];
        decision = decideFor(a);
      }
      logFailure(log0, { cause: 'server', error: f.kind }, excluded, a.attempts, plan.mode, decision.ok ? decision.plan.mode : null);
    }
  }

  /** m6: a stop that throws is tried once more, then left to delivery's idle kill. */
  async function stopOld(s: Session, old: StreamHandle): Promise<void> {
    for (let i = 0; i < 2; i++) {
      try {
        await ports.streamDelivery.stop(old, 'replanned');
        return;
      } catch (err) {
        if (i === 1) log.warn({ err, sessionId: s.sessionId, streamId: old.streamId }, 'stream stop failed during a re-plan, left to the idle kill');
      }
    }
  }

  /**
   * A user change refused (422) while the session waits without a stream: back to the last working
   * tracks, so the session does not stay without one. When those fail too, the session ends.
   */
  async function refusedWhileWaiting(s: Session, o: ReplanOptions, err: ProblemError): Promise<ProblemError> {
    const closed = (why: string) =>
      new ProblemError('NO_COMPATIBLE_PLAN', `${why} La sessione è stata chiusa: nemmeno le tracce precedenti si possono riprodurre.`, { sessionClosed: true });
    if (o.fallback) {
      await end(s, 'failed', { positionMs: o.positionMs, detail: 'Session closed: no playable plan' });
      return closed(err.message);
    }
    try {
      await replan(s, { automatic: false, selection: anchored(s), fileChosen: s.fileChosen, positionMs: o.positionMs, fallback: true });
    } catch {
      if (s.ended) return closed(err.message);
      // Still waiting (STREAM_PREPARING): the next call retries the previous tracks.
    }
    return err;
  }

  /** stop(old, 'replanned') then start(new plan), same sessionId (ADR 0003 D7). Runs inside serial(). */
  async function replan(s: Session, o: ReplanOptions): Promise<PlaybackSessionView> {
    const item = await sessionItem(s, o.positionMs);
    const waitingBefore = s.handle === null;
    const refuse = async (err: ProblemError): Promise<never> => {
      throw !o.automatic && waitingBefore && err.code === 'NO_COMPATIBLE_PLAN' ? await refusedWhileWaiting(s, o, err) : err;
    };
    if (o.automatic && s.attempts >= MAX_AUTOMATIC_ATTEMPTS) {
      await end(s, 'failed', { positionMs: o.positionMs });
      if (o.transient) throw new ProblemError('STREAM_FAILED', `The ${MAX_AUTOMATIC_ATTEMPTS} automatic attempts of this playback are used up.`);
      throw new ProblemError('NO_COMPATIBLE_PLAN', `I ${MAX_AUTOMATIC_ATTEMPTS} tentativi automatici di questa riproduzione sono esauriti. ${s.plan.reasons.map((r) => r.message).join('; ')}`);
    }
    const base = o.exclusions ?? s.exclusions;
    const fileId = o.fileId ?? s.plan.file.fileId;
    const a: Attempt = {
      sessionId: s.sessionId,
      item,
      capabilities: s.capabilities,
      prefs: ports.profilePlayback.getPrefs(s.profileId) ?? s.prefs,
      selection: o.selection,
      explicitFileId: o.fileChosen ? fileId : undefined,
      pinnedFileId: fileId,
      forceMode: s.forceMode,
      startPositionMs: o.positionMs,
      exclusions: o.exclusion ? [...base, o.exclusion] : [...base],
      attempts: s.attempts + (o.automatic ? 1 : 0),
      requireSubtitle: o.requireSubtitle,
    };
    pending.set(s.sessionId, { mode: null, isNew: false });
    try {
      // Decide before stopping: a change without a plan leaves the running stream alone.
      const first = decideFor(a);
      if (!first.ok) {
        if (o.failure) logFailure(s, o.failure, o.exclusion, a.attempts, s.plan.mode, null);
        if (o.automatic) await end(s, 'failed', { positionMs: o.positionMs });
        return await refuse(problemOf(first));
      }
      const refused = droppedRequired(a, first);
      if (refused) return await refuse(refused);
      // S2: until run() narrows it, the slot counts as a transcode if either plan is one.
      pending.set(s.sessionId, { mode: s.plan.mode === 'transcode' || first.plan.mode === 'transcode' ? 'transcode' : first.plan.mode, isNew: false });
      if (o.failure) logFailure(s, o.failure, o.exclusion, a.attempts, s.plan.mode, first.plan.mode);
      const old = s.handle;
      s.handle = null;
      if (old) await stopOld(s, old);
      let started: { plan: PlaybackPlan; handle: StreamHandle };
      try {
        started = await run(a, s, first);
      } catch (err) {
        const waitable = err instanceof RetryLater || (!o.automatic && err instanceof ProblemError && err.code === 'MEDIA_UNAVAILABLE');
        // M3: a session cannot wait without a stream for longer than PLAYBACK_PREPARING_MAX_S.
        const since = s.waitingSince ?? now();
        if (waitable && !closing && now() - since >= preparingMaxMs) {
          await end(s, 'failed', { positionMs: o.positionMs, streamStopped: true, detail: 'Session closed: the stream was never ready' });
          throw tooLongPreparing(since);
        }
        if (waitable && !closing) {
          s.waitingSince = since;
          // S3: the session stays open without a stream; the next call runs this re-plan again.
          s.exclusions = a.exclusions;
          s.attempts = a.attempts - (o.automatic ? 1 : 0); // this re-plan's own attempt is given back
          s.positionMs = o.positionMs;
          s.waiting = { ...o, exclusion: undefined, exclusions: a.exclusions };
          throw err;
        }
        await end(s, 'failed', { positionMs: o.positionMs, streamStopped: true });
        throw err;
      }
      if (s.ended || closing) {
        // m1: the session closed (or the service is stopping) while the stream started.
        try {
          await ports.streamDelivery.stop(started.handle, 'shutdown');
        } catch (err) {
          log.warn({ err, sessionId: s.sessionId }, 'stream stop failed');
        }
        if (!s.ended) await end(s, 'shutdown', { positionMs: o.positionMs, streamStopped: true });
        throw closing ? shuttingDown() : gone(s.sessionId);
      }
      const file = item.files.find((f) => f.fileId === started.plan.file.fileId)!;
      Object.assign(s, {
        itemTitle: item.title,
        itemDurationMs: item.durationMs,
        file,
        prefs: a.prefs,
        selection: o.selection,
        fileChosen: o.fileChosen,
        plan: started.plan,
        handle: started.handle,
        waiting: null,
        waitingSince: null,
        exclusions: a.exclusions,
        attempts: a.attempts,
        subtitleSelected: undefined,
        availability: new Map(),
        positionMs: started.plan.startPositionMs,
      });
      return view(s);
    } finally {
      pending.delete(s.sessionId);
    }
  }

  /** A session without a stream (S3): run its waiting re-plan again. */
  const resume = (s: Session): Promise<PlaybackSessionView> =>
    replan(s, s.waiting ?? { automatic: false, selection: anchored(s), fileChosen: s.fileChosen, positionMs: s.positionMs });

  // ------------------------------------------------------------ operations

  type StartBody = Schemas['StartPlaybackRequest'];

  function startPlayback(profileId: string, body: StartBody): Promise<PlaybackSessionView> {
    if (closing) return Promise.reject(shuttingDown());
    // m5: a second start of the same profile waits for the first, then meets the normal limit rule.
    const run = (startChains.get(profileId) ?? Promise.resolve()).then(() => startOnce(profileId, body));
    const tail = run.catch(() => undefined);
    startChains.set(profileId, tail);
    queued(profileId);
    void tail.then(() => {
      if (startChains.get(profileId) === tail) startChains.delete(profileId);
    });
    return run;
  }

  async function startOnce(profileId: string, body: StartBody): Promise<PlaybackSessionView> {
    if (closing) throw shuttingDown();
    const item = playableItem(body.itemId);
    if (item.files.length === 0) throw new ProblemError('MEDIA_UNAVAILABLE', 'The item has no analysed media file');
    if (body.fileId !== undefined && !item.files.some((f) => f.fileId === body.fileId)) throw notFound('Media file');
    requireFileForTracks(item, body);
    const candidates = body.fileId === undefined ? item.files : item.files.filter((f) => f.fileId === body.fileId);
    const hasAudio = (id: string) => candidates.some((f) => f.facts.streams.some((s) => s.type === 'audio' && streamTrackId(s.index) === id));
    const hasSubtitle = (id: string) => candidates.some((f) => subtitleTracks(f.facts).some((t) => t.trackId === id));
    if (body.audioTrackId !== undefined && !hasAudio(body.audioTrackId)) throw notFound('Audio track');
    if (typeof body.subtitleTrackId === 'string' && !hasSubtitle(body.subtitleTrackId)) throw notFound('Subtitle track');
    const prefs = ports.profilePlayback.getPrefs(profileId);
    if (!prefs) throw notFound('Profile');

    const newOnes = [...pending.values()].filter((p) => p.isNew).length;
    if (sessions.size + newOnes >= opts.maxSessions) {
      throw new ProblemError('SESSION_LIMIT_REACHED', opts.maxSessions === 1 ? 'Al massimo 1 riproduzione alla volta' : `Al massimo ${opts.maxSessions} riproduzioni alla volta`, { activeSessions: [...sessions.values()].map(active) });
    }

    // Explicit request first (hard), then the profile's last choice on the item (remembered, soft:
    // matched by descriptor on another version), then the prefs (doc 04 §3.1).
    const last = ports.profilePlayback.lastTrackChoice(profileId, item.itemId);
    const requestFile = body.fileId ?? null;
    const selection: TrackSelection = {};
    if (body.audioTrackId !== undefined) selection.audio = { trackId: body.audioTrackId, fileId: requestFile, strength: 'explicit' };
    else if (last?.audioTrackId) selection.audio = { trackId: last.audioTrackId, fileId: last.fileId, strength: 'remembered' };
    if (body.subtitleTrackId !== undefined) selection.subtitle = { trackId: body.subtitleTrackId, fileId: requestFile, strength: 'explicit' };
    // E-1: an unknown subtitle choice leaves the prefs to decide.
    else if (last?.subtitleTrackId !== undefined) selection.subtitle = { trackId: last.subtitleTrackId, fileId: last.fileId, strength: 'remembered' };

    const sessionId = makeId();
    pending.set(sessionId, { mode: null, isNew: true });
    try {
      const capabilities = applyOverrides(body.capabilities, overrides).capabilities;
      const a: Attempt = {
        sessionId,
        item,
        capabilities,
        prefs,
        selection,
        explicitFileId: body.fileId,
        pinnedFileId: undefined,
        forceMode: body.forceMode,
        startPositionMs: body.startPositionMs ?? ports.profilePlayback.resumePositionMs(profileId, item.itemId) ?? 0,
        exclusions: [],
        attempts: 0,
        requireSubtitle: undefined,
      };
      const waitKey = `${profileId}\u0000${item.itemId}`;
      let started: { plan: PlaybackPlan; handle: StreamHandle };
      try {
        started = await run(a, { sessionId, capabilities });
      } catch (err) {
        if (err instanceof RetryLater) {
          // M3: StartPlayback retried on STREAM_PREPARING is capped like a waiting session.
          const t = now();
          for (const [k, w] of startWaits) if (t - w.last > opts.sessionTimeoutMs) startWaits.delete(k);
          const w = startWaits.get(waitKey) ?? { since: t, last: t };
          w.last = t;
          startWaits.set(waitKey, w);
          if (t - w.since >= preparingMaxMs) {
            startWaits.delete(waitKey);
            throw tooLongPreparing(w.since);
          }
        }
        throw err;
      }
      startWaits.delete(waitKey);
      const { plan, handle } = started;
      if (closing) {
        try {
          await ports.streamDelivery.stop(handle, 'shutdown');
        } catch (err) {
          log.warn({ err, sessionId }, 'stream stop failed');
        }
        throw shuttingDown();
      }
      const t = now();
      const s: Session = {
        sessionId,
        profileId,
        itemId: item.itemId,
        itemTitle: item.title,
        itemDurationMs: item.durationMs,
        file: item.files.find((f) => f.fileId === plan.file.fileId)!,
        capabilities,
        prefs,
        selection,
        fileChosen: body.fileId !== undefined,
        forceMode: body.forceMode,
        plan,
        handle,
        waiting: null,
        waitingSince: null,
        exclusions: a.exclusions,
        attempts: a.attempts,
        subtitleSelected: undefined,
        availability: new Map(),
        startedAt: t,
        lastSeenAt: t,
        positionMs: plan.startPositionMs,
        lastClientTs: null,
        ended: false,
        queue: Promise.resolve(),
      };
      sessions.set(sessionId, s);
      return view(s);
    } finally {
      pending.delete(sessionId);
    }
  }

  function reportProgress(profileId: string, sessionId: string, body: Schemas['ProgressReport']): void {
    const s = live(sessionId, profileId);
    touch(s);
    // The latest client timestamp wins: a report out of order still counts as a heartbeat.
    if (s.lastClientTs !== null && body.clientTs <= s.lastClientTs) return;
    s.lastClientTs = body.clientTs;
    s.positionMs = clampToDuration(body.positionMs, s.plan.file.durationMs ?? s.itemDurationMs);
    record(s, s.positionMs);
  }

  async function stopPlayback(profileId: string, sessionId: string, body: Schemas['StopRequest']): Promise<void> {
    const s = sessions.get(sessionId);
    if (s && s.profileId === profileId) {
      try {
        await serial(s, () => end(s, 'stopped', { positionMs: clampToDuration(body.positionMs, s.plan.file.durationMs ?? s.itemDurationMs) }));
        return;
      } catch (err) {
        // m2: closed while the stop was queued (a failing re-plan): the tombstone path below.
        if (!(err instanceof ProblemError && err.code === 'SESSION_EXPIRED')) throw err;
      }
    }
    // Idempotent. After a server-side close the client's final position is still worth keeping, dated
    // at the close (S4) so it never overrides a later session's progress.
    const t = tombstones.get(sessionId);
    if (t && t.profileId === profileId) {
      try {
        ports.profilePlayback.recordProgress({
          profileId,
          itemId: t.itemId,
          fileId: t.fileId,
          positionMs: clampToDuration(body.positionMs, t.durationMs),
          durationMs: t.durationMs,
          at: t.at,
          ended: t.durationMs !== null && body.positionMs >= t.durationMs - END_TOLERANCE_MS,
        });
      } catch (err) {
        log.warn({ err, sessionId }, 'progress not recorded');
      }
    }
  }

  async function terminateSession(sessionId: string): Promise<void> {
    const s = sessions.get(sessionId);
    if (!s) return;
    await serial(s, () => end(s, 'terminated')).catch(() => undefined);
  }

  async function changeTracks(profileId: string, sessionId: string, body: Schemas['ChangeTracksRequest']): Promise<PlaybackSessionView> {
    const s = live(sessionId, profileId);
    return serial(s, async () => {
      touch(s);
      const positionMs = body.positionMs ?? s.positionMs;
      const requireSubtitle = typeof body.subtitleTrackId === 'string' ? { requireSubtitle: body.subtitleTrackId } : {};
      if (s.waiting) {
        // A change still waiting for its stream (S3): this one builds on it, on its file.
        const w = s.waiting;
        const fileId = w.fileId ?? s.plan.file.fileId;
        const file = (await sessionItem(s, positionMs)).files.find((f) => f.fileId === fileId) ?? s.file;
        const selection: TrackSelection = { ...w.selection };
        if (body.audioTrackId !== undefined) {
          if (!file.facts.streams.some((x) => x.type === 'audio' && streamTrackId(x.index) === body.audioTrackId)) throw notFound('Audio track');
          selection.audio = { trackId: body.audioTrackId, fileId: file.fileId, strength: 'explicit' };
        }
        if (body.subtitleTrackId !== undefined) {
          const id = body.subtitleTrackId;
          if (id !== null && !subtitleTracks(file.facts).some((t) => t.trackId === id)) throw notFound('Subtitle track');
          selection.subtitle = { trackId: id, fileId: file.fileId, strength: 'explicit' };
        }
        return replan(s, { automatic: false, selection, ...(w.fileId ? { fileId: w.fileId } : {}), fileChosen: w.fileChosen, positionMs, ...requireSubtitle });
      }
      const fileId = s.plan.file.fileId;
      const selection: TrackSelection = anchored(s);
      // No stream (S3): whatever changes, the stream has to be started.
      let needsReplan = s.handle === null;
      let localSubtitle: string | null | undefined;
      if (body.audioTrackId !== undefined) {
        if (!s.file.facts.streams.some((x) => x.type === 'audio' && streamTrackId(x.index) === body.audioTrackId)) throw notFound('Audio track');
        selection.audio = { trackId: body.audioTrackId, fileId, strength: 'explicit' };
        // Audio is muxed into the stream (ADR 0003 D1): any change is a re-plan.
        if (body.audioTrackId !== s.plan.audio?.source.trackId) needsReplan = true;
      }
      if (body.subtitleTrackId !== undefined) {
        const id = body.subtitleTrackId;
        const tracks = subtitleTracks(s.file.facts);
        const track = id === null ? null : tracks.find((t) => t.trackId === id);
        if (track === undefined) throw notFound('Subtitle track');
        selection.subtitle = { trackId: id, fileId, strength: 'explicit' };
        // Off still shows the forced track in the audio language (doc 04 §3.1).
        const shown = track ?? subtitleWhenOff(tracks, s.capabilities, s.plan.audio?.source.language ?? null);
        const shownId = shown?.trackId ?? null;
        const selected = s.plan.subtitles.selected;
        const burned = selected?.delivery === 'burned';
        if (burned && shownId === selected.trackId) {
          localSubtitle = shownId; // already burned in
        } else if (burned) {
          needsReplan = true; // burn-in off
        } else if (
          shown === null ||
          s.plan.subtitles.served.some((x) => x.trackId === shownId) ||
          (s.plan.mode === 'direct_play' && rendersFromStream(shown, s.capabilities, exclusionsForFile(s.exclusions, fileId), []))
        ) {
          localSubtitle = shownId;
        } else {
          needsReplan = true; // a track that needs a new treatment (burn-in)
        }
      }
      if (needsReplan) return replan(s, { automatic: false, selection, fileChosen: s.fileChosen, positionMs, ...requireSubtitle });
      s.selection = selection;
      if (localSubtitle !== undefined) s.subtitleSelected = localSubtitle;
      await refreshAvailability(s);
      return view(s);
    });
  }

  async function refreshAvailability(s: Session): Promise<void> {
    if (!s.handle) return;
    try {
      const st = await ports.streamDelivery.status(s.handle);
      for (const t of st?.subtitles ?? []) s.availability.set(t.trackId, t.availability);
    } catch (err) {
      log.warn({ err, sessionId: s.sessionId }, 'stream status failed');
    }
  }

  async function changeVersion(profileId: string, sessionId: string, body: Schemas['ChangeVersionRequest']): Promise<PlaybackSessionView> {
    const s = live(sessionId, profileId);
    return serial(s, async () => {
      touch(s);
      const positionMs = body.positionMs ?? s.positionMs;
      const item = await sessionItem(s, positionMs);
      const f = item.files.find((x) => x.fileId === body.fileId);
      if (!f) throw notFound('Media file');
      if (!f.available) throw new ProblemError('MEDIA_UNAVAILABLE', 'This version is not available');
      if (f.fileId === s.plan.file.fileId && s.handle) {
        s.fileChosen = true; // m4: chosen even when it is the file already playing
        return view(s);
      }
      // Track ids are per file. Explicit tracks carry over as remembered picks matched by descriptor
      // (E-2), the audio with its language (m13); off carries over as off. The exclusions stay: mode
      // and subtitle ones are pinned to their file (m3). fileChosen is set when the re-plan succeeds.
      const cur = anchored(s);
      const selection: TrackSelection = s.selection.audioLanguage === undefined ? {} : { audioLanguage: s.selection.audioLanguage };
      if (cur.audio?.strength === 'explicit') {
        selection.audio = { ...cur.audio, strength: 'remembered' };
        const lang = s.plan.audio?.source.language;
        if (lang) selection.audioLanguage = lang;
      }
      if (cur.subtitle?.trackId === null) selection.subtitle = { trackId: null, fileId: null, strength: 'remembered' };
      else if (cur.subtitle?.strength === 'explicit') selection.subtitle = { ...cur.subtitle, strength: 'remembered' };
      return replan(s, { automatic: false, selection, fileId: f.fileId, fileChosen: true, positionMs, exclusions: s.exclusions });
    });
  }

  async function reportPlaybackFailure(profileId: string, sessionId: string, body: Schemas['FallbackRequest']): Promise<PlaybackSessionView> {
    const s = live(sessionId, profileId);
    // S1: the stream the client saw fail. A report queued behind a change that replaced it is stale.
    const reportedStream = s.handle?.streamId ?? null;
    return serial(s, async () => {
      touch(s);
      if (!s.handle) return resume(s); // S3: no stream yet, start it
      if (s.handle.streamId !== reportedStream) return view(s);
      let status: StreamStatus | null = null;
      try {
        status = await ports.streamDelivery.status(s.handle);
      } catch (err) {
        log.warn({ err, sessionId }, 'stream status failed');
      }
      const failure = status?.failure ?? null;
      const suspect = body.suspect ?? 'unknown';
      // Delivery's record wins (doc 04 §8). A failure delivery already recovered from does not
      // override a dimension the client did name.
      const server = failure !== null && (failure.terminal || status?.state === 'failed' || suspect === 'unknown');
      const dead = status?.state === 'failed' || failure?.terminal === true;
      const selection = anchored(s);
      const base = { automatic: true, selection, fileChosen: s.fileChosen, positionMs: body.positionMs };
      if (server && failure.kind === 'file_unavailable') {
        logFailure(s, { cause: 'server', error: failure.kind }, undefined, s.attempts, s.plan.mode, null);
        await end(s, 'failed', { positionMs: body.positionMs });
        throw new ProblemError('MEDIA_UNAVAILABLE', 'The file is no longer available');
      }
      if (server && notPlanFault(failure)) {
        // m7: not the plan's fault: the same plan again, within the budget.
        return replan(s, { ...base, transient: true, failure: { cause: 'server', error: failure.kind } });
      }
      const cause = server ? 'server' : 'client';
      const error = server ? failure.kind : body.error;
      const proposed = server ? (failure.exclusion ?? exclusionFor(s, failure.suspect, 'server', failure.kind)) : exclusionFor(s, suspect, 'client', body.error);
      // A subtitle failure with no track shown changes nothing, unless the stream is dead (S6).
      if (proposed === null && !dead) return view(s);
      const exclusion = freshExclusion(s.plan, proposed, s.exclusions, cause, error);
      // Keep the failed subtitle selected, so the plan moves it to its next treatment (doc 04 §8).
      if (exclusion.dimension === 'subtitle') {
        selection.subtitle = { trackId: exclusion.trackId, fileId: s.plan.file.fileId, strength: selection.subtitle?.strength ?? 'remembered' };
      }
      return replan(s, { ...base, exclusion, failure: { cause, error } });
    });
  }

  function explain(body: Schemas['ExplainRequest']): Schemas['PlaybackPlanExplanation'] {
    // 200 whenever the item exists (doc 03 §6), also without a plan or an available file.
    const item = ports.catalogRead.getPlayableItem(body.itemId);
    if (!item) throw notFound('Item');
    if (body.fileId !== undefined && !item.files.some((f) => f.fileId === body.fileId)) throw notFound('Media file');
    requireFileForTracks(item, body);
    const fileId = body.fileId ?? null;
    const selection: TrackSelection = {};
    if (body.audioTrackId !== undefined) selection.audio = { trackId: body.audioTrackId, fileId, strength: 'explicit' };
    if (body.subtitleTrackId !== undefined) selection.subtitle = { trackId: body.subtitleTrackId, fileId, strength: 'explicit' };
    const d = decide({
      files: item.files,
      ...(body.fileId !== undefined ? { fileId: body.fileId } : {}),
      capabilities: applyOverrides(body.capabilities, overrides).capabilities,
      prefs: NO_PREFS,
      selection,
      startPositionMs: 0,
      constraints: constraints(null),
      exclusions: [],
    });
    const candidates = d.candidates.map((c) => ({ fileId: c.fileId, mode: c.mode, reasons: c.reasons.map((r) => r.message) }));
    if (d.ok) return { mode: d.plan.mode, fileId: d.plan.file.fileId, reasons: d.plan.reasons.map((r) => r.message), actions: explainActions(d.plan), candidates };
    const reasons = d.reasons.map((r) => r.message);
    if (reasons.length === 0) reasons.push(item.files.length === 0 ? 'Il titolo non ha un file riproducibile' : 'Nessun file del titolo è disponibile');
    return { mode: null, fileId: null, reasons, actions: {}, candidates };
  }

  /** Heartbeat expiry: a session silent for longer than the timeout is closed, last position kept. */
  async function expire(): Promise<void> {
    const t = now();
    for (const [id, tomb] of tombstones) if (t - tomb.at > TOMBSTONE_TTL_MS) tombstones.delete(id);
    const stale = [...sessions.values()].filter((s) => t - s.lastSeenAt > opts.sessionTimeoutMs);
    await Promise.all(stale.map((s) => serial(s, () => (now() - s.lastSeenAt > opts.sessionTimeoutMs ? end(s, 'expired') : Promise.resolve())).catch(() => undefined)));
  }

  /** m1: refuses new starts, then closes every session through its queue. */
  async function shutdown(): Promise<void> {
    closing = true;
    await Promise.all([...sessions.values()].map((s) => serial(s, () => end(s, 'shutdown')).catch(() => undefined)));
  }

  return {
    startPlayback,
    reportProgress,
    stopPlayback,
    terminateSession,
    changeTracks,
    changeVersion,
    reportPlaybackFailure,
    explain,
    list: (): ActiveSession[] => [...sessions.values()].map(active),
    expire,
    shutdown,
    heartbeatIntervalMs,
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
