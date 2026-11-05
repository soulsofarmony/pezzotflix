// Data-plane tokens (ADR 0003 D9–D10, ADR 0004 P9): 32 random bytes in base64url, kept only as SHA-256.
// A map lookup by hash removes any timing dependence on the token value, so no constant-time compare.
// A stopped or re-planned stream leaves a tombstone: 410 until its TTL ends, then 404.
import { createHash, randomBytes } from 'node:crypto';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const mintToken = (): string => randomBytes(32).toString('base64url');

export type TokenLookup = { state: 'live'; streamId: string } | { state: 'gone'; streamId: string } | { state: 'unknown' };

interface Entry {
  streamId: string;
  /** null while live; ms UTC when the tombstone expires. */
  tombstoneUntil: number | null;
}

export class TokenTable {
  private readonly entries = new Map<string, Entry>();
  private readonly byStream = new Map<string, string>();

  private readonly now: () => number;
  private readonly tombstoneTtlMs: number;

  constructor(now: () => number, tombstoneTtlMs: number) {
    this.now = now;
    this.tombstoneTtlMs = tombstoneTtlMs;
  }

  /** Mints a token for a stream; only its hash is stored. */
  issue(streamId: string): string {
    const token = mintToken();
    const hash = hashToken(token);
    this.entries.set(hash, { streamId, tombstoneUntil: null });
    this.byStream.set(streamId, hash);
    return token;
  }

  lookup(token: string): TokenLookup {
    const hash = hashToken(token);
    const e = this.entries.get(hash);
    if (!e) return { state: 'unknown' };
    if (e.tombstoneUntil === null) return { state: 'live', streamId: e.streamId };
    if (this.now() < e.tombstoneUntil) return { state: 'gone', streamId: e.streamId };
    this.forget(hash, e.streamId);
    return { state: 'unknown' };
  }

  /** Idempotent: a second call keeps the first expiry. */
  tombstone(streamId: string): void {
    const hash = this.byStream.get(streamId);
    const e = hash ? this.entries.get(hash) : undefined;
    if (e && e.tombstoneUntil === null) e.tombstoneUntil = this.now() + this.tombstoneTtlMs;
  }

  /** Drops expired tombstones; returns the stream ids that were forgotten. */
  prune(): string[] {
    const t = this.now();
    const gone: string[] = [];
    for (const [hash, e] of this.entries) {
      if (e.tombstoneUntil !== null && t >= e.tombstoneUntil) {
        this.forget(hash, e.streamId);
        gone.push(e.streamId);
      }
    }
    return gone;
  }

  get size(): number {
    return this.entries.size;
  }

  private forget(hash: string, streamId: string): void {
    this.entries.delete(hash);
    if (this.byStream.get(streamId) === hash) this.byStream.delete(streamId);
  }
}
