// Hand-written ISO-BMFF reader for ffmpeg's fragmented MP4 (ADR 0003 D15): a streaming splitter for the
// top-level boxes on stdout, the init segment (codec strings, AAC channelConfiguration) and moof/traf/trun
// (keyframe PTS = tfdt + composition offset of the first sample). Every read is bounds-checked.

export class BmffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BmffError';
  }
}

export interface Box {
  type: string;
  /** Offsets in the buffer: header start, payload start, end. */
  start: number;
  body: number;
  end: number;
}

const u32 = (b: Buffer, o: number): number => {
  if (o + 4 > b.length) throw new BmffError(`read past the end at ${o}`);
  return b.readUInt32BE(o);
};
const u64 = (b: Buffer, o: number): number => {
  if (o + 8 > b.length) throw new BmffError(`read past the end at ${o}`);
  const v = b.readBigUInt64BE(o);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new BmffError('64-bit value out of range');
  return Number(v);
};
const u8 = (b: Buffer, o: number): number => {
  if (o >= b.length) throw new BmffError(`read past the end at ${o}`);
  return b[o]!;
};
const fourcc = (b: Buffer, o: number): string => b.toString('latin1', o, o + 4);

/** Boxes in [start, end); every box must fit. */
export function* boxes(b: Buffer, start = 0, end = b.length): Generator<Box> {
  let o = start;
  while (o < end) {
    if (o + 8 > end) throw new BmffError(`truncated box header at ${o}`);
    let size = u32(b, o);
    const type = fourcc(b, o + 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) throw new BmffError(`truncated largesize at ${o}`);
      size = u64(b, o + 8);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) throw new BmffError(`box ${JSON.stringify(type)} at ${o} overruns its parent`);
    yield { type, start: o, body: o + header, end: o + size };
    o += size;
  }
}

export const child = (b: Buffer, parent: Box, type: string): Box | null => {
  for (const c of boxes(b, parent.body, parent.end)) if (c.type === type) return c;
  return null;
};
export const childrenOf = (b: Buffer, parent: Box, type: string): Box[] =>
  [...boxes(b, parent.body, parent.end)].filter((c) => c.type === type);
const need = (box: Box | null, what: string): Box => {
  if (!box) throw new BmffError(`missing ${what}`);
  return box;
};

// ---------------------------------------------------------------- streaming splitter

export type SplitEvent =
  /** A complete top-level box other than mdat (ftyp, moov, moof, styp, sidx, free, mfra ...). */
  | { kind: 'box'; type: string; data: Buffer }
  /** An mdat header; its payload follows in mdat-data events, then mdat-end. */
  | { kind: 'mdat-start'; header: Buffer }
  | { kind: 'mdat-data'; data: Buffer }
  | { kind: 'mdat-end' };

/**
 * Splits a byte stream into top-level boxes without holding mdat payloads in memory.
 * Boxes other than mdat are buffered whole, up to maxBoxBytes.
 */
export class BoxSplitter {
  private pending: Buffer[] = [];
  private pendingLen = 0;
  /** Bytes of the current mdat payload still to come; null when between boxes. */
  private mdatLeft: number | null = null;
  private readonly maxBoxBytes: number;

  constructor(opts: { maxBoxBytes?: number } = {}) {
    this.maxBoxBytes = opts.maxBoxBytes ?? 32 * 1024 * 1024;
  }

