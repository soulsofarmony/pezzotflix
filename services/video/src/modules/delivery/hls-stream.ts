// One hls-fmp4 stream (ADR 0003 D2–D7): at most one ffmpeg run at a time writes fragmented MP4 on stdout;
// the segmenter cuts it on the playlist's boundaries into per-run files <scratch>/<streamId>/r<run>-seg-0-NNNNN.m4s,
// served once complete. Segments are produced on demand: a request within 3 segments of the run waits
// up to 8 s, anything else restarts the run one GOP before the segment (pre-roll). A run started at k
// replaces every segment from k on, so forward play always stays within one run (no seams but at k).
// Nothing here may reject unobserved: every failure ends in fail() or a log line.
import { mkdir, open, rm, writeFile, rename, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { PlanAudio, PlanExclusion, SuspectDimension } from '../../shared/playback-plan.ts';
import type { StreamFailure, StreamFailureKind } from '../../shared/ports.ts';
import { BmffError, BoxSplitter, type InitInfo, parseInit, type SplitEvent } from './bmff.ts';
import { fmp4MimeType } from './codecs.ts';
import { type RunSeek, seekSeconds } from './ffmpeg-args.ts';
import { type SegmentGrid, segmentStartMs } from './grid.ts';
import { INIT_SEGMENT, segmentName } from './playlist.ts';
import { type ChildLike, type KillMode, type Spawn, terminate } from './process.ts';
import { fragmentKeyframeMs, SegmentGrouper } from './segmenter.ts';
import { classifyStderr, StderrRing } from './stderr.ts';

/** ADR 0003 D6: a request this many segments ahead of the run waits for it instead of restarting. */
export const WAIT_WINDOW_SEGMENTS = 3;

/**
 * Global scratch quota (SCRATCH_MAX_BYTES, ADR 0006), shared by every stream. Bytes count as they are
 * written (partial segments included); nothing is reserved at start.
 */
export class ScratchQuota {
  used = 0;
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  tryAdd(n: number): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }
  release(n: number): void {
    this.used = Math.max(0, this.used - n);
  }
}

export interface HlsStreamOptions {
  streamId: string;
  fileId: string;
  /** Scratch directory of this stream, removed on stop. */
  dir: string;
  grid: SegmentGrid;
  /** Keyframe times of the index, for the pre-roll keyframe Kₖ. */
  keyframeTimes: readonly number[];
  /** Direct Stream starts one GOP early; a Transcode with IDRs forced on the grid does not (F1b.4). */
  preRoll: boolean;
  /** ffmpeg arguments for a run that seeks (or from the start of the file: null). */
  argsFor: (seek: RunSeek | null) => string[];
  audio: PlanAudio | null;
  spawn: Spawn;
  quota: ScratchQuota;
  log: FastifyBaseLogger;
  now: () => number;
  aheadMs: number;
  behindMs: number;
  idleKillMs: number;
  waitMs?: number;
  startTimeoutMs?: number;
  killGraceMs?: number;
}

/** spawnFailed: ffmpeg never ran (missing binary, spawn error), so the failure is the host's, not the plan's. */
export type StartOutcome = { ok: true; mimeType: string; codecs: string[] } | { ok: false; failure: StreamFailure; spawnFailed: boolean };
export type RequestOutcome = 'ready' | 'timeout' | 'failed' | 'gone';

interface ReadySegment {
  bytes: number;
  path: string;
  runId: number;
}

interface Sink {
  segment: number;
  fh: FileHandle;
  path: string;
  /** Bytes written so far, all counted in the quota. */
  bytes: number;
}

interface Run {
  id: number;
  k: number;
  extra: number;
  isRetry: boolean;
  child: ChildLike;
  stderr: StderrRing;
  grouper: SegmentGrouper;
  initParts: Buffer[];
  gotInit: boolean;
  sink: Sink | null;
  /** Segment whose file is being closed: the grouper has moved past it, but it is not ready yet. */
  closing: number | null;
  /** The process never ran (binary missing, spawn error): an infrastructure fault, not the plan's. */
  spawnFailed: boolean;
  killed: boolean;
  done: Promise<void>;
}

