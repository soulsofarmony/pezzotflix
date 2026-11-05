// Library → analyzer wiring through compose(), without ffprobe or media: the job type and payload the
// library enqueues are the ones the analyzer handles, and sidecars flow from the scan into the facts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { analyzerModule } from '../src/modules/analyzer/index.ts';
import { FfprobeOutput, type ProbeRunner } from '../src/modules/analyzer/ffprobe.ts';
import { createEventsModule } from '../src/modules/events/index.ts';
import { createJobRunner, createJobsModule } from '../src/modules/jobs/index.ts';
import { libraryModule } from '../src/modules/library/index.ts';
import { JOB_TYPES } from '../src/shared/job-types.ts';
import { type MediaFacts, sidecarTrackId } from '../src/shared/media-facts.ts';

const log = pino({ level: 'silent' });
const fixture = FfprobeOutput.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/analyzer-ffprobe-dark.json', import.meta.url)), 'utf8')),
);
const runner: ProbeRunner = { probe: async () => fixture, firstFrameSideData: async () => [] };

let db: Db | undefined;
let root: string | undefined;
let dataDir: string | undefined;
afterEach(() => {
  if (db) closeDb(db);
  for (const d of [root, dataDir]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('library → analyzer', () => {
  it('scans, probes and queues identification with the shared job types and payloads', async () => {
    root = mkdtempSync(join(tmpdir(), 'pzf-wiring-'));
    const put = (rel: string, content = 'x') => {
      const p = join(root ?? '', ...rel.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    };
    put('Dark (2017)/Season 01/Dark - S01E01 - Segreti.mkv', 'not a video');
    put('Dark (2017)/Season 01/Dark - S01E01 - Segreti.it.forced.srt');
    put('Dark (2017)/Season 01/Dark - S01E02.mkv', 'not a video either');

    dataDir = mkdtempSync(join(tmpdir(), 'pzf-wiring-data-'));
    db = await openDb({ path: ':memory:' });
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      LIBRARY_ROOTS: JSON.stringify([{ name: 'Serie', path: root, hint: 'series' }]),
    });
    const comp = compose({
      config,
      db,
      log,
      factories: [createEventsModule, createJobsModule, libraryModule({ stableAfterMs: 0 }), analyzerModule({ runner })],
    });
    for (const m of comp.modules) await m.start?.();
    expect(comp.jobTypes.get(JOB_TYPES.analyzerProbe)).toMatchObject({ concurrency: 1, maxAttempts: 3 });
    expect(comp.jobTypes.get(JOB_TYPES.libraryScan)).toMatchObject({ concurrency: 1 });

    const jobRunner = createJobRunner({ db, log, jobTypes: comp.jobTypes, periodic: comp.periodic });
    await comp.periodic.find((p) => p.name === JOB_TYPES.libraryScan)?.run();
    await jobRunner.drain();
    await jobRunner.stop();

    const files = db.$client.prepare('SELECT id, rel_path, state, facts FROM media_file ORDER BY rel_path').all() as {
      id: string;
      rel_path: string;
      state: string;
      facts: string;
    }[];
    expect(files.map((f) => [f.rel_path, f.state])).toEqual([
      ['Dark (2017)/Season 01/Dark - S01E01 - Segreti.mkv', 'analyzed'],
      ['Dark (2017)/Season 01/Dark - S01E02.mkv', 'analyzed'],
    ]);
    const srt = 'Dark (2017)/Season 01/Dark - S01E01 - Segreti.it.forced.srt';
    expect((JSON.parse(files[0]?.facts ?? '{}') as MediaFacts).sidecars).toEqual([
      { id: sidecarTrackId(srt), relPath: srt, format: 'srt', language: 'ita', forced: true, sdh: false },
    ]);
    expect((JSON.parse(files[1]?.facts ?? '{}') as MediaFacts).sidecars).toEqual([]);

    const jobs = db.$client.prepare('SELECT type, payload, state FROM job ORDER BY type, payload').all();
    expect(jobs).toEqual([
      ...files.map((f) => ({ type: JOB_TYPES.analyzerProbe, payload: JSON.stringify({ fileId: f.id }), state: 'done' })),
      ...files.map((f) => ({ type: JOB_TYPES.identifierIdentify, payload: JSON.stringify({ fileId: f.id }), state: 'queued' })),
      { type: JOB_TYPES.libraryScan, payload: '{}', state: 'done' },
    ].sort((a, b) => (a.type + a.payload < b.type + b.payload ? -1 : 1)));
  });
});
