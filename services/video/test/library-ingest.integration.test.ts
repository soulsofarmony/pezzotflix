// Ingest integration: scan → probe on the S1 sample library with real ffprobe, through compose().
// Needs ffprobe (FFPROBE_PATH or PATH) and the samples (PZF_MEDIA_SAMPLES, default media-samples/library
// of this checkout); skipped with a message otherwise. Media are only read, never copied.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { createFfprobeRunner } from '../src/modules/analyzer/ffprobe.ts';
import { createAnalyzerModule } from '../src/modules/analyzer/index.ts';
import { createEventsModule } from '../src/modules/events/index.ts';
import { createJobRunner, createJobsModule } from '../src/modules/jobs/index.ts';
import { libraryModule } from '../src/modules/library/index.ts';
import { type AudioStreamFacts, type MediaFacts, sidecarTrackId, type SubtitleStreamFacts, type VideoStreamFacts } from '../src/shared/media-facts.ts';

const SAMPLES =
  process.env.PZF_MEDIA_SAMPLES ?? resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'media-samples', 'library');
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

const haveSamples = existsSync(join(SAMPLES, 'movies')) && existsSync(join(SAMPLES, 'series'));
const haveFfprobe = haveSamples && (await execa(FFPROBE, ['-version'], { reject: false })).exitCode === 0;
const skipReason = !haveSamples
  ? `sample library not found at ${SAMPLES} (set PZF_MEDIA_SAMPLES)`
  : !haveFfprobe
    ? `ffprobe not runnable as "${FFPROBE}" (set FFPROBE_PATH or add it to PATH)`
    : null;
// Straight to stderr: the default reporter drops console output of fully skipped files.
if (skipReason) process.stderr.write(`[library-ingest] skipped: ${skipReason}\n`);

const log = pino({ level: 'silent' });
let db: Db;
let dataDir: string | undefined;

const BR2049 = 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv';
const TRAILER = 'Blade Runner 2049 (2017)/extras/Trailer.mkv';
const DUNE = 'Dune (2021)/Dune.2021.2160p.UHD.BluRay.REMUX.DV.HDR.mkv';
const BUONO = 'Il Buono, il Brutto, il Cattivo (1966)/Il.Buono.il.Brutto.il.Cattivo.1966.1080p.BluRay.REMUX.mkv';
const LONG = 'Long Test (2024)/Long Test (2024) - 2160p.mkv';
const BDMV = 'misc/BDMV_DISC1_t00.mkv';
const OPPENHEIMER = 'Oppenheimer (2023)/Oppenheimer (2023).mkv';
const DARK1 = 'Dark (2017)/Season 01/Dark - S01E01 - Segreti.mkv';
const DARK2 = 'Dark (2017)/Season 01/Dark - S01E02-E03.mkv';
const DARK1_SRT = 'Dark (2017)/Season 01/Dark - S01E01 - Segreti.it.forced.srt';

interface FileRow {
  id: string;
  root: string;
  rel_path: string;
  state: string;
  container: string | null;
  duration_ms: number | null;
  fingerprint: string | null;
  facts: string | null;
}
const rows = () =>
  db.$client
    .prepare(
      'SELECT f.id, r.name AS root, f.rel_path, f.state, f.container, f.duration_ms, f.fingerprint, f.facts FROM media_file f JOIN library_root r ON r.id = f.root_id ORDER BY r.name, f.rel_path',
    )
    .all() as FileRow[];
const row = (relPath: string): FileRow => {
  const r = rows().find((x) => x.rel_path === relPath);
  if (!r) throw new Error(`no media_file for ${relPath}`);
  return r;
};
const facts = (relPath: string): MediaFacts => JSON.parse(row(relPath).facts ?? 'null') as MediaFacts;
const vid = (relPath: string) => facts(relPath).streams.find((s): s is VideoStreamFacts => s.type === 'video');
const audio = (relPath: string) => facts(relPath).streams.filter((s): s is AudioStreamFacts => s.type === 'audio');
const subs = (relPath: string) => facts(relPath).streams.filter((s): s is SubtitleStreamFacts => s.type === 'subtitle');

