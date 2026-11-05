// Throwaway (ADR 0003 experiments). Minimal ISO-BMFF reader:
//   node mp4inspect.mjs init <file>            -> tracks, sample entries, codec strings, AAC channelConfiguration
//   node mp4inspect.mjs frags <file> [<file>]  -> per moof: track, tfdt (s), first pts (s), duration (s), samples
// Accepts a single fragmented file (many moof) or a list of segment files.
import { readFileSync } from 'node:fs';

const u32 = (b, o) => b.readUInt32BE(o);
const u64 = (b, o) => Number(b.readBigUInt64BE(o));
const type = (b, o) => b.toString('latin1', o, o + 4);

function* boxes(b, start = 0, end = b.length) {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const t = type(b, o + 4);
    let hdr = 8;
    if (size === 1) { size = u64(b, o + 8); hdr = 16; }
    if (size === 0) size = end - o;
    yield { t, o, size, body: o + hdr, end: o + size };
    o += size;
  }
}
const child = (b, box, t) => { for (const c of boxes(b, box.body, box.end)) if (c.t === t) return c; return null; };
const children = (b, box, t) => [...boxes(b, box.body, box.end)].filter((c) => c.t === t);

class Bits { constructor(buf) { this.b = buf; this.p = 0; } read(n) { let v = 0; for (let i = 0; i < n; i++) { v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; } return v; } }

function hvcCString(b, box, fourcc) {
  const o = box.body;
  const ps = b[o + 1] >> 6, tier = (b[o + 1] >> 5) & 1, pidc = b[o + 1] & 31;
  let compat = u32(b, o + 2), rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const cons = [...b.subarray(o + 6, o + 12)];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  const level = b[o + 12];
  return [fourcc, `${['', 'A', 'B', 'C'][ps]}${pidc}`, (rev >>> 0).toString(16).toUpperCase(), `${tier ? 'H' : 'L'}${level}`, ...cons.map((c) => c.toString(16).toUpperCase())].join('.');
}

function esdsInfo(b, box) {
  let o = box.body + 4; // version/flags
  const readDesc = () => { const tag = b[o++]; let len = 0, c; do { c = b[o++]; len = (len << 7) | (c & 0x7f); } while (c & 0x80); return { tag, len, start: o }; };
  let d = readDesc(); if (d.tag !== 3) return null; o += 2; const flags = b[o++]; if (flags & 0x80) o += 2; if (flags & 0x40) o += 1 + b[o]; if (flags & 0x20) o += 2;
  d = readDesc(); if (d.tag !== 4) return null; const oti = b[o]; o += 13;
  d = readDesc(); if (d.tag !== 5) return { oti };
  const bits = new Bits(b.subarray(o, o + d.len));
  let aot = bits.read(5); if (aot === 31) aot = 32 + bits.read(6);
  const fi = bits.read(4); if (fi === 15) bits.read(24);
  const channelConfiguration = bits.read(4);
  return { oti, aot, channelConfiguration, codec: `mp4a.${oti.toString(16)}.${aot}` };
}

function init(file) {
  const b = readFileSync(file);
  const out = { brands: null, tracks: [] };
  for (const top of boxes(b)) {
    if (top.t === 'ftyp') out.brands = [type(b, top.body), ...Array.from({ length: (top.end - top.body - 8) / 4 }, (_, i) => type(b, top.body + 8 + i * 4))].join(' ');
    if (top.t !== 'moov') continue;
    for (const trak of children(b, top, 'trak')) {
      const tkhd = child(b, trak, 'tkhd'); const v = b[tkhd.body];
      const id = u32(b, tkhd.body + (v ? 20 : 12));
      const mdia = child(b, trak, 'mdia'); const mdhd = child(b, mdia, 'mdhd');
      const ts = u32(b, mdhd.body + (b[mdhd.body] ? 20 : 12));
      const stsd = child(b, child(b, child(b, mdia, 'minf'), 'stbl'), 'stsd');
      const entry = [...boxes(b, stsd.body + 8, stsd.end)][0];
      const t = { id, timescale: ts, entry: entry.t };
      const inner = entry.t.match(/^(hvc1|hev1|avc1|avc3|dvh1|dvhe)$/) ? entry.body + 78 : entry.body + 28;
      for (const c of boxes(b, inner, entry.end)) {
        if (c.t === 'hvcC') t.codec = hvcCString(b, c, entry.t);
        if (c.t === 'avcC') t.codec = `${entry.t}.${b.subarray(c.body + 1, c.body + 4).toString('hex').toUpperCase()}`;
        if (c.t === 'esds') Object.assign(t, esdsInfo(b, c));
        if (c.t === 'dfLa') t.codec = 'flac';
        if (c.t === 'dOps') { t.codec = 'opus'; t.channels = b[c.body + 1]; }
        if (['dvcC', 'dvvC', 'colr', 'mdcv', 'clli', 'chnl'].includes(c.t)) (t.extra ??= []).push(c.t);
      }
      if (entry.t === 'ac-3' || entry.t === 'ec-3') t.codec = entry.t;
      out.tracks.push(t);
    }
  }
  return out;
}

function frags(files, timescales) {
  const rows = [];
  for (const f of files) {
    const b = readFileSync(f);
    for (const top of boxes(b)) {
      if (top.t !== 'moof') continue;
      for (const traf of children(b, top, 'traf')) {
        const tfhd = child(b, traf, 'tfhd'); const id = u32(b, tfhd.body + 4); const tf = u32(b, tfhd.body) & 0xffffff;
        let defDur = 0; let p = tfhd.body + 8; if (tf & 1) p += 8; if (tf & 2) p += 4; if (tf & 8) defDur = u32(b, p);
        const tfdt = child(b, traf, 'tfdt'); const dt = b[tfdt.body] ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4);
        let dur = 0, n = 0, firstCts = 0;
        for (const trun of children(b, traf, 'trun')) {
          const v = b[trun.body]; const fl = u32(b, trun.body) & 0xffffff; n += u32(b, trun.body + 4);
          let q = trun.body + 8; if (fl & 1) q += 4; if (fl & 4) q += 4;
          for (let i = 0; i < u32(b, trun.body + 4); i++) {
            let d = defDur; if (fl & 0x100) { d = u32(b, q); q += 4; } if (fl & 0x200) q += 4; if (fl & 0x400) q += 4;
            if (fl & 0x800) { const c = v ? b.readInt32BE(q) : u32(b, q); if (i === 0 && dur === 0) firstCts = c; q += 4; }
            dur += d;
          }
        }
        const ts = timescales[id] ?? 1;
        rows.push({ file: f.split('/').pop(), track: id, tfdt: +(dt / ts).toFixed(4), pts0: +((dt + firstCts) / ts).toFixed(4), dur: +(dur / ts).toFixed(4), n });
      }
    }
  }
  return rows;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'init') console.log(JSON.stringify(init(args[0])));
else if (cmd === 'frags') {
  const [initFile, ...rest] = args; // timescales come from the init (or the same file)
  const ts = Object.fromEntries(init(initFile).tracks.map((t) => [t.id, t.timescale]));
  for (const r of frags(rest.length ? rest : [initFile], ts)) console.log(Object.values(r).join('\t'));
}
