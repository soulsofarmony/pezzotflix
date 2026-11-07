"""S5 (throwaway): tables from the app's logcat lines (tag PZF_S5) saved by run_tests.sh.

Usage: python -I summarize.py out/results/<group> [...]. Prints one row per run and writes <group>/summary.json.
"""
import json
import pathlib
import re
import sys

LINE = re.compile(r"PZF_S5\s*:\s(.*)$")
CHUNK = re.compile(r"#chunk (\d+) (\d+)/(\d+) (.*)$")


def events(path: pathlib.Path) -> list[dict]:
    out, chunks = [], {}
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = LINE.search(raw)
        if not m:
            continue
        body = m.group(1)
        c = CHUNK.match(body)
        if c:
            cid, i, n, part = c.group(1), int(c.group(2)), int(c.group(3)), c.group(4)
            chunks.setdefault(cid, {})[i] = part
            if len(chunks[cid]) == n:
                body = "".join(chunks[cid][k] for k in range(1, n + 1))
            else:
                continue
        try:
            out.append(json.loads(body))
        except json.JSONDecodeError:
            pass
    return out


def pss_from_meminfo(p: pathlib.Path) -> dict:
    if not p.exists():
        return {}
    t = p.read_text(errors="replace")
    r = {}
    for key, label in (("TOTAL PSS", "TOTAL PSS:"), ("Java Heap", "Java Heap:"), ("Native Heap", "Native Heap:"), ("Graphics", "Graphics:")):
        m = re.search(re.escape(label) + r"\s+(\d+)", t)
        if m:
            r[key] = int(m.group(1)) // 1024
    if "TOTAL PSS" not in r:
        m = re.search(r"TOTAL\s+(\d+)", t)
        if m:
            r["TOTAL PSS"] = int(m.group(1)) // 1024
    return r


for d in map(pathlib.Path, sys.argv[1:]):
    rows = []
    for log in sorted(d.glob("*.log")):
        ev = events(log)
        s = next((e for e in ev if e.get("ev") == "summary"), {})
        at = [e for e in ev if e.get("ev") == "audioTrack"]
        start = next((e for e in ev if e.get("ev") == "start"), {})
        errs = [e for e in ev if e.get("ev") in ("error", "audioSinkError", "audioCodecError", "videoCodecError")]
        tracks = next((e for e in ev if e.get("ev") == "tracks"), {}).get("tracks", [])
        sel_audio = [t for t in tracks if t.get("type") == 1 and t.get("selected")]
        net = next((e for e in ev if e.get("ev") == "netSummary"), None)
        row = {
            "run": log.stem,
            "ffmpeg": start.get("ffmpeg"),
            "videoDecoder": s.get("videoDecoder"),
            "hdr": s.get("hdr"),
            "startReadyMs": s.get("startupReadyMs"),
            "firstFrameMs": s.get("startupFirstFrameMs"),
            "seeks": s.get("seeks"),
            "dropped": s.get("dropped"),
            "rendered": s.get("rendered"),
            "rebuffers": s.get("rebuffers"),
            "rebufferMs": s.get("rebufferMs"),
            "audioIn": (s.get("audio") or "")[:120],
            "audioDecoder": s.get("audioDecoder"),
            "audioOut": s.get("audioOut"),
            "audioTracks": [f"{e.get('encoding')} {e.get('channels')}ch {e.get('sampleRate')}" for e in at],
            "audioSelectedSupport": [t.get("support") for t in sel_audio],
            "underruns": s.get("underruns"),
            "maxPssMb": round(s.get("maxPssKb", 0) / 1024) if s else None,
            "maxAllocMb": round(s.get("maxAllocBytes", 0) / 1048576) if s else None,
            "cues": s.get("cues"),
            "meminfo": pss_from_meminfo(d / f"{log.stem}.meminfo.txt"),
            "errors": [f"{e.get('ev')}: {e.get('code', '')} {str(e.get('msg') or e.get('e'))[:160]}" for e in errs][:3],
            "net": net,
        }
        rows.append(row)
        if net:
            print(f"{log.stem}: avg {net['avgMbps']:.1f} median {net['medianMbps']:.1f} min1s {net['minMbps']:.1f} p5 {net['p5Mbps']:.1f} worst5s {net['worst5sMbps']:.1f} best5s {net['best5sMbps']:.1f} Mb/s")
            continue
        sk = "; ".join(f"{x.get('toMs')}ms->ready {x.get('readyMs')} frame {x.get('firstFrameMs')}" for x in (row["seeks"] or []))
        print(f"{row['run']:22} ff={row['ffmpeg']} vdec={row['videoDecoder']} hdr={row['hdr']} start={row['startReadyMs']}/{row['firstFrameMs']}ms seek[{sk}] "
              f"drop={row['dropped']}/{row['rendered']} rebuf={row['rebuffers']}({row['rebufferMs']}ms) adec={row['audioDecoder']} aout={row['audioOut']} "
              f"pss={row['maxPssMb']}MB alloc={row['maxAllocMb']}MB cues={row['cues']} mem={row['meminfo']} err={row['errors']}")
    (d / "summary.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
