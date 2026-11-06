// Review round 2 of F1b.4, N1, over real ffmpeg: the read cap of a subtitle extraction is applied from Node
// (stdout of the frame-hash clock read no faster than R × wall time, the pipe holding ffmpeg), so a file with
// a dense and a sparse text track is read at R, not at real time (ffmpeg 8's -readrate slept on every gap of
// the sparse track). A generated 150 s file: A has a cue every second, B three cues 67 s apart. Measures the
// clock the extractor lets through (the reader) and the demuxer's progress, from the dense track's output
// while it grows: their slopes are the steady rate, the demuxer's offset over the pacing is the lead the pipe
// and Node's buffer allow (printed). Round 3: pass 2 of the late start must be stopped by its bound (SIGKILL),
// short of the end of the file. Skipped with a message without ffmpeg.
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execaSpawn } from '../src/modules/delivery/process.ts';
import { fingerprint } from '../src/modules/delivery/subtitle-cache.ts';
import { clockReader, createSubtitleExtractor, type ExtractFile, PASS2_MARGIN_S } from '../src/modules/delivery/subtitle-extract.ts';
import { parseExtractionOutputs } from './helpers/delivery-fake-extract.ts';
import { ffmpeg, FFMPEG, skipNotice, tempDir } from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-extraction-pace', false);
const DURATION_S = 150;
const FPS = 24;
const R = 12;
/**
 * Media seconds the demuxer may run ahead of the pacing: the chunk read last, Node's stream buffer and the pipe,
 * 64 KiB each, about 15.5 s of SHA-512 lines each at 24 fps (measured: 39 s on average).
 */
const LEAD_MAX_S = 60;

