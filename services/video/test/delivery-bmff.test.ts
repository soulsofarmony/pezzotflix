// ISO-BMFF reader: bounds, the streaming splitter under any chunking, init codec strings and the AAC
// channelConfiguration, moof/traf/trun with defaults and signed composition offsets.
import { describe, expect, it } from 'vitest';
import {
  avcCodecString,
  BmffError,
  boxes,
  BoxSplitter,
  hevcCodecString,
  isSyncSample,
  parseEsds,
  parseInit,
  parseMoof,
  type SplitEvent,
} from '../src/modules/delivery/bmff.ts';
import { audioEntry, AVCC, box, esds, fakeFmp4, fakeInit, fragment, fullBox, HVCC, NON_SYNC, SYNC, traf, visualEntry } from './helpers/delivery-builders.ts';

describe('boxes', () => {
  it('walks boxes and rejects overruns', () => {
    const b = Buffer.concat([box('ftyp', Buffer.alloc(4)), box('free')]);
    expect([...boxes(b)].map((x) => [x.type, x.start, x.end])).toEqual([
      ['ftyp', 0, 12],
      ['free', 12, 20],
    ]);
    const bad = Buffer.from(b);
    bad.writeUInt32BE(100, 0);
    expect(() => [...boxes(bad)]).toThrow(BmffError);
    expect(() => [...boxes(Buffer.from([0, 0, 0]))]).toThrow(BmffError);
    const tiny = Buffer.from(b);
    tiny.writeUInt32BE(4, 0);
    expect(() => [...boxes(tiny)]).toThrow(BmffError);
  });

  it('reads 64-bit largesize boxes', () => {
    const h = Buffer.alloc(16);
    h.writeUInt32BE(1, 0);
    h.write('free', 4, 'latin1');
    h.writeBigUInt64BE(20n, 8);
    const b = Buffer.concat([h, Buffer.alloc(4)]);
    expect([...boxes(b)].map((x) => [x.type, x.body, x.end])).toEqual([['free', 16, 20]]);
  });
});

describe('BoxSplitter', () => {
  const { init, fragments } = fakeFmp4([0, 2000, 4000], 6000);
  const stream = Buffer.concat([init, ...fragments, box('mfra', Buffer.alloc(8))]);

  /** Collapses events into comparable records: boxes by type, mdat payloads joined. */
  const collapse = (events: SplitEvent[]): string[] => {
    const out: string[] = [];
    let mdat: Buffer[] = [];
    for (const e of events) {
      if (e.kind === 'box') out.push(`${e.type}:${e.data.toString('hex')}`);
      else if (e.kind === 'mdat-start') {
        mdat = [e.header];
      } else if (e.kind === 'mdat-data') mdat.push(e.data);
      else out.push(`mdat:${Buffer.concat(mdat).toString('hex')}`);
    }
    return out;
  };
  const split = (chunks: Buffer[]) => {
    const s = new BoxSplitter();
    const events = chunks.flatMap((c) => s.push(c));
    return { events: collapse(events), idle: s.idle };
  };

  it('gives the same boxes whatever the chunking', () => {
    const whole = split([stream]);
    expect(whole.idle).toBe(true);
    expect(whole.events.map((e) => e.slice(0, 4))).toEqual(['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat', 'mfra']);
    const bytes = split([...stream].map((x) => Buffer.from([x])));
    expect(bytes.events).toEqual(whole.events);
    let seed = 7;
    for (let round = 0; round < 50; round++) {
      const chunks: Buffer[] = [];
      for (let o = 0; o < stream.length; ) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const n = 1 + (seed % 97);
        chunks.push(stream.subarray(o, o + n));
        o += n;
      }
      expect(split(chunks).events).toEqual(whole.events);
    }
  });

  it('streams mdat payloads without buffering them', () => {
    const s = new BoxSplitter({ maxBoxBytes: 64 });
    const big = box('mdat', Buffer.alloc(1000, 1));
    const ev = s.push(big);
    expect(ev[0]).toMatchObject({ kind: 'mdat-start' });
    expect(ev.at(-1)).toEqual({ kind: 'mdat-end' });
    expect(() => new BoxSplitter({ maxBoxBytes: 64 }).push(box('moov', Buffer.alloc(100)))).toThrow(/exceeds/);
  });

  it('is not idle in the middle of a box and rejects invalid headers', () => {
    const s = new BoxSplitter();
    s.push(stream.subarray(0, 30));
    expect(s.idle).toBe(false);
    const zero = Buffer.alloc(8);
    zero.write('mdat', 4, 'latin1');
    expect(() => new BoxSplitter().push(zero)).toThrow(/size 0/);
    const junk = Buffer.from([0, 0, 0, 16, 0x00, 0x01, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => new BoxSplitter().push(junk)).toThrow(/invalid box type/);
  });
});