type Waiter = (o: RequestOutcome) => void;

const quotaError = (max: number) => Object.assign(new Error(`scratch quota of ${max} bytes exceeded`), { code: 'EQUOTA', syscall: 'write' });

let runSeq = 0;

export class HlsStream {
  readonly opts: HlsStreamOptions;
  private readonly ready = new Map<number, ReadySegment>();
  private init: Buffer | null = null;
  private initInfo: InitInfo | null = null;
  private videoTrackId = 0;
  private run: Run | null = null;
  private readonly dying = new Set<Promise<void>>();
  private retryAvailable = true;
  private started = false;
  private closed = false;
  private terminalFlag = false;
  private lastFailure: StreamFailure | null = null;
  /** The last failure came from a run that never started (see Run.spawnFailed). */
  private lastSpawnFailed = false;
  /** Evicted files a delete could not remove yet (a segment being sent, on Windows): retried at stop. */
  private readonly undeleted = new Map<string, number>();
  private lastRequested = 0;
  private lastRequestAtMs: number | null = null;
  private readonly waiters = new Map<number, Set<Waiter>>();
  private wakers: (() => void)[] = [];
  private startWaiter: ((o: StartOutcome) => void) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private mime: { mimeType: string; codecs: string[] } | null = null;

  constructor(opts: HlsStreamOptions) {
    this.opts = opts;
  }

  get terminal(): boolean {
    return this.terminalFlag;
  }
  get failure(): StreamFailure | null {
    return this.lastFailure;
  }
  get lastRequestAt(): number | null {
    return this.lastRequestAtMs;
  }
  get segmentCount(): number {
    return this.opts.grid.starts.length;
  }
  /** Run currently attached (tests and diagnostics). */
  get runInfo(): { id: number; k: number; current: number | null; extra: number } | null {
    return this.run ? { id: this.run.id, k: this.run.k, current: this.run.grouper.current, extra: this.run.extra } : null;
  }
  isReady(j: number): boolean {
    return this.ready.has(j);
  }
  /** Run that produced a ready segment (tests and diagnostics). */
  segmentRun(j: number): number | null {
    return this.ready.get(j)?.runId ?? null;
  }
  initPath(): string {
    return join(this.opts.dir, INIT_SEGMENT);
  }
  /** File of a ready segment, null when it is not ready. */
  segmentPath(j: number): string | null {
    return this.ready.get(j)?.path ?? null;
  }

