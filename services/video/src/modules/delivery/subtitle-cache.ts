// Extracted subtitle tracks on the cache volume (ADR 0003 D12): <cacheDir>/delivery/subtitles/<fingerprint>/<key>,
// key = s<streamIndex>.<sup|vtt|ass>. A file lands there only by an atomic rename after a clean extraction,
// flushed to disk first, so whatever is there is whole; a restart still checks each file's shape and drops
// a damaged one. A track whose pass 2 was given up is whole from its P on and marked partial (<key>.partial). Bounded by SUBTITLE_CACHE_MAX_BYTES with LRU eviction; the last use is the file's mtime, so
// the order survives restarts. Work files (.work-*) never survive a restart.
import { mkdir, open, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { SUP_HEADER_BYTES, type SubtitleFormat } from './subtitle-format.ts';

/** The content a cache entry belongs to: the plan's file stamp (ADR 0003 D8/D12). */
export interface FileStamp {
  fileId: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** Directory name of one file content: a changed file (size or mtime) gets a new one. */
export function fingerprint(f: FileStamp): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(f.fileId)) throw new Error(`invalid file id ${JSON.stringify(f.fileId)}`);
  return `${f.fileId}-${Math.trunc(f.sizeBytes).toString(36)}-${Math.trunc(f.mtimeMs).toString(36)}`;
}

export const outputKey = (streamIndex: number, format: SubtitleFormat): string => {
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) throw new Error(`invalid stream index ${streamIndex}`);
  return `s${streamIndex}.${format}`;
};

const KEY_RE = /^s\d+\.(sup|vtt|ass)$/;
/**
 * Marker of a partial entry (pass 2 given up: no cue before P), next to it: <key>.partial, its mtime the
 * time of the give-up. Written before the entry's rename and removed after a complete one replaces it, so a
 * crash in between leaves at worst an orphan marker (removed at init) or a complete entry marked partial
 * (extracted once more).
 */
const PARTIAL_SUFFIX = '.partial';
const PARTIAL_RE = /^(s\d+\.(sup|vtt|ass))\.partial$/;

/**
 * Whether a cached file has the shape of a finished extraction, in O(1) reads: a .sup starts with a PGS
 * segment and ends with an END segment (type 0x80, no payload), as every display set does; WebVTT and ASS
 * start with their header and end with a line break. A file cut by a crash fails one of these.
 */
export async function looksComplete(path: string, format: SubtitleFormat): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size === 0) return format === 'sup';
    const headLen = Math.min(size, 16);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    if (format === 'sup') {
      if (size < SUP_HEADER_BYTES || head.readUInt16BE(0) !== 0x5047) return false;
      const tail = Buffer.alloc(SUP_HEADER_BYTES);
      await fh.read(tail, 0, SUP_HEADER_BYTES, size - SUP_HEADER_BYTES);
      return tail.readUInt16BE(0) === 0x5047 && tail[10] === 0x80 && tail.readUInt16BE(11) === 0;
    }
    const text = (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? head.subarray(3) : head).toString('utf8');
    if (!text.startsWith(format === 'vtt' ? 'WEBVTT' : '[Script Info]')) return false;
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

