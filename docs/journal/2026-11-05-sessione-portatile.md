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
| `8466e7e` | Diario e checklist aggiornati |
| `f80caf5` | **Motivi di riproduzione in italiano** per chi guarda (`decision/reasons.ts`), con i nomi delle modalità del player |
| `5808b1e` | **F2a**, stack in Compose: immagine del gateway con il web client, health check attivo e `503` in JSON quando il Video Service non risponde, una sola rete `platform` (quella `internal` bloccava Wikidata e TMDB). Test end-to-end: setup dello stack, smoke via API (Direct Play con Range, Direct Stream e ripresa, sottotitoli PGS e WebVTT, Transcode) e test nei browser su Chromium, Chrome, Edge e Firefox: 74 passati, 20 saltati per codec o sample mancanti. Misure sul bind mount (ADR 0003, decisione 12). Nel web client: nomi accessibili, "Riprendi da" subito dopo il player, scorciatoie attive all'apertura del player. 1592 test video, 371 web |
| `7dbfef5` | Misure di F2a nei documenti (ADR 0003 decisione 12, doc 05), Firefox nel gate dell'ADR 0005, stato della revisione finale |
| `5d2cc18` | **Revisione F2, web client fuori dal player:** "il servizio non risponde" per i `5xx` e il servizio giù, ripetizione degli errori transitori finché la pagina è aperta (con `Retry-After`), dati in cache a schermo, "Correggi" nel dettaglio di un caso, watchlist nascosta su stagioni ed episodi, etichette in italiano |
| `ec718e4` | **Revisione F2, deploy:** token delle sessioni mascherati nei log del gateway, `421` per un Host estraneo (`PZF_HOSTS`), health check più tollerante, `404` vero per un asset mancante, utente fisso con `MEDIA_GID`, volume dei segreti, bind della libreria che non crea la cartella, immagini mai scaricate, backup nel README. Gate e2e severo: un sample mancante fa fallire, salvo `PZF_E2E_ALLOW_SKIP` |
| `9639ed4` | ADR 0006, aggiornamento F2 per gateway e Compose |
| `a5d698a` | **Revisione F2, riproduzione:** motivo della chiusura sul `410`, file sparito durante una ripianificazione → `503` con `sessionClosed`, tentativi esauriti → `500`, timeout della sessione a 150 s, il player libera il posto quando rinuncia, token del profilo fisso per sessione, `5xx` definitivo al primo errore (il test della ripianificazione forzata passa da 31 s a 9 s), WebVTT che cresce via `fetch` |
| `4a6b9c1` | Doc 04 §8 "Precisazioni decise in F2", ADR 0003 e 0005 aggiornati |
| `910ad92` | **Revisione F2, ingest e dati** (tre giri di revisione): film diversi in una cartella comune non vengono più collegati al primo, anno preso dalla cartella solo per un titolo tradotto, tagli come edizioni e parole di release come versioni, migrazioni con chiavi esterne spente e controllo dopo (prima cancellavano progressi e stato di visione), backup giornaliero verificato con retention 7+4, copia prima di una migrazione solo se serve, job che falliscono solo dopo due interruzioni, `/healthz` con `503` quando il servizio non sta bene. 1731 test video, 509 web |
| `1afffe2` | Standard di libreria, ADR 0002, doc 01 e diario allineati alle correzioni. **Test end-to-end finali** su uno stack ricostruito da volumi vuoti: 74 passati, 20 saltati (sample c4 e c7 mancanti, HEVC assente in Edge e Firefox su questo portatile), 0 falliti, in 5,2 minuti; nel log del gateway nessun token in chiaro |
| (questo commit) | **Dopo l'MVP, item provvisori:** un file che aspetta Wikidata o TMDB compare subito col titolo dal nome del file ("In attesa"), si guarda, e quando arriva l'identificazione progressi, "visto", cronologia e watchlist passano al titolo vero (migrazione 0004). Le sessioni aperte seguono il file; il web client va al titolo nuovo. Tre giri di revisione (unione di copie che perdeva i progressi, sessioni chiuse per errore, "visto" sul film sbagliato, adozione incompleta). 1697 test video più 388 sui sample, 528 web |

## 2. In corso

- **Lacune dopo l'MVP**, una alla volta per la memoria del portatile: item provvisori ✅; poi file spariti (`missing` → `removed` e "Dimentica" nell'admin).
- **MVP completo (F2 chiuso, 2026-11-06).** Revisione finale con cinque revisori (sicurezza, riproduzione, ingest, contratto e web client, deploy e documentazione); i rilievi gravi sono stati riprodotti, corretti e rivisti di nuovo. Quello che non è stato corretto è nelle lacune (§4).
- **Prova dell'app da parte del proprietario**, anche dall'iPad sulla rete locale. Problema aperto: il portatile non risponde all'iPad, probabilmente per l'indirizzo Wi‑Fi privato dell'iPad, che cambia.

## 3. Prossimi passi

1. Prova del proprietario con lo stack Compose (`deploy/README.md`) e la libreria vera: percorsi, `LIBRARY_ROOTS`, `MEDIA_GID`, `PZF_HOSTS`.
2. Controlli del proprietario (§5), che decidono P5 e H11.
3. Film di prova legali (Tears of Steel, Sintel e simili) in `media-samples/`, se il proprietario dà l'ok al download.
4. Dopo l'MVP: lacune di §4 in ordine di impatto, poi l'app per la TV (serve il modello della TV, ADB in rete, il collegamento audio).

## 4. Lacune note, da riprendere

