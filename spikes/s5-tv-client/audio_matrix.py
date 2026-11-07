"""S5 (throwaway): Q1 matrix from the audio runs: selected track, decoder, AudioTrack config, AudioFlinger threads.

Usage: python -I audio_matrix.py out/results/audio-off out/results/audio-on ...
"""
import json
import pathlib
import re
import sys


def events(log: pathlib.Path):
    chunks = {}
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        if "PZF_S5" not in line or "{" not in line and "#chunk" not in line:
            continue
        body = line.split(": ", 1)[1] if ": " in line else line
        m = re.match(r"#chunk (\S+) (\d+)/(\d+) (.*)", body)
        if m:
            cid, i, n, part = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
            chunks.setdefault(cid, {})[i] = part
            if len(chunks[cid]) == n:
                body = "".join(chunks[cid][k] for k in sorted(chunks[cid]))
            else:
                continue
        try:
            yield json.loads(body[body.index("{"):])
        except (ValueError, json.JSONDecodeError):
            pass


def af_threads(p: pathlib.Path):
    if not p.exists():
        return "-"
    out, cur = [], None
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"Output thread \S+, name (\S+), tid \d+, type \d+ \((\w+)\)", line)
        if m:
            cur = {"name": m.group(1), "type": m.group(2)}
            out.append(cur)
            continue
        if cur is None or line.startswith("-"):
            continue
        for key, rx in (("standby", r"\s+Standby: (\w+)"), ("fmt", r"\s+HAL format: \S+ \(AUDIO_FORMAT_(\w+)\)"),
                        ("ch", r"\s+Channel count: (\d+)"), ("dev", r"\s+Output devices: \S+ \(AUDIO_DEVICE_OUT_(\w+)\)")):
            mm = re.match(rx, line)
            if mm and key not in cur:
                cur[key] = mm.group(1)
    act = [t for t in out if t.get("standby") == "no" and t.get("dev")]
    return "; ".join(f"{t['type']} {t.get('fmt')} {t.get('ch')}ch {t.get('dev')}" for t in act) or "-"


for d in map(pathlib.Path, sys.argv[1:]):
    for log in sorted(d.glob("*.log")):
        ev = list(events(log))
        start = next((e for e in ev if e.get("ev") == "start"), {})
        sel = None
        for e in ev:
            if e.get("ev") == "tracks":
                s = [t for t in e["tracks"] if t.get("type") == 1 and t.get("selected")]
                if s:
                    sel = s[0]
        adec = [e.get("name") for e in ev if e.get("ev") == "audioDecoder"]
        atr = [e for e in ev if e.get("ev") == "audioTrack"]
        err = [e.get("code") for e in ev if e.get("ev") == "error"]
        last = atr[-1] if atr else {}
        print(f"{d.name:9} {log.stem:18} ff={start.get('ffmpeg')} track={sel.get('label') if sel else '-'} "
              f"[{sel.get('mime') if sel else ''} {sel.get('ch') if sel else ''}ch] dec={adec[-1] if adec else '-'} "
              f"out={last.get('encoding', '-')} {last.get('channels', '')}ch offload={last.get('offload', '')} "
              f"err={err[0] if err else '-'} | AF: {af_threads(log.with_suffix('.audioflinger.txt'))}")
