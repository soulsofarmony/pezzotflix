import { describe, expect, it } from 'vitest';
import { isSafeRelPath, resolveInsideRoot } from './media-path.ts';

const win = process.platform === 'win32';

describe('media path guard', () => {
  // [relPath, safe on Linux, safe on Windows]: both rule sets run on every host.
  it.each([
    ['Film (2001)/Film (2001).mkv', true, true],
    ['a/b/c.mkv', true, true],
    ['..foo/bar.mkv', true, true], // a name starting with dots is not traversal
    ['', false, false],
    ['../etc/passwd', false, false],
    ['a/../../b.mkv', false, false],
    ['a/./b.mkv', false, false],
    ['a//b.mkv', false, false],
    ['/etc/passwd', false, false],
    ['C:/Windows/win.ini', false, false], // drive letter in the Windows form, on every platform
    ['C:\\Windows\\win.ini', false, false],
    ['C:', false, false],
    ['a/b\u0000.mkv', false, false],
    // A legal folder name on Linux; on Windows ':' cannot be part of a name (it marks drives and streams).
    ['Q: The Winged Serpent (1982)/Q (1982).mkv', true, false],
    ['Film.mkv:stream', true, false],
    ['a\\b.mkv', true, false],
  ] as const)('%j linux=%s win32=%s', (rel, linux, windows) => {
    expect(isSafeRelPath(rel, 'linux')).toBe(linux);
    expect(isSafeRelPath(rel, 'win32')).toBe(windows);
    expect(isSafeRelPath(rel)).toBe(win ? windows : linux);
  });

  it('resolves inside the root and refuses to escape it', () => {
    const root = win ? 'C:\\media\\Film' : '/media/Film';
    expect(resolveInsideRoot(root, 'X (2001)/X (2001).mkv')).toMatch(/X \(2001\).mkv$/);
    expect(() => resolveInsideRoot(root, '../Serie/x.mkv')).toThrow(/unsafe/);
    expect(() => resolveInsideRoot(root, 'C:/x.mkv')).toThrow(/unsafe/);
  });
});
