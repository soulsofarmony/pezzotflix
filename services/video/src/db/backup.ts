// Database backups (ADR 0002 point 10): online copies with db.backup(), written under a temporary name
// and renamed once complete. Daily copies are checked with integrity_check and kept 7 daily + 4
// weekly; pre-migration copies are kept 3. Restore: stop the service, copy one file over
// /data/db/video.db, delete video.db-wal and video.db-shm, start again.
import type Database from 'better-sqlite3';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const DAY_MS = 24 * 3600_000;

export const DAILY_KEEP = 7;
export const WEEKLY_KEEP = 4;
export const PRE_MIGRATE_KEEP = 3;
/** A daily backup is due when the newest one is older than this. */
export const BACKUP_EVERY_MS = DAY_MS;

const DAILY_PREFIX = 'video-';
const PRE_MIGRATE_PREFIX = 'pre-migrate-';
const TMP = '.tmp';

/** UTC stamp of a backup file name: 20261106T031500123Z (sortable, readable when restoring). */
export const stampOf = (t: number): string => new Date(t).toISOString().replace(/[-:.]/g, '');

/** Time of a backup from its name: the stamp above, or the epoch milliseconds older pre-migration copies used. */
export function timeOfName(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix) || !name.endsWith('.db')) return null;
  const s = name.slice(prefix.length, -'.db'.length);
  if (/^\d{13}$/.test(s)) return Number(s);
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(s);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!) : null;
}

interface Copy {
  name: string;
  at: number;
}

const readdirSafe = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

function listCopies(dir: string, prefix: string): Copy[] {
  return readdirSafe(dir)
    .map((name) => ({ name, at: timeOfName(name, prefix) }))
    .filter((c): c is Copy => c.at !== null)
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
}

const dayOf = (t: number): number => Math.floor(t / DAY_MS);
// 1970-01-01 was a Thursday: +3 makes weeks start on Monday (UTC).
const weekOf = (t: number): number => Math.floor((dayOf(t) + 3) / 7);

/**
 * Times to keep: the newest copy of each of the 7 most recent days that have one, and of each of the
 * 4 most recent weeks. Counted on days with a copy, not calendar days, so downtime never empties it.
 */
export function backupsToKeep(times: readonly number[], daily = DAILY_KEEP, weekly = WEEKLY_KEEP): Set<number> {
  const keep = new Set<number>();
  const pick = (bucket: (t: number) => number, n: number) => {
    const seen = new Set<number>();
    for (const t of [...times].sort((a, b) => b - a)) {
      const k = bucket(t);
      if (seen.has(k)) continue;
      if (seen.size === n) break;
      seen.add(k);
      keep.add(t);
    }
  };
  pick(dayOf, daily);
  pick(weekOf, weekly);
  return keep;
}

/** Leftovers of an interrupted backup: a crash between backup() and rename. */
function removeTemporary(dir: string): void {
  for (const name of readdirSafe(dir)) {
    if ((name.startsWith(DAILY_PREFIX) || name.startsWith(PRE_MIGRATE_PREFIX)) && name.includes(`.db${TMP}`)) rmSync(join(dir, name), { force: true });
  }
}

/**
 * Copies dated more than this after now come from a clock that was ahead, or now is behind (a reset
 * clock). Either way they are neither counted nor deleted: once the time reaches them they count.
 */
const FUTURE_TOLERANCE_MS = 3600_000;
const notFuture = (now: number) => (c: Copy) => c.at <= now + FUTURE_TOLERANCE_MS;

/** Deletes the daily copies the retention does not keep; returns their names. */
export function pruneDaily(dir: string, now: number): string[] {
  const copies = listCopies(dir, DAILY_PREFIX).filter(notFuture(now));
  const keep = backupsToKeep(copies.map((c) => c.at));
  // Two copies with the same time (same millisecond): only the first name is kept.
  const kept = new Set<number>();
  const removed: string[] = [];
  for (const c of copies) {
    if (keep.has(c.at) && !kept.has(c.at)) {
      kept.add(c.at);
      continue;
    }
    rmSync(join(dir, c.name), { force: true });
    removed.push(c.name);
  }
  return removed;
}

/** Deletes all but the newest PRE_MIGRATE_KEEP pre-migration copies; returns their names. */
export function prunePreMigrate(dir: string, keep = PRE_MIGRATE_KEEP): string[] {
  const old = listCopies(dir, PRE_MIGRATE_PREFIX).slice(keep);
  for (const c of old) rmSync(join(dir, c.name), { force: true });
  return old.map((c) => c.name);
}

/** Time of the newest daily copy not dated in the future, or null. */
export const lastDailyBackupAt = (dir: string, now: number): number | null => listCopies(dir, DAILY_PREFIX).find(notFuture(now))?.at ?? null;

/** Problems integrity_check reports on a database file ([] = ok), run in a worker thread. */
export function checkBackup(path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./integrity-worker.ts', import.meta.url), { workerData: { path } });
    let answered = false;
    worker.once('message', (problems: string[]) => {
      answered = true;
      resolve(problems);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!answered) reject(new Error(`integrity check worker exited with code ${code}`));
    });
  });
}

export class BackupCheckError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`backup failed the integrity check: ${problems.slice(0, 3).join('; ')}`);
    this.name = 'BackupCheckError';
    this.problems = problems;
  }
}

async function copyTo(sqlite: Database.Database, dir: string, name: string, check: ((path: string) => Promise<string[]>) | null): Promise<string> {
  mkdirSync(dir, { recursive: true });
  removeTemporary(dir);
  const final = join(dir, name);
  const tmp = `${final}${TMP}`;
  try {
    await sqlite.backup(tmp);
    if (check) {
      const problems = await check(tmp);
      if (problems.length) throw new BackupCheckError(problems);
    }
    renameSync(tmp, final);
  } finally {
    for (const leftover of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) rmSync(leftover, { force: true });
  }
  return final;
}

/**
 * The daily backup: a checked copy in dir, then the retention. A copy that fails integrity_check is
 * deleted and BackupCheckError thrown. Returns the path of the new copy.
 */
export async function backupDatabase(
  sqlite: Database.Database,
  opts: { dir: string; now: number; check?: (path: string) => Promise<string[]> },
): Promise<{ file: string; pruned: string[] }> {
  const file = await copyTo(sqlite, opts.dir, `${DAILY_PREFIX}${stampOf(opts.now)}.db`, opts.check ?? checkBackup);
  return { file, pruned: pruneDaily(opts.dir, opts.now) };
}

/** The copy taken before pending migrations run; the last PRE_MIGRATE_KEEP are kept. */
export async function preMigrationBackup(sqlite: Database.Database, dir: string, now: number): Promise<string> {
  const file = await copyTo(sqlite, dir, `${PRE_MIGRATE_PREFIX}${stampOf(now)}.db`, null);
  prunePreMigrate(dir);
  return file;
}