  push(chunk: Buffer): SplitEvent[] {
    const out: SplitEvent[] = [];
    let buf = chunk;
    while (buf.length > 0) {
      if (this.mdatLeft !== null) {
        const n = Math.min(this.mdatLeft, buf.length);
        out.push({ kind: 'mdat-data', data: buf.subarray(0, n) });
        this.mdatLeft -= n;
        buf = buf.subarray(n);
        if (this.mdatLeft === 0) {
          this.mdatLeft = null;
          out.push({ kind: 'mdat-end' });
        }
        continue;
      }
      this.pending.push(buf);
      this.pendingLen += buf.length;
      buf = Buffer.alloc(0);
      const head = this.peek(16);
      if (head.length < 8) break;
      let size = head.readUInt32BE(0);
      const type = fourcc(head, 4);
      let headerLen = 8;
      if (size === 1) {
        if (head.length < 16) break;
        const big = head.readBigUInt64BE(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new BmffError(`box ${type} too large`);
        size = Number(big);
        headerLen = 16;
      } else if (size === 0) {
        throw new BmffError(`box ${JSON.stringify(type)} with size 0 (to end of stream) is not supported`);
      }
      if (size < headerLen) throw new BmffError(`box ${JSON.stringify(type)} with invalid size ${size}`);
      if (!/^[\x20-\x7e]{4}$/.test(type)) throw new BmffError(`invalid box type ${JSON.stringify(type)}`);
      if (type === 'mdat') {
        const all = this.take(this.pendingLen);
        out.push({ kind: 'mdat-start', header: all.subarray(0, headerLen) });
        this.mdatLeft = size - headerLen;
        if (this.mdatLeft === 0) {
          this.mdatLeft = null;
          out.push({ kind: 'mdat-end' });
        }
        buf = all.subarray(headerLen);
        continue;
      }
      if (size > this.maxBoxBytes) throw new BmffError(`box ${JSON.stringify(type)} of ${size} bytes exceeds the limit`);
      if (this.pendingLen < size) break;
      const all = this.take(this.pendingLen);
      out.push({ kind: 'box', type, data: all.subarray(0, size) });
      buf = all.subarray(size);
    }
    return out;
  }

  /** True when the stream ended on a box boundary. */
  get idle(): boolean {
    return this.mdatLeft === null && this.pendingLen === 0;
  }

  private peek(n: number): Buffer {
    if (this.pending.length === 1 || this.pending[0]!.length >= n) return this.pending[0]!.subarray(0, n);
    const joined = Buffer.concat(this.pending, this.pendingLen);
    this.pending = [joined];
    return joined.subarray(0, n);
  }

  private take(n: number): Buffer {
    const joined = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending, this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    return joined.subarray(0, n);
  }
}

// ---------------------------------------------------------------- init segment

export interface InitTrack {
  id: number;
  /** hdlr handler type: 'vide', 'soun', ... */
  handler: string;
  timescale: number;
  /** Sample entry fourcc: hvc1, avc1, mp4a, fLaC, Opus, ac-3, ec-3 ... */
  entry: string;
  /** RFC 6381 codec string, null if this reader does not know the entry. */
  codec: string | null;
  /** AAC only: channelConfiguration of the AudioSpecificConfig (0 means a PCE). */
  channelConfiguration?: number;
  /** trex defaults, used when tfhd and trun leave them out. */
  defaultSampleDuration: number;
  defaultSampleFlags: number;
}

export interface InitInfo {
  tracks: InitTrack[];
}

class Bits {
  private p = 0;
  private readonly b: Buffer;
  constructor(b: Buffer) {
    this.b = b;
  }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.p >> 3];
      if (byte === undefined) throw new BmffError('bit read past the end');
      v = v * 2 + ((byte >> (7 - (this.p & 7))) & 1);
      this.p++;
    }
    return v;
  }
}

/** RFC 6381 / ISO/IEC 14496-15 Annex E: hvc1.<space><profile>.<compat reversed>.<tier><level>[.<constraints>]. */
export function hevcCodecString(entry: string, hvcc: Buffer): string {
  if (hvcc.length < 13) throw new BmffError('hvcC too short');
  const b1 = hvcc[1]!;
  const space = ['', 'A', 'B', 'C'][b1 >> 6]!;
  const tier = (b1 >> 5) & 1 ? 'H' : 'L';
  const profile = b1 & 31;
  let compat = hvcc.readUInt32BE(2);
  let reversed = 0;
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | (compat & 1);
    compat >>>= 1;
  }
  const constraints = [...hvcc.subarray(6, 12)];
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = hvcc[12]!;
  return [entry, `${space}${profile}`, (reversed >>> 0).toString(16).toUpperCase(), `${tier}${level}`, ...constraints.map((c) => c.toString(16).toUpperCase())].join('.');
}

/** avc1.PPCCLL from the avcC record. */
export function avcCodecString(entry: string, avcc: Buffer): string {
  if (avcc.length < 4) throw new BmffError('avcC too short');
  return `${entry}.${avcc.subarray(1, 4).toString('hex').toUpperCase()}`;
}

