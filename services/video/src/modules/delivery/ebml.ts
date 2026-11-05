// Minimal Matroska reader for the keyframe index (ADR 0003 D8): EBML header, Segment, SeekHead, Info,
// Tracks and Cues, nothing else. Reads through a ByteSource with a byte budget, and checks every size
// against its parent and the file, so a corrupt or hostile file fails with an EbmlError instead of
// reading without end. Clusters are never read.
import type { FileHandle } from 'node:fs/promises';

export class EbmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EbmlError';
  }
}

/** Positional reads of one file. */
export interface ByteSource {
  readonly size: number;
  read(pos: number, len: number): Promise<Buffer>;
}

export function fileByteSource(fh: FileHandle, size: number): ByteSource {
  return {
    size,
    async read(pos, len) {
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return got === len ? buf : buf.subarray(0, got);
    },
  };
}

export const bufferByteSource = (buf: Buffer): ByteSource => ({
  size: buf.length,
  async read(pos, len) {
    return buf.subarray(Math.min(pos, buf.length), Math.min(pos + len, buf.length));
  },
});

// Element ids, marker bits included (Matroska spec).
export const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Void: 0xec,
} as const;

const UNKNOWN_SIZE = -1;

export interface ElementHeader {
  id: number;
  /** Payload size in bytes, or -1 for the "unknown size" marker. */
  size: number;
  headerLen: number;
}

/** Reads an EBML element header from buf at off; null if buf is too short to hold it. */
export function readElementHeader(buf: Buffer, off: number): ElementHeader | null {
  if (off >= buf.length) return null;
  const b0 = buf[off]!;
  const idLen = b0 >= 0x80 ? 1 : b0 >= 0x40 ? 2 : b0 >= 0x20 ? 3 : b0 >= 0x10 ? 4 : 0;
  if (idLen === 0) throw new EbmlError(`invalid element id at ${off}`);
  if (off + idLen >= buf.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[off + i]!;
  const s0 = buf[off + idLen]!;
  if (s0 === 0) throw new EbmlError(`invalid element size at ${off + idLen}`);
  const sizeLen = Math.clz32(s0) - 23; // 1..8
  if (off + idLen + sizeLen > buf.length) return null;
  let size = s0 & (0xff >> sizeLen);
  let allOnes = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const byte = buf[off + idLen + i]!;
    if (byte !== 0xff) allOnes = false;
    size = size * 256 + byte;
  }
  if (allOnes) return { id, size: UNKNOWN_SIZE, headerLen: idLen + sizeLen };
  if (!Number.isSafeInteger(size)) throw new EbmlError(`element size too large at ${off}`);
  return { id, size, headerLen: idLen + sizeLen };
}

function readUint(buf: Buffer, off: number, len: number): number {
  if (len === 0) return 0;
  if (len > 8) throw new EbmlError(`unsigned integer of ${len} bytes`);
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[off + i]!;
  if (!Number.isSafeInteger(v)) throw new EbmlError('unsigned integer out of range');
  return v;
}

function readFloat(buf: Buffer, off: number, len: number): number {
  if (len === 0) return 0;
  if (len === 4) return buf.readFloatBE(off);
  if (len === 8) return buf.readDoubleBE(off);
  throw new EbmlError(`float of ${len} bytes`);
}

interface Child {
  id: number;
  start: number;
  end: number;
}

/** Children of an in-memory master element payload [start, end); every child must fit. */
function* children(buf: Buffer, start: number, end: number): Generator<Child> {
  let off = start;
  while (off < end) {
    const h = readElementHeader(buf, off);
    if (!h) throw new EbmlError(`truncated element at ${off}`);
    if (h.size === UNKNOWN_SIZE) throw new EbmlError(`unknown size inside a master element at ${off}`);
    const cs = off + h.headerLen;
    const ce = cs + h.size;
    if (ce > end) throw new EbmlError(`element at ${off} overruns its parent`);
    yield { id: h.id, start: cs, end: ce };
    off = ce;
  }
}

export interface MatroskaTrack {
  /** Position in Tracks, which is the ffmpeg stream index for Matroska. */
  order: number;
  number: number;
  /** 1 video, 2 audio, 17 subtitle. */
  type: number;
}

export interface MatroskaCuePoint {
  /** CueTime in Segment ticks. */
  ticks: number;
  /** Absolute file offset of the Cluster holding the keyframe. */
  clusterPos: number;
}

export interface MatroskaIndex {
  timestampScaleNs: number;
  /** Info Duration in Segment ticks, null if absent. */
  durationTicks: number | null;
  tracks: MatroskaTrack[];
  /** Cue points per track number, sorted by time; null when the file has no Cues. */
  cues: Map<number, MatroskaCuePoint[]> | null;
  /**
   * End of the media data: the absolute offset of the Cues when they sit after the first Cluster, else
   * null (the file size is the best estimate).
   */
  dataEnd: number | null;
  bytesRead: number;
}

