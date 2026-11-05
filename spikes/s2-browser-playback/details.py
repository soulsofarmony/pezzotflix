"""S2 (throwaway): evidence that summarize.py does not show, read from the same JSON files.

python -I spikes/s2-browser-playback/details.py [dir]   (dir defaults to results/auto/)

Sections:
  1. start/seek ranges per test family
  2. decoders, colour space and audio tracks from the Chromium media log (pass 1)
  3. hls.js errors per test (bufferFullError count, fatal errors)
  4. "orphan" players: MediaSource re-attached by hls.js after a fatal error and labelled
     with the next test by run.mjs (proof: a blob: URL on a progressive test)
  5. PGS: overlay size, per-cue lag, clear lag, dropped frames, render cost
  6. requestVideoFrameCallback rate vs decoded fps
"""
import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUTO = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "results" / "auto"
TAGS = ["msedge", "chrome", "firefox", "msedge-headless"]
DIRECT = {"d1", "d2", "d3", "d4", "d5", "d6", "p1", "c6"}  # progressive tests (no MSE)
FAMILIES = [
    ("MKV diretto (d1, d2, d3, d5, d6)", {"d1", "d2", "d3", "d5", "d6"}),
    ("MP4 progressivo (d4)", {"d4"}),
    ("HLS fMP4 1080p (h1, c1-c7)", {"h1", "c1", "c2", "c3", "c4", "c5", "c7"}),
    ("HLS fMP4 4K, sorgente HDR10 ~100 Mbps (h2-h5, v1)", {"h2", "h3", "h4", "h5", "v1"}),
    ("HLS fMP4 4K, DV P8.1 come hvc1 (h6)", {"h6"}),
    ("fMP4 progressivo 4K (p1)", {"p1"}),
    ("fMP4 progressivo 1080p (c6)", {"c6"}),
]


def load(tag):
    rp, pp = AUTO / f"{tag}-report.json", AUTO / f"{tag}-players.json"
    if not rp.exists():
        return None, {}
    rep = json.loads(rp.read_text(encoding="utf-8"))
    players = json.loads(pp.read_text(encoding="utf-8")) if pp.exists() else {}
    return rep, players


def rng(values):
    v = [x for x in values if x is not None]
    return f"{min(v)}–{max(v)}" if v else "-"


def tracks(raw):
    try:
        return json.loads(raw) if isinstance(raw, str) else (raw or [])
    except ValueError:
        return []


