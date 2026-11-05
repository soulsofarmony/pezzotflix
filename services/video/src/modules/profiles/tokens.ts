// Profile context tokens (ADR 0004 P2). No auth in the MVP, but a token must not be forgeable from a
// profile id: it is `p1.<profileId>.<HMAC-SHA256(key, profileId)>`, so it needs no table and
// survives restarts as long as the key does. A deleted profile's tokens stop verifying.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

const VERSION = 'p1';
const KEY_BYTES = 32;

export interface ProfileTokens {
  sign(profileId: string): string;
  /** The profile id if the signature is valid; existence of the profile is checked by the caller. */
  open(token: string): string | null;
}

export function createProfileTokens(key: Buffer): ProfileTokens {
  const mac = (profileId: string) => createHmac('sha256', key).update(`${VERSION}:${profileId}`).digest();
  return {
    sign: (profileId) => `${VERSION}.${profileId}.${mac(profileId).toString('base64url')}`,
    open(token) {
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) return null;
      const given = Buffer.from(parts[2], 'base64url');
      const expected = mac(parts[1]);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      return parts[1];
    },
  };
}

type KeyRead = { key: Buffer } | { missing: true } | { invalid: true };

function readKey(keyPath: string, log: FastifyBaseLogger): KeyRead {
  try {
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64url');
    if (key.length === KEY_BYTES) return { key };
    log.warn({ keyPath }, 'profile token key has the wrong length, replacing it');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    log.warn({ err: e, keyPath }, 'profile token key unreadable, replacing it');
  }
  return { invalid: true };
}

/**
 * Reads the signing key from keyPath, creating it (32 random bytes) on first use. Creation is
 * atomic: the key is written to a temp file and hard-linked into place, which fails if another
 * process got there first; that key is then used. Linux: secrets/ is 0700 and the key 0600, also
 * re-applied to an existing key. Windows ignores POSIX modes: the ACL of DATA_DIR protects the key.
 * If the data volume is not writable the key is ephemeral: tokens last until the next restart.
 */
export function loadOrCreateKey(keyPath: string, log: FastifyBaseLogger): Buffer {
  const posix = process.platform !== 'win32';
  const existing = readKey(keyPath, log);
  if ('key' in existing) {
    if (posix) {
      try {
        chmodSync(keyPath, 0o600);
      } catch (e) {
        log.warn({ err: e, keyPath }, 'cannot restrict the profile token key to mode 600');
      }
    }
    return existing.key;
  }
  const key = randomBytes(KEY_BYTES);
  const tmp = `${keyPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, key.toString('base64url'), { mode: 0o600, flag: 'wx' });
    if ('invalid' in existing) {
      renameSync(tmp, keyPath);
      return key;
    }
    try {
      linkSync(tmp, keyPath);
      return key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Another process created the key between our read and our link: use theirs.
      const theirs = readKey(keyPath, log);
      if ('key' in theirs) return theirs.key;
      renameSync(tmp, keyPath);
      return key;
    }
  } catch (e) {
    log.warn({ err: e, keyPath }, 'cannot persist the profile token key: tokens will not survive a restart');
    return key;
  } finally {
    rmSync(tmp, { force: true });
  }
}