/** Data of a finished file on the disk before it is renamed into the cache (and the rename after it, where the OS allows). */
async function flushToDisk(path: string): Promise<void> {
  const fh = await open(path, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function flushDir(dir: string): Promise<void> {
  // Windows cannot open a directory for a flush; NTFS journals the rename itself.
  if (process.platform === 'win32') return;
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
/** A use touches the file's mtime at most this often. */
const TOUCH_EVERY_MS = 60_000;

interface Entry {
  bytes: number;
  lastUsed: number;
  /** When it was cached as partial (its marker's mtime); null: complete. */
  partialAt: number | null;
}

export class SubtitleCache {
  readonly root: string;
  private readonly max: number;
  private readonly log: FastifyBaseLogger;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private used = 0;
  /** Fingerprints in use (active streams, running extractions): never evicted. */
  private pinned: () => ReadonlySet<string> = () => new Set();

  constructor(cacheDir: string, maxBytes: number, log: FastifyBaseLogger, now: () => number) {
    this.root = join(cacheDir, 'delivery', 'subtitles');
    this.max = maxBytes;
    this.log = log;
    this.now = now;
  }

  setPinned(fn: () => ReadonlySet<string>): void {
    this.pinned = fn;
  }

  get usedBytes(): number {
    return this.used;
  }

  path(fp: string, key: string): string {
    return join(this.root, fp, key);
  }

  /** Scratch directory of one extraction, on the same volume as the cache (the final rename is atomic). */
  workDir(fp: string, jobId: string): string {
    return join(this.root, fp, `.work-${jobId}`);
  }

  has(fp: string, key: string): boolean {
    return this.entries.has(`${fp}/${key}`);
  }

  /** When a partial entry was cached (pass 2 given up); null for a complete entry or none. */
  partialSince(fp: string, key: string): number | null {
    return this.entries.get(`${fp}/${key}`)?.partialAt ?? null;
  }

  private markerPath(fp: string, key: string): string {
    return `${this.path(fp, key)}${PARTIAL_SUFFIX}`;
  }

  /** Rebuilds the index from the disk, removes leftovers of a previous process, evicts over the limit. */
  async init(): Promise<void> {
    this.entries.clear();
    this.used = 0;
    await mkdir(this.root, { recursive: true });
    for (const dir of await readdir(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const fpDir = join(this.root, dir.name);
      let names: string[];
      try {
        names = await readdir(fpDir);
      } catch {
        continue;
      }
      const markers = new Map<string, string>();
      for (const name of names) {
        const p = join(fpDir, name);
        const marker = PARTIAL_RE.exec(name);
        if (marker) {
          markers.set(marker[1]!, p);
          continue;
        }
        if (!KEY_RE.test(name)) {
          // An interrupted extraction (.work-*, .part): never complete, never served.
          await rm(p, { recursive: true, force: true, maxRetries: 3 }).catch((err: unknown) => this.log.warn({ path: p, err: String(err) }, 'subtitle work files not removed'));
          continue;
        }
        try {
          if (!(await looksComplete(p, name.slice(name.lastIndexOf('.') + 1) as SubtitleFormat))) {
            this.log.warn({ entry: `${dir.name}/${name}` }, 'damaged subtitle cache entry removed');
            await rm(p, { force: true }).catch((err: unknown) => this.log.warn({ entry: `${dir.name}/${name}`, err: String(err) }, 'damaged subtitle cache entry not removed'));
            continue;
          }
          const st = await stat(p);
          this.entries.set(`${dir.name}/${name}`, { bytes: st.size, lastUsed: st.mtimeMs, partialAt: null });
          this.used += st.size;
        } catch {
          // Gone meanwhile.
        }
      }
      for (const [key, p] of markers) {
        const e = this.entries.get(`${dir.name}/${key}`);
        const at = e ? await stat(p).then((s) => s.mtimeMs, () => null) : null;
        if (e && at !== null) e.partialAt = at;
        else await rm(p, { force: true }).catch(() => {});
      }
      if ((await readdir(fpDir).catch(() => ['?'])).length === 0) await rm(fpDir, { recursive: true, force: true }).catch(() => {});
    }
    await this.evict();
  }

  /** Records a use (LRU): in memory at once, on disk at most once a minute. */
  touch(fp: string, key: string): void {
    const e = this.entries.get(`${fp}/${key}`);
    if (!e) return;
    const t = this.now();
    if (t - e.lastUsed < TOUCH_EVERY_MS) return;
    e.lastUsed = t;
    const date = new Date(t);
    void utimes(this.path(fp, key), date, date).catch(() => {});
  }

  /**
   * Moves a finished file into the cache (flushed, then an atomic rename on the same volume), then evicts over
   * the limit. partial: pass 2 was given up, the file has no cue before its P (marked, see PARTIAL_SUFFIX).
   */
  async put(fp: string, key: string, src: string, opts: { partial?: boolean } = {}): Promise<void> {
    const dest = this.path(fp, key);
    const marker = this.markerPath(fp, key);
    const partial = opts.partial === true;
    await mkdir(join(this.root, fp), { recursive: true });
    const st = await stat(src);
    await flushToDisk(src);
    const date = new Date(this.now());
    if (partial) {
      await writeFile(marker, '');
      await utimes(marker, date, date).catch(() => {});
    }
    const id = `${fp}/${key}`;
    try {
      await rename(src, dest);
    } catch (err) {
      // The marker of an entry that was not there, or complete, must not outlive this put.
      if (partial && this.partialSince(fp, key) === null) await rm(marker, { force: true }).catch(() => {});
      throw err;
    }
    if (!partial) await rm(marker, { force: true }).catch((err: unknown) => this.log.warn({ fp, key, err: String(err) }, 'partial subtitle marker not removed'));
    await flushDir(join(this.root, fp)).catch((err: unknown) => this.log.debug({ fp, err: String(err) }, 'subtitle cache directory not flushed'));
    await utimes(dest, date, date).catch(() => {});
    const old = this.entries.get(id);
    if (old) this.used -= old.bytes;
    this.entries.set(id, { bytes: st.size, lastUsed: this.now(), partialAt: partial ? this.now() : null });
    this.used += st.size;
    await this.evict(id);
  }

  /** Forgets an entry whose file vanished (deleted by hand, a full disk ...). */
  forget(fp: string, key: string): void {
    const id = `${fp}/${key}`;
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.used -= e.bytes;
  }

  /** Least recently used first; pinned fingerprints and `keep` stay. A file that cannot be deleted stays counted. */
  private async evict(keep?: string): Promise<void> {
    if (this.used <= this.max) return;
    const pinned = this.pinned();
    const order = [...this.entries.entries()].filter(([id]) => id !== keep && !pinned.has(id.slice(0, id.indexOf('/')))).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id, e] of order) {
      if (this.used <= this.max) break;
      const slash = id.indexOf('/');
      try {
        await rm(this.path(id.slice(0, slash), id.slice(slash + 1)), { force: true });
        if (e.partialAt !== null) await rm(this.markerPath(id.slice(0, slash), id.slice(slash + 1)), { force: true }).catch(() => {});
        this.entries.delete(id);
        this.used -= e.bytes;
      } catch (err) {
        this.log.debug({ entry: id, err: String(err) }, 'subtitle cache entry not evicted');
      }
    }
    if (this.used > this.max) this.log.warn({ used: this.used, max: this.max }, 'subtitle cache over its limit (entries in use)');
  }
}
