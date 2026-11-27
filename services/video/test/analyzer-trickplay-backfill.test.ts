// Startup backfill of the seek-bar previews (ADR 0009 D5): only files with video, present, not ignored, on an online root,
// with no delivery.trickplay job under the current key. A job done, failed or interrupted on its last attempt
// with that key is never queued again; an older parameter version or content is.
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import type { ProbeRunner } from '../src/modules/analyzer/ffprobe.ts';
import { createAnalyzer, TRICKPLAY_BACKFILL_PRIORITY } from '../src/modules/analyzer/service.ts';
import { createJobRunner, enqueueJob } from '../src/modules/jobs/index.ts';
import { JOB_INTERRUPTED_ERROR, trickplayJobKey } from '../src/shared/job-types.ts';
import type { MediaFacts, StreamFacts } from '../src/shared/media-facts.ts';

let db: Db;
const runner: ProbeRunner = {
  probe: () => Promise.reject(new Error('not used')),
  firstFrameSideData: () => Promise.reject(new Error('not used')),
};
const analyzer = (trickplay = true) => createAnalyzer({ db, now: () => 1000, jobs: () => ({ enqueue: (j) => enqueueJob(db, 1000, j) }), runner, maxAttempts: 3, trickplay });

const VIDEO: StreamFacts = {
  type: 'video', index: 0, codec: 'hevc', profile: 'Main 10', language: null, title: null, default: true, forced: false,
  width: 3840, height: 1600, frameRate: 23.976, bitDepth: 10, pixFmt: 'yuv420p10le', colorTransfer: 'smpte2084', colorPrimaries: 'bt2020',
  hdr: 'DV', hdrFallback: ['HDR10'], dolbyVision: { profile: 8, level: 6, blCompatId: 1, hasEnhancementLayer: false, rpuPresent: true }, bitRate: null, attachedPic: false,
};
const COVER: StreamFacts = { ...VIDEO, index: 0, codec: 'mjpeg', attachedPic: true, hdr: 'SDR', hdrFallback: [], dolbyVision: null };
const AUDIO: StreamFacts = {
  type: 'audio', index: 1, codec: 'ac3', profile: null, language: 'ita', title: null, default: true, forced: false,
  channels: 6, channelLayout: '5.1(side)', sampleRate: 48000, bitRate: 640000, lossless: false, objectAudio: null, commentary: false, audioDescription: false,
};

const factsOf = (id: string, streams: StreamFacts[]): MediaFacts => ({
  location: { rootName: 'Film', relPath: `${id}/${id}.mkv` },
  sizeBytes: 1000,
  mtimeMs: 77,
  container: 'matroska',
  durationMs: 7_200_000,
  bitRate: null,
  streams,
  chapters: [],
  sidecars: [],
  analyzerVersion: 2,
});

const insertRoot = (id: string, status: string) =>
  db.$client.prepare("INSERT INTO library_root (id, name, mount_path, hint, status, created_at) VALUES (?, ?, ?, 'movies', ?, 0)").run(id, id === 'r1' ? 'Film' : 'Other', `/media/${id}`, status);
const insertFile = (id: string, o: { root?: string; state?: string; streams?: StreamFacts[] | null } = {}) =>
  db.$client
    .prepare('INSERT INTO media_file (id, root_id, rel_path, size_bytes, mtime_ms, state, facts, created_at, updated_at) VALUES (?, ?, ?, 1000, 77, ?, ?, 0, 0)')
    .run(id, o.root ?? 'r1', `${id}/${id}.mkv`, o.state ?? 'identified', o.streams === null ? null : JSON.stringify(factsOf(id, o.streams ?? [VIDEO, AUDIO])));
const setJob = (key: string, state: string, lastError: string | null = null) =>
  db.$client
    .prepare("INSERT INTO job (id, type, payload, priority, state, attempts, run_at, idempotency_key, last_error, created_at, updated_at) VALUES (?, 'delivery.trickplay', '{}', 100, ?, 3, 0, ?, ?, 0, 0)")
    .run(`j-${key}`, state, key, lastError);