const stamp = (ms: number) => `00:${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
const srtOf = (starts: number[], tag: string) => starts.map((ms, i) => `${i + 1}\n${stamp(ms)} --> ${stamp(ms + 500)}\n${tag} ${ms}\n`).join('\n');
const DENSE = Array.from({ length: DURATION_S - 1 }, (_, i) => (i + 1) * 1000);
const SPARSE = [3000, 70_000, 137_000];

/** Start of the last cue of a growing WebVTT file, seconds; null before the first. */
function lastCueS(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let last: number | null = null;
  for (const m of text.matchAll(/^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3}) -->/gm)) {
    last = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  }
  return last;
}

/** Least-squares line through the points: slope and intercept. */
function fit(points: readonly { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const sxy = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const sxx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

interface PassRecord {
  args: string[];
  t0: number;
  wallS: number | null;
  /** (wall seconds since spawn, clock): what the extractor let through, chunk by chunk. */
  released: { x: number; y: number }[];
  signal: string | null;
  /** (wall seconds since spawn, last cue of the dense track): the demuxer's position. */
  samples: { x: number; y: number }[];
}

/**
 * The reader once the pipe is full: each read a whole stdout chunk (64 KiB, about 15 media s of hash lines
 * at 24 fps) when the previous one is due; not the first fill, nor what is drained at the exit.
 */
const steadyReads = (p: PassRecord) => p.released.filter((r, i) => i > 0 && r.y - p.released[i - 1]!.y >= 5 && r.x < p.wallS! - 0.05);

describe.skipIf(skip !== null)('delivery: a subtitle extraction is read at R from Node, sparse tracks included', () => {
  let work: string;
  let abs: string;
  let size: number;
  beforeAll(async () => {
    work = tempDir('pzf-x-pace-');
    writeFileSync(join(work, 'a.srt'), srtOf(DENSE, 'a'));
    writeFileSync(join(work, 'b.srt'), srtOf(SPARSE, 'b'));
    abs = join(work, 'paced.mkv');
    await ffmpeg([
      '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${FPS}:duration=${DURATION_S}`, '-i', join(work, 'a.srt'), '-i', join(work, 'b.srt'),
      '-map', '0:v', '-map', '1:s', '-map', '2:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(FPS * 2), '-c:s', 'srt', abs,
    ]);
    size = statSync(abs).size;
  }, 120_000);
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const fileBytesPerS = () => size / DURATION_S;

  function extractor(cacheDir: string, prerollS: number) {
    const real = execaSpawn(FFMPEG);
    const passes: PassRecord[] = [];
    const done: string[] = [];
    const timers: NodeJS.Timeout[] = [];
    const x = createSubtitleExtractor({
      config: { cacheDir, SUBTITLE_EXTRACT_MAX_MBPS: (fileBytesPerS() * R) / 1e6, SUBTITLE_PREROLL_S: prerollS, SUBTITLE_PREEXTRACT: 'off', SUBTITLE_CACHE_MAX_BYTES: 1e9 },
      log: pino({ level: 'silent' }),
      now: Date.now,
      spawn: (args) => {
        const rec: PassRecord = { args: [...args], t0: performance.now(), wallS: null, released: [], signal: null, samples: [] };
        passes.push(rec);
        const child = real(args);
        // Registered before the extractor's: its pause() holds this listener too, so this sees what it lets through.
        const read = clockReader();
        let carry = '';
        child.stdout.on('data', (c: Buffer) => {
          const lines = (carry + c.toString('latin1')).split('\n');
          carry = lines.pop()!;
          let y: number | null = null;
          for (const l of lines) y = read(l.trim()) ?? y;
          if (y !== null) rec.released.push({ x: (performance.now() - rec.t0) / 1000, y });
        });
        const dense = parseExtractionOutputs(args).find((o) => o.streamIndex === 1)!.path;
        const sampler = setInterval(() => {
          const y = lastCueS(dense);
          if (y !== null && rec.wallS === null) rec.samples.push({ x: (performance.now() - rec.t0) / 1000, y });
        }, 100);
        timers.push(sampler);
        void child.exited.then((e) => {
          rec.wallS = (performance.now() - rec.t0) / 1000;
          rec.signal = e.signal;
          clearInterval(sampler);
        });
        return child;
      },
      onComplete: (_fp, key) => done.push(key),
    });
    const close = async () => {
      for (const t of timers) clearInterval(t);
      await x.shutdown();
    };
    return { x, passes, done, close };
  }

  const waitFor = async (done: string[], n: number, ms: number) => {
    const end = Date.now() + ms;
    while (done.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };

  const full = async (index: number) =>
    (await execa(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', `file:${abs}`, '-copyts', '-start_at_zero', '-map', `0:${index}`, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'], { stripFinalNewline: false })).stdout;

  it('one pass from 0: the steady rate is R, the whole read about R plus the lead, not real time', async () => {
    const { x, passes, done, close } = extractor(join(work, 'cache-a'), 30);
    try {
      await x.init();
      const file: ExtractFile = { fileId: 'paced-a', sizeBytes: size, mtimeMs: 1, absPath: abs, durationMs: DURATION_S * 1000, videoStreamIndex: 0 };
      x.acquire('stream', file, [{ streamIndex: 1, format: 'vtt' }, { streamIndex: 2, format: 'vtt' }], 0);
      await waitFor(done, 2, 90_000);
      expect(done.sort()).toEqual(['s1.vtt', 's2.vtt']);
      expect(passes).toHaveLength(1);
      const p = passes[0]!;
      expect(p.args).toContain('framehash');
      expect(p.args).not.toContain('-readrate');
      const wallS = p.wallS!;
      const reads = steadyReads(p);
      expect(reads.length, 'full chunks read').toBeGreaterThanOrEqual(4);
      const reader = fit(reads);
      // The demuxer moves in steps of one stdout chunk; past the first fill, short of the end of the file.
      const demuxer = fit(p.samples.filter((s) => s.x > 0.5 && s.y < DURATION_S - 4));
      const overall = DURATION_S / wallS;
      const report =
        `R ${R}, file ${(fileBytesPerS() / 1e6).toFixed(3)} MB/s, cap ${((fileBytesPerS() * R) / 1e6).toFixed(2)} MB/s; ` +
        `wall ${wallS.toFixed(2)} s (real time ${DURATION_S} s), overall ${overall.toFixed(2)}x = ${((overall * fileBytesPerS()) / 1e6).toFixed(2)} MB/s; ` +
        `reader ${reader.slope.toFixed(2)}x, demuxer ${demuxer.slope.toFixed(2)}x, lead ${demuxer.intercept.toFixed(1)} media s`;
      process.stderr.write(`[delivery-extraction-pace] one pass: ${report}\n`);
      expect(reader.slope, report).toBeGreaterThanOrEqual(0.8 * R);
      expect(reader.slope, report).toBeLessThanOrEqual(1.2 * R);
      expect(demuxer.slope, report).toBeGreaterThanOrEqual(0.7 * R);
      expect(demuxer.slope, report).toBeLessThanOrEqual(1.3 * R);
      expect(overall, report).toBeGreaterThanOrEqual(0.8 * R);
      // Over R only by the lead, read once at the start: a bounded offset, not a rate.
      expect(demuxer.intercept, report).toBeLessThan(LEAD_MAX_S);
      expect(wallS, report).toBeGreaterThanOrEqual((DURATION_S - LEAD_MAX_S) / R);
    } finally {
      await close();
    }
  }, 120_000);

  it('a start at 100 s: pass 1 bursts the pre-roll, pass 2 is read at R up to P₁; both merges equal a full extraction', async () => {
    const prerollS = 20;
    const { x, passes, done, close } = extractor(join(work, 'cache-b'), prerollS);
    try {
      await x.init();
      const refs = [await full(1), await full(2)];
      const file: ExtractFile = { fileId: 'paced-b', sizeBytes: size, mtimeMs: 2, absPath: abs, durationMs: DURATION_S * 1000, videoStreamIndex: 0 };
      x.acquire('stream', file, [{ streamIndex: 1, format: 'vtt' }, { streamIndex: 2, format: 'vtt' }], 100_000);
      await waitFor(done, 2, 90_000);
      expect(done.sort()).toEqual(['s1.vtt', 's2.vtt']);
      expect(passes).toHaveLength(2);
      const [p1, p2] = passes as [PassRecord, PassRecord];
      for (const p of passes) expect(p.args).toContain('framehash');
      // Pass 2 reads [0, P₁ + margin] (P₁ ≈ 80 s) at R, no burst; held through the settle, then killed.
      const reads = steadyReads(p2);
      expect(reads.length, 'full chunks read').toBeGreaterThanOrEqual(3);
      const reader = fit(reads);
      const lastClock = p2.released.at(-1)!.y;
      const report =
        `pass 1 (from 80 s, burst ${prerollS} s): wall ${p1.wallS!.toFixed(2)} s for ${DURATION_S - 80} media s; ` +
        `pass 2: reader ${reader.slope.toFixed(2)}x, wall ${p2.wallS!.toFixed(2)} s${p2.signal ? ` (${p2.signal})` : ''} to clock ${lastClock} s ` +
        `= ${(lastClock / p2.wallS!).toFixed(2)}x`;
      process.stderr.write(`[delivery-extraction-pace] start at 100 s: ${report}\n`);
      expect(lastClock, report).toBeGreaterThanOrEqual(78 + PASS2_MARGIN_S);
      // S1: the bound stopped pass 2, it did not run to the end of the file (round 3).
      expect(p2.signal, report).toBe('SIGKILL');
      expect(lastClock, report).toBeLessThan(DURATION_S);
      expect(reader.slope, report).toBeGreaterThanOrEqual(0.8 * R);
      expect(reader.slope, report).toBeLessThanOrEqual(1.2 * R);
      expect(lastClock / p2.wallS!, report).toBeGreaterThanOrEqual(0.8 * R);
      // Pass 1: 70 media s, of which the burst and the lead come at once; the rest at R.
      expect(p1.wallS!, report).toBeLessThanOrEqual((DURATION_S - 80 - prerollS) / (0.8 * R) + 1);
      for (const [i, key] of ['s1.vtt', 's2.vtt'].entries()) expect(readFileSync(x.cache.path(fingerprint(file), key), 'utf8'), key).toBe(refs[i]);
    } finally {
      await close();
    }
  }, 120_000);
});
