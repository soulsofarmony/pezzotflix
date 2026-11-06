// The subtitle extractor on its own, with a fake ffmpeg (no tools needed), review rounds 1 to 3 of F1b.4: a
// cancel or shutdown during a pass's prelude never leaves an ffmpeg running (S2), pass 2 is stopped from its
// video clock past P₁ (S1), the read is paced from Node and a stalled pass is killed (N1), the pre-roll burst
// reaches the pass-1 pacer, a burn-in has its own slot (S3), a failed attempt cuts a growing reader with an
// error (4), a failed pass 2 keeps the pass-1 file and runs again, and is given up into a final pass-1 file
// (5, m2) marked partial, extracted again after the failure TTL, never an unhandled rejection when that
// give-up itself fails, a non-zero exit past the bound counts as reaching it, an empty pass 1 bounds pass 2 at
// P (m1), one track over its cap does not cost the others (6), and the cache drops damaged files on init (7).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildLike, ExitInfo, Spawn } from '../src/modules/delivery/process.ts';
import { fingerprint, looksComplete, outputKey, SubtitleCache } from '../src/modules/delivery/subtitle-cache.ts';
import { ClockPacer, clockReader, createSubtitleExtractor, type ExtractFile, type ExtractorDeps, PACE_JUMP_S, PASS2_MARGIN_S } from '../src/modules/delivery/subtitle-extract.ts';
import { type FakeExtractOptions, fakeExtractor, supSegments, vttOf } from './helpers/delivery-fake-extract.ts';
import { tempDir } from './helpers/delivery-media.ts';

const log = pino({ level: process.env.XR_LOG ?? 'silent' });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(5);
  }
}

const FILE: ExtractFile = { fileId: 'f1', sizeBytes: 1e9, mtimeMs: 1, absPath: '/nowhere.mkv', durationMs: 7_200_000, videoStreamIndex: 0 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function extractor(spawn: Spawn, over: Partial<ExtractorDeps> = {}) {
  const cacheDir = tempDir('pzf-xr-');
  dirs.push(cacheDir);
  const done: string[] = [];
  const failed: string[] = [];
  const x = createSubtitleExtractor({
    config: { cacheDir, SUBTITLE_EXTRACT_MAX_MBPS: 15, SUBTITLE_PREROLL_S: 3, SUBTITLE_PREEXTRACT: 'off', SUBTITLE_CACHE_MAX_BYTES: 1e9 },
    log,
    now: Date.now,
    spawn,
    onComplete: (_fp, key) => done.push(key),
    onFailed: (_fp, key) => failed.push(key),
    ...over,
    timings: { pollMs: 20, cancelGraceMs: 0, ...over.timings },
  });
  return { x, done, failed, cacheDir };
}

/** An ffmpeg that only ends when killed; records whether it was spawned after `cancelled` became true. */
function hangingSpawn(state: { cancelled: boolean }) {
  const spawns: { afterCancel: boolean; killed: boolean }[] = [];
  const spawn: Spawn = () => {
    const rec = { afterCancel: state.cancelled, killed: false };
    spawns.push(rec);
    let exit!: (e: ExitInfo) => void;
    const exited = new Promise<ExitInfo>((r) => (exit = r));
    const child: ChildLike = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        rec.killed = true;
        exit({ exitCode: null, signal: 'SIGKILL', error: null });
        return true;
      },
      exited,
    };
    return child;
  };
  return { spawn, spawns };
}

/** A WebVTT file whose cue texts name their start, so a merge keeps the right copy of each. */
const cues = (ms: number[]): string => vttOf(ms, (i) => `at ${ms[i]}`);

const workDirsLeft = (cacheDir: string): number => {
  const root = join(cacheDir, 'delivery', 'subtitles');
  if (!existsSync(root)) return 0;
  return readdirSync(root).reduce((n, d) => n + readdirSync(join(root, d)).length, 0);
};