/** Object type and AudioSpecificConfig of an esds box payload (after version/flags). */
export function parseEsds(b: Buffer): { oti: number; aot: number | null; channelConfiguration: number | null } {
  let o = 0;
  const desc = (): { tag: number; len: number } => {
    const tag = u8(b, o++);
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const c = u8(b, o++);
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { tag, len };
  };
  let d = desc();
  if (d.tag !== 3) throw new BmffError('esds without ES_Descriptor');
  o += 2; // ES_ID
  const flags = u8(b, o++);
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + u8(b, o);
  if (flags & 0x20) o += 2;
  d = desc();
  if (d.tag !== 4) throw new BmffError('esds without DecoderConfigDescriptor');
  const oti = u8(b, o);
  o += 13;
  if (o >= b.length) return { oti, aot: null, channelConfiguration: null };
  d = desc();
  if (d.tag !== 5) return { oti, aot: null, channelConfiguration: null };
  if (o + d.len > b.length) throw new BmffError('DecoderSpecificInfo overruns esds');
  const bits = new Bits(b.subarray(o, o + d.len));
  let aot = bits.read(5);
  if (aot === 31) aot = 32 + bits.read(6);
  const freqIndex = bits.read(4);
  if (freqIndex === 15) bits.read(24);
  return { oti, aot, channelConfiguration: bits.read(4) };
}

const VISUAL_ENTRY_HEADER = 78; // SampleEntry(8) + VisualSampleEntry fields (70)
const AUDIO_ENTRY_HEADER = 28; // SampleEntry(8) + AudioSampleEntry fields (20)

function sampleEntryInfo(b: Buffer, entry: Box): Pick<InitTrack, 'codec' | 'channelConfiguration'> {
  const t = entry.type;
  const visual = /^(hvc1|hev1|avc1|avc3|dvh1|dvhe|av01|vp09)$/.test(t);
  const inner = entry.body + (visual ? VISUAL_ENTRY_HEADER : AUDIO_ENTRY_HEADER);
  if (inner > entry.end) throw new BmffError(`sample entry ${t} too short`);
  let codec: string | null = null;
  let channelConfiguration: number | undefined;
  if (t === 'ac-3' || t === 'ec-3') codec = t;
  if (t === 'fLaC') codec = 'flac';
  if (t === 'Opus') codec = 'opus';
  for (const c of boxes(b, inner, entry.end)) {
    if (c.type === 'hvcC' && (t === 'hvc1' || t === 'hev1')) codec = hevcCodecString(t, b.subarray(c.body, c.end));
    else if (c.type === 'avcC' && (t === 'avc1' || t === 'avc3')) codec = avcCodecString(t, b.subarray(c.body, c.end));
    else if (c.type === 'esds' && t === 'mp4a') {
      const e = parseEsds(b.subarray(c.body + 4, c.end));
      if (e.oti === 0x40 && e.aot !== null) {
        codec = `mp4a.40.${e.aot}`;
        channelConfiguration = e.channelConfiguration ?? undefined;
      } else if (e.oti === 0x6b || e.oti === 0x69) {
        codec = 'mp4a.40.34'; // MP3
      } else {
        codec = `mp4a.${e.oti.toString(16)}`;
      }
    }
  }
  return channelConfiguration === undefined ? { codec } : { codec, channelConfiguration };
}

/** Tracks of an init segment (ftyp + moov). */
export function parseInit(b: Buffer): InitInfo {
  let moov: Box | null = null;
  for (const top of boxes(b)) if (top.type === 'moov') moov = top;
  if (!moov) throw new BmffError('init segment without moov');
  const trex = new Map<number, { duration: number; flags: number }>();
  const mvex = child(b, moov, 'mvex');
  if (mvex) {
    for (const t of childrenOf(b, mvex, 'trex')) {
      trex.set(u32(b, t.body + 4), { duration: u32(b, t.body + 12), flags: u32(b, t.body + 20) });
    }
  }
  const tracks: InitTrack[] = [];
  for (const trak of childrenOf(b, moov, 'trak')) {
    const tkhd = need(child(b, trak, 'tkhd'), 'tkhd');
    const id = u32(b, tkhd.body + (u8(b, tkhd.body) === 1 ? 20 : 12));
    const mdia = need(child(b, trak, 'mdia'), 'mdia');
    const mdhd = need(child(b, mdia, 'mdhd'), 'mdhd');
    const timescale = u32(b, mdhd.body + (u8(b, mdhd.body) === 1 ? 20 : 12));
    if (timescale === 0) throw new BmffError('timescale 0');
    const hdlr = need(child(b, mdia, 'hdlr'), 'hdlr');
    const handler = fourcc(b, hdlr.body + 8);
    const stbl = need(child(b, need(child(b, mdia, 'minf'), 'minf'), 'stbl'), 'stbl');
    const stsd = need(child(b, stbl, 'stsd'), 'stsd');
    const first = boxes(b, stsd.body + 8, stsd.end).next();
    if (first.done) throw new BmffError('empty stsd');
    const entry = first.value;
    const d = trex.get(id) ?? { duration: 0, flags: 0 };
    tracks.push({ id, handler, timescale, entry: entry.type, ...sampleEntryInfo(b, entry), defaultSampleDuration: d.duration, defaultSampleFlags: d.flags });
  }
  return { tracks };
}

