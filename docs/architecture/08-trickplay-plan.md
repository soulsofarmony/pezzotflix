# 08 — Piano del trickplay (F4)

- **Stato:** approvato da Claude, 2026-11-27, dopo un passaggio di `design-reviewer` insieme all'ADR 0009.
- **Avanzamento:** T1 ✅ (`5a56b9b`, ripiego `d464c4a`), T2 ✅ (`bcc832a`, provato dal vivo in Chrome), T3 ✅ (`97949e2`, provato sull'emulatore Android TV 11). Ricostruzione della libreria fatta sul fisso il 2026-11-27. Da fare: la prova sulla TV vera (§5.4) e la convivenza col playback (§5.2).
- **Base:** [ADR 0009](../adr/0009-trickplay-anteprime-seek.md); [ADR 0003](../adr/0003-streaming-hls-fmp4-segmenter.md) D8–D10 (keyframe index, confine di Delivery, risorse di sessione); [ADR 0004](../adr/0004-contratto-api-openapi-3-1.md) (contratto); [ADR 0005](../adr/0005-web-client-react-vite.md) e [ADR 0008](../adr/0008-client-tv-kotlin-compose-media3.md) (client).
- **Richiesta:** proprietario, 2026-11-27: "scorro sulla timeline col mouse e, stile Netflix, mi compare il riquadro con la preview di quella scena".

## 1. Obiettivo

Su ogni film, episodio ed extra della libreria:
- nel **browser**, passando il mouse sulla barra di seek (o trascinandola) compare il fotogramma di quel punto con l'ora;
- sulla **TV**, sinistra/destra aprono lo scorrimento con l'anteprima; OK conferma, Indietro annulla.

Le anteprime si generano da sole in background, nei momenti senza visione, per i file nuovi e una volta per quelli già in libreria. La riproduzione non cambia: niente attese all'avvio, nessuna modifica a decisione, stream o posizioni.

## 2. Processo

Tre slice in sequenza, ciascuna affidata a un agente `module-implementer` nel suo worktree.

- **T1 (server)** tocca Stream Delivery. È una zona critica per CLAUDE.md, ma qui il lavoro è un'aggiunta a lato che non tocca la Decision Engine né il percorso dello stream. Scostamento deliberato dalla revisione pesante: **un solo `code-reviewer`**, mirato su tre punti:
  - la rotta nuova: token, 410, nessun path controllato dal client;
  - il job: processo figlio, cache atomica, esito, rinvio durante il playback, arresto;
  - la composizione della sessione.
- **T2 (web)** e **T3 (TV)** sono client: le controlla l'orchestratore, con un occhio in più alla ri-pianificazione (nuovo token, nuove griglie).

Ogni slice finisce con i test e una prova vera. Docker, la TV e il browser si usano un agente alla volta.

## 3. Slice

### T1 — Server: generazione, cache e consegna

0. **Misura con gli argomenti finali**, prima di scrivere il codice. Nel container, con `nice -n 10` e i thread limitati, su tre file:
   - un re-encode 4K HDR (2001);
   - il remux DV ibrido di Arancia meccanica (56 GB, GOP corti);
   - un 1080p SDR.

   Per ciascuno si registrano tempo, CPU media e memoria di picco del processo. Si prova anche HLG su un campione sintetico. I numeri vanno nelle Evidenze dell'ADR 0009, e il timeout del job si ricava dal throughput misurato, con un minimo.
1. **Contratto** (`services/video/contract/`):
   - schema `Trickplay` e campo nullable `trickplay` in `PlaybackSession` (ADR 0009 D4);
   - rotta `GET /video/media/s/{sessionToken}/trickplay/{sheet}`;
   - tipi TS rigenerati, `npm run verify` verde, **`gradlew :api:check` verde** (gate del client Kotlin per ogni cambio del bundle).
2. **Tipi condivisi:**
   - `JOB_TYPES.deliveryTrickplay` e il suo payload con i fatti di ADR 0009 D5, copiati dai MediaFacts (`shared/job-types.ts`);
   - `StreamHandle.locators.trickplay` (`shared/ports.ts`).
3. **Analyzer:**
   - accoda `delivery.trickplay` dopo ogni probe riuscito, alla stessa condizione del keyframe index;
   - all'avvio, una query su `media_file` (file presenti con video, root online) con `NOT EXISTS` sul job con la chiave attuale accoda solo quelli che mancano.
4. **Delivery** (nuovo `trickplay.ts`, più l'aggancio in `service.ts`, `handlers.ts`, `index.ts`):
   - **Argomenti ffmpeg:** costruiti da una funzione pura e testata, con `nice -n 10`, `-threads` limitato, `-skip_frame nokey`, tempi riportati a zero sullo start_time del file, `fps=1/<passo>:start_time=0`, SAR, scala, tone mapping per PQ/HLG, `tile`, `-start_number 0`.
   - **Generazione saltata** per DV profilo 5 e per HDR senza `tonemapx`, con un controllo del filtro all'avvio.
   - **Esito:** si giudica dal conteggio dei riquadri prodotti rispetto a quelli attesi (ADR 0009 D4). Nel manifest stanno `count`, il numero di griglie, i parametri, lo stamp e la versione.
   - **Cache:**
     - si scrive in `/data/cache/delivery/trickplay/<fileId>/.tmp-<uuid>/` e si rinomina in `<fileId>/<stamp>/`, poi si cancellano gli stamp vecchi;
     - all'avvio si cancellano le `.tmp-*` rimaste;
     - `fileId` va validato con la stessa regex del KeyframeCache.
   - **Job:**
     - concorrenza 1, 3 tentativi;
     - se ci sono stream attivi, `retryAfterMs` di 5 minuti senza consumare tentativi;
     - se la cache vale, termina subito;
     - timeout misurato al punto 0;
     - kill all'arresto del servizio.
   - **Sessione:** `start` mette in `StreamHandle.locators.trickplay` griglie e parametri se la cache vale per lo stamp del plan, altrimenti `null`, e accoda il job con la chiave normale.
   - **Rotta:** risolve il token come le altre risorse di sessione (404 o 410), serve solo `sheet-N.jpg` dello stamp della sessione con `N` nell'intervallo, `Cache-Control: no-store`, e non aggiorna l'attività dello stream (`lastRequestAt`, `touchOther`).
5. **Playback** (`modules/playback/view.ts`): `PlaybackSession.trickplay` si compone da `StreamHandle.locators.trickplay`. Nessun'altra modifica a sessioni o plan.
6. **Configurazione:** `TRICKPLAY_ENABLED` (default `true`) in `config.ts`, nel `.env.example` e nella documentazione del deploy.
7. **Test:**
   - argomenti ffmpeg: SDR, PQ, HLG, DV P5 saltato, anamorfico, start_time non nullo, oltre 2000 riquadri;
   - cache: stamp o versione cambiati, `.tmp` orfana, stamp vecchi cancellati;
   - job con ffmpeg finto: successo, output corto, timeout, rinvio con stream attivo;
   - backfill: un job già fatto o fallito con la chiave attuale non si riaccoda;
   - rotta: token sconosciuto 404, sessione chiusa 410, griglia fuori intervallo, nome non conforme, attività non toccata;
   - sessione con e senza anteprima, e dopo una ri-pianificazione;
   - **integrazione con l'ffmpeg vero** (nel container, perché `tonemapx` c'è solo lì): sorgente sintetica con il timecode impresso nel video e start_time non nullo (`-output_ts_offset`). Controlla che il riquadro `i` mostri circa `i × 10 s`, oltre a numero e dimensioni dei riquadri.

### T2 — Web client

- **Componente** `SeekPreview` in `clients/web/src/features/player/`:
  - si attiva su `pointermove` sopra la barra (`seekWrap` in `PlayerPage.tsx`) e durante lo scrub che esiste già;
  - l'indice del riquadro è `min(count − 1, round(valoreBarraMs / intervalMs))` (ADR 0009, note di costruzione), **senza conversioni**: la barra (`positionMs`, `durationMs`, `seekTo`) è già sulla timeline originale;
  - il riquadro si mostra con un `div` a `background-image` e `background-position`, scalato via CSS, sopra il puntatore e dentro i bordi del player, con l'ora sotto.
- **Caricamento:** le griglie si caricano con `new Image()` alla prima necessità e restano in una mappa per la sessione. Mentre la griglia arriva si vede solo l'ora.
- **Ri-pianificazione:** con un nuovo `trickplay` (nuovo token) la mappa si svuota.
- **Senza anteprima:** solo l'ora sopra il puntatore.
- **Test** (Vitest + Testing Library): indice e posizione, bordi, assenza di `trickplay`, ri-pianificazione.
- **Prova vera:** sul fisso, in Chrome, con un 4K HDR in HLS, un 1080p in Direct Play e il 576p anamorfico (Todo modo). Il fotogramma deve corrispondere al punto in cui riparte il film dopo il click.

### T3 — Client TV

- **Prerequisito:** JDK e SDK Android sul fisso (oggi non ci sono), installati dall'orchestratore come da [clients/tv/README.md](../../clients/tv/README.md), così la TV si costruisce e si prova da qui.
- **`:api`:** client rigenerato dal contratto di T1.
- **Modalità scorrimento** (`ui/player/`):
  - entra con sinistra/destra a controlli nascosti, quando `trickplay` c'è. A controlli visibili sinistra/destra continuano a spostare il focus tra i pulsanti: la barra non è un elemento con focus;
  - all'ingresso si ricorda posizione e stato (in riproduzione o in pausa), si mette in pausa e compaiono barra, anteprima e ora del punto scelto;
  - ogni pressione sposta di 10 s. Tenendo premuto, il passo sale a 30 s dopo 1 s e a 60 s dopo 3 s;
  - OK e Play/Pausa confermano con `seekTo` sul punto scelto e riprendono la riproduzione;
  - Indietro annulla, prima di ogni altro uso di Indietro: torna alla posizione e allo stato di prima;
  - i report di avanzamento durante lo scorrimento mandano la posizione vera;
  - avanti e indietro veloce (tasti media) e il comportamento senza anteprima restano quelli di oggi.
- **Immagini:**
  - le griglie si caricano con Coil e l'OkHttp dei media, a `Size.ORIGINAL` (un ridimensionamento sposterebbe i ritagli), senza cache su disco (gli URL portano il token);
  - una LRU propria di 2 griglie decodificate, separata dalla cache in memoria dei poster;
  - si disegna il ritaglio con `drawImage(srcOffset, srcSize)`;
  - si precarica la griglia del punto di partenza all'ingresso nello scorrimento;
  - alla ri-pianificazione le griglie si scartano.
- **Test:** unit test del controller di scorrimento (passo, accelerazione, conferma, annullamento con ripristino dello stato, posizione dei report) e test Compose sull'overlay.
- **Prova vera:** emulatore, poi la TV del soggiorno con un 4K HDR in Direct Play.

## 4. Documenti da aggiornare

- All'accettazione dell'ADR 0009:
  - doc 02 §3.7 (l'Artwork Store non genera il trickplay) e §3.11 (Delivery sì);
  - doc 03 (`trickplay` nella PlaybackSession, non più `[futuro]`; `locators.trickplay` in §8);
  - doc 04 §9 (rimanda all'ADR);
  - README degli ADR.
- A fine lavoro:
  - CLAUDE.md, con il passo 10 nella checklist;
  - il journal, con le misure di §5;
  - [clients/tv/README.md](../../clients/tv/README.md), con i tasti della modalità scorrimento.

## 5. Prova finale sul server di casa

1. **Ricostruzione della libreria:** tempo totale e spazio usato per i file attuali.
2. **Convivenza con il playback:**
   - un 4K in Direct Play sulla TV, poi un Direct Stream e un Transcode 1080p nel browser, mentre un job di trickplay è già partito: nessuno scatto e nessun buffering in più rispetto a oggi;
   - con una visione in corso, un job nuovo non parte e si rimanda.
3. **Colori:** anteprime di un HDR10 (2001), dell'ibrido DV (Arancia meccanica) e di un SDR, controllate a vista.
4. **Browser e TV:** l'anteprima segue puntatore e telecomando. Dopo la conferma il film riparte dal punto mostrato, con resume e avanzamento corretti.
5. **File nuovo:** un film portato in libreria ha l'anteprima pronta dopo la scansione, appena non c'è una visione in corso, senza riavvii.

## 6. Rischi

| Rischio | Effetto | Contromisura |
|---|---|---|
| WSL limitato a 3 GB e decodifica 4K | ffmpeg ucciso per memoria | memoria di picco misurata in T1.0; thread limitati; il marcatore `interrupted` non si cancella al riavvio |
| CPU e bind mount condivisi con lo streaming | scatti durante la visione | job rimandato con stream attivi; nice 10; prova §5.2 |
| Remux con GOP corti | generazione lenta | misura in T1.0; B2 se serve (ADR 0009) |
| Keyframe radi (GOP lunghi) | anteprima lontana dal punto fino a ~5 s | accettato; B2 se il proprietario lo nota |
| TV a 32 bit con poca RAM | memoria esaurita nello scorrimento | LRU propria di 2 griglie |
| File con errori del contenitore (come 2001) | output parziale | esito giudicato dal conteggio dei riquadri; il film resta riproducibile |
