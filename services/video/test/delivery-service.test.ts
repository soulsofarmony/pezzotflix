// Stream Delivery through the contract routes with a fake ffmpeg and a fake probe (no tools needed):
// tokens (404 unknown, 410 tombstone, 404 after the TTL), no-store, Direct Play with Range, the file
// checks (MEDIA_UNAVAILABLE), STREAM_PREPARING and the urgent index job, the hls-fmp4 resources, 503 +
// Retry-After, terminal STREAM_FAILED, subtitle locators. Library files are synthetic, in a temp dir.
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { NO_CUES_ADVICE, TRANSIENT_FAILURE_TTL_MS } from '../src/modules/delivery/keyframe-index.ts';
import type { DeliveryProbe } from '../src/modules/delivery/probe.ts';
import { type ChildLike, type ExitInfo, failedChild, type Spawn } from '../src/modules/delivery/process.ts';
import type { DeliveryDeps } from '../src/modules/delivery/service.ts';
import { JOB_TYPES, KEYFRAME_INDEX_URGENT_PRIORITY } from '../src/shared/job-types.ts';
import type { DirectPlayPlan, DirectStreamPlan, PlaybackPlan, ServedSubtitle, VideoSource } from '../src/shared/playback-plan.ts';
import type { StreamHandle } from '../src/shared/ports.ts';
import { fakeInit, fakeMkv } from './helpers/delivery-builders.ts';
import { type Behavior, fakeFfmpeg, type FakeRun } from './helpers/delivery-fake-ffmpeg.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import { FFMPEG, HAVE_FFMPEG, tempDir } from './helpers/delivery-media.ts';

const KEYFRAMES = Array.from({ length: 30 }, (_, i) => i * 2000);
const DURATION = 60_000;

