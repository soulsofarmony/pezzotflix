// Configuration checks at startup: LIBRARY_ROOTS errors, and data that overlaps the media.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/app/config.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pzf-config-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const roots = (...paths: string[]) => JSON.stringify(paths.map((path, i) => ({ name: `R${i}`, path, hint: 'movies' })));
const load = (env: Record<string, string>) => () => loadConfig({ NODE_ENV: 'test', ...env });

describe('LIBRARY_ROOTS', () => {
  it('tells broken JSON from a wrong shape', () => {
    expect(load({ LIBRARY_ROOTS: '[{"name": "Film",' })).toThrow(/LIBRARY_ROOTS is not valid JSON/);
    const shape = load({ LIBRARY_ROOTS: '[{"name": "Film", "path": "/media/Film", "hint": "films"}]' });
    expect(shape).toThrow(/LIBRARY_ROOTS must be an array of .*LIBRARY_ROOTS\[0\]\.hint/);
    expect(shape).not.toThrow(/not valid JSON/);
    expect(load({ LIBRARY_ROOTS: '{"name": "Film"}' })).toThrow(/LIBRARY_ROOTS must be an array/);
    expect(load({ LIBRARY_ROOTS: '[{"name": "Film", "hint": "movies"}]' })).toThrow(/LIBRARY_ROOTS\[0\]\.path/);
  });
});

describe('data and media apart', () => {
  const base = () => {
    const b = tempDir();
    mkdirSync(join(b, 'media', 'Film'), { recursive: true });
    return b;
  };

  it.each([
    ['DATA_DIR inside a root', (b: string) => ({ DATA_DIR: join(b, 'media', 'Film', 'data'), LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) }), /DATA_DIR .* is inside library root "R0"/],
    ['DATA_DIR equal to a root', (b: string) => ({ DATA_DIR: join(b, 'media', 'Film'), LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) }), /DATA_DIR .* is inside library root/],
    ['a root inside DATA_DIR', (b: string) => ({ DATA_DIR: b, LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) }), /library root "R0" .* is inside DATA_DIR/],
    [
      'DB_PATH inside a root',
      (b: string) => ({ DATA_DIR: join(b, 'data'), DB_PATH: join(b, 'media', 'Film', 'video.db'), LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) }),
      /DB_PATH .* is inside library root/,
    ],
    ['a root inside DATA_DIR that does not exist yet', (b: string) => ({ DATA_DIR: join(b, 'new'), LIBRARY_ROOTS: roots(join(b, 'new', 'media')) }), /is inside DATA_DIR/],
    ['a path written with ..', (b: string) => ({ DATA_DIR: join(b, 'media', 'x', '..', 'Film', 'data'), LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) }), /is inside library root/],
  ])('refuses %s', (_label, env, message) => {
    expect(load(env(base()))).toThrow(message);
  });

  it('accepts siblings, and a folder whose name only starts like a root', () => {
    const b = base();
    expect(load({ DATA_DIR: join(b, 'data'), LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) })).not.toThrow();
    expect(load({ DATA_DIR: join(b, 'media', 'Film2'), LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) })).not.toThrow();
    expect(load({ DATA_DIR: join(b, 'data'), DB_PATH: join(b, 'db', 'video.db'), LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) })).not.toThrow();
  });

  it.runIf(process.platform === 'win32')('compares without case on Windows', () => {
    const b = base();
    expect(load({ DATA_DIR: join(b, 'MEDIA', 'film', 'data'), LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) })).toThrow(/is inside library root/);
  });

  it('follows links: a DATA_DIR reached through a link into a root', (t) => {
    const b = base();
    try {
      symlinkSync(join(b, 'media', 'Film'), join(b, 'alias'), 'junction'); // a junction on Windows needs no privilege
    } catch (err) {
      t.skip(`cannot create a link here: ${err instanceof Error ? err.message : String(err)}`);
    }
    cleanup.push(() => rmSync(join(b, 'alias'), { force: true, recursive: true }));
    expect(load({ DATA_DIR: join(b, 'alias', 'data'), LIBRARY_ROOTS: roots(join(b, 'media', 'Film')) })).toThrow(/is inside library root/);
  });
});
