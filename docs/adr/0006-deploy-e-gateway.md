# 0006 — Deploy Docker Compose e gateway Caddy

- **Stato:** Accepted (2026-11-06)
- **Data:** 2026-11-05
- **Decisore:** Claude, su delega del proprietario (review: design-reviewer, correzioni applicate)
- **Requisiti collegati:** §2 (container indipendenti, Docker Compose), §3 (storage esterno read-only, volumi separati), §5.1 (Direct Play con seek), §9 (LAN oggi, remoto domani), §18 (portabilità, resilienza), §19 (MVP in Compose); doc 02 §2.1, §3.1, §6 (C1, C2), §7; doc 03 P1, P9, §5; doc 04 §7, P2
- **Valutazione completa:** [05 — §4 Deploy e gateway](../architecture/05-technology-evaluation.md#4-deploy-e-gateway)

## Contesto

Per costruire l'MVP servono un layout di deploy e un gateway. Il gateway è l'unico punto d'ingresso dei client: serve gli asset statici del web client (C2) e instrada API e media verso il Video Service (doc 02 §2.1).

I vincoli misurati sono questi:
- sul bind mount NTFS di Docker Desktop/WSL2 la lettura va a circa **500 Mbps** (S3/H10);
- inotify non arriva dai path Windows (doc 02 §3.1);
- in container CUDA, NVENC e `tonemap_cuda` funzionano con jellyfin-ffmpeg 8.1.x. ffmpeg 9 vuole un driver ≥ 610 (S3/H10);
- nell'MVP il 4K non si transcodifica (P2).

La portabilità verso un mini-PC o NAS Linux è un vincolo rigido (§18).

## Opzioni considerate

### Gateway A: Caddy 2.11.8
- Pro:
  - Range passato correttamente. Nessuna lettura anticipata dal backend con i default: in G1, con un client lento, ha letto 33–36 MB per 21 MB consegnati;
  - `file_server` con fallback SPA (C2);
  - health check attivi;
  - HTTPS automatico (ACME) integrato per il remoto;
  - Caddyfile breve; Apache-2.0; immagini ufficiali multi-arch.
- Contro: 5 CVE corrette a febbraio 2026 (2.11.1). Il ritmo di patch è alto e l'immagine va aggiornata con regolarità.

### Gateway B: nginx 1.30.6
- Pro: statici eccellenti, maturità, BSD.
- Contro:
  - **con i default ha letto dal backend l'intero file da 1 GiB in 4 s** mentre il client ne consumava 21 MB (G1). Serve `proxy_buffering off`, più timeout lunghi;
  - health check solo passivi nella versione open source;
  - TLS senza ACME integrato nell'immagine ufficiale (non verificato il modulo `nginx-acme`).

### Gateway C: Traefik 3.7
- Pro: streaming di default, ACME, discovery via label.
- Contro: **non serve file statici**. Servirebbe un secondo container, contro C2. La discovery dinamica è superflua con 2–3 servizi.

### Ambiente di sviluppo
- **Tutto in Compose con `docker compose watch`:** stesse immagini e stessa semantica Linux di produzione; niente bind mount NTFS per il codice.
- **Backend sull'host:** più veloce, ma con ffmpeg 7.0 contro 8.1 e la semantica Windows di path e processi figli, cioè la parte più delicata di Stream Delivery.

### ffmpeg nell'immagine
- jellyfin-ffmpeg 8.1.3;
- build linuxserver/BtbN 9.0;
- ffmpeg di Debian;
- build da sorgente.

## Evidenze

- **G1** (2026-11-05, `spikes/g1-gateway-range/`, throwaway): Range `206` su tutti e tre i proxy. Byte letti dall'origine con un client a 5 MB/s per 4 s:

  | Proxy | Byte letti dall'origine |
  |---|---|
  | Caddy | 33–36 MB |
  | nginx, default | **1.074 MB** |
  | nginx, `proxy_buffering off` | 26 MB |

  Dettagli in [05 §4.4](../architecture/05-technology-evaluation.md#44-esperimento-g1-range-e-lettura-anticipata-attraverso-il-proxy).
  - **Limite di G1:** l'origine era Caddy `file_server` che leggeva da un volume Docker, **non** Node con `@fastify/send` su bind mount NTFS. G1 misura la lettura anticipata del proxy, non il comportamento del Video Service reale sui media di Windows: va riverificato sul primo Direct Play reale attraverso il gateway.
- **S3/H10** ([report](../spikes/S3-stream-latency.md)):
  - bind mount NTFS a circa 60–67 MB/s;
  - volume Docker veloce come l'host;
  - con jellyfin-ffmpeg 8.1.3 in container funzionano CUDA, NVENC e `tonemap_cuda`;
  - NVENC di ffmpeg 9.0.2 fallisce con il driver 596;
  - Vulkan e OpenCL non sono esposti su WSL2.
- **Versioni verificate il 2026-11-05:**
  - `caddy:2.11-alpine` → v2.11.8 (digest `sha256:70b3180738b46cd88e49b300d790ae448a0aca3f58edef0f000bb57d619a9ab3`);
  - `nginx:1.30-alpine` → 1.30.6;
  - `jellyfin-ffmpeg8_8.1.3-2` per bookworm e trixie su repo.jellyfin.org.

## Decisione

1. **Gateway: Caddy 2.11.8.**
   - Immagine `caddy:2.11.8-alpine`, fissata per digest. Un'immagine `gateway` costruita in multi-stage copia la build del web client in `/srv/web`.
   - Route, con il percorso inoltrato senza riscrittura:
     - `/video/api/*` → `video`, con compressione;
     - `/video/media/*` → `video`, con `flush_interval -1` e senza compressione;
     - `/video/healthz` → `video` (salute del servizio, fuori dal control plane versionato);
     - il resto → `file_server` con `try_files {path} /index.html`.
   - `handle_errors` restituisce un `503` JSON quando il video è giù. Il gateway non dipende dalla salute di `video` per partire.
   - HTTP in LAN (`auto_https off`) nell'MVP.
2. **Compose:**
   - due servizi: `gateway` (unica porta pubblicata, `${HTTP_PORT:-8080}`) e `video` (solo rete interna, `init: true`, utente non root). Nessun servizio di database: SQLite è un file nel volume `video-db` (ADR 0002);
   - una rete `platform`, a cui si aggancerà il futuro Music Service;
   - `healthcheck` di `video` su `/video/healthz`, senza `curl` nell'immagine:
     `node -e "fetch('http://127.0.0.1:8096/video/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.
     Lo stesso path è l'`health_uri` dell'health check attivo di Caddy;
   - **utente e permessi:** il Dockerfile crea tutti i mount point (`/data/db`, `/data/cache`, `/data/artwork`, `/data/thumbnails`, `/data/scratch`, `/data/backup`, `/media`) con `mkdir -p` e ne fa il `chown` all'utente non root del servizio prima dello `USER`. Così i volumi nominati nuovi ereditano il proprietario giusto. ~~Per i bind mount su Linux si documentano `PUID`/`PGID`~~: sostituiti in F2 da un utente fisso e da `MEDIA_GID` (vedi l'aggiornamento F2 in fondo).
3. **Volumi e mount del container `video`** (`DATA_DIR=/data`; i path sotto `/data` sono fissi, cambia solo cosa c'è dietro):

   | Path nel container | Volume o sorgente | Modalità | Contenuto |
   |---|---|---|---|
   | `/media/<root>` | bind mount di `${MEDIA_DIR}` su `/media`, quindi ogni root della libreria è `/media/<root>`; una root su un altro disco è un bind mount in più su `/media/<root>` | **`:ro`** | media della libreria (invariante §3) |
   | `/data/db` | volume nominato `video-db` | rw | database SQLite `/data/db/video.db` con `-wal`/`-shm` (ADR 0002) |
   | `/data/cache` | volume nominato `video-cache` | rw | solo cache **derivate e ricostruibili**: varianti delle immagini, output grezzo di ffprobe. Cancellarlo è sempre sicuro. Le risposte dei provider stanno nel DB (`provider_cache`, ADR 0002) |
   | `/data/artwork` | volume nominato `video-artwork` | rw | artwork scaricato, caricato dal proprietario, generato dal video |
   | `/data/thumbnails` | volume nominato `video-thumbnails` | rw | frame e anteprime |
   | `/data/scratch` | volume nominato `video-scratch` | rw, effimero | segmenti e file temporanei di Stream Delivery |
   | `/data/backup` | volume nominato `video-backup` | rw | backup giornalieri del database (ADR 0002) |

   - lo scratch ha una **quota applicativa** (`SCRATCH_MAX_BYTES`, default 20 GB), gestita da Stream Delivery, e viene svuotato all'avvio e alla chiusura della sessione;
   - mai il database su bind mount NTFS;
   - **limiti del backup nell'MVP:** su Docker Desktop `video-backup` e `video-db` stanno nello stesso disco virtuale WSL (vhdx), quindi il backup **non** protegge dalla perdita del disco. L'artwork caricato dal proprietario (`video-artwork`) non ha backup. Un backup fuori dall'host avrà una sua ADR; sul server Linux un override può puntare `video-backup` a un altro disco.
4. **Library Monitor:** `LIBRARY_WATCH=off` su Docker Desktop, scansione periodica ogni `LIBRARY_SCAN_INTERVAL_MIN` minuti (default 15), `auto` su Linux nativo.
5. **Sviluppo:**
   - tutto in Compose, con `develop.watch` (in F0 è finito dentro `compose.yaml`, non in un `compose.dev.yaml` separato; nessuna porta di debug pubblicata);
   - i test unitari dei moduli puri possono girare sull'host, quelli d'integrazione girano nel container;
   - il dev server del web client, se c'è, gira sull'host e fa da proxy verso il gateway.
6. **Configurazione:**
   - un solo `.env` alla radice (gitignorato) e un `.env.example` versionato;
   - default per ogni chiave tranne `MEDIA_DIR`;
   - `DATA_DIR=/data` è la radice dei dati nel container (punto 3); `MEDIA_GID` è il gruppo che legge i media (aggiornamento F2);
   - segreti anche come `<NOME>_FILE`: **non ancora implementato** (lacuna nota; oggi il token TMDB arriva solo da `env_file`);
   - le modifiche diventano effettive con `docker compose up -d`.
7. **ffmpeg:**
   - immagine base `node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39` (ADR 0001);
   - `jellyfin-ffmpeg8` **8.1.3-2**, versione fissata nell'`apt-get install` come `jellyfin-ffmpeg8=8.1.3-2-trixie`, installato dal repository firmato di Jellyfin, con `FFMPEG_PATH`/`FFPROBE_PATH` configurabili;
   - nessuna GPU nel Compose base: override `compose.gpu-nvidia.yaml` / `compose.gpu-intel.yaml` e probe delle capability all'avvio. **Non ancora presenti** (il transcode dell'MVP è software): arrivano con l'ADR sull'accelerazione hardware;
   - si passa a ffmpeg 9 solo con un driver ≥ 610.

### Aggiornamento F2 (2026-11-06, orchestratore su delega)

Decisioni prese nell'integrazione finale, dopo la revisione approfondita:

- **Gateway:**
  - un solo `reverse_proxy` per tutto `/video/*`, con l'health check attivo (`health_interval 10s`, `health_timeout 5s`, `health_fails 3`): con un solo fallimento una sonda lenta toglieva tutto `/video/*` per 10 s;
  - il `503` JSON di `handle_errors` è un Problem `MEDIA_UNAVAILABLE` con `Retry-After: 5`. Nel catalogo e nell'admin il web client lo mostra come "il servizio non risponde";
  - **log senza token:** il logger di default maschera `/media/s/<token>` in `uri` e `Referer` e toglie `Authorization` e `Cookie`. Caddy scrive la richiesta quando una risposta si interrompe (ogni seek in Direct Play) o quando il proxy fallisce;
  - **Host ammessi:** un indirizzo IP (v4 o v6), `localhost` e i nomi in `PZF_HOSTS`, con qualunque porta; gli altri ricevono `421`. Senza autenticazione, protegge dal DNS rebinding da una pagina aperta in LAN;
  - `/assets/*` senza ripiego su `index.html`: un asset mancante è un `404` `no-store`, non HTML in cache per un anno.
- **Compose:**
  - una sola rete `platform`, non `internal`: il Video Service deve raggiungere Wikidata e TMDB (ADR 0007). Resta non pubblicato: lo si raggiunge solo dal gateway;
  - **utente fisso `1000:1000`** (l'utente `node` dell'immagine), con `group_add: ${MEDIA_GID:-1000}` per leggere i media. Con `PUID`/`PGID` un uid diverso non poteva scrivere nei volumi nominati, creati dall'immagine per l'uid 1000;
  - nuovo volume **`video-secrets`** su `/data/secrets` (mode 700): la chiave che firma i token dei profili. Senza volume ogni ricostruzione del container scollegava tutti i profili;
  - media in **bind read-only con `create_host_path: false`**: su Linux un `MEDIA_DIR` sbagliato fa fallire `up`. Docker Desktop su Windows crea comunque la cartella mancante, e restano le difese del Video Service sulle radici smontate;
  - `pull_policy: never` sulle immagini costruite in locale: `docker compose pull` non scarica mai un `pezzotflix/*` altrui da Docker Hub. `build` ricostruiva e ricreava i container a ogni `up -d` (misurato su Compose 2.35);
  - log dei container a rotazione, 3 file da 10 MB; nome del progetto, porta, tag delle immagini e file `.env` sovrascrivibili dalla shell, per uno stack di prova accanto a quello principale;
  - il codice nell'immagine appartiene a `node`, così `docker compose watch` può sincronizzarlo.
- **Volume `video-backup`:** copia giornaliera con `integrity_check`, tenute 7 giornaliere e 4 settimanali, più una copia prima di ogni migrazione (ADR 0002 §10). `down -v` cancella anche i backup e la chiave dei profili: il README lo dice e descrive il ripristino.
- **Test end-to-end** (doc 06 §4): `PZF_E2E_BASE_URL` è obbligatorio, così i test non girano per sbaglio sullo stack principale. Un sample mancante fa fallire il gate, salvo quelli elencati in `PZF_E2E_ALLOW_SKIP`.

## Conseguenze

- **Più facile:**
  - il Direct Play passa dal gateway senza amplificare l'I/O sul bind mount NTFS;
  - il TLS per il remoto è una modifica del Caddyfile;
  - lo stesso Compose gira su Windows e su Linux: sul server cambiano solo `MEDIA_DIR` e gli override GPU;
  - sviluppo e produzione usano la stessa ffmpeg.
- **Più difficile:**
  - il debugger va agganciato al container;
  - la build del web client è legata all'immagine del gateway: aggiornare il client significa ricostruire il gateway;
  - jellyfin-ffmpeg segue il ciclo di Jellyfin, e la build va abbinata al driver dell'host.
- **Da rivedere:**
  - con 3 sessioni UHD sul PC Windows (il bind mount NTFS ha poco margine) o al passaggio al server Linux (`tmpfs` per lo scratch, `LIBRARY_WATCH=auto`, GPU Intel);
  - quando l'ADR sull'accelerazione hardware sceglie un backend;
  - all'arrivo dell'accesso remoto (TLS e autenticazione nel gateway).
- **Dipendenze:**
  - ADR 0001 (immagine base `node:26.13.0-trixie-slim` fissata per digest, reload con `compose watch`);
  - ADR 0002 (file `/data/db/video.db` nel volume `video-db`, backup in `video-backup`);
  - ADR 0007 (`.env` dei provider, `provider_cache` nel DB, artwork TMDB in `video-artwork`);
  - [ADR 0003](0003-streaming-hls-fmp4-segmenter.md), streaming (accettata il 2026-11-05): segmenti attraverso Caddy, quota dello scratch;
  - [ADR 0005](0005-web-client-react-vite.md), web client (accettata il 2026-11-05): build e dev server;
  - ADR del client TV (numero da assegnare): HTTP in chiaro in LAN su Android;
  - ADR del backup fuori dall'host (numero da assegnare).
