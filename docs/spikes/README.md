# Spike di evidenza

Esperimenti throwaway che producono **dati**, non codice da tenere. Il codice vive in `spikes/<id>-<nome>/`, il report qui come `<id>-<nome>.md`.

Ogni report contiene: domanda, setup (sample, versioni tool, browser/device), risultati misurati, conclusione/raccomandazione, ADR che alimenta.

| ID | Domanda | Stato |
|---|---|---|
| S1 | Cosa espongono davvero i remux (ffprobe) e cosa serve al modello dati? | ✅ [report](S1-media-probe.md) |
| S2 | Cosa riproduce il browser: MKV diretto, HEVC/HDR, fMP4/HLS remux, audio lossless, PGS? | ✅ [report](S2-browser-playback.md) (H1 ✅; H2 ✅/❌ (Chrome/Edge ✅; «Firefox no» smentito, a favore); H3 ✅ in fMP4, DV solo come `hvc1`; H6 ✅ FLAC 5.1 ovunque; H7 ✅ con `requestVideoFrameCallback`; nuova H11 ⚠️ aperta (DV P7 nel browser, manca un sample). P2: la condizione non scatta; P3 → render lato client; P5 (nuova): HDR10 su display SDR lasciato al browser, da riguardare dopo la verifica dei colori, che se fallisce riapre P2. In sospeso le verifiche del proprietario: colori su display SDR, ascolto 5.1, sample DV P7) |
| S3 | Latenza di avvio e seek del remux on-the-fly (video copy) | ✅ [report](S3-stream-latency.md) |
| S4 | Identificazione da filename + metadata provider in `it-IT` | ✅ [report](S4-identification.md) (parsing e matching ✅ in-sample; conflitto cache TMDB/§12 → deciso, D5; test live TMDB del 2026-11-05: TMDB ✅ primario per i metadata in italiano, con trame 94/94, poster italiani 78/94 e titoli degli episodi al 96%; ❌ non per l'identificazione (opzione B dell'ADR 0007): la condizione dell'ADR, "più preciso", non è soddisfatta con la regola v2. Precision 97,7% contro 98,9% di Wikidata, una sola query di differenza e non significativa; recall 88,5% contro 97,9%, un gap soprattutto del matcher dello spike (voti, titoli alternativi), non del recupero, che su TMDB è migliore. L'artwork scaricato è TMDB Content per il §1.A dei termini; `spikes/s4-identification/out/` va cancellata entro il 2027-05-05) |
