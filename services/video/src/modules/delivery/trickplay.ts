// Trickplay (ADR 0009): seek-bar preview sprite sheets of a file. One ffmpeg pass over the keyframes only
// (-skip_frame nokey), at low CPU priority (nice) with few threads; the fps filter picks one frame per interval
// on the zero-based original timeline (nearest keyframe when the GOP is known), PQ/HLG are tone-mapped to SDR with tonemapx (jellyfin-ffmpeg only),
// and tile composes 10×10 grids of 320 px wide JPEG tiles. A second branch of the graph writes one framecrc
// line per tile on stdout: the outcome is judged by the tiles produced, never by the log (D4).
// Cache: <cache>/delivery/trickplay/<fileId>/<size>-<mtime>-v<version>/ (manifest.json + sheet-N.jpg), written
// into a .tmp-<uuid> sibling and renamed into place; older stamps are deleted after. Arguments are an array,
// never a shell string (ADR 0001 rule 3).
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TRICKPLAY_VERSION } from '../../shared/job-types.ts';
import type { HdrFormat } from '../../shared/media-facts.ts';
import { binaryExists, type ChildLike, type ExitInfo, execaSpawn, failedChild, type Spawn, terminate } from './process.ts';
import { StderrRing } from './stderr.ts';

export const TRICKPLAY_COLUMNS = 10;
export const TRICKPLAY_ROWS = 10;
export const TILES_PER_SHEET = TRICKPLAY_COLUMNS * TRICKPLAY_ROWS;
export const TILE_WIDTH = 320;
/** D2: one tile every 10 s, longer past MAX_TILES. */
export const BASE_INTERVAL_MS = 10_000;
export const MAX_TILES = 2000;
/** mjpeg -q:v (D1). */
export const JPEG_QUALITY = 4;
/** nice level of the generation (D3): every thread of the process inherits it. */
export const TRICKPLAY_NICE = 10;
/** Decoder threads (D3, measured in T1 step 0): enough for 4K keyframes, few enough to leave the CPU to playback. */
export const TRICKPLAY_THREADS = 2;
/** delivery.trickplay attempts (index.ts registers the job with it). */
export const TRICKPLAY_JOB_MAX_ATTEMPTS = 3;
/** While a stream is active the job is put off this long, without using an attempt (D5). */
export const TRICKPLAY_DEFER_MS = 5 * 60_000;
/**
 * How much of the end the tiles may miss: the fps filter emits slots only up to the last keyframe it saw, x265
 * re-encodes put keyframes up to ~10 s apart (13 s measured), and the container's duration may run on with the
 * audio. 2001 (T1 step 0) produced 892 of 894 tiles; Suspiria (1977, x265 1080p) ends on a 38 s GOP over the
 * credits and produced 592 of 596. The client shows the last tile for the missing tail. A truncated or broken
 * file misses far more.
 */
export const TAIL_TOLERANCE_MS = 60_000;
/** Longest duration a generation accepts (a hostile value must stay cheap). */
const MAX_DURATION_MS = 7 * 24 * 3600 * 1000;
/**
 * Job timeout from the file size. T1 step 0 on the home server (nice 10, 2 threads): 32 MB/s on a 56 GB 4K remux
 * with 1 s GOPs (CPU-bound, 29 min), 57–61 MB/s on a 4K x265 re-encode and a 1080p (read-bound). 8 MB/s leaves a
 * 4× margin on the slowest, for a run that shares the machine with playback; never under 20 min.
 */
export const TRICKPLAY_TIMEOUT_FLOOR_MS = 20 * 60_000;
export const TRICKPLAY_MIN_BYTES_PER_S = 8 * 1000 ** 2;
/** How long a failure that is not permanent (timeout, I/O) keeps a session start from enqueueing again. */
export const TRICKPLAY_TRANSIENT_FAILURE_TTL_MS = 6 * 3600_000;

export const timeoutFor = (sizeBytes: number): number => Math.max(TRICKPLAY_TIMEOUT_FLOOR_MS, Math.ceil((sizeBytes / TRICKPLAY_MIN_BYTES_PER_S) * 1000));
/**
 * The full-decode fallback is bound by the decoder, not by the disk: at least the film's duration (1× real time).
 * A 1080p x265 re-encode of 99 min did not finish in 20 min on the home server (nice 10, 2 threads).
 */
export const fullDecodeTimeoutMs = (timeoutMs: number, durationMs: number): number => Math.max(timeoutMs, Math.ceil(durationMs));

