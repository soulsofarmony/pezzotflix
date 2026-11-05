// Library scan on a temporary folder tree of small dummy files (no media): composition with the
// real jobs/events modules; analyzer.probe is not registered, so probe jobs stay queued.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../src/app/compose.ts';
import { loadConfig, type LibraryRootSpec } from '../src/app/config.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createEventsModule } from '../src/modules/events/index.ts';
import { createJobRunner, createJobsModule, enqueueJob } from '../src/modules/jobs/index.ts';
import { libraryModule, requestScan, scanJobKey } from '../src/modules/library/index.ts';
import { syncRoots, validateRoots } from '../src/modules/library/roots.ts';
import { SUSPECT_MIN_PRESENT } from '../src/modules/library/scan.ts';
import type { MediaFacts } from '../src/shared/media-facts.ts';
import type { JobQueuePort } from '../src/shared/ports.ts';

const log = pino({ level: 'silent' });
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pzf-library-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(root: string, rel: string, content: Buffer | string = randomBytes(4096)): void {
  const p = join(root, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const abs = (root: string, rel: string) => join(root, ...rel.split('/'));

interface FileRow {
  id: string;
  rel_path: string;
  state: string;
  fingerprint: string | null;
  missing_since: number | null;
  mtime_ms: number;
  facts: string | null;
  root: string;
}
interface JobRow {
  payload: { fileId: string };
  key: string;
  state: string;
}

async function harness(roots: LibraryRootSpec[], stableAfterMs = 0) {
  const db: Db = await openDb({ path: ':memory:' });
  cleanup.push(() => closeDb(db));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: tempDir(), LIBRARY_ROOTS: JSON.stringify(roots) });
  const comp = compose({ config, db, log, factories: [createEventsModule, createJobsModule, libraryModule({ stableAfterMs })] });
  for (const m of comp.modules) await m.start?.();
  const runner = createJobRunner({ db, log, jobTypes: comp.jobTypes, periodic: comp.periodic });
  cleanup.push(() => void runner.stop());
  const periodicScan = comp.periodic.find((p) => p.name === 'library.scan');
  const q = <T>(sql: string, ...args: unknown[]) => db.$client.prepare(sql).all(...args) as T[];
  const exec = (sql: string, ...args: unknown[]) => db.$client.prepare(sql).run(...args);
  const jobsPort: JobQueuePort = { enqueue: (j) => enqueueJob(db, Date.now(), j) };
  const rootId = (name: string) => (db.$client.prepare('SELECT id FROM library_root WHERE name = ?').get(name) as { id: string }).id;
  const jobs = (type: string) =>
    q<{ payload: string; key: string; state: string }>('SELECT payload, idempotency_key AS key, state FROM job WHERE type = ? ORDER BY created_at, id', type).map(
      (j): JobRow => ({ ...j, payload: JSON.parse(j.payload) as { fileId: string } }),
    );
  const files = () =>
    q<FileRow>(
      'SELECT f.id, f.rel_path, f.state, f.fingerprint, f.missing_since, f.mtime_ms, f.facts, r.name AS root FROM media_file f JOIN library_root r ON r.id = f.root_id ORDER BY f.rel_path',
    );
  let items = 0;
  return {
    db,
    comp,
    jobsPort,
    rootId,
    exec,
    files,
    file: (relPath: string) => files().find((f) => f.rel_path === relPath),
    byId: (id: string | undefined) => files().find((f) => f.id === id),
    /** The periodic task requests a scan of every root; the runner executes it. */
    scan: async () => {
      await periodicScan?.run();
      await runner.drain();
    },
    scanRoot: async (name: string) => {
      requestScan(jobsPort, rootId(name));
      await runner.drain();
    },
    probes: () => jobs('analyzer.probe'),
    queuedProbes: () => jobs('analyzer.probe').filter((j) => j.state === 'queued'),
    queuedIdentifies: () => jobs('identifier.identify').filter((j) => j.state === 'queued'),
    sidecars: (fileId: string | undefined) =>
      q('SELECT rel_path, language, is_forced, is_sdh, format FROM external_subtitle WHERE file_id = ? ORDER BY rel_path', fileId),
    events: () => q<{ type: string; payload: string }>('SELECT type, payload FROM domain_event ORDER BY seq'),
    progress: () => {
      const last = q<{ payload: string }>("SELECT payload FROM domain_event WHERE type = 'ingest.progress' ORDER BY seq DESC LIMIT 1")[0];
      return (JSON.parse(last?.payload ?? '{}') as { roots?: Record<string, unknown>[] }).roots ?? [];
    },
    roots: () => q<{ name: string; status: string; last_scan_at: number | null }>('SELECT name, status, last_scan_at FROM library_root ORDER BY name'),
    /** Pretend the analyzer ran: state 'analyzed' and minimal facts. */
    analyzed: (id: string | undefined) => {
      const f = files().find((x) => x.id === id);
      const facts = { location: { rootName: f?.root, relPath: f?.rel_path }, mtimeMs: f?.mtime_ms, streams: [], sidecars: [] };
      exec("UPDATE media_file SET state = 'analyzed', facts = ? WHERE id = ?", JSON.stringify(facts), id);
    },
    /** Pretend the identifier or the owner decided. */
    link: (id: string | undefined) => {
      const itemId = `item-${++items}`;
      exec("INSERT INTO catalog_item (id, kind, title, sort_title, added_at, updated_at) VALUES (?, 'movie', 'T', 't', 0, 0)", itemId);
      exec("INSERT INTO media_link (id, file_id, item_id, origin, created_at) VALUES (?, ?, ?, 'manual', 0)", `link-${itemId}`, id, itemId);
      exec("UPDATE media_file SET state = 'identified' WHERE id = ?", id);
    },
    openCase: (id: string | undefined, state: 'ignored' | 'needs_review') => {
      exec("INSERT INTO identification_case (id, file_id, state, reason, created_at, updated_at) VALUES (?, ?, ?, 'low_score', 0, 0)", `case-${id}`, id, state);
      exec('UPDATE media_file SET state = ? WHERE id = ?', state, id);
    },
    allJobsDone: () => exec("UPDATE job SET state = 'done'"),
  };
}

