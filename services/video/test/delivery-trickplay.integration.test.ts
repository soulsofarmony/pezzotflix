// Trickplay with the real ffmpeg (ADR 0009 D1–D3): a synthetic source whose luma is its own original time
// (40 + 2·floor(T), a burnt-in timecode readable without OCR), start_time 3.5 s, keyframes every 2 s, SAR 4:3.
// Checks the tile count, the tile size from the display aspect ratio, and that tile i shows ≈ i × 10 s on the
// original timeline. The HDR part (PQ, HLG through tonemapx) runs only with jellyfin-ffmpeg; elsewhere it skips.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { execaSpawn } from '../src/modules/delivery/process.ts';
import { generateTrickplay, hasFilter, type TrickplayTransfer, trickplaySpawn } from '../src/modules/delivery/trickplay.ts';
import { ffmpeg, FFMPEG, HAVE_FFMPEG, skipNotice, tempDir } from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-trickplay.integration', false);
const HAVE_TONEMAPX = HAVE_FFMPEG && (await hasFilter(execaSpawn(FFMPEG), 'tonemapx'));
if (HAVE_FFMPEG && !HAVE_TONEMAPX) process.stderr.write(`[delivery-trickplay.integration] HDR cases skipped: ${FFMPEG} has no tonemapx (jellyfin-ffmpeg only)\n`);

const dir = tempDir('pzf-tp-int-');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DURATION_MS = 65_000;

/** Fixture: 320x180 SAR 4:3 (displayed 427x180), 25 fps, IDR every 2 s, timestamps from 3.5 s, MKV. */
async function makeSource(name: string, transfer: TrickplayTransfer): Promise<string> {
  const path = join(dir, `${name}.mkv`);
  const pq = transfer === 'pq' ? ',zscale=tin=bt709:min=bt709:pin=bt709:t=smpte2084:m=bt2020nc:p=bt2020:npl=100' : '';
  const hlg = transfer === 'hlg' ? ',zscale=tin=bt709:min=bt709:pin=bt709:t=arib-std-b67:m=bt2020nc:p=bt2020:npl=100' : '';
  await ffmpeg([
    '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=25:d=${DURATION_MS / 1000}`,
    '-vf', `geq=lum='40+2*floor(T)':cb=128:cr=128,setsar=4/3${pq}${hlg},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2',
    '-output_ts_offset', '3.5',
    path,
  ]);
  return path;
}

/**
 * Luma of each tile, back to the source's limited range: the sheet averaged down to 10×10 pixels per tile, the
 * centre one read (the tile's edges carry JPEG ringing from the neighbouring tile).
 */
async function tileLumas(sheet: string): Promise<number[]> {
  const r = await execa(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', sheet, '-vf', 'scale=100:100:flags=area', '-pix_fmt', 'yuvj420p', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
  const y = r.stdout;
  return Array.from({ length: 100 }, (_, i) => y[(Math.floor(i / 10) * 10 + 5) * 100 + (i % 10) * 10 + 5]!).map((v) => (v * 219) / 255 + 16);
}

async function run(source: string, transfer: TrickplayTransfer, gopMs: number | null, name: string) {
  const outDir = mkdtempSync(join(dir, `out-${name}-`));
  const out = await generateTrickplay(trickplaySpawn(FFMPEG), {
    absPath: source,
    videoStreamIndex: 0,
    transfer,
    durationMs: DURATION_MS,
    sourceHeight: 180,
    gopMs,
    outDir,
    timeoutMs: 120_000,
    signal: new AbortController().signal,
  });
  return { out, outDir };
}

describe.skipIf(skip !== null)('trickplay with ffmpeg', () => {
  it('SDR: 7 tiles of 320x136 (SAR applied); tile i shows the keyframe at i × 10 s of the original timeline', async () => {
    const src = await makeSource('sdr', 'sdr');
    const { out, outDir } = await run(src, 'sdr', 2000, 'sdr');
    expect(out).toEqual({ ok: true, intervalMs: 10_000, count: 7, sheets: 1, tileWidth: 320, tileHeight: 136 });
    const sheet = readFileSync(join(outDir, 'sheet-0.jpg'));
    expect(sheet.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const shown = (await tileLumas(join(outDir, 'sheet-0.jpg'))).slice(0, 7).map((y) => (y - 40) / 2);
    shown.forEach((t, i) => expect(Math.abs(t - i * 10), `tile ${i} shows ${t.toFixed(1)} s`).toBeLessThanOrEqual(1.5));
  });

  it('without a known GOP each tile stays within half an interval of i × 10 s', async () => {
    const src = join(dir, 'sdr.mkv');
    const { out, outDir } = await run(src, 'sdr', null, 'nogop');
    expect(out).toMatchObject({ ok: true, count: 7 });
    const shown = (await tileLumas(join(outDir, 'sheet-0.jpg'))).slice(0, 7).map((y) => (y - 40) / 2);
    shown.forEach((t, i) => expect(Math.abs(t - i * 10), `tile ${i} shows ${t.toFixed(1)} s`).toBeLessThanOrEqual(5.5));
  });

  it('a broken file is a permanent failure, not a crash', async () => {
    const { out } = await run(join(dir, 'missing.mkv'), 'sdr', null, 'missing');
    expect(out).toMatchObject({ ok: false, permanent: true });
  });

  it.skipIf(!HAVE_TONEMAPX).each(['pq', 'hlg'] as const)('%s: tone-mapped through tonemapx, every tile, time still increasing', async (transfer) => {
    const src = await makeSource(transfer, transfer);
    const { out, outDir } = await run(src, transfer, 2000, transfer);
    expect(out).toEqual({ ok: true, intervalMs: 10_000, count: 7, sheets: 1, tileWidth: 320, tileHeight: 136 });
    const y = (await tileLumas(join(outDir, 'sheet-0.jpg'))).slice(0, 7);
    for (let i = 1; i < y.length; i++) expect(y[i]!, `tile ${i} brighter than tile ${i - 1}`).toBeGreaterThan(y[i - 1]!);
  });
});