describe('S2: cancel or shutdown during the prelude of a pass', () => {
  it('shutdown right after acquire: no ffmpeg left running, shutdown returns, no work dir left (20 trials)', async () => {
    for (let trial = 0; trial < 20; trial++) {
      const state = { cancelled: false };
      const { spawn, spawns } = hangingSpawn(state);
      const { x, cacheDir } = extractor(spawn);
      await x.init();
      x.acquire('h', FILE, [{ streamIndex: 3, format: 'sup' }], 0);
      state.cancelled = true;
      const r = await Promise.race([x.shutdown().then(() => 'returned'), tick(1500).then(() => 'hung')]);
      expect(r).toBe('returned');
      expect(spawns.filter((s) => !s.killed)).toEqual([]);
      expect(workDirsLeft(cacheDir)).toBe(0);
    }
  });

  it('release (no grace) right after acquire: the job is cancelled before or right after its spawn, never orphaned', async () => {
    for (let trial = 0; trial < 20; trial++) {
      const state = { cancelled: false };
      const { spawn, spawns } = hangingSpawn(state);
      const { x, cacheDir } = extractor(spawn);
      await x.init();
      x.acquire('h', FILE, [{ streamIndex: 3, format: 'sup' }], 0);
      x.release('h');
      state.cancelled = true;
      await until(() => x.runningCount === 0);
      expect(spawns.filter((s) => !s.killed)).toEqual([]);
      expect(workDirsLeft(cacheDir)).toBe(0);
      await x.shutdown();
    }
  });

  it('a pass 1 queued while a pass 2 is in its prelude preempts it before it spawns', async () => {
    const fx = fakeExtractor({ content: (o, run) => (run.pass === 2 ? vttOf([1000]) : vttOf([18_000])) });
    const { x } = extractor(fx.spawn);
    await x.init();
    x.acquire('a', FILE, [{ streamIndex: 6, format: 'vtt' }], 20_000);
    await until(() => fx.runs.length === 1);
    fx.runs[0]!.release(0);
    // Pass 2 of file A starts its prelude; file B's pass 1 arrives in the same tick.
    await until(() => x.runningCount === 1 && x.queuedCount === 0 && fx.runs.length === 1);
    x.acquire('b', { ...FILE, fileId: 'f2' }, [{ streamIndex: 6, format: 'vtt' }], 0);
    await until(() => fx.runs.length >= 2);
    await tick(50);
    // Only B's pass 1 runs; A's pass 2 waits in the queue.
    expect(fx.runs.filter((r) => !r.ended).map((r) => r.pass)).toEqual([1]);
    expect(fx.runs[1]!.outputs[0]!.path).toContain('f2-');
    await x.shutdown();
  });
});