// ---------------------------------------------------------------- fragments

export interface TrafSample {
  duration: number;
  size: number;
  flags: number;
  /** Composition offset (signed with trun version 1). */
  cts: number;
}

export interface TrafInfo {
  trackId: number;
  /** tfdt baseMediaDecodeTime, track timescale. */
  baseDecodeTime: number;
  samples: TrafSample[];
  /** data_offset of the first trun (from the moof start, default-base-is-moof), null when absent. */
  dataOffset: number | null;
}

/** A sample is a sync sample when sample_is_non_sync_sample (bit 16) is clear. */
export const isSyncSample = (flags: number): boolean => (flags & 0x00010000) === 0;

/** Every traf of a moof with its samples, using the init's trex defaults. */
export function parseMoof(b: Buffer, init: InitInfo): TrafInfo[] {
  const moof = boxes(b).next();
  if (moof.done || moof.value.type !== 'moof') throw new BmffError('not a moof');
  const out: TrafInfo[] = [];
  for (const traf of childrenOf(b, moof.value, 'traf')) {
    const tfhd = need(child(b, traf, 'tfhd'), 'tfhd');
    const tf = u32(b, tfhd.body) & 0xffffff;
    const trackId = u32(b, tfhd.body + 4);
    const track = init.tracks.find((t) => t.id === trackId);
    let defDuration = track?.defaultSampleDuration ?? 0;
    let defSize = 0;
    let defFlags = track?.defaultSampleFlags ?? 0;
    let p = tfhd.body + 8;
    if (tf & 0x1) p += 8;
    if (tf & 0x2) p += 4;
    if (tf & 0x8) {
      defDuration = u32(b, p);
      p += 4;
    }
    if (tf & 0x10) {
      defSize = u32(b, p);
      p += 4;
    }
    if (tf & 0x20) defFlags = u32(b, p);
    const tfdt = need(child(b, traf, 'tfdt'), 'tfdt');
    const baseDecodeTime = u8(b, tfdt.body) === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4);
    const samples: TrafSample[] = [];
    let dataOffset: number | null = null;
    for (const trun of childrenOf(b, traf, 'trun')) {
      const version = u8(b, trun.body);
      const fl = u32(b, trun.body) & 0xffffff;
      const count = u32(b, trun.body + 4);
      let q = trun.body + 8;
      if (fl & 0x1) {
        if (dataOffset === null) dataOffset = b.readInt32BE(q);
        q += 4;
      }
      let firstFlags: number | null = null;
      if (fl & 0x4) {
        firstFlags = u32(b, q);
        q += 4;
      }
      const per = ((fl & 0x100 ? 1 : 0) + (fl & 0x200 ? 1 : 0) + (fl & 0x400 ? 1 : 0) + (fl & 0x800 ? 1 : 0)) * 4;
      if (q + count * per > trun.end) throw new BmffError('trun overruns its box');
      for (let i = 0; i < count; i++) {
        let duration = defDuration;
        let size = defSize;
        let flags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
        let cts = 0;
        if (fl & 0x100) {
          duration = u32(b, q);
          q += 4;
        }
        if (fl & 0x200) {
          size = u32(b, q);
          q += 4;
        }
        if (fl & 0x400) {
          flags = u32(b, q);
          q += 4;
        }
        if (fl & 0x800) {
          cts = version === 1 ? b.readInt32BE(q) : u32(b, q);
          q += 4;
        }
        samples.push({ duration, size, flags, cts });
      }
    }
    out.push({ trackId, baseDecodeTime, samples, dataOffset });
  }
  return out;
}
