# S3 — Latenza e costo di remux e transcode

- **Stato:** Completato (2026-10-01); H10 rimisurata il 2026-11-04
- **Domanda:** quanto costa, in tempo di avvio, seek e risorse, servire un remux UHD in Direct Stream o in Transcode?
- **Alimenta:** doc 04 H8, H9 (e nuova H10), decisione P2; ADR su motore di streaming e accelerazione hardware
- **Codice:** `spikes/s3-stream-latency/` (`make_long_source.sh`, `measure.py`), throwaway

## Setup

- **Host:** Windows 11, AMD Ryzen 5 3600X (6C/12T), 16 GB RAM, NVIDIA RTX 3060 Ti, SSD. ffmpeg 7.0 (gyan.dev full build). Misure **sull'host, non in Docker** (vedi limiti).
- **Sorgente realistica:** 5 min, 4K HEVC Main10 HDR10, 44 Mbps medi, **GOP 2 s** (come i remux reali; i sample Jellyfin hanno keyframe ogni 0,2 s e falserebbero il seek), TrueHD 5.1 + E-AC3 5.1.
- **Contenuto a 60 fps.** I film sono quasi tutti a 23,976 fps: per il tempo reale di un film bastano **24 fps**. Le colonne "× film 24p" riportano la capacità per quel caso.
- **Streaming di prova:** HLS con segmenti fMP4 da 6 s, video copiato. È solo lo strumento di misura, non una scelta: il protocollo si decide negli ADR.

## Risultati

### M1 — Avvio del Direct Stream (remux on-the-fly, video copiato)

Tempo dall'avvio del processo al primo segmento, e a tre segmenti (18 s di buffer), per offset di seek 0 / 150 / 283 s:

| Audio | 1° segmento | 3 segmenti |
|---|---|---|
| copia (TrueHD) | 0,17–0,24 s | 0,41–0,69 s |
| → FLAC | 0,17–0,19 s | 0,45–0,48 s |
| → E-AC3 640k | 0,16–0,17 s | 0,40–0,41 s |
| → AAC stereo | 0,24–0,25 s | 0,64–0,94 s |

**Il tempo non dipende dall'offset**: il seek nell'MKV usa l'indice dei cue. **H8 confermata con ampio margine** (obiettivo < 2–3 s, misurato < 1 s lato server).

### M2 — Throughput del remux

| Operazione | 5 min di contenuto | Velocità |
|---|---|---|
| Remux completo, video copiato + audio → FLAC | 5,5 s | **54× tempo reale** |
| Solo audio TrueHD → E-AC3 | 3,2 s | 94× tempo reale |

Il Direct Stream ha un **costo trascurabile**: un film di 2 h verrebbe rimpacchettato per intero in circa 2 minuti. Tre sessioni in Direct Stream non sono un problema di risorse.

### M3 — Precisione del seek e timeline

- Con video copiato il flusso può iniziare solo da un keyframe. Richiesto 150 s, lo stream parte da **148,0 s** (keyframe precedente, GOP 2 s).
- Con `-copyts` i timestamp restano **nella timeline originale** (148,0; 148,067…). L'invariante del doc 04 §6.1 è realizzabile.
- **Conseguenza:** il seek fine (148 → 150) lo fa il player dentro il primo segmento. La posizione di resume resta esatta; lo stream no, di al massimo un GOP.

### M4 — Transcode (20 s di contenuto 4K HEVC 10-bit HDR10)

| Pipeline | fps | × film 24p |
|---|---|---|
| Solo decodifica, software | 106 | 4,4× |
| Solo decodifica, CUDA | 384 | 16× |
| **Software**: decodifica + tone-mapping (zscale/hable) + x264 veryfast → 1080p SDR | **14** | **0,6× ❌** |
| Decodifica SW + tone-mapping libplacebo (Vulkan) + h264_nvenc → 1080p SDR | 67 | 2,8× ✅ |
| Decodifica CUDA + libplacebo (Vulkan) + h264_nvenc → 1080p SDR | 84 | 3,5× ✅ |
| Decodifica CUDA + scale_cuda + hevc_nvenc → 1080p **HDR mantenuto** | 120 | 5× ✅ |
| **Burn-in PGS 4K HDR** (overlay su CPU) + hevc_nvenc 4K 10-bit | 21–23 | **≈0,9× ⚠️** |

