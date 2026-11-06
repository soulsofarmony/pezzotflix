// Embedded subtitle extraction (ADR 0003 D12). One ffmpeg reads a file once and writes every requested track
// (PGS copied to .sup, text to WebVTT, or to ASS for a burn-in). Pass 1 runs from P = max(0, X − preroll) to
// the end and is served while it grows; pass 2 covers [0, P₁) and is merged in front of it (PTS dedupe);
// the result is renamed atomically into the cache. Extraction is per file and shared: a job holds the streams
// that need it and is cancelled when none does (unless SUBTITLE_PREEXTRACT is on).
// Slots: one capped extraction at a time (pass 1 before any pass 2), and apart from it one blocking extraction
// a Transcode waits for (burn-in), so a burn-in never queues behind a long capped read.
// The clock of a pass is its video stream copied to a frame-hash muxer on stdout (one line per packet,
// absolute timestamps). The read cap is applied here, not by ffmpeg: Node reads stdout no faster than
// R × wall time (after a burst for the pre-roll), and the pipe's backpressure holds ffmpeg's demuxer, so every
// track waits with the video. ffmpeg 8's -readrate is not used: its catch-up anchors on the stale timestamps of
// a sparse subtitle stream and sleeps on every gap between cues, so a pass ran at real time or slower. Pass 2
// is stopped from here once the clock is past P₁: input -t does not end the read while a mapped subtitle
// stream has no packet after P₁ (ffmpeg would read on to its next cue, or the end of the file). A pass whose
// clock and outputs stop moving (while not held by the pacing) is killed by a watchdog.
// ffmpeg only ever writes .part files in the job's work dir, so a kill (SIGTERM is TerminateProcess on
// Windows) never leaves a partial file in the cache: the rename happens after a clean pass only.
// Nothing here may reject unobserved.
import { createReadStream } from 'node:fs';
import { type FileHandle, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../app/config.ts';
import { newId } from '../../shared/ids.ts';
import { type ChildLike, type Spawn, terminate } from './process.ts';
import { StderrRing } from './stderr.ts';
import { type FileStamp, fingerprint, outputKey, SubtitleCache } from './subtitle-cache.ts';
import { keepSupSegment, mergeVtt, SUP_HEADER_BYTES, supFirstPts, type SubtitleFormat, SupSplitter, vttFirstCueMs } from './subtitle-format.ts';

/** Largest output kept per track; a track past it is dropped (bounded disk and merge memory), the others go on. */
export const MAX_OUTPUT_BYTES: Readonly<Record<SubtitleFormat, number>> = { sup: 1024 ** 3, vtt: 64 * 1024 ** 2, ass: 64 * 1024 ** 2 };
/** ADR 0003 D12: the read rate R (media seconds per second) never below 1.1×, so the extraction stays ahead of playback. */
export const MIN_READRATE = 1.1;
/** A pass whose clock and outputs do not move for this long, while the pacing is not holding it, is killed. */
export const EXTRACT_STALL_MS = 60_000;
/** A clock step larger than this (either way) is a timestamp discontinuity: the pacing follows it, it does not wait it out. */
export const PACE_JUMP_S = 10;
/** Passes running at once: one capped (a second read of the media mount never competes with playback), one blocking. */
const SLOTS = { capped: 1, blocking: 1 } as const;
/** Read size of a growing response. */
const FOLLOW_CHUNK = 256 * 1024;
/** Pass 2 is stopped once its video clock is this far past P₁ (media seconds) ... */
export const PASS2_MARGIN_S = 5;
/** ... and has stayed past it this long, so the muxers have written what was read before. */
const PASS2_SETTLE_MS = 500;
/** A failed pass 2 is tried again after this × its attempt number; the pass-1 file is served meanwhile. */
const PASS2_RETRY_MS = 60_000;
const PASS2_MAX_ATTEMPTS = 3;

export interface ExtractFile extends FileStamp {
  absPath: string;
  durationMs: number | null;
  /** The clock of every pass (frame-hash lines on stdout); null: no clock, no read cap. */
  videoStreamIndex: number | null;
}

export interface ExtractTarget {
  streamIndex: number;
  format: SubtitleFormat;
}

export interface ExtractionArgs {
  absPath: string;
  pass: 1 | 2;
  /** P of pass 1, seconds on the zero-based timeline; 0: from the start, no seek. */
  startS: number;
  /** P₁ of pass 2, seconds: input -t when there is no video stream (no clock); else the clock stops it. */
  untilS: number | null;
  /** The clock: copied to stdout as one line per packet. */
  videoStreamIndex: number | null;
  /**
   * Paced from Node: SHA-512 frame hashes (about 176 bytes a line against framecrc's 65), so the pipe and
   * Node's buffer hold fewer media seconds ahead of the pacing. Unpaced (a burn-in): framecrc, cheaper.
   */
  paced: boolean;
  outputs: { streamIndex: number; format: SubtitleFormat; path: string }[];
}

const CODEC_ARGS: Readonly<Record<SubtitleFormat, readonly string[]>> = {
  // -flush_packets 1: without it the file stays empty until the end (t6).
  sup: ['-c:s', 'copy', '-flush_packets', '1', '-f', 'sup'],
  vtt: ['-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt'],
  ass: ['-c:s', 'ass', '-f', 'ass'],
};

/** ffmpeg command of one pass (ADR 0003 D12), pure. -copyts -start_at_zero keep the cues on the original timeline (t3). */
export function extractionArgs(o: ExtractionArgs): string[] {
  const clock = o.videoStreamIndex !== null;
  return [
    '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'warning', '-y',
    ...(o.pass === 1 && o.startS > 0 ? ['-noaccurate_seek', '-ss', o.startS.toFixed(6)] : []),
    ...(o.pass === 2 && o.untilS !== null && !clock ? ['-t', o.untilS.toFixed(6)] : []),
    '-i', `file:${o.absPath}`,
    '-copyts', '-start_at_zero',
    ...(clock
      ? ['-map', `0:${o.videoStreamIndex}`, '-c', 'copy', '-flush_packets', '1', ...(o.paced ? ['-f', 'framehash', '-hash', 'sha512'] : ['-f', 'framecrc']), 'pipe:1']
      : []),
    ...o.outputs.flatMap((t) => ['-map', `0:${t.streamIndex}`, ...CODEC_ARGS[t.format], `file:${t.path}`]),
  ];
}

/** R = max(1.1; cap / bitrate of the file) (ADR 0003 D12); 1.1 when the duration is unknown. */
export function extractionReadrate(sizeBytes: number, durationMs: number | null, maxMBps: number): number {
  if (!durationMs || durationMs <= 0 || sizeBytes <= 0) return MIN_READRATE;
  const fileBytesPerS = sizeBytes / (durationMs / 1000);
  return Math.max(MIN_READRATE, Math.round(((maxMBps * 1e6) / fileBytesPerS) * 1000) / 1000);
}

/**
 * Pacing of a pass against the wall clock (ADR 0003 D12): the reader may be at origin + burst + R × elapsed
 * (media seconds, the origin being the first packet); a packet past that waits until it is due. A step of the
 * clock over PACE_JUMP_S moves the origin with it (a discontinuity is not media to wait for). Pure: the caller
 * holds its reader for the delay.
 */
export class ClockPacer {
  private readonly rate: number;
  private readonly burstS: number;
  private origin: { clockS: number; atMs: number } | null = null;
  private last = 0;

  constructor(rate: number, burstS: number) {
    this.rate = rate;
    this.burstS = burstS;
  }

  /** Wall ms to wait before reading past this packet; 0: go on. */
  delayMs(clockS: number, nowMs: number): number {
    if (!this.origin) {
      this.origin = { clockS, atMs: nowMs };
      this.last = clockS;
      return 0;
    }
    const step = clockS - this.last;
    if (Math.abs(step) > PACE_JUMP_S) this.origin.clockS += step;
    this.last = clockS;
    const dueAt = this.origin.atMs + ((clockS - this.origin.clockS - this.burstS) / this.rate) * 1000;
    return Math.max(0, dueAt - nowMs);
  }
}

/**
 * Reader of a pass's clock, one framecrc or framehash line at a time: the `#tb 0: num/den` header, then one
 * line per video packet (`0, dts, pts, duration, size, hash`). Returns the packet's dts in seconds on the
 * zero-based timeline, null for any other line.
 */
export function clockReader(): (line: string) => number | null {
  let tb: number | null = null;
  return (line) => {
    const h = /^#tb 0: (\d+)\/(\d+)\s*$/.exec(line);
    if (h) {
      tb = Number(h[2]) > 0 ? Number(h[1]) / Number(h[2]) : null;
      return null;
    }
    const m = /^0,\s*(-?\d+),/.exec(line);
    return m && tb !== null ? Number(m[1]) * tb : null;
  };
}

export type ExtractionLookup =
  | { kind: 'complete'; path: string }
  /**
   * Pass 1 is writing this track: open() follows its .part file (append-only reads, never past what is
   * written) until pass 1 ends, and errors if that attempt fails; null when the file moved meanwhile.
   */
  | { kind: 'growing'; open: () => Promise<Readable | null> }
  /** Pass 1 is over, the merge not yet (pass 2 queued, running or failed): the film from P on, as a plain file. */
  | { kind: 'partial'; path: string }
  /** Waiting for its pass 1 to start. */
  | { kind: 'queued' }
  | { kind: 'failed' }
  | { kind: 'absent' };

type Phase = 'queued' | 'pass1' | 'pass1_done';

interface Output {
  key: string;
  streamIndex: number;
  format: SubtitleFormat;
  /** Pass-1 file: written as is, served while it grows, then merged. */
  p1: string;
  p2: string;
  phase: Phase;
  /** Pass-1 attempt; a reader of an earlier attempt ends with an error (the file was truncated). */
  attempt: number;
  /** Bytes of pass 1 so far (the monitor's last stat). */
  bytes: number;
}

interface Job {
  id: string;
  fp: string;
  file: ExtractFile;
  dir: string;
  startMs: number;
  /** Media read at once in pass 1 (the pre-roll), so the cue on screen at X arrives first. */
  burstMs: number;
  /** R of the pacing; null: no read cap. */
  readrate: number | null;
  /** A Transcode waits for it: its own slot, one pass from 0, no read cap. */
  blocking: boolean;
  outputs: Map<string, Output>;
  holders: Set<string>;
  /** P₁ of pass 2, seconds (P when pass 1 found no cue: it covered everything from its keyframe ≤ P on). */
  untilS: number | null;
  child: ChildLike | null;
  /** Failed pass-1 attempts in a row. */
  attempts: number;
  pass2Attempts: number;
  pass2Timer: NodeJS.Timeout | null;
  state: 'active' | 'done' | 'failed' | 'cancelled';
  cancelTimer: NodeJS.Timeout | null;
  waiters: Set<() => void>;
}

interface QueueEntry {
  job: Job;
  pass: 1 | 2;
  /** A pass 2 stopped (or not started) for a pass 1: queued again, not a failure. */
  preempted: boolean;
}

export interface ExtractorDeps {
  config: Pick<Config, 'cacheDir' | 'SUBTITLE_EXTRACT_MAX_MBPS' | 'SUBTITLE_PREROLL_S' | 'SUBTITLE_PREEXTRACT' | 'SUBTITLE_CACHE_MAX_BYTES'> & Partial<Pick<Config, 'SUBTITLE_EXTRACT_STALL_S'>>;
  log: FastifyBaseLogger;
  now: () => number;
  spawn: Spawn;
  /** A track became complete in the cache (fingerprint, key). */
  onComplete: (fp: string, key: string) => void;
  /** A track failed for good (its url answers MEDIA_UNAVAILABLE until failedTtlMs). */
  onFailed?: (fp: string, key: string) => void;
  /** Fingerprints the caller still uses (active streams): never evicted. */
  inUse?: () => Iterable<string>;
  /** stallMs: the no-progress watchdog of a pass (EXTRACT_STALL_MS). */
  timings?: { cancelGraceMs?: number; pollMs?: number; failedTtlMs?: number; stallMs?: number; pass2RetryMs?: number };
  /** Tests: lower caps than MAX_OUTPUT_BYTES. */
  maxOutputBytes?: Partial<Record<SubtitleFormat, number>>;
}

export interface AcquireOptions {
  /** A Transcode waits for it (burn-in): one pass from 0, no read cap, its own slot. */
  blocking?: boolean;
  /** Released by itself after this long without a new acquire by the same holder. */
  ttlMs?: number;
}

export function createSubtitleExtractor(deps: ExtractorDeps) {
  const { config, log, now } = deps;
  const cache = new SubtitleCache(config.cacheDir, config.SUBTITLE_CACHE_MAX_BYTES, log, now);
  const cancelGraceMs = deps.timings?.cancelGraceMs ?? 30_000;
  const pollMs = deps.timings?.pollMs ?? 500;
  const failedTtlMs = deps.timings?.failedTtlMs ?? 5 * 60_000;
  const pass2RetryMs = deps.timings?.pass2RetryMs ?? PASS2_RETRY_MS;
  const stallMs = deps.timings?.stallMs ?? (config.SUBTITLE_EXTRACT_STALL_S !== undefined ? config.SUBTITLE_EXTRACT_STALL_S * 1000 : EXTRACT_STALL_MS);
  const preextract = config.SUBTITLE_PREEXTRACT === 'on';
  const capOf = (f: SubtitleFormat): number => deps.maxOutputBytes?.[f] ?? MAX_OUTPUT_BYTES[f];
  /** The active job of each output (fp/key). */
  const byOutput = new Map<string, Job>();
  /** Outputs that failed for good, with when: no new extraction until failedTtlMs. */
  const failures = new Map<string, number>();
  const holderJobs = new Map<string, Set<Job>>();
  const holderTtl = new Map<string, NodeJS.Timeout>();
  const queue: QueueEntry[] = [];
  const running = new Set<QueueEntry>();
  const runs = new Set<Promise<void>>();
  let closed = false;

  cache.setPinned(() => {
    const s = new Set<string>(deps.inUse?.() ?? []);
    for (const j of byOutput.values()) if (j.state === 'active') s.add(j.fp);
    return s;
  });

  const id = (fp: string, key: string) => `${fp}/${key}`;

  const wake = (job: Job): void => {
    const w = [...job.waiters];
    job.waiters.clear();
    for (const r of w) r();
  };

  const waitChange = (job: Job, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        job.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      job.waiters.add(done);
    });

  const liveJob = (fp: string, key: string): Job | null => {
    const j = byOutput.get(id(fp, key));
    return j?.state === 'active' ? j : null;
  };

  function failedRecently(fp: string, key: string): boolean {
    const at = failures.get(id(fp, key));
    if (at === undefined) return false;
    if (now() - at < failedTtlMs) return true;
    failures.delete(id(fp, key));
    return false;
  }

  /** A partial track (pass 2 given up) older than a failure's TTL: extracted again, served meanwhile. */
  const stalePartial = (fp: string, key: string): boolean => {
    const at = cache.partialSince(fp, key);
    return at !== null && now() - at >= failedTtlMs;
  };

  const notify = (fn: ((fp: string, key: string) => void) | undefined, fp: string, key: string): void => {
    try {
      fn?.(fp, key);
    } catch (err) {
      log.warn({ fp, key, err: String(err) }, 'subtitle extraction event not published');
    }
  };

  async function removeDir(job: Job): Promise<void> {
    await rm(job.dir, { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) =>
      log.warn({ job: job.id, dir: job.dir, err: String(err) }, 'subtitle extraction work dir not removed'),
    );
  }

  function addHolder(job: Job, holder: string): void {
    job.holders.add(holder);
    let set = holderJobs.get(holder);
    if (!set) holderJobs.set(holder, (set = new Set()));
    set.add(job);
    if (job.cancelTimer) {
      clearTimeout(job.cancelTimer);
      job.cancelTimer = null;
    }
  }

  const slotOf = (job: Job): keyof typeof SLOTS => (job.blocking ? 'blocking' : 'capped');

  function enqueue(job: Job, pass: 1 | 2): void {
    const entry: QueueEntry = { job, pass, preempted: false };
    if (pass === 1) {
      // Pass 1 first: a session is waiting for it. A capped pass 2 running (or about to) is stopped and queued again.
      const firstPass2 = queue.findIndex((e) => e.pass === 2);
      if (firstPass2 < 0) queue.push(entry);
      else queue.splice(firstPass2, 0, entry);
      if (!job.blocking) {
        for (const r of running) {
          if (r.pass !== 2 || r.preempted || r.job.blocking) continue;
          r.preempted = true;
          if (r.job.child) kill(r.job.child);
        }
      }
    } else {
      queue.push(entry);
    }
    pump();
  }

  function pump(): void {
    if (closed) return;
    for (let i = 0; i < queue.length; ) {
      const entry = queue[i]!;
      if (entry.job.state !== 'active') {
        queue.splice(i, 1);
        continue;
      }
      const slot = slotOf(entry.job);
      let busy = 0;
      for (const r of running) if (slotOf(r.job) === slot) busy++;
      if (busy >= SLOTS[slot]) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      running.add(entry);
      const p = runPass(entry)
        .catch(async (err: unknown) => {
          log.warn({ job: entry.job.id, err: String(err) }, 'subtitle extraction error');
          if (entry.pass === 2) await pass2Failed(entry.job, String(err));
          else await fail(entry.job, String(err));
        })
        // The failure handling itself threw (a cache put, a full disk): p must never reject unobserved.
        .catch((err: unknown) => abandon(entry.job, `failure handling failed: ${String(err)}`))
        .finally(() => {
          running.delete(entry);
          runs.delete(p);
          try {
            pump();
          } catch (err) {
            log.error({ err: String(err) }, 'subtitle extraction queue not pumped');
          }
        });
      runs.add(p);
    }
  }

  async function runPass(entry: QueueEntry): Promise<void> {
    const { job, pass } = entry;
    const wanted = () => job.state === 'active' && !closed && !entry.preempted;
    await mkdir(job.dir, { recursive: true });
    const outputs = [...job.outputs.values()];
    for (const o of outputs) {
      if (pass === 2) {
        await rm(o.p2, { force: true });
        continue;
      }
      // A new attempt: readers of an earlier one end with an error before the file is truncated.
      o.attempt += 1;
      o.phase = 'pass1';
      o.bytes = 0;
      // Created before ffmpeg opens it, so a growing response can open it at once (ffmpeg truncates it).
      await writeFile(o.p1, '');
    }
    wake(job);
    // Cancelled, shut down or preempted during the awaits above: no ffmpeg (nobody would kill it).
    if (!wanted()) {
      if (job.state === 'active' && !closed && entry.preempted) queue.push({ job, pass: 2, preempted: false });
      else if (job.state !== 'active' || closed) await removeDir(job);
      return;
    }
    const clock = job.file.videoStreamIndex !== null;
    const pacer = clock && job.readrate !== null ? new ClockPacer(job.readrate, pass === 1 ? job.burstMs / 1000 : 0) : null;
    const args = extractionArgs({
      absPath: job.file.absPath,
      pass,
      startS: job.startMs / 1000,
      untilS: pass === 2 ? job.untilS : null,
      videoStreamIndex: job.file.videoStreamIndex,
      paced: pacer !== null,
      outputs: outputs.map((o) => ({ streamIndex: o.streamIndex, format: o.format, path: pass === 1 ? o.p1 : o.p2 })),
    });
    log.debug({ job: job.id, pass, fp: job.fp, outputs: outputs.map((o) => o.key), readrate: pacer ? job.readrate : null }, 'subtitle extraction pass started');
    const child = deps.spawn(args);
    job.child = child;
    const stderr = new StderrRing(16 * 1024);
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.stderr.on('error', () => {});
    child.stdout.on('error', () => {});
    // Set by the timers below; an object, so the checks after the exit see the closures' writes.
    const stopped: { overCap: string | null; stalled: boolean; atUntil: boolean } = { overCap: null, stalled: false, atUntil: false };
    let settle: NodeJS.Timeout | null = null;
    /** The pacing holds stdout until then: ffmpeg waits on the pipe, which is not a stall. */
    let held: NodeJS.Timeout | null = null;
    let lastProgressAt = now();
    /** Where pass 2 is stopped from its clock; null: pass 1, or no clock. */
    const limitS = clock && pass === 2 && job.untilS !== null ? job.untilS + PASS2_MARGIN_S : null;
    /** Highest clock read, also from what is drained after the exit. */
    let maxClock = Number.NEGATIVE_INFINITY;
    if (clock) {
      const read = clockReader();
      let carry = '';
      child.stdout.on('data', (c: Buffer) => {
        carry += c.toString('latin1');
        let waitMs = 0;
        let nl: number;
        while ((nl = carry.indexOf('\n')) >= 0) {
          const s = read(carry.slice(0, nl).trim());
          carry = carry.slice(nl + 1);
          if (s === null) continue;
          if (s > maxClock) {
            maxClock = s;
            lastProgressAt = now();
          }
          if (pacer) waitMs = pacer.delayMs(s, now());
          // The settle lets the subtitle outputs mux what was read before.
          if (limitS !== null && s >= limitS && !settle) {
            settle = setTimeout(() => {
              stopped.atUntil = true;
              kill(child);
            }, PASS2_SETTLE_MS);
          }
        }
        if (carry.length > 4096) carry = carry.slice(-4096);
        // Held during the settle too: the subtitle muxers do not wait on stdout, and the demuxer is past P₁ by the lead.
        if (waitMs > 0 && !held) {
          child.stdout.pause();
          held = setTimeout(() => {
            held = null;
            lastProgressAt = now();
            child.stdout.resume();
          }, waitMs);
        }
      });
    } else {
      child.stdout.resume();
    }
    const sizes = new Map<string, number>();
    const watch = async (): Promise<void> => {
      for (const o of outputs) {
        const size = await stat(pass === 1 ? o.p1 : o.p2).then((s) => s.size, () => 0);
        if (pass === 1) o.bytes = size;
        if (size !== (sizes.get(o.key) ?? 0)) {
          sizes.set(o.key, size);
          lastProgressAt = now();
        }
        if (size > capOf(o.format) && !stopped.overCap) {
          stopped.overCap = o.key;
          kill(child);
        }
      }
      if (!held && !settle && !stopped.stalled && now() - lastProgressAt > stallMs) {
        stopped.stalled = true;
        kill(child);
      }
      wake(job);
    };
    const monitor = setInterval(() => {
      watch().catch((err: unknown) => log.warn({ job: job.id, err: String(err) }, 'subtitle extraction monitor error'));
    }, pollMs);
    let exit;
    try {
      exit = await child.exited;
    } finally {
      clearInterval(monitor);
      if (settle) clearTimeout(settle);
      if (held) clearTimeout(held);
      job.child = null;
    }
    if (job.state !== 'active') return; // cancelled meanwhile: cancel() cleans up
    if (entry.preempted) {
      log.debug({ job: job.id }, 'subtitle extraction pass 2 preempted by a pass 1');
      if (!closed) queue.push({ job, pass: 2, preempted: false });
      return;
    }
    if (pass === 1) for (const o of outputs) o.bytes = await stat(o.p1).then((s) => s.size, () => o.bytes);
    const { overCap, stalled } = stopped;
    // An exit (of any code) once the clock is past P₁ + margin, before the settle stopped it: what pass 2
    // needed is written, as with the stop (the clock drained after the exit counts).
    const atUntil = stopped.atUntil || (limitS !== null && maxClock >= limitS && exit.error === null);
    if (overCap) {
      // One track over its cap does not cost the others: it is dropped, the pass runs again without it.
      dropOutput(job, overCap, 'over its size cap');
      if (job.outputs.size === 0) {
        await endFailed(job);
        return;
      }
      if (pass === 1) for (const o of job.outputs.values()) o.phase = 'queued';
      wake(job);
      enqueue(job, pass);
      return;
    }
    if (!atUntil && (stalled || exit.exitCode !== 0)) {
      const why = stalled ? `no progress for ${Math.round(stallMs / 1000)} s` : (exit.error ?? `exit ${exit.exitCode ?? exit.signal}`);
      log.warn({ job: job.id, pass, why, stderr: stderr.tail(1024) }, 'subtitle extraction pass failed');
      if (pass === 2) {
        await pass2Failed(job, why);
        return;
      }
      job.attempts += 1;
      // A spawn failure is not worth a second read of the file.
      if (exit.error === null && job.attempts < 2 && !closed) {
        for (const o of outputs) o.phase = 'queued';
        wake(job);
        enqueue(job, 1);
        return;
      }
      await fail(job, why);
      return;
    }
    if (atUntil) log.debug({ job: job.id, untilS: job.untilS }, 'subtitle extraction pass 2 stopped past P₁');
    job.attempts = 0;
    if (pass === 1) await afterPass1(job);
    else await afterPass2(job, atUntil);
  }

  async function firstSeconds(o: Output): Promise<number | null> {
    if (o.format === 'sup') {
      const fh = await open(o.p1, 'r');
      try {
        const head = Buffer.alloc(SUP_HEADER_BYTES);
        const { bytesRead } = await fh.read(head, 0, SUP_HEADER_BYTES, 0);
        const pts = supFirstPts(head.subarray(0, bytesRead));
        return pts === null ? null : pts / 90_000;
      } finally {
        await fh.close();
      }
    }
    const ms = vttFirstCueMs(await readFile(o.p1, 'utf8'));
    return ms === null ? null : ms / 1000;
  }

  async function afterPass1(job: Job): Promise<void> {
    const outputs = [...job.outputs.values()];
    for (const o of outputs) o.phase = 'pass1_done';
    wake(job);
    if (job.startMs === 0) {
      // One pass from 0: pass 1 is the whole extraction (a growing reader keeps its file handle).
      for (const o of outputs) await complete(job, o, o.p1);
      return;
    }
    let until: number | null = null;
    for (const o of outputs) {
      const first = await firstSeconds(o);
      if (first !== null) until = until === null ? first : Math.min(until, first);
    }
    // No cue in pass 1: it covered [K′, end) with K′ ≤ P its keyframe, so pass 2 needs nothing past P.
    job.untilS = until ?? job.startMs / 1000;
    enqueue(job, 2);
  }

  /** truncated: pass 2 was stopped past P₁, so an incomplete last segment (after P₁, dropped anyway) is fine. */
  async function mergeSup(o: Output, out: string, truncated: boolean): Promise<void> {
    const head = Buffer.alloc(SUP_HEADER_BYTES);
    const p1 = await open(o.p1, 'r');
    let firstPts: number | null;
    try {
      const { bytesRead } = await p1.read(head, 0, SUP_HEADER_BYTES, 0);
      firstPts = supFirstPts(head.subarray(0, bytesRead));
    } finally {
      await p1.close();
    }
    const fh = await open(out, 'w');
    try {
      const splitter = new SupSplitter();
      for await (const chunk of createReadStream(o.p2, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
        for (const seg of splitter.push(chunk)) if (keepSupSegment(seg, firstPts)) await writeAll(fh, seg.bytes);
      }
      if (splitter.pending && !truncated) throw new Error(`pass 2 of ${o.key} ends inside a PGS segment`);
      for await (const chunk of createReadStream(o.p1, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) await writeAll(fh, chunk);
    } finally {
      await fh.close();
    }
  }

  async function afterPass2(job: Job, truncated: boolean): Promise<void> {
    for (const o of [...job.outputs.values()]) {
      const merged = join(job.dir, `${o.key}.merged`);
      if (o.format === 'sup') await mergeSup(o, merged, truncated);
      else await writeFile(merged, mergeVtt(await readFile(o.p2, 'utf8'), await readFile(o.p1, 'utf8')));
      await complete(job, o, merged);
    }
  }

  /**
   * The pass-1 files stay served (partial); pass 2 runs again later, up to PASS2_MAX_ATTEMPTS. Then the
   * pass-1 files are final (the cues before P are lost): cached, announced, the job ends.
   */
  async function pass2Failed(job: Job, why: string): Promise<void> {
    if (job.state !== 'active') return;
    job.pass2Attempts += 1;
    for (const o of job.outputs.values()) await rm(o.p2, { force: true }).catch(() => {});
    if (closed) return;
    if (job.pass2Attempts >= PASS2_MAX_ATTEMPTS) {
      log.warn({ job: job.id, fp: job.fp, why, fromS: job.startMs / 1000 }, 'subtitle extraction pass 2 given up: the tracks are kept from P on');
      await keepPass1(job);
      return;
    }
    log.warn({ job: job.id, fp: job.fp, why, retryInMs: pass2RetryMs * job.pass2Attempts }, 'subtitle extraction pass 2 failed, retried later');
    job.pass2Timer = setTimeout(() => {
      job.pass2Timer = null;
      if (job.state === 'active' && !closed) enqueue(job, 2);
    }, pass2RetryMs * job.pass2Attempts);
    job.pass2Timer.unref();
  }

  /**
   * Pass 2 given up: the pass-1 files become the tracks, cached as partial (no cue before P), so a later
   * acquire past failedTtlMs extracts them again while they are served. A file the cache refuses (EMFILE, a
   * full disk) fails that track instead; nothing here throws.
   */
  async function keepPass1(job: Job): Promise<void> {
    let kept = 0;
    for (const o of [...job.outputs.values()]) {
      try {
        await complete(job, o, o.p1, true);
        kept += 1;
      } catch (err) {
        dropOutput(job, o.key, `the pass-1 file was not cached: ${String(err)}`);
      }
    }
    if (job.state === 'active' && job.outputs.size === 0) await endFailed(job, kept > 0 ? 'done' : 'failed');
  }

  async function complete(job: Job, o: Output, file: string, partial = false): Promise<void> {
    await cache.put(job.fp, o.key, file, { partial });
    job.outputs.delete(o.key);
    if (byOutput.get(id(job.fp, o.key)) === job) byOutput.delete(id(job.fp, o.key));
    log.info({ fp: job.fp, track: o.key, partial }, 'subtitle track extracted');
    notify(deps.onComplete, job.fp, o.key);
    if (job.outputs.size === 0) {
      job.state = 'done';
      dropJob(job);
      await removeDir(job);
    }
    wake(job);
  }

  function dropJob(job: Job): void {
    if (job.cancelTimer) clearTimeout(job.cancelTimer);
    job.cancelTimer = null;
    if (job.pass2Timer) clearTimeout(job.pass2Timer);
    job.pass2Timer = null;
    for (const h of job.holders) holderJobs.get(h)?.delete(job);
    job.holders.clear();
  }

  /** One track failed for good: its readers end with an error, its url answers MEDIA_UNAVAILABLE. */
  function dropOutput(job: Job, key: string, why: string): void {
    const o = job.outputs.get(key);
    if (!o) return;
    o.attempt += 1;
    job.outputs.delete(key);
    if (byOutput.get(id(job.fp, key)) === job) byOutput.delete(id(job.fp, key));
    failures.set(id(job.fp, key), now());
    log.warn({ job: job.id, fp: job.fp, track: key, why }, 'subtitle track not extracted');
    notify(deps.onFailed, job.fp, key);
  }

  async function endFailed(job: Job, state: 'failed' | 'done' = 'failed'): Promise<void> {
    job.state = state;
    dropJob(job);
    wake(job);
    await removeDir(job);
  }

  /** Last resort when even the failure handling threw: the job ends failed, in memory only. Never throws. */
  function abandon(job: Job, why: string): void {
    try {
      log.error({ job: job.id, fp: job.fp, why }, 'subtitle extraction abandoned');
      if (job.state !== 'active') return;
      for (const key of [...job.outputs.keys()]) dropOutput(job, key, why);
      job.state = 'failed';
      dropJob(job);
      wake(job);
      void removeDir(job);
    } catch {
      // Nothing left to undo.
    }
  }

  /** A run being stopped; terminate() does not reject, but nothing fire-and-forget may. */
  const kill = (child: ChildLike): void => {
    terminate(child, 'discard').catch((err: unknown) => log.warn({ err: String(err) }, 'subtitle extraction run not stopped'));
  };

  async function fail(job: Job, why: string): Promise<void> {
    if (job.state !== 'active') return;
    for (const key of [...job.outputs.keys()]) dropOutput(job, key, why);
    await endFailed(job);
  }

  async function cancel(job: Job): Promise<void> {
    if (job.state !== 'active') return;
    job.state = 'cancelled';
    for (const key of job.outputs.keys()) if (byOutput.get(id(job.fp, key)) === job) byOutput.delete(id(job.fp, key));
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.job === job) queue.splice(i, 1);
    dropJob(job);
    wake(job);
    if (job.child) await terminate(job.child, 'discard').catch(() => {});
    await removeDir(job);
    log.debug({ job: job.id, fp: job.fp }, 'subtitle extraction cancelled');
  }

  async function openGrowing(job: Job, o: Output): Promise<Readable | null> {
    const attempt = o.attempt;
    let fh: FileHandle;
    try {
      fh = await open(o.p1, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const status = (): FollowStatus => {
      if (o.attempt !== attempt) return 'error';
      if (o.phase === 'pass1_done') return 'end';
      return o.phase === 'pass1' && job.state === 'active' ? 'more' : 'error';
    };
    return new GrowingFile(fh, status, () => waitChange(job, pollMs * 2));
  }

  return {
    cache,

    /** Removes leftovers of a previous process and rebuilds the cache index (damaged files dropped). */
    init: () => cache.init(),

    /** complete: cached, or failed for good (final either way: the url serves the file or answers MEDIA_UNAVAILABLE). */
    availability(stamp: FileStamp, t: ExtractTarget): 'complete' | 'growing' {
      const fp = fingerprint(stamp);
      const key = outputKey(t.streamIndex, t.format);
      return cache.has(fp, key) || failedRecently(fp, key) ? 'complete' : 'growing';
    },

    /**
     * Makes sure every target is cached or being extracted, held by `holder` (a stream). Targets already in a
     * job are shared; the missing ones get one new job from P = max(0, X − SUBTITLE_PREROLL_S).
     */
    acquire(holder: string, file: ExtractFile, targets: readonly ExtractTarget[], startPositionMs: number, opts: AcquireOptions = {}): void {
      if (closed) return;
      const fp = fingerprint(file);
      const missing: ExtractTarget[] = [];
      for (const t of targets) {
        const key = outputKey(t.streamIndex, t.format);
        if ((cache.has(fp, key) && !stalePartial(fp, key)) || failedRecently(fp, key)) continue;
        const j = liveJob(fp, key);
        if (j) addHolder(j, holder);
        else if (!missing.some((m) => m.streamIndex === t.streamIndex && m.format === t.format)) missing.push(t);
      }
      if (missing.length > 0) {
        const jobId = newId();
        const dir = cache.workDir(fp, jobId);
        const preroll = config.SUBTITLE_PREROLL_S * 1000;
        const blocking = opts.blocking === true;
        const startMs = blocking ? 0 : Math.max(0, Math.floor(startPositionMs - preroll));
        const job: Job = {
          id: jobId,
          fp,
          file,
          dir,
          startMs,
          burstMs: startMs > 0 ? Math.max(0, startPositionMs - startMs) : 0,
          readrate: blocking ? null : extractionReadrate(file.sizeBytes, file.durationMs, config.SUBTITLE_EXTRACT_MAX_MBPS),
          blocking,
          outputs: new Map(
            missing.map((t) => {
              const key = outputKey(t.streamIndex, t.format);
              const o: Output = { key, streamIndex: t.streamIndex, format: t.format, p1: join(dir, `p1-${key}.part`), p2: join(dir, `p2-${key}.part`), phase: 'queued', attempt: 0, bytes: 0 };
              return [key, o];
            }),
          ),
          holders: new Set(),
          untilS: null,
          child: null,
          attempts: 0,
          pass2Attempts: 0,
          pass2Timer: null,
          state: 'active',
          cancelTimer: null,
          waiters: new Set(),
        };
        for (const key of job.outputs.keys()) byOutput.set(id(fp, key), job);
        addHolder(job, holder);
        enqueue(job, 1);
      }
      if (opts.ttlMs) {
        const old = holderTtl.get(holder);
        if (old) clearTimeout(old);
        const t = setTimeout(() => this.release(holder), opts.ttlMs);
        t.unref();
        holderTtl.set(holder, t);
      }
    },

    /** The holder no longer needs its tracks; a job nobody holds is cancelled after a grace period. */
    release(holder: string): void {
      const ttl = holderTtl.get(holder);
      if (ttl) clearTimeout(ttl);
      holderTtl.delete(holder);
      const jobs = holderJobs.get(holder);
      holderJobs.delete(holder);
      for (const job of jobs ?? []) {
        job.holders.delete(holder);
        if (job.holders.size > 0 || job.state !== 'active' || preextract || job.cancelTimer) continue;
        // A re-plan stops the old stream before it starts the new one: keep the job meanwhile.
        job.cancelTimer = setTimeout(() => {
          job.cancelTimer = null;
          if (job.holders.size === 0) cancel(job).catch((err: unknown) => log.warn({ job: job.id, err: String(err) }, 'subtitle extraction not cancelled'));
        }, cancelGraceMs);
        job.cancelTimer.unref();
      }
    },

    lookup(stamp: FileStamp, t: ExtractTarget): ExtractionLookup {
      const fp = fingerprint(stamp);
      const key = outputKey(t.streamIndex, t.format);
      if (cache.has(fp, key)) {
        cache.touch(fp, key);
        return { kind: 'complete', path: cache.path(fp, key) };
      }
      if (failedRecently(fp, key)) return { kind: 'failed' };
      const job = liveJob(fp, key);
      const o = job?.outputs.get(key);
      if (!job || !o) return { kind: 'absent' };
      if (o.phase === 'pass1_done') return { kind: 'partial', path: o.p1 };
      if (o.phase === 'pass1') return { kind: 'growing', open: () => openGrowing(job, o) };
      return { kind: 'queued' };
    },

    /** A cached file that vanished: forget it, so the next acquire extracts it again. */
    forget(stamp: FileStamp, t: ExtractTarget): void {
      cache.forget(fingerprint(stamp), outputKey(t.streamIndex, t.format));
    },

    /** Kills every extraction and waits for the passes to end; work files are removed. */
    async shutdown(): Promise<void> {
      closed = true;
      for (const t of holderTtl.values()) clearTimeout(t);
      holderTtl.clear();
      const jobs = new Set([...byOutput.values()].filter((j) => j.state === 'active'));
      for (const e of running) jobs.add(e.job);
      queue.length = 0;
      await Promise.allSettled([...jobs].map((j) => cancel(j)));
      await Promise.allSettled([...runs]);
    },

    /** Tests and diagnostics. */
    get runningCount(): number {
      return running.size;
    },
    get queuedCount(): number {
      return queue.length;
    },
    holdersOf(stamp: FileStamp, t: ExtractTarget): string[] {
      const j = liveJob(fingerprint(stamp), outputKey(t.streamIndex, t.format));
      return j ? [...j.holders] : [];
    },
  };
}

/** more: the writer goes on; end: it finished, every byte is there; error: that attempt failed or restarted. */
type FollowStatus = 'more' | 'end' | 'error';

/**
 * A file another process appends to, as a stream: reads what exists, waits for more, ends once the writer is
 * done (the status is checked before the read, so the last read sees every byte). A writer that fails or
 * starts over destroys the stream with an error, so a client never takes a cut file for a whole one.
 * Destroying it closes the file.
 */
class GrowingFile extends Readable {
  private readonly fh: FileHandle;
  private readonly status: () => FollowStatus;
  private readonly waitMore: () => Promise<void>;
  private readonly buf = Buffer.allocUnsafe(FOLLOW_CHUNK);
  private pos = 0;
  private busy = false;

  constructor(fh: FileHandle, status: () => FollowStatus, waitMore: () => Promise<void>) {
    super();
    this.fh = fh;
    this.status = status;
    this.waitMore = waitMore;
  }

  override _read(): void {
    if (!this.busy) void this.pump();
  }

  private async pump(): Promise<void> {
    this.busy = true;
    try {
      for (;;) {
        if (this.destroyed) return;
        const before = this.status();
        if (before === 'error') throw new Error('the subtitle extraction failed or restarted');
        const { bytesRead } = await this.fh.read(this.buf, 0, this.buf.length, this.pos);
        if (this.destroyed) return;
        // The file may have been truncated for a new attempt during the read.
        if (this.status() === 'error') throw new Error('the subtitle extraction failed or restarted');
        if (bytesRead > 0) {
          this.pos += bytesRead;
          if (!this.push(Buffer.from(this.buf.subarray(0, bytesRead)))) return;
          continue;
        }
        if (before === 'end') {
          this.push(null);
          return;
        }
        await this.waitMore();
      }
    } catch (err) {
      this.destroy(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.busy = false;
    }
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.fh.close().then(
      () => cb(err),
      () => cb(err),
    );
  }
}

async function writeAll(fh: FileHandle, data: Buffer): Promise<void> {
  let off = 0;
  while (off < data.length) {
    const { bytesWritten } = await fh.write(data, off, data.length - off);
    if (bytesWritten <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
    off += bytesWritten;
  }
}

export type SubtitleExtractor = ReturnType<typeof createSubtitleExtractor>;
