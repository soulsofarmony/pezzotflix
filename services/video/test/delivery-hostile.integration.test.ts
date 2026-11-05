// Hostile container headers and a Blu-ray-like MPEG-TS over real ffmpeg/ffprobe, on fixtures generated
// in a temp dir: a declared Duration of 31 years with and without Cues (bounded index, grid and probe
// time), and an .m2ts whose timestamps start at ~600 s (the seek probe keeps the keyframe at or after
// each seek, the index is zero-based, segments start on their boundaries). Skipped without ffmpeg.
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGrid } from '../src/modules/delivery/grid.ts';
import { BAD_DURATION_ADVICE, buildKeyframeIndex, NO_CUES_ADVICE } from '../src/modules/delivery/keyframe-index.ts';
import { createDeliveryProbe } from '../src/modules/delivery/probe.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import {
  directStreamPlan,
  factsOf,
  FFPROBE,
  hideMkvCues,
  makeShortFixture,
  makeTsStartFixture,
  parseInit,
  patchMkvDuration,
  samplesOf,
  skipNotice,
  tempDir,
} from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-hostile', false);
const GRID = { targetMs: 4000, maxMs: 6000, maxBytes: 32 * 1024 * 1024 };
/** 10¹² ticks of 1 ms: 31 years. */
const HUGE = 1e12;

