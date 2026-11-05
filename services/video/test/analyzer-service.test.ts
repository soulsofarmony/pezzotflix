// Analyzer writes (media_file, media_stream, chapter, identify job) with a fake ffprobe runner: no
// ffprobe or media needed. The probed file is a small dummy in a temp folder.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobContext } from '../src/app/module.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { FfprobeOutput, type ProbeRunner } from '../src/modules/analyzer/ffprobe.ts';
import { createAnalyzer } from '../src/modules/analyzer/service.ts';
import { enqueueJob } from '../src/modules/jobs/index.ts';
import { type MediaFacts, sidecarTrackId } from '../src/shared/media-facts.ts';

const br2049 = FfprobeOutput.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/analyzer-ffprobe-br2049.json', import.meta.url)), 'utf8')),
);
const REL = 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv';
const SIDECAR = 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.it.forced.srt';
const MAX = 3;

let db: Db;
let dir: string;
let probeImpl: () => Promise<FfprobeOutput>;
let frameSideData: () => Promise<string[]>;
let probes: number;
let logs: { level: number; msg: string }[];

const runner: ProbeRunner = {
  probe: () => {
    probes++;
    return probeImpl();
  },
  firstFrameSideData: () => frameSideData(),
};
const log = pino(
  { level: 'info' },
  new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(JSON.parse(chunk.toString()) as { level: number; msg: string });
      done();
    },
  }),
);
const ctx = (attempt = 1, signal = new AbortController().signal): JobContext => ({ jobId: 'j', attempt, log, signal });
const analyzer = () =>
  createAnalyzer({ db, now: () => 1000, jobs: () => ({ enqueue: (j) => enqueueJob(db, 1000, j) }), runner, maxAttempts: MAX });

const insertFile = (over: { state?: string; relPath?: string; rootStatus?: string } = {}) => {
  db.$client
    .prepare("INSERT INTO library_root (id, name, mount_path, hint, status, created_at) VALUES ('r1', 'Film', ?, 'movies', ?, 0)")
    .run(dir, over.rootStatus ?? 'online');
  db.$client
    .prepare("INSERT INTO media_file (id, root_id, rel_path, size_bytes, mtime_ms, state, created_at, updated_at) VALUES ('f1', 'r1', ?, 11, 1, ?, 0, 0)")
    .run(over.relPath ?? REL, over.state ?? 'discovered');
};
const file = () =>
  db.$client.prepare("SELECT state, container, duration_ms, bit_rate, facts, analyzed_at FROM media_file WHERE id = 'f1'").get() as {
    state: string;
    container: string | null;
    duration_ms: number | null;
    bit_rate: number | null;
    facts: string | null;
    analyzed_at: number | null;
  };
const facts = () => JSON.parse(file().facts ?? 'null') as MediaFacts | null;
const jobs = () => db.$client.prepare('SELECT type, payload, idempotency_key AS key FROM job').all() as { type: string; payload: string; key: string }[];

