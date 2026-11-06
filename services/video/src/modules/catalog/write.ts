// Catalog write side (doc 02 §3.6, ADR 0002 M3, ADR 0007 point 2): CatalogItem hierarchy, field
// values per source, external ids, credits, artwork rows, expiry and purge of provider data. Every
// write recomputes the resolved projection on catalog_item and the catalog_search row in the same
// transaction. Synchronous: a call made inside the caller's transaction joins it (better-sqlite3
// nests transactions as savepoints).
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.ts';
import {
  type ARTWORK_SOURCES,
  type ARTWORK_TYPES,
  artwork,
  catalogItem,
  credit,
  type EXTRA_TYPES,
  externalId,
  type FIELD_SOURCES,
  fieldLock,
  type ITEM_KINDS,
  itemField,
  person,
} from '../../db/schema/index.ts';
import { newId } from '../../shared/ids.ts';
import { JOB_TYPES, type MetadataEnrichPayload } from '../../shared/job-types.ts';
import { EXTERNAL_ID_KEYS, type ExternalIds, IMAGE_KEY_RE, imageKeyOf, type WorkKind } from '../../shared/metadata.ts';
import type {
  ArtworkRecord,
  ArtworkSource,
  ArtworkType,
  CatalogItemKind,
  CatalogItemRef,
  CatalogWritePort,
  CatalogWriteResult,
  CreditInput,
  EventPublisher,
  ExtraType,
  FieldSource,
  ItemFieldValues,
  JobQueuePort,
  SourcedFieldValues,
  SourceRemoval,
  WorkInput,
  WorkRefreshState,
} from '../../shared/ports.ts';
import { type FieldRow, project } from './resolve.ts';

export const ITEM_ADDED = 'library.item_added';
export const ITEM_UPDATED = 'library.item_updated';

const FIELD_KEYS = ['title', 'originalTitle', 'year', 'category', 'durationMs', 'overview', 'tagline', 'genres'] as const satisfies readonly (keyof ItemFieldValues)[];

/** New episodes of a known series wait this long, so one enrichment covers a whole scan batch. */
export const EPISODE_ENRICH_DELAY_MS = 60_000;

/** Editions compare case- and space-insensitively; no label and an empty label are the same edition. */
const editionKey = (label: string | null | undefined): string => (label ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

const isEmpty = (v: unknown): boolean => v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);

export interface CatalogWriterDeps {
  db: Db;
  now: () => number;
  events: () => EventPublisher;
  /** TMDB_MAX_AGE_DAYS in ms: older TMDB values are ignored by the projection (ADR 0007 point 5). */
  tmdbMaxAgeMs: number;
  /** Where metadata.enrich is enqueued (a work created or with new ids); absent in unit tests. */
  jobs?: () => JobQueuePort;
  log?: FastifyBaseLogger;
}

export type CatalogWriter = CatalogWritePort;

