# Spike di evidenza

Esperimenti throwaway che producono **dati**, non codice da tenere. Il codice vive in `spikes/<id>-<nome>/`, il report qui come `<id>-<nome>.md`.

Ogni report contiene: domanda, setup (sample, versioni tool, browser/device), risultati misurati, conclusione/raccomandazione, ADR che alimenta.

| ID | Domanda | Stato |
|---|---|---|
| S1 | Cosa espongono davvero i remux (ffprobe) e cosa serve al modello dati? | ✅ [report](S1-media-probe.md) |
| S2 | Cosa riproduce il browser: MKV diretto, HEVC/HDR, fMP4/HLS remux, audio lossless, PGS? | — |
| S3 | Latenza di avvio e seek del remux on-the-fly (video copy) | ✅ [report](S3-stream-latency.md) |
| S4 | Identificazione da filename + metadata provider in `it-IT` | — |
