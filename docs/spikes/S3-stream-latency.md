# S3 — Latenza e costo di remux e transcode

- **Stato:** Completato (2026-10-01)
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

## Conclusioni e raccomandazioni

1. ✅ **Direct Stream:** avvio sotto il secondo, seek indipendente dalla posizione, costo trascurabile. È la modalità di default per il browser.
2. ✅ **Timeline originale** realizzabile; il seek del server è granulare al GOP e il player completa il seek fine.
3. ❌ **"Transcode minimo software" (decisione P2) non è sufficiente per contenuti 4K HDR** su questo PC: il caso più probabile (4K HDR → client SDR/1080p) non è in tempo reale. **P2 va rivista**:
   - (a) MVP con transcode GPU (NVENC + libplacebo), con H10 da verificare;
   - (b) MVP con transcode software limitato alle sorgenti 1080p, 4K solo in Direct Play/Direct Stream;
   - (c) transcode fuori dall'MVP.
4. ⚠️ **Burn-in 4K** da evitare: PGS resi dal client (P3); se non evitabile, downscale a 1080p prima del burn-in.
5. 🔬 **Nuova H10:** NVENC/CUDA (e Vulkan per libplacebo) funzionano dentro un container Docker Desktop su WSL2. Da verificare prima dell'ADR sull'accelerazione hardware.
