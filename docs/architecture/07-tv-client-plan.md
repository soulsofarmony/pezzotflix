# 07 — Piano del client TV (F3)

- **Stato:** approvato da Claude, 2026-11-07. Per i client niente revisore sul piano (CLAUDE.md, regola del 2026-11-07).
- **Avanzamento:** F3a ✅ (`739b67f`), F3b ✅ (2026-11-07), entrambe provate sull'emulatore Android TV. Manca la prova sulla TV vera (§7).
- **Base:** [ADR 0008](../adr/0008-client-tv-kotlin-compose-media3.md), [doc 05 §8](05-technology-evaluation.md#8-client-tv), spike [S5](../spikes/S5-tv-client.md) e [K1](../spikes/K1-kotlin-codegen.md).

## 1. Obiettivo

Un'app Android TV, installata via ADB sulla TV del soggiorno, con cui il proprietario sceglie un profilo, sfoglia la libreria e guarda un film o una serie alla qualità piena, ripartendo da dove era rimasto.

Il server non cambia comportamento: l'app dichiara le capability reali e segue il protocollo di riproduzione del web client (doc 04 §8). Le uniche modifiche lato server sono due:
- `format: int64` sulle 10 proprietà del contratto in millisecondi e in byte (K1). È additivo;
- il FLAC del Direct Stream a blocchi da 1152 campioni (S5).

## 2. Processo

Due slice grandi, una dopo l'altra, ciascuna con un solo `module-implementer` nel suo worktree:
- ogni slice finisce con i test e con una prova sulla TV vera;
- una sola revisione esterna (`code-reviewer`) dopo F3a, sul player e sul suo dialogo con il server (avvio, avanzamento, ripresa, ripianificazione, chiusura). Il resto lo controlla l'orchestratore.

La TV e Docker si usano un agente alla volta. La memoria del portatile permette una build pesante alla volta.

## 3. Slice

### F3a — L'app che si usa

- **Progetto `clients/tv/`:** moduli `:app`, `:player` e `:api`; versioni fisse in `gradle/libs.versions.toml`; wrapper Gradle. Manifest per la TV con `LEANBACK_LAUNCHER` e banner, `largeHeap`, HTTP in chiaro (`base-config`), ABI `armeabi-v7a` e `arm64-v8a`.
- **`:api`:**
  - client generato dal bundle a ogni build, con le opzioni e i mapping dell'ADR 0008;
  - Retrofit e OkHttp: client derivati, con il Bearer solo su quello delle API;
  - un test MockWebServer che valida i corpi codificati contro lo schema del bundle;
  - il gate `gradlew :api:check`.
- **Contratto:** `format: int64` sulle 10 proprietà; tipi TypeScript rigenerati; `npm run verify` verde.
- **Schermate:**
  - indirizzo del server, inserito a mano e ricordato;
  - scelta del profilo;
  - Home composta dal server;
  - scheda di un film, con riprendi o ricomincia;
  - per una serie, la scheda e il "prossimo episodio" che il server restituisce già. La navigazione completa per stagioni arriva in F3b.
- **Player (`:player`):**
  - capability lette dalla piattaforma a ogni avvio (doc 05 §8.9), con il JSON di S5 come fixture dei test;
  - Direct Play progressivo e Direct Stream HLS dal locator con il token di sessione;
  - le tracce del piano imposte con `TrackSelectionOverride`;
  - PGS e SRT incorporati; WebVTT esterno in Direct Stream;
  - avanzamento e ripresa sulla timeline originale;
  - `StopPlayback` all'uscita e su `onStop`;
  - ripianificazione come nel doc 04 §8, con le precisazioni di F2, al massimo 3 tentativi;
  - `ChangeTracks` per audio e sottotitoli;
  - `keepScreenOn`, `largeHeap` e tetto di 100 MiB al buffer.
- **Eventi:** polling come nel web client, per la chiusura della sessione dall'esterno e per l'aggiornamento della Home.
- **Fatto quando:**
  - `gradlew test lint assembleDebug` e `:api:check` passano, e `npm run verify` passa;
  - sulla TV, con uno stack dedicato, il *2001* parte in Direct Play con l'audio e i sottotitoli scelti, riprende dal punto giusto dopo l'uscita, e un Direct Stream (un remux con TrueHD) parte e si ferma pulito.

### F3b — L'app completa

- **Schermate:**
  - serie → stagioni → episodi;
  - extra di un item;
  - ricerca;
  - "continua a guardare" e watchlist nella Home, se la Home del server li compone già;
  - segna visto o non visto;
  - errori e stati vuoti curati.
- **PGS in Direct Stream:** parser del `.sup` esterno che lo divide in display set con i loro tempi e li passa al `PgsParser` di Media3 (S5, ADR 0008).
- **Server:** FLAC a 1152 campioni per blocco (`FLAC_FRAME_SAMPLES`), verificato con i test end-to-end dei browser.
- **APK di release** firmato con una chiave fuori dal repo; istruzioni d'installazione per il proprietario.
- **Fatto quando:**
  - i gate di F3a passano;
  - sulla TV si sfoglia una serie fino all'episodio e lo si guarda, si cerca un titolo, e i PGS di un remux in Direct Stream si vedono.

## 4. Test

- **Logica pura con JUnit e Robolectric (SDK 30):** capability dal JSON di S5, mappatura delle tracce del piano sulle tracce di Media3, errori di Media3 verso la dimensione da ripianificare, posizioni.
- **Client API con MockWebServer:** corpi validati contro lo schema, POST senza corpo, `subtitleTrackId: null`.
- **UI:** pochi test di Compose sulle schermate di navigazione. Il resto si prova sulla TV.
- **Stack di prova dedicato** (`COMPOSE_PROJECT_NAME=pzf-f3`, porta 18480), mai lo stack 8080 del proprietario, che resta per l'uso vero.

## 5. Rischi

- **Percorsi lunghi di Windows:** il worktree aggiunge profondità alle cartelle di build di Gradle. Se si supera il limite, la cartella di build va spostata in un percorso corto.
- **Compose sul SoC a 32 bit:** si misura lo scorrimento della Home in F3a; se non basta, baseline profile e immagini più piccole.
- **Memoria della TV:** buffer e cache delle immagini con un tetto esplicito. Il low memory killer si osserva su un film intero.

## 6. Decisioni prese durante la costruzione

- **Sottotitoli serviti a parte:** li disegna un overlay dell'app, non Media3 ([ADR 0008](../adr/0008-client-tv-kotlin-compose-media3.md), decisioni nella costruzione). Il WebVTT esterno di F3a è passato all'overlay in F3b, dopo la revisione del player.
- **Revisione del player (dopo F3a), corretta in F3b:**
  - con Back durante l'avvio, la sessione nata tardi viene chiusa;
  - avvio e chiusura della sessione girano fuori dallo scope della schermata e sono solo attesi;
  - un errore dentro `load()` torna come risultato;
  - nuovi test per ChangeTracks (410, 422, 503), heartbeat 410, errore di rete e "Riprova".
- **Navigazione:**
  - "La mia lista" è una schermata a sé;
  - in testa alla Home ci sono Cerca, La mia lista e Cambia profilo;
  - su una riga di episodio, OK lo avvia e "Dettagli" apre la sua scheda;
  - una stagione si apre con il focus sull'episodio da vedere.
- **Ricerca:** parte 250 ms dopo l'ultimo tasto e mostra al massimo 50 risultati; dal campo, giù porta ai risultati.
- **Riproduzione:** Play alla fine del film ricomincia da capo nella stessa sessione.
- **Liste:** lette a pagine da 200, al massimo 10 pagine.
- **Opzioni di debug** (decoder software, apertura diretta di un item): solo nella build di debug o sull'emulatore.

## 7. Prova sulla TV vera

Da fare alla prima accensione. L'app si installa via ADB come in `clients/tv/README.md`.

1. **Primo avvio:** indirizzo del server scritto con la tastiera Gboard. La tastiera si chiude e il D-pad funziona su Profili e Home (difetto di Android 11 aggirato in F3a).
2. **Capability:** la riga `capabilities` nel logcat (tag `PZF`) elenca AC-3/E-AC-3 e i decoder hardware della TV.
3. **2001 in Direct Play:**
   - audio e sottotitoli scelti dal piano;
   - avanzamento; si esce dopo più di 30 s e "Riprendi da" riparte dal punto giusto;
   - "Dall'inizio" riparte da zero.
4. **Remux con TrueHD in Direct Stream:**
   - il FLAC a 1152 campioni va con audio a 24 bit 5.1 e 7.1, senza errori del buffer del decoder;
   - avvio, cambio traccia e chiusura vanno.
5. **PGS:**
   - quelli incorporati in Direct Play (2001, PGS ita);
   - l'overlay del `.sup` in Direct Stream: posizione e dimensione, sottotitoli forzati, display set che cambiano solo la palette;
   - velocità di decodifica sul MT5889 nei tratti densi.
6. **Sottotitoli in preparazione** alla prima visione di un film lungo: prima la nota, poi i sottotitoli, senza ricaricare il flusso.
7. **Seek lontano in Direct Stream:** confrontare i tempi dei sottotitoli con l'immagine dopo il riavvio della pipeline. Media3 può lasciare uno scarto di 40–200 ms, che S5 non ha misurato.
8. **Immagine:** HDR10 e Dolby Vision corretti sul pannello. Un Dolby Vision profilo 7 ricade su HDR10 senza errore.
9. **Home:** scorrimento e caricamento dei poster sul MT5889, con l'APK di release.
10. **Un film intero** (`largeHeap`, buffer da 100 MiB) sul Wi‑Fi a 2,4 GHz:
    - eventuali rebuffering e memoria;
    - un `.sup` grande (30–60 MB) e la pulizia dei file temporanei all'avvio successivo.
11. **Chiusura della sessione:**
    - TV spenta, tasto Home o un'altra app durante la riproduzione: la sessione si chiude e libera il posto;
    - Back durante l'avvio non lascia sessioni appese.
12. **Telecomando:**
    - play/pausa, avanti e indietro;
    - sinistra e destra ±10 s a controlli nascosti;
    - Back: la prima pressione nasconde i controlli, la seconda esce.
13. **Ricerca → Back → giù → apri → play:** la tastiera non ricompare.
14. **Serie → stagione:** il focus va sull'episodio da vedere. Play alla fine ricomincia da zero.
15. **Release sopra debug:** una disinstallazione, poi l'indirizzo del server va riscritto.
