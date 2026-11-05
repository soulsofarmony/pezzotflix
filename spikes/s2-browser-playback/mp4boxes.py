"""S2 follow-up (throwaway): tiny ISO-BMFF box walker for the variants rebuilt by boxes.sh.

python -I spikes/s2-browser-playback/mp4boxes.py [boxes_dir]   (default: out/boxes/) -> markdown on stdout

Per build directory (host/, jellyfin/) it reads:
  - init.mp4 of h2/h6/h7/h8 and the moov of p1: sample entry, hvcC, colr (nclx), mdcv, clli, dvcC/dvvC/dvwC;
  - every media segment (moof/trun -> samples of the video track): HEVC NAL unit types per sample,
    RPU (type 62) and EL (type 63) counts, SEI payload types (137 mastering display, 144 content light, HDR10+);
  - dune-src.hevc (Annex B of the MKV source) for the same NAL counts;
  - aac/*.mp4: esds AudioSpecificConfig -> channelConfiguration, or the PCE when it is 0;
  - probe/*.json written by ffprobe.
"""
import json
import struct
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
BOXES = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "out" / "boxes"
VARIANTS = ["h2-hevc-hdr10-aac", "h6-dv81-as-hvc1-aac", "h7-dv81-as-dvh1-aac", "h8-dv5-as-dvh1-aac", "p1-hevc-hdr10-flac51-frag.mp4"]


def boxes(buf, start, end):
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack_from(">I4s", buf, i)
        hdr = 8
        if size == 1:
            size, hdr = struct.unpack_from(">Q", buf, i + 8)[0], 16
        elif size == 0:
            size = end - i
        if size < hdr or i + size > end:
            return
        yield typ.decode("latin-1"), i, i + hdr, i + size
        i += size


def child(buf, start, end, name):
    return next(((s, ps, e) for t, s, ps, e in boxes(buf, start, end) if t == name), None)


class Bits:
    def __init__(self, data):
        self.d, self.p = data, 0

    def u(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.d[self.p >> 3] >> (7 - (self.p & 7))) & 1)
            self.p += 1
        return v


def parse_pce(b):
    b.u(4), b.u(2), b.u(4)  # element_instance_tag, object_type, sampling_frequency_index
    nf, ns, nb, nl, na, nc = b.u(4), b.u(4), b.u(4), b.u(2), b.u(3), b.u(4)
    if b.u(1):
        b.u(4)  # mono mixdown
    if b.u(1):
        b.u(4)  # stereo mixdown
    if b.u(1):
        b.u(3)  # matrix mixdown idx + pseudo surround

    def elems(n):
        out = []
        for _ in range(n):
            cpe = b.u(1)
            b.u(4)
            out.append("CPE" if cpe else "SCE")
        return out

    front, side, back = elems(nf), elems(ns), elems(nb)
    ch = sum(2 if x == "CPE" else 1 for x in front + side + back) + nl
    return f"front {'+'.join(front) or '-'} · side {'+'.join(side) or '-'} · back {'+'.join(back) or '-'} · lfe {nl} ({ch} ch)"


def parse_asc(asc):
    b = Bits(asc)
    aot = b.u(5)
    if aot == 31:
        aot = 32 + b.u(6)
    sfi = b.u(4)
    if sfi == 15:
        b.u(24)
    ch = b.u(4)
    out = {"aot": aot, "channelConfiguration": ch, "pce": None}
    if ch == 0 and aot in (1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23):
        b.u(1)  # frameLengthFlag
        if b.u(1):
            b.u(14)  # coreCoderDelay
        b.u(1)  # extensionFlag
        out["pce"] = parse_pce(b)
    return out


def parse_esds(buf, ps, e):
    p = ps + 4

    def desc(p):
        tag, size = buf[p], 0
        p += 1
        for _ in range(4):
            c = buf[p]
            p += 1
            size = (size << 7) | (c & 0x7F)
            if not c & 0x80:
                break
        return tag, p, size

    tag, p, _ = desc(p)
    if tag != 3:
        return None
    flags = buf[p + 2]
    p += 3
    if flags & 0x80:
        p += 2
    if flags & 0x40:
        p += 1 + buf[p]
    if flags & 0x20:
        p += 2
    tag, p, _ = desc(p)
    if tag != 4:
        return None
    p += 13
    tag, p, size = desc(p)
    return bytes(buf[p:p + size]) if tag == 5 else None


