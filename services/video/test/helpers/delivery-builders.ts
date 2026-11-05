// Builders of synthetic Matroska (EBML) and fragmented MP4 data for the delivery unit tests.

// ---------------------------------------------------------------- EBML

const vintSize = (n: number): Buffer => {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const b = Buffer.alloc(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        b[i] = v % 256;
        v = Math.floor(v / 256);
      }
      b[0]! |= 0x80 >> (len - 1);
      return b;
    }
  }
  throw new Error('size too large');
};

const idBytes = (id: number): Buffer => {
  const len = id >= 0x1000000 ? 4 : id >= 0x10000 ? 3 : id >= 0x100 ? 2 : 1;
  const b = Buffer.alloc(len);
  b.writeUIntBE(id, 0, len);
  return b;
};

export const el = (id: number, ...payload: Buffer[]): Buffer => {
  const body = Buffer.concat(payload);
  return Buffer.concat([idBytes(id), vintSize(body.length), body]);
};
/** An element with the "unknown size" marker (8 bytes of ones). */
export const elUnknown = (id: number, ...payload: Buffer[]): Buffer =>
  Buffer.concat([idBytes(id), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), ...payload]);
export const uint = (id: number, v: number, len = 0): Buffer => {
  let n = len || 1;
  while (!len && v >= 2 ** (8 * n)) n++;
  const b = Buffer.alloc(n);
  b.writeUIntBE(v, 0, Math.min(n, 6));
  return el(id, b);
};
export const float = (id: number, v: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return el(id, b);
};
export const str = (id: number, s: string): Buffer => el(id, Buffer.from(s, 'latin1'));
export const bin = (id: number, b: Buffer): Buffer => el(id, b);

export const MKV = {
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

export interface FakeMkvOptions {
  docType?: string;
  /** Cue times (ms) of the video track 1; audio track 2 gets one cue every 2 entries. */
  cues?: number[] | null;
  /** Put the Cues before the Cluster (no SeekHead entry needed). */
  cuesFirst?: boolean;
  /** Leave the Cues out of the SeekHead (and after the Cluster): undiscoverable. */
  hideCues?: boolean;
  unknownSegmentSize?: boolean;
  /** Info Duration, in TimestampScale ticks (ms at the default scale). */
  durationMs?: number;
  /** Info TimestampScale (ns per tick); cue times are ticks too. Default 1 ms. */
  timestampScaleNs?: number;
}

/** A small Matroska file: header elements, one dummy Cluster, and Cues after it (unless cuesFirst). */
export function fakeMkv(opts: FakeMkvOptions = {}): Buffer {
  const header = el(MKV.EBML, str(MKV.DocType, opts.docType ?? 'matroska'));
  const info = el(MKV.Info, uint(MKV.TimestampScale, opts.timestampScaleNs ?? 1_000_000), float(MKV.Duration, opts.durationMs ?? 30_000));
  const tracks = el(
    MKV.Tracks,
    el(MKV.TrackEntry, uint(MKV.TrackNumber, 1), uint(MKV.TrackType, 1)),
    el(MKV.TrackEntry, uint(MKV.TrackNumber, 2), uint(MKV.TrackType, 2)),
  );
  const cluster = el(MKV.Cluster, Buffer.alloc(64, 0xaa));
  const cueTimes = opts.cues === undefined ? [0, 2000, 4000, 6000] : opts.cues;
  // Positions relative to the Segment data start; filled in after the layout is known.
  const build = (seekHeadLen: number, clusterRel: number): { seekHead: Buffer; cues: Buffer | null } => {
    const cues =
      cueTimes === null
        ? null
        : el(
            MKV.Cues,
            // One concat, no spread: the large-Cues tests build hundreds of thousands of points.
            Buffer.concat(
              cueTimes.flatMap((t, i) => [
                el(MKV.CuePoint, uint(MKV.CueTime, t), el(MKV.CueTrackPositions, uint(MKV.CueTrack, 1), uint(MKV.CueClusterPosition, clusterRel + Math.min(i, 63), 4))),
                ...(i % 2 === 0 ? [el(MKV.CuePoint, uint(MKV.CueTime, t), el(MKV.CueTrackPositions, uint(MKV.CueTrack, 2), uint(MKV.CueClusterPosition, clusterRel, 4)))] : []),
              ]),
            ),
          );
    const infoRel = seekHeadLen;
    const tracksRel = infoRel + info.length;
    const afterCluster = tracksRel + tracks.length + (opts.cuesFirst && cues ? cues.length : 0) + cluster.length;
    const seeks = [
      el(MKV.Seek, bin(MKV.SeekID, Buffer.from([0x15, 0x49, 0xa9, 0x66])), uint(MKV.SeekPosition, infoRel, 4)),
      el(MKV.Seek, bin(MKV.SeekID, Buffer.from([0x16, 0x54, 0xae, 0x6b])), uint(MKV.SeekPosition, tracksRel, 4)),
      ...(cues && !opts.cuesFirst && !opts.hideCues
        ? [el(MKV.Seek, bin(MKV.SeekID, Buffer.from([0x1c, 0x53, 0xbb, 0x6b])), uint(MKV.SeekPosition, afterCluster, 4))]
        : []),
    ];
    return { seekHead: el(MKV.SeekHead, ...seeks), cues };
  };
  // Two passes: the SeekHead length does not depend on the positions (fixed 4-byte uints).
  const probe = build(0, 0);
  const shLen = probe.seekHead.length;
  const clusterRel = shLen + info.length + tracks.length + (opts.cuesFirst && probe.cues ? probe.cues.length : 0);
  const { seekHead, cues } = build(shLen, clusterRel);
  const body = opts.cuesFirst && cues ? [seekHead, info, tracks, cues, cluster] : [seekHead, info, tracks, cluster, ...(cues ? [cues] : [])];
  const segment = opts.unknownSegmentSize ? elUnknown(MKV.Segment, ...body) : el(MKV.Segment, ...body);
  return Buffer.concat([header, segment]);
}

// ---------------------------------------------------------------- ISO-BMFF

export const box = (type: string, ...payload: Buffer[]): Buffer => {
  const body = Buffer.concat(payload);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(body.length + 8, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
export const fullBox = (type: string, version: number, flags: number, ...payload: Buffer[]): Buffer => {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...payload);
};
const u32s = (...v: number[]): Buffer => {
  const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4));
  return b;
};
const i32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v, 0);
  return b;
};
const u64 = (v: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(v), 0);
  return b;
};

