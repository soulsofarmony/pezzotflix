// Converted audio across runs (H-M1): a restart at segment k must emit the audio frames of the run from 0,
// so a player switching from one run to the other at k sees no gap or overlap. For each case: the video
// samples of k..k+2 are byte-identical, the audio sample timestamps equal within 1 ms; the seam is the
// distance from the end of the reference's last audio frame in k−1 to the restart's first in k. A table
// of the seams goes to stderr. Generated fixtures always (ffmpeg needed), the sample library when present.
// Converted audio bytes are reported (the "bytes" column), not asserted: FLAC numbers its frames from the
// start of the run, and AAC/Opus frames depend on the encoder state before them.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AudioAction } from '../src/shared/playback-plan.ts';
import type { StreamHandle } from '../src/shared/ports.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import {
  directStreamPlan,
  factsOf,
  ffmpeg,
  HAVE_SAMPLES,
  MOVIES,
  parseInit,
  SAMPLE,
  type Sample,
  samplesOf,
  SAMPLES,
  skipNotice,
  tempDir,
  trackBytes,
} from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-audio-restart', false);
if (!skip && !HAVE_SAMPLES) process.stderr.write(`[delivery-audio-restart] sample cases skipped: sample library not found at ${SAMPLES}\n`);

const ACTIONS: Record<string, Extract<AudioAction, { kind: 'convert' }>> = {
  flac: { kind: 'convert', codec: 'flac', channels: 6, bitrateBps: null, layout: null },
  aac: { kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 640_000, layout: '5.1' },
  eac3: { kind: 'convert', codec: 'eac3', channels: 6, bitrateBps: 640_000, layout: '5.1' },
  opus: { kind: 'convert', codec: 'opus', channels: 6, bitrateBps: 448_000, layout: '5.1' },
};

interface Seam {
  label: string;
  k: number;
  /** Restart's first audio PTS in k minus the reference's, ms. */
  firstDelta: number;
  /** Restart's first audio PTS in k minus the end of the reference's last audio frame in k−1, ms. */
  seam: number;
  /** The same seam inside the reference run (the encoder's own continuity), ms. */
  refSeam: number;
  /** Largest audio PTS difference over k..k+2, ms; null when the frame counts differ. */
  maxDelta: number | null;
  /** Per segment k..k+2: audio sample bytes identical to the reference (y/n). */
  sameBytes: string;
}