// ---------------------------------------------------------------- pure parameters

/** D2: 10 s, or the whole second that keeps the tiles at MAX_TILES or fewer. */
export function intervalFor(durationMs: number): number {
  return Math.max(BASE_INTERVAL_MS / 1000, Math.ceil(durationMs / MAX_TILES / 1000)) * 1000;
}

/** Tiles of a full output: tile i covers i × interval, for every i × interval before the end. */
export const expectedTiles = (durationMs: number, intervalMs: number): number => Math.max(1, Math.ceil(durationMs / intervalMs));

/** The fewest tiles a complete output has (TAIL_TOLERANCE_MS). */
export const minimumTiles = (durationMs: number, intervalMs: number): number =>
  Math.max(1, expectedTiles(durationMs, intervalMs) - Math.ceil(TAIL_TOLERANCE_MS / intervalMs));

/**
 * Forward shift of the timestamps before the fps filter, in ms. With round=near the slot n takes the latest frame
 * before n·I + I/2, so with keyframes every g ms it shows a frame from [n·I + I/2 − g, n·I + I/2): shifted by
 * (I − g)/2 that window becomes [n·I − g/2, n·I + g/2), the keyframe nearest to n·I (D2). Without a known GOP
 * (or g ≥ I) no shift: the window is ±I/2, which is where the long GOPs of x265 re-encodes put it anyway.
 */
export function gopShiftMs(intervalMs: number, gopMs: number | null): number {
  if (gopMs === null || !(gopMs > 0) || gopMs >= intervalMs) return 0;
  return Math.round((intervalMs - gopMs) / 2);
}

/** Median gap of keyframe times (ms), null with fewer than two. */
export function medianGapMs(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1]!;
}

export type TrickplayTransfer = 'sdr' | 'pq' | 'hlg';

export interface TrickplayVideo {
  hdr: HdrFormat;
  hdrFallback: readonly HdrFormat[];
  dolbyVisionProfile: number | null;
}

/**
 * The transfer the decoder outputs, or why the file gets no previews (D3): DV is read as its base layer
 * (HDR10/HDR10+, HLG, SDR, in the engine's order); DV profile 5, or DV without a known base layer, has none
 * whose colours a tone mapper understands.
 */
export function trickplayTransfer(v: TrickplayVideo): { transfer: TrickplayTransfer } | { skip: string } {
  if (v.dolbyVisionProfile === 5) return { skip: 'Dolby Vision profile 5 has no HDR10, HLG or SDR base layer' };
  let base: HdrFormat = v.hdr;
  if (v.hdr === 'DV') {
    const has = (f: HdrFormat) => v.hdrFallback.includes(f);
    const found = has('HDR10') || has('HDR10+') ? 'HDR10' : has('HLG') ? 'HLG' : has('SDR') ? 'SDR' : null;
    if (!found) return { skip: 'Dolby Vision without a known base layer' };
    base = found;
  }
  return { transfer: base === 'SDR' ? 'sdr' : base === 'HLG' ? 'hlg' : 'pq' };
}

/** Width 320, height from the display aspect ratio (the stream's SAR applied, ffmpeg's dar), even. */
const FIT = `scale=w=${TILE_WIDTH}:h=trunc(${TILE_WIDTH}/dar/2+0.5)*2`;

/**
 * The per-tile chain, up to yuvj420p. JPEG decoders read YCbCr as BT.601 full range (JFIF), so the tiles are
 * converted to that: an SDR source from BT.709 (HD) or BT.601 (SD), an HDR source after the tone mapping. The
 * scale comes before the tone mapping: on 320 px frames it costs nothing. Untagged HD sources are read as
 * BT.709, as players do. eof_action=pass emits the last slot too, which the default drops at the end of input.
 */
