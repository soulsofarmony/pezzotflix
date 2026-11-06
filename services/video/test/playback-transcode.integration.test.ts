// The Session Manager over the real Stream Delivery and real ffmpeg (F1b.4, doc 04 §6.3 and §8, ADR 0003
// D7): re-plans into and out of the software Transcode with the same sessionId, the old stream stopped
// each time, and a start that waits for an embedded text track to be extracted for burn-in (503
// STREAM_PREPARING with Retry-After, then the Transcode). Catalog, profiles and events are fakes; the
// media is a fixture generated in a temp dir. Skipped with a message when ffmpeg/ffprobe or libass are missing.
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- response bodies are untyped JSON, checked against the contract */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../src/app/compose.ts';
import { loadConfig } from '../src/app/config.ts';
import { buildServer } from '../src/app/server.ts';
import { closeDb, type Db, openDb } from '../src/db/index.ts';
import { deliveryModule } from '../src/modules/delivery/index.ts';
import { playbackModule } from '../src/modules/playback/index.ts';
import type { MediaFacts } from '../src/shared/media-facts.ts';
import type { ClientCapabilities, PlayableItem } from '../src/shared/ports.ts';
import { contractErrors } from './helpers/contract.ts';
import { factsOf, ffmpeg, FFMPEG, FFPROBE, HAVE_FFMPEG, skipNotice, tempDir } from './helpers/delivery-media.ts';
import { chrome } from './playback-fixtures.ts';
import { FakeCatalog, FakeProfiles, P1 } from './playback-harness.ts';

const HAVE_LIBASS = HAVE_FFMPEG && (await execa(FFMPEG, ['-hide_banner', '-h', 'filter=subtitles'], { reject: false })).stdout.includes('subtitles');
const skip = skipNotice('playback-transcode', false) ?? (HAVE_LIBASS ? null : 'ffmpeg has no subtitles filter (libass)');
if (skip && HAVE_FFMPEG) process.stderr.write(`[playback-transcode] skipped: ${skip}\n`);

const ITEM = '01936f0e-0000-7000-8000-0000000000c1';
const FILE = '01936f0e-0000-7000-8000-000000000fc1';
const SIDECAR = 'x:1a2b3c4d';
const SESSIONS = '/video/api/v1/playback/sessions';

/** A browser that renders no separate subtitles: every subtitle it shows is burned in (Transcode, ≤ 1080p). */
const noSubtitles = (): ClientCapabilities => ({ ...chrome(), subtitles: { text: [], image: [], ass: false } });

