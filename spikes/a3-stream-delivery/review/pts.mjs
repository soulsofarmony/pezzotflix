// node pts.mjs <file> <fromSec> <toSec>: sorted video sample PTS (track 1, timescale from mdhd) in fragments whose keyframe PTS is in [from,to)
import { readFileSync } from 'node:fs';
const [f, from, to] = process.argv.slice(2); const b = readFileSync(f);
function* boxes(s, e) { let o = s; while (o + 8 <= e) { let z = b.readUInt32BE(o); const t = b.toString('latin1', o + 4, o + 8); let h = 8; if (z === 1) { z = Number(b.readBigUInt64BE(o + 8)); h = 16; } if (z === 0) z = e - o; yield { t, o, body: o + h, end: o + z }; o += z; } }
const kid = (x, t) => [...boxes(x.body, x.end)].filter((c) => c.t === t);
let ts = 0; for (const top of boxes(0, b.length)) if (top.t === 'moov') for (const trak of kid(top, 'trak')) { const md = kid(kid(trak, 'mdia')[0], 'mdhd')[0]; const v = b[md.body]; const s = b.readUInt32BE(md.body + (v ? 20 : 12)); if (!ts) ts = s; }
const out = [];
for (const top of boxes(0, b.length)) { if (top.t !== 'moof') continue; for (const traf of kid(top, 'traf')) {
  const tfhd = kid(traf, 'tfhd')[0]; if (b.readUInt32BE(tfhd.body + 4) !== 1) continue; const tf = b.readUInt32BE(tfhd.body) & 0xffffff; let p = tfhd.body + 8, dd = 0; if (tf & 1) p += 8; if (tf & 2) p += 4; if (tf & 8) dd = b.readUInt32BE(p);
  const tfdt = kid(traf, 'tfdt')[0]; let dts = b[tfdt.body] ? Number(b.readBigUInt64BE(tfdt.body + 4)) : b.readUInt32BE(tfdt.body + 4);
  const pts = []; for (const trun of kid(traf, 'trun')) { const v = b[trun.body], fl = b.readUInt32BE(trun.body) & 0xffffff, n = b.readUInt32BE(trun.body + 4); let q = trun.body + 8; if (fl & 1) q += 4; if (fl & 4) q += 4;
    for (let i = 0; i < n; i++) { let d = dd, c = 0; if (fl & 0x100) { d = b.readUInt32BE(q); q += 4; } if (fl & 0x200) q += 4; if (fl & 0x400) q += 4; if (fl & 0x800) { c = v ? b.readInt32BE(q) : b.readUInt32BE(q); q += 4; } pts.push((dts + c) / ts); dts += d; } }
  if (pts[0] >= +from && pts[0] < +to) out.push(...pts);
} }
console.log(out.sort((x, y) => x - y).map((x) => x.toFixed(3)).join(' '));
