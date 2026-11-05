// Catalog write side (doc 02 §3.6, ADR 0002 M3, ADR 0007 point 2): CatalogItem hierarchy, field
// values per source, external ids. Every write recomputes the resolved projection on catalog_item
// and the catalog_search row in the same transaction. Synchronous: a call made inside the caller's
// transaction joins it (better-sqlite3 nests transactions as savepoints).
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/index.ts';
import { catalogItem, type EXTRA_TYPES, externalId, type FIELD_SOURCES, fieldLock, type ITEM_KINDS, itemField } from '../../db/schema/index.ts';
import { newId } from '../../shared/ids.ts';
import { EXTERNAL_ID_KEYS, type ExternalIds, type WorkKind } from '../../shared/metadata.ts';
import type {
  CatalogItemKind,
  CatalogItemRef,
  CatalogWritePort,
  CatalogWriteResult,
  EventPublisher,
  ExtraType,
  FieldSource,
  ItemFieldValues,
  SourcedFieldValues,
  WorkInput,
} from '../../shared/ports.ts';
import { type FieldRow, project } from './resolve.ts';

export const ITEM_ADDED = 'library.item_added';
export const ITEM_UPDATED = 'library.item_updated';

const FIELD_KEYS = ['title', 'originalTitle', 'year', 'category', 'durationMs'] as const satisfies readonly (keyof ItemFieldValues)[];

