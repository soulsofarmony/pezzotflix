// The software Transcode over real ffmpeg, on fixtures generated in a temp dir (doc 04 P2, ADR 0003 D3):
// IDRs on the 4 s grid, the restart rule (same frames and PTS within 1 ms), HDR10 tone-mapped to SDR at the
// source size and scaled (same pixels, T3), burn-in of a sidecar SRT (converted to ASS, a Windows-1252 one
// included, m5) and of an embedded SRT (extracted to ASS first). Skipped with a message when ffmpeg/ffprobe
// (or libx265 / libass for their tests) are missing. Media samples are never written.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseInit } from '../src/modules/delivery/bmff.ts';
import { sidecarToWebVtt } from '../src/modules/delivery/subtitles.ts';
import type { MediaFacts } from '../src/shared/media-facts.ts';
import type { TranscodePlan } from '../src/shared/playback-plan.ts';
import type { StreamHandle } from '../src/shared/ports.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import { factsOf, ffmpeg, FFMPEG, FFPROBE, HAVE_FFMPEG, HAVE_X265, samplesOf, skipNotice, tempDir, transcodePlan } from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-transcode', false);
const HAVE_LIBASS = HAVE_FFMPEG && (await execa(FFMPEG, ['-hide_banner', '-h', 'filter=subtitles'], { reject: false })).stdout.includes('subtitles');
if (!skip && !HAVE_X265) process.stderr.write('[delivery-transcode] HDR10 test skipped: ffmpeg has no libx265 to build the fixture\n');
if (!skip && !HAVE_LIBASS) process.stderr.write('[delivery-transcode] burn-in of text skipped: ffmpeg has no subtitles filter (libass)\n');

const FPS = 24_000 / 1001;
const FRAME_MS = 1000 / FPS;
const SECONDS = 48;

