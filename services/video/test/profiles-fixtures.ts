// Test fixtures for the profiles module: catalog rows seeded directly in SQLite (watch state has FKs
// to catalog_item) and a fake CatalogReadPort over them, ordered as F1a.3's catalog orders episodes
// (season, then episode, specials first; only episodes with a linked file).
import type { Db } from '../src/db/index.ts';
import type { CatalogItemPosition, CatalogReadPort, PlayableItem } from '../src/shared/ports.ts';

export interface Seed {
  item(id: string, kind?: 'movie' | 'extra', durationMs?: number): string;
  series(id: string, seasons: Record<number, number>): { seriesId: string; seasonId: (n: number) => string; ep: (s: number, e: number) => string };
}

export function seedCatalog(db: Db): Seed {
  const insert = db.$client.prepare(
    `INSERT INTO catalog_item (id, kind, parent_id, season_number, episode_number, title, sort_title, duration_ms, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  );
  return {
    item(id, kind = 'movie', durationMs = 7_200_000) {
      insert.run(id, kind, null, null, null, id, id, durationMs);
      return id;
    },
    series(id, seasons) {
      insert.run(id, 'series', null, null, null, id, id, null);
      const seasonId = (n: number) => `${id}-s${n}`;
      const ep = (s: number, e: number) => `${id}-s${s}e${e}`;
      for (const [sn, count] of Object.entries(seasons)) {
        const s = Number(sn);
        insert.run(seasonId(s), 'season', id, s, null, `S${s}`, `S${s}`, null);
        for (let e = 1; e <= count; e++) insert.run(ep(s, e), 'episode', seasonId(s), s, e, `E${e}`, `E${e}`, 3_000_000);
      }
      return { seriesId: id, seasonId, ep };
    },
  };
}

export interface FakeCatalog extends CatalogReadPort {
  /** Items without a playable file (no media linked). */
  noMedia: Set<string>;
}

export function fakeCatalogRead(db: Db): FakeCatalog {
  const sql = db.$client;
  const noMedia = new Set<string>();
  const row = sql.prepare('SELECT id, kind, title, duration_ms AS durationMs FROM catalog_item WHERE id = ?');
  const descendants = sql.prepare(
    `SELECT e.id FROM catalog_item e LEFT JOIN catalog_item s ON s.id = e.parent_id
     WHERE e.kind = 'episode' AND (e.parent_id = @id OR s.parent_id = @id)
     ORDER BY e.season_number, e.episode_number, e.id`,
  );
  const positions = db.$client.prepare(
    `SELECT id, kind, parent_id AS parentId, season_number AS seasonNumber, episode_number AS episodeNumber
     FROM catalog_item WHERE id IN (SELECT value FROM json_each(?))`,
  );
  return {
    noMedia,
    describeItems: (ids) => new Map((positions.all(JSON.stringify(ids)) as CatalogItemPosition[]).map((r) => [r.id, r])),
    itemExists: (id) => row.get(id) !== undefined,
    replacementFor: () => null,
    listPlayableDescendants: (id) => (descendants.all({ id }) as { id: string }[]).map((r) => r.id).filter((e) => !noMedia.has(e)),
    getPlayableItem(id) {
      const r = row.get(id) as { id: string; kind: PlayableItem['kind']; title: string; durationMs: number | null } | undefined;
      if (!r) return null;
      const files = noMedia.has(id) ? [] : [{ fileId: `f-${id}`, available: true, facts: {} as PlayableItem['files'][number]['facts'] }];
      return { itemId: r.id, kind: r.kind, title: r.title, durationMs: r.durationMs, files };
    },
  };
}
