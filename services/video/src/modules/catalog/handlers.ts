// Catalog operations of the contract (paths/catalog.yaml): Home, ListItems, Search, GetItem,
// GetChildren, GetNextUp. Watch-state operations belong to profiles (F1b).
import { typed, type Handlers, type Ok } from '../../app/http.ts';
import { notFound } from '../../app/problem.ts';
import type { CatalogReader, ListQuery } from './read.ts';

const HOME_ROW_SIZE = 20;

type HomeRow = Ok<'getHome'>['rows'][number];

interface RowSpec {
  id: HomeRow['id'];
  title: string;
  /** ListItems parameters of the row; null for next_up, which no list reproduces. */
  query: ListQuery | null;
}

/**
 * Home rows (doc 03 §3.2, requirements §16), Italian titles. Empty rows are left out. next_up sits
 * right after Continue watching: doc 01 D3 puts the next episode of the series in course there.
 */
const HOME_ROWS: readonly RowSpec[] = [
  { id: 'continue_watching', title: 'Continua a guardare', query: { continueWatching: true, sort: 'last_played', order: 'desc' } },
  { id: 'next_up', title: 'Prossimi episodi', query: null },
  { id: 'recently_added', title: 'Aggiunti di recente', query: { sort: 'added', order: 'desc' } },
  { id: 'movies', title: 'Film', query: { kind: 'movie', category: 'film' } },
  { id: 'series', title: 'Serie', query: { kind: 'series' } },
  { id: 'documentaries', title: 'Documentari', query: { category: 'documentary' } },
];

/** ListItems parameters of a row, as strings ("see all"). */
const asParams = (q: ListQuery): Record<string, string> =>
  Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));

/** The security handler sets the profile; an empty id means none (never on these routes). */
const profileOf = (id: string): string | null => id || null;

export function catalogHandlers(reader: CatalogReader): Handlers {
  return {
    getHome: async (req): Promise<Ok<'getHome'>> => {
      const profileId = profileOf(typed<'getHome'>(req).profileId);
      const rows: HomeRow[] = [];
      for (const spec of HOME_ROWS) {
        // Without profile state (no profiles module) there is nothing to continue.
        if ((spec.id === 'continue_watching' || spec.id === 'next_up') && (!profileId || !reader.profileStateAvailable())) continue;
        if (!spec.query) {
          const items = reader.nextUpRow(profileId!, HOME_ROW_SIZE);
          if (items.length) rows.push({ id: spec.id, title: spec.title, items, nextCursor: null });
          continue;
        }
        const page = reader.list({ ...spec.query, limit: HOME_ROW_SIZE }, profileId);
        if (page.items.length) rows.push({ id: spec.id, title: spec.title, items: page.items, nextCursor: page.nextCursor, query: asParams(spec.query) });
      }
      return { rows };
    },

    listItems: async (req): Promise<Ok<'listItems'>> => {
      const { query, profileId } = typed<'listItems'>(req);
      return reader.list(query, profileOf(profileId));
    },

    search: async (req): Promise<Ok<'search'>> => {
      const { query, profileId } = typed<'search'>(req);
      return reader.search(query.q, query.kind, query.limit ?? 50, profileOf(profileId));
    },

    getItem: async (req): Promise<Ok<'getItem'>> => {
      const { params, profileId } = typed<'getItem'>(req);
      const item = reader.detail(params.itemId, profileOf(profileId));
      if (!item) throw notFound('Item');
      return item;
    },

    getChildren: async (req): Promise<Ok<'getChildren'>> => {
      const { params, query, profileId } = typed<'getChildren'>(req);
      const page = reader.children(params.itemId, query.cursor, query.limit ?? 50, profileOf(profileId));
      if (!page) throw notFound('Item');
      return page;
    },

    getNextUp: async (req): Promise<Ok<'getNextUp'>> => {
      const { params, profileId } = typed<'getNextUp'>(req);
      const next = reader.nextUp(params.itemId, profileOf(profileId));
      if (!next) throw notFound('Item');
      return next;
    },
  };
}
