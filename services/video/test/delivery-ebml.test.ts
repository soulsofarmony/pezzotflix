// The minimal Matroska reader: SeekHead → Info/Tracks/Cues, bounds and budget, fuzzed truncations and
// corrupted sizes (it must fail with EbmlError, never hang, read out of bounds or throw anything else).
import { describe, expect, it } from 'vitest';
import { bufferByteSource, EbmlError, readElementHeader, readMatroskaIndex } from '../src/modules/delivery/ebml.ts';
import { fakeMkv } from './helpers/delivery-builders.ts';

const read = (buf: Buffer, opts = {}) => readMatroskaIndex(bufferByteSource(buf), opts);

describe('EBML element headers', () => {
  it.each([
    ['1-byte id, 1-byte size', [0xec, 0x83], { id: 0xec, size: 3, headerLen: 2 }],
    ['4-byte id, 8-byte size', [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0, 0, 0, 0x01, 0x00], { id: 0x1a45dfa3, size: 256, headerLen: 12 }],
    ['unknown size', [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], { id: 0x18538067, size: -1, headerLen: 12 }],
    ['2-byte size', [0xb3, 0x40, 0x10], { id: 0xb3, size: 16, headerLen: 3 }],
  ])('%s', (_l, bytes, want) => {
    expect(readElementHeader(Buffer.from(bytes), 0)).toEqual(want);
  });

  it('returns null when the header is cut, and rejects invalid ids and sizes', () => {
    expect(readElementHeader(Buffer.from([0x1a, 0x45]), 0)).toBeNull();
    expect(readElementHeader(Buffer.from([0xb3]), 0)).toBeNull();
    expect(() => readElementHeader(Buffer.from([0x00, 0x81]), 0)).toThrow(EbmlError);
    expect(() => readElementHeader(Buffer.from([0xb3, 0x00]), 0)).toThrow(EbmlError);
  });
});

describe('readMatroskaIndex', () => {
  it('finds Info, Tracks and the Cues after the Clusters through the SeekHead', async () => {
    const buf = fakeMkv({ cues: [0, 2000, 4000, 6000], durationMs: 8000 });
    const ix = await read(buf);
    expect(ix.timestampScaleNs).toBe(1_000_000);
    expect(ix.durationTicks).toBe(8000);
    expect(ix.tracks).toEqual([
      { order: 0, number: 1, type: 1 },
      { order: 1, number: 2, type: 2 },
    ]);
    expect(ix.cues?.get(1)?.map((p) => p.ticks)).toEqual([0, 2000, 4000, 6000]);
    expect(ix.cues?.get(2)?.map((p) => p.ticks)).toEqual([0, 4000]);
    // Absolute positions, inside the file, distinct per keyframe here.
    const pos = ix.cues!.get(1)!.map((p) => p.clusterPos);
    expect(new Set(pos).size).toBe(4);
    for (const p of pos) expect(p).toBeLessThan(buf.length);
    expect(ix.bytesRead).toBeGreaterThan(0);
  });

  it('finds Cues placed before the first Cluster without a SeekHead entry', async () => {
    const ix = await read(fakeMkv({ cuesFirst: true }));
    expect(ix.cues?.get(1)?.length).toBe(4);
  });

  it('reads a Segment of unknown size', async () => {
    const ix = await read(fakeMkv({ unknownSegmentSize: true }));
    expect(ix.cues?.get(1)?.length).toBe(4);
  });

  it('reports no Cues when there are none or they cannot be found cheaply', async () => {
    expect((await read(fakeMkv({ cues: null }))).cues).toBeNull();
    expect((await read(fakeMkv({ hideCues: true }))).cues).toBeNull();
  });

  it('rejects other files and other DocTypes', async () => {
    await expect(read(Buffer.from('RIFF....AVI LIST'))).rejects.toThrow(EbmlError);
    await expect(read(fakeMkv({ docType: 'other' }))).rejects.toThrow(/DocType/);
  });

  it('stops at the byte budget', async () => {
    await expect(read(fakeMkv(), { maxBytes: 40 })).rejects.toThrow(/budget/);
    await expect(read(fakeMkv(), { maxCuesBytes: 10 })).rejects.toThrow(/exceeds/);
  });

  it('caps the number of cue points', async () => {
    await expect(read(fakeMkv({ cues: [0, 2000, 4000, 6000] }), { maxCuePoints: 5 })).rejects.toThrow(/more than 5 cue points/);
    expect((await read(fakeMkv({ cues: [0, 2000, 4000, 6000] }), { maxCuePoints: 6 })).cues?.get(1)).toHaveLength(4);
  });

  it('a large Cues element: 200k points read in bounded time; above 8 MiB it is refused, not parsed', async () => {
    const times = Array.from({ length: 200_000 }, (_, i) => i * 1000);
    const big = fakeMkv({ cues: times, durationMs: 200_000_000 });
    const t0 = performance.now();
    const ix = await read(big);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(ix.cues?.get(1)).toHaveLength(200_000);
    const huge = fakeMkv({ cues: Array.from({ length: 400_000 }, (_, i) => i * 1000), durationMs: 400_000_000 });
    expect(huge.length).toBeGreaterThan(8 * 1024 * 1024);
    await expect(read(huge)).rejects.toThrow(/exceeds/);
  });

  it('hostile Info values are read as they are (the index sanity-checks them)', async () => {
    const ix = await read(fakeMkv({ timestampScaleNs: 1, durationMs: 1e300, cues: [0, 2 ** 47] }));
    expect(ix.timestampScaleNs).toBe(1);
    expect(ix.durationTicks).toBe(1e300);
    expect(ix.cues?.get(1)?.map((p) => p.ticks)).toEqual([0, 2 ** 47]);
  });

  it('fails cleanly on every truncation', async () => {
    const full = fakeMkv();
    for (let len = 0; len < full.length; len++) {
      const r = await read(full.subarray(0, len)).then(
        (ix) => ix,
        (e: unknown) => e,
      );
      if (r instanceof Error) expect(r, `length ${len}`).toBeInstanceOf(EbmlError);
    }
  });

  it('fails cleanly on corrupted bytes (seeded fuzz)', async () => {
    const full = fakeMkv();
    let seed = 0x2545f491;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 2 ** 32;
    };
    for (let i = 0; i < 3000; i++) {
      const buf = Buffer.from(full);
      const flips = 1 + Math.floor(rnd() * 3);
      for (let f = 0; f < flips; f++) buf[Math.floor(rnd() * buf.length)] = Math.floor(rnd() * 256);
      let ix;
      try {
        ix = await read(buf);
      } catch (e) {
        expect(e).toBeInstanceOf(EbmlError);
        continue;
      }
      for (const list of ix.cues?.values() ?? []) for (const p of list) expect(p.clusterPos).toBeLessThan(buf.length);
    }
  });
});