describe.skipIf(skipReason !== null)('ingest of the sample library (scan → probe, real ffprobe)', () => {
  beforeAll(async () => {
    db = await openDb({ path: ':memory:' });
    dataDir = mkdtempSync(join(tmpdir(), 'pzf-ingest-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      FFPROBE_PATH: FFPROBE,
      LIBRARY_ROOTS: JSON.stringify([
        { name: 'Film', path: join(SAMPLES, 'movies'), hint: 'movies' },
        { name: 'Serie', path: join(SAMPLES, 'series'), hint: 'series' },
      ]),
    });
    const comp = compose({
      config,
      db,
      log,
      factories: [createEventsModule, createJobsModule, libraryModule({ stableAfterMs: 0 }), createAnalyzerModule],
    });
    for (const m of comp.modules) await m.start?.();
    const runner = createJobRunner({ db, log, jobTypes: comp.jobTypes, periodic: comp.periodic });
    await comp.periodic.find((p) => p.name === 'library.scan')?.run();
    await runner.drain(); // scan, then every probe; identifier.identify has no handler yet and stays queued
    await runner.stop();
  }, 180_000);
  afterAll(() => {
    if (db) closeDb(db);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('records and analyses every video file of both roots', () => {
    expect(rows().map((r) => [r.root, r.rel_path, r.state])).toEqual([
      ['Film', BR2049, 'analyzed'],
      ['Film', TRAILER, 'analyzed'],
      ['Film', DUNE, 'analyzed'],
      ['Film', BUONO, 'analyzed'],
      ['Film', LONG, 'analyzed'],
      ['Film', OPPENHEIMER, 'analyzed'], // binary collation: uppercase sorts before "misc"
      ['Film', BDMV, 'analyzed'],
      ['Serie', DARK1, 'analyzed'],
      ['Serie', DARK2, 'analyzed'],
    ]);
    for (const r of rows()) {
      expect(r.container).toBe('matroska');
      expect(r.fingerprint).toMatch(/^v1:\d+:[0-9a-f]{64}$/);
      expect(facts(r.rel_path).location).toEqual({ rootName: r.root, relPath: r.rel_path });
    }
    expect(row(LONG).duration_ms).toBe(300_000);
    expect(row(BR2049).duration_ms).toBe(30_005);
  });

  it('normalises streams, chapters and sidecars into their tables', () => {
    const count = (sql: string, ...a: unknown[]) => (db.$client.prepare(sql).get(...a) as { n: number }).n;
    const streamsOf = (rel: string) => count('SELECT count(*) AS n FROM media_stream WHERE file_id = ?', row(rel).id);
    const chaptersOf = (rel: string) => count('SELECT count(*) AS n FROM chapter WHERE file_id = ?', row(rel).id);
    expect([BR2049, TRAILER, DUNE, BUONO, LONG, BDMV, OPPENHEIMER, DARK1, DARK2].map(streamsOf)).toEqual([8, 2, 4, 4, 3, 2, 2, 4, 2]);
    expect([BR2049, TRAILER, DUNE, BUONO, LONG, BDMV, OPPENHEIMER, DARK1, DARK2].map(chaptersOf)).toEqual([3, 3, 3, 3, 0, 3, 3, 3, 3]);
    expect(db.$client.prepare('SELECT title, start_ms, end_ms FROM chapter WHERE file_id = ? ORDER BY chapter_index').all(row(BR2049).id)).toEqual([
      { title: 'Capitolo 1', start_ms: 0, end_ms: 10000 },
      { title: 'Capitolo 2', start_ms: 10000, end_ms: 20000 },
      { title: 'Capitolo 3', start_ms: 20000, end_ms: 30000 },
    ]);

    const flagged = db.$client
      .prepare(
        'SELECT f.rel_path AS file, s.stream_index AS i, s.is_forced AS forced, s.is_sdh AS sdh, s.is_commentary AS commentary FROM media_stream s JOIN media_file f ON f.id = s.file_id WHERE s.is_forced = 1 OR s.is_sdh = 1 OR s.is_commentary = 1 ORDER BY f.rel_path, s.stream_index',
      )
      .all();
    expect(flagged).toEqual([
      { file: BR2049, i: 3, forced: 0, sdh: 0, commentary: 1 },
      { file: BR2049, i: 4, forced: 1, sdh: 0, commentary: 0 },
      { file: DUNE, i: 3, forced: 1, sdh: 0, commentary: 0 },
      { file: BUONO, i: 3, forced: 0, sdh: 1, commentary: 0 },
    ]);

    expect(db.$client.prepare('SELECT file_id, rel_path, language, is_forced, is_sdh, format FROM external_subtitle').all()).toEqual([
      { file_id: row(DARK1).id, rel_path: DARK1_SRT, language: 'ita', is_forced: 1, is_sdh: 0, format: 'srt' },
    ]);
    expect(facts(DARK1).sidecars).toEqual([
      { id: sidecarTrackId(DARK1_SRT), relPath: DARK1_SRT, format: 'srt', language: 'ita', forced: true, sdh: false },
    ]);
    expect(facts(DARK2).sidecars).toEqual([]);
  });

  it('detects HDR10, Dolby Vision with and without fallback, and SDR', () => {
    expect(vid(BR2049)).toMatchObject({ codec: 'hevc', width: 3840, height: 2160, bitDepth: 10, hdr: 'HDR10', hdrFallback: [], dolbyVision: null });
    expect(vid(LONG)).toMatchObject({ width: 3840, hdr: 'HDR10', hdrFallback: [] });
    expect(vid(DUNE)).toMatchObject({
      hdr: 'DV',
      hdrFallback: ['HDR10'],
      dolbyVision: { profile: 8, level: 9, blCompatId: 1, hasEnhancementLayer: false, rpuPresent: true },
    });
    expect(vid(OPPENHEIMER)).toMatchObject({ hdr: 'DV', hdrFallback: [], dolbyVision: { profile: 5, blCompatId: 0 } });
    for (const rel of [BUONO, TRAILER, BDMV, DARK1, DARK2]) {
      expect(vid(rel)).toMatchObject({ codec: 'h264', width: 1920, height: 1080, bitDepth: 8, hdr: 'SDR', dolbyVision: null });
    }
  });

  it('reads the first-frame side data the HDR10+ check relies on', async () => {
    // Dune's first frame carries HDR10 static metadata but no SMPTE 2094-40, so it stays HDR10/DV.
    const sideData = await createFfprobeRunner(FFPROBE).firstFrameSideData(join(SAMPLES, 'movies', ...DUNE.split('/')), 0, new AbortController().signal);
    expect(sideData).toContain('Mastering display metadata');
    expect(sideData.some((t) => /2094-40|HDR10\+/i.test(t))).toBe(false);
  });

  it('detects lossless audio, commentary, languages and subtitle kinds', () => {
    expect(audio(BR2049).map((a) => [a.codec, a.language, a.lossless, a.commentary, a.default])).toEqual([
      ['truehd', 'ita', true, false, true],
      ['eac3', 'eng', false, false, false],
      ['ac3', 'ita', false, true, false],
    ]);
    expect(audio(DUNE).map((a) => [a.codec, a.language, a.lossless])).toEqual([['truehd', 'eng', true], ['eac3', 'ita', false]]);
    expect(audio(LONG).map((a) => [a.codec, a.language, a.lossless, a.channels])).toEqual([['truehd', 'ita', true, 6], ['eac3', 'eng', false, 6]]);
    expect(audio(OPPENHEIMER)).toMatchObject([{ codec: 'flac', language: 'eng', lossless: true, channels: 6 }]);
    expect(audio(BUONO)).toMatchObject([{ codec: 'dts', profile: 'DTS', lossless: false }, { codec: 'ac3', language: 'ita' }]);
    expect(audio(TRAILER)).toMatchObject([{ codec: 'aac', language: 'eng', channels: 2, lossless: false }]);
    expect(audio(BDMV)).toMatchObject([{ codec: 'ac3', language: null }]);
    expect(audio(DARK1).map((a) => a.language)).toEqual(['ger', 'ita']);
    for (const rel of [BR2049, DUNE, LONG, OPPENHEIMER, BUONO]) {
      expect(audio(rel).every((a) => a.objectAudio === null)).toBe(true); // no Atmos/DTS:X in the samples
    }

    expect(subs(BR2049).map((s) => [s.codec, s.kind, s.language, s.forced, s.sdh])).toEqual([
      ['hdmv_pgs_subtitle', 'image', 'ita', true, false],
      ['hdmv_pgs_subtitle', 'image', 'ita', false, false],
      ['subrip', 'text', 'ita', false, false],
      ['ass', 'text', 'eng', false, false],
    ]);
    expect(subs(DUNE)).toMatchObject([{ codec: 'subrip', kind: 'text', forced: true }]);
    expect(subs(BUONO)).toMatchObject([{ kind: 'image', language: 'eng', sdh: true, forced: false }]);
    expect(subs(DARK1)).toMatchObject([{ kind: 'image', language: 'ita' }]);
  });

  it('enqueues identifier.identify for every analysed file', () => {
    const jobs = db.$client
      .prepare("SELECT payload, state, idempotency_key AS key FROM job WHERE type = 'identifier.identify' ORDER BY payload")
      .all() as { payload: string; state: string; key: string }[];
    const ids = rows().map((r) => r.id).sort();
    expect(jobs.map((j) => (JSON.parse(j.payload) as { fileId: string }).fileId).sort()).toEqual(ids);
    expect(jobs.every((j) => j.state === 'queued' && j.key === `identify:${(JSON.parse(j.payload) as { fileId: string }).fileId}`)).toBe(true);
    const probeStates = db.$client.prepare("SELECT DISTINCT state FROM job WHERE type IN ('library.scan', 'analyzer.probe')").all();
    expect(probeStates).toEqual([{ state: 'done' }]);
  });
});