def load_url(player):
    for e in player.get("events", []):
        try:
            ev = json.loads(e) if isinstance(e, str) else e
        except ValueError:
            continue
        if isinstance(ev, dict) and ev.get("event") == "kLoad":
            return ev.get("url", "")
    return ""


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    data = {t: load(t) for t in TAGS}
    data = {t: d for t, d in data.items() if d[0]}

    print("## 1. Avvio e seek per famiglia (ms, min–max su test e passate non falliti)\n")
    print("| Famiglia | " + " | ".join(f"{t} avvio | {t} seek" for t in data) + " |")
    print("|---|" + "---|---|" * len(data))
    for name, ids in FAMILIES:
        cells = []
        for rep, _ in data.values():
            rs = [r for r in rep["auto"] if r["id"] in ids and r["outcome"] != "fail"]
            cells += [rng(r["startMs"] for r in rs), rng(r["seekMs"] for r in rs)]
        print(f"| {name} | " + " | ".join(cells) + " |")

    print("\n## 2. Decoder, colore e tracce audio (media log Chromium, passata 1)\n")
    for tag, (rep, players) in data.items():
        if not players:
            continue
        print(f"\n### {tag}\n")
        print("| Test | Decoder video (platform) | Colore (primaries/transfer/matrix) | hdr metadata | Decoder audio | Tracce audio create |")
        print("|---|---|---|---|---|---|")
        for p in players.values():
            if not p["test"].endswith("#1") or "kVideoDecoderName" not in p["props"]:
                continue
            pr = p["props"]
            vt = tracks(pr.get("kVideoTracks"))
            at = tracks(pr.get("kAudioTracks"))
            cs = vt[0].get("color space", {}) if vt else {}
            col = "/".join(str(cs.get(k)) for k in ("primaries", "transfer", "matrix")) if cs else "-"
            hdr = json.dumps(vt[0].get("hdr metadata")) if vt else "-"
            vd = f'{pr.get("kVideoDecoderName")} ({pr.get("kIsPlatformVideoDecoder")})'
            ad = f'{pr.get("kAudioDecoderName", "-")} ({pr.get("kIsPlatformAudioDecoder", "-")})'
            au = "; ".join(f'{t.get("codec")} {t.get("channels")}ch {t.get("channel layout")}' for t in at) or "nessuna"
            print(f'| {p["test"]} | {vd} | {col} | {hdr} | {ad} | {au} |')

    print("\n## 3. Errori hls.js per test (somma delle 2 passate)\n")
    print("| Browser | Test | bufferFullError | Altri errori (unici) |")
    print("|---|---|---|---|")
    for tag, (rep, _) in data.items():
        by = {}
        for r in rep["auto"]:
            by.setdefault(r["id"], []).extend(r.get("errors") or [])
        for tid, errs in by.items():
            full = sum("bufferFullError" in e for e in errs)
            other = sorted({e[:150] for e in errs if "bufferFullError" not in e})
            if full or other:
                print(f"| {tag} | {tid} | {full} | {' / '.join(other).replace('|', '/')} |")

    print("\n## 4. Player con errori nel media log: URL caricato e decoder\n")
    print("Un test progressivo (d*, p1, c6) non usa MSE: un player `blob:` con quell'etichetta è la MediaSource")
    print("ricreata da hls.js per il test precedente (MEDIA_SOURCE_REQUIRES_RESET), etichettata in ritardo.\n")
    print("| Browser | Etichetta | Test progressivo? | URL caricato | Decoder video | Primo messaggio di errore |")
    print("|---|---|---|---|---|---|")
    for tag, (_, players) in data.items():
        for p in players.values():
            if not p.get("errors"):
                continue
            url = load_url(p)
            msg = next((m for m in p.get("messages", []) if m.startswith("error")), "")
            tid = p["test"].split("#")[0]
            print(f'| {tag} | {p["test"]} | {"sì" if tid in DIRECT else "no"} | {url.split(":")[0]}:… | '
                  f'{p["props"].get("kVideoDecoderName", "-")} | {msg[:140]} |')

    print("\n## 5. PGS (libpgs): overlay, lag per cue, costo\n")
    print("| Browser | Test#pass | Driver | Overlay (OffscreenCanvas) | Lag per cue (ms) | Clear finale (ms) | Persi senza/con | Render ms mediana/max | Richieste di render |")
    print("|---|---|---|---|---|---|---|---|---|")
    for tag, (rep, _) in data.items():
        for p in rep.get("pgs", []):
            dr = p.get("draws") or []
            ms = [x["probeMs"] for x in dr if x.get("probeMs") is not None]
            canv = ",".join(sorted({x["canvas"] for x in dr}))
            lags = ", ".join(str(s["lagMs"]) for s in p.get("sync") or [])
            s = p.get("summary") or {}
            cost = f"{statistics.median(ms):.1f}/{max(ms):.1f}" if ms else "-"
            drv = "rVFC" if "requestVideoFrameCallback" in str(p.get("driver")) else "timeupdate"
            print(f'| {tag} | {p["id"]}#{p["pass"]} | {drv} | {canv} | {lags} | {(p.get("lastClear") or {}).get("lagMs")} | '
                  f'{s.get("droppedBaseline")}/{s.get("droppedWithPgs")} | {cost} | {len(p.get("renderRequests") or [])} |')

    print("\n### 5b. Lag dei cue PGS aggregato (2 passate; s1+s2 = timeupdate, s3 = rVFC)\n")
    print("| Browser | Driver | Cue disegnati | Lag min / medio / max (ms) | Clear finale min–max (ms) | Frame persi con PGS (max per finestra da 10,6 s) |")
    print("|---|---|---|---|---|---|")
    for tag, (rep, _) in data.items():
        for drv, ids in (("timeupdate", {"s1", "s2"}), ("rVFC", {"s3"})):
            ps = [p for p in rep.get("pgs", []) if p["id"] in ids]
            lags = [s["lagMs"] for p in ps for s in (p.get("sync") or []) if s["lagMs"] is not None]
            total = sum(len(p.get("sync") or []) for p in ps)
            clears = [(p.get("lastClear") or {}).get("lagMs") for p in ps]
            dropped = [(p.get("summary") or {}).get("droppedWithPgs") for p in ps]
            print(f"| {tag} | {drv} | {len(lags)}/{total} | {min(lags)} / {round(statistics.mean(lags))} / {max(lags)} | "
                  f"{rng(clears)} | {max(d for d in dropped if d is not None)} |")

    print("\n## 6. requestVideoFrameCallback: callback al secondo vs frame decodificati al secondo (finestre da 3 s)\n")
    print("| Browser | fps decodificati (mediana) | callback rVFC/s (mediana) | min–max callback/s |")
    print("|---|---|---|---|")
    for tag, (rep, _) in data.items():
        w = [r["window"] for r in rep["auto"] if r.get("window")]
        dec = statistics.median(x["decodedFps"] for x in w)
        pres = [x["presentedFps"] for x in w]
        print(f"| {tag} | {dec} | {statistics.median(pres)} | {min(pres)}–{max(pres)} |")


if __name__ == "__main__":
    main()
