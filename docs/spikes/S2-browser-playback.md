# S2 — Cosa riproduce il browser

- **Stato:** Completato. Le misure nei browser sono del 2026-11-05, sul PC originale, e il report è scritto dai risultati salvati, senza rieseguire i test. I box fMP4, l'AAC 5.1 e l'Opus 5.1 sono stati verificati dopo, sul portatile, con ffmpeg 8.1.2 e jellyfin-ffmpeg 8.1.3, senza browser. Restano le verifiche del proprietario: colori su display SDR (decidono P5), ascolto su un impianto 5.1 e un sample DV profilo 7 (vedi Conclusioni, punto 11).
- **Domanda:** cosa riproducono davvero Chrome, Edge e Firefox su Windows di un remux Blu-ray/UHD? Si guardano MKV diretto, HEVC Main10/HDR10, Dolby Vision, remux in fMP4/HLS, audio multicanale e PGS.
- **Alimenta:** doc 04 H1, H2, H3 (parte fMP4), H6, H7, nuova ipotesi H11 (DV P7 nel browser), decisioni P2/P3 e nuova decisione P5 (doc 04 §11); doc 03 §4.1 (ClientCapabilities), I5 e I6; doc 02 §3.11; ADR 0003 (protocollo di streaming) e ADR 0005 (web client)
- **Codice:** `spikes/s2-browser-playback/`, throwaway. I risultati grezzi sono committati in `spikes/s2-browser-playback/results/`.
  - Preparazione: `prepare.sh`, `prepare_extra.sh`.
  - Esecuzione: `server.py`, `auto.html`, `run.mjs`, `ff_support.mjs`, `pgsprobe.worker.js`, `sup_cues.py`.
  - Tabelle: `summarize.py` dà una tabella per browser; `details.py` raccoglie le prove che il riepilogo non mostra.
  - `index.html` serve per le prove a vista e d'ascolto (sezione 2, con i c1–c7).
  - Verifica dei file, senza browser:
    - `boxes.sh` rigenera h2, h6, h7, h8, p1 e le prove AAC con una build di ffmpeg;
    - `mp4boxes.py` legge box, unità NAL e AudioSpecificConfig;
    - `chanmap.py` misura in quale canale decodificato finisce ogni tono.

## Setup

- **PC:** quello originale, lo stesso di S3.
  - Windows 11 (NT 10.0.26200.9711), NVIDIA RTX 3060 Ti con driver 32.0.15.9649 (= 596.49).
  - Due monitor 2560×1440 **SDR**.
  - Tutte le uscite audio sono **stereo**: `AudioContext.destination.maxChannelCount` vale 2, e in Firefox ogni dispositivo WASAPI ha 2 canali.
- **Browser:** Edge 156.0.4314.58 (Chromium 156.0.8078.80), Chrome 156.0.8078.80, Firefox 159.0.1. In `chrome://gpu` "Video Decode" risulta "Hardware accelerated", con il profilo "hevc main 10" fino a 8192×8192.
- **Automazione:**
  - Edge e Chrome girano con Playwright (`playwright-core` sui browser installati). Il media log di Chromium, cioè gli stessi dati di `chrome://media-internals`, è raccolto via CDP: nomi dei decoder, flag "platform", spazio colore, tracce create ed errori.
  - Firefox parte da riga di comando con un profilo pulito. Senza CDP non ci sono nomi di decoder. `about:support` è esportato con `ff_support.mjs`.
  - Le opzioni predefinite di Playwright includono `--force-color-profile=srgb` (riga di comando in `results/auto/*-gpu.txt`).
- **Server:** `server.py` serve file statici con richieste a intervalli su `localhost:8765`. HLS e fMP4 sono **pre-generati** sul PC originale: niente rete e niente remux al volo. Il costo del remux è misurato in S3.
  - La versione di ffmpeg dei file provati nei browser **non è registrata**. Nessuno script la salva, e in `results/` non compaiono né `ffmpeg version` né le stringhe `Lavf`/`Lavc`.
  - Sullo stesso PC S3 usava ffmpeg 7.0 (build gyan.dev): è quasi certamente quella.
- **Player:** sono strumenti di misura, non scelte. Protocollo e librerie si decidono negli ADR.
  - `<video>` nativo per MKV, MP4 e fMP4 progressivo;
  - hls.js 1.7.3 per l'HLS, via MSE con un solo SourceBuffer audio+video;
  - libpgs 0.9.0 (MIT) per i PGS.
- **Varianti:** tutte dalle fixture di S1, con il **video sempre copiato**.
  - L'HLS ha segmenti fMP4 da 4 s (`-hls_segment_type fmp4 -hls_flags independent_segments`).
  - Le clip durano 30 s; i c*, d5 e d6 durano 10 s.

| ID | Contenuto | Per |
|---|---|---|
| d1, d2, d3 | MKV originali:<br>- d1: AVC + AAC;<br>- d2: AVC + DTS 5.1 eng di default, + AC-3 5.1 ita;<br>- d3: HEVC 4K HDR10 + TrueHD 5.1 ita di default, + E-AC-3 5.1 eng e AC-3 2.0 | H1, H2 |
| d5, d6 | MKV con **una sola** traccia audio: TrueHD (4K) / DTS (1080p) | H1 |
| d4 | MP4 progressivo AVC + AAC (riferimento) | — |
| h1 | HLS AVC + AAC (riferimento) | — |
| h2–h5 | HLS HEVC 4K HDR10, circa 100 Mbps a 60 fps, tag `hvc1`. Audio: AAC 2.0 / FLAC 5.1 / E-AC-3 640k / AC-3 640k | H2, H3, H6 |
| h6 | HLS DV P8.1 con tag `hvc1` + AAC | H3 |
| h7, h8 | HLS DV P8.1 / DV P5 con tag `dvh1` + AAC. `-strict unofficial` fa scrivere il box DV | H3 |
| p1 | fMP4 progressivo (senza MSE) HEVC 4K HDR10 + FLAC 5.1 | H6 |
| c1–c7 | 1080p AVC + 5.1 sintetico con **un tono per canale**:<br>- FLAC: c1 in HLS, c6 progressivo;<br>- E-AC-3 (c2) e AC-3 (c3) da layout 5.1(side);<br>- Opus (c4) da layout 5.1, perché il libopus di ffmpeg upstream rifiuta 5.1(side) (vedi H6);<br>- AAC da layout 5.1(side) (c5) e da layout 5.1 (c7) | H6 |
| v1 | h2 + WebVTT con `<track>` | — |
| s1, s2, s3 | PGS con libpgs su 1080p AVC (s1) e su 4K HEVC HDR10 (s2, s3). In s3 il render è pilotato da `requestVideoFrameCallback` | H7 |

- **Misure:** 2 passate per test.
  - **Avvio:** da `src`/`loadSource` al primo frame dopo `playing`.
  - **Seek:** a 20 s (5 s per c*, d5, d6), dall'assegnazione di `currentTime` al primo frame dopo `seeked`.
  - **Finestra di 3 s:** fps decodificati e frame persi da `getVideoPlaybackQuality`, più le callback di `requestVideoFrameCallback` (rVFC).
  - **Audio:** analisi Web Audio dopo la decodifica (`createMediaElementSource` → splitter a 8 canali → analizzatori, uscita a volume zero), con livello e frequenza dominante per canale.
  - **Video senza audio:** il video avanza ma nessun canale supera −60 dB.
- **Audio di prova:**
  - Le tracce 5.1 delle fixture di S1 hanno segnale **solo su FL/FR** (330/550 Hz). Su d*, h* e p1 i "2 canali vivi" sono quindi una proprietà del sample, non un downmix.
  - L'ordine dei canali si verifica sui c*, con un tono per canale e tolleranza ±12 Hz: FL 300, FR 500, FC 700, LFE 60, SL/BL 900, SR/BR 1100 Hz.
- **PGS:**
  - I `.sup` sono estratti dalle fixture: è lo stesso sample 1920×1080 di S1. Ha 5 apparizioni (0,005 / 2,029 / 4,029 / 6,029 / 8,029 s) e l'ultima cancellazione a 10,005 s, secondo `sup_cues.py`.
  - Il worker di libpgs, non modificato, è avvolto da `pgsprobe.worker.js`, che registra ogni render e rilegge il canvas.
  - **Ritardo:** posizione nel media (`mediaTime`) del primo frame a schermo con il render completo, meno il PTS del cue. La risoluzione è un frame: 16,7 ms in Chromium, circa 40 ms in Firefox (vedi rVFC sotto).
- **Esecuzioni finali** (UTC, 2026-11-05):

| Corsa | Orario | Test | Mancano |
|---|---|---|---|
| Edge | 00:09–00:14 | 20 | d5, d6, c7 (aggiunti dopo) |
| Chrome | 00:14–00:21 | 21 | d5, d6 |
| Firefox | 00:21–00:28 | 23 | — |
| Edge headless | 00:29–00:35 | 23 | — |

- **Note sulle corse:**
  - **Edge headless dà gli stessi esiti** di Edge con finestra su tutti i 20 test in comune: esito, canali vivi e mappa dei canali. Copre quindi d5, d6 e c7 per Edge.
  - Di Chrome headless esiste solo l'export di `chrome://gpu`, nessun report.
  - I file `results/*.json` coincidono con `results/auto/*-report.json`, a parte il campo `saved`.
  - Le 6 corse di sviluppo di Edge (00:02–00:08, parziali) non entrano nelle tabelle (vedi Limiti).
