// Direct Stream over real ffmpeg and the sample library, through the contract routes: playlists, init
// and every segment, restarts compared with the run from 0, the AAC 5.1 layout. Skipped with a message
// when ffmpeg/ffprobe or the samples are missing. Media are only read.
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseInit } from '../src/modules/delivery/bmff.ts';
import type { StreamHandle } from '../src/shared/ports.ts';
import { harness, type Harness } from './helpers/delivery-harness.ts';
import { directStreamPlan, factsOf, MOVIES, restartDiff, SAMPLE, samplesOf, skipNotice } from './helpers/delivery-media.ts';

const skip = skipNotice('delivery-hls', true);

describe.skipIf(skip !== null)('delivery: hls-fmp4 on the samples', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness([{ name: 'Film', path: MOVIES() }]);
  });
  afterAll(async () => h?.close());

  const get = async (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
  const startOk = async (relPath: string, fileId: string, opts: Parameters<typeof directStreamPlan>[2] = {}): Promise<StreamHandle> => {
    const facts = await factsOf(join(MOVIES(), relPath), { rootName: 'Film', relPath });
    const r = await h.delivery.port.start(directStreamPlan(fileId, facts, opts), `session-${fileId}`);
    if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
    return r.handle;
  };
  const base = (handle: StreamHandle) => handle.locators.stream.replace(/main\.m3u8$/, '');
  const segmentNames = (media: string) => media.split('\n').filter((l) => l.endsWith('.m4s'));

  it('serves playlists, init and every segment with contiguous timestamps (BR2049, TrueHD → AAC 5.1)', async () => {
    const handle = await startOk(SAMPLE.br2049, 'br2049', {
      audioIndex: 1,
      action: { kind: 'convert', codec: 'aac', channels: 6, bitrateBps: 640_000, layout: '5.1' },
    });
    expect(handle.protocol).toBe('hls-fmp4');
    expect(handle.mediaTimestampOffsetMs).toBe(10_000);
    expect(handle.mimeType).toMatch(/^video\/mp4; codecs="hvc1\.2\.4\.L\d+(\.[0-9A-F]+)*, mp4a\.40\.2"$/);
    expect(handle.bitrate.audioBps).toBe(640_000);

    const main = await get(handle.locators.stream);
    expect(main.statusCode).toBe(200);
    expect(main.headers['cache-control']).toBe('no-store');
    expect(main.body).toContain('#EXT-X-STREAM-INF:BANDWIDTH=');
    expect(main.body).toContain(`CODECS="${/codecs="([^"]+)"/.exec(handle.mimeType)![1]!.replace(/, /g, ',')}"`);
    expect(main.body).toContain('VIDEO-RANGE=PQ');
    expect(main.body).not.toContain('INDEPENDENT-SEGMENTS');

    const media = (await get(`${base(handle)}media-0.m3u8`)).body;
    expect(media).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(media).toContain('#EXT-X-ENDLIST');
    const names = segmentNames(media);
    expect(names.length).toBeGreaterThan(7); // 30 s, 4 s target, the byte cap splits the 100 Mb/s segments

    const initRes = await get(`${base(handle)}init-0.mp4`);
    expect(initRes.statusCode).toBe(200);
    const init = parseInit(initRes.rawPayload);
    const aac = init.tracks.find((t) => t.handler === 'soun')!;
    expect(aac).toMatchObject({ entry: 'mp4a', codec: 'mp4a.40.2', channelConfiguration: 6 });

    const stream = h.delivery.streamOf(handle.streamId)!;
    const starts = (stream.hls as unknown as { opts: { grid: { starts: number[] } } }).opts.grid.starts;
    const video = init.tracks.find((t) => t.handler === 'vide')!.id;
    let lastVideoEnd: number | null = null;
    let lastAudioEnd: number | null = null;
    for (const [j, name] of names.entries()) {
      const r = await get(`${base(handle)}${name}`);
      expect(r.statusCode, name).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const samples = samplesOf(r.rawPayload, init);
      const v = samples.filter((s) => s.track === video);
      const a = samples.filter((s) => s.track !== video);
      expect(v[0]!.sync, name).toBe(true);
      if (j > 0) expect(Math.abs(v[0]!.pts - starts[j]!), name).toBeLessThanOrEqual(1);
      for (const [list, last] of [[v, lastVideoEnd], [a, lastAudioEnd]] as const) {
        if (last !== null) expect(Math.abs(list[0]!.dts - last), `${name} gap`).toBeLessThan(0.01);
        for (let i = 1; i < list.length; i++) expect(Math.abs(list[i]!.dts - (list[i - 1]!.dts + list[i - 1]!.duration))).toBeLessThan(0.01);
      }
      lastVideoEnd = v[v.length - 1]!.dts + v[v.length - 1]!.duration;
      lastAudioEnd = a[a.length - 1]!.dts + a[a.length - 1]!.duration;
    }
    // A name that is not in the playlist is 404; a listed one never is.
    expect((await get(`${base(handle)}seg-0-99999.m4s`)).statusCode).toBe(404);
    await h.delivery.port.stop({ streamId: handle.streamId }, 'stopped');
    const gone = await get(`${base(handle)}media-0.m3u8`);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().code).toBe('SESSION_EXPIRED');
  }, 180_000);

  it('a restart in the middle gives the same samples as the run from 0 (Long Test, closed GOP, E-AC-3 copy)', async () => {
    const ref = await startOk(SAMPLE.longTest, 'long-ref', { audioIndex: 2 });
    const refSegs: Buffer[] = [];
    for (let j = 0; j <= 12; j++) refSegs.push((await get(`${base(ref)}seg-0-${String(j).padStart(5, '0')}.m4s`)).rawPayload);
    const refInit = (await get(`${base(ref)}init-0.mp4`)).rawPayload;
    await h.delivery.port.stop({ streamId: ref.streamId }, 'stopped');

    const rs = await startOk(SAMPLE.longTest, 'long-rs', { audioIndex: 2, startPositionMs: 40_000 });
    const rsInit = (await get(`${base(rs)}init-0.mp4`)).rawPayload;
    expect(rsInit.equals(refInit)).toBe(true);
    for (let j = 10; j <= 12; j++) {
      const seg = (await get(`${base(rs)}seg-0-${String(j).padStart(5, '0')}.m4s`)).rawPayload;
      expect(restartDiff(seg, refSegs[j]!, parseInit(refInit)), `segment ${j}`).toEqual([]);
    }
    await h.delivery.port.stop({ streamId: rs.streamId }, 'stopped');
  }, 180_000);
});
