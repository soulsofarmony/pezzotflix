// F1b.4 through the delivery service and the contract routes, with a fake ffmpeg (no tools needed): the
// embedded subtitle extraction (growing response, 503 while queued, two passes merged with PTS dedupe, the
// pass-1 file meanwhile, the cache with Range, playback.subtitle_ready per session, one extraction per file
// shared and cancelled when no stream needs it, failure) and the software Transcode (synthetic grid, forced
// keyframes, restart on Bₖ, burn-in of image and text tracks, refusals).
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDeliveryProbe, type DeliveryProbe } from '../src/modules/delivery/probe.ts';
import { fingerprint } from '../src/modules/delivery/subtitle-cache.ts';
import { fakeMkv } from './helpers/delivery-builders.ts';
import { type FakeExtractOptions, fakeExtractor, supSegments, vttOf } from './helpers/delivery-fake-extract.ts';
import { type Behavior, fakeFfmpeg, type FakeRun } from './helpers/delivery-fake-ffmpeg.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import { tempDir } from './helpers/delivery-media.ts';
import type { DirectPlayPlan, DirectStreamPlan, PlaybackPlan, ServedSubtitle, TranscodePlan, VideoSource } from '../src/shared/playback-plan.ts';
import type { StreamHandle } from '../src/shared/ports.ts';

const KEYFRAMES = Array.from({ length: 30 }, (_, i) => i * 2000);
const DURATION = 60_000;

const lib = tempDir('pzf-lib-');
const write = (rel: string, data: Buffer | string) => {
  mkdirSync(join(lib, rel, '..'), { recursive: true });
  writeFileSync(join(lib, rel), data);
};
write('Cues/Cues.mkv', fakeMkv({ cues: KEYFRAMES, durationMs: DURATION }));
write('Play/Play.mp4', Buffer.alloc(50_000, 3));
write('Cues/Cues.it.srt', '1\n00:00:01,000 --> 00:00:02,000\nCiao\n');
write('Cues/Cues.it.sup', supSegments([1000]));
afterAll(() => rmSync(lib, { recursive: true, force: true }));

const fakeProbe: DeliveryProbe = {
  timeline: async () => ({ startTimeMs: 0, rawDurationMs: DURATION, videoStreamIndex: 0 }),
  streamEndMs: async () => DURATION,
  keyframesAt: async (_abs, _idx, targets) => targets.map((t) => ({ ptsMs: KEYFRAMES.filter((k) => k <= t).at(-1)!, pos: null })),
};

const video: VideoSource = { streamIndex: 0, codec: 'h264', profile: 'High', width: 1920, height: 1080, frameRate: 24, bitDepth: 8, hdr: 'SDR', hdrFallback: [], dolbyVisionProfile: null, bitRate: null, level: null };
const audioSource = { streamIndex: 1, trackId: 's1', codec: 'aac', profile: 'LC', language: 'ita', channels: 2, channelLayout: 'stereo', sampleRate: 48_000, bitRate: 192_000 };
const fileOf = (relPath: string, container = 'matroska') => {
  const st = statSync(join(lib, relPath));
  return { fileId: relPath.split('/')[0]!.toLowerCase(), location: { rootName: 'Film', relPath }, sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs), container, durationMs: DURATION };
};

const PGS: ServedSubtitle = { trackId: 's3', source: { kind: 'embedded', streamIndex: 3 }, codec: 'hdmv_pgs_subtitle', language: 'ita', forced: false, delivery: 'client_render', format: 'sup' };
const TEXT: ServedSubtitle = { trackId: 's4', source: { kind: 'embedded', streamIndex: 4 }, codec: 'subrip', language: 'ita', forced: false, delivery: 'sidecar', format: 'webvtt' };

const streamPlan = (over: Partial<DirectStreamPlan> = {}): DirectStreamPlan => ({
  planVersion: 1,
  mode: 'direct_stream',
  protocol: 'hls-fmp4',
  file: fileOf('Cues/Cues.mkv'),
  video: { kind: 'copy', source: video, tag: null, dolbyVision: 'none' },
  audio: { source: audioSource, action: { kind: 'copy' } },
  subtitles: { selected: null, served: [PGS] },
  startPositionMs: 0,
  reasons: [],
  exclusions: [],
  ...over,
});

