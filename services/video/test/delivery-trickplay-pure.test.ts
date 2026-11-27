// Trickplay (ADR 0009), pure parts and the cache: interval and tile counts, transfer and skips, the ffmpeg
// arguments (SDR, PQ, HLG, anamorphic, start_time, over 2000 tiles), framecrc parsing, and the stamp cache
// (stamp or version changed, missing sheet, orphan .tmp, old stamps deleted, failure records).
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expectedTiles,
  gopShiftMs,
  intervalFor,
  InvalidManifest,
  MAX_TILES,
  medianGapMs,
  minimumTiles,
  parseFramecrc,
  timeoutFor,
  TRICKPLAY_TIMEOUT_FLOOR_MS,
  trickplayArgs,
  trickplayFilter,
  TrickplayCache,
  type TrickplayManifest,
  trickplayTransfer,
} from '../src/modules/delivery/trickplay.ts';
import { TRICKPLAY_VERSION, trickplayJobKey } from '../src/shared/job-types.ts';
import { tempDir } from './helpers/delivery-media.ts';

describe('interval and tiles (D2)', () => {
  it.each([
    [60_000, 10_000, 6],
    [61_000, 10_000, 7],
    [8_930_664, 10_000, 894], // 2001
    [20_000_000, 10_000, 2000], // 5 h 33 min 20 s: exactly 2000 tiles
    [20_000_001, 11_000, 1819],
    [36_000_000, 18_000, 2000], // 10 h
  ])('%i ms → every %i ms, %i tiles', (duration, interval, tiles) => {
    expect(intervalFor(duration)).toBe(interval);
    expect(expectedTiles(duration, interval)).toBe(tiles);
    expect(expectedTiles(duration, interval)).toBeLessThanOrEqual(MAX_TILES);
  });

  it('tolerates the last 30 s missing, no more', () => {
    expect(minimumTiles(8_930_664, 10_000)).toBe(891);
    expect(minimumTiles(20_000, 10_000)).toBe(1);
  });

  it.each([
    [10_000, null, 0],
    [10_000, 10_010, 0],
    [10_000, 1_000, 4500],
    [10_000, 2_000, 4000],
    [10_000, 0, 0],
  ])('interval %i, GOP %s → shift %i ms', (interval, gop, shift) => expect(gopShiftMs(interval, gop)).toBe(shift));

  it('median keyframe gap', () => {
    expect(medianGapMs([0])).toBeNull();
    expect(medianGapMs([0, 1000, 2000, 10_000])).toBe(1000);
  });

  it('timeout: the floor, or the size at the measured throughput with a margin', () => {
    expect(timeoutFor(1e9)).toBe(TRICKPLAY_TIMEOUT_FLOOR_MS);
    expect(timeoutFor(100e9)).toBeGreaterThan(TRICKPLAY_TIMEOUT_FLOOR_MS);
  });
});

describe('transfer and skips (D3)', () => {
  it.each([
    [{ hdr: 'SDR', hdrFallback: [], dolbyVisionProfile: null }, { transfer: 'sdr' }],
    [{ hdr: 'HDR10', hdrFallback: [], dolbyVisionProfile: null }, { transfer: 'pq' }],
    [{ hdr: 'HDR10+', hdrFallback: ['HDR10'], dolbyVisionProfile: null }, { transfer: 'pq' }],
    [{ hdr: 'HLG', hdrFallback: [], dolbyVisionProfile: null }, { transfer: 'hlg' }],
    [{ hdr: 'DV', hdrFallback: ['HDR10'], dolbyVisionProfile: 8 }, { transfer: 'pq' }],
    [{ hdr: 'DV', hdrFallback: ['HDR10', 'HDR10+'], dolbyVisionProfile: 7 }, { transfer: 'pq' }],
    [{ hdr: 'DV', hdrFallback: ['HLG'], dolbyVisionProfile: 8 }, { transfer: 'hlg' }],
    [{ hdr: 'DV', hdrFallback: ['SDR'], dolbyVisionProfile: 8 }, { transfer: 'sdr' }],
  ] as const)('%j → %j', (v, out) => expect(trickplayTransfer(v)).toEqual(out));

  it('DV profile 5, and DV without a base layer, get no previews', () => {
    expect(trickplayTransfer({ hdr: 'DV', hdrFallback: [], dolbyVisionProfile: 5 })).toHaveProperty('skip');
    expect(trickplayTransfer({ hdr: 'DV', hdrFallback: ['HDR10'], dolbyVisionProfile: 5 })).toHaveProperty('skip');
    expect(trickplayTransfer({ hdr: 'DV', hdrFallback: [], dolbyVisionProfile: 8 })).toHaveProperty('skip');
  });
});

