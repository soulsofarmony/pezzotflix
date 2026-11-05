// Manual MediaLinks (doc 02 §4: the catalog owns MediaLink manual, the identifier the auto ones).
// Synchronous: a call made inside the caller's transaction joins it.
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