def unescape(n):
    out, z = bytearray(), 0
    for x in n:
        if z >= 2 and x == 3:
            z = 0
            continue
        out.append(x)
        z = z + 1 if x == 0 else 0
    return bytes(out)


def sei_types(nal):
    r, p, res = unescape(nal[2:]), 0, []
    while p < len(r) - 1:
        t = 0
        while p < len(r) and r[p] == 0xFF:
            t, p = t + 255, p + 1
        if p >= len(r):
            break
        t, p = t + r[p], p + 1
        sz = 0
        while p < len(r) and r[p] == 0xFF:
            sz, p = sz + 255, p + 1
        if p >= len(r):
            break
        sz, p = sz + r[p], p + 1
        pl = r[p:p + sz]
        p += sz
        res.append("4/HDR10+" if t == 4 and pl[:3] == b"\xb5\x00\x3c" else str(t))
    return res


def parse_dovi(buf, ps):
    d = buf[ps:ps + 5]
    return {"ver": f"{d[0]}.{d[1]}", "profile": (d[2] >> 1) & 0x7F, "level": ((d[2] & 1) << 5) | (d[3] >> 3),
            "rpu": (d[3] >> 2) & 1, "el": (d[3] >> 1) & 1, "bl": d[3] & 1, "compat": d[4] >> 4}


def parse_entry(buf, et, ps, e, handler):
    ent = {"type": et, "children": []}
    kids = boxes(buf, ps + (78 if handler == "vide" else 28), e)
    for t, s, cps, ce in kids:
        ent["children"].append(t)
        if t == "hvcC":
            d = buf[cps:ce]
            ent["hvcC"] = {"profile": d[1] & 0x1F, "tier": "H" if d[1] & 0x20 else "L", "level": d[12], "ls": (d[21] & 3) + 1}
            n, p, types, seis = d[22], 23, [], []
            for _ in range(n):
                nt, cnt = d[p] & 0x3F, struct.unpack_from(">H", d, p + 1)[0]
                p += 3
                for _ in range(cnt):
                    ln = struct.unpack_from(">H", d, p)[0]
                    types.append(nt)
                    if nt in (39, 40):
                        seis += sei_types(d[p + 2:p + 2 + ln])
                    p += 2 + ln
            ent["hvcC"]["arrays"], ent["hvcC"]["sei"] = types, seis
        elif t == "colr":
            ct = buf[cps:cps + 4].decode("latin-1")
            if ct == "nclx":
                pr, tr, mx = struct.unpack_from(">HHH", buf, cps + 4)
                ent["colr"] = f"nclx {pr}/{tr}/{mx} full_range={buf[cps + 10] >> 7}"
            elif ct == "nclc":
                ent["colr"] = "nclc %d/%d/%d" % struct.unpack_from(">HHH", buf, cps + 4)
            else:
                ent["colr"] = ct
        elif t == "mdcv":
            v = struct.unpack_from(">8H2I", buf, cps)
            ent["mdcv"] = f"max {v[8] / 10000:g} cd/m², min {v[9] / 10000:g}"
        elif t == "clli":
            ent["clli"] = "MaxCLL %d, MaxFALL %d" % struct.unpack_from(">HH", buf, cps)
        elif t in ("dvcC", "dvvC", "dvwC"):
            ent["dovi"] = (t, parse_dovi(buf, cps))
        elif t == "esds":
            asc = parse_esds(buf, cps, ce)
            ent["asc"] = parse_asc(asc) if asc else None
        elif t == "dfLa":
            si = cps + 4 + 4  # fullbox + metadata block header
            ent["flac_channels"] = ((buf[si + 12] >> 1) & 7) + 1
    return ent


