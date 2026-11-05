// Throwaway (ADR 0003).
//   node helpers.mjs supshift <in.sup> <out.sup> <copies> <stepSeconds>  -> one .sup with the input repeated, PTS shifted
//   node helpers.mjs supinfo <file.sup>                                  -> display sets (PCS count) and PTS range
//   node helpers.mjs naltypes <file.hevc>                                -> NAL unit type histogram of an Annex B stream
import { readFileSync, writeFileSync } from 'node:fs';
const [cmd, a, b, c, d] = process.argv.slice(2);
function* segs(buf) { for (let o = 0; o + 13 <= buf.length;) { const len = buf.readUInt16BE(o + 11); yield { o, pts: buf.readUInt32BE(o + 2), type: buf[o + 10], end: o + 13 + len }; o += 13 + len; } }
if (cmd === 'supshift') {
  const src = readFileSync(a); const parts = [];
  for (let i = 0; i < Number(c); i++) {
    const copy = Buffer.from(src);
    for (const s of segs(copy)) { copy.writeUInt32BE((s.pts + i * Number(d) * 90000) >>> 0, s.o + 2); copy.writeUInt32BE(0, s.o + 6); if (process.env.DTS_EQ_PTS) copy.writeUInt32BE((s.pts + i * Number(d) * 90000) >>> 0, s.o + 6); }
    parts.push(copy);
  }
  writeFileSync(b, Buffer.concat(parts));
} else if (cmd === 'supinfo') {
  const pts = [...segs(readFileSync(a))].filter((s) => s.type === 0x16).map((s) => s.pts / 90000);
  console.log(`displaySets=${pts.length} first=${pts[0]?.toFixed(3)} last=${pts.at(-1)?.toFixed(3)} sorted=${pts.every((p, i) => !i || p >= pts[i - 1])}`);
} else if (cmd === 'naltypes') {
  const buf = readFileSync(a); const h = {};
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { const t = (buf[i + 3] >> 1) & 0x3f; h[t] = (h[t] ?? 0) + 1; i += 3; }
  console.log(JSON.stringify(h));
}
