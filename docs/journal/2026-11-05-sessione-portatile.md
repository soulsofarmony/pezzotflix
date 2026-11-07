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
| `6287985` | **Dopo l'MVP, item provvisori:** un file che aspetta Wikidata o TMDB compare subito col titolo dal nome del file ("In attesa"), si guarda, e quando arriva l'identificazione progressi, "visto", cronologia e watchlist passano al titolo vero (migrazione 0004). Le sessioni aperte seguono il file; il web client va al titolo nuovo. Tre giri di revisione (unione di copie che perdeva i progressi, sessioni chiuse per errore, "visto" sul film sbagliato, adozione incompleta). 1697 test video più 388 sui sample, 528 web |
| `e1eead9` | **Dopo l'MVP, file spariti:** un file mancante esce dal catalogo dopo 30 giorni (`MISSING_REMOVE_AFTER_DAYS`, 0 = mai), solo se la sua libreria è in linea e non trattenuta; nuova pagina **Gestione → File mancanti** con "Dimentica" per un file o per tutti i mancanti di una libreria. Niente si cancella: un file che torna riprende titolo e progressi. Regola "un disco per radice". Una revisione, correzioni piccole. 1807 test video con i sample, 550 web |
| `6f2aefe` | **Test end-to-end** delle due lacune su uno stack da volumi vuoti: 74 passati, 20 saltati, 0 falliti (4,9 minuti); nessun token in chiaro nel gateway, nessun errore nel Video Service. Un primo giro aveva 3 errori: Chrome chiuso all'avvio (ambiente, passa ripetuto) e due 4K HEVC in Firefox partiti per sbaglio (vedi lacune); la prova di decodifica dei test ora aspetta 5 s in Firefox |
| `d8df747` | **Client TV, progetto (2026-11-07).** Letta la TV del proprietario via ADB: Haier H65C95EUX, OLED, Android TV 11, userspace a 32 bit, audio dagli altoparlanti integrati, Wi‑Fi a 2,4 GHz. **ADR 0008 accettata:** app Android nativa in Kotlin con Compose for TV e Media3, client generato con `jvm-retrofit2` (K1). **Spike S5** sulla TV: il file tipico del proprietario (ricodifica x265 4K HDR10, ~20 Mb/s) va in Direct Play con PGS e SRT; FLAC del server da ridurre a blocchi da 1152 campioni, `.sup` esterno da leggere nel client. Requisiti e CLAUDE.md allineati ai fatti del proprietario (libreria di ricodifiche, niente AVR) e alla regola di costruzione più leggera per i client |
| `739b67f` | **App TV, prima slice F3a (2026-11-07).** Progetto `clients/tv` con i moduli `:api` (client generato dal contratto a ogni build, più uno strato scritto a mano), `:player` (Media3: capability lette dalla TV, Direct Play e Direct Stream HLS, tracce del piano imposte, avanzamento e ripresa, chiusura della sessione, ripianificazione fino a 3 tentativi, cambio tracce) e `:app` (indirizzo del server, profili, Home, scheda con riprendi o ricomincia, prossimo episodio, player). Nel contratto `format: int64` su 10 proprietà, additivo. 62 test Kotlin, lint, build e `:api:check` verdi; `npm run verify` verde. Provata sull'emulatore Android TV (API 30) contro uno stack dedicato: Direct Play, Direct Stream con cambio d'audio, limite di sessione. Sulla TV vera non ancora (spenta). Decisioni: compileSdk 37 per OkHttp, validatore JSON Schema per i test (doc 05 §8.6) |
| `f0bbe78` | **App TV, seconda slice F3b (2026-11-07).** Schermate: serie → stagioni → episodi con avanzamento e segni di visione, extra, ricerca con la tastiera della TV, "La mia lista", segna visto o da vedere, lista, togli l'avanzamento, server irraggiungibile con "Riprova" e "Cambia server". Player: i sottotitoli serviti a parte (WebVTT e PGS in `.sup`) li disegna un overlay dell'app (ADR 0008). La revisione del player dopo F3a ha trovato due problemi gravi, corretti con i test che mancavano: con Back durante l'avvio restava una sessione che occupava il posto, e i sottotitoli ancora in estrazione non si vedevano. Server: FLAC del Direct Stream a blocchi da 1152 campioni, test end-to-end dei browser verdi. Release: APK firmato con una chiave fuori dal repository, con R8. Verifiche: 91 test Kotlin; sull'emulatore serie → episodio, ricerca, segni di visione e APK di release. La prova sulla TV vera è nel doc 07 §7 |
| (questo commit) | **Prima prova sulla TV vera e trasloco sul fisso (2026-11-07).** Sulla TV vera, contro lo stack del portatile, il 2001 è andato in Direct Play con l'audio AC-3 ita, i PGS ita incorporati scelti dal menu, l'avanzamento ogni 10 s, la ripresa dal punto giusto e una chiusura pulita; le capability lette dalla TV sono quelle vere. Il resto della prova (doc 07 §7) non è partito: la TV è stata spenta. Preparato il trasloco del server sul PC fisso: [passaggio di consegne](2026-11-07-trasloco-sul-fisso.md) e "Server di casa su Windows" in `deploy/README.md` |

## 2. In corso

