"""S5 (throwaway): copies the small text evidence the report relies on into docs/spikes/S5-tv-client/ (tracked),
scrubbed of serial numbers, MAC addresses, SSIDs/BSSIDs and session tokens.

Inputs are in out/results/ (gitignored): the probe's JSON, the TV dumps in out/results/device/ (pulled with
`adb shell dumpsys media.audio_policy`, `cat /vendor/etc/media_codecs*.xml`, `dumpsys hdmi_control`) and the
per-group summaries written by summarize.py. Usage: python -I evidence.py
"""
import json
import pathlib
import re
import shutil
import xml.etree.ElementTree as ET

HERE = pathlib.Path(__file__).resolve().parent
RES = HERE / "out" / "results"
DEV = RES / "device"
DST = HERE.parent.parent / "docs" / "spikes" / "S5-tv-client"

MAC = re.compile(r"\b([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b")
SECRET_KEYS = re.compile(r'"(ssid|bssid|serial|serialno|mac|macAddress|token|profileToken|sessionToken)"\s*:\s*"[^"]*"', re.I)
URL_TOKEN = re.compile(r"/s/[A-Za-z0-9_\-.~%]{12,}/")


def scrub(text: str) -> str:
    text = MAC.sub("<mac>", text)
    text = SECRET_KEYS.sub(lambda m: f'"{m.group(1)}": "<rimosso>"', text)
    text = URL_TOKEN.sub("/s/<token>/", text)
    text = re.sub(r"(Bearer\s+)\S+", r"\1<token>", text)
    for bad in ("ro.serialno", "ro.boot.serialno", "SSID:", "SSID\"", "SSID ="):
        assert bad not in text, f"unscrubbed field {bad}"
    return text


def put(name: str, text: str) -> None:
    p = DST / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(scrub(text), encoding="utf-8", newline="\n")
    print(f"{p.relative_to(DST.parent.parent.parent)}  {p.stat().st_size} B")