Osservazioni:
- **Il transcode 4K → 1080p con tone-mapping in software non è in tempo reale** su questa CPU, nemmeno per un film a 24 fps. Con la GPU lo è, con margine per 2–3 sessioni.
- Il **burn-in PGS su 4K** è al limite anche con encoder GPU: il collo di bottiglia è l'overlay su CPU di frame 4K a 10 bit. Si ottimizza con overlay su GPU o downscale prima del burn-in, ma resta la trasformazione più costosa. Questo **rafforza P3** (PGS resi dal client).
- **Insidia:** decodifica CUDA + filtro Vulkan senza device esplicito → **crash di ffmpeg** (segfault, exit 139). Serve `-init_hw_device vulkan=vk -filter_hw_device vk`. Le pipeline hardware vanno testate combinazione per combinazione.

## Limiti della misura

- **Solo host Windows.** Non misurati: overhead di Docker Desktop/WSL2, I/O dei bind mount NTFS (per 100 Mbps servono circa 12,5 MB/s, dovrebbero bastare) e soprattutto **disponibilità di GPU/NVENC/Vulkan dentro un container su WSL2** → nuova ipotesi **H10**.
- **Hardware attuale ≠ hardware futuro:** il mini-PC/server Linux potrebbe avere solo una GPU Intel (Quick Sync/VAAPI) o nessuna. L'accelerazione deve essere un **backend sostituibile**, non un'assunzione.
- La latenza end-to-end percepita dal client (rete + buffer del player) si misura in S2.

## H10 — GPU e I/O dentro Docker Desktop (WSL2)

Script: `spikes/s3-stream-latency/h10_docker.sh`. Immagine `lscr.io/linuxserver/ffmpeg` (ffmpeg 9.0; controprova con 8.1.2). Media montati **read-only** dal disco NTFS.

| Prova | Esito |
|---|---|
| GPU visibile nel container (`--gpus all`, `nvidia-smi`) | ✅ RTX 3060 Ti, driver 596.49 |
| Avvio del container | circa 2 s |
| **I/O**: remux completo del file da 5 min (1,66 GB) dal bind mount NTFS | 35 s → **circa 47 MB/s (~380 Mbps)**. Sull'host 5,5 s (circa 300 MB/s) |
| CUDA decode / NVENC / scale_cuda | ❌ `cuInit(0) failed -> CUDA_ERROR_NOT_FOUND: named symbol not found`, identico con ffmpeg 9.0 e 8.1.2 |
| libplacebo (Vulkan) nel container | ❌ nessun output utile (Vulkan non esposto) |

**Diagnosi:** il problema è l'ambiente, non ffmpeg. WSL **2.0.14** (kernel 5.15) e Docker Desktop **25.0.3** risalgono a fine 2023 / inizio 2024, mentre il driver NVIDIA è **596** (2026). Lo shim CUDA di WSL non espone i simboli che si aspettano le librerie recenti. **H10 non verificata:** va ripetuta dopo `wsl --update` e l'aggiornamento di Docker Desktop.

**I/O:** 380 Mbps bastano per un Direct Play UHD (picchi circa 100–130 Mbps), ma con **poco margine** per 3 sessioni UHD più una scansione. Su Docker Desktop per Windows il bind mount NTFS diventa un vincolo reale. Mitigazioni da valutare nell'ADR di deploy:
- servire i byte del Direct Play da un processo sull'host o dal gateway;
- tenere i media sul filesystem WSL;
- evitarlo con il futuro server Linux, dove il problema non esiste.

### H10 — Seconda prova dopo l'aggiornamento (2026-11-04)

