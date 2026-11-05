// Resolves a plan's file (rootName, relPath) to a host path (ADR 0003 D10): the root must be configured,
// relPath must be safe, and the real path (symlinks followed) must stay inside the root's real path.
// The media mount is read-only: delivery only ever opens it for reading.
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { LibraryRootSpec } from '../../app/config.ts';
import type { MediaLocation } from '../../shared/media-facts.ts';
import { resolveInsideRoot } from '../../shared/media-path.ts';

export type ResolveResult = { ok: true; absPath: string; sizeBytes: number; mtimeMs: number } | { ok: false; detail: string };

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export async function resolveMediaFile(
  roots: readonly LibraryRootSpec[],
  location: MediaLocation,
  expect?: { sizeBytes: number; mtimeMs: number },
): Promise<ResolveResult> {
  const root = roots.find((r) => r.name === location.rootName);
  if (!root) return { ok: false, detail: `library root ${JSON.stringify(location.rootName)} is not configured` };
  let abs: string;
  try {
    abs = resolveInsideRoot(root.path, location.relPath);
  } catch {
    return { ok: false, detail: 'unsafe media path' };
  }
  let real: string;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root.path), realpath(abs)]);
    if (!inside(realRoot, realFile)) return { ok: false, detail: 'media path escapes its root' };
    real = realFile;
  } catch {
    return { ok: false, detail: 'file or root not reachable' };
  }
  // Check then open is not atomic: accepted, the media mount is read-only and only rescans change it.
  try {
    const st = await stat(real);
    if (!st.isFile()) return { ok: false, detail: 'not a regular file' };
    const mtimeMs = Math.floor(st.mtimeMs);
    if (expect && (st.size !== expect.sizeBytes || mtimeMs !== expect.mtimeMs)) {
      return { ok: false, detail: 'file changed since it was analysed' };
    }
    return { ok: true, absPath: real, sizeBytes: st.size, mtimeMs };
  } catch {
    return { ok: false, detail: 'file not reachable' };
  }
}
