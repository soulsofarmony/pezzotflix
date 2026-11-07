# Evidenze di S5 (client TV)

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
