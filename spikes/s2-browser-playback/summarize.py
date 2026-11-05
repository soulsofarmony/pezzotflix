"""S2 (throwaway): print markdown tables from out/auto/*-report.json and *-players.json.

python -I spikes/s2-browser-playback/summarize.py > spikes/s2-browser-playback/out/auto/summary.md
"""
import json
from pathlib import Path

AUTO = Path(__file__).resolve().parent / "out" / "auto"
TAGS = ["msedge", "chrome", "firefox", "msedge-headless", "chrome-headless"]


def load(tag):
    rp, pp = AUTO / f"{tag}-report.json", AUTO / f"{tag}-players.json"
    if not rp.exists():
        return None, {}
    rep = json.loads(rp.read_text(encoding="utf-8"))
    players = json.loads(pp.read_text(encoding="utf-8")) if pp.exists() else {}
    by_test = {}
    for p in players.values():
        by_test.setdefault(p["test"], []).append(p)
    return rep, by_test


def decoders(plist):
    v, a, err = set(), set(), []
    for p in plist or []:
        pr = p["props"]
        if "kVideoDecoderName" in pr:
            v.add(f'{pr["kVideoDecoderName"]}{" (platform)" if pr.get("kIsPlatformVideoDecoder") in (True, "true") else ""}')
        if "kAudioDecoderName" in pr:
            a.add(f'{pr["kAudioDecoderName"]}{" (platform)" if pr.get("kIsPlatformAudioDecoder") in (True, "true") else ""}')
        err += [e[:160] for e in p.get("errors", [])]
        err += [m[:160] for m in p.get("messages", []) if m.startswith("error")]
    return ", ".join(sorted(v)) or "-", ", ".join(sorted(a)) or "-", err


def fmt2(a, b):
    return f"{a}/{b}" if a != b else f"{a}"


def main():
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    for tag in TAGS:
        rep, players = load(tag)
        if not rep:
            continue
        print(f"\n## {tag}: {rep['browser']}\n")
        print(f"UA: `{rep['ua']}`\n")
        rows = {}
        for r in rep["auto"]:
            rows.setdefault(r["id"], []).append(r)
        print("| ID | Esito p1/p2 | Avvio ms | Seek ms | Ris. | fps dec. / persi (3 s) | Audio (canali vivi) | Decoder video | Decoder audio | Errori/note |")
        print("|---|---|---|---|---|---|---|---|---|---|")
        for tid, rs in rows.items():
            r1, r2 = rs[0], rs[-1]
            w = r1.get("window") or {}
            w2 = r2.get("window") or {}
            au = r1.get("audio") or {}
            aud = f'{au.get("liveChannels", "-")} ch' + (f' · {au["channelMap"]}' if au.get("channelMap") else "") if au else "-"
            vd, ad, err = decoders(players.get(f"{tid}#1"))
            notes = "; ".join(sorted(set((r1.get("errors") or []) + (r2.get("errors") or []))))[:200]
            notes = (notes + " " + (r1.get("note") or "")).strip()
            if err and not notes:
                notes = err[0]
            print(f'| {tid} | {fmt2(r1["outcome"], r2["outcome"])} | {fmt2(r1["startMs"], r2["startMs"])} | {fmt2(r1["seekMs"], r2["seekMs"])} | {r1["res"]} | '
                  f'{w.get("decodedFps", "-")}/{w.get("droppedInWindow", "-")} · {w2.get("decodedFps", "-")}/{w2.get("droppedInWindow", "-")} | {aud} | {vd} | {ad} | {notes.replace("|", "/")} |')
        if rep.get("pgs"):
            print("\n| PGS | pass | Esito | driver | cue disegnati | lag ms min/medio/max | clear finale ms | px max | persi senza/con PGS | fps senza/con |")
            print("|---|---|---|---|---|---|---|---|---|---|")
            for p in rep["pgs"]:
                s = p.get("summary") or {}
                print(f'| {p["id"]} | {p["pass"]} | {p["outcome"]} | {p.get("driver", "-")} | {s.get("cuesDrawn", "-")} | {s.get("lagMsMin", "-")}/{s.get("lagMsMean", "-")}/{s.get("lagMsMax", "-")} | '
                      f'{(p.get("lastClear") or {}).get("lagMs", "-")} | {s.get("maxCanvasPixels", "-")} | {s.get("droppedBaseline", "-")}/{s.get("droppedWithPgs", "-")} | {s.get("fpsBaseline", "-")}/{s.get("fpsWithPgs", "-")} | {p.get("note", "")} |')
        if rep.get("vtt"):
            print("\nVTT cuechange:", json.dumps(rep["vtt"]))
    # capability matrix
    reps = {t: load(t)[0] for t in TAGS}
    reps = {t: r for t, r in reps.items() if r}
    for section in ["isTypeSupported", "canPlayType", "decodingInfo", "matchMedia", "screen", "audioOut", "webglRenderer"]:
        print(f"\n### {section}\n")
        print("| Chiave | " + " | ".join(reps) + " |")
        print("|---|" + "---|" * len(reps))
        vals = {t: r["caps"].get(section) for t, r in reps.items()}
        if not isinstance(next(iter(vals.values())), dict):
            print("| - | " + " | ".join(str(v) for v in vals.values()) + " |")
            continue
        keys = []
        for v in vals.values():
            for k in (v or {}):
                if k not in keys:
                    keys.append(k)
        for k in keys:
            cells = []
            for t in reps:
                x = (vals[t] or {}).get(k)
                if isinstance(x, dict) and "supported" in x:
                    x = ("✅" if x["supported"] else "❌") + (" smooth" if x.get("smooth") else "") + (" pE" if x.get("powerEfficient") else "")
                elif x is True:
                    x = "✅"
                elif x is False:
                    x = "❌"
                elif x == "":
                    x = '""'
                cells.append(str(x))
            print(f"| {k} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
