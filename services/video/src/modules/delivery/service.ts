// Stream Delivery (doc 02 §3.11, ADR 0003 D9): the StreamDeliveryPort, the token table, the streams, the
// keyframe index job and the embedded subtitle extraction. Plain JSON in and out of the port, no DB (C1).
import { writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../app/config.ts';
import type { JobContext } from '../../app/module.ts';
import { ProblemError } from '../../app/problem.ts';
import { newId } from '../../shared/ids.ts';
import { type DeliveryKeyframeIndexPayload, JOB_TYPES, KEYFRAME_INDEX_URGENT_PRIORITY } from '../../shared/job-types.ts';
import {
  type DirectStreamPlan,
  PLAN_VERSION,
  type PlanExclusion,
  type PlaybackPlan,
  type ServedSubtitle,
  type SubtitleAvailability,
  type SuspectDimension,
  type TranscodePlan,
} from '../../shared/playback-plan.ts';
import type {
  EventPublisher,
  JobQueuePort,
  StreamBitrate,
  StreamDeliveryPort,
  StreamFailure,
  StreamHandle,
  StreamRef,
  StreamStartResult,
  StreamStatus,
  StreamStopReason,
} from '../../shared/ports.ts';
import { progressiveMimeType, servedAudioBps } from './codecs.ts';
import { directStreamArgs, OUTPUT_TS_OFFSET_MS } from './ffmpeg-args.ts';
import { buildGrid, segmentAt, type SegmentGrid } from './grid.ts';
import { HlsStream, ScratchQuota } from './hls-stream.ts';
import { buildKeyframeIndex, IndexBuildError, KeyframeCache, type KeyframeIndex } from './keyframe-index.ts';
import { resolveMediaFile } from './media-file.ts';
import { mediaPlaylist, multivariantPlaylist, videoRange } from './playlist.ts';
import type { DeliveryProbe } from './probe.ts';
import type { Spawn } from './process.ts';
import { fingerprint, outputKey } from './subtitle-cache.ts';
import { createSubtitleExtractor, type ExtractFile, type ExtractionLookup, type ExtractorDeps, type ExtractTarget } from './subtitle-extract.ts';
import { BITMAP_SUBTITLE_CODECS } from './subtitle-format.ts';
import { extractTarget, sidecarToAss, subtitleLocators, type TextSidecarFormat } from './subtitles.ts';
import { TokenTable } from './tokens.ts';
import { type BurnSource, forcedKeyframeList, TRANSCODE_EARLY_MS, transcodeArgs, transcodeBlame, transcodeGrid, transcodeLateMs, transcodeVideoBitrate } from './transcode-args.ts';

export const MEDIA_BASE = '/video/media/s';
/** STREAM_PREPARING: advisory retry delay while the slow probe builds the index. */
export const PREPARING_RETRY_MS = 5000;
/** Consecutive start timeouts of the same file and stream shape before STREAM_FAILED (M3). */
export const START_TIMEOUTS_MAX = 2;
/** delivery.keyframe_index attempts (index.ts registers the job with it). */
export const KEYFRAME_JOB_MAX_ATTEMPTS = 3;
/** A text track to burn waits for its ASS extraction; each StartPlayback retry keeps it held this long. */
export const BURN_EXTRACTION_HOLD_MS = 60_000;
/** Largest source the software Transcode takes (doc 04 P2). */
const TRANSCODE_MAX_WIDTH = 1920;
const TRANSCODE_MAX_HEIGHT = 1080;

export interface DeliveryDeps {
  config: Config;
  log: FastifyBaseLogger;
  now: () => number;
  jobs: () => JobQueuePort;
  spawn: Spawn;
  probe: DeliveryProbe;
  /** Domain events (playback.subtitle_ready); a missing publisher only loses the event, never the stream. */
  events?: () => EventPublisher | undefined;
  /** ffmpeg of the subtitle extraction; default spawn. */
  extractSpawn?: Spawn;
  /** Overrides for tests. */
  timings?: { waitMs?: number; startTimeoutMs?: number; killGraceMs?: number };
  extractTimings?: ExtractorDeps['timings'];
  /** A text sidecar to ASS for a burn-in; default sidecarToAss with FFMPEG_PATH. */
  convertSidecar?: (absPath: string, format: TextSidecarFormat, outPath: string, signal?: AbortSignal) => Promise<void>;
}

/** A sidecar text track converted for this stream: one conversion, its result or its failure cached. */
export interface SidecarConversion {
  promise: Promise<Buffer>;
}

/** A live stream. Stopped streams leave only a Tombstone. */
interface StreamRecord {
  streamId: string;
  sessionId: string;
  plan: PlaybackPlan;
  absPath: string;
  /** The file as the extraction knows it; fp is its cache directory (null: a file id the cache cannot name). */
  extract: ExtractFile;
  fp: string | null;
  served: ServedSubtitle[];
  hls: HlsStream | null;
  playlists: { main: string; media: string } | null;
  lastRequestAt: number | null;
  /** Responses being written (file bodies): cut on stop and shutdown. */
  inflight: Set<ServerResponse>;
  sidecars: Map<string, SidecarConversion>;
  /** Serializes this stream's sidecar conversions (one ffmpeg at a time) and cancels them on stop. */
  sidecarQueue: Promise<unknown>;
  abort: AbortController;
}

/** What a stopped stream keeps until its tombstone expires (status() and the 410). */
interface Tombstone {
  streamId: string;
  sessionId: string;
  stoppedAt: number;
  failure: StreamFailure | null;
  lastRequestAt: number | null;
}

const KeyframePayload = z.object({
  fileId: z.string().min(1),
  location: z.object({ rootName: z.string().min(1), relPath: z.string().min(1) }),
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  container: z.string(),
  videoStreamIndex: z.number().int().nonnegative().nullable().optional(),
});

/** Errors of the file itself (gone, unreadable, busy): the media is unavailable, not the stream broken. */
const isFileError = (err: unknown): boolean =>
  err instanceof Error && ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOTDIR', 'ELOOP', 'EMFILE', 'ENFILE'].includes((err as NodeJS.ErrnoException).code ?? '');

export function createDelivery(deps: DeliveryDeps) {
  const { config, log, now } = deps;
  const tokens = new TokenTable(now, config.DELIVERY_TOMBSTONE_TTL_S * 1000);
  const streams = new Map<string, StreamRecord>();
  const tombstones = new Map<string, Tombstone>();
  /** Streams whose start is in progress, so shutdown can stop their ffmpeg. */
  const starting = new Set<HlsStream>();
  /** port.start calls in progress: shutdown waits for them, so none spawns or registers after it. */
  const inFlight = new Set<Promise<StreamStartResult>>();
  let shuttingDown = false;
  /**
   * The answer of a start that finds delivery shutting down. The start path checks after each of its awaits,
   * and right before every spawn or register: JS runs the check and what follows it in one go, so a shutdown
   * either sees the stream (in `starting` or `streams`) or the start sees the shutdown.
   */
  const shutDown = (): Exclude<StreamStartResult, { ok: true }> => ({ ok: false, code: 'MEDIA_UNAVAILABLE', detail: 'delivery is shutting down' });
  const cache = new KeyframeCache(config.cacheDir);
  const quota = new ScratchQuota(config.SCRATCH_MAX_BYTES);
  const scratchRoot = join(config.scratchDir, 'delivery');
  const ttlMs = config.DELIVERY_TOMBSTONE_TTL_S * 1000;
  const gridOptions = {
    targetMs: config.HLS_SEGMENT_TARGET_S * 1000,
    maxMs: config.HLS_SEGMENT_MAX_S * 1000,
    maxBytes: config.HLS_SEGMENT_MAX_BYTES,
  };

  /**
   * ADR 0003 D12: the event goes out for every active stream on the file, with its session's current id. A
   * track that failed for good is final too (availability complete): its url now answers MEDIA_UNAVAILABLE.
   */
  const publishReady = (fp: string, key: string): void => {
    for (const rec of streams.values()) {
      if (rec.fp !== fp) continue;
      for (const s of rec.served) {
        const t = extractTarget(s);
        if (!t || outputKey(t.streamIndex, t.format) !== key) continue;
        try {
          deps.events?.()?.publish('playback.subtitle_ready', { sessionId: rec.sessionId, trackId: s.trackId, availability: 'complete' });
        } catch (err) {
          log.warn({ streamId: rec.streamId, trackId: s.trackId, err: String(err) }, 'playback.subtitle_ready not published');
        }
      }
    }
  };

  const extractor = createSubtitleExtractor({
    config,
    log,
    now,
    spawn: deps.extractSpawn ?? deps.spawn,
    onComplete: publishReady,
    onFailed: publishReady,
    inUse: () => [...streams.values()].flatMap((r) => (r.fp ? [r.fp] : [])),
    ...(deps.extractTimings ? { timings: deps.extractTimings } : {}),
  });
  const convertSidecar = deps.convertSidecar ?? ((absPath, format, outPath, signal) => sidecarToAss(config.FFMPEG_PATH, absPath, format, outPath, signal));

  const extractFileOf = (plan: PlaybackPlan, absPath: string): ExtractFile => ({
    fileId: plan.file.fileId,
    sizeBytes: plan.file.sizeBytes,
    mtimeMs: plan.file.mtimeMs,
    absPath,
    durationMs: plan.file.durationMs,
    videoStreamIndex: plan.video.source.streamIndex,
  });

  const fingerprintOf = (f: ExtractFile): string | null => {
    try {
      return fingerprint(f);
    } catch (err) {
      log.warn({ fileId: f.fileId, err: String(err) }, 'subtitle extraction impossible for this file id');
      return null;
    }
  };

  const embeddedTargets = (served: readonly ServedSubtitle[]): ExtractTarget[] => served.flatMap((s) => extractTarget(s) ?? []);

  const availabilityOf = (rec: Pick<StreamRecord, 'extract' | 'fp'>, s: ServedSubtitle): SubtitleAvailability => {
    const t = extractTarget(s);
    if (!t) return 'complete';
    return rec.fp ? extractor.availability(rec.extract, t) : 'growing';
  };

  const prune = () => {
    tokens.prune();
    const t = now();
    for (const [id, r] of tombstones) if (t >= r.stoppedAt + ttlMs) tombstones.delete(id);
  };

  const keyframePayload = (plan: PlaybackPlan): DeliveryKeyframeIndexPayload => ({
    fileId: plan.file.fileId,
    location: plan.file.location,
    sizeBytes: plan.file.sizeBytes,
    mtimeMs: plan.file.mtimeMs,
    container: plan.file.container,
    videoStreamIndex: plan.video.source.streamIndex,
  });

  /** Urgent index job; a failed enqueue (DB busy) only delays it: the client's retry enqueues again. */
  const enqueueUrgent = (plan: PlaybackPlan) => {
    const p = keyframePayload(plan);
    try {
      deps.jobs().enqueue({
        type: JOB_TYPES.deliveryKeyframeIndex,
        payload: p,
        priority: KEYFRAME_INDEX_URGENT_PRIORITY,
        idempotencyKey: `keyframes-now:${p.fileId}:v${p.videoStreamIndex}:${p.sizeBytes}:${p.mtimeMs}`,
      });
    } catch (err) {
      log.warn({ fileId: p.fileId, err: String(err) }, 'keyframe index job not enqueued');
    }
  };

  const fallbackBitrate = (plan: PlaybackPlan): number => {
    const d = plan.file.durationMs;
    return d && d > 0 ? Math.round((plan.file.sizeBytes * 8000) / d) : (plan.video.source.bitRate ?? 0);
  };

  /** A plan delivery cannot serve before any ffmpeg ran: a format failure, re-planned with the exclusion. */
  const planFailure = (suspect: SuspectDimension, exclusion: PlanExclusion, message: string): StreamFailure => ({
    at: now(),
    kind: 'no_output',
    class: 'format',
    suspect,
    exclusion,
    exitCode: null,
    signal: null,
    stderrClass: null,
    stderrTail: message.slice(-4096),
    positionMs: null,
    segment: null,
    terminal: true,
  });

  /**
   * The selected served track whose extraction failed recently (within the failure's TTL): a format failure
   * with its exclusion, so the Session Manager re-plans without it at once instead of the client waiting on
   * it. Only the selected one: a failed job fails every track of the file, and each exclusion costs one of
   * the automatic attempts; another failed track answers 503 MEDIA_UNAVAILABLE if it is picked.
   */
  function failedSelectedSubtitle(plan: PlaybackPlan, absPath: string): StreamFailure | null {
    const sel = plan.subtitles.selected;
    const s = sel ? plan.subtitles.served.find((x) => x.trackId === sel.trackId) : undefined;
    const t = s ? extractTarget(s) : null;
    if (!s || !t) return null;
    const file = extractFileOf(plan, absPath);
    if (!fingerprintOf(file) || extractor.lookup(file, t).kind !== 'failed') return null;
    const exclusion: PlanExclusion = { dimension: 'subtitle', trackId: s.trackId, delivery: s.delivery, fileId: plan.file.fileId, cause: 'server', error: 'no_output' };
    return planFailure('subtitle', exclusion, `subtitle track ${s.trackId}: its extraction failed recently`);
  }

  /** A file this mode cannot serve: the Session Manager re-plans without the mode for it. */
  const indexFailure = (plan: PlaybackPlan, message: string): StreamFailure =>
    planFailure('video', { dimension: 'video', fileId: plan.file.fileId, mode: plan.mode, cause: 'server', error: 'no_output' }, message);

  /** Consecutive start timeouts per file and stream shape (M3); a successful start clears its entry. */
  const startTimeouts = new Map<string, number>();
  const timeoutKey = (plan: PlaybackPlan): string =>
    JSON.stringify([plan.file.fileId, plan.file.sizeBytes, plan.file.mtimeMs, plan.mode, plan.audio?.source.streamIndex ?? null, plan.audio?.action ?? null]);

  /**
   * A start that failed for a reason of the server, not of the plan, is not a terminal no_output: scratch
   * or ffmpeg missing is MEDIA_UNAVAILABLE, a first segment not produced in time (no exit seen: overload)
   * is STREAM_PREPARING, so the client retries and the Session Manager does not exclude the file. The
   * same start timing out START_TIMEOUTS_MAX times in a row is STREAM_FAILED: an ffmpeg that hangs
   * before its init must not prepare forever.
   */
  const startFailure = (plan: PlaybackPlan, failure: StreamFailure, spawnFailed: boolean): Exclude<StreamStartResult, { ok: true }> => {
    if (failure.kind === 'io_error') return { ok: false, code: 'MEDIA_UNAVAILABLE', detail: `stream scratch: ${failure.stderrTail.trim().split('\n').at(-1) ?? 'io error'}` };
    if (spawnFailed) return { ok: false, code: 'MEDIA_UNAVAILABLE', detail: 'ffmpeg is not available' };
    if (failure.kind === 'no_output' && failure.exitCode === null && failure.signal === null) {
      const key = timeoutKey(plan);
      const n = (startTimeouts.get(key) ?? 0) + 1;
      startTimeouts.delete(key);
      if (n < START_TIMEOUTS_MAX) {
        // Bounded: the oldest entry goes first.
        if (startTimeouts.size >= 1000) startTimeouts.delete(startTimeouts.keys().next().value!);
        startTimeouts.set(key, n);
        return { ok: false, code: 'STREAM_PREPARING', retryAfterMs: PREPARING_RETRY_MS };
      }
      return { ok: false, code: 'STREAM_FAILED', failure: { ...failure, class: 'stream', suspect: 'unknown', exclusion: null, terminal: true } };
    }
    return { ok: false, code: 'STREAM_FAILED', failure };
  };

  type IndexOutcome = { index: KeyframeIndex } | { result: Exclude<StreamStartResult, { ok: true }> };

  async function indexFor(plan: DirectStreamPlan, absPath: string): Promise<IndexOutcome> {
    const stamp = { fileId: plan.file.fileId, sizeBytes: plan.file.sizeBytes, mtimeMs: plan.file.mtimeMs };
    const videoIndex = plan.video.source.streamIndex;
    const cached = await cache.get(stamp, videoIndex);
    if (cached) return { index: cached };
    const failed = await cache.getFailure(stamp, videoIndex, now());
    if (failed) return { result: { ok: false, code: 'STREAM_FAILED', failure: indexFailure(plan, `keyframe index: ${failed.reason}`) } };
    if (shuttingDown) return { result: shutDown() };
    // ADR 0003 D8: a missing index is built now from the Cues; the slow probe only runs as a job.
    try {
      const built = await buildKeyframeIndex(
        // The shutdown signal: a timeline probe in progress does not hold the shutdown.
        { ...stamp, absPath, container: plan.file.container, videoStreamIndex: videoIndex, allowProbe: false, targetMs: gridOptions.targetMs, maxGapMs: gridOptions.maxMs, now, signal: probeAbort.signal },
        deps.probe,
      );
      if (shuttingDown) return { result: shutDown() };
      if (!built.ok) {
        if (built.advice) log.warn({ fileId: plan.file.fileId, advice: built.advice }, 'keyframe index needs the slow probe');
        enqueueUrgent(plan);
        return { result: { ok: false, code: 'STREAM_PREPARING', retryAfterMs: PREPARING_RETRY_MS } };
      }
      if (built.index.advice) log.warn({ fileId: plan.file.fileId, advice: built.index.advice }, 'keyframe index');
      await cache.put(built.index).catch((err: unknown) => log.warn({ fileId: plan.file.fileId, err: String(err) }, 'keyframe index not cached'));
      return { index: built.index };
    } catch (err) {
      // Aborted by the shutdown: nothing to record, no job to enqueue.
      if (shuttingDown) return { result: shutDown() };
      if (err instanceof IndexBuildError) {
        await cache.putFailure(stamp, videoIndex, err.message, now(), true).catch(() => {});
        return { result: { ok: false, code: 'STREAM_FAILED', failure: indexFailure(plan, `keyframe index: ${err.message}`) } };
      }
      if (isFileError(err)) return { result: { ok: false, code: 'MEDIA_UNAVAILABLE', detail: `file not readable: ${(err as NodeJS.ErrnoException).code}` } };
      // ffprobe timed out or failed: transient, the job retries it.
      log.warn({ fileId: plan.file.fileId, err: String(err) }, 'keyframe index not built now');
      enqueueUrgent(plan);
      return { result: { ok: false, code: 'STREAM_PREPARING', retryAfterMs: PREPARING_RETRY_MS } };
    }
  }

  async function startDirectStream(plan: DirectStreamPlan, sessionId: string, absPath: string): Promise<StreamStartResult> {
    const r = await indexFor(plan, absPath);
    if (shuttingDown) return shutDown();
    if ('result' in r) return r.result;
    const index = r.index;
    let grid: SegmentGrid;
    try {
      grid = buildGrid({ times: index.times, positions: index.positions, durationMs: index.durationMs, sizeBytes: plan.file.sizeBytes, dataEndBytes: index.dataEndBytes }, gridOptions);
    } catch (err) {
      log.warn({ fileId: plan.file.fileId, err: String(err) }, 'keyframe index unusable');
      return { ok: false, code: 'STREAM_FAILED', failure: indexFailure(plan, `segment grid: ${String(err)}`) };
    }
    const streamId = newId();
    const hls = new HlsStream({
      streamId,
      fileId: plan.file.fileId,
      dir: join(scratchRoot, streamId),
      grid,
      keyframeTimes: index.times,
      preRoll: true,
      argsFor: (seek) => directStreamArgs(plan, absPath, seek),
      audio: plan.audio,
      ...hlsCommon(),
    });
    const started = await startHls(plan, hls, grid);
    if (!started.ok) return started.result;
    if (shuttingDown) return discard(hls);
    const out = started.out;
    const fallback = fallbackBitrate(plan);
    const bitrate: StreamBitrate = {
      peakBps: grid.peakBps ?? fallback,
      averageBps: grid.averageBps ?? fallback,
      audioBps: plan.audio ? servedAudioBps(plan.audio.source, plan.audio.action) : 0,
    };
    const v = plan.video.source;
    const playlists = {
      main: multivariantPlaylist({
        peakBps: bitrate.peakBps,
        averageBps: bitrate.averageBps,
        codecs: out.codecs,
        width: v.width,
        height: v.height,
        frameRate: v.frameRate,
        videoRange: videoRange(v.hdr, v.hdrFallback),
        // The Cues do not say whether a keyframe is an IDR, so a copied stream never claims it (D2).
        independentSegments: false,
      }),
      media: mediaPlaylist(grid, { independentSegments: false }),
    };
    return register(plan, sessionId, absPath, streamId, hls, playlists, out.mimeType, bitrate);
  }

  const hlsCommon = () => ({
    spawn: deps.spawn,
    quota,
    log,
    now,
    aheadMs: config.DELIVERY_AHEAD_S * 1000,
    behindMs: config.DELIVERY_BEHIND_S * 1000,
    idleKillMs: config.DELIVERY_IDLE_KILL_S * 1000,
    ...deps.timings,
  });

  type HlsStart = { ok: true; out: { mimeType: string; codecs: string[] } } | { ok: false; result: Exclude<StreamStartResult, { ok: true }> };

  /** A started stream that shutdown did not see (it began after startHls returned): stopped, never registered. */
  async function discard(hls: HlsStream): Promise<Exclude<StreamStartResult, { ok: true }>> {
    await hls.stop('discard');
    return shutDown();
  }

  /** Starts the first run at the plan's start position and waits for its checked init segment. */
  async function startHls(plan: PlaybackPlan, hls: HlsStream, grid: SegmentGrid): Promise<HlsStart> {
    if (shuttingDown) {
      // Never started, but its directory may hold a converted sidecar (burnFor).
      await hls.stop('discard');
      return { ok: false, result: shutDown() };
    }
    starting.add(hls);
    let out;
    try {
      out = await hls.start(segmentAt(grid, plan.startPositionMs));
    } catch (err) {
      await hls.stop('discard');
      if (isFileError(err)) return { ok: false, result: { ok: false, code: 'MEDIA_UNAVAILABLE', detail: `scratch not writable: ${(err as NodeJS.ErrnoException).code}` } };
      throw err;
    } finally {
      starting.delete(hls);
    }
    if (shuttingDown) {
      await hls.stop('discard');
      return { ok: false, result: shutDown() };
    }
    if (!out.ok) {
      await hls.stop('discard');
      return { ok: false, result: startFailure(plan, out.failure, out.spawnFailed) };
    }
    startTimeouts.delete(timeoutKey(plan));
    return { ok: true, out };
  }

  type BurnOutcome = { burn: BurnSource | null } | { result: Exclude<StreamStartResult, { ok: true }> };

  /**
   * The selected track to burn (doc 04 §4.4). An embedded image track is overlaid from the same input; text
   * goes through libass, which reads its whole file when the filter starts: an embedded track is first
   * extracted to ASS (one blocking pass from 0, no read cap, in its own slot so it never waits behind a capped
   * extraction), and the start answers STREAM_PREPARING until it is complete. The served tracks are acquired
   * by the stream once it runs, not here: holding them for a start that waits would keep their extraction
   * alive for nobody. A text sidecar is converted to ASS into the stream's scratch `dir` first (forced
   * demuxer, charset from its bytes), never handed to libass as is. A sidecar image track (.sup) is not
   * burned: sub2video needs the subtitles in the video's input (the engine does not plan it).
   */
  async function burnFor(plan: TranscodePlan, absPath: string, dir: string): Promise<BurnOutcome> {
    const sel = plan.subtitles.selected;
    if (!sel || sel.delivery !== 'burned') return { burn: null };
    const exclusion: PlanExclusion = { dimension: 'subtitle', trackId: sel.trackId, delivery: 'burned', fileId: plan.file.fileId, cause: 'server', error: 'no_output' };
    const cannot = (why: string): BurnOutcome => ({ result: { ok: false, code: 'STREAM_FAILED', failure: planFailure('subtitle', exclusion, why) } });
    const src = sel.source;
    if (src.kind === 'embedded') {
      if (BITMAP_SUBTITLE_CODECS.has(sel.codec)) return { burn: { kind: 'bitmap', trackId: sel.trackId, streamIndex: src.streamIndex } };
      const file = extractFileOf(plan, absPath);
      if (!fingerprintOf(file)) return cannot('burn-in: the track cannot be extracted');
      const target: ExtractTarget = { streamIndex: src.streamIndex, format: 'ass' };
      const found = extractor.lookup(file, target);
      if (found.kind === 'complete') return { burn: { kind: 'text', trackId: sel.trackId, path: found.path } };
      if (found.kind === 'failed') return cannot('burn-in: the subtitle extraction failed');
      extractor.acquire(`burn:${plan.file.fileId}:${sel.trackId}`, file, [target], 0, {
        blocking: true,
        ttlMs: BURN_EXTRACTION_HOLD_MS,
      });
      return { result: { ok: false, code: 'STREAM_PREPARING', retryAfterMs: PREPARING_RETRY_MS } };
    }
    if (src.format === 'sup') return cannot('burn-in of a sidecar image track is not supported');
    const f = await resolveMediaFile(config.LIBRARY_ROOTS, { rootName: plan.file.location.rootName, relPath: src.relPath });
    if (!f.ok) return cannot(`burn-in: sidecar ${f.detail}`);
    const ass = join(dir, 'burn-sidecar.ass');
    try {
      await mkdir(dir, { recursive: true });
      // The shutdown signal: a conversion in progress does not hold the shutdown.
      await convertSidecar(f.absPath, src.format, ass, probeAbort.signal);
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return cannot(`burn-in: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { burn: { kind: 'text', trackId: sel.trackId, path: ass } };
  }

  /** Video durations of the synthetic grids, per file content (fingerprint): a new stream of the same file probes nothing. */
  const videoDurations = new Map<string, number>();
  /** The probe in flight per key: starts of the same file at once share it. */
  const durationProbes = new Map<string, Promise<number | null>>();
  /** Aborted by shutdown(): the probes of the starts in progress (a shared probe has no single start to follow). */
  const probeAbort = new AbortController();

  /**
   * Zero-based duration for the synthetic grid: where the video stream ends, which may be seconds before the
   * container's end (the audio runs on); a grid past the video would ask for segments that never come. The
   * container's duration (the plan's, else ffprobe's) when the stream's end cannot be read, or when a probe
   * fails for another reason than the file (logged, not cached). Throws on a file error, or when a probe
   * failed and the plan has no duration either.
   */
  function transcodeDuration(plan: TranscodePlan, absPath: string): Promise<number | null> {
    const key = `${plan.file.fileId}:${plan.file.sizeBytes}:${plan.file.mtimeMs}:${plan.video.source.streamIndex}`;
    const known = videoDurations.get(key);
    if (known !== undefined) return Promise.resolve(known);
    let p = durationProbes.get(key);
    if (!p) {
      p = probeDuration(plan, absPath, key).finally(() => durationProbes.delete(key));
      durationProbes.set(key, p);
    }
    return p;
  }

  async function probeDuration(plan: TranscodePlan, absPath: string, key: string): Promise<number | null> {
    const signal = probeAbort.signal;
    const planMs = plan.file.durationMs && plan.file.durationMs > 0 ? plan.file.durationMs : null;
    /** The container's duration after a failed probe; the error again when that is a file error, or no duration is known. */
    const fallback = (what: string, err: unknown, containerMs: number | null): number => {
      if (isFileError(err) || signal.aborted || containerMs === null) throw err;
      log.warn({ fileId: plan.file.fileId, err: String(err) }, `${what} probe failed: the grid ends with the container`);
      return containerMs;
    };
    let t;
    try {
      t = await deps.probe.timeline(absPath, signal);
    } catch (err) {
      return fallback('timeline', err, planMs);
    }
    const raw = t.rawDurationMs === null ? null : plan.file.container === 'matroska' || plan.file.container === 'webm' ? t.rawDurationMs - t.startTimeMs : t.rawDurationMs;
    const containerMs = planMs ?? (raw !== null && raw > 0 ? raw : null);
    let end;
    try {
      end = await deps.probe.streamEndMs(absPath, plan.video.source.streamIndex, containerMs === null ? null : t.startTimeMs + containerMs, signal);
    } catch (err) {
      return fallback('video end', err, containerMs);
    }
    const videoMs = end === null ? null : end - t.startTimeMs;
    // Never past the container: a stray late packet must not stretch the grid.
    const d = videoMs !== null && videoMs > 0 ? (containerMs === null ? videoMs : Math.min(videoMs, containerMs)) : containerMs;
    if (d === null) return null;
    if (videoDurations.size >= 256) videoDurations.delete(videoDurations.keys().next().value!);
    videoDurations.set(key, d);
    return d;
  }

  /**
   * Software Transcode (doc 04 P2, ADR 0003 D3): a synthetic grid ending with the video stream, IDRs forced on
   * it, a new encode from Bₖ₋₁ on a seek (its first segment dropped). Admission (MAX_TRANSCODES) is the
   * Session Manager's (P4).
   */
  async function startTranscode(plan: TranscodePlan, sessionId: string, absPath: string): Promise<StreamStartResult> {
    const src = plan.video.source;
    if (src.width > TRANSCODE_MAX_WIDTH || src.height > TRANSCODE_MAX_HEIGHT) {
      return { ok: false, code: 'STREAM_FAILED', failure: indexFailure(plan, `source ${src.width}x${src.height} is above 1080p: no software Transcode (P2)`) };
    }
    let durationMs: number | null;
    try {
      durationMs = await transcodeDuration(plan, absPath);
    } catch (err) {
      if (shuttingDown) return shutDown();
      if (isFileError(err)) return { ok: false, code: 'MEDIA_UNAVAILABLE', detail: `file not readable: ${(err as NodeJS.ErrnoException).code}` };
      log.warn({ fileId: plan.file.fileId, err: String(err) }, 'duration probe failed');
      return { ok: false, code: 'STREAM_PREPARING', retryAfterMs: PREPARING_RETRY_MS };
    }
    // Before burnFor: it may acquire an extraction, and the extractor stops with the shutdown.
    if (shuttingDown) return shutDown();
    let grid: SegmentGrid;
    try {
      if (durationMs === null) throw new Error('duration unknown');
      grid = transcodeGrid(durationMs, gridOptions);
    } catch (err) {
      return { ok: false, code: 'STREAM_FAILED', failure: indexFailure(plan, `segment grid: ${String(err)}`) };
    }
    const streamId = newId();
    const dir = join(scratchRoot, streamId);
    const b = await burnFor(plan, absPath, dir);
    if (shuttingDown) {
      // A converted sidecar may sit in the stream's directory (the shutdown's rm may have run before it).
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return shutDown();
    }
    if ('result' in b) return b.result;
    const burn = b.burn;
    const hls = new HlsStream({
      streamId,
      fileId: plan.file.fileId,
      dir,
      grid,
      keyframeTimes: [],
      preRoll: 'segment',
      mode: 'transcode',
      earlyMs: TRANSCODE_EARLY_MS,
      lateMs: transcodeLateMs(src.frameRate),
      argsFor: (seek) => {
        // The run's first boundary (the segment before the one asked for): its keyframe list starts there.
        const k = seek ? segmentAt(grid, seek.keyframeMs) : 0;
        const keyframeFile = join(dir, `keyframes-${k}.txt`);
        // A few bytes per segment, once per run, on the scratch volume; ffmpeg reads it (-/force_key_frames).
        writeFileSync(keyframeFile, forcedKeyframeList(grid, k));
        return transcodeArgs({ plan, absPath, seek, keyframeFile, burn });
      },
      audio: plan.audio,
      blame: transcodeBlame(plan, burn),
      ...hlsCommon(),
    });
    const started = await startHls(plan, hls, grid);
    if (!started.ok) return started.result;
    if (shuttingDown) return discard(hls);
    const out = started.out;
    const audioBps = plan.audio ? servedAudioBps(plan.audio.source, plan.audio.action) : 0;
    const video = transcodeVideoBitrate(plan.video.maxBitrateBps, gridOptions.targetMs);
    const bitrate: StreamBitrate = { peakBps: video.peakBps + audioBps, averageBps: video.averageBps + audioBps, audioBps };
    const playlists = {
      main: multivariantPlaylist({
        peakBps: bitrate.peakBps,
        averageBps: bitrate.averageBps,
        codecs: out.codecs,
        width: plan.video.width,
        height: plan.video.height,
        frameRate: src.frameRate,
        videoRange: plan.video.toneMap === 'to_sdr' ? 'SDR' : videoRange(src.hdr, src.hdrFallback),
        // Every boundary is an IDR forced by the encoder (-forced-idr).
        independentSegments: true,
      }),
      media: mediaPlaylist(grid, { independentSegments: true }),
    };
    return register(plan, sessionId, absPath, streamId, hls, playlists, out.mimeType, bitrate);
  }

  function register(
    plan: PlaybackPlan,
    sessionId: string,
    absPath: string,
    streamId: string,
    hls: HlsStream | null,
    playlists: StreamRecord['playlists'],
    mimeType: string,
    bitrate: StreamBitrate,
  ): StreamStartResult {
    const token = tokens.issue(streamId);
    const extract = extractFileOf(plan, absPath);
    const rec: StreamRecord = {
      streamId,
      sessionId,
      plan,
      absPath,
      extract,
      fp: fingerprintOf(extract),
      served: plan.subtitles.served,
      hls,
      playlists,
      lastRequestAt: null,
      inflight: new Set(),
      sidecars: new Map(),
      sidecarQueue: Promise.resolve(),
      abort: new AbortController(),
    };
    streams.set(streamId, rec);
    // ADR 0003 D12: the first stream of a file with embedded served tracks starts their extraction; later
    // streams share it. Held by the stream until it stops.
    const targets = embeddedTargets(rec.served);
    if (rec.fp && targets.length > 0) extractor.acquire(streamId, extract, targets, plan.startPositionMs);
    const base = `${MEDIA_BASE}/${token}`;
    const handle: StreamHandle = {
      streamId,
      sessionId,
      mode: plan.mode,
      protocol: plan.protocol,
      locators: {
        stream: plan.protocol === 'progressive' ? `${base}/file` : `${base}/hls/main.m3u8`,
        subtitles: subtitleLocators(plan.subtitles.served, base, (s) => availabilityOf(rec, s)),
      },
      mimeType,
      bitrate,
      mediaTimestampOffsetMs: plan.protocol === 'hls-fmp4' ? OUTPUT_TS_OFFSET_MS : 0,
      startedAt: now(),
    };
    log.info({ streamId, sessionId, mode: plan.mode, fileId: plan.file.fileId }, 'stream started');
    return { ok: true, handle };
  }

  async function stopRecord(rec: StreamRecord, reason: StreamStopReason): Promise<void> {
    streams.delete(rec.streamId);
    tokens.tombstone(rec.streamId);
    tombstones.set(rec.streamId, {
      streamId: rec.streamId,
      sessionId: rec.sessionId,
      stoppedAt: now(),
      failure: rec.hls?.failure ?? null,
      lastRequestAt: rec.hls?.lastRequestAt ?? rec.lastRequestAt,
    });
    rec.abort.abort();
    // The extraction is per file: it goes on for the other streams, or stops after a grace period.
    extractor.release(rec.streamId);
    // Cut the bodies being sent: the file handle closes, and a paused client cannot hold the stream.
    for (const res of rec.inflight) res.destroy();
    rec.inflight.clear();
    rec.sidecars.clear();
    // A re-plan or an expiry throws the output away: SIGKILL at once (ADR 0003 D7).
    const mode = reason === 'replanned' || reason === 'expired' ? 'discard' : 'graceful';
    await rec.hls?.stop(mode);
    log.info({ streamId: rec.streamId, reason }, 'stream stopped');
  }

  async function startStream(plan: PlaybackPlan, sessionId: string): Promise<StreamStartResult> {
    prune();
    const file = await resolveMediaFile(config.LIBRARY_ROOTS, plan.file.location, { sizeBytes: plan.file.sizeBytes, mtimeMs: plan.file.mtimeMs });
    if (shuttingDown) return shutDown();
    if (!file.ok) return { ok: false, code: 'MEDIA_UNAVAILABLE', detail: file.detail };
    const failedSub = failedSelectedSubtitle(plan, file.absPath);
    if (failedSub) return { ok: false, code: 'STREAM_FAILED', failure: failedSub };
    switch (plan.mode) {
      case 'direct_play': {
        const d = plan.file.durationMs;
        const avg = d && d > 0 ? Math.round((file.sizeBytes * 8000) / d) : (plan.video.source.bitRate ?? 0);
        const bitrate: StreamBitrate = { peakBps: avg, averageBps: avg, audioBps: plan.audio ? servedAudioBps(plan.audio.source, plan.audio.action) : 0 };
        const mime = progressiveMimeType(plan.file.container, plan.video.source, plan.audio?.source ?? null);
        return register(plan, sessionId, file.absPath, newId(), null, null, mime, bitrate);
      }
      case 'direct_stream':
        return startDirectStream(plan, sessionId, file.absPath);
      case 'transcode':
        return startTranscode(plan, sessionId, file.absPath);
    }
  }

  const port: StreamDeliveryPort = {
    async start(plan, sessionId) {
      const version: unknown = plan.planVersion;
      if (version !== PLAN_VERSION) throw new Error(`plan version ${String(version)} is not ${PLAN_VERSION}`);
      if (shuttingDown) return shutDown();
      const p = startStream(plan, sessionId);
      inFlight.add(p);
      try {
        return await p;
      } finally {
        inFlight.delete(p);
      }
    },
    async stop(ref: StreamRef, reason: StreamStopReason) {
      const rec = streams.get(ref.streamId);
      if (rec) await stopRecord(rec, reason);
    },
    async status(ref: StreamRef): Promise<StreamStatus | null> {
      prune();
      const rec = streams.get(ref.streamId);
      if (rec) {
        const failed = rec.hls?.terminal ?? false;
        return {
          streamId: rec.streamId,
          sessionId: rec.sessionId,
          state: failed ? 'failed' : 'active',
          failure: rec.hls?.failure ?? null,
          subtitles: rec.served.map((s) => ({ trackId: s.trackId, availability: availabilityOf(rec, s) })),
          lastRequestAt: rec.hls?.lastRequestAt ?? rec.lastRequestAt,
        };
      }
      const t = tombstones.get(ref.streamId);
      return t ? { streamId: t.streamId, sessionId: t.sessionId, state: 'stopped', failure: t.failure, subtitles: [], lastRequestAt: t.lastRequestAt } : null;
    },
  };

  /** Data-plane token check: 404 for an unknown token, 410 for a tombstone (ADR 0003 D10). */
  function resolveToken(token: string): StreamRecord {
    const hit = tokens.lookup(token);
    if (hit.state === 'unknown') throw new ProblemError('NOT_FOUND', 'Unknown session resource');
    const rec = streams.get(hit.streamId);
    if (hit.state === 'gone' || !rec) throw new ProblemError('SESSION_EXPIRED', 'Playback session closed or re-planned');
    return rec;
  }

  /** Registers a response body being sent for a stream, until it finishes or is cut. */
  function track(rec: StreamRecord, res: ServerResponse): void {
    if (!streams.has(rec.streamId)) {
      res.destroy();
      return;
    }
    rec.inflight.add(res);
    res.once('close', () => rec.inflight.delete(res));
  }

  async function keyframeJob(payload: unknown, ctx: JobContext): Promise<void> {
    const p = KeyframePayload.parse(payload);
    const stamp = { fileId: p.fileId, sizeBytes: p.sizeBytes, mtimeMs: p.mtimeMs };
    const file = await resolveMediaFile(config.LIBRARY_ROOTS, p.location, { sizeBytes: p.sizeBytes, mtimeMs: p.mtimeMs });
    if (!file.ok) {
      // A changed file is probed again by the analyzer, which enqueues a job with the new stamp.
      ctx.log.info({ fileId: p.fileId, detail: file.detail }, 'keyframe index skipped');
      return;
    }
    // The same video-stream rule as start: the payload's stream, or the first video stream.
    let videoIndex = p.videoStreamIndex ?? null;
    try {
      const timeline = await deps.probe.timeline(file.absPath, ctx.signal);
      videoIndex ??= timeline.videoStreamIndex;
      if (videoIndex === null) {
        ctx.log.info({ fileId: p.fileId }, 'keyframe index skipped: no video stream');
        return;
      }
      if (await cache.get(stamp, videoIndex)) return;
      const built = await buildKeyframeIndex(
        { ...stamp, absPath: file.absPath, container: p.container, videoStreamIndex: videoIndex, allowProbe: true, targetMs: gridOptions.targetMs, maxGapMs: gridOptions.maxMs, signal: ctx.signal, now, timeline },
        deps.probe,
      );
      if (!built.ok) throw new Error('keyframe index not built');
      if (built.index.advice) ctx.log.warn({ fileId: p.fileId, advice: built.index.advice }, 'keyframe index');
      await cache.put(built.index);
      ctx.log.info({ fileId: p.fileId, source: built.index.source, keyframes: built.index.times.length }, 'keyframe index built');
    } catch (err) {
      // A file without a usable index is recorded for good; the last attempt of anything else (timeout,
      // I/O) for TRANSIENT_FAILURE_TTL_MS. An aborted job (shutdown) records nothing.
      const permanent = err instanceof IndexBuildError;
      if (videoIndex !== null && !ctx.signal.aborted && (permanent || ctx.attempt >= KEYFRAME_JOB_MAX_ATTEMPTS)) {
        await cache.putFailure(stamp, videoIndex, String(err instanceof Error ? err.message : err), now(), permanent);
        ctx.log.warn({ fileId: p.fileId, err: String(err), permanent }, 'keyframe index failed');
      }
      if (permanent) return;
      throw err;
    }
  }

  /**
   * Where an embedded served track is (handlers): cached, growing, the first pass only, queued or failed.
   * A track no extraction knows (a failure past its TTL, a cache file deleted by hand) is extracted again.
   */
  function subtitle(rec: StreamRecord, s: ServedSubtitle): ExtractionLookup {
    const t = extractTarget(s);
    if (!t || !rec.fp) return { kind: 'failed' };
    const found = extractor.lookup(rec.extract, t);
    if (found.kind !== 'absent') return found;
    if (streams.has(rec.streamId)) extractor.acquire(rec.streamId, rec.extract, [t], rec.plan.startPositionMs);
    return extractor.lookup(rec.extract, t);
  }

  /** A cached file that vanished between the lookup and the read. */
  function subtitleMissing(rec: StreamRecord, s: ServedSubtitle): void {
    const t = extractTarget(s);
    if (t && rec.fp) extractor.forget(rec.extract, t);
  }

  return {
    port,
    resolveToken,
    track,
    keyframeJob,
    cache,
    extractor,
    subtitle,
    subtitleMissing,
    /** Clears the scratch left by a previous process (ADR 0006: emptied at startup) and the extraction leftovers. */
    async clearScratch(): Promise<void> {
      await rm(scratchRoot, { recursive: true, force: true, maxRetries: 3 });
      await extractor.init();
    },
    /** Stops every stream, the starts in progress included, and every extraction; later starts are refused. */
    async shutdown(): Promise<void> {
      shuttingDown = true;
      probeAbort.abort();
      await Promise.allSettled([...[...streams.values()].map((r) => stopRecord(r, 'shutdown')), ...[...starting].map((s) => s.stop('discard'))]);
      // The other starts end at their next check (aborted probes and conversions return at once): each
      // answers MEDIA_UNAVAILABLE, and none spawns, registers or writes to the scratch after the rm below.
      await Promise.allSettled([...inFlight]);
      await extractor.shutdown();
      await rm(scratchRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    },
    /** Tests and diagnostics. */
    streamOf: (streamId: string): StreamRecord | undefined => streams.get(streamId),
    get quotaUsed(): number {
      return quota.used;
    },
  };
}

export type Delivery = ReturnType<typeof createDelivery>;
export type { StreamRecord };
