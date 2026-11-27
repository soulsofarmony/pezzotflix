# 0009 — Trickplay: anteprime sulla barra di seek

- **Stato:** Accepted (2026-11-27, Claude, su delega del proprietario, dopo un passaggio di `design-reviewer` e le sue correzioni)
- **Data:** 2026-11-27
- **Requisiti collegati:** requisiti §3 (storage read-only, dati applicativi su volumi separati), §8 ("formato e strategia delle thumbnail" tra le scelte aperte); [doc 02](../architecture/02-components.md) §3.7, §3.11, §3.12 ("non deve mai rallentare il playback"), C1; [doc 03](../architecture/03-interfaces.md) (PlaybackSession, "trickplay [futuro]", §8 StreamHandle); [doc 04](../architecture/04-playback-architecture.md) §9 (evoluzione "Trickplay"); [ADR 0003](0003-streaming-hls-fmp4-segmenter.md) D8 (keyframe index), D9 (confine estraibile e cache di Delivery), D10 (risorse di sessione); [ADR 0004](0004-contratto-api-openapi-3-1.md) (contratto e codegen Kotlin)

## Contesto

Il proprietario chiede (2026-11-27) l'anteprima stile Netflix: passando il mouse sulla timeline del browser, o scorrendo col telecomando sulla TV, compare il fotogramma di quel punto del film.

La funzione è prevista dal progetto ma fuori dall'MVP:
- doc 04 §9 la elenca tra le evoluzioni;
- doc 03 la segna come `[futuro]` nella PlaybackSession;
- doc 02 §3.7 la attribuisce all'Artwork Store ("in futuro l'anteprima nella barra di seek").

Manca la decisione su formato, generazione, modulo proprietario e consegna ai client. È l'"ADR sulle thumbnail" annunciato in [docs/adr/README.md](README.md) e in ADR 0007, limitato qui al trickplay: gli still degli episodi restano all'Artwork Store e a un ADR futuro.

Vincoli:
- media in sola lettura;
- elaborazione dei media sempre in processi figli;
- posizioni sempre sulla timeline originale (PTS − start_time);
- URL del data plane autorizzati dal token di sessione nell'URL;
- il lavoro in background non deve mai rallentare il playback (doc 02 §3.12);
- server di casa modesto: WSL limitato a 3 GB, CPU condivisa con il transcode software 1080p;
- TV a 32 bit con 2,8 GB di RAM su Wi-Fi a 2,4 GHz;
- la libreria è fatta soprattutto di re-encode x265 4K HDR10 da circa 20 GB, con qualche remux da 50 GB e oltre e un ibrido DV.

## Opzioni considerate

### A. Formato delle anteprime

#### A1. Sprite sheet JPEG + descrizione nel contratto (scelta)
- Pro:
  - poche immagini grandi, ciascuna una griglia di fotogrammi: un film di 2 h 30 sta in 9 immagini;
  - la descrizione (intervallo, riquadro, griglia, URL) è un oggetto piccolo e tipizzato nella PlaybackSession: niente richiesta in più, e codegen TS e Kotlin già pronti (ADR 0004);
  - su entrambi i client basta ritagliare l'immagine: CSS `background-position` nel browser, `drawImage` con offset in Compose.
- Contro: per un solo fotogramma si scarica l'intera griglia (0,3–0,8 MB). Accettabile, perché la griglia serve poi per i fotogrammi vicini.

#### A2. Traccia WebVTT "thumbnails" (`#xywh=`)
- Pro: convenzione diffusa nei player web pronti.
- Contro: il nostro player web è scritto da noi, quindi la convenzione non porta niente. In più serve un parser VTT anche sulla TV, e la traccia sta fuori dal contratto OpenAPI.

#### A3. HLS image playlist (`EXT-X-IMAGES-ONLY`)
- Pro: standard HLS.
- Contro:
  - esiste solo con l'HLS, e il Direct Play progressivo non ha playlist;
  - hls.js non la usa per le anteprime. Per Media3 non abbiamo verificato il supporto attuale.

#### A4. Un file JPEG per fotogramma
- Pro: il più semplice da generare.
- Contro: circa 900 file e 900 richieste per film. Sulla TV in Wi-Fi a 2,4 GHz lo scorrimento rapido diventa una raffica di richieste.