- **Trasloco del server sul PC fisso:** preparato il 2026-11-07, si fa dal fisso seguendo il [passaggio di consegne](2026-11-07-trasloco-sul-fisso.md).
- **App per la TV (F3):** costruita (F3a e F3b), provata sull'emulatore e, il 2026-11-07, sulla TV vera con il 2001. Il resto della prova è nel [doc 07 §7](../architecture/07-tv-client-plan.md#7-prova-sulla-tv-vera); l'installazione in `clients/tv/README.md`.
- **Lacune dopo l'MVP**, una alla volta per la memoria del portatile: item provvisori ✅ (`6287985`), file spariti ✅ (`e1eead9`), test end-to-end ✅.
- **MVP completo (F2 chiuso, 2026-11-06).** Revisione finale con cinque revisori (sicurezza, riproduzione, ingest, contratto e web client, deploy e documentazione); i rilievi gravi sono stati riprodotti, corretti e rivisti di nuovo. Quello che non è stato corretto è nelle lacune (§4).
- **Prova dell'app da parte del proprietario**, anche dall'iPad sulla rete locale. Problema aperto: il portatile non risponde all'iPad, probabilmente per l'indirizzo Wi‑Fi privato dell'iPad, che cambia.

## 3. Prossimi passi

1. **Server sul PC fisso, con la libreria vera** (proprietario, 2026-11-07). Ci resta finché non arriva il mini-PC; poi il trasloco porta solo i volumi. Si parte da zero: profili e stato di visione del portatile non si portano. Passi nel [passaggio di consegne](2026-11-07-trasloco-sul-fisso.md).
2. Controlli del proprietario (§5), che decidono P5 e H11.
3. Film di prova legali (Tears of Steel, Sintel e simili) in `media-samples/`, se il proprietario dà l'ok al download.
4. Resto della prova dell'app TV (doc 07 §7) con il server sul fisso, poi le lacune di §4 in ordine di impatto.

## 4. Lacune note, da riprendere

- **Viste in F3b, da capire:**
  - dopo una presa di posto (409 → "Interrompi") la nuova sessione è partita senza sottotitoli, mentre la precedente aveva i PGS;
  - un item corto (meno di circa 25 minuti) può stare in "Continua a guardare" senza una posizione di ripresa, perché è sotto i 30 s minimi. La scheda mostra allora "Riproduci" e non "Togli da Continua a guardare". Il web client fa lo stesso.
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
  - ~~un file sparito resta `missing` per sempre~~: risolto con la rimozione dopo 30 giorni e "Dimentica" in **Gestione → File mancanti** (doc 01 §6.1). Restano:
    - nessun evento quando un file passa da presente a mancante o torna presente (solo il passaggio a `removed` e il ritorno ne hanno uno);
    - quando una radice trattenuta viene sbloccata, i file mancanti da più del periodo di grazia vengono dimenticati tutti insieme al controllo successivo;
    - nessun indice sullo stato dei file: il controllo giornaliero e la lista leggono tutta la tabella, che va bene per una libreria di casa;
    - un disco montato in una sottocartella di una radice non è visto dalla protezione contro i dischi smontati: i suoi file escono dal catalogo dopo il periodo di grazia (tornano col disco). Per ora la regola è "un disco per radice"; una protezione per sottocartella sarebbe una decisione a parte;
    - allo spegnimento il servizio non aspetta il controllo giornaliero in corso: il blocco in corso è atomico, il resto riprende al giro dopo;
    - un item con file in due blocchi riceve due eventi `media_removed`.
- **F2a, browser e codec:**
  - su questo portatile Edge e Firefox non hanno HEVC (manca probabilmente l'estensione HEVC di Windows, a pagamento): il 4K e il flusso principale si provano solo in Chromium e Chrome;
  - per circa 0,5 s dopo l'avvio Firefox dice di decodificare HEVC anche senza decoder, e con il portatile carico anche più di 2 s: un link aperto in quella finestra dichiarerebbe HEVC. Nei test del 2026-11-06 in quel caso la pagina non ha ripianificato: il thread principale si è bloccato (Firefox ha interrotto uno script per timeout) e il test è scaduto a 2 minuti. Da riprovare con il web client, se Firefox diventa un client importante;
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
- **Resto della prova dell'app TV** sulla TV vera (doc 07 §7), con il server sul fisso.
- **Backup della chiave di firma dell'app TV** (`C:\Users\SimoneMen\.pezzotflix\`, sul portatile): una copia fuori dal PC. Senza la chiave, per aggiornare l'app bisogna disinstallarla.
- **Verifiche sulla TV** con l'app di S5 ("Pezzotflix S5 sonda", elenco nel report S5): coppia d'ascolto AAC 5.1 contro E-AC-3 5.1 (decide la politica Dolby del server, ADR 0008), sincronia labiale, HDR10 e Dolby Vision sul pannello, judder dei 24p, prova dei canali, PGS. Serve il server dei file acceso sul portatile (`bash spikes/s5-tv-client/serve.sh`).
- **TV sul Wi‑Fi a 5 GHz o via cavo**, quando sarà possibile; il server va cablato (S5).
- **Un sample Dolby Vision profilo 7** (UHD Blu-ray), per H11.
- **Per il server sul fisso** (§5 del [passaggio di consegne](2026-11-07-trasloco-sul-fisso.md)):
  - dove stanno i film;
  - il token TMDB e la chiave dell'app copiati;
  - la porta 8080 nel firewall;
  - le prenotazioni DHCP del fisso e della TV.
- **Estensione HEVC di Windows** (Microsoft Store) per provare il 4K anche in Edge e Firefox, e l'ok al download dei film di prova legali.
- Impostazione "Indirizzo Wi‑Fi privato: No" sull'iPad per la rete di casa, se l'iPad continua a non raggiungere il portatile.

## 6. Scadenze

- **Entro il 2027-05-05: cancellare `spikes/s4-identification/out/`.** Contiene risposte TMDB e, per i termini (§1.C), non si conservano oltre 6 mesi.
