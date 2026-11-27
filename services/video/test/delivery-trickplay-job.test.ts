// Trickplay in Stream Delivery (ADR 0009 D4, D5) with a fake ffmpeg: the job (success, short output, exit,
// timeout, deferral while a stream is active, skips, shutdown), the session start (locators from a valid cache,
// else null and the job enqueued), and the sheet route (404/410, index range, name, no-store, no activity).
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { JobContext } from '../src/app/module.ts';
import type { ChildLike, ExitInfo, Spawn } from '../src/modules/delivery/process.ts';
import { closeDb, openDb } from '../src/db/index.ts';
import { TRICKPLAY_JOB_MAX_ATTEMPTS } from '../src/modules/delivery/trickplay.ts';
import { createJobRunner, enqueueJob } from '../src/modules/jobs/index.ts';
import { JOB_TYPES, TRICKPLAY_VERSION, trickplayJobKey } from '../src/shared/job-types.ts';
import type { DirectPlayPlan, VideoSource } from '../src/shared/playback-plan.ts';
import type { StreamHandle } from '../src/shared/ports.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import { tempDir } from './helpers/delivery-media.ts';

const lib = tempDir('pzf-tp-lib-');
mkdirSync(join(lib, 'Play'), { recursive: true });
writeFileSync(join(lib, 'Play', 'Play.mp4'), Buffer.alloc(50_000, 7));
afterAll(() => rmSync(lib, { recursive: true, force: true }));

const DURATION = 125_000; // 13 tiles, one sheet
const video: VideoSource = { streamIndex: 0, codec: 'h264', profile: 'High', width: 1920, height: 1080, frameRate: 24, bitDepth: 8, hdr: 'SDR', hdrFallback: [], dolbyVisionProfile: null, bitRate: null, level: 41 };

const plan = (v: Partial<VideoSource> = {}): DirectPlayPlan => {
  const st = statSync(join(lib, 'Play', 'Play.mp4'));
  return {
    planVersion: 1,
    mode: 'direct_play',
    protocol: 'progressive',
    file: { fileId: 'play', location: { rootName: 'Film', relPath: 'Play/Play.mp4' }, sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs), container: 'mp4', durationMs: DURATION },
    video: { kind: 'original', source: { ...video, ...v } },
    audio: null,
    subtitles: { selected: null, served: [] },
    startPositionMs: 0,
    reasons: [],
    exclusions: [],
  };
};

const payloadOf = (p: DirectPlayPlan) => ({
  fileId: p.file.fileId,
  location: p.file.location,
  sizeBytes: p.file.sizeBytes,
  mtimeMs: p.file.mtimeMs,
  container: p.file.container,
  videoStreamIndex: p.video.source.streamIndex,
  durationMs: p.file.durationMs,
  width: p.video.source.width,
  height: p.video.source.height,
  hdr: p.video.source.hdr,
  hdrFallback: p.video.source.hdrFallback,
  dolbyVisionProfile: p.video.source.dolbyVisionProfile,
});

type Gen = { kind: 'ok'; tiles: number } | { kind: 'exit'; code: number } | { kind: 'hang' } | { kind: 'killed'; signal: NodeJS.Signals };

/** A fake ffmpeg for `-filters` and for the generation: writes the sheets, prints the framecrc. */
class FakeTrickplayFfmpeg {
  gen: Gen = { kind: 'ok', tiles: 13 };
  /** What a full-decode run (no -skip_frame) does; the same as gen when unset. */
  genFull: Gen | null = null;
  tonemapx = true;
  runs: { args: readonly string[]; signals: string[] }[] = [];

