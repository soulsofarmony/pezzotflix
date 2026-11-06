// HlsStream with a fake ffmpeg (ADR 0003 D4–D7): wait or restart, pre-roll seek, backpressure, idle
// kill, one retry (one keyframe earlier after a mismatch), terminal failure, request timeout, PCE check.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGrid } from '../src/modules/delivery/grid.ts';
import { HlsStream, type HlsStreamOptions, ScratchQuota } from '../src/modules/delivery/hls-stream.ts';
import { type ChildLike, type ExitInfo, failedChild } from '../src/modules/delivery/process.ts';
import { directStreamArgs } from '../src/modules/delivery/ffmpeg-args.ts';
import type { DirectStreamPlan, PlanAudio } from '../src/shared/playback-plan.ts';
import { audioEntry, esds, fakeInit } from './helpers/delivery-builders.ts';
import { type Behavior, fakeFfmpeg } from './helpers/delivery-fake-ffmpeg.ts';

const KEYFRAMES = Array.from({ length: 30 }, (_, i) => i * 2000); // a keyframe every 2 s, 60 s
const DURATION = 60_000;
const grid = buildGrid({ times: KEYFRAMES, positions: KEYFRAMES.map(() => null), durationMs: DURATION, sizeBytes: 1e6 }, { targetMs: 4000, maxMs: 6000, maxBytes: 32 * 1024 * 1024 });

const silent = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {} } as unknown as FastifyBaseLogger;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const AAC_COPY: PlanAudio = {
  source: { streamIndex: 1, trackId: 'a', codec: 'aac', profile: 'LC', language: 'ita', channels: 6, channelLayout: '5.1', sampleRate: 48_000, bitRate: 640_000 },
  action: { kind: 'copy' },
};

let dir: string;
let streams: HlsStream[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pzf-hls-'));
});
afterEach(async () => {
  await Promise.all(streams.map((s) => s.stop('discard')));
  streams = [];
  await rm(dir, { recursive: true, force: true });
});

function stream(behaviors: Behavior[], over: Partial<HlsStreamOptions> = {}) {
  const ff = fakeFfmpeg(KEYFRAMES, DURATION, behaviors);
  const s = new HlsStream({
    streamId: 'st',
    fileId: 'f1',
    dir: join(dir, 'st'),
    grid,
    keyframeTimes: KEYFRAMES,
    preRoll: true,
    argsFor: (seek) => (seek === null ? [] : ['-ss', String(seek.seekS)]),
    audio: AAC_COPY,
    spawn: ff.spawn,
    quota: new ScratchQuota(1e9),
    log: silent,
    now: () => Date.now(),
    aheadMs: 12_000,
    behindMs: 30_000,
    idleKillMs: 60_000,
    waitMs: 2000,
    killGraceMs: 50,
    ...over,
  });
  streams.push(s);
  return { s, ...ff };
}

