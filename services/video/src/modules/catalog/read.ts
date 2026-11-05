// Catalog read side (doc 02 §3.6, doc 03 §3.2–3.4): summaries, lists with keyset pagination,
// search, item detail, children, and the CatalogReadPort used by playback. Reads the resolved
// projection on catalog_item only (ADR 0002 point 4); item_field is read for detail-only fields.
// Profile state comes from ProfileStatePort, which may be absent (profiles arrive in F1b).
import type { Db } from '../../db/index.ts';
import type { MediaFacts } from '../../shared/media-facts.ts';
import { imageKeyOf, imageUrlOf, type ImageWidth, TMDB_NOTICE, WIKIDATA_NOTICE } from '../../shared/metadata.ts';
import type {
  ApiSchemas,
  CatalogItemPosition,
  CatalogReadPort,
  FieldSource,
  ItemSummary,
  MediaVersion,
  PlayableItem,
  ProfileItemState,
  ProfileStatePort,
} from '../../shared/ports.ts';
import { type AudioSignal, badgesOf, type Signals, versionLabel, type VideoSignal } from './badges.ts';
import { compareKeys, decodeCursor, encodeCursor, type KeyValue } from './cursor.ts';
import { resolveField, type FieldRow } from './resolve.ts';
import { foldForContains, ftsQuery, needsSubstringSearch } from './search.ts';

type ImageRef = ApiSchemas['ImageRef'];
type Track = ApiSchemas['Track'];
type Chapter = ApiSchemas['Chapter'];
type ItemDetail = ApiSchemas['ItemDetail'];
type ItemKind = ItemSummary['kind'];

/** Ids per describeItems statement: well below SQLite's limits, and a bounded JSON parameter. */
export const DESCRIBE_CHUNK = 500;

// One definition of the notices and of the image keys and URLs, shared with modules/metadata.
export { imageKeyOf, TMDB_NOTICE, WIKIDATA_NOTICE } from '../../shared/metadata.ts';

export interface ItemRow {
  id: string;
  kind: ItemKind;
  category: 'film' | 'documentary' | null;
  parentId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  extraType: string | null;
  editionLabel: string | null;
  title: string;
  originalTitle: string | null;
  sortTitle: string;
  year: number | null;
  durationMs: number | null;
  addedAt: number;
}

const COLS = `i.id, i.kind, i.category, i.parent_id AS parentId, i.season_number AS seasonNumber, i.episode_number AS episodeNumber,
  i.extra_type AS extraType, i.edition_label AS editionLabel, i.title, i.original_title AS originalTitle, i.sort_title AS sortTitle,
  i.year, i.duration_ms AS durationMs, i.added_at AS addedAt`;

/** The item, or for a container one of its episodes, has a linked file. Items left without files are hidden. */
const HAS_MEDIA = `(EXISTS (SELECT 1 FROM media_link l WHERE l.item_id = i.id)
  OR EXISTS (SELECT 1 FROM catalog_item e JOIN media_link l ON l.item_id = e.id WHERE e.parent_id = i.id AND e.kind = 'episode')
  OR EXISTS (SELECT 1 FROM catalog_item s JOIN catalog_item e ON e.parent_id = s.id JOIN media_link l ON l.item_id = e.id
             WHERE s.parent_id = i.id AND s.kind = 'season' AND e.kind = 'episode'))`;

/** A linked file can be played: present and on an online root. */
const FILE_AVAILABLE = `(f.state NOT IN ('missing', 'removed') AND r.status = 'online')`;

/** Files of each requested item and of its seasons and episodes (not of its extras). */
const TREE_FILES = `WITH RECURSIVE tree(root, id) AS (
    SELECT value, value FROM json_each(@ids)
    UNION ALL
    SELECT t.root, c.id FROM catalog_item c JOIN tree t ON c.parent_id = t.id WHERE c.kind IN ('season', 'episode')
  ),
  files AS (
    SELECT DISTINCT t.root AS root, f.id AS fileId, ${FILE_AVAILABLE} AS available
    FROM tree t JOIN media_link l ON l.item_id = t.id JOIN media_file f ON f.id = l.file_id JOIN library_root r ON r.id = f.root_id
  )`;

