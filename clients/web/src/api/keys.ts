// Query keys, one family per operation (doc 05 §7.7), and the invalidation that each polled event causes.
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { AppEvent } from './types.ts';

export interface ItemFilters {
  kind?: string | undefined;
  category?: string | undefined;
  sort?: string | undefined;
  order?: string | undefined;
  watched?: boolean | undefined;
  inWatchlist?: boolean | undefined;
  continueWatching?: boolean | undefined;
  year?: number | undefined;
}

export const keys = {
  server: ['server'] as const,
  profiles: ['profiles'] as const,
  home: ['home'] as const,
  items: (filters: ItemFilters) => ['items', filters] as const,
  itemsAll: ['items'] as const,
  item: (id: string) => ['item', id] as const,
  /** Every item detail, children list and next up: one item's change shows in its parent's lists too. */
  itemAll: ['item'] as const,
  children: (id: string) => ['item', id, 'children'] as const,
  nextUp: (id: string) => ['item', id, 'next-up'] as const,
  search: (q: string, kind: string | undefined) => ['search', q, kind ?? null] as const,
  searchAll: ['search'] as const,
  activeSessions: ['playback', 'sessions'] as const,
  admin: {
    all: ['admin'] as const,
    cases: (state: string) => ['admin', 'cases', state] as const,
    casesAll: ['admin', 'cases'] as const,
    case: (id: string) => ['admin', 'case', id] as const,
    roots: ['admin', 'roots'] as const,
    ingest: ['admin', 'ingest'] as const,
    providerSearch: (q: string, kind: string | undefined, year: number | undefined) => ['admin', 'provider-search', q, kind ?? null, year ?? null] as const,
    file: (id: string) => ['admin', 'file', id] as const,
  },
};

/**
 * After a StopPlayback: the last position and the watched state are saved now, while the page the viewer goes
 * back to (item detail, Home) may already have refetched before it. Every item page and list is stale.
 */
export function invalidateAfterPlayback(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.itemAll }),
    qc.invalidateQueries({ queryKey: keys.home }),
    qc.invalidateQueries({ queryKey: keys.itemsAll }),
    qc.invalidateQueries({ queryKey: keys.searchAll }),
  ]);
}

/** The query families an event makes stale. Playback events are for the player, not for the cache. */
export function staleKeysForEvent(e: AppEvent): QueryKey[] {
  switch (e.type) {
    case 'library.item_added':
    case 'library.item_updated':
    case 'library.item_removed':
      // Every item query, not only this item's: its season's episode list, its series' next up, the parent an
      // added item joins.
      return [keys.home, keys.itemsAll, keys.searchAll, keys.itemAll];
    case 'ingest.progress':
      return [keys.admin.ingest, keys.admin.roots, keys.server];
    case 'identification.needs_review':
      return [keys.admin.casesAll, keys.server, ...(e.caseId ? [keys.admin.case(e.caseId)] : [])];
    default:
      return [];
  }
}

/**
 * Invalidates what a page of events makes stale, each family once: a scan sends many events at a time. A removed
 * item's own queries (detail, children, next up) are dropped, not kept as stale data; only those no page observes,
 * because the page on screen answers the removal itself (api/removals.ts) and the player keeps its title.
 */
export function invalidateForEvents(qc: QueryClient, events: readonly AppEvent[]): void {
  for (const e of events) if (e.type === 'library.item_removed' && e.itemId) qc.removeQueries({ queryKey: keys.item(e.itemId), type: 'inactive' });
  const stale = new Map<string, QueryKey>();
  for (const e of events) for (const k of staleKeysForEvent(e)) stale.set(JSON.stringify(k), k);
  for (const queryKey of stale.values()) void qc.invalidateQueries({ queryKey });
}