describe('ffmpeg arguments (D1–D3)', () => {
  const base = { absPath: '/media/Film/A (2000)/A.mkv', videoStreamIndex: 0, transfer: 'sdr', intervalMs: 10_000, sourceHeight: 1080, outDir: '/data/cache/delivery/trickplay/f1/.tmp-x' } as const;
  const graph = (args: string[]) => args[args.indexOf('-filter_complex') + 1]!;

  it('SDR: keyframes only, few threads, fps on the zero-based timeline, scale with the SAR, BT.601 full range, 10×10 tiles', () => {
    const args = trickplayArgs(base);
    expect(args.indexOf('-skip_frame')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-skip_frame') + 1]).toBe('nokey');
    expect(args.indexOf('-threads')).toBeLessThan(args.indexOf('-i'));
    expect(Number(args[args.indexOf('-threads') + 1])).toBeLessThanOrEqual(4);
    expect(args[args.indexOf('-i') + 1]).toBe('file:/media/Film/A (2000)/A.mkv');
    // start_time: ffmpeg's default zero-basing, never -copyts or a seek.
    expect(args).not.toContain('-copyts');
    expect(args).not.toContain('-ss');
    expect(graph(args)).toBe(
      '[0:0]fps=1/10:start_time=0:round=near:eof_action=pass,scale=w=320:h=trunc(320/dar/2+0.5)*2:in_color_matrix=bt709:out_color_matrix=bt601:out_range=pc,setsar=1,format=yuvj420p,split[t][c];[t]tile=10x10[s]',
    );
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2)).toEqual(['-map', '[s]']);
    expect(args[args.indexOf('-q:v') + 1]).toBe('4');
    expect(args[args.indexOf('-start_number') + 1]).toBe('0');
    expect(args).toContain(join(base.outDir, 'sheet-%d.jpg'));
    expect(args.slice(-7)).toEqual(['-map', '[c]', '-fps_mode', 'passthrough', '-f', 'framecrc', 'pipe:1']);
  });

  it('SD sources keep BT.601', () => {
    expect(trickplayFilter('sdr', 10_000, 576)).toContain('in_color_matrix=bt601');
  });

  it('PQ and HLG: scaled first, then tone-mapped with tonemapx to BT.601 full range', () => {
    const pq = trickplayFilter('pq', 10_000, 2160);
    expect(pq).toBe(
      'fps=1/10:start_time=0:round=near:eof_action=pass,scale=w=320:h=trunc(320/dar/2+0.5)*2,setsar=1,zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemapx=tonemap=bt2390:desat=0,zscale=t=bt709:m=470bg:r=full,format=yuvj420p',
    );
    expect(trickplayFilter('hlg', 10_000, 2160)).toContain('zscale=tin=arib-std-b67:');
    expect(trickplayFilter('hlg', 10_000, 2160)).toContain('tonemapx=');
  });

  it('anamorphic: the height follows the display aspect ratio (dar includes the SAR), then square pixels', () => {
    const f = trickplayFilter('sdr', 10_000, 576);
    expect(f).toContain('h=trunc(320/dar/2+0.5)*2');
    expect(f.indexOf('setsar=1')).toBeGreaterThan(f.indexOf('scale='));
  });

  it('the chosen video stream, a GOP shift, a longer interval past 2000 tiles', () => {
    const g = graph(trickplayArgs({ ...base, videoStreamIndex: 3, intervalMs: intervalFor(36_000_000), shiftMs: 4500 }));
    expect(g.startsWith('[0:3]setpts=PTS+4.500/TB,fps=1/18:start_time=0:round=near:eof_action=pass,')).toBe(true);
  });

  it('a % in the cache path is escaped for image2', () => {
    expect(trickplayArgs({ ...base, outDir: '/data/100%/x' })).toContain(join('/data/100%%/x', 'sheet-%d.jpg'));
  });

  it('rejects a bad stream index', () => {
    expect(() => trickplayArgs({ ...base, videoStreamIndex: -1 })).toThrow();
  });
});

describe('framecrc', () => {
  it('counts the tiles and reads their size', () => {
    const text = '#software: Lavf62\n#tb 0: 10/1\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 320x146\n#sar 0: 1/1\n0,          0,          0,        1,    70080, 0xd10ca2a3\n0,          1,          1,        1,    70080, 0x1\n';
    expect(parseFramecrc(text)).toEqual({ tiles: 2, width: 320, height: 146 });
    expect(parseFramecrc('garbage')).toBeNull();
  });
});

