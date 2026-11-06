// SQLite connection (ADR 0002): one connection, WAL, migrations applied at startup after a backup.
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preMigrationBackup, prunePreMigrate } from './backup.ts';
import * as schema from './schema/index.ts';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** What openDb reports (a pino logger fits). */
export interface DbLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface OpenDbOptions {
  path: string; // ':memory:' for tests
  /** Where the pre-migration copy goes when a migration is pending. */
  backupDir?: string;
  /** Tests only: another migrations folder. */
  migrationsFolder?: string;
  log?: DbLog;
}

interface ForeignKeyViolation {
  table: string;
  rowid: number;
  parent: string;
}

const countByTable = (violations: readonly ForeignKeyViolation[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const v of violations) counts.set(v.table, (counts.get(v.table) ?? 0) + 1);
  return counts;
};

/** Migrations of the folder not applied yet: the ones newer than the last row of __drizzle_migrations (drizzle's rule). */
export function pendingMigrations(sqlite: Database.Database, migrationsFolder = MIGRATIONS_DIR): number {
  const migrations = readMigrationFiles({ migrationsFolder });
  const table = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
  const last = table
    ? (sqlite.prepare('SELECT created_at AS at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as { at: number | string } | undefined)
    : undefined;
  return last ? migrations.filter((m) => m.folderMillis > Number(last.at)).length : migrations.length;
}

export async function openDb({ path, backupDir, migrationsFolder = MIGRATIONS_DIR, log }: OpenDbOptions): Promise<Db> {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const existed = path !== ':memory:' && existsSync(path);
  const sqlite = new Database(path);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('busy_timeout = 5000');
    // Drizzle applies pending migrations in one transaction, where PRAGMA foreign_keys is a no-op: a
    // drizzle-kit table rebuild (CREATE __new_x, INSERT, DROP x, RENAME) would cascade and delete the
    // child rows (progress, watch state, links). Keys are off while migrating, then checked.
    sqlite.pragma('foreign_keys = OFF');
    const db: Db = drizzle({ client: sqlite, schema });
    const pending = pendingMigrations(sqlite, migrationsFolder); // all of them for a new database
    if (existed && pending > 0 && backupDir) {
      const file = await preMigrationBackup(sqlite, backupDir, Date.now());
      log?.info({ file, pending }, 'database copied before its migrations');
    } else if (backupDir) {
      prunePreMigrate(backupDir); // copies from older versions, which took one at every start
    }
    const fkCheck = () => sqlite.pragma('foreign_key_check') as ForeignKeyViolation[];
    // Orphans from before (a row written while keys were off) are a baseline, per table: only what
    // the migrations of this start add is refused, since they may have broken the data and the copy
    // taken before them is the way back. Old orphans alone never stop the service, or its upgrades.
    const baseline = pending > 0 ? countByTable(fkCheck()) : new Map<string, number>();
    migrate(db, { migrationsFolder });
    const violations = fkCheck();
    if (violations.length) {
      const after = countByTable(violations);
      const added = [...after].filter(([table, n]) => n > (baseline.get(table) ?? 0)).map(([table]) => table);
      if (pending > 0 && added.length) {
        const first = violations.find((v) => added.includes(v.table))!;
        throw new Error(
          `the migrations left foreign key violation(s) in ${added.join(', ')} (first: ${first.table} row ${first.rowid} → ${first.parent}); ` +
            `restore the pre-migration copy${backupDir ? ` in ${backupDir}` : ''}`,
        );
      }
      const tables = [...after.keys()];
      log?.warn({ violations: violations.length, tables, first: violations[0] }, 'the database has rows whose parent is missing (foreign key check)');
    }
    sqlite.pragma('foreign_keys = ON');
    return db;
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

export function closeDb(db: Db): void {
  try {
    db.$client.pragma('optimize');
  } finally {
    db.$client.close();
  }
}

export { schema };