export function trickplayFilter(transfer: TrickplayTransfer, intervalMs: number, sourceHeight: number, shiftMs = 0): string {
  const fps = `${shiftMs > 0 ? `setpts=PTS+${(shiftMs / 1000).toFixed(3)}/TB,` : ''}fps=1/${Math.round(intervalMs / 1000)}:start_time=0:round=near:eof_action=pass`;
  if (transfer === 'sdr') {
    const matrix = sourceHeight > 576 ? 'bt709' : 'bt601';
    return [fps, `${FIT}:in_color_matrix=${matrix}:out_color_matrix=bt601:out_range=pc`, 'setsar=1', 'format=yuvj420p'].join(',');
  }
  const tin = transfer === 'hlg' ? 'arib-std-b67' : 'smpte2084';
  return [
    fps,
    FIT,
    'setsar=1',
    `zscale=tin=${tin}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemapx=tonemap=bt2390:desat=0',
    'zscale=t=bt709:m=470bg:r=full',
    'format=yuvj420p',
  ].join(',');
}

export interface TrickplayArgsInput {
  absPath: string;
  videoStreamIndex: number;
  transfer: TrickplayTransfer;
  intervalMs: number;
  sourceHeight: number;
  outDir: string;
  /** gopShiftMs; 0 by default. */
  shiftMs?: number;
  threads?: number;
  /**
   * Decode the keyframes only (-skip_frame nokey, the default). false decodes every frame: the fallback for
   * streams whose decoder outputs nothing from keyframes alone (Blu-ray H.264 with non-IDR I-frames).
   */
  keyframesOnly?: boolean;
}

/**
 * The ffmpeg arguments (the nice prefix is the spawn's, trickplaySpawn). Without -copyts ffmpeg subtracts the
 * file's start_time from every timestamp, so the fps filter's slots sit on the original timeline (D2). Sheets
 * go to <outDir>/sheet-%d.jpg from 0; the framecrc of the tiles goes to stdout.
 */
export function trickplayArgs(i: TrickplayArgsInput): string[] {
  if (!Number.isSafeInteger(i.videoStreamIndex) || i.videoStreamIndex < 0) throw new Error(`invalid stream index ${i.videoStreamIndex}`);
  const graph = `[0:${i.videoStreamIndex}]${trickplayFilter(i.transfer, i.intervalMs, i.sourceHeight, i.shiftMs ?? 0)},split[t][c];[t]tile=${TRICKPLAY_COLUMNS}x${TRICKPLAY_ROWS}[s]`;
  return [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-loglevel', 'error',
    '-filter_threads', '1',
    '-threads', String(i.threads ?? TRICKPLAY_THREADS),
    ...(i.keyframesOnly === false ? [] : ['-skip_frame', 'nokey']),
    '-i', `file:${i.absPath}`,
    '-filter_complex', graph,
    '-map', '[s]',
    '-c:v', 'mjpeg',
    '-q:v', String(JPEG_QUALITY),
    '-fps_mode', 'passthrough',
    '-f', 'image2',
    '-start_number', '0',
    // image2 expands % sequences in the whole path.
    join(i.outDir.replaceAll('%', '%%'), 'sheet-%d.jpg'),
    '-map', '[c]',
    '-fps_mode', 'passthrough',
    '-f', 'framecrc',
    'pipe:1',
  ];
}

/** Tiles and their size from the framecrc on stdout: one line per tile, '#dimensions 0: WxH' in the header. */
export function parseFramecrc(text: string): { tiles: number; width: number; height: number } | null {
  let tiles = 0;
  let dims: RegExpExecArray | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) dims ??= /^#dimensions 0:\s*(\d+)x(\d+)/.exec(line);
    else if (/^0,/.test(line)) tiles++;
  }
  if (!dims) return null;
  return { tiles, width: Number(dims[1]), height: Number(dims[2]) };
}

// ---------------------------------------------------------------- process

/**
 * ffmpeg under `nice -n 10` where nice exists (Linux, the container); plain ffmpeg elsewhere (Windows dev
 * hosts). A missing ffmpeg is a spawn failure, not nice's exit 127.
 */
export function trickplaySpawn(ffmpegPath: string): Spawn {
  if (process.platform === 'win32' || !binaryExists('nice')) return execaSpawn(ffmpegPath);
  const inner = execaSpawn('nice', ['-n', String(TRICKPLAY_NICE), ffmpegPath]);
  let found = false;
  return (args) => {
    if (!found) found = binaryExists(ffmpegPath);
    return found ? inner(args) : failedChild(`ffmpeg not found: ${ffmpegPath}`);
  };
}

/** Reads a child's stdout to the end (bounded) and its stderr into a ring. */
function collect(child: ChildLike, maxBytes: number): { stdout: Promise<string>; stderr: StderrRing } {
  const stderr = new StderrRing(16 * 1024);
  child.stderr.on('data', (c: Buffer) => stderr.push(c));
  child.stderr.on('error', () => {});
  const stdout = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (c: Buffer) => {
      if (size < maxBytes) chunks.push(c);
      size += c.length;
    });
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    child.stdout.once('end', done);
    child.stdout.once('close', done);
    child.stdout.once('error', done);
  });
  return { stdout, stderr };
}

/** Whether ffmpeg has a filter (tonemapx exists in jellyfin-ffmpeg only), from `ffmpeg -filters`. */
export async function hasFilter(spawn: Spawn, name: string, timeoutMs = 30_000): Promise<boolean> {
  const child = spawn(['-hide_banner', '-nostdin', '-filters']);
  const { stdout } = collect(child, 4 * 1024 * 1024);
  const timer = setTimeout(() => void terminate(child, 'discard'), timeoutMs);
  try {
    const [text, exit] = await Promise.all([stdout, child.exited]);
    if (exit.error || exit.exitCode !== 0) return false;
    return new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(text);
  } finally {
    clearTimeout(timer);
  }
}

export interface GenerateInput {
  absPath: string;
  videoStreamIndex: number;
  transfer: TrickplayTransfer;
  durationMs: number;
  sourceHeight: number;
  /** Typical keyframe spacing of the stream (median gap of its keyframe index), null when unknown. */
  gopMs: number | null;
  outDir: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type GenerateOutcome =
  | { ok: true; intervalMs: number; count: number; sheets: number; tileWidth: number; tileHeight: number }
  /** permanent: ffmpeg ran and exited, or its output is short or malformed; otherwise timeout or spawn failure. */
  | { ok: false; permanent: boolean; reason: string };

/** Sheet files sheet-0 … sheet-(n-1) in a directory, or -1 when the numbering has a hole or a stray name. */
async function countSheets(dir: string): Promise<number> {
  const names = (await readdir(dir)).filter((n) => n.startsWith('sheet-'));
  const ids = names.map((n) => /^sheet-(0|[1-9]\d{0,3})\.jpg$/.exec(n)).map((m) => (m ? Number(m[1]) : -1));
  ids.sort((a, b) => a - b);
  return ids.every((id, i) => id === i) ? ids.length : -1;
}

/** A clean ffmpeg exit that produced too few tiles: the cue for the full-decode fallback. */
const isShortOutput = (o: GenerateOutcome): boolean => !o.ok && o.permanent && /^(short output|no tiles produced)/.test(o.reason);

/**
 * One generation into outDir (which must exist and be empty). Throws when aborted (shutdown: nothing to record)
 * and on an error of the output directory (I/O: transient). Keyframes only first; when ffmpeg exits cleanly
 * with too few tiles (the H.264 decoder outputs nothing from the non-IDR I-frames of some Blu-ray streams,
 * seen on a 1971 AVC remux on 2026-11-27), the partial sheets are removed and every frame is decoded instead.
 */
export async function generateTrickplay(spawn: Spawn, input: GenerateInput): Promise<GenerateOutcome> {
  if (!(input.durationMs > 0) || input.durationMs > MAX_DURATION_MS) return { ok: false, permanent: true, reason: `duration ${input.durationMs} ms out of range` };
  const first = await generateOnce(spawn, input, true);
  if (!isShortOutput(first)) return first;
  for (const name of await readdir(input.outDir)) await rm(join(input.outDir, name), { force: true });
  const full = await generateOnce(spawn, input, false);
  return full.ok ? full : { ...full, reason: `keyframes only: ${first.ok ? '' : first.reason.slice(0, 200)}; full decode: ${full.reason}` };
}

async function generateOnce(spawn: Spawn, input: GenerateInput, keyframesOnly: boolean): Promise<GenerateOutcome> {
  const intervalMs = intervalFor(input.durationMs);
  const args = trickplayArgs({
    absPath: input.absPath,
    videoStreamIndex: input.videoStreamIndex,
    transfer: input.transfer,
    intervalMs,
    sourceHeight: input.sourceHeight,
    outDir: input.outDir,
    // With every frame decoded, fps=round=near already picks the frame nearest to each slot.
    shiftMs: keyframesOnly ? gopShiftMs(intervalMs, input.gopMs) : 0,
    keyframesOnly,
  });
  const timeoutMs = keyframesOnly ? input.timeoutMs : fullDecodeTimeoutMs(input.timeoutMs, input.durationMs);
  input.signal.throwIfAborted();
  const child = spawn(args);
  const { stdout, stderr } = collect(child, 1024 * 1024);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate(child, 'discard');
  }, timeoutMs);
  const onAbort = () => void terminate(child, 'discard');
  input.signal.addEventListener('abort', onAbort, { once: true });
  let exit: ExitInfo;
  let text: string;
  try {
    [exit, text] = await Promise.all([child.exited, stdout]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', onAbort);
  }
  input.signal.throwIfAborted();
  const tail = () => stderr.tail(1500).trim();
  if (exit.error) return { ok: false, permanent: false, reason: `ffmpeg not runnable: ${exit.error}` };
  if (timedOut) return { ok: false, permanent: false, reason: `timed out after ${Math.round(timeoutMs / 1000)} s` };
  // Killed by a signal we did not send (the OOM killer, a stop of the container): the content is not at fault.
  if (exit.exitCode === null && exit.signal) return { ok: false, permanent: false, reason: `ffmpeg killed by ${exit.signal}: ${tail()}` };
  if (exit.exitCode !== 0) return { ok: false, permanent: true, reason: `ffmpeg exited with ${exit.exitCode ?? exit.signal}: ${tail()}` };
  const crc = parseFramecrc(text);
  if (!crc || crc.tiles === 0 || crc.width <= 0 || crc.height <= 0) return { ok: false, permanent: true, reason: `no tiles produced: ${tail()}` };
  if (crc.tiles < minimumTiles(input.durationMs, intervalMs)) {
    return { ok: false, permanent: true, reason: `short output: ${crc.tiles} of ${expectedTiles(input.durationMs, intervalMs)} tiles. ${tail()}`.trim() };
  }
  const written = await countSheets(input.outDir);
  if (written !== Math.ceil(crc.tiles / TILES_PER_SHEET)) return { ok: false, permanent: true, reason: `${written} sheets for ${crc.tiles} tiles` };
  // A slot past the end (eof_action=pass with the GOP shift) is never asked for: the count is clamped to the
  // expected tiles, so the manifest stays valid, and a sheet holding only such tiles is left unlisted.
  const count = Math.min(crc.tiles, expectedTiles(input.durationMs, intervalMs), MAX_TILES);
  return { ok: true, intervalMs, count, sheets: Math.ceil(count / TILES_PER_SHEET), tileWidth: crc.width, tileHeight: crc.height };
}

// ---------------------------------------------------------------- cache

export interface TrickplayStamp {
  fileId: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface TrickplayManifest extends TrickplayStamp {
  version: typeof TRICKPLAY_VERSION;
  videoStreamIndex: number;
  intervalMs: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  count: number;
  sheets: number;
  builtAt: number;
  elapsedMs: number;
}

const int = z.number().int().nonnegative();
const ManifestJson = z.object({
  version: z.literal(TRICKPLAY_VERSION),
  fileId: z.string(),
  sizeBytes: int,
  mtimeMs: int,
  videoStreamIndex: int,
  intervalMs: z.number().int().positive(),
  tileWidth: z.number().int().positive(),
  tileHeight: z.number().int().positive(),
  columns: z.literal(TRICKPLAY_COLUMNS),
  rows: z.literal(TRICKPLAY_ROWS),
  count: z.number().int().positive().max(MAX_TILES),
  sheets: z.number().int().positive(),
  builtAt: z.number(),
  elapsedMs: z.number(),
});

export interface TrickplayFailure extends TrickplayStamp {
  version: typeof TRICKPLAY_VERSION;
  reason: string;
  permanent: boolean;
  at: number;
}

const FailureJson = z.object({
  version: z.literal(TRICKPLAY_VERSION),
  fileId: z.string(),
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  reason: z.string(),
  permanent: z.boolean(),
  at: z.number(),
});

const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STAMP_DIR = /^\d+-\d+-v\d+$/;
const FAILURE_FILE = 'failed.json';
const MANIFEST_FILE = 'manifest.json';

/** A cached set of sheets: its manifest and the directory that holds them. */
export interface TrickplayEntry {
  manifest: TrickplayManifest;
  dir: string;
}

/** A manifest that get() would reject: the output is at fault, not the cache volume. */
export class InvalidManifest extends Error {}

export class TrickplayCache {
  readonly root: string;

  constructor(cacheDir: string) {
    this.root = join(cacheDir, 'delivery', 'trickplay');
  }

  /** The file's directory; the id is checked like the keyframe cache's, it never names a path of its own. */
  fileDir(fileId: string): string {
    if (!FILE_ID.test(fileId)) throw new Error(`invalid file id ${JSON.stringify(fileId)}`);
    return join(this.root, fileId);
  }

  static stampName(s: TrickplayStamp): string {
    if (!Number.isSafeInteger(s.sizeBytes) || s.sizeBytes < 0 || !Number.isSafeInteger(s.mtimeMs) || s.mtimeMs < 0) {
      throw new Error(`invalid stamp ${s.sizeBytes}/${s.mtimeMs}`);
    }
    return `${s.sizeBytes}-${s.mtimeMs}-v${TRICKPLAY_VERSION}`;
  }

  stampDir(s: TrickplayStamp): string {
    return join(this.fileDir(s.fileId), TrickplayCache.stampName(s));
  }

  private async readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
      return null;
    }
  }

  /** The sheets of exactly this content, parameter version and video stream, all present, or null. */
  async get(s: TrickplayStamp, videoStreamIndex: number): Promise<TrickplayEntry | null> {
    const dir = this.stampDir(s);
    const parsed = ManifestJson.safeParse(await this.readJson(join(dir, MANIFEST_FILE)));
    if (!parsed.success) return null;
    const m = parsed.data;
    if (m.fileId !== s.fileId || m.sizeBytes !== s.sizeBytes || m.mtimeMs !== s.mtimeMs || m.videoStreamIndex !== videoStreamIndex) return null;
    if (m.sheets !== Math.ceil(m.count / TILES_PER_SHEET)) return null;
    for (let k = 0; k < m.sheets; k++) {
      const st = await stat(join(dir, `sheet-${k}.jpg`)).catch(() => null);
      if (!st?.isFile()) return null;
    }
    return { manifest: m, dir };
  }

  /** A new empty working directory next to the stamps (same volume, so the rename is atomic). */
  async makeTmp(fileId: string): Promise<string> {
    const dir = join(this.fileDir(fileId), `.tmp-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async discard(tmp: string): Promise<void> {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  /**
   * Writes the manifest into tmp and renames it to its stamp; then deletes the older stamps and the failure
   * record. A leftover directory of the same stamp (an unreadable manifest) is replaced.
   */
  /** Throws (before anything is written) when the manifest would not pass get(). */
  async commit(tmp: string, manifest: TrickplayManifest): Promise<TrickplayEntry> {
    const valid = ManifestJson.safeParse(manifest);
    if (!valid.success) throw new InvalidManifest(`invalid trickplay manifest: ${valid.error.message}`);
    await writeFile(join(tmp, MANIFEST_FILE), JSON.stringify(manifest));
    const target = this.stampDir(manifest);
    await rm(target, { recursive: true, force: true, maxRetries: 3 });
    await rename(tmp, target);
    const fileDir = this.fileDir(manifest.fileId);
    const keep = TrickplayCache.stampName(manifest);
    for (const name of await readdir(fileDir).catch(() => [] as string[])) {
      if (name === FAILURE_FILE || (STAMP_DIR.test(name) && name !== keep)) await rm(join(fileDir, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
    return { manifest, dir: target };
  }

  /** The recorded failure of exactly this content and version: permanent, or transient within its TTL. */
  async getFailure(s: TrickplayStamp, now: number): Promise<TrickplayFailure | null> {
    const parsed = FailureJson.safeParse(await this.readJson(join(this.fileDir(s.fileId), FAILURE_FILE)));
    if (!parsed.success) return null;
    const f = parsed.data;
    if (f.fileId !== s.fileId || f.sizeBytes !== s.sizeBytes || f.mtimeMs !== s.mtimeMs) return null;
    return f.permanent || now - f.at < TRICKPLAY_TRANSIENT_FAILURE_TTL_MS ? f : null;
  }

  async putFailure(s: TrickplayStamp, reason: string, at: number, permanent: boolean): Promise<void> {
    const dir = this.fileDir(s.fileId);
    await mkdir(dir, { recursive: true });
    const f: TrickplayFailure = { version: TRICKPLAY_VERSION, fileId: s.fileId, sizeBytes: s.sizeBytes, mtimeMs: s.mtimeMs, reason: reason.slice(0, 2000), permanent, at };
    const target = join(dir, FAILURE_FILE);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(f));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Deletes the working directories a previous process left (startup, before any job runs). */
  async cleanOrphans(): Promise<number> {
    let n = 0;
    for (const fileId of await readdir(this.root).catch(() => [] as string[])) {
      if (!FILE_ID.test(fileId)) continue;
      const dir = join(this.root, fileId);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!name.startsWith('.tmp-')) continue;
        await rm(join(dir, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
        n++;
      }
    }
    return n;
  }
}