beforeEach(async () => {
  db = await openDb({ path: ':memory:' });
  dir = mkdtempSync(join(tmpdir(), 'pzf-analyzer-'));
  mkdirSync(join(dir, 'Blade Runner 2049 (2017)'));
  writeFileSync(join(dir, ...REL.split('/')), 'not a video');
  probeImpl = async () => br2049;
  frameSideData = async () => [];
  probes = 0;
  logs = [];
});
afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('analyzer.probe', () => {
  it('stores facts, streams and chapters, takes sidecars from the library, then enqueues identification', async () => {
    insertFile();
    db.$client
      .prepare("INSERT INTO external_subtitle (id, file_id, rel_path, language, is_forced, is_sdh, format) VALUES ('x1', 'f1', ?, 'ita', 1, 0, 'srt')")
      .run(SIDECAR);
    await analyzer().probe({ fileId: 'f1' }, ctx());

    const f = file();
    expect(f).toMatchObject({ state: 'analyzed', container: 'matroska', duration_ms: 30005, bit_rate: 99569471, analyzed_at: 1000 });
    expect(facts()?.location).toEqual({ rootName: 'Film', relPath: REL });
    expect(facts()?.sizeBytes).toBe(11); // fresh stat of the probed file
    expect(facts()?.sidecars).toEqual([{ id: sidecarTrackId(SIDECAR), relPath: SIDECAR, format: 'srt', language: 'ita', forced: true, sdh: false }]);
    expect(db.$client.prepare('SELECT id FROM external_subtitle').all()).toEqual([{ id: 'x1' }]); // rows belong to the library

    const streams = db.$client
      .prepare("SELECT stream_index AS i, type, codec, language, is_default AS d, is_forced AS f, is_sdh AS sdh, is_commentary AS c, attrs FROM media_stream WHERE file_id = 'f1' ORDER BY stream_index")
      .all() as { i: number; type: string; codec: string; language: string | null; d: number; f: number; sdh: number; c: number; attrs: string }[];
    expect(streams.map((s) => [s.i, s.type, s.codec, s.language, s.d, s.f, s.c])).toEqual([
      [0, 'video', 'hevc', null, 1, 0, 0],
      [1, 'audio', 'truehd', 'ita', 1, 0, 0],
      [2, 'audio', 'eac3', 'eng', 0, 0, 0],
      [3, 'audio', 'ac3', 'ita', 0, 0, 1],
      [4, 'subtitle', 'hdmv_pgs_subtitle', 'ita', 0, 1, 0],
      [5, 'subtitle', 'hdmv_pgs_subtitle', 'ita', 0, 0, 0],
      [6, 'subtitle', 'subrip', 'ita', 0, 0, 0],
      [7, 'subtitle', 'ass', 'eng', 0, 0, 0],
    ]);
    expect(JSON.parse(streams[0]!.attrs)).toMatchObject({ width: 3840, hdr: 'HDR10', hdrFallback: [] });
    expect(JSON.parse(streams[1]!.attrs)).toMatchObject({ lossless: true, channels: 6, objectAudio: null });
    expect(JSON.parse(streams[4]!.attrs)).toEqual({ kind: 'image', sdh: false, eventCount: null });

    const chapters = db.$client.prepare("SELECT chapter_index AS i, title, start_ms AS s, end_ms AS e FROM chapter WHERE file_id = 'f1'").all();
    expect(chapters).toEqual([
      { i: 0, title: 'Capitolo 1', s: 0, e: 10000 },
      { i: 1, title: 'Capitolo 2', s: 10000, e: 20000 },
      { i: 2, title: 'Capitolo 3', s: 20000, e: 30000 },
    ]);
    expect(jobs()).toEqual([{ type: 'identifier.identify', payload: '{"fileId":"f1"}', key: 'identify:f1' }]);
  });

  it('re-analysis keeps later states and does not re-identify', async () => {
    insertFile();
    await analyzer().probe({ fileId: 'f1' }, ctx());
    db.$client.prepare("UPDATE media_file SET state = 'identified' WHERE id = 'f1'").run();
    db.$client.prepare("UPDATE job SET state = 'done'").run();

    await analyzer().probe({ fileId: 'f1' }, ctx());
    expect(file().state).toBe('identified');
    expect(db.$client.prepare('SELECT count(*) AS n FROM media_stream').get()).toEqual({ n: 8 });
    expect(db.$client.prepare('SELECT state FROM job').all()).toEqual([{ state: 'done' }]);
  });

  it('stores the current location when a scan moved the file during the probe', async () => {
    insertFile();
    probeImpl = async () => {
      db.$client.prepare("UPDATE media_file SET rel_path = 'Moved (2017)/Moved (2017).mkv' WHERE id = 'f1'").run();
      return br2049;
    };
    await analyzer().probe({ fileId: 'f1' }, ctx());
    expect(facts()?.location).toEqual({ rootName: 'Film', relPath: 'Moved (2017)/Moved (2017).mkv' });
  });

  describe('HDR10+ first-frame probe', () => {
    const frameFails = () => {
      frameSideData = async () => {
        throw new Error('ffprobe timed out');
      };
    };
    const video = () => facts()?.streams[0];

    it('detects HDR10+ from the first frame', async () => {
      insertFile();
      frameSideData = async () => ['Mastering display metadata', 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)'];
      await analyzer().probe({ fileId: 'f1' }, ctx());
      expect(video()).toMatchObject({ hdr: 'HDR10+', hdrFallback: ['HDR10'] });
    });

    it('fails the attempt so the job retries, and stores nothing', async () => {
      insertFile();
      frameFails();
      await expect(analyzer().probe({ fileId: 'f1' }, ctx(1))).rejects.toThrow(/first-frame probe failed: ffprobe timed out/);
      await expect(analyzer().probe({ fileId: 'f1' }, ctx(MAX - 1))).rejects.toThrow(/first-frame probe failed/);
      expect(file()).toMatchObject({ state: 'discovered', facts: null });
      expect(jobs()).toEqual([]);
    });

    it('on the last attempt records HDR10 with a warning', async () => {
      insertFile();
      frameFails();
      await analyzer().probe({ fileId: 'f1' }, ctx(MAX));
      expect(video()).toMatchObject({ hdr: 'HDR10', hdrFallback: [] });
      expect(file().state).toBe('analyzed');
      expect(logs.some((l) => l.level === 40 && l.msg.includes('first-frame probe failed'))).toBe(true);
    });

    it('never downgrades a stream already recorded as HDR10+', async () => {
      insertFile();
      frameSideData = async () => ['HDR Dynamic Metadata SMPTE2094-40 (HDR10+)'];
      await analyzer().probe({ fileId: 'f1' }, ctx());
      frameFails();
      await analyzer().probe({ fileId: 'f1' }, ctx(MAX)); // e.g. a re-probe after a library change
      expect(video()).toMatchObject({ hdr: 'HDR10+', hdrFallback: ['HDR10'] });
    });

    it('rethrows when the job is aborted, even on the last attempt', async () => {
      insertFile();
      const abort = new AbortController();
      frameSideData = async () => {
        abort.abort();
        throw new Error('ffprobe canceled');
      };
      await expect(analyzer().probe({ fileId: 'f1' }, ctx(MAX, abort.signal))).rejects.toThrow('ffprobe canceled');
      expect(file().facts).toBeNull();
    });
  });

  it('logs a probe that failed for good, and leaves the file waiting', async () => {
    insertFile();
    probeImpl = async () => {
      throw new Error('ffprobe exit 1: Invalid data found when processing input');
    };
    await expect(analyzer().probe({ fileId: 'f1' }, ctx(1))).rejects.toThrow(/Invalid data/);
    expect(logs.filter((l) => l.level >= 50)).toEqual([]);
    await expect(analyzer().probe({ fileId: 'f1' }, ctx(MAX))).rejects.toThrow(/Invalid data/);
    expect(logs.filter((l) => l.level === 50)).toMatchObject([{ msg: 'probe failed for good', fileId: 'f1', attempts: MAX }]);
    expect(file()).toMatchObject({ state: 'discovered', facts: null });
  });

  it.each([
    ['missing file', { state: 'missing' }],
    ['offline root', { rootStatus: 'offline' }],
  ])('skips a %s without probing', async (_label, over) => {
    insertFile(over);
    await analyzer().probe({ fileId: 'f1' }, ctx());
    expect(probes).toBe(0);
    expect(file().facts).toBeNull();
    expect(jobs()).toEqual([]);
  });

  it('completes quietly for an unknown file and rejects unsafe paths', async () => {
    await analyzer().probe({ fileId: 'nope' }, ctx());
    insertFile({ relPath: '../outside.mkv' });
    await expect(analyzer().probe({ fileId: 'f1' }, ctx())).rejects.toThrow(/unsafe media path/);
    expect(probes).toBe(0);
  });

  it('rejects an invalid payload', async () => {
    await expect(analyzer().probe({ file: 'f1' }, ctx())).rejects.toThrow();
  });
});