describe.skipIf(skip !== null)('playback: Session Manager over the real delivery and the software Transcode', () => {
  let lib: string;
  let work: string;
  let dataDir: string;
  let db: Db;
  let comp: Composition;
  let app: FastifyInstance;
  let facts: MediaFacts;
  const catalog = new FakeCatalog();
  const profiles = new FakeProfiles();
  const events: { type: string; payload: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    [lib, work, dataDir] = [tempDir('pzf-pt-lib-'), tempDir('pzf-pt-work-'), tempDir('pzf-pt-data-')];
    mkdirSync(join(lib, 'f24'), { recursive: true });
    const srt = '1\n00:00:00,500 --> 00:00:19,000\nPEZZOTFLIX\n';
    writeFileSync(join(work, 'subs.srt'), srt);
    writeFileSync(join(lib, 'f24', 'f24.en.srt'), srt);
    // H.264 1080p + AC-3 5.1 (no browser decodes it: Direct Stream) + an embedded SRT in Italian (s2).
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24000/1001',
      '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
      '-i', join(work, 'subs.srt'),
      '-t', '20',
      '-map', '0:v', '-map', '1:a', '-map', '2:s',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-bf', '2',
      '-c:a', 'ac3', '-b:a', '384k', '-ac', '6', '-metadata:s:a:0', 'language=ita',
      '-c:s', 'srt', '-metadata:s:s:0', 'language=ita',
      join(lib, 'f24', 'f24.mkv'),
    ]);
    const probed = await factsOf(join(lib, 'f24', 'f24.mkv'), { rootName: 'Film', relPath: 'f24/f24.mkv' });
    facts = { ...probed, sidecars: [{ id: SIDECAR, relPath: 'f24/f24.en.srt', format: 'srt', language: 'eng', forced: false, sdh: false }] };
    const item: PlayableItem = { itemId: ITEM, kind: 'movie', title: 'F24', durationMs: facts.durationMs, files: [{ fileId: FILE, available: true, facts }] };
    catalog.items.set(ITEM, item);

    db = await openDb({ path: ':memory:' });
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      FFMPEG_PATH: FFMPEG,
      FFPROBE_PATH: FFPROBE,
      LIBRARY_ROOTS: JSON.stringify([{ name: 'Film', path: lib, hint: 'movies' }]),
    });
    comp = compose({
      config,
      db,
      log: pino({ level: process.env.PZF_TEST_LOG ?? 'silent' }),
      factories: [
        () => ({
          name: 'fakes',
          provides: {
            catalogRead: catalog,
            profilePlayback: profiles,
            jobs: { enqueue: () => 'job' },
            events: { publish: (type, payload) => void events.push({ type, payload }) },
          },
        }),
        deliveryModule(),
        playbackModule(),
      ],
    });
    for (const m of comp.modules) await m.start?.();
    app = await buildServer({ logger: false, handlers: comp.handlers, profileTokens: { verify: (t) => (t === 't1' ? P1 : null) } });
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    for (const m of comp?.modules ?? []) await m.stop?.();
    await app?.close();
    if (db) closeDb(db);
    for (const dir of [lib, work, dataDir]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function call(operationId: string, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
    const r = await app.inject({ method, url, headers: { authorization: 'Bearer t1' }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const body = r.body ? r.json() : undefined;
    if (r.statusCode !== 204) expect(contractErrors(operationId, r.statusCode, body), `${operationId} ${r.statusCode} ${r.body.slice(0, 600)}`).toEqual([]);
    return { status: r.statusCode, body, headers: r.headers };
  }
  const media = (url: string) => app.inject({ method: 'GET', url });
  const base = (view: any): string => String(view.stream.url).replace(/main\.m3u8$/, '');

  /** Init and one segment of the session's stream, probed: what the client would decode. */
  async function probeSegment(view: any, j: number): Promise<{ codec: string; width: number; height: number }> {
    const init = await media(`${base(view)}init-0.mp4`);
    const seg = await media(`${base(view)}seg-0-${String(j).padStart(5, '0')}.m4s`);
    expect([init.statusCode, seg.statusCode]).toEqual([200, 200]);
    const path = join(work, `seg-${Math.random().toString(36).slice(2)}.mp4`);
    writeFileSync(path, Buffer.concat([init.rawPayload, seg.rawPayload]));
    const out = await execa(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', path]);
    const s = (JSON.parse(out.stdout) as { streams: { codec_name: string; width: number; height: number }[] }).streams[0]!;
    return { codec: s.codec_name, width: s.width, height: s.height };
  }

  it('Direct Stream → Transcode (burned sidecar) → Direct Stream: same session, old stream stopped each time', async () => {
    const started = await call('startPlayback', 'POST', SESSIONS, { itemId: ITEM, capabilities: noSubtitles(), subtitleTrackId: null });
    expect(started.status).toBe(201);
    const ds = started.body;
    expect(ds.mode).toBe('direct_stream');
    expect((await media(String(ds.stream.url))).statusCode).toBe(200);
    expect(await probeSegment(ds, 0)).toEqual({ codec: 'h264', width: 1920, height: 1080 });

    // Into the Transcode: the sidecar can only be burned in for this client.
    const on = await call('changeTracks', 'POST', `${SESSIONS}/${ds.sessionId}/tracks`, { subtitleTrackId: SIDECAR, positionMs: 8_000 });
    expect(on.status).toBe(200);
    const tx = on.body;
    expect(tx).toMatchObject({ sessionId: ds.sessionId, mode: 'transcode', resumePositionMs: 8_000 });
    expect(tx.tracks.subtitles.find((t: any) => t.id === SIDECAR)).toMatchObject({ selected: true, delivery: 'burned' });
    expect(tx.stream.url).not.toBe(ds.stream.url);
    expect((await media(String(ds.stream.url))).statusCode).toBe(410);
    const playlist = await media(String(tx.stream.url));
    expect(playlist.statusCode).toBe(200);
    expect(await probeSegment(tx, 2)).toMatchObject({ codec: 'h264' });
    expect((await call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toMatchObject([{ sessionId: ds.sessionId, mode: 'transcode' }]);

    // Out of it: subtitles off, back to the copied video.
    const off = await call('changeTracks', 'POST', `${SESSIONS}/${ds.sessionId}/tracks`, { subtitleTrackId: null, positionMs: 12_000 });
    expect(off.body).toMatchObject({ sessionId: ds.sessionId, mode: 'direct_stream', resumePositionMs: 12_000 });
    expect((await media(String(tx.stream.url))).statusCode).toBe(410);
    expect(await probeSegment(off.body, 0)).toEqual({ codec: 'h264', width: 1920, height: 1080 });

    expect((await call('stopPlayback', 'POST', `${SESSIONS}/${ds.sessionId}/stop`, { positionMs: 13_000 })).status).toBe(204);
    expect((await media(String(off.body.stream.url))).statusCode).toBe(410);
    expect((await call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toEqual([]);
  }, 300_000);

  it('an embedded text track to burn: 503 STREAM_PREPARING with Retry-After while it is extracted, then the Transcode', async () => {
    const body = { itemId: ITEM, capabilities: noSubtitles(), subtitleTrackId: 's2' };
    const first = await call('startPlayback', 'POST', SESSIONS, body);
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('STREAM_PREPARING');
    expect(Number(first.headers['retry-after'])).toBeGreaterThan(0);
    let r = first;
    for (let i = 0; i < 120 && r.status === 503; i++) {
      await new Promise((res) => setTimeout(res, 250));
      r = await call('startPlayback', 'POST', SESSIONS, body);
    }
    expect(r.status).toBe(201);
    expect(r.body.mode).toBe('transcode');
    expect(r.body.tracks.subtitles.find((t: any) => t.id === 's2')).toMatchObject({ selected: true, delivery: 'burned' });
    expect(await probeSegment(r.body, 0)).toMatchObject({ codec: 'h264' });
    expect((await call('stopPlayback', 'POST', `${SESSIONS}/${r.body.sessionId}/stop`, { positionMs: 1_000 })).status).toBe(204);
  }, 300_000);
});