- **Nessun timeout sulle chiamate a Stream Delivery**: un avvio che si blocca ferma anche gli avvii successivi dello stesso profilo. Oggi lo limita il timeout di avvio di Delivery; servirà quando Delivery andrà in un container separato.
- **Conteggio degli avvii bloccati in memoria**: si azzera al riavvio del servizio.
- **Riproduzione e stato di visione:**
  - "ultima visione" ignora i segni manuali;
  - un 422 su `reportPlaybackFailure` non porta il campo "sessione chiusa";
  - un segno manuale dopo un completamento non si vede;
  - nel web client la tolleranza "già posizionato" è di 6 s.
- **Sottotitoli (F1b.4):**
  - **Limite di lettura:** vale in media. All'inizio di ogni passaggio la lettura va avanti di 30–46 s di media alla massima velocità. Misurato in F2a: il costo su un seek in Direct Stream è di circa 20–40 ms, trascurabile.
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
- **Ingest (revisione F2):**
  - ~~file in attesa di un provider invisibile~~: risolto con gli item provvisori (doc 01 §3.1). Restano questi limiti accettati:
    - gli extra di un'opera in attesa non hanno un item provvisorio;
    - copie in radici diverse mostrano due card provvisorie finché non vengono identificate;
    - un "visto" unito sul titolo vero può coprire un "non visto" messo apposta (non c'è la data del "non visto");
    - se cambia il contenuto di un'opera adottata, lo stato del contenuto vecchio passa a quello nuovo;
    - un episodio in attesa di una serie già adottata crea una seconda serie provvisoria invece di agganciarsi a quella adottata;
    - le sostituzioni (`replacedBy`) per sessioni e web client stanno in memoria: si perdono al riavvio del servizio o della scheda;
  - un file sparito resta `missing` per sempre: manca il passaggio a `removed` (doc 01 §6.1) e un'azione "dimentica il file" nell'admin.
- **F2a, browser e codec:**
  - su questo portatile Edge e Firefox non hanno HEVC (manca probabilmente l'estensione HEVC di Windows, a pagamento): il 4K e il flusso principale si provano solo in Chromium e Chrome;
  - per circa 0,5 s dopo l'avvio Firefox dice di decodificare HEVC anche senza decoder: un link aperto in quella finestra dichiarerebbe HEVC, fallirebbe e ripianificherebbe;
  - le stringhe dei codec in Direct Play sono approssimate: Long Test risulta `hvc1.2.4.L153.B0` invece di `hvc1.2.4.H153.90` (High tier), come dice invece il Direct Stream. Può contare per i client nativi;
  - mancano i sample c4 (Opus 5.1) e c7 (AAC 5.1).
- **Flag di revisione dei metadata** non salvato (ADR 0007 §2/§3): per ora solo un warning nel log.
- **Autore e licenza delle immagini Commons** non salvati: serve una migrazione della tabella `artwork`.
- **Job:** manutenzione dell'identifier e dei metadata, e da F2 anche il giro dell'analyzer sui probe falliti, scrivono direttamente sulla tabella dei job; va sostituito da una funzione della porta `JobQueuePort`.
- **Rimasto dalla revisione F2:**
  - le edizioni con parole di release (IMAX, Remastered, Criterion) in un database creato prima di F2 restano edizioni separate: non c'è una migrazione che le riunisca. Una nuova identificazione del file le sistema;
  - un heartbeat che riceve `404` dopo un riavvio del servizio mostra "sessione scaduta" con "Riprendi", invece di ripartire da solo;
  - un cambio di traccia il cui piano nuovo fallisce, senza altri piani, dà un `422` semplice: il player mostra "interrotta" e non torna alle tracce di prima;
  - i segreti `<NOME>_FILE` dell'ADR 0006 non ci sono: il token TMDB passa solo dal file `.env`;
  - Docker Desktop su Windows crea comunque una `MEDIA_DIR` che non esiste (su Linux il bind la rifiuta);
  - lo stato dell'ingest non dice quanti job in coda sono già dovuti: il setup dei test e2e aspetta con una stima;
  - il gateway risponde `MEDIA_UNAVAILABLE` anche quando il Video Service è giù: serve un codice suo;
  - un transcode è finito una volta con `no_output` dopo 21 s nei test e2e, non più riprodotto.
- **Ultima scelta delle tracce** persa quando un titolo viene completato.
- **Token del profilo** firmato, più severo di quanto chiede l'ADR 0004: va bene così, da annotare nell'ADR alla prossima revisione.
- **Ricerca:** la scansione per sottostringa sull'indice FTS costa O(righe); va bene per una libreria domestica.
- **Locandine orfane:** la pulizia scorre tutte le cartelle una volta al giorno; il blocco contro le scritture concorrenti vale per un solo processo.

## 5. In attesa del proprietario

- **Verifica dei colori su un monitor SDR** in Chrome, Edge e Firefox, anche con un remux UHD vero con metadata statici: decide **P5**. Se fallisce si riapre P2.
- **Ascolto 5.1** delle clip c1–c7 (`spikes/s2-browser-playback/index.html`). Serve un'uscita HDMI verso l'AVR: il PC originale ha solo uscite stereo.
- **Un sample Dolby Vision profilo 7** (UHD Blu-ray), per H11.
- Percorsi reali della libreria, modello della TV, ADB, eARC, porta 8080 nel firewall.
- **Estensione HEVC di Windows** (Microsoft Store) per provare il 4K anche in Edge e Firefox, e l'ok al download dei film di prova legali.
- Impostazione "Indirizzo Wi‑Fi privato: No" sull'iPad per la rete di casa, se l'iPad continua a non raggiungere il portatile.

## 6. Scadenze

- **Entro il 2027-05-05: cancellare `spikes/s4-identification/out/`.** Contiene risposte TMDB e, per i termini (§1.C), non si conservano oltre 6 mesi.
