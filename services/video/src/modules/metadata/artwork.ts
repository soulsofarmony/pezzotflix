// Artwork Store (doc 02 §3.7, ADR 0007 point 6, ADR 0004 point 8): image files in the artwork
// volume, addressed by content hash (the contract's imageKey), and the size variants of GetImage.
// - TMDB images are never resized nor re-encoded: the CDN sizes downloaded are served as they are,
//   picking the nearest one to the width asked.
// - Other images (Wikidata/Commons, later uploads and video frames) get WebP variants made with
//   sharp on first request, in the cache volume (rebuildable, ADR 0006).
// Nothing is ever written into the media roots.
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import sharp from 'sharp';
import { artworkPathOf, IMAGE_KEY_RE, IMAGE_WIDTHS, imageKeyOf } from '../../shared/metadata.ts';
import type { ArtworkRecord } from '../../shared/ports.ts';
import type { DownloadedFile } from './types.ts';

/** ADR 0004 point 8: content-addressed URLs are immutable, except TMDB images (30 days, ADR 0007). */
export const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_CONTROL_TMDB = 'public, max-age=2592000';
/** Variant served when the client asks no width. */
export const DEFAULT_WIDTH = 1280;
/** Key directories no artwork row references are deleted after this (a save may be in flight). */
export const ORPHAN_AGE_MS = 3600_000;
const WEBP_QUALITY = 82;
/** Decoding bound for untrusted images: about 40 megapixels. */
export const MAX_INPUT_PIXELS = 40_000_000;
const SHARP_INPUT = { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true, failOn: 'error' } as const;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const FORMAT_OF_TYPE: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPE_OF_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const SAFE_LOCAL_PATH = /^[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_.-]{1,64}$/;

export interface StoredImage {
  key: string;
  localPath: string;
  width: number | null;
  height: number | null;
}

export interface ServedImage {
  bytes: Buffer;
  contentType: string;
  cacheControl: string;
}

export interface ArtworkStore {
  /**
   * Runs fn alone among the store's critical sections. Callers wrap "save + write the rows" and
   * "drop the rows + remove the unreferenced files" in it, so a file another item has just saved
   * under the same key is never deleted between the two steps.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Validates every file (full decode with sharp), then writes them under their content key.
   * Throws on an invalid image, before anything is written. Returns the row values of the primary file.
   */
  save(files: readonly DownloadedFile[]): Promise<StoredImage>;
  /** Deletes the key directories (originals and cached variants) of these local paths. */
  remove(paths: readonly string[]): Promise<void>;
  /** The bytes for GetImage, or null if the file is gone. */
  serve(record: Pick<ArtworkRecord, 'localPath' | 'source' | 'width'>, w: number | undefined): Promise<ServedImage | null>;
  /**
   * Deletes the key directories (artwork and variants) that no row references and that are older
   * than ORPHAN_AGE_MS: what a crash between a row change and the file removal leaves behind.
   * Call it inside exclusive(). Returns how many directories were removed.
   */
  collectOrphans(isReferenced: (key: string) => boolean): Promise<number>;
  /** Removes the *.tmp leftovers of interrupted writes. At start. */
  cleanTemp(): Promise<number>;
}

/** Content key: SHA-256 of the bytes, base64url, 32 characters (192 bits). */
export const contentKey = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('base64url').slice(0, 32);

const sizeOf = async (p: string): Promise<number | null> => {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
};

/** Write to a temp file, fsync, rename: a crash leaves the old file or the new one, never half. */
async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

/** TMDB: the smallest downloaded size at least as wide as asked, else the largest. */
export function pickSize(files: readonly { name: string; width: number }[], w: number | undefined): string | null {
  const sorted = [...files].sort((a, b) => a.width - b.width);
  if (!sorted.length) return null;
  if (w === undefined) return sorted.at(-1)?.name ?? null;
  return (sorted.find((f) => f.width >= w) ?? sorted.at(-1))?.name ?? null;
}

/** Non-TMDB without ?w=: the default variant, or the largest contract width the original fills. */
export function defaultVariant(originalWidth: number | null): number {
  const cap = Math.min(DEFAULT_WIDTH, originalWidth ?? DEFAULT_WIDTH);
  return [...IMAGE_WIDTHS].reverse().find((x) => x <= cap) ?? IMAGE_WIDTHS[0];
}

/** Full decode of untrusted bytes; throws if they are not a whole image of the declared type. */
async function validate(f: DownloadedFile): Promise<{ width: number | null; height: number | null }> {
  const img = sharp(f.bytes, SHARP_INPUT);
  const meta = await img.metadata();
  const expected = FORMAT_OF_TYPE[f.contentType];
  if (!expected || meta.format !== expected) throw new Error(`invalid image: ${meta.format ?? 'unknown format'} for ${f.contentType}`);
  await img.stats(); // decodes every pixel: a truncated or corrupt body fails here
  return { width: meta.width ?? null, height: meta.height ?? null };
}

