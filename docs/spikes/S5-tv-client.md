# S5 — Client TV sulla TV del proprietario

- **Stato:** Completato (2026-11-07) per le misure da remoto. Restano le verifiche fisiche del proprietario (immagine HDR/Dolby Vision, ascolto, fluidità dei 24p): elenco nelle Conclusioni.
- **Domanda:** cosa riproduce davvero la TV del salotto (Haier, Android TV 11) con un'app nativa Media3? Audio sugli altoparlanti della TV, Direct Play via HTTP Range, PGS, capability da dichiarare al server, rete Wi‑Fi a 2,4 GHz, memoria, e il percorso completo attraverso il server Pezzotflix.
- **Alimenta:** doc 04 H5 e §4.3, §4.4, §4.5, §5 (capability Android TV); doc 03 §4.1 (`ClientCapabilities`, `stream.bitrate`); doc 05 §8.9, §8.10, §8.13 (domande per S5); [ADR 0008](../adr/0008-client-tv-kotlin-compose-media3.md) (client TV); ADR 0003 (Direct Stream e sottotitoli esterni); profilo del Decision Engine e override (I2) per questa TV.
- **Codice:** `spikes/s5-tv-client/`, throwaway.
  - `android/`: app Kotlin + Media3 (sonda e player con overlay), progetto Gradle con wrapper.
  - `fetch.sh` (bitstream audio reali dalla suite FATE di FFmpeg), `make_media.sh` + `samples_index.py` (file di prova in `out/www/gen/`), `serve.sh` (nginx in sola lettura).
  - `run_tests.sh`, `extra_tests.sh`, `ds_tests.sh` + `ds_session.py`, `net2.sh` (prove pilotate via ADB); `summarize.py`, `audio_matrix.py` (tabelle dai log); `bitrate.py`, `net_traces.py`, `net_model.py` (profilo di bitrate, tracce di rete, modello del buffer); `q7_api.py` (piani del Decision Engine via API); `evidence.py` (artefatti versionati).
  - Risultati grezzi in `spikes/s5-tv-client/out/results/` (gitignored).
- **Evidenze versionate:** [`docs/spikes/S5-tv-client/`](S5-tv-client/) (capability, tabella dei decoder, estratti di `dumpsys`, risultati delle prove), ripulite da seriali, MAC, SSID e BSSID.

## Setup

- **TV:** Haier H65C95EUX ("Haier OLED TV AE"), Android TV **11** (API 30), patch 2025-03-01, SoC MediaTek **MT5889**.
  - Sistema **a 32 bit**: `uname -m` = `armv8l`, `ro.product.cpu.abilist` = `armeabi-v7a,armeabi`, nessuna ABI a 64 bit, `ro.zygote` = `zygote32`; l'APK è installato con `primaryCpuAbi=armeabi-v7a`.
  - RAM 2,95 GB (`MemTotal` 2.884.672 kB), liberi 1,06 GB al momento della sonda e 0,69 GB durante le prove; heap Java per app **192 MB** (`memoryClass`), 512 MB con `largeHeap`.
  - Interfaccia 1920×1080 a **60 o 50 Hz** (gli unici due modi); piano video 3840×2160 (`Util.getCurrentDisplayModeSize` di Media3).
  - Audio: **un solo dispositivo d'uscita attivo**, `BUILTIN_SPEAKER` (la barra Harman Kardon della TV). Nessun AVR o soundbar esterna (correzione del proprietario): l'ARC non è il percorso da misurare.
  - Rete: Wi‑Fi **2,4 GHz** (canale 11, collegamento 144 Mb/s, RSSI −50 dBm), condizione reale della prima versione dell'app: il proprietario non può passare a 5 GHz né al cavo.
- **App:** pacchetto `dev.pezzotflix.s5probe`, nome "Pezzotflix S5 sonda", voce nel launcher della TV (banner Leanback). Build release firmata con la chiave di debug, APK 9,7 MB.
  - Kotlin con le View di Android (niente Compose: lo spike misura la riproduzione, non la UI).
  - **Media3 1.11.1** (ultima stabile su Google Maven al 2026-11-07): `media3-exoplayer`, `media3-exoplayer-hls`, `media3-ui`.
  - Estensione FFmpeg: `org.jellyfin.media3:media3-ffmpeg-decoder:1.9.0+1` (Maven Central), libavcodec 60.3.100, **licenza GPL‑3.0**, compilata per Media3 1.9.0 e usata qui con la 1.11.1. Si attiva e disattiva per prova: l'ADR 0008 la lascia fuori dalla prima build, quindi i risultati "senza FFmpeg" sono quelli che valgono per il client.
  - Heap: le prove di memoria fino al gruppo `hot` girano con l'heap predefinito (192 MB, build `-PlargeHeap=false`); le prove successive e l'APK lasciato installato hanno `largeHeap` (512 MB).
  - Build: AGP 9.5.1 (Kotlin integrato, KGP 2.2.10), Gradle 9.6.0, JDK 21.0.13, compileSdk 36, minSdk 26.
- **Server dei file:** nginx 1.31.8 (`nginx:alpine`) in Docker sul portatile, porta 18381, tutto montato in sola lettura: `media-samples/library` e `out/www`.
- **Server Pezzotflix:** stack dedicato `pzf-s5` (gateway Caddy + Video Service, immagini `s5`) sulla porta 18380, con la libreria di prova.
- **Portatile (server):** in Wi‑Fi, di norma a 5 GHz (collegamento 432/576 Mb/s). La TV è associata a un access point diverso da quello del portatile. Il portatile a volte passa da solo ai 2,4 GHz, e allora condivide la banda con la TV (Q5).
- **Sample:**

| Sample | Contenuto | Per |
|---|---|---|
| **2001: Odissea nello spazio** (file del proprietario) | Re-encode x265, 21,8 GB, 148,8 min, **19,6 Mb/s medi**; HEVC Main10 3840×1746 HDR10, 23,976p; SRT eng, SRT eng SDH, **PGS ita**, **AC-3 5.1 ita** (default, 384k), **AAC 5.1 eng**. Secondo il proprietario è il file tipico della libreria reale | caso principale per Q1, Q2, Q3, Q5, Q6, Q7 |
| Blade Runner 2049 (fixture S1) | HEVC 4K60 HDR10 ~100 Mb/s (livello 6.1), TrueHD 5.1 ita, E-AC-3 5.1, AC-3 2.0, PGS ita forced e completi, SRT, ASS | remux "pesante" |
| Dune (fixture S1) | DV **P8.1** + TrueHD 5.1 eng + E-AC-3 5.1 ita | DV |
| Oppenheimer (fixture S1) | DV **P5** + FLAC 5.1 | DV senza fallback |
| Il Buono, il Brutto, il Cattivo (fixture S1) | AVC 1080p ~31 Mb/s, DTS 5.1 core + AC-3 5.1 + PGS | 1080p |
| Long Test (fixture S3) | HEVC 4K HDR10 5 min, 44 Mb/s, GOP 2 s, TrueHD + E-AC-3 | seek lontano, Direct Stream |
| `canali-5.1-otto-codec.mkv` (generato) | rumore rosa canale per canale, con il nome del canale a schermo, in 8 tracce: TrueHD, DTS core, E-AC-3, AC-3, FLAC, PCM 24 bit, AAC 5.1, AAC 2.0 | Q1 |
| `canali-7.1-tre-codec.mkv` (generato) | come sopra in 7.1: FLAC, PCM. La traccia TrueHD è 5.1: l'encoder di ffmpeg non produce TrueHD 7.1 e ha ridotto il layout senza avvisare | Q1 |
| Bitstream reali FATE (`fetch.sh`) | **TrueHD Atmos 7.1** (`atmos.thd`), **DTS-HD MA 7.1** (`master_audio_7.1_24bit.dts`), **E-AC-3 JOC Atmos 7.1** (`the_great_wall_7.1.eac3`), copiati in MKV | Q1, codec "veri" |
| `confronto-truehd-eac3-flac.mkv` (generato) | 50 s dello stesso mix reale (il DTS-HD MA di FATE): 1 TrueHD 5.1, 2 E-AC-3 5.1 640k, 3 FLAC 5.1, 4 DTS-HD MA 7.1 originale | ascolto del proprietario |
| `flac-blocchi.mkv` / `.mp4` (generati) | lo stesso mix reale in FLAC 24 bit: 5.1 e 7.1, blocchi da 4608 e da 1152 campioni; l'MP4 è frammentato come il Direct Stream | Q1, FLAC del server |
| `ascolto-2001-aac-vs-eac3.mkv` (generato in `out/`, dal file del proprietario) | 4 min di 2001 da 26:00, video copiato: 1 AAC 5.1 eng originale, 2 E-AC-3 5.1 640k convertito dallo stesso AAC come farebbe il server, 3 AC-3 ita originale | coppia d'ascolto dell'ADR 0008 |