const lib = tempDir('pzf-lib-');
const outside = tempDir('pzf-outside-');
const write = (rel: string, data: Buffer) => {
  mkdirSync(join(lib, rel, '..'), { recursive: true });
  writeFileSync(join(lib, rel), data);
};
const PROGRESSIVE = Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 7) & 0xff));
write('Play/Play.mp4', PROGRESSIVE);
write('Cues/Cues.mkv', fakeMkv({ cues: KEYFRAMES, durationMs: DURATION }));
write('NoCues/NoCues.mkv', fakeMkv({ cues: null, durationMs: DURATION }));
write('Cues/Cues.it.vtt', Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nCiao\n'));
writeFileSync(join(outside, 'secret.mp4'), Buffer.from('nope'));

afterAll(() => {
  rmSync(lib, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const fakeProbe: DeliveryProbe = {
  timeline: async () => ({ startTimeMs: 0, rawDurationMs: DURATION, videoStreamIndex: 0 }),
  keyframesAt: async (_abs, _idx, targets) => targets.map((t) => ({ ptsMs: KEYFRAMES.filter((k) => k <= t).at(-1)!, pos: null })),
};

const video: VideoSource = { streamIndex: 0, codec: 'h264', profile: 'High', width: 1920, height: 1080, frameRate: 24, bitDepth: 8, hdr: 'SDR', hdrFallback: [], dolbyVisionProfile: null, bitRate: null, level: null };
const audioSource = { streamIndex: 1, trackId: 's1', codec: 'aac', profile: 'LC', language: 'ita', channels: 2, channelLayout: 'stereo', sampleRate: 48_000, bitRate: 192_000 };

const fileOf = (relPath: string, rootName = 'Film', container = 'matroska') => {
  const st = statSync(join(lib, relPath));
  return { fileId: relPath.split('/')[0]!.toLowerCase(), location: { rootName, relPath }, sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs), container, durationMs: DURATION };
};

const playPlan = (over: Partial<DirectPlayPlan['file']> = {}): DirectPlayPlan => ({
  planVersion: 1,
  mode: 'direct_play',
  protocol: 'progressive',
  file: { ...fileOf('Play/Play.mp4', 'Film', 'mp4'), ...over },
  video: { kind: 'original', source: { ...video, level: 41 } },
  audio: { source: audioSource, action: { kind: 'copy' } },
  subtitles: { selected: null, served: [] },
  startPositionMs: 0,
  reasons: [],
  exclusions: [],
});

const SERVED: ServedSubtitle[] = [
  { trackId: 's3', source: { kind: 'embedded', streamIndex: 3 }, codec: 'hdmv_pgs_subtitle', language: 'ita', forced: false, delivery: 'client_render', format: 'sup' },
  { trackId: 'x:it', source: { kind: 'sidecar', relPath: 'Cues/Cues.it.vtt', format: 'vtt' }, codec: 'webvtt', language: 'ita', forced: false, delivery: 'sidecar', format: 'webvtt' },
];

const streamPlan = (relPath: string, over: Partial<DirectStreamPlan> = {}): DirectStreamPlan => ({
  planVersion: 1,
  mode: 'direct_stream',
  protocol: 'hls-fmp4',
  file: fileOf(relPath),
  video: { kind: 'copy', source: video, tag: null, dolbyVision: 'none' },
  audio: { source: audioSource, action: { kind: 'copy' } },
  subtitles: { selected: null, served: SERVED },
  startPositionMs: 0,
  reasons: [],
  exclusions: [],
  ...over,
});

let h: Harness;
let behaviors: Behavior[] = [{ kind: 'ok' }];
let runs: FakeRun[] = [];

let spawnOverride: Spawn | null = null;

async function open(env: Record<string, string> = {}, timings: DeliveryDeps['timings'] = { waitMs: 2000, killGraceMs: 50 }, probe: DeliveryProbe = fakeProbe) {
  h = await harness([{ name: 'Film', path: lib }], {
    env: { DELIVERY_AHEAD_S: '4', ...env },
    timings,
    probe,
    spawn: (args) => {
      if (spawnOverride) return spawnOverride(args);
      // One fake per spawn, so each test can set its behaviors before starting.
      const ff = fakeFfmpeg(KEYFRAMES, DURATION, [behaviors[runs.length] ?? behaviors.at(-1)!]);
      const child = ff.spawn(args);
      runs.push(ff.runs[0]!);
      return child;
    },
  });
}

afterEach(async () => {
  await h?.close();
  behaviors = [{ kind: 'ok' }];
  runs = [];
  spawnOverride = null;
});

const get = (url: string, headers: Record<string, string> = {}, method: 'GET' | 'HEAD' = 'GET') => h.app.inject({ method, url, headers });
const startOk = async (plan: PlaybackPlan): Promise<StreamHandle> => {
  const r = await h.delivery.port.start(plan, 'sess');
  if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
  return r.handle;
};
const hlsBase = (handle: StreamHandle) => handle.locators.stream.replace(/main\.m3u8$/, '');
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Direct Play (progressive)', () => {

  it('serves the file read-only with Range, HEAD and no-store', async () => {
    await open();
    const handle = await startOk(playPlan());
    expect(handle).toMatchObject({ mode: 'direct_play', protocol: 'progressive', mediaTimestampOffsetMs: 0, mimeType: 'video/mp4; codecs="avc1.640029, mp4a.40.2"' });
    expect(handle.locators.stream).toMatch(/^\/video\/media\/s\/[A-Za-z0-9_-]{43}\/file$/);
    expect(handle.bitrate).toEqual({ peakBps: Math.round((PROGRESSIVE.length * 8000) / DURATION), averageBps: Math.round((PROGRESSIVE.length * 8000) / DURATION), audioBps: 192_000 });

    const full = await get(handle.locators.stream);
    expect(full.statusCode).toBe(200);
    expect(full.headers).toMatchObject({ 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'content-type': 'video/mp4', 'content-length': String(PROGRESSIVE.length) });
    expect(full.rawPayload.equals(PROGRESSIVE)).toBe(true);
    expect(full.headers.etag).toBeTruthy();

    const part = await get(handle.locators.stream, { range: 'bytes=10-19' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${PROGRESSIVE.length}`);
    expect(part.rawPayload.equals(PROGRESSIVE.subarray(10, 20))).toBe(true);
    expect(part.headers['cache-control']).toBe('no-store');

    const tail = await get(handle.locators.stream, { range: 'bytes=-5' });
    expect(tail.rawPayload.equals(PROGRESSIVE.subarray(-5))).toBe(true);

    const bad = await get(handle.locators.stream, { range: `bytes=${PROGRESSIVE.length + 10}-` });
    expect(bad.statusCode).toBe(416);

    const head = await get(handle.locators.stream, {}, 'HEAD');
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(PROGRESSIVE.length));
    expect(head.rawPayload.length).toBe(0);

    // No HLS resources on a progressive stream.
    expect((await get(handle.locators.stream.replace(/file$/, 'hls/main.m3u8'))).statusCode).toBe(404);
  });

  it('tokens: 404 unknown, 410 after stop (no-store, problem+json), 404 once the tombstone expires', async () => {
    await open({ DELIVERY_TOMBSTONE_TTL_S: '1' });
    const handle = await startOk(playPlan());
    const unknown = await get('/video/media/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/file');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['cache-control']).toBe('no-store');
    await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    const gone = await get(handle.locators.stream);
    expect(gone.statusCode).toBe(410);
    expect(gone.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(gone.headers['cache-control']).toBe('no-store');
    expect(gone.json()).toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(await h.delivery.port.status({ streamId: handle.streamId })).toMatchObject({ state: 'stopped' });
    await tick(1100);
    expect((await get(handle.locators.stream)).statusCode).toBe(404);
    expect(await h.delivery.port.status({ streamId: handle.streamId })).toBeNull();
  });

  it.each([
    ['an unknown root', { location: { rootName: 'Nope', relPath: 'Play/Play.mp4' } }, /not configured/],
    ['a path outside the root', { location: { rootName: 'Film', relPath: '../secret.mp4' } }, /unsafe|escapes|not reachable/],
    ['an absolute path', { location: { rootName: 'Film', relPath: join(outside, 'secret.mp4') } }, /unsafe|escapes|not reachable/],
    ['a missing file', { location: { rootName: 'Film', relPath: 'Play/Gone.mp4' } }, /not reachable/],
    ['a changed file', { sizeBytes: 1 }, /changed/],
  ])('MEDIA_UNAVAILABLE for %s', async (_l, over, detail) => {
    await open();
    const r = await h.delivery.port.start(playPlan(over), 'sess');
    expect(r).toMatchObject({ ok: false, code: 'MEDIA_UNAVAILABLE' });
    expect(r.ok ? '' : 'detail' in r ? r.detail : '').toMatch(detail);
  });

  it('rejects another plan version; the Transcode tier is not here yet', async () => {
    await open();
    await expect(h.delivery.port.start({ ...playPlan(), planVersion: 2 } as unknown as PlaybackPlan, 'sess')).rejects.toThrow(/plan version/);
    await expect(h.delivery.port.start({ ...streamPlan('Cues/Cues.mkv'), mode: 'transcode' } as unknown as PlaybackPlan, 'sess')).rejects.toThrow(/F1b\.4/);
  });
});

describe('Direct Stream (hls-fmp4) with a fake ffmpeg', () => {
  it('serves playlists, init and segments; the first run is the exact command', async () => {
    await open();
    const plan = streamPlan('Cues/Cues.mkv');
    const handle = await startOk(plan);
    expect(handle).toMatchObject({ mode: 'direct_stream', protocol: 'hls-fmp4', mediaTimestampOffsetMs: 10_000, mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"' });
    expect(handle.locators.stream).toMatch(/\/hls\/main\.m3u8$/);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args).toContain(`file:${realpathSync.native(join(lib, 'Cues', 'Cues.mkv'))}`);
    expect(runs[0]!.args).not.toContain('-ss');

    const main = await get(handle.locators.stream);
    expect(main.statusCode).toBe(200);
    expect(main.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
    expect(main.headers['cache-control']).toBe('no-store');
    expect(main.body).toContain('CODECS="hvc1.2.4.L153.B0,mp4a.40.2"');
    expect(main.body).toContain('RESOLUTION=1920x1080');
    const media = (await get(`${hlsBase(handle)}media-0.m3u8`)).body;
    const names = media.split('\n').filter((l) => l.endsWith('.m4s'));
    expect(names).toHaveLength(15);
    expect(media).toContain('#EXT-X-TARGETDURATION:4');
    expect(media).toContain('#EXT-X-MAP:URI="init-0.mp4"');

    const init = await get(`${hlsBase(handle)}init-0.mp4`);
    expect(init.statusCode).toBe(200);
    expect(init.headers['content-type']).toBe('video/mp4');
    expect(init.rawPayload.equals(fakeInit())).toBe(true);
    const seg = await get(`${hlsBase(handle)}${names[0]}`);
    expect(seg.statusCode).toBe(200);
    expect(seg.headers['cache-control']).toBe('no-store');
    expect(seg.rawPayload.subarray(4, 8).toString('latin1')).toBe('moof');

    // Not in the playlist: 404; in the playlist but far away: produced by a restart, never 404.
    expect((await get(`${hlsBase(handle)}seg-0-00015.m4s`)).statusCode).toBe(404);
    expect((await get(`${hlsBase(handle)}${names[12]}`)).statusCode).toBe(200);
    expect(runs.map((r) => r.seek)).toEqual([null, 46.135]);
    expect(runs[0]!.signals).toEqual(['SIGKILL']);

    expect(await h.delivery.port.status({ streamId: handle.streamId })).toMatchObject({
      state: 'active',
      failure: null,
      subtitles: [
        { trackId: 's3', availability: 'growing' },
        { trackId: 'x:it', availability: 'complete' },
      ],
    });
  });

  it('starts at the segment of startPositionMs, one GOP early', async () => {
    await open();
    await startOk(streamPlan('Cues/Cues.mkv', { startPositionMs: 41_000 }));
    expect(runs.map((r) => r.seek)).toEqual([38.135]);
  });

  it('a segment the run does not reach in time answers 503 STREAM_PREPARING with Retry-After', async () => {
    behaviors = [{ kind: 'hang' }];
    await open({}, { waitMs: 50, killGraceMs: 50 });
    const handle = await startOk(streamPlan('Cues/Cues.mkv'));
    const r = await get(`${hlsBase(handle)}seg-0-00000.m4s`);
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('1');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toMatchObject({ code: 'STREAM_PREPARING' });
  });

  it('two failed runs make the stream terminal: 500 STREAM_FAILED on every resource, status failed', async () => {
    behaviors = [{ kind: 'exit', after: 1, stderr: '[hevc @ x] Invalid NAL unit size\n' }];
    await open();
    const handle = await startOk(streamPlan('Cues/Cues.mkv'));
    const seg = await get(`${hlsBase(handle)}seg-0-00002.m4s`);
    expect(seg.statusCode).toBe(500);
    expect(seg.json()).toMatchObject({ code: 'STREAM_FAILED' });
    for (const name of ['main.m3u8', 'media-0.m3u8', 'init-0.mp4', 'seg-0-00000.m4s']) expect((await get(`${hlsBase(handle)}${name}`)).statusCode, name).toBe(500);
    expect((await get(handle.locators.subtitles[1]!.url)).statusCode).toBe(500);
    const status = await h.delivery.port.status({ streamId: handle.streamId });
    expect(status).toMatchObject({ state: 'failed', failure: { kind: 'process_exit', terminal: true, stderrClass: 'decode' } });
    expect(runs).toHaveLength(2);
  });

  it('subtitles: embedded answer 503 + Retry-After until F1b.4, a WebVTT sidecar is served as is', async () => {
    await open();
    const handle = await startOk(streamPlan('Cues/Cues.mkv'));
    expect(handle.locators.subtitles).toEqual([
      { trackId: 's3', url: `${hlsBase(handle).replace(/hls\/$/, '')}subtitles/s3.sup`, availability: 'growing' },
      { trackId: 'x:it', url: `${hlsBase(handle).replace(/hls\/$/, '')}subtitles/x:it.vtt`, availability: 'complete' },
    ]);
    const pgs = await get(handle.locators.subtitles[0]!.url);
    expect(pgs.statusCode).toBe(503);
    expect(pgs.headers['retry-after']).toBe('5');
    const vtt = await get(handle.locators.subtitles[1]!.url);
    expect(vtt.statusCode).toBe(200);
    expect(vtt.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(vtt.body).toContain('Ciao');
    expect((await get(handle.locators.subtitles[1]!.url.replace('x:it.vtt', 'x:it.sup'))).statusCode).toBe(404);
    expect((await get(handle.locators.subtitles[1]!.url.replace('x:it.vtt', 's9.vtt'))).statusCode).toBe(404);
  });

  it('an MKV without Cues: STREAM_PREPARING and an urgent index job; the job builds the index from the probe', async () => {
    await open();
    const plan = streamPlan('NoCues/NoCues.mkv');
    expect(await h.delivery.port.start(plan, 'sess')).toEqual({ ok: false, code: 'STREAM_PREPARING', retryAfterMs: 5000 });
    expect(h.enqueued).toEqual([
      {
        type: JOB_TYPES.deliveryKeyframeIndex,
        payload: { fileId: 'nocues', location: plan.file.location, sizeBytes: plan.file.sizeBytes, mtimeMs: plan.file.mtimeMs, container: 'matroska', videoStreamIndex: 0 },
        priority: KEYFRAME_INDEX_URGENT_PRIORITY,
        idempotencyKey: `keyframes-now:nocues:v0:${plan.file.sizeBytes}:${plan.file.mtimeMs}`,
      },
    ]);
    expect(runs).toHaveLength(0);

    const log = pino({ level: 'silent' });
    await h.delivery.keyframeJob(h.enqueued[0]!.payload, { jobId: 'j', attempt: 1, log, signal: new AbortController().signal });
    const ix = await h.delivery.cache.get({ fileId: 'nocues', sizeBytes: plan.file.sizeBytes, mtimeMs: plan.file.mtimeMs }, 0);
    expect(ix).toMatchObject({ source: 'probe', complete: false, advice: NO_CUES_ADVICE, startTimeMs: 0, durationMs: DURATION });
    expect(ix!.times).toEqual(KEYFRAMES.filter((k) => k % 4000 === 0));

    const handle = await startOk(plan);
    expect(handle.protocol).toBe('hls-fmp4');
    expect((await get(`${hlsBase(handle)}seg-0-00000.m4s`)).statusCode).toBe(200);
  });

  it('the index job skips a file that changed since the analysis', async () => {
    await open();
    const plan = streamPlan('NoCues/NoCues.mkv');
    const log = pino({ level: 'silent' });
    await h.delivery.keyframeJob({ ...h.enqueued[0]?.payload as object, fileId: 'nocues', location: plan.file.location, sizeBytes: 1, mtimeMs: plan.file.mtimeMs, container: 'matroska' }, { jobId: 'j', attempt: 1, log, signal: new AbortController().signal });
    expect(await h.delivery.cache.get({ fileId: 'nocues', sizeBytes: 1, mtimeMs: plan.file.mtimeMs }, 0)).toBeNull();
    await expect(h.delivery.keyframeJob({ fileId: '' }, { jobId: 'j', attempt: 1, log, signal: new AbortController().signal })).rejects.toThrow();
  });
});

/** An ffmpeg that writes nothing until killed (an overloaded host, a stuck input). */
function silentChild(): ChildLike {
  const stdout = new PassThrough();
  let exit!: (e: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((r) => (exit = r));
  return {
    stdout,
    stderr: new PassThrough(),
    kill(signal) {
      stdout.end();
      exit({ exitCode: null, signal, error: null });
      return true;
    },
    exited,
  };
}

const bigFile = () => {
  if (!existsSync(join(lib, 'Big', 'Big.mp4'))) write('Big/Big.mp4', Buffer.alloc(48 * 1024 * 1024, 7));
  return fileOf('Big/Big.mp4', 'Film', 'mp4');
};

describe('index failures', () => {
  const noKeyframes: DeliveryProbe = { ...fakeProbe, keyframesAt: async () => [] };
  const log = pino({ level: 'silent' });
  const ctx = (attempt: number) => ({ jobId: 'j', attempt, log, signal: new AbortController().signal });

  it('a deterministic probe failure is recorded: start answers STREAM_FAILED at once, excluding Direct Stream for the file', async () => {
    await open({}, undefined, noKeyframes);
    const plan = streamPlan('NoCues/NoCues.mkv');
    expect((await h.delivery.port.start(plan, 'sess')).ok).toBe(false);
    await h.delivery.keyframeJob(h.enqueued[0]!.payload, ctx(1));
    const r = await h.delivery.port.start(plan, 'sess');
    expect(r).toMatchObject({
      ok: false,
      code: 'STREAM_FAILED',
      failure: { class: 'format', terminal: true, exclusion: { dimension: 'video', fileId: 'nocues', mode: 'direct_stream', cause: 'server' } },
    });
    // No new urgent job: the failure is cached per content and video stream.
    expect(h.enqueued).toHaveLength(1);
    const stamp = { fileId: 'nocues', sizeBytes: plan.file.sizeBytes, mtimeMs: plan.file.mtimeMs };
    expect(await h.delivery.cache.getFailure(stamp, 0, Date.now())).toMatchObject({ videoStreamIndex: 0, permanent: true });
    expect(await h.delivery.cache.getFailure(stamp, 1, Date.now())).toBeNull();
    // Permanent: no index can be built from this content, however long ago.
    expect(await h.delivery.cache.getFailure(stamp, 0, Date.now() + 100 * TRANSIENT_FAILURE_TTL_MS)).not.toBeNull();
  });

  it('a transient probe failure is retried; only the last attempt is recorded', async () => {
    const flaky: DeliveryProbe = { ...fakeProbe, keyframesAt: () => Promise.reject(new Error('ffprobe timed out')) };
    await open({}, undefined, flaky);
    const plan = streamPlan('NoCues/NoCues.mkv');
    await h.delivery.port.start(plan, 'sess');
    const stamp = { fileId: 'nocues', sizeBytes: plan.file.sizeBytes, mtimeMs: plan.file.mtimeMs };
    await expect(h.delivery.keyframeJob(h.enqueued[0]!.payload, ctx(1))).rejects.toThrow(/timed out/);
    expect(await h.delivery.cache.getFailure(stamp, 0, Date.now())).toBeNull();
    expect(await h.delivery.port.start(plan, 'sess')).toMatchObject({ ok: false, code: 'STREAM_PREPARING' });
    await expect(h.delivery.keyframeJob(h.enqueued[0]!.payload, ctx(3))).rejects.toThrow(/timed out/);
    expect(await h.delivery.cache.getFailure(stamp, 0, Date.now())).toMatchObject({ reason: 'ffprobe timed out', permanent: false });
    expect(await h.delivery.port.start(plan, 'sess')).toMatchObject({ ok: false, code: 'STREAM_FAILED' });
    // A timeout is never permanent: after the TTL the file is tried again.
    expect(await h.delivery.cache.getFailure(stamp, 0, Date.now() + TRANSIENT_FAILURE_TTL_MS + 1)).toBeNull();
  });

  it('a failing timeline probe is inside the job\'s failure handling: recorded on the last attempt, with a TTL', async () => {
    const noTimeline: DeliveryProbe = { ...fakeProbe, timeline: () => Promise.reject(new Error('ffprobe timed out')) };
    await open({}, undefined, noTimeline);
    const plan = streamPlan('NoCues/NoCues.mkv');
    await h.delivery.port.start(plan, 'sess');
    const stamp = { fileId: 'nocues', sizeBytes: plan.file.sizeBytes, mtimeMs: plan.file.mtimeMs };
    await expect(h.delivery.keyframeJob(h.enqueued[0]!.payload, ctx(3))).rejects.toThrow(/timed out/);
    expect(await h.delivery.cache.getFailure(stamp, 0, Date.now())).toMatchObject({ permanent: false });
  });

  it('an aborted job (shutdown) records nothing, even on the last attempt', async () => {
    const aborted = new AbortController();
    const slow: DeliveryProbe = {
      ...fakeProbe,
      keyframesAt: () => {
        aborted.abort();
        return Promise.reject(new Error('canceled'));
      },
    };
    await open({}, undefined, slow);
    const plan = streamPlan('NoCues/NoCues.mkv');
    await h.delivery.port.start(plan, 'sess');
    const stamp = { fileId: 'nocues', sizeBytes: plan.file.sizeBytes, mtimeMs: plan.file.mtimeMs };
    await expect(h.delivery.keyframeJob(h.enqueued[0]!.payload, { jobId: 'j', attempt: 3, log, signal: aborted.signal })).rejects.toThrow(/canceled/);
    expect(await h.delivery.cache.getFailure(stamp, 0, Date.now())).toBeNull();
  });
});

describe('start failures that are not the plan\'s fault', () => {
  it('ffmpeg missing: MEDIA_UNAVAILABLE, not a terminal no_output', async () => {
    spawnOverride = () => failedChild('ffmpeg not found: /nope/ffmpeg');
    await open();
    expect(await h.delivery.port.start(streamPlan('Cues/Cues.mkv'), 'sess')).toEqual({ ok: false, code: 'MEDIA_UNAVAILABLE', detail: 'ffmpeg is not available' });
  });

  it('no output in time (an overloaded host): STREAM_PREPARING once, STREAM_FAILED the second time in a row', async () => {
    spawnOverride = () => silentChild();
    await open({}, { waitMs: 2000, killGraceMs: 10, startTimeoutMs: 30 });
    const plan = streamPlan('Cues/Cues.mkv');
    expect(await h.delivery.port.start(plan, 'sess')).toEqual({ ok: false, code: 'STREAM_PREPARING', retryAfterMs: 5000 });
    expect(await h.delivery.port.start(plan, 'sess')).toMatchObject({
      ok: false,
      code: 'STREAM_FAILED',
      failure: { kind: 'no_output', class: 'stream', suspect: 'unknown', exclusion: null, terminal: true },
    });
    // Another stream shape of the same file has its own count.
    const converted = streamPlan('Cues/Cues.mkv', { audio: { source: audioSource, action: { kind: 'convert', codec: 'flac', channels: 2, bitrateBps: null, layout: null } } });
    expect(await h.delivery.port.start(converted, 'sess')).toMatchObject({ ok: false, code: 'STREAM_PREPARING' });
  });

  it('a successful start resets the count of start timeouts', async () => {
    spawnOverride = () => silentChild();
    await open({}, { waitMs: 2000, killGraceMs: 10, startTimeoutMs: 30 });
    const plan = streamPlan('Cues/Cues.mkv');
    expect(await h.delivery.port.start(plan, 'sess')).toMatchObject({ code: 'STREAM_PREPARING' });
    spawnOverride = null;
    const handle = await startOk(plan);
    await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    spawnOverride = () => silentChild();
    expect(await h.delivery.port.start(plan, 'sess')).toMatchObject({ code: 'STREAM_PREPARING' });
  });

  it('a scratch quota too small for one segment: the segment answers STREAM_FAILED (io_error), stop releases everything', async () => {
    await open({ SCRATCH_MAX_BYTES: '100' });
    const handle = await startOk(streamPlan('Cues/Cues.mkv'));
    const seg = await get(`${hlsBase(handle)}seg-0-00000.m4s`);
    expect(seg.statusCode).toBe(500);
    expect(await h.delivery.port.status({ streamId: handle.streamId })).toMatchObject({ state: 'failed', failure: { kind: 'io_error', terminal: true } });
    await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    expect(h.delivery.quotaUsed).toBe(0);
    expect(existsSync(join(h.config.scratchDir, 'delivery', handle.streamId))).toBe(false);
  });
});

describe('lifecycle', () => {
  /**
   * A client that reads the headers and then stops reading. A paused client socket does not read, so it
   * cannot see the cut: the test watches the server's response, then resumes the client to see it end early.
   */
  const pausedBody = async (url: string, streamId: string) => {
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await new Promise<IncomingMessage>((resolve, reject) => httpGet(`${address}${url}`, resolve).on('error', reject));
    res.pause();
    res.on('error', () => {});
    await tick(50);
    const inflight = [...h.delivery.streamOf(streamId)!.inflight];
    expect(inflight).toHaveLength(1);
    const server = inflight[0]!;
    const serverClosed = new Promise<void>((resolve) => (server.closed ? resolve() : server.once('close', () => resolve())));
    const clientEnded = () =>
      new Promise<void>((resolve) => {
        res.once('close', () => resolve());
        res.resume();
      });
    return { res, server, serverClosed, clientEnded };
  };

  it('stop cuts a Direct Play body a paused client holds; the server still closes', async () => {
    const file = bigFile();
    await open();
    const handle = await startOk(playPlan(file));
    const { res, server, serverClosed, clientEnded } = await pausedBody(handle.locators.stream, handle.streamId);
    expect(res.statusCode).toBe(200);
    await h.delivery.port.stop({ streamId: handle.streamId }, 'expired');
    await serverClosed;
    expect(server.writableFinished).toBe(false);
    await clientEnded();
    expect(res.complete).toBe(false);
    const t0 = Date.now();
    await h.close();
    expect(Date.now() - t0).toBeLessThan(5000);
    h = { ...h, close: async () => {} };
  });

  it('shutdown with the server close: a paused client does not hold either', async () => {
    const file = bigFile();
    await open();
    const handle = await startOk(playPlan(file));
    const { res, server, serverClosed, clientEnded } = await pausedBody(handle.locators.stream, handle.streamId);
    const t0 = Date.now();
    await Promise.all([h.app.close(), h.delivery.shutdown()]);
    await serverClosed;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(server.writableFinished).toBe(false);
    await clientEnded();
    expect(res.complete).toBe(false);
  });

  it('without delivery, the server close alone does not wait for a paused client (forceCloseConnections)', async () => {
    const file = bigFile();
    await open();
    const handle = await startOk(playPlan(file));
    const { serverClosed } = await pausedBody(handle.locators.stream, handle.streamId);
    const t0 = Date.now();
    await h.app.close();
    await serverClosed;
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('shutdown kills the runs, the start in progress too; later starts are refused', async () => {
    behaviors = [{ kind: 'hang' }];
    await open({}, { waitMs: 2000, killGraceMs: 50, startTimeoutMs: 10_000 });
    await startOk(streamPlan('Cues/Cues.mkv'));
    spawnOverride = () => silentChild();
    const pending = h.delivery.port.start(streamPlan('Cues/Cues.mkv'), 'sess2');
    await tick(50);
    const scratch = join(h.config.scratchDir, 'delivery');
    expect(existsSync(scratch)).toBe(true);
    await h.delivery.shutdown();
    expect(runs[0]!.signals.length).toBeGreaterThan(0);
    expect(await pending).toMatchObject({ ok: false, code: 'MEDIA_UNAVAILABLE' });
    expect(existsSync(scratch)).toBe(false);
    expect(await h.delivery.port.start(playPlan(), 'sess3')).toEqual({ ok: false, code: 'MEDIA_UNAVAILABLE', detail: 'delivery is shutting down' });
  });

  it('clearScratch empties what a previous process left', async () => {
    await open();
    const old = join(h.config.scratchDir, 'delivery', 'old-stream');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'seg-0-00001.m4s'), 'x');
    await h.delivery.clearScratch();
    expect(existsSync(join(h.config.scratchDir, 'delivery'))).toBe(false);
  });
});

describe('sidecar conversion', () => {
  const SRT: ServedSubtitle = {
    trackId: 'x:en',
    source: { kind: 'sidecar', relPath: 'Cues/Cues.en.srt', format: 'srt' },
    codec: 'subrip',
    language: 'eng',
    forced: false,
    delivery: 'sidecar',
    format: 'webvtt',
  };
  write('Cues/Cues.en.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n'));
  const planWithSrt = (): DirectPlayPlan => ({ ...playPlan(), subtitles: { selected: null, served: [SRT] } });

  it('ffmpeg failing: 503 MEDIA_UNAVAILABLE, one conversion per track, the failure cached', async () => {
    await open({ FFMPEG_PATH: join(outside, 'no-ffmpeg.exe') });
    const handle = await startOk(planWithSrt());
    const url = handle.locators.subtitles[0]!.url;
    const [a, b] = await Promise.all([get(url), get(url)]);
    for (const r of [a, b]) {
      expect(r.statusCode).toBe(503);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.json()).toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
    }
    const rec = h.delivery.streamOf(handle.streamId)!;
    const cached = rec.sidecars.get('x:en')!.promise;
    expect((await get(url)).statusCode).toBe(503);
    expect(rec.sidecars.get('x:en')!.promise).toBe(cached);
    expect(rec.sidecars.size).toBe(1);
  });

  it.skipIf(!HAVE_FFMPEG)('an SRT sidecar as WebVTT: concurrent requests share one conversion (needs ffmpeg)', async () => {
    await open({ FFMPEG_PATH: FFMPEG });
    const handle = await startOk(planWithSrt());
    const url = handle.locators.subtitles[0]!.url;
    const [a, b] = await Promise.all([get(url), get(url)]);
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(a.body).toMatch(/^WEBVTT/);
    expect(a.body).toContain('Hello');
    expect(b.body).toBe(a.body);
    expect(h.delivery.streamOf(handle.streamId)!.sidecars.size).toBe(1);
  });

  it('stop cancels and drops the conversions of the stream', async () => {
    await open({ FFMPEG_PATH: join(outside, 'no-ffmpeg.exe') });
    const handle = await startOk(planWithSrt());
    const rec = h.delivery.streamOf(handle.streamId)!;
    await get(handle.locators.subtitles[0]!.url);
    await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    expect(rec.abort.signal.aborted).toBe(true);
    expect(rec.sidecars.size).toBe(0);
    expect((await get(handle.locators.subtitles[0]!.url)).statusCode).toBe(410);
  });
});
