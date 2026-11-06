// Delivery's own ffprobe calls, in child processes (ADR 0001 rule 3): the file's zero point and duration,
// and the seek probe that is the keyframe index fallback (ADR 0003 D8, option B).
import { execa, ExecaError } from 'execa';
import { z } from 'zod';

export interface Timeline {
  /** format start_time, the zero of the original timeline (PTS − start_time), ms. */
  startTimeMs: number;
  /** format duration as ffprobe reports it, ms (for Matroska the Info Duration, i.e. the last timestamp). */
  rawDurationMs: number | null;
  /** ffprobe index of the first video stream that is not cover art, null when there is none. */
  videoStreamIndex: number | null;
}

export interface ProbedKeyframe {
  /** Absolute PTS (not zero-based), ms. */
  ptsMs: number;
  pos: number | null;
}

export interface KeyframeProbeOptions {
  /** MediaFacts.container: Matroska and MP4 seek onto a keyframe; anything else is read in windows. */
  container: string;
  /** Average bitrate of the file, null when unknown: sizes the ffprobe calls and their timeouts. */
  bitrateBps: number | null;
  /** Longest GOP to expect (HLS_SEGMENT_MAX_S): windows overlap by this much, so none is missed. */
  maxGopMs: number;
}

export interface DeliveryProbe {
  timeline(absPath: string, signal?: AbortSignal): Promise<Timeline>;
  /**
   * Keyframes near the absolute targets (ms), ascending and unique. Matroska and MP4 seek onto a
   * keyframe, so one packet per seek is read (M5). Other containers (MPEG-TS) seek to a byte position:
   * they are read in overlapping windows from the first target to the last, every keyframe of the range.
   */
  keyframesAt(absPath: string, streamIndex: number, targetsMs: readonly number[], opts: KeyframeProbeOptions, signal?: AbortSignal): Promise<ProbedKeyframe[]>;
  /**
   * End of a stream (absolute ms: PTS + duration of its last packet), read backwards from `nearMs` (the
   * container's end, absolute) in growing windows, the whole file last; null when it has no timed packet.
   * A video stream may end seconds before the container (the audio runs on).
   */
  streamEndMs(absPath: string, streamIndex: number, nearMs: number | null, signal?: AbortSignal): Promise<number | null>;
}

/** Windows read before the container's end, looking for a stream's last packet. */
const END_WINDOWS_MS = [10_000, 40_000, 160_000, 640_000];

/** Containers whose seek lands on a keyframe (indexed seeking). */
export const SEEKS_TO_KEYFRAME = new Set(['matroska', 'webm', 'mp4', 'mov']);

const num = z.union([z.number(), z.string()]).transform((v) => Number(v));

const TimelineJson = z.looseObject({
  format: z.looseObject({ start_time: num.optional(), duration: num.optional() }).optional(),
  streams: z
    .array(z.looseObject({ index: z.number(), codec_type: z.string().optional(), disposition: z.record(z.string(), z.number()).optional() }))
    .default([]),
});

const PacketsJson = z.looseObject({
  packets: z.array(z.looseObject({ pts_time: num.optional(), pos: num.optional(), flags: z.string().optional() })).default([]),
});

const EndPacketsJson = z.looseObject({
  packets: z.array(z.looseObject({ pts_time: num.optional(), duration_time: num.optional() })).default([]),
});

/** Bytes one ffprobe call should read at most; batches and windows are sized from the bitrate. */
const CALL_BUDGET_BYTES = 512 * 1024 * 1024;
/** Slowest read rate assumed for the timeout (an NTFS bind mount under load). */
const MIN_READ_BYTES_PER_S = 5 * 1024 * 1024;
/** Bitrate assumed when unknown, and the bounds of an estimate (a hostile duration skews it). */
const DEFAULT_BITRATE_BPS = 40_000_000;
const MIN_BITRATE_BPS = 2_000_000;
const MAX_BITRATE_BPS = 160_000_000;
/** Bytes read per seek onto a keyframe: about the keyframe itself, half a second of data. */
const SEEK_READ_S = 0.5;