- **Metodo:** gli script avviano il player via ADB con parametri (URL, traccia audio e sottotitoli, buffer, seek, FFmpeg sì/no, tunneling) e volume del player al 5%. L'app scrive ogni evento in logcat con il tag `PZF_S5`, un oggetto JSON per riga. A tempo fisso lo script salva `dumpsys meminfo`, `dumpsys media.audio_flinger` e i layer di SurfaceFlinger. Prima di ogni prova `input keyevent KEYCODE_WAKEUP`: la TV va in standby da sola (è successo una volta durante lo spike, ~13 minuti di prove perse).
  - **Avvio:** dal `prepare()` allo stato READY e al primo frame reso (`onRenderedFirstFrame`).
  - **Seek:** dal `seekTo()` al primo frame reso e allo stato READY; seek esatto (default di Media3) e, dove indicato, al keyframe (`CLOSEST_SYNC`).
  - **Frame persi:** `DecoderCounters` del decoder video (`droppedBufferCount` su `renderedOutputBufferCount`).
  - **Percorso audio:** il formato dell'`AudioTrack` (evento di Media3) e il thread di AudioFlinger attivo durante la prova: `OFFLOAD`/`DIRECT` con formato compresso = bitstream al decoder della TV; `MIXER` = PCM mixato da Android.
- **Ricostruzione:** `bash spikes/s5-tv-client/fetch.sh && bash spikes/s5-tv-client/make_media.sh && (cd spikes/s5-tv-client/android && ./gradlew assembleRelease) && adb -s 192.168.1.8:5555 install -r spikes/s5-tv-client/android/app/build/outputs/apk/release/app-release.apk && bash spikes/s5-tv-client/serve.sh && bash spikes/s5-tv-client/run_tests.sh all && bash spikes/s5-tv-client/extra_tests.sh hotlh flac pair && bash spikes/s5-tv-client/ds_tests.sh && bash spikes/s5-tv-client/net2.sh 3 180 && python -I spikes/s5-tv-client/evidence.py`. Su Windows `FFMPEG` punta a `ffmpeg.exe` e Gradle va lanciato con `gradlew.bat`; per le prove di memoria con l'heap predefinito, `gradlew assembleRelease -PlargeHeap=false`. `run_tests.sh q7` e `ds_tests.sh` vogliono lo stack `pzf-s5` sulla porta 18380.
- **Analisi** (da `spikes/s5-tv-client/`, prima di `evidence.py`): `for g in out/results/*/; do python -I summarize.py $g; done; python -I audio_matrix.py out/results/{audio-off,audio-on,flac,pair,o2001} > out/results/audio-matrix.txt; python -I net_traces.py out/results/net*/run*.log > out/results/net-stats.jsonl; python -I q7_api.py http://<portatile>:18380 out/results/client-caps-noffmpeg.json`. `bitrate.py` gira sul 2001 e sui sample (il suo `bitrate.json` va rinominato in `bitrate-2001.json` e `bitrate-samples.json`), poi `net_model.py <profilo> out/results/net*/run*.trace.json`. I dump in `out/results/device/` vengono da `adb shell dumpsys media.audio_policy`, `adb shell cat /vendor/etc/media_codecs.xml /vendor/etc/media_codecs_c2.xml` e `adb shell dumpsys hdmi_control`.

## Evidenze del dispositivo