describe('init segment', () => {
  it('reads the HEVC codec string from hvcC (RFC 6381)', () => {
    expect(hevcCodecString('hvc1', HVCC)).toBe('hvc1.2.4.L153.B0');
    const high = Buffer.from(HVCC);
    high[1] = 0x22; // tier High
    expect(hevcCodecString('hvc1', high)).toBe('hvc1.2.4.H153.B0');
    expect(avcCodecString('avc1', AVCC)).toBe('avc1.640029');
  });

  it('reads AAC object type and channelConfiguration from esds', () => {
    expect(parseEsds(esds(6).subarray(12))).toEqual({ oti: 0x40, aot: 2, channelConfiguration: 6 });
    expect(parseEsds(esds(0).subarray(12))).toEqual({ oti: 0x40, aot: 2, channelConfiguration: 0 });
    expect(() => parseEsds(Buffer.from([0x04, 0]))).toThrow(BmffError);
  });

  it.each([
    ['hvc1 + AAC 5.1', fakeInit(), ['hvc1.2.4.L153.B0', 'mp4a.40.2'], 6],
    ['avc1 + AAC with a PCE', fakeInit({ video: visualEntry('avc1', box('avcC', AVCC)), audio: audioEntry('mp4a', esds(0)) }), ['avc1.640029', 'mp4a.40.2'], 0],
    ['FLAC', fakeInit({ audio: audioEntry('fLaC', fullBox('dfLa', 0, 0, Buffer.alloc(38))) }), ['hvc1.2.4.L153.B0', 'flac'], undefined],
    ['Opus', fakeInit({ audio: audioEntry('Opus', box('dOps', Buffer.alloc(11))) }), ['hvc1.2.4.L153.B0', 'opus'], undefined],
    ['E-AC-3', fakeInit({ audio: audioEntry('ec-3', box('dec3', Buffer.alloc(5))) }), ['hvc1.2.4.L153.B0', 'ec-3'], undefined],
    ['no audio', fakeInit({ audio: null }), ['hvc1.2.4.L153.B0'], undefined],
  ])('%s', (_l, buf, codecs, channelConfiguration) => {
    const info = parseInit(buf);
    expect(info.tracks.map((t) => t.codec)).toEqual(codecs);
    expect(info.tracks[0]).toMatchObject({ id: 1, handler: 'vide', timescale: 16_000, defaultSampleFlags: 0x01010000 });
    if (codecs.length > 1) expect(info.tracks[1]!.handler).toBe('soun');
    expect(info.tracks[1]?.channelConfiguration).toBe(channelConfiguration);
  });

  it('rejects an init without moov', () => {
    expect(() => parseInit(box('ftyp', Buffer.alloc(8)))).toThrow(/moov/);
  });
});

describe('fragments', () => {
  const init = parseInit(fakeInit());

  it('reads tfdt and samples, with signed composition offsets (trun v1)', () => {
    const moof = fragment(
      [traf(1, 160_000, [{ duration: 640, size: 10, flags: SYNC, cts: -1280 }, { duration: 640, size: 5, flags: NON_SYNC, cts: 640 }])],
      15,
    );
    const [t] = parseMoof(moof, init);
    expect(t).toEqual({
      trackId: 1,
      baseDecodeTime: 160_000,
      samples: [
        { duration: 640, size: 10, flags: SYNC, cts: -1280 },
        { duration: 640, size: 5, flags: NON_SYNC, cts: 640 },
      ],
      dataOffset: 0,
    });
    expect(isSyncSample(SYNC)).toBe(true);
    expect(isSyncSample(NON_SYNC)).toBe(false);
  });

  it('uses first_sample_flags and the trex defaults when per-sample flags are absent', () => {
    const moof = fragment([traf(1, 0, [{ duration: 640, size: 1 }, { duration: 640, size: 1 }], { firstFlags: SYNC })], 2);
    const [t] = parseMoof(moof, init);
    expect(t!.samples.map((s) => isSyncSample(s.flags))).toEqual([true, false]);
  });

  it('rejects a trun that overruns its box', () => {
    const moof = fragment([traf(1, 0, [{ duration: 1, size: 1 }])], 1);
    const bad = Buffer.from(moof);
    const trunAt = bad.indexOf(Buffer.from('trun', 'latin1'));
    bad.writeUInt32BE(1000, trunAt + 8); // sample_count
    expect(() => parseMoof(bad, init)).toThrow(BmffError);
  });
});
