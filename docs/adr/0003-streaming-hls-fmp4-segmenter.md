# 0003 — Streaming: HLS fMP4 VOD con segmenter proprio

- **Stato:** Accepted (2026-11-05, dopo la revisione di design, B1, M1–M9 e minori 1–22, e una seconda revisione breve di riavvio, timeline e sottotitoli)
- **Data:** 2026-11-05
- **Decisore:** Claude, su delega del proprietario. Revisione del `design-reviewer`: "accettare dopo le correzioni", correzioni applicate; seconda revisione: "accettare", con otto ritocchi al testo applicati
- **Requisiti collegati:** §5.1 (Direct Play preferito), §5.2 (transcode di ripiego), §6 (più tracce audio e sottotitoli, selezione e disattivazione), §8 (1 sessione, target 3), §18 ("Qualità", "Portabilità", "Modularità"), §19 (MVP), §20 ("strategia concreta di streaming", "implementazione Direct Play", "implementazione transcoding", "strategia di caching"); doc 02 §3.10–§3.11, C1; doc 03 §4.3, §5, §8, I6; doc 04 §4, §6, §7, §8, P2, P3, H8, H11
- **Valutazione completa:** [05 — §6 Protocollo di streaming e Stream Delivery](../architecture/05-technology-evaluation.md#6-protocollo-di-streaming-e-stream-delivery)

## Contesto

- **Il browser non fa Direct Play di un remux** con più tracce audio o con audio TrueHD/DTS (S2, H1). Il percorso normale è quindi il **Direct Stream**: video copiato, audio copiato o convertito, container fMP4. Il Direct Play resta per gli MKV con una sola traccia audio decodificabile (doc 04 §4.1).
- **Vincoli:**
  - il seek su tutto il film;
  - le posizioni sempre sulla timeline originale (doc 04 §6.1);
  - un avvio rapido (H8: sotto i 2–3 s);
  - nessuna degradazione non necessaria (§18);
  - processi media sempre figli e Stream Delivery estraibile (C1);
  - contratto: `stream.protocol` ∈ {`progressive`, `hls-fmp4`}, risorse `/video/media/s/{token}/file|hls/{resource}|subtitles/{track}` (ADR 0004). Le aggiunte di questa ADR sono additive (P8).
- **Fatti misurati:**
  - S2: HLS fMP4 via MSE funziona in Chrome, Edge e Firefox, anche HEVC Main10 HDR10 4K a circa 100 Mbps;
  - S2: Chromium tiene al massimo 150 MiB di video e 12 MiB di audio per stream;
  - S3: il remux al volo costa poco, e il seek nell'MKV è indipendente dall'offset;
  - S3/H10: dal bind mount NTFS il remux legge a circa 47 MB/s e `cat` a 60–67 MB/s;
  - S2: estrarre una traccia di sottotitoli legge tutto il file.

## Opzioni considerate

### Protocollo
- **A. HLS con segmenti fMP4 (CMAF), playlist VOD.**
  - Pro: misurato in S2; `hls-fmp4` è già nel contratto; Media3 e i dispositivi Apple lo leggono nativamente.
  - Contro: le quote MSE vanno rispettate dal client.
- **B. DASH con segmenti CMAF.**
  - Pro: tecnicamente equivalente.
  - Contro: non misurato; serve un valore nuovo nel contratto; nessun supporto nativo Apple.
- **C. fMP4 progressivo, una risposta per avvio.**
  - Pro: server semplicissimo, nessuna quota MSE.
  - Contro: in Chromium il 4K parte in 0,8–1,5 s (S2); che cresca con la durata del file è un giudizio, perché S2 lo indica come probabile e da misurare. Ogni seek è un nuovo URL; barra di seek e offset dei sottotitoli restano a carico del client.

### Segmenter
- **A. Muxer `hls` di ffmpeg** (come Jellyfin).
  - Pro: nessun codice di segmentazione.
  - Contro:
    - taglia al primo keyframe ≥ inizio dell'esecuzione + n·`hls_time`. Coincide con una playlist calcolata da 0 solo se i keyframe cadono sulla griglia: con keyframe fuori griglia un riavvio taglia altrove (E1, verifica del revisore t7);
    - il primo `tfdt` dell'AAC è negativo e va in overflow (E3);
    - throttling con segnali, attesa dei file con polling.
- **B. ffmpeg scrive fMP4 frammentato su stdout, il servizio taglia i segmenti** sui confini della playlist.
  - Pro:
    - confini nostri, indipendenti dall'esecuzione;
    - con il pre-roll di un GOP (Decisione 4: si parte dal keyframe indicizzato che precede Bₖ), i campioni di un riavvio coincidono con quelli dell'esecuzione da 0 anche con GOP aperti (verifica del revisore t4, t8, t9);
    - throttling per contropressione;
    - lo stesso parser dà stringa di codec e controllo dell'`esds`.
  - Contro: circa 300–400 righe da scrivere e testare; un GOP letto in più a ogni riavvio (fino a un segmento con la sonda di ripiego).
- **C. Muxer `segment` con `-segment_times`.**
  - Pro: tagli espliciti.
  - Contro: non misurato; ogni segmento è un MP4 a sé, mentre l'HLS fMP4 vuole un init separato.

### Indice dei keyframe
- **A. Cues di Matroska** letti con un parser EBML minimo (SeekHead e Cues): legge solo l'indice, lo stesso che ffmpeg usa per il seek.
- **B. Sonda a salti di ffprobe** (`-read_intervals`): nessun codice nuovo, ma legge un pacchetto keyframe per intervallo. Su un remux da 2,5 h sono circa 2250 salti e 0,6–3 GB, cioè 10–60 s a freddo (stima del revisore, t5: keyframe medi da 263 KB su Long Test).
- **C. Scansione completa dei pacchetti:** esatta, ma legge tutto il file.

### Sottotitoli embedded
- **A. Estrazione completa per file, nella cache, servita mentre cresce.**
  - Pro: una lettura per file, una volta sola (tutte le tracce in un passaggio, E5b); vale anche per il Direct Play.
  - Contro: due passaggi e una fusione se la sessione non parte da 0; una lettura completa in concorrenza col playback.
- **B. Uscita in più del processo di remux.**
  - Pro: nessuna lettura in più.
  - Contro: copertura limitata all'esecuzione in corso e a pezzi dopo ogni riavvio; niente remux in Direct Play.
- **C. Estrazione all'ingest per ogni file.**
  - Pro: sempre pronta.
  - Contro: una lettura completa di tutta la libreria (circa 6 giorni per 500 film da 60 GB sul bind mount).

### Direct Play
- **Fastify con `@fastify/send`.**
- **Il gateway**, già scartato dall'ADR 0006 (Accepted): duplicherebbe autorizzazione e sessioni.

## Evidenze

- **[S2](../spikes/S2-browser-playback.md):**
  - HLS fMP4 in tre browser;
  - audio per browser: FLAC, Opus 5.1 e AAC 5.1 con channelConfiguration 6 ovunque, E-AC-3/AC-3 solo in Edge;
  - nessun AAC con PCE;
  - DV P8.1 servito come `hvc1`;
  - il `bufferFullError` viene dal buffer in avanti, non dalla durata dei segmenti.
- **[S3](../spikes/S3-stream-latency.md):** primo segmento in 0,16–0,25 s sull'host; seek granulare al GOP; con `-copyts` la timeline originale resta.
- **Esperimento A3** (2026-11-05, portatile, `spikes/a3-stream-delivery/`, dettagli in [05 §6.5](../architecture/05-technology-evaluation.md#65-esperimento-a3-2026-11-05-portatile)), su un file sintetico a 60 fps con GOP chiusi da 2 s:
  - **E1:** il muxer `hls`, riavviato, non riproduce i tagli della playlist calcolata da 0 (rivista dal revisore, t7: vedi sopra);
  - **E2/E7:** con fMP4 frammentato e `-noaccurate_seek -ss B+0,135` il riavvio parte esattamente al keyframe, con gli stessi `tfdt` dell'esecuzione da 0;
  - **E3:**
    - `-ss 16` parte da 14 s, per l'arretramento di 3/23 s che ffmpeg applica con i B-frame;
    - con l'AAC il primo `tfdt` audio va in overflow; `-output_ts_offset 10` lo evita;
    - senza `frag_discont` il `tfdt` riparte da 0;
  - **E3b:** dal TrueHD 5.1(side), channelConfiguration 0 senza `aformat` e 6 con `aformat`, letto dall'`esds` dell'init;
  - **E2b:** dal bind mount NTFS, i primi 60 MB da un offset profondo in 0,39–0,80 s;
  - **E4:** la copia dell'E-AC-3 su pipe richiede `delay_moov`;
  - **E5b:** tutte le tracce di sottotitoli in un passaggio costano quanto una;
  - **E6:** `hevc_metadata=remove_dovi=1` toglie tutte le RPU di un P8.1 (62 → 0) e lascia i SEI HDR10. Anche VPS/SPS/PPS (NAL 32/33/34) passano da 4 a 2, con entrambi i filtri provati;
  - **E7:** con `negative_cts_offsets` il PTS di un keyframe IDR coincide con quello originale.
- **Verifica del revisore** (2026-11-05, `spikes/a3-stream-delivery/review/`, script e output t1–t9):
  - **t1:** con il comando di questa ADR il segmento di init è identico byte per byte fra l'esecuzione da 0 e un riavvio (FLAC e AAC);
  - **t4, t8:** HEVC a 23,976 fps con **GOP aperti** (CRA), B-pyramid, keyframe fuori griglia. Un riavvio esattamente a Bₖ dà PTS sbagliati alle leading picture del primo GOP: `13.546 13.546 13.587…` contro `13.504 13.545 13.587…` dell'esecuzione da 0, cioè un PTS doppio e un buco di 42 ms. Il primo `tfdt` differisce (13,629 contro 13,503). Dal secondo GOP in poi tutto coincide;
  - **t9:** su GOP chiusi (Long Test) i campioni del riavvio coincidono esattamente;
  - **t3:** su una traccia PGS reale (Blade Runner), senza `-copyts` un passaggio con `-ss 5` riscrive i cue sul punto di seek (6,000 → 1,000). Con `-copyts` la fusione dei due passaggi è identica byte per byte all'estrazione completa, a X = 5 e X = 6,5;
  - **t6:** senza `-flush_packets 1` il `.sup` resta a 0 byte fino alla fine; con il flag cresce con la lettura (10,7 → 21 → 49 → 101 → 119 KB);
  - **t7:** con la compensazione del seek, il muxer `hls` coincide su Long Test (keyframe sulla griglia), ma non sulla fixture con keyframe fuori griglia (da 0 il quinto segmento parte a 16,891 s, il riavvio taglia a 15,807 e 20,519 s; valori di `tfdt`);
  - **lettura di hls.js 1.7.4** (`passthrough-remuxer.ts`): `initPTS` viene dal tempo di decodifica del primo frammento caricato, della traccia audio se parte prima. Per questo `currentTime` = PTS originale + δ, con δ misurato fra 37 ms (E-AC-3 copiato, t9) e 178–203 ms (AC-3 copiato su GOP aperto, t4).
- **Sorgenti lette il 2026-11-05:**
  - [Jellyfin, DynamicHlsPlaylistGenerator.cs](https://github.com/jellyfin/jellyfin/blob/master/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs) e [DynamicHlsController.cs](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/DynamicHlsController.cs);
  - [hls.js `getMaxBufferLength`](https://github.com/video-dev/hls.js/blob/master/src/controller/base-stream-controller.ts) e [`Level.maxBitrate`](https://github.com/video-dev/hls.js/blob/master/src/types/level.ts): il buffer si calcola da `max(BANDWIDTH, bitrate misurato)`. `src/utils/error-helper.ts`: hls.js non legge `Retry-After`, ritenta i 5xx con un backoff proprio e non ritenta i 4xx;
  - [libpgs `pgs.ts`](https://github.com/Arcus92/libpgs-js/blob/main/src/pgs.ts), 0.9.0, MIT: il `.sup` si legge dallo stream della risposta, con `onProgress`.
- **Limiti delle evidenze:**
  - nessun remux reale; fixture sintetiche a 60 fps; GOP aperti solo sulla fixture x265 del revisore;
  - nessun browser con questi segmenti (F1c);
  - parser dei Cues non ancora scritto: va confrontato con la sonda sui sample;
  - DV P7 non misurato.

## Decisione

1. **Protocollo:** HLS con segmenti fMP4 (CMAF) per Direct Stream e Transcode, `stream.protocol = hls-fmp4`.
   - Audio **muxato** con il video, una traccia per stream; cambiare audio è una ripianificazione con riavvio alla posizione corrente.
   - Direct Play = `progressive`.
   - Per `hls-fmp4`, `stream.mimeType` è il tipo dei **segmenti** (`video/mp4; codecs="…"`), non della playlist, e porta entrambi i codec, video e audio (es. `codecs="hvc1.2.4.L153.B0, flac"`), letti dal segmento di init.
2. **Playlist VOD dell'intero film, segmenti su richiesta.**
   - `main.m3u8` è una playlist multivariante con una variante: `BANDWIDTH` (picco stimato per segmento), `AVERAGE-BANDWIDTH`, `CODECS` (la lista interna del parametro `codecs` di `stream.mimeType`), `RESOLUTION`, `FRAME-RATE`, `VIDEO-RANGE`.
   - La variante rimanda a `media-0.m3u8`: `EXT-X-VERSION:7`, `EXT-X-PLAYLIST-TYPE:VOD`, `EXT-X-MAP:URI="init-0.mp4"`, segmenti `seg-0-NNNNN.m4s`, `EXT-X-ENDLIST`. Nei nomi, 0 è l'indice della rendition.
   - `EXT-X-INDEPENDENT-SEGMENTS` solo quando ogni keyframe di confine è IDR. È il caso del Transcode, con IDR forzati; per il Direct Stream il tag si omette, salvo un indice che lo dimostri. Con un GOP aperto le RASL dipendono dal segmento precedente.
   - Gli `EXTINF` si scrivono con arrotondamento cumulativo, così la somma dei primi k coincide con Bₖ: hls.js reimposta `initPTS` quando lo scarto raggiunge max(durata, 1 s).
   - **Una risorsa presente nella playlist non risponde mai `404` finché la sessione è viva.**
3. **Confini dei segmenti:** durata obiettivo **4 s**.
   - Bₙ è l'ultimo keyframe indicizzato ≤ n·4 s, sulla timeline originale (Decisione 5). I duplicati si scartano, e un segmento sotto 0,5 s si unisce al precedente.
   - **Limite superiore:** un gruppo di GOP più lungo di `HLS_SEGMENT_MAX_S` (6 s) o più grande di `HLS_SEGMENT_MAX_BYTES` (32 MiB, stimati dalle posizioni dell'indice) si taglia ai keyframe interni. `EXT-X-TARGETDURATION` vale quindi al più 6 s, salvo un GOP singolo più lungo, che non si può tagliare col video copiato.
   - **Perché 32 MiB:** quota video di Chromium 150 MiB; buffer in avanti minimo dell'ADR 0005 = 1 × TD = 6 s a circa 128 Mbps di picco ≈ 92 MiB, più un segmento in append: con 64 MiB ≈ 156 MiB (oltre la quota), con 32 MiB ≈ 124 MiB. Il limite taglia solo i segmenti oltre circa 2 s di picco; quelli a bitrate basso non cambiano.
   - Con il Transcode i keyframe IDR si forzano sulla griglia da 4 s.
4. **Riavvio con pre-roll di un GOP.**
   - Un'esecuzione per il segmento k parte da **Kₖ, il keyframe indicizzato immediatamente prima di Bₖ**: `-ss Kₖ + 0,135`; per k = 0 parte da 0, senza `-ss`.
     - I Cues elencano ogni keyframe, quindi Kₖ è il GOP precedente. Con la sonda di ripiego l'indice conosce solo i confini, e Kₖ = Bₖ₋₁: la regola è la stessa.
     - Basta un GOP: le leading picture sbagliate stanno solo nel primo GOP di un'esecuzione (t4, t8).
   - Il segmenter scarta i frammenti il cui keyframe ha PTS (`tfdt` + composition offset del primo campione) < Bₖ.
   - Il raggruppamento in segmenti usa **sempre il PTS del keyframe, mai il `tfdt`**: su un GOP aperto il `tfdt` precede il PTS di 125 ms (t4).
   - **Controllo del primo keyframe tenuto:** il suo PTS si confronta con Bₖ in millisecondi sulla timeline originale, con tolleranza di 1 ms. Uno scarto è deterministico: il tentativo automatico del server (Decisione 7) riparte da un keyframe indicizzato ancora prima (due prima di Bₖ), mai con lo stesso comando. Solo se fallisce anche quello, `STREAM_FAILED`.
   - **Transcode (F1b.4, 2026-11-06).**
     - Un riavvio al segmento k ricodifica da **Bₖ₋₁**: un segmento di pre-roll, uno in più al tentativo automatico. Il segmenter scarta i frammenti prima di Bₖ.
     - Senza pre-roll, all'inizio dell'esecuzione l'audio convertito aveva il frame di priming dell'AAC, con un buco di 21 ms e un click; l'audio copiato partiva dal keyframe sorgente prima di Bₖ.
     - Gli IDR si forzano con una lista di tempi per esecuzione, non con `expr:`: dopo un seek il `t` di un'espressione conta dall'inizio dell'esecuzione.
     - **Tolleranza sul ritardo dell'IDR:** max(1,5 frame; 250 ms), oppure 1 s se il frame rate è ignoto.
     - **Verificato** dal segmento k, contro l'esecuzione da 0: audio convertito e copiato, GOP da 10 s, sorgente MPEG-TS, sorgente interlacciata.
   - Costo: un GOP letto in più a ogni riavvio, circa +0,2–0,4 s per seek a UHD; nel caso peggiore, con la sonda di ripiego (Kₖ = Bₖ₋₁), fino a un segmento, circa 0,5–0,7 s.
   - Comando di un'esecuzione, video copiato, su stdout:

     `-nostdin -noaccurate_seek -ss <Kₖ + 0,135> -i <file> -map 0:v:0 -map 0:a:<n>? -c:v copy [-tag:v hvc1 solo per HEVC] <audio> -copyts -start_at_zero -avoid_negative_ts disabled -output_ts_offset 10 -map_metadata -1 -map_chapters -1 -sn -dn -fflags +bitexact -f mp4 -movflags +frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets pipe:1`

     La mappa audio è facoltativa, per i file senza audio.
   - Il servizio scrive `…m4s.part` nello scratch e rinomina quando il segmento è completo. Serve l'init della prima esecuzione e controlla che quelli successivi siano identici (t1).
5. **Timeline.**
   - **La timeline originale è definita una volta sola come PTS − `start_time`**, cioè quello che un browser riporta in Direct Play. `-start_at_zero` (con `-copyts`) la applica all'esecuzione video e ai due passaggi dei sottotitoli; l'indice dei keyframe si salva in questo dominio, quindi Bₖ, Kₖ, `-ss` e `-t` partono tutti da 0.
   - I timestamp dei segmenti sono la timeline originale più un **offset costante di 10 s**, dichiarato nel nuovo campo `stream.mediaTimestampOffsetMs`: 10000 per `hls-fmp4`, 0 per il Direct Play.
   - `stream.startOffsetMs` vale 0 per ogni protocollo.
   - Il `currentTime` del player **non** coincide da solo con la timeline originale. hls.js prende `initPTS` dal tempo di decodifica del primo frammento caricato, quindi `currentTime` = PTS originale + δ, dove δ cambia col codec e con la posizione di partenza (37–203 ms misurati dal revisore).
   - **Un riavvio della pipeline non cambia la timeline: i cue restano validi; `timelineOffsetMs` si ricalcola a ogni `INIT_PTS_FOUND`, cioè con un nuovo player o quando hls.js reimposta `initPTS`.** I cue vengono dall'estrazione (Decisione 12), non dal processo del video.
   - Il client lo corregge a ogni `INIT_PTS_FOUND` con `timelineOffsetMs = initPTS·1000/timescale − mediaTimestampOffsetMs`, e tempo originale = `currentTime` + `timelineOffsetMs`. Lo usa nei due sensi: per posizioni e PGS, e per tradurre in tempo del player un seek a un tempo originale (ADR 0005).
6. **Seek:** il player chiede il segmento che vuole.
   - Se è pronto, si serve.
   - Se il processo lo produrrà entro 3 segmenti, la richiesta aspetta l'evento al più 8 s, poi `503` con `Retry-After`. hls.js non legge `Retry-After` e ritenta i 5xx con il suo backoff: l'header serve agli altri client, nessuno ci fa affidamento.
   - Altrimenti il processo si chiude e ne parte uno nuovo per k.
7. **Processi:** uno ffmpeg per sessione, con execa (`cancelSignal`, `cleanup`, stderr in un buffer circolare).
   - **Throttling per contropressione:** il servizio smette di leggere stdout oltre `DELIVERY_AHEAD_S` (30 s) davanti all'ultima richiesta.
   - **Chiusura:** prima si distrugge stdout, poi SIGTERM e SIGKILL dopo 2 s. Per un'esecuzione il cui output si butta (seek, ripianificazione) si manda subito SIGKILL. Un ffmpeg bloccato in scrittura su una pipe piena ignora SIGTERM.
   - **Si chiude** su stop, scadenza dell'heartbeat, ripianificazione, seek lontano, `DELIVERY_IDLE_KILL_S` (120 s) senza richieste, e spegnimento. Una ripianificazione emette un **nuovo token**: i locatori vecchi danno `410`.
   - **Errore di stream:** uscita di ffmpeg diversa da 0, oppure riavvio fallito.
     - Il servizio registra uscita e classificazione dello stderr, e fa un solo tentativo automatico. Per un riavvio fallito il tentativo parte un keyframe indicizzato prima (Decisione 4), mai con lo stesso comando.
     - Se fallisce ancora, il data plane risponde `500` `application/problem+json` con codice `STREAM_FAILED`.
     - **`STREAM_FAILED` è terminale per lo stream:** da quel momento ogni richiesta del data plane di quella sessione risponde subito `500` `STREAM_FAILED`, senza nuovi tentativi e senza consumare il limite dei 3 tentativi. Si recupera solo con `reportPlaybackFailure`.
     - Il web client, quando hls.js dà un errore fatale di rete o media su un 5xx dopo i suoi tentativi, chiama **da solo** `reportPlaybackFailure` con sospetto `unknown`. hls.js non legge il corpo della risposta.
     - Il server sceglie la dimensione sospetta e la modifica minima dal **proprio** registro del fallimento, non dal sospetto del client. È la ripianificazione automatica del doc 04 §8. Vale il limite del doc 04 §8: al più 3 tentativi automatici per `StartPlayback`, ripianificazioni e riavvii insieme.
   - **Fallimento di formato** (es. channelConfiguration 0): lo Stream Delivery lo segnala al Session Manager, che ripianifica col Decision Engine escludendo quel formato. Il motivo va in `reasons`: nessun cambio di gradino silenzioso.
   - **Scratch** a finestra (`DELIVERY_AHEAD_S` + `DELIVERY_BEHIND_S`, 30 + 30 s) sotto la quota `SCRATCH_MAX_BYTES`; si svuota a fine sessione e all'avvio.
8. **Indice dei keyframe.**
   - **Fonte primaria per gli MKV: i Cues**, letti da un parser EBML minimo, scritto a mano, che legge solo SeekHead e Cues. Va confrontato con la sonda a salti sui sample.
   - **Ripiego** per i file non MKV o senza Cues: la sonda a salti di ffprobe.
   - L'indice si calcola in un **job obbligatorio dopo `FileAnalyzed`** e si salva in `video-cache` sotto un sotto-path proprio (`/data/cache/delivery/keyframes/<impronta>`).
   - A `StartPlayback` un indice mancante si costruisce in modo sincrono dai Cues. Se è possibile solo la sonda lenta, `StartPlayback` risponde `503` con codice `STREAM_PREPARING` e `Retry-After`, e mette il job in testa alla coda. Il client mostra "in preparazione" e riprova.
   - Un MKV senza Cues rende lento anche il seek di ffmpeg (lettura lineare): la scansione completa non rende veloci i riavvii. La diagnostica segnala il file, con il consiglio di rifare il remux con l'indice.
9. **Confine estraibile (C1):**
   - il modulo `delivery` possiede le route del data plane, la tabella dei token, i processi, lo scratch, l'indice dei keyframe e i sottotitoli estratti;
   - espone l'interfaccia serializzabile del doc 03 §8: `start` → `StreamHandle` con locatori, `mimeType`, `bitrate`, `mediaTimestampOffsetMs` e disponibilità dei sottotitoli; `stop`; `status`;
   - il Session Manager possiede sessioni e heartbeat;
   - cache proprie in `/data/cache/delivery/`, separate dalle immagini, così un `video-worker` le può montare da solo.
10. **Direct Play:** Fastify con `@fastify/send` (Range, `206`/`416`, `ETag`).
    - Il file si risolve solo dal piano della sessione: root + path relativo, path reale controllato dentro la root.
    - Il token si cerca per SHA-256 in una mappa: un confronto "a tempo costante" non ha senso su una ricerca in mappa.
    - `{track}` si risolve sull'elenco delle tracce della sessione, mai unito a un path.
    - `410` a sessione chiusa, con una tombstone a scadenza (TTL); `Cache-Control: no-store` su tutte le risorse di sessione.
    - Token mascherato nei log di pino; se si accendono i log di accesso di Caddy, va filtrato.
11. **Audio** (il gradino lo sceglie il Decision Engine, doc 04 §4.3):
    - copia (l'E-AC-3 grazie a `delay_moov`);
    - FLAC alla profondità della sorgente;
    - E-AC-3 640k solo se il client lo dichiara;
    - AAC 5.1 640k e Opus 5.1 448k, sempre dopo `aformat=channel_layouts=5.1`; una sorgente 7.1 va a 5.1 per i formati lossy;
    - AAC stereo solo per un client stereo.

    Prima di rispondere a `StartPlayback`, lo Stream Delivery legge il segmento di init: ricava la stringa di codec esatta per `stream.mimeType` e controlla il channelConfiguration dell'AAC. Se è 0 vale il fallimento di formato della Decisione 7.
12. **Sottotitoli embedded:** al primo `StartPlayback` di un file con tracce che il client deve ricevere a parte, un processo estrae **tutte** le tracce.
    - **Comando** di un passaggio:

      `-nostdin -readrate <r> -noaccurate_seek -ss <P> -i <file> -map 0:s:<i> -c copy -copyts -start_at_zero -flush_packets 1 -f sup <i>.sup`, una coppia `-map`/output per ogni traccia; per il testo e l'ASS `-c:s webvtt -f webvtt <i>.vtt`.

      Senza `-copyts` i cue finiscono sul punto di seek; senza `-flush_packets 1` il file resta vuoto fino alla fine (t3, t6).

      **Aggiornamento F1b.4 (2026-11-06): niente più `-readrate`.**
      - **Perché:** ffmpeg 8 regola il passo sullo stream più lento non ancora finito. Una traccia di sottotitoli rada fa dormire la lettura a ogni cue. Misurato: 120 s di media in 232 s con readrate 10. L'estrazione restava quindi dietro la riproduzione.
      - **Come funziona ora:**
        - il video si copia in `framehash` su stdout;
        - il servizio legge quell'orologio e smette di leggere stdout quando ffmpeg è avanti rispetto a R × tempo trascorso; la pipe piena ferma ffmpeg.
      - **Misure:** su Windows e nell'immagine il passo medio è esattamente R. All'inizio di ogni passaggio la lettura va avanti di 30–46 s di media alla massima velocità (i buffer della pipe).
      - **Watchdog:** `SUBTITLE_EXTRACT_STALL_S` (60 s) ferma un passaggio il cui orologio e i cui file non avanzano, fuori dalle pause volute. Sostituisce il timeout fisso del passaggio.
    - **Passaggi:** il primo va da P = max(0, X − `SUBTITLE_PREROLL_S`) alla fine, dove X è la posizione di partenza della sessione e il pre-roll vale 60 s di default. Così il cue sullo schermo a X è nel primo passaggio. Il secondo copre [0, P₁), dove P₁ è il minimo, fra le tracce estratte, del primo PTS del primo passaggio. Se P = 0 basta un passaggio.
      - **Fine del secondo passaggio (F1b.4):**
        - con una traccia video il servizio ferma ffmpeg quando l'orologio supera P₁ + 5 s, e lo stop conta come successo; se il primo passaggio è vuoto, il limite è P;
        - `-t P₁` resta solo per i file senza video.
      - **Perché:** con `-t` in ingresso una traccia di testo decodificata, o una PGS rada, non finisce mai, e ffmpeg leggeva tutto il resto del file.
    - **Fusione:** concatenazione (il secondo davanti), con eliminazione dei duplicati per PTS, e rinomina atomica in `/data/cache/delivery/subtitles/<impronta>/`. Verificata identica byte per byte all'estrazione completa (t3, traccia da 10 s).
    - **I/O:** la lettura è limitata in byte da `SUBTITLE_EXTRACT_MAX_MBPS` (default 15 MB/s), con un passo R = max(1,1; limite / bitrate del file), regolato dal servizio come descritto sopra.
      - Il limite tiene l'estrazione sotto un terzo della capacità del bind mount NTFS (47–67 MB/s, S3). Accanto a un Direct Stream UHD (12,5–16 MB/s) restano circa 16–36 MB/s per i picchi di un seek.
      - Su un file oltre 13,6 MB/s (circa 110 Mbps) vale il minimo di 1,1×, quindi il limite viene superato di poco: l'estrazione deve restare davanti alla riproduzione.
      - La latenza di un seek durante un'estrazione sul bind mount reale non è misurata.
    - **Cache:** LRU con `SUBTITLE_CACHE_MAX_BYTES` (20 GB).
    - **Stato delle tracce:**
      - `switchWithoutRestart` riguarda solo lo stream: è true per una traccia `client_render` o `sidecar` che ha un URL;
      - lo stato dell'estrazione sta nel nuovo campo `availability` della traccia: `growing` mentre si estrae, `complete` dopo.
    - **Durante l'estrazione** l'URL della traccia è una sola risposta in streaming, senza `Content-Length`, che cresce fino alla fine del primo passaggio.
    - **Estrazione in coda:** l'URL risponde `503 STREAM_PREPARING` con `Retry-After`. Era il ripiego previsto; adottato in F1b.4, perché il web client aspetta già i `503`.
    - **Code:**
      - un'estrazione alla volta per tutti i file;
      - un primo passaggio passa davanti ai secondi passaggi in coda e ferma quello in corso;
      - l'estrazione che serve a un burn-in ha un posto suo, senza limite di lettura.
    - **Fine dell'estrazione:** il server pubblica l'evento `playback.subtitle_ready` (sessione, traccia) nel polling degli eventi (`listEvents`), la chiamata periodica che il client fa già. L'estrazione è per file e condivisa: l'evento esce per ogni sessione attiva su quel file, con il `sessionId` attuale di quella sessione. `reportProgress` risponde `204` senza corpo, e dargli un corpo non sarebbe additivo. Il client allora rilegge l'URL, che serve il file completo con Range (ADR 0005).
    - **Fallimenti (F1b.4):**
      - se fallisce il secondo passaggio, si serve il primo e il secondo si ritenta;
      - se si rinuncia al secondo passaggio, il primo si salva in cache come parziale, con un file marcatore accanto: si serve, e dopo il TTL dei fallimenti un nuovo avvio lo estrae di nuovo;
      - se fallisce il primo passaggio, la traccia passa a `complete` con l'evento, e l'URL risponde `503 MEDIA_UNAVAILABLE`;
      - un nuovo avvio che seleziona quella traccia la esclude subito, con una ripianificazione;
      - **Fallimento definitivo o transitorio:**
        - un `503 MEDIA_UNAVAILABLE` **senza** `Retry-After` vuol dire estrazione fallita per sempre: su una traccia `complete` il web client lo tratta subito come fallimento;
        - con `Retry-After` è un errore transitorio di un file (radice irraggiungibile, troppi file aperti), e il client riprova.
    - I `.srt` esterni si convertono alla richiesta. La codifica si ricava dai byte: UTF-8 se almeno il 90% delle sequenze multibyte è valido, altrimenti CP1252.
    - `SUBTITLE_PREEXTRACT` (default `off`) abilita l'estrazione all'ingest. In F1b.4 toglie solo la cancellazione delle estrazioni avviate; il job di ingest non c'è ancora.
13. **Dolby Vision verso il browser:**
    - P8.1 copiato com'è, con `hvc1`;
    - P7 con `-bsf:v hevc_metadata=remove_dovi=1` e `hvc1`: regola provvisoria finché H11 non è misurata, dichiarata nei motivi della sessione;
    - mai `-strict unofficial`, mai un box DV;
    - P5, e ogni DV senza un base layer HDR10, HLG o SDR (anche con base ignota) → `NO_COMPATIBLE_PLAN`, a ogni risoluzione: il tone-map HDR10 darebbe colori sbagliati (F1b.4).
14. **Buffer del browser:** `BANDWIDTH` e `AVERAGE-BANDWIDTH` nella playlist, più il campo additivo `stream.bitrate { peakBps, averageBps, audioBps }` nella sessione, per il limite audio di 12 MiB.
15. **Librerie:** nessuna nuova.
    - Lettore di box ISO-BMFF, parser EBML dei Cues e writer delle playlist scritti a mano, con test su fixture generate da ffmpeg.
    - Scartati mp4box.js 2.5.0 (BSD-3-Clause), più grande del bisogno, e hls-parser 0.16.x (MIT), inutile per due playlist fisse.
16. **Configurazione nuova** (ADR 0006):
    - `HLS_SEGMENT_TARGET_S=4`, `HLS_SEGMENT_MAX_S=6`, `HLS_SEGMENT_MAX_BYTES=32MiB`;
    - `DELIVERY_AHEAD_S=30`, `DELIVERY_BEHIND_S=30`, `DELIVERY_IDLE_KILL_S=120`;
    - `SUBTITLE_EXTRACT_MAX_MBPS=15`, `SUBTITLE_PREROLL_S=60`, `SUBTITLE_PREEXTRACT=off`, `SUBTITLE_CACHE_MAX_BYTES=20GB`, `SUBTITLE_EXTRACT_STALL_S=60` (F1b.4).

**Runner-up:**
- protocollo: DASH CMAF;
- segmenter: il muxer `hls` di ffmpeg con playlist EVENT;
- indice: la sonda a salti come fonte primaria, se il parser dei Cues risultasse inaffidabile;
- sottotitoli: un'uscita in più del remux, per un host con I/O molto scarso.

## Conseguenze

- **Più facile:**
  - il player vede un film normale, con la barra di seek completa;
  - la timeline originale si ottiene da un solo offset, ricalcolato dal client a ogni `INIT_PTS_FOUND`;
  - i riavvii sono invisibili anche con GOP aperti. Regola verificata in F1b (2026-11-05), su ogni confine di segmento: il video di un riavvio è identico byte per byte; l'audio copiato ha gli stessi byte dei campioni e PTS entro 1 ms; l'audio convertito ha lo stesso numero di frame e PTS entro 1 ms (i byte codificati dipendono dallo stato dell'encoder, quindi non coincidono). Per l'audio copiato da MKV ffmpeg ricalcola i tempi dal primo pacchetto dopo il seek, e su alcuni confini il `tfdt` si sposta di una frazione di millisecondo (0,167 ms a 48 kHz): lo scarto è sotto la soglia udibile. Per l'audio convertito i frame dell'encoder sono ancorati alla timeline da 0, e lo scarto misurato è 0. Le lacune sotto 0,1 s nell'audio sorgente possono dare uno scarto fino a 100 ms al punto di riavvio;
  - il throttling non usa segnali, quindi funziona uguale su Windows e Linux;
  - la stringa di codec e il controllo dell'AAC vengono da ciò che si serve davvero;
  - `video-worker` prende il modulo `delivery` così com'è, con le sue cache.
- **Più difficile:**
  - lettore di box, parser dei Cues e segmenter sono codice nostro, critico, da coprire con test d'integrazione su ffmpeg reale;
  - la prima volta, i sottotitoli di un file costano una lettura completa;
  - `StartPlayback` in Direct Stream aspetta il segmento di init (0,4–0,8 s misurati dal bind mount), e un file senza Cues né indice pronto risponde `STREAM_PREPARING`.
- **Test d'integrazione richiesti in F1b:**
  - fixture HEVC a 23,976 fps con GOP aperti: i PTS di ogni campione di un riavvio confrontati con quelli dell'esecuzione da 0 (come t8);
  - fixture con `start_time` diverso da 0: indice, Bₖ, `-ss`, `-t` e PTS dei segmenti (meno 10 s) devono stare tutti sulla timeline PTS − `start_time`, grazie a `-start_at_zero`;
  - parser dei Cues confrontato con la sonda a salti sui sample;
  - fusione dei passaggi dei sottotitoli su una traccia PGS reale;
  - controllo dell'`esds` a ogni aggiornamento di ffmpeg.
- **Da verificare in F1c**, prima di accettare in via definitiva il dettaglio dei flag:
  - Direct Play di un file con `start_time` diverso da 0: che il browser riporti davvero PTS − `start_time`;
  - estrazione in coda: libpgs e `<track>` con un primo byte lento (ripiego `503` + `Retry-After`);
  - hls.js 1.7.4 nei tre browser con `negative_cts_offsets` (`trun` v1) e l'offset costante. Se fallisce, si toglie il flag e il client compensa lo spostamento con lo stesso `timelineOffsetMs`;
  - `timelineOffsetMs` dopo un riavvio, confrontato con il PTS originale;
  - libpgs su un `.sup` in streaming;
  - **WebVTT che cresce con `<track>`:** non è verificato che il browser aggiunga i cue mentre la risposta cresce. Ripiego: `fetch` + `VTTCue`;
  - giunzione audio fra segmenti di esecuzioni diverse: sovrapposizione o buco fino a un frame audio, da misurare;
  - l'E-AC-3 7.1 copiato verso Edge.
- **Da rivedere:**
  - quando arriva un sample DV P7 (H11);
  - **una sola estrazione di sottotitoli alla volta:** con 3 sessioni, i sottotitoli del secondo e del terzo film aspettano un passaggio intero;
  - con 3 sessioni UHD sul PC Windows (I/O del bind mount);
  - quando servisse il cambio audio senza riavvio (rendition separate);
  - con l'ADR sull'accelerazione hardware: cambia solo l'encoder del Transcode.
- **Contratto** (modifiche additive, P8, applicate in `services/video/contract`):
  - `stream.bitrate { peakBps, averageBps, audioBps }` e `stream.mediaTimestampOffsetMs`;
  - `availability` (`complete` | `growing`) sulle tracce di sottotitoli della sessione; `switchWithoutRestart` riferito solo allo stream;
  - l'evento `playback.subtitle_ready`;
  - `startOffsetMs` = 0 per ogni protocollo;
  - `getHlsResource`: `503` con `Retry-After`, mai `404` per una risorsa della playlist a sessione viva, `media-N.m3u8` fra le risorse;
  - `startPlayback`: `503` `STREAM_PREPARING`;
  - codici `STREAM_FAILED` e `STREAM_PREPARING`; `MIME_TYPE_UNSUPPORTED` e `STREAM_FAILED` nel vocabolario di `FallbackRequest.error`;
  - `getSubtitle`: risposta in streaming durante l'estrazione.
- **Dipendenze:**
  - ADR 0001: execa, `@fastify/send`, pino;
  - ADR 0004: token nel path, nomi relativi, modifiche additive;
  - **ADR 0005:**
    - build **light** di hls.js, perché l'audio è muxato e non ci sono rendition separate;
    - `autoStartLoad: false`;
    - `timelineOffsetMs` da `INIT_PTS_FOUND` e `mediaTimestampOffsetMs`, nei due sensi;
    - buffer da `BANDWIDTH` e `stream.bitrate`, con il minimo pari a 1 × la durata obiettivo;
    - `reportPlaybackFailure` automatico (`unknown`) su un 5xx fatale;
    - `availability` e rilettura del `.sup` a `playback.subtitle_ready`;
    - nessun `ChangeTracks` per una traccia `growing`;
    - errori di un motore in sostituzione ignorati (un `410` del token vecchio non deve diventare un nuovo `StartPlayback`);
    - "in preparazione" con nuovo tentativo su `STREAM_PREPARING`;
  - ADR 0006: `flush_interval -1`, scratch con quota, `video-cache` con il sotto-path `delivery/`, jellyfin-ffmpeg 8.1.3, chiavi del `.env`;
  - ADR 0002: nessun cambiamento di schema;
  - Job Runner (doc 02 §3.12): job dell'indice dei keyframe dopo `FileAnalyzed`, con priorità alta su `STREAM_PREPARING`.