  /** Starts the first run at segment k0 and resolves once its init segment is checked (ADR 0003 D11). */
  async start(k0: number): Promise<StartOutcome> {
    await mkdir(this.opts.dir, { recursive: true });
    this.lastRequested = k0;
    // A client that never asks for anything still gets its ffmpeg stopped.
    this.armIdle();
    const outcome = new Promise<StartOutcome>((resolve) => (this.startWaiter = resolve));
    this.launch(k0, 0, false);
    const timeoutMs = this.opts.startTimeoutMs ?? 20_000;
    let timer: NodeJS.Timeout | null = null;
    const watchdog = () => {
      timer = setTimeout(() => {
        const r = this.run;
        if (this.started || this.closed || !r) return;
        this.fail(r, this.failureRecord(r, 'no_output', { segment: r.k }));
        if (!this.started && !this.terminalFlag) watchdog();
      }, timeoutMs);
    };
    watchdog();
    try {
      return await outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A data-plane request for segment j: serve if ready, wait for the run, or restart it (ADR 0003 D6). */
  async request(j: number): Promise<RequestOutcome> {
    if (this.closed) return 'gone';
    this.touch(j);
    if (this.terminalFlag) return 'failed';
    if (this.ready.has(j)) return 'ready';
    this.ensureProducing(j);
    return this.waitFor(j, this.opts.waitMs ?? 8000);
  }

  /** Records a request that is not a segment (playlists, init): counts for the idle timer. */
  touchOther(): void {
    this.lastRequestAtMs = this.opts.now();
    this.armIdle();
  }

  /** A segment that vanished from the scratch between the check and the read: produce it again. */
  forget(j: number): void {
    void this.evict(j);
  }

  async stop(mode: KillMode): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.wake();
    for (const set of this.waiters.values()) for (const w of set) w('gone');
    this.waiters.clear();
    this.startWaiter?.({ ok: false, failure: this.lastFailure ?? this.failureRecord(null, 'no_output', { segment: null }), spawnFailed: this.lastSpawnFailed });
    this.startWaiter = null;
    const r = this.run;
    this.run = null;
    try {
      if (r) await this.killRun(r, mode);
      await Promise.allSettled([...this.dying]);
    } finally {
      for (const r of this.ready.values()) this.undeleted.set(r.path, (this.undeleted.get(r.path) ?? 0) + r.bytes);
      this.ready.clear();
      // The responses that held evicted files are cut by now: delete them again, then the directory.
      for (const [path, bytes] of [...this.undeleted]) if (await this.remove(path)) this.release(path, bytes);
      const gone = await rm(this.opts.dir, { recursive: true, force: true, maxRetries: 3 }).then(
        () => true,
        (err: unknown) => {
          this.opts.log.warn({ streamId: this.opts.streamId, err: String(err) }, 'scratch cleanup failed');
          return false;
        },
      );
      // Bytes that could not be deleted stay counted, so the quota keeps matching the disk.
      if (gone) for (const [path, bytes] of [...this.undeleted]) this.release(path, bytes);
    }
  }

  // ---------------------------------------------------------------- runs

  private seekFor(k: number, extra: number): RunSeek | null {
    const { grid, keyframeTimes, preRoll } = this.opts;
    if (k === 0) return null;
    if (!preRoll) {
      const t = segmentStartMs(grid, k);
      return { seekS: t / 1000, keyframeMs: t };
    }
    // Kₖ: the indexed keyframe just before Bₖ (Cues list every keyframe; with the probe, the one found).
    const i = grid.keyframeIdx[k]! - 1 - extra;
    if (i <= 0) return null;
    return { seekS: seekSeconds(keyframeTimes[i]!, keyframeTimes[i + 1] ?? null), keyframeMs: keyframeTimes[i]! };
  }

  private launch(k: number, extra: number, isRetry: boolean): void {
    // Overwrite policy: from k on, only this run's segments are served.
    for (const j of [...this.ready.keys()]) if (j >= k) void this.evict(j);
    const seek = this.seekFor(k, extra);
    let child: ChildLike;
    try {
      child = this.opts.spawn(this.opts.argsFor(seek));
    } catch (err) {
      this.lastSpawnFailed = true;
      this.markTerminal({ ...this.failureRecord(null, 'process_exit', { segment: k }), stderrTail: `spawn failed: ${String(err)}` });
      return;
    }
    const stderr = new StderrRing();
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.stderr.on('error', () => {});
    const run: Run = {
      id: ++runSeq,
      k,
      extra,
      isRetry,
      child,
      stderr,
      grouper: new SegmentGrouper(this.opts.grid.starts, k),
      initParts: [],
      gotInit: false,
      sink: null,
      closing: null,
      spawnFailed: false,
      killed: false,
      done: Promise.resolve(),
    };
    this.run = run;
    this.opts.log.debug({ streamId: this.opts.streamId, run: run.id, k, seek, extra }, 'ffmpeg run started');
    run.done = this.consume(run);
  }

  /** Never rejects: any error ends as a failure of the run (io_error when nothing more specific). */
  private async consume(run: Run): Promise<void> {
    try {
      await this.consumeRun(run);
    } catch (err) {
      await this.dropSink(run).catch(() => {});
      if (run.killed || this.closed) return;
      run.stderr.push(Buffer.from(`\n${String(err)}\n`));
      this.opts.log.warn({ streamId: this.opts.streamId, run: run.id, err: String(err) }, 'stream run error');
      this.fail(run, this.failureRecord(run, 'io_error', { segment: run.grouper.current ?? run.k }));
    }
  }

  private async consumeRun(run: Run): Promise<void> {
    const splitter = new BoxSplitter();
    let error: { kind: StreamFailureKind; message: string } | null = null;
    try {
      for await (const chunk of run.child.stdout as AsyncIterable<Buffer>) {
        if (run.killed) break;
        for (const ev of splitter.push(chunk)) {
          await this.handle(run, ev);
          if (run.killed) break;
        }
        if (run.killed) break;
        await this.throttle(run);
      }
    } catch (err) {
      if (!run.killed) {
        const io = err instanceof Error && 'code' in err && typeof (err as NodeJS.ErrnoException).syscall === 'string';
        error = { kind: err instanceof BmffError ? 'process_exit' : io ? 'io_error' : 'process_exit', message: String(err) };
        // We stopped reading: ffmpeg would block on the full pipe and never exit.
        run.child.kill('SIGKILL');
        run.child.stdout.destroy();
      }
    }
    const exit = await run.child.exited;
    if (run.killed) {
      await this.dropSink(run);
      return;
    }
    if (!error && exit.exitCode === 0 && splitter.idle) {
      if (!run.gotInit) error = { kind: 'no_output', message: 'ffmpeg ended without an init segment' };
      else if (run.sink) {
        const last = run.sink.segment === this.segmentCount - 1;
        await this.closeSink(run);
        if (!last) error = { kind: 'process_exit', message: 'ffmpeg ended before the last segment' };
      } else if (run.grouper.current === null) {
        error = { kind: 'no_output', message: 'ffmpeg ended before the first kept keyframe' };
      }
    }
    if (!error && exit.exitCode !== 0) error = { kind: 'process_exit', message: exit.error ?? `exit ${exit.exitCode ?? exit.signal}` };
    if (exit.error !== null && exit.exitCode === null && exit.signal === null) run.spawnFailed = true;
    if (!error && !splitter.idle) error = { kind: 'process_exit', message: 'output ended inside a box' };
    await this.dropSink(run);
    if (error) {
      if (error.kind === 'io_error' || exit.error) run.stderr.push(Buffer.from(`\n${error.message}\n`));
      this.fail(run, this.failureRecord(run, error.kind, { segment: run.grouper.current ?? run.k, exitCode: exit.exitCode, signal: exit.signal }));
      return;
    }
    if (this.run === run) this.run = null;
    this.opts.log.debug({ streamId: this.opts.streamId, run: run.id }, 'ffmpeg run reached the end');
  }

  private async handle(run: Run, ev: SplitEvent): Promise<void> {
    if (ev.kind === 'box') {
      if (ev.type === 'ftyp' || ev.type === 'moov') {
        if (run.gotInit) return;
        run.initParts.push(ev.data);
        if (ev.type === 'moov') await this.onInit(run, Buffer.concat(run.initParts));
        return;
      }
      if (ev.type !== 'moof') return; // styp, sidx, free, mfra: not part of the segments
      if (!run.gotInit || !this.initInfo) throw new BmffError('fragment before the init segment');
      const kf = fragmentKeyframeMs(ev.data, this.initInfo, this.videoTrackId);
      const d = run.grouper.place(kf);
      switch (d.action) {
        case 'discard':
          await this.dropSink(run);
          return;
        case 'mismatch':
          this.opts.log.warn({ streamId: this.opts.streamId, segment: d.segment, keyframeMs: d.keyframeMs, expectedMs: d.expectedMs }, 'keyframe not on the expected boundary');
          // Everything up to this fragment belongs to the segment before the missed boundary: keep it.
          if (run.sink && d.segment === run.sink.segment + 1) await this.closeSink(run);
          this.fail(run, this.failureRecord(run, 'restart_mismatch', { segment: d.segment }));
          return;
        case 'open':
          if (d.closes !== null) await this.closeSink(run);
          await this.openSink(run, d.segment);
          break;
        case 'append':
          break;
      }
      await this.write(run, ev.data);
      return;
    }
    if (ev.kind === 'mdat-start') await this.write(run, ev.header);
    else if (ev.kind === 'mdat-data') await this.write(run, ev.data);
  }

  private async onInit(run: Run, init: Buffer): Promise<void> {
    run.gotInit = true;
    if (this.init) {
      // Restarts must give the same init byte for byte (t1, -fflags +bitexact).
      if (!init.equals(this.init)) this.fail(run, this.failureRecord(run, 'init_mismatch', { segment: run.k }));
      return;
    }
    const info = parseInit(init);
    const video = info.tracks.find((t) => t.handler === 'vide');
    if (!video) {
      this.fail(run, this.failureRecord(run, 'no_output', { segment: run.k }));
      return;
    }
    const audio = info.tracks.find((t) => t.handler === 'soun');
    // ADR 0003 D11: never AAC with a PCE (channelConfiguration 0), copied or encoded.
    if (audio?.entry === 'mp4a' && audio.channelConfiguration === 0) {
      this.fail(run, this.failureRecord(run, 'aac_channel_config', { segment: run.k }));
      return;
    }
    this.init = init;
    this.initInfo = info;
    this.videoTrackId = video.id;
    const codecs = [video.codec ?? video.entry, ...(audio ? [audio.codec ?? audio.entry] : [])];
    this.mime = { mimeType: fmp4MimeType(codecs), codecs };
    const part = `${this.initPath()}.part`;
    await writeFile(part, init);
    await rename(part, this.initPath());
    this.started = true;
    this.startWaiter?.({ ok: true, ...this.mime });
    this.startWaiter = null;
  }

  private async openSink(run: Run, segment: number): Promise<void> {
    await this.dropSink(run);
    const path = join(this.opts.dir, `r${run.id}-${segmentName(segment)}`);
    run.sink = { segment, fh: await open(path, 'w'), path, bytes: 0 };
  }

  private async write(run: Run, data: Buffer): Promise<void> {
    const s = run.sink;
    if (!s) return;
    const { quota } = this.opts;
    if (!quota.tryAdd(data.length) && !((await this.evictFor(data.length)) && quota.tryAdd(data.length))) throw quotaError(quota.max);
    s.bytes += data.length;
    // A write may be partial: loop until every byte is in the file.
    let off = 0;
    while (off < data.length) {
      const { bytesWritten } = await s.fh.write(data, off, data.length - off);
      if (bytesWritten <= 0) throw Object.assign(new Error('short write'), { code: 'EIO', syscall: 'write' });
      off += bytesWritten;
    }
  }

  /** Completes the open segment and wakes the requests waiting for it; it replaces an older run's copy. */
  private async closeSink(run: Run): Promise<void> {
    const s = run.sink;
    if (!s) return;
    run.sink = null;
    // Set before the first await: a request for this segment now waits instead of restarting the run (M1).
    run.closing = s.segment;
    try {
      try {
        await s.fh.close();
      } catch (err) {
        await this.discardFile(s);
        throw err;
      }
      if (run.killed || this.closed) {
        await this.discardFile(s);
        return;
      }
      if (this.ready.has(s.segment)) void this.evict(s.segment);
      this.ready.set(s.segment, { bytes: s.bytes, path: s.path, runId: run.id });
      if (run.isRetry) this.retryAvailable = true;
      this.notify(s.segment, 'ready');
    } finally {
      if (run.closing === s.segment) run.closing = null;
    }
  }

  private async dropSink(run: Run): Promise<void> {
    const s = run.sink;
    if (!s) return;
    run.sink = null;
    await s.fh.close().catch(() => {});
    await this.discardFile(s);
  }

  private async discardFile(s: Sink): Promise<void> {
    if (await this.remove(s.path)) this.opts.quota.release(s.bytes);
    else this.undeleted.set(s.path, (this.undeleted.get(s.path) ?? 0) + s.bytes);
  }

  /** Deletes a scratch file; false when it is still there (the quota keeps counting it). */
  private async remove(path: string): Promise<boolean> {
    try {
      await rm(path, { force: true });
      return true;
    } catch (err) {
      this.opts.log.debug({ streamId: this.opts.streamId, err: String(err) }, 'scratch file not removed');
      return false;
    }
  }

  private release(path: string, bytes: number): void {
    this.undeleted.delete(path);
    this.opts.quota.release(bytes);
  }

  /** Backpressure: stop reading stdout while the run is DELIVERY_AHEAD_S ahead of the last request. */
  private async throttle(run: Run): Promise<void> {
    const { grid, aheadMs } = this.opts;
    for (;;) {
      if (run.killed || this.closed) return;
      const cur = run.grouper.current;
      if (cur === null || segmentStartMs(grid, cur) - segmentStartMs(grid, this.lastRequested) < aheadMs) return;
      await new Promise<void>((r) => this.wakers.push(r));
    }
  }

  private wake(): void {
    const w = this.wakers;
    this.wakers = [];
    for (const r of w) r();
  }

  private ensureProducing(j: number): void {
    const r = this.run;
    if (r && !r.killed) {
      const p = r.grouper.current ?? r.k;
      // The segment the run is closing is about to be ready: wait for it, never restart (M1).
      if (j === r.closing || (j >= p && j <= p + WAIT_WINDOW_SEGMENTS)) return;
      this.detach(r, 'discard');
    }
    this.launch(j, 0, false);
  }

  private detach(r: Run, mode: KillMode): void {
    if (this.run === r) this.run = null;
    const p = this.killRun(r, mode).catch((err: unknown) => this.opts.log.warn({ streamId: this.opts.streamId, run: r.id, err: String(err) }, 'ffmpeg run not stopped cleanly'));
    this.dying.add(p);
    void p.then(() => this.dying.delete(p));
  }

  private async killRun(r: Run, mode: KillMode): Promise<void> {
    if (!r.killed) {
      r.killed = true;
      this.wake();
      await terminate(r.child, mode, this.opts.killGraceMs ?? 2000);
    }
    await r.done.catch(() => {});
  }

  private markTerminal(failure: StreamFailure): void {
    failure.terminal = true;
    this.lastFailure = failure;
    this.terminalFlag = true;
    for (const set of this.waiters.values()) for (const w of set) w('failed');
    this.waiters.clear();
    this.startWaiter?.({ ok: false, failure, spawnFailed: this.lastSpawnFailed });
    this.startWaiter = null;
  }

  /**
   * A run failed (ADR 0003 D7). One automatic retry per failure: a restart that missed its keyframe
   * retries one indexed keyframe earlier, never with the same command. A second failure in a row, or a
   * format failure, is terminal: every data-plane request then answers 500 STREAM_FAILED.
   */
  private fail(run: Run, failure: StreamFailure): void {
    if (run.killed || this.closed) return;
    this.lastFailure = failure;
    this.lastSpawnFailed = run.spawnFailed;
    this.detach(run, 'discard');
    this.opts.log.warn(
      { streamId: this.opts.streamId, kind: failure.kind, segment: failure.segment, exitCode: failure.exitCode, stderrClass: failure.stderrClass },
      'stream run failed',
    );
    if (failure.class === 'stream' && this.retryAvailable) {
      this.retryAvailable = false;
      const extra = failure.kind === 'restart_mismatch' || failure.kind === 'init_mismatch' ? run.extra + 1 : run.extra;
      this.launch(failure.segment ?? run.k, extra, true);
      return;
    }
    this.markTerminal(failure);
  }

  private failureRecord(
    run: Run | null,
    kind: StreamFailureKind,
    at: { segment: number | null; exitCode?: number | null; signal?: string | null },
  ): StreamFailure {
    const stderrText = run?.stderr.text() ?? '';
    const stderrClass = run ? classifyStderr(stderrText) : null;
    let cls: StreamFailure['class'] = 'stream';
    let suspect: SuspectDimension = 'unknown';
    let exclusion: PlanExclusion | null = null;
    const audio = this.opts.audio;
    if (kind === 'aac_channel_config') {
      cls = 'format';
      suspect = 'audio';
      exclusion =
        audio?.action.kind === 'convert'
          ? { dimension: 'audio', action: 'convert', codec: 'aac', cause: 'server', error: kind }
          : { dimension: 'audio', action: 'copy', codec: audio?.source.codec ?? 'aac', profile: audio?.source.profile ?? null, cause: 'server', error: kind };
    } else if (kind === 'restart_mismatch' || kind === 'init_mismatch') {
      suspect = 'video';
      exclusion = { dimension: 'video', fileId: this.opts.fileId, mode: 'direct_stream', cause: 'server', error: kind };
    } else if (kind === 'process_exit' && (stderrClass === 'encode' || stderrClass === 'filter') && audio?.action.kind === 'convert') {
      suspect = 'audio';
      exclusion = { dimension: 'audio', action: 'convert', codec: audio.action.codec, cause: 'server', error: kind };
    }
    const segment = at.segment;
    return {
      at: this.opts.now(),
      kind,
      class: cls,
      suspect,
      exclusion,
      exitCode: at.exitCode ?? null,
      signal: at.signal ?? null,
      stderrClass,
      stderrTail: run?.stderr.tail(4096) ?? '',
      positionMs: segment === null ? null : Math.round(segmentStartMs(this.opts.grid, segment)),
      segment,
      terminal: false,
    };
  }

  // ---------------------------------------------------------------- requests

  private touch(j: number): void {
    this.lastRequested = j;
    this.lastRequestAtMs = this.opts.now();
    this.armIdle();
    this.evictAround(j);
    this.wake();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const r = this.run;
      if (r && !this.closed) {
        this.opts.log.debug({ streamId: this.opts.streamId }, 'idle: ffmpeg run stopped');
        this.detach(r, 'graceful');
      }
    }, this.opts.idleKillMs);
    this.idleTimer.unref();
  }

  private waitFor(j: number, ms: number): Promise<RequestOutcome> {
    return new Promise((resolve) => {
      let set = this.waiters.get(j);
      if (!set) this.waiters.set(j, (set = new Set()));
      const w: Waiter = (o) => {
        clearTimeout(timer);
        resolve(o);
      };
      const timer = setTimeout(() => {
        set.delete(w);
        resolve('timeout');
      }, ms);
      set.add(w);
    });
  }

  private notify(j: number, o: RequestOutcome): void {
    const set = this.waiters.get(j);
    if (!set) return;
    this.waiters.delete(j);
    for (const w of set) w(o);
  }

  /** Keeps the window [request − DELIVERY_BEHIND_S, request + DELIVERY_AHEAD_S + 2 segments] in the scratch. */
  private evictAround(j: number): void {
    const { grid, behindMs, aheadMs } = this.opts;
    const at = segmentStartMs(grid, j);
    const lo = at - behindMs;
    const hi = at + aheadMs + 2 * grid.targetDurationS * 1000;
    for (const s of [...this.ready.keys()]) {
      const start = segmentStartMs(grid, s);
      const end = s + 1 < this.segmentCount ? segmentStartMs(grid, s + 1) : grid.durationMs;
      if (end <= lo || start > hi) void this.evict(s);
    }
  }

  /** Frees at least `bytes` by evicting the ready segments farthest from the last request. */
  private async evictFor(bytes: number): Promise<boolean> {
    const keep = new Set([this.lastRequested, this.lastRequested + 1]);
    const order = [...this.ready.keys()].filter((s) => !keep.has(s)).sort((a, b) => Math.abs(b - this.lastRequested) - Math.abs(a - this.lastRequested));
    const evicting: Promise<boolean>[] = [];
    let planned = 0;
    for (const s of order) {
      if (planned >= bytes) break;
      planned += this.ready.get(s)?.bytes ?? 0;
      evicting.push(this.evict(s));
    }
    await Promise.all(evicting);
    return this.opts.quota.used + bytes <= this.opts.quota.max;
  }

  /**
   * Drops a ready segment. Its bytes leave the quota only once the file is deleted: on Windows a segment
   * being sent cannot be removed, so it stays counted and stop() deletes it again. Never rejects.
   */
  private evict(s: number): Promise<boolean> {
    const seg = this.ready.get(s);
    if (!seg) return Promise.resolve(true);
    this.ready.delete(s);
    this.undeleted.set(seg.path, (this.undeleted.get(seg.path) ?? 0) + seg.bytes);
    return this.remove(seg.path).then((ok) => {
      if (ok) this.release(seg.path, seg.bytes);
      return ok;
    });
  }
}
