// Keyframe index of a file (ADR 0003 D8): Matroska Cues read by the EBML parser (primary), the ffprobe
// seek probe as the fallback for other containers and MKVs without usable Cues. Times are zero-based on
// the original timeline (PTS − start_time). Cached as JSON under
// <cache>/delivery/keyframes/<fileId>.v<videoStreamIndex>.json, valid while size and mtime match; a
// failed build is cached the same way, so a broken file fails fast instead of preparing forever.
// Every declared value (Duration, TimestampScale, CueTime) is sanity-checked: none drives a loop.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { EbmlError, fileByteSource, readMatroskaIndex } from './ebml.ts';
import { type DeliveryProbe, SEEKS_TO_KEYFRAME, type Timeline } from './probe.ts';

export const KEYFRAME_INDEX_VERSION = 2;

/** Diagnostics advice for an MKV without Cues: ffmpeg's own seek is a linear read there too. */
export const NO_CUES_ADVICE = 'MKV senza Cues: seek e riavvii lenti. Rifare il remux con l\'indice (es. mkvmerge)';
export const BAD_CUES_ADVICE = 'Cues dell\'MKV inattendibili (buchi o punti non keyframe): indice ricostruito dal probe. Rifare il remux con mkvmerge';
export const BAD_DURATION_ADVICE = 'Durata dichiarata dal contenitore non plausibile: usata quella dei keyframe';

/** Longest plausible file: anything above is a hostile or corrupt value. */
export const MAX_MEDIA_MS = 7 * 24 * 3600 * 1000;
/** The declared Duration may exceed the last keyframe by at most this much (one long final GOP). */
const MAX_TAIL_MS = 60_000;
/** Probe seeks at most (≈ 55 h at 4 s); the probe also stops at the end of the content. */
const MAX_PROBE_TARGETS = 50_000;
/** Cues denser than this (median gap) are not keyframe-only: most frames would be cue points. */
const MIN_PLAUSIBLE_GOP_MS = 200;

export interface KeyframeIndex {
  version: typeof KEYFRAME_INDEX_VERSION;
  fileId: string;
  sizeBytes: number;
  mtimeMs: number;
  source: 'cues' | 'probe';
  /** True when every keyframe is listed (plausible Cues); the probe knows the keyframes near its seeks. */
  complete: boolean;
  videoStreamIndex: number;
  startTimeMs: number;
  /** Zero-based duration (ms), sanity-checked. */
  durationMs: number;
  /** Zero-based keyframe times (ms), ascending and unique. */
  times: number[];
  /** File offsets (cluster or packet) of the keyframes, null when unknown. */
  positions: (number | null)[];
  /** End of the media data (Cues offset after the Clusters), null when unknown. */
  dataEndBytes: number | null;
  advice: string | null;
  builtAt: number;
}

const IndexJson = z.object({
  version: z.literal(KEYFRAME_INDEX_VERSION),
  fileId: z.string(),
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  source: z.enum(['cues', 'probe']),
  complete: z.boolean(),
  videoStreamIndex: z.number().int(),
  startTimeMs: z.number(),
  durationMs: z.number().positive(),
  times: z.array(z.number()),
  positions: z.array(z.number().nullable()),
  dataEndBytes: z.number().nullable(),
  advice: z.string().nullable(),
  builtAt: z.number(),
});

/** How long a failure that is not IndexBuildError (timeout, I/O, retries used up) answers STREAM_FAILED. */
export const TRANSIENT_FAILURE_TTL_MS = 3600_000;

/**
 * A build that failed for this content: start answers STREAM_FAILED while the stamp is unchanged.
 * permanent: the file has no usable index (IndexBuildError); otherwise the record expires after
 * TRANSIENT_FAILURE_TTL_MS, so a slow disk or a timeout never excludes a file for good.
 */
export interface IndexFailure {
  version: typeof KEYFRAME_INDEX_VERSION;
  fileId: string;
  sizeBytes: number;
  mtimeMs: number;
  videoStreamIndex: number | null;
  reason: string;
  permanent: boolean;
  at: number;
}

const FailureJson = z.object({
  version: z.literal(KEYFRAME_INDEX_VERSION),
  fileId: z.string(),
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  videoStreamIndex: z.number().int().nullable(),
  reason: z.string(),
  permanent: z.boolean(),
  at: z.number(),
});

export interface FileStamp {
  fileId: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** A build failure that retrying cannot fix (malformed or implausible data). */
export class IndexBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexBuildError';
  }
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Sorted, deduplicated (within 1 µs) keyframes; the position kept is the first one seen. */
function normalize(entries: { t: number; pos: number | null }[]): { times: number[]; positions: (number | null)[] } {
  const sorted = entries.filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  const times: number[] = [];
  const positions: (number | null)[] = [];
  for (const e of sorted) {
    const t = round3(e.t);
    if (times.length && Math.abs(times[times.length - 1]! - t) < 0.001) continue;
    times.push(t);
    positions.push(e.pos);
  }
  return { times, positions };
}

function medianGap(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1]!;
}

