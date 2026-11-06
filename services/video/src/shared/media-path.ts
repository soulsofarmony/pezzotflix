// Media paths are always (root, relPath) and resolved here with an anti-traversal check (ADR 0001 rule 3).
// The library records only paths this accepts and the analyzer (later delivery) resolves them, so all
// sides agree on what a valid relPath is.
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// "C:", "C:/x", "C:\x": a drive letter in the Windows form. "Q: The Winged Serpent (1982)" is a
// legal folder name on Linux and is not one.
const WINDOWS_DRIVE = /^[a-zA-Z]:(?:[\\/]|$)/;

/**
 * A stored relative path: '/'-separated, no empty, '.' or '..' segments, never absolute.
 * `platform` is the host's; tests pass the other one to check both rule sets.
 */
export function isSafeRelPath(relPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!relPath || relPath.includes('\0')) return false;
  if (relPath.startsWith('/') || WINDOWS_DRIVE.test(relPath)) return false;
  const segments = relPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  // On Windows '\' and ':' are separators or drive/stream markers, never part of a name.
  if (platform === 'win32' && segments.some((s) => /[\\:]/.test(s))) return false;
  return true;
}

/** True when p is strictly below root (not root itself). */
const strictlyInside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Absolute path of relPath inside the root mount; throws if it would escape the root. */
export function resolveInsideRoot(mountPath: string, relPath: string): string {
  if (!isSafeRelPath(relPath)) throw new Error(`unsafe media path ${JSON.stringify(relPath)}`);
  const root = resolve(mountPath);
  const abs = resolve(root, ...relPath.split('/'));
  if (!strictlyInside(root, abs)) throw new Error(`media path escapes its root: ${JSON.stringify(relPath)}`);
  return abs;
}

/**
 * resolveInsideRoot, then with links followed (symlinks, junctions): the real path must stay inside
 * the root's real path, as delivery checks before it serves a file. Returns the real path; throws if
 * it escapes, or if the file or the root cannot be reached.
 */
export async function resolveRealInsideRoot(mountPath: string, relPath: string): Promise<string> {
  const abs = resolveInsideRoot(mountPath, relPath);
  const [realRoot, realFile] = await Promise.all([realpath(mountPath), realpath(abs)]);
  if (!strictlyInside(realRoot, realFile)) throw new Error(`media path escapes its root through a link: ${JSON.stringify(relPath)}`);
  return realFile;
}