describe('cache', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const stamp = { fileId: 'f1', sizeBytes: 1000, mtimeMs: 5 };
  const manifest = (over: Partial<TrickplayManifest> = {}): TrickplayManifest => ({
    version: TRICKPLAY_VERSION,
    ...stamp,
    videoStreamIndex: 0,
    intervalMs: 10_000,
    tileWidth: 320,
    tileHeight: 180,
    columns: 10,
    rows: 10,
    count: 150,
    sheets: 2,
    builtAt: 1,
    elapsedMs: 1,
    ...over,
  });
  const build = async (c: TrickplayCache, m = manifest()) => {
    const tmp = await c.makeTmp(m.fileId);
    for (let k = 0; k < m.sheets; k++) writeFileSync(join(tmp, `sheet-${k}.jpg`), 'jpeg');
    return c.commit(tmp, m);
  };

  it('valid only for the same stamp, version, video stream and with every sheet present', async () => {
    dir = tempDir('pzf-tp-');
    const c = new TrickplayCache(dir);
    const e = await build(c);
    expect(e.dir).toBe(join(dir, 'delivery', 'trickplay', 'f1', `1000-5-v${TRICKPLAY_VERSION}`));
    expect((await c.get(stamp, 0))?.manifest.count).toBe(150);
    expect(await c.get({ ...stamp, mtimeMs: 6 }, 0)).toBeNull();
    expect(await c.get({ ...stamp, sizeBytes: 1001 }, 0)).toBeNull();
    expect(await c.get(stamp, 1)).toBeNull();
    // Another parameter version in the manifest.
    writeFileSync(join(e.dir, 'manifest.json'), JSON.stringify({ ...manifest(), version: TRICKPLAY_VERSION + 1 }));
    expect(await c.get(stamp, 0)).toBeNull();
    writeFileSync(join(e.dir, 'manifest.json'), JSON.stringify(manifest()));
    expect(await c.get(stamp, 0)).not.toBeNull();
    rmSync(join(e.dir, 'sheet-1.jpg'));
    expect(await c.get(stamp, 0)).toBeNull();
  });

  it('a new stamp replaces the old ones and the failure record; orphan working dirs go at startup', async () => {
    dir = tempDir('pzf-tp-');
    const c = new TrickplayCache(dir);
    await build(c);
    await c.putFailure({ ...stamp, mtimeMs: 9 }, 'x', 0, true);
    const orphan = await c.makeTmp('f1');
    const next = await build(c, manifest({ mtimeMs: 9 }));
    const names = readdirSync(c.fileDir('f1')).sort();
    expect(names).toEqual([`.tmp-${orphan.split('.tmp-')[1]}`, `1000-9-v${TRICKPLAY_VERSION}`].sort());
    expect(await c.get(stamp, 0)).toBeNull();
    expect(await c.get({ ...stamp, mtimeMs: 9 }, 0)).toEqual(next);
    expect(await c.cleanOrphans()).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it('failure records: per stamp, permanent or transient within the TTL', async () => {
    dir = tempDir('pzf-tp-');
    const c = new TrickplayCache(dir);
    await c.putFailure(stamp, 'ffmpeg exited', 1000, true);
    expect(await c.getFailure(stamp, 1e12)).toMatchObject({ reason: 'ffmpeg exited', permanent: true });
    expect(await c.getFailure({ ...stamp, mtimeMs: 6 }, 1000)).toBeNull();
    await c.putFailure(stamp, 'timed out', 1000, false);
    expect(await c.getFailure(stamp, 2000)).toMatchObject({ permanent: false });
    expect(await c.getFailure(stamp, 1000 + 7 * 3600_000)).toBeNull();
  });

  it('refuses to commit a manifest get() would reject, writing nothing', async () => {
    dir = tempDir('pzf-tp-');
    const c = new TrickplayCache(dir);
    const tmp = await c.makeTmp('f1');
    await expect(c.commit(tmp, manifest({ count: MAX_TILES + 1, sheets: 21 }))).rejects.toBeInstanceOf(InvalidManifest);
    expect(readdirSync(tmp)).toEqual([]);
    expect(readdirSync(c.fileDir('f1'))).toEqual([`.tmp-${tmp.split('.tmp-')[1]}`]);
  });

  it('never names a path from a bad file id or stamp', () => {
    dir = tempDir('pzf-tp-');
    const c = new TrickplayCache(dir);
    expect(() => c.fileDir('../x')).toThrow();
    expect(() => c.stampDir({ fileId: 'f1', sizeBytes: 1.5, mtimeMs: 0 })).toThrow();
    mkdirSync(join(c.root, 'not ok'), { recursive: true });
    return expect(c.cleanOrphans()).resolves.toBe(0);
  });

  it('job key carries the parameter version and the stamp', () => {
    expect(trickplayJobKey('f1', 10, 20)).toBe(`trickplay:v${TRICKPLAY_VERSION}:f1:10:20`);
  });
});