### B. Generazione

#### B1. Un solo passaggio ffmpeg sui soli keyframe (scelta)
`-skip_frame nokey` decodifica solo i keyframe; il filtro `fps` sceglie il fotogramma più vicino a ogni passo; `tile` compone le griglie.
- Pro:
  - un processo per film;
  - niente decodifica dei frame B/P;
  - funziona allo stesso modo con MKV, MP4 e file senza Cues.
- Contro:
  - legge tutto il file in sequenza;
  - con GOP corti (remux, circa 1 s) decodifica circa 10 volte più keyframe di quanti ne servano;
  - la precisione è di ± mezzo GOP.

#### B2. Un seek per fotogramma guidato dal keyframe index
- Pro: legge e decodifica solo quello che serve: molto meno lavoro sui remux.
- Contro: circa 900 avvii di ffmpeg, oppure un demuxer scritto da noi. Resta l'ottimizzazione da adottare se la misura sui remux lo chiede (§Conseguenze).

### C. Modulo proprietario

#### C1. Stream Delivery (scelta, scostamento da doc 02 §3.7)
- Pro:
  - le anteprime sono un prodotto del **data plane**: derivano dal contenuto del file, si invalidano con lo stesso stamp (dimensione + mtime) del keyframe index e si servono sotto il token di sessione;
  - Delivery ha già ffmpeg in processi figli, la cache per stamp, il registro dei fallimenti, le rotte `/video/media/s/{token}/…` e il conteggio degli stream attivi che serve per rimandare il lavoro (D5);
  - si estrae nel `video-worker` (C1) insieme al resto del lavoro pesante sui media, con le sue cache in `/data/cache/delivery/` (ADR 0003 D9).
- Contro: doc 02 §3.7 e §3.11 vanno aggiornati.

#### C2. Artwork Store (come scritto in doc 02)
- Pro: nessuno scostamento.
- Contro:
  - l'Artwork Store (modulo `metadata`) gestisce immagini di catalogo legate agli item;
  - il trickplay è legato al singolo file e al suo stamp, ed è servito per sessione;
  - servirebbero un secondo percorso di autorizzazione col token e una copia della logica di stamp e fallimenti di Delivery;
  - non vede gli stream attivi.

## Evidenze

Misura **preliminare** del 2026-11-27, superata dalla tabella successiva sul server di casa, con l'ffmpeg dell'immagine del progetto (`jellyfin-ffmpeg` 8.1.3) nel container `video`, sul file reale `2001 - Odissea nello spazio (1968) - 2160p.mkv` (HEVC 10 bit 3840×1746, HDR10/PQ, 21,8 GB, 2 h 29 min):

| Misura | Valore |
|---|---|
| Filtri | `-skip_frame nokey`, poi `fps=1/10,zscale=w=320:h=-2:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemapx=tonemap=bt2390:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuvj420p,tile=10x10`, `-q:v 4` |
| Tempo | 245 s, senza limite di thread e senza nice. CPU e memoria di picco non misurate |
| Output | 9 griglie 3200×1460 (riquadri da 320×146), 5,4 MB in tutto, 270–790 kB a griglia |
| Colori | corretti a vista: scene scure, rosse, lunari e bianche leggibili |
| Note | il demuxer segnala elementi EBML fuori misura nel file, ma la generazione arriva in fondo |

La lettura media è stata di circa 89 MB/s, molto sotto un SSD SATA. Il collo di bottiglia è quindi la CPU o il bind mount NTFS → WSL2, cioè proprio le risorse che usa lo streaming. Questi numeri **non** sono quelli della configurazione decisa (thread limitati, nice 10): il primo passo di T1 ([piano 08](../architecture/08-trickplay-plan.md) §3) li rimisura con gli argomenti finali, con tempo, CPU e memoria di picco, su un re-encode 4K, sul remux di Arancia meccanica e su un 1080p.

**Misura con gli argomenti finali** (T1, 2026-11-27, stesso container): `nice -n 10`, `-threads 2`, `-skip_frame nokey`, catena di tone mapping per PQ, `tile=10x10`, `-q:v 4`. CPU e memoria campionate da `/proc`.