describe.skipIf(skip !== null)('delivery: software Transcode on generated fixtures', () => {
  let lib: string;
  let work: string;
  let h: Harness;
  let f24: MediaFacts;

  beforeAll(async () => {
    [lib, work] = [tempDir('pzf-tx-lib-'), tempDir('pzf-tx-work-')];
    mkdirSync(join(lib, 'f24'), { recursive: true });
    const srt = '1\n00:00:00,500 --> 00:00:03,500\nPEZZOTFLIX BURN TEST\n\n2\n00:00:41,000 --> 00:00:43,000\nLATE CUE\n';
    writeFileSync(join(work, 'subs.srt'), srt);
    writeFileSync(join(lib, 'f24', 'f24.it.srt'), srt);
    // m5: the first cue in Windows-1252 (every letter accented), and in UTF-16 LE with a BOM.
    writeFileSync(join(lib, 'f24', 'f24.cp.srt'), Buffer.from('1\n00:00:00,500 --> 00:00:03,500\nÀÈÌÒÙ PERCHÉ È GIÀ\n', 'latin1'));
    writeFileSync(join(lib, 'f24', 'f24.u16.srt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('1\r\n00:00:00,500 --> 00:00:03,500\r\nPERCHÉ È GIÀ\r\n', 'utf16le')]));
    // 1080p at 23.976 fps: the first frame after k·4 s is up to a frame late, by a different amount at each k.
    await ffmpeg([
      '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=24000/1001`,
      '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
      '-i', join(work, 'subs.srt'),
      '-t', String(SECONDS),
      '-map', '0:v', '-map', '1:a', '-map', '2:s',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-bf', '2',
      '-c:a', 'ac3', '-b:a', '384k', '-ac', '6',
      '-c:s', 'srt', '-metadata:s:s:0', 'language=ita',
      join(lib, 'f24', 'f24.mkv'),
    ]);
    f24 = await factsOf(join(lib, 'f24', 'f24.mkv'), { rootName: 'Film', relPath: 'f24/f24.mkv' });
    if (HAVE_X265) {
      mkdirSync(join(lib, 'hdr'), { recursive: true });
      await ffmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
        '-t', '8',
        // The frames carry the colour tags: the encoder takes them from the frames, not from -color_trc.
        '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=yuv420p10le',
        '-c:v', 'libx265', '-preset', 'ultrafast',
        '-x265-params', 'hdr10=1:max-cll=1000,400:log-level=error',
        join(lib, 'hdr', 'hdr.mkv'),
      ]);
    }
    h = await harness([{ name: 'Film', path: lib }], { env: { SUBTITLE_EXTRACT_MAX_MBPS: '100000' } });
  }, 300_000);

  afterAll(async () => {
    await h?.close();
    for (const dir of [lib, work]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const get = (url: string) => h.app.inject({ method: 'GET', url });
  const base = (handle: StreamHandle) => handle.locators.stream.replace(/main\.m3u8$/, '');
  const seg = (j: number) => `seg-0-${String(j).padStart(5, '0')}.m4s`;
  async function startOk(plan: TranscodePlan, sessionId = 'sess'): Promise<StreamHandle> {
    for (let i = 0; i < 120; i++) {
      const r = await h.delivery.port.start(plan, sessionId);
      if (r.ok) return r.handle;
      if (r.code !== 'STREAM_PREPARING') throw new Error(`start failed: ${JSON.stringify(r)}`);
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error('still preparing');
  }
  async function segment(handle: StreamHandle, j: number): Promise<Buffer> {
    const r = await get(`${base(handle)}${seg(j)}`);
    expect(r.statusCode, seg(j)).toBe(200);
    return r.rawPayload;
  }
  const initOf = async (handle: StreamHandle) => (await get(`${base(handle)}init-0.mp4`)).rawPayload;
  const videoSamples = (s: Buffer, init: Buffer) => {
    const info = parseInit(init);
    const v = info.tracks.find((t) => t.handler === 'vide')!.id;
    return samplesOf(s, info).filter((x) => x.track === v);
  };

  /** Bottom third of the n-th frame of a segment, 160 px wide, grey. */
  async function bottomOf(init: Buffer, s: Buffer, n: number): Promise<Buffer> {
    const path = join(work, `frame-${Math.random().toString(36).slice(2)}.mp4`);
    writeFileSync(path, Buffer.concat([init, s]));
    const r = await execa(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${n}),crop=iw:ih/3:0:ih*2/3,scale=160:-2,format=gray`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    return Buffer.from(r.stdout);
  }
  /** The n-th frame of a segment as raw yuv420p, scaled (YUV to YUV) to w×h when given. */
  async function yuvOf(init: Buffer, s: Buffer, n: number, size: { w: number; h: number } | null): Promise<Buffer> {
    const path = join(work, `yuv-${Math.random().toString(36).slice(2)}.mp4`);
    writeFileSync(path, Buffer.concat([init, s]));
    const vf = [`select=eq(n\\,${n})`, ...(size ? [`scale=${size.w}:${size.h}`] : []), 'format=yuv420p'].join(',');
    const r = await execa(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    return Buffer.from(r.stdout);
  }
  const meanDiff = (a: Buffer, b: Buffer) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
    return sum / a.length;
  };

  it('1080p23.976: an IDR on the first frame at or after each k·4 s; a restart gives the same frames and PTS', async () => {
    const plan = transcodePlan('f24', f24, { action: { kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 384_000, layout: '5.1' } });
    const t0 = Date.now();
    const ref = await startOk(plan);
    const main = (await get(ref.locators.stream)).body;
    expect(main).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
    expect(main).toContain('VIDEO-RANGE=SDR');
    expect(ref.mimeType).toMatch(/^video\/mp4; codecs="avc1\.6400(28|29|2A), mp4a\.40\.2"$/);
    const init = await initOf(ref);
    const count = Math.ceil(SECONDS / 4);
    const segs: Buffer[] = [];
    for (let j = 0; j < count; j++) segs.push(await segment(ref, j));
    const elapsedS = (Date.now() - t0) / 1000;
    let frames = 0;
    let lastEnd = 0;
    for (const [j, s] of segs.entries()) {
      const v = videoSamples(s, init);
      frames += v.length;
      expect(v[0]!.sync, seg(j)).toBe(true);
      const first = Math.min(...v.map((x) => x.pts));
      if (j > 0) {
        expect(first, seg(j)).toBeGreaterThanOrEqual(j * 4000 - 1);
        expect(first, seg(j)).toBeLessThan(j * 4000 + FRAME_MS + 1);
      }
      // One IDR per segment: forced on the boundary, no scene cut in a test pattern.
      expect(v.filter((x) => x.sync).length, seg(j)).toBeGreaterThanOrEqual(1);
      if (j > 0) expect(Math.abs(v[0]!.dts - lastEnd), `${seg(j)} gap`).toBeLessThan(1);
      lastEnd = v.at(-1)!.dts + v.at(-1)!.duration;
    }
    expect(Math.abs(frames - SECONDS * FPS)).toBeLessThanOrEqual(1);
    process.stderr.write(`[delivery-transcode] 1080p23.976 libx264 veryfast: ${frames} frames in ${elapsedS.toFixed(1)} s, ${(frames / elapsedS).toFixed(0)} fps (start and HTTP included)\n`);

    // Same stream: segment 1 was evicted (30 s behind), so asking for it restarts at k = 1; the init must match.
    const again = await segment(ref, 1);
    expect(h.delivery.streamOf(ref.streamId)!.hls!.terminal).toBe(false);
    expect(diffFrames(videoSamples(again, init), videoSamples(segs[1]!, init))).toEqual([]);
    await h.delivery.port.stop({ streamId: ref.streamId }, 'stopped');

    // A new stream at 40 s (k = 10: the boundary frame is 40 ms late, the next one 2 ms): same frames.
    const late = await startOk({ ...plan, startPositionMs: 41_000 });
    expect((await initOf(late)).equals(init)).toBe(true);
    for (const j of [10, 11]) expect(diffFrames(videoSamples(await segment(late, j), init), videoSamples(segs[j]!, init)), seg(j)).toEqual([]);
    await h.delivery.port.stop({ streamId: late.streamId }, 'stopped');
  }, 300_000);

  it.skipIf(!HAVE_X265)('HDR10 is tone-mapped to SDR BT.709 (zscale + tonemap)', async () => {
    const facts = await factsOf(join(lib, 'hdr', 'hdr.mkv'), { rootName: 'Film', relPath: 'hdr/hdr.mkv' });
    expect(facts.streams[0]).toMatchObject({ hdr: 'HDR10' });
    const plan = transcodePlan('hdr', facts, { audioIndex: null });
    expect(plan.video.toneMap).toBe('to_sdr');
    const handle = await startOk(plan);
    expect((await get(handle.locators.stream)).body).toContain('VIDEO-RANGE=SDR');
    const path = join(work, 'hdr-seg0.mp4');
    writeFileSync(path, Buffer.concat([await initOf(handle), await segment(handle, 0)]));
    const probe = await execa(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,pix_fmt,color_transfer,color_primaries,color_space', '-of', 'json', path]);
    expect((JSON.parse(probe.stdout) as { streams: unknown[] }).streams[0]).toEqual({
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuv420p',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      color_space: 'bt709',
    });
    await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
  }, 300_000);

  it.skipIf(!HAVE_X265)('HDR10 tone-mapped and scaled (720p → 360p) has the colours of the unscaled output (T3)', async () => {
    const facts = await factsOf(join(lib, 'hdr', 'hdr.mkv'), { rootName: 'Film', relPath: 'hdr/hdr.mkv' });
    const frames: Buffer[] = [];
    for (const size of [null, { width: 640, height: 360 }]) {
      const handle = await startOk(transcodePlan('hdr', facts, { audioIndex: null, ...(size ?? {}) }));
      frames.push(await yuvOf(await initOf(handle), await segment(handle, 0), 12, size ? null : { w: 640, h: 360 }));
      await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    }
    const [full, scaled] = frames as [Buffer, Buffer];
    const ySize = 640 * 360;
    const planes: [string, number, number][] = [['Y', 0, ySize], ['U', ySize, ySize * 1.25], ['V', ySize * 1.25, ySize * 1.5]];
    const stats = planes.map(([name, from, to]) => {
      const [a, b] = [full.subarray(from, to), scaled.subarray(from, to)];
      return { name, mean: meanDiff(a, b), maxA: a.reduce((m, x) => Math.max(m, x), 0), maxB: b.reduce((m, x) => Math.max(m, x), 0) };
    });
    process.stderr.write(`[delivery-transcode] T3 tone-map 720p scaled after vs 360p: ${stats.map((s) => `${s.name} mean diff ${s.mean.toFixed(2)}, max ${s.maxA}/${s.maxB}`).join('; ')}\n`);
    expect(full.length).toBe(ySize * 1.5);
    expect(scaled.length).toBe(ySize * 1.5);
    for (const s of stats) {
      expect(s.mean, `${s.name}: mean difference`).toBeLessThan(1.5);
      expect(Math.abs(s.maxA - s.maxB), `${s.name}: peak`).toBeLessThanOrEqual(4);
    }
  }, 300_000);

  it('a Windows-1252 and a UTF-16 sidecar convert to WebVTT with their accented cues (m5)', async () => {
    expect((await sidecarToWebVtt(FFMPEG, join(lib, 'f24', 'f24.cp.srt'), 'srt')).toString('utf8')).toContain('ÀÈÌÒÙ PERCHÉ È GIÀ');
    expect((await sidecarToWebVtt(FFMPEG, join(lib, 'f24', 'f24.u16.srt'), 'srt')).toString('utf8')).toContain('PERCHÉ È GIÀ');
  }, 60_000);

  it.skipIf(!HAVE_LIBASS)('burns a Windows-1252 sidecar SRT with its accented cue (m5)', async () => {
    const cp = { trackId: 'x:cp', source: { kind: 'sidecar' as const, relPath: 'f24/f24.cp.srt', format: 'srt' as const }, codec: 'subrip', delivery: 'burned' as const };
    const frames: Buffer[] = [];
    for (const selected of [null, cp]) {
      const handle = await startOk(transcodePlan('f24', f24, { width: 1280, height: 720, selected }));
      frames.push(await bottomOf(await initOf(handle), await segment(handle, 0), 48));
      await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    }
    const diff = meanDiff(frames[0]!, frames[1]!);
    process.stderr.write(`[delivery-transcode] Windows-1252 burn-in diff: ${diff.toFixed(2)}\n`);
    expect(diff).toBeGreaterThan(2);
  }, 300_000);

  it.skipIf(!HAVE_LIBASS)('burns a sidecar SRT, and the embedded SRT once extracted to ASS', async () => {
    const noBurn = transcodePlan('f24', f24, { width: 1280, height: 720 });
    const sidecar = transcodePlan('f24', f24, { width: 1280, height: 720, selected: { trackId: 'x:it', source: { kind: 'sidecar', relPath: 'f24/f24.it.srt', format: 'srt' }, codec: 'subrip', delivery: 'burned' } });
    const embedded = transcodePlan('f24', f24, { width: 1280, height: 720, selected: { trackId: 's2', source: { kind: 'embedded', streamIndex: 2 }, codec: 'subrip', delivery: 'burned' } });
    const frames: Buffer[] = [];
    for (const plan of [noBurn, sidecar, embedded]) {
      const handle = await startOk(plan);
      const init = await initOf(handle);
      frames.push(await bottomOf(init, await segment(handle, 0), 48)); // 2 s: the first cue is on screen
      await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    }
    const [plain, side, emb] = frames as [Buffer, Buffer, Buffer];
    process.stderr.write(`[delivery-transcode] burn-in diff: sidecar ${meanDiff(plain, side).toFixed(2)}, embedded ${meanDiff(plain, emb).toFixed(2)}, between them ${meanDiff(side, emb).toFixed(2)}\n`);
    expect(meanDiff(plain, side)).toBeGreaterThan(2);
    expect(meanDiff(plain, emb)).toBeGreaterThan(2);
    // The same text rendered the same way (the ASS of the extraction and the SRT read by libass).
    expect(meanDiff(side, emb)).toBeLessThan(meanDiff(plain, side) / 4);
  }, 300_000);
});

/** The restart rule (ADR 0003 D3): same number of video frames, same PTS within 1 ms; the bytes may differ. */
function diffFrames(a: { pts: number }[], b: { pts: number }[]): string[] {
  if (a.length !== b.length) return [`${a.length} frames, reference ${b.length}`];
  const pa = a.map((x) => x.pts).sort((x, y) => x - y);
  const pb = b.map((x) => x.pts).sort((x, y) => x - y);
  const worst = Math.max(0, ...pa.map((p, i) => Math.abs(p - pb[i]!)));
  return worst > 1 ? [`PTS off by ${worst.toFixed(3)} ms`] : [];
}