describe.skipIf(skip !== null)('delivery: hostile headers and MPEG-TS', () => {
  let root: string;
  const probe = createDeliveryProbe(FFPROBE);

  beforeAll(async () => {
    root = tempDir('pzf-hostile-');
    await Promise.all([makeShortFixture(join(root, 'base.mkv')), makeTsStartFixture(join(root, 'bd.m2ts'))]);
    const base = readFileSync(join(root, 'base.mkv'));
    writeFileSync(join(root, 'hugedur-cues.mkv'), patchMkvDuration(base, HUGE));
    writeFileSync(join(root, 'hugedur-nocues.mkv'), hideMkvCues(patchMkvDuration(base, HUGE)));
  }, 120_000);
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const input = (name: string, allowProbe: boolean, container = 'matroska') => {
    const abs = join(root, name);
    const st = statSync(abs);
    return { fileId: 'x', sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs), absPath: abs, container, videoStreamIndex: null, allowProbe, targetMs: 4000, maxGapMs: 6000, now: Date.now };
  };

  it('a 31-year Duration with Cues: the index keeps the keyframes and replaces the duration, at once', async () => {
    const t0 = performance.now();
    const built = await buildKeyframeIndex(input('hugedur-cues.mkv', false), probe);
    if (!built.ok) throw new Error(JSON.stringify(built));
    expect(built.index).toMatchObject({ source: 'cues', complete: true, advice: BAD_DURATION_ADVICE });
    expect(built.index.times).toHaveLength(5);
    // The last keyframe (8 s) plus a median GOP (2 s).
    expect(built.index.durationMs).toBeCloseTo(10_000, -1);
    const grid = buildGrid({ ...built.index, sizeBytes: statSync(join(root, 'hugedur-cues.mkv')).size }, GRID);
    expect(grid.starts).toEqual([0, 4000, 8000]);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('a 31-year Duration without Cues: needs the probe; the probe stops at the end of the content', async () => {
    const quick = await buildKeyframeIndex(input('hugedur-nocues.mkv', false), probe);
    expect(quick).toMatchObject({ ok: false, reason: 'needs_probe', advice: NO_CUES_ADVICE, videoStreamIndex: 0 });
    const t0 = performance.now();
    const built = await buildKeyframeIndex(input('hugedur-nocues.mkv', true), probe);
    if (!built.ok) throw new Error(JSON.stringify(built));
    expect(performance.now() - t0).toBeLessThan(30_000);
    expect(built.index.source).toBe('probe');
    // One packet per seek (M5): the keyframes the 4 s targets land on, not every one of the 2 s GOPs.
    expect(built.index.times.map((t) => Math.round(t))).toEqual([0, 4000, 8000]);
    expect(built.index.complete).toBe(false);
    // No plausible duration: the last keyframe plus the median gap of those found, at most one target long.
    expect(built.index.durationMs).toBeGreaterThanOrEqual(10_000);
    expect(built.index.durationMs).toBeLessThanOrEqual(12_000);
    expect(built.index.advice).toContain(BAD_DURATION_ADVICE);
  }, 60_000);

  describe('MPEG-TS starting at ~600 s', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await harness([{ name: 'Film', path: root }]);
    });
    afterAll(async () => h?.close());

    it('the probe index is zero-based and matches a linear scan; segments start on their boundaries', async () => {
      const facts = await factsOf(join(root, 'bd.m2ts'), { rootName: 'Film', relPath: 'bd.m2ts' });
      expect(facts.container).toMatch(/mpegts/);
      const plan = directStreamPlan('bd', facts);
      expect(await h.delivery.port.start(plan, 's')).toMatchObject({ ok: false, code: 'STREAM_PREPARING' });
      const job = h.enqueued.find((j) => j.idempotencyKey?.startsWith('keyframes-now:bd:'))!;
      await h.delivery.keyframeJob(job.payload, { jobId: 'j', attempt: 1, log: pino({ level: 'silent' }), signal: new AbortController().signal });
      const ix = (await h.delivery.cache.get({ fileId: 'bd', sizeBytes: facts.sizeBytes, mtimeMs: facts.mtimeMs }, plan.video.source.streamIndex))!;
      // MPEG-TS is read in windows, not seeked: every keyframe is found, so the index is complete.
      expect(ix).toMatchObject({ source: 'probe', complete: true });
      expect(ix.startTimeMs).toBeGreaterThan(600_000);
      expect(ix.startTimeMs).toBeLessThan(602_000);

      // Every keyframe of a linear read (no seek), zero-based, against the index.
      const { stdout } = await execa(FFPROBE, [
        '-v', 'error', '-select_streams', String(ix.videoStreamIndex), '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', '-i', `file:${join(root, 'bd.m2ts')}`,
      ]);
      const scanned = stdout
        .split(/\r?\n/)
        .filter((l) => l.includes('K'))
        .map((l) => Number(l.split(',')[0]) * 1000 - ix.startTimeMs);
      expect(scanned.length).toBe(5);
      for (const t of ix.times) expect(scanned.some((s) => Math.abs(s - t) <= 1), `${t} ms is a real keyframe`).toBe(true);
      expect(ix.times[0]).toBeLessThan(50);
      expect(ix.times.length).toBe(scanned.length);

      const r = await h.delivery.port.start(plan, 's');
      if (!r.ok) throw new Error(JSON.stringify(r));
      const base = r.handle.locators.stream.replace(/main\.m3u8$/, '');
      const init = parseInit((await h.app.inject({ method: 'GET', url: `${base}init-0.mp4` })).rawPayload);
      const video = init.tracks.find((t) => t.handler === 'vide')!.id;
      const names = (await h.app.inject({ method: 'GET', url: `${base}media-0.m3u8` })).body.split('\n').filter((l) => l.endsWith('.m4s'));
      const starts = (h.delivery.streamOf(r.handle.streamId)!.hls as unknown as { opts: { grid: { starts: number[] } } }).opts.grid.starts;
      // The last segment first (a restart), then the first.
      for (const j of [names.length - 1, 0]) {
        const seg = await h.app.inject({ method: 'GET', url: `${base}${names[j]}` });
        if (seg.statusCode !== 200) throw new Error(`${names[j]}: ${JSON.stringify(await h.delivery.port.status({ streamId: r.handle.streamId }))}`);
        const v = samplesOf(seg.rawPayload, init).filter((s) => s.track === video);
        expect(v[0]!.sync, names[j]).toBe(true);
        expect(Math.abs(v[0]!.pts - starts[j]!), `${names[j]} starts on its boundary`).toBeLessThanOrEqual(1);
      }
      await h.delivery.port.stop({ streamId: r.handle.streamId }, 'stopped');
    }, 120_000);
  });
});