const callTimeoutMs = (bytes: number): number => 60_000 + Math.ceil((bytes / MIN_READ_BYTES_PER_S) * 1000);

/**
 * ffprobe's message for an input it cannot open (libavformat prints `<url>: <strerror>`), by errno code: the
 * callers tell a file error (MEDIA_UNAVAILABLE) from a broken stream by the code, as for their own fs calls.
 */
const OPEN_ERRORS: ReadonlyArray<readonly [string, string]> = [
  ['No such file or directory', 'ENOENT'],
  ['Permission denied', 'EACCES'],
  ['Operation not permitted', 'EPERM'],
  ['Not a directory', 'ENOTDIR'],
  ['Input/output error', 'EIO'],
  ['Device or resource busy', 'EBUSY'],
  ['Too many open files', 'EMFILE'],
];

/** The errno code of an input ffprobe could not open, from its stderr lines; null when it is something else. */
export function openErrorCode(stderr: string): string | null {
  for (const line of stderr.split(/\r?\n/)) {
    for (const [message, code] of OPEN_ERRORS) if (line.trimEnd().endsWith(`: ${message}`)) return code;
  }
  return null;
}

function describe(err: unknown, what: string): Error {
  if (err instanceof ExecaError) {
    const why = err.timedOut ? 'timed out' : err.isCanceled ? 'canceled' : `exit ${err.exitCode ?? err.signal ?? '?'}`;
    const raw: unknown = err.stderr;
    const stderr = typeof raw === 'string' ? raw.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') : '';
    const out = new Error(`${what}: ffprobe ${why}${stderr ? `: ${stderr.slice(0, 400)}` : ''}`);
    // Only an ffprobe that ran and exited: a missing ffprobe binary (spawn ENOENT) is not a file error.
    const code = typeof err.exitCode === 'number' && !err.timedOut && !err.isCanceled && typeof raw === 'string' ? openErrorCode(raw) : null;
    return code ? Object.assign(out, { code }) : out;
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function createDeliveryProbe(ffprobePath: string, opts: { timeoutMs?: number; argsPrefix?: readonly string[] } = {}): DeliveryProbe {
  const run = async (args: string[], signal: AbortSignal | undefined, what: string, timeout = opts.timeoutMs ?? 120_000): Promise<unknown> => {
    try {
      const r = await execa(ffprobePath, [...(opts.argsPrefix ?? []), ...args], {
        timeout,
        ...(signal ? { cancelSignal: signal } : {}),
        forceKillAfterDelay: 5000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      return JSON.parse(r.stdout);
    } catch (err) {
      throw describe(err, what);
    }
  };
  return {
    async timeline(absPath, signal) {
      const json = TimelineJson.parse(
        await run(
          ['-v', 'error', '-show_entries', 'format=start_time,duration:stream=index,codec_type:stream_disposition=attached_pic', '-of', 'json', '-i', `file:${absPath}`],
          signal,
          'timeline probe',
          30_000,
        ),
      );
      const start = json.format?.start_time;
      const dur = json.format?.duration;
      const video = json.streams.find((s) => s.codec_type === 'video' && (s.disposition?.attached_pic ?? 0) !== 1);
      return {
        startTimeMs: Number.isFinite(start) ? Math.round(start! * 1e6) / 1e3 : 0,
        rawDurationMs: Number.isFinite(dur) && dur! > 0 ? Math.round(dur! * 1e6) / 1e3 : null,
        videoStreamIndex: video?.index ?? null,
      };
    },
    async keyframesAt(absPath, streamIndex, targetsMs, o, signal) {
      const seen = new Map<number, number | null>();
      let maxPts = Number.NEGATIVE_INFINITY;
      const collect = (json: z.infer<typeof PacketsJson>): number => {
        let found = 0;
        for (const p of json.packets) {
          if (!Number.isFinite(p.pts_time)) continue;
          found++;
          if (!p.flags?.includes('K')) continue;
          const pts = Math.round(p.pts_time! * 1e6) / 1e3;
          if (!seen.has(pts)) seen.set(pts, Number.isFinite(p.pos) && p.pos! >= 0 ? p.pos! : null);
          if (pts > maxPts) maxPts = pts;
        }
        return found;
      };
      const packets = (intervals: string, timeout: number) =>
        run(['-v', 'error', '-select_streams', String(streamIndex), '-read_intervals', intervals, '-show_entries', 'packet=pts_time,pos,flags', '-of', 'json', '-i', `file:${absPath}`], signal, 'keyframe probe', timeout).then((j) => PacketsJson.parse(j));
      const bitrate = Math.min(MAX_BITRATE_BPS, Math.max(MIN_BITRATE_BPS, o.bitrateBps ?? DEFAULT_BITRATE_BPS));

      if (SEEKS_TO_KEYFRAME.has(o.container)) {
        // One packet per seek: the keyframe the seek lands on.
        const perSeek = (bitrate / 8) * SEEK_READ_S;
        const batch = Math.max(25, Math.min(400, Math.floor(CALL_BUDGET_BYTES / perSeek)));
        for (let i = 0; i < targetsMs.length; i += batch) {
          const slice = targetsMs.slice(i, i + batch);
          const before = maxPts;
          collect(await packets(slice.map((t) => `${(t / 1000).toFixed(6)}%+#1`).join(','), opts.timeoutMs ?? callTimeoutMs(slice.length * perSeek)));
          // A batch that finds nothing past the last keyframe is past the end of the file: a declared
          // duration longer than the content does not cost more seeks.
          if (maxPts === before) break;
        }
      } else if (targetsMs.length > 0) {
        // Windows of about CALL_BUDGET_BYTES each, overlapping by one GOP: a seek lands on a byte
        // position, so a keyframe just before a window's start is caught by the previous window.
        const overlapMs = o.maxGopMs + 500;
        const windowMs = Math.max(overlapMs * 4, Math.floor(((CALL_BUDGET_BYTES * 8) / bitrate) * 1000));
        const first = targetsMs[0]!;
        const last = targetsMs[targetsMs.length - 1]! + overlapMs;
        for (let from = first; from < last; from += windowMs - overlapMs) {
          const ms = Math.min(windowMs, last - from);
          if (collect(await packets(`${(from / 1000).toFixed(6)}%+${(ms / 1000).toFixed(6)}`, opts.timeoutMs ?? callTimeoutMs((bitrate / 8) * (ms / 1000)))) === 0) break;
        }
      }
      const out: ProbedKeyframe[] = [];
      for (const [ptsMs, pos] of seen) out.push({ ptsMs, pos });
      out.sort((a, b) => a.ptsMs - b.ptsMs);
      return out;
    },
    async streamEndMs(absPath, streamIndex, nearMs, signal) {
      const endOf = async (interval: string | null, timeout: number): Promise<number | null> => {
        const json = EndPacketsJson.parse(
          await run(
            ['-v', 'error', '-select_streams', String(streamIndex), ...(interval ? ['-read_intervals', interval] : []), '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', '-i', `file:${absPath}`],
            signal,
            'stream end probe',
            timeout,
          ),
        );
        let end: number | null = null;
        for (const p of json.packets) {
          if (!Number.isFinite(p.pts_time)) continue;
          const e = p.pts_time! + (Number.isFinite(p.duration_time) ? p.duration_time! : 0);
          if (end === null || e > end) end = e;
        }
        return end === null ? null : Math.round(end * 1e6) / 1e3;
      };
      if (nearMs !== null && Number.isFinite(nearMs)) {
        for (const w of END_WINDOWS_MS) {
          const from = nearMs - w;
          if (from <= 0) break;
          const found = await endOf(`${(from / 1000).toFixed(6)}%`, callTimeoutMs((DEFAULT_BITRATE_BPS / 8) * (w / 1000)));
          if (found !== null) return found;
        }
      }
      return endOf(null, opts.timeoutMs ?? 600_000);
    },
  };
}