def read(p: pathlib.Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")


if DST.exists():
    shutil.rmtree(DST)
DST.mkdir(parents=True)

# 1. Probe output.
for f in ("raw-caps.json", "client-caps.json", "client-caps-noffmpeg.json"):
    put(f, read(RES / f))

# 2. Decoder table: vendor media_codecs.xml (+ c2) vs what apps see in MediaCodecList(ALL_CODECS).
raw = json.loads(read(RES / "raw-caps.json"))
listed = {(c["name"], c["type"]) for c in raw["codecs"]}
listed_names = {c["name"] for c in raw["codecs"]}
rows = []
for xf in ("media_codecs.xml", "media_codecs_c2.xml"):
    root = ET.fromstring(read(DEV / xf))
    for dec in root.iter("Decoders"):
        for mc in dec.findall("MediaCodec"):
            name = mc.get("name")
            if name.endswith(".secure"):
                continue
            types = [mc.get("type")] if mc.get("type") else [t.get("name") for t in mc.findall("Type")]
            lim = {}
            for el in mc.iter("Limit"):
                if el.get("name") in ("size", "channel-count", "bitrate") and el.get("name") not in lim:
                    lim[el.get("name")] = el.get("max") or el.get("range") or el.get("value")
            feats = [f.get("name") for f in mc.iter("Feature") if f.get("name") in ("tunneled-playback", "low-latency")]
            seen = [t for t in types if (name, t) in listed]
            rows.append((xf, name, types, lim, feats, name in listed_names, seen))
md = ["# Decoder della TV: `media_codecs.xml` del vendor e `MediaCodecList(ALL_CODECS)`", "",
      "Riassunto generato da `spikes/s5-tv-client/evidence.py` (non è il file del vendor). Fonti: `adb shell cat "
      "/vendor/etc/media_codecs.xml` e `media_codecs_c2.xml` (decoder dichiarati) e `MediaCodecList(ALL_CODECS)` letto "
      "dall'app sonda (`raw-caps.json`, decoder che un'app può usare). Varianti `.secure` omesse.", "",
      "| File | Componente | MIME dichiarati | Limiti | Funzioni | In `MediaCodecList(ALL_CODECS)` |", "|---|---|---|---|---|---|"]
for xf, name, types, lim, feats, present, seen in rows:
    vis = "**no**" if not present else ("sì: " + ", ".join(f"`{t}`" for t in seen) if seen else "sì (MIME diversi)")
    md.append(f"| {xf.replace('media_codecs', 'mc')} | `{name}` | {', '.join(f'`{t}`' for t in types)} | "
              f"{', '.join(f'{k} {v}' for k, v in lim.items()) or '-'} | {', '.join(feats) or '-'} | {vis} |")
md += ["", "I codec Google in `media_codecs_google_*.xml` (inclusi dal file del vendor) non sono elencati qui; quelli che "
       "l'app vede sono in `raw-caps.json` (`codecs`)."]
put("decoders.md", "\n".join(md) + "\n")

# 3. Audio policy excerpt: Speaker and HDMI ARC device profiles, compressed output mix ports.
ap = read(DEV / "audio_policy.txt").split("\n")
out = ["# Estratto di `adb shell dumpsys media.audio_policy` (Haier H65C95EUX, Android 11), 2026-11-07", ""]
out += [ln for ln in ap if "Config source" in ln]


def block(start_pred, stop_pred, lines, first=0):
    for i in range(first, len(lines)):
        if start_pred(lines[i]):
            j = i + 1
            while j < len(lines) and not stop_pred(lines[j]):
                j += 1
            return lines[i:j], j
    return [], len(lines)


b, _ = block(lambda s: s.startswith("- Available output devices:"), lambda s: s.startswith("- Available input devices:"), ap)
out += ["", "## Dispositivi d'uscita disponibili (in uso)"] + [ln for ln in b if "gain" not in ln.lower() and "_value" not in ln
                                                               and "ramp" not in ln and "mode: 0" not in ln
                                                               and "channel_mask: 0" not in ln]
decl = next(i for i, ln in enumerate(ap) if "Declared devices:" in ln)
for tag in ("HDMI Out", "HDMI ARC", "Spdif"):
    b, _ = block(lambda s, t=tag: s.strip() == f"- tag name: {t}", lambda s: re.match(r"\s+Device \d+:", s) is not None, ap, decl)
    out += ["", f"## Dispositivo dichiarato: {tag}"] + b
out += ["", "## Uscite (mix port) del modulo primary: formati e flag", ""]
mod = next(i for i, ln in enumerate(ap) if ln.startswith("- HW Module 1:"))
end = next(i for i, ln in enumerate(ap) if i > mod and "- inputs:" in ln)
for ln in ap[mod:end]:
    if re.match(r"\s+output \d+:", ln) or "- name:" in ln or "- format:" in ln or "- flags:" in ln:
        out.append(ln)
put("audio-policy.txt", "\n".join(out) + "\n")

# 4. HDMI ports and ARC state.
hd = [ln for ln in read(DEV / "hdmi_control.txt").split("\n")
      if re.search(r"port_id: \d, type|mArcEstablished|mArcFeatureEnabled|mSystemAudioActivated", ln)]
put("hdmi.txt", "# Estratto di `adb shell dumpsys hdmi_control`, 2026-11-07\n\n" + "\n".join(hd) + "\n")

# 5. Platform facts.
plat = [ln.split(":", 1)[1] if ln.startswith("Mem") else ln for ln in read(DEV / "platform.txt").strip().split("\n")]
labels = ["uname -m", "ro.product.cpu.abilist", "ro.product.cpu.abilist64", "ro.zygote", "MemTotal", "MemFree",
          "MemAvailable (durante le prove)", "ro.build.version.security_patch"]
put("platform.txt", "# Piattaforma (adb shell), 2026-11-07\n\n" + "\n".join(f"{k}: {v.strip()}" for k, v in zip(labels, plat))
    + "\n\nBuild (dall'app): " + json.dumps(raw["build"]) + "\nMemoria (ActivityManager): " + json.dumps(raw["memory"]) + "\n")

# 6. Measurement results.
for g in ("o2001", "video", "audio-off", "audio-on", "flac", "pair", "pgs", "mem", "hot", "hot-largeheap", "q7", "ds"):
    s = RES / g / "summary.json"
    if s.exists():
        put(f"results/runs-{g}.json", read(s))
for f in ("audio-matrix.txt", "q7-plans.json", "net-stats.jsonl", "flac-frames.jsonl"):
    if (RES / f).exists():
        put(f"results/{f}", read(RES / f))
for d in ("net", "net2"):
    for t in sorted((RES / d).glob("*.trace.json")) if (RES / d).exists() else []:
        put(f"results/net-trace-{d}-{t.name.split('.')[0]}.json", read(t))
for f in ("bitrate-2001.json", "bitrate-samples.json"):
    prof = json.loads(read(RES / f))
    for p in prof:
        p.pop("perSecMbps", None)
    put(f"results/{f.replace('.json', '-peaks.json')}", json.dumps(prof, indent=1, ensure_ascii=False))
for f in ("bitrate-2001-buffer-model.json", "bitrate-samples-buffer-model.json"):
    if (RES / f).exists():
        put(f"results/{f}", read(RES / f))

# 7. Index of the folder.
put("README.md", """# Evidenze di S5 (client TV)

Artefatti di testo su cui si basa il [report di S5](../S5-tv-client.md), copiati da `spikes/s5-tv-client/out/results/`
(non versionato) con `python -I spikes/s5-tv-client/evidence.py`. Seriali, MAC, SSID, BSSID e token di sessione sono tolti.
Dispositivo: Haier H65C95EUX, Android TV 11, misure del 2026-11-07.

| File | Cosa contiene | Da dove |
|---|---|---|
| `raw-caps.json` | build, Media3, estensione FFmpeg, `MediaCodecList(ALL_CODECS)` con profili e livelli, display, `AudioCapabilities` e uscite audio, memoria | `CapsActivity` dell'app sonda |
| `client-caps.json`, `client-caps-noffmpeg.json` | il `ClientCapabilities` che l'app dichiarerebbe, con e senza l'estensione FFmpeg | idem |
| `decoders.md` | decoder dichiarati nel `media_codecs.xml` del vendor confrontati con quelli visibili alle app (riassunto, non il file del vendor) | `adb shell cat /vendor/etc/media_codecs*.xml` + `raw-caps.json` |
| `audio-policy.txt` | profili delle uscite Speaker, HDMI e HDMI ARC; formati e flag delle uscite del modulo primary | `adb shell dumpsys media.audio_policy` |
| `hdmi.txt` | porte HDMI, ARC | `adb shell dumpsys hdmi_control` |
| `platform.txt` | architettura, ABI, memoria, patch | `adb shell` |
| `results/runs-*.json` | una riga per prova: decoder, HDR, avvio, seek, frame persi, rebuffer, uscita audio, PSS, buffer, errori | `summarize.py` sui log dell'app |
| `results/audio-matrix.txt` | percorso audio per traccia: decoder, `AudioTrack`, thread di AudioFlinger | `audio_matrix.py` |
| `results/flac-frames.jsonl` | dimensione dei frame FLAC per blocco da 4608 e 1152 campioni | ffprobe |
| `results/q7-plans.json` | piani del Decision Engine per ogni item con le capability della TV, e prove Range sui locator | `q7_api.py` |
| `results/net-stats.jsonl`, `results/net-trace-*.json` | throughput verso la TV, statistiche e tracce al secondo | `net_traces.py` sui log di `NetActivity` |
| `results/bitrate-*-peaks.json`, `results/bitrate-*-buffer-model.json` | picchi di bitrate su finestre mobili e buffer necessario per throughput | `bitrate.py`, `net_model.py` |
""")
