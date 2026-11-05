// Stream Delivery (doc 02 §3.11, ADR 0003 D9): the StreamDeliveryPort, the token table, the streams and
// the keyframe index job. Plain JSON in and out of the port, no DB (C1).
import type { ServerResponse } from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../app/config.ts';
import type { JobContext } from '../../app/module.ts';
import { ProblemError } from '../../app/problem.ts';
import { newId } from '../../shared/ids.ts';
import { type DeliveryKeyframeIndexPayload, JOB_TYPES, KEYFRAME_INDEX_URGENT_PRIORITY } from '../../shared/job-types.ts';
import { type DirectStreamPlan, PLAN_VERSION, type PlaybackPlan, type ServedSubtitle } from '../../shared/playback-plan.ts';
import type {
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
import { initialAvailability, subtitleLocators } from './subtitles.ts';
import { TokenTable } from './tokens.ts';

export const MEDIA_BASE = '/video/media/s';
/** STREAM_PREPARING: advisory retry delay while the slow probe builds the index. */
export const PREPARING_RETRY_MS = 5000;
/** Consecutive start timeouts of the same file and stream shape before STREAM_FAILED (M3). */
export const START_TIMEOUTS_MAX = 2;
/** delivery.keyframe_index attempts (index.ts registers the job with it). */
export const KEYFRAME_JOB_MAX_ATTEMPTS = 3;

export interface DeliveryDeps {
  config: Config;
  log: FastifyBaseLogger;
  now: () => number;
  jobs: () => JobQueuePort;
  spawn: Spawn;
  probe: DeliveryProbe;
  /** Overrides for tests. */
  timings?: { waitMs?: number; startTimeoutMs?: number; killGraceMs?: number };
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
  let shuttingDown = false;
  const cache = new KeyframeCache(config.cacheDir);
  const quota = new ScratchQuota(config.SCRATCH_MAX_BYTES);
  const scratchRoot = join(config.scratchDir, 'delivery');
  const ttlMs = config.DELIVERY_TOMBSTONE_TTL_S * 1000;
  const gridOptions = {
    targetMs: config.HLS_SEGMENT_TARGET_S * 1000,
    maxMs: config.HLS_SEGMENT_MAX_S * 1000,
    maxBytes: config.HLS_SEGMENT_MAX_BYTES,
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

  /** A file Direct Stream cannot serve: the Session Manager re-plans without Direct Stream for it. */
  const indexFailure = (plan: PlaybackPlan, message: string): StreamFailure => ({
    at: now(),
    kind: 'no_output',
    class: 'format',
    suspect: 'video',
    exclusion: { dimension: 'video', fileId: plan.file.fileId, mode: 'direct_stream', cause: 'server', error: 'no_output' },
    exitCode: null,
    signal: null,
    stderrClass: null,
    stderrTail: message.slice(-4096),
    positionMs: null,
    segment: null,
    terminal: true,
  });

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
    // ADR 0003 D8: a missing index is built now from the Cues; the slow probe only runs as a job.
    try {
      const built = await buildKeyframeIndex(
        { ...stamp, absPath, container: plan.file.container, videoStreamIndex: videoIndex, allowProbe: false, targetMs: gridOptions.targetMs, maxGapMs: gridOptions.maxMs, now },
        deps.probe,
      );
      if (!built.ok) {
        if (built.advice) log.warn({ fileId: plan.file.fileId, advice: built.advice }, 'keyframe index needs the slow probe');
        enqueueUrgent(plan);
        return { result: { ok: false, code: 'STREAM_PREPARING', retryAfterMs: PREPARING_RETRY_MS } };
      }
      if (built.index.advice) log.warn({ fileId: plan.file.fileId, advice: built.index.advice }, 'keyframe index');
      await cache.put(built.index).catch((err: unknown) => log.warn({ fileId: plan.file.fileId, err: String(err) }, 'keyframe index not cached'));
      return { index: built.index };
    } catch (err) {
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
      spawn: deps.spawn,
      quota,
      log,
      now,
      aheadMs: config.DELIVERY_AHEAD_S * 1000,
      behindMs: config.DELIVERY_BEHIND_S * 1000,
      idleKillMs: config.DELIVERY_IDLE_KILL_S * 1000,
      ...deps.timings,
    });
    starting.add(hls);
    let out;
    try {
      out = await hls.start(segmentAt(grid, plan.startPositionMs));
    } catch (err) {
      await hls.stop('discard');
      if (isFileError(err)) return { ok: false, code: 'MEDIA_UNAVAILABLE', detail: `scratch not writable: ${(err as NodeJS.ErrnoException).code}` };
      throw err;
    } finally {
      starting.delete(hls);
    }
    if (shuttingDown) {
      await hls.stop('discard');
      return { ok: false, code: 'MEDIA_UNAVAILABLE', detail: 'delivery is shutting down' };
    }
    if (!out.ok) {
      await hls.stop('discard');
      return startFailure(plan, out.failure, out.spawnFailed);
    }
    startTimeouts.delete(timeoutKey(plan));
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
    const rec: StreamRecord = {
      streamId,
      sessionId,
      plan,
      absPath,
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
    const base = `${MEDIA_BASE}/${token}`;
    const handle: StreamHandle = {
      streamId,
      sessionId,
      mode: plan.mode,
      protocol: plan.protocol,
      locators: {
        stream: plan.protocol === 'progressive' ? `${base}/file` : `${base}/hls/main.m3u8`,
        subtitles: subtitleLocators(plan.subtitles.served, base),
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
    // Cut the bodies being sent: the file handle closes, and a paused client cannot hold the stream.
    for (const res of rec.inflight) res.destroy();
    rec.inflight.clear();
    rec.sidecars.clear();
    // A re-plan or an expiry throws the output away: SIGKILL at once (ADR 0003 D7).
    const mode = reason === 'replanned' || reason === 'expired' ? 'discard' : 'graceful';
    await rec.hls?.stop(mode);
    log.info({ streamId: rec.streamId, reason }, 'stream stopped');
  }

  const port: StreamDeliveryPort = {
    async start(plan, sessionId) {
      const version: unknown = plan.planVersion;
      if (version !== PLAN_VERSION) throw new Error(`plan version ${String(version)} is not ${PLAN_VERSION}`);
      if (shuttingDown) return { ok: false, code: 'MEDIA_UNAVAILABLE', detail: 'delivery is shutting down' };
      prune();
      const file = await resolveMediaFile(config.LIBRARY_ROOTS, plan.file.location, { sizeBytes: plan.file.sizeBytes, mtimeMs: plan.file.mtimeMs });
      if (!file.ok) return { ok: false, code: 'MEDIA_UNAVAILABLE', detail: file.detail };
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
          throw new Error('the Transcode tier lands in F1b.4');
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
          subtitles: rec.served.map((s) => ({ trackId: s.trackId, availability: initialAvailability(s) })),
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

  return {
    port,
    resolveToken,
    track,
    keyframeJob,
    cache,
    /** Clears the scratch left by a previous process (ADR 0006: emptied at startup). */
    async clearScratch(): Promise<void> {
      await rm(scratchRoot, { recursive: true, force: true, maxRetries: 3 });
    },
    /** Stops every stream, the starts in progress included; later starts are refused. */
    async shutdown(): Promise<void> {
      shuttingDown = true;
      await Promise.allSettled([...[...streams.values()].map((r) => stopRecord(r, 'shutdown')), ...[...starting].map((s) => s.stop('discard'))]);
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
