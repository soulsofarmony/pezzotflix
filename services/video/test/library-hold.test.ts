// The hold of the unmounted-root guard is kept on library_root, and ConfirmRootContents releases it
// once: the next scan marks the absent files missing, at most as many as the owner confirmed.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { libraryRoot } from '../src/db/schema/index.ts';
import { createEventsModule } from '../src/modules/events/index.ts';
import { createJobRunner, createJobsModule } from '../src/modules/jobs/index.ts';
import { libraryModule } from '../src/modules/library/index.ts';
import { syncRoots } from '../src/modules/library/roots.ts';
import { SUSPECT_MIN_PRESENT } from '../src/modules/library/scan.ts';

const log = pino({ level: 'silent' });
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

const COUNT = SUSPECT_MIN_PRESENT + 4;
const rel = (i: number) => `Movie ${i} (2001)/Movie ${i} (2001).mkv`;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pzf-hold-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < COUNT; i++) {
    const p = join(root, ...rel(i).split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, randomBytes(4096));
  }
  const db = await openDb({ path: ':memory:' });
  cleanup.push(() => closeDb(db));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: '/nonexistent', LIBRARY_ROOTS: JSON.stringify([{ name: 'Film', path: root, hint: 'movies' }]) });
  const comp = compose({ config, db, log, factories: [createEventsModule, createJobsModule, libraryModule({ stableAfterMs: 0 })] });
  for (const m of comp.modules) await m.start?.();
  const runner = createJobRunner({ db, log, jobTypes: comp.jobTypes, periodic: comp.periodic });
  cleanup.push(() => void runner.stop());
  const rootRow = () =>
    db.$client.prepare('SELECT id, status, hold_reason AS holdReason, held_missing AS heldMissing, confirmed_missing AS confirmedMissing, confirmed_at AS confirmedAt FROM library_root WHERE name = ?').get('Film') as {
      id: string;
      status: string;
      holdReason: string | null;
      heldMissing: number | null;
      confirmedMissing: number | null;
      confirmedAt: number | null;
    };
  const missing = () => (db.$client.prepare("SELECT count(*) AS n FROM media_file WHERE state = 'missing'").get() as { n: number }).n;
  const scan = async () => {
    comp.ports.library.requestScan();
    await runner.drain();
  };
  const remove = (from: number, to: number) => {
    for (let i = from; i < to; i++) rmSync(join(root, `Movie ${i} (2001)`), { recursive: true });
  };
  await scan();
  db.$client.prepare("UPDATE media_file SET state = 'identified'").run();
  return { db, root, comp, runner, rootRow, missing, scan, remove };
}