  spawn: Spawn = (args) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let exit!: (e: ExitInfo) => void;
    const exited = new Promise<ExitInfo>((r) => (exit = r));
    const finish = (code: number) => {
      stdout.end();
      stderr.end();
      exit({ exitCode: code, signal: null, error: null });
    };
    if (args.includes('-filters')) {
      setImmediate(() => {
        stdout.write(` ... scale             V->V       Scale the input video size.\n${this.tonemapx ? ' .S tonemapx          V->V       SIMD optimized HDR to SDR tonemapping\n' : ''}`);
        finish(0);
      });
      return { stdout, stderr, kill: () => true, exited };
    }
    const run = { args, signals: [] as string[] };
    this.runs.push(run);
    const g = !args.includes('-skip_frame') && this.genFull ? this.genFull : this.gen;
    let ended = false;
    setImmediate(() => {
      if (g.kind === 'hang') return;
      if (g.kind === 'killed') {
        stdout.end();
        stderr.end();
        exit({ exitCode: null, signal: g.signal, error: null });
        ended = true;
        return;
      }
      if (g.kind === 'exit') {
        stderr.write('[matroska @ 0x1] EBML header parsing failed\n');
        finish(g.code);
        ended = true;
        return;
      }
      const out = args.find((a) => a.endsWith('sheet-%d.jpg'))!.replaceAll('%%', '%');
      for (let k = 0; k < Math.ceil(g.tiles / 100); k++) writeFileSync(join(dirname(out), `sheet-${k}.jpg`), `jpeg ${k}`);
      stdout.write('#tb 0: 10/1\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 320x180\n#sar 0: 1/1\n');
      for (let i = 0; i < g.tiles; i++) stdout.write(`0, ${i}, ${i}, 1, 86400, 0x0\n`);
      finish(0);
      ended = true;
    });
    const child: ChildLike = {
      stdout,
      stderr,
      kill(signal) {
        run.signals.push(signal);
        if (!ended) {
          ended = true;
          stdout.destroy();
          stderr.destroy();
          exit({ exitCode: null, signal, error: null });
        }
        return true;
      },
      exited,
    };
    return child;
  };
}

let h: Harness;
let ff: FakeTrickplayFfmpeg;
const log = pino({ level: 'silent' });
const ctx = (attempt = 1, signal = new AbortController().signal): JobContext => ({ jobId: 'j', attempt, log, signal });

async function open(env: Record<string, string> = {}, timings: { timeoutMs?: number; deferMs?: number } = {}) {
  ff = new FakeTrickplayFfmpeg();
  h = await harness([{ name: 'Film', path: lib }], {
    env,
    spawn: () => {
      throw new Error('no stream ffmpeg in these tests');
    },
    trickplaySpawn: ff.spawn,
    trickplayTimings: { deferMs: 300_000, ...timings },
  });
  await h.delivery.initTrickplay();
}

afterEach(async () => {
  await h?.close();
});

const start = async (p: DirectPlayPlan = plan()): Promise<StreamHandle> => {
  const r = await h.delivery.port.start(p, 'sess');
  if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
  return r.handle;
};
const get = (url: string) => h.app.inject({ method: 'GET', url });
const trickplayJobs = () => h.enqueued.filter((j) => j.type === JOB_TYPES.deliveryTrickplay);
const stampDir = (p: DirectPlayPlan) => join(h.dataDir, 'cache', 'delivery', 'trickplay', p.file.fileId, `${p.file.sizeBytes}-${p.file.mtimeMs}-v${TRICKPLAY_VERSION}`);

describe('session start', () => {
  it('without previews: trickplay null, the job enqueued under the analyzer key with the same payload', async () => {
    await open();
    const p = plan();
    const handle = await start(p);
    expect(handle.locators.trickplay).toBeNull();
    expect(trickplayJobs()).toEqual([{ type: 'delivery.trickplay', payload: payloadOf(p), idempotencyKey: trickplayJobKey('play', p.file.sizeBytes, p.file.mtimeMs) }]);
  });

  it('with previews: the sheets under the token, nothing enqueued; a re-plan gets new urls, the old ones answer 410', async () => {
    await open();
    const p = plan();
    await h.delivery.trickplayJob(payloadOf(p), ctx());
    const first = await start(p);
    expect(trickplayJobs()).toEqual([]);
    const base = first.locators.stream.replace(/\/file$/, '');
    expect(first.locators.trickplay).toEqual({ intervalMs: 10_000, tileWidth: 320, tileHeight: 180, columns: 10, rows: 10, count: 13, sheets: [`${base}/trickplay/sheet-0.jpg`] });

    await h.delivery.port.stop(first, 'replanned');
    const second = await start(p);
    expect(second.locators.trickplay!.sheets[0]).not.toBe(first.locators.trickplay!.sheets[0]);
    expect((await get(second.locators.trickplay!.sheets[0]!)).statusCode).toBe(200);
    const old = await get(first.locators.trickplay!.sheets[0]!);
    expect(old.statusCode).toBe(410);
    expect(old.headers['cache-control']).toBe('no-store');
  });

  it('TRICKPLAY_ENABLED=false: no previews, nothing enqueued', async () => {
    await open({ TRICKPLAY_ENABLED: 'false' });
    const handle = await start();
    expect(handle.locators.trickplay).toBeNull();
    expect(trickplayJobs()).toEqual([]);
  });

  it('a file that gets no previews (DV profile 5) or failed for good is not enqueued', async () => {
    await open();
    await h.delivery.port.stop(await start(plan({ codec: 'hevc', hdr: 'DV', hdrFallback: [], dolbyVisionProfile: 5 })), 'stopped');
    expect(trickplayJobs()).toEqual([]);
    ff.gen = { kind: 'exit', code: 1 };
    await h.delivery.trickplayJob(payloadOf(plan()), ctx());
    await start();
    expect(trickplayJobs()).toEqual([]);
  });
});

