// Software Transcode restarts and grid edges over real ffmpeg, on fixtures generated in a temp dir (ADR 0003
// D3/D4, review round 1 T1, T2, T4):
// - a video stream shorter than the container: the grid ends with the video, one run serves it all (T1);
// - a restart at k (a new stream started inside segment k) against the run from 0, at k..k+2: same video
//   frames and PTS, audio frames on the same PTS (copied audio byte-identical), and no hole or click where a
//   player joins the reference's segment k−1 to the restart's segment k (converted audio decoded across the
//   join, 5 ms RMS windows). Converted and copied audio, a long-GOP source and an MPEG-TS source (T2);
// - an interlaced source comes out progressive on the same grid, restarts included (T4).
// A table of the seams goes to stderr. Skipped with a message when ffmpeg/ffprobe are missing.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execaSpawn } from '../src/modules/delivery/process.ts';
import type { AudioAction } from '../src/shared/playback-plan.ts';
import type { StreamHandle } from '../src/shared/ports.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import { factsOf, ffmpeg, FFMPEG, FFPROBE, parseInit, type Sample, samplesOf, skipNotice, tempDir, trackBytes, transcodePlan } from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-transcode-restart', false);

const AAC: AudioAction = { kind: 'convert', codec: 'aac', channels: 2, bitrateBps: 192_000, layout: 'stereo' };
const COPY: AudioAction = { kind: 'copy' };
const AMPLITUDE = 0.5;

interface SeamRow {
  label: string;
  k: number;
  /** Restart's first audio PTS in k minus the reference's, ms. */
  firstDelta: number;
  /** Largest audio PTS difference over k..k+2, ms. */
  maxDelta: number;
  /** Lowest 5 ms RMS within 100 ms of the join, as a fraction of the reference's median (converted audio). */
  minRms: number | null;
  /** Largest sample difference from the reference within 100 ms after the join, as a fraction of the tone's peak. */
  maxDiff: number | null;
}