describe('HlsStream', () => {
  it('the grid of the fixture: 15 segments of 4 s', () => {
    expect(grid.starts).toEqual(Array.from({ length: 15 }, (_, i) => i * 4000));
  });

  it('starts, writes the init and serves segments in order', async () => {
    const { s, runs } = stream([{ kind: 'ok' }]);
    expect(await s.start(0)).toEqual({ ok: true, mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"', codecs: ['hvc1.2.4.L153.B0', 'mp4a.40.2'] });
    expect((await readFile(s.initPath())).equals(fakeInit())).toBe(true);
    for (let j = 0; j < 3; j++) expect(await s.request(j)).toBe('ready');
    expect(existsSync(s.segmentPath(2)!)).toBe(true);
    expect(s.segmentPath(5)).toBeNull();
    expect(runs.map((r) => r.seek)).toEqual([null]);
  });

  it('backpressure: the run stops reading DELIVERY_AHEAD_S past the last request', async () => {
    const { s, runs } = stream([{ kind: 'ok' }], { aheadMs: 8000 });
    await s.start(0);
    expect(await s.request(0)).toBe('ready');
    await tick(100);
    // Run current at segment 2 (8 s ahead of segment 0): no fragment past it is read.
    expect(s.runInfo?.current).toBe(2);
    expect(runs[0]!.emitted).toBeLessThanOrEqual(6);
    expect(await s.request(3)).toBe('ready'); // within 3 segments: waits for the same run
    expect(runs).toHaveLength(1);
  });

  it('a request beyond the window restarts one GOP before the segment and discards the old run', async () => {
    const { s, runs } = stream([{ kind: 'ok' }], { aheadMs: 8000 });
    await s.start(0);
    await s.request(0);
    expect(await s.request(10)).toBe('ready');
    // B₁₀ = 40 s, Kₖ = 38 s: -ss 38.135 (ADR 0003 D4).
    expect(runs.map((r) => r.seek)).toEqual([null, 38.135]);
    expect(runs[0]!.signals).toEqual(['SIGKILL']);
    expect(s.isReady(9)).toBe(false); // the pre-roll GOP is not a segment
    expect(await s.request(11)).toBe('ready');
    expect(runs).toHaveLength(2);
  });

  it('one retry after a failed run; the retry restarts at the segment that was open (1, Kₖ = 2 s)', async () => {
    const { s, runs } = stream([{ kind: 'exit', after: 4, stderr: '[hevc @ x] Invalid NAL unit size\n' }, { kind: 'ok' }]);
    await s.start(0);
    expect(await s.request(0)).toBe('ready');
    expect(await s.request(2)).toBe('ready');
    expect(runs.map((r) => r.seek)).toEqual([null, 2.135]);
    expect(s.terminal).toBe(false);
    expect(s.failure).toMatchObject({ kind: 'process_exit', class: 'stream', stderrClass: 'decode', segment: 1, positionMs: 4000, exitCode: 1, terminal: false });
  });

  it('two failures in a row are terminal: every request answers failed', async () => {
    const bad: Behavior = { kind: 'exit', after: 2, stderr: '[matroska,webm @ x] Invalid data found when processing input\n' };
    const { s, runs } = stream([bad, bad]);
    await s.start(0);
    expect(await s.request(1)).toBe('failed');
    expect(runs).toHaveLength(2);
    expect(s.terminal).toBe(true);
    expect(s.failure).toMatchObject({ kind: 'process_exit', stderrClass: 'demux', terminal: true });
    expect(s.failure!.stderrTail).toContain('Invalid data found');
    expect(await s.request(0)).toBe('failed');
  });

  it('a restart that misses its keyframe retries one indexed keyframe earlier', async () => {
    const { s, runs } = stream([{ kind: 'ok' }, { kind: 'shift', ms: 500 }, { kind: 'ok' }], { aheadMs: 8000 });
    await s.start(0);
    await s.request(0);
    expect(await s.request(10)).toBe('ready');
    expect(runs.map((r) => r.seek)).toEqual([null, 38.135, 36.135]);
    expect(s.failure).toMatchObject({ kind: 'restart_mismatch', suspect: 'video', segment: 10, exclusion: { dimension: 'video', fileId: 'f1', mode: 'direct_stream' } });
    expect(s.terminal).toBe(false);
  });

  it('a retry one keyframe earlier with converted audio anchors the audio on that earlier keyframe', async () => {
    const audio: PlanAudio = { source: { ...AAC_COPY.source, codec: 'truehd' }, action: { kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 640_000, layout: '5.1' } };
    const plan = { video: { kind: 'copy', source: { streamIndex: 0, codec: 'h264' }, tag: null, dolbyVision: 'none' }, audio } as unknown as DirectStreamPlan;
    const { s, runs } = stream([{ kind: 'ok' }, { kind: 'shift', ms: 500 }, { kind: 'ok' }], { aheadMs: 8000, audio, argsFor: (seek) => directStreamArgs(plan, '/m/a.mkv', seek) });
    await s.start(0);
    await s.request(0);
    expect(await s.request(10)).toBe('ready');
    expect(runs.map((r) => r.seek)).toEqual([null, 38.135, 36.135]);
    expect(s.runInfo).toMatchObject({ extra: 1 });
    // first_pts = floor(K · 48 / 1024) · 1024 samples, K the keyframe the run seeks to (38 s, then 36 s).
    const firstPts = (args: readonly string[]) => /first_pts=(\d+)/.exec(args[args.indexOf('-af') + 1]!)?.[1];
    expect(firstPts(runs[1]!.args)).toBe(String(Math.floor((38_000 * 48) / 1024) * 1024));
    expect(firstPts(runs[2]!.args)).toBe(String(Math.floor((36_000 * 48) / 1024) * 1024));
  });

  it('a restart inside the stream (ensureProducing) replaces the run and serves from the new one', async () => {
    const { s, runs } = stream([{ kind: 'ok' }], { aheadMs: 8000 });
    await s.start(0);
    expect(await s.request(0)).toBe('ready');
    const first = s.runInfo!.id;
    // Far ahead of the run (more than 3 segments): restart there, the old run is killed.
    expect(await s.request(9)).toBe('ready');
    expect(runs).toHaveLength(2);
    expect(runs[0]!.signals).toEqual(['SIGKILL']);
    expect(s.segmentRun(9)).not.toBe(first);
    expect(s.segmentRun(9)).toBe(s.runInfo!.id);
  });

  it('a request that the run does not reach in time answers timeout (503 upstream)', async () => {
    const { s } = stream([{ kind: 'hang' }], { waitMs: 50 });
    expect((await s.start(0)).ok).toBe(true);
    expect(await s.request(0)).toBe('timeout');
  });

  it('the idle timer stops the run gracefully, even when nothing was ever requested', async () => {
    const { s, runs } = stream([{ kind: 'hang' }], { idleKillMs: 30 });
    await s.start(0);
    await tick(120);
    expect(runs[0]!.signals[0]).toBe('SIGTERM');
    expect(s.runInfo).toBeNull();
  });

  it('a restart replaces the segments after it: forward play stays within one run', async () => {
    const { s } = stream([{ kind: 'ok' }], { aheadMs: 8000 });
    await s.start(0);
    expect(await s.request(0)).toBe('ready');
    const runA = s.runInfo!.id;
    expect(await s.request(10)).toBe('ready');
    expect(await s.request(11)).toBe('ready');
    const runB = s.runInfo!.id;
    expect(s.segmentRun(10)).toBe(runB);
    // Back to 3: run C starts at 3 and run B's 10, 11 are dropped, so no later segment mixes runs.
    expect(await s.request(3)).toBe('ready');
    const runC = s.runInfo!.id;
    expect(new Set([runA, runB, runC]).size).toBe(3);
    expect(s.segmentRun(3)).toBe(runC);
    expect(s.isReady(10)).toBe(false);
    expect(s.isReady(11)).toBe(false);
    expect(await s.request(4)).toBe('ready');
    expect(s.segmentRun(4)).toBe(runC);
  });

  it('a mismatch at a later boundary keeps the segment before it, then retries', async () => {
    const { s, runs } = stream([{ kind: 'shiftAfter', fromMs: 4000, ms: 500 }, { kind: 'ok' }]);
    await s.start(0);
    const runA = s.runInfo!.id;
    expect(await s.request(1)).toBe('ready');
    expect(s.segmentRun(0)).toBe(runA);
    expect(s.failure).toMatchObject({ kind: 'restart_mismatch', segment: 1 });
    expect(runs).toHaveLength(2);
  });

  it('a full scratch quota: io_error, retried once, then terminal; no unhandled rejection; stop cleans up', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const quota = new ScratchQuota(1000); // a fragment of the fake is ~6 KB
      const { s, runs } = stream([{ kind: 'ok' }], { quota });
      expect((await s.start(0)).ok).toBe(true);
      expect(await s.request(0)).toBe('failed');
      expect(runs).toHaveLength(2);
      expect(s.failure).toMatchObject({ kind: 'io_error', terminal: true, exclusion: null });
      expect(s.failure!.stderrTail).toContain('quota');
      await s.stop('graceful');
      expect(existsSync(join(dir, 'st'))).toBe(false);
      expect(quota.used).toBe(0);
      await tick(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('AAC with a PCE (channelConfiguration 0) is a terminal format failure with an audio exclusion', async () => {
    const pce = fakeInit({ audio: audioEntry('mp4a', esds(0)) });
    const { s, runs } = stream([{ kind: 'init', init: pce }]);
    const r = await s.start(0);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.failure).toMatchObject({
      kind: 'aac_channel_config',
      class: 'format',
      suspect: 'audio',
      terminal: true,
      exclusion: { dimension: 'audio', action: 'copy', codec: 'aac', profile: 'LC', cause: 'server', error: 'aac_channel_config' },
    });
    expect(runs).toHaveLength(1);
  });

  it('infrastructure faults carry no exclusion: a missing ffmpeg is process_exit without exit code or signal', async () => {
    const { s } = stream([{ kind: 'ok' }], { spawn: () => failedChild('ffmpeg not found: /nope') });
    const r = await s.start(0);
    expect(r.ok ? null : r.failure).toMatchObject({ kind: 'process_exit', exitCode: null, signal: null, exclusion: null, class: 'stream', terminal: true });
    expect(r.ok ? '' : r.failure.stderrTail).toContain('ffmpeg not found');
  });

  it('a run that never writes an init fails start with no_output after the retry', async () => {
    let spawned = 0;
    const silentChild = (): ChildLike => {
      spawned++;
      let exit!: (e: ExitInfo) => void;
      const stdout = new Readable({ read() {} });
      return {
        stdout,
        stderr: new Readable({ read() {} }),
        kill(signal) {
          stdout.destroy();
          exit({ exitCode: null, signal, error: null });
          return true;
        },
        exited: new Promise((r) => (exit = r)),
      };
    };
    const { s } = stream([], { startTimeoutMs: 30, spawn: silentChild });
    expect(await s.start(0)).toMatchObject({ ok: false, failure: { kind: 'no_output', terminal: true } });
    expect(spawned).toBe(2);
  });

  it('pre-roll by segment (Transcode): a restart at k runs from Bₖ₋₁ and drops it; a mismatch retries one more segment earlier', async () => {
    const { s, runs } = stream([{ kind: 'ok' }, { kind: 'shift', ms: 500 }, { kind: 'ok' }], { aheadMs: 8000, preRoll: 'segment' });
    await s.start(0);
    await s.request(0);
    expect(await s.request(10)).toBe('ready');
    // B₉ = 36 s, then B₈ = 32 s after the mismatch at B₁₀.
    expect(runs.map((r) => r.seek)).toEqual([null, 36, 32]);
    expect(s.isReady(9)).toBe(false);
    expect(s.isReady(8)).toBe(false);
    expect(s.failure).toMatchObject({ kind: 'restart_mismatch', segment: 10 });
    // k = 1: the pre-roll segment is the start of the file, no seek.
    const { s: s1, runs: r1 } = stream([{ kind: 'ok' }], { preRoll: 'segment' });
    await s1.start(1);
    expect(r1.map((r) => r.seek)).toEqual([null]);
    expect(await s1.request(1)).toBe('ready');
    expect(s1.isReady(0)).toBe(false);
  });

  it('a retry that only produces the segment it failed at again does not re-arm the retry (T1: no endless restarts)', async () => {
    // The stream ends at 50 s, in segment 12 of a 60 s grid: each run ends "before the last segment".
    const short = fakeFfmpeg(KEYFRAMES.filter((k) => k < 50_000), 50_000, [{ kind: 'ok' }]);
    const { s } = stream([{ kind: 'ok' }], { spawn: short.spawn, aheadMs: 120_000 });
    await s.start(0);
    expect(await s.request(12)).toBe('ready');
    expect(await s.request(13)).toBe('failed');
    await tick(100);
    // The restart at 12, then one retry at 12 that closes 12 again: no third attempt (it used to loop).
    expect(short.runs.map((r) => r.seek)).toEqual([null, 46.135, 46.135]);
    expect(s.terminal).toBe(true);
    expect(s.failure).toMatchObject({ kind: 'process_exit', segment: 12, terminal: true });
  });

  it('stop removes the scratch and later requests answer gone', async () => {
    const { s } = stream([{ kind: 'ok' }]);
    await s.start(0);
    await s.request(0);
    await s.stop('graceful');
    expect(existsSync(join(dir, 'st'))).toBe(false);
    expect(await s.request(0)).toBe('gone');
  });
});
