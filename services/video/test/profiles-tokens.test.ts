// Profile token signing and the signing key file: creation, reuse, replacement, modes, races.
import { randomBytes } from 'node:crypto';
import type * as nodeFs from 'node:fs';
import { linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfileTokens, loadOrCreateKey } from '../src/modules/profiles/tokens.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof nodeFs>();
  return { ...fs, linkSync: vi.fn(fs.linkSync) };
});

const log = pino({ level: 'silent' });
const posix = process.platform !== 'win32';
let dir: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pzf-key-'));
  keyPath = join(dir, 'secrets', 'profile-token.key');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('profile tokens', () => {
  it('sign and open round-trip; another key or a tampered id fails', () => {
    const t = createProfileTokens(randomBytes(32));
    const token = t.sign('0190-abc');
    expect(t.open(token)).toBe('0190-abc');
    expect(createProfileTokens(randomBytes(32)).open(token)).toBeNull();
    expect(t.open(token.replace('0190-abc', '0190-abd'))).toBeNull();
    for (const bad of ['', 'p1', 'p1..x', 'p2.0190-abc.x', `${token}.x`]) expect(t.open(bad)).toBeNull();
  });
});

describe('signing key file', () => {
  it('is created once, then reused, with no temp file left', () => {
    const a = loadOrCreateKey(keyPath, log);
    const b = loadOrCreateKey(keyPath, log);
    expect(a.length).toBe(32);
    expect(b.equals(a)).toBe(true);
    expect(readdirSync(join(dir, 'secrets'))).toEqual(['profile-token.key']);
  });

  it.skipIf(!posix)('uses modes 0700 for secrets/ and 0600 for the key, also fixing an existing key', () => {
    loadOrCreateKey(keyPath, log);
    expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    // chmod after write: the umask must not matter.
    writeFileSync(keyPath, randomBytes(32).toString('base64url'), { mode: 0o644 });
    loadOrCreateKey(keyPath, log);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('replaces a key of the wrong length', () => {
    loadOrCreateKey(keyPath, log);
    writeFileSync(keyPath, 'short');
    const k = loadOrCreateKey(keyPath, log);
    expect(Buffer.from(readFileSync(keyPath, 'utf8'), 'base64url').equals(k)).toBe(true);
  });

  it('losing the creation race uses the key the other process wrote', () => {
    const theirs = randomBytes(32);
    vi.mocked(linkSync).mockImplementationOnce(() => {
      // The other process links its key in between our read and our link.
      writeFileSync(keyPath, theirs.toString('base64url'));
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    });
    expect(loadOrCreateKey(keyPath, log).equals(theirs)).toBe(true);
    expect(readdirSync(join(dir, 'secrets'))).toEqual(['profile-token.key']);
  });

  it('falls back to an ephemeral key when the volume is not writable', () => {
    writeFileSync(join(dir, 'secrets'), 'a file where the directory should be');
    const k = loadOrCreateKey(keyPath, log);
    expect(k.length).toBe(32);
  });
});
