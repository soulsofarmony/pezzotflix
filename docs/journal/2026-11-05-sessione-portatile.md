# Sessione sul portatile — 2026-11-05

Diario della sessione ripresa sul portatile dal [passaggio di consegne](2026-11-06-handoff.md). Si aggiorna a ogni commit importante. **Claude: per riprendere leggi `CLAUDE.md`, poi questo file.**

## 1. Fatto

| Commit | Cosa |
|---|---|
| `6a7b8ae` | Ambiente del portatile in CLAUDE.md, worktree degli agenti ignorati da git |
| `593b836` | **S4, test live TMDB** con la chiave del proprietario, e revisione dell'ADR 0007. TMDB resta il provider dei metadata in italiano; l'identificazione resta su Wikidata (opzione A confermata) |
| `2ed688f` | **F1a.1**, moduli library (scansione, fingerprint, spostamenti, radici smontate, sidecar) e analyzer (ffprobe → MediaFacts). 242 test |
| `3b79530` | Standard di libreria: cartelle dei NAS ignorate, collegamenti simbolici non seguiti |
| `b99d99a` | ADR 0007: il contatto Wikidata di default è l'URL pubblico del repository |
| `128f531` | **S2 chiuso**: report, revisione (54 rilievi applicati), propagazione nei doc 02/03/04, nuove decisioni P5, I5, I6 e ipotesi H11 |
| `84f26e5` | Contratto: campi `audioTrackSelection` e `displayHdr`, vocabolario fisso dei codec, definizioni di `delivery`, `stream.mimeType` con i `codecs` |
| `9d46b07` | Gateway: `index.html` e le rotte della SPA con `Cache-Control: no-cache`, così una nuova build arriva subito |
| `21d61b0` | **F1a.2**, identifier e scrittura nel catalogo: parser dei percorsi, catena Wikidata → TMDB (ADR 0007 opzione A), coda "Da verificare", ripresa giornaliera dei casi in sospeso. 561 test |
| `a1c6d13` | Tipo di job `metadata.enrich`, condiviso fra catalogo e metadata |
| `8a5f4fa` | Gateway: compressione degli asset testuali del web client |
| `8a6138a` | Contratto: campi ed errori dello streaming dall'ADR 0003 (`STREAM_PREPARING` 503, `STREAM_FAILED` 500, disponibilità dei sottotitoli, bitrate) |
| `9eb90f5` | **ADR 0003 (streaming) e 0005 (web client) accettati**; la catena di progetto è chiusa (ADR 0001–0007 tutti accettati) |
| `c15320d` | **F1b.0**, tipo condiviso del piano di riproduzione e porta di Stream Delivery |
| `529d34f`, `75a8682` | Porte per profili e playback (preferenze, avanzamento, ripresa) e posizione degli item nel catalogo |
| `9c96f38` | **F1a.3**, lettura del catalogo e admin: home, ricerca, figli, coda "Da verificare" con risoluzione manuale, conferma delle radici sospese dopo una sparizione di massa, stato dell'ingest. 711 test |
| `8ad6a84` | Solo episodi con un file fra i discendenti riproducibili; ultima scelta delle tracce nella porta dei profili |
| `c08a5ec` | **F1b.1**, profili e stato di visione: progressi, cronologia, watchlist, "continua a guardare", prossimo episodio. 818 test |
| `e5c57c1` | **F1a.4**, metadata, arricchimento e locandine: adapter TMDB e Wikidata, cache locale con scadenza, locandine validate e salvate per contenuto, pulizia delle orfane, attribuzioni. 960 test; test live TMDB e Wikidata verdi |
| `3e2b8c1` | **F1b.2**, motore di decisione e gestore delle sessioni: scelta della versione per qualità (P6), audio per lingua, qualità e conversione minima, tracce ricordate per file, ripianificazione automatica (3 tentativi), sessioni concorrenti, attesa senza stream mentre l'indice si prepara. Due revisioni approfondite e una rilettura. 1161 test |
| `8111756` | **F1c**, web client: profili, Home, catalogo, ricerca, dettaglio, player (Direct Play e HLS, PGS e WebVTT, ripianificazione automatica), admin "Da verificare", attribuzioni. Revisione del player con correzioni (posizione di ripresa, motore staccato durante i cambi). 349 test |
| `4c60f78` | **F1b.3**, Stream Delivery: indice dei keyframe, token, Direct Play con Range, HLS fMP4 con segmentatore proprio; riavvii con video identico e audio convertito allineato (scarto misurato 0 ms). Due revisioni approfondite e una rilettura. 1396 test |
| `712a7af` | Diario e checklist aggiornati |
| `5da30a8` | **Richieste dal web client:** titolo della serie sugli episodi, riga "prossimo episodio" in Home, motivi di `session_terminated`, campo "sessione chiusa" sul 422, stato di visione che segue un file ricollegato (migrazione 0003), `ANALYZER_VERSION` a 2 con nuova analisi dei file vecchi |
| `5acca04` | **F1b.4**, sottotitoli interni al file e transcode software fino a 1080p. Estrazione in due passaggi con passo regolato dal servizio (con ffmpeg 8 `-readrate` restava dietro la riproduzione), cache con file parziali, burn-in PGS e testo, tone-map HDR, deinterlacciamento, riavvii del transcode identici all'esecuzione da 0. Corretta anche una corsa allo spegnimento di F1b.3. Due revisioni approfondite, tre giri di correzioni, due riletture. 1561 test video, 366 web |