const queued = () =>
  (db.$client.prepare("SELECT idempotency_key AS key, priority, payload FROM job WHERE type = 'delivery.trickplay' AND state = 'queued' ORDER BY key").all() as { key: string; priority: number; payload: string }[]);

beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
  insertRoot('r1', 'online');
  insertRoot('r2', 'offline');
});
afterEach(() => closeDb(db));

describe('trickplay backfill', () => {
  it('queues only the files that never had a job for their current content', () => {
    insertFile('new');
    insertFile('done');
    setJob(trickplayJobKey('done', 1000, 77), 'done');
    insertFile('failed');
    setJob(trickplayJobKey('failed', 1000, 77), 'failed', 'trickplay: timed out');
    insertFile('crash');
    setJob(trickplayJobKey('crash', 1000, 77), 'failed', `${JOB_INTERRUPTED_ERROR} (3 of 3): the service stopped while it ran, twice in a row`);
    insertFile('running');
    setJob(trickplayJobKey('running', 1000, 77), 'running');
    insertFile('oldversion');
    setJob('trickplay:v0:oldversion:1000:77', 'done');
    insertFile('changed');
    setJob(trickplayJobKey('changed', 999, 77), 'done');
    insertFile('missing', { state: 'missing' });
    insertFile('removed', { state: 'removed' });
    insertFile('ignored', { state: 'ignored' });
    insertFile('offline', { root: 'r2' });
    insertFile('audio', { streams: [AUDIO] });
    insertFile('cover', { streams: [COVER, AUDIO] });
    insertFile('unprobed', { state: 'discovered', streams: null });

    expect(analyzer().backfillTrickplay()).toBe(3);
    const rows = queued();
    expect(rows.map((r) => r.key)).toEqual([trickplayJobKey('changed', 1000, 77), trickplayJobKey('new', 1000, 77), trickplayJobKey('oldversion', 1000, 77)]);
    expect(rows.every((r) => r.priority === TRICKPLAY_BACKFILL_PRIORITY)).toBe(true);
    expect(JSON.parse(rows[1]!.payload)).toEqual({
      fileId: 'new',
      location: { rootName: 'Film', relPath: 'new/new.mkv' },
      sizeBytes: 1000,
      mtimeMs: 77,
      container: 'matroska',
      videoStreamIndex: 0,
      durationMs: 7_200_000,
      width: 3840,
      height: 1600,
      hdr: 'DV',
      hdrFallback: ['HDR10'],
      dolbyVisionProfile: 8,
    });
    // The other states are untouched.
    expect(db.$client.prepare("SELECT idempotency_key AS k, state FROM job WHERE idempotency_key LIKE 'trickplay:v1:%' AND state <> 'queued' ORDER BY k").all()).toEqual([
      { k: trickplayJobKey('changed', 999, 77), state: 'done' },
      { k: trickplayJobKey('crash', 1000, 77), state: 'failed' },
      { k: trickplayJobKey('done', 1000, 77), state: 'done' },
      { k: trickplayJobKey('failed', 1000, 77), state: 'failed' },
      { k: trickplayJobKey('running', 1000, 77), state: 'running' },
    ]);
  });

  it('a second start queues nothing more, also once the jobs ran', async () => {
    insertFile('a');
    expect(analyzer().backfillTrickplay()).toBe(1);
    expect(analyzer().backfillTrickplay()).toBe(0);
    // The job runs and fails for good: the next start leaves it alone.
    const jobRunner = createJobRunner({
      db,
      log: pino({ level: 'silent' }),
      jobTypes: new Map([['delivery.trickplay', { concurrency: 1, maxAttempts: 1, handler: () => Promise.reject(new Error('boom')) }]]),
      periodic: [],
      now: () => 1000,
    });
    await jobRunner.drain();
    expect(db.$client.prepare("SELECT state FROM job WHERE type = 'delivery.trickplay'").all()).toEqual([{ state: 'failed' }]);
    expect(analyzer().backfillTrickplay()).toBe(0);
  });

  it('nothing while the previews are turned off', () => {
    insertFile('a');
    expect(analyzer(false).backfillTrickplay()).toBe(0);
    expect(queued()).toEqual([]);
  });
});