- **Verifica dei file** (portatile, 2026-11-05, senza browser):
  - **Build:** ffmpeg/ffprobe **8.1.2** (build gyan.dev full, sull'host) e **jellyfin-ffmpeg 8.1.3** dell'immagine `pezzotflix/video:dev`, in container usa e getta. Le fixture di S1 sono ricostruite con la 8.1.2.
  - **Cosa rigenera:** `boxes.sh` rifà h2, h6, h7, h8 e p1 con gli stessi argomenti di `prepare.sh` (video copiato), più le prove AAC 5.1.
  - **Le due build danno gli stessi risultati:** stessi box, stesse unità NAL, stesso AudioSpecificConfig. Cambia solo la versione scritta nel commento del PCE (`Lavc62.28.102` / `Lavc62.28.103`).
  - **Confronto con i file provati nei browser:**
    - le quattro stringhe di codec che hls.js ha ricavato dai segmenti di init sul PC originale coincidono con hvcC, `dvvC` e `dvcC` della ricostruzione: `hvc1.2.4.L183.B0`, `hvc1.2.4.H153.B0`, `dvh1.08.09`, `dvh1.05.09`;
    - le regole con cui il muxer MP4 scrive `dvcC`/`dvvC` e `mdcv`/`clli` sono le stesse in ffmpeg 7.0 e 8.1.2 ([movenc.c a `n7.0`, righe 2515–2537](https://github.com/FFmpeg/FFmpeg/blob/n7.0/libavformat/movenc.c#L2515-L2537); per la 8.1.2 vedi H3), e così la tabella PCE dell'encoder AAC (vedi H6).
- **Ricostruzione:** `bash spikes/s1-media-probe/fetch.sh && bash spikes/s1-media-probe/build_fixtures.sh && bash spikes/s2-browser-playback/prepare.sh && bash spikes/s2-browser-playback/prepare_extra.sh && mkdir -p spikes/s2-browser-playback/out/node && npm i --prefix spikes/s2-browser-playback/out/node playwright-core puppeteer-core && node spikes/s2-browser-playback/run.mjs --headless=msedge && node spikes/s2-browser-playback/ff_support.mjs && python -I spikes/s2-browser-playback/summarize.py spikes/s2-browser-playback/out/auto > spikes/s2-browser-playback/out/summary.md && python -I spikes/s2-browser-playback/details.py spikes/s2-browser-playback/out/auto > spikes/s2-browser-playback/out/details.md`
  - Servono ffmpeg 7, Node, Python 3.12 e i tre browser installati.
  - La corsa occupa i browser per circa 26 minuti.
  - Le tabelle si rigenerano dai risultati salvati, senza browser: `python -I spikes/s2-browser-playback/summarize.py && python -I spikes/s2-browser-playback/details.py`.
  - **Verifica dei file**, senza browser:
    - comando, con ffmpeg 8.1.2 sul PATH: `export PATH="<cartella bin di ffmpeg 8.1.2>:$PATH" && bash spikes/s1-media-probe/fetch.sh && bash spikes/s1-media-probe/build_fixtures.sh && bash spikes/s2-browser-playback/boxes.sh host && bash spikes/s2-browser-playback/boxes.sh jellyfin && python -I spikes/s2-browser-playback/mp4boxes.py > spikes/s2-browser-playback/out/boxes/report.md && python -I spikes/s2-browser-playback/chanmap.py > spikes/s2-browser-playback/out/boxes/chanmap.md`;
    - serve l'immagine `pezzotflix/video:dev`: `docker compose -f deploy/compose.yaml build video`;
    - l'identità byte per byte delle prove AAC (H6) si controlla con `sha256sum spikes/s2-browser-playback/out/boxes/*/aac/*.mp4`;
    - richiede circa 15 s per l'host e 60 s per Jellyfin, e 1,3 GB per build.

## Risultati

### H1 — MKV diretto (`<video src="….mkv">`)

| Test | Edge | Chrome | Firefox |
|---|---|---|---|
| d1 AVC + AAC | ✅ | ✅ | ✅ |
| d2 AVC + DTS eng (+ AC-3 ita) | ⚠️ suona l'**AC-3 italiano** | ❌ video senza audio | ❌ video senza audio |
| d3 HEVC 4K + TrueHD ita (+ E-AC-3 eng, AC-3) | ⚠️ suona l'**E-AC-3 inglese** | ❌ video senza audio | ❌ video senza audio |
| d5 solo TrueHD / d6 solo DTS | ❌ video senza audio (headless) | non eseguiti | ❌ video senza audio |
| d4 MP4 (riferimento) | ✅ | ✅ | ✅ |

- **Il browser scarta in silenzio l'audio che non sa decodificare.**
  - Non arriva nessun evento `error`.
  - Il media log di Chromium registra solo `FFmpegDemuxer: skipping invalid or unsupported audio track`.
  - `webkitAudioDecodedByteCount` resta a 0 in Chrome, e `mozHasAudio` è `false` in Firefox.
- **Edge prende la prima traccia che sa decodificare.** AC-3/E-AC-3 li decodifica con `MediaFoundationAudioDecoder`, un decoder di piattaforma.
  - Nei due casi provati la traccia di default era quella non decodificabile (DTS, TrueHD).
  - Non è provato se Edge preferisca una traccia di default decodificabile a una che la precede.
- **`canPlayType` non aiuta.** In tutti i browser dà "maybe" per `video/x-matroska` e "probably" con i codec avc1+aac o hevc. Non è stato chiesto con i codec audio che spariscono (DTS, TrueHD). `MediaSource.isTypeSupported` per MKV è `false` ovunque.
- **La pagina non può scegliere la traccia audio.** `HTMLMediaElement.audioTracks` è dietro flag sia in Chrome/Edge (`#enable-experimental-web-platform-features`) sia in Firefox (`media.track.enabled`) ([MDN BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/HTMLMediaElement.json)). Il dato viene da MDN BCD e non è misurato nello spike.

### H2 — HEVC Main10 / HDR10 4K

| | Edge | Chrome | Firefox | Edge headless |
|---|---|---|---|---|
| Decoder video (HEVC) | `VDAVideoDecoder`, platform. Nel log: "Use MediaFoundationVideoDecoder for DXVA" | `D3D11VideoDecoder`, platform, uscita P010, bit depth 10 | Nome non esposto. In `about:support` la decodifica HEVC software è "Non supportata", quella hardware "Supportata" | come Edge |
| fps decodificati, finestre 4K da 3 s | 59,7–60,4 | 59,8–61,1 (67,8 nella prima finestra di d3) | 59,8–60,4 | 59,7–60,7 |
| Frame persi per finestra | 0 in 11 finestre su 16, max 3 | 0 in 8 su 12. Prima finestra di d3: 25; altrimenti ≤ 1 | 0 in 12 su 14. d3 (MKV): 14 e 11 | 0 in 15 su 18, max 3 |
| Frame persi in totale | 8 su circa 2 900 | 28 su circa 2 200 | 25 su circa 2 500 | 5 su circa 3 300 |

- Nei percorsi HLS e fMP4 i frame persi sono **0–3 per finestra in tutti i browser**. I picchi vengono dall'MKV diretto.
- Il sample è a **60 fps e circa 100 Mbps**, più pesante di un film a 24 fps.
- `mediaCapabilities.decodingInfo` (tipo `media-source`) e media query:

| Configurazione | Edge | Chrome | Firefox |
|---|---|---|---|
| HEVC 4K HDR10 (smpteSt2086, pq, rec2020) | ✅ smooth, powerEfficient | ✅ smooth, powerEfficient | ✅ smooth, powerEfficient |
| HEVC 4K HLG | ✅ | ✅ | ✅ |
| HEVC 4K HDR10+ | ❌ | ❌ | ✅ |
| DV P8 / P5 4K | ❌ | ❌ | ❌ |
| `matchMedia('(dynamic-range: high)')` (monitor SDR) | false | false | false |

- **Dipendenza da Windows:**
  - Secondo Microsoft, Edge decodifica HEVC con `MediaFoundationVideoDecoder`: serve un'estensione HEVC valida, mentre Chrome riproduce lo stesso contenuto con un altro decoder ([Microsoft Learn](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues)).
  - Firefox decodifica HEVC solo via Media Foundation ([Bugzilla 1942047](https://bugzilla.mozilla.org/show_bug.cgi?id=1942047)). La decodifica hardware è attiva dalla versione 134 ([Bugzilla 1928536](https://bugzilla.mozilla.org/show_bug.cgi?id=1928536)).
  - Sul PC originale Edge e Firefox riproducono HEVC, quindi l'estensione è installata (non verificata a parte).
- **`decodingInfo` dice se il browser decodifica, non come presenta.** Firefox risponde sì anche a HDR10+ e ad AV1 4K HDR10, che Chrome ed Edge negano: i parametri HDR non bastano a dire che la resa è corretta.

### H3 — fMP4/HLS: segnalazione HDR10 e Dolby Vision

| Test | Sorgente → tag | Codec annunciato a MSE | Edge | Chrome | Firefox |
|---|---|---|---|---|---|
| h2–h5, v1 | HDR10 → `hvc1` | `hvc1.2.4.L183.B0` | ✅ | ✅ (h4/h5 ❌ per l'audio, vedi H6) | ✅ (h4/h5 ❌ per l'audio) |
| p1 | HDR10 → `hvc1`, fMP4 progressivo | — | ✅ | ✅ | ✅ |
| h6 | DV P8.1 → `hvc1` | `hvc1.2.4.H153.B0` | ✅ | ✅ | ✅ |
| h7 | DV P8.1 → `dvh1` | `dvh1.08.09` | ❌ `addSourceBuffer`: tipo non supportato | ❌ all'append | ❌ "Can't play type" |
| h8 | DV P5 → `dvh1` | `dvh1.05.09` | ❌ come h7 | ❌ come h7 | ❌ come h7 |

- **Il colore resta nel remux fMP4.** Per h2–h6 e p1 il media log di Chromium riporta BT2020 / SMPTEST2084 (PQ) / BT2020_NCL, come per l'MKV sorgente d3. Edge lo legge dal decoder DXVA: "PQ (white:203 nits)", range limited.
- **Box dei segmenti di init**, misurati sulla ricostruzione (vedi Setup), identici con le due build:

| Variante | Brand compatibili | Sample entry, hvcC | `colr` nclx | `mdcv` / `clli` | Box DV |
|---|---|---|---|---|---|
| h2 e p1 (HDR10 → `hvc1`) | iso5 iso6 mp41 | `hvc1`, Main 10, tier Main, livello 6.1 (`L183`) | 9 / 16 / 9 (BT.2020 / PQ / BT.2020 NCL), range limitato | assenti | — |
| h6 (DV P8.1 → `hvc1`) | iso5 iso6 **dby1** mp41 | `hvc1`, Main 10, tier High, livello 5.1 (`H153`) | 9 / 16 / 9, range limitato | assenti | **nessuno** |
| h7 (DV P8.1 → `dvh1`) | iso5 iso6 dby1 mp41 | `dvh1`, come h6 | come h6 | assenti | `dvvC` 1.0: profilo 8, livello 9, RPU sì, EL no, BL sì, compatibilità BL 1 |
| h8 (DV P5 → `dvh1`) | iso5 iso6 dby1 mp41 | `dvh1`, come h6 | **assente**: per ffprobe colore non specificato e range pieno, come nella sorgente | assenti | `dvcC` 1.0: profilo 5, livello 9, RPU sì, EL no, BL sì, compatibilità BL 0 |

- **Il box DV dipende da `-strict unofficial`, non dal tag.**
  - Il muxer MP4 di ffmpeg scrive `dvcC`/`dvvC` per ogni traccia con record DV, ma solo con quell'opzione ([movenc.c, righe 2974–2983](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavformat/movenc.c#L2974-L2983)). h6 è stato generato senza, h7 e h8 con.
  - Il brand `dby1` compare invece per qualunque traccia con record DV, oltre che per l'audio AC-3, E-AC-3 e TrueHD ([movenc.c, righe 6083–6089 e 6142–6143](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavformat/movenc.c#L6083-L6089)). h6 lo porta e va in tutti e tre i browser, quindi il brand non disturba.
  - hls.js costruisce `dvh1.08.09` / `dvh1.05.09` leggendo `dvvC`/`dvcC` dal segmento di init. Da questi box ricava un codec DV "supplementare" anche quando la sample entry è `hvc1` ([mp4-tools.ts v1.7.3, righe 778–807 e 896–913](https://github.com/video-dev/hls.js/blob/v1.7.3/src/utils/mp4-tools.ts#L778-L807)).
  - Il caso `hvc1` con `-strict unofficial` non è provato.
- **Tier High riprodotto ma non sondato.** h6 (`hvc1.2.4.H153.B0`, tier High) va in tutti e tre i browser, ma la lista di `isTypeSupported` della pagina conteneva solo stringhe tier Main (`L153`, `L183`). Una lista di stringhe per il client deve comprendere anche `H153`.
- **Gli RPU restano nel bitstream.**
  - h6 e h7 hanno un'unità NAL RPU (tipo 62) in tutte le 1797 access unit, come l'MKV sorgente (1797 su 1797). Nel primo segmento di h6 sono 237 su 237.
  - Non ci sono NAL EL (tipo 63).
  - ffprobe trova `Dolby Vision RPU Data` e `Dolby Vision Metadata` negli 8 frame letti di h6, come nella sorgente.
  - h8 (P5) ha gli RPU in 1797 access unit su 1797.
  - Servire P8.1 come `hvc1` toglie quindi la segnalazione nel container, ma non i dati DV.
- **Metadata HDR statici: ci sono nel bitstream, non nel container.**
  - **Il sample HDR10** (h2–h5, p1, d3) non li ha affatto. Non ci sono SEI 137/144: c'è un solo SEI, di tipo 5. Non ci sono nemmeno metadata nel container. Lì il `{}` del media log è corretto (S1, scoperta 1).
  - **Il sample DV P8.1** (h6, h7) li ha nei SEI: 30 di tipo mastering display (137) e 30 di tipo content light level (144), uno per IRAP (29 CRA e 1 IDR).
    - Numero e valori sono quelli della sorgente.
    - Primari: R 0,680/0,320, G 0,265/0,690, B 0,150/0,060. Bianco: 0,3127/0,3290.
    - Luminanza 0,0001–1000 cd/m², MaxCLL 244, MaxFALL 145.
  - **Nessuna variante ha `mdcv`/`clli`.** Il muxer li scrive solo dai metadata a livello di stream ([movenc.c, righe 2629–2660](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavformat/movenc.c#L2629-L2660)). Gli MKV di prova non ne hanno: come side data di stream ffprobe vede solo il record DOVI.
  - **Edge li legge dal bitstream.**
    - Su h6 il media log lo riporta in tutte e quattro le esecuzioni: con finestra e headless, 2 passate ciascuna.
    - Il messaggio è `Extracted hdr metadata from DXVA decoder due to MF_E_TRANSFORM_STREAM_CHANGE`, con questi valori: maxLum 1000, minLum 0,0001, maxCLL 244, maxFALL 145.
    - Sul sample HDR10 lo stesso messaggio riporta `{}`.
  - **Il campo `hdr metadata` della traccia resta `{}`**, sia in Edge sia in Chrome.
    - Chromium 156 lo riempie con i SEI contenuti nell'hvcC oppure con i box `mdcv`/`clli` ([box_definitions.cc, righe 1317 e 1427–1442](https://github.com/chromium/chromium/blob/156.0.8078.80/media/formats/mp4/box_definitions.cc#L1427-L1442); [hevc.cc, righe 258–274](https://github.com/chromium/chromium/blob/156.0.8078.80/media/formats/mp4/hevc.cc#L258-L274)).
    - Qui l'hvcC contiene solo VPS, SPS e PPS.
    - Il log non dice se Chrome usi i SEI presenti nel flusso.
- **Nessun browser riproduce DV in MSE.**
  - `isTypeSupported`, `canPlayType` e `decodingInfo` lo negano ovunque, per `dvh1` e `dvhe`, P8 e P5.
  - Edge e Firefox rifiutano il SourceBuffer.
  - Chrome lo crea e poi fallisce all'append: `CHUNK_DEMUXER_ERROR_APPEND_FAILED: MSE playback of DolbyVision is only supported via platform decryptor, but the provided DV track is not encrypted`.
- **Conseguenza per DV:**
  - **P8.1** va servito ai browser come `hvc1`, cioè come HDR10 del base layer. h6 va ovunque: 59,8–60,4 fps, 0–2 frame persi.
  - **P5** non ha un base layer compatibile (S1), quindi nel browser servirebbe un Transcode. Con P2, per una sorgente 4K, la sessione fallisce con motivo chiaro.
  - Servire P5 come `hvc1` non è una scorciatoia: senza `colr` il browser lo tratterebbe come video a colore non specificato, con i colori sbagliati di S1 (scoperta 2). Il caso non è misurato.
  - **P7** (il DV tipico degli UHD Blu-ray, S1) non è misurato: manca un sample. Diventa l'ipotesi H11 di doc 04 (vedi Conclusioni).

### H6 — Audio multicanale in MSE e fMP4

Esito dei test con un tono per canale (c*) e dei test 4K (h3–h5, p1), su 2 passate:

| Codec 5.1 | Edge | Chrome | Firefox |
|---|---|---|---|
| **FLAC**, HLS (c1) e progressivo (c6) | ✅ 6 canali, ordine L R C LFE Ls Rs corretto | ✅ | ✅ |
| FLAC su 4K, HLS (h3) e progressivo (p1) | ✅ | ✅ | ✅ |
| **Opus**, mapping family 1, da layout 5.1 (c4) | ✅ | ✅ | ✅ |
| **AAC**, channelConfiguration 6 (c7) | ✅ (headless) | ✅ | ✅ |
| AAC con PCE (c5) | ❌ errore fatale | ❌ errore fatale | ❌ video senza audio |
| **E-AC-3** 640k (c2, h4) | ✅ | ❌ errore fatale, cade anche il video | ❌ errore fatale |
| **AC-3** 640k (c3, h5) | ✅ | ❌ come E-AC-3 | ❌ come E-AC-3 |
| TrueHD, DTS, DTS-HD MA, DTS:X (solo API) | ❌ | ❌ | ❌ |

- **Decoder audio** nel media log di Chromium:
  - FLAC → `SymphoniaAudioDecoder`;
  - Opus → `OpusAudioDecoder`;
  - AAC → `FFmpegAudioDecoder`;
  - AC-3/E-AC-3 → `MediaFoundationAudioDecoder`, decoder di piattaforma, solo Edge.

  Le tracce create sono "6ch 5.1" per FLAC, AC-3, E-AC-3 e Opus, "6ch 5.1_BACK" per l'AAC di c7.
- **Errori:**
  - Chrome rifiuta E-AC-3 e AC-3 già all'`addSourceBuffer`, con "The type provided ('video/mp4;codecs=ec-3,…') is unsupported".
  - Firefox risponde "Can't play type".
  - Con l'AAC PCE Chromium accetta il tipo e poi fallisce al parsing: `CHUNK_DEMUXER_ERROR_APPEND_FAILED: RunSegmentParserLoop: stream parsing failed`. Firefox riproduce il video in silenzio (`bufferSeekOverHole`, 0 canali vivi).
- **L'AAC 5.1 dipende dal layout d'ingresso.** c5 e c7 differiscono solo per quello: 5.1(side) contro 5.1.
  - Il codec annunciato è `mp4a.40.2` in entrambi i casi, quindi le API di capability non vedono la differenza.
  - Misura sul file, con l'encoder `aac` nativo a 384 kb/s. ffmpeg 8.1.2 e jellyfin-ffmpeg 8.1.3 danno gli stessi risultati:

| Ingresso all'encoder | channelConfiguration | PCE | Layout per ffprobe |
|---|---|---|---|
| Toni 5.1(side), come c5 | **0** | sì | nessuno (6 canali) |
| Toni 5.1, come c7 | 6 | no | 5.1 |
| TrueHD della fixture (Blade Runner), decodificato da ffmpeg | **0** | sì | nessuno (6 canali) |
| DTS core della fixture (Buono), decodificato da ffmpeg | **0** | sì | nessuno (6 canali) |
| Ognuno dei quattro + `aformat=channel_layouts=5.1` | 6 | no | 5.1 |
| Toni 5.1(side) o TrueHD + `-ac 6` | 6 | no | 5.1 |

- **Il PCE di ffmpeg 8.1 è malformato.**
  - Nei casi con PCE l'encoder lo scrive nel log: `Using a PCE to encode channel layout "5.1(side)"`.
  - Il PCE contiene un CPE e un SCE frontali, un SCE laterale e un CPE posteriore, ma nessun elemento LFE. L'LFE viaggia quindi in un SCE, come un canale normale dichiarato laterale, e i surround laterali sono dichiarati posteriori.
  - È la tabella di [aacenc.c, righe 179–186](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavcodec/aacenc.c#L179-L186), uguale al tag `n7.0` ([righe 178–185](https://github.com/FFmpeg/FFmpeg/blob/n7.0/libavcodec/aacenc.c#L178-L185)).
  - Lo stesso ffmpeg decodifica il file in 6 canali con layout `unknown`.
  - Su master la tabella è stata corretta, dopo la separazione del ramo 8.1:
    - [c92c6cbf](https://github.com/FFmpeg/FFmpeg/commit/c92c6cbf19f23e9569a67fba64f61923073512cc), del 2026-05-19: "mistagging LFE elements as SCE … results in unparseable streams";
    - [bca473e1](https://github.com/FFmpeg/FFmpeg/commit/bca473e155ba7eeaa13acb7104ac4b26f40428ba), del 2026-06-02: "Most parsers outright dislike anything being signaled as SIDE".
  - Le due correzioni non sono nel tag `n8.1.2`. Dalla misura, mancano anche in jellyfin-ffmpeg 8.1.3.
- **Chromium rifiuterebbe anche un PCE corretto.**
  - Per l'AAC-LC il parser MP4 di Chromium 156 fallisce con channelConfiguration 0: `RCHECK(channel_config_ != 0)` ([aac.cc, riga 269](https://github.com/chromium/chromium/blob/156.0.8078.80/media/formats/mp4/aac.cc#L269)). È coerente con l'errore misurato su c5, `stream parsing failed`.
  - Il valore 6 diventa `CHANNEL_LAYOUT_5_1_BACK` ([adts_constants.h, righe 27–31](https://github.com/chromium/chromium/blob/156.0.8078.80/media/formats/mpeg/adts_constants.h#L27-L31)): è la traccia "6ch 5.1_BACK" vista su c7.
  - Anche la versione corretta di ffmpeg (master al 2026-11-05) usa un PCE per il 5.1(side). Quel layout infatti non è fra quelli che hanno un channelConfiguration standard, né in 8.1.2 né su master ([aacenctab.h a `n8.1.2`](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavcodec/aacenctab.h#L47-L55), [su master](https://github.com/FFmpeg/FFmpeg/blob/0893feba652894f836cb76617936da52570d20a5/libavcodec/aacenctab.h#L47-L63)).
- **I decoder di ffmpeg danno 5.1(side) per tutti i codec dei Blu-ray.**
  - Nelle fixture tutte le tracce 5.1 (TrueHD, DTS, E-AC-3, AC-3) risultano 5.1(side), anche se sono state codificate da un ingresso 5.1.
  - Il motivo è nei decoder:
    - TrueHD mappa la coppia "LRs" sui canali laterali ([mlp_parse.h, righe 71–85](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavcodec/mlp_parse.h#L71-L85));
    - il DTS fa lo stesso con Ls/Rs, salvo i layout 7.x "wide" ([dcadec.c, righe 35–66](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavcodec/dcadec.c#L35-L66)).
  - Su file reali i log di Jellyfin mostrano `Audio: truehd, 48000 Hz, 5.1(side), s32 (24 bit)` ([#10007](https://github.com/jellyfin/jellyfin/issues/10007), [#13430](https://github.com/jellyfin/jellyfin/issues/13430)).
  - **Senza accorgimenti, quindi, ogni 5.1 da Blu-ray convertito in AAC 5.1 esce con il PCE**, e in Chromium fa cadere la riproduzione.
- **Il rimedio cambia solo l'etichetta dei canali, non il mix.**
  - `aformat=channel_layouts=5.1` porta SL/SR su BL/BR con guadagno 1 ([rematrix.c, righe 236–246](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libswresample/rematrix.c#L236-L246)). `-ac 6`, che compare nel comando di Jellyfin in #10007, ha lo stesso effetto.
  - Con entrambe le build, il file prodotto da 5.1(side) + `aformat` o da 5.1(side) + `-ac 6` è identico byte per byte a quello prodotto da un ingresso 5.1. SHA-256 (primi 8 caratteri): ffmpeg 8.1.2 `a25cc8e7` per i toni, `d142c6e5` per il TrueHD; jellyfin-ffmpeg 8.1.3 `4709c5df` e `116f49e5`. Il file da 5.1(side) senza rimedio è diverso (`faccdad8` / `a025e260`).
  - Alla decodifica ogni tono resta nel suo canale: −18,0…−18,5 dBFS, con il secondo tono più forte a −97,4 dBFS o meno (`chanmap.py`).
- **Anche l'Opus 5.1 vuole il layout 5.1, ma dipende dalla build.** Misura sul portatile, 1 s di toni 5.1(side) dati a `libopus`:
  - ffmpeg 8.1.2 upstream rifiuta l'ingresso all'apertura dell'encoder, con `-mapping_family 1` e senza: "Invalid channel layout 5.1(side) for specified mapping family 1". Non scrive nulla;
  - con `aformat=channel_layouts=5.1` prima dell'encoder la codifica riesce;
  - jellyfin-ffmpeg 8.1.3 (ADR 0006) accetta il 5.1(side) e lo rimappa da sé ("side channels will be mapped to back channels"): esce un Opus 6 canali con layout 5.1.
  - Per questo c4 è stato generato da toni 5.1 (`prepare_extra.sh`). Su questo punto le due build non si comportano allo stesso modo.
- **API:** `isTypeSupported` e `decodingInfo` danno:
  - AAC, FLAC (anche a 8 canali) e Opus ovunque;
  - AC-3/E-AC-3 solo in Edge;
  - TrueHD e DTS in nessun browser.

  Gli esiti misurati coincidono, salvo l'AAC PCE.
- I canali sono misurati **dopo la decodifica, prima dell'uscita**. L'uscita del PC è stereo: cosa arriva a un impianto 5.1 non è misurato (vedi Limiti).

### H7 — PGS lato client con libpgs

| Browser | Pilotaggio | Cue disegnati | Ritardo min / medio / max (ms) | Cancellazione finale (ms) | Frame persi con PGS, max per finestra da 10,6 s |
|---|---|---|---|---|---|
| Edge | `timeupdate` | 20/20 | 38 / 133 / 245 | 45 | 1 |
| Edge | rVFC | 10/10 | 4 / 9 / 28 | 12–28 | 1 |
| Chrome | `timeupdate` | 20/20 | 38 / 136 / 254 | 28–278 | 16 in una finestra di s2 (4K; 3 nella stessa finestra senza PGS), altrimenti ≤ 2 |
| Chrome | rVFC | 10/10 | 4 / 19 / 28 | 28 | 0 |
| Firefox | `timeupdate` | 20/20 | 142 / 203 / 283 | 99–149 | 0 |
| Firefox | rVFC | 10/10 | 9 / 28 / 42 | da −17 a 33 | 0 |
| Edge headless | `timeupdate` | 20/20 | 21 / 131 / 245 | 28–62 | 1 |
| Edge headless | rVFC | 10/10 | 4 / 7 / 21 | 12 | 0 |

Le righe `timeupdate` sommano s1 (1080p) e s2 (4K HDR10); le righe rVFC sono s3 (4K HDR10). Tutte su 2 passate. Un valore negativo vuol dire che la cancellazione è a schermo prima del suo PTS.

- **Funziona ovunque.**
  - 5 cue su 5 in tutte le 24 esecuzioni.
  - libpgs disegna in un Worker su un OffscreenCanvas 1920×1080 ed è pronta in 25–86 ms.
  - Con i sottotitoli il video va a 59,5–59,8 fps, contro 57,4–59,8 senza.
- **Il sync dipende da chi pilota il render.**
  - Lasciata a sé, libpgs aggiorna il canvas sugli eventi `timeupdate` del `<video>`. La specifica HTML ammette fino a 250 ms fra due `timeupdate` ([HTML, "time marches on"](https://html.spec.whatwg.org/multipage/media.html#time-marches-on)), e i massimi misurati, 245–283 ms, sono quel limite più il render e un frame (in Firefox circa 40 ms).
  - In Chromium quel ritardo dipende da dove cade il cue (21–254 ms); in Firefox è sempre tra 142 e 283 ms.
  - Con `requestVideoFrameCallback` + `renderAtTimestamp(mediaTime)` il cue compare entro 1–2 frame in Chromium (4–28 ms). In Firefox compare entro circa una callback (9–42 ms).
  - Nello spike playlist e `.sup` partono entrambi da 0, senza seek con riavvio: `mediaTime` coincide con la timeline originale. Con uno stream ripartito a un offset non è misurato.
- **Costo:**
  - Il render gira nel Worker: mediana 5,0–22,2 ms per aggiornamento, massimo 58,7 ms. Il dato comprende la rilettura del canvas fatta dalla sonda, quindi è un limite superiore.
  - Le richieste di render sono 6–7 per finestra con `timeupdate` e 10 con rVFC (8–9 in Firefox). Con `timeupdate` le cancellazioni che cadono 24 ms prima del cue successivo vengono saltate.
- **4K:** s2 e s3 sovrappongono i PGS a un video **4K HEVC HDR10 a 60 fps**, con ritardi simili al 1080p.
  - I frame persi sono 0–1, salvo una passata di Chrome su s2: 16 in 10,6 s (3 senza PGS nella stessa passata), con la cancellazione finale a 278 ms. Sul 1080p (s1) sono al massimo 2, con cancellazioni a 28–45 ms.
  - Un PGS con composizione 3840×2160 **non è stato misurato**.
  - Secondo fonti di forum i PGS degli UHD Blu-ray sono 1920×1080 ([doom9](https://forum.doom9.org/archive/index.php/t-175129.html), [VLC #26710](https://code.videolan.org/videolan/vlc/-/issues/26710), [Emby](https://emby.media/community/topic/128836-pgs-subtitles-scaled-incorrectly-on-4k-video)). La specifica BD non è stata verificata.

### Altre misure

**Avvio e seek** in ms, nella forma "avvio / seek", min–max su test e passate con esito ok, esclusi i "video senza audio" (localhost, file in cache). `details.py` §1 include anche quelli; questi valori sono ricalcolati dagli stessi `results/auto/*-report.json`:

| Famiglia | Edge | Chrome | Firefox | Edge headless |
|---|---|---|---|---|
| MKV diretto (d*) | 59–496 / 20–71 (d1–d3) | 85–513 / 27–40 (solo d1) | 92–129 / 50–51 (solo d1) | 75–558 / 31–80 (d1–d3) |
| MP4 progressivo (d4) | 72 / 23–36 | 58–68 / 18–23 | 72–81 / 55–56 | 62–67 / 18–24 |
| HLS 1080p (h1, c*) | 129–272 / 4–26 | 215–282 / 5–22 | 190–220 / 53–57 | 141–434 / 3–30 |
| HLS 4K HDR10 ~100 Mbps (h2–h5, v1) | 166–311 / 95–214 | 287–378 / 105–163 | 256–410 / 155–259 | 168–400 / 137–194 |
| HLS 4K DV P8.1 come `hvc1` (h6) | 170–209 / 5–6 | 151–247 / 58–63 | 281–287 / 95 | 229–262 / 6 |
| fMP4 progressivo 4K (p1) | 800–1321 / 31–35 | 913–958 / 21–22 | 114–180 / 45–48 | 1308–1465 / 31–53 |
| fMP4 progressivo 1080p (c6) | 157–176 / 11–21 | 170–173 / 7–16 | 75–79 / 57–61 | 224–229 / 11–16 |

- Sono **limiti inferiori**. Al tempo reale si aggiungono:
  - il remux del server: in S3, 0,16–0,25 s per il primo segmento;
  - il trasferimento: un segmento da 4 s a 100 Mbps pesa circa 50 MB, cioè circa 0,4 s su gigabit (stima, non misurata).
- In Chromium l'fMP4 progressivo 4K parte in 0,8–1,5 s, contro 0,15–0,40 s dell'HLS 4K; in Firefox parte in 0,11–0,18 s.
  - Causa probabile, non misurata: su un fMP4 frammentato senza `sidx` il demuxer MP4 di FFmpeg usato da Chromium legge tutti i `moof` fino alla fine del file. Il `mfra` che ffmpeg scrive in coda è ignorato con l'opzione predefinita (`use_mfra_for` = auto; [mov.c a `n8.1.2`, righe 1853 e 9751–9757](https://github.com/FFmpeg/FFmpeg/blob/n8.1.2/libavformat/mov.c#L9751-L9757)).
  - p1 ha 150 frammenti (150 IDR in 30 s); un film intero ne avrebbe migliaia, quindi l'avvio crescerebbe con la durata (stima).
  - c6, più piccolo, parte in 0,16–0,23 s.
- **WebVTT (v1):** il `<track>` sopra l'HLS 4K funziona in tutti i browser. `cuechange` arriva a 2,006–2,016 s per un cue che inizia a 2,005 s.

**`bufferFullError` di hls.js sul 4K:**
- Compare in ogni test HLS 4K riuscito della sorgente a ~100 Mbps (h2–h5, v1): 7 volte per passata in Chromium, 6 in Firefox. Non compare su h6 né sul 1080p.
- hls.js lo recupera da solo riducendo il buffer massimo ([API.md](https://raw.githubusercontent.com/video-dev/hls.js/master/docs/API.md)). Tutti quei test finiscono ✅, con 0–3 frame persi.
- **Causa: il buffer in avanti di hls.js, non la dimensione del segmento.** Un append da circa 50 MB sta sotto il limite; è la somma dei segmenti chiesti in anticipo che lo supera.
  - hls.js punta a `min(max(8·maxBufferSize/bitrate, maxBufferLength), maxMaxBufferLength)` secondi di buffer ([base-stream-controller.ts v1.7.3](https://github.com/video-dev/hls.js/blob/v1.7.3/src/controller/base-stream-controller.ts)). Con i default (`maxBufferLength` 30 s, `maxBufferSize` 60 MB) sono 30 s: `maxBufferLength` è garantito "regardless of maxBufferSize" ([API.md](https://github.com/video-dev/hls.js/blob/v1.7.3/docs/API.md)).
  - h2 pesa 369 274 564 byte in 30 s, circa 98,5 Mbps: 30 s di buffer sono circa 352 MiB, 2,3 volte i 150 MiB che Chromium tiene per lo stream video ([demuxer_memory_limit.h, righe 48–53](https://github.com/chromium/chromium/blob/156.0.8078.80/media/base/demuxer_memory_limit.h#L48-L53); [demuxer_memory_limit_default.cc](https://github.com/chromium/chromium/blob/156.0.8078.80/media/base/demuxer_memory_limit_default.cc)). A questo bitrate 150 MiB valgono circa 12–13 s.
  - h6 pesa 125 878 145 byte in 30 s (circa 34 Mbps, 120 MiB in tutto): sta intero sotto il limite, e infatti non dà l'errore.
  - Le 6–7 occorrenze per passata corrispondono ai dimezzamenti di `maxMaxBufferLength` da 600 s finché il buffer ci sta (600 → 300 → … → circa 9 s). A ogni errore hls.js riscarica il frammento.
  - Anche Firefox ha un limite proprio ("MediaSource buffer not sufficient", 6 volte per passata), non verificato nel sorgente.
- **Altri limiti di Chromium:** per l'audio 12 MiB per stream. L'header definisce anche varianti da 80 e 30 MiB per il video, per i dispositivi con poca memoria: 30 MiB sono circa 2,5 s a 100 Mbps.
- **Il limite audio non è stato esercitato.** La FLAC di prova ha segnale su 2 canali soli e pesa circa 0,2 Mbps. Una FLAC 5.1/7.1 reale a 4–6 Mbps riempirebbe 12 MiB in circa 20 s, sotto i 30 s di hls.js: il `bufferFullError` è atteso anche sul 1080p.
- Il comportamento su un film intero non è misurato.

**`requestVideoFrameCallback`:**
- Firefox chiama rVFC **24,6 volte al secondo** (mediana; da 22,6 a 24,9) mentre decodifica 60 fps senza frame persi. Chromium lo chiama 59,1–59,6 volte al secondo.
- In Firefox, quindi, la logica legata ai frame ha una risoluzione di circa 40 ms.

**HLS nativo:** `canPlayType('application/vnd.apple.mpegurl')` dà "maybe" in Edge e Chrome 156 e una stringa vuota in Firefox. Non è stato provato: dove c'è MSE la pagina usa sempre hls.js.

## Scoperte

1. **In MSE un codec non supportato fa cadere tutta la riproduzione.**
   - Nell'MKV diretto l'audio non supportato sparisce in silenzio.
   - Con segmenti che portano audio e video insieme, come nello spike, hls.js usa un solo SourceBuffer `audiovideo`. In Chrome l'E-AC-3 dà `bufferAddCodecError` fatale e non parte nemmeno il video.
   - Con rendition audio separate (`EXT-X-MEDIA`, un SourceBuffer audio a parte) l'esito non è misurato: hls.js rende l'errore fatale quando non ha alternative.
   - Il piano deve quindi contenere solo codec che il client ha dichiarato supportati.
2. **Sulle stringhe di codec `isTypeSupported` e `decodingInfo` sono affidabili, con un'eccezione.** Hanno previsto l'esito misurato per HEVC, DV, AC-3/E-AC-3, FLAC, Opus, TrueHD e DTS.
   - L'eccezione è l'AAC con PCE: `mp4a.40.2` risulta supportato e lo stream fallisce.
   - Ingannano invece altre due API:
     - in Chrome `addSourceBuffer` accetta `dvh1`, che `isTypeSupported` rifiuta, e poi l'append fallisce;
     - `canPlayType` per MKV è stato chiesto solo con avc1+aac e hvc1, non con i codec audio che spariscono (DTS, TrueHD): non serve a decidere il Direct Play.
   - Conta `isTypeSupported` sulla stringa esatta, non il successo di `addSourceBuffer`.
3. **Su Windows Edge è il browser più capace per l'audio.** AC-3 ed E-AC-3 passano da Media Foundation. Chrome e Firefox vogliono FLAC, AAC o Opus.
   - In fMP4 sono misurati solo E-AC-3/AC-3 5.1 a 640 kb/s codificati da ffmpeg (h4, h5, c2, c3). La copia di una traccia E-AC-3/AC-3 della sorgente è dedotta, non misurata; in particolare l'E-AC-3 7.1 con substream dipendente.
   - Il decoder AC-3 dipende dall'installazione di Windows: secondo la stampa tecnica, le installazioni pulite di Windows 11 24H2 non hanno più il codec Dolby Digital, che i produttori possono preinstallare ([gHacks](https://www.ghacks.net/2024/05/29/microsoft-drops-ac-3-dolby-digital-codec-support-in-windows-11-version-24h2/), [PCWorld](https://www.pcworld.com/article/2349721/dolby-digital-support-disappears-in-windows-11.html)). Sul PC originale c'è; altrove va rilevato.
4. **Dopo un errore fatale hls.js ricrea la MediaSource e ritenta lo stesso stream.**
   - Per questo `summarize.py` mostra `CHUNK_DEMUXER_ERROR_APPEND_FAILED` su p1 (Chrome), c6 (Edge) e c7 (Chrome, Edge headless): sono errori attribuiti al test sbagliato.
     - In realtà sono player `blob:` di MSE. Su un test progressivo come p1 o c6 non possono essere del test stesso.
     - Si tratta della MediaSource che hls.js ricrea dopo l'errore fatale del test precedente (`MEDIA_SOURCE_REQUIRES_RESET`). Il messaggio infatti è quello di h8 (DV) o di c5 (PCE), e `run.mjs` la etichetta in ritardo (`details.py` §4).
     - p1, c6 e c7 hanno riprodotto correttamente.
   - **Per il prodotto:** dopo un errore fatale il client deve fermare hls.js e chiedere una nuova decisione (doc 04 §8). Lasciato a sé, il recupero automatico ritenta lo stesso stream.
5. **Con un monitor SDR i tre browser riproducono l'HDR10 e lo mostrano in SDR per conto loro. Come lo convertano non è misurato.**
   - Tutti i test 4K HDR10 sono andati su uscite SDR: monitor SDR o headless, `dynamic-range: high` false, profilo sRGB forzato in Chromium.
   - Ogni browser ha decodificato e presentato l'HDR10 senza errori. Cosa abbia fatto ai colori (tone-mapping o conversione ingenua) non è osservato: nessun frame è stato catturato.
   - In Firefox su Windows la resa BT.2020/PQ su SDR è un difetto aperto ([Bugzilla 1948087](https://bugzilla.mozilla.org/show_bug.cgi?id=1948087), "Inaccurate tone mapping from BT.2020 to SDR").
   - Il punto conta per doc 04 §4.2, che chiedeva «HDR10 su display SDR → Transcode con tone-mapping», e per P2: ne nasce la decisione P5, che resta da riguardare dopo la verifica del proprietario.
6. **DV P5 nel browser non ha strada senza Transcode.** Chrome accetta DV in MSE solo se cifrato; Edge e Firefox rifiutano il tipo.
7. **Ogni 5.1 da Blu-ray va rietichettato prima dell'AAC, e prima dell'Opus con ffmpeg upstream.**
   - I decoder di ffmpeg danno 5.1(side) per TrueHD, DTS, E-AC-3 e AC-3.
   - Da quel layout l'encoder AAC di ffmpeg 8.1 scrive un PCE, per di più malformato, e Chromium rifiuta qualunque PCE.
   - Il `libopus` di ffmpeg 8.1.2 rifiuta del tutto il 5.1(side); jellyfin-ffmpeg 8.1.3 lo rimappa da sé.
   - `aformat=channel_layouts=5.1` o `-ac 6` lo evitano senza toccare il mix: il file AAC è identico a quello prodotto da un ingresso 5.1.
   - Le API di capability non vedono la differenza, perché il codec è `mp4a.40.2` in entrambi i casi. Serve quindi un controllo lato server: channelConfiguration diverso da 0 nell'`esds` dopo l'encoder.
8. **Nel sample DV P8.1 i metadata HDR statici viaggiano solo nei SEI.**
   - Il remux con video copiato conserva SEI e RPU.
   - Non scrive `mdcv`/`clli`, perché l'MKV non ha i metadata nel container.
   - Edge li ricava dal decoder DXVA; nel media log di Chrome ed Edge, però, la traccia non dichiara metadata statici (`hdr metadata` = `{}`).

## Limiti

- **Un solo PC e una sola data:**
  - la configurazione è RTX 3060 Ti, Windows 11 con estensione HEVC, monitor SDR, uscite stereo, browser al 2026-11-05;
  - non sono misurati altre GPU (Intel, AMD), Linux, macOS e Safari;
  - non è misurato Windows senza estensione HEVC. Un thread Mozilla segnala Firefox senza HEVC su Windows 11 26200 anche con l'estensione installata ([SUMO 1588979](https://support.mozilla.org/vi/questions/1588979)): "Firefox sì" vale macchina per macchina;
  - il portatile su cui è stato scritto il report (iGPU Intel + RTX 1000 Ada) non è stato usato per le misure nei browser, perché i numeri non sarebbero confrontabili; è servito solo per la verifica dei file (Setup);
  - il decoder AC-3/E-AC-3 di Edge dipende dall'installazione di Windows (scoperta 3): non è misurato un Windows senza codec Dolby.
- **Clip brevi (10–30 s), HLS statico su localhost, file in cache.** Non sono misurati la rete, il remux al volo e la memoria su un film intero, compreso il `bufferFullError` nel tempo. Il limite audio di Chromium (12 MiB) non è stato esercitato: va misurato con una traccia FLAC multicanale reale su un film intero.
- **Audio sintetico.**
  - Su d*, h* e p1 c'è segnale solo su FL/FR, e l'ordine dei canali è verificato solo sui c*.
  - Il layout 5.1(side) delle tracce reali non è misurato su un disco. È dedotto dai sorgenti dei decoder di ffmpeg e, per il TrueHD, da due log di Jellyfin.
  - Per il DTS-HD MA non è stato trovato un log reale, e nelle fixture non c'è DTS-HD, perché ffmpeg non lo codifica (S1).
  - I layout 6.1 e 7.1 non sono provati: la FLAC a 8 canali è vista solo dalle API.
  - La copia in fMP4 di una traccia E-AC-3/AC-3 della sorgente non è provata: tutte le varianti E-AC-3/AC-3 in MSE sono codificate da ffmpeg. Va provata su un remux reale, anche con E-AC-3 7.1 a substream dipendente.
- **MKV diretto (`<video src>`):** sono misurati solo AAC (d1), AC-3/E-AC-3 in Edge (d2, d3) e il rifiuto di TrueHD/DTS (d5, d6). FLAC, Opus e PCM in MKV no, mentre le capability audio vengono da sonde MSE in fMP4. Non c'è nessun MKV con Dolby Vision.
- **Dolby Vision profilo 7:** non c'è un sample (S1). Non sono misurati né la copia così com'è (con le NAL EL) né la rimozione di RPU ed EL (ipotesi H11). Il sample P7 resta un'azione del proprietario.
- **Sottotitoli estratti in anticipo.** I `.sup` e il WebVTT sono estratti prima, da clip di 30 s (`prepare.sh`). Non sono misurati:
  - il tempo di estrazione da un remux intero. Estrarre una traccia legge tutto il file: per 50–80 GB dal bind mount NTFS (circa 500 Mbps, S3) sono circa 13–21 minuti (stima);
  - il consumo da parte di libpgs di un `.sup` ancora in scrittura.
- **Verifiche del proprietario, in sospeso.** I verdetti non vanno oltre la decodifica, il numero e l'ordine dei canali. Cosa fare è al punto 11 delle Conclusioni.
  - **Colori su display SDR: decidono P5.** La domanda è se la conversione è accettabile (alte luci, neri, tinte), non se i colori sembrano HDR. Va fatta in Chrome, Edge e Firefox, in una finestra normale: le corse automatiche usavano `--force-color-profile=srgb`. Va fatta anche su un remux UHD reale con metadata statici nel container (per esempio un MKV con MasteringMetadata impostato con mkvmerge): h2 non ne ha, e in h6 stanno solo nei SEI. Se c'è un display HDR, anche con l'HDR di Windows attivo.
  - **Ascolto dell'audio convertito** (FLAC, AAC, Opus, E-AC-3) su un'uscita 5.1 verso l'AVR: posizione dei canali e assenza di artefatti. Conferma anche H6 dopo la rotazione L/R/C vista in una corsa di sviluppo.
  - **Un sample DV profilo 7** (FEL o MEL), per misurare H11.
- **Cosa non copre la verifica dei file:**
  - **File ricostruiti.** I box sono misurati su file rifatti con ffmpeg 8.1.2 e 8.1.3, non su quelli provati nei browser, che vengono probabilmente dalla 7.0 (vedi Setup). Coincidono le stringhe di codec e le regole del muxer nei sorgenti, non i byte.
  - **Metadata HDR nel container.** Le fixture non li hanno. Non è misurato se gli MKV reali li portino nel container, né di conseguenza se in quel caso il muxer scriva davvero `mdcv`/`clli`: lo si deduce dal sorgente.
  - **SEI in Chrome.** Non è visibile se Chrome usi i SEI di mastering presenti nel flusso.
  - **`hvc1` con `-strict unofficial`.** Questo caso (`hvc1` con `dvvC`) non è provato, e nemmeno l'effetto del codec supplementare di hls.js.
  - **Altri encoder.** L'AAC è misurato solo con l'encoder nativo di ffmpeg. libfdk_aac e gli encoder di piattaforma non sono provati.
- **PGS:**
  - c'è un solo sample semplice, con 10 display set e al massimo circa 48 000 pixel;
  - non sono provati animazioni, cropping, più finestre e un film intero;
  - il ritardo è misurato a render completo, e la composizione a schermo può aggiungere un frame;
  - in Firefox la risoluzione è di circa 40 ms;
  - il costo comprende la rilettura del canvas.
- **Firefox:** nessun nome di decoder, perché manca il media log via CDP e `mozRequestDebugInfo` non è disponibile.
- **Corse incomplete:** Edge con finestra non ha d5, d6 e c7; Chrome non ha d5 e d6; Chrome headless non c'è.
- **Corse di sviluppo** (Edge, 00:02–00:08, fuori dalle tabelle):
  - nella prima c1 risultava con L/R/C ruotati: 498/697/299 Hz invece di 300/500/700. Non si è ripetuto nelle 9 esecuzioni successive di c1, e la causa non è isolata;
  - una partenza a freddo di h2 ha richiesto 1701 ms, con 31 frame persi.
- **Non valutati:** l'HLS nativo di Chromium, le alternative a hls.js e a libpgs, i sottotitoli ASS.

## Conclusioni e raccomandazioni

1. ✅ **H1 confermata.**
   - Nessun browser fa un Direct Play affidabile di un remux MKV: TrueHD e DTS spariscono in silenzio e la traccia non si sceglie.
   - Anche in Edge il Direct Play di d3 violerebbe P1, perché suona l'E-AC-3 inglese al posto del TrueHD italiano.
   - MSE non accetta MKV.
   - Il Direct Play di MKV nel browser va ammesso solo se il file ha una sola traccia audio e il browser la decodifica (come d1). Altrimenti si passa al Direct Stream in fMP4.
2. ✅/❌ **H2.**
   - ✅ Chrome ed Edge decodificano HEVC Main10 HDR10 4K in hardware (`D3D11VideoDecoder` / `VDAVideoDecoder`, platform), a circa 60 fps con 0–3 frame persi per finestra in HLS/fMP4.
   - ❌ **"Firefox no" è smentito:** Firefox 159 riproduce gli stessi file, solo in hardware.
   - Il risultato vale per il PC originale. Edge e Firefox dipendono dall'estensione HEVC di Windows.
3. ✅ **H3 confermata anche in fMP4.**
   - BT.2020/PQ arrivano al decoder, con `colr` nclx 9/16/9 nei segmenti di init.
   - La segnalazione DV invece non arriva: nessun browser accetta `dvh1`. DV P8.1 va servito come `hvc1` (HDR10), mentre DV P5 nel browser richiede un Transcode.
   - Servito come `hvc1`, il P8.1 conserva RPU e SEI di mastering, come la sorgente: 1797 su 1797 e 30 su 30. Perde solo il box DV.
   - I metadata statici arrivano nel bitstream, non nel container. Edge li ricava dal decoder; nella traccia, sia in Chrome sia in Edge, non risultano, e nessuna variante ha `mdcv`/`clli`.
4. ✅ **H6 confermata.**
   - FLAC 5.1 in fMP4, sia in HLS sia progressivo, va in tutti e tre i browser con l'ordine dei canali corretto. Una corsa di sviluppo di Edge, la prima a freddo, ha dato L/R/C ruotati: 1 caso su 10 esecuzioni di c1, causa non isolata, da ripetere nella prova d'ascolto.
   - Opus 5.1 (da layout 5.1) e AAC 5.1 con channelConfiguration 6 vanno ovunque.
   - AC-3/E-AC-3 vanno solo in Edge.
   - L'AAC con PCE non va. ffmpeg 8.1 lo produce da ogni ingresso 5.1(side), cioè da ogni traccia 5.1 Blu-ray decodificata, se prima dell'encoder il layout non viene portato a 5.1.
   - Solo 5.1: 6.1 e 7.1 non sono provati, la FLAC a 8 canali è vista solo dalle API. L'ascolto su un impianto 5.1 è in sospeso.
5. ✅ **H7 confermata, a patto di pilotare il render.** libpgs rende tutti i cue su 1080p e su 4K HDR10, con una sola finestra fuori norma (Chrome, s2, 16 frame persi).
   - ✅ Con `requestVideoFrameCallback` il ritardo è di 4–42 ms.
   - ⚠️ Con il `timeupdate` predefinito il ritardo arriva a 283 ms: non va usato.
   - I PGS a composizione 4K non sono misurati.
6. ⚠️ **H11 (nuova): DV profilo 7 nel browser.** Non misurata: manca un sample P7 (S1).
   - P7 è il DV tipico degli UHD Blu-ray, quindi la regola copre buona parte del DV della collezione.
   - Regola provvisoria, finché non si misura: si segue l'approccio di Jellyfin per i client solo HDR10. Si tolgono i layer DV (RPU ed EL) con un filtro di bitstream, senza ricodificare il video: `hevc_metadata=remove_dovi=1` di jellyfin-ffmpeg.
     - Nell'immagine `pezzotflix/video:dev` l'opzione esiste ("Remove Dolby Vision EL and RPU", `ffmpeg -h bsf=hevc_metadata`); il suo effetto su un P7 non è misurato.
     - `dovi_rpu=strip=1` di FFmpeg non basta: toglie solo l'ultima unità NAL di ogni access unit e lascia l'EL.
   - P8.1 resta come misurato: `hvc1`, video copiato, RPU nel flusso.
   - Verso il browser mai `-strict unofficial` né un box DV.
   - Niente Direct Play di un MKV con DV nel browser, finché non è misurato.
7. **P3: l'esito è "render lato client".** H7 è confermata, quindi il web client rende i PGS.
   - Il server li serve come `.sup` a parte, con delivery `client_render` (doc 03 §4.3), e il render è pilotato da rVFC.
   - Il tempo passato al renderer deve stare sulla timeline originale: `mediaTime` se playlist e frammenti sono nella timeline originale (`-copyts`, S3), altrimenti `mediaTime` più l'offset dello stream. Da verificare dopo un seek con riavvio della pipeline.
   - Il burn-in resta un fallback per i client senza renderer. Con P2 vale solo per sorgenti fino a 1080p.
8. **P2: la condizione non scatta.**
   - La parte di H2 da cui P2 dipende è confermata (Chrome ed Edge decodificano HEVC Main10 4K in hardware), e la parte smentita («Firefox no») è a favore; H7 è confermata. La condizione «Se S2 smentisce H2 o H7» quindi non scatta e non serve una decisione del proprietario.
   - Restano senza strada nel web client, come P2 già accetta, questi casi 4K:
     - **DV P5**, che senza Transcode non ha strada;
     - **browser senza HEVC**, cioè Edge o Firefox su Windows senza estensione HEVC, oppure altri sistemi;
     - **HDR10 su display SDR, se P5 viene ritirata per un browser.** La versione originale del §4.2 chiedeva un Transcode con tone-mapping, che P2 esclude per il 4K; ora vale P5;
     - **DV P7, se H11 fallisce** anche con la rimozione dei layer DV.
9. **P5 regge, con una premessa più debole.**
   - S2 ha misurato la riproduzione dell'HDR10 su display SDR, non la qualità della conversione. In Firefox su Windows la resa su SDR è un difetto aperto (Bugzilla 1948087).
   - Il motivo nella sessione diventa "HDR10 su display SDR: conversione lasciata al browser".
   - Il web client mette browser, versione e sistema nel modello del dispositivo, così un override (I2) può colpire un browser.
   - Se l'override toglie HDR10 a un browser, il 4K HDR10 su display SDR fallisce con `NO_COMPATIBLE_PLAN` (P2), e fino a 1080p si passa al Transcode con tone-mapping. Sul PC del proprietario, con due monitor SDR, è tutta la libreria 4K HDR10 in quel browser: in quel caso si riapre P2 (tone-mapping su GPU, H10 ✅ per `tonemap_cuda`), con una decisione del proprietario.
10. **Estrazione dei sottotitoli embedded: punto aperto per l'ADR 0003.** Non si decide qui.
    - Costo: estrarre una traccia legge tutto il file, cioè minuti dal bind mount (circa 13–21 per 50–80 GB, stima).
    - Il risultato va nel volume di cache persistente, non nello scratch, perché il media è in sola lettura.
    - Opzioni da misurare:
      - un'uscita in più dello stesso processo di remux, dalla posizione di partenza (nessuna lettura in più; `.sup` che cresce o a segmenti, da verificare con libpgs);
      - estrazione in background nella cache, all'ingest o al primo playback (file completo; una lettura intera per file).
    - `switchWithoutRestart` e la disponibilità della traccia devono riflettere un'estrazione in corso.
11. 📥 **Azione per il proprietario.** I verdetti sopra si fermano alla decodifica e all'ordine dei canali misurato dal software.
    - **Colori:** h2 (HDR10) e h6 (DV P8.1 come `hvc1`) in una finestra normale su un display **SDR**, in Chrome, Edge e Firefox. Questo caso decide se P5 resta per quel browser; se no, override I2 (punto 9). La domanda è se la conversione è accettabile (alte luci, neri, tinte). Serve anche un remux UHD reale con metadata statici nel container. Se c'è un display HDR, anche con l'HDR di Windows attivo.
    - **Ascolto:** c1–c7 (un tono per canale) su un'uscita 5.1 verso l'AVR. Ogni tono deve uscire dal diffusore giusto: FL 300, FR 500, FC 700, LFE 60, Ls 900, Rs 1100 Hz. Conferma H6, anche per la rotazione L/R/C vista in una corsa di sviluppo. h3/h4 non bastano: hanno segnale solo su FL/FR. Il PC originale ha solo uscite stereo: serve un collegamento HDMI verso l'AVR.
    - **Sample DV profilo 7** (FEL o MEL), per misurare H11.
    - **Come:** dopo le fixture di S1, `bash spikes/s2-browser-playback/prepare.sh && bash spikes/s2-browser-playback/prepare_extra.sh` (generano `out/media` e scaricano in `out/vendor` hls.js e libpgs), poi `python -I spikes/s2-browser-playback/server.py` e `http://localhost:8765/index.html`, sezione 2. Sul portatile `out/` oggi non ha né media né `out/vendor`.

**Impatto sui documenti** (riportato in doc 02, 03 e 04 e nel contratto):
- **Doc 04:**
  - **§4.1:** nel browser niente Direct Play di MKV, salvo i file con una sola traccia audio che il browser decodifica; il default è il Direct Stream in fMP4. Il DV in MKV non va in Direct Play.
  - **§4.2:**
    - la riga "HEVC Main10 nel browser" vale anche per Firefox, se c'è il decoder;
    - riga DV per il browser: mai DV; P8.1 come HDR10 con `hvc1` e senza box DV (misurato); P7 provvisorio con rimozione di RPU ed EL (H11); P5 → Transcode;
    - i metadata HDR statici, se ci sono, restano nei SEI del video copiato;
    - per "HDR10 su display SDR" vale P5: la conversione è lasciata al client.
  - **§4.3:**
    - il gradino 3 è FLAC per tutti i browser;
    - il gradino 4 è E-AC-3/AC-3 solo in Edge (codificati da ffmpeg; la copia dalla sorgente è da provare), altrimenti AAC 5.1 (channelConfiguration 6) o Opus 5.1;
    - mai AAC con PCE: prima dell'encoder AAC o Opus il layout va portato da 5.1(side) a 5.1, e dopo l'AAC si controlla il channelConfiguration.
  - **§4.4:** nel browser i PGS si servono come `.sup` a parte (delivery `client_render`) e li rende il client, con i cue sulla timeline originale.
  - **§4.5:** il buffer in avanti di hls.js si dimensiona dal bitrate.
  - **§5:** il rilevamento web usa un elenco fisso di stringhe con `isTypeSupported` e verifica `stream.mimeType` prima di avviare il player (I6). `canPlayType` per MKV non serve a decidere il Direct Play e `audioTracks` non è disponibile.
  - **§8:** si ripianifica dalla dimensione sospetta con la modifica minima; gli errori fatali di MSE e l'audio che sparisce in Direct Play contano come fallimenti.
  - **§10:** nuova ipotesi H11 (DV P7 nel browser).
  - **§11:** P2 riporta l'esito (la condizione non scatta); P5 ha una premessa più debole e dice cosa succede con un override.
- **Doc 03:**
  - **§4.1 (ClientCapabilities):** vocabolario fisso per codec e profili (I6); HDR del display tenuto separato da quello del decoder (I5);
  - **§4.2:** `ChangeTracks` con un PGS impone il burn-in solo sui client senza renderer;
  - **§4.3:** i PGS resi dal client hanno una delivery propria, `client_render` (URL del `.sup`), distinta da `sidecar`, che resta per il testo;
  - **§5:** la riga dei sottotitoli comprende i `.sup`; quando si estraggono è aperto (ADR 0003).
- **Doc 02:**
  - nello Stream Delivery i sottotitoli immagine si servono anche come `.sup` a parte per il render lato client, non solo in pass-through o bruciati nel video; quando e dove estrarli è aperto (ADR 0003);
  - la conversione audio porta il layout a 5.1 prima dell'AAC e controlla il channelConfiguration del risultato.
- **Doc 01:** nessun campo nuovo oltre a quelli di S1 (profilo DV e compatibilità del base layer). Il layout dei canali audio, già rilevato, serve allo Stream Delivery per la conversione audio (doc 02 §3.11).

**Input per ADR 0003 (protocollo di streaming).** Sono da valutare, non decisi.
- **Formato:**
  - HLS con segmenti fMP4 via MSE ha funzionato in Chrome, Edge e Firefox, per AVC e per HEVC Main10 HDR10 4K con video copiato;
  - l'fMP4 progressivo funziona, ma in Chromium il 4K parte più lento (0,8–1,5 s), probabilmente perché il demuxer legge tutti i `moof` (Altre misure). Va misurato su un file intero, o generato con `sidx` (`-movflags +global_sidx`, da provare).
- **Codec tag:**
  - HEVC come `hvc1`;
  - DV verso il browser sempre come `hvc1`, senza box DV: mai `-strict unofficial`. Per P8.1 RPU e SEI restano nel flusso, e il brand `dby1` non disturba (h6). Per P7 si tolgono RPU ed EL con `hevc_metadata=remove_dovi=1`, in via provvisoria finché H11 non è misurata;
  - `hev1` è accettato da `isTypeSupported` ma non è stato riprodotto.
- **Tracce audio: audio muxato o rendition separate.**
  - Con audio e video negli stessi segmenti, come nello spike, c'è una traccia per stream, il cambio richiede un riavvio e un codec rifiutato fa cadere anche il video.
  - Con rendition audio separate (`EXT-X-MEDIA`, `hls.audioTrack`) hls.js cambia traccia da sé, con un SourceBuffer audio a parte: cambio senza riavvio, ma più conversioni audio sul server. Non provato in S2.
- **Audio per browser.** Ogni stream o rendition porta un solo codec, dichiarato dal client:

| Browser | Lossless | Lossy multicanale | Stereo |
|---|---|---|---|
| Edge | FLAC | E-AC-3/AC-3 (misurati codificati da ffmpeg; la copia dalla sorgente è da provare su un remux reale), AAC 5.1 (channelConfiguration 6), Opus 5.1 | AAC |
| Chrome | FLAC | AAC 5.1 (channelConfiguration 6), Opus 5.1 | AAC |
| Firefox | FLAC | AAC 5.1 (channelConfiguration 6), Opus 5.1 | AAC |

- **Layout prima di AAC e Opus.**
  - Prima di codificare in AAC 5.1 o Opus 5.1 il layout va portato a 5.1 (back), con `aformat=channel_layouts=5.1` o `-ac 6`.
  - Per l'AAC evita il PCE, e il mix non cambia: il file è identico byte per byte a quello prodotto da un ingresso 5.1.
  - Per l'Opus dipende dalla build: ffmpeg 8.1.2 upstream rifiuta 5.1(side) all'apertura dell'encoder ("Invalid channel layout 5.1(side) for specified mapping family 1", anche senza `-mapping_family`); jellyfin-ffmpeg 8.1.3 (ADR 0006) lo rimappa da sé sui canali posteriori. Con il layout portato a 5.1 codificano entrambe.
  - Serve per ogni sorgente 5.1, perché i decoder di ffmpeg danno sempre 5.1(side).
  - Dopo l'encoder AAC serve un controllo: channelConfiguration diverso da 0 nell'`esds`.
  - A ogni cambio di versione di ffmpeg la misura va ripetuta (basta un test automatico), perché upstream la tabella del PCE è cambiata dopo la 8.1.
- **Metadata HDR statici.** Con il video copiato restano solo nei SEI. Da valutare:
  - scrivere `mdcv`/`clli` nel segmento di init quando la sorgente li ha, perché Chromium li legge da lì;
  - oppure verificare se i remux reali li portano nel container: in quel caso ffmpeg li scrive da solo.
- **Segmenti e buffer.** Il `bufferFullError` viene dal buffer in avanti di hls.js (30 s), non dalla durata dei segmenti: segmenti più corti non cambiano i byte nel buffer.
  - Dimensionare `maxBufferLength`, `maxMaxBufferLength` e `maxBufferSize` di hls.js dal bitrate dello stream, perché il buffer in avanti resti sotto i 150 MiB del video di Chromium con margine (per esempio il 70%: circa 9 s a 100 Mbps, 7 s a 128 Mbps). `maxBufferSize` non è un tetto in byte: entra nel calcolo della durata.
  - `backBufferLength` finito.
  - Il limite audio (12 MiB) non è stato esercitato: va misurato con FLAC multicanale reale su un film intero.
- **Sottotitoli:** i PGS come `.sup` servito dal server, il testo come WebVTT. Nello spike erano estratti in anticipo da clip di 30 s. Quando e dove estrarli è un punto aperto (Conclusioni, punto 10).

**Input per ADR 0005 (web client).** Sono da valutare, non decisi.
- **hls.js 1.7.3** ha funzionato in tutti e tre i browser, con HEVC, FLAC, Opus e AAC 5.1.
  - Vanno gestiti i suoi errori: `bufferFullError` si recupera, `bufferAddCodecError` è fatale, `mediaSourceRequiresReset` ricrea la MediaSource.
  - Gli errori fatali vanno tradotti in una ripianificazione.
  - I limiti del buffer si fissano dal bitrate (vedi ADR 0003, Segmenti e buffer).
  - Le alternative (Shaka Player, HLS nativo di Chromium, dash.js se si sceglie DASH) non sono state provate.
- **Audio che sparisce in Direct Play.** Nell'MKV o nell'MP4 progressivo l'audio non supportato sparisce senza errore.
  - Se dopo qualche secondo `webkitAudioDecodedByteCount` resta a 0 (Chromium) o `mozHasAudio` è false (Firefox), il client segnala un fallimento audio.
  - Le due proprietà non sono standard: se mancano, il client non segnala.
  - L'AAC con PCE in Firefox non si vede da questi segnali (c5: `mozHasAudio` true, 0 canali vivi): lo previene solo il controllo del server.
- **Renderer PGS:** libpgs 0.9.0 (MIT, Worker + OffscreenCanvas) basta.
  - Va pilotato con `requestVideoFrameCallback` → `renderAtTimestamp(t)`, non con il `timeupdate` predefinito. t sta sulla timeline originale: `mediaTime`, più l'offset dello stream se la timeline del player non è quella originale. Lo stesso offset vale per il WebVTT.
  - Le alternative non sono state valutate.
- **Rilevamento delle capability:**
  - `MediaSource.isTypeSupported` su un elenco fisso di stringhe, quelle di S2: `avc1.640028`, `hvc1.2.4.L153.B0`, `hvc1.2.4.L183.B0`, `hvc1.2.4.H153.B0` (tier High, riprodotto ma non sondato), `flac`, `opus`, `mp4a.40.2`, `ac-3`, `ec-3`. Il risultato si dichiara nei campi esistenti con un vocabolario fisso (doc 03, I6);
  - prima di avviare il player, `isTypeSupported` sulla stringa esatta di `stream.mimeType`; se è false, `reportPlaybackFailure` con la dimensione sospetta;
  - `decodingInfo` con i parametri HDR dice se il browser decodifica, non come presenta: Firefox risponde sì anche a HDR10+ e ad AV1 4K HDR10;
  - `matchMedia('(dynamic-range: high)')` per il display;
  - browser, versione e sistema nel modello del dispositivo, per gli override (I2);
  - `maxChannelCount` solo per la diagnostica: i canali dichiarati sono quelli che il browser decodifica, e il downmix lo fa il browser.
- **Tracce audio:** `HTMLMediaElement.audioTracks` non è disponibile senza flag (MDN BCD), quindi nel Direct Play la traccia non si sceglie. Con HLS il cambio di traccia dipende dal packaging (ADR 0003): con audio muxato lo decide il server con un riavvio, con rendition separate lo fa hls.js.
- **Firefox:** rVFC va a circa 25 Hz. Basta per i PGS (≤ 42 ms), non per statistiche frame per frame.
