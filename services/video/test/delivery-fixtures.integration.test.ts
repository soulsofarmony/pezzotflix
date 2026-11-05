// Direct Stream over real ffmpeg on generated fixtures (temp dir, never the repo or media-samples):
// restart vs run from 0 on an open-GOP x265 at 23.976 and on a file with start_time 3.5 s, the
// zero-based index (Cues and probe), the AAC PCE check and the 5.1 layout of an encode, and a doctored
// index that makes the stream terminal. Skipped with a message when ffmpeg/ffprobe are missing.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseInit } from '../src/modules/delivery/bmff.ts';
import type { MediaFacts } from '../src/shared/media-facts.ts';
import type { StreamHandle } from '../src/shared/ports.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import {
  directStreamPlan,
  factsOf,
  HAVE_X265,
  makeOpenGopFixture,
  makePceFixture,
  makeStartTimeFixture,
  restartDiff,
  samplesOf,
  skipNotice,
  tempDir,
} from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-fixtures', false);
if (!skip && !HAVE_X265) process.stderr.write('[delivery-fixtures] open-GOP x265 tests skipped: this ffmpeg has no libx265\n');

describe.skipIf(skip !== null)('delivery: generated fixtures', () => {
  let root: string;
  let h: Harness;
  const facts = new Map<string, MediaFacts>();

  beforeAll(async () => {
    root = tempDir('pzf-fixtures-');
    const jobs: Promise<void>[] = [makeStartTimeFixture(join(root, 'start.mkv')), makeStartTimeFixture(join(root, 'start.mp4')), makePceFixture(join(root, 'pce.mkv'))];
    if (HAVE_X265) jobs.push(makeOpenGopFixture(join(root, 'opengop.mkv')));
    await Promise.all(jobs);
    for (const rel of ['start.mkv', 'start.mp4', 'pce.mkv', ...(HAVE_X265 ? ['opengop.mkv'] : [])]) facts.set(rel, await factsOf(join(root, rel), { rootName: 'Film', relPath: rel }));
    h = await harness([{ name: 'Film', path: root }]);
  }, 300_000);
  afterAll(async () => {
    await h?.close();
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const get = (url: string) => h.app.inject({ method: 'GET', url });
  const base = (handle: StreamHandle) => handle.locators.stream.replace(/main\.m3u8$/, '');
  const names = async (handle: StreamHandle) => (await get(`${base(handle)}media-0.m3u8`)).body.split('\n').filter((l) => l.endsWith('.m4s'));
  const gridOf = (handle: StreamHandle) =>
    (h.delivery.streamOf(handle.streamId)!.hls as unknown as { opts: { grid: { starts: number[]; durationMs: number } } }).opts.grid;
  const start = async (rel: string, fileId: string, opts: Parameters<typeof directStreamPlan>[2] = {}) =>
    h.delivery.port.start(directStreamPlan(fileId, facts.get(rel)!, opts), `s-${fileId}`);
  const startOk = async (rel: string, fileId: string, opts: Parameters<typeof directStreamPlan>[2] = {}): Promise<StreamHandle> => {
    const r = await start(rel, fileId, opts);
    if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
    return r.handle;
  };
  const stop = (handle: StreamHandle) => h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');

  /**
   * Every segment of a run from 0, then restarts: at `at`, or in every segment k >= 1 ('every'). Each
   * restart must give the same init and, for its first three segments, the restart rule (ADR 0003 D4).
   */
  async function restartMatches(rel: string, fileId: string, at: number | 'every', audio: Parameters<typeof directStreamPlan>[2] = {}) {
    const full = await startOk(rel, fileId, audio);
    const list = await names(full);
    const fullInit = (await get(`${base(full)}init-0.mp4`)).rawPayload;
    const init = parseInit(fullInit);
    const video = init.tracks.find((t) => t.handler === 'vide')!.id;
    const grid = gridOf(full);
    const starts = grid.starts;
    const segs: Buffer[] = [];
    for (const [j, n] of list.entries()) {
      const r = await get(`${base(full)}${n}`);
      expect(r.statusCode, n).toBe(200);
      const v = samplesOf(r.rawPayload, init).filter((s) => s.track === video);
      expect(v[0]!.sync, n).toBe(true);
      if (j > 0) expect(Math.abs(v[0]!.pts - starts[j]!), `${n} starts on Bj`).toBeLessThanOrEqual(1);
      segs.push(r.rawPayload);
    }
    await stop(full);

    // Mid-segment positions, so each lands in segment k whatever the rounding at the boundary.
    const positions =
      at === 'every' ? starts.slice(1).map((s, i) => ({ ms: Math.round((s + (starts[i + 2] ?? grid.durationMs)) / 2), k: i + 1 })) : [{ ms: at, k: null as number | null }];
    for (const pos of positions) {
      const re = await startOk(rel, fileId, { ...audio, startPositionMs: pos.ms });
      const k = h.delivery.streamOf(re.streamId)!.hls!.runInfo!.k;
      if (pos.k !== null) expect(k, `restart at ${pos.ms} ms`).toBe(pos.k);
      else expect(k).toBeGreaterThan(0);
      expect((await get(`${base(re)}init-0.mp4`)).rawPayload.equals(fullInit)).toBe(true);
      for (let j = k; j < Math.min(k + 3, list.length); j++) {
        const r = await get(`${base(re)}${list[j]}`);
        expect(r.statusCode, list[j]).toBe(200);
        const diff = restartDiff(r.rawPayload, segs[j]!, init);
        expect(diff, `${list[j]} after a restart at ${pos.ms} ms (k=${k})`).toEqual([]);
      }
      await stop(re);
    }
    return { starts, count: list.length };
  }

  it.skipIf(!HAVE_X265)('open-GOP x265 at 23.976 (AC-3 copy): a restart in every segment matches the run from 0', async () => {
    const { starts, count } = await restartMatches('opengop.mkv', 'og', 'every');
    expect(count).toBeGreaterThanOrEqual(7);
    // Boundaries are keyframes (keyint 29 at 24000/1001): multiples of 1209.58 ms, never on n·4 s exactly.
    for (const s of starts.slice(1)) expect(Math.abs(s / (29_000 / 23.976) - Math.round(s / (29_000 / 23.976)))).toBeLessThan(0.01);
  }, 180_000);

  it('start_time 3.5 s (MKV, Cues): zero-based index and segments, a restart in every segment matches', async () => {
    const f = facts.get('start.mkv')!;
    const { starts } = await restartMatches('start.mkv', 'stm', 'every');
    const ix = await h.delivery.cache.get({ fileId: 'stm', sizeBytes: f.sizeBytes, mtimeMs: f.mtimeMs }, 0);
    expect(ix).toMatchObject({ source: 'cues', complete: true });
    expect(ix!.startTimeMs).toBeCloseTo(3500, -1);
    expect(ix!.times[0]).toBeLessThan(50);
    for (const t of ix!.times) expect(Math.abs(t / 2520 - Math.round(t / 2520))).toBeLessThan(0.002);
    expect(ix!.durationMs).toBeGreaterThan(19_000);
    expect(ix!.durationMs).toBeLessThan(20_500);
    expect(starts.slice(1).every((s) => ix!.times.includes(s))).toBe(true);
  }, 120_000);

  it('start_time 3.5 s (MP4, no Cues): STREAM_PREPARING, then the probe job builds a zero-based index', async () => {
    const f = facts.get('start.mp4')!;
    expect(f.container).toBe('mp4');
    const r = await start('start.mp4', 'stp');
    expect(r).toMatchObject({ ok: false, code: 'STREAM_PREPARING' });
    const job = h.enqueued.find((j) => j.idempotencyKey?.startsWith('keyframes-now:stp:'))!;
    expect(job.priority).toBe(0);
    await h.delivery.keyframeJob(job.payload, { jobId: 'j', attempt: 1, log: pino({ level: 'silent' }), signal: new AbortController().signal });
    const ix = (await h.delivery.cache.get({ fileId: 'stp', sizeBytes: f.sizeBytes, mtimeMs: f.mtimeMs }, 0))!;
    expect(ix).toMatchObject({ source: 'probe', complete: false, advice: null });
    // MP4: the AAC priming starts the audio ~21 ms before the video, so start_time (the zero) is below 3.5 s.
    expect(ix.startTimeMs).toBeGreaterThan(3450);
    expect(ix.startTimeMs).toBeLessThanOrEqual(3500);
    expect(ix.times[0]).toBeLessThan(50);
    for (const t of ix.times) expect(Math.abs((t - ix.times[0]!) / 2520 - Math.round((t - ix.times[0]!) / 2520))).toBeLessThan(0.002);
    await restartMatches('start.mp4', 'stp', 10_000);
  }, 120_000);

  it('AAC with a PCE copied: STREAM_FAILED, format class, exclusion {audio, copy, aac}', async () => {
    const r = await start('pce.mkv', 'pce');
    expect(r).toMatchObject({
      ok: false,
      code: 'STREAM_FAILED',
      failure: { kind: 'aac_channel_config', class: 'format', suspect: 'audio', terminal: true, exclusion: { dimension: 'audio', action: 'copy', codec: 'aac', cause: 'server' } },
    });
  }, 60_000);

  it('the same 5.1(side) source encoded with the ADR command: AAC channelConfiguration 6', async () => {
    const handle = await startOk('pce.mkv', 'pce51', { action: { kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 384_000, layout: '5.1' } });
    const init = parseInit((await get(`${base(handle)}init-0.mp4`)).rawPayload);
    expect(init.tracks.find((t) => t.handler === 'soun')).toMatchObject({ codec: 'mp4a.40.2', channelConfiguration: 6 });
    for (const n of await names(handle)) expect((await get(`${base(handle)}${n}`)).statusCode, n).toBe(200);
    await stop(handle);
  }, 60_000);

  it('an index that disagrees with the stream: retry one keyframe earlier, then terminal STREAM_FAILED', async () => {
    const f = facts.get('start.mkv')!;
    const ok = await startOk('start.mkv', 'doc');
    await stop(ok);
    const ix = (await h.delivery.cache.get({ fileId: 'doc', sizeBytes: f.sizeBytes, mtimeMs: f.mtimeMs }, 0))!;
    await h.delivery.cache.put({ ...ix, times: ix.times.map((t, i) => (i === 0 ? t : t + 400)) });
    const handle = await startOk('start.mkv', 'doc');
    const list = await names(handle);
    const seg = await get(`${base(handle)}${list[2]}`);
    expect(seg.statusCode).toBe(500);
    expect(seg.json()).toMatchObject({ code: 'STREAM_FAILED' });
    for (const n of ['main.m3u8', 'init-0.mp4', list[0]!]) expect((await get(`${base(handle)}${n}`)).statusCode, n).toBe(500);
    expect(await h.delivery.port.status({ streamId: handle.streamId })).toMatchObject({
      state: 'failed',
      failure: { kind: 'restart_mismatch', terminal: true, suspect: 'video', exclusion: { dimension: 'video', fileId: 'doc', mode: 'direct_stream' } },
    });
    await stop(handle);
  }, 60_000);
});