const factsOf = (row: { facts: string | null } | undefined) => JSON.parse(row?.facts ?? 'null') as MediaFacts | null;

describe('library scan', () => {
  it('records videos, sidecars and disc structures, ignores the rest, and enqueues probes', async () => {
    const root = tempDir();
    writeFile(root, 'Movie A (2001)/Movie A (2001).mkv', randomBytes(3 * 1024 * 1024 + 17));
    writeFile(root, 'Movie A (2001)/Movie A (2001).it.forced.srt', '1');
    writeFile(root, 'Movie A (2001)/Movie A (2001).en.srt', '1');
    writeFile(root, 'Movie A (2001)/Movie A (2001)-sample.mkv');
    writeFile(root, 'Movie A (2001)/Sample/Movie A (2001).mkv');
    writeFile(root, 'Movie A (2001)/extras/Trailer.mkv');
    writeFile(root, 'Disc (2002)/BDMV/STREAM/00001.m2ts');
    writeFile(root, 'Old (1990)/VIDEO_TS/VTS_01_1.VOB');
    writeFile(root, 'Iso (2003)/Iso (2003).iso');
    writeFile(root, 'Dark (2017)/Season 01/Dark (2017) - S01E01 - Sample Rate.mkv');
    for (const junk of ['.hidden', '@eaDir', '$RECYCLE.BIN', 'samples', '#snapshot/GMT+01_2026-11-01', '@Recycle', '@Recently-Snapshot']) {
      writeFile(root, `${junk}/x.mkv`);
    }
    writeFile(root, 'notes.txt', 'x');

    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();

    expect(h.files().map((f) => [f.rel_path, f.state])).toEqual([
      ['Dark (2017)/Season 01/Dark (2017) - S01E01 - Sample Rate.mkv', 'discovered'],
      ['Disc (2002)/BDMV', 'needs_review'],
      ['Iso (2003)/Iso (2003).iso', 'needs_review'],
      ['Movie A (2001)/Movie A (2001).mkv', 'discovered'],
      ['Movie A (2001)/extras/Trailer.mkv', 'discovered'],
      ['Old (1990)/VIDEO_TS', 'needs_review'],
    ]);
    const movie = h.file('Movie A (2001)/Movie A (2001).mkv');
    expect(movie?.fingerprint).toMatch(/^v1:3145745:[0-9a-f]{64}$/);
    expect(h.file('Iso (2003)/Iso (2003).iso')?.fingerprint).toMatch(/^v1:4096:/);
    expect(h.file('Disc (2002)/BDMV')?.fingerprint).toBeNull();

    // The library writes the sidecars with the file row.
    expect(h.sidecars(movie?.id)).toEqual([
      { rel_path: 'Movie A (2001)/Movie A (2001).en.srt', language: 'eng', is_forced: 0, is_sdh: 0, format: 'srt' },
      { rel_path: 'Movie A (2001)/Movie A (2001).it.forced.srt', language: 'ita', is_forced: 1, is_sdh: 0, format: 'srt' },
    ]);
    const mtime = Math.floor(statSync(abs(root, 'Movie A (2001)/Movie A (2001).mkv')).mtimeMs);
    expect(h.probes()).toHaveLength(3);
    expect(h.probes().find((p) => p.payload.fileId === movie?.id)).toEqual({
      key: `probe:${movie?.id}:${mtime}`,
      state: 'queued',
      payload: { fileId: movie?.id },
    });

    const cases = h.db.$client
      .prepare('SELECT f.rel_path, c.state, c.reason, c.parsed FROM identification_case c JOIN media_file f ON f.id = c.file_id ORDER BY f.rel_path')
      .all();
    expect(cases).toEqual([
      { rel_path: 'Disc (2002)/BDMV', state: 'needs_review', reason: 'disc_structure', parsed: '{"kind":"disc","disc":"bdmv"}' },
      { rel_path: 'Iso (2003)/Iso (2003).iso', state: 'needs_review', reason: 'disc_structure', parsed: '{"kind":"disc","disc":"iso"}' },
      { rel_path: 'Old (1990)/VIDEO_TS', state: 'needs_review', reason: 'disc_structure', parsed: '{"kind":"disc","disc":"video_ts"}' },
    ]);
    expect(h.events().map((e) => e.type)).toEqual([
      'identification.needs_review', 'identification.needs_review', 'identification.needs_review', 'ingest.progress',
    ]);
    expect(h.progress()).toMatchObject([{ name: 'Film', status: 'online', warning: null, added: 6, discCases: 3, missing: 0, moved: 0 }]);
    expect(h.roots()).toEqual([{ name: 'Film', status: 'online', last_scan_at: expect.any(Number) }]);

    // A second scan of an unchanged tree changes nothing and queues nothing new.
    await h.scan();
    expect(h.files()).toHaveLength(6);
    expect(h.probes()).toHaveLength(3);
    expect(h.events().filter((e) => e.type === 'identification.needs_review')).toHaveLength(3);
  });

  it('keeps sidecars up to date without probing again', async () => {
    const root = tempDir();
    writeFile(root, 'Movie A (2001)/Movie A (2001).mkv');
    writeFile(root, 'Movie A (2001)/Movie A (2001).it.srt', '1');
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    const id = h.file('Movie A (2001)/Movie A (2001).mkv')?.id;
    h.analyzed(id);
    h.allJobsDone();

    writeFile(root, 'Movie A (2001)/Movie A (2001).en.sdh.srt', '1');
    rmSync(abs(root, 'Movie A (2001)/Movie A (2001).it.srt'));
    await h.scan();
    expect(h.sidecars(id)).toEqual([{ rel_path: 'Movie A (2001)/Movie A (2001).en.sdh.srt', language: 'eng', is_forced: 0, is_sdh: 1, format: 'srt' }]);
    expect(factsOf(h.byId(id))?.sidecars).toEqual([
      { id: expect.stringMatching(/^x:[0-9a-f]{8}$/), relPath: 'Movie A (2001)/Movie A (2001).en.sdh.srt', format: 'srt', language: 'eng', forced: false, sdh: true },
    ]);
    expect(h.byId(id)?.state).toBe('analyzed');
    expect(h.queuedProbes()).toEqual([]);
  });

  it('moves keep ids, decisions and links; renamed undecided files are identified again', async () => {
    const root = tempDir();
    writeFile(root, 'Movie A (2001)/Movie A (2001).mkv');
    writeFile(root, 'Movie A (2001)/Movie A (2001).it.srt', '1');
    writeFile(root, 'Movie A (2001)/extras/Trailer.mkv');
    writeFile(root, 'misc/title_t00.mkv');
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    const movieId = h.file('Movie A (2001)/Movie A (2001).mkv')?.id;
    const trailerId = h.file('Movie A (2001)/extras/Trailer.mkv')?.id;
    const reviewId = h.file('misc/title_t00.mkv')?.id;
    for (const id of [movieId, trailerId, reviewId]) h.analyzed(id);
    h.link(movieId);
    h.openCase(reviewId, 'needs_review');
    h.allJobsDone();

    renameSync(abs(root, 'Movie A (2001)'), abs(root, 'Movie A (2001) {tmdb-42}'));
    mkdirSync(abs(root, 'Inception (2010)'));
    renameSync(abs(root, 'misc/title_t00.mkv'), abs(root, 'Inception (2010)/Inception (2010).mkv'));
    await h.scan();

    expect(h.files().map((f) => [f.rel_path, f.id, f.state])).toEqual([
      ['Inception (2010)/Inception (2010).mkv', reviewId, 'needs_review'],
      ['Movie A (2001) {tmdb-42}/Movie A (2001).mkv', movieId, 'identified'],
      ['Movie A (2001) {tmdb-42}/extras/Trailer.mkv', trailerId, 'analyzed'],
    ]);
    expect(factsOf(h.byId(movieId))?.location).toEqual({ rootName: 'Film', relPath: 'Movie A (2001) {tmdb-42}/Movie A (2001).mkv' });
    expect(h.sidecars(movieId)).toMatchObject([{ rel_path: 'Movie A (2001) {tmdb-42}/Movie A (2001).it.srt', language: 'ita' }]);
    expect(h.progress()).toMatchObject([{ moved: 3, missing: 0, added: 0 }]);
    // Same content: no probe. Not decided yet: the identifier sees the new name (how the owner fixes a case).
    expect(h.queuedProbes()).toEqual([]);
    expect(h.queuedIdentifies().map((j) => j.payload.fileId).sort()).toEqual([reviewId, trailerId].sort());
  });

  it('a touch keeps the state and re-runs nothing', async () => {
    const root = tempDir();
    for (const name of ['Linked', 'Ignored', 'Fresh']) writeFile(root, `${name} (2001)/${name} (2001).mkv`);
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    const linked = h.file('Linked (2001)/Linked (2001).mkv')?.id;
    const ignored = h.file('Ignored (2001)/Ignored (2001).mkv')?.id;
    const fresh = h.file('Fresh (2001)/Fresh (2001).mkv')?.id; // never analysed
    h.analyzed(linked);
    h.link(linked);
    h.analyzed(ignored);
    h.openCase(ignored, 'ignored');
    h.allJobsDone();

    const later = new Date(Date.now() + 10_000);
    for (const name of ['Linked', 'Ignored', 'Fresh']) utimesSync(abs(root, `${name} (2001)/${name} (2001).mkv`), later, later);
    await h.scan();

    const mtime = Math.floor(later.getTime());
    expect([h.byId(linked), h.byId(ignored), h.byId(fresh)].map((f) => [f?.state, f?.mtime_ms])).toEqual([
      ['identified', mtime],
      ['ignored', mtime],
      ['discovered', mtime],
    ]);
    expect(factsOf(h.byId(linked))?.mtimeMs).toBe(mtime);
    expect(h.progress()).toMatchObject([{ touched: 3, changed: 0 }]);
    // Only the file without facts is probed (under its new mtime); nobody is identified again.
    expect(h.queuedProbes()).toEqual([{ key: `probe:${fresh}:${mtime}`, state: 'queued', payload: { fileId: fresh } }]);
    expect(h.queuedIdentifies()).toEqual([]);
  });

  it('new content in place is probed and identified again', async () => {
    const root = tempDir();
    writeFile(root, 'Movie A (2001)/Movie A (2001).mkv');
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    const id = h.file('Movie A (2001)/Movie A (2001).mkv')?.id;
    h.analyzed(id);
    h.link(id);
    h.allJobsDone();

    writeFile(root, 'Movie A (2001)/Movie A (2001).mkv', randomBytes(5000));
    const later = new Date(Date.now() + 5000);
    utimesSync(abs(root, 'Movie A (2001)/Movie A (2001).mkv'), later, later);
    await h.scan();
    expect(h.byId(id)?.state).toBe('discovered');
    expect(h.queuedProbes()).toEqual([{ key: `probe:${id}:${Math.floor(later.getTime())}`, state: 'queued', payload: { fileId: id } }]);
    expect(h.progress()).toMatchObject([{ changed: 1, touched: 0 }]);
  });

  it('a file back from missing gets its state back from links and cases', async () => {
    const root = tempDir();
    const away = tempDir();
    const names = ['Linked', 'Ignored', 'Review', 'Analysed', 'Fresh'];
    for (const name of names) writeFile(root, `Gone/${name} (2001).mkv`);
    writeFile(root, 'Keep (2000)/Keep (2000).mkv'); // an emptied root would look unmounted
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    const ids = Object.fromEntries(names.map((n) => [n, h.file(`Gone/${n} (2001).mkv`)?.id]));
    for (const n of ['Linked', 'Ignored', 'Review', 'Analysed']) h.analyzed(ids[n]);
    h.link(ids.Linked);
    h.openCase(ids.Ignored, 'ignored');
    h.openCase(ids.Review, 'needs_review');
    h.allJobsDone();

    renameSync(abs(root, 'Gone'), join(away, 'Gone')); // rename keeps the mtimes
    await h.scan();
    expect(names.map((n) => h.byId(ids[n])?.state)).toEqual(names.map(() => 'missing'));

    renameSync(join(away, 'Gone'), abs(root, 'Gone'));
    await h.scan();
    expect(names.map((n) => h.byId(ids[n])?.state)).toEqual(['identified', 'ignored', 'needs_review', 'analyzed', 'discovered']);
    expect(names.every((n) => h.byId(ids[n])?.missing_since === null)).toBe(true);
    expect(h.progress()).toMatchObject([{ revived: 5, missing: 0 }]);
    // Only the file that never got facts is probed again.
    expect(h.queuedProbes().map((j) => j.payload.fileId)).toEqual([ids.Fresh]);
    expect(h.queuedIdentifies()).toEqual([]);
  });

  it('recognises a file that reappears in another root as the missing one', async () => {
    const film = tempDir();
    const serie = tempDir();
    const content = randomBytes(8192);
    writeFile(film, 'Dark (2017)/Dark - S01E01.mkv', content);
    writeFile(film, 'Keep (2000)/Keep (2000).mkv');
    writeFile(serie, 'Other (2001)/Other (2001) - S01E01.mkv');
    const h = await harness([
      { name: 'Film', path: film, hint: 'movies' },
      { name: 'Serie', path: serie, hint: 'series' },
    ]);
    await h.scan();
    const id = h.file('Dark (2017)/Dark - S01E01.mkv')?.id;
    h.analyzed(id);
    h.link(id);
    rmSync(abs(film, 'Dark (2017)'), { recursive: true });
    await h.scan();
    expect(h.byId(id)?.state).toBe('missing');

    writeFile(serie, 'Dark (2017)/Season 01/Dark - S01E01.mkv', content);
    await h.scan();
    expect(h.byId(id)).toMatchObject({ root: 'Serie', rel_path: 'Dark (2017)/Season 01/Dark - S01E01.mkv', state: 'identified', missing_since: null });
    expect(factsOf(h.byId(id))?.location).toEqual({ rootName: 'Serie', relPath: 'Dark (2017)/Season 01/Dark - S01E01.mkv' });
    expect(h.files()).toHaveLength(3);
  });

  it('revives a missing file at its own path even when a copy appears elsewhere', async () => {
    const root = tempDir();
    const content = randomBytes(8192);
    writeFile(root, 'Movie A (2001)/Movie A (2001).mkv', content);
    writeFile(root, 'Keep (2000)/Keep (2000).mkv');
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    const id = h.file('Movie A (2001)/Movie A (2001).mkv')?.id;
    const moviePath = abs(root, 'Movie A (2001)/Movie A (2001).mkv');
    renameSync(moviePath, join(root, 'away.bin')); // not a video: the walk skips it, mtime is kept
    await h.scan();
    expect(h.byId(id)?.state).toBe('missing');

    renameSync(join(root, 'away.bin'), moviePath);
    writeFile(root, 'Copy (2001)/Copy (2001).mkv', content); // same fingerprint, new path
    await h.scan();
    expect(h.file('Movie A (2001)/Movie A (2001).mkv')).toMatchObject({ id, state: 'discovered' });
    expect(h.file('Copy (2001)/Copy (2001).mkv')?.id).not.toBe(id);
    expect(h.files()).toHaveLength(3);
  });
});