describe('S1: pass 2 stops past P₁', () => {
  it('reads the clock of framecrc and framehash lines: the #tb header, then the dts of each packet line', () => {
    const read = clockReader();
    expect(read('0,      26000,      26000,       41,    10518, 0x699eed36')).toBeNull();
    expect(read('#tb 0: 1/1000')).toBeNull();
    expect(read('#media_type 0: video')).toBeNull();
    expect(read('0,      26042,      26084,       41,     3604, 0xd8d6fdd5, F=0x0')).toBe(26.042);
    expect(read(`0,      26083,      26125,       41,     3604, ${'ab'.repeat(64)}`)).toBeCloseTo(26.083, 9);
    expect(read('#tb 0: 1/90000')).toBeNull();
    expect(read('0, 900000, 900000, 3754, 100, 0x0')).toBe(10);
  });

  it('pass 2 has no -t but the paced video clock on stdout; killed 0.5 s after its clock passed P₁ + margin, a success, the merge whole', async () => {
    const fx = fakeExtractor({ content: (o, run) => (run.pass === 2 ? cues([1000, 18_000, 19_000]) : cues([18_000, 30_000])) });
    const { x, done } = extractor(fx.spawn);
    await x.init();
    x.acquire('h', FILE, [{ streamIndex: 6, format: 'vtt' }], 20_000);
    await until(() => fx.runs.length === 1);
    // Both passes carry the clock; no ffmpeg read cap.
    expect(fx.runs[0]!.args.join(' ')).toContain('-map 0:0 -c copy -flush_packets 1 -f framehash -hash sha512 pipe:1 -map 0:6 ');
    expect(fx.runs[0]!.args.join(' ')).not.toMatch(/-readrate/);
    fx.runs[0]!.release(0);
    await until(() => fx.runs.length === 2);
    const p2 = fx.runs[1]!;
    expect(p2.pass).toBe(2);
    expect(p2.args).not.toContain('-t');
    expect(p2.args.join(' ')).toContain('-map 0:0 -c copy -flush_packets 1 -f framehash -hash sha512 pipe:1 -map 0:6 ');
    p2.clock(10);
    p2.clock(18 + PASS2_MARGIN_S - 0.1);
    await tick(700);
    expect(p2.signals).toEqual([]);
    // One line past the limit is enough: ffmpeg may then be held by the pipe and write nothing more.
    p2.clock(18 + PASS2_MARGIN_S);
    await tick(300);
    expect(p2.signals).toEqual([]);
    await until(() => done.length === 1);
    expect(p2.signals).toEqual(['SIGKILL']);
    // The cues of pass 2 from P₁ on are pass 1's: dropped by the merge.
    expect(readFileSync(x.cache.path(fingerprint(FILE), 's6.vtt'), 'utf8')).toBe(cues([1000, 18_000, 30_000]));
    await x.shutdown();
  });

  it('a pass 2 that ends by itself before its clock passes the limit is a plain success', async () => {
    const fx = fakeExtractor({ content: (o, run) => (run.pass === 2 ? cues([1000]) : cues([18_000])) });
    const { x, done } = extractor(fx.spawn);
    await x.init();
    x.acquire('h', FILE, [{ streamIndex: 6, format: 'vtt' }], 20_000);
    await until(() => fx.runs.length === 1);
    fx.runs[0]!.release(0);
    await until(() => fx.runs.length === 2);
    fx.runs[1]!.clock(5);
    fx.runs[1]!.release(0);
    await until(() => done.length === 1);
    expect(fx.runs[1]!.signals).toEqual([]);
    expect(readFileSync(x.cache.path(fingerprint(FILE), 's6.vtt'), 'utf8')).toBe(cues([1000, 18_000]));
    await x.shutdown();
  });
});

describe('N1: the read is paced from Node; a stalled pass is killed', () => {
  it('ClockPacer: origin at the first packet, burst, R × elapsed, discontinuities followed', () => {
    const p = new ClockPacer(2, 3);
    const steps: [number, number, number][] = [
      // clock s, now ms, expected wait ms
      [10, 0, 0],
      [12, 0, 0], // inside the burst
      [15, 0, 1000], // (15 − 10 − 3) / 2 s
      [15, 400, 600],
      [14.9, 2000, 0], // a small step back is just a B-frame order
      [1000, 2000, 0], // a jump over PACE_JUMP_S moves the origin with it
      [1000 + PACE_JUMP_S, 2000, 3950], // a step of exactly PACE_JUMP_S is media: (1010 − 995.1 − 3) / 2 s − 2 s
      [500, 2000, 3950], // a step back over PACE_JUMP_S too
    ];
    for (const [clockS, nowMs, wait] of steps) expect(p.delayMs(clockS, nowMs), `${clockS} s at ${nowMs} ms`).toBeCloseTo(wait, 6);
  });

  it('a clock ahead of R × elapsed holds stdout until it is due; held is not stalled, a clock that stops moving is', async () => {
    const fx = fakeExtractor();
    // R = 1.1: a file whose bit rate is far over the cap.
    const slow: ExtractFile = { ...FILE, sizeBytes: 1e13 };
    // Wide margins (a 2 s hold, a 1 s watchdog): event-loop lag under a loaded run must not decide.
    const { x } = extractor(fx.spawn, { timings: { stallMs: 1000 } });
    await x.init();
    x.acquire('h', slow, [{ streamIndex: 3, format: 'sup' }], 0);
    await until(() => fx.runs.length === 1);
    const run = fx.runs[0]!;
    expect(run.paced).toBe(true);
    run.clock(0);
    run.clock(2.2); // due 2 s after the first packet
    await until(() => run.readerPaused());
    const heldAt = Date.now();
    await until(() => !run.readerPaused(), 5000);
    expect(Date.now() - heldAt).toBeGreaterThan(1000);
    // Held for about 2 s against a 1 s watchdog: not killed while held.
    expect(run.signals).toEqual([]);
    // Then nothing moves: killed, and the pass is tried again.
    await until(() => run.signals.length > 0, 5000);
    expect(run.signals).toEqual(['SIGKILL']);
    await until(() => fx.runs.length === 2);
    await x.shutdown();
  }, 20_000);

  it('the pre-roll burst reaches the pass-1 pacer: packets up to X are read at once, the next ones wait', async () => {
    const fx = fakeExtractor();
    const slow: ExtractFile = { ...FILE, sizeBytes: 1e13 };
    const { x } = extractor(fx.spawn);
    await x.init();
    // X = 20 s, pre-roll 3 s: P = 17 s, a burst of 3 media seconds at R = 1.1.
    x.acquire('h', slow, [{ streamIndex: 3, format: 'sup' }], 20_000);
    await until(() => fx.runs.length === 1);
    const run = fx.runs[0]!;
    expect(run.seekS).toBe(17);
    run.clock(17);
    run.clock(19.9); // inside the burst: without it, due 2.6 s later
    await tick(50);
    expect(run.readerPaused()).toBe(false);
    run.clock(21.1); // (21.1 − 17 − 3) / 1.1 = 1 s after the first packet
    await until(() => run.readerPaused());
    await x.shutdown();
  });

  it('a pass whose outputs grow is alive without a clock line', async () => {
    let grow: NodeJS.Timeout | null = null;
    const fx = fakeExtractor();
    const { x } = extractor(fx.spawn, { timings: { stallMs: 1000 } });
    await x.init();
    x.acquire('h', FILE, [{ streamIndex: 6, format: 'vtt' }], 0);
    await until(() => fx.runs.length === 1);
    const path = fx.runs[0]!.outputs[0]!.path;
    let n = 0;
    grow = setInterval(() => writeFileSync(path, vttOf(Array.from({ length: ++n }, (_, i) => i * 1000))), 100);
    await tick(2000);
    clearInterval(grow);
    expect(fx.runs[0]!.signals).toEqual([]);
    await until(() => fx.runs[0]!.signals.length > 0, 5000);
    await x.shutdown();
  }, 20_000);
});