const playPlan = (): DirectPlayPlan => ({
  planVersion: 1,
  mode: 'direct_play',
  protocol: 'progressive',
  file: fileOf('Play/Play.mp4', 'mp4'),
  video: { kind: 'original', source: video },
  audio: { source: audioSource, action: { kind: 'copy' } },
  subtitles: { selected: null, served: [PGS] },
  startPositionMs: 0,
  reasons: [],
  exclusions: [],
});

const transcodePlan = (over: Partial<TranscodePlan> = {}, v: Partial<TranscodePlan['video']> = {}): TranscodePlan => ({
  planVersion: 1,
  mode: 'transcode',
  protocol: 'hls-fmp4',
  file: fileOf('Cues/Cues.mkv'),
  video: { kind: 'transcode', source: video, codec: 'h264', width: 1280, height: 720, maxBitrateBps: 8_000_000, toneMap: 'none', causes: ['resolution'], ...v },
  audio: { source: audioSource, action: { kind: 'copy' } },
  subtitles: { selected: null, served: [] },
  startPositionMs: 0,
  reasons: [],
  exclusions: [],
  ...over,
});

let h: Harness;
let fx = fakeExtractor();
let behaviors: Behavior[] = [{ kind: 'ok' }];
let runs: FakeRun[] = [];
/** Sidecar conversions to ASS (burn-in): a fake that writes a header, or fails for a file named "*.bad.srt". */
let conversions: { absPath: string; format: string; outPath: string }[] = [];
const convertSidecar = async (absPath: string, format: string, outPath: string): Promise<void> => {
  conversions.push({ absPath, format, outPath });
  if (absPath.endsWith('.bad.srt')) throw new Error('sidecar conversion failed: exit 1');
  writeFileSync(outPath, '[Script Info]\n');
};

async function open(env: Record<string, string> = {}, extract: FakeExtractOptions | null = null, probe: DeliveryProbe = fakeProbe) {
  fx = fakeExtractor(extract ?? {});
  h = await harness([{ name: 'Film', path: lib }], {
    env: { DELIVERY_AHEAD_S: '4', ...env },
    timings: { waitMs: 2000, killGraceMs: 50 },
    probe,
    spawn: (args) => {
      const ff = fakeFfmpeg(KEYFRAMES, DURATION, [behaviors[runs.length] ?? behaviors.at(-1)!]);
      const child = ff.spawn(args);
      runs.push(ff.runs[0]!);
      return child;
    },
    extractSpawn: fx.spawn,
    extractTimings: { cancelGraceMs: 100, pollMs: 20 },
    convertSidecar,
  });
}

afterEach(async () => {
  for (const r of fx.runs) r.release(0);
  await h?.close();
  behaviors = [{ kind: 'ok' }];
  runs = [];
  conversions = [];
});

const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const startOk = async (plan: PlaybackPlan, sessionId = 'sess'): Promise<StreamHandle> => {
  const r = await h.delivery.port.start(plan, sessionId);
  if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
  return r.handle;
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await tick(10);
  }
}
const availability = async (handle: StreamHandle) => (await h.delivery.port.status({ streamId: handle.streamId }))!.subtitles;
const ready = () => h.events.filter((e) => e.type === 'playback.subtitle_ready').map((e) => e.payload);
const hlsBase = (handle: StreamHandle) => handle.locators.stream.replace(/main\.m3u8$/, '');