| File | Dimensione | Durata | Tempo | CPU (core medi) | Memoria di picco | Lettura | Riquadri (attesi) | Output |
|---|---|---|---|---|---|---|---|---|
| 2001, 4K HDR10 x265 | 21,8 GB | 2 h 29 min | **359 s** | 0,47 | 311 MiB | 61 MB/s | 892 (894) | 9 griglie, 6,4 MB |
| Psyco, 1080p SDR H.264 | 8,5 GB | 1 h 49 min | **150 s** | 0,46 | 205 MiB | 57 MB/s | 653 (654) | 7 griglie, 4,3 MB |
| Arancia meccanica, 4K DV 8.1 remux, GOP ~1 s | 56,4 GB | 2 h 17 min | **1766 s (29 min)** | 0,88 | 452 MiB | 32 MB/s | 820 (820) | 9 griglie, 7,9 MB |

- I re-encode sono limitati dalla lettura del bind mount, il remux dalla CPU (keyframe 4K ogni secondo).
- Con `-threads 4` su 600 s di Arancia meccanica: 102,7 s contro 110,8 s con 2 thread, ma 321 MiB contro 241 MiB. Si tengono 2 thread.
- La memoria resta sotto i 500 MiB anche sul remux: compatibile con il limite di 3 GB di WSL.
- HLG provato su una clip sintetica nel container: luminosità dei riquadri coerente con il tempo.

`tonemapx` esiste solo in jellyfin-ffmpeg (immagine del progetto, ADR 0006). L'ffmpeg upstream installato sui PC di sviluppo non ce l'ha.

Riferimenti non verificati in rete in questa sessione, quindi senza peso nella decisione: il trickplay di Jellyfin 10.9 e il BIF di Roku usano lo stesso schema a griglie.

## Decisione

**D1 — Formato.** Sprite sheet **JPEG** con griglia **10×10** di riquadri larghi **320 px**. L'altezza segue l'aspect ratio di visualizzazione (SAR applicato prima della scala), arrotondata a un numero pari. Qualità JPEG `-q:v 4`. Le griglie sono numerate da 0 (`-start_number 0`).

**D2 — Passo.** Un riquadro ogni **10 s** sulla timeline originale: il riquadro `i` mostra il keyframe più vicino al tempo originale `i × intervalMs`, con `fps=…:start_time=0` dopo aver riportato a zero i tempi sullo start_time del file. Oltre 2000 riquadri (5 h 33 min) il passo cresce al secondo intero che li riporta sotto 2000.

**D3 — Generazione.**
- Un processo ffmpeg per file, in un solo passaggio sui soli keyframe (B1), sul flusso video scelto dall'Analyzer.
- PQ o HLG: tone mapping a SDR BT.709 su CPU con `tonemapx`. Se il filtro manca, il servizio lo dice nei log all'avvio e i file HDR restano senza anteprima.
- SDR: solo scala.
- **Dolby Vision profilo 5** (senza base HDR10): niente anteprima, perché i colori sarebbero sbagliati.
- Il processo si lancia con `nice -n 10` (vale per tutti i suoi thread) e un numero di thread limitato.

**D4 — Cache e consegna.**
- **Proprietario e cache:**
  - proprietario Stream Delivery (C1);
  - cache in `/data/cache/delivery/trickplay/<fileId>/<stamp>/` (`stamp` = dimensione, mtime e versione dei parametri), con `manifest.json` e `sheet-N.jpg`, come richiede ADR 0003 D9;
  - la cartella dello stamp si scrive in una cartella temporanea e si rinomina al suo posto. Le cartelle di stamp vecchi si cancellano dopo;
  - il volume `/data/thumbnails` resta all'Artwork Store.
- **Esito della generazione:** si giudica dall'output, non dagli errori nel log. Vale se ha prodotto il numero di riquadri atteso, con tolleranza sull'ultimo. Altrimenti si registra un fallimento: permanente per quello stamp se ffmpeg è uscito, temporaneo per timeout e I/O.
- **Contratto:** schema `Trickplay` (`intervalMs`, `tileWidth`, `tileHeight`, `columns`, `rows`, `count`, `sheets[]` di locator relativi) e campo `trickplay` della `PlaybackSession`, nullable con il pattern `oneOf: [$ref, {type: 'null'}]` già usato nel contratto: `null` finché l'anteprima non c'è. Il campo arriva da `StreamHandle.locators` (doc 03 §8).
- **Rotta:**
  - `GET /video/media/s/{sessionToken}/trickplay/{sheet}`, con `sheet` vincolato a `^sheet-[0-9]{1,4}\.jpg$` e `N` minore del numero di griglie;
  - si servono solo le griglie del file della sessione e dello stamp del suo plan;
  - stessi codici delle altre risorse di sessione (404 per token sconosciuto, 410 per sessione chiusa), `Cache-Control: no-store` (ADR 0003 D10);
  - le richieste di griglie non contano come attività dello stream (timer di inattività).