describe('sheet route', () => {
  it('serves only the sheets of the session, with no-store, without counting as stream activity', async () => {
    await open();
    const p = plan();
    await h.delivery.trickplayJob(payloadOf(p), ctx());
    const handle = await start(p);
    const url = handle.locators.trickplay!.sheets[0]!;
    const r = await get(url);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toBe('jpeg 0');
    expect((await h.delivery.port.status(handle))?.lastRequestAt).toBeNull();

    const base = url.replace(/sheet-0\.jpg$/, '');
    for (const name of ['sheet-1.jpg', 'sheet-01.jpg', 'sheet-9999.jpg']) {
      const x = await get(base + name);
      expect(x.statusCode, name).toBe(404);
      expect(x.headers['cache-control'], name).toBe('no-store');
    }
    // Names outside the contract's pattern never reach the handler.
    for (const name of ['sheet-0.png', 'sheet-12345.jpg', '..%2Fmanifest.json', 'manifest.json']) expect((await get(base + name)).statusCode, name).toBe(400);
    expect((await get(url.replace(/\/s\/[^/]+\//, '/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/'))).statusCode).toBe(404);
  });

  it('404 for a session without previews; 404 when the sheet left the cache', async () => {
    await open();
    const p = plan();
    const without = await start(p);
    expect((await get(without.locators.stream.replace(/\/file$/, '/trickplay/sheet-0.jpg'))).statusCode).toBe(404);
    await h.delivery.port.stop(without, 'stopped');
    await h.delivery.trickplayJob(payloadOf(p), ctx());
    const handle = await start(p);
    rmSync(join(stampDir(p), 'sheet-0.jpg'));
    expect((await get(handle.locators.trickplay!.sheets[0]!)).statusCode).toBe(404);
  });

  it('410 after the stream stopped', async () => {
    await open();
    const p = plan();
    await h.delivery.trickplayJob(payloadOf(p), ctx());
    const handle = await start(p);
    await h.delivery.port.stop(handle, 'stopped');
    expect((await get(handle.locators.trickplay!.sheets[0]!)).statusCode).toBe(410);
  });
});

describe('job', () => {
  it('builds the sheets once: keyframes only, the payload stream; a cached content returns at once', async () => {
    await open();
    const p = plan({ streamIndex: 2 });
    await h.delivery.trickplayJob(payloadOf(p), ctx());
    expect(ff.runs).toHaveLength(1);
    const args = ff.runs[0]!.args;
    expect(args[args.indexOf('-skip_frame') + 1]).toBe('nokey');
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(/^\[0:2\]fps=1\/10:start_time=0/);
    expect(readdirSync(stampDir(p)).sort()).toEqual(['manifest.json', 'sheet-0.jpg']);
    // No working directory left next to the stamp.
    expect(readdirSync(dirname(stampDir(p)))).toEqual([`${p.file.sizeBytes}-${p.file.mtimeMs}-v${TRICKPLAY_VERSION}`]);
    await h.delivery.trickplayJob(payloadOf(p), ctx());
    expect(ff.runs).toHaveLength(1);
  });

  it('a short output from the keyframes falls back to a full decode, without the GOP shift', async () => {
    await open();
    ff.gen = { kind: 'ok', tiles: 1 }; // the H.264 decoder outputs nothing from non-IDR I-frames
    ff.genFull = { kind: 'ok', tiles: 13 };
    const p = plan();
    await h.delivery.trickplayJob(payloadOf(p), ctx());
    expect(ff.runs).toHaveLength(2);
    expect(ff.runs[0]!.args).toContain('-skip_frame');
    const full = ff.runs[1]!.args;
    expect(full).not.toContain('-skip_frame');
    expect(full[full.indexOf('-filter_complex') + 1]).toMatch(/^\[0:\d+\]fps=1\/10:start_time=0/);
    expect(readdirSync(stampDir(p)).sort()).toEqual(['manifest.json', 'sheet-0.jpg']);
  });

  it('a short output of both passes fails for good (recorded, no retry), and so does an ffmpeg exit', async () => {
    await open();
    ff.gen = { kind: 'ok', tiles: 9 }; // 13 expected, 3 may lack
    await expect(h.delivery.trickplayJob(payloadOf(plan()), ctx())).resolves.toBeUndefined();
    const f = await h.delivery.trickplayCache.getFailure({ fileId: 'play', sizeBytes: plan().file.sizeBytes, mtimeMs: plan().file.mtimeMs }, Date.now());
    expect(f).toMatchObject({ permanent: true });
    expect(f!.reason).toMatch(/keyframes only: short output: 9 of 13.*full decode: short output: 9 of 13/s);
    expect(ff.runs).toHaveLength(2);
    await h.delivery.trickplayJob(payloadOf(plan()), ctx());
    expect(ff.runs).toHaveLength(2);
    expect(readdirSync(dirname(stampDir(plan())))).toEqual(['failed.json']);
  });

  it('accepts an output missing up to 30 s at the end', async () => {
    await open();
    ff.gen = { kind: 'ok', tiles: 10 };
    await h.delivery.trickplayJob(payloadOf(plan()), ctx());
    expect((await start()).locators.trickplay?.count).toBe(10);
  });

  it('a slot past the end (or past MAX_TILES) is clamped: the manifest stays valid and the cache is used', async () => {
    await open();
    ff.gen = { kind: 'ok', tiles: 14 }; // 13 expected
    await h.delivery.trickplayJob(payloadOf(plan()), ctx());
    expect((await start()).locators.trickplay).toMatchObject({ count: 13, sheets: [expect.stringMatching(/sheet-0\.jpg$/)] });
    await h.close();

    // 20 000 s: 2000 tiles of 10 s; ffmpeg wrote 2001, 21 sheets.
    await open();
    ff.gen = { kind: 'ok', tiles: 2001 };
    await h.delivery.trickplayJob({ ...payloadOf(plan()), durationMs: 20_000_000 }, ctx());
    const handle = await start();
    expect(handle.locators.trickplay).toMatchObject({ count: 2000 });
    expect(handle.locators.trickplay!.sheets).toHaveLength(20);
    expect(trickplayJobs()).toEqual([]);
    await h.delivery.trickplayJob(payloadOf(plan()), ctx());
    expect(ff.runs).toHaveLength(1);
  });

  it('ffmpeg killed by a signal it was not sent (OOM killer): transient, retried', async () => {
    await open();
    ff.gen = { kind: 'killed', signal: 'SIGKILL' };
    const stamp = { fileId: 'play', sizeBytes: plan().file.sizeBytes, mtimeMs: plan().file.mtimeMs };
    await expect(h.delivery.trickplayJob(payloadOf(plan()), ctx(1))).rejects.toThrow(/killed by SIGKILL/);
    expect(await h.delivery.trickplayCache.getFailure(stamp, Date.now())).toBeNull();
    await expect(h.delivery.trickplayJob(payloadOf(plan()), ctx(TRICKPLAY_JOB_MAX_ATTEMPTS))).rejects.toThrow(/killed by SIGKILL/);
    expect(await h.delivery.trickplayCache.getFailure(stamp, Date.now())).toMatchObject({ permanent: false });
  });

  it('a timeout retries; the last attempt records a transient failure', async () => {
    await open({}, { timeoutMs: 50 });
    ff.gen = { kind: 'hang' };
    const stamp = { fileId: 'play', sizeBytes: plan().file.sizeBytes, mtimeMs: plan().file.mtimeMs };
    await expect(h.delivery.trickplayJob(payloadOf(plan()), ctx(1))).rejects.toThrow(/timed out/);
    expect(ff.runs[0]!.signals).toEqual(['SIGKILL']);
    expect(await h.delivery.trickplayCache.getFailure(stamp, Date.now())).toBeNull();
    await expect(h.delivery.trickplayJob(payloadOf(plan()), ctx(TRICKPLAY_JOB_MAX_ATTEMPTS))).rejects.toThrow(/timed out/);
    expect(await h.delivery.trickplayCache.getFailure(stamp, Date.now())).toMatchObject({ permanent: false });
    // Within its TTL a session start does not enqueue it again.
    await start();
    expect(trickplayJobs()).toEqual([]);
  });

  it('is put off without an attempt while a stream is active', async () => {
    await open({}, { deferMs: 123_000 });
    const handle = await start();
    const err = await h.delivery.trickplayJob(payloadOf(plan()), ctx()).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryAfterMs: 123_000 });
    expect(ff.runs).toHaveLength(0);
    await h.delivery.port.stop(handle, 'stopped');
    await h.delivery.trickplayJob(payloadOf(plan()), ctx());
    expect(ff.runs).toHaveLength(1);
  });

  it('skips DV profile 5, HDR without tonemapx, an unknown duration and a changed file', async () => {
    await open();
    ff.tonemapx = false;
    await h.delivery.initTrickplay();
    await h.delivery.trickplayJob(payloadOf(plan({ hdr: 'DV', hdrFallback: [], dolbyVisionProfile: 5 })), ctx());
    await h.delivery.trickplayJob(payloadOf(plan({ hdr: 'HDR10' })), ctx());
    await h.delivery.trickplayJob({ ...payloadOf(plan()), durationMs: null }, ctx());
    await h.delivery.trickplayJob({ ...payloadOf(plan()), mtimeMs: 1 }, ctx());
    expect(ff.runs).toHaveLength(0);
    // No HDR job from a session start either; SDR still works.
    await h.delivery.port.stop(await start(plan({ hdr: 'HDR10' })), 'stopped');
    expect(trickplayJobs()).toEqual([]);
    await h.delivery.trickplayJob(payloadOf(plan()), ctx());
    expect(ff.runs).toHaveLength(1);
  });

  it('with tonemapx, HDR10 is tone-mapped', async () => {
    await open();
    await h.delivery.trickplayJob(payloadOf(plan({ hdr: 'HDR10', height: 2160, width: 3840 })), ctx());
    expect(ff.runs[0]!.args.join(' ')).toContain('tonemapx=');
  });

  it('shutdown kills a running generation, records nothing and puts the job off; later jobs are put off too', async () => {
    await open();
    ff.gen = { kind: 'hang' };
    const job = h.delivery.trickplayJob(payloadOf(plan()), ctx(TRICKPLAY_JOB_MAX_ATTEMPTS));
    while (ff.runs.length === 0) await new Promise((r) => setTimeout(r, 5));
    await h.delivery.shutdown();
    await expect(job).rejects.toMatchObject({ retryAfterMs: 60_000 });
    await expect(h.delivery.trickplayJob(payloadOf(plan()), ctx())).rejects.toMatchObject({ retryAfterMs: 60_000 });
    expect(ff.runs).toHaveLength(1);
    expect(ff.runs[0]!.signals).toEqual(['SIGKILL']);
    expect(readdirSync(dirname(stampDir(plan())))).toEqual([]);
  });

  it('through the runner: delivery stopping first gives the attempts back, of the running job and of the next', async () => {
    await open();
    ff.gen = { kind: 'hang' };
    const db = await openDb({ path: ':memory:' });
    try {
      const runner = createJobRunner({
        db,
        log,
        jobTypes: new Map([[JOB_TYPES.deliveryTrickplay, { handler: h.delivery.trickplayJob, concurrency: 1, maxAttempts: TRICKPLAY_JOB_MAX_ATTEMPTS }]]),
        periodic: [],
        pollMs: 10,
      });
      const first = enqueueJob(db, Date.now(), { type: JOB_TYPES.deliveryTrickplay, payload: payloadOf(plan()), idempotencyKey: 'tp-1', priority: 1 });
      const second = enqueueJob(db, Date.now(), { type: JOB_TYPES.deliveryTrickplay, payload: payloadOf(plan()), idempotencyKey: 'tp-2', priority: 2 });
      const row = (id: string | null) =>
        db.$client.prepare('SELECT state, attempts, run_at AS runAt FROM job WHERE id = ?').get(id) as { state: string; attempts: number; runAt: number };
      runner.start();
      while (ff.runs.length === 0) await new Promise((r) => setTimeout(r, 5));
      // main.ts order: the modules stop before the runner.
      const stopping = Date.now();
      await h.delivery.shutdown();
      while (row(second).runAt < stopping) await new Promise((r) => setTimeout(r, 5));
      await runner.stop();
      expect(ff.runs).toHaveLength(1);
      expect(ff.runs[0]!.signals).toEqual(['SIGKILL']);
      for (const id of [first, second]) expect(row(id), String(id)).toMatchObject({ state: 'queued', attempts: 0 });
      expect(readdirSync(dirname(stampDir(plan())))).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  it('an orphan working directory of a previous run is deleted at start', async () => {
    await open();
    const orphan = join(dirname(stampDir(plan())), '.tmp-dead');
    mkdirSync(orphan, { recursive: true });
    await h.delivery.initTrickplay();
    expect(readdirSync(dirname(orphan))).toEqual([]);
  });
});