/** Editions compare case- and space-insensitively; no label and an empty label are the same edition. */
const editionKey = (label: string | null | undefined): string => (label ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

export interface CatalogWriterDeps {
  db: Db;
  now: () => number;
  events: () => EventPublisher;
  /** TMDB_MAX_AGE_DAYS in ms: older TMDB values are ignored by the projection (ADR 0007 point 5). */
  tmdbMaxAgeMs: number;
}

export type CatalogWriter = CatalogWritePort & {
  /** Recomputes the projection and the search row of one item (also used after expiry and purge). */
  refresh(itemId: string): void;
};

export function createCatalogWriter({ db, now, events, tmdbMaxAgeMs }: CatalogWriterDeps): CatalogWriter {
  const tx = <T>(fn: () => T): T => db.$client.transaction(fn)();

  const insertSearch = db.$client.prepare('INSERT INTO catalog_search (item_id, title, original_title) VALUES (?, ?, ?)');
  const deleteSearch = db.$client.prepare('DELETE FROM catalog_search WHERE item_id = ?');

  function refresh(itemId: string): void {
    const item = db.select().from(catalogItem).where(eq(catalogItem.id, itemId)).get();
    if (!item) return;
    const rows: FieldRow[] = db
      .select({ field: itemField.field, source: itemField.source, value: itemField.value, fetchedAt: itemField.fetchedAt })
      .from(itemField)
      .where(eq(itemField.itemId, itemId))
      .all();
    const locks = new Map(
      db.select({ field: fieldLock.field, source: fieldLock.source }).from(fieldLock).where(eq(fieldLock.itemId, itemId)).all().map((l) => [l.field, l.source]),
    );
    const p = project(item, rows, locks, now(), tmdbMaxAgeMs);
    db.update(catalogItem)
      .set({ title: p.title, originalTitle: p.originalTitle, sortTitle: p.sortTitle, year: p.year, durationMs: p.durationMs, category: p.category, updatedAt: now() })
      .where(eq(catalogItem.id, itemId))
      .run();
    deleteSearch.run(itemId);
    insertSearch.run(itemId, p.title, p.originalTitle);
  }

  function writeFieldRows(itemId: string, fields: readonly SourcedFieldValues[]): void {
    for (const { source, fetchedAt, values } of fields) {
      for (const key of FIELD_KEYS) {
        if (!(key in values)) continue;
        const value = values[key];
        if (value === undefined) continue;
        if (value === null || (typeof value === 'string' && !value.trim())) {
          db.delete(itemField).where(and(eq(itemField.itemId, itemId), eq(itemField.field, key), eq(itemField.source, source))).run();
          continue;
        }
        db.insert(itemField)
          .values({ itemId, field: key, source, value, fetchedAt })
          .onConflictDoUpdate({ target: [itemField.itemId, itemField.field, itemField.source], set: { value, fetchedAt } })
          .run();
      }
    }
  }

  function addIds(itemId: string, ids: ExternalIds): void {
    for (const provider of EXTERNAL_ID_KEYS) {
      const value = ids[provider];
      if (value) db.insert(externalId).values({ itemId, provider, externalId: value }).onConflictDoNothing().run();
    }
  }

  function insertItem(row: {
    kind: CatalogItemKind;
    parentId: string | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    extraType?: ExtraType | null;
    editionLabel?: string | null;
  }): string {
    const id = newId();
    const t = now();
    // Title and sort title are placeholders until refresh() computes the projection, in this transaction.
    db.insert(catalogItem)
      .values({
        id,
        kind: row.kind,
        parentId: row.parentId,
        seasonNumber: row.seasonNumber ?? null,
        episodeNumber: row.episodeNumber ?? null,
        extraType: row.extraType ?? null,
        editionLabel: row.editionLabel ?? null,
        title: '',
        sortTitle: '',
        addedAt: t,
        updatedAt: t,
      })
      .run();
    return id;
  }

  const added = (itemId: string, kind: CatalogItemKind, parentId: string | null) => events().publish(ITEM_ADDED, { itemId, kind, parentId });
  const updated = (itemId: string, kind: CatalogItemKind) => events().publish(ITEM_UPDATED, { itemId, kind });

  function findWork(kind: WorkKind, ids: ExternalIds, editionLabel: string | null): string | null {
    const edition = editionKey(editionLabel);
    for (const provider of EXTERNAL_ID_KEYS) {
      const value = ids[provider];
      if (!value) continue;
      const hit = db
        .select({ id: catalogItem.id, editionLabel: catalogItem.editionLabel })
        .from(externalId)
        .innerJoin(catalogItem, eq(catalogItem.id, externalId.itemId))
        .where(and(eq(externalId.provider, provider), eq(externalId.externalId, value), eq(catalogItem.kind, kind), isNull(catalogItem.parentId)))
        .orderBy(asc(catalogItem.addedAt), asc(catalogItem.id))
        .all()
        .find((r) => editionKey(r.editionLabel) === edition);
      if (hit) return hit.id;
    }
    return null;
  }

  function child(parentId: string, kind: 'season' | 'episode', column: 'seasonNumber' | 'episodeNumber', n: number): string | null {
    return (
      db
        .select({ id: catalogItem.id })
        .from(catalogItem)
        .where(and(eq(catalogItem.parentId, parentId), eq(catalogItem.kind, kind), eq(catalogItem[column], n)))
        .orderBy(asc(catalogItem.addedAt), asc(catalogItem.id))
        .get()?.id ?? null
    );
  }

  function requireKind(itemId: string, kind: CatalogItemKind): void {
    const got = db.select({ kind: catalogItem.kind }).from(catalogItem).where(eq(catalogItem.id, itemId)).get()?.kind;
    if (got !== kind) throw new Error(`catalog item ${itemId} is ${got ?? 'missing'}, expected ${kind}`);
  }

  const getItem = (itemId: string): CatalogItemRef | null =>
    db
      .select({
        id: catalogItem.id,
        kind: catalogItem.kind,
        parentId: catalogItem.parentId,
        seasonNumber: catalogItem.seasonNumber,
        episodeNumber: catalogItem.episodeNumber,
        editionLabel: catalogItem.editionLabel,
        title: catalogItem.title,
      })
      .from(catalogItem)
      .where(eq(catalogItem.id, itemId))
      .get() ?? null;

  return {
    refresh: (itemId) => tx(() => refresh(itemId)),
    findWork,

    upsertWork(input: WorkInput): CatalogWriteResult {
      return tx(() => {
        let itemId = findWork(input.kind, input.externalIds, input.editionLabel);
        const created = itemId === null;
        itemId ??= insertItem({ kind: input.kind, parentId: null, editionLabel: input.editionLabel?.trim() || null });
        addIds(itemId, input.externalIds);
        writeFieldRows(itemId, input.fields);
        refresh(itemId);
        if (created) added(itemId, input.kind, null);
        else updated(itemId, input.kind);
        return { itemId, created };
      });
    },

    ensureSeason(seriesId, seasonNumber) {
      return tx(() => {
        requireKind(seriesId, 'series');
        const existing = child(seriesId, 'season', 'seasonNumber', seasonNumber);
        if (existing) return { itemId: existing, created: false };
        const itemId = insertItem({ kind: 'season', parentId: seriesId, seasonNumber });
        refresh(itemId);
        added(itemId, 'season', seriesId);
        return { itemId, created: true };
      });
    },

    ensureEpisode(seasonId, episodeNumber) {
      return tx(() => {
        const season = getItem(seasonId);
        if (season?.kind !== 'season') throw new Error(`catalog item ${seasonId} is not a season`);
        const existing = child(seasonId, 'episode', 'episodeNumber', episodeNumber);
        if (existing) return { itemId: existing, created: false };
        const itemId = insertItem({ kind: 'episode', parentId: seasonId, seasonNumber: season.seasonNumber, episodeNumber });
        refresh(itemId);
        added(itemId, 'episode', seasonId);
        return { itemId, created: true };
      });
    },

    createExtra({ parentId, extraType, title, numberIfTaken, fetchedAt }) {
      return tx(() => {
        let shown = title.trim() || 'Extra';
        if (numberIfTaken && parentId) {
          const taken = new Set(
            db
              .select({ title: catalogItem.title })
              .from(catalogItem)
              .where(and(eq(catalogItem.parentId, parentId), eq(catalogItem.kind, 'extra')))
              .all()
              .map((r) => r.title),
          );
          for (let n = 2; taken.has(shown); n++) shown = `${title.trim()} ${n}`;
        }
        const itemId = insertItem({ kind: 'extra', parentId, extraType });
        writeFieldRows(itemId, [{ source: 'filename', fetchedAt, values: { title: shown } }]);
        refresh(itemId);
        added(itemId, 'extra', parentId);
        return { itemId, created: true };
      });
    },

    writeFields(itemId, fields) {
      tx(() => {
        const item = getItem(itemId);
        if (!item) throw new Error(`catalog item ${itemId} not found`);
        writeFieldRows(itemId, fields);
        refresh(itemId);
        updated(itemId, item.kind);
      });
    },

    addExternalIds(itemId, ids) {
      tx(() => addIds(itemId, ids));
    },

    getItem,

    findAncestor(itemId, kind) {
      let cur = getItem(itemId);
      for (let depth = 0; cur && depth < 8; depth++) {
        if (cur.kind === kind) return cur.id;
        cur = cur.parentId ? getItem(cur.parentId) : null;
      }
      return null;
    },
  };
}

// Compile-time checks: the port's enums are the schema's.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const PORT_ENUMS_MATCH_SCHEMA: [
  Same<FieldSource, (typeof FIELD_SOURCES)[number]>,
  Same<ExtraType, (typeof EXTRA_TYPES)[number]>,
  Same<CatalogItemKind, (typeof ITEM_KINDS)[number]>,
] = [true, true, true];
