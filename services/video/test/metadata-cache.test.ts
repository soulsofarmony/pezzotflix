// Provider cache bounds: free-text searches keep their newest rows only, trimmed in batches without
// reading the responses; ids and works are kept.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createProviderCache, SEARCH_ROWS_MAX } from '../src/modules/metadata/cache.ts';

let db: Db;
beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
});
afterEach(() => closeDb(db));

const keys = (provider: string) => db.$client.prepare('SELECT cache_key FROM provider_cache WHERE provider = ? ORDER BY cache_key').pluck().all(provider) as string[];
const searchKeys = (provider: string, prefix = 'search:') => keys(provider).filter((k) => k.startsWith(prefix));

describe('provider cache', () => {
  it('keeps the newest search rows of each provider and prefix, trimmed a tenth past the bound', () => {
    const cache = createProviderCache(db, { searchRowsMax: 10 }); // trimmed back to 10 once past 11
    cache.put('tmdb', 'details:movie:1:it-IT', { v: 1 }, 1);
    cache.put('wikidata', 'search:q0', { v: [] }, 1);
    const q = (i: number) => `search:movie:it-IT::query ${String(i).padStart(2, '0')}`;
    for (let i = 1; i <= 11; i++) cache.put('tmdb', q(i), { v: [] }, 10 + i);
    expect(searchKeys('tmdb')).toHaveLength(11); // within the slack
    cache.put('tmdb', q(12), { v: [] }, 22);
    expect(searchKeys('tmdb')).toEqual(Array.from({ length: 10 }, (_, i) => q(i + 3)));
    // A search stored again counts as the newest: the oldest others go first.
    cache.put('tmdb', q(3), { v: [] }, 30);
    cache.put('tmdb', q(13), { v: [] }, 31);
    cache.put('tmdb', q(14), { v: [] }, 32);
    expect(searchKeys('tmdb')).toEqual([3, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(q));
    for (let i = 1; i <= 12; i++) cache.put('wikidata', `label:it:query ${i}`, { v: [] }, 10 + i);
    expect(searchKeys('wikidata', 'label:')).toHaveLength(10);
    // Other keys and providers are never trimmed; the next prefix up is outside the range.
    cache.put('tmdb', 'search;not a search', { v: 1 }, 0);
    expect(keys('tmdb').filter((k) => !k.startsWith('search:'))).toEqual(['details:movie:1:it-IT', 'search;not a search']);
    expect(searchKeys('wikidata')).toEqual(['search:q0']);
    expect(cache.get('tmdb', 'details:movie:1:it-IT', 1e9, 2)).toEqual({ value: { v: 1 }, fetchedAt: 1 });
    expect(cache.get('tmdb', q(3), 1e9, 31)).toEqual({ value: { v: [] }, fetchedAt: 30 });
  });

  it('a search put stays cheap with the range full of large responses (no row reads)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pzf-cache-'));
    const file = await openDb({ path: join(dir, 'video.db') });
    try {
      const max = 1000;
      const blob = JSON.stringify({ results: 'x'.repeat(30_000) });
      const ins = file.$client.prepare('INSERT INTO provider_cache (provider, cache_key, response, fetched_at) VALUES (?, ?, ?, ?)');
      file.$client.transaction(() => {
        for (let i = 0; i < max; i++) ins.run('wikidata', `search:q${i}`, blob, i);
      })();
      const cache = createProviderCache(file, { searchRowsMax: max });
      const n = 150; // crosses the slack once: one batch trim included
      const t0 = performance.now();
      for (let i = 0; i < n; i++) cache.put('wikidata', `search:new${i}`, { results: 'y'.repeat(30_000) }, max + i);
      const perPut = (performance.now() - t0) / n;
      expect(file.$client.prepare("SELECT count(*) FROM provider_cache WHERE cache_key LIKE 'search:%'").pluck().get()).toBeLessThanOrEqual(max + max / 10);
      // Reading every row's fetched_at (behind the response) took tens of ms per put here.
      expect(perPut).toBeLessThan(8);
    } finally {
      closeDb(file);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the default bound is above a home library', () => {
    expect(SEARCH_ROWS_MAX).toBeGreaterThanOrEqual(5000);
  });
});
