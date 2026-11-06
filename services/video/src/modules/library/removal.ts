// Forgetting missing files (doc 01 §6.1: missing ──(grace period, or explicit removal)──→ removed). A state
// change, never a delete: the links, the case and every profile's state stay, so the same content coming back
// (same fingerprint) revives with them (scan.ts). The catalog hides an item whose files are all removed.
// Only a root that is online and not held ages into removal or is forgotten in bulk: the files of a root the
// unmounted-root guard sees as unmounted (unreachable, an empty walk, most of its files gone at once) are never
// forgotten. The guard sees a root, not the disks inside it: a separate disk mounted in a subfolder of a root
// that goes away looks like files deleted, and they age like any other.
// Writes run in short transactions with a yield to the event loop in between, like the scan's (ADR 0002 §12);
// every write re-checks what it decides on, since a scan may revive a file or hold its root meanwhile.
// A run that forgot something publishes ingest.progress (phase remove_missing), so clients refresh the missing
// list and the review queue; each item that changed gets library.item_updated (media_removed).
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { Db } from '../../db/index.ts';
import type { EventPublisher, LibraryControlPort } from '../../shared/ports.ts';
import { BATCH_SIZE } from './scan.ts';

export const DAY_MS = 24 * 3600_000;

/** A root whose missing files may be forgotten: online, and not held by the unmounted-root guard. */
const ROOT_SETTLED = `r.status = 'online' AND r.hold_reason IS NULL AND r.held_missing IS NULL`;
/**
 * When a file went missing; a row without missing_since (never written so by a scan) counts from its last change.
 * The same expression orders the missing list (admin/files.ts MISSING_AT): change the two together.
 */
const MISSING_AT = 'coalesce(f.missing_since, f.updated_at)';

export interface RemovalDeps {
  db: Db;
  now: () => number;
  events: () => EventPublisher;
}

export function createRemoval({ db, now, events }: RemovalDeps) {
  const prep = db.$client.prepare.bind(db.$client);
  const agedIds = prep(
    `SELECT f.id FROM media_file f JOIN library_root r ON r.id = f.root_id
     WHERE f.state = 'missing' AND ${MISSING_AT} < ? AND ${ROOT_SETTLED} ORDER BY ${MISSING_AT}, f.id`,
  ).pluck();
  const forgetAged = prep(
    `UPDATE media_file AS f SET state = 'removed', updated_at = @t
     WHERE f.id = @id AND f.state = 'missing' AND ${MISSING_AT} < @cutoff
       AND EXISTS (SELECT 1 FROM library_root r WHERE r.id = f.root_id AND ${ROOT_SETTLED})`,
  );
  const missingOfRoot = prep("SELECT id FROM media_file WHERE root_id = ? AND state = 'missing' ORDER BY id").pluck();
  const forgetOnRoot = prep(
    `UPDATE media_file AS f SET state = 'removed', updated_at = @t
     WHERE f.id = @id AND f.state = 'missing' AND EXISTS (SELECT 1 FROM library_root r WHERE r.id = f.root_id AND ${ROOT_SETTLED})`,
  );
  const forgetOne = prep("UPDATE media_file SET state = 'removed', updated_at = ? WHERE id = ? AND state = 'missing'");
  const stateOf = prep('SELECT state FROM media_file WHERE id = ?').pluck();
  const rootOf = prep('SELECT status, hold_reason AS holdReason, held_missing AS heldMissing FROM library_root WHERE id = ?');
  const linkedItems = prep('SELECT item_id FROM media_link WHERE file_id = ? ORDER BY created_at, id').pluck();

  /** library.item_updated once per item for the files just forgotten (the first of them names the file). */
  function announce(fileIds: readonly string[]): void {
    const items = new Map<string, string>();
    for (const fileId of fileIds) for (const itemId of linkedItems.all(fileId) as string[]) if (!items.has(itemId)) items.set(itemId, fileId);
    for (const [itemId, fileId] of items) events().publish('library.item_updated', { itemId, fileId, reason: 'media_removed' });
  }

  /**
   * Forgets ids in batches with `write` (true when it changed the row); returns how many it changed, and
   * publishes that count as ingest.progress (phase remove_missing) when it is not 0.
   */
  async function inBatches(ids: readonly string[], write: (id: string, t: number) => boolean): Promise<number> {
    const batch = db.$client.transaction((chunk: readonly string[]) => {
      const t = now();
      const done = chunk.filter((id) => write(id, t));
      announce(done);
      return done.length;
    });
    let n = 0;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      if (i > 0) await yieldToLoop();
      n += batch(ids.slice(i, i + BATCH_SIZE));
    }
    if (n > 0) events().publish('ingest.progress', { phase: 'remove_missing', forgotten: n });
    return n;
  }

  /** The daily task: files missing for more than `days` days are forgotten; 0 days turns it off. */
  async function removeAged(days: number): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = now() - days * DAY_MS;
    return inBatches(agedIds.all(cutoff) as string[], (id, t) => forgetAged.run({ id, t, cutoff }).changes > 0);
  }

  const forgetFile: LibraryControlPort['forgetFile'] = (fileId) =>
    db.$client.transaction(() => {
      const state = stateOf.get(fileId) as string | undefined;
      if (state === undefined) return 'not_found';
      if (state !== 'missing') return 'not_missing';
      forgetOne.run(now(), fileId);
      announce([fileId]);
      return 'forgotten';
    })();

  const forgetRootMissing: LibraryControlPort['forgetRootMissing'] = async (rootId) => {
    const root = rootOf.get(rootId) as { status: string; holdReason: string | null; heldMissing: number | null } | undefined;
    if (!root) return { status: 'not_found' };
    if (root.holdReason !== null || root.heldMissing !== null) return { status: 'held' };
    if (root.status !== 'online') return { status: 'offline' };
    const forgotten = await inBatches(missingOfRoot.all(rootId) as string[], (id, t) => forgetOnRoot.run({ id, t }).changes > 0);
    return { status: 'done', forgotten };
  };

  return { removeAged, forgetFile, forgetRootMissing };
}