describe.skipIf(skip !== null)('delivery: Transcode restarts and grid edges on generated fixtures', () => {
  let lib: string;
  let work: string;
  let h: Harness;
  let spawns = 0;
  const seams: SeamRow[] = [];

  beforeAll(async () => {
    [lib, work] = [tempDir('pzf-txr-lib-'), tempDir('pzf-txr-work-')];
    const tone = `aevalsrc='${AMPLITUDE}*sin(2*PI*440*t)':s=48000:c=stereo`;
    const x264 = (gop: number) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-bf', '2'];
    await Promise.all([
      // T1: 251 frames at 24 fps (10.458 s) and 14 s of audio: the container lasts 14 s.
      ffmpeg([
        '-f', 'lavfi', '-t', '10.458', '-i', 'testsrc2=size=320x240:rate=24',
        '-f', 'lavfi', '-t', '14', '-i', 'sine=f=440:sample_rate=48000',
        '-map', '0:v', '-map', '1:a', ...x264(48), '-c:a', 'aac', '-b:a', '128k',
        join(lib, 'short.mkv'),
      ]),
      // T2: a steady tone as FLAC (converted) and as AAC (copied), 2 s GOPs.
      ffmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', tone, '-t', '28',
        '-map', '0:v', '-map', '1:a', '-map', '1:a', ...x264(50), '-c:a:0', 'flac', '-c:a:1', 'aac', '-b:a:1', '192k',
        join(lib, 'tone.mkv'),
      ]),
      // T2: 10 s GOPs, so Bₖ₋₁ is far from the keyframe before it.
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', tone, '-t', '28', ...x264(250), '-c:a', 'flac', join(lib, 'long.mkv')]),
      // T2: Blu-ray MPEG-TS (192-byte packets, timestamps from 600 s), AC-3.
      ffmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', tone, '-t', '28',
        ...x264(50), '-c:a', 'ac3', '-b:a', '192k', '-output_ts_offset', '600', '-f', 'mpegts', '-mpegts_m2ts_mode', '1',
        join(lib, 'tone.m2ts'),
      ]),
      // T4: PAL interlaced, top field first (MBAFF): fields woven from 50 fps motion, so they comb. AAC.
      ffmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=720x576:rate=50', '-f', 'lavfi', '-i', tone, '-t', '20',
        '-vf', 'tinterlace=mode=interleave_top,setfield=tff', ...x264(50), '-flags', '+ildct+ilme', '-x264-params', 'tff=1', '-c:a', 'aac', '-b:a', '128k',
        join(lib, 'inter.mkv'),
      ]),
    ]);
    const real = execaSpawn(FFMPEG);
    h = await harness([{ name: 'Gen', path: lib }], {
      spawn: (args) => {
        spawns++;
        return real(args);
      },
      extractSpawn: real,
    });
  }, 300_000);

  afterAll(async () => {
    await h?.close();
    for (const dir of [lib, work]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    if (seams.length > 0) {
      const f = (n: number | null, d = 3) => (n === null ? 'n/a' : n.toFixed(d)).padStart(7);
      const rows = seams.map((s) => `  ${s.label.padEnd(26)} k=${String(s.k).padStart(2)}  first ${f(s.firstDelta)}  max ${f(s.maxDelta)} ms  min RMS ${f(s.minRms, 2)}  max diff ${f(s.maxDiff, 3)}`);
      process.stderr.write(`[delivery-transcode-restart] seams:\n${rows.join('\n')}\n`);
    }
  });

  const get = (url: string) => h.app.inject({ method: 'GET', url });
  const base = (handle: StreamHandle) => handle.locators.stream.replace(/main\.m3u8$/, '');
  const segName = (j: number) => `seg-0-${String(j).padStart(5, '0')}.m4s`;
  async function segment(handle: StreamHandle, j: number): Promise<Buffer> {
    const r = await get(`${base(handle)}${segName(j)}`);
    if (r.statusCode !== 200) throw new Error(`${segName(j)}: ${r.statusCode} ${JSON.stringify(await h.delivery.port.status({ streamId: handle.streamId }))}`);
    return r.rawPayload;
  }
  async function start(relPath: string, audioIndex: number, action: AudioAction, startPositionMs = 0): Promise<StreamHandle> {
    const facts = await factsOf(join(lib, relPath), { rootName: 'Gen', relPath });
    const r = await h.delivery.port.start(transcodePlan(relPath.replace(/\W/g, '-'), facts, { audioIndex, action, startPositionMs }), `s-${Math.random()}`);
    if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
    return r.handle;
  }
  const initOf = async (handle: StreamHandle) => (await get(`${base(handle)}init-0.mp4`)).rawPayload;

  /** Mono 48 kHz PCM of an fMP4 built from parts (init + segments), as a player decodes it. */
  async function pcm(parts: Buffer[]): Promise<Int16Array> {
    const path = join(work, `pcm-${Math.random().toString(36).slice(2)}.mp4`);
    writeFileSync(path, Buffer.concat(parts));
    const r = await execa(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer' });
    const b = Buffer.from(r.stdout);
    const out = new Int16Array(b.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2);
    return out;
  }
  const rms = (x: Int16Array, from: number, n: number) => {
    let s = 0;
    for (let i = from; i < from + n; i++) s += x[i]! * x[i]!;
    return Math.sqrt(s / n);
  };

  /**
   * The run from 0 read in order, then one new stream per position (its first run at k, from Bₖ₋₁), each
   * compared with the reference at k..k+2. Converted audio: the reference's k−1 joined to the restart's k
   * decodes without a hole or a click.
   */
  async function compare(label: string, relPath: string, audioIndex: number, action: AudioAction, positionsMs: number[]) {
    const restarts: { k: number; segs: Buffer[]; init: Buffer }[] = [];
    for (const at of positionsMs) {
      const handle = await start(relPath, audioIndex, action, at);
      const k = h.delivery.streamOf(handle.streamId)!.hls!.runInfo!.k;
      expect(k, `${label} at ${at} ms`).toBeGreaterThan(1);
      const segs = [k, k + 1, k + 2].map((j) => segment(handle, j));
      restarts.push({ k, segs: await Promise.all(segs), init: await initOf(handle) });
      // The pre-roll segment is encoded and dropped.
      expect(h.delivery.streamOf(handle.streamId)!.hls!.segmentRun(k - 1), `${label}: segment k−1 of the restart`).toBeNull();
      await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    }
    const ref = await start(relPath, audioIndex, action);
    const initBytes = await initOf(ref);
    const init = parseInit(initBytes);
    const video = init.tracks.find((t) => t.handler === 'vide')!.id;
    const audio = init.tracks.find((t) => t.handler === 'soun')!.id;
    const refSegs: Buffer[] = [];
    const runs = new Set<number>();
    for (let j = 0; j <= Math.max(...restarts.map((r) => r.k + 2)); j++) {
      refSegs.push(await segment(ref, j));
      runs.add(h.delivery.streamOf(ref.streamId)!.hls!.segmentRun(j)!);
    }
    expect(runs.size, `${label}: the reference is one run`).toBe(1);
    await h.delivery.port.stop({ streamId: ref.streamId }, 'stopped');

    const of = (s: Buffer, track: number): Sample[] => samplesOf(s, init).filter((x) => x.track === track);
    for (const r of restarts) {
      expect(r.init.equals(initBytes), `${label} k=${r.k}: init`).toBe(true);
      for (let i = 0; i < 3; i++) {
        const j = r.k + i;
        const [a, b] = [of(r.segs[i]!, video), of(refSegs[j]!, video)];
        expect(a.length, `${label}: video frames of ${segName(j)}`).toBe(b.length);
        expect(a[0]!.sync, `${label}: ${segName(j)} starts with an IDR`).toBe(true);
        const worst = Math.max(...a.map((s, n) => Math.abs(s.pts - b[n]!.pts)));
        expect(worst, `${label}: video PTS of ${segName(j)}`).toBeLessThan(0.001);
      }
      const rsAudio = r.segs.flatMap((s) => of(s, audio));
      const refAudio = [0, 1, 2].flatMap((i) => of(refSegs[r.k + i]!, audio));
      expect(rsAudio.length, `${label} k=${r.k}: audio frames`).toBe(refAudio.length);
      const maxDelta = Math.max(...rsAudio.map((s, n) => Math.abs(s.pts - refAudio[n]!.pts)));
      expect(maxDelta, `${label} k=${r.k}: audio PTS`).toBeLessThanOrEqual(1);
      const row: SeamRow = { label, k: r.k, firstDelta: rsAudio[0]!.pts - refAudio[0]!.pts, maxDelta, minRms: null, maxDiff: null };
      if (action.kind === 'copy') {
        for (let i = 0; i < 3; i++) expect(trackBytes(r.segs[i]!, init, audio).equals(trackBytes(refSegs[r.k + i]!, init, audio)), `${label}: copied audio of ${segName(r.k + i)}`).toBe(true);
      } else {
        const prev = of(refSegs[r.k - 1]!, audio);
        const join = Math.round(((refAudio[0]!.pts - prev[0]!.pts) * 48_000) / 1000);
        const [want, got] = await Promise.all([pcm([initBytes, refSegs[r.k - 1]!, refSegs[r.k]!]), pcm([initBytes, refSegs[r.k - 1]!, r.segs[0]!])]);
        const win = 240;
        const all: number[] = [];
        for (let i = win; i + win < want.length; i += win) all.push(rms(want, i, win));
        const median = all.sort((x, y) => x - y)[all.length >> 1]!;
        let minRms = Number.POSITIVE_INFINITY;
        for (let i = join - 4800; i < join + 4800; i += win / 2) minRms = Math.min(minRms, rms(got, i, win) / median);
        let maxDiff = 0;
        for (let i = join; i < join + 4800; i++) maxDiff = Math.max(maxDiff, Math.abs(got[i]! - want[i]!) / (AMPLITUDE * 32_767));
        Object.assign(row, { minRms, maxDiff });
        expect(minRms, `${label} k=${r.k}: no hole at the join`).toBeGreaterThan(0.8);
        expect(maxDiff, `${label} k=${r.k}: no click at the join`).toBeLessThan(0.1);
      }
      seams.push(row);
    }
  }

  it('T1: a video shorter than the container: the grid ends with the video, one run serves every segment', async () => {
    const facts = await factsOf(join(lib, 'short.mkv'), { rootName: 'Gen', relPath: 'short.mkv' });
    expect(facts.durationMs).toBeGreaterThanOrEqual(13_900);
    spawns = 0;
    const handle = await start('short.mkv', 1, AAC);
    const media = (await get(`${base(handle)}media-0.m3u8`)).body;
    const durations = [...media.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
    expect(durations).toHaveLength(3);
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(251 / 24, 1);
    for (let j = 0; j < 3; j++) await segment(handle, j);
    const status = await h.delivery.port.status({ streamId: handle.streamId });
    expect(h.delivery.streamOf(handle.streamId)!.hls!.terminal).toBe(false);
    expect(status).not.toMatchObject({ state: 'failed' });
    process.stderr.write(`[delivery-transcode-restart] T1: container 14 s, video 10.458 s → ${durations.length} segments (${durations.join(' + ')} s), ${spawns} ffmpeg run(s)\n`);
    expect(spawns).toBe(1);
    await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
  }, 120_000);

  it('T2: converted audio (FLAC → AAC): restarts at k = 2 and 4 match the run from 0, no hole at the join', async () => {
    await compare('tone.mkv FLAC→AAC', 'tone.mkv', 1, AAC, [9_000, 17_300]);
  }, 240_000);

  it('T2: copied audio (AAC): restarts emit the reference audio bytes', async () => {
    await compare('tone.mkv AAC copy', 'tone.mkv', 2, COPY, [9_000, 17_300]);
  }, 240_000);

  it('T2: long GOP (10 s): restarts from far after the source keyframe match the run from 0', async () => {
    await compare('long.mkv FLAC→AAC', 'long.mkv', 1, AAC, [9_000, 17_300]);
  }, 240_000);

  it('T2: MPEG-TS from 600 s (AC-3 → AAC): restarts match the run from 0', async () => {
    await compare('tone.m2ts AC-3→AAC', 'tone.m2ts', 1, AAC, [9_000, 13_300]);
  }, 240_000);

  it('T4: an interlaced source comes out progressive (combing gone), IDRs on the grid, restarts match the run from 0', async () => {
    // Flags say how frames are coded; idet looks at the picture (combing between the fields).
    const interlacedFlags = async (path: string) =>
      (await execa(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#4', '-show_entries', 'frame=interlaced_frame', '-of', 'csv=p=0', path])).stdout.match(/^\d/gm) ?? [];
    const idet = async (path: string) => {
      const r = await execa(FFMPEG, ['-hide_banner', '-nostats', '-i', path, '-map', '0:v:0', '-vf', 'idet', '-f', 'null', '-']);
      const m = [...r.stderr.matchAll(/Multi frame detection: TFF:\s*(\d+) BFF:\s*(\d+) Progressive:\s*(\d+) Undetermined:\s*(\d+)/g)].at(-1)!;
      return { interlaced: Number(m[1]) + Number(m[2]), progressive: Number(m[3]), total: [1, 2, 3, 4].reduce((n, i) => n + Number(m[i]), 0) };
    };
    expect(await interlacedFlags(join(lib, 'inter.mkv'))).toEqual(['1', '1', '1', '1']);
    const source = await idet(join(lib, 'inter.mkv'));
    expect(source.interlaced / source.total).toBeGreaterThan(0.9);
    await compare('inter.mkv AAC copy', 'inter.mkv', 1, COPY, [9_000]);
    const handle = await start('inter.mkv', 1, COPY);
    const path = join(work, 'inter-out.mp4');
    writeFileSync(path, Buffer.concat([await initOf(handle), await segment(handle, 0), await segment(handle, 1)]));
    await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    const out = await idet(path);
    process.stderr.write(`[delivery-transcode-restart] T4 idet: source ${source.interlaced}/${source.total} interlaced, output ${out.progressive}/${out.total} progressive\n`);
    expect(out.total).toBe(200);
    expect(out.progressive / out.total).toBeGreaterThan(0.9);
  }, 240_000);
});