describe('S3: a burn-in has its own slot', () => {
  it('a blocking extraction starts while a capped pass 1 runs, and the capped one is not disturbed', async () => {
    const fx = fakeExtractor();
    const { x } = extractor(fx.spawn);
    await x.init();
    x.acquire('stream', FILE, [{ streamIndex: 3, format: 'sup' }], 600_000);
    await until(() => fx.runs.length === 1);
    x.acquire('burn', FILE, [{ streamIndex: 4, format: 'ass' }], 0, { blocking: true, ttlMs: 60_000 });
    await until(() => fx.runs.length === 2);
    expect(fx.runs[1]!.paced).toBe(false);
    expect(fx.runs[1]!.args).toContain('framecrc');
    expect(fx.runs[1]!.outputs.map((o) => o.format)).toEqual(['ass']);
    expect(fx.runs[0]!.signals).toEqual([]);
    // A second capped job still waits for the capped slot.
    x.acquire('other', { ...FILE, fileId: 'f2' }, [{ streamIndex: 3, format: 'sup' }], 0);
    await tick(60);
    expect(fx.runs).toHaveLength(2);
    await x.shutdown();
  });
});

describe('failures', () => {
  async function drain(r: Readable): Promise<{ data: string; error: string | null }> {
    let data = '';
    try {
      for await (const c of r as AsyncIterable<Buffer>) data += c.toString('utf8');
      return { data, error: null };
    } catch (err) {
      return { data, error: String(err) };
    }
  }

  it('(4) a growing response of an attempt that fails ends with an error, not as a complete file', async () => {
    const fx = fakeExtractor({ content: () => vttOf([1000]) });
    const { x } = extractor(fx.spawn);
    await x.init();
    x.acquire('h', FILE, [{ streamIndex: 6, format: 'vtt' }], 0);
    await until(() => fx.runs.length === 1);
    const found = x.lookup(FILE, { streamIndex: 6, format: 'vtt' });
    expect(found.kind).toBe('growing');
    const body = await (found as Extract<typeof found, { kind: 'growing' }>).open();
    const reading = drain(body!);
    await tick(50);
    fx.runs[0]!.release(1);
    const r = await reading;
    expect(r.error).toMatch(/failed or restarted/);
    await x.shutdown();
  });

  it('(4) a growing response of an attempt that succeeds ends normally with every byte', async () => {
    const fx = fakeExtractor({ content: () => vttOf([1000, 2000]) });
    const { x } = extractor(fx.spawn);
    await x.init();
    x.acquire('h', FILE, [{ streamIndex: 6, format: 'vtt' }], 0);
    await until(() => fx.runs.length === 1);
    const found = x.lookup(FILE, { streamIndex: 6, format: 'vtt' });
    const body = await (found as Extract<typeof found, { kind: 'growing' }>).open();
    const reading = drain(body!);
    await tick(30);
    fx.runs[0]!.release(0);
    expect(await reading).toEqual({ data: vttOf([1000, 2000]), error: null });
    await x.shutdown();
  });

  it('(5) a failed pass 2 keeps serving the pass-1 file and runs again later; the merge then completes', async () => {
    let p2Runs = 0;
    const opts: FakeExtractOptions = { content: (_o, run) => (run.pass === 2 ? cues([1000]) : cues([18_000])), exitAt: (run) => (run.pass === 2 && ++p2Runs === 1 ? 1 : null) };
    const fx = fakeExtractor(opts);
    const { x, done } = extractor(fx.spawn, { timings: { pass2RetryMs: 80 } });
    await x.init();
    x.acquire('h', FILE, [{ streamIndex: 6, format: 'vtt' }], 20_000);
    await until(() => fx.runs.length === 1);
    fx.runs[0]!.release(0);
    await until(() => fx.runs.length === 2 && fx.runs[1]!.ended);
    await tick(20);
    const partial = x.lookup(FILE, { streamIndex: 6, format: 'vtt' });
    expect(partial.kind).toBe('partial');
    expect(readFileSync((partial as { path: string }).path, 'utf8')).toBe(cues([18_000]));
    expect(x.availability(FILE, { streamIndex: 6, format: 'vtt' })).toBe('growing');
    await until(() => fx.runs.length === 3);
    fx.runs[2]!.release(0);
    await until(() => done.length === 1);
    expect(readFileSync(x.cache.path(fingerprint(FILE), 's6.vtt'), 'utf8')).toBe(cues([1000, 18_000]));
    await x.shutdown();
  });

  it('(m2) pass 2 given up: the pass-1 file becomes final, announced, the job ends and its work dir goes', async () => {
    const fx = fakeExtractor({ content: (_o, run) => (run.pass === 2 ? cues([1000]) : cues([18_000])), exitAt: (run) => (run.pass === 2 ? 1 : null) });
    const { x, done, cacheDir } = extractor(fx.spawn, { timings: { pass2RetryMs: 20 } });
    await x.init();
    const t = { streamIndex: 6, format: 'vtt' } as const;
    x.acquire('h', FILE, [t], 20_000);
    await until(() => fx.runs.length === 1);
    fx.runs[0]!.release(0);
    await until(() => done.length === 1, 3000);
    expect(fx.runs.filter((r) => r.pass === 2)).toHaveLength(3);
    expect(readFileSync(x.cache.path(fingerprint(FILE), 's6.vtt'), 'utf8')).toBe(cues([18_000]));
    expect(x.availability(FILE, t)).toBe('complete');
    expect(x.lookup(FILE, t).kind).toBe('complete');
    expect(x.holdersOf(FILE, t)).toEqual([]);
    const fpDir = join(cacheDir, 'delivery', 'subtitles', fingerprint(FILE));
    await until(() => readdirSync(fpDir, { withFileTypes: true }).every((d) => !d.isDirectory()));
    await x.shutdown();
  });

  it('(m2, round 3) the cache refusing the pass-1 file at the give-up fails the track; nothing rejects unobserved', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const fx = fakeExtractor({ content: (_o, run) => (run.pass === 2 ? cues([1000]) : cues([18_000])), exitAt: (run) => (run.pass === 2 ? 1 : null) });
      const { x, done, failed } = extractor(fx.spawn, { timings: { pass2RetryMs: 20 } });
      await x.init();
      x.cache.put = () => Promise.reject(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }));
      const t = { streamIndex: 6, format: 'vtt' } as const;
      x.acquire('h', FILE, [t], 20_000);
      await until(() => fx.runs.length === 1);
      fx.runs[0]!.release(0);
      await until(() => failed.length === 1);
      expect(fx.runs.filter((r) => r.pass === 2)).toHaveLength(3);
      expect(failed).toEqual(['s6.vtt']);
      expect(done).toEqual([]);
      expect(x.lookup(FILE, t).kind).toBe('failed');
      expect(x.holdersOf(FILE, t)).toEqual([]);
      await tick(100);
      expect(x.runningCount).toBe(0);
      await x.shutdown();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('(m2, round 3) the given-up track is cached as partial (marked on disk): served, and extracted again after the failure TTL', async () => {
    let p2Runs = 0;
    const fx = fakeExtractor({ content: (_o, run) => (run.pass === 2 ? cues([1000]) : cues([18_000])), exitAt: (run) => (run.pass === 2 && ++p2Runs <= 3 ? 1 : null) });
    const { x, done, cacheDir } = extractor(fx.spawn, { timings: { pass2RetryMs: 20, failedTtlMs: 300 } });
    await x.init();
    const t = { streamIndex: 6, format: 'vtt' } as const;
    const fp = fingerprint(FILE);
    x.acquire('h', FILE, [t], 20_000);
    await until(() => fx.runs.length === 1);
    fx.runs[0]!.release(0);
    await until(() => done.length === 1);
    expect(x.cache.partialSince(fp, 's6.vtt')).not.toBeNull();
    expect(existsSync(`${x.cache.path(fp, 's6.vtt')}.partial`)).toBe(true);
    // The marker survives a restart.
    const again = new SubtitleCache(cacheDir, 1e9, log, Date.now);
    await again.init();
    expect(again.partialSince(fp, 's6.vtt')).not.toBeNull();
    // Within the TTL: served as it is, nothing extracted.
    const runs = fx.runs.length;
    x.acquire('h2', FILE, [t], 20_000);
    await tick(50);
    expect(fx.runs).toHaveLength(runs);
    // Past it: extracted again, the partial file served meanwhile.
    await tick(300);
    x.acquire('h3', FILE, [t], 20_000);
    await until(() => fx.runs.length === runs + 1);
    expect(x.lookup(FILE, t).kind).toBe('complete');
    expect(x.availability(FILE, t)).toBe('complete');
    fx.runs.at(-1)!.release(0);
    await until(() => fx.runs.length === runs + 2);
    fx.runs.at(-1)!.release(0);
    await until(() => done.length === 2);
    expect(readFileSync(x.cache.path(fp, 's6.vtt'), 'utf8')).toBe(cues([1000, 18_000]));
    expect(x.cache.partialSince(fp, 's6.vtt')).toBeNull();
    expect(existsSync(`${x.cache.path(fp, 's6.vtt')}.partial`)).toBe(false);
    await x.shutdown();
  });

  it('(round 3) pass 2 exiting non-zero once its clock is past P₁ + margin is the stop, not a failure', async () => {
    const fx = fakeExtractor({ content: (_o, run) => (run.pass === 2 ? cues([1000, 18_000]) : cues([18_000, 30_000])) });
    const { x, done } = extractor(fx.spawn);
    await x.init();
    x.acquire('h', FILE, [{ streamIndex: 6, format: 'vtt' }], 20_000);
    await until(() => fx.runs.length === 1);
    fx.runs[0]!.release(0);
    await until(() => fx.runs.length === 2);
    const p2 = fx.runs[1]!;
    p2.clock(10);
    p2.clock(18 + PASS2_MARGIN_S + 1);
    await tick(30);
    // Before the settle stops it.
    p2.release(1);
    await until(() => done.length === 1);
    expect(p2.signals).toEqual([]);
    expect(fx.runs).toHaveLength(2);
    expect(readFileSync(x.cache.path(fingerprint(FILE), 's6.vtt'), 'utf8')).toBe(cues([1000, 18_000, 30_000]));
    await x.shutdown();
  });

  it('(m1) pass 1 without a cue: pass 2 is bounded at P (its clock stops it past P + margin), not read to the end', async () => {
    const fx = fakeExtractor({ content: (_o, run) => (run.pass === 2 ? cues([1000]) : 'WEBVTT\n') });
    const { x, done } = extractor(fx.spawn);
    await x.init();
    x.acquire('h', FILE, [{ streamIndex: 6, format: 'vtt' }], 20_000);
    await until(() => fx.runs.length === 1);
    expect(fx.runs[0]!.seekS).toBe(17);
    fx.runs[0]!.release(0);
    await until(() => fx.runs.length === 2);
    const p2 = fx.runs[1]!;
    p2.clock(17 + PASS2_MARGIN_S);
    await until(() => done.length === 1);
    expect(p2.signals).toEqual(['SIGKILL']);
    expect(readFileSync(x.cache.path(fingerprint(FILE), 's6.vtt'), 'utf8')).toContain('at 1000');
    await x.shutdown();
  });

  it('(6) one track over its cap is dropped; the others run again without it and complete', async () => {
    const fx = fakeExtractor({ content: (o) => (o.format === 'webvtt' ? vttOf([1000, 2000, 3000, 4000]) : supSegments([1000])) });
    const { x, done, failed } = extractor(fx.spawn, { maxOutputBytes: { vtt: 20 } });
    await x.init();
    x.acquire('h', FILE, [{ streamIndex: 3, format: 'sup' }, { streamIndex: 6, format: 'vtt' }], 0);
    await until(() => fx.runs.length === 2);
    expect(fx.runs[0]!.signals).toEqual(['SIGKILL']);
    expect(failed).toEqual(['s6.vtt']);
    expect(x.lookup(FILE, { streamIndex: 6, format: 'vtt' }).kind).toBe('failed');
    expect(x.availability(FILE, { streamIndex: 6, format: 'vtt' })).toBe('complete');
    expect(fx.runs[1]!.outputs.map((o) => o.streamIndex)).toEqual([3]);
    fx.runs[1]!.release(0);
    await until(() => done.length === 1);
    expect(done).toEqual(['s3.sup']);
    await x.shutdown();
  });
});