export interface ReadMatroskaOptions {
  /** Total bytes the reader may read (default 16 MiB). */
  maxBytes?: number;
  /** Largest Cues element accepted (default 8 MiB: ~4 h of 1 s cues for every track is under 2 MiB). */
  maxCuesBytes?: number;
  /** Most cue positions accepted, all tracks together (default 500k). */
  maxCuePoints?: number;
}

const MAX_HEADER_ELEMENT = 64 * 1024;
const MAX_TRACKS_BYTES = 8 * 1024 * 1024;
const MAX_TOP_LEVEL_SCAN = 32;

/** Reads the Matroska index elements. Throws EbmlError on anything malformed or over budget. */
export async function readMatroskaIndex(src: ByteSource, opts: ReadMatroskaOptions = {}): Promise<MatroskaIndex> {
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const maxCues = opts.maxCuesBytes ?? 8 * 1024 * 1024;
  const maxCuePoints = opts.maxCuePoints ?? 500_000;
  let bytesRead = 0;
  const read = async (pos: number, len: number): Promise<Buffer> => {
    if (pos < 0 || pos >= src.size) throw new EbmlError(`read outside the file at ${pos}`);
    const n = Math.min(len, src.size - pos);
    bytesRead += n;
    if (bytesRead > maxBytes) throw new EbmlError(`byte budget of ${maxBytes} exceeded`);
    const buf = await src.read(pos, n);
    if (buf.length !== n) throw new EbmlError(`short read at ${pos}`);
    return buf;
  };
  const headerAt = async (pos: number): Promise<ElementHeader> => {
    const buf = await read(pos, Math.min(12, src.size - pos));
    const h = readElementHeader(buf, 0);
    if (!h) throw new EbmlError(`truncated element header at ${pos}`);
    return h;
  };
  /** Payload of a sized element whose header starts at pos, bounded by limit and by parentEnd. */
  const payloadAt = async (pos: number, h: ElementHeader, limit: number, parentEnd: number): Promise<Buffer> => {
    if (h.size === UNKNOWN_SIZE) throw new EbmlError(`unknown size for element 0x${h.id.toString(16)} at ${pos}`);
    if (h.size > limit) throw new EbmlError(`element 0x${h.id.toString(16)} of ${h.size} bytes exceeds ${limit}`);
    const start = pos + h.headerLen;
    if (start + h.size > parentEnd) throw new EbmlError(`element at ${pos} overruns its parent`);
    return h.size === 0 ? Buffer.alloc(0) : read(start, h.size);
  };

  // EBML header and DocType.
  const ebml = await headerAt(0);
  if (ebml.id !== ID.EBML) throw new EbmlError('not an EBML file');
  const ebmlPayload = await payloadAt(0, ebml, MAX_HEADER_ELEMENT, src.size);
  let docType = '';
  for (const c of children(ebmlPayload, 0, ebmlPayload.length)) {
    if (c.id === ID.DocType) docType = ebmlPayload.toString('latin1', c.start, c.end).replace(/\0+$/, '');
  }
  if (docType !== 'matroska' && docType !== 'webm') throw new EbmlError(`unsupported DocType ${JSON.stringify(docType)}`);

  // Segment.
  const segPos = ebml.headerLen + ebml.size;
  const seg = await headerAt(segPos);
  if (seg.id !== ID.Segment) throw new EbmlError('no Segment after the EBML header');
  const segStart = segPos + seg.headerLen;
  const segEnd = seg.size === UNKNOWN_SIZE ? src.size : Math.min(src.size, segStart + seg.size);

  let timestampScaleNs = 1_000_000;
  let durationTicks: number | null = null;
  let tracks: MatroskaTrack[] | null = null;
  let cues: Map<number, MatroskaCuePoint[]> | null = null;
  let cuesPos: number | null = null;
  let firstClusterPos: number | null = null;
  const seen = new Set<number>();
  const pending: number[] = [];

  const parseSeekHead = (buf: Buffer) => {
    for (const seek of children(buf, 0, buf.length)) {
      if (seek.id !== ID.Seek) continue;
      let target: number | null = null;
      let rel: number | null = null;
      for (const c of children(buf, seek.start, seek.end)) {
        if (c.id === ID.SeekID) target = readUint(buf, c.start, c.end - c.start);
        else if (c.id === ID.SeekPosition) rel = readUint(buf, c.start, c.end - c.start);
      }
      if (rel === null || target === null) continue;
      if (target === ID.Info || target === ID.Tracks || target === ID.Cues || target === ID.SeekHead) {
        const abs = segStart + rel;
        if (abs >= segEnd) throw new EbmlError(`SeekPosition ${rel} outside the Segment`);
        pending.push(abs);
      }
    }
  };
  const parseInfo = (buf: Buffer) => {
    for (const c of children(buf, 0, buf.length)) {
      if (c.id === ID.TimestampScale) timestampScaleNs = readUint(buf, c.start, c.end - c.start);
      else if (c.id === ID.Duration) durationTicks = readFloat(buf, c.start, c.end - c.start);
    }
    if (!(timestampScaleNs > 0)) throw new EbmlError('invalid TimestampScale');
    if (durationTicks !== null && !(Number.isFinite(durationTicks) && durationTicks >= 0)) durationTicks = null;
  };
  const parseTracks = (buf: Buffer) => {
    const out: MatroskaTrack[] = [];
    for (const entry of children(buf, 0, buf.length)) {
      if (entry.id !== ID.TrackEntry) continue;
      let number = 0;
      let type = 0;
      for (const c of children(buf, entry.start, entry.end)) {
        if (c.id === ID.TrackNumber) number = readUint(buf, c.start, c.end - c.start);
        else if (c.id === ID.TrackType) type = readUint(buf, c.start, c.end - c.start);
      }
      out.push({ order: out.length, number, type });
    }
    tracks = out;
  };
  const parseCues = (buf: Buffer) => {
    const map = new Map<number, MatroskaCuePoint[]>();
    let count = 0;
    for (const point of children(buf, 0, buf.length)) {
      if (point.id !== ID.CuePoint) continue;
      let ticks: number | null = null;
      const positions: { track: number; cluster: number }[] = [];
      for (const c of children(buf, point.start, point.end)) {
        if (c.id === ID.CueTime) ticks = readUint(buf, c.start, c.end - c.start);
        else if (c.id === ID.CueTrackPositions) {
          let track: number | null = null;
          let cluster: number | null = null;
          for (const p of children(buf, c.start, c.end)) {
            if (p.id === ID.CueTrack) track = readUint(buf, p.start, p.end - p.start);
            else if (p.id === ID.CueClusterPosition) cluster = readUint(buf, p.start, p.end - p.start);
          }
          if (track !== null && cluster !== null) positions.push({ track, cluster });
        }
      }
      if (ticks === null) continue;
      for (const p of positions) {
        const abs = segStart + p.cluster;
        if (abs >= segEnd) throw new EbmlError(`CueClusterPosition ${p.cluster} outside the Segment`);
        if (++count > maxCuePoints) throw new EbmlError(`more than ${maxCuePoints} cue points`);
        let list = map.get(p.track);
        if (!list) map.set(p.track, (list = []));
        list.push({ ticks, clusterPos: abs });
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.ticks - b.ticks || a.clusterPos - b.clusterPos);
    cues = map;
  };

  const visit = async (pos: number): Promise<number | null> => {
    if (seen.has(pos)) return null;
    seen.add(pos);
    const h = await headerAt(pos);
    switch (h.id) {
      case ID.SeekHead:
        parseSeekHead(await payloadAt(pos, h, MAX_HEADER_ELEMENT, segEnd));
        break;
      case ID.Info:
        parseInfo(await payloadAt(pos, h, MAX_HEADER_ELEMENT, segEnd));
        break;
      case ID.Tracks:
        parseTracks(await payloadAt(pos, h, MAX_TRACKS_BYTES, segEnd));
        break;
      case ID.Cues:
        parseCues(await payloadAt(pos, h, maxCues, segEnd));
        cuesPos = pos;
        break;
      default:
        break;
    }
    return h.id;
  };

  // Top-level elements before the first Cluster (SeekHead, Info, Tracks, sometimes Cues).
  let pos = segStart;
  for (let i = 0; i < MAX_TOP_LEVEL_SCAN && pos < segEnd; i++) {
    const h = await headerAt(pos);
    if (h.id === ID.Cluster) {
      firstClusterPos = pos;
      break;
    }
    if (h.size === UNKNOWN_SIZE) throw new EbmlError(`unknown size for top-level element at ${pos}`);
    await visit(pos);
    pos += h.headerLen + h.size;
  }
  // Elements the SeekHead points to (Cues usually sit after the Clusters).
  for (let guard = 0; pending.length > 0; guard++) {
    if (guard > 64) throw new EbmlError('too many SeekHead entries');
    await visit(pending.shift()!);
  }

  if (!tracks) throw new EbmlError('no Tracks element');
  const dataEnd = cuesPos !== null && firstClusterPos !== null && cuesPos > firstClusterPos ? cuesPos : null;
  return { timestampScaleNs, durationTicks, tracks, cues, dataEnd, bytesRead };
}