describe('copy then delete, and moves seen by single-root scans', () => {
  const setup = async () => {
    const film = tempDir();
    const docs = tempDir();
    const content = randomBytes(8192);
    writeFile(film, 'Free Solo (2018)/Free Solo (2018).mkv', content);
    writeFile(film, 'Keep (2000)/Keep (2000).mkv');
    writeFile(docs, 'Keep (2001)/Keep (2001).mkv');
    const h = await harness([
      { name: 'Film', path: film, hint: 'movies' },
      { name: 'Documentari', path: docs, hint: 'movies' },
    ]);
    await h.scan();
    const id = h.file('Free Solo (2018)/Free Solo (2018).mkv')?.id;
    h.analyzed(id);
    h.link(id);
    h.allJobsDone();
    return { film, docs, content, h, id };
  };

  it('the original row takes the place of its copy once the original is deleted', async () => {
    const { film, docs, content, h, id } = await setup();
    writeFile(docs, 'Free Solo (2018)/Free Solo (2018).mkv', content);
    writeFile(docs, 'Free Solo (2018)/Free Solo (2018).it.srt', '1');
    await h.scan(); // both present: the copy is a new row for now
    const copyId = h.files().find((f) => f.root === 'Documentari' && f.rel_path.startsWith('Free Solo'))?.id;
    expect(copyId).toBeDefined();
    expect(copyId).not.toBe(id);

    rmSync(abs(film, 'Free Solo (2018)'), { recursive: true });
    await h.scan();
    const rows = h.files().filter((f) => f.rel_path === 'Free Solo (2018)/Free Solo (2018).mkv');
    expect(rows).toMatchObject([{ id, root: 'Documentari', state: 'identified', missing_since: null }]);
    expect(h.byId(copyId)).toBeUndefined();
    expect(factsOf(h.byId(id))?.location).toEqual({ rootName: 'Documentari', relPath: 'Free Solo (2018)/Free Solo (2018).mkv' });
    expect(h.sidecars(id)).toMatchObject([{ rel_path: 'Free Solo (2018)/Free Solo (2018).it.srt' }]);
    expect(h.progress().find((r) => r.name === 'Film')).toMatchObject({ merged: 1, missing: 0 });
    expect(h.queuedIdentifies()).toEqual([]);
  });

  it('a move seen first by a scan of the destination root only is merged by the next full scan', async () => {
    const { film, docs, h, id } = await setup();
    mkdirSync(abs(docs, 'Free Solo (2018)'));
    renameSync(abs(film, 'Free Solo (2018)/Free Solo (2018).mkv'), abs(docs, 'Free Solo (2018)/Free Solo (2018).mkv'));
    await h.scanRoot('Documentari');
    expect(h.files().filter((f) => f.rel_path === 'Free Solo (2018)/Free Solo (2018).mkv')).toHaveLength(2);

    await h.scan();
    expect(h.files().filter((f) => f.rel_path === 'Free Solo (2018)/Free Solo (2018).mkv')).toMatchObject([
      { id, root: 'Documentari', state: 'identified' },
    ]);
  });

  it('never merges into a copy that already carries a decision', async () => {
    const { film, docs, content, h, id } = await setup();
    writeFile(docs, 'Free Solo (2018)/Free Solo (2018).mkv', content);
    await h.scan();
    const copyId = h.files().find((f) => f.root === 'Documentari' && f.rel_path.startsWith('Free Solo'))?.id;
    h.analyzed(copyId);
    h.link(copyId);
    rmSync(abs(film, 'Free Solo (2018)'), { recursive: true });
    await h.scan();
    expect(h.byId(id)?.state).toBe('missing');
    expect(h.byId(copyId)).toMatchObject({ root: 'Documentari', state: 'identified' });
  });
});

