// The items that took the place of removed ones (library.item_removed replacedBy, doc 02 §3.5), kept in
// memory like the playback sessions that ask for them (CatalogReadPort.replacementFor). Written when the
// retirement publishes its event, inside the caller's transaction: a rolled back retirement leaves an entry
// for an item that still exists, which nobody asks about (the lookup starts from a removed item).

/** A rescan can retire many items; the sessions that ask are few and recent. */
export const REPLACEMENTS_KEPT = 1000;

export interface Replacements {
  record(itemId: string, replacedBy: string): void;
  /** The first item of the chain of replacements from itemId that exists; null when the chain ends before. */
  follow(itemId: string, exists: (id: string) => boolean): string | null;
}

export function createReplacements(limit = REPLACEMENTS_KEPT): Replacements {
  const byItem = new Map<string, string>();
  return {
    record(itemId, replacedBy) {
      byItem.delete(itemId);
      byItem.set(itemId, replacedBy);
      for (const oldest of byItem.keys()) {
        if (byItem.size <= limit) break;
        byItem.delete(oldest);
      }
    },
    follow(itemId, exists) {
      const seen = new Set([itemId]);
      let current = itemId;
      for (;;) {
        const next = byItem.get(current);
        if (next === undefined || seen.has(next)) return null;
        if (exists(next)) return next;
        seen.add(next);
        current = next;
      }
    },
  };
}