/** hvcC: Main 10, compat flags bit 2, tier L, level 153, constraint byte 0xB0. */
export const HVCC = Buffer.from([1, 0x02, 0x20, 0x00, 0x00, 0x00, 0xb0, 0, 0, 0, 0, 0, 153, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0]);
export const AVCC = Buffer.from([1, 0x64, 0x00, 0x29, 0xff, 0xe0]);

/** esds with an AAC LC AudioSpecificConfig: 48 kHz, the given channelConfiguration. */
export function esds(channelConfiguration: number): Buffer {
  const asc = Buffer.from([(2 << 3) | (3 >> 1), ((3 & 1) << 7) | (channelConfiguration << 3)]);
  const dsi = Buffer.concat([Buffer.from([0x05, asc.length]), asc]);
  const dcd = Buffer.concat([Buffer.from([0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), dsi]);
  const es = Buffer.concat([Buffer.from([0x03, 3 + dcd.length, 0, 1, 0]), dcd]);
  return fullBox('esds', 0, 0, es);
}

function trak(id: number, handler: string, timescale: number, entry: Buffer): Buffer {
  return box(
    'trak',
    fullBox('tkhd', 0, 3, u32s(0, 0, id, 0, 0), Buffer.alloc(60)),
    box(
      'mdia',
      fullBox('mdhd', 0, 0, u32s(0, 0, timescale, 0, 0)),
      fullBox('hdlr', 0, 0, u32s(0), Buffer.from(handler, 'latin1'), Buffer.alloc(13)),
      box('minf', box('stbl', fullBox('stsd', 0, 0, u32s(1), entry))),
    ),
  );
}

export const visualEntry = (type: string, ...inner: Buffer[]): Buffer => box(type, Buffer.alloc(78), ...inner);
export const audioEntry = (type: string, ...inner: Buffer[]): Buffer => box(type, Buffer.alloc(28), ...inner);

export interface FakeInitOptions {
  video?: Buffer;
  audio?: Buffer | null;
  videoTimescale?: number;
  /** trex default sample flags of the video track. */
  videoDefaultFlags?: number;
}

/** ftyp + moov with a video track 1 and an audio track 2 (unless audio is null). */
export function fakeInit(o: FakeInitOptions = {}): Buffer {
  const video = o.video ?? visualEntry('hvc1', box('hvcC', HVCC));
  const audio = o.audio === undefined ? audioEntry('mp4a', esds(6)) : o.audio;
  return Buffer.concat([
    box('ftyp', Buffer.from('iso5', 'latin1'), u32s(512), Buffer.from('iso5iso6mp41', 'latin1')),
    box(
      'moov',
      fullBox('mvhd', 0, 0, Buffer.alloc(96)),
      trak(1, 'vide', o.videoTimescale ?? 16_000, video),
      ...(audio ? [trak(2, 'soun', 48_000, audio)] : []),
      box('mvex', fullBox('trex', 0, 0, u32s(1, 1, 0, 0, o.videoDefaultFlags ?? 0x01010000)), ...(audio ? [fullBox('trex', 0, 0, u32s(2, 1, 1024, 0, 0x02000000))] : [])),
    ),
  ]);
}

export interface FakeSample {
  duration: number;
  size: number;
  flags?: number;
  cts?: number;
}

export function traf(trackId: number, baseDecodeTime: number, samples: FakeSample[], opts: { version?: 0 | 1; firstFlags?: number } = {}): Buffer {
  const version = opts.version ?? 1;
  const perSampleFlags = samples.some((s) => s.flags !== undefined);
  const flags = 0x1 | (opts.firstFlags !== undefined ? 0x4 : 0) | 0x100 | 0x200 | (perSampleFlags ? 0x400 : 0) | 0x800;
  const entries = samples.map((s) =>
    Buffer.concat([u32s(s.duration, s.size), ...(perSampleFlags ? [u32s(s.flags ?? 0)] : []), version === 1 ? i32(s.cts ?? 0) : u32s(s.cts ?? 0)]),
  );
  return box(
    'traf',
    fullBox('tfhd', 0, 0x020000, u32s(trackId)),
    fullBox('tfdt', 1, 0, u64(baseDecodeTime)),
    fullBox('trun', version, flags, u32s(samples.length, 0), ...(opts.firstFlags !== undefined ? [u32s(opts.firstFlags)] : []), ...entries),
  );
}

export const SYNC = 0x02000000;
export const NON_SYNC = 0x01010000;

let seq = 0;
/** One fragment (moof + mdat) holding the given trafs; mdat bytes are filler of the sample sizes. */
export function fragment(trafs: Buffer[], mdatBytes: number): Buffer {
  return Buffer.concat([box('moof', fullBox('mfhd', 0, 0, u32s(++seq)), ...trafs), box('mdat', Buffer.alloc(mdatBytes, seq & 0xff))]);
}

/**
 * A fragmented MP4 stream like ffmpeg's: init, then one fragment per video keyframe, keyframe PTS on
 * the original timeline + 10 s. keyframesMs are the keyframe PTS (ms); each GOP has 1 video sample per
 * 40 ms and a 1024-sample audio frame per 21.333 ms.
 */
export function fakeFmp4(keyframesMs: readonly number[], endMs: number, opts: { cts?: number; audio?: boolean } = {}): { init: Buffer; fragments: Buffer[] } {
  const ts = 16_000;
  const init = fakeInit(opts.audio === false ? { audio: null } : {});
  const fragments = keyframesMs.map((k, i) => {
    const next = keyframesMs[i + 1] ?? endMs;
    const n = Math.max(1, Math.round((next - k) / 40));
    const cts = opts.cts ?? 0;
    const video = traf(1, ((k + 10_000) * ts) / 1000 - cts, Array.from({ length: n }, (_, j) => ({ duration: (40 * ts) / 1000, size: 100, flags: j === 0 ? SYNC : NON_SYNC, cts })));
    const audioFrames = Math.max(1, Math.round((next - k) / 21.333));
    const audio = opts.audio === false ? [] : [traf(2, Math.round(((k + 10_000) * 48_000) / 1000), Array.from({ length: audioFrames }, () => ({ duration: 1024, size: 10 })))];
    return fragment([video, ...audio], n * 100 + (opts.audio === false ? 0 : audioFrames * 10));
  });
  return { init, fragments };
}
