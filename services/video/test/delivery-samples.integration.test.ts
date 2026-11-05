// Delivery on the sample library (read only): the Cues index checked against the ffprobe seek probe on
// every MKV, Direct Play with Range and the codec string from the probed level, an SRT sidecar served
// as WebVTT, and backpressure on a long file. Skipped with a message when ffmpeg or the samples are missing.
import { readdirSync, statSync } from 'node:fs';
import { execa } from 'execa';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildKeyframeIndex } from '../src/modules/delivery/keyframe-index.ts';
import { createDeliveryProbe } from '../src/modules/delivery/probe.ts';
import type { ServedSubtitle } from '../src/shared/playback-plan.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import { directPlayPlan, directStreamPlan, factsOf, FFPROBE, MOVIES, SAMPLE, SAMPLES, skipNotice } from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-samples', true);

function mkvs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? mkvs(join(dir, e.name)) : e.name.toLowerCase().endsWith('.mkv') ? [join(dir, e.name)] : [],
  );
}

describe.skipIf(skip !== null)('delivery: sample library', () => {
  it('the Cues index agrees with a linear packet scan of the first minute on every sample MKV (within 1 ms)', async () => {
    const probe = createDeliveryProbe(FFPROBE);
    const files = mkvs(SAMPLES);
    expect(files.length).toBeGreaterThan(3);
    for (const abs of files) {
      const st = statSync(abs);
      const name = relative(SAMPLES, abs);
      const built = await buildKeyframeIndex(
        { fileId: 'x', sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs), absPath: abs, container: 'matroska', videoStreamIndex: null, allowProbe: false, targetMs: 4000, maxGapMs: 6000, now: Date.now },
        probe,
      );
      expect(built.ok, name).toBe(true);
      if (!built.ok) continue;
      const ix = built.index;
      expect(ix.source, name).toBe('cues');
      expect(ix.times[0], name).toBeLessThan(100);
      // A linear read from the start, no seeking: independent of both the Cues and the seek probe.
      const { stdout } = await execa(FFPROBE, [
        '-v', 'error', '-select_streams', String(ix.videoStreamIndex), '-read_intervals', '%+60',
        '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', '-i', `file:${abs}`,
      ]);
      const scanned = stdout
        .split(/\r?\n/)
        .filter((l) => l.includes('K'))
        .map((l) => Number(l.split(',')[0]) * 1000 - ix.startTimeMs)
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b);
      expect(scanned.length, name).toBeGreaterThan(2);
      // The last scanned keyframe may be cut by the interval end; the Cues must list every one before it.
      const until = scanned.at(-1)!;
      const fromCues = ix.times.filter((k) => k <= until + 1);
      expect(fromCues.length, name).toBe(scanned.length);
      for (const [i, t] of scanned.entries()) expect(Math.abs(fromCues[i]! - t), `${name} keyframe ${i}`).toBeLessThanOrEqual(1);
    }
  }, 300_000);

  describe('through the routes', () => {
    let h: Harness;
    let slow: Harness;
    beforeAll(async () => {
      h = await harness([
        { name: 'Film', path: MOVIES() },
        { name: 'Serie', path: join(SAMPLES, 'series') },
      ]);
      slow = await harness([{ name: 'Film', path: MOVIES() }], { env: { DELIVERY_AHEAD_S: '4' } });
    });
    afterAll(async () => {
      await h?.close();
      await slow?.close();
    });

    it('Direct Play: Range on a real remux, codec string from the probed level', async () => {
      const facts = await factsOf(join(MOVIES(), SAMPLE.buono), { rootName: 'Film', relPath: SAMPLE.buono });
      const v = facts.streams.find((s) => s.type === 'video')!;
      expect(v.type === 'video' ? v.level : null).toBeGreaterThan(0);
      const r = await h.delivery.port.start(directPlayPlan('buono', facts), 'sess');
      if (!r.ok) throw new Error(JSON.stringify(r));
      expect(r.handle.mimeType).toMatch(/^video\/x-matroska; codecs="avc1\.[0-9A-F]{6}(, [a-z0-9.-]+)?"$/);
      const head = await h.app.inject({ method: 'GET', url: r.handle.locators.stream, headers: { range: 'bytes=0-3' } });
      expect(head.statusCode).toBe(206);
      expect(head.rawPayload.toString('hex')).toBe('1a45dfa3');
      expect(head.headers['content-range']).toBe(`bytes 0-3/${facts.sizeBytes}`);
      const mid = await h.app.inject({ method: 'GET', url: r.handle.locators.stream, headers: { range: 'bytes=50000000-50000999' } });
      expect(mid.statusCode).toBe(206);
      expect(mid.rawPayload.length).toBe(1000);
      await h.delivery.port.stop({ streamId: r.handle.streamId }, 'stopped');
    }, 60_000);

    it('an SRT sidecar is served as WebVTT (converted by ffmpeg, cached per stream)', async () => {
      const rel = 'Dark (2017)/Season 01/Dark - S01E01 - Segreti.mkv';
      const facts = await factsOf(join(SAMPLES, 'series', rel), { rootName: 'Serie', relPath: rel });
      const served: ServedSubtitle[] = [
        {
          trackId: 'x:srt1',
          source: { kind: 'sidecar', relPath: 'Dark (2017)/Season 01/Dark - S01E01 - Segreti.it.forced.srt', format: 'srt' },
          codec: 'subrip',
          language: 'ita',
          forced: true,
          delivery: 'sidecar',
          format: 'webvtt',
        },
      ];
      const plan = directPlayPlan('dark1', facts);
      const r = await h.delivery.port.start({ ...plan, subtitles: { selected: null, served } }, 'sess');
      if (!r.ok) throw new Error(JSON.stringify(r));
      const url = r.handle.locators.subtitles[0]!.url;
      expect(url).toMatch(/\/subtitles\/x:srt1\.vtt$/);
      const vtt = await h.app.inject({ method: 'GET', url });
      expect(vtt.statusCode).toBe(200);
      expect(vtt.headers['content-type']).toBe('text/vtt; charset=utf-8');
      expect(vtt.headers['cache-control']).toBe('no-store');
      expect(vtt.body.startsWith('WEBVTT')).toBe(true);
      expect(vtt.body).toMatch(/\d\d:\d\d\.\d{3} --> \d\d:\d\d\.\d{3}/);
      expect((await h.app.inject({ method: 'GET', url })).body).toBe(vtt.body);
      await h.delivery.port.stop({ streamId: r.handle.streamId }, 'stopped');
    }, 60_000);

    it('backpressure: with DELIVERY_AHEAD_S=4 the run pauses just past the last request', async () => {
      const facts = await factsOf(join(MOVIES(), SAMPLE.longTest), { rootName: 'Film', relPath: SAMPLE.longTest });
      const r = await slow.delivery.port.start(directStreamPlan('long-bp', facts, { audioIndex: 2 }), 'sess');
      if (!r.ok) throw new Error(JSON.stringify(r));
      const base = r.handle.locators.stream.replace(/main\.m3u8$/, '');
      expect((await slow.app.inject({ method: 'GET', url: `${base}seg-0-00000.m4s` })).statusCode).toBe(200);
      await new Promise((res) => setTimeout(res, 3000));
      const hls = slow.delivery.streamOf(r.handle.streamId)!.hls!;
      expect(hls.runInfo).not.toBeNull(); // paused, not finished
      expect(hls.runInfo!.current).toBeLessThanOrEqual(2);
      expect(hls.isReady(4)).toBe(false);
      // A request inside the window releases it.
      expect((await slow.app.inject({ method: 'GET', url: `${base}seg-0-00003.m4s` })).statusCode).toBe(200);
      await slow.delivery.port.stop({ streamId: r.handle.streamId }, 'stopped');
    }, 120_000);
  });
});
