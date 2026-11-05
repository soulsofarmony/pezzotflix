// Read-only walk of one library root (doc 02 §3.1). Never opens files for writing, never follows links.
// Limit: there is no timeout on fs calls. A network root mounted "hard" (NFS default) that stops
// answering blocks the walk, and the scan job with it, until the mount answers again. Network roots
// should be mounted with soft/timeo options so the calls fail and the root goes offline.
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeRelPath } from '../../shared/media-path.ts';
import { associateSidecars, classifyFile, discDirKind, type DiscKind, isIgnoredDir, joinRel } from './rules.ts';

/**
 * stat() calls in flight per folder. They run on the libuv pool (4 threads by default), which
 * file streaming shares: a hung mount must not take all of it.
 */
export const STAT_CONCURRENCY = 2;

export interface WalkEntry {
  /** Root-relative, '/'-separated, byte-exact as on disk. */
  relPath: string;
  disc: DiscKind | null;
  sizeBytes: number;
  mtimeMs: number;
  /** Root-relative paths of the associated sidecar subtitles (videos only), sorted. */
  sidecars: string[];
}

export interface WalkResult {
  entries: WalkEntry[];
  /** Folders that could not be listed: known files below them are not marked missing. */
  unreadableDirs: string[];
  /** Files seen but not recorded now (still being copied, or stat failed): not marked missing either. */
  skipped: string[];
  unstable: number;
  /** Symbolic links (and Windows junctions), never followed nor recorded. */
  symlinks: string[];
  /** Names the media path guard rejects (shared/media-path.ts): nothing could ever open them. */
  unsafe: string[];
}

export interface WalkOptions {
  now: number;
  /** A file modified more recently than this is assumed to be still copying (doc 02 §3.1). */
  stableAfterMs: number;
  signal?: AbortSignal;
}

export const absPathOf = (rootPath: string, relPath: string): string => join(rootPath, ...relPath.split('/'));

/** Runs fn over items with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  const queue = items.map((item, i) => ({ item, i }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) out[job.i] = await fn(job.item);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Walks a root; throws only if the root folder itself cannot be listed (the caller marks it offline). */
export async function walkRoot(rootPath: string, opts: WalkOptions): Promise<WalkResult> {
  const result: WalkResult = { entries: [], unreadableDirs: [], skipped: [], unstable: 0, symlinks: [], unsafe: [] };
  const stack: string[] = [''];
  while (stack.length) {
    opts.signal?.throwIfAborted();
    const dir = stack.pop() ?? '';
    let dirents: Dirent[];
    try {
      dirents = await readdir(absPathOf(rootPath, dir), { withFileTypes: true });
    } catch (err) {
      if (dir === '') throw err;
      result.unreadableDirs.push(dir);
      continue;
    }

    const videos: string[] = [];
    const isos: string[] = [];
    const subtitles: string[] = [];
    const subdirs: string[] = [];
    const discDirs: { name: string; kind: DiscKind }[] = [];
    for (const d of dirents) {
      const relPath = joinRel(dir, d.name);
      if (d.isSymbolicLink()) {
        result.symlinks.push(relPath); // links could leave the root or loop
        continue;
      }
      const isDir = d.isDirectory();
      const cls = d.isFile() ? classifyFile(d.name) : null;
      if (isDir ? isIgnoredDir(d.name) : cls === null) continue;
      if (!isSafeRelPath(relPath)) {
        result.unsafe.push(relPath);
        continue;
      }
      const disc = isDir ? discDirKind(d.name) : null;
      if (disc) discDirs.push({ name: d.name, kind: disc });
      else if (isDir) subdirs.push(d.name);
      else if (cls === 'video') videos.push(d.name);
      else if (cls === 'iso') isos.push(d.name);
      else subtitles.push(d.name);
    }

    const statEntry = async ({ name, disc }: { name: string; disc: DiscKind | null }): Promise<WalkEntry | null> => {
      const relPath = joinRel(dir, name);
      try {
        const st = await stat(absPathOf(rootPath, relPath));
        const mtimeMs = Math.floor(st.mtimeMs);
        // Disc folders are never probed, so they need no stability wait.
        if (disc !== 'bdmv' && disc !== 'video_ts' && Math.abs(opts.now - mtimeMs) < opts.stableAfterMs) {
          result.unstable++;
          result.skipped.push(relPath);
          return null;
        }
        return { relPath, disc, sizeBytes: st.isFile() ? st.size : 0, mtimeMs, sidecars: [] };
      } catch {
        result.skipped.push(relPath);
        return null;
      }
    };

    const here = (
      await mapLimit(
        [
          ...videos.map((name) => ({ name, disc: null })),
          ...isos.map((name) => ({ name, disc: 'iso' as const })),
          ...discDirs.map((d) => ({ name: d.name, disc: d.kind })),
        ],
        STAT_CONCURRENCY,
        statEntry,
      )
    ).filter((e): e is WalkEntry => e !== null);
    const nameOf = (relPath: string) => relPath.slice(relPath.lastIndexOf('/') + 1);
    const sidecars = associateSidecars(
      here.filter((e) => e.disc === null).map((e) => nameOf(e.relPath)),
      subtitles,
    );
    for (const e of here) {
      if (e.disc === null) e.sidecars = (sidecars.get(nameOf(e.relPath)) ?? []).map((s) => joinRel(dir, s));
      result.entries.push(e);
    }
    for (const name of subdirs.sort().reverse()) stack.push(joinRel(dir, name));
  }
  result.entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return result;
}