describe.skipIf(skip !== null)('delivery: converted audio across restarts', () => {
  let root: string;
  let h: Harness;
  const seams: Seam[] = [];

  beforeAll(async () => {
    root = tempDir('pzf-audio-restart-');
    // 40 s of H.264 (2 s GOPs) with a 5.1 FLAC track whose tone changes every second: at 48 kHz, at
    // 44.1 and 96 kHz (m1), with start_time 3.5 s, and with the audio starting 1.3 s after the video.
    const tone = (name: string, rate: number, extra: { beforeAudio?: string[]; output?: string[] } = {}) =>
      ffmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
        ...(extra.beforeAudio ?? []),
        '-f', 'lavfi', '-i', `aevalsrc='sin(2*PI*(220+110*floor(t))*t)':s=${rate}:c=5.1`,
        '-t', '40',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
        '-c:a', 'flac',
        ...(extra.output ?? []),
        join(root, name),
      ]);
    await Promise.all([
      tone('tone.mkv', 48_000),
      tone('tone441.mkv', 44_100),
      tone('tone96.mkv', 96_000),
      tone('tonestart.mkv', 48_000, { output: ['-output_ts_offset', '3.5'] }),
      tone('tonelate.mkv', 48_000, { beforeAudio: ['-itsoffset', '1.3'] }),
    ]);
    const roots = [{ name: 'Gen', path: root }, ...(HAVE_SAMPLES ? [{ name: 'Film', path: MOVIES() }] : [])];
    h = await harness(roots);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    if (seams.length > 0) {
      const rows = seams.map((s) => `  ${s.label.padEnd(34)} k=${String(s.k).padStart(3)}  first ${fmt(s.firstDelta)}  seam ${fmt(s.seam)}  (in-run ${fmt(s.refSeam)})  max ${s.maxDelta === null ? 'n/a' : fmt(s.maxDelta)}  bytes ${s.sameBytes}`);
      process.stderr.write(`[delivery-audio-restart] seams, ms:\n${rows.join('\n')}\n`);
    }
  });

  const fmt = (ms: number) => `${ms >= 0 ? '+' : ''}${ms.toFixed(3)}`.padStart(9);
  const get = (url: string) => h.app.inject({ method: 'GET', url });
  const base = (handle: StreamHandle) => handle.locators.stream.replace(/main\.m3u8$/, '');
  const segUrl = (handle: StreamHandle, j: number) => `${base(handle)}seg-0-${String(j).padStart(5, '0')}.m4s`;

  async function fetchSeg(handle: StreamHandle, j: number): Promise<Buffer> {
    const r = await get(segUrl(handle, j));
    if (r.statusCode !== 200) throw new Error(`segment ${j}: ${r.statusCode} ${JSON.stringify(await h.delivery.port.status({ streamId: handle.streamId }))}`);
    return r.rawPayload;
  }

  /** Reference run from 0 (one run, read in order), then one restart per position, compared at k..k+2. */
  async function compare(rootName: string, relPath: string, audioIndex: number, codec: keyof typeof ACTIONS, positionsMs: number[]) {
    const abs = join(rootName === 'Gen' ? root : MOVIES(), relPath);
    const facts = await factsOf(abs, { rootName, relPath });
    const action = ACTIONS[codec]!;
    const label = `${relPath.split('/').at(-1)!.slice(0, 18)} a${audioIndex}→${codec}`;
    const start = async (id: string, startPositionMs = 0) => {
      const r = await h.delivery.port.start(directStreamPlan(id, facts, { audioIndex, action, startPositionMs }), `s-${id}`);
      if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
      return r.handle;
    };

    const restarts: { at: number; k: number; segs: Buffer[]; handle: StreamHandle }[] = [];
    for (const [i, at] of positionsMs.entries()) {
      const handle = await start(`${codec}-rs${i}-${audioIndex}`, at);
      restarts.push({ at, k: h.delivery.streamOf(handle.streamId)!.hls!.runInfo!.k, segs: [], handle });
    }
    // Restarts first, each stopped before the reference run so only one ffmpeg runs at a time.
    for (const r of restarts) {
      expect(r.k, `restart at ${r.at} ms`).toBeGreaterThan(0);
      for (let j = r.k; j <= r.k + 2; j++) r.segs.push(await fetchSeg(r.handle, j));
      await h.delivery.port.stop({ streamId: r.handle.streamId }, 'stopped');
    }

    const ref = await start(`${codec}-ref-${audioIndex}`);
    const init = parseInit((await get(`${base(ref)}init-0.mp4`)).rawPayload);
    const video = init.tracks.find((t) => t.handler === 'vide')!.id;
    const audio = init.tracks.find((t) => t.handler === 'soun')!.id;
    const last = Math.max(...restarts.map((r) => r.k + 2));
    const refSegs: Buffer[] = [];
    const refRun = new Set<number>();
    for (let j = 0; j <= last; j++) {
      refSegs.push(await fetchSeg(ref, j));
      refRun.add(h.delivery.streamOf(ref.streamId)!.hls!.segmentRun(j)!);
    }
    expect(refRun.size, 'the reference is one run').toBe(1);
    const lastSeg = (await get(`${base(ref)}media-0.m3u8`)).body.split('\n').filter((l) => l.endsWith('.m4s')).length - 1;
    await h.delivery.port.stop({ streamId: ref.streamId }, 'stopped');

    const aud = (seg: Buffer): Sample[] => samplesOf(seg, init).filter((s) => s.track === audio);
    for (const r of restarts) {
      for (let i = 0; i < 3; i++) {
        const j = r.k + i;
        expect(trackBytes(r.segs[i]!, init, video).equals(trackBytes(refSegs[j]!, init, video)), `${label}: video of segment ${j}`).toBe(true);
      }
      const refPrev = aud(refSegs[r.k - 1]!).at(-1)!;
      const refFirst = aud(refSegs[r.k]!)[0]!;
      const rsFirst = aud(r.segs[0]!)[0]!;
      const refAll = [0, 1, 2].flatMap((i) => aud(refSegs[r.k + i]!));
      const rsAll = r.segs.flatMap((s) => aud(s));
      // At the end of the file the encoder's flush may differ by one short frame: the total sample count
      // follows the first packet's timestamp, rounded to the ms by Matroska. Nothing plays after it.
      if (r.k + 2 === lastSeg && Math.abs(refAll.length - rsAll.length) === 1) {
        const end = (ss: Sample[]) => ss.at(-1)!.pts + ss.at(-1)!.duration;
        expect(Math.abs(end(refAll) - end(rsAll)), `${label} k=${r.k}: end of the audio`).toBeLessThanOrEqual(1);
        if (refAll.length > rsAll.length) refAll.pop();
        else rsAll.pop();
      }
      let maxDelta: number | null = null;
      if (refAll.length === rsAll.length) {
        maxDelta = 0;
        for (const [i, s] of rsAll.entries()) maxDelta = Math.max(maxDelta, Math.abs(s.pts - refAll[i]!.pts));
      }
      const seam: Seam = {
        label,
        k: r.k,
        firstDelta: rsFirst.pts - refFirst.pts,
        seam: rsFirst.pts - (refPrev.pts + refPrev.duration),
        refSeam: refFirst.pts - (refPrev.pts + refPrev.duration),
        maxDelta,
        sameBytes: [0, 1, 2].map((i) => (trackBytes(r.segs[i]!, init, audio).equals(trackBytes(refSegs[r.k + i]!, init, audio)) ? 'y' : 'n')).join(''),
      };
      seams.push(seam);
      expect(Math.abs(seam.firstDelta), `${label} k=${r.k}: first audio PTS`).toBeLessThanOrEqual(1);
      const tail = (ss: Sample[]) => (ss.length ? `${ss.length} frames ${ss[0]!.pts.toFixed(3)}..${(ss.at(-1)!.pts + ss.at(-1)!.duration).toFixed(3)}` : 'none');
      const counts = [0, 1, 2].map((i) => `seg ${r.k + i}: ${tail(aud(r.segs[i]!))} vs ${tail(aud(refSegs[r.k + i]!))}`).join('; ');
      expect(maxDelta, `${label} k=${r.k}: audio frame count (${counts})`).not.toBeNull();
      expect(maxDelta!, `${label} k=${r.k}: every audio PTS`).toBeLessThanOrEqual(1);
    }
  }

  for (const codec of ['flac', 'aac', 'eac3', 'opus'] as const) {
    it(`generated 5.1 FLAC → ${codec}: restarts at several k emit the reference's audio frames`, async () => {
      await compare('Gen', 'tone.mkv', 1, codec, [9_000, 17_300, 30_100]);
    }, 180_000);
  }

  // m1: the explicit aresample rate, for sources that are not 48 kHz (Opus, and E-AC-3 from 96 kHz, go to 48).
  for (const [file, rate] of [['tone441.mkv', '44.1'], ['tone96.mkv', '96']] as const) {
    for (const codec of ['flac', 'aac', 'eac3', 'opus'] as const) {
      it(`generated 5.1 FLAC at ${rate} kHz → ${codec}: restarts emit the reference's audio frames`, async () => {
        await compare('Gen', file, 1, codec, [9_000, 17_300, 30_100]);
      }, 180_000);
    }
  }

  for (const codec of ['flac', 'aac'] as const) {
    it(`start_time 3.5 s → ${codec}: the anchor is on the zero-based timeline`, async () => {
      await compare('Gen', 'tonestart.mkv', 1, codec, [9_000, 17_300, 30_100]);
    }, 180_000);
    it(`audio starting 1.3 s after the video → ${codec}: the reference pads from 0, restarts match it`, async () => {
      await compare('Gen', 'tonelate.mkv', 1, codec, [9_000, 17_300, 30_100]);
    }, 180_000);
  }

  describe.skipIf(!HAVE_SAMPLES)('sample library', () => {
    for (const codec of ['flac', 'aac', 'eac3', 'opus'] as const) {
      it(`Long Test, TrueHD 5.1 → ${codec}`, async () => {
        await compare('Film', SAMPLE.longTest, 1, codec, [21_000, 47_500, 90_000]);
      }, 600_000);
    }
    it('Il Buono, DTS 5.1 → flac', async () => {
      await compare('Film', SAMPLE.buono, 1, 'flac', [9_000, 17_000]);
    }, 300_000);
  });
});