def parse_moov(buf):
    out = {"ftyp": None, "tracks": []}
    for t, s, ps, e in boxes(buf, 0, len(buf)):
        if t == "ftyp":
            out["ftyp"] = buf[ps:ps + 4].decode("latin-1") + " [" + " ".join(
                buf[i:i + 4].decode("latin-1") for i in range(ps + 8, e, 4)) + "]"
        if t != "moov":
            continue
        for tt, ts, tps, te in boxes(buf, ps, e):
            if tt != "trak":
                continue
            tr = {"id": None, "handler": None, "entries": []}
            tk = child(buf, tps, te, "tkhd")
            if tk:
                tr["id"] = struct.unpack_from(">I", buf, tk[1] + (20 if buf[tk[1]] == 1 else 12))[0]
            md = child(buf, tps, te, "mdia")
            hd = child(buf, md[1], md[2], "hdlr")
            tr["handler"] = buf[hd[1] + 8:hd[1] + 12].decode("latin-1")
            mi = child(buf, md[1], md[2], "minf")
            st = child(buf, mi[1], mi[2], "stbl")
            sd = child(buf, st[1], st[2], "stsd")
            for et, es, eps, ee in boxes(buf, sd[1] + 8, sd[2]):
                tr["entries"].append(parse_entry(buf, et, eps, ee, tr["handler"]))
            out["tracks"].append(tr)
    return out


def samples(buf, tid):
    """Yield the samples of track `tid` from every moof/traf/trun in buf."""
    for t, s, ps, e in boxes(buf, 0, len(buf)):
        if t != "moof":
            continue
        prev_end = s
        for tt, ts, tps, te in boxes(buf, ps, e):
            if tt != "traf":
                continue
            fh = child(buf, tps, te, "tfhd")
            fl = int.from_bytes(buf[fh[1] + 1:fh[1] + 4], "big")
            ftid = struct.unpack_from(">I", buf, fh[1] + 4)[0]
            q, base, dsize = fh[1] + 8, None, None
            if fl & 0x1:
                base = struct.unpack_from(">Q", buf, q)[0]
                q += 8
            if fl & 0x2:
                q += 4
            if fl & 0x8:
                q += 4
            if fl & 0x10:
                dsize = struct.unpack_from(">I", buf, q)[0]
                q += 4
            if base is None:
                base = s if fl & 0x20000 else prev_end
            pos = base
            for rt, rs, rps, re_ in boxes(buf, tps, te):
                if rt != "trun":
                    continue
                rf = int.from_bytes(buf[rps + 1:rps + 4], "big")
                n = struct.unpack_from(">I", buf, rps + 4)[0]
                q = rps + 8
                if rf & 0x1:
                    pos = base + struct.unpack_from(">i", buf, q)[0]
                    q += 4
                if rf & 0x4:
                    q += 4
                for _ in range(n):
                    if rf & 0x100:
                        q += 4
                    size = dsize
                    if rf & 0x200:
                        size = struct.unpack_from(">I", buf, q)[0]
                        q += 4
                    if rf & 0x400:
                        q += 4
                    if rf & 0x800:
                        q += 4
                    if ftid == tid:
                        yield buf[pos:pos + size]
                    pos += size
            prev_end = pos


def nal_stats(nals_per_au):
    st = {"au": 0, "pics": 0, "au_with_rpu": 0, "types": Counter(), "sei": Counter()}
    for au in nals_per_au:
        st["au"] += 1
        has_rpu = False
        for nal in au:
            if len(nal) < 2:
                continue
            t = (nal[0] >> 1) & 0x3F
            st["types"][t] += 1
            if t < 32 and len(nal) > 2 and nal[2] & 0x80:
                st["pics"] += 1
            if t == 62:
                has_rpu = True
            if t in (39, 40):
                st["sei"].update(sei_types(bytes(nal)))
        st["au_with_rpu"] += has_rpu
    return st


def mp4_aus(buf, tid, ls):
    for smp in samples(buf, tid):
        p, nals = 0, []
        while p + ls <= len(smp):
            ln = int.from_bytes(smp[p:p + ls], "big")
            p += ls
            nals.append(smp[p:p + ln])
            p += ln
        yield nals


