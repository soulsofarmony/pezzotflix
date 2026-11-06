// Items the library removed while the app is open (library.item_removed), and the item that took each one's place.
// A page open on a removed item reads it here: the cached detail would otherwise stay on screen, and a refetch only
// says 404.

/** How many removals are remembered: a rescan can remove many items, and old ones are no longer on any page. */
export const REMOVALS_KEPT = 500;

export interface RemovalStore {
  /** replacedBy: the item that took its place (a provisional item identified), or null. */
  record: (itemId: string, replacedBy: string | null) => void;
  /**
   * undefined: not removed. null: removed, nothing took its place. Otherwise the item to show instead, following a
   * chain of replacements to its end.
   */
  resolve: (itemId: string) => string | null | undefined;
  subscribe: (onChange: () => void) => () => void;
}

export function createRemovalStore(limit = REMOVALS_KEPT): RemovalStore {
  const removed = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  return {
    record(itemId, replacedBy) {
      removed.delete(itemId);
      removed.set(itemId, replacedBy);
      for (const old of removed.keys()) {
        if (removed.size <= limit) break;
        removed.delete(old);
      }
      for (const l of listeners) l();
    },
    resolve(itemId) {
      if (!removed.has(itemId)) return undefined;
      const seen = new Set([itemId]);
      let current = itemId;
      for (;;) {
        const next = removed.get(current);
        if (next === undefined) return current;
        if (next === null || seen.has(next)) return null;
        seen.add(next);
        current = next;
      }
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
  };
}
