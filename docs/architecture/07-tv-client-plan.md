# 07 — Piano del client TV (F3)

- **Stato:** approvato da Claude, 2026-11-07. Per i client niente revisore sul piano (CLAUDE.md, regola del 2026-11-07).
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