## 2. In corso

- **Prova dell'app da parte del proprietario**, anche dall'iPad sulla rete locale. Problema aperto: il portatile non riesce a rispondere all'iPad, probabilmente per l'indirizzo Wi‑Fi privato, che cambia.

## 3. Prossimi passi

1. **F2**: stack in Compose, test end-to-end Playwright (riproduzione, streaming, regressione di S2, accessibilità) sui sample, revisione approfondita finale, correzioni.
2. Report finale per il proprietario.

## 4. Lacune note, da riprendere

- **Nessun timeout sulle chiamate a Stream Delivery**: un avvio che si blocca ferma anche gli avvii successivi dello stesso profilo. Oggi lo limita il timeout di avvio di Delivery; servirà quando Delivery andrà in un container separato.
- **Conteggio degli avvii bloccati in memoria**: si azzera al riavvio del servizio.
- **Motivi della sessione in inglese** (`decision/reasons.ts`): vanno tradotti in italiano in F2.
- **Riproduzione e stato di visione:**
  - "ultima visione" ignora i segni manuali;
  - un 422 su `reportPlaybackFailure` non porta il campo "sessione chiusa";
  - un segno manuale dopo un completamento non si vede;
  - nel web client la tolleranza "già posizionato" è di 6 s.
- **Sottotitoli (F1b.4):**
  - **Limite di lettura:** vale in media. All'inizio di ogni passaggio la lettura va avanti di 30–46 s di media alla massima velocità; da misurare in F2 sul bind mount reale.
  - **Estrazione all'ingest:** il job (`SUBTITLE_PREEXTRACT`) non c'è.
  - **Spazio:** i file di lavoro non contano nel limite della cache.
  - **Burn-in di un sottotitolo testuale interno al file:**
    - su un remux grande serve una lettura completa di 5–10 minuti, oltre l'attesa di 60 s del client;
    - attivato a metà film, ferma il video per tutta l'estrazione;
    - mancano i font allegati all'MKV.
  - **Errori dei file da ffprobe:** riconosciuti dal testo inglese dei messaggi; una locale diversa nell'immagine li farebbe diventare "in preparazione".
- **Transcode (F1b.4):**
  - nessun limite ai thread di x264;
  - un DV con base ignota dà `NO_COMPATIBLE_PLAN`;
  - l'HDR 1080p60 con tone-map è misurato solo a 24 fps (85 fps di codifica).
- **Spegnimento:** ora aspetta gli avvii in corso; uno bloccato su un mount di rete appeso lo ritarda (Docker poi chiude il container).
- **Flag di revisione dei metadata** non salvato (ADR 0007 §2/§3): per ora solo un warning nel log.
- **Autore e licenza delle immagini Commons** non salvati: serve una migrazione della tabella `artwork`.
- **Job:** manutenzione dell'identifier e dei metadata scrive direttamente sulla tabella dei job; va sostituito da una funzione della porta `JobQueuePort`.
- **Ultima scelta delle tracce** persa quando un titolo viene completato.
- **Token del profilo** firmato, più severo di quanto chiede l'ADR 0004: va bene così, da annotare nell'ADR alla prossima revisione.
- **Ricerca:** la scansione per sottostringa sull'indice FTS costa O(righe); va bene per una libreria domestica.
- **Locandine orfane:** la pulizia scorre tutte le cartelle una volta al giorno; il blocco contro le scritture concorrenti vale per un solo processo.

## 5. In attesa del proprietario

- **Verifica dei colori su un monitor SDR** in Chrome, Edge e Firefox, anche con un remux UHD vero con metadata statici: decide **P5**. Se fallisce si riapre P2.
- **Ascolto 5.1** delle clip c1–c7 (`spikes/s2-browser-playback/index.html`). Serve un'uscita HDMI verso l'AVR: il PC originale ha solo uscite stereo.
- **Un sample Dolby Vision profilo 7** (UHD Blu-ray), per H11.
- Percorsi reali della libreria, modello della TV, ADB, eARC, porta 8080 nel firewall.

## 6. Scadenze

- **Entro il 2027-05-05: cancellare `spikes/s4-identification/out/`.** Contiene risposte TMDB e, per i termini (§1.C), non si conservano oltre 6 mesi.
