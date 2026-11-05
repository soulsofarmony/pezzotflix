// review helper: node rv.mjs initsplit <in> <outInit> ; node rv.mjs elst <file>
import { readFileSync, writeFileSync } from 'node:fs';
const [cmd, a, b] = process.argv.slice(2);
const buf = readFileSync(a);
function* boxes(s, e) { let o = s; while (o + 8 <= e) { let size = buf.readUInt32BE(o); const t = buf.toString('latin1', o + 4, o + 8); let h = 8; if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); h = 16; } if (size === 0) size = e - o; yield { t, o, size, body: o + h, end: o + size }; o += size; } }
if (cmd === 'initsplit') { let end = 0; for (const x of boxes(0, buf.length)) { if (x.t === 'moof') break; end = x.end; } writeFileSync(b, buf.subarray(0, end)); console.log('init bytes', end); }
if (cmd === 'elst') {
  const walk = (s, e, d) => { for (const x of boxes(s, e)) {
    if (['moov', 'trak', 'edts', 'mdia', 'mvex'].includes(x.t)) { console.log(' '.repeat(d) + x.t); walk(x.body, x.end, d + 1); }
    else if (x.t === 'elst') { const v = buf[x.body]; const n = buf.readUInt32BE(x.body + 4); let p = x.body + 8; for (let i = 0; i < n; i++) { const dur = v ? Number(buf.readBigUInt64BE(p)) : buf.readUInt32BE(p); const mt = v ? Number(buf.readBigInt64BE(p + 8)) : buf.readInt32BE(p + 4); p += v ? 16 : 8; p += 4; console.log(' '.repeat(d) + `elst[${i}] dur=${dur} media_time=${mt}`); } }
    else if (['mvhd', 'tkhd', 'mdhd', 'mehd'].includes(x.t)) { const v = buf[x.body]; let dur; if (x.t === 'mvhd' || x.t === 'mdhd') dur = v ? Number(buf.readBigUInt64BE(x.body + 24)) : buf.readUInt32BE(x.body + 16); else if (x.t === 'tkhd') dur = v ? Number(buf.readBigUInt64BE(x.body + 28)) : buf.readUInt32BE(x.body + 20); else dur = v ? Number(buf.readBigUInt64BE(x.body + 4)) : buf.readUInt32BE(x.body + 4); console.log(' '.repeat(d) + `${x.t} dur=${dur}`); }
  } };
  for (const x of boxes(0, buf.length)) if (x.t === 'moov') walk(x.body, x.end, 0);
}
