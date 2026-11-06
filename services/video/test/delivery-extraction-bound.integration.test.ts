// Review round 1 of F1b.4, S1, over real ffmpeg: input -t does not end the read of pass 2 while a mapped
// subtitle track has no packet past P₁, so pass 2 carries no -t and is stopped from its video clock (the video
// copied to frame hashes on stdout, paced from Node at R = 10). A generated 120 s file with two text tracks: A
// has one cue, at 9.5 s (P₁ of a session at 12 s), B one at 2 s and the next at 100 s. The file is longer than
// the pacing's lead (about 38 media s at 24 fps) plus the settle, so pass 2 cannot end by itself before the
// bound (round 3): checks that the real clock is read, pass 2 is stopped (SIGKILL) past P₁ + margin and short
// of the next cue of B, and both merges equal a full extraction. Skipped without ffmpeg.
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execaSpawn } from '../src/modules/delivery/process.ts';
import { fingerprint } from '../src/modules/delivery/subtitle-cache.ts';
import { clockReader, createSubtitleExtractor, type ExtractFile, PASS2_MARGIN_S } from '../src/modules/delivery/subtitle-extract.ts';
import { ffmpeg, FFMPEG, skipNotice, tempDir } from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-extraction-bound', false);
const DURATION_S = 120;
/** B's next cue after 2 s: far past where the bound stops pass 2 (P₁ + margin + the pacing's lead). */
const B_NEXT_MS = 100_000;

const stamp = (ms: number) => `00:${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
/** Half-second cues at these times (ms). */
const srtOf = (starts: number[], tag: string) => starts.map((ms, i) => `${i + 1}\n${stamp(ms)} --> ${stamp(ms + 500)}\n${tag} ${ms}\n`).join('\n');

describe.skipIf(skip !== null)('delivery: pass 2 of a subtitle extraction stops past P₁', () => {
  let work: string;
  let abs: string;
  beforeAll(async () => {
    work = tempDir('pzf-x-bound-');
    writeFileSync(join(work, 'a.srt'), srtOf([9500], 'a'));
    writeFileSync(join(work, 'b.srt'), srtOf([2000, B_NEXT_MS], 'b'));
    abs = join(work, 'sparse.mkv');
    await ffmpeg([
      '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=24:duration=${DURATION_S}`, '-i', join(work, 'a.srt'), '-i', join(work, 'b.srt'),
      '-map', '0:v', '-map', '1:s', '-map', '2:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-c:s', 'srt', abs,
    ]);
  }, 120_000);
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const full = async (index: number) =>
    (await execa(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', `file:${abs}`, '-copyts', '-start_at_zero', '-map', `0:${index}`, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'], { stripFinalNewline: false })).stdout;

  it('pass 2 has no -t, its real clock is read, it is stopped (SIGKILL) past P₁ + margin, short of the next cue of the sparse track; both merges equal a full extraction', async () => {
    const size = statSync(abs).size;
    const refs = [await full(1), await full(2)];
    expect(refs[1]).toContain(`b ${B_NEXT_MS}`);
    const real = execaSpawn(FFMPEG);
    const passes: { args: string[]; ms: number | null; clockS: number | null; signal: string | null }[] = [];
    const done: string[] = [];
    const x = createSubtitleExtractor({
      // R = 10 on this file.
      config: { cacheDir: join(work, 'cache'), SUBTITLE_EXTRACT_MAX_MBPS: ((size / DURATION_S) * 10) / 1e6, SUBTITLE_PREROLL_S: 3, SUBTITLE_PREEXTRACT: 'off', SUBTITLE_CACHE_MAX_BYTES: 1e9 },
      log: pino({ level: 'silent' }),
      now: Date.now,
      spawn: (args) => {
        const rec = { args: [...args], ms: null as number | null, clockS: null as number | null, signal: null as string | null };
        passes.push(rec);
        const t0 = performance.now();
        const child = real(args);
        const read = clockReader();
        let carry = '';
        child.stdout.on('data', (c: Buffer) => {
          const lines = (carry + c.toString('latin1')).split('\n');
          carry = lines.pop()!;
          for (const l of lines) rec.clockS = read(l.trim()) ?? rec.clockS;
        });
        void child.exited.then((e) => {
          rec.ms = performance.now() - t0;
          rec.signal = e.signal;
        });
        return child;
      },
      onComplete: (_fp, key) => done.push(key),
    });
    try {
      await x.init();
      const file: ExtractFile = { fileId: 'sparse', sizeBytes: size, mtimeMs: 1, absPath: abs, durationMs: DURATION_S * 1000, videoStreamIndex: 0 };
      x.acquire('stream', file, [{ streamIndex: 1, format: 'vtt' }, { streamIndex: 2, format: 'vtt' }], 12_000);
      const end = Date.now() + 120_000;
      while (done.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      const report = passes
        .map((p, i) => `pass ${i + 1}: ${p.ms === null ? 'running' : `${(p.ms / 1000).toFixed(2)} s`}, clock ${p.clockS ?? '-'} s${p.signal ? `, ${p.signal}` : ''}`)
        .join('; ');
      process.stderr.write(`[delivery-extraction-bound] ${report}\n`);
      expect(done.sort(), report).toEqual(['s1.vtt', 's2.vtt']);
      expect(passes).toHaveLength(2);
      const p2 = passes[1]!;
      expect(p2.args).not.toContain('-t');
      expect(p2.args).toContain('framehash');
      // The clock was read; the bound stopped pass 2 (SIGKILL) past P₁ + margin, never as far as B's next cue.
      expect(p2.clockS).not.toBeNull();
      expect(p2.signal, report).toBe('SIGKILL');
      expect(p2.clockS!).toBeGreaterThanOrEqual(9.5 + PASS2_MARGIN_S);
      expect(p2.clockS!).toBeLessThan(B_NEXT_MS / 1000);
      for (const [i, key] of ['s1.vtt', 's2.vtt'].entries()) expect(readFileSync(x.cache.path(fingerprint(file), key), 'utf8'), key).toBe(refs[i]);
    } finally {
      await x.shutdown();
    }
  }, 180_000);
});
