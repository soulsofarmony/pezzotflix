// ListMediaFiles (doc 03 §6): the missing files with the items they are linked to, newest missing first, for
// the "File mancanti" page. Forgetting them belongs to the library (LibraryControlPort), which owns file states.
import { notFound, ProblemError } from '../../app/problem.ts';
import type { Db } from '../../db/index.ts';
import type { ApiSchemas, CatalogViewPort } from '../../shared/ports.ts';

type Entry = ApiSchemas['MediaFileEntry'];
type FileItem = ApiSchemas['FileItem'];

interface FileRow {
  fileId: string;
  rootId: string;
  rootName: string;
  relPath: string;
  state: string;
  sizeBytes: number;
  missingSince: number | null;
  /** Negated time the file went missing: the first key of the ascending keyset. */
  k: number;
}

/**
 * When a file went missing; a row without missing_since counts from its last change. A copy of library/removal.ts
 * MISSING_AT, which decides when a file ages into removal (modules do not import each other): change the two together.
 */
const MISSING_AT = 'coalesce(f.missing_since, f.updated_at)';

const ordering = (state: string, rootId: string | undefined) => `files:${state}:${rootId ?? ''}`;

const encodeFilesCursor = (o: string, last: Pick<FileRow, 'k' | 'relPath' | 'fileId'>): string =>
  Buffer.from(JSON.stringify({ o, k: last.k, p: last.relPath, i: last.fileId })).toString('base64url');

function decodeFilesCursor(cursor: string, o: string): { k: number; p: string; i: string } {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown; k?: unknown; p?: unknown; i?: unknown };
    if (c.o === o && typeof c.k === 'number' && typeof c.p === 'string' && typeof c.i === 'string') return { k: c.k, p: c.p, i: c.i };
  } catch {
    // falls through
  }
  throw new ProblemError('VALIDATION_FAILED', 'invalid cursor');
}

export function createFileList(deps: { db: Db; views: () => CatalogViewPort }) {
  const prep = deps.db.$client.prepare.bind(deps.db.$client);
  const rootExists = prep('SELECT 1 FROM library_root WHERE id = ?');
  const linksOf = prep('SELECT file_id AS fileId, item_id AS itemId FROM media_link WHERE file_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id');
  // The page and the count, one prepared statement per variant (with or without rootId, first page or not).
  const statements = new Map<string, ReturnType<typeof prep>>();
  const cached = (sql: string): ReturnType<typeof prep> => {
    let s = statements.get(sql);
    if (!s) statements.set(sql, (s = prep(sql)));
    return s;
  };

  function itemsByFile(fileIds: readonly string[]): Map<string, FileItem[]> {
    const links = linksOf.all(JSON.stringify(fileIds)) as { fileId: string; itemId: string }[];
    const summaries = new Map(deps.views().summaries([...new Set(links.map((l) => l.itemId))]).map((s) => [s.id, s]));
    const out = new Map<string, FileItem[]>();
    for (const l of links) {
      const s = summaries.get(l.itemId);
      if (!s) continue;
      const item: FileItem = {
        id: s.id,
        kind: s.kind,
        title: s.title,
        year: s.year ?? null,
        seriesTitle: s.seriesTitle ?? null,
        seasonNumber: s.seasonNumber ?? null,
        episodeNumber: s.episodeNumber ?? null,
      };
      out.set(l.fileId, [...(out.get(l.fileId) ?? []), item]);
    }
    return out;
  }

  /** One page of the files in `state`, newest missing first, then by path; total counts every page. */
  function list(q: { state: 'missing'; rootId?: string; cursor?: string; limit?: number }): { files: Entry[]; nextCursor: string | null; total: number } {
    if (q.rootId !== undefined && !rootExists.get(q.rootId)) throw notFound('Library root');
    const limit = q.limit ?? 50;
    const o = ordering(q.state, q.rootId);
    const after = q.cursor ? decodeFilesCursor(q.cursor, o) : null;
    const filter = `f.state = @state ${q.rootId !== undefined ? 'AND f.root_id = @rootId' : ''}`;
    const params = { state: q.state, ...(q.rootId !== undefined ? { rootId: q.rootId } : {}) };
    const rows = cached(
      `SELECT f.id AS fileId, f.root_id AS rootId, r.name AS rootName, f.rel_path AS relPath, f.state, f.size_bytes AS sizeBytes,
         f.missing_since AS missingSince, -${MISSING_AT} AS k
       FROM media_file f JOIN library_root r ON r.id = f.root_id
       WHERE ${filter} ${after ? `AND (-${MISSING_AT}, f.rel_path, f.id) > (@k, @p, @i)` : ''}
       ORDER BY k, f.rel_path, f.id LIMIT @limit`,
    ).all({ ...params, limit: limit + 1, ...(after ?? {}) }) as FileRow[];
    const total = (cached(`SELECT count(*) AS n FROM media_file f WHERE ${filter}`).get(params) as { n: number }).n;
    const shown = rows.slice(0, limit);
    const items = itemsByFile(shown.map((r) => r.fileId));
    const last = shown[shown.length - 1];
    return {
      files: shown.map((r) => ({
        fileId: r.fileId,
        rootId: r.rootId,
        rootName: r.rootName,
        relPath: r.relPath,
        state: r.state,
        sizeBytes: r.sizeBytes,
        missingSince: r.missingSince,
        items: items.get(r.fileId) ?? [],
      })),
      nextCursor: rows.length > limit && last ? encodeFilesCursor(o, last) : null,
      total,
    };
  }

  return { list };
}
