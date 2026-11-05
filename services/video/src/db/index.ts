// SQLite connection (ADR 0002): one connection, WAL, migrations applied at startup after a backup.
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema/index.ts';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export interface OpenDbOptions {
  path: string; // ':memory:' for tests
  backupDir?: string;
}

export async function openDb({ path, backupDir }: OpenDbOptions): Promise<Db> {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const existed = path !== ':memory:' && existsSync(path);
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db: Db = drizzle({ client: sqlite, schema });
  if (existed && backupDir) {
    mkdirSync(backupDir, { recursive: true });
    await sqlite.backup(join(backupDir, `pre-migrate-${Date.now()}.db`));
  }
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export function closeDb(db: Db): void {
  try {
    db.$client.pragma('optimize');
  } finally {
    db.$client.close();
  }
}

export { schema };