describe('(7) the cache on init', () => {
  const END = (() => {
    const b = Buffer.alloc(13);
    b.write('PG', 0, 'latin1');
    b[10] = 0x80;
    return b;
  })();

  it('keeps whole files and drops a .sup cut inside a segment or without its END, and text without its header or last line break', async () => {
    const cacheDir = tempDir('pzf-xr-cache-');
    dirs.push(cacheDir);
    const fp = fingerprint(FILE);
    const dir = join(cacheDir, 'delivery', 'subtitles', fp);
    mkdirSync(dir, { recursive: true });
    const whole = Buffer.concat([supSegments([1000, 2000]), END]);
    writeFileSync(join(dir, outputKey(3, 'sup')), whole);
    writeFileSync(join(dir, outputKey(4, 'sup')), whole.subarray(0, whole.length - 5));
    writeFileSync(join(dir, outputKey(5, 'sup')), supSegments([1000]));
    writeFileSync(join(dir, outputKey(6, 'vtt')), vttOf([1000]));
    writeFileSync(join(dir, outputKey(7, 'vtt')), '00:01.000 --> 00:02.000\nno header\n');
    writeFileSync(join(dir, outputKey(8, 'vtt')), vttOf([1000]).slice(0, -1));
    writeFileSync(join(dir, outputKey(9, 'ass')), '[Script Info]\nScriptType: v4.00+\n');
    writeFileSync(join(dir, outputKey(10, 'sup')), '');
    const cache = new SubtitleCache(cacheDir, 1e9, log, Date.now);
    await cache.init();
    const kept = ['s3.sup', 's6.vtt', 's9.ass', 's10.sup'];
    for (const k of ['s3.sup', 's4.sup', 's5.sup', 's6.vtt', 's7.vtt', 's8.vtt', 's9.ass', 's10.sup']) expect(cache.has(fp, k), k).toBe(kept.includes(k));
    expect(readdirSync(dir).sort()).toEqual([...kept].sort());
    expect(await looksComplete(join(dir, 's3.sup'), 'sup')).toBe(true);
  });
});