describe('mass-missing confirmation', () => {
  it('keeps the hold on the root and releases it once the owner confirms', async () => {
    const h = await setup();
    expect(h.rootRow()).toMatchObject({ status: 'online', holdReason: null, heldMissing: null });
    expect(h.comp.ports.library.confirmRootContents(h.rootRow().id)).toEqual({ status: 'not_held' });

    h.remove(0, COUNT - 2); // the owner really deleted most of the films
    await h.scan();
    expect(h.rootRow()).toMatchObject({ status: 'offline', holdReason: 'mass_missing', heldMissing: COUNT - 2, confirmedMissing: null });
    expect(h.missing()).toBe(0);
    await h.scan(); // held for good until someone decides
    expect(h.rootRow()).toMatchObject({ status: 'offline', holdReason: 'mass_missing' });

    const r = h.comp.ports.library.confirmRootContents(h.rootRow().id);
    expect(r).toMatchObject({ status: 'queued' });
    expect(h.rootRow().confirmedMissing).toBe(COUNT - 2);
    await h.runner.drain();
    expect(h.missing()).toBe(COUNT - 2);
    expect(h.rootRow()).toMatchObject({ status: 'online', holdReason: null, heldMissing: null, confirmedMissing: null });
    expect(h.comp.ports.library.confirmRootContents('nope')).toEqual({ status: 'not_found' });
  });

  it('holds again when more files are absent than the owner confirmed', async () => {
    const h = await setup();
    h.remove(0, 15);
    await h.scan();
    expect(h.rootRow()).toMatchObject({ holdReason: 'mass_missing', heldMissing: 15 });
    h.comp.ports.library.confirmRootContents(h.rootRow().id);
    h.remove(15, 20); // more vanished before the scan ran
    await h.runner.drain();
    expect(h.missing()).toBe(0);
    expect(h.rootRow()).toMatchObject({ status: 'offline', holdReason: 'mass_missing', heldMissing: 20, confirmedMissing: null });
  });

  it('confirms an empty root too', async () => {
    const h = await setup();
    h.remove(0, COUNT);
    await h.scan();
    expect(h.rootRow()).toMatchObject({ status: 'offline', holdReason: 'empty_walk', heldMissing: COUNT });
    h.comp.ports.library.confirmRootContents(h.rootRow().id);
    await h.runner.drain();
    expect(h.missing()).toBe(COUNT);
    expect(h.rootRow()).toMatchObject({ status: 'online', holdReason: null });
  });

  it('a confirmation recorded after a scan started is kept for the next scan', async () => {
    const h = await setup();
    h.remove(0, 15);
    await h.scan();
    const id = h.rootRow().id;
    // The scan reads the root rows when it starts: a confirmation written after that is not consumed by it.
    expect(h.comp.ports.library.requestScan(id)).toBeTruthy();
    // drain() claims the job and the handler reads the roots synchronously, before the first await.
    const drained = h.runner.drain();
    h.db.$client.prepare('UPDATE library_root SET confirmed_missing = 15, confirmed_at = 7').run();
    await drained;
    expect(h.missing()).toBe(0);
    expect(h.rootRow()).toMatchObject({ holdReason: 'mass_missing', confirmedMissing: 15, confirmedAt: 7 });
    await h.scan();
    expect(h.missing()).toBe(15);
    expect(h.rootRow()).toMatchObject({ status: 'online', holdReason: null, confirmedMissing: null, confirmedAt: null });
  });

  it('a re-confirmation during a confirmed scan survives it; the scan clears only the one it saw', async () => {
    const h = await setup();
    h.remove(0, 15);
    await h.scan();
    const id = h.rootRow().id;
    expect(h.comp.ports.library.confirmRootContents(id)).toMatchObject({ status: 'queued' });
    const first = h.rootRow().confirmedAt!;
    // Confirming again (same clock) still moves confirmedAt forward.
    expect(h.comp.ports.library.confirmRootContents(id)).toMatchObject({ status: 'queued' });
    const second = h.rootRow().confirmedAt!;
    expect(second).toBeGreaterThan(first);
    // Drop the follow-up scan the second confirmation queued, so only one scan runs below.
    h.db.$client.prepare("DELETE FROM job WHERE idempotency_key LIKE '%:next'").run();
    const drained = h.runner.drain();
    // While that scan runs (it saw `second`), the owner confirms once more.
    h.db.$client.prepare('UPDATE library_root SET confirmed_missing = 16, confirmed_at = ?').run(second + 1);
    await drained;
    expect(h.missing()).toBe(15);
    expect(h.rootRow()).toMatchObject({ status: 'online', holdReason: null, heldMissing: null, confirmedMissing: 16, confirmedAt: second + 1 });
  });

  it('an unreachable root during a confirmed scan keeps its hold and the confirmation', async () => {
    const h = await setup();
    h.remove(0, 15);
    await h.scan();
    const id = h.rootRow().id;
    h.db.$client.prepare('UPDATE library_root SET confirmed_missing = 15, confirmed_at = 7').run();
    rmSync(h.root, { recursive: true, force: true }); // the disk is unplugged
    await h.scan();
    expect(h.missing()).toBe(0);
    expect(h.rootRow()).toMatchObject({ id, status: 'offline', holdReason: 'mass_missing', heldMissing: 15, confirmedMissing: 15, confirmedAt: 7 });
  });

  it('refuses to confirm a root that is not configured', async () => {
    const h = await setup();
    h.db.$client
      .prepare("INSERT INTO library_root (id, name, mount_path, hint, status, created_at, hold_reason, held_missing) VALUES ('old', 'Vecchio', '/gone', 'movies', 'offline', 0, 'empty_walk', 3)")
      .run();
    expect(h.comp.ports.library.confirmRootContents('old')).toEqual({ status: 'not_configured' });
    expect(h.db.$client.prepare("SELECT confirmed_missing AS c FROM library_root WHERE id = 'old'").get()).toEqual({ c: null });
  });
});

describe('syncRoots and the hold', () => {
  const held = { holdReason: 'mass_missing', heldMissing: 9, confirmedMissing: 9, confirmedAt: 5 } as const;
  const holdOf = (db: Db, id: string) =>
    db.$client.prepare('SELECT status, hold_reason AS holdReason, held_missing AS heldMissing, confirmed_missing AS confirmedMissing, confirmed_at AS confirmedAt FROM library_root WHERE id = ?').get(id);

  it('clears the hold of a root that left the config or moved; keeps it otherwise', async () => {
    const db = await openDb({ path: ':memory:' });
    cleanup.push(() => closeDb(db));
    const specs = [
      { name: 'Film', path: '/media/Film', hint: 'movies' as const },
      { name: 'Serie', path: '/media/Serie', hint: 'series' as const },
      { name: 'Doc', path: '/media/Doc', hint: 'movies' as const },
    ];
    const ids = Object.fromEntries(syncRoots(db, specs, 0).roots.map((r) => [r.name, r.id]));
    db.update(libraryRoot).set({ status: 'offline', ...held }).run();
    // Film stays, Serie moves to another disk, Doc leaves the config.
    syncRoots(db, [specs[0]!, { ...specs[1]!, path: '/mnt/disk2/Serie' }], 1);
    expect(holdOf(db, ids.Film!)).toEqual({ status: 'offline', ...held });
    expect(holdOf(db, ids.Serie!)).toEqual({ status: 'offline', holdReason: null, heldMissing: null, confirmedMissing: null, confirmedAt: null });
    expect(holdOf(db, ids.Doc!)).toEqual({ status: 'offline', holdReason: null, heldMissing: null, confirmedMissing: null, confirmedAt: null });
  });
});
