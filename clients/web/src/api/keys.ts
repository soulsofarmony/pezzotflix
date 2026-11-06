// Query keys, one family per operation (doc 05 §7.7), and the invalidation that each polled event causes.
import type { QueryClient } from '@tanstack/react-query';
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
    qc.invalidateQueries({ queryKey: ['item'] }),
    qc.invalidateQueries({ queryKey: keys.home }),
    qc.invalidateQueries({ queryKey: keys.itemsAll }),
    qc.invalidateQueries({ queryKey: keys.searchAll }),
  ]);
}

/** Invalidates the queries an event makes stale. Playback events are for the player, not for the cache. */
export function invalidateForEvent(qc: QueryClient, e: AppEvent): void {
  switch (e.type) {
    case 'library.item_added':
    case 'library.item_updated':
    case 'library.item_removed':
      void qc.invalidateQueries({ queryKey: keys.home });
      void qc.invalidateQueries({ queryKey: keys.itemsAll });
      void qc.invalidateQueries({ queryKey: keys.searchAll });
      if (e.itemId) void qc.invalidateQueries({ queryKey: keys.item(e.itemId) });
      return;
    case 'ingest.progress':
      void qc.invalidateQueries({ queryKey: keys.admin.ingest });
      void qc.invalidateQueries({ queryKey: keys.admin.roots });
      void qc.invalidateQueries({ queryKey: keys.server });
      return;
    case 'identification.needs_review':
      void qc.invalidateQueries({ queryKey: keys.admin.casesAll });
      void qc.invalidateQueries({ queryKey: keys.server });
      if (e.caseId) void qc.invalidateQueries({ queryKey: keys.admin.case(e.caseId) });
      return;
    default:
      return;
  }
}