export function createArtworkStore(deps: { artworkDir: string; cacheDir: string; log: FastifyBaseLogger; now: () => number }): ArtworkStore {
  const { artworkDir, log } = deps;
  const variantsDir = join(deps.cacheDir, 'images');
  const making = new Map<string, Promise<Buffer>>();
  // One image at a time and no cache: bounded memory next to the streaming work (ADR 0001).
  sharp.concurrency(1);
  sharp.cache(false);
  let queue: Promise<unknown> = Promise.resolve();

  const keyDir = (root: string, key: string) => join(root, key.slice(0, 2), key);

  async function variant(original: string, out: string, width: number): Promise<Buffer> {
    const pending = making.get(out);
    if (pending) return pending;
    const p = (async () => {
      const bytes = await sharp(original, SHARP_INPUT).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: WEBP_QUALITY }).toBuffer();
      await writeAtomic(out, bytes);
      return bytes;
    })().finally(() => making.delete(out));
    making.set(out, p);
    return p;
  }

  /** The key directories under a root: root/<2 chars>/<key>. */
  async function keyDirs(root: string): Promise<{ key: string; path: string }[]> {
    const out: { key: string; path: string }[] = [];
    let shards: string[];
    try {
      shards = await readdir(root);
    } catch {
      return out;
    }
    for (const shard of shards) {
      if (!/^[A-Za-z0-9_-]{2}$/.test(shard)) continue;
      let keys: string[];
      try {
        keys = await readdir(join(root, shard));
      } catch {
        continue;
      }
      for (const key of keys) if (IMAGE_KEY_RE.test(key) && key.startsWith(shard)) out.push({ key, path: join(root, shard, key) });
    }
    return out;
  }

  return {
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    },

    async save(files) {
      const primary = [...files].sort((a, b) => (b.width ?? Number.MAX_SAFE_INTEGER) - (a.width ?? Number.MAX_SAFE_INTEGER))[0];
      if (!primary) throw new Error('no image file to save');
      // Every file is checked before the first one is written.
      const dims = new Map<DownloadedFile, { width: number | null; height: number | null }>();
      for (const f of files) dims.set(f, await validate(f));
      const key = contentKey(primary.bytes);
      const nameOf = (f: DownloadedFile) => `${f.size}.${EXT[f.contentType] ?? 'bin'}`;
      for (const f of files) {
        const path = join(artworkDir, artworkPathOf(key, nameOf(f)));
        // Same key and same size: the file is already there (a truncated leftover is rewritten).
        if ((await sizeOf(path)) !== f.bytes.length) await writeAtomic(path, f.bytes);
      }
      const decoded = dims.get(primary);
      const width = primary.width ?? decoded?.width ?? null;
      const height = primary.height ?? decoded?.height ?? null;
      return { key, localPath: artworkPathOf(key, nameOf(primary)), width, height };
    },

    async remove(paths) {
      for (const p of new Set(paths)) {
        const key = imageKeyOf(p);
        if (!key || !SAFE_LOCAL_PATH.test(p)) continue;
        await rm(keyDir(artworkDir, key), { recursive: true, force: true });
        await rm(keyDir(variantsDir, key), { recursive: true, force: true });
        log.debug({ key }, 'artwork files removed');
      }
    },

    async serve(record, w) {
      const key = imageKeyOf(record.localPath);
      if (!key || !SAFE_LOCAL_PATH.test(record.localPath)) return null;
      if (record.source === 'tmdb') {
        let names: string[];
        try {
          names = await readdir(keyDir(artworkDir, key));
        } catch {
          return null;
        }
        const sized = names
          .map((name) => ({ name, m: /^w(\d+)\.(jpg|jpeg|png|webp)$/.exec(name) }))
          .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
          .map((x) => ({ name: x.name, width: Number(x.m[1]) }));
        const name = pickSize(sized, w) ?? names.find((n) => /^original\.(jpg|jpeg|png|webp)$/.test(n)) ?? null;
        if (!name) return null;
        const ext = name.split('.').pop() ?? '';
        try {
          return { bytes: await readFile(join(keyDir(artworkDir, key), name)), contentType: TYPE_OF_EXT[ext] ?? 'application/octet-stream', cacheControl: CACHE_CONTROL_TMDB };
        } catch {
          return null;
        }
      }
      const original = join(artworkDir, record.localPath);
      if ((await sizeOf(original)) === null) return null;
      const width = w ?? defaultVariant(record.width);
      const out = join(keyDir(variantsDir, key), `w${width}.webp`);
      const bytes = (await sizeOf(out)) ? await readFile(out) : await variant(original, out, width);
      return { bytes, contentType: 'image/webp', cacheControl: CACHE_CONTROL_IMMUTABLE };
    },

    async collectOrphans(isReferenced) {
      const cutoff = deps.now() - ORPHAN_AGE_MS;
      let n = 0;
      for (const root of [artworkDir, variantsDir]) {
        for (const d of await keyDirs(root)) {
          if (isReferenced(d.key)) continue;
          const st = await stat(d.path).catch(() => null);
          if (!st || st.mtimeMs > cutoff) continue;
          await rm(d.path, { recursive: true, force: true });
          n++;
        }
      }
      if (n) log.info({ directories: n }, 'orphan artwork removed');
      return n;
    },

    async cleanTemp() {
      let n = 0;
      for (const root of [artworkDir, variantsDir]) {
        for (const d of await keyDirs(root)) {
          const names = await readdir(d.path).catch(() => [] as string[]);
          for (const name of names.filter((x) => x.endsWith('.tmp'))) {
            await rm(join(d.path, name), { force: true });
            n++;
          }
        }
      }
      if (n) log.info({ files: n }, 'interrupted artwork writes cleaned up');
      return n;
    },
  };
}
