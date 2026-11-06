// F1b.4 on the sample library over real ffmpeg (ADR 0003 D12, doc 04 P2/P3): the two-pass extraction merged
// is byte-identical to a full extraction (PGS .sup, SRT and ASS to WebVTT), playback.subtitle_ready reaches
// every session on the file, and a burned PGS survives a restart (pre-roll). Skipped with a message when
// ffmpeg/ffprobe or the samples are missing. Media are only read; outputs go to temp dirs.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execaSpawn } from '../src/modules/delivery/process.ts';
import { fingerprint, outputKey } from '../src/modules/delivery/subtitle-cache.ts';
import { createSubtitleExtractor, type ExtractFile, type ExtractTarget } from '../src/modules/delivery/subtitle-extract.ts';
import type { ServedSubtitle, TranscodePlan } from '../src/shared/playback-plan.ts';
import type { StreamHandle } from '../src/shared/ports.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import { directStreamPlan, factsOf, FFMPEG, MOVIES, SAMPLE, skipNotice, tempDir, transcodePlan } from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-extraction', true);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(skip !== null)('delivery: subtitle extraction and burn-in on the samples', () => {
  let work: string;
  beforeAll(() => {
    work = tempDir('pzf-x-work-');
  });
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** One track extracted in one pass from 0, as ffmpeg does it without us: the reference. */
  async function full(abs: string, t: ExtractTarget): Promise<Buffer> {
    const codec = t.format === 'sup' ? ['-c:s', 'copy', '-f', 'sup'] : ['-c:s', 'webvtt', '-f', 'webvtt'];
    const r = await execa(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', `file:${abs}`, '-copyts', '-start_at_zero', '-map', `0:${t.streamIndex}`, ...codec, 'pipe:1'], { encoding: 'buffer', stripFinalNewline: false });
    return Buffer.from(r.stdout);
  }

  it('two passes merged == a full extraction, byte for byte, wherever the session starts (BR2049: PGS s4 s5, SRT s6, ASS s7)', async () => {
    const abs = join(MOVIES(), SAMPLE.br2049);
    const facts = await factsOf(abs, { rootName: 'Film', relPath: SAMPLE.br2049 });
    const targets: ExtractTarget[] = [
      { streamIndex: 4, format: 'sup' },
      { streamIndex: 5, format: 'sup' },
      { streamIndex: 6, format: 'vtt' },
      { streamIndex: 7, format: 'vtt' },
    ];
    const refs = await Promise.all(targets.map((t) => full(abs, t)));
    expect(refs.every((r) => r.length > 0)).toBe(true);
    for (const startMs of [0, 7_000, 16_000, 27_000]) {
      const cacheDir = join(work, `cache-${startMs}`);
      const done: string[] = [];
      const spawned: string[][] = [];
      const real = execaSpawn(FFMPEG);
      const x = createSubtitleExtractor({
        config: { cacheDir, SUBTITLE_EXTRACT_MAX_MBPS: 100_000, SUBTITLE_PREROLL_S: 3, SUBTITLE_PREEXTRACT: 'off', SUBTITLE_CACHE_MAX_BYTES: 1e9 },
        log: pino({ level: 'silent' }),
        now: Date.now,
        spawn: (args) => {
          spawned.push([...args]);
          return real(args);
        },
        onComplete: (_fp, key) => done.push(key),
      });
      await x.init();
      const file: ExtractFile = { fileId: 'br2049', sizeBytes: facts.sizeBytes, mtimeMs: facts.mtimeMs, absPath: abs, durationMs: facts.durationMs, videoStreamIndex: 0 };
      x.acquire('stream', file, targets, startMs);
      for (let i = 0; i < 600 && done.length < targets.length; i++) await tick(100);
      expect(done.sort(), `X = ${startMs}`).toEqual(targets.map((t) => outputKey(t.streamIndex, t.format)).sort());
      // One ffmpeg per pass for every track: one pass from 0, two otherwise.
      expect(spawned.length, `X = ${startMs}`).toBe(startMs > 3000 ? 2 : 1);
      for (const [i, t] of targets.entries()) {
        const got = readFileSync(x.cache.path(fingerprint(file), outputKey(t.streamIndex, t.format)));
        expect(got.equals(refs[i]!), `X = ${startMs}, track ${t.streamIndex}`).toBe(true);
      }
      await x.shutdown();
    }
  }, 300_000);

  describe('through the delivery service', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await harness([{ name: 'Film', path: MOVIES() }], { env: { SUBTITLE_EXTRACT_MAX_MBPS: '100000' } });
    });
    afterAll(async () => h?.close());
    const get = (url: string) => h.app.inject({ method: 'GET', url });
    const base = (handle: StreamHandle) => handle.locators.stream.replace(/main\.m3u8$/, '');

    it('playback.subtitle_ready reaches both sessions on the file; the url then serves the cached .sup', async () => {
      const facts = await factsOf(join(MOVIES(), SAMPLE.br2049), { rootName: 'Film', relPath: SAMPLE.br2049 });
      const served: ServedSubtitle[] = [{ trackId: 's5', source: { kind: 'embedded', streamIndex: 5 }, codec: 'hdmv_pgs_subtitle', language: 'ita', forced: false, delivery: 'client_render', format: 'sup' }];
      const plan = { ...directStreamPlan('br2049-ready', facts, { audioIndex: null }), subtitles: { selected: null, served } };
      const handles: StreamHandle[] = [];
      for (const sessionId of ['sess-a', 'sess-b']) {
        const r = await h.delivery.port.start(plan, sessionId);
        if (!r.ok) throw new Error(JSON.stringify(r));
        handles.push(r.handle);
      }
      for (let i = 0; i < 600 && h.events.length < 2; i++) await tick(100);
      expect(h.events.map((e) => e.payload).sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)))).toEqual([
        { sessionId: 'sess-a', trackId: 's5', availability: 'complete' },
        { sessionId: 'sess-b', trackId: 's5', availability: 'complete' },
      ]);
      const sup = await get(handles[1]!.locators.subtitles[0]!.url);
      expect(sup.statusCode).toBe(200);
      expect(sup.rawPayload.equals(await full(join(MOVIES(), SAMPLE.br2049), { streamIndex: 5, format: 'sup' }))).toBe(true);
      for (const handle of handles) await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    }, 300_000);

    it('a burned PGS (Il Buono, 1080p60) survives a restart: the cue on screen began before the boundary (pre-roll)', async () => {
      // Il Buono's PGS track shows a cue from x.024 to x+2.000 every 2 s: with 3 s segments the cue of
      // 2.024 s is still on screen at the start of segment 1, so a restart there needs the pre-roll.
      const h3 = await harness([{ name: 'Film', path: MOVIES() }], { env: { HLS_SEGMENT_TARGET_S: '3' } });
      try {
        const facts = await factsOf(join(MOVIES(), SAMPLE.buono), { rootName: 'Film', relPath: SAMPLE.buono });
        const selected: TranscodePlan['subtitles']['selected'] = { trackId: 's3', source: { kind: 'embedded', streamIndex: 3 }, codec: 'hdmv_pgs_subtitle', delivery: 'burned' };
        const frameOf = async (plan: TranscodePlan): Promise<Buffer> => {
          const r = await h3.delivery.port.start(plan, 'sess');
          if (!r.ok) throw new Error(JSON.stringify(r));
          const at = base(r.handle);
          const init = (await h3.app.inject({ method: 'GET', url: `${at}init-0.mp4` })).rawPayload;
          const seg = await h3.app.inject({ method: 'GET', url: `${at}seg-0-00001.m4s` });
          expect(seg.statusCode).toBe(200);
          await h3.delivery.port.stop({ streamId: r.handle.streamId }, 'stopped');
          const path = join(work, `buono-${Math.random().toString(36).slice(2)}.mp4`);
          writeFileSync(path, Buffer.concat([init, seg.rawPayload]));
          // 3.25 s (frame 15 of the segment at 60 fps), the bottom third, small and grey.
          const vf = 'select=eq(n\\,15),crop=iw:ih/3:0:ih*2/3,scale=160:-2,format=gray';
          const out = await execa(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', stripFinalNewline: false });
          return Buffer.from(out.stdout);
        };
        const opts = { width: 1280, height: 720, audioIndex: null };
        const plain = await frameOf(transcodePlan('buono', facts, opts));
        const fromZero = await frameOf(transcodePlan('buono', facts, { ...opts, selected }));
        const restart = await frameOf(transcodePlan('buono', facts, { ...opts, selected, startPositionMs: 3_000 }));
        // Share of pixels that changed a lot: glyphs and their outline, not encoder noise.
        const changed = (a: Buffer, b: Buffer) => a.reduce((n, v, i) => n + (Math.abs(v - b[i]!) > 48 ? 1 : 0), 0) / a.length;
        const burned = changed(plain, fromZero);
        const restarted = changed(restart, fromZero);
        process.stderr.write(`[delivery-extraction] PGS burn-in, pixels changed: burned vs plain ${(burned * 100).toFixed(2)} %, restart vs run from 0 ${(restarted * 100).toFixed(2)} %\n`);
        expect(burned).toBeGreaterThan(0.002);
        expect(restarted).toBeLessThan(burned / 10);
      } finally {
        await h3.close();
      }
    }, 300_000);
  });
});