describe('embedded subtitle extraction', () => {
  it('grows while pass 1 runs, then is complete with Range; playback.subtitle_ready names the session', async () => {
    const sup = supSegments([1000, 2000, 3000]);
    await open({}, { content: () => sup });
    const handle = await startOk(streamPlan(), 'sess-a');
    expect(handle.locators.subtitles[0]).toMatchObject({ trackId: 's3', availability: 'growing' });
    await until(() => fx.runs.length === 1);
    const run = fx.runs[0]!;
    // Started at 0: one pass, no seek; paced from Node on the video clock (no ffmpeg read cap).
    expect(run.seekS).toBeNull();
    expect(run.paced).toBe(true);
    expect(run.args.join(' ')).toContain('-copyts -start_at_zero -map 0:0 -c copy -flush_packets 1 -f framehash -hash sha512 pipe:1 -map 0:3 -c:s copy -flush_packets 1 -f sup file:');
    expect(run.args.join(' ')).not.toMatch(/-readrate/);
    expect(run.outputs).toEqual([{ streamIndex: 3, format: 'sup', path: expect.stringMatching(/p1-s3\.sup\.part$/) as string }]);

    const pending = get(handle.locators.subtitles[0]!.url);
    await tick(100);
    expect(ready()).toEqual([]);
    run.release(0);
    const grown = await pending;
    expect(grown.statusCode).toBe(200);
    expect(grown.headers['content-length']).toBeUndefined();
    expect(grown.headers['content-type']).toBe('application/octet-stream');
    expect(grown.headers['cache-control']).toBe('no-store');
    expect(grown.rawPayload.equals(sup)).toBe(true);

    await until(() => ready().length === 1);
    expect(ready()).toEqual([{ sessionId: 'sess-a', trackId: 's3', availability: 'complete' }]);
    expect(await availability(handle)).toEqual([{ trackId: 's3', availability: 'complete' }]);
    const full = await get(handle.locators.subtitles[0]!.url);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-length']).toBe(String(sup.length));
    const part = await get(handle.locators.subtitles[0]!.url, { range: 'bytes=0-15' });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.equals(sup.subarray(0, 16))).toBe(true);
    // A new stream on the same content starts complete, with no new extraction.
    const again = await startOk(streamPlan(), 'sess-b');
    expect(again.locators.subtitles[0]!.availability).toBe('complete');
    expect(fx.runs).toHaveLength(1);
  });

  it('a track whose extraction has not started answers 503 STREAM_PREPARING with Retry-After (one extraction at a time)', async () => {
    await open();
    await startOk(streamPlan(), 'sess-a');
    await until(() => fx.runs.length === 1);
    const play = await startOk(playPlan(), 'sess-b');
    expect(play.locators.subtitles[0]!.availability).toBe('growing');
    const r = await get(play.locators.subtitles[0]!.url);
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('5');
    expect(r.json()).toMatchObject({ code: 'STREAM_PREPARING' });
    expect(fx.runs).toHaveLength(1);
    fx.runs[0]!.release(0);
    await until(() => fx.runs.length === 2);
    expect(fx.runs[1]!.args.find((a) => a.startsWith('file:') && a.endsWith('Play.mp4'))).toBeTruthy();
  });

  it('a late start: pass 1 from X − pre-roll (a burst), the pass-1 file meanwhile, pass 2 up to P₁, merged with PTS dedupe, every track in one process', async () => {
    const pass1 = { sup: supSegments([41_000, 45_000]), vtt: vttOf([41_000, 45_000], (i) => `late ${i}`) };
    const pass2 = { sup: supSegments([1000, 30_000, 41_000]), vtt: vttOf([1000, 41_000], (i) => (i === 0 ? 'early' : 'late 0')) };
    await open({ SUBTITLE_PREROLL_S: '10' }, { content: (o, run) => (run.pass === 1 ? pass1 : pass2)[o.format === 'sup' ? 'sup' : 'vtt'] });
    const handle = await startOk(streamPlan({ startPositionMs: 50_000, subtitles: { selected: null, served: [PGS, TEXT] } }), 'sess-a');
    await until(() => fx.runs.length === 1);
    const p1 = fx.runs[0]!;
    expect(p1.seekS).toBe(40);
    expect(p1.paced).toBe(true);
    expect(p1.outputs.map((o) => [o.streamIndex, o.format])).toEqual([[3, 'sup'], [4, 'webvtt']]);
    p1.release(0);
    await until(() => fx.runs.length === 2);
    const p2 = fx.runs[1]!;
    // Up to P₁ = 41 s: no -t, the video clock on stdout stops it past P₁ (S1).
    expect(p2.pass).toBe(2);
    expect(p2.untilS).toBeNull();
    expect(p2.args).toContain('framehash');
    expect(p2.seekS).toBeNull();
    // Pass 1 is over, pass 2 runs: the url serves the pass-1 file, still growing for the session.
    const meanwhile = await get(handle.locators.subtitles[0]!.url);
    expect(meanwhile.statusCode).toBe(200);
    expect(meanwhile.rawPayload.equals(pass1.sup)).toBe(true);
    expect((await availability(handle)).map((s) => s.availability)).toEqual(['growing', 'growing']);
    p2.release(0);
    await until(() => ready().length === 2);
    const sup = await get(handle.locators.subtitles[0]!.url);
    expect(sup.rawPayload.equals(Buffer.concat([supSegments([1000, 30_000]), pass1.sup]))).toBe(true);
    const vtt = await get(handle.locators.subtitles[1]!.url);
    expect(vtt.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(vtt.body).toBe(vttOf([1000, 41_000, 45_000], (i) => (i === 0 ? 'early' : `late ${i - 1}`)));
  });

  it('one extraction per file, shared: both sessions get subtitle_ready; a re-plan within the grace keeps it', async () => {
    await open({}, { content: () => supSegments([1000]) });
    const a = await startOk(streamPlan(), 'sess-a');
    const b = await startOk(streamPlan(), 'sess-b');
    await until(() => fx.runs.length === 1);
    await tick(50);
    expect(fx.runs).toHaveLength(1);
    // A re-plan stops the old stream, then starts the new one.
    await h.delivery.port.stop({ streamId: a.streamId }, 'replanned');
    const a2 = await startOk(streamPlan(), 'sess-a2');
    await tick(150);
    expect(fx.runs[0]!.signals).toEqual([]);
    fx.runs[0]!.release(0);
    await until(() => ready().length === 2);
    expect(ready().map((p) => p.sessionId).sort()).toEqual(['sess-a2', 'sess-b']);
    expect(a2.streamId).not.toBe(b.streamId);
  });

  it('cancelled once no stream needs it (after the grace period); kept with SUBTITLE_PREEXTRACT=on', async () => {
    await open();
    const a = await startOk(streamPlan(), 'sess-a');
    const b = await startOk(streamPlan(), 'sess-b');
    await until(() => fx.runs.length === 1);
    await h.delivery.port.stop({ streamId: a.streamId }, 'stopped');
    await tick(150);
    expect(fx.runs[0]!.signals).toEqual([]);
    await h.delivery.port.stop({ streamId: b.streamId }, 'stopped');
    await until(() => fx.runs[0]!.signals.length > 0);
    expect(fx.runs[0]!.signals).toEqual(['SIGKILL']);
    // The work files never reach the cache.
    expect(h.delivery.extractor.cache.usedBytes).toBe(0);
    await h.close();

    await open({ SUBTITLE_PREEXTRACT: 'on' });
    const c = await startOk(streamPlan(), 'sess-c');
    await until(() => fx.runs.length === 1);
    await h.delivery.port.stop({ streamId: c.streamId }, 'stopped');
    await tick(200);
    expect(fx.runs[0]!.signals).toEqual([]);
  });

  it('a failed extraction is retried once, then the track answers 503 MEDIA_UNAVAILABLE without Retry-After and is final (complete + event)', async () => {
    await open({}, { exitAt: () => 1 });
    const handle = await startOk(streamPlan());
    await until(() => fx.runs.length === 2);
    await tick(50);
    const r = await get(handle.locators.subtitles[0]!.url);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
    expect(r.headers['retry-after']).toBeUndefined();
    // Never growing forever: the state is final, and the client is told to read the url again.
    expect((await availability(handle))[0]!.availability).toBe('complete');
    expect(h.events.map((e) => e.payload)).toEqual([{ sessionId: 'sess', trackId: 's3', availability: 'complete' }]);
  });

  it('m3: a start whose selected track failed recently is STREAM_FAILED excluding that track; served only, or another selected, starts', async () => {
    await open({}, { exitAt: (run) => (run.outputs.some((o) => o.streamIndex === 3) ? 1 : 0) });
    await startOk(streamPlan());
    await until(() => fx.runs.length === 2);
    await until(() => h.events.length === 1);
    const selected = (s: ServedSubtitle) => ({ trackId: s.trackId, source: s.source, codec: s.codec, delivery: s.delivery });
    const before = { streams: runs.length, extractions: fx.runs.length };
    const r = await h.delivery.port.start(streamPlan({ subtitles: { selected: selected(PGS), served: [PGS, TEXT] } }), 'sess-b');
    expect(r).toMatchObject({
      ok: false,
      code: 'STREAM_FAILED',
      failure: {
        class: 'format',
        suspect: 'subtitle',
        terminal: true,
        exclusion: { dimension: 'subtitle', trackId: 's3', delivery: 'client_render', fileId: 'cues', cause: 'server', error: 'no_output' },
      },
    });
    // No ffmpeg for the refused start.
    await tick(50);
    expect({ streams: runs.length, extractions: fx.runs.length }).toEqual(before);
    await startOk(streamPlan({ subtitles: { selected: null, served: [PGS, TEXT] } }), 'sess-c');
    await startOk(streamPlan({ subtitles: { selected: selected(TEXT), served: [PGS, TEXT] } }), 'sess-d');
  });

  it('a growing track whose file cannot be opened (not ENOENT) answers 503 MEDIA_UNAVAILABLE with Retry-After (transient), not 500', async () => {
    await open();
    const handle = await startOk(streamPlan());
    await until(() => fx.runs.length === 1);
    const real = h.delivery.subtitle;
    h.delivery.subtitle = () => ({ kind: 'growing', open: () => Promise.reject(Object.assign(new Error('too many open files'), { code: 'EMFILE' })) });
    try {
      const r = await get(handle.locators.subtitles[0]!.url);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ code: 'MEDIA_UNAVAILABLE', detail: expect.stringContaining('EMFILE') as string });
      expect(r.headers['retry-after']).toBe('5');
    } finally {
      h.delivery.subtitle = real;
    }
  });
});