- **Ri-pianificazione:** un nuovo plan porta un nuovo token e quindi nuovi URL. I client sostituiscono le griglie della sessione con quelle del nuovo `trickplay`.

**D5 — Pianificazione.**
- Nuovo job `delivery.trickplay`, gestito da Delivery, con concorrenza 1 e 3 tentativi.
  - La priorità ordina solo i job dello stesso tipo, quindi non lo mette dopo i keyframe index.
  - Il payload porta i fatti che servono a Delivery, copiati da chi accoda: luogo, stamp, container, indice del flusso video, durata, start_time, transfer, profilo DV, SAR e dimensioni.
- **Chi accoda:**
  - l'Analyzer, dopo ogni probe riuscito di un file con video, con chiave `trickplay:v<versione>:<fileId>:<size>:<mtime>`;
  - all'avvio, l'Analyzer accoda solo i file presenti con video che **non hanno ancora un job con la chiave attuale**. Così un job già finito o fallito, compreso uno marcato `interrupted on its last attempt`, non si riaccoda a ogni riavvio;
  - all'avvio di una sessione senza anteprima, Delivery accoda lo stesso job (stessa chiave, quindi senza duplicati). Copre una cache cancellata.
- **Precedenza al playback:** mentre Delivery ha uno stream attivo, il job non parte e si rimanda di qualche minuto (`retryAfterMs`), senza consumare tentativi. Un job già partito arriva in fondo, a priorità CPU bassa.
- `TRICKPLAY_ENABLED` (default `true`) spegne tutto su un server debole.

**D6 — Client.**
- **Web:**
  - al passaggio del mouse sulla barra di seek, e durante il trascinamento (anche touch), compare sopra il punto il riquadro con l'ora;
  - l'indice del riquadro è `min(count − 1, floor(valoreBarraMs / intervalMs))`, senza conversioni: la barra è già sulla timeline originale;
  - le griglie si caricano alla prima necessità e restano in memoria per la sessione.
- **TV:**
  - con l'anteprima disponibile e i controlli nascosti, sinistra/destra entrano in **modalità scorrimento**;
  - il video va in pausa, ogni pressione sposta il punto di 10 s e il tasto tenuto premuto accelera;
  - OK o Play confermano il seek; Indietro annulla e torna al punto e allo stato di riproduzione di prima;
  - i report di avanzamento mandano la posizione vera, non quella scelta;
  - senza anteprima resta il comportamento attuale (±10 s immediati);
  - in memoria al più 2 griglie decodificate, in una cache propria, separata da quella dei poster.

## Note di costruzione (T1, 2026-11-27)

