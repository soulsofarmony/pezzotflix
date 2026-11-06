// Manual MediaLinks (doc 02 §4: the catalog owns MediaLink manual, the identifier the auto ones).
// Synchronous: a call made inside the caller's transaction joins it. A provisional item the owner links a
// file to is adopted with its whole work (the series and all its seasons and episodes, the movie and its
// extras): none of it is provisional any more, so none of it is retired (doc 02 §3.5).
import type { Db } from '../../db/index.ts';
import { newId } from '../../shared/ids.ts';
import type { CatalogLinkPort, EventPublisher } from '../../shared/ports.ts';

export function createCatalogLinks(deps: { db: Db; now: () => number; events: () => EventPublisher }): CatalogLinkPort {
  const { db, now } = deps;
  const tx = <T>(fn: () => T): T => db.$client.transaction(fn)();
  const manualOf = db.$client.prepare("SELECT item_id AS itemId FROM media_link WHERE file_id = ? AND origin = 'manual'");
  const deleteManual = db.$client.prepare("DELETE FROM media_link WHERE file_id = ? AND origin = 'manual'");
  const itemExists = db.$client.prepare('SELECT 1 FROM catalog_item WHERE id = ?');
  // A leftover auto link to the same item becomes the manual one (unique file × item).
  const insert = db.$client.prepare(
    `INSERT INTO media_link (id, file_id, item_id, origin, confidence, created_at) VALUES (?, ?, ?, 'manual', NULL, ?)
     ON CONFLICT (file_id, item_id) DO UPDATE SET origin = 'manual', confidence = NULL`,
  );
  // The item and its ancestors, the top-level work last.
  const chain = db.$client.prepare(
    `WITH RECURSIVE up(id, parent, depth) AS (
       SELECT id, parent_id, 0 FROM catalog_item WHERE id = ?
       UNION ALL SELECT c.id, c.parent_id, up.depth + 1 FROM catalog_item c JOIN up ON c.id = up.parent WHERE up.depth < 8
     ) SELECT i.id, i.provisional FROM up JOIN catalog_item i ON i.id = up.id ORDER BY up.depth`,
  );
  const provisionalTree = db.$client.prepare(
    `WITH RECURSIVE down(id, depth) AS (
       SELECT ?, 0
       UNION ALL SELECT c.id, down.depth + 1 FROM catalog_item c JOIN down ON c.parent_id = down.id WHERE down.depth < 8
     ) SELECT i.id, i.kind FROM down JOIN catalog_item i ON i.id = down.id WHERE i.provisional = 1 ORDER BY down.depth, i.id`,
  );
  const adopt = db.$client.prepare('UPDATE catalog_item SET provisional = 0, updated_at = ? WHERE id = ?');

  /** The provisional items of the work itemId belongs to, when any of its chain is provisional. */
  function adoptable(itemId: string): { id: string; kind: string }[] {
    const up = chain.all(itemId) as { id: string; provisional: number }[];
    const root = up.at(-1);
    if (!root || !up.some((r) => r.provisional === 1)) return [];
    return provisionalTree.all(root.id) as { id: string; kind: string }[];
  }

  const remove = (fileId: string): string[] => {
    const before = [...new Set((manualOf.all(fileId) as { itemId: string }[]).map((r) => r.itemId))];
    deleteManual.run(fileId);
    return before;
  };

  return {
    replaceManualLinks(fileId, itemIds) {
      return tx(() => {
        const wanted = [...new Set(itemIds)];
        for (const id of wanted) if (!itemExists.get(id)) throw new Error(`catalog item ${id} not found`);
        const removed = remove(fileId).filter((id) => !wanted.includes(id));
        const t = now();
        for (const itemId of wanted) insert.run(newId(), fileId, itemId, t);
        const adopted = new Map<string, string>();
        for (const itemId of wanted) for (const r of adoptable(itemId)) adopted.set(r.id, r.kind);
        for (const [itemId, kind] of adopted) {
          adopt.run(t, itemId);
          deps.events().publish('library.item_updated', { itemId, kind });
        }
        for (const itemId of removed) deps.events().publish('library.item_updated', { itemId, fileId, reason: 'media_unlinked' });
        for (const itemId of wanted) deps.events().publish('library.item_updated', { itemId, fileId, reason: 'media_linked' });
        return { removed };
      });
    },
    removeManualLinks(fileId) {
      return tx(() => {
        const removed = remove(fileId);
        for (const itemId of removed) deps.events().publish('library.item_updated', { itemId, fileId, reason: 'media_unlinked' });
        return removed;
      });
    },
  };
}
