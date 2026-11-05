# 0001 — Runtime backend: TypeScript su Node.js 26 LTS con Fastify 5

- **Stato:** Accepted (2026-11-06)
- **Data:** 2026-11-05
- **Decisore:** Claude, su delega del proprietario (review: design-reviewer, correzioni applicate)
- **Requisiti collegati:** §2 (container indipendenti), §5 (Direct Play, Direct Stream, Transcode), §8 (fino a 3 sessioni), §18 (portabilità, qualità, evolvibilità), §20 (linguaggio/framework aperto); doc 02 §3, §6 (C1); doc 03 §5, §8, I4; doc 04 §6–7
- **Valutazione completa:** [05 — §1 Runtime e framework del backend](../architecture/05-technology-evaluation.md#1-runtime-e-framework-del-backend)

## Contesto

Il Video Service è un monolite modulare (doc 02 C1). Il lavoro sui media gira in processi figli (ffprobe, ffmpeg). Il server deve:
- avviare, sorvegliare e terminare quei processi in modo affidabile;
- servire file da 40–80 GB con `Range` e segmenti HLS dallo scratch;
- reggere fino a 3 sessioni insieme ai job di ingest;
- esporre un'API contract-first (doc 03 I4).

Stream Delivery deve poter diventare un container `video-worker`.

L'host ha Node 22 e Python 3.12, più un Node 26.13.0 portabile installato il 2026-11-05; .NET e Go non sono installati. Il codice è scritto dall'AI e rivisto dal proprietario, forte in Python e TypeScript. L'MVP va costruito subito, quindi conta anche la velocità di consegna.

## Opzioni considerate

### A. TypeScript su Node.js 26 con Fastify 5
- Pro:
  - streaming e `Range` nativi (verificati);
  - route e validazione registrate direttamente dallo spec OpenAPI 3.1 (verificato);
  - un solo linguaggio per server, web client e tooling del contratto;
  - unioni discriminate per il Decision Engine;
  - nessuna build grazie al type stripping stabile;
  - ecosistema maturo (sharp, pino, Vitest).
- Contro:
  - un solo thread JS: il lavoro CPU-bound va tenuto fuori (lo è già: ffmpeg);
  - better-sqlite3 è sincrono (ADR 0002);
  - `openapi-typescript` richiede un `overrides` per TypeScript 6.

### B. Python con FastAPI o Litestar
- Pro: asyncio subprocess, Starlette con `Range`, guessit disponibile, codice degli spike già in Python.
- Contro:
  - FastAPI è code-first, quindi il contract-first richiede generazione dei modelli più test di conformità;
  - due linguaggi tra server e web;
  - tipizzazione opzionale.

### C. Go 1.27
- Pro: `os/exec` e `http.ServeContent` eccellenti, footprint minimo, `oapi-codegen` strict-server.
- Contro:
  - toolchain assente;
  - il proprietario non può rivederlo a fondo;
  - niente tipi somma;
  - due linguaggi.
- I vantaggi cadono su criteri dove Node supera già il requisito con margine.

### D. Kotlin/JVM con Ktor 3.6
- Pro: stesso linguaggio del client Android TV, tipi forti.
- Contro: JVM e Gradle pesanti per un mini-PC e lenti nel ciclo; non installati; codice poco rivedibile.

## Evidenze

- **Smoke test dello stack** (2026-11-05, throwaway, host Windows, Node 22.14, ffmpeg 7.0), dettagli in [05 §1.5](../architecture/05-technology-evaluation.md#15-esperimento-smoke-test-dello-stack-2026-11-05):
  - install senza compilatore (prebuild N-API);
  - spec 3.1 → route con validazione (400) e serializzazione che rimuove i campi non dichiarati;
  - `Range` → 206 con `Content-Range` corretto e 416 fuori range;
  - ffmpeg lungo annullato con `AbortSignal` → SIGTERM in 1,56 s;
  - ffprobe con `timeout`.
- **Node 26 sull'host** (2026-11-05): l'host ha ora Node **26.13.0** portabile (npm 11.20.0). Lo smoke test del database (migrazioni Drizzle, FTS5, better-sqlite3 13.0.3 con SQLite 3.53.4) **passa** su questa versione (ADR 0002). Il `package.json` della radice dichiara `engines.node` `>=26.13.0 <27` e la radice ha un `.nvmrc` con `26.13.0`.
- **Verifica in container ancora da fare:** il primo passo di build della fase F0 riesegue gli stessi test dentro `node:26.13.0-trixie-slim`, cioè sull'immagine di produzione (Linux, segnali veri per ffmpeg).
- **S3:** il costo dello streaming è in ffmpeg (remux a 54× il tempo reale, avvio sotto il secondo), non nel server HTTP.
- **Versioni** verificate sui registry il 2026-11-05. Ciclo di vita di Node dallo [schedule ufficiale](https://github.com/nodejs/Release/blob/main/schedule.json), type stripping stabile dalla [documentazione di Node 26](https://nodejs.org/api/typescript.html).
  - TypeScript: `latest` su npm è **7.0.2**; si fissa comunque la 6.0.3 (vedi Decisione).
  - sharp: **0.35.5** è `latest` su npm (pubblicata il 2026-09-27). Non ha script di install: i binari arrivano già compilati come dipendenze opzionali `@img/sharp-<piattaforma>` (linux x64/arm64, win32 x64 e altre).
  - Immagine `node:26.13.0-trixie-slim`: digest dell'indice multi-arch `sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39` (Docker Hub, tag aggiornato il 2026-10-28, letto il 2026-11-05).

## Decisione

**Opzione A.** Stack fissato (versioni del 2026-11-05; si aggiornano le patch, le major solo con revisione di questa ADR):

| Ruolo | Scelta | Note |
|---|---|---|
| Runtime | **Node.js 26.13 LTS "Lithium"** (supporto fino al 2029-04-30) | Immagine `node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39` (Debian 13, compatibile con jellyfin-ffmpeg di ADR 0006); tag e digest si aggiornano insieme, a mano.<br>`engines.node` `>=26.13.0 <27` nel `package.json` della radice, `.nvmrc` con `26.13.0` |
| Linguaggio | **TypeScript 6.0.3**, versione esatta (niente `^`), eseguito con il **type stripping nativo** di Node | `tsc --noEmit` per il type-check. `latest` su npm è la 7.0.2: niente TS 7 finché `typescript-eslint` (≤ 6.0) e `openapi-typescript` non lo supportano |
| Framework HTTP | **Fastify 5.12.8** | Plugin incapsulati per modulo, logger pino integrato, `inject()` per i test |
| Routing dal contratto | **fastify-openapi-glue 4.12.0** | Vedi ADR 0004 |
| Validazione HTTP | **Ajv 8.20.0** (`ajv/dist/2020`), compilatore di validazione di Fastify | Schemi presi dallo spec OpenAPI 3.1 |
| Validazione ai confini non HTTP | **Zod 4.6.7** | Configurazione da env, output JSON di ffprobe, risposte dei provider |
| Processi figli | **execa 10.2.1** sopra `node:child_process` | Sempre con array di argomenti, mai shell |
| File e Range | **@fastify/send 4.2.1** | Direct Play, playlist e segmenti dallo scratch |
| Logging | **pino 10.4.0** (via Fastify) | JSON su stdout; il serializer `req` maschera il token di sessione nei path `/s/{token}/` (regola 7) |
| Immagini | **sharp 0.35.5** | Varianti WebP dell'Artwork Store per gli upload del proprietario e i frame dal video. Le immagini TMDB **non** si ridimensionano (ADR 0007). Binari precompilati, nessuno script di install |
| ID | **uuid 14.0.3** (UUIDv7) | ID opachi e ordinabili (doc 03 P3) |
| HTTP client verso i provider | `fetch` nativo di Node | Retry e `Retry-After` in un helper del Metadata Provider Adapter |
| Rate limiter dei provider | **scritto a mano**: un token bucket per host | Pochi file, nessuna dipendenza; limiti e concorrenza per host da ADR 0007 |
| Scheduler e Job Runner | **scritto a mano**: un ciclo su `job.run_at` | Concorrenza per tipo e trigger periodici nella regola 6 |
| Parser dei filename e matcher | **port a mano** in TypeScript del parser a regole di S4 (`spikes/s4-identification/rules.py`), con `ratio` e `token_sort_ratio` (distanza Indel) compatibili con rapidfuzz scritti a mano | Nessuna dipendenza; test di parità (ADR 0007, §4) |
| Test | **Vitest 5.1.0** | Unit (Decision Engine table-driven), HTTP con `inject`, integrazione in container con ffmpeg reale |
| Lint e confini | **ESLint 10.14.0** + **typescript-eslint 8.72.1**; **dependency-cruiser 18.7.2** | Regole dei confini tra moduli dentro `npm run verify` (regola 8) |
| Workspace | npm workspaces: `services/video`, `clients/web` | Un solo lockfile, un solo `typescript` |

**Regole d'uso vincolanti:**
1. **tsconfig:**
   - `strict`, `noUncheckedIndexedAccess`;
   - `erasableSyntaxOnly`, `verbatimModuleSyntax`;
   - `module: nodenext`, `rewriteRelativeImportExtensions`, `noEmit`;
   - `"types": ["node"]` (nessun tipo globale caricato per caso da `node_modules/@types`) e `rootDir` esplicito in ogni workspace.
   - Niente `enum`, `namespace` runtime, parameter properties o decoratori: si usano unioni di letterali e oggetti `as const`. Import relativi con estensione `.ts`, alias solo con subpath imports `#…`.
2. **Moduli:**
   - `services/video/src/modules/<modulo>/` con un `index.ts` che è l'unica API pubblica del modulo;
   - dependency-cruiser vieta gli import tra file interni di moduli diversi;
   - vieta anche qualsiasi import di I/O (`node:fs`, `node:child_process`, DB, HTTP) nel modulo `playback-decision`.
3. **Process supervisor** (in Stream Delivery e Media Analyzer):
   - ogni processo figlio è registrato per sessione o job;
   - stop = `SIGTERM` con `forceKillAfterDelay: 5000`;
   - timeout espliciti per ffprobe;
   - ultime righe di stderr conservate per la diagnostica (exit 139 in S3);
   - all'avvio si svuota lo scratch e non si lasciano processi orfani;
   - i path dei media si costruiscono da root + path relativo, con verifica anti-traversal (doc 03 §8).
4. **Stream Delivery estraibile:**
   - l'interfaccia `StreamDelivery` (`start`/`stop`/`status`, doc 03 §8) accetta e restituisce solo dati serializzabili;
   - l'implementazione MVP è in-process (`LocalStreamDelivery`);
   - un `video-worker` futuro è lo stesso codice con un altro entrypoint e un client HTTP interno.
5. **Event loop:** nessun lavoro CPU-bound sul thread principale oltre a quello di pochi millisecondi. Le scansioni scrivono a lotti (ADR 0002).
6. **Job Runner e scheduler** (scritti a mano, nessuna libreria di code o cron):
   - un ciclo reclama i job con `run_at <= now` dalla tabella `job` (ADR 0002); `job.run_at` è l'unica fonte del prossimo tentativo, anche per backoff e `Retry-After`;
   - concorrenza per tipo: `probe` 1, `identify` 1, `metadata` 1, `artwork` 2;
   - trigger periodici, che accodano job idempotenti:
     - scansione della libreria ogni `LIBRARY_SCAN_INTERVAL_MIN` minuti (default 15, ADR 0006);
     - backup del database ogni giorno (ADR 0002);
     - scadenza dei valori TMDB ogni giorno (`ExpireProviderValues`, ADR 0007);
     - `PRAGMA optimize` ogni giorno e alla chiusura.
7. **Token e log:**
   - i token di sessione del data plane sono 32 byte casuali (`crypto.randomBytes`) codificati base64url;
   - il confronto con il token atteso è a tempo costante (`crypto.timingSafeEqual` su buffer della stessa lunghezza);
   - il serializer `req` di pino sostituisce il segmento `/s/{token}/` dei path con `/s/***/`, così i token non finiscono nei log.
8. **Verifica locale** (nessuna CI ospitata per ora; avrà una sua ADR):
   - un unico `npm run verify` alla radice esegue type-check, lint, dependency-cruiser, test, lint e bundle del contratto, e il controllo che il codegen non produca diff (ADR 0004);
   - si esegue prima di ogni commit;
   - oasdiff, Schemathesis e OpenAPI Generator girano via Docker come gate di milestone (ADR 0004).

## Conseguenze

- **Più facile:**
  - server, web client e contratto condividono linguaggio, tipi generati, test runner e lockfile;
  - nessuna build per eseguire il server, quindi `node --watch` dentro `compose watch` (ADR 0006);
  - il Decision Engine è testabile come funzione pura con tipi esaustivi.
- **Più difficile:**
  - disciplina sulla sintassi cancellabile (niente `enum`) e sugli import con estensione;
  - un `overrides` npm per `openapi-typescript` su TypeScript 6;
  - il lavoro CPU-bound in-process richiede `worker_threads` se compare.
- **Criterio di accettazione da misurare nell'MVP:** event loop delay p99 sotto 50 ms (`perf_hooks.monitorEventLoopDelay`) durante una scansione completa con una sessione Direct Stream attiva. Se fallisce, si spostano le scritture dell'ingest in un worker thread prima di cambiare runtime.
- **Da rivedere:**
  - all'estrazione di `video-worker`: lì Go resta il runner-up se servisse un footprint minimo;
  - a TypeScript 7, quando il tooling lo supporta;
  - all'upgrade di major di Node: con il nuovo ciclo annuale la prossima LTS è la 27, in ottobre 2027, secondo lo schedule ufficiale. Il vincolo `engines` `<27` va alzato solo con quella revisione;
  - al primo passo di F0, se i test in `node:26.13.0-trixie-slim` danno esiti diversi da quelli sull'host Windows.
- **Dipendenze:**
  - ADR 0002 (better-sqlite3 e Drizzle, tabella `job`);
  - ADR 0004 (fastify-openapi-glue, openapi-typescript);
  - ADR 0006 (immagine trixie, `init: true`, `compose watch`);
  - ADR 0007 (limiti per host del rate limiter, parser e matcher portati da S4);
  - [ADR 0003](0003-streaming-hls-fmp4-segmenter.md), streaming (accettata il 2026-11-05): forma dei segmenti servita da `@fastify/send`;
  - [ADR 0005](0005-web-client-react-vite.md), web client (accettata il 2026-11-05).