function maxGap(times: readonly number[], fromZero: boolean): number {
  let m = fromZero && times.length ? times[0]! : 0;
  for (let i = 1; i < times.length; i++) m = Math.max(m, times[i]! - times[i - 1]!);
  return m;
}

/** Rejects keyframe times no real file has (negative beyond a frame, non-finite, longer than 7 days). */
function checkTimes(times: readonly number[]): string | null {
  if (times.length === 0) return 'no keyframes';
  if (times[0]! < -1000) return `first keyframe at ${times[0]} ms`;
  if (!(times[times.length - 1]! <= MAX_MEDIA_MS)) return `keyframe at ${times[times.length - 1]} ms`;
  return null;
}

/**
 * Zero-based duration. The declared one (Matroska Info Duration is the last timestamp, so start_time
 * comes off it) is kept only within [last keyframe, last keyframe + 60 s] and below 7 days; otherwise
 * the last keyframe plus a median GOP stands in for it.
 */
export function plausibleDuration(
  container: string,
  rawMs: number | null,
  startMs: number,
  times: readonly number[],
): { durationMs: number; declaredOk: boolean } {
  const last = times[times.length - 1]!;
  const declared = rawMs === null ? null : container === 'matroska' || container === 'webm' ? rawMs - startMs : rawMs;
  if (declared !== null && Number.isFinite(declared) && declared >= last && declared <= last + MAX_TAIL_MS && declared <= MAX_MEDIA_MS) {
    return { durationMs: round3(Math.max(declared, last + 1)), declaredOk: true };
  }
  // Some muxers write Duration without subtracting the start: the raw value may still be plausible.
  if (rawMs !== null && rawMs >= last && rawMs <= last + MAX_TAIL_MS && rawMs <= MAX_MEDIA_MS) return { durationMs: round3(Math.max(rawMs, last + 1)), declaredOk: true };
  return { durationMs: round3(last + (medianGap(times) ?? 1000)), declaredOk: false };
}

export interface BuildInput extends FileStamp {
  absPath: string;
  container: string;
  /** The video stream to index; null picks the first video stream (the job's and the analyzer's rule). */
  videoStreamIndex: number | null;
  /** false at StartPlayback: only the Cues may be read synchronously, never the slow probe. */
  allowProbe: boolean;
  targetMs: number;
  /** Cue gaps above this mean the Cues miss keyframes (HLS_SEGMENT_MAX_S). */
  maxGapMs: number;
  signal?: AbortSignal;
  now: () => number;
  /** Reuse a timeline already probed. */
  timeline?: Timeline;
}

export type BuildResult = { ok: true; index: KeyframeIndex } | { ok: false; reason: 'needs_probe'; advice: string | null; videoStreamIndex: number };

export async function buildKeyframeIndex(input: BuildInput, probe: DeliveryProbe): Promise<BuildResult> {
  const timeline = input.timeline ?? (await probe.timeline(input.absPath, input.signal));
  const requested = input.videoStreamIndex ?? timeline.videoStreamIndex;
  if (requested === null) throw new IndexBuildError('no video stream to index');
  const stamp = { version: KEYFRAME_INDEX_VERSION, fileId: input.fileId, sizeBytes: input.sizeBytes, mtimeMs: input.mtimeMs, startTimeMs: timeline.startTimeMs } as const;

  let advice: string | null = null;
  if (input.container === 'matroska' || input.container === 'webm') {
    const fh = await open(input.absPath, 'r');
    try {
      const mkv = await readMatroskaIndex(fileByteSource(fh, input.sizeBytes));
      // The Matroska track order is the ffmpeg stream index: the index is labelled with the track used.
      const track = mkv.tracks.find((t) => t.order === requested && t.type === 1);
      const points = track ? mkv.cues?.get(track.number) : undefined;
      if (track && points && points.length > 0) {
        const scale = mkv.timestampScaleNs / 1e6;
        const entries: { t: number; pos: number | null }[] = [];
        for (const p of points) entries.push({ t: p.ticks * scale - timeline.startTimeMs, pos: p.clusterPos });
        const { times, positions } = normalize(entries);
        const bad = checkTimes(times);
        const median = medianGap(times);
        if (bad) {
          advice = `${BAD_CUES_ADVICE} (${bad})`;
        } else if ((median !== null && median < MIN_PLAUSIBLE_GOP_MS) || maxGap(times, true) > input.maxGapMs) {
          advice = BAD_CUES_ADVICE;
        } else {
          const rawDuration = mkv.durationTicks !== null ? mkv.durationTicks * scale : timeline.rawDurationMs;
          const d = plausibleDuration(input.container, rawDuration, timeline.startTimeMs, times);
          return {
            ok: true,
            index: {
              ...stamp,
              videoStreamIndex: track.order,
              source: 'cues',
              complete: true,
              durationMs: d.durationMs,
              times,
              positions,
              dataEndBytes: mkv.dataEnd,
              advice: d.declaredOk ? null : BAD_DURATION_ADVICE,
              builtAt: input.now(),
            },
          };
        }
      } else {
        advice = NO_CUES_ADVICE;
      }
    } catch (err) {
      if (!(err instanceof EbmlError)) throw err;
      advice = `${NO_CUES_ADVICE} (${err.message})`;
    } finally {
      await fh.close();
    }
  }
  if (!input.allowProbe) return { ok: false, reason: 'needs_probe', advice, videoStreamIndex: requested };

  // Seek probe around each n·target; read_intervals takes absolute timestamps. The declared duration only
  // bounds the seeks (capped); the probe stops by itself past the end of the content.
  const declared = timeline.rawDurationMs === null ? null : input.container === 'matroska' || input.container === 'webm' ? timeline.rawDurationMs - timeline.startTimeMs : timeline.rawDurationMs;
  const span = declared !== null && declared > 0 && declared <= MAX_MEDIA_MS ? declared : MAX_PROBE_TARGETS * input.targetMs;
  const targets: number[] = [];
  for (let t = 0; t < span && targets.length < MAX_PROBE_TARGETS; t += input.targetMs) targets.push(t + timeline.startTimeMs);
  const bitrateBps = declared !== null && declared > 0 && declared <= MAX_MEDIA_MS ? (input.sizeBytes * 8000) / declared : null;
  const probed = await probe.keyframesAt(input.absPath, requested, targets, { container: input.container, bitrateBps, maxGopMs: input.maxGapMs }, input.signal);
  const entries: { t: number; pos: number | null }[] = [];
  for (const p of probed) entries.push({ t: p.ptsMs - timeline.startTimeMs, pos: p.pos });
  const { times, positions } = normalize(entries);
  const bad = checkTimes(times);
  if (bad) throw new IndexBuildError(`the seek probe found no usable keyframes: ${bad}`);
  const d = plausibleDuration(input.container, timeline.rawDurationMs, timeline.startTimeMs, times);
  const notes = [advice, d.declaredOk ? null : BAD_DURATION_ADVICE].filter((x): x is string => x !== null);
  return {
    ok: true,
    index: {
      ...stamp,
      videoStreamIndex: requested,
      source: 'probe',
      // Read in windows (MPEG-TS), the probe sees every keyframe; seeking, only those it lands on.
      complete: !SEEKS_TO_KEYFRAME.has(input.container),
      durationMs: d.durationMs,
      times,
      positions,
      dataEndBytes: null,
      advice: notes.length ? notes.join('; ') : null,
      builtAt: input.now(),
    },
  };
}

