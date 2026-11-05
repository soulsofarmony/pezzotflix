# 0005 — Web client: React 19 con Vite 8, hls.js e libpgs

- **Stato:** Accepted (2026-11-05)
- **Data:** 2026-11-05 (rivista lo stesso giorno dopo la revisione di design e i punti incrociati della revisione dell'ADR 0003)
- **Decisore:** Claude, su delega del proprietario (review: design-reviewer, correzioni applicate e allineate all'ADR 0003 accettata)
- **Requisiti collegati:** §6 (scelta delle tracce audio e sottotitoli), §7 (client proprietari, desktop via browser), §13 (correzione manuale, "Da verificare"), §14 (profili), §15 (progress, resume), §16 (Home, ricerca, filtri), §18 (qualità, evolvibilità), §19 (MVP con web client), §20 (player, capability detection); doc 02 §2.3, C2, C3; doc 03 P1, P2, P9, §4, §5, §7, I3, I5, I6; doc 04 §4–§6, §8, P3, P5
- **Valutazione completa:** [05 — §7 Web client](../architecture/05-technology-evaluation.md#7-web-client)

## Contesto

Il web client è l'unico client dell'MVP (§19). Copre:
- scelta del profilo, Home composta dal server, dettaglio, ricerca, player;
- la sezione di gestione "Da verificare" (doc 06 F1c).

Vincoli già accettati:
- TypeScript e workspace npm (ADR 0001);
- tipi generati da openapi-typescript e runtime openapi-fetch (ADR 0004);
- build statica servita da Caddy (ADR 0006);
- HLS fMP4 con audio muxato nei segmenti video e offset costante dei timestamp (ADR 0003, in parallelo).

S2 ha fissato cosa serve al player:
- HLS fMP4 via MSE con hls.js;
- `<video>` nativo per il progressivo;
- PGS resi con libpgs e pilotati da `requestVideoFrameCallback`;
- capability da un elenco fisso di stringhe con `isTypeSupported`;
- verifica di `stream.mimeType` prima dell'avvio;
- errori fatali di MSE e audio che sparisce trattati come fallimenti da ripianificare;
- buffer di hls.js dimensionato dal bitrate.

Il client TV sarà con ogni probabilità un'app nativa (Kotlin/Media3): il web client non deve servire anche da UI per il D-pad.

## Opzioni considerate

### A. React 19.3.1
- Pro:
  - il corpus più ampio per lo sviluppo AI;
  - TSX controllato da `tsc` nella stessa `verify`;
  - router e cache dei dati tipizzati e maturi (TanStack Router 1.170.46, TanStack Query 5.106.1);
  - riserve per accessibilità (React Aria) e D-pad (Norigin).
- Contro:
  - il runtime più pesante: 81 KB gzip senza router e 107 KB con TanStack Router, contro 25 KB di Svelte senza router (misurato, W1);
  - il modello a effetti e lo `StrictMode` puniscono un player scritto dentro i componenti.

### B. Svelte 5.57.3
- Pro: runtime minimo, componenti leggibili, aggancio naturale di oggetti imperativi.
- Contro:
  - tipi nei template con uno strumento in più (svelte-check);
  - rischio di codice generato con sintassi Svelte 4;
  - ecosistema più sottile fuori da SvelteKit.

### C. Solid 1.9.18
- Pro: reattività fine, TSX, runtime piccolo.
- Contro: la 2.0 è in release candidate, quindi una migrazione è imminente; ecosistema piccolo.

### D. Vue 3.5.45
- Pro: maturo e completo.
- Contro: due stili di API, vue-tsc, Vapor Mode (3.6) in release candidate.

Scartati: Lit e web component scritti a mano (tutto da scrivere), Preact (compatibilità meno provata).

## Evidenze

- **[S2](../spikes/S2-browser-playback.md):**
  - hls.js 1.7.3 e libpgs 0.9.0 in Chrome, Edge e Firefox;
  - `isTypeSupported` affidabile sulle stringhe esatte, salvo l'AAC con PCE;
  - `bufferFullError` causato dal buffer in avanti;
  - rVFC con 4–42 ms di ritardo contro 283 ms con `timeupdate`, nella configurazione `PgsRenderer({ video, … })` più rVFC;
  - `audioTracks` non disponibile.
- **Esperimento W1** (2026-11-05, Vite 8.3.6, `spikes/w1-web-bundle/run.sh`, [05 §7.4](../architecture/05-technology-evaluation.md#74-esperimento-w1-peso-del-bundle-2026-11-05)):
  - React + Query + openapi-fetch: 80,8 KB gzip; con TanStack Router 107,3 KB; con React Router 8.5.1 110,8 KB;
  - Svelte + Query, senza router: 25,2 KB;
  - chunk del player: hls.js completo 180,3 KB, `hls.js/light` 115,3 KB, più libpgs 23,2 KB;
  - `tsc` 6.0.3 strict passa anche con `skipLibCheck: false`, con tre dichiarazioni locali (`hls.js/light`, i due polyfill di libpgs).
- **libpgs 0.9.0** (sorgente del pacchetto): con `video` aggiorna su `timeupdate` a `currentTime + timeOffset`; `renderAtTimestamp` usa il tempo dato; il `.sup` si legge come stream, e il Worker pubblica i display set circa ogni secondo mentre carica.
- **hls.js 1.7.4** (2026-10-28): una patch della 1.7 che tocca anche MediaSource, caricamento dei frammenti e timestamp (#8083, #8085, #8110, #8125, #8127, #8128) ([release](https://github.com/video-dev/hls.js/releases/tag/v1.7.4)); l'export `./light` non ha tipi; la build ESM usa `workerPath`.
- **Revisione dell'ADR 0003:** lo scarto fra `currentTime` e PTS originale con fMP4 è di 37–203 ms secondo codec e posizione; da qui l'offset ricavato da `INIT_PTS_FOUND`.
- **Punteggio pesato** (05 §7.5): React 4,54, Svelte 4,38, Vue 3,88, Solid 3,63.

## Decisione

**React 19.3.1 con Vite 8.3.6.** Il player è un modulo TypeScript senza framework.

1. **Codice e build:**
   - `clients/web/` (`@pezzotflix/web`), workspace npm della radice;
   - **Vite 8.3.6** con `@vitejs/plugin-react` 6.2.1; build in `clients/web/dist`, asset con hash in `/assets/`;
   - **deroga all'ADR 0001 sul `tsconfig`:** `"types": ["vite/client"]`, `lib` con il DOM, `moduleResolution: "bundler"`, nessun tipo di Node; i file di configurazione hanno un `tsconfig.node.json` a parte. Il resto segue l'ADR 0001;
   - dichiarazioni locali in `src/types/ambient.d.ts` per `hls.js/light` e per i due import a solo effetto di libpgs;
   - in produzione l'immagine `gateway` la costruisce in multi-stage con `npm ci -w @pezzotflix/web --include-workspace-root` e la copia in `/srv/web` (ADR 0006); in sviluppo il Compose la monta in sola lettura e Vite gira sull'host con proxy di `/video` verso il gateway;
   - il Caddyfile di F0 ha già `no-cache` su `index.html` e sulle route della SPA; si aggiunge `encode zstd gzip` per gli asset;
   - `npm run verify` del workspace: `contract:check`, `typecheck`, `lint` e `test`;
   - dependency-cruiser vieta a `src/player/` di importare React e le feature.
2. **API:**
   - openapi-typescript 7.13.0 genera `src/api/schema.d.ts` dal bundle versionato, e il diff fa fallire `verify`;
   - **openapi-fetch 0.17.0** con `baseUrl` uguale all'origine della pagina;
   - **TanStack Query 5.106.1**, con query e chiavi scritte a mano: un helper di una trentina di righe fa quello che farebbe `openapi-react-query`, con una dipendenza in meno;
   - `profileToken` in `localStorage`, aggiunto come `Authorization: Bearer` da un middleware; un `401` del control plane porta alla scelta del profilo;
   - **polling degli eventi** con cursore ogni 5 s a pagina visibile, fermo a pagina nascosta, backoff fino a 60 s dopo un errore;
   - ogni evento invalida le query interessate; `410 CURSOR_EXPIRED` invalida tutto e riparte senza cursore.
3. **Routing e stato:**
   - **TanStack Router 1.170.46**, con le route nel codice e i parametri di ricerca nell'URL, validati con zod 4.6.7;
   - stato del server in TanStack Query, profilo in un context, player nel suo controller (`useSyncExternalStore`);
   - nessuno store globale.
4. **Player** (`src/player/`, idempotente su attach e destroy):
   - **sostituzione del motore:** ogni motore ha una generazione legata alla sessione; il vecchio si distrugge prima di creare il nuovo, e i suoi errori (vecchio token, `410` dopo `ChangeTracks`) si ignorano: non portano mai a una nuova `StartPlayback`;
   - **motori:** `progressive` con `<video src>` nativo; `hls-fmp4` con **hls.js 1.7.4 light** (`import Hls from 'hls.js/light'`), versione esatta, in un chunk caricato a parte, `enableWorker: true` con `workerPath` da `hls.js/dist/hls.worker.js?url`, `autoStartLoad: false`;
   - **capability** a ogni `StartPlayback`:
     - le nove stringhe di I6 sondate con `isTypeSupported`, tradotte nel vocabolario fisso;
     - risoluzione, frame rate (sonda a 60 fps, poi 30) e HDR (HDR10, HLG) da `decodingInfo`, mai DV né HDR10+;
     - `limits.maxBitrate` non inviato (assente = nessun limite, da concordare con F1b);
     - `displayHdr` da `matchMedia('(dynamic-range: high)')`;
     - `audioTrackSelection: false`;
     - `pgs` solo con Worker e rVFC;
     - `device.model` con browser, versione e sistema;
     - la tabella completa è in 05 §7.8.2;
   - **verifica prima dell'avvio:**
     - `isTypeSupported(stream.mimeType)` per HLS e MP4, con la scomposizione dei codec per trovare la dimensione sospetta;
     - per un MKV in Direct Play, `canPlayType` vuoto vuol dire sospetto `container`, senza scomposizione;
     - senza `stream.mimeType` la verifica si salta e si scrive nel log;
     - un esito negativo chiama `reportPlaybackFailure` con `MIME_TYPE_UNSUPPORTED` in automatico;
   - **buffer di hls.js** (a `MANIFEST_PARSED`):
     - `T = min(0,7·150 MiB·8 / bv, 0,7·12 MiB·8 / ba)`, con `bv` e `ba` da `stream.bitrate { peakBps, averageBps, audioBps }`;
     - `maxBufferLength = maxMaxBufferLength = clamp(floor(T − TD), TD, 30 s)`, con TD la target duration: hls.js può aggiungere un frammento oltre `maxBufferLength`;
     - `maxBufferSize` il 70% di 150 MiB; il buffer indietro il 10%, almeno 2 s;
     - avviso nel log se `T < 2·TD`;
     - senza `stream.bitrate`, `BANDWIDTH` e una stima per codec (giudizio);
     - valori di partenza da verificare su un film intero (05 §7.8.4);
   - **fallimenti e ripianificazione automatica** (doc 04 §8):
     - a ogni errore fatale di media o di buffer di hls.js il client ferma e distrugge il motore, senza lasciarlo ritentare, e chiama `reportPlaybackFailure` con la dimensione sospetta (da `sourceBufferName` o dalla scomposizione dei codec);
     - un 5xx fatale sui media, dopo i retry di hls.js, chiama `reportPlaybackFailure` con `unknown`: la dimensione la sceglie il server;
     - `500` vuol dire stream fallito in modo definitivo (`STREAM_FAILED`, ADR 0003): `errorRetry.shouldRetry` di `manifestLoadPolicy`, `playlistLoadPolicy` e `fragLoadPolicy` restituisce `false` su 500, così l'errore diventa fatale subito, senza decine di secondi di schermo nero; un `503` continua a essere ritentato da hls.js;
     - un 401, 403, 404 o 410 sul data plane vuol dire sessione chiusa: `stopPlayback`, poi `StartPlayback` dalla posizione corrente;
     - nel progressivo, dopo 4 s di riproduzione con `webkitAudioDecodedByteCount === 0` o `mozHasAudio === false`, segnala `audio`;
     - nessuna domanda all'utente prima dei tentativi automatici; al massimo 3 per avvio, poi i motivi e "Riprova";
     - `bufferFullError` e `mediaSourceRequiresReset` non sono fallimenti del piano;
     - la tabella completa è in 05 §7.8.5;
   - **audio:** il cambio passa sempre da `ChangeTracks`, perché l'audio è muxato (una traccia per stream) e il browser non sceglie la traccia in Direct Play;
   - **sottotitoli:**
     - `client_render` con **libpgs 0.9.0** nella configurazione di S2 (`video` più un ciclo rVFC che chiama `renderAtTimestamp`), con `timeOffset` e rVFC entrambi riferiti alla timeline originale;
     - `sidecar` con `<track>` WebVTT, con i cue spostati di `−timelineOffsetMs`;
     - `switchWithoutRestart` riguarda solo lo stream; una traccia `availability: growing` si sceglie in locale, senza `ChangeTracks`, e si mostra "in preparazione";
     - `availability` arriva nelle tracce della sessione (`StartPlayback`, `ChangeTracks`); il passaggio a `complete` arriva con l'evento `playback.subtitle_ready` `{sessionId, trackId, availability}` su `listEvents`, che il poller interroga ogni 5 s a pagina visibile e ogni 15 s a pagina nascosta con una sessione attiva (`reportProgress` risponde 204 senza corpo);
     - a quel punto, se la traccia è scelta, il client rilegge l'URL (`loadFromUrl` per i PGS, un `<track>` nuovo per il WebVTT);
     - il WebVTT che cresce con `<track>` è da verificare in F1c, con il ripiego `fetch` più `VTTCue`;
   - **timeline:**
     - a ogni `INIT_PTS_FOUND`, `timelineOffsetMs = initPTS·1000/timescale − stream.mediaTimestampOffsetMs` (0 in Direct Play);
     - `positionMs = currentTime·1000 + timelineOffsetMs` per progress, resume, capitoli e PGS;
     - il seek a un tempo originale X imposta `currentTime = (X − timelineOffsetMs)/1000`;
   - **avvio:** `503 STREAM_PREPARING` su `StartPlayback` mostra "in preparazione" e ripete dopo `Retry-After`, per al più 60 s;
   - **heartbeat:** `reportProgress` ogni `heartbeatIntervalMs` (10 s se manca);
   - **uscita:** `stopPlayback` con `fetch` `keepalive` su `pagehide`.
5. **Stile, i18n, accessibilità:**
   - CSS Modules e token CSS, tema scuro, font di sistema, icone SVG inline;
   - catalogo dei messaggi italiano tipizzato e `Intl` in `it-IT`, nessuna libreria finché la lingua è una sola;
   - elementi nativi, focus visibile, frecce nelle righe, scorciatoie del player;
   - lint con `eslint-plugin-jsx-a11y-x` 0.2.0 (il plugin originale non supporta ESLint 10) e controllo axe nell'e2e;
   - D-pad non richiesto.
6. **Test:**
   - **Vitest 5.1.0 con jsdom 31.0.0:** il motore del player con API del browser finte (capability, verifica, buffer con i casi del §7.8.4, fallimenti, sostituzione del motore, timeline, ricarica dei sottotitoli), poi i componenti con Testing Library;
   - **Playwright 1.64.1** sullo stack Compose, con Edge e Chrome installati (`channel`), come gate di milestone fuori da `verify`, perché il browser è una risorsa condivisa. Comprende la regressione di S2 (h1, h2, h6, c1, c4, c7, s3), un seek lontano con riavvio della pipeline e il controllo axe (`@axe-core/playwright` 4.14.0);
   - Firefox resta una verifica manuale.
7. **Dipendenze**, tutte fissate (licenze in 05 §7.10):
   - runtime: react e react-dom 19.3.1, @tanstack/react-router 1.170.46, @tanstack/react-query 5.106.1, openapi-fetch 0.17.0, zod 4.6.7, hls.js 1.7.4 (Apache-2.0, build light), libpgs 0.9.0;
   - sviluppo: vite 8.3.6, @vitejs/plugin-react 6.2.1, @types/react e @types/react-dom 19.3.0, eslint-plugin-react-hooks 7.1.1, eslint-plugin-jsx-a11y-x 0.2.0, jsdom 31.0.0, @testing-library/react 16.3.3, @testing-library/dom 10.4.2, @testing-library/user-event 14.6.8, @playwright/test 1.64.1 (Apache-2.0), @axe-core/playwright 4.14.0 (MPL-2.0, senza modifiche);
   - aggiunte in F1c, solo sviluppo: typescript 6.0.3 anche nel workspace web (la dipendenza peer di openapi-typescript installava un TypeScript 5.9 annidato che `tsc` avrebbe usato) e @types/node 26.6.6 per i file di configurazione eseguiti da Node (Vite, Vitest, Playwright). Nessuna delle due entra nel bundle;
   - il resto è già nel workspace.

**Perché:** decidono la qualità del codice scritto dall'AI e rivisto dal proprietario, un ecosistema tipizzato e maturo, e i TSX controllati da `tsc`. Il peso in più di React è misurato, ma in LAN conta poco, e il primo playback è dominato dal chunk del player, uguale per ogni framework.

**Runner-up: Svelte 5.57.3**, se il client dovesse girare su dispositivi deboli. Il motore del player si porterebbe così com'è.

## Conseguenze

- **Più facile:**
  - un solo linguaggio, test runner, lint e lockfile con il backend;
  - i tipi del contratto arrivano fino ai componenti;
  - il motore del player si testa senza browser e non dipende dal framework;
  - le capability e la ripianificazione seguono S2 e il doc 04 §8.
- **Più difficile:**
  - il player va tenuto fuori dai componenti (regola di dependency-cruiser);
  - i tipi stretti di `PlaybackSession` ed `Event` si scrivono a mano (ADR 0004);
  - tre dichiarazioni di tipi locali da tenere allineate agli aggiornamenti di hls.js e libpgs;
  - l'e2e richiede il turno sul browser;
  - le versioni fissate vanno aggiornate a mano.
- **Ipotesi e dipendenze sull'ADR 0003** (05 §7.11, H-A…H-J):
  - HLS fMP4 VOD con audio muxato (build light);
  - `stream.mediaTimestampOffsetMs` e offset da `INIT_PTS_FOUND`;
  - seek oltre la parte generata gestito dal server;
  - `stream.bitrate` come oggetto, `TARGETDURATION` limitata (taglio ai keyframe interni sopra 6 s o 32 MiB);
  - sottotitoli come una sola risposta che cresce, con `availability`;
  - nessun 404 su risorse in playlist a sessione viva, `503 STREAM_PREPARING` su `StartPlayback`;
  - `stream.mimeType` dei segmenti con entrambi i codec;
  - cue dei sottotitoli sulla timeline originale anche dopo un riavvio.
- **Richieste sul contratto**, additive (05 §7.12): `stream.mediaTimestampOffsetMs`, `stream.bitrate { peakBps, averageBps, audioBps }`, `SessionTrack.availability` più l'evento `playback.subtitle_ready` `{sessionId, trackId, availability}` su `listEvents`, `503 STREAM_PREPARING`, la citazione di `MIME_TYPE_UNSUPPORTED`. La richiesta di `stream.timelineOffsetMs` della prima stesura è ritirata.
- **Da verificare in F1c:** WebVTT che cresce con `<track>`; worker ESM di hls.js light; offset da `INIT_PTS_FOUND` dopo un seek con riavvio; PGS che cresce e ricarica a `complete`.
- **Rischi:**
  - libpgs è piccola (un solo autore, 22 mesi fra la 0.8.1 e la 0.9.0, polyfill dentro): se smette di essere mantenuta, si copia nel repo (MIT);
  - hls.js 1.7.4 non è la versione misurata: il test di regressione ripete la parte HLS di S2 con s3 e un seek con riavvio, con ritorno alla 1.7.3 se fallisce;
  - la regola dei buffer non è provata su un film intero; con il tetto di 32 MiB per segmento il caso peggiore (128 Mbps, segmenti da 6 s) arriva a circa 124 MiB, sotto i 150 MiB di Chromium, e lo supererebbe solo un picco sopra circa 165 Mbps;
  - il controllo dell'audio che sparisce usa proprietà non standard;
  - in Firefox non si distingue Windows 10 da 11;
  - `eslint-plugin-jsx-a11y-x` è un fork giovane; axe nell'e2e resta come rete.
- **Da rivedere:**
  - quando l'ADR 0003 è accettata (ipotesi H-A…H-J);
  - dopo il test su un film intero in F2 (buffer);
  - se arrivassero rendition audio separate (build completa e `hls.audioTrack`);
  - alla seconda lingua (libreria i18n);
  - all'arrivo dell'autenticazione (salvataggio del token);
  - se servisse un browser TV (Norigin Spatial Navigation, oppure Svelte).
- **Dipendenze:** ADR 0001 (con la deroga sul `tsconfig`), 0003, 0004, 0006; Decision Engine (F1b) per il vocabolario delle capability, `maxFrameRate`, `limits.maxBitrate` e la ripianificazione; ADR del client TV (contratto e protocollo condivisi, nessuna UI condivisa).