describe('offline and unmounted roots', () => {
  it('marks an unreachable or empty root offline without marking its files missing', async () => {
    const root = tempDir();
    writeFile(root, 'Movie A (2001)/Movie A (2001).mkv');
    writeFile(root, 'Movie B (2002)/Movie B (2002).mkv');
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    h.exec("UPDATE media_file SET state = 'identified'");

    renameSync(root, `${root}.away`);
    cleanup.push(() => rmSync(`${root}.away`, { recursive: true, force: true }));
    await h.scan();
    expect(h.roots()[0]?.status).toBe('offline');
    expect(h.files().map((f) => f.state)).toEqual(['identified', 'identified']);

    mkdirSync(root); // the mount point exists but is empty, like an unmounted NAS share
    await h.scan();
    expect(h.roots()[0]?.status).toBe('offline');
    expect(h.progress()).toMatchObject([{ status: 'offline', warning: 'empty_walk', heldMissing: 2 }]);
    expect(h.files().map((f) => f.state)).toEqual(['identified', 'identified']);

    rmSync(root, { recursive: true });
    renameSync(`${root}.away`, root);
    await h.scan();
    expect(h.roots()[0]?.status).toBe('online');
    expect(h.files().map((f) => f.state)).toEqual(['identified', 'identified']);
    const statuses = h.events().filter((e) => e.type === 'ingest.progress').map((e) => (JSON.parse(e.payload) as { roots: { status: string }[] }).roots[0]?.status);
    expect(statuses).toEqual(['online', 'offline', 'offline', 'online']);
  });

  it('holds a large root offline when most of it vanishes at once', async () => {
    const root = tempDir();
    const count = SUSPECT_MIN_PRESENT + 4;
    for (let i = 0; i < count; i++) writeFile(root, `Movie ${i} (2001)/Movie ${i} (2001).mkv`);
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    h.exec("UPDATE media_file SET state = 'identified'");

    // The share is not mounted, but something left one stray video in the mount point.
    renameSync(root, `${root}.away`);
    cleanup.push(() => rmSync(`${root}.away`, { recursive: true, force: true }));
    writeFile(root, 'stray.mkv');
    await h.scan();
    expect(h.roots()[0]?.status).toBe('offline');
    expect(h.progress()).toMatchObject([{ status: 'offline', warning: 'mass_missing', heldMissing: count, missing: 0 }]);
    expect(h.files().filter((f) => f.state === 'missing')).toEqual([]);

    rmSync(root, { recursive: true });
    renameSync(`${root}.away`, root);
    await h.scan();
    expect(h.roots()[0]?.status).toBe('online');
    expect(h.files().filter((f) => f.state === 'identified')).toHaveLength(count);
  });

  it('an emptied root whose files all moved to another root stays online', async () => {
    const docs = tempDir();
    const film = tempDir();
    writeFile(docs, 'Free Solo (2018)/Free Solo (2018).mkv');
    writeFile(film, 'Keep (2000)/Keep (2000).mkv');
    const h = await harness([
      { name: 'Documentari', path: docs, hint: 'movies' },
      { name: 'Film', path: film, hint: 'movies' },
    ]);
    await h.scan();
    const id = h.file('Free Solo (2018)/Free Solo (2018).mkv')?.id;
    renameSync(abs(docs, 'Free Solo (2018)'), abs(film, 'Free Solo (2018)'));
    await h.scan();
    expect(h.byId(id)).toMatchObject({ root: 'Film' });
    expect(h.roots()).toMatchObject([{ name: 'Documentari', status: 'online' }, { name: 'Film', status: 'online' }]);
  });

  it('never re-queues a probe that failed for good, except after the root was offline', async () => {
    const root = tempDir();
    writeFile(root, 'Broken (2020)/Broken (2020).mkv');
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    h.exec("UPDATE job SET state = 'failed', attempts = 3, last_error = 'ffprobe exit 1' WHERE type = 'analyzer.probe'");
    await h.scan();
    await h.scan();
    expect(h.probes()).toMatchObject([{ state: 'failed' }]);

    // While the root was offline the analyzer skipped its probes: the scan that sees it back queues them.
    h.exec("UPDATE library_root SET status = 'offline'");
    await h.scan();
    expect(h.probes()).toMatchObject([{ state: 'queued' }]);
  });

  it('waits for files that are still being copied', async () => {
    const root = tempDir();
    writeFile(root, 'Old (1999)/Old (1999).mkv');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(abs(root, 'Old (1999)/Old (1999).mkv'), old, old);
    writeFile(root, 'Copying (2024)/Copying (2024).mkv');
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }], 60_000);
    await h.scan();
    expect(h.files().map((f) => f.rel_path)).toEqual(['Old (1999)/Old (1999).mkv']);

    // A known file being rewritten is neither changed nor missing until it settles.
    writeFile(root, 'Old (1999)/Old (1999).mkv');
    await h.scan();
    expect(h.files().map((f) => [f.rel_path, f.state])).toEqual([['Old (1999)/Old (1999).mkv', 'discovered']]);
    expect(h.progress()).toMatchObject([{ unstable: 2, missing: 0, changed: 0 }]);
  });

  it('counts symbolic links without following or recording them', async (ctx) => {
    const root = tempDir();
    writeFile(root, 'Real (2001)/Real (2001).mkv');
    try {
      symlinkSync(abs(root, 'Real (2001)'), abs(root, 'Link (2001)'), 'junction'); // a junction needs no privilege on Windows
    } catch (err) {
      ctx.skip(`cannot create a link here: ${String(err)}`);
    }
    const h = await harness([{ name: 'Film', path: root, hint: 'movies' }]);
    await h.scan();
    expect(h.files().map((f) => f.rel_path)).toEqual(['Real (2001)/Real (2001).mkv']);
    expect(h.progress()).toMatchObject([{ symlinks: 1 }]);
  });
});