export function createCatalogWriter({ db, now, events, tmdbMaxAgeMs, jobs, log }: CatalogWriterDeps): CatalogWriter {
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
    const locks = lockMap(itemId);
    const p = project(item, rows, locks, now(), tmdbMaxAgeMs);
    db.update(catalogItem)
      .set({ title: p.title, originalTitle: p.originalTitle, sortTitle: p.sortTitle, year: p.year, durationMs: p.durationMs, category: p.category, updatedAt: now() })
      .where(eq(catalogItem.id, itemId))
      .run();
    deleteSearch.run(itemId);
    // NFKC like the query side (catalog/search.ts), so compatibility forms match what users type.
    insertSearch.run(itemId, p.title.normalize('NFKC'), p.originalTitle?.normalize('NFKC') ?? null);
  }

  const lockMap = (itemId: string): Map<string, FieldSource> =>
    new Map(db.select({ field: fieldLock.field, source: fieldLock.source }).from(fieldLock).where(eq(fieldLock.itemId, itemId)).all().map((l) => [l.field, l.source]));

  function writeFieldRows(itemId: string, fields: readonly SourcedFieldValues[]): void {
    let locks: Map<string, FieldSource> | null = null;
    for (const { source, fetchedAt, values } of fields) {
      for (const key of FIELD_KEYS) {
        if (!(key in values)) continue;
        const value = values[key];
        if (value === undefined) continue;
        const where = and(eq(itemField.itemId, itemId), eq(itemField.field, key), eq(itemField.source, source));
        if (source !== 'manual') {
          // ADR 0007 point 2: a lock on a provider value keeps it when an automatic write brings a
          // different one (the owner decides). For TMDB the old row keeps its fetched_at, so it still
          // expires. Known gap: the review flag is not persisted, only logged (ADR 0007 points 2, 3).
          locks ??= lockMap(itemId);
          if (locks.get(key) === source) {
            const old = db.select({ value: itemField.value }).from(itemField).where(where).get();
            if (old && JSON.stringify(old.value) !== JSON.stringify(isEmpty(value) ? null : value)) {
              log?.warn({ itemId, field: key, source }, 'locked provider value changed upstream: kept the old one, review needed');
              continue;
            }
          }
        }
        if (isEmpty(value)) {
          db.delete(itemField).where(where).run();
          continue;
        }
        db.insert(itemField)
          .values({ itemId, field: key, source, value, fetchedAt })
          .onConflictDoUpdate({ target: [itemField.itemId, itemField.field, itemField.source], set: { value, fetchedAt } })
          .run();
      }
    }
  }

  /** Adds the ids the item has no value for. Returns how many were added. */
  function addIds(itemId: string, ids: ExternalIds): number {
    let added = 0;
    for (const provider of EXTERNAL_ID_KEYS) {
      const value = ids[provider];
      if (!value) continue;
      const r = db.insert(externalId).values({ itemId, provider, externalId: value }).onConflictDoNothing().run();
      if (r.changes) {
        added++;
        continue;
      }
      const kept = db
        .select({ v: externalId.externalId })
        .from(externalId)
        .where(and(eq(externalId.itemId, itemId), eq(externalId.provider, provider)))
        .get()?.v;
      // Known gap (F1a.2): the first id wins; a different later one is only reported.
      if (kept !== value) log?.warn({ itemId, provider, kept, ignored: value }, 'conflicting external id ignored');
    }
    return added;
  }

  function enqueueEnrich(itemId: string, delayMs = 0): void {
    if (!jobs) return;
    const payload: MetadataEnrichPayload = { itemId };
    jobs().enqueue({ type: JOB_TYPES.metadataEnrich, payload, idempotencyKey: `enrich:${itemId}`, ...(delayMs ? { runAt: now() + delayMs } : {}) });
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

  const refColumns = {
    id: catalogItem.id,
    kind: catalogItem.kind,
    parentId: catalogItem.parentId,
    seasonNumber: catalogItem.seasonNumber,
    episodeNumber: catalogItem.episodeNumber,
    editionLabel: catalogItem.editionLabel,
    extraType: catalogItem.extraType,
    title: catalogItem.title,
  };

  const getItem = (itemId: string): CatalogItemRef | null => db.select(refColumns).from(catalogItem).where(eq(catalogItem.id, itemId)).get() ?? null;

  // ---------------------------------------------------------------- credits and artwork

  function personId(source: FieldSource, c: CreditInput): string {
    const existing = db
      .select({ id: person.id, name: person.name })
      .from(person)
      .where(and(eq(person.source, source), c.personRef ? eq(person.externalRef, c.personRef) : and(isNull(person.externalRef), eq(person.name, c.name))))
      .get();
    if (existing) {
      if (existing.name !== c.name) db.update(person).set({ name: c.name }).where(eq(person.id, existing.id)).run();
      return existing.id;
    }
    const id = newId();
    db.insert(person).values({ id, name: c.name, source, externalRef: c.personRef }).run();
    return id;
  }

  const dropOrphanPersons = (source: FieldSource) =>
    db.delete(person).where(and(eq(person.source, source), sql`${person.id} NOT IN (SELECT person_id FROM credit)`)).run();

  type ArtworkRow = typeof artwork.$inferSelect;
  const toRecord = (r: ArtworkRow): ArtworkRecord => ({
    id: r.id,
    itemId: r.itemId,
    source: r.source,
    type: r.type,
    language: r.language,
    localPath: r.localPath,
    remoteRef: r.remoteRef,
    width: r.width,
    height: r.height,
    selected: r.selected,
    fetchedAt: r.fetchedAt,
  });

  /** Rows of the image (any file of its key directory). */
  const rowsOfKey = (imageKey: string) => {
    const prefix = `${imageKey.slice(0, 2)}/${imageKey}/`;
    return sql`substr(${artwork.localPath}, 1, ${prefix.length}) = ${prefix}`;
  };

  /**
   * Of these paths, the ones whose image no artwork row references any more. By key directory, like
   * ArtworkStore.remove(), which deletes the whole directory of a key.
   */
  function unreferenced(paths: Iterable<string>): string[] {
    const out: string[] = [];
    for (const p of new Set(paths)) {
      const key = imageKeyOf(p);
      if (!key || !db.select({ id: artwork.id }).from(artwork).where(rowsOfKey(key)).limit(1).get()) out.push(p);
    }
    return out;
  }

  /** Expiry (cutoff) or purge (null) of one source: values, credits, artwork; then the projections. */
  function removeSource(source: 'tmdb', fetchedBefore: number | null): SourceRemoval {
    return tx(() => {
      const fieldWhere = fetchedBefore === null ? eq(itemField.source, source) : and(eq(itemField.source, source), lt(itemField.fetchedAt, fetchedBefore));
      const artWhere = fetchedBefore === null ? eq(artwork.source, source) : and(eq(artwork.source, source), lt(artwork.fetchedAt, fetchedBefore));
      const affected = new Set<string>();
      for (const r of db.selectDistinct({ itemId: itemField.itemId }).from(itemField).where(fieldWhere).all()) affected.add(r.itemId);
      const arts = db.select({ itemId: artwork.itemId, localPath: artwork.localPath }).from(artwork).where(artWhere).all();
      for (const a of arts) affected.add(a.itemId);
      db.delete(itemField).where(fieldWhere).run();
      db.delete(artwork).where(artWhere).run();
      // Credits carry no fetched_at. They are rewritten with the work's values at every refresh, so
      // they go when the item has no values of that source left (and all of them on a purge).
      const creditItems = db.selectDistinct({ itemId: credit.itemId }).from(credit).where(eq(credit.source, source)).all();
      for (const { itemId } of creditItems) {
        const stillHasValues = db
          .select({ f: itemField.field })
          .from(itemField)
          .where(and(eq(itemField.itemId, itemId), eq(itemField.source, source)))
          .limit(1)
          .get();
        if (fetchedBefore === null || !stillHasValues) {
          db.delete(credit).where(and(eq(credit.itemId, itemId), eq(credit.source, source))).run();
          affected.add(itemId);
        }
      }
      dropOrphanPersons(source);
      for (const itemId of affected) {
        refresh(itemId);
        const kind = getItem(itemId)?.kind;
        if (kind) updated(itemId, kind);
      }
      return { itemIds: [...affected], unreferencedPaths: unreferenced(arts.map((a) => a.localPath)) };
    });
  }

  return {
    refresh: (itemId) => tx(() => refresh(itemId)),
    findWork,

    upsertWork(input: WorkInput): CatalogWriteResult {
      return tx(() => {
        let itemId = findWork(input.kind, input.externalIds, input.editionLabel);
        const created = itemId === null;
        itemId ??= insertItem({ kind: input.kind, parentId: null, editionLabel: input.editionLabel?.trim() || null });
        const newIds = addIds(itemId, input.externalIds);
        writeFieldRows(itemId, input.fields);
        refresh(itemId);
        if (created) added(itemId, input.kind, null);
        else updated(itemId, input.kind);
        if (created || newIds) enqueueEnrich(itemId);
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
        // The series enrichment covers its seasons and episodes.
        enqueueEnrich(seriesId, EPISODE_ENRICH_DELAY_MS);
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
        if (season.parentId) enqueueEnrich(season.parentId, EPISODE_ENRICH_DELAY_MS);
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
      tx(() => {
        const item = getItem(itemId);
        if (addIds(itemId, ids) && item && item.parentId === null && (item.kind === 'movie' || item.kind === 'series')) enqueueEnrich(itemId);
      });
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

    getExternalIds(itemId) {
      const ids: ExternalIds = {};
      for (const r of db.select({ provider: externalId.provider, value: externalId.externalId }).from(externalId).where(eq(externalId.itemId, itemId)).all()) {
        if ((EXTERNAL_ID_KEYS as readonly string[]).includes(r.provider)) ids[r.provider as keyof ExternalIds] = r.value;
      }
      return ids;
    },

    listChildren(itemId) {
      return db
        .select(refColumns)
        .from(catalogItem)
        .where(eq(catalogItem.parentId, itemId))
        .orderBy(asc(catalogItem.seasonNumber), asc(catalogItem.episodeNumber), asc(catalogItem.sortTitle), asc(catalogItem.id))
        .all();
    },

    replaceCredits(itemId, source, credits) {
      tx(() => {
        db.delete(credit).where(and(eq(credit.itemId, itemId), eq(credit.source, source))).run();
        for (const c of credits) {
          if (!c.name.trim()) continue;
          db.insert(credit)
            .values({ itemId, personId: personId(source, c), role: c.role, character: c.character, order: c.order, source })
            .onConflictDoNothing()
            .run();
        }
        dropOrphanPersons(source);
      });
    },

    setArtwork(itemId, source, type, images) {
      return tx(() => {
        const where = and(eq(artwork.itemId, itemId), eq(artwork.source, source), eq(artwork.type, type));
        const old = db.select().from(artwork).where(where).all();
        db.delete(artwork).where(where).run();
        for (const img of images) {
          // An owner choice survives a re-download of the same file.
          const selected = old.some((o) => o.localPath === img.localPath && o.selected);
          db.insert(artwork).values({ id: newId(), itemId, source, ...img, type, selected }).run();
        }
        const removed = unreferenced(old.map((o) => o.localPath));
        if (old.length || images.length) {
          const kind = getItem(itemId)?.kind;
          if (kind) updated(itemId, kind);
        }
        return removed;
      });
    },

    listArtwork(itemId) {
      return db.select().from(artwork).where(eq(artwork.itemId, itemId)).orderBy(asc(artwork.type), asc(artwork.source), asc(artwork.id)).all().map(toRecord);
    },

    findArtworkByKey(imageKey) {
      if (!IMAGE_KEY_RE.test(imageKey)) return null;
      // TMDB first: if any row of this file is TMDB Content, its cache policy applies.
      const r = db.select().from(artwork).where(rowsOfKey(imageKey)).orderBy(sql`${artwork.source} = 'tmdb' DESC`, asc(artwork.id)).get();
      return r ? toRecord(r) : null;
    },

    markImageMissing(imageKey) {
      if (!IMAGE_KEY_RE.test(imageKey)) return;
      db.update(artwork).set({ fetchedAt: 0 }).where(rowsOfKey(imageKey)).run();
    },

    hasSourceData(source) {
      const row = db.$client
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM item_field WHERE source = @s) OR EXISTS (SELECT 1 FROM credit WHERE source = @s)
             OR EXISTS (SELECT 1 FROM artwork WHERE source = @s) AS present`,
        )
        .get({ s: source }) as { present: number };
      return row.present === 1;
    },

    listWorkRefreshState(): WorkRefreshState[] {
      // Newest value = the last refresh: one value no refresh rewrites must not make the work due
      // every day. The work's own TMDB artwork counts with its oldest row (it is re-downloaded too).
      const rows = db.$client
        .prepare(
          `SELECT i.id AS itemId, i.kind AS kind,
             (SELECT max(f.fetched_at) FROM item_field f WHERE f.item_id = i.id AND f.source = 'tmdb') AS tmdbValues,
             (SELECT min(a.fetched_at) FROM artwork a WHERE a.item_id = i.id AND a.source = 'tmdb') AS tmdbArtwork,
             (SELECT max(f.fetched_at) FROM item_field f WHERE f.item_id = i.id AND f.source = 'wikidata') AS wikidataFetchedAt
           FROM catalog_item i WHERE i.parent_id IS NULL AND i.kind IN ('movie', 'series') ORDER BY i.added_at, i.id`,
        )
        .all() as { itemId: string; kind: WorkKind; tmdbValues: number | null; tmdbArtwork: number | null; wikidataFetchedAt: number | null }[];
      return rows.map((r) => ({
        itemId: r.itemId,
        kind: r.kind,
        tmdbFetchedAt: r.tmdbValues === null ? r.tmdbArtwork : r.tmdbArtwork === null ? r.tmdbValues : Math.min(r.tmdbValues, r.tmdbArtwork),
        wikidataFetchedAt: r.wikidataFetchedAt,
      }));
    },

    expireSource: (source, fetchedBefore) => removeSource(source, fetchedBefore),
    purgeSource: (source) => removeSource(source, null),
  };
}

// Compile-time checks: the port's enums are the schema's.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const PORT_ENUMS_MATCH_SCHEMA: [
  Same<FieldSource, (typeof FIELD_SOURCES)[number]>,
  Same<ExtraType, (typeof EXTRA_TYPES)[number]>,
  Same<CatalogItemKind, (typeof ITEM_KINDS)[number]>,
  Same<ArtworkType, (typeof ARTWORK_TYPES)[number]>,
  Same<ArtworkSource, (typeof ARTWORK_SOURCES)[number]>,
] = [true, true, true, true, true];
