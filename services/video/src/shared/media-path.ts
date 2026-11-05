// Media paths are always (root, relPath) and resolved here with an anti-traversal check (ADR 0001 rule 3).
// The library records only paths this accepts and the analyzer (later delivery) resolves them, so all
// sides agree on what a valid relPath is.
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

/** Absolute path of relPath inside the root mount; throws if it would escape the root. */
export function resolveInsideRoot(mountPath: string, relPath: string): string {
  if (!isSafeRelPath(relPath)) throw new Error(`unsafe media path ${JSON.stringify(relPath)}`);
  const root = resolve(mountPath);
  const abs = resolve(root, ...relPath.split('/'));
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`media path escapes its root: ${JSON.stringify(relPath)}`);
  }
  return abs;
}