describe('software Transcode', () => {
  const keyframeList = (run: FakeRun) => readFileSync(run.args[run.args.indexOf('-/force_key_frames:v') + 1]!, 'utf8');

  it('synthetic 4 s grid, IDRs forced from a list, INDEPENDENT-SEGMENTS, SDR at the target size; a seek is a new encode from Bₖ₋₁ (one segment of pre-roll)', async () => {
    await open();
    const handle = await startOk(transcodePlan());
    expect(handle).toMatchObject({ mode: 'transcode', protocol: 'hls-fmp4', mediaTimestampOffsetMs: 10_000 });
    expect(handle.bitrate).toEqual({ peakBps: 12_000_000 + 192_000, averageBps: 8_000_000 + 192_000, audioBps: 192_000 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args).not.toContain('-ss');
    expect(runs[0]!.args).toContain('libx264');
    expect(keyframeList(runs[0]!)).toBe(Array.from({ length: 15 }, (_, i) => `${i * 4}.000`).join(','));
    const main = (await get(handle.locators.stream)).body;
    expect(main).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
    expect(main).toContain('RESOLUTION=1280x720');
    expect(main).toContain('VIDEO-RANGE=SDR');
    const media = (await get(`${hlsBase(handle)}media-0.m3u8`)).body;
    expect(media.split('\n').filter((l) => l.startsWith('#EXTINF:'))).toEqual(Array.from({ length: 15 }, () => '#EXTINF:4.000,'));
    expect(media).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
    expect((await get(`${hlsBase(handle)}seg-0-00000.m4s`)).statusCode).toBe(200);
    expect((await get(`${hlsBase(handle)}seg-0-00012.m4s`)).statusCode).toBe(200);
    expect(runs.map((r) => r.seek)).toEqual([null, 44]);
    expect(runs[1]!.args).not.toContain('-noaccurate_seek');
    expect(keyframeList(runs[1]!)).toBe('44.000,48.000,52.000,56.000');
    expect(h.delivery.streamOf(handle.streamId)!.hls!.segmentRun(12)).not.toBeNull();
  });

  describe('m5: the duration of the grid', () => {
    const extinfs = async (handle: StreamHandle) => (await get(`${hlsBase(handle)}media-0.m3u8`)).body.split('\n').filter((l) => l.startsWith('#EXTINF:'));
    const fifteen = Array.from({ length: 15 }, () => '#EXTINF:4.000,');
    const errno = (code: string) => Object.assign(new Error(code), { code });

    it('a failing timeline or video-end probe: logged, the grid ends with the container, nothing cached', async () => {
      const calls: string[] = [];
      let failing: 'timeline' | 'end' | null = 'timeline';
      await open({}, null, {
        ...fakeProbe,
        timeline: async (abs, signal) => {
          calls.push('timeline');
          if (failing === 'timeline') throw new Error('ffprobe timed out');
          return fakeProbe.timeline(abs, signal);
        },
        streamEndMs: async () => {
          calls.push('end');
          if (failing === 'end') throw new Error('ffprobe exit 1');
          return DURATION - 2000;
        },
      });
      const a = await startOk(transcodePlan(), 'sess-a');
      expect(await extinfs(a)).toEqual(fifteen);
      failing = 'end';
      const b = await startOk(transcodePlan(), 'sess-b');
      expect(await extinfs(b)).toEqual(fifteen);
      expect(calls).toEqual(['timeline', 'timeline', 'end']);
      // Probed again (the fallbacks were not cached), then cached: 58 s of video.
      failing = null;
      const c = await startOk(transcodePlan(), 'sess-c');
      expect((await extinfs(c)).at(-1)).toBe('#EXTINF:2.000,');
      await startOk(transcodePlan(), 'sess-d');
      expect(calls).toEqual(['timeline', 'timeline', 'end', 'timeline', 'end']);
    });

    it('a file error is MEDIA_UNAVAILABLE; a failure with no duration known is STREAM_PREPARING', async () => {
      let err: Error = errno('EACCES');
      await open({}, null, { ...fakeProbe, timeline: () => Promise.reject(err) });
      expect(await h.delivery.port.start(transcodePlan(), 'sess')).toMatchObject({ ok: false, code: 'MEDIA_UNAVAILABLE' });
      err = new Error('ffprobe timed out');
      const noDuration = transcodePlan({ file: { ...fileOf('Cues/Cues.mkv'), durationMs: null } });
      expect(await h.delivery.port.start(noDuration, 'sess')).toMatchObject({ ok: false, code: 'STREAM_PREPARING' });
    });

    it('the real probe: ffprobe failing to open the input ("Permission denied") is MEDIA_UNAVAILABLE (round 3)', async () => {
      // A Node script stands in for ffprobe (a real ExecaError); `--` passes ffprobe's arguments to it.
      const script = 'process.stderr.write("file:/media/x.mkv: Permission denied\\n"); process.exit(1)';
      await open({}, null, createDeliveryProbe(process.execPath, { argsPrefix: ['-e', script, '--'] }));
      expect(await h.delivery.port.start(transcodePlan(), 'sess')).toMatchObject({ ok: false, code: 'MEDIA_UNAVAILABLE', detail: 'file not readable: EACCES' });
    });

    it('the video end is clamped to the container; starts at once share one probe, with the shutdown signal', async () => {
      const signals: (AbortSignal | undefined)[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      await open({}, null, {
        ...fakeProbe,
        timeline: async (abs, signal) => {
          signals.push(signal);
          await gate;
          return fakeProbe.timeline(abs, signal);
        },
        streamEndMs: async (_abs, _i, _near, signal) => {
          signals.push(signal);
          return DURATION + 3000;
        },
      });
      const starts = [h.delivery.port.start(transcodePlan(), 'sess-a'), h.delivery.port.start(transcodePlan(), 'sess-b')];
      await tick(50);
      release();
      const [a, b] = await Promise.all(starts);
      expect(a!.ok && b!.ok).toBe(true);
      if (!a!.ok) return;
      expect(await extinfs(a!.handle)).toEqual(fifteen);
      expect(signals).toHaveLength(2);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).toBe(signals[0]);
      expect(signals[0]!.aborted).toBe(false);
      await h.delivery.shutdown();
      expect(signals[0]!.aborted).toBe(true);
    });
  });

  it('burns an embedded image track from the same input; a restart from Bₖ₋₁ reads 10 s earlier and trims there, audio from a second input', async () => {
    await open();
    const plan = transcodePlan({ subtitles: { selected: { trackId: 's3', source: { kind: 'embedded', streamIndex: 3 }, codec: 'hdmv_pgs_subtitle', delivery: 'burned' }, served: [] } });
    const handle = await startOk(plan);
    expect(runs[0]!.args[runs[0]!.args.indexOf('-filter_complex') + 1]).toContain('[0:3]scale=w=1920:h=1080:force_original_aspect_ratio=decrease[sub];[main][sub]overlay=');
    expect((await get(`${hlsBase(handle)}seg-0-00012.m4s`)).statusCode).toBe(200);
    const r = runs[1]!.args;
    expect(r.slice(r.indexOf('-noaccurate_seek'), r.indexOf('-filter_complex'))).toEqual(['-noaccurate_seek', '-ss', '34.000', '-i', expect.any(String), '-ss', '44.000', '-i', expect.any(String)]);
    expect(r[r.indexOf('-filter_complex') + 1]).toMatch(/^\[0:0\]bwdif=[^,]*,trim=start=44\.000\[main\];/);
    expect(r.join(' ')).toContain('-map [v] -map 1:1 ');
    expect(fx.runs).toHaveLength(0);
  });

  it('burns an embedded text track once it is extracted to ASS: STREAM_PREPARING meanwhile, one read from 0 without a cap, only the burn source', async () => {
    await open({}, { content: (o) => (o.format === 'ass' ? '[Script Info]\n' : 'WEBVTT\n') });
    const plan = transcodePlan({ subtitles: { selected: { trackId: 's4', source: { kind: 'embedded', streamIndex: 4 }, codec: 'subrip', delivery: 'burned' }, served: [PGS] } });
    expect(await h.delivery.port.start(plan, 'sess')).toEqual({ ok: false, code: 'STREAM_PREPARING', retryAfterMs: 5000 });
    expect(await h.delivery.port.start(plan, 'sess')).toMatchObject({ ok: false, code: 'STREAM_PREPARING' });
    await until(() => fx.runs.length === 1);
    const x = fx.runs[0]!;
    expect(x.paced).toBe(false);
    expect(x.seekS).toBeNull();
    // The served PGS is not held by a start that waits: the stream acquires it once it runs.
    expect(x.outputs.map((o) => [o.streamIndex, o.format])).toEqual([[4, 'ass']]);
    expect(runs).toHaveLength(0);
    x.release(0);
    await until(() => h.delivery.extractor.cache.usedBytes > 0);
    await tick(50);
    const handle = await startOk(plan);
    const graph = runs[0]!.args[runs[0]!.args.indexOf('-filter_complex') + 1]!;
    const ass = h.delivery.extractor.cache.path(fingerprint(plan.file), 's4.ass');
    expect(graph).toContain(`subtitles=filename=${ass.replace(/\\/g, '/').replace(/:/g, '\\\\:')}`);
    expect(handle.locators.subtitles[0]!.availability).toBe('growing');
    await until(() => fx.runs.length === 2);
    expect(fx.runs[1]!.outputs.map((o) => [o.streamIndex, o.format])).toEqual([[3, 'sup']]);
    expect(fx.runs[1]!.paced).toBe(true);
  });

  it('burns a sidecar text file converted to ASS in the stream dir; a failed conversion or a sidecar .sup: STREAM_FAILED excluding that burn-in', async () => {
    await open();
    const srt = transcodePlan({ subtitles: { selected: { trackId: 'x:srt', source: { kind: 'sidecar', relPath: 'Cues/Cues.it.srt', format: 'srt' }, codec: 'subrip', delivery: 'burned' }, served: [] } });
    const handle = await startOk(srt);
    expect(conversions).toEqual([{ absPath: expect.stringMatching(/Cues[\\/]Cues\.it\.srt$/), format: 'srt', outPath: expect.stringMatching(/burn-sidecar\.ass$/) }]);
    const assPath = conversions[0]!.outPath;
    expect(assPath).toContain(handle.streamId);
    expect(runs[0]!.args[runs[0]!.args.indexOf('-filter_complex') + 1]).toMatch(/subtitles=filename=.*burn-sidecar\.ass,scale=/);
    expect(runs[0]!.args.join(' ')).not.toContain('Cues.it.srt');
    await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    expect(() => statSync(assPath)).toThrow();

    write('Cues/Cues.it.bad.srt', '1\n00:00:01,000 --> 00:00:02,000\nx\n');
    const bad = transcodePlan({ subtitles: { selected: { trackId: 'x:bad', source: { kind: 'sidecar', relPath: 'Cues/Cues.it.bad.srt', format: 'srt' }, codec: 'subrip', delivery: 'burned' }, served: [] } });
    expect(await h.delivery.port.start(bad, 'sess')).toMatchObject({
      ok: false,
      code: 'STREAM_FAILED',
      failure: { class: 'format', suspect: 'subtitle', exclusion: { dimension: 'subtitle', trackId: 'x:bad', delivery: 'burned', cause: 'server' } },
    });
    expect(() => statSync(dirname(conversions[1]!.outPath))).toThrow();
    expect(runs).toHaveLength(1);
    const sup = transcodePlan({ subtitles: { selected: { trackId: 'x:sup', source: { kind: 'sidecar', relPath: 'Cues/Cues.it.sup', format: 'sup' }, codec: 'hdmv_pgs_subtitle', delivery: 'burned' }, served: [] } });
    expect(await h.delivery.port.start(sup, 'sess')).toMatchObject({
      ok: false,
      code: 'STREAM_FAILED',
      failure: { class: 'format', suspect: 'subtitle', exclusion: { dimension: 'subtitle', trackId: 'x:sup', delivery: 'burned', fileId: 'cues', cause: 'server' } },
    });
  });

  it('refuses a source above 1080p, excluding the Transcode for the file', async () => {
    await open();
    const r = await h.delivery.port.start(transcodePlan({}, { source: { ...video, width: 3840, height: 2160 } }), 'sess');
    expect(r).toMatchObject({ ok: false, code: 'STREAM_FAILED', failure: { class: 'format', exclusion: { dimension: 'video', fileId: 'cues', mode: 'transcode' } } });
    expect(runs).toHaveLength(0);
  });

  it('a failure naming the overlay excludes burning that track, at once (a format failure)', async () => {
    behaviors = [{ kind: 'exit', after: 2, stderr: '[Parsed_overlay_2 @ 0x1] [error] Failed to configure input pad on Parsed_overlay_2\n' }];
    await open();
    const plan = transcodePlan({ subtitles: { selected: { trackId: 's3', source: { kind: 'embedded', streamIndex: 3 }, codec: 'hdmv_pgs_subtitle', delivery: 'burned' }, served: [] } });
    const handle = await startOk(plan);
    expect((await get(`${hlsBase(handle)}seg-0-00003.m4s`)).statusCode).toBe(500);
    expect(await h.delivery.port.status({ streamId: handle.streamId })).toMatchObject({
      state: 'failed',
      failure: { kind: 'process_exit', class: 'format', suspect: 'subtitle', exclusion: { dimension: 'subtitle', trackId: 's3', delivery: 'burned' } },
    });
    expect(runs).toHaveLength(1);
  });
});