Confronto con le note lette via ADB prima dello spike (`tv-facts.md` dell'orchestratore). Gli artefatti sono in [`docs/spikes/S5-tv-client/`](S5-tv-client/).

| Fatto | Esito in S5 | Artefatto |
|---|---|---|
| Android TV 11 (API 30), patch 2025-03-01, SoC MT5889 | ✅ | `platform.txt`, `raw-caps.json` (`build`) |
| "4 core aarch64" | ⚠️ **Corretto:** la CPU è ARMv8, ma kernel e userland sono a 32 bit (`armv8l`, solo `armeabi-v7a`, `zygote32`). Un APK serve con le librerie native `armeabi-v7a` | `platform.txt` |
| RAM 2,8 GB, ~1 GB libero a riposo | ✅ 2.884.672 kB; 1,06 GB liberi alla sonda, 0,69 GB durante le prove | `platform.txt` |
| Interfaccia 1920×1080 a 60/50 Hz, piano video 3840×2160 | ✅ | `raw-caps.json` (`display`) |
| Decoder video: HEVC, AV1, AVC, VP9, VP8, MPEG-2, VC-1; DV P4, P5, P8, P9, P10; **nessun DV P7** | ✅ tutti visibili in `MediaCodecList(ALL_CODECS)`. Dichiarati nell'XML ma **non visibili** alle app: AVS, AVS2, RealVideo e `OMX.MS.HEVCDV.Decoder` | `decoders.md` |
| HDR: Dolby Vision, HDR10, HLG, HDR10+; 500 nit | ✅ | `raw-caps.json` (`display`) |
| Decoder audio hardware: AC-3, E-AC-3 (6 canali), **DTS** (fino a 8 canali), LPCM, AAC, MP2; niente TrueHD | ⚠️ **Corretto:** `OMX.MS.DTS.Decoder` è dichiarato nel `media_codecs.xml` del vendor anche con i MIME standard (`audio/vnd.dts` fino a 6 canali, `audio/vnd.dts.hd` fino a 8), ma **non compare in `MediaCodecList(ALL_CODECS)`**: per un'app non esiste. Lo stesso per LPCM, WMA, RealAudio e DRA. L'AAC hardware è dichiarato con un MIME non standard (`audio/mp4a-latm-hw`): Media3 usa `c2.android.aac.decoder`, software. AC-3, E-AC-3 (6 canali) e MP2: ✅. Niente TrueHD: ✅ | `decoders.md`, `raw-caps.json` (`codecs`) |
| Policy audio: uscita **Speaker** = PCM 16 bit stereo + AC-3, E-AC-3, E-AC-3 JOC; **HDMI ARC** = solo AC-3 ed E-AC-3 (fino a 7.1, ≤ 48 kHz); uscite compresse (offload e `hw_av_sync`) con AC-3, E-AC-3, E-AC-3 JOC, AAC, AC-4; niente TrueHD, MAT, DTS, IEC61937 | ✅ | `audio-policy.txt` |
| Media3 `AudioCapabilities` con l'AVR collegato | non verificabile: non c'è un AVR | — |
| ARC solo su HDMI 3, non attivo; Android 11 non modella l'eARC | ✅ | `hdmi.txt` |
| Wi‑Fi 2,4 GHz, canale 11, 144 Mb/s, RSSI −49 dBm | ✅ (−50 dBm durante le prove) | — (dumpsys wifi non versionato: contiene SSID e BSSID) |

## Risultati

### Q4 — Capability viste dall'app

Sonda `CapsActivity`, file completo in [`raw-caps.json`](S5-tv-client/raw-caps.json); i decoder in [`decoders.md`](S5-tv-client/decoders.md).

| Area | Cosa riporta la TV | Note |
|---|---|---|
| HEVC | `OMX.MS.HEVC.Decoder` (hardware): Main, **Main10, Main10 HDR10, Main10 HDR10+** fino a **High tier 5.1**; 4096×2176; 3840×2160 fino a 64,5 fps; bitrate massimo 160 Mb/s; tunneling sì | livello 5.1 High è quello degli UHD Blu-ray |
| Dolby Vision | decoder hardware per **P4** (DVHE.DTR), **P5** (DVHE.STN), **P8** (DVHE.ST), **P9** (DVAV.SE), **P10** (DVAV1), tutti `uhd60` tranne P9 (`fhd60`); più un decoder generico P4/P5/P8. **Nessun P7** (DVHE.DTB) | come da `media_codecs.xml` |
| AV1 | `OMX.MS.AV1.Decoder`: Main 8/10, HDR10, HDR10+, livello 5.1, 4K fino a 66 fps | |
| H.264 | `OMX.MS.AVC.Decoder`: fino a High 5.1; **4K solo fino a 30 fps** | |
| VP9 | Profile 0/2 (HDR, HDR10+), 4K fino a 70 fps | |
| Display | HDR: **Dolby Vision, HDR10, HLG, HDR10+**; luminanza dichiarata 500 nit; modi 1920×1080 a 60 e 50 Hz; Media3 vede **3840×2160** | **nessun modo a 24 Hz** (vedi Scoperte) |
| Audio, decoder | Hardware: `OMX.MS.AC3.Decoder` (6 can.), `OMX.MS.EAC3.Decoder` (6 can.). Software: AAC (8), FLAC (8), Opus (8), raw/PCM (8). **Nessun decoder DTS né TrueHD visibile alle app** | `OMX.MS.DTS.Decoder` è nel `media_codecs.xml` del vendor, anche con `audio/vnd.dts` e `audio/vnd.dts.hd`, ma **non è in `MediaCodecList(ALL_CODECS)`** (Evidenze) |
| Audio, uscita | Un dispositivo: `BUILTIN_SPEAKER`, codifiche PCM 16 bit, **AC-3, E-AC-3, E-AC-3 JOC**, 2 canali. Media3 `AudioCapabilities`: passthrough per AC-3, E-AC-3, E-AC-3 JOC e AC-4. `AudioTrack.isDirectPlaybackSupported`: le stesse quattro, a 2, 6 e 8 canali; PCM diretto no; DTS, DTS-HD, TrueHD, MAT, IEC61937 no | il "passthrough" qui va al decoder Dolby della TV, non a un AVR |
| FFmpeg (estensione) | caricata, libavcodec 60.3.100; `supportsFormat` vero per TrueHD, DTS, DTS-HD, AC-3, E-AC-3, AAC, FLAC | fuori dalla prima build (ADR 0008) |
| Tunneling | tutti i decoder video hardware lo dichiarano; nessun decoder audio | |

**JSON che il client TV dichiarerebbe al server** (`ClientCapabilities` del contratto, generato dall'app **senza FFmpeg**, come nella prima build dell'ADR 0008; file completo in [`client-caps-noffmpeg.json`](S5-tv-client/client-caps-noffmpeg.json)):

```json
{
  "device": { "class": "tv", "model": "Haier Haier OLED TV AE; Android 11 (API 30); Media3 1.11.1", "app": "pezzotflix-s5-probe 0.1" },
  "containers": ["mkv", "mp4", "webm"],
  "audioTrackSelection": true,
  "protocols": ["progressive", "hls-fmp4"],
  "video": [
    { "codec": "hevc", "profiles": ["main", "main10"], "maxWidth": 1920, "maxHeight": 1080, "maxBitDepth": 10, "maxFrameRate": 256 },
    { "codec": "hevc", "profiles": ["main", "main10"], "maxWidth": 4096, "maxHeight": 2176, "maxBitDepth": 10, "maxFrameRate": 64 },
    { "codec": "h264", "profiles": ["baseline", "main", "high"], "maxWidth": 1920, "maxHeight": 1080, "maxBitDepth": 8, "maxFrameRate": 120 },
    { "codec": "h264", "profiles": ["baseline", "main", "high"], "maxWidth": 4096, "maxHeight": 2304, "maxBitDepth": 8, "maxFrameRate": 30 },
    { "codec": "av1", "profiles": ["main"], "maxWidth": 4096, "maxHeight": 2304, "maxBitDepth": 10, "maxFrameRate": 66 },
    { "codec": "vp9", "profiles": ["profile0", "profile2"], "maxWidth": 4096, "maxHeight": 2176, "maxBitDepth": 10, "maxFrameRate": 70 }
  ],
  "hdr": ["HDR10", "HDR10+", "HLG", "DV4", "DV5", "DV8", "DV9", "DV10"],
  "displayHdr": true,
  "audio": [
    { "codec": "eac3", "maxChannels": 8, "mode": "passthrough" },
    { "codec": "ac3", "maxChannels": 6, "mode": "passthrough" },
    { "codec": "aac", "maxChannels": 8, "mode": "decode" },
    { "codec": "flac", "maxChannels": 8, "mode": "decode" },
    { "codec": "opus", "maxChannels": 8, "mode": "decode" },
    { "codec": "pcm", "maxChannels": 8, "mode": "decode" }
  ],
  "subtitles": { "text": ["srt", "webvtt", "tx3g"], "image": ["pgs", "vobsub", "dvb"], "ass": true }
}
```

(Abbreviato: le voci AV1 e VP9 a 1080p sono omesse. Con FFmpeg si aggiungono `dtshd`, `dts` e `truehd` in `decode`: [`client-caps.json`](S5-tv-client/client-caps.json).)

- **Una voce per fascia di risoluzione.** Il contratto ha un solo `maxFrameRate` per voce e H.264 fa 120 fps a 1080p ma 30 a 4K: con una voce sola un 1080p60 H.264 verrebbe scartato. Il Decision Engine guarda la dimensione prima del frame rate (`videoFit`), quindi due voci per codec funzionano già.
- **`mode: passthrough` qui significa "bitstream al decoder Dolby della TV"**: AC-3 ed E-AC-3 arrivano compressi all'uscita, e la TV li decodifica da sé (Q1). Per il server non cambia nulla: passthrough e decodifica accettano entrambi il bitstream.
- `maxChannels` 8 per E-AC-3 in passthrough viene da `isDirectPlaybackSupported`; i decoder hardware fanno 6 canali.
- **Due voci da rivedere** alla luce di Q1 e Q3: `flac` a 8 canali vale solo con blocchi piccoli (Q1), e `pgs` vale solo incorporato nel container, non come `.sup` esterno (Q3).

### Q1 — Audio sugli altoparlanti della TV (uscita Speaker)

Una prova per traccia, FFmpeg spento (prima build) e acceso. File generati e bitstream reali FATE da nginx; 2001 per AC-3 e AAC reali. Righe complete in [`results/audio-matrix.txt`](S5-tv-client/results/audio-matrix.txt).

| Traccia | Senza FFmpeg (prima build, ADR 0008) | Con FFmpeg | Percorso fino agli altoparlanti |
|---|---|---|---|
| **AC-3 5.1** (2001 ita 384k; prova 640k) | **bitstream** (`AudioTrack` AC3, 6 can.) | uguale | thread `OFFLOAD` (`DIRECT\|COMPRESS_OFFLOAD`), formato HAL **AC3 6 can.** → decoder Dolby della TV |
| **E-AC-3 5.1** (prova 640k, Dune ita) | **bitstream** (E_AC3, 6 can.) | uguale | `OFFLOAD`, **E_AC3 6 can.** |
| **E-AC-3 JOC Atmos 7.1** (FATE) | **bitstream** (E_AC3, 8 can.) | uguale | `OFFLOAD`, **E_AC3 8 can.** Media3 non riconosce il JOC nell'MKV e lo passa come E-AC-3: gli oggetti restano nel bitstream, il decoder della TV fa il resto |
| **AAC 5.1** (2001 eng; prova) | `c2.android.aac.decoder` (**software**) → PCM 16 bit **6 can.** | uguale | thread `MIXER`, PCM 16 bit **2 can.**: **Android mixa i 6 canali in stereo** prima della TV |
| AAC 2.0 | software → PCM 2 can. | uguale | `MIXER` 2 can. |
| FLAC 5.1 e 7.1, 24 bit, rumore rosa (blocchi 4608) | `c2.android.flac.decoder` → PCM 6/8 can. | uguale | `MIXER` 2 can. |
| **FLAC 5.1 e 7.1, 24 bit, mix reale, blocchi 4608** (come il server), in MKV **e in MP4 frammentato** | **errore** dopo 1–4 s: `InsufficientCapacityException: Buffer too small (32768 < 33242)` (7.1: `< 34197` e oltre) | uguale (Media3 preferisce il decoder della piattaforma) | — (Scoperta 1) |
| **FLAC 5.1 e 7.1, 24 bit, mix reale, blocchi 1152**, in MKV e in MP4 frammentato | `c2.android.flac.decoder` → PCM 6/8 can., **nessun errore** | non provato | `MIXER` 2 can. |
| PCM 24 bit 5.1 e 7.1 | nessun decoder; PCM 16 bit 6/8 can. | uguale | `MIXER` 2 can. |
| **TrueHD 5.1** (sintetico), **TrueHD Atmos 7.1** (FATE) | **non riproducibile**: `ERROR_CODE_DECODER_INIT_FAILED` se scelto; da solo, traccia non supportata e video senza audio | `ffmpegLavc60.3.100-truehd` → PCM 6/8 can. (il letto 7.1 decodificato, oggetti Atmos persi) | `MIXER` 2 can. |
| **DTS 5.1 core**, **DTS-HD MA 7.1** (FATE) | **non riproducibile** (come TrueHD): il decoder DTS del vendor non è visibile | `ffmpegLavc60.3.100-dca` → PCM 6/8 can. | `MIXER` 2 can. |

**Coppia d'ascolto dell'ADR 0008 sul 2001** (`ascolto-2001-aac-vs-eac3.mkv`, senza FFmpeg):

| Traccia | Decoder | `AudioTrack` | AudioFlinger | Frame persi |
|---|---|---|---|---|
| 1 AAC 5.1 eng (originale) | `c2.android.aac.decoder` | PCM 16 bit, 6 can. | `MIXER` PCM **2 can.** | 0 / 362 |
| 2 E-AC-3 5.1 640k (dallo stesso AAC, impostazioni del server) | — (bitstream) | E_AC3, 6 can. | `OFFLOAD` **E_AC3 6 can.** | 95 / 308, tutti nei primi 1,4 s, durante il cambio di traccia AC-3 → E-AC-3 fatto dallo script; dopo il seek 0 |
| 3 AC-3 5.1 ita (originale) | — (bitstream) | AC3, 6 can. | `OFFLOAD` **AC3 6 can.** | 0 / 370 |

Le due tracce della coppia seguono davvero i due percorsi: la 1 arriva alla TV già stereo, la 2 arriva compressa al decoder Dolby. Quale suona meglio lo dice l'ascolto (verifiche del proprietario). Media3, lasciato fare, sceglie la traccia ita perché la lingua di sistema è l'italiano, non la traccia marcata `default` (Scoperta 5).

- **Bitstream al decoder della TV solo per la famiglia Dolby (AC-3, E-AC-3, JOC).** Lo dicono insieme il formato dell'`AudioTrack` di Media3 e il thread di AudioFlinger: formato compresso su un'uscita `DIRECT|COMPRESS_OFFLOAD` (con il tunneling, `DIRECT` su `hw_av_sync`). Senza AVR, il "passthrough" del contratto è questo.
- **Tutto il resto diventa PCM stereo prima della TV.** AAC, FLAC, PCM e i TrueHD/DTS decodificati da FFmpeg escono dal decoder a 6 o 8 canali, ma l'unico mixer verso l'altoparlante è stereo (`Channel count: 2`, maschera `front-left, front-right`): il downmix lo fa AudioFlinger. Con AC-3/E-AC-3 il downmix lo fa invece il decoder Dolby della TV, che può applicare la sua elaborazione (virtualizzazione, dialoghi): **se suoni meglio si sente, non si misura** (verifica del proprietario).
- **Lossless:** il passthrough di TrueHD e DTS-HD non esiste su questa TV (né verso lo Speaker né verso l'ARC, che accetta solo AC-3/E-AC-3), ma senza un impianto esterno non serve: sugli altoparlanti della TV un TrueHD arriva comunque come PCM stereo.
- **FFmpeg:** decodifica TrueHD (anche Atmos, come letto 7.1) e DTS/DTS-HD MA senza frame persi in più nelle prove 1080p (0–1 su ~350). Sul 4K60 di Blade Runner il TrueHD software si somma a un video da 100 Mb/s: 9 frame persi su 754 (Q2), non separabili dalla rete.

### Q2 — Direct Play via HTTP Range

Tutte le prove da nginx sulla rete Wi‑Fi, senza sottotitoli, FFmpeg attivo. "Avvio" = primo frame / stato READY; "Seek" = verso la posizione indicata, primo frame / READY; seek esatto salvo dove indicato.

| Sample | Decoder video | HDR in Media3 / layer di SurfaceFlinger | Avvio (ms) | Seek (ms) | Frame persi / resi | Rebuffer |
|---|---|---|---|---|---|---|
| **2001** (x265, 19,6 Mb/s) | `OMX.MS.HEVC.Decoder` | HDR10 (PQ) / `BT2020_ITU_PQ` | 997 / 1176 | a 2:00:00: **772 / 1103** | **0 / 933** | 0 |
| 2001, seek al keyframe | idem | idem | 984 / 1139 | a 1:15:00: 380 / 734 | 0 / 704 | 0 |
| 2001, tunneling | idem | idem | 1152 / 945 | a 1:00:00: 1236 / 2898 | 0 / 669 | 0 |
| Blade Runner (4K60 ~100 Mb/s, livello 6.1) | `OMX.MS.HEVC.Decoder` | HDR10 (PQ) / `BT2020_ITU_PQ` | 1358 / 2179 | a 0:24: 351 / 1668 | 9 / 754 | **1 (3,2 s)** |
| Blade Runner, tunneling | idem | idem | 882 / 1392 | 368 / 1811 | 4 / 845 | **1 (2,8 s)** |
| Dune, **DV P8.1** | **`OMX.MS.DOLBY_VISION.DVHE.ST.Decoder`** | Dolby Vision `dvhe.08.09` / `BT2020_ITU_PQ` | 912 / 1094 | 169 / 228 | 2 / 1010 | 0 |
| Dune, tunneling | idem | idem | 1930 / 984 | 44 / 1178 | 0 / 1066 | 0 |
| Oppenheimer, **DV P5** | **`OMX.MS.DOLBY_VISION.DVHE.STN.Decoder`** | Dolby Vision `dvhe.05.09` / layer senza dataspace (`UNKNOWN`) | 1039 / 1058 | 416 / 1701 | 7 / 1088 | 0 |
| Il Buono (AVC 1080p) | `OMX.MS.AVC.Decoder` | SDR / `V0_BT709` | 995 / 1371 | 333 / 1249 | 1 / 1055 | 0 |
| Long Test (4K HDR10, GOP 2 s, 44 Mb/s) | `OMX.MS.HEVC.Decoder` | HDR10 (PQ) / `BT2020_ITU_PQ` | 773 / 1325 | a 4:10: **251 / 849** | 4 / 2013 | 0 |
| Long Test, seek al keyframe | idem | idem | 817 / 1335 | 254 / 792 | 4 / 2017 | 0 |

- **Dolby Vision:** Media3 riconosce il DV negli MKV (`dvhe.08.09`, `dvhe.05.09`) e sceglie i decoder DV della TV, non il fallback HEVC. Durante le prove DV il servizio di sistema `DolbyVisionService` registra `isDoViSwitch == 1`. Che il pannello entri davvero in modalità Dolby Vision si vede solo a occhio (verifica del proprietario).
- **DV P5** non dichiara primari né funzione di trasferimento (S1, scoperta 2): il layer non ha dataspace e la conversione IPTPQc2 la fa la pipeline DV della TV.
- **Livelli:** il sample Blade Runner è HEVC livello 6.1 (`hvc1.2.4.L183`), sopra il 5.1 dichiarato dal decoder, e si riproduce lo stesso (9 frame persi su 754 a 60 fps). Gli UHD Blu-ray e il 2001 sono livello 5.1 (`L153`).
- **Rebuffer:** solo con Blade Runner, l'unico sample sopra i 100 Mb/s medi: la rete Wi‑Fi della TV non regge quel bitrate (Q5).
- **Tunneling:** nessun guadagno misurabile su frame persi o avvio, e con il 2001 un seek più lento (1236 ms al primo frame). Non serve attivarlo.

### Q3 — Sottotitoli: PGS e SRT

Media3 rende i PGS e gli SRT incorporati nell'MKV (parsing durante l'estrazione, cue come bitmap o testo). Il ritardo è la posizione del player quando arriva `onCues` meno il PTS del cue; la risoluzione è il frame (42 ms a 23,976 fps, 17 ms a 60 fps).

| Prova | Cue con immagine | Ritardo a regime | Costo |
|---|---|---|---|
| **2001, PGS ita**, 4K HDR10: da 28:00 per 40 s, poi seek a 64:00 per 40 s | 32 sottotitoli (64 eventi con le cancellazioni), bitmap da 151×47 a 976×143 | **mediana 7 ms, 0–20 ms**, un caso a 147 ms (rispetto al PTS del pacchetto nel file, letto con ffprobe) | **1 frame perso su 1862** |
| Blade Runner, PGS ita forced, 4K60 ~100 Mb/s | 8 | 5–16 ms | 3 / 797 (2 rebuffer per la rete) |
| Blade Runner, PGS ita completi | 6, bitmap fino a 891×309 | 0–14 ms | 2 / 724 (3 rebuffer per la rete) |
| Il Buono, PGS, 1080p | 9, fino a 1538×70 | 0–19 ms | 2 / 1365 |
| **2001, SRT eng incorporato** (Direct Play, da 28:00 per 40 s) | 17 cue di testo | **mediana 5 ms, 1–8 ms** | 0 frame persi su 1154 |
| **Il Buono, `.sup` esterno** (`SubtitleConfiguration`, `application/pgs`) | **0**: la traccia è accettata e scelta, ma arrivano solo cue vuoti | — | — |
| Blade Runner via server (Direct Stream, `.sup` `client_render`) | **0**, come sopra | — | — |

- Dopo l'avvio o un seek, i sottotitoli già iniziati prima della posizione compaiono subito (ritardi apparenti di 1,3–4,8 s): è il comportamento corretto.
- **Il `.sup` esterno non funziona in Media3 1.11.** Il `PgsParser` legge le sezioni PGS così come stanno nei blocchi MKV: tipo (1 byte) e lunghezza (2 byte), senza gestire l'intestazione `PG` + PTS + DTS che il `.sup` ha davanti a ogni segmento, e restituisce un solo `CuesWithTiming` senza tempi per chiamata ([`PgsParser.java`, ramo `release`](https://github.com/androidx/media/blob/release/libraries/extractor/src/main/java/androidx/media3/extractor/text/pgs/PgsParser.java)). Misurato: zero cue con immagine, sia dal file statico sia dal server. Era il giudizio del doc 05 §8.10; ora è un fatto (Scoperta 2).

### Q5 — Rete Wi‑Fi a 2,4 GHz

**Profilo di bitrate** (`bitrate.py`, dai pacchetti con ffprobe; finestre mobili, Mb/s):

| File | Tipo | Analizzato | Media | Picco 1 s | 5 s | 30 s | 60 s | 300 s |
|---|---|---|---|---|---|---|---|---|
| **2001** | re-encode x265 | film intero, 148,8 min | **19,6** | **57,4** | **47,3** | **39,6** | 38,4 | 27,4 |
| Long Test | HEVC 4K HDR10 di prova | 5 min | 44,3 | 71,8 | 50,8 | 44,6 | 44,5 | 44,3 |
| Oppenheimer | spezzone di remux | 30 s | 44,2 | 75,3 | 57,8 | 44,2 | — | — |
| Dune | spezzone di remux | 30 s | 34,4 | 53,6 | 42,8 | 34,4 | — | — |
| Il Buono | spezzone di remux 1080p | 30 s | 31,4 | 39,8 | 34,3 | 31,4 | — | — |
| Blade Runner | spezzone di remux 4K60 | 30 s | 99,5 | 102,1 | 101,5 | 99,5 | — | — |
| **Riferimento: UHD Blu-ray reale** (BDInfo di *Black Adam*, playlist intera) | remux | film intero | **67,4** totali, video 58,8 | **154,2** | **81,3** | 10 s: 73,5 | — | — |

- Il riferimento viene da un report BDInfo pubblicato ([forum LibreELEC](https://forum.libreelec.tv/core/attachment/8964-bdinfo-example-2-txt/)): picchi per capitolo, qui il massimo fra i capitoli. Il disco UHD ha una velocità di lettura massima di 92, 123 o 144 Mb/s secondo la capacità ([Wikipedia, Ultra HD Blu-ray](https://en.wikipedia.org/wiki/Ultra_HD_Blu-ray)): un remux UHD sta tipicamente fra 50 e 80 Mb/s medi, con picchi oltre 100.
- **Il punto più denso del 2001** è a 1:49:25: 36,7 Mb/s per 120 s (550 MB). Nel film solo 58 secondi su 8931 superano i 40 Mb/s, e 2 superano i 50.

**Throughput misurato verso la TV** (`NetActivity`: download HTTP Range continuo di un file da nginx sul portatile, 180 s per prova, Mb/s per secondo; prove 4–6 con la banda del portatile registrata ogni 10 s da `net2.sh`):

| Prova | Banda del portatile | Media | Mediana | Minimo 1 s | 5° percentile | Peggiori 5 s | Peggiori 30 s | Peggiori 60 s | Secondi sotto 40 / sotto 20 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 5 GHz | **65,6** | **66,2** | 31,3 | 49,4 | **41,4** | 56,8 | 58,8 | 4 / 0 |
| 2 | 5 GHz, poi **2,4 GHz** dal secondo 99 | 38,9 | 52,8 | 4,2 | 6,3 | 6,7 | — | — | 82 / 81 |
| 3 | 2,4 GHz (presunta: la banda non era registrata) | 7,2 | 7,6 | 0 | 0 | 0 | — | — | 180 / 178 |
| 4 | 5 GHz (19 campioni su 19) | **71,7** | **72,0** | 44,2 | 60,3 | **56,5** | 67,4 | 69,1 | 0 / 0 |
| 5 | 5 GHz (19/19) | **70,1** | **71,3** | 38,1 | 58,2 | **45,8** | 62,1 | 66,7 | 1 / 0 |
| 6 | 5 GHz (19/19) | **70,8** | **71,6** | 3,0 | 62,4 | **44,7** | 66,3 | 68,5 | 2 / 1 |

- **Prova 2 e 3:** il portatile è passato da solo ai 2,4 GHz (un altro BSSID dello stesso router), e da lì i due tratti radio (portatile → router e access point → TV) si contendono la stessa banda: il throughput crolla a circa 8 Mb/s. Il collegamento della TV è rimasto a 144 Mb/s, RSSI −50 dBm, per tutto il tempo. Il caso non rappresenta l'uso reale, dove il server sarà cablato, ma mostra quanto conta il resto della rete.

**Buffer necessario** (`net_model.py`): per un throughput costante T, il buffer che evita ogni stallo è il massimo deficit cumulato del profilo al secondo (consumo meno download, su qualunque intervallo). Va riempito prima, all'avvio o nelle scene più leggere.

| Throughput sostenuto | 22 | 25 | 28 | 30 | 35 | 40 | 50 Mb/s |
|---|---|---|---|---|---|---|---|
| **2001**, buffer necessario | 358 MB | 177 MB | 136 MB | 109 MB | 43 MB | 6 MB | 1 MB |
| in secondi di film (a 19,6 Mb/s) | 146 s | 72 s | 56 s | 45 s | 17 s | 2 s | 0,5 s |

- Con il buffer predefinito di Media3 (circa 144 MB in byte, Q6) il 2001 regge da **27,4 Mb/s** sostenuti in su; con 100 MB da 30,7; con 50 MB da 34,4.
- **Con le tracce reali** delle prove 1, 4, 5 e 6, ripetute in ciclo sul profilo del film intero, il 2001 chiede **0–4 MB** di buffer: nessun rischio. Con la prova 2 (metà del tempo a ~8 Mb/s) ne chiederebbe 299 MB.
- **Un remux UHD reale** chiede in media 60–70 Mb/s per tutto il film (67,4 il riferimento, con 73,5 sui 10 s e 81,3 sui 5 s peggiori). La rete dà 65,6–71,7 medi, ma 56,8–67,4 nei 30 s peggiori e 58,8–69,1 nel minuto peggiore: il margine è di pochi Mb/s, e quando un calo della rete coincide con una scena densa il buffer si svuota per tutta la durata della scena. Blade Runner a ~100 Mb/s va in rebuffer (Q2, Q7) con qualunque buffer.
- **Verdetto Q5:** per le **ricodifiche come il 2001: sì**, con un margine di circa 2 volte sul throughput che serve (27,4 Mb/s col buffer predefinito, misurati 65–72) e senza rebuffer anche nel punto più denso (Q6). Per i **remux UHD: al limite**, solo con un buffer grande (`largeHeap`, 200–300 MiB = 25–38 s a 67 Mb/s) e con il server cablato o a 5 GHz; **no** sopra gli ~80 Mb/s medi. Con il server sui 2,4 GHz (prove 2 e 3) non regge nemmeno il 2001.
- **Se i remux devono andare su questa TV**, le strade possibili (nessuna scelta qui): TV via cavo o a 5 GHz (oggi resta sui 2,4 GHz); buffer grande con `largeHeap`; una soglia di banda nel Decision Engine, con il client che dichiara il throughput misurato e il server che lo confronta con un picco vero su finestra (Scoperta 6), e per il 4K un'altra versione del file o un messaggio chiaro (il Transcode 4K non c'è, P2); lasciare i remux pesanti ai client cablati.

### Q6 — Memoria dell'app

PSS dell'intera app da `Debug.getPss()` ogni 5 s (massimo della prova); byte del buffer = `DefaultAllocator.totalBytesAllocated` (massimo, MiB). Il buffer predefinito di Media3 1.11 è 50 s, con un tetto in byte di 2000 × 64 KiB per il video e 200 × 64 KiB per l'audio, cioè **137,5 MiB** (144 MB), allocati come `byte[]` nello heap Java ([`DefaultLoadControl.java`](https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/DefaultLoadControl.java)).

| Prova | Heap | Buffer | PSS massimo | Buffer allocato | Esito |
|---|---|---|---|---|---|
| 2001 da 28:00, PGS ita | 192 MB | predefinito | **191 MB** | **139 MiB** (tetto in byte) | ok |
| 2001, seek a 2:00:00 | 192 MB | predefinito | 132 MB | 92 MiB | ok |
| 2001 da 50:00 | 192 MB | predefinito | 84 MB | 45 MiB | ok (parte leggera del film) |
| 2001 da 50:00 | 192 MB | 120 s, tetto 400 MB | 88 MB | 48 MiB | ok (parte leggera del film) |
| **2001 da 1:49:25** (punto più denso, 36,7 Mb/s per 120 s) | 192 MB | predefinito | **208 MB** | **139 MiB**, 29–35 s di buffer | ok, 0 rebuffer, 1 frame perso su 2589 |
| **2001 da 1:49:25** | 192 MB | **120 s, tetto 400 MB** | 230 MB | **177 MiB**, poi **`OutOfMemoryError`** | ❌ il caricamento si ferma (`Failed to allocate a 65552 byte allocation … growth limit 201326592`), il player consuma i 35 s di buffer e va in errore `ERROR_CODE_IO_UNSPECIFIED` |
| 2001 da 1:49:25 | 192 MB | 120 s, tetto 150 MiB | 216 MB | 151 MiB (Java heap 164 MB), 32–34 s di buffer | ok, 0 rebuffer, ma con ~25 MB di margine sull'heap |
| Long Test (44 Mb/s) | 192 MB | predefinito | 155 MB | 110 MiB | ok |
| Long Test | 192 MB | tetto 64 MB | 108 MB | 65 MiB | ok |
| Long Test | 192 MB | 120 s, tetto 400 MB | 209 MB | 162 MiB (Java heap 175 MB) | ok solo perché la prova dura 65 s: era vicino al limite |
| Blade Runner (100 Mb/s) | 192 MB | predefinito | 67 MB | 24 MiB | 2 rebuffer (5,3 s): la rete non riempie il buffer |
| **2001 da 1:49:25** | **512 MB** (`largeHeap`) | **120 s, tetto 400 MB** | **418 MB** | **341 MiB** (Java heap 291 MB), **120 s di buffer** raggiunti in ~90 s | ok, 0 rebuffer, nessun intervento del low memory killer nei 100 s |

- **Il buffer predefinito sta nei 192 MB, ma al limite.** Con il film denso il buffer arriva al tetto in byte (139 MiB, 29–35 s) e il PSS a 208 MB; un tetto di 150 MiB lascia circa 25 MB di heap. Oltre, `OutOfMemoryError` nell'allocatore e la riproduzione si ferma quando il buffer finisce: il tetto in byte va sempre messo, anche con `largeHeap`.
- **Con `largeHeap` 120 s di buffer stanno**: 341 MiB per il punto più denso del 2001, PSS 418 MB su 1,06 GB liberi alla sonda (0,69 GB durante le prove). Un film intero con questo buffer non è osservato (Limiti).
- **Quanto buffer serve davvero dipende dalla rete (Q5):** con il throughput della prova 1 bastano pochi MB; il buffer grande serve a reggere i cali, non il bitrate medio.

### Q7 — Attraverso il server Pezzotflix

**Piani del Decision Engine** (stack `pzf-s5`, `StartPlayback` con le capability generate dall'app sulla TV: `q7_api.py`, [`results/q7-plans.json`](S5-tv-client/results/q7-plans.json)). Profilo con lingue audio `ita, eng` e sottotitoli `forced`.

| Item | Con FFmpeg (TrueHD/DTS dichiarati) | Senza FFmpeg (prima build) |
|---|---|---|
| **2001** | **Direct Play**, AC-3 5.1 ita, `video/x-matroska; codecs="hvc1.2.4.L153.B0, ac-3"` | uguale |
| Blade Runner (TrueHD ita) | **Direct Play**, TrueHD, `codecs="hvc1.2.4.L183.B0, mlpa"` | **Direct Stream** HLS fMP4, TrueHD → **FLAC 5.1**; PGS servito a parte come `.sup` (`client_render`) |
| Dune (DV P8.1) | Direct Play, E-AC-3 ita, nessun motivo DV (la TV dichiara `DV8`) | uguale |
| Oppenheimer (DV P5) | Direct Play, FLAC | uguale |
| Il Buono, episodi, trailer | Direct Play | uguale |

- **Locator per un player nativo:** l'URL `/video/media/s/<token>/file` attraverso Caddy risponde `206` con `Content-Range`, `Accept-Ranges: bytes` e `Content-Type: video/x-matroska`, anche sugli ultimi 1024 byte del file da 21,8 GB (`bytes 21829609367-21829610390/21829610391`). Il token nell'URL basta: nessun header necessario.
- `StartPlayback` risponde in 8–34 ms (132 ms per il Direct Stream).

**Riproduzione sulla TV dei locator** (l'app chiama l'API, avvia il player sul locator, manda il progresso ogni 10 s e chiude la sessione; poi seek all'80% della durata o a 0:24):

| Item | FFmpeg | Piano | Decoder | Avvio (ms) | Seek (ms) | Frame persi | Rebuffer |
|---|---|---|---|---|---|---|---|
| **2001** | no | Direct Play progressivo MKV | HEVC + AC-3 in bitstream | 891 / 823 | a 1:59:04: 1156 / 1437 | 0 / 495 | 0 |
| 2001 | sì | idem | idem | 1334 / 1103 | 2030 / 2479 | 0 / 475 | 0 |
| **Blade Runner** | no | **Direct Stream HLS fMP4**, FLAC 5.1 | HEVC + `c2.android.flac.decoder` | 1487 / 456 | 366 / 2182 | 3 / 610 | 2 (7,3 s) |
| Blade Runner | sì | Direct Play, TrueHD | HEVC + FFmpeg TrueHD | 1598 / 815 | 227 / 1586 | 0 / 806 | 1 (3,5 s) |
| Dune | no / sì | Direct Play, E-AC-3 | DV P8 + E-AC-3 in bitstream | 1027 / 948; 791 / 698 | 430 / 1235; 154 / 233 | 0 / 1025; 0 / 1055 | 0 |
| Oppenheimer | sì | Direct Play, FLAC | DV P5 + FLAC | 810 / 762 | 404 / 1612 | 2 / 1079 | 0 |

- **Seek nel Direct Stream:** solo dentro lo spezzone di 30 s di Blade Runner (a 0:24: 366 ms al primo frame, 2182 ms a READY). La posizione riportata da Media3 segue la playlist (24,0 s, poi 27,0 s circa 3 s dopo), mentre i segmenti dichiarano `mediaTimestampOffsetMs` = 10000. Che coincida con la timeline originale non si può vedere senza un riferimento a schermo, e un seek lontano con riavvio della pipeline non è misurato: Long Test, l'unico file lungo con TrueHD, nello stack non è identificato e non è nel catalogo (Limiti).

- **Tracce del piano non applicate.** Per il 2001 il server ha scelto AAC eng e SRT eng, cioè le tracce scelte a mano in una prova precedente via API e ricordate per profilo e item (`lastTrackChoice`, `sessions.ts`). Il player dello spike invece usa la scelta di Media3, che segue il flag `default` del file: AC-3 ita, niente sottotitoli. Il client vero deve imporre a Media3 le tracce del piano (Scoperta 5).
- **Direct Stream HLS fMP4 in Media3: va.** Blade Runner senza FFmpeg parte in 0,5 s al primo frame con il FLAC 5.1 del server. I rebuffer sono quelli del bitrate (~100 Mb/s, Q5). Il `.sup` esterno dello stesso piano non mostra nulla (Q3).

### Q8 — Dolby Vision profilo 7

**Non misurato:** manca ancora un sample P7 (H11, in sospeso con il proprietario). La TV non dichiara un decoder P7 (DVHE.DTB): un remux UHD con DV P7 arriverebbe al massimo come HDR10 del base layer, come già previsto (CLAUDE.md, rischio noto; doc 05 §8.12).

## Scoperte

1. **Il FLAC del server con blocchi da 4608 campioni non passa nel decoder FLAC della TV, su audio reale.** `c2.android.flac.decoder` ha buffer d'ingresso da 32.768 byte, e Media3 non ricava la dimensione massima di un frame FLAC né dall'MKV né dall'MP4 frammentato (non imposta `KEY_MAX_INPUT_SIZE`): un frame più grande dà `InsufficientCapacityException: Buffer too small (32768 < 33242)` e la riproduzione si ferma.
   - Sullo stesso mix reale a 24 bit, con 4608 campioni per blocco (96 ms, il `FLAC_FRAME_SAMPLES` del server in `ffmpeg-args.ts`): **5.1** mediana 33,7 KB, massimo 40,9 KB, 303 frame su 520 sopra i 32 KB; **7.1** mediana 46,9 KB, massimo 57,2 KB, 419 su 520.
   - Una colonna sonora vera fa lo stesso: 20 minuti del 2001 (da 20:00, Danubio blu e dialoghi), con l'AAC 5.1 decodificato e riportato in FLAC 24 bit, danno a 4608 campioni una mediana di 28,5 KB, un massimo di 48,3 KB e **3830 frame su 12.500 (31%) sopra i 32 KB**. È un'approssimazione: una traccia lossless vera ha un rumore di fondo diverso da un AAC decodificato.
   - Con 1152 campioni per blocco (24 ms): mix FATE 5.1 massimo 10,4 KB, 7.1 massimo 14,5 KB; 2001 massimo 12,3 KB. Anche un blocco 7.1 a 24 bit non compresso (1152 × 8 × 3 = 27.648 byte più le intestazioni) resta sotto i 32 KB.
   - I sample di prova delle fixture non lo mostrano: Oppenheimer (FLAC 5.1 24 bit) ha frame da 2,3 KB, il TrueHD di Blade Runner convertito in FLAC 2,6 KB, il rumore rosa 11,6 KB. Per questo il Direct Stream di Blade Runner via server è andato (Q7).
   - **Misurato sulla TV** (`flac-blocchi.mkv` e `.mp4`, Q1): con 4608 campioni 5.1 e 7.1 si fermano in entrambi i container; con 1152 campioni 5.1 e **7.1** vanno in entrambi. Il MP4 frammentato usa lo stesso estrattore dei segmenti HLS fMP4 del Direct Stream.
2. **Il `.sup` esterno non si vede in Media3 1.11** (Q3): zero cue, dal file e dal server. Oggi l'ADR 0008 manda i PGS dei remux con TrueHD/DTS-HD in Direct Stream proprio come `.sup` esterno (`client_render`), quindi su questa TV i sottotitoli PGS di quei film non apparirebbero.
3. **Il "passthrough" della TV è il suo decoder Dolby.** AC-3, E-AC-3 e JOC escono compressi su un'uscita `DIRECT|COMPRESS_OFFLOAD`; tutto il resto (AAC, FLAC, PCM, e TrueHD/DTS decodificati) diventa PCM a 6–8 canali e poi **stereo nel mixer di Android**. Fra AAC 5.1 ed E-AC-3 5.1 cambia quindi chi fa il downmix e con quale elaborazione: lo decide l'orecchio (coppia d'ascolto dell'ADR 0008).
4. **Il decoder DTS della TV esiste ma le app non lo vedono.** `OMX.MS.DTS.Decoder` è dichiarato nel `media_codecs.xml` anche con `audio/vnd.dts` e `audio/vnd.dts.hd`, ma non è in `MediaCodecList(ALL_CODECS)` (come LPCM, WMA, RealAudio, DRA, AVS, AVS2, RV). Le capability vanno lette da `MediaCodecList`, mai dal file XML del vendor.
5. **Media3 non sa delle tracce scelte dal server.** In Direct Play il player apre il file intero e sceglie da sé (flag `default` e lingua di sistema): nel 2001 ha suonato l'AC-3 ita mentre il piano diceva AAC eng con SRT eng. Il client deve tradurre le tracce del piano in un `TrackSelectionOverride` di Media3, abbinando l'indice o l'id del server alla traccia del container. Il caso di prova è anche la spiegazione di un sospetto del primo giro: l'SRT eng al posto del PGS ita non era un errore del motore, ma la scelta ricordata per profilo e item (`lastTrackChoice`).
6. **`stream.bitrate.peakBps` di un Direct Play progressivo è la media del file.** Per il 2001 il server dichiara 19,55 Mb/s di picco, mentre il picco su 1 s è 57,4 Mb/s e su 30 s 39,6 Mb/s (Q5). Una regola di banda che lo usasse sottostimerebbe il rischio di 2–3 volte.
7. **Sistema a 32 bit con heap da 192 MB.** Il buffer predefinito di Media3 (137,5 MiB in `byte[]` nello heap Java) ci sta, al limite: nel punto più denso del 2001 l'app sale a 208 MB di PSS con 139 MiB di buffer. Un buffer da 120 s con tetto 400 MB va in `OutOfMemoryError` a 177 MiB con l'heap da 192 MB, e sta (341 MiB, PSS 418 MB) con `largeHeap` (Q6).
8. **Nessun modo a 24 Hz.** Il display espone all'app solo 1080p a 60 e 50 Hz: un 23,976 fps va su 60 Hz con cadenza 3:2, a meno che la TV non lo gestisca da sé (verifica del proprietario).
9. **Il secondo tratto radio conta più della TV.** Con il portatile a 5 GHz la TV a 2,4 GHz regge 65,6–71,7 Mb/s medi su quattro prove da 3 minuti (41,4–56,5 nei 5 s peggiori, 56,8–67,4 nei 30 s peggiori). Quando il portatile passa da solo ai 2,4 GHz il throughput scende a 7–8 Mb/s con secondi a zero, mentre il collegamento della TV resta a 144 Mb/s. Il server va cablato o almeno a 5 GHz.
10. **La TV va in standby da sola:** è successo una volta in circa due ore di prove (~13 minuti persi), con ADB caduto; dai log non si distingue se fra due prove o durante una. Il client deve tenere lo schermo acceso mentre riproduce (`keepScreenOn` della superficie del player).
11. **Una POST vuota di `HttpURLConnection` viene rifiutata.** Android aggiunge `Content-Type: application/x-www-form-urlencoded`, e il server risponde `415`. Con `{}` va. Il client generato (Retrofit/OkHttp, K1) va controllato sulle POST senza corpo, per esempio `SelectProfile`.
12. **Livello HEVC e tunneling:** un HEVC livello 6.1 va su un decoder che dichiara il 5.1; il tunneling non migliora nulla (Q2).
13. **Estensione FFmpeg:** l'AAR della community (GPL‑3.0) compilato per Media3 1.9.0 funziona con la 1.11.1 e decodifica TrueHD (anche Atmos, come letto 7.1), DTS e DTS-HD MA. Resta un'opzione, fuori dalla prima build.

## Limiti

- **Niente verifiche a occhio e a orecchio:** modalità HDR/Dolby Vision del pannello, judder dei 24p, qualità del downmix, sincronia labiale. Sono nelle verifiche del proprietario.
- **Server in Wi‑Fi:** il portatile fa da server in Wi‑Fi, quindi la rete misurata ha due tratti radio. Con un server cablato resta solo il tratto della TV; la prova 1 (portatile a 5 GHz) è la più vicina a quel caso. Le misure sono di una notte (01:40–02:40), con poca interferenza attesa: di giorno può andare peggio.
- **Sample audio:** il TrueHD 5.1 è codificato da ffmpeg (niente 7.1); TrueHD Atmos, DTS-HD MA ed E-AC-3 JOC sono spezzoni FATE da 12–25 s, non tracce di un film intero. Il FLAC "reale" è il mix FATE ripetuto: la dimensione dei frame dipende dal contenuto, e una colonna sonora vera può stare sopra o sotto.
- **FLAC 7.1 in Direct Stream attraverso lo stack:** non fatto. La libreria di prova non ha un file con audio lossless 7.1, e `media-samples/` è in sola lettura. Sostituito dal MP4 frammentato servito da nginx, che usa lo stesso estrattore di Media3 dei segmenti HLS fMP4.
- **E-AC-3 copiato in fMP4 con `delay_moov`:** non esercitato, perché nessun piano lo produce con queste capability (l'E-AC-3 va in Direct Play).
- **Direct Stream lungo:** l'unico Direct Stream via server è lo spezzone di 30 s di Blade Runner. Un seek lontano con riavvio della pipeline e la coincidenza della posizione di Media3 con la timeline originale (doc 05 §8.13, domanda 9) restano da misurare con un film intero in Direct Stream.
- **Memoria:** prove di 1–3 minuti; il low memory killer su un film intero non è osservato. Le istantanee di `dumpsys meminfo` sono prese a tempo fisso, a volte dopo che un seek ha svuotato il buffer: fa fede il PSS registrato dall'app ogni 5 s.
- **Dolby Vision P7 e HDR10+:** nessun sample.
- **AAC in offload:** la policy audio accetta AAC anche sull'uscita compressa, che Media3 userebbe con `AudioOffloadPreferences`. Non provato: non è una capability da dichiarare, e l'ADR 0008 esclude preferenze audio nascoste nel client.
- **FFmpeg nelle prove:** la preferenza FFmpeg dell'app è rimasta spenta dopo il gruppo `q7`, quindi le prove di memoria di Long Test e Blade Runner hanno scelto l'E-AC-3 eng o l'AC-3 2.0 del commento al posto del TrueHD. Non cambia la memoria, che è quasi tutta video.

## Conclusioni e raccomandazioni

### Verdetti

| Ipotesi o domanda | Esito |
|---|---|
| **H5** — il device fa passthrough TrueHD/DTS-HD verso l'AVR, o almeno li decodifica in PCM | ❌ **per la prima build.** Il passthrough non esiste: l'uscita Speaker e l'ARC accettano solo AC-3, E-AC-3 e JOC; senza un impianto esterno, del resto, non servirebbe. La decodifica in PCM non c'è con i decoder della piattaforma (nessun TrueHD; il DTS del vendor non è visibile alle app). ✅ solo con l'estensione FFmpeg, che l'ADR 0008 lascia fuori. La strada dell'ADR, FLAC dal server, è ⚠️: funziona solo con frame FLAC sotto i 32 KB (Scoperta 1) |
| Q1 — AC-3 ed E-AC-3 arrivano al decoder Dolby della TV, non come PCM? (doc 05 §8.13, domanda 2) | ✅ bitstream su uscita `COMPRESS_OFFLOAD`, 6 canali (8 per il JOC). La sincronia labiale resta da sentire |
| Q1 — AAC 5.1, FLAC, PCM sugli altoparlanti | ✅ decodificati sulla TV, poi **stereo nel mixer di Android** |
| Q2 — Direct Play via HTTP Range (domanda 1) | ✅ 2001: avvio ~1 s, seek a 2 h in 0,8 s al primo frame, 0 frame persi su 933; DV P5 e P8.1 sui decoder Dolby Vision |
| Q3 — PGS incorporati (domanda 3) | ✅ ritardo mediano 7 ms, 1 frame perso su 1862 nel 4K HDR10 |
| Q3 — `.sup` esterno (domanda 10) | ❌ Media3 1.11 non lo rende (zero cue) |
| Q4 — capability e JSON | ✅ (sopra); `flac` e `pgs` vanno precisati |
| Q5 — rete Wi‑Fi a 2,4 GHz (TV a 144 Mb/s di collegamento) | ✅ **ricodifiche come il 2001**: servono ~27 Mb/s sostenuti col buffer predefinito, misurati 65,6–71,7 medi e 41–57 nei 5 s peggiori, nessun rebuffer nel punto più denso. ⚠️ **remux UHD (~67 Mb/s medi)**: al limite, solo con buffer grande (`largeHeap`, 200–300 MiB) e server cablato o a 5 GHz, perché i 30 s peggiori della rete (56,8–67,4) stanno sotto la media del file. ❌ **remux da ~100 Mb/s** (Blade Runner): rebuffer con qualunque buffer. ❌ con il server sui 2,4 GHz: 7–8 Mb/s |
| Q6 — memoria (domanda 6) | ⚠️ il buffer predefinito sta nei 192 MB ma al limite (PSS 208 MB nel punto più denso del 2001); 120 s / 400 MB vanno in `OutOfMemoryError` senza `largeHeap` e stanno con `largeHeap` (341 MiB, PSS 418 MB). Il low memory killer su un film intero non è osservato |
| Q7 — attraverso il server (domanda 9) | ✅ 2001 in Direct Play dal locator con Range attraverso Caddy; ✅ Direct Stream HLS fMP4 riprodotto da Media3; ⚠️ le tracce del piano vanno imposte a Media3 (Scoperta 5) |
| Q8 — DV P7 (domanda 12) | non misurato: manca un sample; nessun decoder P7 |

### Ricodifiche contro remux: cosa cambia

La libreria reale sarà fatta soprattutto di ricodifiche come il 2001. Per quei file le conclusioni sono quasi tutte positive; i problemi aperti si concentrano sui remux.

| Tema | Ricodifica tipica (2001: x265, ~20 Mb/s, AC-3/AAC, PGS) | Remux UHD (60–80 Mb/s medi, picchi oltre 100, TrueHD/DTS-HD, PGS) |
|---|---|---|
| Piano | Direct Play, nessun lavoro del server | Direct Play se l'audio è Dolby; altrimenti Direct Stream FLAC |
| Audio | AC-3 in bitstream al decoder Dolby, AAC decodificato sulla TV | TrueHD/DTS-HD → FLAC dal server: ⚠️ blocchi da ridurre (Scoperta 1) |
| Sottotitoli PGS | incorporati, resi da Media3 | in Direct Stream diventano `.sup` esterno: ❌ (Scoperta 2) |
| Rete a 2,4 GHz | ✅ margine di circa 2 volte (27,4 Mb/s richiesti, 65–72 misurati), con il server a 5 GHz o cablato | ⚠️ 67 Mb/s medi contro 56,8–67,4 nei 30 s peggiori: solo con buffer grande; ❌ sopra gli ~80 Mb/s medi |
| Memoria | il buffer predefinito (137,5 MiB) vale 50 s alla media (tetto in tempo) e ~31 s nel punto più denso: sta nei 192 MB | 137,5 MiB valgono ~17 s a 67 Mb/s e ~11 s a 100: un buffer più lungo chiede `largeHeap` |
| Dolby Vision | il 2001 è HDR10; DV P5/P8.1 vanno | P7 senza decoder (Q8) |

### Raccomandazioni (input per gli ADR e i documenti, nessuna scelta)

**ADR 0008 e doc 05 §8.9–8.10 (client TV):**
1. **FLAC di ripiego.** Così com'è, il FLAC del server con blocchi da 4608 campioni si ferma sulla TV con audio reale (Scoperta 1). Opzioni, da misurare prima di scegliere:
   - (a) blocchi da **1152 campioni** nel server (`FLAC_FRAME_SAMPLES`, ADR 0003): un frame 7.1 a 24 bit resta sotto i 32 KB per costruzione. **Misurato: va sulla TV, 5.1 e 7.1, in MKV e in MP4 frammentato** (Q1). Va riverificato nei browser di S2, e costa intestazioni di frame 4 volte più frequenti;
   - (b) nel client, una sottoclasse di `MediaCodecAudioRenderer` che alzi `getCodecMaxInputSize` (metodo `protected` in Media3 1.11) per il FLAC: non misurato se `c2.android.flac.decoder` rispetta `KEY_MAX_INPUT_SIZE`;
   - (c) un decoder FLAC nel client (estensione FFmpeg o libflac di Media3), che l'ADR 0008 oggi non prevede.
2. **PGS dei Direct Stream.** Il `.sup` esterno non funziona in Media3 (Scoperta 2). Opzioni:
   - (a) il piccolo parser del doc 05 §8.10, che divide il `.sup` in display set con i loro tempi e li passa al `PgsParser`: solo client;
   - (b) un overlay proprio sincronizzato con la posizione, come libpgs nel web: solo client;
   - (c) per i client nativi, un Direct Stream in un container che porti il PGS incorporato (MKV progressivo): cambia server e contratto.
3. **Tracce del piano:** il client impone a Media3 le tracce scelte dal server con `TrackSelectionOverride` (Scoperta 5), anche in Direct Play.
4. **Buffer:** il tetto in byte va sempre impostato, e con `largeHeap` (Q6). Dati per scegliere il valore (doc 05 §8.10 parte da 100 MiB):
   - 100 MiB = 43 s del 2001 alla media, 23 s nel punto più denso, 13 s a 67 Mb/s; il 2001 regge da 30,3 Mb/s sostenuti in su. Sta anche senza `largeHeap`;
   - 200 MiB: 2001 da 23,5 Mb/s in su; 300 MiB: da 22,2 Mb/s. Costano 300–420 MB di PSS su una TV con 0,7–1 GB liberi;
   - oltre i 50 s di Media3 il tetto in tempo va alzato insieme a quello in byte (`setBufferDurationsMs`), altrimenti il byte in più non si usa;
   - per un remux sopra la banda disponibile nessun buffer basta: il deficit cresce per tutta la scena (Q5).
5. **Schermo acceso** durante la riproduzione (Scoperta 10); **POST senza corpo** verificate nel client generato (Scoperta 11).
6. **Capability:** lette da `MediaCodecList(ALL_CODECS)` e `AudioCapabilities`, mai dal `media_codecs.xml`; una voce video per fascia di risoluzione; JSON di Q4 come fixture (`raw-caps.json`).

**Doc 03 §4.1 (contratto):**
- `stream.bitrate.peakBps` di un Direct Play è oggi la media del file (Scoperta 6). Un picco vero su una finestra (5 o 30 s) richiede una scansione dei pacchetti: per il 2001 (21,8 GB) ffprobe ci mette 26 s sul disco locale del portatile. Da valutare all'ingest, insieme al profilo di bitrate.
- `subtitles.image` non distingue fra immagini incorporate e `.sup` esterno: per questo client le prime vanno, il secondo no. Una capability o un override (I2) deve dirlo al Decision Engine.

**Doc 04:**
- **§10, H5:** ❌ per la prima build (verdetto sopra), con il rimando alla strada FLAC e alle sue condizioni.
- **§4.3, punto 3:** il FLAC multicanale dal server vale per i player nativi solo con frame piccoli (opzione 1a), oppure con la verifica del client (1b).
- **§4.3 e §5:** sulla TV senza impianto il passthrough è il decoder Dolby della TV, e tutto il PCM arriva stereo dal mixer di Android: `audio[].maxChannels` dice cosa decodifica il client, non i canali che si sentono (come già per il browser).
- **§4.4:** nella riga PGS, "pass-through (Media3 supporta PGS)" vale solo per i PGS incorporati; il `.sup` esterno no.
- **§4.5:** misura su questa casa: TV a 2,4 GHz (144 Mb/s di collegamento) e server a 5 GHz danno **65,6–71,7 Mb/s medi**, 41–57 nei 5 s peggiori, 56,8–67,4 nei 30 s peggiori. Bastano per le ricodifiche, sono al limite per un remux UHD medio e non bastano oltre gli ~80 Mb/s. Il "bitrate max" dichiarato dal client va confrontato con un picco del file su finestra (5–30 s), non con la media (Scoperta 6), e il buffer del client nativo (Q6) è il secondo termine del confronto. Se il server finisce sui 2,4 GHz il throughput crolla a 7–8 Mb/s: il secondo tratto radio va escluso (server cablato).
- **§5 (Android TV):** il decoder DTS del vendor non è in `MediaCodecList(ALL_CODECS)`: le capability si leggono da lì.

**Profilo del Decision Engine per questa TV (override I2):** nessun override serve per le capability, se il client dichiara quelle misurate. Restano due politiche possibili, da decidere con i dati: la conversione AAC 5.1 → E-AC-3 se l'ascolto la preferisce (ADR 0008, politica del server), e una soglia di bitrate per i remux sul Wi‑Fi (§4.5).

### Verifiche fisiche del proprietario

Tutte con l'app **"Pezzotflix S5 sonda"** (pacchetto `dev.pezzotflix.s5probe`), lasciata installata sulla TV: menu → "Sample diretti". Serve il server dei file sul portatile (`bash spikes/s5-tv-client/serve.sh`, porta 18381). Nel player: ▲ cambia traccia audio, ▼ i sottotitoli, ◀ ▶ salti, OK pausa; l'overlay mostra traccia, decoder e uscita audio.

1. **Coppia d'ascolto dell'ADR 0008** — "Ascolto 2001": traccia 1 AAC 5.1 decodificato dalla TV, traccia 2 E-AC-3 5.1 a 640 kb/s convertito dallo stesso AAC come farebbe il server, traccia 3 AC-3 ita originale come riferimento. Dialoghi chiari? Musica (Danubio blu) più ampia con l'una o l'altra? Decide se serve la politica Dolby del server.
2. **Sincronia labiale** sull'AC-3 in bitstream (2001, scene di dialogo da 28:00) e sull'AAC.
3. **Immagine HDR10** sul 2001 e **Dolby Vision** su Dune (P8.1) e Oppenheimer (P5): la TV mostra il logo o la modalità Dolby Vision? Colori corretti, niente immagine slavata o violacea su P5?
4. **Fluidità a 23,976 fps** (2001, carrellate lente): scatti regolari (judder 3:2)? Se sì, si guarda nelle impostazioni della TV (movimento, modalità film).
5. **Canali:** "Prova canali 5.1" e "7.1", ogni codec: si sentono tutti i canali annunciati a schermo (il centro dal centro della barra, i surround mixati)?
6. **Confronto opzionale** "TrueHD / E-AC-3 / FLAC / DTS-HD MA" con il decoder FFmpeg acceso: interessa solo se un giorno si vuole l'estensione.
7. **PGS ita** sul 2001: dimensione, posizione e nitidezza dei sottotitoli in 4K.