def annexb_aus(buf):
    """Split an Annex B stream into access units (a new AU starts at a VCL NAL with first_slice_segment_in_pic_flag)."""
    au, i = [], buf.find(b"\x00\x00\x01")
    while i >= 0:
        j = buf.find(b"\x00\x00\x01", i + 3)
        nal = buf[i + 3:(j if j >= 0 else len(buf))]
        if j >= 0 and nal[-1:] == b"\x00":
            nal = nal[:-1]
        t = (nal[0] >> 1) & 0x3F if nal else -1
        if t in (32, 33, 34, 35, 39) or (0 <= t < 32 and len(nal) > 2 and nal[2] & 0x80):
            if any(((x[0] >> 1) & 0x3F) < 32 for x in au if x):  # previous AU already has its picture
                yield au
                au = []
        au.append(nal)
        i = j
    if au:
        yield au


def fmt_types(c):
    names = {32: "VPS", 33: "SPS", 34: "PPS", 35: "AUD", 39: "SEI", 40: "SEI-suf", 62: "RPU", 63: "EL"}
    return ", ".join(f"{names.get(t, t)}×{n}" for t, n in sorted(c.items()))


def load_json(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def side_data(stream):
    out = []
    for sd in stream.get("side_data_list", []):
        t = sd.get("side_data_type")
        if t == "DOVI configuration record":
            t += (f" (P{sd.get('dv_profile')} L{sd.get('dv_level')} rpu={sd.get('rpu_present_flag')} el={sd.get('el_present_flag')}"
                  f" bl={sd.get('bl_present_flag')} compat={sd.get('dv_bl_signal_compatibility_id')})")
        out.append(t)
    return "; ".join(out) or "nessuno"


def report_build(d):
    print(f"\n## {d.name}: {(d / 'version.txt').read_text(encoding='utf-8').strip()}\n")
    print("### Init / moov\n")
    print("| Variante | ftyp | Sample entry | hvcC | colr | mdcv | clli | Box DV | Altri box nella sample entry | Audio |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    stats = {}
    for v in VARIANTS:
        f = d / v / "init.mp4" if not v.endswith(".mp4") else d / v
        if not f.exists():
            continue
        buf = f.read_bytes()
        mv = parse_moov(buf)
        vt = next(t for t in mv["tracks"] if t["handler"] == "vide")
        at = next((t for t in mv["tracks"] if t["handler"] == "soun"), None)
        ve = vt["entries"][0]
        h = ve.get("hvcC", {})
        hv = f"P{h.get('profile')} {h.get('tier')}{h.get('level')}, len {h.get('ls')}, array {h.get('arrays')}" + (f", SEI {h['sei']}" if h.get("sei") else "")
        dv = f"{ve['dovi'][0]} v{ve['dovi'][1]['ver']} P{ve['dovi'][1]['profile']} L{ve['dovi'][1]['level']} rpu={ve['dovi'][1]['rpu']} el={ve['dovi'][1]['el']} bl={ve['dovi'][1]['bl']} compat={ve['dovi'][1]['compat']}" if ve.get("dovi") else "assente"
        others = [c for c in ve["children"] if c not in ("hvcC", "colr", "mdcv", "clli", "dvcC", "dvvC", "dvwC")]
        au = "-"
        if at:
            ae = at["entries"][0]
            au = ae["type"] + (f" chanConfig {ae['asc']['channelConfiguration']}" if ae.get("asc") else "") + (f" {ae['flac_channels']} ch" if ae.get("flac_channels") else "")
        print(f"| {v.split('-')[0]} | {mv['ftyp']} | {ve['type']} | {hv} | {ve.get('colr', 'assente')} | {ve.get('mdcv', 'assente')} | "
              f"{ve.get('clli', 'assente')} | {dv} | {', '.join(others) or '-'} | {au} |")
        # NAL statistics over every media segment of the variant
        segs = sorted((d / v).glob("index*.m4s"), key=lambda p: int(p.stem[5:])) if not v.endswith(".mp4") else [f]
        aus = []
        for sp in segs:
            sb = sp.read_bytes()
            aus.append(nal_stats(mp4_aus(memoryview(sb), vt["id"], h.get("ls", 4))))
        tot = {"au": sum(a["au"] for a in aus), "pics": sum(a["pics"] for a in aus), "au_with_rpu": sum(a["au_with_rpu"] for a in aus),
               "types": sum((a["types"] for a in aus), Counter()), "sei": sum((a["sei"] for a in aus), Counter()), "segs": len(segs),
               "first": aus[0] if aus else None}
        stats[v.split("-")[0]] = tot
    src = d / "dune-src.hevc"
    if src.exists():
        stats["Dune MKV (sorgente di h6/h7)"] = {**nal_stats(annexb_aus(src.read_bytes())), "segs": "-", "first": None}
    print("\n### Unità NAL del video (tutti i segmenti)\n")
    print("| Variante | Segmenti | Access unit | Picture | AU con RPU (tipo 62) | NAL EL (tipo 63) | SEI (payloadType) | Tipi NAL |")
    print("|---|---|---|---|---|---|---|---|")
    for k, s in stats.items():
        sei = ", ".join(f"{t}×{n}" for t, n in sorted(s["sei"].items())) or "nessuno"
        print(f"| {k} | {s['segs']} | {s['au']} | {s['pics']} | {s['au_with_rpu']} | {s['types'].get(63, 0)} | {sei} | {fmt_types(s['types'])} |")
    if stats.get("h6") and stats["h6"]["first"]:
        f6 = stats["h6"]["first"]
        print(f"\nh6, primo segmento: {f6['au']} access unit, {f6['au_with_rpu']} con RPU.")

    print("\n### ffprobe: campi dello stream video e side data\n")
    print("| File | codec_tag | primaries / transfer / space / range | Side data dello stream |")
    print("|---|---|---|---|")
    for p in sorted((d / "probe").glob("*.json")):
        if p.name.startswith(("frames-", "audio-", "aac-")):
            continue
        st = (load_json(p).get("streams") or [{}])[0]
        print(f"| {p.stem} | {st.get('codec_tag_string')} | {st.get('color_primaries')} / {st.get('color_transfer')} / "
              f"{st.get('color_space')} / {st.get('color_range')} | {side_data(st)} |")
    print("\n### ffprobe: side data dei primi 8 frame decodificati\n")
    for p in sorted((d / "probe").glob("frames-*.json")):
        fr = load_json(p).get("frames", [])
        c = Counter(sd.get("side_data_type") for f in fr for sd in f.get("side_data_list", []))
        print(f"- {p.stem}: {len(fr)} frame; " + (", ".join(f"{t} ×{n}" for t, n in c.items()) or "nessun side data"))

    print("\n### AAC 5.1: AudioSpecificConfig\n")
    print("| Prova | AOT | channelConfiguration | PCE | Layout per ffprobe | Log dell'encoder |")
    print("|---|---|---|---|---|---|")
    for p in sorted((d / "aac").glob("*.mp4")):
        buf = p.read_bytes()
        mv = parse_moov(buf)
        ae = mv["tracks"][0]["entries"][0]
        asc = ae.get("asc") or {}
        st = (load_json(d / "probe" / f"aac-{p.stem}.json").get("streams") or [{}])[0]
        log = (d / "log" / f"aac-{p.stem}.log").read_text(encoding="utf-8", errors="replace")
        pce_log = next((ln.strip() for ln in log.splitlines() if "PCE" in ln), "-")
        print(f"| {p.stem} | {asc.get('aot')} | {asc.get('channelConfiguration')} | {asc.get('pce') or '-'} | "
              f"{st.get('channel_layout')} ({st.get('channels')} ch) | {pce_log.replace('|', '/')} |")

    print("\n### Layout audio delle fixture S1 secondo ffprobe\n")
    for p in sorted((d / "probe").glob("audio-*.json")):
        ss = load_json(p).get("streams", [])
        print(f"- {p.stem[6:]}: " + "; ".join(
            f"#{s.get('index')} {s.get('codec_name')}{' (' + s['profile'] + ')' if s.get('profile') else ''} "
            f"{(s.get('tags') or {}).get('language', '')} {s.get('channels')} ch {s.get('channel_layout')}" for s in ss))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    for d in sorted(p for p in BOXES.iterdir() if p.is_dir()):
        report_build(d)


if __name__ == "__main__":
    main()