Dettagli decisi durante la costruzione, che precisano D2–D5 senza cambiarne il senso:
- **Riquadro più vicino (D2).** `fps=…:round=near` sui soli keyframe prende l'ultimo keyframe prima di `n·I + I/2`: con GOP di 2 s i riquadri arrivavano 4 s in ritardo. Un `setpts=PTS+(I−g)/2` prima di `fps`, con `g` il gap mediano dei keyframe letto dal keyframe index (o dai Cues), rende ogni riquadro il keyframe più vicino a `i × I`. Senza `g` lo spostamento è nullo. `eof_action=pass` recupera l'ultimo riquadro. Il test d'integrazione controlla uno scarto ≤ 1,5 s.
- **Timeline (D2).** Senza `-copyts` ffmpeg riporta già i tempi a zero sullo start_time del file: il payload non porta lo start_time.
- **Aspect ratio (D1).** La scala usa il DAR (`h=trunc(320/dar/2+0.5)*2`, poi `setsar=1`). Le dimensioni vere del riquadro si leggono dall'output di ffmpeg.
- **Colore (D3).** Le griglie si scrivono in BT.601 full range, cioè quello che i decoder JPEG assumono (`zscale=t=bt709:m=470bg:r=full`). La catena preliminare (`m=bt709:r=tv`) dava neri sollevati, visti a confronto su 2001. La scala avviene prima del tone mapping.
- **Esito (D4).** Un ramo `split` scrive `framecrc` su stdout: conteggio e dimensioni esatti dei riquadri. Tolleranza: mancano al più 60 s alla fine (era 30 s; alzata il 2026-11-27 per Suspiria, vedi sotto). Il numero di griglie deve essere `ceil(riquadri / 100)`.
- **Fallimenti (D4).** Registrati in `<fileId>/failed.json`. Quelli temporanei (timeout, I/O, avvio) valgono 6 h. Timeout: `max(20 min, dimensione ÷ 8 MB/s)`, cioè circa 4 volte il tempo misurato su Arancia meccanica.
- **Contratto (D4).** `trickplay` è obbligatorio e nullable nella PlaybackSession: il server lo manda sempre.
- **Rinvio (D5).** Scatta con uno stream registrato o con un avvio in corso. Con `TRICKPLAY_ENABLED=false` niente job, niente ricostruzione, `trickplay: null`.
- **Indice del riquadro nei client (D6).** Il riquadro `i` copre `[i·I − I/2, i·I + I/2)`, quindi l'indice per una posizione `p` è `min(count − 1, round(p / intervalMs))`, non `floor` come scritto in D6: con `floor` a 19 s si vedrebbe il riquadro dei 10 s invece di quello dei 20 s. Vale il testo del contratto.
- **Ripiego a decodifica completa (D3, 2026-11-27).** Su un remux Blu-ray AVC (La classe operaia va in paradiso, 31 GB) il decoder H.264 con `-skip_frame nokey` non restituisce niente dagli I-frame non IDR: 1 riquadro su 692. Lo stesso con `nointra` e con `-flags2 +showall`. Quando ffmpeg esce pulito con troppi pochi riquadri, le griglie parziali si cancellano e la generazione si rifà decodificando tutti i fotogrammi, senza lo spostamento del GOP. Su quel file la decodifica completa con 2 thread va a circa 12 volte il tempo reale.
- **Coda lunga e timeout del ripiego (2026-11-27).** Suspiria (x265 1080p, 8,6 GB) chiude con un GOP di 38 s sui titoli di coda: dai soli keyframe escono 592 riquadri su 596, sotto il minimo di allora (593). Il ripiego a decodifica completa è poi scaduto dopo 20 minuti, perché il timeout si calcolava solo dalla dimensione del file. Due correzioni:
  - la tolleranza alla fine sale a 60 s. Il client mostra l'ultimo riquadro per la coda che manca;
  - il passaggio a decodifica completa ha come timeout almeno la durata del film (1× tempo reale), perché lì conta il decoder, non il disco.
- **B2 non serve per ora.** I 29 minuti del remux più grande si spendono una volta sola, nelle ore senza visione: si resta su B1.

## Conseguenze

- **Più facile:** navigare un film lungo. L'anteprima vale per Direct Play, Direct Stream e Transcode, perché non dipende dallo stream.
- **Costo una tantum:** circa 6 min per un re-encode 4K da 20 GB, 2–3 min per un 1080p, circa 30 min per un remux 4K da 50 GB e oltre, sempre nei momenti senza visione. Spazio: circa 5–15 MB per film.
- **Lacune note:**
  - DV profilo 5 senza anteprima;
  - le cartelle dei file usciti dalla libreria restano in cache, come oggi quelle dei keyframe index (circa 10 MB a film): pulizia insieme, quando servirà;
  - precisione di ± mezzo GOP.
- **Da rivedere:**
  - se il remux di Arancia meccanica risulta troppo lento, si passa a B2 per i file con Cues complete;
  - con l'accelerazione hardware (ADR prevista dopo H10) decodifica e tone mapping possono passare sulla GPU (`tonemap_cuda` è nell'immagine).
- **Documenti da aggiornare all'accettazione:** doc 02 §3.7 e §3.11, doc 03 (PlaybackSession e §8), doc 04 §9, la riga "ADR previste" di [README](README.md).
