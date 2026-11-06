// Migrations and backups (ADR 0002 points 2 and 10) on temporary database files: the pre-migration
// copy only when a migration is pending, a drizzle-kit table rebuild that keeps the child rows, the
// daily checked copy and its retention.
import Database from 'better-sqlite3';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BackupCheckError,
  backupDatabase,
  backupsToKeep,
  checkBackup,
  lastDailyBackupAt,
  PRE_MIGRATE_KEEP,
  stampOf,
  timeOfName,
} from '../src/db/backup.ts';
import { closeDb, openDb, pendingMigrations } from '../src/db/index.ts';
import { backupDue, backupTask } from '../src/modules/system/index.ts';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 10, 6, 3, 0, 0); // a Friday

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pzf-db-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const names = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** A copy of the real migrations, to add test migrations to. */
function copyMigrations(): string {
  const dir = join(tempDir(), 'migrations');
  cpSync(MIGRATIONS, dir, { recursive: true });
  return dir;
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** Appends a migration to a copied folder, as drizzle-kit would (journal entry, statement breakpoints). */
function addMigration(dir: string, tag: string, statements: string[]): void {
  writeFileSync(join(dir, `${tag}.sql`), statements.join('--> statement-breakpoint\n'));
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
  const last = journal.entries[journal.entries.length - 1]!.when;
  journal.entries.push({ idx: journal.entries.length, version: '6', when: last + 1, tag, breakpoints: true });
  writeFileSync(journalPath, JSON.stringify(journal));
}

/** What drizzle-kit generates for most column changes on SQLite: a rebuild of the table. */
const PROFILE_REBUILD = [
  'PRAGMA foreign_keys=OFF;',
  'CREATE TABLE `__new_profile` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `avatar` text, `prefs` text NOT NULL, `color` text, `created_at` integer NOT NULL);',
  'INSERT INTO `__new_profile`("id", "name", "avatar", "prefs", "created_at") SELECT "id", "name", "avatar", "prefs", "created_at" FROM `profile`;',
  'DROP TABLE `profile`;',
  'ALTER TABLE `__new_profile` RENAME TO `profile`;',
  'PRAGMA foreign_keys=ON;',
];

describe('migrations', () => {
  it('copies the database before pending migrations only, and keeps the last 3 copies', async () => {
    const base = tempDir();
    const path = join(base, 'db', 'video.db');
    const backupDir = join(base, 'backup');
    const migrations = copyMigrations();
    closeDb(await openDb({ path, backupDir, migrationsFolder: migrations })); // a new database: nothing to copy
    for (let i = 0; i < 3; i++) closeDb(await openDb({ path, backupDir, migrationsFolder: migrations })); // restarts
    expect(names(backupDir)).toEqual([]);

    // Upgrades: one copy each, taken before the migration, never more than 3 kept.
    mkdirSync(backupDir);
    writeFileSync(join(backupDir, 'pre-migrate-1700000000000.db'), 'a copy named the older way');
    for (let i = 0; i < 4; i++) {
      addMigration(migrations, `900${i}_upgrade`, [`CREATE TABLE \`upgrade_${i}\` (\`id\` integer PRIMARY KEY);`]);
      const sqlite = new Database(path);
      expect(pendingMigrations(sqlite, migrations)).toBe(1);
      sqlite.close();
      closeDb(await openDb({ path, backupDir, migrationsFolder: migrations }));
      await new Promise((r) => setTimeout(r, 5)); // distinct stamps
    }
    const copies = names(backupDir);
    expect(copies).toHaveLength(PRE_MIGRATE_KEEP);
    expect(copies.every((n) => /^pre-migrate-\d{8}T\d{9}Z\.db$/.test(n))).toBe(true);
    // The newest copy is the database as it was before the last upgrade.
    const newest = new Database(join(backupDir, copies[copies.length - 1]!), { readonly: true });
    const tables = newest.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'upgrade_%' ORDER BY name").pluck().all();
    newest.close();
    expect(tables).toEqual(['upgrade_0', 'upgrade_1', 'upgrade_2']);
  });

  it('a table rebuild keeps the child rows (foreign keys off while migrating, checked after)', async () => {
    const base = tempDir();
    const path = join(base, 'video.db');
    const db = await openDb({ path });
    const t = Date.now();
    db.$client.prepare("INSERT INTO profile (id, name, prefs, created_at) VALUES ('p1', 'Simone', '{}', ?)").run(t);
    db.$client.prepare("INSERT INTO catalog_item (id, kind, title, sort_title, added_at, updated_at) VALUES ('i1', 'movie', 'Dune', 'dune', ?, ?)").run(t, t);
    db.$client
      .prepare("INSERT INTO playback_progress (profile_id, item_id, position_ms, duration_ms, client_ts, updated_at) VALUES ('p1', 'i1', 3600000, 9000000, ?, ?)")
      .run(t, t);
    db.$client.prepare("INSERT INTO watchlist_entry (profile_id, item_id, added_at) VALUES ('p1', 'i1', ?)").run(t);
    closeDb(db);

    const migrations = copyMigrations();
    addMigration(migrations, '9000_profile_rebuild', PROFILE_REBUILD);
    const upgraded = await openDb({ path, backupDir: join(base, 'backup'), migrationsFolder: migrations });
    cleanup.push(() => closeDb(upgraded));
    const count = (table: string) => (upgraded.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([count('profile'), count('playback_progress'), count('watchlist_entry')]).toEqual([1, 1, 1]);
    expect(upgraded.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(names(join(base, 'backup'))).toHaveLength(1);
  });

  it('refuses to start when the migrations leave a foreign key violation', async () => {
    const base = tempDir();
    const path = join(base, 'video.db');
    closeDb(await openDb({ path }));
    const migrations = copyMigrations();
    // A broken migration: progress of a profile that does not exist.
    addMigration(migrations, '9000_broken', [
      "INSERT INTO catalog_item (id, kind, title, sort_title, added_at, updated_at) VALUES ('i1', 'movie', 'X', 'x', 0, 0);",
      "INSERT INTO playback_progress (profile_id, item_id, position_ms, duration_ms, client_ts, updated_at) VALUES ('ghost', 'i1', 1, 2, 0, 0);",
    ]);
    await expect(openDb({ path, backupDir: join(base, 'backup'), migrationsFolder: migrations })).rejects.toThrow(/foreign key violation.*playback_progress/);
  });

  it('an orphan row from before (no migration in this start) is a warning, not a refusal', async () => {
    const base = tempDir();
    const path = join(base, 'video.db');
    closeDb(await openDb({ path }));
    const raw = new Database(path); // keys off, as a tool or an old version could have written it
    raw.pragma('foreign_keys = OFF');
    raw.prepare("INSERT INTO catalog_item (id, kind, title, sort_title, added_at, updated_at) VALUES ('i1', 'movie', 'X', 'x', 0, 0)").run();
    raw.prepare("INSERT INTO watchlist_entry (profile_id, item_id, added_at) VALUES ('ghost', 'i1', 0)").run();
    raw.close();
    const warnings: { obj: object; msg: string }[] = [];
    const log = { info: () => undefined, warn: (obj: object, msg: string) => void warnings.push({ obj, msg }) };
    const db = await openDb({ path, backupDir: join(base, 'backup'), log });
    cleanup.push(() => closeDb(db));
    expect(warnings).toMatchObject([{ obj: { violations: 1, tables: ['watchlist_entry'] }, msg: expect.stringMatching(/foreign key/) }]);
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('old orphan rows do not block a migration; a migration that adds orphans to the same table is still refused', async () => {
    const base = tempDir();
    const path = join(base, 'video.db');
    closeDb(await openDb({ path }));
    const raw = new Database(path);
    raw.pragma('foreign_keys = OFF');
    raw.prepare("INSERT INTO catalog_item (id, kind, title, sort_title, added_at, updated_at) VALUES ('i1', 'movie', 'X', 'x', 0, 0)").run();
    raw.prepare("INSERT INTO watchlist_entry (profile_id, item_id, added_at) VALUES ('ghost', 'i1', 0)").run();
    raw.close();
    const warnings: { obj: object; msg: string }[] = [];
    const log = { info: () => undefined, warn: (obj: object, msg: string) => void warnings.push({ obj, msg }) };
    const migrations = copyMigrations();
    addMigration(migrations, '9000_harmless', ['CREATE TABLE `harmless` (`id` integer PRIMARY KEY);']);
    closeDb(await openDb({ path, backupDir: join(base, 'backup'), migrationsFolder: migrations, log }));
    expect(warnings).toMatchObject([{ obj: { violations: 1, tables: ['watchlist_entry'] } }]);

    addMigration(migrations, '9001_broken', ["INSERT INTO watchlist_entry (profile_id, item_id, added_at) VALUES ('ghost2', 'i1', 0);"]);
    await expect(openDb({ path, backupDir: join(base, 'backup'), migrationsFolder: migrations, log })).rejects.toThrow(/foreign key violation.*in watchlist_entry/);
  });

  it('prunes the pre-migration copies of older versions at every start', async () => {
    const base = tempDir();
    const path = join(base, 'video.db');
    const backupDir = join(base, 'backup');
    closeDb(await openDb({ path }));
    mkdirSync(backupDir);
    // An older version copied the database at every start, named by epoch milliseconds.
    for (let i = 0; i < 6; i++) writeFileSync(join(backupDir, `pre-migrate-${1793900000000 + i * 60_000}.db`), 'a copy');
    writeFileSync(join(backupDir, `video-${stampOf(T0)}.db`), 'a daily copy, not touched');
    closeDb(await openDb({ path, backupDir })); // nothing pending
    expect(names(backupDir)).toEqual([3, 4, 5].map((i) => `pre-migrate-${1793900000000 + i * 60_000}.db`).concat(`video-${stampOf(T0)}.db`));
  });
});

describe('daily backup', () => {
  it.each([
    // Friday back to Wednesday of the week before: 7 days, and the 2 weeks' newest are among them.
    ['one a day for 10 days: the last 7 days', Array.from({ length: 10 }, (_, i) => T0 - i * DAY), [0, 1, 2, 3, 4, 5, 6]],
    ['two on one day: the newer', [T0, T0 - 3600_000], [0]],
    ['downtime never empties it: days with a copy count', [T0, T0 - 30 * DAY, T0 - 60 * DAY], [0, 1, 2]],
    ['one a week for 6 weeks: all 6 (the 7 newest days with a copy)', Array.from({ length: 6 }, (_, i) => T0 - i * 7 * DAY), [0, 1, 2, 3, 4, 5]],
  ])('retention: %s', (_label, times, keptIndexes) => {
    const keep = backupsToKeep(times);
    expect(times.map((t, i) => (keep.has(t) ? i : -1)).filter((i) => i >= 0)).toEqual(keptIndexes);
  });

  it('a long history keeps 7 days and the newest of 4 weeks', () => {
    const times = Array.from({ length: 70 }, (_, i) => T0 - i * DAY); // 10 weeks, one a day
    const keep = backupsToKeep(times);
    // 7 days (Friday back to Saturday), plus the Sundays of the 2 older weeks the days do not reach.
    expect([...keep].sort((a, b) => b - a)).toEqual([0, 1, 2, 3, 4, 5, 6, 12, 19].map((i) => T0 - i * DAY));
  });

  it('names carry a sortable UTC stamp; older epoch names are read too', () => {
    expect(stampOf(T0)).toBe('20261106T030000000Z');
    expect(timeOfName(`video-${stampOf(T0)}.db`, 'video-')).toBe(T0);
    expect(timeOfName('pre-migrate-1793938779761.db', 'pre-migrate-')).toBe(1793938779761);
    expect(timeOfName('video-x.db', 'video-')).toBeNull();
  });

  it('writes a checked copy under a temporary name, renames it, and prunes', async () => {
    const dir = tempDir();
    const db = await openDb({ path: join(tempDir(), 'video.db') });
    cleanup.push(() => closeDb(db));
    db.$client.prepare("INSERT INTO profile (id, name, prefs, created_at) VALUES ('p1', 'Simone', '{}', 0)").run();
    for (let i = 9; i >= 1; i--) writeFileSync(join(dir, `video-${stampOf(T0 - i * DAY)}.db`), 'older copy');
    writeFileSync(join(dir, `video-${stampOf(T0 - DAY)}.db.tmp`), 'interrupted');
    const seen: string[] = [];
    const { file, pruned } = await backupDatabase(db.$client, {
      dir,
      now: T0,
      check: async (p) => {
        seen.push(p);
        return checkBackup(p);
      },
    });
    expect(seen).toEqual([`${file}.tmp`]);
    expect(file).toBe(join(dir, `video-${stampOf(T0)}.db`));
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare('SELECT name FROM profile').pluck().all()).toEqual(['Simone']);
    expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
    copy.close();
    expect(pruned).toEqual([7, 8, 9].map((i) => `video-${stampOf(T0 - i * DAY)}.db`));
    expect(names(dir).filter((n) => !/^video-\d{8}T\d{9}Z\.db$/.test(n))).toEqual([]);
    expect(lastDailyBackupAt(dir, T0)).toBe(T0);
  });

  it('a copy that fails the integrity check is deleted and reported', async () => {
    const dir = tempDir();
    const db = await openDb({ path: ':memory:' });
    cleanup.push(() => closeDb(db));
    const failing = backupDatabase(db.$client, { dir, now: T0, check: async () => ['*** in database main *** Page 7: btreeInitPage() returns error code 11'] });
    await expect(failing).rejects.toBeInstanceOf(BackupCheckError);
    expect(names(dir)).toEqual([]);
    expect(lastDailyBackupAt(dir, T0)).toBeNull();
  });

  it('the integrity check finds a corrupted file', async () => {
    const path = join(tempDir(), 'broken.db');
    const raw = new Database(path);
    raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX t_v ON t (v);');
    const ins = raw.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 2000; i++) ins.run(`value ${i} ${'x'.repeat(50)}`);
    raw.close();
    const bytes = readFileSync(path);
    bytes.fill(0x5a, 4096 * 3, 4096 * 6); // overwrite a few pages in the middle
    writeFileSync(path, bytes);
    expect((await checkBackup(path)).length).toBeGreaterThan(0);
  });

  it.each([
    ['no copy yet', null, 0, true],
    ['a day old', T0 - DAY, T0, true],
    ['an hour short of a day (the hourly check would slide later each day)', T0 - DAY + 3600_000, T0, true],
    ['22 hours old', T0 - 22 * 3600_000, T0, false],
    ['just made', T0, T0, false],
  ] as const)('due: %s', (_label, last, now, due) => {
    expect(backupDue(last, now)).toBe(due);
  });

  it('a copy dated in the future (a clock that jumped ahead) neither stops backups nor gets pruned', async () => {
    const dir = tempDir();
    const db = await openDb({ path: ':memory:' });
    cleanup.push(() => closeDb(db));
    const future = `video-${stampOf(T0 + 3 * 365 * DAY)}.db`;
    writeFileSync(join(dir, future), 'made while the clock was ahead');
    for (let i = 1; i <= 9; i++) writeFileSync(join(dir, `video-${stampOf(T0 - i * DAY)}.db`), 'older copy');
    expect(lastDailyBackupAt(dir, T0)).toBe(T0 - DAY);
    const clock = { now: T0 };
    const task = backupTask({ db, dir, now: () => clock.now, log: pino({ level: 'silent' }) });
    await task.run();
    expect(names(dir)).toContain(`video-${stampOf(T0)}.db`);
    expect(names(dir)).toContain(future);
    expect(names(dir)).toHaveLength(1 + 7); // the future copy, and the 7 newest days up to now
    clock.now += 3600_000;
    await task.run(); // an hour later: not due again
    expect(names(dir)).toHaveLength(8);
  });

  it('the task backs up once a day, never twice at once, and logs a failure', async () => {
    const base = tempDir();
    const dir = join(base, 'backup');
    const db = await openDb({ path: ':memory:' });
    cleanup.push(() => closeDb(db));
    const errors: unknown[] = [];
    const log = pino({ level: 'silent' });
    log.error = (o: unknown) => void errors.push(o);
    const clock = { now: T0 };
    const task = backupTask({ db, dir, now: () => clock.now, log });
    await Promise.all([task.run(), task.run()]);
    expect(names(dir)).toEqual([`video-${stampOf(T0)}.db`]);
    clock.now += 3600_000;
    await task.run(); // less than a day later: nothing
    expect(names(dir)).toHaveLength(1);
    clock.now = T0 + DAY;
    await task.run();
    expect(names(dir)).toHaveLength(2);
    expect(errors).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'a file where the backup folder should be');
    await task.run();
    expect(errors).toHaveLength(1);
  });
});