export class KeyframeCache {
  private readonly dir: string;

  constructor(cacheDir: string) {
    this.dir = join(cacheDir, 'delivery', 'keyframes');
  }

  private path(fileId: string, videoStreamIndex: number, kind: 'index' | 'failed'): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new Error(`invalid file id ${JSON.stringify(fileId)}`);
    if (!Number.isSafeInteger(videoStreamIndex) || videoStreamIndex < 0) throw new Error(`invalid stream index ${videoStreamIndex}`);
    return join(this.dir, `${fileId}.v${videoStreamIndex}${kind === 'failed' ? '.failed' : ''}.json`);
  }

  private async readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
      return null;
    }
  }

  private async write(target: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** The cached index of exactly this content and video stream, or null. */
  async get(stamp: FileStamp, videoStreamIndex: number): Promise<KeyframeIndex | null> {
    const parsed = IndexJson.safeParse(await this.readJson(this.path(stamp.fileId, videoStreamIndex, 'index')));
    if (!parsed.success) return null;
    const ix = parsed.data;
    if (ix.fileId !== stamp.fileId || ix.sizeBytes !== stamp.sizeBytes || ix.mtimeMs !== stamp.mtimeMs) return null;
    if (ix.videoStreamIndex !== videoStreamIndex) return null;
    if (ix.times.length === 0 || ix.positions.length !== ix.times.length) return null;
    return ix;
  }

  async put(index: KeyframeIndex): Promise<void> {
    await this.write(this.path(index.fileId, index.videoStreamIndex, 'index'), index);
    await rm(this.path(index.fileId, index.videoStreamIndex, 'failed'), { force: true });
  }

  /** The recorded build failure of exactly this content and stream, or null. */
  async getFailure(stamp: FileStamp, videoStreamIndex: number, now: number): Promise<IndexFailure | null> {
    const parsed = FailureJson.safeParse(await this.readJson(this.path(stamp.fileId, videoStreamIndex, 'failed')));
    if (!parsed.success) return null;
    const f = parsed.data;
    if (f.fileId !== stamp.fileId || f.sizeBytes !== stamp.sizeBytes || f.mtimeMs !== stamp.mtimeMs) return null;
    return f.permanent || now - f.at < TRANSIENT_FAILURE_TTL_MS ? f : null;
  }

  async putFailure(stamp: FileStamp, videoStreamIndex: number, reason: string, at: number, permanent: boolean): Promise<void> {
    const f: IndexFailure = { version: KEYFRAME_INDEX_VERSION, ...stamp, videoStreamIndex, reason: reason.slice(0, 2000), permanent, at };
    await this.write(this.path(stamp.fileId, videoStreamIndex, 'failed'), f);
  }
}