/** Widths of getImage offered per artwork type. */
const VARIANTS: Readonly<Record<ImageRef['type'], readonly ImageWidth[]>> = {
  poster: [160, 320, 640],
  backdrop: [640, 1280, 1920],
  logo: [320, 640],
  still: [320, 640],
  thumbnail: [160, 320],
};

export function imageRef(type: ImageRef['type'], key: string): ImageRef {
  return { type, url: imageUrlOf(key), variants: Object.fromEntries(VARIANTS[type].map((w) => [String(w), imageUrlOf(key, w)])) };
}

/** Artwork language order of ADR 0007 point 3: it → none → en → others. */
const langRank = (l: string | null): number => (l === 'it' || l === 'ita' ? 0 : l === null ? 1 : l === 'en' || l === 'eng' ? 2 : 3);

const ARTWORK_ORDER: readonly ImageRef['type'][] = ['poster', 'backdrop', 'logo', 'still', 'thumbnail'];

// ---------------------------------------------------------------- tracks

const SIDECAR_CODEC: Readonly<Record<string, string>> = { srt: 'subrip', ass: 'ass', ssa: 'ssa', vtt: 'webvtt', sup: 'hdmv_pgs_subtitle' };

interface StreamRow {
  index: number;
  type: string;
  codec: string | null;
  profile: string | null;
  language: string | null;
  title: string | null;
  isDefault: number;
  isForced: number;
  isSdh: number;
  isCommentary: number;
  attrs: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function trackOf(s: StreamRow): Track | null {
  if (s.type !== 'video' && s.type !== 'audio' && s.type !== 'subtitle') return null;
  const a = JSON.parse(s.attrs) as Record<string, unknown>;
  if (s.type === 'video' && a.attachedPic === true) return null; // cover art, not a track
  const dv = a.dolbyVision as { profile?: unknown; level?: unknown; blCompatId?: unknown; hasEnhancementLayer?: unknown } | null | undefined;
  return {
    id: `s${s.index}`,
    type: s.type,
    index: s.index,
    codec: s.codec,
    profile: s.profile,
    language: s.language,
    title: s.title,
    default: s.isDefault === 1,
    forced: s.isForced === 1,
    sdh: s.isSdh === 1,
    commentary: s.isCommentary === 1,
    channels: int(a.channels),
    channelLayout: strOrNull(a.channelLayout),
    lossless: typeof a.lossless === 'boolean' ? a.lossless : null,
    objectAudio: strOrNull(a.objectAudio),
    width: int(a.width),
    height: int(a.height),
    frameRate: num(a.frameRate),
    bitDepth: int(a.bitDepth),
    hdr: strOrNull(a.hdr),
    dolbyVision: dv
      ? { profile: Number(dv.profile), level: Number(dv.level), blCompatId: Number(dv.blCompatId), hasEnhancementLayer: dv.hasEnhancementLayer === true }
      : null,
    subtitleKind: s.type === 'subtitle' ? (a.kind === 'image' ? 'image' : 'text') : null,
    external: false,
  };
}

export function sidecarTracks(facts: MediaFacts | null): Track[] {
  return (facts?.sidecars ?? []).map((x, i) => ({
    id: x.id,
    type: 'subtitle' as const,
    // Sidecars have no container index: their position among the file's sidecars. Select by id.
    index: i,
    codec: SIDECAR_CODEC[x.format] ?? x.format,
    profile: null,
    language: x.language,
    title: null,
    default: false,
    forced: x.forced,
    sdh: x.sdh,
    commentary: false,
    channels: null,
    channelLayout: null,
    lossless: null,
    objectAudio: null,
    width: null,
    height: null,
    frameRate: null,
    bitDepth: null,
    hdr: null,
    dolbyVision: null,
    subtitleKind: x.format === 'sup' ? ('image' as const) : ('text' as const),
    external: true,
  }));
}

// ---------------------------------------------------------------- reader

export interface ListQuery {
  kind?: ItemKind;
  category?: 'film' | 'documentary';
  year?: number;
  watched?: boolean;
  inWatchlist?: boolean;
  continueWatching?: boolean;
  sort?: 'title' | 'year' | 'added' | 'duration' | 'last_played';
  order?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}

export interface Page {
  items: ItemSummary[];
  nextCursor: string | null;
}

export interface CatalogReaderDeps {
  db: Db;
  now: () => number;
  tmdbMaxAgeMs: number;
  /** Null while no module provides the port. */
  profileState: () => ProfileStatePort | null;
}

const KEY_SQL: Readonly<Record<Exclude<NonNullable<ListQuery['sort']>, 'last_played'>, string>> = {
  title: 'i.sort_title',
  year: 'COALESCE(i.year, 0)',
  added: 'i.added_at',
  duration: 'COALESCE(i.duration_ms, 0)',
};

const STATE_CHUNK = 500;
const CONTINUE_WATCHING_MAX = 10_000;

export function createCatalogReader({ db, now, tmdbMaxAgeMs, profileState }: CatalogReaderDeps) {
  const prep = db.$client.prepare.bind(db.$client);
  const itemById = prep(`SELECT ${COLS} FROM catalog_item i WHERE i.id = ?`);
  // One statement per chunk of ids (a JSON array), whatever the chunk size.
  const positionsOf = prep(
    `SELECT id, kind, parent_id AS parentId, season_number AS seasonNumber, episode_number AS episodeNumber
     FROM catalog_item WHERE id IN (SELECT value FROM json_each(?))`,
  );
  const itemsByIds = prep(`SELECT ${COLS} FROM catalog_item i WHERE i.id IN (SELECT value FROM json_each(?))`);
  const availability = prep(`${TREE_FILES} SELECT root, max(available) AS available FROM files GROUP BY root`);
  const streamSignals = prep(
    `${TREE_FILES}
     SELECT DISTINCT x.root AS root, s.type AS type, s.codec AS codec, s.profile AS profile, s.is_commentary AS commentary,
       json_extract(s.attrs, '$.width') AS width, json_extract(s.attrs, '$.height') AS height, json_extract(s.attrs, '$.hdr') AS hdr,
       json_extract(s.attrs, '$.hdrFallback') AS hdrFallback, json_extract(s.attrs, '$.attachedPic') AS attachedPic,
       json_extract(s.attrs, '$.channels') AS channels, json_extract(s.attrs, '$.lossless') AS lossless,
       json_extract(s.attrs, '$.objectAudio') AS objectAudio
     FROM files x JOIN media_stream s ON s.file_id = x.fileId WHERE s.type IN ('video', 'audio')`,
  );
  // Series of each episode (under a season or straight under the series) and of each season.
  const seriesTitles = prep(
    `SELECT i.id, CASE WHEN p.kind = 'series' THEN p.title ELSE g.title END AS seriesTitle
     FROM catalog_item i LEFT JOIN catalog_item p ON p.id = i.parent_id
       LEFT JOIN catalog_item g ON g.id = p.parent_id AND p.kind = 'season' AND g.kind = 'series'
     WHERE i.id IN (SELECT value FROM json_each(?)) AND i.kind IN ('episode', 'season')`,
  );
  const artworkOf = prep(
    `SELECT item_id AS itemId, type, local_path AS localPath, language, selected, fetched_at AS fetchedAt
     FROM artwork WHERE item_id IN (SELECT value FROM json_each(?))`,
  );
  const linkedFiles = prep(
    `SELECT f.id AS fileId, f.facts AS facts, ${FILE_AVAILABLE} AS available
     FROM media_link l JOIN media_file f ON f.id = l.file_id JOIN library_root r ON r.id = f.root_id
     WHERE l.item_id = ? ORDER BY f.created_at, f.id`,
  );
  const fileRow = prep(
    `SELECT f.id, f.size_bytes AS sizeBytes, f.container, f.duration_ms AS durationMs, f.bit_rate AS bitRate, f.facts, ${FILE_AVAILABLE} AS available
     FROM media_file f JOIN library_root r ON r.id = f.root_id WHERE f.id = ?`,
  );
  const streamsOf = prep(
    `SELECT stream_index AS "index", type, codec, profile, language, title, is_default AS isDefault, is_forced AS isForced,
       is_sdh AS isSdh, is_commentary AS isCommentary, attrs FROM media_stream WHERE file_id = ? ORDER BY stream_index`,
  );
  const chaptersOf = prep('SELECT title, start_ms AS startMs, end_ms AS endMs FROM chapter WHERE file_id = ? ORDER BY chapter_index');
  const childrenOf = (kind: 'season' | 'episode' | 'extra') =>
    prep(`SELECT ${COLS} FROM catalog_item i WHERE i.parent_id = ? AND i.kind = '${kind}' AND ${HAS_MEDIA} ORDER BY i.sort_title, i.id`);
  const seasonsOf = childrenOf('season');
  const episodesOf = childrenOf('episode');
  const extrasOf = childrenOf('extra');
  const descendants = prep(
    `SELECT e.id FROM catalog_item s JOIN catalog_item e ON e.parent_id = s.id
     WHERE s.parent_id = @id AND s.kind = 'season' AND e.kind = 'episode'
     UNION ALL SELECT e.id FROM catalog_item e WHERE e.parent_id = @id AND e.kind = 'episode'`,
  );
  const fieldsOf = prep('SELECT field, source, value, fetched_at AS fetchedAt FROM item_field WHERE item_id = ? AND field IN (\'overview\', \'genres\')');
  const locksOf = prep("SELECT field, source FROM field_lock WHERE item_id = ? AND field IN ('overview', 'genres')");
  const creditsOf = prep(
    `SELECT p.name, c.role, c.character FROM credit c JOIN person p ON p.id = c.person_id WHERE c.item_id = ?
     ORDER BY CASE c.role WHEN 'director' THEN 0 WHEN 'writer' THEN 1 WHEN 'actor' THEN 2 ELSE 3 END, c.sort_order, p.name`,
  );
  const externalIdsOf = prep('SELECT provider, external_id AS id FROM external_id WHERE item_id = ? ORDER BY provider');
  const sourcesOf = prep(
    `SELECT source FROM item_field WHERE item_id = @id AND (source <> 'tmdb' OR fetched_at >= @tmdbSince)
     UNION SELECT source FROM artwork WHERE item_id = @id UNION SELECT source FROM credit WHERE item_id = @id`,
  );

  const ps = (): ProfileStatePort | null => profileState();

  // ---------------------------------------------------------------- summaries

  function signalsByRoot(ids: readonly string[]): Map<string, Signals> {
    const out = new Map<string, Signals>();
    const rows = streamSignals.all({ ids: JSON.stringify(ids) }) as {
      root: string;
      type: string;
      codec: string | null;
      profile: string | null;
      commentary: number;
      width: number | null;
      height: number | null;
      hdr: string | null;
      hdrFallback: string | null;
      attachedPic: number | null;
      channels: number | null;
      lossless: number | null;
      objectAudio: string | null;
    }[];
    for (const r of rows) {
      const sig = out.get(r.root) ?? { video: [], audio: [] };
      out.set(r.root, sig);
      if (r.type === 'video' && r.attachedPic !== 1 && r.width && r.height) {
        const fallback = r.hdrFallback ? (JSON.parse(r.hdrFallback) as VideoSignal['hdrFallback']) : [];
        sig.video.push({ width: r.width, height: r.height, hdr: (r.hdr ?? 'SDR') as VideoSignal['hdr'], hdrFallback: fallback });
      } else if (r.type === 'audio') {
        sig.audio.push({
          codec: r.codec ?? '',
          profile: r.profile,
          channels: r.channels ?? 0,
          lossless: r.lossless === 1,
          objectAudio: (r.objectAudio as AudioSignal['objectAudio']) ?? null,
          commentary: r.commentary === 1,
          language: null,
        });
      }
    }
    return out;
  }

  function imagesByItem(ids: readonly string[]): Map<string, ImageRef[]> {
    const rows = artworkOf.all(JSON.stringify(ids)) as {
      itemId: string;
      type: ImageRef['type'];
      localPath: string;
      language: string | null;
      selected: number;
      fetchedAt: number;
    }[];
    rows.sort((a, b) => b.selected - a.selected || langRank(a.language) - langRank(b.language) || b.fetchedAt - a.fetchedAt);
    const out = new Map<string, ImageRef[]>();
    const taken = new Set<string>();
    for (const r of rows) {
      const key = imageKeyOf(r.localPath);
      if (!key || taken.has(`${r.itemId}\u0000${r.type}`)) continue;
      taken.add(`${r.itemId}\u0000${r.type}`);
      out.set(r.itemId, [...(out.get(r.itemId) ?? []), imageRef(r.type, key)]);
    }
    for (const list of out.values()) list.sort((a, b) => ARTWORK_ORDER.indexOf(a.type) - ARTWORK_ORDER.indexOf(b.type));
    return out;
  }

  function statesOf(profileId: string | null, ids: readonly string[]): Map<string, ProfileItemState> {
    const port = profileId ? ps() : null;
    if (!port || !profileId || !ids.length) return new Map();
    const out = new Map<string, ProfileItemState>();
    for (let i = 0; i < ids.length; i += STATE_CHUNK) {
      for (const [k, v] of port.getStates(profileId, ids.slice(i, i + STATE_CHUNK))) out.set(k, v);
    }
    return out;
  }

  /** Summaries of rows, in their order. With a profile and the port, each carries its state. */
  function summarize(rows: readonly ItemRow[], profileId: string | null): ItemSummary[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const avail = new Map(
      (availability.all({ ids: JSON.stringify(ids) }) as { root: string; available: number }[]).map((r) => [r.root, r.available === 1]),
    );
    const signals = signalsByRoot(ids);
    const images = imagesByItem(ids);
    const states = statesOf(profileId, ids);
    const series = rows.some((r) => r.kind === 'episode' || r.kind === 'season')
      ? new Map((seriesTitles.all(JSON.stringify(ids)) as { id: string; seriesTitle: string | null }[]).map((x) => [x.id, x.seriesTitle]))
      : new Map<string, string | null>();
    return rows.map((r) => {
      const state = states.get(r.id);
      return {
        id: r.id,
        kind: r.kind,
        category: r.category,
        title: r.title,
        originalTitle: r.originalTitle,
        year: r.year,
        seasonNumber: r.seasonNumber,
        episodeNumber: r.episodeNumber,
        ...(r.kind === 'episode' || r.kind === 'season' ? { seriesTitle: series.get(r.id) ?? null } : {}),
        extraType: r.extraType,
        editionLabel: r.editionLabel,
        durationMs: r.durationMs,
        images: images.get(r.id) ?? [],
        badges: badgesOf(signals.has(r.id) ? [signals.get(r.id)!] : []),
        available: avail.get(r.id) ?? false,
        ...(state ? { state } : {}),
      };
    });
  }

  function rowsByIds(ids: readonly string[]): ItemRow[] {
    const byId = new Map((itemsByIds.all(JSON.stringify(ids)) as ItemRow[]).map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is ItemRow => r !== undefined);
  }

  // ---------------------------------------------------------------- lists

  function list(q: ListQuery, profileId: string | null): Page {
    const sort = q.sort ?? 'title';
    const order = q.order ?? 'asc';
    const limit = q.limit ?? 50;
    const ordering = `items:${sort}:${order}`;
    const after = q.cursor ? decodeCursor(q.cursor, ordering) : null;
    const where: string[] = [HAS_MEDIA];
    const params: Record<string, unknown> = {};
    if (q.kind) {
      where.push('i.kind = @kind');
      params.kind = q.kind;
    } else if (q.continueWatching !== true) {
      // Browsing lists works; Continue watching lists what is played (movies, episodes, extras).
      where.push("i.kind IN ('movie', 'series')");
    }
    if (q.category) {
      where.push('i.category = @category');
      params.category = q.category;
    }
    if (q.year !== undefined) {
      where.push('i.year = @year');
      params.year = q.year;
    }
    const profileDependent = q.watched !== undefined || q.inWatchlist !== undefined || q.continueWatching !== undefined || sort === 'last_played';
    if (!profileDependent) {
      const key = KEY_SQL[sort];
      const dir = order === 'asc' ? 'ASC' : 'DESC';
      if (after) {
        where.push(`(${key}, i.id) ${order === 'asc' ? '>' : '<'} (@ck, @ci)`);
        params.ck = after.key;
        params.ci = after.id;
      }
      const rows = prep(`SELECT ${COLS}, ${key} AS k FROM catalog_item i WHERE ${where.join(' AND ')} ORDER BY k ${dir}, i.id ${dir} LIMIT @limit`).all({
        ...params,
        limit: limit + 1,
      }) as (ItemRow & { k: KeyValue })[];
      return page(rows, limit, ordering, profileId);
    }

    // Profile filters and last_played need the profile's state: filtered and ordered here, then the
    // same keyset on (key, id). Fine for a home library (thousands of items); see the report on scale.
    const port = profileId ? ps() : null;
    if (!port || !profileId) {
      // No profile state: nothing is watched, in the watchlist or in progress.
      if (q.watched === true || q.inWatchlist === true || q.continueWatching === true) return { items: [], nextCursor: null };
    }
    const key = sort === 'last_played' ? '0' : KEY_SQL[sort];
    let rows = prep(`SELECT ${COLS}, ${key} AS k FROM catalog_item i WHERE ${where.join(' AND ')}`).all(params) as (ItemRow & { k: KeyValue })[];
    if (port && profileId) {
      const cw = q.continueWatching !== undefined || sort === 'last_played' ? port.continueWatching(profileId, CONTINUE_WATCHING_MAX) : [];
      const cwSet = new Set(cw);
      if (q.watched !== undefined || q.inWatchlist !== undefined) {
        const states = statesOf(profileId, rows.map((r) => r.id));
        rows = rows.filter((r) => {
          const s = states.get(r.id);
          if (q.watched !== undefined && (s?.watched ?? false) !== q.watched) return false;
          if (q.inWatchlist !== undefined && (s?.inWatchlist ?? false) !== q.inWatchlist) return false;
          return true;
        });
      }
      if (q.continueWatching !== undefined) rows = rows.filter((r) => cwSet.has(r.id) === q.continueWatching);
      if (sort === 'last_played') {
        const played = port.lastPlayed?.(profileId, rows.map((r) => r.id)) ?? new Map(cw.map((id, i) => [id, cw.length - i]));
        for (const r of rows) r.k = played.get(r.id) ?? 0;
      }
    }
    const sign = order === 'asc' ? 1 : -1;
    rows.sort((a, b) => sign * compareKeys({ key: a.k, id: a.id }, { key: b.k, id: b.id }));
    if (after) rows = rows.filter((r) => sign * compareKeys({ key: r.k, id: r.id }, after) > 0);
    return page(rows.slice(0, limit + 1), limit, ordering, profileId);
  }

  function page(rows: (ItemRow & { k: KeyValue })[], limit: number, ordering: string, profileId: string | null): Page {
    const more = rows.length > limit;
    const shown = rows.slice(0, limit);
    const last = shown[shown.length - 1];
    return { items: summarize(shown, profileId), nextCursor: more && last ? encodeCursor(ordering, last.k, last.id) : null };
  }

  function search(q: string, kind: ItemKind | undefined, limit: number, profileId: string | null): Page {
    const match = ftsQuery(q);
    if (!match) return { items: [], nextCursor: null };
    const kindSql = kind ? 'i.kind = @kind' : "i.kind <> 'season'";
    const rows = prep(
      `SELECT ${COLS} FROM catalog_search JOIN catalog_item i ON i.id = catalog_search.item_id
       WHERE catalog_search MATCH @match AND ${kindSql} AND ${HAS_MEDIA}
       ORDER BY bm25(catalog_search), i.sort_title, i.id LIMIT @limit`,
    ).all({ match, limit, ...(kind ? { kind } : {}) }) as ItemRow[];
    if (rows.length && !needsSubstringSearch(q)) return { items: summarize(rows, profileId), nextCursor: null };
    // Scripts written without spaces (Japanese, Chinese) form one FTS token per title: a word in the
    // middle of it is found by substring, after the FTS hits. With no FTS hit at all, any script falls back.
    const needle = foldForContains(q.normalize('NFKC').trim());
    const all = prep(`SELECT ${COLS} FROM catalog_item i WHERE ${kindSql} AND ${HAS_MEDIA} ORDER BY i.sort_title, i.id`).all(kind ? { kind } : {}) as ItemRow[];
    const seen = new Set(rows.map((r) => r.id));
    const hits = all.filter(
      (r) => !seen.has(r.id) && (foldForContains(r.title).includes(needle) || (r.originalTitle !== null && foldForContains(r.originalTitle).includes(needle))),
    );
    return { items: summarize([...rows, ...hits].slice(0, limit), profileId), nextCursor: null };
  }

  function children(itemId: string, cursor: string | undefined, limit: number, profileId: string | null): Page | null {
    const item = itemById.get(itemId) as ItemRow | undefined;
    if (!item) return null;
    const ordering = 'children';
    const after = cursor ? decodeCursor(cursor, ordering) : null;
    const stmt = item.kind === 'series' ? seasonsOf : item.kind === 'season' ? episodesOf : null;
    if (!stmt) return { items: [], nextCursor: null };
    let rows = (stmt.all(itemId) as ItemRow[]).map((r) => ({ ...r, k: r.sortTitle }));
    if (after) rows = rows.filter((r) => compareKeys({ key: r.k, id: r.id }, after) > 0);
    return page(rows.slice(0, limit + 1), limit, ordering, profileId);
  }

  function episodeIds(itemId: string): string[] {
    const item = itemById.get(itemId) as ItemRow | undefined;
    if (!item || (item.kind !== 'series' && item.kind !== 'season')) return [];
    const ids = (descendants.all({ id: itemId }) as { id: string }[]).map((r) => r.id);
    const rows = rowsByIds(ids);
    rows.sort((a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0) || (a.id < b.id ? -1 : 1));
    return rows.map((r) => r.id);
  }

  /** Episodes of a series/season that have at least one linked file, in viewing order. */
  function playableEpisodeIds(itemId: string): string[] {
    const ids = episodeIds(itemId);
    if (!ids.length) return ids;
    const linked = new Set(
      (prep('SELECT DISTINCT item_id AS id FROM media_link WHERE item_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as { id: string }[]).map(
        (r) => r.id,
      ),
    );
    return ids.filter((id) => linked.has(id));
  }

  function nextUp(seriesId: string, profileId: string | null): { item: ItemSummary | null } | null {
    const item = itemById.get(seriesId) as ItemRow | undefined;
    if (!item) return null;
    if (item.kind !== 'series') return { item: null };
    const port = profileId ? ps() : null;
    let next: string | null;
    if (port && profileId) {
      next = port.nextUp(profileId, seriesId);
    } else {
      // Without profile state nothing is watched: the first regular episode (specials last) with media.
      const linked = new Set(
        (prep('SELECT DISTINCT item_id AS id FROM media_link WHERE item_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(episodeIds(seriesId))) as { id: string }[]).map(
          (r) => r.id,
        ),
      );
      const ordered = rowsByIds(episodeIds(seriesId)).filter((r) => linked.has(r.id));
      next = (ordered.find((r) => r.seasonNumber !== 0) ?? ordered[0])?.id ?? null;
    }
    const row = next ? rowsByIds([next])[0] : undefined;
    return { item: row ? (summarize([row], profileId)[0] ?? null) : null };
  }

  const seriesWithMedia = prep(`SELECT i.id FROM catalog_item i WHERE i.kind = 'series' AND ${HAS_MEDIA}`).pluck();

  /**
   * Home "next up" (doc 01 §7.2, D3): for each series the profile played, most recently played first,
   * the episode GetNextUp answers, unless it is in progress (Continue watching already shows it).
   */
  function nextUpRow(profileId: string, limit: number): ItemSummary[] {
    const port = ps();
    if (!port?.lastPlayed) return [];
    const played = port.lastPlayed(profileId, seriesWithMedia.all() as string[]);
    const ordered = [...played].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
    const inProgress = new Set(ordered.length ? port.continueWatching(profileId, CONTINUE_WATCHING_MAX) : []);
    const ids: string[] = [];
    for (const seriesId of ordered) {
      if (ids.length >= limit) break;
      const next = port.nextUp(profileId, seriesId);
      if (next && !inProgress.has(next) && !ids.includes(next)) ids.push(next);
    }
    return summarize(rowsByIds(ids), profileId);
  }

  // ---------------------------------------------------------------- detail

  function mediaVersion(fileId: string): MediaVersion | null {
    const f = fileRow.get(fileId) as
      | { id: string; sizeBytes: number; container: string | null; durationMs: number | null; bitRate: number | null; facts: string | null; available: number }
      | undefined;
    if (!f) return null;
    const facts = f.facts ? (JSON.parse(f.facts) as MediaFacts) : null;
    const tracks = (streamsOf.all(fileId) as StreamRow[]).map(trackOf).filter((t): t is Track => t !== null);
    return {
      fileId: f.id,
      label: facts ? versionLabel(facts) : (f.container ?? 'Non ancora analizzato'),
      available: f.available === 1,
      container: f.container,
      durationMs: f.durationMs,
      sizeBytes: f.sizeBytes,
      bitRate: f.bitRate,
      tracks: [...tracks, ...sidecarTracks(facts)],
      chapters: chaptersOf.all(fileId) as Chapter[],
    };
  }

  function detailField(itemId: string, field: 'overview' | 'genres'): unknown {
    const rows = (fieldsOf.all(itemId) as { field: string; source: FieldSource; value: string; fetchedAt: number }[]).map(
      (r): FieldRow => ({ field: r.field, source: r.source, value: JSON.parse(r.value) as unknown, fetchedAt: r.fetchedAt }),
    );
    const lock = (locksOf.all(itemId) as { field: string; source: FieldSource }[]).find((l) => l.field === field)?.source ?? null;
    return resolveField(field, rows, lock, now(), tmdbMaxAgeMs)?.value ?? null;
  }

  function genresOf(v: unknown): string[] {
    if (Array.isArray(v)) return v.filter((g): g is string => typeof g === 'string' && g.trim() !== '');
    if (typeof v === 'string') return v.split(',').map((g) => g.trim()).filter(Boolean);
    return [];
  }

  function detail(itemId: string, profileId: string | null): ItemDetail | null {
    const item = itemById.get(itemId) as ItemRow | undefined;
    if (!item) return null;
    const [summary] = summarize([item], profileId);
    const parent = item.parentId ? rowsByIds([item.parentId])[0] : undefined;
    const kids = item.kind === 'series' ? (seasonsOf.all(itemId) as ItemRow[]) : item.kind === 'season' ? (episodesOf.all(itemId) as ItemRow[]) : [];
    const playable = item.kind === 'movie' || item.kind === 'episode' || item.kind === 'extra';
    const versions = playable
      ? (linkedFiles.all(itemId) as { fileId: string }[]).map((f) => mediaVersion(f.fileId)).filter((v): v is MediaVersion => v !== null)
      : [];
    const overview = detailField(itemId, 'overview');
    const sources = new Set((sourcesOf.all({ id: itemId, tmdbSince: now() - tmdbMaxAgeMs }) as { source: string }[]).map((r) => r.source));
    return {
      ...summary!,
      overview: typeof overview === 'string' && overview.trim() ? overview : null,
      genres: genresOf(detailField(itemId, 'genres')),
      credits: creditsOf.all(itemId) as ApiSchemas['Credit'][],
      parent: parent ? (summarize([parent], profileId)[0] ?? null) : null,
      children: summarize(kids, profileId),
      extras: summarize(extrasOf.all(itemId) as ItemRow[], profileId),
      versions,
      externalIds: Object.fromEntries((externalIdsOf.all(itemId) as { provider: string; id: string }[]).map((r) => [r.provider, r.id])),
      attributions: [...(sources.has('tmdb') ? [TMDB_NOTICE] : []), ...(sources.has('wikidata') ? [WIKIDATA_NOTICE] : [])],
    };
  }

  // ---------------------------------------------------------------- port for playback

  const port: CatalogReadPort = {
    getPlayableItem(itemId: string): PlayableItem | null {
      const item = itemById.get(itemId) as ItemRow | undefined;
      if (!item) return null;
      const playable = item.kind === 'movie' || item.kind === 'episode' || item.kind === 'extra';
      const files = playable
        ? (linkedFiles.all(itemId) as { fileId: string; facts: string | null; available: number }[])
            .filter((f) => f.facts !== null)
            .map((f) => ({ fileId: f.fileId, available: f.available === 1, facts: JSON.parse(f.facts!) as MediaFacts }))
        : [];
      return { itemId: item.id, kind: item.kind, title: item.title, durationMs: item.durationMs, files };
    },
    listPlayableDescendants: playableEpisodeIds,
    itemExists: (itemId) => itemById.get(itemId) !== undefined,
    describeItems(itemIds) {
      const out = new Map<string, CatalogItemPosition>();
      const ids = [...new Set(itemIds)];
      for (let i = 0; i < ids.length; i += DESCRIBE_CHUNK) {
        for (const r of positionsOf.all(JSON.stringify(ids.slice(i, i + DESCRIBE_CHUNK))) as CatalogItemPosition[]) out.set(r.id, r);
      }
      return out;
    },
  };

  return {
    port,
    list,
    search,
    children,
    nextUp,
    nextUpRow,
    detail,
    mediaVersion,
    summaries: (ids: readonly string[], profileId: string | null = null) => summarize(rowsByIds(ids), profileId),
    profileStateAvailable: () => ps() !== null,
  };
}

export type CatalogReader = ReturnType<typeof createCatalogReader>;
