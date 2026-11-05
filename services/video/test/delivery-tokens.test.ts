// Data-plane tokens (ADR 0003 D9–D10): random base64url, stored only as SHA-256, tombstones with a TTL.
import { describe, expect, it } from 'vitest';
import { hashToken, mintToken, TokenTable } from '../src/modules/delivery/tokens.ts';

describe('tokens', () => {
  it('mints 32 random bytes in base64url, inside the contract length', () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a.length).toBeLessThanOrEqual(128);
  });

  it('keeps only the hash', () => {
    const t = new TokenTable(() => 0, 1000);
    const token = t.issue('s1');
    const keys = [...(t as unknown as { entries: Map<string, unknown> }).entries.keys()];
    expect(keys).toEqual([hashToken(token)]);
    expect(JSON.stringify([...(t as unknown as { entries: Map<string, unknown> }).entries])).not.toContain(token);
  });

  it('live → tombstone (410) within the TTL → unknown (404) after it', () => {
    let now = 1000;
    const t = new TokenTable(() => now, 60_000);
    const token = t.issue('s1');
    expect(t.lookup(token)).toEqual({ state: 'live', streamId: 's1' });
    expect(t.lookup(`${token}x`)).toEqual({ state: 'unknown' });
    expect(t.lookup('')).toEqual({ state: 'unknown' });
    t.tombstone('s1');
    now += 59_999;
    expect(t.lookup(token)).toEqual({ state: 'gone', streamId: 's1' });
    t.tombstone('s1'); // idempotent: keeps the first expiry
    now += 1;
    expect(t.lookup(token)).toEqual({ state: 'unknown' });
    expect(t.size).toBe(0);
  });

  it('a re-plan gives the stream a new token while the old one answers gone', () => {
    let now = 0;
    const t = new TokenTable(() => now, 1000);
    const old = t.issue('s1');
    t.tombstone('s1');
    const fresh = t.issue('s2');
    expect(t.lookup(old).state).toBe('gone');
    expect(t.lookup(fresh)).toEqual({ state: 'live', streamId: 's2' });
    now = 1000;
    expect(t.prune()).toEqual(['s1']);
    expect(t.size).toBe(1);
  });
});
