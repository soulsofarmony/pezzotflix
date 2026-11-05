// HlsStream against file-system timing, with node:fs/promises mocked (own file, so the mock does not
// touch the other HlsStream tests). M1: a request for the segment whose file is being closed waits for
// it, never restarts the run (the grouper has moved on while fh.close() is pending). m3: a segment that
// cannot be deleted stays in the quota until stop deletes it. m5: short writes are completed.
import { existsSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boxes } from '../src/modules/delivery/bmff.ts';
import { buildGrid } from '../src/modules/delivery/grid.ts';
import { HlsStream, ScratchQuota } from '../src/modules/delivery/hls-stream.ts';
import { fakeFfmpeg } from './helpers/delivery-fake-ffmpeg.ts';

/** The close of the file whose path contains `match` waits until `release()` is called. */
const gate = vi.hoisted(() => {
  const g = { match: null as string | null, hit: false, release: () => {}, held: Promise.resolve(), rmFail: null as string | null, shortWrites: false };
  return {
    g,
    arm(match: string) {
      g.match = match;
      g.hit = false;
      g.held = new Promise<void>((r) => (g.release = r));
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (gate.g.rmFail !== null && String(args[0]).includes(gate.g.rmFail)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return real.rm(...args);
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      const path = String(args[0]);
      const close = fh.close.bind(fh);
      const write = fh.write.bind(fh) as (b: Buffer, off: number, len: number) => Promise<{ bytesWritten: number; buffer: Buffer }>;
      // Short writes: at most 1000 bytes per call, as a pipe or a full disk may do.
      fh.write = ((b: Buffer, off = 0, len = b.length - off) => write(b, off, gate.g.shortWrites ? Math.min(len, 1000) : len)) as typeof fh.write;
      fh.close = async () => {
        if (gate.g.match !== null && path.includes(gate.g.match)) {
          gate.g.hit = true;
          await gate.g.held;
        }
        return close();
      };
      return fh;
    },
  };
});

const KEYFRAMES = Array.from({ length: 30 }, (_, i) => i * 2000);
const DURATION = 60_000;
const grid = buildGrid({ times: KEYFRAMES, positions: KEYFRAMES.map(() => null), durationMs: DURATION, sizeBytes: 1e6 }, { targetMs: 4000, maxMs: 6000, maxBytes: 32 * 1024 * 1024 });
const silent = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {} } as unknown as FastifyBaseLogger;
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

let dir: string | null = null;
let stream: HlsStream | null = null;
afterEach(async () => {
  gate.g.release();
  gate.g.match = null;
  gate.g.rmFail = null;
  gate.g.shortWrites = false;
  await stream?.stop('discard');
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('HlsStream: a request during a segment close', () => {
  it('waits for the closing segment: no relaunch, the bytes come from the original run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pzf-hls-race-'));
    const ff = fakeFfmpeg(KEYFRAMES, DURATION, [{ kind: 'ok' }]);
    stream = new HlsStream({
      streamId: 'st',
      fileId: 'f1',
      dir: join(dir, 'st'),
      grid,
      keyframeTimes: KEYFRAMES,
      preRoll: true,
      argsFor: (seek) => (seek === null ? [] : ['-ss', String(seek.seekS)]),
      audio: null,
      spawn: ff.spawn,
      quota: new ScratchQuota(1e9),
      log: silent,
      now: () => Date.now(),
      aheadMs: 30_000,
      behindMs: 30_000,
      idleKillMs: 60_000,
      waitMs: 4000,
      killGraceMs: 50,
    });
    gate.arm('seg-0-00004.m4s');
    expect((await stream.start(0)).ok).toBe(true);
    expect(await stream.request(0)).toBe('ready');
    // The run reaches segment 5 and holds in the close of segment 4.
    for (let i = 0; i < 200 && !gate.g.hit; i++) await tick();
    expect(gate.g.hit).toBe(true);
    const run = stream.runInfo!;
    expect(run.current).toBe(5);
    expect(stream.isReady(4)).toBe(false);
    // Behind the run's current segment, but it is the one being closed: wait, never restart.
    const pending = stream.request(4);
    await tick(30);
    expect(ff.runs).toHaveLength(1);
    expect(ff.runs[0]!.signals).toEqual([]);
    gate.g.release();
    expect(await pending).toBe('ready');
    expect(stream.segmentRun(4)).toBe(run.id);
    expect(ff.runs).toHaveLength(1);
  });
});

describe('HlsStream: the quota follows the disk (m3)', () => {
  it('an evicted segment that cannot be deleted stays counted; stop deletes it again and releases it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pzf-hls-quota-'));
    const ff = fakeFfmpeg(KEYFRAMES, DURATION, [{ kind: 'ok' }]);
    const quota = new ScratchQuota(1e9);
    stream = new HlsStream({
      streamId: 'st',
      fileId: 'f1',
      dir: join(dir, 'st'),
      grid,
      keyframeTimes: KEYFRAMES,
      preRoll: true,
      argsFor: (seek) => (seek === null ? [] : ['-ss', String(seek.seekS)]),
      audio: null,
      spawn: ff.spawn,
      quota,
      log: silent,
      now: () => Date.now(),
      aheadMs: 4000,
      behindMs: 30_000,
      idleKillMs: 60_000,
      waitMs: 4000,
      killGraceMs: 50,
    });
    expect((await stream.start(0)).ok).toBe(true);
    expect(await stream.request(0)).toBe('ready');
    const path = stream.segmentPath(0)!;
    await tick(50);
    const before = quota.used;
    gate.g.rmFail = 'seg-0-00000.m4s';
    stream.forget(0);
    await tick(20);
    expect(stream.isReady(0)).toBe(false);
    // Still on disk (a response is sending it): still counted.
    expect(quota.used).toBe(before);
    gate.g.rmFail = null;
    await stream.stop('discard');
    expect(quota.used).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});

describe('HlsStream: short writes (m5)', () => {
  it('every byte reaches the segment file when the file system writes less than asked', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pzf-hls-short-'));
    gate.g.shortWrites = true;
    const ff = fakeFfmpeg(KEYFRAMES, DURATION, [{ kind: 'ok' }]);
    stream = new HlsStream({
      streamId: 'st',
      fileId: 'f1',
      dir: join(dir, 'st'),
      grid,
      keyframeTimes: KEYFRAMES,
      preRoll: true,
      argsFor: (seek) => (seek === null ? [] : ['-ss', String(seek.seekS)]),
      audio: null,
      spawn: ff.spawn,
      quota: new ScratchQuota(1e9),
      log: silent,
      now: () => Date.now(),
      aheadMs: 8000,
      behindMs: 30_000,
      idleKillMs: 60_000,
      waitMs: 4000,
      killGraceMs: 50,
    });
    expect((await stream.start(0)).ok).toBe(true);
    expect(await stream.request(1)).toBe('ready');
    const seg = await readFile(stream.segmentPath(1)!);
    expect(seg.length).toBeGreaterThan(1000);
    let end = 0;
    const types: string[] = [];
    for (const b of boxes(seg)) {
      types.push(b.type);
      end = b.end;
    }
    expect(end).toBe(seg.length);
    expect(types[0]).toBe('moof');
    expect(types).toContain('mdat');
  });
});