describe('scan requests', () => {
  it('uses one idempotent job per target, plus one follow-up while a scan runs', async () => {
    const h = await harness([{ name: 'Film', path: tempDir(), hint: 'movies' }]);
    const task = h.comp.periodic.find((p) => p.name === 'library.scan');
    expect(task).toMatchObject({ runAtStart: true, everyMs: 15 * 60_000 });
    const scanJobs = () => h.db.$client.prepare("SELECT idempotency_key AS key, state FROM job WHERE type = 'library.scan' ORDER BY idempotency_key").all();
    await task?.run();
    expect(scanJobs()).toEqual([{ key: scanJobKey(), state: 'queued' }]);

    h.exec("UPDATE job SET state = 'running' WHERE type = 'library.scan'"); // the scan is under way
    await task?.run();
    await task?.run();
    expect(scanJobs()).toEqual([
      { key: scanJobKey(), state: 'running' },
      { key: `${scanJobKey()}:next`, state: 'queued' },
    ]);
    expect(h.comp.jobTypes.get('library.scan')?.concurrency).toBe(1);
  });
});

describe('library roots', () => {
  it('keeps a root whose mount path changed, and never deletes unconfigured roots', async () => {
    const db = await openDb({ path: ':memory:' });
    cleanup.push(() => closeDb(db));
    const [film] = syncRoots(db, [{ name: 'Film', path: '/media/Film', hint: 'movies' }], 1).roots;
    const [moved] = syncRoots(db, [{ name: 'Film', path: '/mnt/nas/Film/', hint: 'movies' }], 2).roots;
    expect(moved).toMatchObject({ id: film?.id, mountPath: '/mnt/nas/Film' }); // trailing separator dropped

    const now = syncRoots(db, [{ name: 'Serie', path: '/media/Serie', hint: 'series' }], 3).roots;
    expect(now.map((r) => r.name)).toEqual(['Serie']);
    expect(db.$client.prepare('SELECT name, mount_path, status FROM library_root ORDER BY name').all()).toEqual([
      { name: 'Film', mount_path: '/mnt/nas/Film', status: 'offline' },
      { name: 'Serie', mount_path: '/media/Serie', status: 'online' },
    ]);
  });

  it('renames the root in the facts of its files', async () => {
    const root = tempDir();
    writeFile(root, 'Free Solo (2018)/Free Solo (2018).mkv');
    const h = await harness([{ name: 'Documentari', path: root, hint: 'movies' }]);
    await h.scan();
    const id = h.file('Free Solo (2018)/Free Solo (2018).mkv')?.id;
    h.analyzed(id);
    syncRoots(h.db, [{ name: 'Documentaries', path: root, hint: 'movies' }], 2);
    expect(factsOf(h.byId(id))?.location).toEqual({ rootName: 'Documentaries', relPath: 'Free Solo (2018)/Free Solo (2018).mkv' });
  });

  it('skips duplicate names, duplicate paths and nested roots: the first one wins', () => {
    const { accepted, skipped } = validateRoots([
      { name: 'Film', path: '/media/Film', hint: 'movies' },
      { name: 'film', path: '/media/Other', hint: 'movies' },
      { name: 'Copy', path: '/media/Film/', hint: 'movies' },
      { name: 'Inner', path: '/media/Film/Inner', hint: 'movies' },
      { name: 'Outer', path: '/media', hint: 'mixed' },
      { name: 'Serie', path: '/media2/Serie', hint: 'series' },
    ]);
    expect(accepted.map((s) => s.name)).toEqual(['Film', 'Serie']);
    expect(skipped.map((s) => [s.spec.name, s.reason, s.clashesWith])).toEqual([
      ['film', 'duplicate_name', 'Film'],
      ['Copy', 'duplicate_path', 'Film'],
      ['Inner', 'nested', 'Film'],
      ['Outer', 'nested', 'Film'],
    ]);
  });
});
