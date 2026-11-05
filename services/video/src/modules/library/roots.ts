// Library roots from config.LIBRARY_ROOTS (doc 01 §4.1). Roots are never deleted: that would
// cascade to files, links and progress.
import { resolve, sep } from 'node:path';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { LibraryRootSpec } from '../../app/config.ts';
import type { Db } from '../../db/index.ts';
import { libraryRoot, mediaFile } from '../../db/schema/index.ts';
import { newId } from '../../shared/ids.ts';
import { fold } from './rules.ts';

export type RootRow = typeof libraryRoot.$inferSelect;

export interface SkippedRoot {
  spec: LibraryRootSpec;
  reason: 'duplicate_name' | 'duplicate_path' | 'nested';
  /** Name of the earlier root it clashes with (the first one wins). */
  clashesWith: string;
}

export interface RootSync {
  /** Configured roots in config order. */
  roots: RootRow[];
  skipped: SkippedRoot[];
}

/** "/media/Film/" and "/media/Film" are one root; "/" and "C:\" stay as they are. */
function trimTrailingSep(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  return t === '' || /^[a-zA-Z]:$/.test(t) ? p : t;
}

// Comparison only: resolved, and case-insensitive where the file system is (Windows dev host).
const pathKey = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const isInside = (parent: string, child: string): boolean => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Root specs usable together: unique names, unique paths, no root inside another. */
export function validateRoots(specs: readonly LibraryRootSpec[]): { accepted: LibraryRootSpec[]; skipped: SkippedRoot[] } {
  const accepted: { spec: LibraryRootSpec; key: string }[] = [];
  const skipped: SkippedRoot[] = [];
  for (const raw of specs) {
    const spec = { ...raw, path: trimTrailingSep(raw.path) };
    const key = pathKey(spec.path);
    const byName = accepted.find((a) => fold(a.spec.name) === fold(spec.name));
    const byPath = accepted.find((a) => a.key === key);
    const nested = accepted.find((a) => isInside(a.key, key) || isInside(key, a.key));
    const clash = byName ?? byPath ?? nested;
    if (clash) {
      const reason = byName ? 'duplicate_name' : byPath ? 'duplicate_path' : 'nested';
      skipped.push({ spec: raw, reason, clashesWith: clash.spec.name });
    } else {
      accepted.push({ spec, key });
    }
  }
  return { accepted: accepted.map((a) => a.spec), skipped };
}

/**
 * Upserts the configured roots by mount path. A root whose mount path changed but whose name did
 * not keeps its row, so moving the library elsewhere keeps its files. A renamed root renames the
 * location of its files' facts too. Roots no longer configured (or skipped) go offline.
 */
export function syncRoots(db: Db, specs: readonly LibraryRootSpec[], now: number): RootSync {
  const { accepted, skipped } = validateRoots(specs);
  return db.transaction((tx) => {
    const rows = tx.select().from(libraryRoot).all();
    const configuredPaths = new Set(accepted.map((s) => s.path));
    const claimed = new Set<string>();
    const roots: RootRow[] = [];
    for (const spec of accepted) {
      const row =
        rows.find((r) => r.mountPath === spec.path && !claimed.has(r.id)) ??
        rows.find((r) => r.name === spec.name && !configuredPaths.has(r.mountPath) && !claimed.has(r.id));
      if (row) {
        claimed.add(row.id);
        if (row.name !== spec.name || row.hint !== spec.hint || row.mountPath !== spec.path) {
          tx.update(libraryRoot)
            .set({ name: spec.name, hint: spec.hint, mountPath: spec.path })
            .where(eq(libraryRoot.id, row.id))
            .run();
        }
        if (row.name !== spec.name) {
          // Playback and delivery address a file by (rootName, relPath) from its facts.
          tx.update(mediaFile)
            .set({ facts: sql`json_set(${mediaFile.facts}, '$.location.rootName', ${spec.name})` })
            .where(and(eq(mediaFile.rootId, row.id), isNotNull(mediaFile.facts)))
            .run();
        }
        roots.push({ ...row, name: spec.name, hint: spec.hint, mountPath: spec.path });
      } else {
        const created: RootRow = {
          id: newId(),
          name: spec.name,
          mountPath: spec.path,
          hint: spec.hint,
          status: 'online',
          lastScanAt: null,
          createdAt: now,
        };
        tx.insert(libraryRoot).values(created).run();
        roots.push(created);
      }
    }
    for (const r of rows) {
      if (!claimed.has(r.id) && r.status !== 'offline') {
        tx.update(libraryRoot).set({ status: 'offline' }).where(eq(libraryRoot.id, r.id)).run();
      }
    }
    return { roots, skipped };
  });
}
