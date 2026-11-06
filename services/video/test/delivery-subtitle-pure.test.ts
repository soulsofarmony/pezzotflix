// The embedded subtitle extraction, pure parts (ADR 0003 D12): .sup segments and the PTS dedupe of the
// merge, WebVTT cues and their merge, the ffmpeg command of a pass and its read rate, the cache's LRU, the charset of a text sidecar.
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprint, outputKey, SubtitleCache } from '../src/modules/delivery/subtitle-cache.ts';
import { extractionArgs, extractionReadrate, MIN_READRATE } from '../src/modules/delivery/subtitle-extract.ts';
import { keepSupSegment, mergeVtt, parseVtt, SupError, supFirstPts, SupSplitter, vttCueStartMs, vttFirstCueMs } from '../src/modules/delivery/subtitle-format.ts';
import { SIDECAR_FALLBACK_CHARSET, SIDECAR_UTF8_MIN_SHARE, sidecarCharenc, utf8Census } from '../src/modules/delivery/subtitles.ts';
import { supSegments, vttOf } from './helpers/delivery-fake-extract.ts';
import { tempDir } from './helpers/delivery-media.ts';

describe('.sup segments', () => {
  it('splits a stream into whole segments across any chunking', () => {
    const sup = supSegments([0, 1000, 2500, 60_000], 300);
    for (const size of [1, 7, 13, 14, 313, 1000, sup.length]) {
      const s = new SupSplitter();
      const segs = [];
      for (let at = 0; at < sup.length; at += size) segs.push(...s.push(sup.subarray(at, at + size)));
      expect(segs.map((g) => g.pts), `chunk ${size}`).toEqual([0, 90_000, 225_000, 5_400_000]);
      expect(Buffer.concat(segs.map((g) => g.bytes)).equals(sup)).toBe(true);
      expect(s.pending).toBe(0);
    }
  });

  it('keeps an incomplete segment pending and rejects bytes that are not PGS', () => {
    const s = new SupSplitter();
    expect(s.push(supSegments([1000]).subarray(0, 10))).toEqual([]);
    expect(s.pending).toBe(10);
    expect(() => new SupSplitter().push(Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\n'))).toThrow(SupError);
  });

  it('first PTS of a file; empty is null, truncated or foreign throws', () => {
    expect(supFirstPts(supSegments([41_000]))).toBe(41_000 * 90);
    expect(supFirstPts(Buffer.alloc(0))).toBeNull();
    expect(() => supFirstPts(supSegments([1]).subarray(0, 5))).toThrow(SupError);
    expect(() => supFirstPts(Buffer.alloc(13, 1))).toThrow(SupError);
  });

  it.each([
    ['before pass 1', 40_999, 41_000, true],
    ['at the first PTS of pass 1 (a duplicate)', 41_000, 41_000, false],
    ['after it', 50_000, 41_000, false],
    ['pass 1 empty: everything', 50_000, null, true],
  ])('pass-2 segment %s', (_l, pts, first, keep) => {
    expect(keepSupSegment({ pts: pts * 90, bytes: Buffer.alloc(0) }, first === null ? null : first * 90)).toBe(keep);
  });
});

describe('WebVTT', () => {
  it('reads cue starts with and without hours, with an id line', () => {
    expect(vttCueStartMs('00:01.500 --> 00:02.000\nhi')).toBe(1500);
    expect(vttCueStartMs('01:02:03.004 --> 01:02:04.000\nhi')).toBe(3_723_004);
    expect(vttCueStartMs('7\n00:00:05.000 --> 00:00:06.000 line:90%\nhi')).toBe(5000);
    expect(vttCueStartMs('NOTE nothing here')).toBeNull();
    expect(vttFirstCueMs('WEBVTT\n')).toBeNull();
    expect(vttFirstCueMs(vttOf([3000, 9000]))).toBe(3000);
  });

  it('parses ffmpeg output into header and cues, CRLF included', () => {
    const doc = parseVtt(vttOf([1000, 2000]).replace(/\n/g, '\r\n'));
    expect(doc.header).toBe('WEBVTT');
    expect(doc.cues).toEqual(['00:01.000 --> 00:02.000\ncue 0', '00:02.000 --> 00:03.000\ncue 1']);
  });

  it('merge: pass 2 in front, without its cues at or after the first cue of pass 1 (PTS dedupe)', () => {
    const full = vttOf([1000, 5000, 41_000, 45_000]);
    const pass1 = vttOf([41_000, 45_000], (i) => `cue ${i + 2}`);
    const pass2 = vttOf([1000, 5000, 41_000]);
    expect(mergeVtt(pass2, pass1)).toBe(full);
    // An empty pass 1: pass 2 read to the end is everything.
    expect(mergeVtt(full, 'WEBVTT\n')).toBe(full);
    // An empty pass 2.
    expect(mergeVtt('WEBVTT\n', pass1)).toBe(pass1);
    expect(mergeVtt('WEBVTT\n', 'WEBVTT\n')).toBe('WEBVTT\n');
  });
});

describe('extraction command and read rate', () => {
  const outputs = [
    { streamIndex: 4, format: 'sup' as const, path: '/c/w/p1-s4.sup.part' },
    { streamIndex: 6, format: 'vtt' as const, path: '/c/w/p1-s6.vtt.part' },
  ];

  it('pass 1 from P: fast seek, -copyts, the video clock as SHA-512 frame hashes on stdout (paced from Node, no -readrate), one output per track', () => {
    expect(extractionArgs({ absPath: '/m/f.mkv', pass: 1, startS: 60, untilS: null, videoStreamIndex: 0, paced: true, outputs })).toEqual([
      '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'warning', '-y',
      '-noaccurate_seek', '-ss', '60.000000',
      '-i', 'file:/m/f.mkv',
      '-copyts', '-start_at_zero',
      '-map', '0:0', '-c', 'copy', '-flush_packets', '1', '-f', 'framehash', '-hash', 'sha512', 'pipe:1',
      '-map', '0:4', '-c:s', 'copy', '-flush_packets', '1', '-f', 'sup', 'file:/c/w/p1-s4.sup.part',
      '-map', '0:6', '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', 'file:/c/w/p1-s6.vtt.part',
    ]);
  });

  it('pass 2 up to P₁: no seek, the clock on stdout (no -t); -t only without a video stream; pass 1 from 0 has no seek; an unpaced ASS extraction has the framecrc clock', () => {
    const p2 = extractionArgs({ absPath: '/m/f.mkv', pass: 2, startS: 60, untilS: 61.2, videoStreamIndex: 0, paced: true, outputs });
    expect(p2.join(' ')).toContain('-copyts -start_at_zero -map 0:0 -c copy -flush_packets 1 -f framehash -hash sha512 pipe:1 -map 0:4 ');
    expect(p2).not.toContain('-t');
    expect(p2).not.toContain('-ss');
    const noVideo = extractionArgs({ absPath: '/m/f.mkv', pass: 2, startS: 60, untilS: 61.2, videoStreamIndex: null, paced: false, outputs });
    expect(noVideo[noVideo.indexOf('-t') + 1]).toBe('61.200000');
    expect(noVideo).not.toContain('pipe:1');
    const zero = extractionArgs({ absPath: '/m/f.mkv', pass: 1, startS: 0, untilS: null, videoStreamIndex: 0, paced: true, outputs });
    expect(zero).not.toContain('-ss');
    const ass = extractionArgs({ absPath: '/m/f.mkv', pass: 1, startS: 0, untilS: null, videoStreamIndex: 0, paced: false, outputs: [{ streamIndex: 6, format: 'ass', path: '/x.ass' }] });
    expect(ass.join(' ')).toContain('-map 0:0 -c copy -flush_packets 1 -f framecrc pipe:1 -map 0:6 -c:s ass -f ass file:/x.ass');
    for (const a of [p2, noVideo, zero, ass]) expect(a.join(' ')).not.toMatch(/-readrate/);
  });

  it.each([
    ['a 40 GB 2 h remux at 15 MB/s', 40e9, 7_200_000, 15, 2.7],
    ['a 110 Mb/s file: the 1.1 floor', 99e9, 7_200_000, 15, MIN_READRATE],
    ['duration unknown', 1e9, null, 15, MIN_READRATE],
  ])('readrate for %s', (_l, size, duration, cap, rate) => {
    expect(extractionReadrate(size, duration, cap)).toBe(rate);
  });
});

describe('sidecar charset (m5, m7)', () => {
  const utf8 = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nPerché è già così\n', 'utf8');
  const cp1252 = (s: string) => Buffer.from(s, 'latin1');
  /** n UTF-8 cues of four accented letters each, and one cue with a stray Windows-1252 byte. */
  const mostlyUtf8 = (n: number) =>
    Buffer.concat([...Array.from({ length: n }, (_, i) => Buffer.from(`${i + 1}\nPerché è già così\n\n`, 'utf8')), cp1252('99\nCos\xec\n')]);
  it.each<[string, Uint8Array, string | null]>([
    ['ASCII', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n'), null],
    ['UTF-8', utf8, null],
    ['UTF-8 with a BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]), null],
    ['UTF-8, 4-byte sequences', Buffer.from('🎬 ok 🎞️', 'utf8'), null],
    ['UTF-16 LE with a BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Perché', 'utf16le')]), null],
    ['UTF-16 BE with a BOM', Buffer.from([0xfe, 0xff, 0x00, 0x50, 0x00, 0xe9]), null],
    ['Windows-1252 accents', cp1252('1\n00:00:01,000 --> 00:00:02,000\nPerch\xe9 \xe8 gi\xe0\n'), SIDECAR_FALLBACK_CHARSET],
    ['Windows-1252 with one accidental UTF-8 pair (Ã©)', cp1252('Perch\xe9 \xe8 gi\xe0 \xc3\xa9 l\xec\n'), SIDECAR_FALLBACK_CHARSET],
    ['UTF-8 with one stray Windows-1252 byte in 30 cues (120 valid, 1 invalid)', mostlyUtf8(30), null],
    ['UTF-8 with one stray byte in 2 cues (8 valid, 1 invalid: 89%)', mostlyUtf8(2), SIDECAR_FALLBACK_CHARSET],
    ['UTF-8 with one stray byte in 3 cues (12 valid, 1 invalid: 92%)', mostlyUtf8(3), null],
    ['a UTF-8 sequence cut short', Buffer.from([0x41, 0xc3]), SIDECAR_FALLBACK_CHARSET],
    ['overlong, surrogate and over U+10FFFF forms are not UTF-8', Buffer.from([0xc0, 0xaf, 0xe0, 0x80, 0xaf, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80]), SIDECAR_FALLBACK_CHARSET],
    ['empty', Buffer.alloc(0), null],
  ])('%s', (_l, bytes, charenc) => {
    expect(sidecarCharenc(bytes)).toBe(charenc);
  });

  it.each<[string, number[], { valid: number; invalid: number }]>([
    ['ASCII', [0x41, 0x0a], { valid: 0, invalid: 0 }],
    ['2, 3 and 4 bytes', [0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x8e, 0xac], { valid: 3, invalid: 0 }],
    ['a lone continuation, a cut lead', [0x80, 0x41, 0xe2, 0x82], { valid: 0, invalid: 3 }],
    ['an overlong 2-byte form', [0xc1, 0xbf], { valid: 0, invalid: 2 }],
    ['the edges: U+0800, U+D7FF, U+E000, U+10FFFF', [0xe0, 0xa0, 0x80, 0xed, 0x9f, 0xbf, 0xee, 0x80, 0x80, 0xf4, 0x8f, 0xbf, 0xbf], { valid: 4, invalid: 0 }],
  ])('utf8Census: %s', (_l, bytes, census) => {
    expect(utf8Census(Uint8Array.from(bytes))).toEqual(census);
  });
  it('the share is 0.9', () => expect(SIDECAR_UTF8_MIN_SHARE).toBe(0.9));
});

describe('subtitle cache', () => {
  let dir: string;
  const log = pino({ level: 'silent' });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const put = async (cache: SubtitleCache, fp: string, key: string, bytes: number) => {
    const src = join(dir, `src-${fp}-${key}`);
    writeFileSync(src, Buffer.alloc(bytes, 1));
    await cache.put(fp, key, src);
  };

  it('fingerprint changes with size and mtime; ids and keys are checked', () => {
    const a = fingerprint({ fileId: 'f-1', sizeBytes: 1000, mtimeMs: 1_700_000_000_123.7 });
    expect(a).toBe(`f-1-${(1000).toString(36)}-${(1_700_000_000_123).toString(36)}`);
    expect(fingerprint({ fileId: 'f-1', sizeBytes: 1001, mtimeMs: 1_700_000_000_123 })).not.toBe(a);
    expect(() => fingerprint({ fileId: '../x', sizeBytes: 1, mtimeMs: 1 })).toThrow();
    expect(outputKey(5, 'sup')).toBe('s5.sup');
    expect(() => outputKey(-1, 'vtt')).toThrow();
  });

  it('evicts the least recently used over the limit, never a pinned file nor the one just put', async () => {
    dir = tempDir('pzf-subcache-');
    let t = 1_000_000;
    const cache = new SubtitleCache(dir, 250, log, () => t);
    await cache.init();
    await put(cache, 'a', 's1.sup', 100);
    t += 120_000;
    await put(cache, 'b', 's1.sup', 100);
    t += 120_000;
    cache.touch('a', 's1.sup'); // a is now more recent than b
    t += 120_000;
    await put(cache, 'c', 's1.sup', 100);
    expect(cache.has('a', 's1.sup')).toBe(true);
    expect(cache.has('b', 's1.sup')).toBe(false);
    expect(cache.usedBytes).toBe(200);
    cache.setPinned(() => new Set(['a', 'c']));
    t += 120_000;
    await put(cache, 'd', 's1.sup', 100);
    // Over the limit, but a and c are in use and d was just put.
    expect(['a', 'c', 'd'].every((fp) => cache.has(fp, 's1.sup'))).toBe(true);
    expect(cache.usedBytes).toBe(300);
  });

  it('init rebuilds the index from the disk (LRU order from mtimes) and removes interrupted work', async () => {
    dir = tempDir('pzf-subcache-');
    const root = join(dir, 'delivery', 'subtitles');
    mkdirSync(join(root, 'old', '.work-x'), { recursive: true });
    mkdirSync(join(root, 'new'), { recursive: true });
    mkdirSync(join(root, 'empty'), { recursive: true });
    writeFileSync(join(root, 'old', 's2.vtt'), 'WEBVTT\n');
    writeFileSync(join(root, 'old', '.work-x', 'p1-s2.vtt.part'), 'WEBVTT\n');
    writeFileSync(join(root, 'old', 's3.sup.part'), 'x');
    writeFileSync(join(root, 'new', 's2.vtt'), 'WEBVTT\n');
    utimesSync(join(root, 'old', 's2.vtt'), new Date(1000), new Date(1000));
    const cache = new SubtitleCache(dir, 7, log, Date.now);
    await cache.init();
    expect(readdirSync(join(root, 'old'))).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(['new', 'old']);
    expect(cache.has('old', 's2.vtt')).toBe(false); // the older one went to fit 7 bytes
    expect(cache.has('new', 's2.vtt')).toBe(true);
    expect(statSync(join(root, 'new', 's2.vtt')).size).toBe(7);
  });
});
