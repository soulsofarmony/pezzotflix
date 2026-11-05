import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDb, closeDb } from '../src/db/index.ts';

describe('database', () => {
  it('applies migrations and supports FTS5 with diacritics folding', async () => {
    const db = await openDb({ path: ':memory:' });
    const tables = db.$client.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['catalog_item', 'media_file', 'job', 'catalog_search']));
    db.run(sql`insert into catalog_search(item_id, title, original_title) values ('x', 'La città incantata', 'Sen to Chihiro')`);
    const hit = db.all(sql`select item_id from catalog_search where catalog_search match 'citta'`);
    expect(hit).toHaveLength(1);
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    closeDb(db);
  });
});