- **Ambiente:** WSL **3.0.3** (kernel 6.18), Docker Desktop **4.98.0** (engine 29.9.2), driver NVIDIA **596.49**, 26 GB liberi su C:.
- **Script:** `spikes/s3-stream-latency/h10_docker_v2.sh`. Ogni prova salva lo stderr completo in `out/h10v2/<id>.r<n>.log`, il riepilogo è in `out/h10v2/summary.tsv`, l'ambiente in `out/h10v2/env.txt`. Ogni prova è ripetuta 2 volte.
- **Sorgente:** clip di 20 s (1200 frame a 60 fps) dal file da 5 min usato sopra, letta da un **volume Docker** (ext4 nella VM WSL) per separare il costo GPU dall'I/O. Una prova è ripetuta dal bind mount NTFS.
- **Immagini:**
  - `lscr.io/linuxserver/ffmpeg:latest` (**9.0.2**);
  - `lscr.io/linuxserver/ffmpeg:8.1.2`;
  - `jellyfin/jellyfin:latest`, con **jellyfin-ffmpeg 8.1.3**.
- **fps:** valore riportato da ffmpeg (`-stats`).
- **Prima prova della giornata, scartata:** il disco C: era quasi pieno (2 GB liberi) e tutti i tempi risultavano gonfiati. La causa precisa non è stata isolata e quei numeri non vanno usati. Per la stessa ragione l'output `out/h10-rerun.txt` è superato.

#### Funzionalità nel container

| Prova | Esito | Evidenza |
|---|---|---|
| Decodifica CUDA (ffmpeg 9.0.2, 8.1.2, jellyfin 8.1.3) | ✅ | 373–397 fps |
| NVENC con ffmpeg **9.0.2** | ❌ | `Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0` e `The minimum required Nvidia driver for nvenc is 610.00 or newer` |
| NVENC con ffmpeg **8.1.2** e **jellyfin 8.1.3** | ✅ | `scale_cuda` + `hevc_nvenc`, rc=0 |
| `tonemap_cuda` (HDR10 → SDR) | ✅ in jellyfin-ffmpeg | Nell'elenco `-filters` compare **solo** nell'immagine jellyfin; linuxserver 9.0.2 e 8.1.2 hanno `tonemap_opencl`, `tonemap_vaapi`, `libplacebo` ma non `tonemap_cuda` |
| Vulkan (per `libplacebo`) | ❌ | Unico device visibile: `llvmpipe (LLVM 21.1.8) (software)`. Nel container ci sono `libcuda`, `libnvcuvid`, `libnvidia-encode` ma nessun ICD Vulkan NVIDIA |
| OpenCL (`tonemap_opencl`) | ❌ | `No such device` (prima prova, non ripetuta) |

#### Prestazioni (2 ripetizioni, fps riportati da ffmpeg)

| Pipeline (clip 4K HEVC Main10 HDR10, 20 s) | fps | × film 24p |
|---|---|---|
| Container, solo decodifica CUDA | 373–397 | 16× |
| Container, CUDA + `scale_cuda` + `hevc_nvenc` 1080p HDR (ffmpeg 8.1.2) | 129–130 | 5,4× |
| come sopra, sorgente dal **bind mount NTFS** | 129–130 | 5,4× |
| Container, CUDA + `scale_cuda` + `hevc_nvenc` (jellyfin 8.1.3) | 151–154 | 6,3× |
| Container, CUDA + **`tonemap_cuda`** + `h264_nvenc` 1080p **SDR** (jellyfin) | **106–107** | **4,4× ✅** |
| Container, solo `tonemap_cuda` (senza encoder) | 108–114 | 4,6× |
| **Host Windows**, CUDA + `scale_cuda` + `hevc_nvenc` (ffmpeg 7.0), stessa clip, stessa sessione | 292–299 | 12× |

- Il transcode 4K HDR → 1080p SDR **interamente su GPU nel container** va a **circa 4,4× il tempo reale di un film a 24p**, quindi c'è margine teorico per 3 sessioni. Il collo di bottiglia è `tonemap_cuda`, non l'encoder.
- **Overhead WSL/GPU:** a parità di pipeline il container fa circa **la metà degli fps** dell'host (130–154 contro 292–299). È il costo della GPU paravirtualizzata di WSL e non riguarderà il server Linux nativo.
- **Nota sul confronto con M4:** i 120 fps di M4 per la stessa pipeline sull'host erano calcolati come contenuto/tempo totale del processo (avvio e seek compresi) e misurati in un'altra sessione. Il confronto valido è quello host/container fatto nella stessa sessione, riportato qui.

#### I/O (file da 5 min, 1,66 GB, 2 ripetizioni)

| Prova | Tempo | Throughput |
|---|---|---|
| Lettura sequenziale (`cat`) dal **bind mount NTFS** | 24,7–27,9 s | **circa 60–67 MB/s (circa 500 Mbps)** |
| Lettura sequenziale dal **volume Docker** | 0,93 s | probabilmente in cache nella VM: non è una misura del disco |
| Remux completo (copy) dal bind mount | 33,4–34,3 s | circa 9× il tempo reale |
| Remux completo (copy) dal volume | 6,1–6,4 s | circa 56–59× il tempo reale (come sull'host) |

- Il bind mount NTFS regge circa 500 Mbps: bastano per 3 Direct Play UHD (picchi di 100–130 Mbps ciascuno), con poco margine se nel frattempo gira una scansione. Resta valida la raccomandazione per l'ADR di deploy (sopra).
- Per un clip che si legge a circa 44 Mbps il bind mount **non** limita il transcode: stessi fps da volume e da bind mount.

**Scoperte:**
- **La versione di ffmpeg va abbinata al driver.** ffmpeg 9.0 richiede l'API NVENC 13.1 (driver ≥ 610, dal messaggio di ffmpeg stesso), il driver 596 espone la 13.0. Il backend di accelerazione dovrà fare all'avvio un **probe delle capability reali** (encoder, filtri, device) invece di dedurle dalla presenza di una GPU.
- **Su Docker Desktop/WSL2 l'unica catena di tone-mapping su GPU funzionante è CUDA** (`tonemap_cuda`), disponibile in jellyfin-ffmpeg ma non nelle build linuxserver provate. Vulkan/libplacebo e OpenCL non sono esposti. Sul server Linux nativo vanno verificati Vulkan, VAAPI/QSV o CUDA, in base alla GPU.

**Stato H10:**
- ✅ **Confermata per CUDA e NVENC** (con ffmpeg 8.x) e per il tone-mapping CUDA, a 4,4× il tempo reale per un film 24p.
- ❌ **Smentita per Vulkan/libplacebo e OpenCL** su WSL2.

## Conclusioni e raccomandazioni

1. ✅ **Direct Stream:** avvio sotto il secondo, seek indipendente dalla posizione, costo trascurabile. È la modalità di default per il browser.
2. ✅ **Timeline originale** realizzabile; il seek del server è granulare al GOP e il player completa il seek fine.
3. ❌ **"Transcode minimo software" (decisione P2) non è sufficiente per contenuti 4K HDR** su questo PC: il caso più probabile (4K HDR → client SDR/1080p) non è in tempo reale. **P2 va rivista**:
   - (a) MVP con transcode GPU;
   - (b) MVP con transcode software limitato alle sorgenti 1080p, 4K solo in Direct Play/Direct Stream;
   - (c) transcode fuori dall'MVP.
   - → Scelta l'opzione **(b)** il 2026-11-04 (doc 04 §11, P2).
4. ⚠️ **Burn-in 4K** da evitare: PGS resi dal client (P3); se non evitabile, downscale a 1080p prima del burn-in.
5. ✅/❌ **H10** (rimisurata il 2026-11-04):
   - in un container Docker Desktop su WSL2 funzionano CUDA, NVENC (ffmpeg 8.x) e `tonemap_cuda` (jellyfin-ffmpeg): il 4K HDR → 1080p SDR su GPU va a circa 4,4× il tempo reale per un film 24p;
   - Vulkan/libplacebo e OpenCL non funzionano.
   - L'ADR sull'accelerazione hardware deve prevedere:
     - un backend sostituibile (CUDA oggi, VAAPI/QSV/Vulkan sul server);
     - una build di ffmpeg abbinata al driver;
     - un probe delle capability all'avvio.
