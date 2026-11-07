# 05 — Valutazione tecnologica

- **Stato:** completo per l'MVP. Le ADR delle aree 1–7 sono **Accepted**; le ha accettate l'orchestratore dopo il passaggio del `design-reviewer` (CLAUDE.md, decisioni delegate dal proprietario il 2026-11-05). L'area 8 (client TV) ha l'ADR 0008 **Accepted** (2026-11-07).
- **Data:** 2026-11-05; area 8 il 2026-11-07
- **Fonti interne:** [requisiti](../requirements/0001-video-service-requirements-v0.1.md) (§20–21 e le sezioni citate in ogni area); doc [01](01-domain-model.md)–[04](04-playback-architecture.md); report degli spike in [`docs/spikes/`](../spikes/); [standard di libreria](../library-standard.md).

La tecnologia segue i requisiti: ogni area parte dalla decisione da prendere e da criteri pesati, ricavati dai requisiti, e confronta le opzioni con un punteggio che distingue **evidenza** (**E**: spike, smoke test, documentazione) da **giudizio** (**G**). La decisione vincolante sta nell'ADR dell'area; qui resta il ragionamento completo.

## Sintesi

| # | Area | Scelta | Runner-up | ADR |
|---|---|---|---|---|
| 1 | [Runtime e framework del backend](#1-runtime-e-framework-del-backend) | TypeScript 6.0.3 su Node.js 26.13 LTS, Fastify 5.12.8 | Go 1.27 | [0001](../adr/0001-runtime-backend-typescript-node-fastify.md) |
| 2 | [Database e migrazioni](#2-database-e-migrazioni) | SQLite 3.53 in WAL, better-sqlite3 13.0.3, Drizzle ORM 0.45.4 | PostgreSQL 18.6 (motore), Kysely 0.29.8 (query layer) | [0002](../adr/0002-database-sqlite-drizzle.md) |
| 3 | [Formato del contratto API e codegen](#3-formato-del-contratto-api-e-codegen) | OpenAPI 3.1.1 scritto a mano, fastify-openapi-glue, openapi-typescript, OpenAPI Generator | TypeSpec 1.17 | [0004](../adr/0004-contratto-api-openapi-3-1.md) |
| 4 | [Deploy e gateway](#4-deploy-e-gateway) | Docker Compose, Caddy 2.11.8, `jellyfin-ffmpeg8` 8.1.3-2 | nginx 1.30 con `proxy_buffering off` | [0006](../adr/0006-deploy-e-gateway.md) |
| 5 | [Provider dei metadata e funzionamento offline](#5-provider-dei-metadata-e-funzionamento-offline) | TMDB per l'arricchimento, Wikidata per identificazione e base durevole | Identificazione TMDB-first | [0007](../adr/0007-provider-metadata-e-offline.md) |
| 6 | [Protocollo di streaming e Stream Delivery](#6-protocollo-di-streaming-e-stream-delivery) | HLS fMP4 (CMAF) con playlist VOD dell'intero film, segmenter proprio sui confini dei keyframe (indice dai Cues dell'MKV), un ffmpeg figlio per sessione rallentato dalla backpressure, Direct Play con `@fastify/send` | DASH CMAF; muxer `hls` di ffmpeg con playlist EVENT | [0003](../adr/0003-streaming-hls-fmp4-segmenter.md) |
| 7 | [Web client](#7-web-client) | React 19.3.1, Vite 8.3.6, TanStack Router e Query, openapi-fetch; player con hls.js 1.7.4 light e libpgs 0.9.0 | Svelte 5.57.3 | [0005](../adr/0005-web-client-react-vite.md) |
| 8 | [Client TV](#8-client-tv) | App Android nativa: Kotlin 2.4.21, Compose for TV (tv-material 1.1.0), Media3 1.11.1; client generato con OpenAPI Generator `jvm-retrofit2` su OkHttp 5.5.1 | Kotlin con Leanback | [0008](../adr/0008-client-tv-kotlin-compose-media3.md) (**Accepted**) |

**ADR previste, senza numero:** accelerazione hardware del transcode (dopo H10), thumbnail, CI ospitata, backup fuori dall'host.

**Decisioni aggiunte dopo la revisione di design (2026-11-05)**, riportate nelle aree e nelle ADR:
- path fissi nel container sotto `DATA_DIR=/data` e volume `video-backup` (§4.6.2, ADR 0006);
- proiezione risolta materializzata in `catalog_item`, risposte dei provider solo nella tabella `provider_cache`, `job.run_at` come unica fonte del prossimo tentativo (ADR 0002);
- URL delle immagini indirizzati per contenuto, con `Cache-Control` più breve per le immagini TMDB; nessuna unione `oneOf` con `discriminator` in `v1`; parametro `cursor` ovunque e `CURSOR_EXPIRED` (ADR 0004);
- lock sui valori TMDB, passo "tag ID" prima del matching fuzzy, port a mano del parser di S4 con test di parità (ADR 0007);
- rate limiter, Job Runner e scheduler scritti a mano, sharp per le varianti WebP, un unico `npm run verify` prima di ogni commit (ADR 0001).

**Convenzioni di lettura:**
- un rimando «§n» senza altro prefisso indica una sezione dei requisiti; i rimandi interni a questo documento usano la numerazione dell'area («§4.6.2»); «doc 0x §n» indica i documenti di architettura;
- le sigle dei criteri (K1, D1, A1, M1…) valgono solo dentro la propria area.


---

## 1. Runtime e framework del backend

- **Area:** linguaggio, runtime e framework web del Video Service
- **ADR:** [0001 — TypeScript su Node.js 26 con Fastify 5](../adr/0001-runtime-backend-typescript-node-fastify.md) (Accepted)
- **Data:** 2026-11-05
- **Aree collegate:** [database](#2-database-e-migrazioni) (ADR 0002), [contratto API](#3-formato-del-contratto-api-e-codegen) (ADR 0004), [deploy](#4-deploy-e-gateway) (ADR 0006), [metadata](#5-provider-dei-metadata-e-funzionamento-offline) (ADR 0007), [streaming](#6-protocollo-di-streaming-e-stream-delivery) (ADR 0003), [web client](#7-web-client) (ADR 0005)

### 1.1 Decisione da prendere

In quale linguaggio, runtime e framework HTTP si scrive il Video Service.

Il Video Service è un **monolite modulare** (doc 02 C1) con tredici moduli: Library Monitor, Media Analyzer, Identifier, Metadata Provider Adapter, Enricher, Catalog, Artwork Store, Profiles & Watch State, Playback Decision Engine, Session Manager, Stream Delivery, Job Runner e API. Il lavoro pesante sui media gira **sempre in processi figli** (ffprobe, ffmpeg). Il server orchestra quei processi, serve byte e risponde alle API.

### 1.2 Criteri

| # | Criterio | Fonte | Peso | Vincolo rigido? |
|---|---|---|---|---|
| K1 | **Controllo dei processi figli**: spawn, stdout in streaming, kill con escalation, timeout, nessun processo orfano | doc 02 C1 e §3.11, doc 04 §7, S3 (crash di ffmpeg con exit 139) | 5 | sì |
| K2 | **Streaming di file grandi** con `Range` (Direct Play, 40–80 GB) e servizio di playlist e segmenti HLS dallo scratch | §5.1, doc 03 §5, doc 04 §6.2 | 5 | sì |
| K3 | **Concorrenza**: fino a 3 sessioni e job in background senza che l'ingest rallenti il playback | §8, doc 02 §3.12 | 3 | no |
| K4 | **Contract-first**: la specifica guida routing e validazione, con tipi generati condivisi con il web client | doc 03 I4, P6, P8 | 4 | no |
| K5 | **Tipizzazione e testabilità**: il Decision Engine è logica pura con varianti (modalità, delivery dei sub) da modellare come unioni discriminate | doc 02 §3.9, §18 "Qualità" | 4 | no |
| K6 | **Portabilità** Windows/Docker Desktop → Linux, immagine Debian con jellyfin-ffmpeg | §18 "Portabilità", ADR 0006 | 4 | sì |
| K7 | **Velocità di consegna con sviluppo AI e revisione del proprietario** (MVP da costruire subito; il proprietario rivede in Python/TS) | CLAUDE.md, mandato dell'orchestratore | 4 | no |
| K8 | **Estraibilità di Stream Delivery** in un container `video-worker` | doc 02 C1, doc 03 §8 | 3 | no |
| K9 | **Ecosistema di dominio**: varianti di immagini, client HTTP con retry, parsing | doc 02 §3.4, §3.7, S4 | 2 | no |
| K10 | **Footprint** su un mini-PC | §18, doc 04 §7 | 2 | no |

La familiarità del proprietario conta solo dentro K7, come capacità di **rivedere** il codice: lo sviluppo è guidato dall'AI.

### 1.3 Opzioni

Le versioni sono state verificate il 2026-11-05 sui registry ufficiali (npm, PyPI, go.dev, GitHub releases).

#### A. TypeScript su Node.js con Fastify
- **Runtime:** Node.js **26.13.0 LTS "Lithium"**, LTS dal 2026-10-28 e supportato fino al 2029-04-30. Node 24 "Krypton" è in manutenzione fino al 2028-04-30 ([schedule Node.js](https://github.com/nodejs/Release/blob/main/schedule.json)). Il type stripping nativo è **stabile da v24.12/v25.2**, quindi Node esegue `.ts` senza build se si usa solo sintassi cancellabile ([docs Node 26](https://nodejs.org/api/typescript.html)).
- **Framework:**
  - **Fastify 5.12.8** (MIT, 2026-11-02): validazione JSON Schema integrata (Ajv), serializzazione da schema, plugin incapsulati, `inject()` per i test;
  - Hono 4.13.16: Web Standard Request/Response, sul file system di Node meno diretto;
  - NestJS 12.3.3: DI e decoratori, code-first; i decoratori non passano dal type stripping.
- **Processi:** `node:child_process` con **execa 10.2.1** (MIT): `cancelSignal`, `forceKillAfterDelay`, `timeout`, stream di stdout.
- **Range:** `@fastify/send` 4.2.1 (206, 416, `Accept-Ranges`, ETag).

#### B. Python 3.12+ con FastAPI o Litestar
- FastAPI 0.162.0 (2026-10-23), Litestar 2.25.0, Starlette 1.10.0 (`FileResponse` con `Range`), Pydantic 2.14.2, Uvicorn 0.54.0.
- Processi con `asyncio.create_subprocess_exec`.
- FastAPI è **code-first**: genera lo spec dal codice. Per lavorare contract-first servono `datamodel-code-generator` 0.89.0 per i modelli, route scritte a mano e un test di conformità.
- guessit è disponibile, ma S4 lo ritiene **non sufficiente da solo** e lo mette al più come fallback ([S4 §Conclusioni](../spikes/S4-identification.md)).

#### C. Go (riferimento)
- Go 1.27.3: `os/exec` con `CommandContext` e `WaitDelay`, `http.ServeContent` (Range nativo), `oapi-codegen` in modalità strict-server.
- Non è installato sull'host (si può usare in Docker). Il proprietario non lo conosce.
- Non ha tipi somma: le varianti del `PlaybackPlan` vanno simulate.

#### D. Kotlin/JVM con Ktor (riferimento)
- Ktor 3.6.1 (2026-10-30). Stesso linguaggio del futuro client Android TV.
- JVM e Gradle pesanti per un mini-PC e lenti nel ciclo di sviluppo. Non installati, codice poco rivedibile dal proprietario.

### 1.4 Valutazione

Punteggi 1–5. **E** = evidenza (smoke test §1.5, spike, documentazione ufficiale); **G** = giudizio.

| Criterio (peso) | A. TS/Node/Fastify | B. Python/FastAPI | C. Go | D. Kotlin/Ktor |
|---|---|---|---|---|
| K1 Processi (5) | 4 **E**: cancel → SIGTERM a ffmpeg in 1,5 s, `forceKillAfterDelay` | 4 G | 5 G | 4 G |
| K2 Range/HLS (5) | 5 **E**: 206, `Content-Range` corretto, 416 | 4 G: Range in Starlette, ASGI più indiretto per i file | 5 G | 4 G |
| K3 Concorrenza (3) | 4 G: event loop + libuv; ffmpeg fuori processo | 4 G | 5 G | 5 G |
| K4 Contract-first (4) | 5 **E**: route e validazione registrate dallo spec 3.1, tipi condivisi con il web | 3 G: framework code-first | 4 G | 3 G |
| K5 Tipi/test (4) | 5 G: unioni discriminate, `never` esaustivo, Vitest | 3 G: pyright buono, ma tipi opzionali | 4 G: senza tipi somma | 5 G |
| K6 Portabilità (4) | 5 **E**: prebuild nativi linux/win/musl (better-sqlite3) | 5 G | 5 G | 4 G |
| K7 Consegna AI + revisione (4) | 5 G: un linguaggio per server, web e tooling del contratto | 4 G: due linguaggi | 3 G: toolchain da aggiungere, revisione difficile | 2 G |
| K8 Estraibilità (3) | 4 G | 4 G | 5 G | 4 G |
| K9 Ecosistema (2) | 4 G: sharp 0.35.5 | 5 G: guessit, Pillow | 3 G | 4 G |
| K10 Footprint (2) | 4 G | 3 G | 5 G | 2 G |
| **Totale pesato (/5)** | **4,58** | 3,89 | 4,44 | 3,75 |

**Lettura del risultato.** Go e TypeScript sono vicini, quindi il totale da solo non basta a decidere.
- I punti in cui Go vince (K1, K3, K8, K10) sono quelli in cui **Node supera già il requisito con margine**:
  - il costo vero dello streaming è in ffmpeg, fuori processo (S3: remux a 54× il tempo reale);
  - le sessioni sono al massimo 3;
  - lo smoke test copre controllo dei processi e Range.
- I punti in cui vince TypeScript sono quelli che **vincolano adesso**:
  - consegna immediata;
  - revisione da parte del proprietario;
  - un solo linguaggio e un solo test runner per server, web client e codegen del contratto;
  - unioni discriminate per il Decision Engine.

### 1.5 Esperimento: smoke test dello stack (2026-11-05)

Un test usa e getta nella scratchpad della sessione (non nel repo), su Windows 11 con Node 22.14.0 e ffmpeg 7.0. È durato circa 10 minuti.

| Verifica | Esito |
|---|---|
| Install di `fastify@5.12.8`, `fastify-openapi-glue@4.12.0`, `@fastify/send@4.2.1`, `better-sqlite3@13.0.3`, `kysely`, `execa@10.2.1`, `ajv@8.20.0` | ✅ 12 s, **nessun compilatore**: better-sqlite3 usa prebuild per win32/linux/linuxmusl x64/arm64 (SQLite 3.53.4) |
| Route registrate da uno spec OpenAPI **3.1.1** (`type: [integer, "null"]`, enum, default) con Ajv2020 | ✅ `limit=0` → 400; `kind=cartoon` → 400; default applicati |
| Serializzazione della risposta da schema | ✅ un campo non dichiarato (`leaked`) viene **rimosso** dalla risposta |
| Direct Play con `Range: bytes=1000-1999` | ✅ `206`, `Content-Range: bytes 1000-1999/365532`, 1000 byte; range fuori file → `416` |
| ffmpeg lungo (`-re`, stdout su pipe) annullato con `AbortController` | ✅ `isCanceled`, `SIGTERM`, 97 KB letti, fine in 1,56 s |
| ffprobe one-shot con `timeout` e output JSON | ✅ |
| Errore di validazione | ⚠️ di default è il formato di Fastify (`FST_ERR_VALIDATION`), **non** Problem Details: serve un `setErrorHandler` (ADR 0004) |
| Codegen TS con TypeScript 6 | ⚠️ `openapi-typescript@7.13.0` dichiara il peer `typescript ^5.x`. Con un `overrides` di npm verso 6.0.3 genera tipi corretti (`year: number \| null`) |

**Limiti:**
- solo host Windows, dove `SIGTERM` diventa `TerminateProcess`, cioè un kill immediato. Su Linux, il target dei container, ffmpeg riceve un vero SIGTERM e chiude in modo ordinato;
- Node 22, non 26: le API usate sono stabili in entrambe e i prebuild sono N-API.
- **Ripetizione su Node 26** (2026-11-05): con il Node 26.13.0 portabile ora presente sull'host (npm 11.20.0), lo smoke test del database (migrazioni, FTS5, better-sqlite3 13.0.3 con SQLite 3.53.4) passa. Il primo passo di build di F0 ripete i test dentro `node:26.13.0-trixie-slim`.

### 1.6 Raccomandazione

**TypeScript su Node.js 26 LTS con Fastify 5.** Runner-up: **Go 1.27**, da riconsiderare solo se `video-worker` diventa un componente separato con requisiti di prestazioni che Node non regge, cosa che oggi non risulta.

Lo stack concreto e le regole d'uso sono nell'[ADR 0001](../adr/0001-runtime-backend-typescript-node-fastify.md). In sintesi:
- Node 26.13 LTS, immagine `node:26.13.0-trixie-slim` fissata per digest, `engines.node` `>=26.13.0 <27` e `.nvmrc`;
- TypeScript **6.0.3**, versione esatta (`latest` su npm è la 7.0.2, ma `typescript-eslint` 8.72.1 supporta `<6.1.0` e `openapi-typescript` usa la API JS del compilatore), eseguito con il **type stripping nativo** e quindi senza build; tsconfig con `"types": ["node"]` e `rootDir` esplicito;
- Fastify 5.12.8, fastify-openapi-glue 4.12.0, Ajv 8.20.0 (draft 2020-12), Zod 4.6.7 ai confini non HTTP;
- execa 10.2.1, `@fastify/send` 4.2.1, pino 10.4.0 (con il token di sessione mascherato nei log);
- sharp 0.35.5 per le varianti WebP delle immagini non TMDB (binari precompilati, nessuno script di install);
- **scritti a mano**, senza dipendenze: rate limiter a token bucket per host, Job Runner e scheduler su `job.run_at` (concorrenza per tipo: probe 1, identify 1, metadata 1, artwork 2), parser dei filename e punteggi `ratio`/`token_sort_ratio` compatibili con rapidfuzz, portati da S4 con un test di parità;
- Vitest 5.1.0, ESLint 10.14.0 con typescript-eslint 8.72.1, dependency-cruiser 18.7.2 per i confini tra moduli, tutti dentro un unico `npm run verify` da eseguire prima di ogni commit (la CI ospitata avrà una sua ADR).

**Scartate:**
- **NestJS:** decoratori incompatibili con il type stripping, e code-first;
- **Hono:** ottimo sugli edge, ma sui file di Node e su `Range` aggiunge uno strato; la sua OpenAPI è code-first (`@hono/zod-openapi`);
- **Python:** ragionevole, ma code-first e con due linguaggi;
- **Kotlin:** costo di runtime e di revisione.

### 1.7 Dipendenze con altre aree

- **ADR 0002 (database):** better-sqlite3 è **sincrono** sull'event loop. Va bene con transazioni brevi e un catalogo di qualche migliaio di item, ma va misurato (event loop delay, ADR 0001, Conseguenze).
- **ADR 0004 (contratto):** fastify-openapi-glue registra le route **dallo spec**, e i tipi generati da `openapi-typescript` tipizzano handler e web client. Le due ADR vanno accettate insieme.
- **ADR 0006 (deploy):**
  - immagine `node:26.13.0-trixie-slim` (fissata per digest) con `jellyfin-ffmpeg8=8.1.3-2-trixie` dal repo Jellyfin;
  - `init: true` per raccogliere i processi zombie;
  - `node --watch` dentro `compose watch` (nessuna build: il type stripping evita un passo di transpilazione).
- **ADR 0003, streaming** (accettata il 2026-11-05): il runtime serve la playlist generata e i segmenti fMP4 tagliati dal segmenter, e il Direct Play con `@fastify/send` (§6).
- **ADR 0005, web client** (accettata il 2026-11-05): stesso TypeScript 6.0.3 e Vitest 5 nel workspace npm.
- **ADR 0007 (provider dei metadata):** limiti per host del rate limiter; parser e matcher portati da S4.

### 1.8 Domande aperte

- **TypeScript 7.0 (tsgo):** quando `typescript-eslint` e `openapi-typescript` lo supporteranno, si potrà usare `tsgo --noEmit` per un type-check più rapido. Non blocca.
- **Host di sviluppo:** risolta il 2026-11-05. L'host ha un Node 26.13.0 portabile (npm 11.20.0), e lo smoke test del database passa su questa versione. Resta da ripetere la verifica dentro `node:26.13.0-trixie-slim` al primo passo di F0.


---

## 2. Database e migrazioni

- **Area:** motore di database, driver, query layer e migrazioni, backup
- **ADR:** [0002 — SQLite (WAL) con better-sqlite3 e Drizzle](../adr/0002-database-sqlite-drizzle.md) (Accepted)
- **Data:** 2026-11-05
- **Aree collegate:** [runtime](#1-runtime-e-framework-del-backend) (ADR 0001), [contratto API](#3-formato-del-contratto-api-e-codegen) (ADR 0004), [deploy](#4-deploy-e-gateway) (ADR 0006)

### 2.1 Decisione da prendere

Dove e come il Video Service persiste i suoi dati:
- catalogo con provenienza e campi locked (doc 01 §3.5);
- media e tracce;
- `MediaLink` e `IdentificationCase`;
- profili e stato di visione per profilo;
- coda persistente dei job con priorità e chiave di idempotenza (doc 02 §3.12, doc 03 §8);
- eventi per il polling (doc 03 §7, I3).

Il dimensionamento è di qualche migliaio di item, qualche decina di migliaia di tracce, un nodo solo e un solo processo scrittore. Le sessioni di playback sono runtime e **non** si persistono (doc 02 §7), salvo progress e ViewingRecord.

### 2.2 Criteri

| # | Criterio | Fonte | Peso | Vincolo rigido? |
|---|---|---|---|---|
| D1 | **Operatività minima**: niente container in più se non serve | doc 02 §6 ("`video-db` **se** la tecnologia lo richiede"), §2 | 5 | no |
| D2 | **Backup e restore** semplici, coerenti a caldo e verificabili | §3 (volumi separati), doc 02 §7 | 4 | no |
| D3 | **Integrità transazionale**: lock e provenienza, idempotenza dei job, claim atomico | doc 01 §3.5, doc 03 §8 | 5 | sì |
| D4 | **Concorrenza adeguata**: letture parallele, scritture brevi e rare (progress ogni pochi secondi, job) | §8, doc 03 §4.2 | 4 | no |
| D5 | **Ricerca** su titolo italiano e originale, insensibile ai diacritici, con filtri | doc 03 §3.2, §16 | 3 | no |
| D6 | **Portabilità** Windows/WSL2 → Linux, dati su un volume proprio | §3, §18, ADR 0006 ("mai il DB su bind mount NTFS") | 4 | sì |
| D7 | **Evoluzione**: `video-worker` estratto, accesso remoto, eventuali più istanze | doc 02 C1, §9 | 2 | no |
| D8 | **Tooling TypeScript** (query tipizzate, migrazioni versionate) e **test veloci** | ADR 0001, §18 "Qualità" | 4 | no |

### 2.3 Opzioni

Versioni verificate il 2026-11-05.

#### A. SQLite in modalità WAL, nel processo
- **Driver:**
  - **better-sqlite3 13.0.3** (MIT, 2026-08-05), SQLite 3.53.4 incluso con FTS5 e JSON, API sincrona, prebuild N-API per linux/win/musl x64/arm64, online backup API (`db.backup()`);
  - in alternativa `node:sqlite` integrato, ma Drizzle lo supporta solo nella linea 1.0 (tag npm `node-sqlite`, beta).
- **WAL:** lettori e scrittore non si bloccano a vicenda; uno scrittore alla volta. Non funziona su file system di rete ([sqlite.org/wal.html](https://sqlite.org/wal.html)), quindi il file va in un volume nominato (ADR 0006 lo prevede già).

#### B. PostgreSQL 18.6 in un container `video-db`
- PostgreSQL 18.6, supportato fino al 2030-11-14 ([versions.json](https://www.postgresql.org/versions.json)).
- Concorrenza piena, `pg_trgm` e `unaccent` per la ricerca, `LISTEN/NOTIFY`, code dedicate (pg-boss, graphile-worker).
- **Costi:**
  - un servizio in più da avviare, aggiornare (upgrade di major con `pg_upgrade` o dump/restore) e monitorare;
  - backup con `pg_dump` in un sidecar;
  - test d'integrazione con un container o con PGlite.

#### Query layer e migrazioni (per il runtime di ADR 0001)
- **Drizzle ORM 0.45.4** + **drizzle-kit 0.31.11** (Apache-2.0, 2026-10-08/21):
  - schema in TypeScript, da cui derivano tipi e migrazioni SQL generate e leggibili;
  - `migrate()` all'avvio;
  - la linea **1.0** è in RC (`1.0.0-rc.5`, 2026-10-21), non ancora `latest`.
- **Kysely 0.29.8** (MIT, 2026-11-01):
  - query builder molto stabile, migrazioni in TS scritte a mano;
  - i tipi del DB sono un'interfaccia scritta a mano, perché `kysely-codegen` 0.20.0 dichiara il peer `better-sqlite3 <13`;
  - risultato: due sorgenti (migrazioni e tipi) che possono divergere.
- **Prisma:** la 7.10.1 è stabile, ma `latest` su npm è già `8.0.0-rc.30`. Ha un DSL proprio e una generazione in più nel ciclo. Scartato per peso e per la transizione di major in corso.

### 2.4 Valutazione

Punteggi 1–5. **E** = evidenza, **G** = giudizio.

| Criterio (peso) | A. SQLite WAL | B. PostgreSQL 18 |
|---|---|---|
| D1 Operatività (5) | 5 G: un file in un volume, nessun servizio | 2 G: container, upgrade di major, healthcheck |
| D2 Backup (4) | 5 **E**: `db.backup()` online e coerente; restore = sostituire un file | 3 G: `pg_dump` in un sidecar, restore più lungo |
| D3 Integrità (5) | 5 **E**: transazioni ACID, `UNIQUE` sulla chiave di idempotenza, claim atomico con `UPDATE … RETURNING` (provato) | 5 G |
| D4 Concorrenza (4) | 4 G: uno scrittore, ampiamente sufficiente al carico | 5 G |
| D5 Ricerca (3) | 4 **E**: FTS5 `unicode61 remove_diacritics 2`: "citta" trova "La città incantata", "perche*" trova "Perché proprio a me?" | 5 G: `pg_trgm` + `unaccent`, anche fuzzy |
| D6 Portabilità (4) | 4 **E**: prebuild su tutte le piattaforme; vincolo di volume nominato (WAL) | 4 G: stesso vincolo |
| D7 Evoluzione (2) | 3 G: `video-worker` non tocca il DB (StreamDelivery riceve un `PlaybackPlan` serializzabile); più istanze richiederebbero una migrazione | 5 G |
| D8 Tooling e test (4) | 5 **E**: DB in memoria o file temporaneo per test, migrazione in pochi ms | 4 G: container per i test |
| **Totale pesato (/5)** | **4,52** | 4,00 |

### 2.5 Esperimento (2026-11-05, smoke test, host Windows, Node 22.14)

| Verifica | Esito |
|---|---|
| Schema Drizzle (`catalog_item` con `title_provenance`/`title_locked`, `job` con `idempotency_key` unico) → `drizzle-kit generate` | ✅ un file `0000_init.sql` leggibile, con indici e default |
| `migrate()` all'avvio su un DB in WAL, poi `INSERT … ON CONFLICT DO NOTHING` | ✅ |
| **Claim atomico di un job** (`UPDATE job SET state='running' WHERE id = (SELECT … ORDER BY priority DESC, run_at LIMIT 1) RETURNING *`) | ✅ restituisce il job reclamato già nello stato `running` |
| FTS5 con rimozione dei diacritici | ✅ (vedi il criterio D5 in §2.4) |
| Opzioni di compilazione | `ENABLE_FTS5`, `THREADSAFE=2`; JSON integrato dal 3.38 |

**Limite:** gli enum di Drizzle su SQLite sono solo tipi TypeScript. Nel DB servono `CHECK` espliciti, che Drizzle esprime con `check()`.

**Ripetizione su Node 26** (2026-11-05, host Windows, Node 26.13.0 portabile, npm 11.20.0): migrazioni, FTS5 e better-sqlite3 13.0.3 (SQLite 3.53.4) passano. Al primo passo di F0 gli stessi test girano dentro `node:26.13.0-trixie-slim`.

### 2.6 Raccomandazione

**SQLite 3.53 in WAL**, file `/data/db/video.db` nel volume nominato `video-db` montato su `/data/db`. Driver **better-sqlite3 13.0.3**, query e migrazioni con **Drizzle ORM 0.45.4 / drizzle-kit 0.31.11**.

- **Runner-up per il motore:** PostgreSQL 18.6. Il passaggio va riconsiderato se servono più processi scrittori o più istanze, oppure se la ricerca fuzzy diventa un requisito.
- **Runner-up per il query layer:** Kysely 0.29.8.

Decisivi:
- D1, nessun servizio in più nell'MVP;
- D2, backup a caldo in una riga;
- D8, test su DB in memoria.

Regole aggiunte dopo la revisione di design (dettagli nell'ADR 0002):
- **proiezione risolta materializzata:** `title`, `original_title`, `sort_title`, `year` e `duration` di `catalog_item` sono ricalcolati dal Catalog nella stessa transazione di ogni modifica a `item_field`, insieme alla riga FTS5 di `catalog_search`. Scadenza e purge dei provider sono operazioni del Catalog (`ExpireProviderValues`, `PurgeProviderData(provider)`);
- **risposte dei provider solo nel DB** (`provider_cache`); `video-cache` contiene solo derivati ricostruibili;
- `job.run_at` è l'unica fonte del prossimo tentativo, senza `not_before` in `identification_case`;
- mai `drizzle-kit push` né l'introspezione, che eliminerebbero tabella FTS5 e trigger.

Il carico (§8: 3 sessioni, scritture di progress ogni pochi secondi) è di diversi ordini di grandezza sotto il limite di uno scrittore SQLite in WAL.

**Perché Drizzle e non Kysely:** una sola sorgente (lo schema TS) per tipi e migrazioni, migrazioni SQL generate e rivedibili nel diff, e la massima velocità di sviluppo con l'AI. Il costo è un upgrade 0.45 → 1.0 quando la 1.0 diventa `latest`. Va pianificato e non va fatto con la RC.

### 2.7 Dipendenze con altre aree

- **ADR 0001:**
  - better-sqlite3 è sincrono, quindi transazioni brevi;
  - le scansioni scrivono a lotti (per esempio 500 righe per transazione);
  - l'event loop delay va misurato come criterio di accettazione.
- **ADR 0004:**
  - i cursori di paginazione sono opachi e codificano la chiave d'ordinamento con l'id (keyset), mai un `OFFSET`;
  - gli eventi del polling (`GET /video/api/v1/events?cursor=`) vengono da una tabella `domain_event` con id monotono e retention limitata; un cursore oltre la retention dà `CURSOR_EXPIRED` (410).
- **ADR 0006:**
  - il volume `video-db` è montato su `/data/db`, il volume `video-backup` su `/data/backup` (ADR 0006 §3);
  - su Docker Desktop i due volumi stanno nello stesso disco virtuale WSL: il backup non protegge dalla perdita del disco, e l'artwork caricato dal proprietario non ha backup nell'MVP. Il backup fuori dall'host avrà una sua ADR; sul server Linux `video-backup` può puntare a un altro disco.
- **ADR 0007:** valori per sorgente in `item_field`, risposte dei provider in `provider_cache` e base durevole Wikidata (D5) separate, così la cancellazione dei dati TMDB (§1.D dei termini) è una serie di `DELETE` mirate.

### 2.8 Domande aperte

- **Upgrade a Drizzle 1.0:** quando diventa `latest` su npm. Va pianificato come attività a sé, con `drizzle-kit up` e una verifica delle migrazioni.
- **Retention dei backup:** default proposto 7 giornalieri e 4 settimanali, da confermare nel piano MVP.


---

## 3. Formato del contratto API e codegen

- **Area:** formato della specifica contract-first, validazione lato server, generazione dei client TS e Kotlin, convenzioni trasversali
- **ADR:** [0004 — OpenAPI 3.1 scritto a mano, con codegen TS e Kotlin](../adr/0004-contratto-api-openapi-3-1.md) (Accepted)
- **Data:** 2026-11-05
- **Aree collegate:** [runtime](#1-runtime-e-framework-del-backend) (ADR 0001), [database](#2-database-e-migrazioni) (ADR 0002), [deploy](#4-deploy-e-gateway) (ADR 0006), [streaming](#6-protocollo-di-streaming-e-stream-delivery) (ADR 0003), [web client](#7-web-client) (ADR 0005) e ADR del client TV

### 3.1 Decisione da prendere

Con quale formato si scrive il contratto machine-readable che è la fonte di verità tra il Video Service e i client (doc 03 I4). Da questa scelta dipendono:
- come il server valida richieste e risposte;
- come si generano i client: web subito, Android TV in Kotlin/Media3 dopo, mobile dopo ancora.

Il doc 03 fissa già la semantica:
- control plane REST/JSON;
- data plane HTTP puro con token nell'URL (P9);
- cursori (P5), errori uniformi (P6), millisecondi e UTC (P7);
- evoluzione additiva e versionata (P8);
- polling per le notifiche (I3).

### 3.2 Criteri

| # | Criterio | Fonte | Peso | Vincolo rigido? |
|---|---|---|---|---|
| A1 | Contratto machine-readable **nel repo** come unica fonte di verità | doc 03 I4 | 5 | sì |
| A2 | **Semantica HTTP nativa**: `Range`/206, URL con token nel path, cache delle immagini, `application/problem+json` | doc 03 P6, P9, §5; ADR 0006 (Caddy) | 5 | sì |
| A3 | **Codegen TypeScript** di qualità per il web client | doc 03 I4 | 5 | no |
| A4 | **Codegen Kotlin** utilizzabile per Android TV | §7, doc 03 I4 | 4 | no |
| A5 | **Validazione lato server** derivata dallo stesso artefatto | doc 03 P6, ADR 0001 | 4 | no |
| A6 | **Evoluzione additiva**: client vecchi che ignorano campi ed enum nuovi; rilevamento dei breaking change | doc 03 P8 | 4 | no |
| A7 | Leggibilità, revisione, lint, documentazione | §18 "Qualità" | 3 | no |
| A8 | Velocità con lo sviluppo AI, da subito | mandato dell'orchestratore | 4 | no |

### 3.3 Opzioni

Versioni verificate il 2026-11-05.

#### A. OpenAPI 3.1 scritto a mano (YAML, multi-file)
- **Strumenti:**
  - **Redocly CLI 2.75.0** (MIT) per lint e bundle;
  - **oasdiff 1.35.0** (Apache-2.0, 2026-10-28) per il diff dei breaking change.
- **Server:** **fastify-openapi-glue 4.12.0** (MIT, 2026-10-18), che registra le route dallo spec e supporta 3.1 con Ajv 2020 ([README](https://github.com/seriousme/fastify-openapi-glue)).
- **TS:** **openapi-typescript 7.13.0** + **openapi-fetch 0.17.0** (MIT): solo tipi più un client `fetch` di pochi kB, indipendente dal framework del web client.
- **Kotlin:** **OpenAPI Generator 7.27.0** (Apache-2.0, 2026-11-02), generatore `kotlin`. Il supporto 3.1 è dichiarato **beta** dal tool stesso. In alternativa Fabrikt 28.4.0 (solo modelli e client OkHttp/Ktor).
- **Contract test:** **Schemathesis 4.33.1** (MIT, 2026-11-04), test property-based e di conformità delle risposte dallo spec.
- **OpenAPI 3.2** (pubblicato a settembre 2025) è escluso per ora: il supporto nei tool sopra non è verificato.

#### B. TypeSpec → OpenAPI 3.1
- **@typespec/compiler** e **@typespec/openapi3 1.17.0** (MIT, Microsoft; 1.x GA dal 2025).
- È più conciso: modelli generici (`Page<T>`), decoratori per gli errori, riuso. Emette OpenAPI 3.1, quindi a valle si usano gli stessi tool di A.
- **Costi:**
  - un secondo linguaggio e un compilatore nel ciclo;
  - lo YAML generato va comunque versionato e rivisto;
  - c'è meno codice di esempio da cui l'AI possa attingere.

#### C. Protobuf + Connect (buf)
- `@connectrpc/connect` 2.3.0 e `connect-fastify` 2.3.0 (Apache-2.0); **connect-kotlin 0.10.0** (2026-10-22, pre-1.0).
- Evoluzione dei campi eccellente e codegen forte.
- **Il data plane resta fuori** (Range, segmenti, immagini sono HTTP puro), quindi i contratti diventano due. Paginazione ed errori vanno ridefiniti sopra i codici Connect, e il debug con `curl` e dal browser è meno diretto.

### 3.4 Valutazione

Punteggi 1–5. **E** = evidenza, **G** = giudizio.

| Criterio (peso) | A. OpenAPI 3.1 | B. TypeSpec → OpenAPI | C. Protobuf/Connect |
|---|---|---|---|
| A1 Fonte di verità (5) | 5 G | 5 G | 5 G |
| A2 HTTP nativo (5) | 5 **E**: route 206 descritta e servita dallo stesso spec | 5 G | 2 G: data plane fuori dal contratto |
| A3 Codegen TS (5) | 5 **E**: `year: number \| null`, `nextCursor: string \| null` | 5 G: stesso output | 5 G |
| A4 Codegen Kotlin (4) | 4 **E**: `Int?`/`String?` corretti, enum con valore sconosciuto di fallback; avviso "3.1 beta" | 4 G: stesso output | 4 G: connect-kotlin pre-1.0 |
| A5 Validazione server (4) | 5 **E**: 400 su query non valida, campi non dichiarati rimossi dalla risposta | 5 G | 4 G |
| A6 Evoluzione (4) | 4 G: oasdiff ai gate di milestone, enum aperti nei client | 4 G | 5 G |
| A7 Leggibilità (3) | 4 G | 5 G | 3 G |
| A8 Velocità AI (4) | 5 G | 3 G | 3 G |
| **Totale pesato (/5)** | **4,68** | 4,53 | 3,91 |

### 3.5 Esperimento (2026-11-05, smoke test)

Spec OpenAPI **3.1.1** minimale con:
- `GET /items` (cursore, `limit` con min/max/default, enum `kind`, `nextCursor` nullable);
- `GET /media/{token}/file` (200/206 binario);
- uno schema `Problem`.

| Verifica | Esito |
|---|---|
| `openapi-typescript` 7.13.0 | ✅ 36 ms; tipi `number \| null` corretti. Richiede `overrides` npm per TypeScript 6.0.3 (peer dichiarato `^5.x`) |
| fastify-openapi-glue 4.12.0 + Ajv2020 | ✅ route registrate dallo spec, validazione della query, default, serializzazione che toglie i campi non dichiarati |
| Default degli errori di Fastify | ⚠️ formato proprio (`FST_ERR_VALIDATION`), da mappare su Problem Details con `setErrorHandler` |
| OpenAPI Generator 7.27.0 (immagine Docker `openapitools/openapi-generator-cli:v7.27.0`), `kotlin`, `library=jvm-ktor`, `serializationLibrary=kotlinx_serialization`, `enumUnknownDefaultCase=true` | ✅ modelli `data class` corretti, nullabilità dei tipi 3.1 a lista rispettata, enum con caso sconosciuto (P8). ⚠️ avviso "OpenAPI 3.1 support is still in beta" |

### 3.6 Raccomandazione

**OpenAPI 3.1.1 scritto a mano** in `services/video/contract/`, multi-file e bundled con Redocly. Il bundle `services/video/contract/dist/openapi.json` si versiona ed è l'unico input dei generatori: nessun pacchetto di contratto condiviso, ogni client genera i propri tipi dal bundle. Runner-up: **TypeSpec 1.17**. Passarci è economico, perché l'artefatto consumato a valle resta lo stesso OpenAPI 3.1: si può adottare quando il contratto cresce e la ripetizione diventa un costo.

Decisivi:
- A2: il data plane descritto nello stesso contratto;
- A5: validazione dallo spec, verificata;
- A8: nessun linguaggio in più.

Convenzioni vincolanti (dettagli nell'ADR 0004):
1. **Base path.**
   - Control plane `/video/api/v1/…`, data plane `/video/media/…`, coerenti con le route del gateway (ADR 0006, nessuna riscrittura).
   - La versione maggiore sta nel path; dentro una versione le modifiche sono solo additive (P8).
   - I path nello spec sono assoluti, con `servers: [{ url: "/" }]` e nessun `prefix` in fastify-openapi-glue. Un futuro `video-worker` registra solo le operazioni con il tag `media`.
2. **Token di sessione nel *path*, non in query.**
   - Forma: `/video/media/s/{sessionToken}/…`.
   - Motivo: nelle playlist HLS gli URI dei segmenti sono relativi, e la risoluzione di un riferimento relativo (RFC 3986 §5.2) **eredita il path ma non la query** dell'URL base.
   - Con il token nel path, segmenti e sottotitoli restano autorizzati senza riscrivere le playlist (P9).
   - Il token è di 32 byte casuali in base64url, confrontato a tempo costante, e il serializer di pino lo maschera nei log (ADR 0001).
3. **Errori RFC 9457** `application/problem+json`, con le estensioni `code` (enum stabile: `SESSION_LIMIT_REACHED`, `MEDIA_UNAVAILABLE`, `NO_COMPATIBLE_PLAN`, `SESSION_EXPIRED`, `VALIDATION_FAILED`, `NOT_FOUND`, `CURSOR_EXPIRED`…) ed `errors[]` per la validazione.
4. **Paginazione:** `?limit=&cursor=`, risposta `{ items, nextCursor }` con `nextCursor: string | null`. Il cursore è opaco (keyset, ADR 0002). Il parametro si chiama `cursor` ovunque, eventi compresi. Un cursore non più valido dà `CURSOR_EXPIRED` (HTTP 410) e il client si risincronizza.
5. **Contesto di profilo (P2):**
   - `SelectProfile` restituisce un `profileToken` opaco, inviato come `Authorization: Bearer` sul control plane;
   - nell'MVP è un riferimento al profilo, senza segreto; con l'auth futura diventa un token vero senza cambiare il contratto;
   - lo schema di sicurezza è dichiarato nello spec e gestito da `securityHandlers` di fastify-openapi-glue.
6. **Enum aperti:**
   - i client trattano ogni enum come aperto (`enumUnknownDefaultCase` in Kotlin, ramo `default` nei `switch` TS);
   - aggiungere un valore è additivo; rimuoverlo richiede una nuova versione.
7. **Eventi in polling:** `GET /video/api/v1/events?cursor=<cursor>` → `{ events, nextCursor }`. I tipi di evento sono quelli del doc 03 §7; il payload è un oggetto generico che dipende da `type`.
8. **Sottoinsieme 3.1 "portabile"**, verificato dal lint:
   - nullabilità dei tipi semplici solo come `type: [T, "null"]`; un riferimento nullable come `oneOf: [{ $ref: … }, { type: "null" }]`;
   - in `v1` niente unioni `oneOf` con `discriminator`: `PlaybackSession` è un solo schema con l'enum `mode`;
   - niente `const` né `$ref` con fratelli negli schemi usati dai client Kotlin;
   - `operationId` obbligatorio e in camelCase;
   - ogni operazione ha una risposta `default` di tipo Problem.
9. **Immagini:** URL indirizzati per contenuto (hash nell'URL). Immagini non TMDB: `Cache-Control: public, max-age=31536000, immutable`. Immagini di sorgente `tmdb`: `public, max-age=2592000`, senza `immutable` (ADR 0007).
10. **Verifiche:** `npm run verify` (lint e bundle del contratto, diff del codegen) prima di ogni commit; oasdiff, Schemathesis e OpenAPI Generator via Docker come gate di milestone. La CI ospitata avrà una sua ADR.

### 3.7 Dipendenze con altre aree

- **ADR 0001:** server Fastify, tipi degli handler da `openapi-typescript` (`operations[...]`), TypeScript 6.0.3 con `overrides`.
- **ADR 0002:** cursori keyset; tabella `domain_event` per il polling.
- **ADR 0006:**
  - prefissi `/video/api` e `/video/media`;
  - Caddy non tocca `Authorization` e passa il path invariato;
  - le immagini (`GetImage`) hanno URL indirizzati per contenuto: `immutable` per un anno se non TMDB, 30 giorni senza `immutable` se di sorgente `tmdb`;
  - `/video/healthz` è una route operativa del Video Service, inoltrata dal gateway.
- **ADR 0003, streaming** (accettata il 2026-11-05): il token nel path è un **vincolo** sulla forma dei locatori HLS/DASH.
- **ADR del client TV:** il client Kotlin generato (`jvm-ktor` o `jvm-retrofit2`/OkHttp) va scelto lì insieme allo stack Android. Qui si garantisce solo che la generazione funzioni. → Scelto `jvm-retrofit2` dopo l'esperimento K1 (§8.7, ADR 0008, Accepted).

### 3.8 Domande aperte

- **Libreria HTTP Kotlin del client generato** (Ktor contro Retrofit/OkHttp): decide l'ADR del client TV. Il generatore supporta entrambe. → Retrofit 3.0.0 su OkHttp 5.5.1: il codice `jvm-ktor` non compila sul bundle (§8.7).
- **Toolchain sullo spec reale:** l'orchestratore prova `redocly bundle`, fastify-openapi-glue e openapi-typescript sullo spec multi-file vero durante F0.
- **Generatore Kotlin:** la verifica completa è rinviata all'ADR del client TV. Trigger: inizio del lavoro sul client TV, oppure un fallimento della generazione al gate di milestone. → Fatta il 2026-11-07 (§8.7, [K1](../spikes/K1-kotlin-codegen.md)): `jvm-retrofit2` compila e decodifica i payload d'esempio del contratto con tre mapping di tipo, senza cambiare il contratto; `jvm-ktor` non compila.
- **Push al posto del polling** (SSE): quando arriveranno TV e mobile (I3). Il contratto degli eventi è già quello, cambia il trasporto. → Per la TV resta il polling (§8.8).


---

## 4. Deploy e gateway

- **Stato:** Accettata (2026-11-05). ADR collegato: [0006 — Deploy e gateway](../adr/0006-deploy-e-gateway.md)
- **Area:** layout Docker Compose dell'MVP, gateway/reverse proxy, volumi, mount dei media, ambiente di sviluppo su Windows, configurazione e segreti, ffmpeg nell'immagine del Video Service.
- **Fonti interne:** requisiti §2, §3, §5.1, §9, §18, §19; doc 02 §2.1, §3.1, §3.11, §6 (C1, C2); doc 03 P1, P9, §5; doc 04 §7, P2; [S3](../spikes/S3-stream-latency.md) (M2, H10 e seconda prova H10).
- **Esperimento nuovo:** `spikes/g1-gateway-range/` (throwaway, 2026-11-05), descritto in §4.4.

### 4.1 Decisioni da prendere

1. Quale gateway: serve gli asset statici del web client (C2) e instrada API e media verso il Video Service.
2. Il layout Compose: container, rete, volumi, mount read-only dei media, health check.
3. Come si sviluppa su Windows: tutto in Compose, oppure backend sull'host e Compose per il resto.
4. Come passano configurazione e segreti.
5. Da dove viene ffmpeg nell'immagine del Video Service.

### 4.2 Criteri

| # | Criterio | Fonte | Peso | Tipo |
|---|---|---|---|---|
| K1 | **Pass-through di Range e streaming senza buffering anticipato**: un `Range` arriva al Video Service e torna `206`; il proxy non legge dal Video Service molto più di quanto il client consumi (un seek in Direct Play non deve trascinare centinaia di MB letti dal bind mount NTFS a 500 Mbps) | §5.1, doc 03 §5, S3/H10 I/O | 30% | **vincolo** (dopo la configurazione) |
| K2 | Serve gli asset statici del web client nello **stesso** container, con fallback SPA | doc 02 C2 | 15% | **vincolo** |
| K3 | Resilienza: il gateway resta su e risponde anche con il Video Service giù; health check del backend | §2, §18, doc 02 §2.1 e §7 | 15% | importante |
| K4 | Configurazione semplice e verificabile (pochi file, leggibili in review, default sicuri) | §18 Modularità, sviluppo guidato da AI | 15% | importante |
| K5 | TLS e accesso remoto futuri senza toccare il Video Service | §9 Evoluzione, doc 02 §2.1 | 15% | importante |
| K6 | Portabilità: immagini ufficiali amd64 + arm64, stesso file Compose su Windows/Docker Desktop e su Linux | §18 Portabilità | 10% | **vincolo** |
| — | Manutenzione, licenza, storico di sicurezza | — | (dentro K4/K6) | — |

La familiarità del proprietario conta poco: Caddyfile e `nginx.conf` sono entrambi leggibili.

### 4.3 Opzioni per il gateway (stato al 2026-11-05)

| | **Caddy** | **nginx** | **Traefik** |
|---|---|---|---|
| Versione corrente | **2.11.8** (2026-11-04). L'immagine `caddy:2.11-alpine` scaricata oggi riporta `v2.11.8` | **1.30.6** stable (2026-10-14), mainline 1.31.x. `nginx:1.30-alpine` scaricata oggi riporta `nginx/1.30.6` | **3.7.x**: almeno 3.7.11 entro agosto 2026 (fonte secondaria, advisory FreeBSD); ultima patch non verificata |
| Licenza | Apache-2.0 | BSD-2-Clause | MIT |
| Asset statici | `file_server` con `try_files` (fallback SPA) | eccellente (`sendfile`) | **no**: è solo un proxy, servono un secondo container o un web server |
| Streaming verso il backend | nessuno spooling su disco; `flush_interval -1` disponibile | **`proxy_buffering on` di default**: legge l'upstream in anticipo e lo parcheggia in un file temporaneo fino a 1 GB (`proxy_max_temp_file_size`); `proxy_read_timeout` 60 s di default | streaming di default; buffering solo con un middleware esplicito |
| Health check del backend | attivi (`health_uri`) e passivi | solo passivi nella versione open source (quelli attivi sono di NGINX Plus) | attivi e passivi |
| TLS | **HTTPS automatico** (ACME) integrato; `tls internal` per la LAN | certificati esterni (certbot o simili). Esiste un modulo ACME ufficiale dal 2025, non verificato nell'immagine ufficiale | ACME integrato |
| Configurazione | un Caddyfile breve | `nginx.conf` più lungo e con default da correggere per lo streaming | configurazione statica + label Docker o file provider |
| Sicurezza | 5 CVE (2 critiche) corrette in 2.11.1 a febbraio 2026, poi 2.11.2–2.11.8 | correzioni regolari di overflow (1.30.1–1.30.6) | più CVE corrette nel 2026 (3.7.3, 3.7.7–3.7.11) |

Fonti, consultate il 2026-11-05: [Caddy releases](https://github.com/caddyserver/caddy/releases), [Caddy `reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [nginx news 2026](https://nginx.org/2026.html), [Traefik releases](https://github.com/traefik/traefik/releases) e [advisory FreeBSD su Traefik < 3.7.11](https://vuxml.freebsd.org/freebsd/b22fee3d-9f14-11f1-b948-5404a68ad561.html), [Traefik community: "Traefik is still a reverse proxy and not a web server"](https://community.traefik.io/t/is-it-always-necessary-to-use-another-webserver-to-deliver-static-files-or-is-traefik-v2-also-able-to-do-that/5287), [CVE Caddy febbraio 2026](https://www.tenable.com/cve/CVE-2026-27588).

### 4.4 Esperimento G1: Range e lettura anticipata attraverso il proxy

- **Domanda:** il gateway passa `Range` correttamente? Quanti byte legge dal backend quando il client consuma lentamente, come una TV che bufferizza un Direct Play?
- **Setup** (`spikes/g1-gateway-range/run.sh`, output in `out/results.txt`, gitignorato):
  - Docker Desktop 4.98.0, engine 29.9.2, WSL2;
  - origine: Caddy `file_server` su un volume Docker con un file casuale da 1 GiB, che fa da "Video Service" capace di Range;
  - tre proxy davanti all'origine: Caddy 2.11.8 con `reverse_proxy` di default, nginx 1.30.6 di default, nginx 1.30.6 con `proxy_buffering off`;
  - client `curlimages/curl` sulla stessa rete Docker; 2 ripetizioni per proxy.
- **Prove:** Range di 1.000 byte a metà file; GET completo; GET limitato a 5 MB/s e interrotto dopo 4 s, confrontando i byte ricevuti dal client con i byte scritti dall'origine (campo `size` del log dell'origine).

| Proxy | Range | GET completo, TTFB | GET 5 MB/s × 4 s: byte al client | **byte letti dall'origine** |
|---|---|---|---|---|
| Caddy 2.11.8, default | `206`, 1.000 byte | 3–5 ms | 21,0 MB | **33,4–36,1 MB** |
| nginx 1.30.6, default | `206`, 1.000 byte | 3–4 ms | 21,0 MB | **1.073,7 MB (tutto il file)** |
| nginx 1.30.6, `proxy_buffering off` | `206`, 1.000 byte | 2 ms | 21,0 MB | 25,5–26,7 MB |

- **Risultato.** Tutti e tre passano il Range. Con i default, però, nginx ha letto dal backend **l'intero file da 1 GiB in 4 secondi** mentre il client ne consumava 21 MB. Sul bind mount NTFS a circa 60 MB/s (S3/H10), ogni seek in Direct Play costerebbe fino a 1 GB di lettura inutile e saturerebbe l'I/O condiviso con le altre sessioni e con la scansione. Caddy legge solo i buffer di socket in più (circa 12–15 MB); nginx senza buffering è simile.
- **Limiti:** un solo file, rete Docker locale, origine Caddy invece del Video Service reale, nessun HLS. Misura il comportamento dei default, non le prestazioni assolute. In particolare l'origine era **Caddy che leggeva da un volume Docker**, non Node con `@fastify/send` sul bind mount NTFS: va riverificato sul primo Direct Play reale attraverso il gateway.

### 4.5 Punteggio del gateway

Punteggi da 1 a 5. **E** = evidenza (esperimento G1, S3, documentazione), **G** = giudizio.

| Criterio (peso) | Caddy | nginx | Traefik |
|---|---|---|---|
| K1 Range/streaming (30%) | 5 (E: G1) | 3 (E: G1; corretto con `proxy_buffering off` e timeout, ma il default è sbagliato per noi) | 4 (G: streaming di default da documentazione, non misurato) |
| K2 asset statici (15%) | 5 (E: docs) | 5 (E: docs) | **1** (E: non serve file; viola C2) |
| K3 resilienza e health check (15%) | 4 (E: docs, health check attivi; G: con un solo upstream servono poco, conta di più la `handle_errors` che va scritta con cura) | 3 (E: solo passivi in OSS) | 5 (E: docs) |
| K4 semplicità (15%) | 5 (G) | 3 (G: più direttive, default da correggere) | 3 (G: due livelli di configurazione, discovery inutile con 2–3 servizi) |
| K5 TLS/remoto (15%) | 5 (E: ACME integrato) | 3 (G) | 5 (E: ACME integrato) |
| K6 portabilità (10%) | 5 (E: immagine ufficiale multi-arch) | 5 (E) | 5 (E) |
| **Totale pesato** | **4,85** | **3,50** | **3,80, ma escluso dal vincolo K2** |

### 4.6 Layout Compose

#### 4.6.1 Container

| Servizio | Immagine | Ruolo | Porte |
|---|---|---|---|
| `gateway` | costruita da `caddy:2.11.8-alpine` (fissata per digest; quella osservata oggi per `2.11-alpine` è `sha256:70b31807…9ab3`) + build del web client copiata in `/srv/web` | asset statici, instradamento, error page quando il video è giù | **unica porta pubblicata**: `${HTTP_PORT:-8080}` |
| `video` | costruita da `services/video/Dockerfile`: `node:26.13.0-trixie-slim@sha256:e4db4c91…2c39` (ADR 0001) + `jellyfin-ffmpeg8=8.1.3-2-trixie` | monolite modulare (C1), processi figli per ffmpeg | nessuna (solo rete interna) |

Nessun container di database: SQLite è un file nel volume `video-db` (ADR 0002).

- **Rete:** una rete bridge `platform`. Il futuro Music Service si aggancia alla stessa rete con un proprio container e una propria route nel gateway.
- **Instradamento** (il percorso **non** viene riscritto: il Video Service monta le sue route sotto `/video`, P1):
  - `/video/api/*` → `video`, con compressione;
  - `/video/media/*` (data plane, P9) → `video`, con `flush_interval -1` e **senza** compressione;
  - `/video/healthz` → `video`;
  - tutto il resto → `file_server` su `/srv/web` con `try_files {path} /index.html`.
- **Video Service giù** (§2, §18): il gateway non dipende dallo stato del video per partire (nessun `depends_on: service_healthy`); le route `/video/*` rispondono `503` JSON tramite `handle_errors`; il web client si carica e mostra "video non disponibile" (doc 02 §7).
- **Health check:** `video` espone `/video/healthz` (processo vivo e database raggiungibile), usato sia dal `healthcheck` di Compose sia dall'health check attivo di Caddy (`health_uri /video/healthz`, intervallo 10 s). Il `healthcheck` di Compose non richiede `curl` nell'immagine: `node -e "fetch('http://127.0.0.1:8096/video/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`. `gateway` ha un proprio `healthcheck` su una route `respond` locale.
- **Processi figli:** `video` gira con `init: true`. Un init minimale raccoglie gli zombie e inoltra i segnali ai processi ffmpeg (doc 02 C1). Gira inoltre con un utente non root, con `stop_grace_period` di circa 20 s per chiudere le sessioni.
- **Permessi:** il Dockerfile crea con `mkdir -p` tutti i mount point (`/data/db`, `/data/cache`, `/data/artwork`, `/data/thumbnails`, `/data/scratch`, `/data/backup`, `/media`) e ne fa il `chown` all'utente del servizio prima di `USER`, così i volumi nominati nuovi nascono con il proprietario giusto. In F2 `PUID`/`PGID` sono stati sostituiti da un utente fisso 1000:1000 e da `MEDIA_GID` per leggere i media (ADR 0006, aggiornamento F2).
- **Log:** stdout, driver `local` con rotazione.

#### 4.6.2 Volumi e mount

Tutti i dati stanno sotto `DATA_DIR=/data` (decisione dopo la revisione di design; il codice legge i path da `DATA_DIR`).

| Path nel container `video` | Volume o sorgente | Modalità | Note |
|---|---|---|---|
| `/media/<root>` ← `${MEDIA_DIR}` montato su `/media` | **bind mount** | **`:ro`** | invariante §3. Una root su un altro disco è un bind mount in più su `/media/<root>`. Sul server Linux punta a dischi o NAS (NFS/SMB montati sull'host) senza modifiche al servizio |
| `/data/db` | volume nominato `video-db` | rw | file `/data/db/video.db` (ADR 0002). Mai su bind NTFS: SQLite su NTFS via WSL ha lock inaffidabili e I/O lento |
| `/data/cache` | volume `video-cache` | rw | solo cache derivate e ricostruibili (varianti delle immagini, output grezzo di ffprobe): cancellarlo è sempre sicuro. Le risposte dei provider stanno nel DB, tabella `provider_cache` (ADR 0002, ADR 0007) |
| `/data/artwork` | volume `video-artwork` | rw | artwork scaricato, caricato a mano, generato |
| `/data/thumbnails` | volume `video-thumbnails` | rw | frame e anteprime (formato dall'ADR sulle thumbnail) |
| `/data/scratch` | volume `video-scratch` | rw, effimero | **quota applicativa** `SCRATCH_MAX_BYTES` (default 20 GB) applicata da Stream Delivery; svuotato all'avvio e alla chiusura della sessione (doc 04 §7) |
| `/data/backup` | volume `video-backup` | rw | backup giornalieri del database (ADR 0002) |

- **Perché la quota è applicativa:** il driver `local` di Docker non applica quote ai volumi su ext4, e Docker Desktop non offre XFS con `pquota`. Una quota nel codice si comporta allo stesso modo su Windows e su Linux. Sul server Linux si può usare in più un `tmpfs` con `size=`, se la RAM lo permette.
- **Volumi nominati, non bind:** vivono sull'ext4 della VM WSL, quindi sono veloci e senza problemi di lock. Sul server Linux, con un override, possono diventare directory dell'host per i backup.
- **Limiti del backup nell'MVP:** su Docker Desktop `video-backup` sta nello stesso disco virtuale WSL (vhdx) di `video-db`, quindi non protegge dalla perdita del disco; l'artwork caricato dal proprietario (`video-artwork`) non ha backup. Un backup fuori dall'host avrà una sua ADR.

#### 4.6.3 Media su Windows

- Il bind mount NTFS legge circa **500 Mbps** (S3/H10). Bastano per la sessione dell'MVP e per 3 Direct Play UHD da 100–130 Mbps, ma con poco margine durante una scansione.
- **Decisione per l'MVP:** bind mount NTFS read-only. Per misure di prestazioni, i sample possono stare in un volume Docker.
- **Scartato per ora:** far servire i byte del Direct Play al gateway. Duplicherebbe l'autorizzazione con token (P9) e il controllo delle sessioni fuori dal Video Service, per un problema che sul server Linux non esiste. Da riconsiderare solo se servissero 3 sessioni UHD sul PC Windows.
- **Library Monitor:** `LIBRARY_WATCH=off` (default su Docker Desktop, perché inotify non arriva dai path Windows) e scansione periodica ogni `LIBRARY_SCAN_INTERVAL_MIN` minuti (default 15), più `TriggerScan` manuale. Su Linux nativo `LIBRARY_WATCH=auto` aggiunge il watching come ottimizzazione (doc 02 §3.1).

#### 4.6.4 GPU (non nell'MVP)

- Il file Compose base non chiede GPU. P2: il 4K non si transcodifica, e il transcode software fino a 1080p basta.
- Un override `compose.gpu-nvidia.yaml` aggiunge la reservation `driver: nvidia` con capability `gpu, video, compute` (H10: CUDA, NVENC e `tonemap_cuda` funzionano su Docker Desktop/WSL2).
- Un override `compose.gpu-intel.yaml` aggiunge `/dev/dri` per VAAPI/QSV sul futuro mini-PC.
- In ogni caso il servizio fa un **probe delle capability reali** all'avvio (S3). La configurazione `HWACCEL=none|cuda|vaapi|qsv` è un tetto, non un'assunzione.

### 4.7 ffmpeg nell'immagine

| Opzione | Evidenza | Valutazione |
|---|---|---|
| **`jellyfin-ffmpeg8` 8.1.3-2** (pacchetto `.deb` per bookworm e trixie, amd64/arm64, da `repo.jellyfin.org`), versione fissata come `jellyfin-ffmpeg8=8.1.3-2-trixie` | S3/H10: con jellyfin-ffmpeg 8.1.3 in container funzionano decodifica CUDA, NVENC (driver 596) e **`tonemap_cuda`** (4,4× il tempo reale a 24p). Include VAAPI/QSV per Intel | **scelta** |
| ffmpeg delle build linuxserver / BtbN 9.0.x | S3/H10: NVENC **fallisce** con il driver 596 (richiede ≥ 610); nessun `tonemap_cuda` | scartata finché il driver non è ≥ 610 |
| ffmpeg di Debian trixie (7.1.x) | non misurato; nessun `tonemap_cuda` nelle build upstream | scartata: più vecchia, niente catena GPU provata |
| Build da sorgente | — | scartata per l'MVP: costo alto senza un bisogno misurato |

- **Licenza:** jellyfin-ffmpeg è GPL-3.0. Lo usiamo come eseguibile separato in un processo figlio, senza linking, per uso privato.
- Il path del binario è configurabile (`FFMPEG_PATH`, `FFPROBE_PATH`; default `/usr/lib/jellyfin-ffmpeg/`).
- **Regola di aggiornamento:** la major di ffmpeg segue il driver (H10). Il passaggio a 9.x avviene solo con un driver ≥ 610 sull'host di produzione, e lo verifica il probe.
- Fonti, consultate il 2026-11-05: [repo.jellyfin.org, `ffmpeg/debian/latest-8.x/amd64`](https://repo.jellyfin.org/?path=/ffmpeg/debian/latest-8.x/amd64) (elenca `jellyfin-ffmpeg8_8.1.3-2-bookworm` e `-trixie`), [jellyfin-ffmpeg releases](https://github.com/jellyfin/jellyfin-ffmpeg/releases).

### 4.8 Ambiente di sviluppo su Windows

| Opzione | Pro | Contro |
|---|---|---|
| **A. Tutto in Compose, con `docker compose watch` per il ciclo di sviluppo** | stesse immagini, ffmpeg e semantica Linux di produzione (path case-sensitive, segnali e gruppi di processi per i figli ffmpeg); il codice si sincronizza nel container con eventi del filesystem dell'host, quindi senza bind mount NTFS e senza il problema di inotify | debugger da agganciare in remoto; test in container un po' più lenti |
| B. Backend sull'host, Compose per gateway e resto | ciclo più veloce, debugger nativo, I/O host a circa 300 MB/s | ffmpeg dell'host 7.0 contro 8.1 nell'immagine; path Windows (case-insensitive, separatori); il controllo dei processi figli (segnali, kill dell'albero) su Windows è diverso da Linux. Proprio la parte più critica di Stream Delivery verrebbe sviluppata in un ambiente che non è quello vero |

**Decisione: A**, con due eccezioni:
- i **test unitari dei moduli puri** (parser, matcher, Decision Engine) possono girare anche con il toolchain dell'host, per un ciclo veloce degli agenti. I test d'integrazione (ffmpeg, Range, database) girano **nel container** (`docker compose run --rm video …`);
- il **dev server del web client** con hot reload, se l'ADR 0005 (web client) ne prevede uno, gira sull'host e fa da proxy di `/video/*` verso il gateway su `localhost:${HTTP_PORT}`.

`compose.dev.yaml` aggiunge la sezione `develop.watch`, pubblica la porta del Video Service e quella del debugger e alza il livello di log.

### 4.9 Configurazione e segreti

- **Un solo `.env` alla radice del repo**, già ignorato da git (`.gitignore`: `.env`, `.env.*`, eccetto `.env.example`). `.env.example` è versionato e contiene tutte le chiavi con valori vuoti o di default e un commento.
- Il servizio parte **anche senza `.env`**: ogni chiave ha un default, tranne `MEDIA_DIR`, che va impostato perché non ha un default sensato. Compose carica il file con `env_file` e `required: false`.
- **Segreti** oggi: solo `TMDB_READ_TOKEN`. Per ogni segreto si accetta anche la variante `<NOME>_FILE`, che punta a un file: è la convenzione dei Docker secrets, per il server.
- Chiavi principali:
  - `MEDIA_DIR`, `HTTP_PORT`, `TZ`, `LOG_LEVEL`, `DATA_DIR` (default `/data`), `MEDIA_GID` e `PZF_HOSTS` (da F2, al posto di `PUID`/`PGID`);
  - `LIBRARY_SCAN_INTERVAL_MIN`, `LIBRARY_WATCH`;
  - `SESSION_MAX`, `TRANSCODE_MAX`, `SCRATCH_MAX_BYTES`, `HWACCEL`, `FFMPEG_PATH`;
  - `TMDB_READ_TOKEN`, `WIKIDATA_CONTACT` (ADR 0007).
- Come caricare il `.env` della radice con i file Compose in `deploy/` (un `compose.yaml` alla radice con `include`, oppure `--env-file`) si decide in implementazione. I vincoli: un solo `.env`, nessun segreto nei file versionati.
- Una modifica del `.env` diventa effettiva con `docker compose up -d`, che ricrea il container. Nessuna configurazione a caldo nell'MVP.

### 4.10 Rete e TLS

- **MVP:** HTTP in LAN sulla porta `${HTTP_PORT}`, `auto_https off`. Su Windows può servire una regola del firewall per raggiungere la porta di Docker Desktop dagli altri dispositivi: è un passo del proprietario, con UAC.
- **Futuro remoto** (§9): HTTPS automatico di Caddy (ACME) o `tls internal` in LAN, e autenticazione davanti a `/video/*`, senza modifiche al Video Service (doc 02 §2.1). Per la challenge DNS serve una build di Caddy con il plugin del provider DNS (`xcaddy`).
- **Da tenere presente per il client TV:** Android blocca di default il traffico HTTP in chiaro. L'app TV dovrà dichiararlo permesso per la LAN, finché non c'è TLS. Va nell'ADR del client TV. → `base-config` con il chiaro permesso, perché un `domain-config` non accetta intervalli IP (§8.8).

### 4.11 Dipendenze con altre aree

- **ADR 0001 (runtime):** immagine base `node:26.13.0-trixie-slim` fissata per digest e `node --watch` dentro `compose watch`. Se la base cambiasse distribuzione, cambierebbe il pacchetto `jellyfin-ffmpeg8` da installare (esiste anche per bookworm).
- **ADR 0002 (database):** SQLite embedded, file `/data/db/video.db` nel volume `video-db`, backup in `video-backup`; nessun container di database.
- **ADR 0007 (provider):** `.env` dei provider, risposte in `provider_cache` nel DB, artwork TMDB in `video-artwork`.
- **ADR 0003, streaming** (accettata il 2026-11-05): i segmenti HLS/fMP4 passano dal gateway con `flush_interval -1`; il Range del Direct Play è verificato in G1; la quota dello scratch dipende dalla durata dei segmenti tenuti.
- **Accelerazione hardware:** override GPU, versione di jellyfin-ffmpeg abbinata al driver, probe all'avvio.
- **ADR 0005, web client** (accettata il 2026-11-05): la sua build entra nell'immagine del gateway (multi-stage). Il dev server, se c'è, gira sull'host.
- **Contratto API:** base path `/video`, locatori relativi (P1), token nell'URL (P9). Il gateway non tocca la query string.
- **Client TV:** HTTP in chiaro in LAN, TLS in futuro.

### 4.12 Raccomandazione

- **Gateway:** **Caddy 2.11.8** (immagine `caddy:2.11.8-alpine` fissata per digest), con `flush_interval -1` sulle route dei media. È l'unica opzione che rispetta K1 **con i default**, serve gli statici (C2), fa health check attivi e porta il TLS automatico per il futuro.
- **Runner-up:** nginx 1.30.x, con `proxy_buffering off`, `proxy_request_buffering off` e timeout lunghi sui media.
- **Layout:** `gateway` e `video`, nessun container di database; media in bind mount read-only su `/media/<root>`; sei volumi nominati separati sotto `/data` (`video-db`, `video-cache`, `video-artwork`, `video-thumbnails`, `video-scratch`, `video-backup`); quota dello scratch applicativa.
- **Sviluppo:** tutto in Compose, con `compose watch`.
- **ffmpeg:** `jellyfin-ffmpeg8=8.1.3-2-trixie`, versione fissata, GPU solo via override.


---

## 5. Provider dei metadata e funzionamento offline

- **Stato:** Accettata (2026-11-05). ADR collegato: [0007 — Provider dei metadata e funzionamento offline](../adr/0007-provider-metadata-e-offline.md)
- **Area:** contratto del Metadata Provider Adapter, ripartizione dei dati tra le sorgenti, refresh, rate limiting e `Retry-After`, artwork e il suo stato rispetto ai termini TMDB, attribuzione nella UI, comportamento **senza chiave TMDB**.
- **Fissato a monte:** la decisione D5 del proprietario (doc 01 §11). TMDB è il provider principale, con refresh entro la finestra di 6 mesi dei termini; Wikidata fa da base durevole CC0 conservata indefinitamente (titoli IT/originali, anno, ID esterni); i dati TMDB si cancellano alla cessazione della licenza.
- **Fonti interne:** requisiti §11, §12, §13, §16; doc 01 §3.5, §3.6, §3.7, §5.2, D1, D5, D6; doc 02 §3.3–3.5, §3.7, §7; doc 03 §6, §8 (`MetadataProvider`); [S4](../spikes/S4-identification.md); [standard di libreria](../library-standard.md).

### 5.1 Decisioni da prendere

1. Il contratto dell'adapter (che estende `MetadataProvider` del doc 03 §8).
2. Quali dati vengono da quale sorgente, e come si risolve un campo coperto da più sorgenti.
3. Il calendario dei refresh e la scadenza dei dati TMDB.
4. Rate limiting, `Retry-After` e fallimenti per singola query.
5. L'artwork: se è "TMDB Content", come si conserva e come si cancella.
6. L'attribuzione nella UI.
7. Cosa fa l'MVP **finché la chiave TMDB non c'è**, e come attiva TMDB quando arriva.

### 5.2 Criteri

| # | Criterio | Fonte | Peso | Tipo |
|---|---|---|---|---|
| M1 | **Rispetto dei termini TMDB**: §1.C (cache non oltre 6 mesi, niente derivati, niente uso con applicazioni AI), §1.D (purge alla cessazione), §3 (logo e avviso) | termini TMDB, D5 | — | **vincolo** |
| M2 | **La libreria funziona senza API esterne** e sopravvive alla perdita di TMDB | §12, D5 | 25% | **vincolo** |
| M3 | Qualità `it-IT`: trama, titoli, episodi, poster in italiano | §12, §16 | 20% | importante |
| M4 | Qualità dell'identificazione: precision prima della recall, coda "Da verificare" per i dubbi | §11, §13, D6, S4 | 20% | importante |
| M5 | Funziona **stasera senza chiave TMDB**, e attiva TMDB senza migrazioni manuali | vincolo dell'MVP | 15% | **vincolo** |
| M6 | Uso corretto dei provider: niente 429 a raffica, `Retry-After` rispettato, User-Agent conforme | S4 Q3, politiche Wikimedia | 10% | **vincolo** |
| M7 | Le correzioni manuali non si perdono mai (provenienza, lock) | §13, doc 01 §3.5 | 10% | **vincolo** |

### 5.3 Stato delle sorgenti (verificato il 2026-11-05)

#### 5.3.1 TMDB

- **Termini** ([API Terms of Use](https://www.themoviedb.org/api-terms-of-use), "last updated October 20, 2023", riletti il 2026-11-05):
  - **§1.A:** TMDB Content è "any content (**including audio or visual content**) or other information available through, on, or from the TMDB APIs";
  - **§1.B:** la licenza è condizionata all'attribuzione di tutto il TMDB Content (§3);
  - **§1.C**, tra i divieti:
    - "Cache, for longer than 6 months, any information obtained through or from TMDB or the TMDB APIs";
    - "Make derivatives of the TMDB APIs or TMDB Content";
    - "Use TMDB as an image hosting service for banner advertisements, graphics, etc.";
    - usare API o TMDB Content "in connection with, including for training, … a machine learning (ML) or artificial intelligence (AI) based Application";
  - **§1.D:** alla cessazione, "promptly delete or otherwise purge all TMDB Content, including any cached content";
  - **§2.A:** nessun uso commerciale;
  - **§3:** logo TMDB obbligatorio e avviso "uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB".
- **FAQ** ([developer FAQ](https://developer.themoviedb.org/docs/faq), 2026-11-05):
  - gratis per uso non commerciale "as long as you attribute TMDB as the source of the data and/or images";
  - avviso "This product uses the TMDB API but is not endorsed or certified by TMDB";
  - l'attribuzione va "within your application's 'About' or 'Credits' type section".
  - Su cache e immagini la FAQ **non dice nulla**.
- **Forum, staff TMDB** (Travis Bell, [thread](https://www.themoviedb.org/talk/5ba32c77925141523700e0c9)):
  - 2018-09-21: "Yes, you can cache data on your end", con attribuzione di dati **e immagini**;
  - 2020-03-03: durata e refresh della cache sono una scelta dell'implementazione.
  - Le risposte sono precedenti al limite esplicito dei 6 mesi, che prevale.
- **Logo** ([logos & attribution](https://www.themoviedb.org/about/logos-attribution)): cinque varianti SVG ufficiali, colori di marchio `#0d253f`, `#01b4e4`, `#90cea1`. Nessuna regola su dimensioni o posizione.
- **Rate limit** ([rate limiting](https://developer.themoviedb.org/docs/rate-limiting)):
  - il vecchio limite di 40 richieste ogni 10 s è disabilitato dal 2019;
  - resta un tetto "somewhere in the 40 requests per second range", variabile;
  - un `429` va rispettato. `Retry-After` non è documentato.
- **Non misurato:** la chiave manca ancora (S4, test live bloccati).

#### 5.3.2 Wikidata

- **Licenza:** CC0, conservabile senza limiti ([Wikidata:Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)).
- **Rate limit 2026** ([Wikimedia APIs/Rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits), modificata il 2026-10-15, letta il 2026-11-05), per Action API e REST API:
  - **senza User-Agent identificativo: 10 richieste/min**;
  - **bot non autenticato con User-Agent conforme** (nome, versione, contatto email o URL): **200 richieste/min**;
  - un `429` va rispettato con `Retry-After`; in sua assenza "wait at least five seconds, or implement exponential back-off".
  - È la spiegazione più probabile dei 429 visti in S4 dopo circa 10 richieste: lo spike non mandava un User-Agent conforme.
- **WDQS (SPARQL):** 60 s di CPU al minuto e 5 query parallele per IP (S4). In S4: 429 con `Retry-After` fino a 120 s, e `504` dopo circa 66 s per il titolo numerico "2012".
- **Copertura misurata in S4** (94 item famosi):
  - etichetta italiana 97%;
  - ID TMDB e IMDb 94/94;
  - nessuna trama;
  - poster quasi assenti: P18 su 33/94, e quasi mai un poster;
  - episodi italiani scarsi;
  - flag documentario corretto 6/6.

#### 5.3.3 Alternative non scelte

| | Motivo |
|---|---|
| Solo TMDB, con refresh ogni 6 mesi | Contro §12 e D5: alla cessazione della licenza la libreria resterebbe senza titoli e anni |
| Solo Wikidata | Contro §12, M3: nessuna trama, nessun poster, episodi scarsi. Va bene come **modalità degradata** dell'MVP, non come obiettivo |
| TheTVDB (secondo provider per le serie) | Non misurato, chiave e account necessari, termini di cache non documentati (S4). Resta possibile come secondo adapter |
| OMDb | Solo inglese, CC BY-NC (S4) |

### 5.4 L'artwork scaricato da TMDB è "TMDB Content"?

**Lettura più difendibile: sì.**
- Il §1.A include esplicitamente "audio or visual content" disponibile "through, on, or from the TMDB APIs".
- I path delle immagini arrivano dalle API, e i file da `image.tmdb.org`, cioè dall'infrastruttura TMDB.
- La FAQ parla di attribuzione per "data and/or images".
- Il fatto che il copyright dei poster sia degli studi, e non di TMDB, non cambia niente: i termini regolano **il nostro accesso** a quelle copie.

**Conseguenze, applicate all'artwork come ai metadata:**
1. **Copia locale ammessa** (lo staff conferma la cache, P1 del doc 03 vieta comunque l'hotlinking dai client) e soggetta a **6 mesi** di età massima: l'immagine viene **riscaricata** a ogni refresh, non solo riconfermata. Il costo è trascurabile: un poster `w342` pesa circa 30–60 KB.
2. **Nessun derivato** (§1.C): **non ricodifichiamo e non ridimensioniamo** le immagini TMDB. Le varianti di dimensione richieste dall'Artwork Store (doc 02 §3.7) si scaricano **già pronte** dalle taglie offerte dal CDN TMDB, ad esempio:
   - `w342` per la griglia e `w780` per il dettaglio dei poster;
   - `w1280` per i backdrop;
   - `w500` o `original` per i loghi;
   - `w300` per gli still;
   - `w185` per le foto delle persone.

   La generazione di varianti nostre vale solo per gli upload del proprietario e per i frame estratti dal video.
3. **Cancellazione** di tutti i file con sorgente TMDB a scadenza o al purge (§1.D).
4. **Non sono TMDB Content**, e restano:
   - l'artwork **caricato dal proprietario**;
   - i **frame generati dal video** (Artwork Store, sorgente "generato dal video");
   - le immagini con licenza propria (in futuro, ad esempio da Commons, ognuna con la sua attribuzione: non nell'MVP).

### 5.5 Ripartizione dei dati tra le sorgenti

**Principio di memorizzazione:** si salva **un valore per (item, campo, sorgente)**, con `fetched_at`, e non solo il valore vincente. Il valore mostrato si risolve con una precedenza fissa:

```text
manual  >  tmdb (non scaduto)  >  wikidata  >  filename
```

- **Purge e scadenza** diventano "cancella le righe con sorgente `tmdb`": il valore successivo nella precedenza compare da solo, senza logica di ripiego. Sono operazioni del Catalog (`ExpireProviderValues`, `PurgeProviderData(provider)`), accodate dal Job Runner, perché solo il Catalog scrive `item_field`, provenienza e lock e ricalcola nella stessa transazione la proiezione risolta di `catalog_item` e l'indice di ricerca (ADR 0002).
- È un dettaglio d'implementazione compatibile con la provenienza per campo del doc 01 §3.5. Il modello resta lo stesso, ma conserva anche i valori non vincenti.
- **Lock** (doc 01 §3.5): un campo modificato dal proprietario diventa `manual`, ed è contenuto del proprietario che resta (D5). **Solo `manual` è durevole.**
- **Lock su un valore TMDB non modificato** (decisione dopo la revisione di design) = "tieni TMDB come sorgente scelta":
  - il refresh lo riscarica comunque; se il valore è cambiato, il valore mostrato non cambia da solo e l'item riceve un flag di revisione;
  - se i valori TMDB scadono senza refresh, il campo ricade sulla sorgente successiva e la UI lo segnala;
  - per renderlo durevole, la UI offre "fissa come valore manuale", che copia il valore in una riga `source=manual`.

| Campo | Wikidata (CC0, durevole) | TMDB (licenza, ≤ 180 giorni) | Note |
|---|---|---|---|
| ID esterni | QID, `P4947` (TMDB film), `P4983` (TMDB serie), `P345` (IMDb), `P4835` (TheTVDB serie) | `external_ids` | Un ID TMDB **ottenuto da Wikidata** è un dato CC0 e resta; un ID dal filename è contenuto del proprietario e resta.<br>Gli ID numerici TMDB in `external_id` si conservano anche se ottenuti solo da TMDB e anche dopo il purge: sono identificatori che servono a riabbinare. È un'**interpretazione** dei termini, da ricontrollare a ogni loro nuova versione |
| Titolo (IT) | etichetta `it`, poi `en` | `title`/`name` con `language=it-IT` | Precedenza standard |
| Titolo originale | `P1476` con lingua | `original_title` | **Eccezione:** Wikidata prima di TMDB, perché è un dato stabile |
| Alias | alias `it`/`en` | `alternative_titles` (solo matching, non memorizzati a lungo) | Usati dal matcher (S4) |
| Anno | `P577`, la data più antica | `release_date`/`first_air_date` | Precedenza standard |
| Kind | `P31` (film, serie) | endpoint `movie`/`tv` | Filtro di tipo dalla root (standard §2) |
| Documentario (`category`, D1) | `P31`/`P136` (6/6 in S4) | genere 99 "Documentary" | Con provenienza e lock (S4, impatto su doc 01) |
| Generi | `P136` (molto granulari) | `genres` localizzati | La lista TMDB è più adatta ai filtri (§16) |
| Durata | `P2047` | `runtime` | La durata tecnica vera viene dal Media Analyzer |
| Trama | — (la descrizione è una riga, **non** una trama: non va mostrata come tale) | `overview` it-IT, con fallback `en-US` | Senza TMDB, il campo resta vuoto |
| Tagline | — | `tagline` it-IT | |
| Regista, cast | `P57`, `P161` (senza ordine né personaggi) | `credits` ordinati, con personaggi e foto | Le Person di Wikidata hanno un QID durevole |
| Stagioni ed episodi | `P179`/`P527`, scarsi | `season/{n}` it-IT (titoli, trame, still) | Senza TMDB: numeri dal filename e titoli Wikidata dove ci sono |
| Poster, backdrop, logo, still, foto | — | immagini, con `include_image_language=it,null,en` | Il poster si cerca prima in `it`, poi senza testo, poi in `en`; il backdrop prima senza testo |
| Popolarità | — | `popularity` | Solo segnale di matching, non persistito come metadata |

### 5.6 Identificazione

- **Prima di tutto, il passo "tag ID"** ([standard di libreria](../library-standard.md) §3):
  - i tag `{tmdb-…}`, `{imdb-tt…}` e, per le serie, `{tvdb-…}` del filename indicano il candidato;
  - lo spazio dei nomi TMDB (film o serie) segue il tipo dell'item: un ID di serie in `Film/` dà `id_mismatch`; un'opera di tipo diverso da quello atteso dà `kind_mismatch`;
  - titolo e anno del file vanno confrontati con l'opera dell'ID; se non sono coerenti, `id_mismatch`;
  - senza chiave TMDB l'ID si risolve su Wikidata con `haswbstatement:P4947` (film TMDB), `P4983` (serie TMDB), `P345` (IMDb), `P4835` (serie TheTVDB);
  - un ID dal filename è contenuto del proprietario ed è durevole.
- **Con o senza chiave, il matching fuzzy parte da Wikidata.** È l'unica configurazione misurata: S4 v2, T 0,80, M 0,10, precision e recall 98,9% in-sample.
- Così ogni item abbinato in automatico ha **subito** la base durevole (QID) che D5 chiede.
- Il dato TMDB si aggancia tramite l'ID TMDB letto su Wikidata, che in S4 c'era per 94/94 item: nessuna seconda ricerca, nessun nuovo rischio di match sbagliato.
- **La ricerca TMDB si usa:**
  - come **fallback** quando Wikidata non dà candidati, o dà un'opera senza ID TMDB;
  - nella ricerca manuale della coda (`SearchProvider`, doc 03 §6), perché è interattiva e veloce.
  - In entrambi i casi valgono la soglia e il distacco minimo di D6. Le soglie per TMDB **non** si ereditano da Wikidata (S4, Scoperta 4: omonimi oscuri, serve `popularity`): finché non sono misurate, un candidato solo TMDB va in coda con motivo `low_score` o `ambiguous`, salvo distacco netto.
- **Implementazione:** il parser a regole di S4 (`spikes/s4-identification/rules.py`) si riscrive a mano in TypeScript; `ratio` e `token_sort_ratio` compatibili con rapidfuzz (distanza Indel) si scrivono a mano, senza dipendenze. Un test di parità confronta gli output con quelli di rapidfuzz sul corpus S4 e sul holdout, salvati come fixture JSON versionate (solo testo, nessun media). Le soglie T 0,80 e M 0,10 non cambiano.
- **Da rivedere** quando la chiave permette le misure di `tmdb_probe.py` e `match_eval.py --provider tmdb` (S4). Se TMDB risultasse più preciso, diventa la prima fonte di candidati, e Wikidata resta la base durevole agganciata via `haswbstatement:P4947=<id>`.
- **Provider che fallisce** (S4, Scoperta 6): `429`, `5xx`, timeout o `504` producono `ProviderUnavailable`. Il caso resta `pending` e **non** diventa mai `needs_review`; il prossimo tentativo è il `run_at` del job, unica fonte (ADR 0002). Il file intanto resta visibile con il titolo ricavato dal filename (doc 02 §3.5).

### 5.7 Contratto dell'adapter

Estende `MetadataProvider` del doc 03 §8. Nessun tipo del provider esce dall'adapter.

```text
MetadataProvider
  id() → "wikidata" | "tmdb" | …
  status() → not_configured | ok | degraded(until) | invalid_credentials
  terms() → { retention: durable | max_age(days), attribution: AttributionSpec?, purge_on_termination: bool }
  search(query{title, year?, kind?, aliases?}, lang) → Result<Candidate[]>
  lookupByExternalId(provider, id) → Result<ProviderRef?>        # ponte: QID ↔ TMDB ↔ IMDb
  getDetails(ref, lang) → Result<NormalizedMetadata>             # campi con source e fetched_at
  getSeason(ref, n, lang) → Result<NormalizedSeason>
  getImages(ref, lang) → Result<ImageRef[]>                      # ogni ImageRef ha le taglie già pronte
  fetchImage(imageRef, size) → Result<bytes>                     # passa dallo stesso rate limiter

Result<T> = Ok(T) | NotFound | RateLimited(retry_after) | Unavailable(retry_after?) | InvalidRequest(reason)
```

- `terms()` rende **dichiarativa** la politica di conservazione. Enricher, job di scadenza e purge leggono `retention` senza conoscere il provider. Un secondo provider con termini simili (TheTVDB) entra senza toccare il resto.
- **Registro dei provider:** contiene solo quelli configurati. Il **Metadata Enricher** applica la precedenza del §5.5 e il **Catalog** le regole di lock (doc 02 §4).
- **Lingua:** `it-IT`, poi l'originale (doc 02 §3.4), con fallback `en-US` solo per la trama.
- **Cache delle risposte** solo nella tabella `provider_cache` del database (ADR 0002), mai su file:
  - TTL 30 giorni per Wikidata;
  - **24 ore per TMDB**, e cancellata dal purge;
  - nella cache non c'è niente che sopravviva ai 6 mesi.
  - Il volume `video-cache` contiene solo derivati ricostruibili (varianti delle immagini, output di ffprobe): cancellarlo è sempre sicuro.

### 5.8 Refresh e scadenza

| Job | Quando | Priorità | Effetto |
|---|---|---|---|
| Arricchimento iniziale | subito dopo il link (auto o manuale) | normale | Wikidata, poi TMDB se configurato |
| **Refresh TMDB** | per ogni item con `fetched_at(tmdb)` più vecchio di `TMDB_REFRESH_AFTER_DAYS` (**default 90**, ±10% di jitter), controllato ogni giorno | bassa, sotto l'ingest | Riscarica dettagli, stagioni e immagini selezionate. I 90 giorni lasciano 3 mesi di margine per i guasti del provider |
| **Scadenza TMDB** | ogni giorno, `ExpireProviderValues` nel Catalog | alta (è un obbligo) | Cancella valori, immagini, crediti e righe di `provider_cache` con `fetched_at(tmdb)` più vecchio di **180 giorni** (`TMDB_MAX_AGE_DAYS`, configurabile **solo al ribasso**). L'item ricade su Wikidata e filename. **Risolve il caso aperto di D5**: con TMDB irraggiungibile oltre 6 mesi e la licenza ancora attiva, i dati scadono comunque (§1.C) |
| Refresh Wikidata | ogni `WIKIDATA_REFRESH_AFTER_DAYS` (default 180) e su `RefreshMetadata` | bassa | Migliora la base, come le etichette aggiunte nel tempo (La La Land in S4). Un fallimento non ha conseguenze |
| **Backfill TMDB** | all'avvio, se il set di provider configurati è cambiato (impronta salvata nel database) | bassa | Vedi §5.10 |
| **Purge TMDB** | comando di gestione `PurgeProviderData(tmdb)`, operazione del Catalog, per la cessazione della licenza | manuale | Cancella tutto ciò che ha sorgente `tmdb` (§5.9) |

### 5.9 Purge alla cessazione della licenza

- **Si cancella:**
  - le righe `item_field` con `source=tmdb`, anche se lockate senza modifica;
  - le righe di `provider_cache` di `tmdb`;
  - le righe di artwork con sorgente `tmdb`, con i loro file in `video-artwork` e le eventuali varianti in `video-cache`;
  - le Person e i Credit di sorgente `tmdb`.
- **Resta:**
  - gli ID numerici TMDB in `external_id`, anche se ottenuti solo da TMDB: sono identificatori necessari per riabbinare (interpretazione da ricontrollare se i termini dicono altro);
  - gli ID scritti nel filename;
  - i valori Wikidata e gli ID che vengono da Wikidata;
  - i campi `manual`;
  - i titoli ricavati dal filename;
  - l'artwork caricato a mano o generato dal video;
  - i MediaLink e lo stato di visione.
- **Proprietà:** l'operazione è idempotente, viene registrata nel log, ed è verificabile con un conteggio delle righe `tmdb`, che deve risultare zero.
- **Rimuovere il token ≠ cessare la licenza.** Senza token il refresh si ferma e i dati scadono da soli entro 180 giorni. Il purge immediato è un comando esplicito.

### 5.10 MVP senza chiave TMDB (stasera)

- **`TMDB_READ_TOKEN` assente:**
  - il provider `tmdb` non viene registrato e `status()` vale `not_configured`, visibile nella diagnostica di gestione;
  - nessun errore, nessun retry.
- **Identificazione:** Wikidata (S4 v2) nei job dell'ingest. La ricerca manuale della coda usa Wikidata: risposte da 1 a 20 s, e la UI mostra uno stato di attesa.
- **Metadata disponibili:**
  - titolo IT e originale, anno, kind;
  - generi Wikidata, flag documentario, durata;
  - regista e cast non ordinato;
  - ID esterni.
  - Nessuna trama e nessun poster.
- **Visualizzazione:**
  - copertine **segnaposto generate dal client** (titolo e anno su fondo tipografico), che non occupano spazio nell'Artwork Store;
  - frame estratti dal video come backdrop o still, solo se l'Artwork Store li implementa già nell'MVP;
  - upload manuale dell'artwork disponibile (§13).
- **User-Agent Wikimedia:**
  - `Pezzotflix/<versione> (<WIKIDATA_CONTACT>)`;
  - se `WIKIDATA_CONTACT` manca, il servizio parte lo stesso, ma il limiter scende a **10 richieste/min** (fascia "unidentified") e registra un avviso.
  - Con 100 film, la scansione iniziale passa da qualche minuto a circa un'ora.
- **Prima ingest, anche con il contatto:** circa 3 richieste Wikidata per item a 1 req/s, quindi circa **1,7 ore per 2000 item**. La UI mostra l'avanzamento.
- **Quando il token compare nel `.env`:**
  - al successivo `docker compose up -d` (ADR 0006) il servizio valida il token (`GET /3/authentication`); un token errato dà `invalid_credentials`, visibile e non bloccante;
  - poi registra il provider e, confrontando l'impronta dei provider con quella salvata, accoda il **backfill TMDB**:
    1. per gli item con ID TMDB da Wikidata: dettagli e immagini **per ID**, senza nuova ricerca e senza cambiare il MediaLink;
    2. per gli item senza ID TMDB: ricerca TMDB con titolo e anno già noti come vincolo forte; se l'esito non è univoco, l'item non viene arricchito e la diagnostica lo segnala, senza toccare il link;
    3. per i casi "Da verificare": nuovo tentativo con i candidati TMDB.
  - Attivare TMDB **non ri-identifica mai** un item già collegato.

### 5.11 Rate limiting e `Retry-After`

| Host | Limite nostro | Concorrenza | Note |
|---|---|---|---|
| `api.themoviedb.org` | token bucket 20 req/s, burst 20 | 4 | Metà del tetto documentato. 500 film × 2 richieste (search + details con `append_to_response`) ≈ 50 s |
| `image.tmdb.org` | 10 req/s | 4 | |
| `www.wikidata.org` (Action/REST) | 1 req/s (60/min, sotto i 200/min della fascia con User-Agent) | 1 | Senza `WIKIDATA_CONTACT`: 10/min |
| `query.wikidata.org` (WDQS) | 1 query alla volta, almeno 1 s tra due query, batch di 50–100 QID, timeout 60 s | 1 | |

- **`429` / `503`:**
  - si rispetta `Retry-After`, in secondi o come data HTTP, con un tetto di 10 min;
  - la pausa vale per **tutto l'host**, non solo per quella richiesta;
  - se l'header manca: backoff esponenziale da 5 s, raddoppiato fino a 5 min, con jitter pieno (indicazione Wikimedia).
- **Circuit breaker:** 5 fallimenti consecutivi mettono l'host in `degraded` per 5 min. Il prossimo tentativo è il `run_at` del job, e la coda persistente del Job Runner li riprende (doc 02 §3.12).
- **Fallimento della singola query** (S4: "2012" → `504`):
  - dopo 3 tentativi si cambia strategia: per Wikidata, ricerca per etichetta esatta con anno invece che full-text;
  - dopo circa un giorno di tentativi il caso **resta `pending`** (non diventa `needs_review`), ma la gestione lo mostra con l'esito `provider_unavailable` e lo si può ritentare con `RetryJob`.
- **Ricerca interattiva** (`SearchProvider`): un limiter esaurito restituisce subito "provider occupato, riprova tra N s", senza attese lunghe nella richiesta HTTP.

### 5.12 Attribuzione nella UI

- **Pagina "Informazioni / Crediti"** del web client (e poi del client TV), mostrata quando TMDB è configurato **o** quando nel database ci sono dati di sorgente `tmdb`:
  - **logo TMDB** ufficiale, una delle cinque varianti SVG, non modificata;
  - avviso **testuale invariato** del §3 dei termini: "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.", seguito dalla traduzione italiana.
- **Wikidata:** "Dati da Wikidata (CC0)". Non è obbligatorio, ma è una cortesia.
- **Gestione:** la vista dei metadata di un item mostra la provenienza di ogni campo, che serve già per i lock (§13) e rende visibile la fonte di ogni dato.
- **Divieti:** il logo TMDB non va nel nome dell'app né in posizioni che suggeriscano un'approvazione.

### 5.13 Vincoli che nascono dai termini (da tenere a mente)

- **Resolver AI futuro** (§11): non deve ricevere TMDB Content, per il divieto di uso "in connection with … AI based Application" (§1.C). I suoi input sono filename, metadata del file e dati Wikidata. Prima di introdurlo va riletto il §1.C, perché una lettura estesa potrebbe coinvolgere l'intera app.
- **Test e repository:**
  - nessuna risposta TMDB registrata va in git, perché sarebbe una cache oltre 6 mesi;
  - le fixture dell'adapter TMDB sono **sintetiche**, scritte a mano;
  - gli output di `tmdb_probe.py` restano in `out/`, che è gitignorato;
  - gli agenti di sviluppo non elaborano in blocco dati TMDB reali.
- **Uso non commerciale:** chiave personale del proprietario, mai distribuita. Ogni installazione usa la propria.

### 5.14 Punteggio delle strategie

Punteggi da 1 a 5. **E** = evidenza (S4, termini), **G** = giudizio.

| Criterio (peso) | **A. TMDB + base Wikidata, identificazione Wikidata-first** | B. TMDB + base Wikidata, identificazione TMDB-first | C. Solo TMDB | D. Solo Wikidata |
|---|---|---|---|---|
| M1 termini (vincolo) | ✅ | ✅ | ✅ solo con purge, ma poi la libreria perde tutto | ✅ |
| M2 offline/durata (25%) | 5 (E: base CC0 per ogni item abbinato) | 4 (G: base solo se Wikidata ha l'ID TMDB) | **1** (E: §1.D) | 5 |
| M3 `it-IT` (20%) | 5 (E: S4 con la chiave, trame 94/94, poster italiani 78/94, episodi 96% titoli e 99,5% trame) | 5 (E) | 5 (E) | 2 (E: niente trame né poster) |
| M4 identificazione (20%) | 4 (E: 98,9% in-sample su Wikidata; lento, 429/504) | 3 (E: S4, regola v2 su TMDB: precision 97,7%, recall 88,5%; omonimi poco noti) | 3 (G) | 4 (E) |
| M5 stasera senza chiave (15%) | 5 (E: è la configurazione misurata in S4) | 3 (G: due percorsi di identificazione da mantenere) | **1** | 5 |
| M6 uso corretto (10%) | 4 (E: politica Wikimedia rispettabile con User-Agent) | 4 | 5 | 4 |
| M7 correzioni (10%) | 5 | 5 | 5 | 5 |
| **Totale** | **4,70** | **3,95** | **escluso (M2, M5)** | **4,10, ma escluso come obiettivo (M3)** |

### 5.15 Dipendenze con altre aree

- **ADR 0006 (deploy):** `.env` con `TMDB_READ_TOKEN`/`_FILE` e `WIKIDATA_CONTACT`, attivazione con `docker compose up -d`, volume `video-artwork`; `video-cache` solo per derivati ricostruibili.
- **ADR 0002 (database):** valori per (item, campo, sorgente) in `item_field` con `fetched_at`, proiezione materializzata, `provider_cache`, impronta dei provider, `job.run_at` come unico prossimo tentativo.
- **ADR 0001 (runtime):** `fetch` nativo, token bucket per host scritto a mano e parsing di `Retry-After`; parser e punteggi portati a mano da S4, senza guessit né rapidfuzz.
- **Thumbnail e Artwork Store:** niente ricodifica delle immagini TMDB; varianti nostre solo per upload e frame.
- **ADR 0004 (contratto API):** `Cache-Control` di 30 giorni senza `immutable` per le immagini TMDB; stati `provider_unavailable` e `not_configured`, provenienza per campo, comando `PurgeProviderData`, payload della pagina crediti.
- **ADR 0005 (web client) e client TV:** pagina "Informazioni" con logo e avviso, segnaposto delle copertine, avanzamento dell'ingest, "fissa come valore manuale".

### 5.16 Raccomandazione

- **Strategia A.**
  - TMDB è la fonte primaria di **arricchimento**: trame, poster, cast ordinato, episodi in `it-IT`. I suoi dati scadono dopo 180 giorni e vengono rinnovati ogni 90.
  - Wikidata è la fonte di **identificazione** e la **base durevole**, collegata via QID e ID TMDB.
  - Tutto è memorizzato per sorgente, con la precedenza `manual > tmdb > wikidata > filename`; solo `manual` (e gli ID dal filename) sono durevoli.
  - Prima del matching fuzzy si usano i tag ID del filename.
  - L'artwork TMDB è trattato come TMDB Content: riscaricato a ogni refresh, mai ricodificato, cancellato a scadenza o al purge.
  - Senza chiave l'MVP gira con Wikidata e i segnaposto, e TMDB si attiva al riavvio con un backfill automatico.
- **Runner-up:** B (identificazione TMDB-first). Sarebbe diventata la scelta con una precision più alta su TMDB: misurata il 2026-11-05 in S4, non lo è (ADR 0007, revisione).

---

## 6. Protocollo di streaming e Stream Delivery

- **Stato:** Accettata (2026-11-05), dopo la revisione di design ("accettare dopo le correzioni": B1, M1–M9, minori 1–22) e una seconda revisione breve ("accettare", otto ritocchi applicati). ADR collegato: [0003 — Streaming: HLS fMP4 VOD con segmenter proprio](../adr/0003-streaming-hls-fmp4-segmenter.md)
- **Area:** protocollo e packaging di Direct Stream e Transcode, segmentazione e playlist, indice dei keyframe, seek e timeline, processi ffmpeg, Direct Play, conversione audio, sottotitoli embedded, dati per il buffer del browser, Dolby Vision P7, librerie.
- **Fonti interne:** requisiti §5, §6, §8, §18, §19, §20; doc 02 §3.9–§3.12, §6 (C1), §7; doc 03 §4, §5, §8, I5, I6; doc 04 (tutto, in particolare §4, §6, §7, §8, H8, H11, P2, P3); [S1](../spikes/S1-media-probe.md), [S2](../spikes/S2-browser-playback.md), [S3](../spikes/S3-stream-latency.md); ADR 0001, 0004, 0006; §4.4 (G1).
- **Esperimento nuovo:** `spikes/a3-stream-delivery/` (throwaway, 2026-11-05), descritto in §6.5. Misurato sul **portatile**: iGPU Intel + RTX 1000 Ada, Docker Desktop con engine 28.1, WSL 2.5.7, immagine `pezzotflix/video:dev` con jellyfin-ffmpeg 8.1.3, media dal bind mount NTFS in sola lettura.
- **Verifica del revisore:** script e output t1–t9 in `spikes/a3-stream-delivery/review/` (2026-11-05, stesso portatile). Dove questa sezione li usa, li cita come "verifica del revisore, tN".

### 6.1 Decisioni da prendere

1. Protocollo e packaging per Direct Stream e Transcode.
2. Segmentazione e modello di playlist: muxer HLS di ffmpeg o segmenter nostro; playlist EVENT o VOD; seek, confini e durata dei segmenti; fonte dell'indice dei keyframe.
3. Gestione dei processi ffmpeg: ciclo di vita, kill, throttling, scratch, errori, confine estraibile verso `video-worker` (C1).
4. Chi serve i byte del Direct Play, e con quale sicurezza.
5. La scala di conversione audio del Direct Stream, lato server.
6. I punti aperti della revisione di S2: estrazione dei sottotitoli embedded, dati per il buffer di hls.js, DV P7 (H11).
7. Le librerie, oltre a ffmpeg ed execa.

Il player (hls.js, libpgs) è dell'ADR 0005: qui conta solo dove vincola il server.

### 6.2 Criteri

| # | Criterio | Fonte | Peso | Vincolo rigido? |
|---|---|---|---|---|
| P1 | **Qualità originale**: video copiato, trasformazione minima, multi-traccia | §5.1, §6, §18 "Qualità", doc 04 §1 | — | sì |
| P2 | Riproduzione **misurata** nei browser dell'MVP | §19, S2 | 25% | no |
| P3 | **Seek** su tutta la durata, **timeline originale** esatta | doc 03 §5, doc 04 §6.1–§6.2 | 20% | sì |
| P4 | Client futuri: Android TV (Media3), mobile | §7, doc 03 I4 | 15% | no |
| P5 | Aderenza al contratto (`progressive`, `hls-fmp4`, token nel path), solo con modifiche additive | ADR 0004, mvp-plan §3 | 15% | no |
| P6 | Semplicità e robustezza del server (processi, riavvii, risorse) | doc 02 C1 e §7, ADR 0001 | 15% | no |
| P7 | Limiti di memoria del player (quote MSE di Chromium) | S2, doc 04 §4.5 | 10% | no |

Per la segmentazione e l'indice dei keyframe valgono criteri propri (§6.4).

### 6.3 Protocollo e packaging

Versioni verificate il 2026-11-05 su GitHub releases: hls.js **1.7.4** (2026-10-28), dash.js **5.3.0** (2026-11-04), Shaka Player **5.3.3** (2026-10-29), AndroidX Media3 **1.11.1** (2026-09-11; HLS e DASH entrambi supportati).

| Criterio (peso) | **A. HLS con segmenti fMP4 (CMAF), playlist VOD** | B. DASH con segmenti CMAF (`SegmentTimeline`) | C. fMP4 progressivo, una risposta per ogni avvio |
|---|---|---|---|
| P1 (vincolo) | ✅ video copiato | ✅ | ✅ |
| P2 browser misurati (25%) | 5 **E**: S2, Chrome/Edge/Firefox, AVC e HEVC Main10 HDR10 4K, FLAC/Opus/AAC 5.1 | 2 G: non misurato; player diverso (dash.js o Shaka) | 3 **E**/G: funziona, ma in Chromium il 4K parte in 0,8–1,5 s contro 0,15–0,40 s dell'HLS (**E**, S2). Che il ritardo cresca con la durata del file è un giudizio: S2 lo indica come probabile, non lo misura (G) |
| P3 seek e timeline (20%) | 5 **E** lato server (§6.5, verifica del revisore t4, t8, t9): playlist dell'intero film, riavvio al seek invisibile al player con il pre-roll di un GOP; timeline originale tramite un offset dichiarato (§6.6) | 5 G: stessa logica | 2 G: ogni seek oltre il generato è un nuovo URL; la barra di seek e l'offset dei sottotitoli restano al client |
| P4 client futuri (15%) | 5 G: Media3 lo supporta; HLS nativo sui dispositivi Apple | 4 G: Media3 sì, Apple no | 3 G |
| P5 contratto (15%) | 5 **E**: `hls-fmp4` e la risorsa `hls/{resource}` esistono | 2 **E**: serve un valore nuovo dell'enum e nuove risorse | 4 **E**: `progressive` e `startOffsetMs` esistono |
| P6 server (15%) | 4 G | 4 G | 5 G: nessuna playlist |
| P7 memoria (10%) | 3 **E**: quote MSE da rispettare dal client (S2) | 3 G: stesse quote | 4 G: buffer nativo, niente MSE |
| **Totale pesato** | **4,65** | 3,30 | 3,35 |

- **HLS con MPEG-TS** è escluso: il TS non porta la FLAC e obbliga hls.js a ricomporre i segmenti in fMP4.
- **Audio muxato o rendition separate.** Nell'MVP l'audio è **muxato** con il video, una traccia per stream, come in S2 (un solo SourceBuffer, misurato). Cambiare traccia audio è una ripianificazione con riavvio alla posizione corrente (circa 1 s). Le rendition separate (`EXT-X-MEDIA`) darebbero il cambio senza riavvio, ma S2 non le ha misurate, e il segmenter dovrebbe produrre segmenti solo audio e una conversione per ogni traccia. Restano un'evoluzione.
  - Conseguenza per l'ADR 0005: senza rendition separate basta la build **light** di hls.js.
- **`stream.mimeType`** per `hls-fmp4` è il tipo dei **segmenti** (`video/mp4; codecs="…"`), non della playlist, con entrambi i codec (video e audio) letti dal segmento di init: è ciò che il client verifica con `MediaSource.isTypeSupported`.

### 6.4 Segmentazione, modello di playlist e indice dei keyframe

**Playlist.** Si confrontano due modelli:
- **EVENT**: la playlist cresce con ffmpeg. Il seek oltre il generato richiede una nuova sessione con `startOffsetMs`, una timeline del player che non parte da 0 e un offset per sottotitoli e progress;
- **VOD**: la playlist copre tutto il film sin dall'inizio, con durate e confini noti, e i segmenti si producono su richiesta, come fa Jellyfin ([DynamicHlsPlaylistGenerator.cs](https://github.com/jellyfin/jellyfin/blob/master/src/Jellyfin.MediaEncoding.Hls/Playlist/DynamicHlsPlaylistGenerator.cs), letto il 2026-11-05). Il player vede un film normale, con la barra di seek completa.

Si sceglie la **VOD**. La condizione è che un segmento prodotto da un riavvio sia identico, per confini e timestamp di ogni campione, a quello che avrebbe prodotto un'esecuzione partita da 0. È la domanda dell'esperimento (§6.5) e della verifica del revisore.

**Segmenter.** Criteri propri:

| # | Criterio | Peso |
|---|---|---|
| G1 | **Coerenza dopo un riavvio**: stessi confini e stessi timestamp dei campioni della playlist | 30% (vincolo) |
| G2 | Timeline originale ricostruibile, nessun timestamp negativo | 20% |
| G3 | Throttling e controllo delle risorse (scratch, CPU) | 15% |
| G4 | Latenza di avvio e di seek (H8) | 15% |
| G5 | Ispezione dell'output: stringa di codec, controllo dell'`esds` (doc 04 §4.3) | 10% |
| G6 | Codice da scrivere e mantenere | 10% |

| Criterio (peso) | A. Muxer `hls` di ffmpeg (Jellyfin) | **B. ffmpeg scrive fMP4 frammentato su stdout, il servizio taglia i segmenti** | C. Muxer `segment` con `-segment_times` |
|---|---|---|---|
| G1 riavvio (30%) | **1 E**: taglia al primo keyframe ≥ inizio dell'esecuzione + n·`hls_time`. Coincide con una playlist calcolata da 0 solo con keyframe sulla griglia (verifica del revisore, t7); con keyframe fuori griglia un riavvio taglia altrove (E1, t7) | **5 E**: con il pre-roll di un GOP i campioni del riavvio coincidono con quelli dell'esecuzione da 0, su GOP chiusi (E2, E7, t9) e aperti (t4, t8) | 3 G: tagli espliciti, ma non misurato; ogni segmento è un file MP4 a sé |
| G2 timeline (20%) | 2 **E**: con l'AAC, il primo `tfdt` audio è negativo e va in overflow (E3) | 5 **E**: offset costante dichiarato e `negative_cts_offsets` (E3, E7, t1) | 3 G |
| G3 throttling (15%) | 2 G: file su disco; pausa con SIGSTOP o lettura limitata, attesa dei file con polling (Jellyfin: 100 ms) | 5 G: contropressione della pipe: se il servizio non legge, ffmpeg si ferma; segmenti pronti con un evento | 2 G |
| G4 latenza (15%) | 4 **E**: S3, 0,16–0,25 s sull'host | 4 **E**: primi 60 MB in 0,39–0,80 s dal bind mount NTFS (E2b); il pre-roll aggiunge un GOP, dal keyframe indicizzato che precede Bₖ (G: circa +0,2–0,4 s a UHD; fino a un segmento, 0,5–0,7 s, con la sonda di ripiego) | 4 G |
| G5 ispezione (10%) | 3 G: il file di init va letto comunque | 5 **E**: lo stesso parser legge `hvcC` ed `esds` dal segmento di init (E3) | 3 G |
| G6 codice (10%) | 4 G | 3 G: circa 300–400 righe (lettore di box, segmenter, playlist) con i test | 3 G |
| **Totale pesato** | 2,30 | **4,65** | 3,00 |

**Indice dei keyframe.** La playlist VOD con video copiato vuole la posizione dei keyframe prima di produrre un segmento. Criteri: esattezza rispetto al seek di ffmpeg (vincolo), byte letti a freddo da un remux da 50–80 GB, codice.

| | **A. Cues di Matroska (parser EBML)** | B. Sonda a salti di ffprobe (`-read_intervals`) | C. Scansione completa dei pacchetti |
|---|---|---|---|
| Esattezza | G: è lo stesso indice che ffmpeg usa per il seek; da confrontare con la sonda sui sample | **E**: usa l'indice del container, i confini coincidono per costruzione (E7) | **E**: esatta |
| Byte letti | G: solo SeekHead e Cues, qualche centinaio di KB | **E**/G: un pacchetto keyframe per intervallo. In E7 74 salti in 181 ms su 5 min di file in cache; su un remux da 2,5 h circa 2250 salti e 0,6–3 GB, cioè 10–60 s a freddo (stima del revisore, t5: keyframe medi da 263 KB su Long Test) | **E**: tutto il file; sul portatile 20,5 s per 1,66 GB (circa 81 MB/s), cioè circa 12 minuti per 60 GB |
| Copertura | solo MKV con Cues | ogni container | ogni container |
| Codice | un parser EBML minimo, scritto a mano | nessuno | nessuno |

**Scelta:**
- **A, i Cues, come fonte primaria per gli MKV**, verificata contro la sonda a salti sui sample in un test;
- **B, la sonda, come ripiego** per i file non MKV o senza Cues;
- C non rende veloci i riavvii, perché anche il seek di ffmpeg in un MKV senza Cues è una lettura lineare. Per questi file la diagnostica consiglia di rifare il remux con l'indice.

L'indice si calcola in un **job obbligatorio dopo `FileAnalyzed`** e si salva in `video-cache` sotto `/data/cache/delivery/keyframes/<impronta>`. A `StartPlayback` un indice mancante si costruisce in modo sincrono dai Cues. Se è possibile solo la sonda lenta, `StartPlayback` risponde `503` `STREAM_PREPARING` con `Retry-After` e il job passa in testa alla coda (§6.6).

### 6.5 Esperimento A3 (2026-11-05, portatile)

- **Setup:** `spikes/a3-stream-delivery/`, con gli script `e1_restart.sh`, `e3_fixes.sh`, `e4_subs_misc.sh`, `e5_grow.sh`, `e6_merge_dv.sh` ed `e7_timeline.sh`, eseguiti in container usa e getta di `pezzotflix/video:dev`.
  - Parser dei box: `mp4inspect.mjs` legge `tfdt`, `trun`, `hvcC`, `esds`, `dfLa` e `dOps`. `helpers.mjs` dà gli istogrammi delle unità NAL e le informazioni sui `.sup`.
  - Sorgente: `Long Test (2024) - 2160p.mkv` di `media-samples/library` (S3: 5 min, HEVC Main10 HDR10 a 60 fps, GOP chiusi da 2 s, TrueHD 5.1(side) ed E-AC-3), montata in sola lettura.
  - Output in `out/`, gitignorato.

| # | Domanda | Esito |
|---|---|---|
| E1 | Il muxer `hls` di ffmpeg, riavviato a un keyframe con `-start_number`, produce gli stessi segmenti di un'esecuzione da 0? | **No, nella forma provata.** Con `-hls_time 5` e GOP da 2 s, da 0 i tagli cadono a 6, 10, 16, 20, 26, 30 s; riavviato con `-ss 16`, parte a 14 s e taglia a 20, 24, 30, 34 s. Gran parte dello scarto viene dall'arretramento del seek (E3, punto 1), che qui non era compensato. **Verifica del revisore, t7:** con `-noaccurate_seek -ss 12.135` il muxer coincide su Long Test, perché i keyframe cadono sulla griglia; sulla fixture con keyframe fuori griglia no (da 0 il quinto segmento parte a 16,891 s, il riavvio taglia a 15,807 e 20,519 s, valori di `tfdt`). Il muxer taglia al primo keyframe ≥ inizio dell'esecuzione + n·`hls_time`: una playlist VOD calcolata da 0 resta valida solo se i keyframe sono sulla griglia |
| E2 | fMP4 frammentato su stdout (`frag_keyframe`), riavvio allo stesso keyframe | Su GOP chiusi il video del riavvio ha gli stessi `tfdt` dell'esecuzione da 0 (16, 18, 20 s…); un frammento per keyframe |
| E2b | Primo output da un offset profondo, dal bind mount NTFS | Primi 60 MB (circa 4,8 s di contenuto a 100 Mbps) in **0,39–0,80 s** (offset 284 e 150 s) |
| E3 | Insidie e rimedi | 1) **`-ss 16` parte da 14 s**, perché ffmpeg arretra il target di 3/23 s quando il video ha B-frame (`has_b_frames`=2). Con `-ss 16.135` parte esattamente a 16 s (E7).<br>2) **Seek accurato**: l'audio è tagliato al target e parte 178 ms dopo il video. Con `-noaccurate_seek` parte 71 ms prima.<br>3) **AAC da 0**: il priming dà un primo `tfdt` audio di −21 ms, scritto come intero senza segno (`tfdt` ≈ 3,8·10¹⁴ s), sia con il muxer `hls` sia con l'fMP4. **`-output_ts_offset 10`** sposta tutto di 10 s costanti: nessun valore negativo, stessi rapporti fra le esecuzioni.<br>4) **Senza `frag_discont`** il `tfdt` riparte da 0 a ogni esecuzione: la timeline originale si perde |
| E3b | Controllo dell'AAC multicanale dopo l'encoder | Dal TrueHD 5.1(side): `channelConfiguration` **0** (PCE) senza `aformat`; **6** con `aformat=channel_layouts=5.1`. Il parser lo legge dall'`esds` del segmento di init. Stringhe ricavate dall'init: `hvc1.2.4.H153.90`, `mp4a.40.2`, `flac`, `opus` (6 canali) |
| E4 | Copia dell'E-AC-3 in fMP4 su pipe | Con `empty_moov` fallisce ("Cannot write moov atom before EAC3 packets parsed"). Con **`delay_moov`** riesce (`ec-3`, brand `dby1`) |
| E5a | Lettura sequenziale dal bind mount NTFS | `cat` del file da 1,66 GB: 178–183 MB/s, probabilmente dalla cache di Windows, perché il file era già stato letto. La prima lettura completa della sessione (ffprobe, E7) andava a circa 81 MB/s. Per la pianificazione restano i 47 MB/s del remux e i 60–67 MB/s di `cat` di S3 |
| E5b | Estrazione dei sottotitoli embedded (Blade Runner, 373 MB, due PGS, un SRT e un ASS) | Una traccia PGS: 2,9 s. **Tutte e quattro in un solo passaggio: 2,0 s.** Il costo è la lettura del file, non il numero di tracce |
| E5c | Un `.sup` in estrazione cresce mentre ffmpeg legge? | La mia misura usava la fixture difettosa di E5d e non vale. **Verifica del revisore, t6**, su una traccia PGS reale: senza `-flush_packets 1` il `.sup` resta a 0 byte fino alla fine; **con `-flush_packets 1` cresce** con la lettura (10,7 → 21 → 49 → 101 → 119 KB) |
| E5d | Due passaggi ([X, fine), poi [0, X)) concatenati danno il file completo? | La mia fixture sintetica non ha permesso la misura (PTS a 2³²−1 nel mux MKV). **Verifica del revisore, t3**, su Blade Runner (traccia PGS s:4): senza `-copyts` il passaggio con `-ss 5` riscrive i cue sul punto di seek (6,000 → 1,000); **con `-copyts` la fusione è identica byte per byte all'estrazione completa**, a X = 5 e X = 6,5. Il passaggio da X = 5 parte dal cue a 6,0 s: il display set 4,024–6,0 s, sullo schermo a X, sta solo nel secondo passaggio. Da qui il pre-roll di §6.10 |
| E6 | `hevc_metadata=remove_dovi=1` su un DV P8.1, video copiato | Unità NAL di tipo 62 (RPU): **62 → 0**. Restano i SEI di mastering e di content light level. **Non sono identiche le altre:** VPS/SPS/PPS (NAL 32/33/34) passano da 4 a 2, con entrambi i filtri provati, quindi per effetto della riscrittura dei parametri, non della rimozione DV. Sull'EL di un P7 (tipo 63) non si può dire nulla: manca un sample |
| E7 | Seek e timeline con le opzioni finali | `-noaccurate_seek -ss 16.135` parte a 16 s esatti. Con `+negative_cts_offsets` il primo PTS video di un keyframe **IDR** coincide col keyframe (+10 s di offset); senza, è spostato di 33 ms, il ritardo di riordino dei B-frame a 60 fps. La FLAC parte 50 ms prima del video. La sonda a salti (74 intervalli) dura 181 ms |

**Verifica del revisore** (`spikes/a3-stream-delivery/review/`):

| # | Domanda | Esito |
|---|---|---|
| t1 | Il segmento di init è identico fra l'esecuzione da 0 e un riavvio? | **Sì**, byte per byte, con FLAC e con AAC; `elst` con durata 0 |
| t3 | Fusione dei due passaggi su una traccia PGS reale | Vedi E5d: identica con `-copyts`, sbagliata senza |
| t4 | Riavvio esattamente a Bₖ su HEVC x265 a 23,976 fps con **GOP aperti** (CRA), keyint 29, B-pyramid | **No.** A B = 3,629 (`-ss 3.764`) il primo frammento ha `tfdt` = 13,629 e PTS 13,629, mentre nell'esecuzione da 0 lo stesso GOP ha `tfdt` = 13,503 e PTS 13,629: su un GOP aperto il `tfdt` precede il PTS del keyframe di circa 125 ms. Dal secondo GOP in poi i frammenti coincidono. AC-3 copiato: lo scarto audio-video all'inizio è di 178–203 ms |
| t5 | Peso medio di un keyframe su Long Test | 263 KB: base della stima del costo della sonda a salti (§6.4) |
| t6 | Crescita del `.sup` | Vedi E5c |
| t7 | Muxer `hls` con la compensazione del seek | Vedi E1 |
| t8 | PTS di ogni campione del primo GOP dopo il riavvio (fixture di t4) | Da 0: `13.504 13.545 13.587 13.629…`; riavvio: `13.546 13.546 13.587 13.629…`. Le leading picture (RASL) del primo GOP hanno un PTS doppio e un buco di 42 ms, perché i riferimenti del GOP precedente mancano. **Il secondo GOP coincide esattamente** |
| t9 | Riavvio su GOP chiusi (Long Test) con il comando di §6.6 | Campioni identici all'esecuzione da 0; E-AC-3 copiato con δ = 37 ms |

**Conclusione per la decisione:** un riavvio esattamente a Bₖ è corretto solo con GOP chiusi. Con un GOP aperto il primo GOP di ogni esecuzione è sbagliato, quindi un'esecuzione per il segmento k parte dal keyframe indicizzato che precede Bₖ e scarta il GOP di pre-roll (§6.6).

**Limiti:**
- nessun remux reale; fixture sintetiche a 60 fps con GOP chiusi, più la fixture x265 a GOP aperti del revisore, l'unica con GOP aperti;
- i file erano probabilmente nella cache di Windows: le misure di I/O (E2b, E5, E7) sono limiti inferiori dei tempi;
- nessun browser: che hls.js accetti i segmenti prodotti così (`trun` versione 1 con composizione negativa, offset costante) va verificato in F1c;
- parser dei Cues non ancora scritto, e quindi non confrontato con la sonda;
- nessun DV P7.

### 6.6 Seek, timeline e confini dei segmenti

- **Dominio dei tempi.** La timeline originale è definita una volta sola come **PTS − `start_time`**, cioè quello che un browser riporta in Direct Play. `-start_at_zero` (con `-copyts`) la applica all'esecuzione video e ai due passaggi dei sottotitoli, e l'indice dei keyframe si salva in questo dominio. Bₖ, `-ss` e `-t` partono quindi tutti da 0; `mediaTimestampOffsetMs` resta 10000.
  - Un test di F1b con una fixture a `start_time` diverso da 0 lo verifica.
  - Da verificare in F1c: che in Direct Play il browser riporti davvero PTS − `start_time` per un file con `start_time` diverso da 0.
- **Confini:** dall'indice (§6.4), B₀ = 0 e Bₙ = l'ultimo keyframe ≤ n·4 s. I duplicati si scartano, e un segmento più corto di 0,5 s si unisce al precedente.
  - **Durata obiettivo: 4 s**, come in S2. Con video copiato un segmento non può essere più corto di un GOP.
  - **Limite superiore:** un gruppo di GOP più lungo di `HLS_SEGMENT_MAX_S` (6 s) o più grande di `HLS_SEGMENT_MAX_BYTES` (32 MiB, stimati dalle posizioni dell'indice) si taglia ai keyframe interni. Così `EXT-X-TARGETDURATION` vale al più 6 s, salvo un GOP singolo più lungo, che col video copiato non si può tagliare.
  - **Conto della quota** (video di Chromium 150 MiB, S2): buffer in avanti minimo dell'ADR 0005 = 1 × TD = 6 s a circa 128 Mbps di picco ≈ 92 MiB, più un segmento in append. Con 64 MiB fanno circa 156 MiB, oltre la quota; con 32 MiB circa 124 MiB. Il limite taglia solo i segmenti oltre circa 2 s di picco: quelli a bitrate basso non cambiano.
  - Un segmento da 4 s a 100 Mbps pesa circa 50 MB. Dal bind mount NTFS sono circa 0,7 s, contro 1,1 s per uno da 6 s: conta su avvio e seek. Segmenti più corti non cambiano i byte nel buffer (S2).
  - `EXT-X-TARGETDURATION` è il massimo arrotondato per eccesso.
- **`EXTINF` con arrotondamento cumulativo:** ogni valore è la differenza fra i confini arrotondati al millisecondo, così la somma dei primi n coincide con Bₙ. hls.js reimposta `initPTS` quando lo scarto fra la durata attesa e quella dei campioni raggiunge max(durata, 1 s) (`isInvalidInitPts`).
- **`EXT-X-INDEPENDENT-SEGMENTS`** solo quando ogni keyframe di confine è IDR: nel Transcode, con IDR forzati, e nel Direct Stream solo se l'indice lo dimostra. Con un GOP aperto le RASL dipendono dal segmento precedente (t8), quindi il tag sarebbe falso.
- **Riavvio con pre-roll di un GOP (B1).** Un'esecuzione per il segmento k parte da **Kₖ, il keyframe indicizzato immediatamente prima di Bₖ**; per k = 0 parte da 0, senza `-ss`.
  - I Cues elencano ogni keyframe, quindi Kₖ è il GOP precedente. Con la sonda di ripiego l'indice conosce solo un keyframe per intervallo, e Kₖ = Bₖ₋₁: la regola è la stessa.
  - Basta un GOP: le leading picture sbagliate stanno solo nel primo GOP di un'esecuzione (t4, t8).
  - Il segmenter scarta i frammenti il cui keyframe ha PTS (`tfdt` + composition offset del primo campione) < Bₖ.
  - Il raggruppamento dei frammenti in segmenti usa **sempre il PTS del keyframe, mai il `tfdt`**: su un GOP aperto il `tfdt` precede il PTS di circa 125 ms (t4).
  - Le leading picture del primo GOP tenuto hanno ora i riferimenti del GOP di pre-roll, quindi i loro PTS coincidono con quelli dell'esecuzione da 0. Lo mostra t8 per il secondo GOP di un riavvio; un test di F1b lo verifica per il percorso completo.
  - **Controllo del primo keyframe tenuto:** il suo PTS si confronta con Bₖ in millisecondi sulla timeline originale, con tolleranza di 1 ms. Uno scarto è deterministico: il tentativo automatico del server riparte da un keyframe indicizzato ancora prima (due prima di Bₖ), mai con lo stesso comando. Solo se fallisce anche quello, `STREAM_FAILED` (§6.7).
  - Costo: un GOP letto in più a ogni riavvio, circa +0,2–0,4 s per seek a UHD (G: 1–2 s di GOP a 100 Mbps dal bind mount); nel caso peggiore, con la sonda di ripiego (Kₖ = Bₖ₋₁), fino a un segmento, circa 0,5–0,7 s.
- **Comando di un'esecuzione** (video copiato), con i parametri ricavati in §6.5:
  `-nostdin -noaccurate_seek -ss <Kₖ + 0,135> -i <file> -map 0:v:0 -map 0:a:<n>? -c:v copy [-tag:v hvc1 solo per HEVC] <audio> -copyts -start_at_zero -avoid_negative_ts disabled -output_ts_offset 10 -map_metadata -1 -map_chapters -1 -sn -dn -fflags +bitexact -f mp4 -movflags +frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets pipe:1`
  - i 0,135 s compensano l'arretramento di 3/23 s che ffmpeg fa con i B-frame. Senza B-frame vale il minimo fra 0,135 s e metà della distanza dal keyframe successivo;
  - la mappa audio è facoltativa (`?`), per i file senza audio;
  - `hvc1` si imposta solo per l'HEVC; per l'AVC resta `avc1`.
- **Audio all'inizio di un'esecuzione.** Nessun `atrim`: l'audio che parte prima di Bₖ cade nel GOP di pre-roll, che si scarta, e quello tenuto è contiguo. Resta da misurare la giunzione fra segmenti di esecuzioni diverse (dopo un seek): sovrapposizione o buco fino a un frame audio (F1c).
- **Timeline (M1).** I timestamp dei segmenti sono la timeline originale più un **offset costante di 10 s**, dichiarato nel nuovo campo `stream.mediaTimestampOffsetMs`: 10000 per `hls-fmp4`, 0 per il Direct Play. `stream.startOffsetMs` vale 0 per ogni protocollo.
  - Il `currentTime` del player **non** coincide da solo con la timeline originale. hls.js 1.7.4 prende `initPTS` dal tempo di decodifica del primo frammento caricato, della traccia audio se parte prima (`passthrough-remuxer.ts`, letto dal revisore). Quindi `currentTime` = PTS originale + δ, con δ che cambia con codec e posizione di partenza.
  - δ misurati: 37 ms con E-AC-3 copiato (t9), 50 ms con FLAC (E7), 71 ms con AAC e `-noaccurate_seek` (E3), 178–203 ms con AC-3 copiato su GOP aperto (t4), di cui circa 125 ms dovuti allo spostamento del DTS.
  - **Un riavvio della pipeline non cambia la timeline: i cue restano validi; `timelineOffsetMs` si ricalcola a ogni `INIT_PTS_FOUND`, cioè con un nuovo player o quando hls.js reimposta `initPTS`.** I cue vengono dall'estrazione (§6.10), non dal processo del video.
  - Il client lo corregge a ogni `INIT_PTS_FOUND` con `timelineOffsetMs = initPTS·1000/timescale − mediaTimestampOffsetMs` (tempo originale = `currentTime` + `timelineOffsetMs`), e lo usa nei due sensi: per posizioni e PGS, e per tradurre in tempo del player un seek a un tempo originale (ADR 0005). Il server non può dichiarare δ, perché dipende dal primo frammento che il player carica.
- **Regola del riavvio.** Per una richiesta del segmento k:
  - se il segmento c'è nello scratch, si serve;
  - se il processo lo produrrà entro 3 segmenti, la richiesta aspetta l'evento "segmento pronto", al più 8 s, poi `503` con `Retry-After`;
  - altrimenti, cioè k indietro rispetto all'esecuzione o più di 3 segmenti avanti, il processo si chiude e ne parte uno nuovo da Kₖ.
  - **Una risorsa presente nella playlist non risponde mai `404` finché la sessione è viva.** hls.js non legge `Retry-After` e ritenta i 5xx con un backoff proprio, mentre non ritenta i 4xx (`error-helper.ts`). L'header resta per gli altri client, ma nessuno ci fa affidamento.
  - Latenza attesa del seek lato server: 0,4–1,2 s (S3, E2b, più il pre-roll).
- **Indice non pronto.** Se a `StartPlayback` l'indice manca e il file non ha Cues, la risposta è `503` `application/problem+json` con codice `STREAM_PREPARING` e `Retry-After`; il job dell'indice passa in testa alla coda. Il client mostra "in preparazione" e riprova (ADR 0005).
- **Transcode** (≤ 1080p, P2): stesso segmenter, keyframe IDR forzati sulla griglia (`-force_key_frames "expr:gte(t,<Bₖ>+n_forced*4)"`), quindi Bₙ = n·4 s senza indice, seek accurato (il video si decodifica comunque) e nessun pre-roll, perché ogni confine è IDR.

### 6.7 Processi, throttling, scratch e confine estraibile

- **Un processo ffmpeg per sessione** in Direct Stream o Transcode, avviato con execa:
  - `stdin: 'ignore'`, `buffer: false`, `cancelSignal` di un `AbortController`, `forceKillAfterDelay: 2000`, `cleanup: true`;
  - stderr in un buffer circolare (ultimi 64 KB) per la diagnostica.

  Accanto ci sono **al più un'estrazione di sottotitoli** alla volta (per file, condivisa fra le sessioni) e le sonde ffprobe.
- **Throttling per contropressione:** il segmenter legge stdout solo finché i segmenti pronti davanti all'ultima richiesta sono meno di `DELIVERY_AHEAD_S` (default 30 s). Poi smette di leggere: la pipe si riempie e ffmpeg si blocca in scrittura, senza CPU e senza segnali.
- **Il processo si chiude:**
  - su `StopPlayback` o `terminateSession`;
  - quando il Session Manager scade la sessione per heartbeat mancati;
  - su una ripianificazione (`ChangeTracks`, `ChangeVersion`, `reportPlaybackFailure`), che emette un **nuovo token** di sessione: i locatori vecchi danno `410`;
  - su un riavvio per seek;
  - dopo `DELIVERY_IDLE_KILL_S` (default 120 s) senza richieste di segmenti, per esempio in pausa. Riparte da solo alla richiesta successiva;
  - allo spegnimento del servizio, entro lo `stop_grace_period`.
- **Ordine di chiusura:** prima si distrugge stdout, poi SIGTERM e, dopo 2 s, SIGKILL. Un ffmpeg bloccato in scrittura su una pipe piena non gestisce SIGTERM finché la scrittura non si sblocca. Per un'esecuzione il cui output si butta (seek, ripianificazione) si manda subito SIGKILL.
- **Errore di stream (M7):** uscita di ffmpeg diversa da 0, oppure riavvio fallito (primo keyframe tenuto lontano più di 1 ms da Bₖ).
  - Il modulo `delivery` registra il fallimento: codice d'uscita, classificazione dello stderr (es. errore di demux, di codec, di I/O), posizione. Fa un solo tentativo automatico; per un riavvio fallito parte un keyframe indicizzato prima (§6.6), mai con lo stesso comando.
  - Se fallisce ancora, il data plane risponde `500` `application/problem+json` con codice `STREAM_FAILED`, per i client che leggono il corpo.
  - **`STREAM_FAILED` è terminale per lo stream:** da quel momento ogni richiesta del data plane di quella sessione risponde subito `500` `STREAM_FAILED`, senza nuovi tentativi e senza consumare il limite dei 3 tentativi. Si recupera solo con `reportPlaybackFailure`.
  - hls.js non legge il corpo della risposta. Per questo il web client, quando hls.js dà un errore fatale di rete o media su un 5xx dopo i suoi tentativi, chiama **da solo** `reportPlaybackFailure` con sospetto `unknown` (ADR 0005).
  - Il server sceglie la dimensione sospetta e la modifica minima dal **proprio** registro del fallimento, non dal sospetto del client. È la ripianificazione automatica del doc 04 §8. Vale il limite del doc 04 §8: al più 3 tentativi automatici per `StartPlayback`, ripianificazioni e riavvii insieme.
- **Fallimento di formato** (es. channelConfiguration 0 dopo l'encoder, §6.9): lo Stream Delivery lo segnala al Session Manager, che ripianifica col Decision Engine escludendo quel formato. Il motivo va in `reasons`: nessun cambio di gradino silenzioso dentro lo Stream Delivery.
- **Segmenti:** scritti come `…m4s.part` in `/data/scratch/<sessionId>/` e rinominati quando sono completi; li serve `@fastify/send`. Il segmento di init viene dalla prima esecuzione: quelli successivi si confrontano byte per byte (`-fflags +bitexact`, identici in t1), e una differenza è un errore del riavvio.
- **Scratch:**
  - per sessione si tiene la finestra `DELIVERY_AHEAD_S` + `DELIVERY_BEHIND_S` (default 30 + 30 s), circa 1 GB a 130 Mbps;
  - la quota globale `SCRATCH_MAX_BYTES` (ADR 0006) si applica con una prenotazione all'avvio della sessione e con l'eliminazione dei segmenti più vecchi dietro la posizione;
  - lo scratch si svuota a fine sessione e all'avvio del servizio.
- **Confine estraibile (C1):**
  - l'interfaccia interna è quella del doc 03 §8: `start(PlaybackPlan) → StreamHandle`, `stop`, `status`, con dati serializzabili e file riferiti come root + path relativo. `StreamHandle` porta locatori, `mimeType`, `bitrate`, `mediaTimestampOffsetMs` e la disponibilità di ogni traccia di sottotitoli;
  - le route del data plane (`/video/media/s/{token}/…`, tag `media`) appartengono al modulo `delivery`, insieme a tabella dei token, processi, scratch, indice dei keyframe e sottotitoli estratti;
  - le cache del modulo stanno in `/data/cache/delivery/` (`keyframes/`, `subtitles/`), separate dalle immagini, così un `video-worker` le può montare da solo;
  - il Session Manager possiede sessioni e heartbeat e chiama `stop`.
  - Un `video-worker` futuro prende il modulo così com'è: il gateway gli instrada `/video/media/*`.

### 6.8 Direct Play

- **Lo serve Fastify** con `@fastify/send` (ADR 0001). Range, `206`/`416`, `ETag`, `Last-Modified` e la contropressione sono verificati nello smoke test (§1.5), e G1 (§4.4) mostra che Caddy non legge in anticipo.
- Servire dal gateway è già scartato dall'ADR 0006 (Accepted): duplicherebbe l'autorizzazione con token e il controllo delle sessioni.
- **Sicurezza:**
  - l'URL non contiene path del file. Il file si risolve dal piano della sessione (root + path relativo, ricondotto al path reale e controllato dentro la root, quindi niente traversal né symlink fuori dalla root);
  - il token di 32 byte (ADR 0004) si cerca per SHA-256 in una mappa. Un confronto "a tempo costante" non ha senso su una ricerca in mappa: l'hash toglie la dipendenza dei tempi dal valore del token;
  - `{track}` dei sottotitoli si risolve sull'elenco delle tracce della sessione, mai unito a un path;
  - `410` a sessione chiusa, con una tombstone del token a scadenza (TTL), così la tabella non cresce;
  - `Cache-Control: no-store` su tutte le risorse di sessione;
  - token mascherato nei log di pino. Se si accendono i log di accesso di Caddy, va filtrato il segmento `/s/{token}/`.
- **Throughput:** un UHD chiede 12,5–16 MB/s, contro i 47–67 MB/s del bind mount NTFS (S3). Per una sessione c'è margine; per 3 UHD su Windows il margine è poco (ADR 0006).
- `stream.mimeType`: `video/x-matroska` per un MKV, che il client verifica con `canPlayType` (ADR 0005); `video/mp4; codecs="…"` per un MP4. `stream.mediaTimestampOffsetMs` = 0.

### 6.9 Audio nel Direct Stream

- La **scelta** del gradino è del Decision Engine (doc 04 §4.3). Lo Stream Delivery la esegue così:

| Gradino | Parametri ffmpeg | Note |
|---|---|---|
| Copia | `-c:a copy` | Per una traccia che il client decodifica (es. AC-3/E-AC-3 in Edge). L'E-AC-3 copiato richiede `delay_moov` (E4). Mai la copia di un AAC con channelConfiguration 0 |
| FLAC | `-c:a flac`, profondità della sorgente (s32 per 24 bit) | Lossless, va in tutti e tre i browser (S2). Il 7.1 è visto solo dalle API |
| E-AC-3 / AC-3 | `-c:a eac3 -b:a 640k` | Solo se il client dichiara `eac3`/`ac3` (Edge con il codec Dolby) |
| AAC 5.1 | `-af aformat=channel_layouts=5.1 -c:a aac -b:a 640k` | Il layout passa da 5.1(side) a 5.1 a mix invariato (S2). Una sorgente 7.1 si porta a 5.1, perché l'AAC 7.1 nel browser non è misurato |
| Opus 5.1 | `-af aformat=channel_layouts=5.1 -c:a libopus -b:a 448k` | `aformat` serve anche con jellyfin-ffmpeg, che rimappa da solo: la catena non dipende dalla build |
| Stereo | `-ac 2 -c:a aac -b:a 256k` | Solo per un client stereo |

- **Controllo dopo l'encoder:** prima di rispondere a `StartPlayback` lo Stream Delivery legge il segmento di init (la prima esecuzione parte subito, e l'init arriva col primo frammento: E2b). Da lì ricava la **stringa di codec esatta** per `stream.mimeType` (I6) e il `channelConfiguration` dell'AAC.
  - Se il channelConfiguration è 0, è un fallimento di formato (§6.7): il Session Manager ripianifica escludendo quel formato, e il motivo finisce in `reasons`.
  - Lo stesso controllo vale per l'AAC copiato.
  - Un test d'integrazione lo ripete a ogni aggiornamento di ffmpeg (S2).

### 6.10 Sottotitoli embedded

Il punto aperto di S2 e del doc 04 §4.4. Le opzioni:

| | **A. Estrazione completa nella cache, una volta per file, servita mentre cresce** | B. Uscita in più del processo di remux | C. Estrazione all'ingest per ogni file |
|---|---|---|---|
| I/O | una lettura completa per file, una volta sola (E5b: tutte le tracce costano come una) | nessuna lettura in più | una lettura completa per **ogni** file della libreria: con 500 film da 60 GB a 60 MB/s, circa 6 giorni sul bind mount NTFS |
| Copertura | da subito, dal pre-roll prima della posizione di partenza; il resto dopo | solo da dove parte l'esecuzione fino a dove è arrivato il remux; ogni riavvio crea un file parziale nuovo | completa prima di ogni playback |
| Direct Play | ✅ indipendente dalla delivery | ❌ in Direct Play non c'è un remux | ✅ |
| Complessità | media: due passaggi e una fusione (verifica del revisore, t3) | alta: copertura a pezzi, file per esecuzione, sottotitoli legati alla pipeline video | bassa, ma il costo è alto |

**Scelta: A**, con questi dettagli:
- **Quando:** al primo `StartPlayback` di un file con tracce di sottotitoli embedded che il client deve ricevere a parte (`client_render` o `sidecar`), qualunque sia la traccia scelta. Così un `ChangeTracks` successivo non costa nulla.
- **Comando** di un passaggio, una coppia `-map`/output per ogni traccia:
  `-nostdin -readrate <r> -noaccurate_seek -ss <P> -i <file> -map 0:s:<i> -c copy -copyts -start_at_zero -flush_packets 1 -f sup <i>.sup`
  - per il testo e l'ASS: `-c:s webvtt -f webvtt <i>.vtt` (ASS in WebVTT semplice, doc 04 §4.4);
  - senza `-copyts` i cue finiscono sul punto di seek (t3); senza `-flush_packets 1` il file resta vuoto fino alla fine (t6).
- **Passaggi (M4):**
  - il primo va da P = max(0, X − `SUBTITLE_PREROLL_S`) alla fine, dove X è la posizione di partenza della sessione e il pre-roll vale 60 s di default. Così il cue che è sullo schermo a X sta nel primo passaggio (in t3 il passaggio da X partiva dal cue successivo);
  - il secondo copre [0, P₁), con `-t P₁`, dove P₁ è il minimo, fra le tracce estratte, del primo PTS del primo passaggio. Se il primo passaggio è vuoto, il secondo va fino alla fine, senza `-t`;
  - se P = 0 basta un passaggio.
- **Fusione:** i due file si concatenano (il secondo davanti), scartando i display set duplicati per PTS, e si rinominano in modo atomico nella cache. Con `-copyts` il risultato è identico byte per byte all'estrazione completa (verifica del revisore, t3, su una traccia PGS reale).
- **Dove:** `/data/cache/delivery/subtitles/<impronta del file>/<traccia>.sup|.vtt`, nel volume `video-cache`: derivato e ricostruibile, come prevede l'ADR 0006. Un limite LRU `SUBTITLE_CACHE_MAX_BYTES` (default 20 GB) evita che cresca senza fine.
- **I/O (M5):** la lettura è limitata in byte, non in multipli del tempo reale.
  - `SUBTITLE_EXTRACT_MAX_MBPS` (default 15 MB/s); `-readrate` = max(1,1; limite / bitrate del file).
  - **Cosa protegge:** il bind mount NTFS legge a 47 MB/s col remux e a 60–67 MB/s con `cat` (S3). Con 15 MB/s di estrazione e un Direct Stream UHD da 12,5–16 MB/s restano circa 16–36 MB/s per i picchi di lettura di un seek.
  - Su un file oltre 13,6 MB/s (circa 110 Mbps) vale il minimo di 1,1×, quindi il limite viene superato di poco: l'estrazione deve restare davanti alla riproduzione.
  - **Latenza di un seek in Direct Stream durante un'estrazione:** misurata in F2a (2026-11-06) sul portatile, Docker Desktop, bind mount NTFS in sola lettura, file 4K HEVC da circa 5,5 MB/s. Otto seek lontani in Direct Stream: primo segmento in 500–647 ms senza estrazione e in 522–592 ms con un'estrazione PGS in corso sullo stesso file; segmenti successivi in 264–400 ms contro 264–370 ms. Costo dell'estrazione: circa 20–40 ms sulla mediana, trascurabile. Passo dell'estrazione: 20 s di media nel primo secondo (la partenza a piena velocità), poi 2,6× il tempo reale, circa 14,6 MB/s, cioè al limite di 15 MB/s (risoluzione di circa 10 s, ricavata dai tempi dei sottotitoli).
  - **Throughput attraverso il gateway (F2a):** Direct Stream di un 4K HEVC con TrueHD → FLAC, 75 segmenti, 1640 MB in 23 s (71 MB/s, 13× il tempo reale); Direct Play di un file intero da 1664 MB a 86 MB/s. Valori sopra quelli di S3 (47–67 MB/s), probabilmente in parte dalla cache delle pagine di Windows.
- **Servizio durante l'estrazione:** `GET …/subtitles/{track}` restituisce il file che cresce come **una sola risposta in streaming**, senza `Content-Length`, aperta fino alla fine del primo passaggio, con `Cache-Control: no-store`. Il `flush_interval -1` di Caddy (ADR 0006) passa i byte subito.
  - libpgs 0.9.0 legge il corpo della risposta come stream (`StreamBinaryReader`) e rende i display set man mano, con aggiornamenti `onProgress` ([pgs.ts](https://github.com/Arcus92/libpgs-js/blob/main/src/pgs.ts), letto il 2026-11-05). È verificato dal sorgente, non nel browser: va provato in F1c.
  - Per il WebVTT con `<track>` non è verificato che il browser aggiunga i cue mentre la risposta cresce: da verificare in F1c, con ripiego `fetch` + `VTTCue` (ADR 0005). Da F2 il web client usa sempre il ripiego per le tracce che crescono (ADR 0005, aggiornamento F2).
  - **Estrazione in coda:** per una traccia `growing` la cui estrazione non è ancora partita, l'URL tiene aperta la risposta senza byte finché l'estrazione parte. Da verificare in F1c: libpgs e `<track>` devono tollerare un primo byte lento; ripiego: `503` con `Retry-After` sull'URL del sottotitolo.
  - A estrazione finita, la stessa URL serve il file completo, con Range.
- **Stato nella sessione (M4, M6):**
  - `switchWithoutRestart` riguarda solo lo stream: è true per una traccia `client_render` o `sidecar` che ha un URL;
  - lo stato dell'estrazione sta nel nuovo campo `availability` della traccia: `growing` mentre si estrae, `complete` dopo.
- **Segnale di fine:** il server pubblica l'evento `playback.subtitle_ready` (`sessionId`, `trackId`, `availability`) nel polling degli eventi (`listEvents`), la chiamata periodica che il client fa già.
  - L'estrazione è per file e condivisa: l'evento esce per ogni sessione attiva su quel file, con il `sessionId` attuale di quella sessione.
  - `reportProgress` non va bene: risponde `204` senza corpo, e dargli un corpo non sarebbe additivo per i client generati.
  - All'evento il client rilegge l'URL, che serve il file completo, e ha così anche la parte prima del pre-roll (ADR 0005).
- **Sidecar esterni** (`.srt` accanto al file): convertiti in WebVTT alla richiesta e messi in cache. Costano poco, perché il file è piccolo.
- **Estrazione all'ingest:** opzionale con `SUBTITLE_PREEXTRACT=on`, da valutare sul server Linux. Default `off`.
- **Aggiornamento F1b.4 (2026-11-06):** sono cambiati il passo di lettura (niente più `-readrate`, il passo lo regola il servizio), la fine del secondo passaggio, l'estrazione in coda (`503`) e i fallimenti. Vedi ADR 0003, decisione 12.
- **Runner-up:** B, se un host futuro avesse un I/O molto più scarso (NAS su rete lenta).

### 6.11 Buffer del browser: cosa dà il server

- La causa del `bufferFullError` è il buffer in avanti di hls.js (S2), che hls.js calcola da `max(BANDWIDTH, bitrate misurato)` del livello ([base-stream-controller.ts](https://github.com/video-dev/hls.js/blob/master/src/controller/base-stream-controller.ts), [level.ts](https://github.com/video-dev/hls.js/blob/master/src/types/level.ts), letti il 2026-11-05).
- `main.m3u8` è quindi una **playlist multivariante** con una sola variante:
  - `BANDWIDTH` è il picco stimato per segmento e `AVERAGE-BANDWIDTH` la media, dalle posizioni dell'indice. Comprendono tutte le tracce del file, quindi sono una stima prudente;
  - poi `CODECS`, cioè la lista interna del parametro `codecs` di `stream.mimeType` (non l'intero tipo MIME), `RESOLUTION`, `FRAME-RATE` e `VIDEO-RANGE` (PQ/SDR/HLG);
  - rimanda a `media-0.m3u8`.
- Il client legge `BANDWIDTH` a `MANIFEST_PARSED` (ADR 0005, `autoStartLoad: false`) e fissa i limiti prima del primo frammento.
- **Il limite audio di Chromium (12 MiB)** dipende dal bitrate della sola traccia audio, che la playlist non separa. Per questo la sessione porta il campo additivo `stream.bitrate { peakBps, averageBps, audioBps }` (richiesto anche dall'ADR 0005).
- **Dimensione dei segmenti:** un segmento da 4 s a 130 Mbps pesa circa 65 MB; il limite `HLS_SEGMENT_MAX_BYTES` (32 MiB) taglia ai keyframe interni i gruppi più grandi (§6.6), così buffer minimo più un append restano sotto i 150 MiB. Il minimo del buffer in avanti dell'ADR 0005 diventa 1 × la durata obiettivo.

### 6.12 Dolby Vision P7 (H11)

- **Finché H11 non è misurata vale la regola provvisoria del doc 04 §4.2.** Verso il browser, un DV P7 si serve come HDR10 con `hvc1`, video copiato e `-bsf:v hevc_metadata=remove_dovi=1`. Mai `-strict unofficial`, mai un box DV.
- La sessione lo dice nei motivi: "Dolby Vision P7: servito come HDR10, layer DV rimossi (regola provvisoria)".
- **Evidenza parziale (E6):** su un P8.1 il filtro toglie tutte le RPU (62 → 0) e lascia i SEI di mastering e di content light level. Anche VPS/SPS/PPS passano da 4 a 2, con entrambi i filtri provati: effetto della riscrittura dei parametri, da tenere presente. Che tolga anche l'EL di un P7 (NAL 63) non è misurato.
- Un errore fatale MSE su un P7 porta alla ripianificazione: con il video come dimensione sospetta si arriva al Transcode, che per il 4K dà `NO_COMPATIBLE_PLAN` (P2).
- P8.1 resta com'è (RPU nel flusso, misurato in S2). Togliere le RPU anche lì sarebbe una trasformazione non necessaria.
- **Misura da fare** quando arriva un sample P7 (azione del proprietario): copia così com'è e copia con `remove_dovi`, conteggio delle NAL 62/63 con `helpers.mjs naltypes`, riproduzione nei tre browser.

### 6.13 Librerie

| Bisogno | Scelta | Alternative considerate |
|---|---|---|
| Lettore di box ISO-BMFF (frammenti, `tfdt`/`trun`, `hvcC`/`avcC`/`esds`/`dfLa`/`dOps`/`dec3`) | **scritto a mano**, circa 200 righe, con test su fixture generate da ffmpeg nei test d'integrazione. Prototipo in `spikes/a3-stream-delivery/mp4inspect.mjs` | mp4box.js 2.5.0 (BSD-3-Clause, 2026-10-25): parser completo, molto più grande del bisogno |
| Indice dei keyframe da Matroska | **parser EBML minimo scritto a mano**, solo SeekHead e Cues, confrontato con la sonda a salti nei test | sonda a salti di ffprobe (ripiego, §6.4) |
| Writer delle playlist HLS | **scritto a mano**: VOD e multivariante, una decina di tag | hls-parser 0.16.x (MIT): non serve per scrivere due playlist fisse |
| Processi, file, Range | execa 10.2.1, `@fastify/send` 4.2.1 (ADR 0001) | — |
| Sonda dei keyframe di ripiego, estrazione | ffprobe/ffmpeg di jellyfin-ffmpeg 8.1.3 (ADR 0006) | — |

Nessuna dipendenza nuova. È coerente con la regola dell'ADR 0001: si scrive a mano il codice piccolo e testabile.

### 6.14 Dipendenze con altre aree

- **ADR 0001:**
  - execa e la contropressione degli stream di Node;
  - `@fastify/send` per file, segmenti e `.sup` completi;
  - token mascherato da pino.
- **ADR 0004 e contratto** (modifiche additive, applicate in `services/video/contract`):
  - token nel path: i nomi relativi della playlist (`media-0.m3u8`, `init-0.mp4`, `seg-0-00042.m4s`) rispettano il pattern di `resource`;
  - `stream.mediaTimestampOffsetMs`, `stream.bitrate`, `startOffsetMs` = 0 per ogni protocollo;
  - `availability` sulle tracce di sottotitoli; `switchWithoutRestart` riferito solo allo stream; evento `playback.subtitle_ready`;
  - `503` con `Retry-After` su `getHlsResource`, mai `404` per una risorsa della playlist a sessione viva;
  - `503` `STREAM_PREPARING` su `startPlayback`; `500` `STREAM_FAILED` sul data plane;
  - `MIME_TYPE_UNSUPPORTED` e `STREAM_FAILED` nel vocabolario di `FallbackRequest.error`;
  - `stream.mimeType` dal segmento di init.
- **ADR 0006:**
  - `flush_interval -1` sui media, che serve anche al `.sup` in streaming;
  - scratch con quota;
  - `video-cache` con il sotto-path `delivery/` per i sottotitoli estratti e l'indice dei keyframe, entrambi derivati;
  - jellyfin-ffmpeg 8.1.3 (`remove_dovi`, `libopus`), `init: true`, `stop_grace_period`;
  - nuove chiavi del `.env` (§6.16).
- **ADR 0005** (le scrive il suo autore):
  - build **light** di hls.js (audio muxato, nessuna rendition separata);
  - `autoStartLoad: false` + `startPosition`;
  - `timelineOffsetMs = initPTS·1000/timescale − mediaTimestampOffsetMs` a ogni `INIT_PTS_FOUND`, nei due sensi; non serve più un campo `stream.timelineOffsetMs`, perché il client lo ricava;
  - buffer da `BANDWIDTH` e da `stream.bitrate`, con il minimo pari a 1 × la durata obiettivo;
  - `reportPlaybackFailure` automatico con sospetto `unknown` su un 5xx fatale dopo i tentativi di hls.js;
  - errori di un motore in sostituzione ignorati: un `410` del token vecchio non deve diventare un nuovo `StartPlayback`;
  - "in preparazione" con nuovo tentativo su `STREAM_PREPARING`;
  - libpgs con `loadFromUrl` in streaming; rilettura dell'URL a `playback.subtitle_ready`; nessun `ChangeTracks` necessario per una traccia `growing`;
  - verifica in F1c di `negative_cts_offsets`, di `timelineOffsetMs` dopo un riavvio e del WebVTT che cresce.
- **ADR 0002:** nessun cambiamento di schema. Indice dei keyframe e sottotitoli stanno nella cache, indicizzati per impronta del file; le sessioni restano runtime.
- **Job Runner (doc 02 §3.12):** job dell'indice dei keyframe dopo `FileAnalyzed`, con priorità alta su `STREAM_PREPARING`.
- **Accelerazione hardware (ADR futura):** il Transcode usa lo stesso segmenter; cambia solo l'encoder.

### 6.15 Domande aperte e rischi

- **`trun` versione 1 con composizione negativa** (`negative_cts_offsets`): è CMAF standard, ma non è provato con hls.js 1.7.4 nei tre browser (F1c). Se fallisce, si toglie il flag: lo spostamento pari al ritardo di riordino (33 ms a 60 fps, fino a circa 125 ms a 24 fps) entra in δ, e il client lo compensa con lo stesso `timelineOffsetMs`.
- **`timelineOffsetMs` dopo un riavvio:** da confrontare con il PTS originale in F1c, su GOP chiusi e aperti.
- **GOP aperti su un remux reale:** il pre-roll è verificato solo sulla fixture x265 del revisore; il test di F1b lo ripete su una fixture a 23,976 fps, e va ripetuto sul primo remux vero.
- **Parser dei Cues:** da scrivere e confrontare con la sonda a salti sui sample. Se risulta inaffidabile, la sonda diventa la fonte primaria, con `STREAM_PREPARING` più frequente.
- **MKV senza Cues:** seek e riavvii lenti anche per ffmpeg. La diagnostica segnala il file con il consiglio di rifare il remux con l'indice.
- **E-AC-3 7.1 con substream dipendente** copiato verso Edge: non misurato (S2).
- **Contesa di I/O** sul bind mount NTFS fra playback ed estrazione: limitata da `SUBTITLE_EXTRACT_MAX_MBPS`, ma la latenza di un seek durante l'estrazione va misurata.
- **Una sola estrazione di sottotitoli alla volta:** con 3 sessioni, i sottotitoli del secondo e del terzo film aspettano un passaggio intero. Da rivedere con il target di 3 sessioni.
- **H11 (DV P7):** aperta; serve un sample del proprietario.
- **Giunzione audio** fra segmenti di esecuzioni diverse (dopo un seek indietro): sovrapposizione o buco fino a un frame audio. Da misurare in F1c.

### 6.16 Raccomandazione

- **Protocollo:** HLS con segmenti fMP4 (CMAF), playlist **VOD** dell'intero film e segmenti prodotti su richiesta; audio muxato, una traccia per stream. Runner-up: DASH CMAF, se un client futuro lo richiedesse.
- **Segmenter:** ffmpeg scrive fMP4 frammentato (`frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets`, `-copyts`, `-output_ts_offset 10`) su stdout, e il modulo `delivery` lo taglia in segmenti da circa 4 s (al più 6 s o 32 MiB) sul PTS dei keyframe. Ogni esecuzione parte un GOP prima e scarta il pre-roll. Runner-up: il muxer `hls` di ffmpeg, solo con la playlist EVENT.
- **Indice dei keyframe:** Cues di Matroska come fonte primaria, sonda a salti come ripiego, job obbligatorio dopo `FileAnalyzed`, `STREAM_PREPARING` se manca e serve la sonda lenta.
- **Timeline:** offset costante dichiarato in `stream.mediaTimestampOffsetMs`; il client ricava `timelineOffsetMs` a ogni `INIT_PTS_FOUND`.
- **Processi:** uno per sessione, throttling per contropressione, kill su stop, timeout, ripianificazione, seek lontano e inattività; scratch a finestra con quota; `STREAM_FAILED` e registro del fallimento lato server per la ripianificazione automatica.
- **Direct Play:** Fastify con `@fastify/send`, come da ADR 0006.
- **Audio:** scala di §6.9, con `aformat=channel_layouts=5.1` prima di AAC e Opus e il controllo dell'`esds` sull'init.
- **Sottotitoli embedded:** estrazione completa per file nella cache, al primo playback, con pre-roll di 60 s prima della posizione della sessione, `-copyts -flush_packets 1`, lettura limitata in byte, servita in streaming mentre cresce, `availability` ed evento `playback.subtitle_ready`. Runner-up: uscita in più del remux.
- **Buffer:** playlist multivariante con `BANDWIDTH` e `AVERAGE-BANDWIDTH`, più `stream.bitrate` nella sessione.
- **DV P7:** regola provvisoria con `remove_dovi`, da misurare.
- **Librerie:** nessuna nuova.
- **Configurazione nuova** (`.env`, ADR 0006):
  - `HLS_SEGMENT_TARGET_S=4`, `HLS_SEGMENT_MAX_S=6`, `HLS_SEGMENT_MAX_BYTES=32MiB`;
  - `DELIVERY_AHEAD_S=30`, `DELIVERY_BEHIND_S=30`, `DELIVERY_IDLE_KILL_S=120`;
  - `SUBTITLE_EXTRACT_MAX_MBPS=15`, `SUBTITLE_PREROLL_S=60`, `SUBTITLE_PREEXTRACT=off`, `SUBTITLE_CACHE_MAX_BYTES=20GB`.

---

## 7. Web client

- **Area:** framework della UI, build, client dell'API, stack del player, stile, i18n, stato e test del web client
- **ADR:** [0005 — Web client: React 19 con Vite 8, hls.js e libpgs](../adr/0005-web-client-react-vite.md) (Accepted, 2026-11-05)
- **Data:** 2026-11-05; rivista lo stesso giorno dopo la revisione di design dell'ADR 0005 e i punti incrociati della revisione dell'ADR 0003
- **Aree collegate:** [runtime](#1-runtime-e-framework-del-backend) (ADR 0001: TypeScript, workspace npm, Vitest), [contratto API](#3-formato-del-contratto-api-e-codegen) (ADR 0004: openapi-typescript e openapi-fetch), [deploy](#4-deploy-e-gateway) (ADR 0006: Caddy serve la build statica), [streaming](#6-protocollo-di-streaming-e-stream-delivery) (ADR 0003: vedi §7.11)

### 7.1 Decisioni da prendere

Il web client è il primo e, nell'MVP, l'unico client (§7, §19). Fa tutto quello che vede il proprietario: scelta del profilo, Home, dettaglio, ricerca, player e la sezione di gestione "Da verificare" (doc 02 §2.3, C3; doc 06 F1c). Le decisioni sono cinque:

1. il **framework della UI**;
2. **build e ambiente di sviluppo**: dove vive il codice e come la build arriva a Caddy;
3. il **client dell'API**: tipi generati dal contratto, token del profilo, polling degli eventi;
4. lo **stack del player**: motori di riproduzione, sottotitoli, capability, verifica del `mimeType`, ripianificazione, buffer, timeline;
5. **stile, i18n, stato e test**.

Il client TV sarà con ogni probabilità **un'app nativa** (Kotlin/Media3, ADR 0004 punto 7): Media3 fa Direct Play di MKV, passthrough audio e PGS da sé (doc 04 §4.1, §4.4). Ne segue che il web client non condivide codice di UI con la TV. Con la TV condivide il contratto, il vocabolario delle capability (I6) e il protocollo di ripianificazione (doc 04 §8).

### 7.2 Criteri

| # | Criterio | Fonte | Peso | Vincolo rigido? |
|---|---|---|---|---|
| W1 | **Qualità e manutenibilità con sviluppo AI**: codice corretto alla prima stesura, pattern stabili, errori presi dal compilatore e dal lint, revisione del proprietario | CLAUDE.md, §18 "Qualità" | 5 | no |
| W2 | **Integrazione del player imperativo**: `<video>`, hls.js, Worker di libpgs e `requestVideoFrameCallback` vivono fuori dal ciclo di render, con un ciclo di vita pulito (attach, destroy, ripianificazione) | doc 04 §5, §8; S2 scoperta 4 | 4 | no |
| W3 | **Ecosistema**: routing con parametri di ricerca tipizzati (filtri e ordinamenti, doc 03 P5), cache dei dati del server, componenti accessibili, test | §16, doc 03 §3.2 | 4 | no |
| W4 | **Manutenzione e licenza**: versione stabile, API ferma nei prossimi 12 mesi, licenza permissiva | §18 "Evolvibilità" | 4 | sì (licenza permissiva, progetto mantenuto) |
| W5 | **Tipi dal contratto e TypeScript strict** senza strumenti in più | ADR 0001, ADR 0004 punto 6 | 4 | sì (TypeScript, tipi da openapi-typescript) |
| W6 | **Costo di bundle e di runtime** su un PC modesto in LAN | §18 | 2 | no |
| W7 | **Focus e D-pad**, se la stessa UI finisse su un browser TV | §7 "TV" | 1 | no |
| — | **Build statica** servita da Caddy, nessun server di rendering | ADR 0006, doc 02 C2 | — | sì (passa/non passa) |

- La familiarità del proprietario conta solo dentro W1, come capacità di rivedere il codice.
- W6 pesa poco perché il client gira su browser desktop in LAN: il costo vero del primo playback è il player (§7.4).
- W7 pesa poco perché la TV avrà un'app nativa (§7.1).

### 7.3 Opzioni (stato al 2026-11-05)

Versioni, date e licenze sono lette dal registry npm il 2026-11-05 (`npm view`, campi `version`, `license`, `time`, `dist-tags`).

#### A. React 19
- **react / react-dom 19.3.1** (MIT, 2026-10-14). La serie 19 è stabile dal 2024-12-05; la 19.3.0 ha aggiunto `<ViewTransition />` e Fragment Refs ([changelog 19.3.0](https://www.gitclear.com/open_repos/facebook/react/release/v19.3.0), mirror, settembre 2026).
- Plugin di build `@vitejs/plugin-react` 6.2.1 (MIT), per Vite 8.
- **Ecosistema:**
  - routing: TanStack Router 1.170.46 (MIT, 1.x stabile dal 2023-12, parametri di path e di ricerca tipizzati, validazione dei parametri con uno schema) o React Router 8.5.1 (MIT);
  - dati: TanStack Query 5.106.1 (MIT);
  - accessibilità: React Aria Components 1.22.1 (Apache-2.0);
  - test: Testing Library 16.3.3;
  - navigazione spaziale per D-pad: `@noriginmedia/norigin-spatial-navigation` 3.4.0 (MIT), pensata per React.
- **Contro:**
  - il runtime più pesante delle quattro opzioni (§7.4);
  - il modello a effetti, con lo `StrictMode` che in sviluppo monta due volte, punisce un player scritto dentro i componenti;
  - React Router ha cambiato API due volte in due anni (v6 → v7 → v8): il codice generato tende a mescolare le versioni.

#### B. Svelte 5
- **svelte 5.57.3** (MIT, 2026-10-26), runes stabili dal 2024-10-19; `@sveltejs/vite-plugin-svelte` 7.3.1; SvelteKit 3.1.1 in modalità SPA con adapter statico, oppure un router di terze parti.
- **Pro:**
  - runtime minimo (§7.4);
  - componenti leggibili;
  - `$effect` e gli attachment rendono naturale agganciare un oggetto imperativo come hls.js.
- **Contro:**
  - i tipi nei template passano da un controllore separato (svelte-check 4.7.8);
  - il codice Svelte 4 (store, `export let`, `$:`) è ancora maggioritario nel materiale da cui imparano i modelli, quindi il codice generato tende a mescolare due sintassi;
  - l'ecosistema dell'accessibilità e del routing fuori da SvelteKit è più sottile.

#### C. Solid
- **solid-js 1.9.18** (MIT, 2026-10-29), con la **2.0 in release candidate** (`next` = 2.0.0-rc.21) e il router 1.0.1 appena uscito (2026-10-30), già con una 2.0 in `next`. La beta 2.0 cambia async, Suspense e batching ([This Month in Solid](https://dev.to/danieljcafonso/this-month-in-solid-v200-beta-is-over-and-start-v2-on-the-horizon-26jo), 2026).
- **Pro:**
  - reattività fine, nessun re-render;
  - TSX controllato da `tsc`;
  - runtime piccolo.
- **Contro:**
  - una migrazione 2.0 imminente;
  - l'ecosistema più piccolo;
  - meno codice di riferimento per i modelli.

#### D. Vue 3
- **vue 3.5.45** (MIT, 2026-11-05), con la 3.6 (Vapor Mode) in release candidate e non ancora stabile ([OpenReplay](https://blog.openreplay.com/vue-vapor-mode/), ottobre 2026); vue-router 5.4.0.
- **Pro:** maturo, ecosistema completo, TanStack Vue Query.
- **Contro:**
  - due stili di API (Options e Composition) che i modelli mescolano;
  - template controllati da vue-tsc;
  - un cambio di modello di compilazione (Vapor) in arrivo.

**Scartati:** Lit 3.3.3 (BSD-3-Clause) e i web component scritti a mano: routing, cache dei dati e componenti accessibili sarebbero tutti da scrivere, cioè più codice nostro da rivedere senza vantaggi per un'unica SPA. Preact 11.1.1 (MIT) è un sostituto di React più leggero, ma con un ecosistema di compatibilità meno provato: si può riconsiderare se il peso diventasse un problema.

### 7.4 Esperimento W1: peso del bundle (2026-11-05)

Esperimento usa e getta in `spikes/w1-web-bundle/` (`run.sh` e `src/`, output in `out/`), sul portatile con Node 26.13.0 e Vite 8.3.6. Si rifà con `bash spikes/w1-web-bundle/run.sh`. Ogni build di produzione contiene una pagina con un contatore, una query di TanStack Query con `refetchInterval` e una chiamata openapi-fetch. I pesi sono quelli riportati da Vite, gzip compreso:

| Variante | JS | gzip |
|---|---|---|
| a0: React 19.3.1 + TanStack Query 5.106.1 + openapi-fetch 0.17.0, senza router | 259,9 KB | 80,8 KB |
| a1: a0 + TanStack Router 1.170.46 (route nel codice, senza plugin) | 336,3 KB | 107,3 KB |
| a2: a0 + React Router 8.5.1 al posto di TanStack Router | 353,7 KB | 110,8 KB |
| b0: Svelte 5.57.3 + TanStack Svelte Query 6.3.11 + openapi-fetch 0.17.0, **senza router** (switch a hash scritto a mano) | 73,9 KB | 25,2 KB |
| Chunk del player con hls.js 1.7.4 **completo** (worker incluso) | 578,4 KB | 180,3 KB |
| Chunk del player con **`hls.js/light`** | 362,3 KB | 115,3 KB |
| libpgs 0.9.0, chunk condiviso dai due player | 69,1 KB | 23,2 KB |
| Worker di hls.js per la build ESM (`hls.worker.js`), asset con hash | 118,4 KB | — |
| Worker di libpgs, asset con hash | 66,0 KB | — |

- **Tipi:** `tsc` 6.0.3 strict, anche con `skipLibCheck: false`, passa su React 19.3, hls.js light e libpgs con tre dichiarazioni locali (`src/ambient.d.mts` dello spike):
  - `hls.js/light` non ha tipi: l'export `./light` di hls.js 1.7.4 non ha la condizione `types` (TS7016). La dichiarazione riesporta i tipi di `hls.js`;
  - libpgs 0.9.0 dichiara nei suoi tipi due import a solo effetto, `core-js/stable/promise` e `whatwg-fetch` (TS2882): bastano due `declare module`.
- **Polyfill di libpgs:** libpgs 0.9.0 porta dentro di sé core-js 3.50 (Promise) e whatwg-fetch (MIT), per la compatibilità con WebOS. Nei browser moderni si attivano solo se mancano le funzioni native (giudizio, non misurato).
- **Compressione:** il Caddyfile di F0 comprime solo `/video/api/*`. Gli asset della SPA oggi viaggiano senza gzip, cioè con i pesi della colonna JS (§7.6).
- **Non misurati:** tempi di parsing ed esecuzione, i bundle di Solid e Vue, Svelte con un router, la memoria.
- **Lettura:** fra React con router (107 KB) e Svelte senza router (25 KB) ci sono circa 80 KB gzip; con un router Svelte la differenza sarebbe minore. In LAN a 100 Mbps 80 KB sono circa 7 ms di trasferimento; su un PC modesto il parsing aggiunge decine di millisecondi (giudizio). Il primo playback è dominato dal chunk del player (circa 139 KB gzip con la build light più libpgs), uguale per tutti i framework. W6 quindi non decide.

### 7.5 Valutazione del framework

Punteggi 1–5. **E** = evidenza (§7.4, registry, documentazione); **G** = giudizio.

| Criterio (peso) | A. React 19 | B. Svelte 5 | C. Solid 1.9/2.0 | D. Vue 3.5 |
|---|---|---|---|---|
| W1 Qualità con sviluppo AI (5) | 5 G: il corpus più ampio, JSX controllato da `tsc`, regole di `eslint-plugin-react-hooks` 7.1.1 | 4 G: leggibile, ma con il rischio di sintassi Svelte 4 mescolata | 3 G: corpus piccolo, 2.0 in arrivo | 4 G: due stili di API |
| W2 Player imperativo (4) | 4 G: possibile con un controller esterno e `useSyncExternalStore`; attenzione allo `StrictMode` | 5 G: `$effect` e attachment | 5 G: nessun re-render | 4 G |
| W3 Ecosistema (4) | 5 **E**: TanStack Router e Query, React Aria, Testing Library, Norigin (versioni al §7.3) | 4 **E**: SvelteKit o router di terze parti, TanStack Svelte Query 6 | 3 **E**: router 1.0.1 di 6 giorni, 2.0 in `next` | 4 **E**: vue-router 5.4, TanStack Vue Query |
| W4 Manutenzione e licenza (4) | 5 **E**: MIT, 19.x stabile dal 2024-12 | 5 **E**: MIT, 5.x stabile dal 2024-10 | 2 **E**: la 1.9 sarà sostituita dalla 2.0 (RC) | 4 **E**: MIT, 3.6 in RC |
| W5 Tipi e TS strict (4) | 5 **E**: `tsc` sui TSX (§7.4) | 4 G: serve svelte-check | 5 G: TSX | 4 G: serve vue-tsc |
| W6 Bundle e runtime (2) | 2 **E**: 81 KB gzip senza router, 107 con | 5 **E**: 25 KB gzip senza router | 5 G | 3 G |
| W7 Focus e D-pad (1) | 4 **E**: Norigin 3.4.0 | 3 G | 2 G | 3 G |
| **Totale pesato (/5)** | **4,54** | 4,38 | 3,63 | 3,88 |

Tutte e quattro passano il vincolo della build statica: Vite produce file statici e nessuna opzione richiede un server di rendering.

**Lettura del risultato.** React e Svelte sono vicini, quindi il totale da solo non basta a decidere.
- **Svelte vince su W2 e W6**, ma nessuno dei due vincola davvero:
  - il player si scrive comunque come modulo TypeScript senza framework (§7.8), quindi l'ergonomia del framework conta solo per l'involucro;
  - il bundle conta poco in LAN, e il primo playback è dominato dal player (§7.4).
- **React vince su W1, W3 e W5**, che vincolano adesso:
  - F1c lo scrive un agente, subito, e il proprietario lo rivede;
  - router e cache dei dati sono tipizzati e maturi;
  - i TSX sono controllati da `tsc` senza strumenti in più, nella stessa `npm run verify` del backend.
- Un esperimento in più non cambierebbe l'esito: l'unica differenza misurabile, il peso, è già misurata (§7.4).

### 7.6 Build, workspace e consegna a Caddy

- **Vite 8.3.6** (MIT, 2026-11-05) con `@vitejs/plugin-react` 6.2.1. Vite 8 compila con Rolldown. La build produce file statici con hash in `/assets/`: è il path su cui il Caddyfile mette già `Cache-Control: immutable`.
- **Posizione:** `clients/web/` è già un workspace npm della radice (`package.json`, ADR 0001), con il nome `@pezzotflix/web`. Un solo lockfile, un solo `typescript` 6.0.3, ESLint 10 e Vitest 5 condivisi con il backend.
- **`tsconfig` del web client, deroga esplicita all'ADR 0001.** L'ADR 0001 chiede `"types": ["node"]` in ogni workspace. Il web client gira nel browser, quindi usa `"types": ["vite/client"]`, `"lib": ["ES2024", "DOM", "DOM.Iterable"]`, `moduleResolution: "bundler"` e `jsx: "react-jsx"`, senza tipi di Node; i file di configurazione (`vite.config.ts`, `playwright.config.ts`) hanno un `tsconfig.node.json` a parte, con i tipi di Node. Il resto segue l'ADR 0001 (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `skipLibCheck: true`). F1c non copia il `tsconfig` del backend.
- **Dichiarazioni locali** in `src/types/ambient.d.ts`: `hls.js/light` (riesporta i tipi di `hls.js`) e i due import a solo effetto di libpgs (§7.4). `?url` è già dichiarato da `vite/client`.
- **Struttura** (proposta per F1c):

```text
clients/web/
  index.html, vite.config.ts, tsconfig.json, tsconfig.node.json, eslint.config.js, playwright.config.ts
  src/
    api/        client openapi-fetch, schema.d.ts generato, query, poller degli eventi
    player/     motore di riproduzione in TypeScript puro: nessun import da react
    i18n/       messaggi in italiano e formattazione Intl
    app/        router, provider, layout
    features/   profiles, home, catalog, item, search, player (UI), admin ("Da verificare")
    styles/     token CSS e stili globali
    types/      dichiarazioni locali (ambient.d.ts)
  test/e2e/     Playwright
```

- **Confini:** una regola di dependency-cruiser, come nel backend, vieta a `src/player/` di importare `react` e `src/features/`. Il motore del player si testa da solo e sopravvive a un cambio di framework.
- **Script:**
  - `dev`: Vite sull'host, con `server.proxy` di `/video` verso il gateway su `http://localhost:8080` (ADR 0006 punto 5);
  - `build`: `vite build` in `clients/web/dist`;
  - `contract:types`: openapi-typescript sul bundle;
  - `typecheck`, `lint`, `test`;
  - `verify`: `contract:check` + `typecheck` + `lint` + `test`, come nel backend; la `npm run verify` della radice la esegue già;
  - `e2e`: Playwright, fuori da `verify` (§7.9).
- **Consegna a Caddy:** l'artefatto è `clients/web/dist`.
  - **Produzione (ADR 0006):** l'immagine `gateway` si costruisce in multi-stage. Uno stage `node:26.13.0-trixie-slim` esegue `npm ci -w @pezzotflix/web --include-workspace-root`, così non installa le dipendenze del backend (better-sqlite3, drizzle…), poi `npm run build -w @pezzotflix/web`; l'immagine `caddy:2.11.8-alpine` copia `dist` in `/srv/web`.
  - **Sviluppo:** il Compose di F0 monta `clients/web/dist` in sola lettura su `/srv/web`, ed è sufficiente.
- **Cache:** il Caddyfile di F0 mette già `no-cache` su `index.html` e sulle route della SPA (`@shell`), e `immutable` su `/assets/*`. Non serve altro.
- **Compressione:** il Caddyfile comprime solo `/video/api/*`. Nel blocco della SPA va aggiunto `encode zstd gzip`, così i chunk viaggiano compressi (§7.4: il player passa da circa 431 KB a circa 139 KB). È una riga del Caddyfile, da fare in F1c (§7.12).

### 7.7 Client API, profilo ed eventi

- **Tipi** (ADR 0004 punto 6): openapi-typescript 7.13.0 genera `clients/web/src/api/schema.d.ts` da `services/video/contract/dist/openapi.json`. Il file si versiona, e `verify` lo rigenera e fallisce se c'è un diff. Nessun pacchetto di contratto condiviso.
- **Runtime:** **openapi-fetch 0.17.0** (MIT, circa 2 KB gzip), con `baseUrl` uguale all'origine della pagina. È il gateway che serve la SPA, quindi il client non conosce host né IP (doc 03 P1).
- **Cache dei dati:** **TanStack Query 5.106.1**. Le query sono scritte a mano in `src/api/queries.ts`, con chiavi esplicite per operazione (`['home']`, `['items', filtri]`, `['item', id]`, `['admin', 'cases', stato]`…).
  - Il wrapper `openapi-react-query` 0.5.4 non serve: un helper di una trentina di righe fa lo stesso con una dipendenza in meno.
  - I tipi stretti per `PlaybackSession.mode` ed `Event.type` si scrivono a mano, come prevede l'ADR 0004 (niente `oneOf` con `discriminator` in `v1`).
- **Contesto di profilo** (doc 03 P2, ADR 0004 punto 8):
  - `SelectProfile` restituisce `profileToken`. Il client lo tiene in `localStorage` (`pezzotflix.profile`: id e token), così l'ultimo profilo resta scelto su quel browser; "Cambia profilo" è sempre nell'intestazione;
  - un middleware di openapi-fetch aggiunge `Authorization: Bearer` su ogni chiamata del control plane, tranne quelle con `security: []` (`listProfiles`, `selectProfile`, `getServerInfo`);
  - un `401` del control plane cancella il token e porta alla scelta del profilo;
  - nell'MVP il token non è un segreto. Con l'autenticazione vera (§9, §14) il salvataggio si rivede (per esempio un cookie `HttpOnly`), con la sua ADR;
  - il data plane non usa header: i locatori portano già il token di sessione nel path (P9), e il client non costruisce mai URL.
- **Polling degli eventi** (doc 03 I3, ADR 0004 punto 8): è un modulo `EventPoller`, non un `refetchInterval`, perché deve tenere il cursore.
  - All'avvio `listEvents` senza cursore: dà la posizione corrente e nessun evento.
  - Poi una chiamata ogni **5 s** con la pagina visibile, anche durante la riproduzione e a schermo intero. Con la pagina nascosta il polling si ferma (Page Visibility), e riparte subito quando torna visibile; **con una sessione di playback attiva** non si ferma ma passa a 15 s, perché il player aspetta `playback.subtitle_ready` (§7.8.6). Dopo un errore di rete l'intervallo cresce fino a 60 s.
  - Ogni evento invalida le query interessate:

    | Evento | Query invalidate |
    |---|---|
    | `library.item_added` / `library.item_updated` / `library.item_removed` | `['home']`, `['items']`, `['search']`, e `['item', id]` se il payload lo porta |
    | `ingest.progress` | `['admin', 'ingest']` |
    | `identification.needs_review` | `['admin', 'cases']` (badge "Da verificare") |
    | `playback.session_terminated` | ferma il player se la sessione è la sua e mostra il motivo |

    Dopo l'MVP (2026-11-06): con `library.item_removed` il client toglie dalla cache le query non attive dell'item. Una pagina aperta sull'item va all'item che lo sostituisce (`replacedBy`) oppure mostra "non trovato"; il player continua e usa l'item nuovo per gli avvii successivi. Le sostituzioni restano in memoria per scheda: se il cursore degli eventi scade, una pagina aperta tiene i suoi dati finché non viene ricaricata.
    | `playback.subtitle_ready` `{sessionId, trackId, availability}` | se la sessione è quella del player: aggiorna `availability` della traccia e, se è scelta, la ricarica (§7.8.6) |
    | tipo sconosciuto | ignorato (enum aperti, ADR 0004) |

  - `410 CURSOR_EXPIRED`: invalida tutto e riparte senza cursore.
- **Lingua:** `<html lang="it">`. Il browser manda già `Accept-Language`, e il contratto oggi non ha un parametro di lingua (doc 03 P4): per l'MVP basta, perché i metadata sono in `it-IT` lato server.

### 7.8 Stack del player

Il player è un modulo TypeScript senza framework, `src/player/`. Un `PlayerController` riceve un `HTMLVideoElement` e una `PlaybackSession`, e la UI React lo legge con `useSyncExternalStore`. È idempotente su `attach`/`destroy`, quindi il doppio montaggio dello `StrictMode` in sviluppo non lascia istanze di hls.js aperte.

**Sostituzione del motore.** Ogni motore (hls.js, `<video src>`, renderer dei sottotitoli) nasce con un numero di generazione legato alla sessione che lo ha creato.
- Quando la sessione cambia (`ChangeTracks`, `ChangeVersion`, `reportPlaybackFailure`, nuova `StartPlayback`), il controller distrugge il motore vecchio **prima** di creare il nuovo.
- Gli errori e gli eventi di un motore che non è quello corrente (vecchio token, `410` dopo `ChangeTracks`, richieste ancora in volo) **si ignorano**: non portano mai a una nuova `StartPlayback` né a un `reportPlaybackFailure`.

#### 7.8.1 Motori di riproduzione

| `stream.protocol` | Motore | Note |
|---|---|---|
| `progressive` (Direct Play dell'originale, o fMP4 progressivo) | `<video src>` nativo | Seek con richieste a intervalli gestite dal browser (doc 04 §6.2). Controllo dell'audio che sparisce (§7.8.5) |
| `hls-fmp4` (Direct Stream, Transcode) | **hls.js 1.7.4**, build **light**, fissato alla versione esatta, via MSE | Il caricamento parte solo dopo aver calcolato i buffer (§7.8.4) |
| `hls-fmp4` senza MSE | nessuno: `NO_COMPATIBLE_PLAN` lato client, con motivo | Tutti i browser desktop misurati hanno MSE; l'HLS nativo non è stato provato (S2) |

- **Perché hls.js 1.7.4 e non 1.7.3, la versione misurata in S2.**
  - La 1.7.4 (Apache-2.0, 2026-10-28) è una patch dentro la 1.7. Fra le correzioni c'è il troncamento dei parameter set, una regressione della 1.7.0 ([release v1.7.4](https://github.com/video-dev/hls.js/releases/tag/v1.7.4)).
  - Le altre correzioni riguardano LL-HLS, DRM, interstitial e audio alternativo, ma **anche** MediaSource, caricamento dei frammenti e timestamp: #8083 (initPTS alle discontinuità), #8085 (detach invece di reset della MediaSource), #8110 (audio silenzioso iniettato), #8125, #8127, #8128. Toccano proprio il percorso del player.
  - Il test end-to-end di F1c/F2 ripete la parte HLS di S2 come test di regressione: h1, h2, h6, c1, c4, c7, **s3** (PGS su 4K HDR10 con rVFC, ritardo ≤ 42 ms) e un caso di **seek e resume** con riavvio della pipeline (§7.8.7). Se fallisce, si torna alla 1.7.3.
- **Build light: `import Hls from 'hls.js/light'`.** L'ADR 0003 mette l'audio muxato nei segmenti video (una sola rendition) e i sottotitoli sono nostri (§7.8.6), quindi audio alternativo, sottotitoli ed EME della build completa non servono. Il chunk del player scende da circa 180 a circa 115 KB gzip, più libpgs (§7.4).
  - I tipi arrivano da una dichiarazione locale (§7.6).
  - La build ESM non incorpora il worker di trasmux: si passa `workerPath` con l'URL di `hls.js/dist/hls.worker.js?url`, che Vite emette con hash (§7.4). Che il worker parta davvero è da verificare in F1c (§7.15); per fMP4 in passthrough il costo nel thread principale è basso, quindi `enableWorker: false` è un ripiego accettabile (giudizio).
- **Configurazione di hls.js:**
  - `enableWorker: true` con `workerPath` (sopra);
  - `autoStartLoad: false`: dopo `MANIFEST_PARSED` si calcolano i buffer e si chiama `startLoad(posizione)`;
  - nessun sottotitolo gestito da hls.js: la build light non li ha, i sottotitoli seguono il §7.8.6.
- **Alternativa al player:** Shaka Player 5.3.3 (Apache-2.0). Non è provato in S2 e non serve finché il protocollo è HLS.

#### 7.8.2 Capability (doc 03 I6, doc 04 §5)

Le capability si rilevano **a ogni `StartPlayback`**, non solo all'avvio dell'app: è il momento in cui conta `displayHdr`.

- **Sonda fissa** con `MediaSource.isTypeSupported('video/mp4; codecs="…"')`, tradotta nel vocabolario fisso:

| Stringa sondata | Dichiarazione se `true` |
|---|---|
| `avc1.640028` | `video[]`: `{ codec: h264, profiles: [high], maxBitDepth: 8 }` |
| `hvc1.2.4.L153.B0`, `hvc1.2.4.H153.B0`, `hvc1.2.4.L183.B0` (almeno una) | `video[]`: `{ codec: hevc, profiles: [main, main10], maxBitDepth: 10 }` |
| `flac` | `audio[]`: `{ codec: flac, maxChannels: 8, mode: decode }` |
| `opus` | `audio[]`: `{ codec: opus, maxChannels: 6, mode: decode }` |
| `mp4a.40.2` | `audio[]`: `{ codec: aac, maxChannels: 6, mode: decode }` |
| `ac-3` | `audio[]`: `{ codec: ac3, maxChannels: 6, mode: decode }` |
| `ec-3` | `audio[]`: `{ codec: eac3, maxChannels: 6, mode: decode }`: il 7.1 con substream dipendente non è misurato (S2) |

- **Risoluzione e frame rate:** per ogni codec dichiarato, `mediaCapabilities.decodingInfo` (tipo `media-source`) a 3840×2160 e **60 fps**.
  - Se risponde `supported`: `maxWidth`/`maxHeight` 3840×2160 e `maxFrameRate: 60`.
  - Altrimenti si prova 3840×2160 a 30 fps (`maxFrameRate: 30`), poi 1920×1080 a 60 e a 30 fps.
  - Il sample 4K di S2 era a 60 fps: la sonda a 60 fps corrisponde a quello che è stato misurato.
- **Limiti:** `limits.maxBitrate` non si invia nell'MVP: non c'è un'impostazione dell'utente né una misura della rete. Il campo assente vuol dire "nessun limite": va concordato con il Decision Engine (F1b).
- **HDR:**
  - `hdr` contiene `HDR10` se `decodingInfo` risponde sì per HEVC Main10 4K con `transferFunction: pq`, `colorGamut: rec2020` e `hdrMetadataType: smpteSt2086`; contiene `HLG` con `transferFunction: hlg`;
  - **mai** DV, perché nessun browser lo riproduce (S2 H3);
  - **mai** HDR10+, perché Firefox risponde sì anche quando non lo presenta (S2 H2), e l'HDR10+ si riproduce comunque come HDR10.
- **Display:** `displayHdr = matchMedia('(dynamic-range: high)').matches`, letto all'avvio della sessione.
- **Container e protocolli:**
  - `containers` contiene sempre `mp4`; contiene `mkv` se `canPlayType('video/x-matroska')` non è vuoto (doc 04 §5);
  - `protocols` = `["progressive"]`, più `"hls-fmp4"` se `Hls.isSupported()`.
- **Tracce e sottotitoli:**
  - `audioTrackSelection: false`, fisso: anche dove `audioTracks` esiste dietro un flag, non è misurato;
  - `subtitles: { text: ["webvtt"], image: ["pgs"], ass: false }`. `pgs` si dichiara solo se ci sono `Worker` e `requestVideoFrameCallback`.
- **Dispositivo:**
  - `device.class` vale `desktop`, oppure `mobile` se `navigator.userAgentData.mobile` è vero;
  - `device.model` = browser, versione e sistema, per esempio `"Edge 156.0.4314.58; Windows 11"`;
  - in Chromium si ricava da `userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion'])`, con Windows 11 quando la major di `platformVersion` è ≥ 13;
  - in Firefox si ricava dallo user agent, che dice sempre "Windows NT 10.0": il modello diventa `"Firefox 159.0; Windows"`, senza distinguere 10 da 11;
  - `device.app` = versione del web client.
- **Diagnostica:** `AudioContext.destination.maxChannelCount` va solo nel log del client, non nelle capability (doc 04 §5).
- **Test:** la tabella si testa con un `isTypeSupported` e un `decodingInfo` finti, uno per ogni browser misurato in S2.

#### 7.8.3 Verifica di `stream.mimeType` prima di avviare

- **Cosa contiene `stream.mimeType`:** per `hls-fmp4` è il MIME dei **segmenti**, `video/mp4; codecs="<video>, <audio>"`, non quello della playlist (ipotesi H-I, §7.11).
- **`hls-fmp4` e MP4 progressivo:** `MediaSource.isTypeSupported(stream.mimeType)` sulla stringa esatta.
  - Se fallisce, si cerca la dimensione sospetta. Il client scompone il parametro `codecs` e prova ogni codec da solo (`video/mp4; codecs="<uno>"`). Sono video le stringhe che iniziano con `avc1`, `avc3`, `hvc1`, `hev1`, `dvh1`, `dvhe`, `av01` e `vp09`; tutte le altre sono audio.
  - Se è rifiutato solo il video, il sospetto è `video`; se è rifiutato solo l'audio, è `audio`.
  - Se sono rifiutati entrambi, o nessuno dei due da solo, il sospetto è `unknown`.
- **MKV in Direct Play:** la verifica MSE non vale, perché `isTypeSupported` dà `false` per MKV ovunque (S2 H1).
  - Se `canPlayType(stream.mimeType)` è vuoto, il sospetto è `container`, senza scomposizione: doc 04 §8 porta al Direct Stream. Provare i codec come `video/mp4` attribuirebbe all'audio o al video un problema del container.
  - Questa verifica ferma solo il container. L'audio si controlla dopo l'avvio (§7.8.5), e "maybe" per qualunque Matroska non dice nulla dei codec (S2 H1).
- **`stream.mimeType` assente:** il contratto lo lascia facoltativo (`required: [url, protocol]`). Il client salta la verifica, lo scrive nel log e si affida agli errori a runtime (§7.8.5).
- **Esito negativo:** `reportPlaybackFailure` con `error: "MIME_TYPE_UNSUPPORTED"` e la dimensione trovata, **in automatico**, senza avviare il player e senza chiedere nulla all'utente (§7.8.5).

#### 7.8.4 Buffer di hls.js dal bitrate

S2 ha misurato che con i default di hls.js un remux UHD a circa 100 Mbps chiede circa 352 MiB di buffer in avanti, contro i 150 MiB di video che Chromium 156 tiene per stream; per l'audio il limite è 12 MiB (doc 04 §4.5). La regola, calcolata a `MANIFEST_PARSED` prima di `startLoad`:

```text
Qv = 150 MiB, Qa = 12 MiB   limiti di Chromium per stream (demuxer_memory_limit)
m  = 0,70                    margine per il buffer in avanti; il 10% va al buffer indietro
ba = stream.bitrate.audioBps
bv = stream.bitrate.peakBps − ba
TD = EXT-X-TARGETDURATION (s)
T  = min(m·Qv·8 / bv, m·Qa·8 / ba)     secondi che stanno nel margine
maxBufferLength = maxMaxBufferLength = clamp(floor(T − TD), TD, 30 s)
maxBufferSize   = floor(m · Qv)        byte; entra nel calcolo della durata, non è un tetto
backBufferLength = max(2 s, floor(0,10·Qv·8 / bv))
```

- **Perché `T − TD`:** hls.js chiede il frammento successivo finché il buffer in avanti è sotto `maxBufferLength`, quindi può arrivare a `maxBufferLength` più un frammento intero. Togliere una target duration tiene anche quel frammento dentro `T`.
- **Minimo di una target duration:** sotto non si scende, altrimenti il player non avrebbe nemmeno un segmento davanti. Se `T < 2 × TD` il minimo vince e il buffer può superare il margine: il client scrive un avviso nel log. L'ADR 0003 limita `TARGETDURATION` tagliando un gruppo di GOP ai keyframe interni sopra 6 s o 32 MiB (`HLS_SEGMENT_MAX_BYTES`).
- **Esempi** (`m·Qv·8` ≈ 881 Mbit, `m·Qa·8` ≈ 70 Mbit):
  - 100 Mbps, TD 4 s: T ≈ 8,8 s → `maxBufferLength` 4 s; in avanti al più 8 s, circa 100 MB, sotto il margine;
  - 1080p a 20 Mbps con AAC 5.1: T ≈ 44 s → tetto di 30 s;
  - FLAC 7.1 a circa 6 Mbit/s, TD 6 s: T audio ≈ 11,7 s → floor(5,7) = 5, alzato al minimo di 6 s; in avanti al più 12 s di audio, circa 8,6 MiB, sotto i 12 MiB;
  - 100 Mbps, TD 6 s: T ≈ 8,8 s < 12 s → avviso; `maxBufferLength` 6 s (circa 72 MiB) più un segmento da al più 32 MiB fanno circa 104 MiB, appena sotto il margine del 70% (105 MiB);
  - 128 Mbps, TD 6 s: T ≈ 6,9 s → avviso; 6 s (circa 92 MiB) più un segmento da 32 MiB fanno circa 124 MiB, sopra il margine ma sotto i 150 MiB (§7.15).
  - Gli esempi diventano casi dei test unitari della regola.
- **Fonte del bitrate:** `stream.bitrate { peakBps, averageBps, audioBps }` nella `PlaybackSession` (§7.12, contratto dell'ADR 0003). Se il campo manca, `bv` viene da `BANDWIDTH` del master playlist meno `ba`, e `ba` da una tabella per codec, che è una **stima (giudizio)**: FLAC 0,75 Mbit/s per canale, AC-3/E-AC-3 640 kbit/s, AAC/Opus 384 kbit/s per il 5.1.
- **Vale per tutti i browser.** Firefox ha un limite suo, non letto nel sorgente (S2): la stessa regola è prudente.
- **`bufferFullError` resta non fatale:** hls.js lo recupera da solo. Il client lo conta e lo scrive nel log. Se compare più di 3 volte in un minuto con questa regola, è un difetto da correggere, non un evento normale.
- **I valori sono di partenza, da verificare su un film intero** in F2: S2 ha misurato clip di 30 s. Il limite audio non è stato esercitato.

#### 7.8.5 Fallimenti e ripianificazione (doc 04 §8)

La ripianificazione è **automatica** (doc 04 §8): nessuna domanda all'utente prima dei tentativi automatici. Il client non lascia mai che hls.js ritenti da solo lo stesso stream dopo un errore fatale (S2 scoperta 4). Ferma e distrugge il motore, poi chiama `reportPlaybackFailure` con posizione, errore e sospetto, e riparte con la sessione restituita.

| Segnale | Azione e sospetto | Note |
|---|---|---|
| Verifica di `mimeType` fallita (§7.8.3) | `reportPlaybackFailure` automatico, sospetto dalla scomposizione dei codec (`container` per l'MKV) | prima di avviare |
| hls.js `ERROR` fatale, `bufferAddCodecError` o `bufferIncompatibleCodecsError` | `reportPlaybackFailure`: `audio` o `video` da `sourceBufferName`; con `audiovideo`, dalla scomposizione dei codec; altrimenti `unknown` | S2: E-AC-3 in Chrome |
| hls.js `ERROR` fatale, `bufferAppendError` o `fragParsingError` | `reportPlaybackFailure`: scomposizione dei codec, poi `unknown` | S2: AAC con PCE, DV `dvh1` in Chrome |
| hls.js `ERROR` fatale, `manifestIncompatibleCodecsError` | `reportPlaybackFailure`: scomposizione dei codec | |
| hls.js `ERROR` di rete fatale con un **5xx** sui media, dopo i retry di hls.js | `reportPlaybackFailure` automatico con sospetto `unknown`: la dimensione la sceglie il server, che ha registrato il fallimento dello stream | hls.js non legge `Retry-After` e ritenta i 5xx con il suo backoff (`error-helper.ts` 1.7.4). Un `500` è `STREAM_FAILED`, definitivo per lo stream (ADR 0003): `errorRetry.shouldRetry` restituisce `false` su 500 in `manifestLoadPolicy`, `playlistLoadPolicy` e `fragLoadPolicy`, così non si aspettano decine di secondi di retry inutili; i `503` restano ritentati |
| hls.js `ERROR` di rete con 401, 403, 404 o 410 | sessione chiusa: `stopPlayback` (idempotente), poi `StartPlayback` dalla posizione corrente | Una risorsa elencata nella playlist non risponde mai 404 finché la sessione è viva (ADR 0003), quindi 404 e 410 vogliono dire sessione chiusa. Lo `stopPlayback` prima evita `SESSION_LIMIT_REACHED` per la propria sessione |
| hls.js `ERROR` di rete non fatale | nessuna: retry di hls.js | |
| `<video>` `error`, `MEDIA_ERR_SRC_NOT_SUPPORTED` in `progressive` | `reportPlaybackFailure`: `container` | |
| `<video>` `error`, `MEDIA_ERR_DECODE` | `reportPlaybackFailure`: `video` se l'audio è stato decodificato, altrimenti `unknown` | |
| `<video>` `error`, `MEDIA_ERR_NETWORK` in `progressive` | come i 5xx di hls.js: `reportPlaybackFailure` con `unknown` dopo un nuovo tentativo del browser | |
| **Audio che sparisce** in `progressive` (Direct Play e fMP4 progressivo): dopo 4 s di `currentTime` avanzato con una traccia audio selezionata, `webkitAudioDecodedByteCount === 0` (Chromium) o `mozHasAudio === false` (Firefox) | `reportPlaybackFailure`: `audio` | Le proprietà non sono standard: se mancano, nessun segnale (S2). L'AAC con PCE in Firefox non si vede: lo previene il server |
| libpgs o `<track>`: caricamento del sottotitolo fallito | `reportPlaybackFailure`: `subtitle`, con il motore staccato come per ogni cambio di stream | Il server ripianifica e restituisce uno stream nuovo, quindi il motore si ricrea (decisione in F1c). Un `503` sull'URL del sottotitolo non è un fallimento: si riprova dopo `Retry-After` e la traccia resta "in preparazione".<br>**Da F1b.4:**<br>- un `503 MEDIA_UNAVAILABLE` senza `Retry-After` su una traccia `complete` è un fallimento subito (estrazione fallita sul server);<br>- se una risposta in crescita si interrompe e la sonda risponde 2xx, il client ricarica una volta, e il permesso torna appena arrivano dati |
| Errore di un motore in sostituzione (§7.8) | ignorato | mai una nuova `StartPlayback`. Vale anche mentre è in volo una chiamata che sostituisce lo stream (`ChangeTracks`, `ChangeVersion`, `reportPlaybackFailure`): prima della chiamata il client alza la generazione, il motore vecchio continua a suonare ma i suoi errori, compreso il 410 dei locatori vecchi, non contano |
| hls.js `ERROR` fatale, `bufferStalledError` o `bufferSeekOverHole` (fatali in 1.7.4 dopo `nudgeMaxRetry`) | un solo reload, poi `reportPlaybackFailure` con `unknown` | hls.js ferma il caricamento: senza azione resterebbe uno spinner infinito |
| hls.js `ERROR` fatale, `mediaSourceRequiresReset` con `video.error` impostato, o ripetuto sulla stessa sessione | `reportPlaybackFailure`: scomposizione dei codec, poi `unknown`; al più un reload | In 1.7.4 un append fallito dopo che Chromium ha chiuso la MediaSource arriva con questo codice (casi di S2: AAC con PCE, DV) |

- **Esclusioni:**
  - `bufferFullError` non è un fallimento del piano;
  - `mediaSourceRequiresReset` e `bufferStalledError` non fatali sono gestiti da hls.js; le versioni fatali seguono la tabella.
- **Posizione prima del posizionamento:** finché il motore non ha raggiunto la posizione di partenza (primo `playing` o `seeked`), il client usa la posizione di partenza per i fallimenti, lo stop, il progress e il `pagehide`, mai `currentTime` = 0 (revisione di F1c).
- **Limite:** al massimo **3 tentativi automatici per avvio**, contando insieme le ripianificazioni e le nuove `StartPlayback` dopo una sessione chiusa. Il doc 04 §8 non fissa un numero: questo è il limite del web client. Esauriti i tentativi, il player mostra i motivi della sessione e solo allora offre "Riprova" all'utente.
- **`422 NO_COMPATIBLE_PLAN`** mostra il motivo del server ("4K: serve un Transcode, non disponibile nell'MVP", P2).
- **Diagnostica:** il pannello "Informazioni tecniche" del player mostra `mode`, `reasons`, `mimeType`, la capability dichiarata e l'ultimo fallimento, perché si possa capire perché un film non va in Direct Play (doc 03 §4.3).

#### 7.8.6 Tracce audio e sottotitoli

**Audio** (§6: scelta della traccia audio):
- il menu elenca sempre tutte le tracce audio della sessione, con lingua, codec e canali;
- il cambio passa **sempre** da `ChangeTracks` con `positionMs`, e il player si ricrea sulla sessione nuova:
  - in Direct Play, perché il browser non sceglie la traccia (`audioTrackSelection: false`, S2);
  - in Direct Stream, perché l'audio è muxato nei segmenti video, una traccia per stream (ADR 0003, doc 04 §4.3).
- Con la build light non c'è `hls.audioTrack`: se un giorno arrivassero rendition separate, servirebbe la build completa (§7.11, H-D).

**Sottotitoli:**
- **`client_render` (PGS): libpgs 0.9.0** (MIT, 2026-08-27) nella **configurazione misurata in S2**: `new PgsRenderer({ video, workerUrl, subUrl })`, più un ciclo `requestVideoFrameCallback` che chiama `renderAtTimestamp` (S2 H7, ritardo 4–42 ms).
  - libpgs aggiorna anche sul `timeupdate`, con `currentTime + timeOffset`: i render in più sono ridondanti e restano quelli misurati.
  - Il client tiene `pgs.timeOffset = timelineOffsetMs / 1000` e il ciclo rVFC chiama `renderAtTimestamp(mediaTime + timelineOffsetMs / 1000)`: le due strade danno lo stesso tempo, sulla timeline originale (§7.8.7). La semantica di `timeOffset` è letta in `pgsRenderer.ts` 0.9.0 (`currentTime + timeOffset`).
  - Il canvas lo crea libpgs accanto al video, che sta in un contenitore `position: relative`.
  - Senza rVFC il PGS non si dichiara (§7.8.2).
  - Il Worker si importa con `libpgs/dist/libpgs.worker.js?url`: Vite lo emette con hash in `/assets/` (§7.4).
- **`sidecar` (WebVTT):** un `<track kind="subtitles">` con `src` dal locatore, come in S2 v1. I cue sono sulla timeline originale: dopo il `load` del track, il client sposta `startTime`/`endTime` di ogni `VTTCue` di `−timelineOffsetMs`, e li risposta se l'offset cambia.
- **`embedded` e `burned`:** niente da fare nel client. Una traccia `client_render` non si aggancia mai come `<track>` (descrizione nel contratto).
- **Disponibilità e `switchWithoutRestart`** (decisione dell'orchestratore, contratto dell'ADR 0003):
  - `switchWithoutRestart` riguarda solo lo stream: è vero per una traccia `client_render` o `sidecar` che ha un URL;
  - `availability` ∈ {`complete`, `growing`} dice se l'estrazione è finita;
  - scegliere una traccia `growing` **non** passa da `ChangeTracks`: il client carica l'URL e la UI la mostra "in preparazione", perché i cue prima dell'inizio dell'estrazione possono mancare;
  - una traccia che il client sa mostrare da sé si sceglie in locale, ma il client manda anche `ChangeTracks` con `subtitleTrackId`, così il server registra l'ultima scelta del profilo (doc 04 §3.1); per una traccia servita il server non ripianifica e lo stream resta lo stesso;
  - "Nessuno" passa da `ChangeTracks`: il server registra la scelta e mostra comunque la traccia forced nella lingua dell'audio, se c'è (doc 04 §3.1). La UI mostra la traccia che la sessione dichiara visibile.
- **Regola di ricarica.**
  - `availability` arriva nelle tracce della sessione restituita da `StartPlayback` e da `ChangeTracks`.
  - Il passaggio a `complete` arriva con l'evento **`playback.subtitle_ready`** `{sessionId, trackId, availability}` su `listEvents`, che il client già interroga: ogni 5 s a pagina visibile, ogni 15 s a pagina nascosta con una sessione attiva (§7.7). `reportProgress` risponde 204 senza corpo, quindi non porta lo stato delle tracce.
  - Il client ignora l'evento se `sessionId` non è quello della sessione corrente (§7.8, sostituzione del motore).
  - Quando una traccia scelta passa da `growing` a `complete`, il client rilegge l'URL: per i PGS `pgs.loadFromUrl(url)`, per il WebVTT un `<track>` nuovo con lo stesso `src` al posto del vecchio. Il render in corso non si ferma.
  - **PGS che cresce:** libpgs legge la risposta come stream e, nel Worker, pubblica i display set letti circa ogni secondo mentre carica (`worker.ts` con `onProgress`, `pgs.ts` 0.9.0). Letto nel sorgente, non misurato. La promessa `ready` si risolve solo a fine file, quindi per una traccia `growing` il client non la aspetta.
  - **WebVTT che cresce con `<track>`:** non è verificato che il browser aggiunga i cue mentre la risposta cresce. Va verificato in F1c (§7.15). Il ripiego è `fetch` in streaming più un parser WebVTT minimo che aggiunge `VTTCue` a una traccia creata con `addTextTrack('subtitles')`.
- **Cambio traccia:** con `switchWithoutRestart: true` il cambio è locale (si cambia il `<track>` attivo o si carica un altro `.sup`); altrimenti `ChangeTracks` con la posizione corrente.

#### 7.8.7 Timeline, progress e heartbeat

Decisione dell'orchestratore, che sostituisce l'ipotesi H-B della prima stesura e la richiesta di `stream.timelineOffsetMs`.

- **Offset dei timestamp:** il contratto porta `stream.mediaTimestampOffsetMs`, l'offset costante dei PTS nei segmenti (10000 per `hls-fmp4`, `-output_ts_offset 10` dell'ADR 0003; 0 o assente per `progressive`).
- **Offset della timeline del player:** a ogni `INIT_PTS_FOUND` di hls.js (frammenti `main`) il player calcola

  ```text
  timelineOffsetMs = initPTS · 1000 / timescale − mediaTimestampOffsetMs
  ```

  Per il Direct Play vale 0. Prima del primo `INIT_PTS_FOUND` vale 0: la posizione di partenza può sbagliare di uno scarto δ, che la revisione dell'ADR 0003 ha misurato fra 37 e 203 ms.
- **Posizione sulla timeline originale (doc 04 §6.1):** `positionMs = round(currentTime · 1000 + timelineOffsetMs)`, per progress, resume, capitoli e PGS. Lo stesso offset sposta i cue WebVTT (§7.8.6).
- **Seek a un tempo originale X:** `currentTime = (X − timelineOffsetMs) / 1000`.
- **Resume:** per il Direct Play `currentTime = resumePositionMs / 1000`. Per l'HLS `startLoad` alla posizione nella timeline del player, con l'offset noto (0 al primo avvio).
- **Test:** la formula si verifica in unit test con i dati di `INIT_PTS_FOUND` registrati da stream veri, e nell'e2e con un seek lontano che riavvia la pipeline: `positionMs` deve coincidere con il PTS originale del frame, e il cue PGS deve comparire al suo tempo (regressione del §7.8.1).
- **Avvio:** `StartPlayback` può rispondere `503 STREAM_PREPARING` con `Retry-After`. Il player mostra "in preparazione" e ripete la richiesta dopo `Retry-After` (2 s se manca), finché l'utente non annulla o per al più 60 s; poi mostra un errore con "Riprova".
- **Heartbeat:** `reportProgress` ogni `heartbeatIntervalMs` (10 s se manca), anche in pausa.
  - Lo stato è `playing`, `paused` o `buffering` (dagli eventi `waiting`/`playing`); `clientTs = Date.now()`.
  - A `seeked` e a `pause` parte un report subito.
  - La risposta è un 204 senza corpo: lo stato delle tracce dei sottotitoli arriva da `playback.subtitle_ready` (§7.8.6).
- **Fine della sessione:** `stopPlayback` quando si esce dal player. Su `pagehide` si usa `fetch` con `keepalive: true`, perché `sendBeacon` non può mandare l'header `Authorization`.
- **Concorrenza:** `SESSION_LIMIT_REACHED` apre un dialogo con le sessioni attive e "Interrompi l'altra" (`terminateSession`, poi di nuovo `StartPlayback`). `SESSION_EXPIRED` propone di ripartire dall'ultima posizione salvata.

### 7.9 Stile, i18n, stato, accessibilità e test

- **Routing: TanStack Router 1.170.46**, con le route dichiarate nel codice (nessun plugin né generazione di file).
  - I parametri di ricerca di catalogo e ricerca (filtri, ordinamento, testo) stanno nell'URL e si validano con **zod 4.6.7**, già usato dal backend (Standard Schema). Un link o un "indietro" riportano la stessa vista.
  - Rispetto a React Router 8.5.1 (§7.4: circa 3 KB gzip in più per React Router) dà parametri tipizzati, e la sua API 1.x è ferma.
- **Stato:**
  - lo stato del server è in TanStack Query;
  - il profilo è in un context React;
  - il player è nel `PlayerController` (§7.8);
  - lo stato della vista è nell'URL.
  - Nessuna libreria di store globale.
- **Stile:**
  - CSS Modules, già in Vite, più un file di token con le custom property CSS (colori, spaziature, tipografia) e tema scuro;
  - font di sistema: nessun font da CDN, perché la LAN deve funzionare offline;
  - icone SVG inline;
  - niente Tailwind né CSS-in-JS: dipendenze e runtime in più, senza un bisogno.
- **i18n, italiano per primo:**
  - un catalogo tipizzato `src/i18n/it.ts` (oggetto `as const`) con una funzione `t(chiave, parametri)` di poche righe, e una chiave mancante è un errore di compilazione;
  - date, numeri e durate con `Intl` in `it-IT` ("1 h 47 min", "aggiunto 3 giorni fa");
  - nessuna libreria finché esiste una sola lingua. Alla seconda lingua si valuta una libreria (per esempio i18next o Lingui), e le chiavi sono già centralizzate.
- **Accessibilità e tastiera:**
  - elementi nativi (`button`, `a`, `dialog`, `select`), focus visibile e ordine di tabulazione corretto;
  - frecce dentro le righe della Home (roving tabindex, un hook di poche righe);
  - scorciatoie del player: spazio, ←/→ 10 s, F, M, C.
  - **Lint:** `eslint-plugin-jsx-a11y` 6.10.2 non dichiara ESLint 10 fra i peer, quindi non si adotta. Si adotta il suo fork **`eslint-plugin-jsx-a11y-x` 0.2.0** (MIT, es-tooling, 2026-05-10, peer `eslint ^9 || ^10`). È un fork giovane: se smette di seguire ESLint, si toglie, e resta la rete del punto seguente.
  - **Seconda rete:** **`@axe-core/playwright` 4.14.0** (MPL-2.0, solo sviluppo, usato senza modifiche) controlla con axe le pagine principali nell'e2e di milestone. Le query per ruolo di Testing Library coprono solo i componenti con un test, quindi non bastano da sole.
  - Se i menu delle tracce diventano complessi, React Aria Components 1.22.1 (Apache-2.0) è la riserva.
  - **D-pad:** non è un requisito, perché la TV avrà un'app nativa. Se servisse un browser TV, Norigin Spatial Navigation 3.4.0 (MIT) si aggiunge sopra lo stesso focus nativo.
- **Test:**
  - **Unit (Vitest 5.1.0, jsdom 31.0.0):** il player senza DOM reale, cioè tabella delle capability per browser, scomposizione del `mimeType`, regola dei buffer con gli esempi del §7.8.4, tabella dei fallimenti con il limite di 3 tentativi, sostituzione del motore (errori ignorati), calcolo della timeline da `INIT_PTS_FOUND`, regola di ricarica dei sottotitoli, `EventPoller` con timer finti e `410`, middleware del token. Poi i componenti con Testing Library 16.3.3 (`@testing-library/dom` 10.4.2, `user-event` 14.6.8): scelta del profilo, righe della Home, menu delle tracce, coda "Da verificare".
  - **End-to-end (Playwright 1.64.1, Apache-2.0)**, giustificato perché MSE, hls.js e libpgs si provano solo in un browser vero e il punto 7 della Definition of done di doc 06 chiede un test che riproduca un file.
    - Gira sullo stack Compose con i browser installati (`channel: 'msedge'` e `'chrome'`), come S2, per avere i decoder di piattaforma (HEVC, AC-3 in Edge).
    - Scenari: scelta del profilo → Home → dettaglio → play → primo frame → seek → progress salvato → resume; un Direct Stream HLS; un seek lontano con riavvio della pipeline (timeline e PGS); un PGS reso (s3); un fallimento forzato (`forceMode`) con ripianificazione; il controllo axe.
    - Non entra in `verify`: occupa il browser, che è una risorsa condivisa, e gira come gate di milestone (F2), in sequenza con altre attività che usano il browser.
    - Firefox resta una verifica manuale: la build di Firefox di Playwright non è il Firefox installato.

### 7.10 Dipendenze

Versioni verificate sul registry npm il 2026-11-05; tutte fissate alla versione esatta, come nel backend.

| Pacchetto | Versione | Licenza | Uso | Tipo |
|---|---|---|---|---|
| react, react-dom | 19.3.1 | MIT | UI | runtime |
| @tanstack/react-router | 1.170.46 | MIT | routing | runtime |
| @tanstack/react-query | 5.106.1 | MIT | cache dei dati del server | runtime |
| openapi-fetch | 0.17.0 | MIT | client del control plane (ADR 0004) | runtime |
| zod | 4.6.7 | MIT | validazione dei parametri di ricerca | runtime |
| hls.js | 1.7.4 | Apache-2.0 | HLS fMP4 via MSE, build light: `import Hls from 'hls.js/light'`, worker da `hls.js/dist/hls.worker.js?url` | runtime (chunk del player) |
| libpgs | 0.9.0 | MIT (include core-js e whatwg-fetch, MIT) | render dei PGS | runtime (chunk del player) |
| vite | 8.3.6 | MIT | build e dev server | sviluppo |
| @vitejs/plugin-react | 6.2.1 | MIT | JSX/Fast Refresh | sviluppo |
| openapi-typescript | 7.13.0 | MIT | tipi dal contratto (già nel backend) | sviluppo |
| @types/react, @types/react-dom | 19.3.0 | MIT | tipi | sviluppo |
| eslint-plugin-react-hooks | 7.1.1 | MIT | regole degli hook (ESLint 10) | sviluppo |
| eslint-plugin-jsx-a11y-x | 0.2.0 | MIT | lint di accessibilità (ESLint 10) | sviluppo |
| vitest | 5.1.0 | MIT | test (già nel backend) | sviluppo |
| jsdom | 31.0.0 | MIT | DOM per i test | sviluppo |
| @testing-library/react / dom / user-event | 16.3.3 / 10.4.2 / 14.6.8 | MIT | test dei componenti | sviluppo |
| @playwright/test | 1.64.1 | Apache-2.0 | end-to-end | sviluppo |
| @axe-core/playwright | 4.14.0 | MPL-2.0 | controllo di accessibilità nell'e2e, senza modifiche | sviluppo |

TypeScript 6.0.3, ESLint 10.14.0, typescript-eslint 8.72.1 e dependency-cruiser 18.7.2 sono già nel workspace. Nessuna dipendenza ha script di install.

### 7.11 Ipotesi e dipendenze sull'ADR 0003

Il web client regge le varianti indicate. Le ipotesi in grassetto sono già decise dall'orchestratore dopo le due revisioni.

| # | Ipotesi | Se l'ADR 0003 decide diversamente |
|---|---|---|
| H-A | Direct Stream = HLS con segmenti fMP4 (`protocol: hls-fmp4`), playlist VOD completa (`#EXT-X-ENDLIST`) | Una playlist EVENT che cresce funziona con hls.js, ma la barra di avanzamento va limitata alla durata da `durationMs` |
| H-B | **Timeline:** il contratto porta `stream.mediaTimestampOffsetMs` (10000 per `hls-fmp4`) e il player ricava `timelineOffsetMs` da `INIT_PTS_FOUND` (§7.8.7). Sostituisce l'ipotesi `-copyts` della prima stesura: con fMP4 hls.js mappa i frammenti sulla timeline della playlist, e il `currentTime` differisce dal PTS originale di uno scarto δ che dipende da codec e posizione | — |
| H-C | Il seek oltre la parte già generata è trasparente: il client chiede il segmento e il server riavvia la pipeline (doc 04 §6.2) | Se serve una nuova sessione per i seek lontani, il client usa `ChangeTracks` con `positionMs`: il contratto ha già il campo |
| H-D | **Audio muxato** nei segmenti video, una sola rendition: build light di hls.js, cambio audio sempre con `ChangeTracks` (§7.8.6) | Con rendition separate (`EXT-X-MEDIA`) servono la build completa e `hls.audioTrack` |
| H-E | **`stream.bitrate { peakBps, averageBps, audioBps }`** nella sessione; `BANDWIDTH` del master playlist = picco della variante (RFC 8216 §4.3.4.2), usato solo se il campo manca | — |
| H-F | **Sottotitoli:** il `.sup` o il WebVTT si servono come una sola risposta che cresce finché l'estrazione finisce; `availability: growing`/`complete` sulla traccia; `switchWithoutRestart` riguarda solo lo stream (§7.8.6) | Un `.sup` a segmenti richiederebbe `loadFromBuffer` e un caricatore nostro |
| H-G | **Codici HTTP:** una risorsa elencata nella playlist non risponde mai 404 finché la sessione è viva; 401, 403, 404 o 410 sul data plane vogliono dire sessione chiusa; un 5xx fatale porta a `reportPlaybackFailure` con `unknown`; `StartPlayback` può rispondere `503 STREAM_PREPARING` con `Retry-After`. hls.js non legge `Retry-After` | — |
| H-H | **Durata dei segmenti:** `EXT-X-TARGETDURATION` limitata, con un taglio ai keyframe interni sopra 6 s o 32 MiB; entra nella regola dei buffer (§7.8.4) | Segmenti più lunghi alzano il minimo della regola e il rischio di `bufferFullError` |
| H-I | `stream.mimeType` per `hls-fmp4` è il MIME dei segmenti, `video/mp4; codecs="<video>, <audio>"`, con entrambi i codec (§7.8.3) | Senza i due codec la verifica prima dell'avvio non ha senso |
| H-J | I locatori dei sottotitoli restano sulla timeline originale anche dopo un riavvio della pipeline (lo stesso `-output_ts_offset` non si applica ai cue, oppure si compensa nel server) | Se i cue fossero spostati dell'offset, il client dovrebbe sottrarre anche `mediaTimestampOffsetMs`: va detto nel contratto |

### 7.12 Richieste sul contratto (congelato; nessuna blocca F1c)

Le prime tre le sta applicando l'autore dell'ADR 0003, su decisione dell'orchestratore.

1. **`stream.mediaTimestampOffsetMs`** (intero, facoltativo, additivo): l'offset costante dei PTS (10000 per `hls-fmp4`). Sostituisce la richiesta di `stream.timelineOffsetMs` della prima stesura, che si ritira.
2. **`stream.bitrate { peakBps, averageBps, audioBps }`** (oggetto facoltativo, additivo, bit/s): rende la regola dei buffer indipendente da `BANDWIDTH` e dalla stima per codec, anche per il limite audio di 12 MiB (§7.8.4).
3. **`SessionTrack.availability`** ∈ {`complete`, `growing`} per i sottotitoli serviti a parte, con `switchWithoutRestart` riferito solo allo stream, nelle tracce della sessione (`StartPlayback`, `ChangeTracks`), più l'evento `playback.subtitle_ready` `{sessionId, trackId, availability}` su `listEvents` per il passaggio a `complete` (§7.8.6).
4. **Errore del preflight:** il valore `MIME_TYPE_UNSUPPORTED` in `FallbackRequest.error` è una stringa libera, quindi va bene così. Basta citarlo nella descrizione del campo.
5. **`503 STREAM_PREPARING`** per `startPlayback`, con `Retry-After`, nel contratto (§7.8.7).
6. **Fuori dal contratto:** nel Caddyfile `encode zstd gzip` nel blocco della SPA (§7.6). La cache di `index.html` è già a posto.

### 7.13 Dipendenze con altre aree

- **ADR 0001:** TypeScript 6.0.3, workspace npm, Vitest 5.1.0, ESLint 10, dependency-cruiser, `npm run verify`. Deroga sul `tsconfig` (`types`, `lib`, `moduleResolution`) per il browser (§7.6).
- **ADR 0004:** openapi-typescript 7.13.0 e openapi-fetch 0.17.0 dal bundle versionato; `profileToken` come Bearer; cursori e `410 CURSOR_EXPIRED`; enum aperti.
- **ADR 0006:** build in `clients/web/dist`, copiata nell'immagine `gateway` (multi-stage, solo il workspace del web) o montata in sviluppo; dev server sull'host con proxy verso il gateway; compressione degli asset da aggiungere.
- **ADR 0003:** ipotesi H-A…H-J (§7.11), regola dei buffer, estrazione e disponibilità dei sottotitoli, codici HTTP, offset dei timestamp.
- **Decision Engine (F1b):** vocabolario delle capability (I6), `maxFrameRate`, `limits.maxBitrate` assente = nessun limite, ripianificazione per dimensione (doc 04 §8), scelta della dimensione per un `unknown` dopo un 5xx. La tabella del §7.8.2 è l'input dei casi di test del Decision Engine per il browser.
- **Client TV (ADR 0008, Accepted, §8):** nessun codice di UI condiviso. Si condividono il contratto, il vocabolario e il protocollo di ripianificazione.

### 7.14 Raccomandazione

- **Scelta: React 19.3.1 con Vite 8.3.6**, TanStack Router 1.170.46 e TanStack Query 5.106.1, openapi-fetch 0.17.0 sui tipi di openapi-typescript 7.13.0.
  - Il player è un modulo TypeScript senza framework, con **hls.js 1.7.4 light** per l'HLS, `<video>` nativo per il progressivo e **libpgs 0.9.0** nella configurazione di S2 (`video` più `requestVideoFrameCallback`) per i PGS.
  - Stile con CSS Modules, i18n con un catalogo tipizzato e `Intl`, test con Vitest e Playwright (con axe).
- **Criteri decisivi:**
  - W1: qualità del codice scritto dall'AI e revisione del proprietario;
  - W3: router e cache dei dati tipizzati e maturi;
  - W5: TSX controllati da `tsc` nella stessa `verify`.
  - Il peso del bundle, l'unico punto misurato a sfavore, è dominato dal player e conta poco in LAN (§7.4).
- **Runner-up: Svelte 5.57.3.** Diventerebbe la scelta se il web client dovesse girare su dispositivi deboli (un browser TV, un tablet vecchio), dove il peso e il costo dei re-render contano. Il motore del player, senza framework, si porterebbe così com'è.

### 7.15 Domande aperte, rischi e verifiche di F1c

- **Da verificare in F1c** (prima del merge di F1c, con il turno sul browser):
  - **WebVTT che cresce con `<track>`:** se il browser non aggiunge i cue mentre la risposta cresce, si passa al ripiego `fetch` più `VTTCue` (§7.8.6);
  - **worker ESM di hls.js light** con `workerPath`: che parta, altrimenti `enableWorker: false` (§7.8.1);
  - **`timelineOffsetMs` da `INIT_PTS_FOUND`:** su un Direct Stream da 0 e dopo un seek lontano con riavvio, `positionMs` uguale al PTS originale e PGS al suo tempo (§7.8.7);
  - **PGS che cresce:** i cue compaiono mentre l'estrazione è in corso, e la ricarica a `complete` non lascia buchi (§7.8.6).
- **libpgs è un progetto piccolo.**
  - Al 2026-11-05 la pagina GitHub mostra un solo autore, 14 stelle e nessuna release; sul registry fra la 0.8.1 (2024-11-07) e la 0.9.0 (2026-08-27) passano 22 mesi.
  - Porta dentro di sé dei polyfill, e i suoi tipi dichiarano due import a solo effetto: bastano due `declare module` locali (§7.4, §7.6).
  - È MIT e pesa circa 70 KB: se smette di essere mantenuta, si copia nel repo (vendoring) con la licenza. Le alternative non sono state valutate (S2).
- **hls.js 1.7.4 non è la versione misurata:** il test di regressione del §7.8.1, con s3 e il seek con riavvio, lo copre.
- **Buffer:** i valori del §7.8.4 non sono provati su un film intero, né con FLAC multicanale reale; il limite di Firefox non è noto. Con il tetto di 32 MiB per segmento il caso peggiore calcolato, 128 Mbps con segmenti da 6 s, arriva a circa 124 MiB in avanti, sotto i 150 MiB (§7.8.4). Lo supererebbe solo un picco sopra circa 165 Mbps con segmenti da 6 s, oltre il massimo dell'UHD Blu-ray (giudizio), oppure il buffer indietro da 2 s sommato al caso peggiore, che Chromium dovrebbe liberare per primo quando serve spazio (giudizio, non misurato). Da misurare in F2.
- **Audio che sparisce:** il controllo usa proprietà non standard. Se un browser le toglie, il Direct Play di un MKV con audio non decodificabile torna muto in silenzio: la regola del doc 04 §4.1 (una sola traccia, codec provato) resta la difesa principale.
- **Windows 10 o 11 in Firefox:** non si distingue. Un override (I2) per sistema in Firefox oggi non è possibile.
- **Accessibilità:** `eslint-plugin-jsx-a11y-x` è un fork giovane (0.2.0); axe nell'e2e copre il caso in cui venga tolto.
- **Limite dei tentativi:** il doc 04 §8 non fissa un numero; il web client usa 3. Il valore andrebbe scritto nel doc 04, perché valga anche per la TV.
- **Fonti** (consultate il 2026-11-05):
  - registry npm per tutte le versioni e le date;
  - [hls.js v1.7.4](https://github.com/video-dev/hls.js/releases/tag/v1.7.4) e il pacchetto `hls.js@1.7.4` (`package.json` exports, `dist/hls.d.ts`: `InitPTSFoundData`, `ErrorData.sourceBufferName`, `workerPath`);
  - [libpgs-js](https://github.com/Arcus92/libpgs-js) e il pacchetto `libpgs@0.9.0` (`src/pgsRenderer.ts`, `src/pgs.ts`, `src/worker.ts`, `dist/pgsRendererOptions.d.ts`);
  - [changelog React 19.3.0](https://www.gitclear.com/open_repos/facebook/react/release/v19.3.0);
  - [This Month in Solid](https://dev.to/danieljcafonso/this-month-in-solid-v200-beta-is-over-and-start-v2-on-the-horizon-26jo);
  - [OpenReplay su Vue Vapor](https://blog.openreplay.com/vue-vapor-mode/);
  - [Chromium audio/video](https://chromium.org/audio-video) (codec proprietari solo in Chrome);
  - [S2](../spikes/S2-browser-playback.md), `spikes/w1-web-bundle/`.

---

## 8. Client TV

- **Area:** stack dell'app per Android TV e Google TV, client API in Kotlin, capability e audio sulla TV del soggiorno
- **ADR:** [0008 — Client TV: app Android nativa in Kotlin con Compose for TV e Media3](../adr/0008-client-tv-kotlin-compose-media3.md) (**Accepted**)
- **Data:** 2026-11-07 (rivista lo stesso giorno dopo la revisione di design)
- **Aree collegate:** [contratto API](#3-formato-del-contratto-api-e-codegen) (ADR 0004), [deploy](#4-deploy-e-gateway) (ADR 0006), [streaming](#6-protocollo-di-streaming-e-stream-delivery) (ADR 0003), [web client](#7-web-client) (ADR 0005), Decision Engine (F1b)
- **Fonti interne:**
  - requisiti §5–§9, §14–§16, §18, §20; doc 03 P1, P2, P8, P9, §4.1, §7, I2, I3, I6; doc 04 §4–§8, H5, H11, P1, P5;
  - [S5 — Client TV sulla TV del proprietario](../spikes/S5-tv-client.md), con gli artefatti in [`docs/spikes/S5-tv-client/`](../spikes/S5-tv-client/);
  - [K1 — Client Kotlin generato dal contratto](../spikes/K1-kotlin-codegen.md).

### 8.1 Decisioni da prendere

Il client TV viene dopo l'MVP web. Il proprietario lo vuole presto, e questa area è il cancello prima di qualsiasi codice di prodotto per la TV (CLAUDE.md). Le decisioni sono:
1. lo **stack dell'app**: linguaggio, UI e player;
2. il **client API** in Kotlin: generatore, libreria HTTP e serializzazione, verificati sul bundle (rinvio dell'ADR 0004 punto 7 e del §3);
3. la **mappatura delle capability** sul contratto (doc 03 §4.1, I6);
4. l'**audio** sulla TV di oggi, come conseguenza delle prime tre;
5. i punti lasciati aperti dalle altre aree: HTTP in chiaro in LAN (§4.10), polling o SSE per la TV (§3), versioni e toolchain.

**Tre fatti del proprietario (2026-11-07)**, che il resto dell'area dà per acquisiti:
1. **Niente AVR né soundbar.** L'audio esce dagli altoparlanti Harman Kardon del TV, sull'uscita Speaker, non su HDMI ARC.
   - Il passthrough lossless (TrueHD, DTS-HD) non è in gioco su questo impianto. Non è un requisito perso: con un impianto futuro il client lo dichiarerebbe da sé (§8.9.3).
   - Il box esterno non serve per l'audio. Resta una strada futura facoltativa, per esempio per il DV profilo 7, senza un acquisto consigliato.
2. **La libreria sarà fatta soprattutto di ricodifiche x265, non di remux completi.** Il sample tipico, misurato in S5, è "2001: Odissea nello spazio":
   - 4K HEVC Main10 HDR10, 21,8 GB, 19,6 Mb/s medi, senza Dolby Vision;
   - audio AC-3 5.1 in italiano e AAC 5.1 in inglese;
   - sottotitoli PGS in italiano e SRT in inglese.

   Il percorso comune è quindi AC-3, E-AC-3 e AAC con PGS e SRT incorporati, e TrueHD, DTS-HD e DV P7 diventano casi limite. I remux restano supportati, perché i requisiti li ammettono.
3. **La TV resta sul Wi-Fi a 2,4 GHz** (link a 144 Mb/s): per ora niente cavo né 5 GHz.

### 8.2 Il dispositivo

Fatti misurati in S5 (sonda con Media3 1.11.1, dump via ADB, 2026-11-07); dettagli e file nel [report](../spikes/S5-tv-client.md).

| Aspetto | Fatto |
|---|---|
| Piattaforma | Google TV su Android TV 11 (API 30). Modello commerciale H65C95EUX; `Build.MODEL` riporta «Haier OLED TV AE» |
| SoC e ABI | MediaTek MT5889; `ro.product.cpu.abilist` = `armeabi-v7a,armeabi`: **userspace a 32 bit** |
| Memoria | 2,95 GB totali, circa 1,06 GB disponibili; `memoryClass` 192 MB, `largeMemoryClass` 512 MB |
| Display | All'app sono esposti solo 1920×1080 a 60 e a 50 Hz, **nessun modo a 24 Hz**; piano video 3840×2160.<br>HDR: Dolby Vision, HDR10, HLG, HDR10+; 500 nit |
| Video | - HEVC Main10 (HDR10, HDR10+) fino a livello 5.1 High, 4096×2176, 3840×2160 fino a 64,5 fps;<br>- AV1, VP9 profili 0 e 2;<br>- AVC fino a 1080p a 120 fps, ma in 4K solo fino a 30 fps;<br>- tutti in hardware, con tunneling |
| Dolby Vision | Decoder hardware P4, P5, P8, P9 e P10; **nessun P7** (DVHE.DTB), nemmeno nel decoder generico |
| Decoder audio | AC-3 ed E-AC-3 in hardware (6 canali); AAC, FLAC, Opus e PCM in software (8 canali).<br>**Nessun decoder DTS né TrueHD visibile alle app:** il decoder DTS che `media_codecs.xml` dichiara non compare in `MediaCodecList(ALL_CODECS)` |
| Uscita audio | Un solo dispositivo, `BUILTIN_SPEAKER` (altoparlanti Harman Kardon): PCM 16 bit stereo, AC-3, E-AC-3, E-AC-3 JOC.<br>`AudioCapabilities` di Media3 e `AudioTrack.isDirectPlaybackSupported` accettano in bitstream AC-3, E-AC-3, E-AC-3 JOC e AC-4, a 2, 6 e 8 canali; DTS, DTS-HD e TrueHD no |
| Estensione FFmpeg (opzione futura) | L'AAR Jellyfin `media3-ffmpeg-decoder` 1.9.0+1 (licenza GPL-3.0), compilato per Media3 1.9.0, si carica con la 1.11.1 e dichiara TrueHD, DTS e DTS-HD |
| Rete | Wi-Fi a 2,4 GHz, link a 144 Mb/s |

Cosa ne segue, prima ancora di scegliere lo stack:
- l'app deve compilare per `armeabi-v7a`, e ogni libreria nativa deve avere quella ABI;
- il buffer predefinito di Media3 (circa 125 MiB nello heap Java, §8.10) non sta in 192 MB insieme alla UI;
- su questa uscita "passthrough" vuol dire bitstream verso il decoder Dolby del TV, non verso un ricevitore.

### 8.3 Criteri

| # | Criterio | Fonte | Peso | Vincolo rigido? |
|---|---|---|---|---|
| T1 | **Direct Play di MKV sulla TV** con i decoder hardware: HEVC Main10 4K HDR10 delle ricodifiche (il caso comune), e per i remux anche HDR10+, DV P5 e P8 | §5.1, §7 "TV", §18 | 5 | sì (MKV nativo) |
| T2 | **Controllo di audio e capability:** leggere `MediaCodecList`, `AudioCapabilities` e l'HDR del display, e dichiarare solo capability reali | §5, §6, doc 03 I6, doc 04 §5 | 5 | sì (capability reali, non presunte) |
| T3 | **Sottotitoli:** PGS e SRT incorporati (entrambi nel caso comune), `.sup` e WebVTT esterni | §6, doc 04 §4.4, P3 | 5 | no |
| T4 | **Qualità e manutenibilità con sviluppo AI:** un linguaggio, API stabili, errori presi dal compilatore, revisione del proprietario | CLAUDE.md, §18 "Qualità" | 5 | no |
| T5 | **UX con il D-pad:** focus, righe, griglie | §7 "TV", §16 | 4 | no |
| T6 | **Memoria e fluidità** sulla TV: 32 bit, heap di 192 MB | §18, §8.2 | 4 | no |
| T7 | **Manutenzione e licenza** | §18 "Evolvibilità" | 4 | sì (progetto mantenuto, licenza compatibile con l'uso privato) |
| T8 | **Testabilità e toolchain** su Windows | CLAUDE.md "Environment" | 3 | no |
| T9 | **Riuso per il mobile** | §7 "mobile" (condivisione facoltativa) | 2 | no |
| — | **Sideload via ADB** e stesso APK su un box esterno | proprietario | — | sì (passa/non passa) |

- La familiarità del proprietario (forte in TypeScript e Python, non in Kotlin) conta solo dentro T4, come capacità di rivedere il codice: lo sviluppo è guidato dall'AI.
- T3 pesa quanto T1 perché nel caso comune ogni film ha PGS in italiano e SRT in inglese.
- T9 pesa poco perché il §7 rende facoltativa la condivisione di codice fra i client.

### 8.4 Opzioni (stato al 2026-11-07)

#### A. Kotlin, Jetpack Compose con Compose for TV, Media3
- **Media3 1.11.1** (Apache-2.0, 2026-09-10; la 1.12.0-alpha02 è del 2026-10-26).
  - Il `MatroskaExtractor` riconosce `dvcC`/`dvvC` (MIME Dolby Vision), `S_HDMV/PGS`, `S_TEXT/UTF8`, `A_TRUEHD` e `A_DTS`.
  - `AudioCapabilities` dice cosa passa in bitstream; ci sono `OkHttpDataSource` e `media3-ui-compose` con `PlayerSurface`.
  - La 1.11 aggiunge gli slot del `Player` Material3 e il supporto di `FocusRequester` per il D-pad ([novità di Media3 1.11](https://android-developers.googleblog.com/2026/08/media3-1-11-whats-new.html), 2026-08-11).
- **Compose for TV:** `androidx.tv:tv-material` 1.1.0 e `tv-foundation` 1.0.0 (2026-05-06), su Compose ui e foundation 1.12.1 (2026-11-04). Le lazy list TV sono state deprecate in tv-foundation 1.0.0-alpha11 e tolte in alpha12: si usano quelle di Compose foundation.
- **Pro:** il player di riferimento su Android, nello stesso linguaggio dell'app; la sonda di S5 è già scritta così; è la UI che Google raccomanda per la TV.
- **Contro:** lo scorrimento di Compose su un SoC a 32 bit non è misurato; le righe in stile Leanback si scrivono a mano.

#### B. Kotlin, Leanback, Media3
- La [pagina di rilascio di Leanback](https://developer.android.com/jetpack/androidx/releases/leanback) la dichiara deprecata e rimanda alla [migrazione a Compose for TV](https://developer.android.com/training/tv/playback/leanback/migrate-to-compose), anche se esce ancora qualche alpha (1.3.0-alpha02, giugno 2026).
- **Pro:** `BrowseSupportFragment`, righe con Presenter e focus pronti e provati su dispositivi deboli.
- **Contro:** API deprecata, con View e Fragment; il codice generato tende a pattern vecchi; la UI non si riusa sul mobile.

#### C. React Native for TV
- `react-native-tvos` (fork della community per Android TV e tvOS; ultimo commit visto intorno al 2026-05-29) con `react-native-video` 7, che su Android usa Media3.
- **Pro:** TypeScript; riuso con il mobile, iOS compreso.
- **Contro:**
  - capability (`MediaCodecList`, `AudioCapabilities`), scelta dei renderer e sottotitoli esterni non sono esposti: servono moduli nativi in Kotlin, cioè il costo di A più un ponte;
  - runtime JavaScript nello stesso heap di 192 MB.

#### D. Flutter
- Nessun target TV ufficiale; il focus del D-pad passa da pacchetti della community come `dpad` 3.1.0 (2026-10-07).
- `video_player` su Android usa ExoPlayer, ma non espone tracce, capability né bitstream: il player va scritto in Kotlin dietro un platform channel, con Dart in più.

#### E. WebView o TWA che incapsula il web client
- **Non passa T1.** Una WebView si comporta come il browser del §7: niente MKV né PGS nativi, nessun controllo dell'uscita audio, e tutto andrebbe in Direct Stream o in Transcode (§5.1).
- Una TWA richiede Chrome, che Google TV non installa di serie (giudizio).

### 8.5 Valutazione

Punteggi 1–5. **E** = evidenza (§8.2, S5, codice di Media3, documentazione, K1); **G** = giudizio.

| Criterio (peso) | A. Compose for TV + Media3 | B. Leanback + Media3 | C. React Native TV | D. Flutter |
|---|---|---|---|---|
| T1 Direct Play MKV (5) | 5 **E**: Media3 con i decoder hardware della TV (S5) | 5 **E**: stesso player | 4 G: Media3 dietro react-native-video; i renderer si configurano da un modulo nativo | 3 G: `video_player` non controlla tracce né renderer; serve comunque un player nativo |
| T2 Audio e capability (5) | 5 **E**: la sonda di S5 le produce già in Kotlin | 5 **E** | 2 G: tutto da un modulo nativo | 2 G: platform channel |
| T3 Sottotitoli (5) | 4 **E**: PGS e SRT incorporati con Media3 (S5 per i PGS); `.sup` esterno da verificare | 4 **E** | 3 G | 2 G |
| T4 Qualità con sviluppo AI (5) | 5 G: un linguaggio, l'API raccomandata, Compose molto documentato | 3 G: API deprecata, View e Fragment | 3 G: due linguaggi e un ponte | 3 G: Dart più Kotlin |
| T5 D-pad (4) | 4 **E**: focus di Compose e tv-material 1.1.0; le righe si scrivono | 5 **E**: righe e focus pronti | 3 G: motore di focus del fork | 3 G: focus di Flutter più `dpad` |
| T6 Memoria e fluidità (4) | 3 G: Compose su 32 bit, non misurato | 4 G: RecyclerView, provato su dispositivi deboli | 2 G: un runtime JS in più | 3 G: un motore in più |
| T7 Manutenzione e licenza (4) | 5 **E**: Apache-2.0, tutto stabile e attivo | 2 **E**: deprecata | 3 **E**: fork della community | 3 **E**: la TV non è un target ufficiale |
| T8 Testabilità e toolchain (3) | 4 **E**: S5 compila con AGP 9.5.1 sul portatile; test sulla JVM con Robolectric | 4 **E** | 3 G: Metro, npm e Gradle insieme | 4 G |
| T9 Riuso per il mobile (2) | 4 G: Compose e `:player` su Android; iOS no | 2 G | 5 G: anche iOS | 5 G: anche iOS |
| **Totale pesato (/5)** | **4,41** | 3,92 | 3,00 | 2,92 |

Tutte le opzioni passano il vincolo del sideload. C e D passano T1 e T2 solo con moduli nativi in Kotlin, cioè con una parte del costo di A. E non passa T1.

**Lettura del risultato.**
- **A e B condividono il player:** sulla riproduzione, la parte che conta di più, non c'è differenza.
- **B vince solo su T5 e T6;** A vince su T4, T7 e T9.
  - T7 vincola: una UI nuova non si costruisce su un'API deprecata.
  - T6 è l'unico rischio vero di A, da misurare nella prima slice TV (§8.13, domanda 7). Se Compose non regge, la riserva è circoscritta: Leanback solo per le schermate di navigazione, con lo stesso modulo del player.
- **C e D non tolgono lavoro nativo, ne aggiungono:** il valore del client TV sta nel player e nelle capability, che restano in Kotlin.

### 8.6 Piattaforma, versioni e toolchain

Versioni lette il 2026-11-07.

| Componente | Versione | Data | Fonte | Note |
|---|---|---|---|---|
| Kotlin | 2.4.21 | 2026-10-08 | [kotlinlang.org](https://kotlinlang.org/docs/releases.html) | la 2.4.0 è del 2026-06-03 |
| Android Gradle Plugin | 9.5.1 | patch della 9.5.0 (ottobre 2026) | [Google Maven](https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml), [note della 9.5](https://developer.android.com/build/releases/agp-9-5-0-release-notes) | Gradle 9.6.0 o più, JDK 17 o più, API fino a 37; Kotlin integrato da AGP 9.0; la 9.6 è ancora alpha |
| Gradle | 9.8.2 | 2026-10-19 | [gradle.org](https://gradle.org/releases/) | |
| JDK | 21 | — | Microsoft OpenJDK 21.0.13 sul portatile | per eseguire Gradle; bytecode 17 |
| Android SDK | compileSdk 37, targetSdk 36, minSdk 30 | — | piattaforme `android-36` e `android-37.0` già installate sul portatile; build-tools 37.0.0 | S5 compila con 36; in F3a OkHttp 5.5.1 (`okhttp-android`) chiede compileSdk 37 per compilare. Il compileSdk non cambia il comportamento a runtime: quello lo decide il targetSdk, che resta 36 (sotto) |
| Media3 | 1.11.1 | 2026-09-10 | [note di rilascio](https://developer.android.com/jetpack/androidx/releases/media3) | `exoplayer`, `exoplayer-hls`, `datasource-okhttp`, `ui-compose`, `ui` (solo per `SubtitleView`) |
| Compose | ui e foundation 1.12.1 | 2026-11-04 | [note di rilascio](https://developer.android.com/jetpack/androidx/releases/compose) | la [BOM](https://dl.google.com/dl/android/maven2/androidx/compose/compose-bom/maven-metadata.xml) più recente è la 2026.09.00, quindi versioni fissate a mano |
| Compose for TV | tv-material 1.1.0, tv-foundation 1.0.0 | 2026-05-06 | [note di rilascio](https://developer.android.com/jetpack/androidx/releases/tv) | |
| Navigation3 | 1.2.1 | 2026-11-04 | [note di rilascio](https://developer.android.com/jetpack/androidx/releases/navigation3) | |
| Coil | 3.6.3 | 2026-09-18 | [Maven Central](https://repo1.maven.org/maven2/io/coil-kt/coil3/coil-compose/maven-metadata.xml) | `coil-compose`, `coil-network-okhttp` |
| Retrofit | 3.0.0 | 2025-05-15 | [Maven Central](https://repo1.maven.org/maven2/com/squareup/retrofit2/retrofit/maven-metadata.xml) | con `converter-kotlinx-serialization` 3.0.0 |
| OkHttp | 5.5.1 | 2026-10-22 | [Maven Central](https://repo1.maven.org/maven2/com/squareup/okhttp3/okhttp/maven-metadata.xml) | anche `mockwebserver3` per i test |
| kotlinx-serialization-json | 1.12.0 | 2026-10-19 | [Maven Central](https://repo1.maven.org/maven2/org/jetbrains/kotlinx/kotlinx-serialization-json/maven-metadata.xml) | |
| kotlinx-coroutines | 1.11.0 | — | [Maven Central](https://repo1.maven.org/maven2/org/jetbrains/kotlinx/kotlinx-coroutines-core/maven-metadata.xml) | |
| OpenAPI Generator | 7.27.0 | 2026-11-02 | [release](https://github.com/OpenAPITools/openapi-generator/releases), [Gradle Plugin Portal](https://plugins.gradle.org/m2/org/openapi/generator/org.openapi.generator.gradle.plugin/maven-metadata.xml) | plugin Gradle o immagine Docker (ADR 0004), stessa versione |
| Robolectric | 4.17 | — | [Maven Central](https://repo1.maven.org/maven2/org/robolectric/robolectric/maven-metadata.xml) | SDK dei test fissato a 30 |
| Validatore JSON Schema (solo test di `:api`) | `io.github.optimumcode:json-schema-validator-jvm` 0.5.5 | — | Maven Central | scelto in F3a (§8.8 lo lasciava alla prima slice): JSON Schema 2020-12 come OpenAPI 3.1, scritto su kotlinx-serialization già nel progetto, niente Jackson né org.json; solo `testImplementation` |

- **minSdk 30:** è la TV. Anche l'Nvidia Shield, il box più vecchio che avrebbe senso, ha Android 11. Con 30 non ci sono rami di codice per API che non si possono provare.
- **targetSdk 36, non 37:** con targetSdk 37 Android 17 blocca di default l'accesso alla rete locale. Serve allora il permesso a runtime `ACCESS_LOCAL_NETWORK`, e senza di lui le connessioni TCP in LAN vanno in timeout, OkHttp compreso ([protezione della rete locale](https://developer.android.com/privacy-and-security/local-network-permission)).
  - Sulla TV con API 30 non cambia nulla, ma sul box e sul mobile sì.
  - Con targetSdk 36 l'accesso resta concesso implicitamente con `INTERNET`.
  - Si passa a 37 solo dichiarando e chiedendo il permesso e gestendo il rifiuto. Per la scoperta mDNS c'è il picker di `NsdManager` (`FLAG_SHOW_PICKER`), che non chiede il permesso.
- **Versioni fisse** in `gradle/libs.versions.toml`, senza BOM e senza intervalli. Le librerie Jetpack di base (activity-compose, lifecycle) si fissano nello scaffold all'ultima stabile.
- **Scartati:**
  - Ktor 3.6.1 (2026-10-29), per l'esito di K1 (§8.7);
  - DataStore, perché tre valori stanno bene in `SharedPreferences`;
  - un framework di DI, perché un contenitore scritto a mano basta per tre moduli.
- **Opzione futura:** l'estensione FFmpeg di Media3, per TrueHD e DTS in Direct Play (§8.9.2).

### 8.7 Esperimento K1: client Kotlin generato dal bundle (2026-11-07)

Report completo: [K1](../spikes/K1-kotlin-codegen.md); codice in `spikes/k1-kotlin-codegen/`.

- **Domanda:** OpenAPI Generator 7.27.0 produce un client Kotlin che compila e decodifica i payload del contratto? Con quale libreria HTTP?
- **Metodo:**
  - cinque varianti del generatore sul bundle, compilate con Kotlin 2.4.21 in Docker;
  - una sonda con sette controlli su **payload d'esempio scritti a mano** nel formato del contratto (istanti in millisecondi, byte, enum sconosciuti, `payload` libero, `null`, codifica di una `StartPlaybackRequest`).

| Variante | Compilazione | Controlli |
|---|---|---|
| `jvm-retrofit2`, senza mapping | ❌ `Map<String, kotlin.Any>` senza serializer | — |
| `jvm-ktor`, `AnyType=JsonElement`, `number=kotlin.Double` | ❌ `State.needs_review` non qualificato in `AdminApi`, enum `Sort` e `Order` non risolti in `CatalogApi`; in più, nessun convertitore JSON nell'`ApiClient` | — |
| `jvm-retrofit2`, stessi mapping | ✅ | 4 su 7: istanti e byte superano `Int` |
| idem, bundle con `format: int64` su 10 proprietà | ✅ | 7 su 7 |
| idem, bundle invariato più **`integer=kotlin.Long`** | ✅ | **7 su 7** |

**Lettura:**
- `jvm-ktor` è scartato sull'evidenza;
- `jvm-retrofit2` va con i tre mapping;
- `integer=kotlin.Long` copre per costruzione ogni intero futuro, e `Long` è il tipo che Media3 usa già per posizioni e durate.

**Cosa K1 non prova:**
- il collegamento HTTP di Retrofit;
- la validità dei corpi codificati rispetto allo schema: con la configurazione generata il corpo contiene `"app":null`, che il server rifiuterebbe.

Il §8.8 prevede il test che manca.

### 8.8 Client API, rete ed eventi

- **Generazione:** il modulo `:api` genera il client a ogni build, in `build/generated/`, dal bundle versionato `services/video/contract/dist/openapi.json`.
  - Si usa il plugin Gradle `org.openapi.generator` 7.27.0; se non va con Gradle 9.8 (da verificare nello scaffold), si genera con l'immagine Docker dell'ADR 0004.
  - Opzioni e mapping sono quelli della variante `integer=kotlin.Long` di K1. Si usano solo i sorgenti generati.
- **Gate sui cambi del contratto:** ogni modifica di `contract/dist/openapi.json` rigenera e compila il client Kotlin.
  - Lo fa `gradlew :api:check`, quando `clients/tv` esiste; prima di allora `bash spikes/k1-kotlin-codegen/run.sh retrofit-long`, che deve dare 14 righe `OK`.
  - Il gate di milestone dell'ADR 0004 diventa "genera e compila".
- **`format: int64`:** nella prima slice TV si aggiunge alle 10 proprietà in millisecondi e in byte di K1. È un cambio additivo, che serve anche a un generatore senza mapping globale (la riserva Fabrikt). Il contratto, oggi, non cambia.
- **Retrofit:** l'app costruisce l'istanza Retrofit sulle interfacce generate, con il convertitore kotlinx.serialization e un `Json` a `explicitNulls = false`, `encodeDefaults = false` e `ignoreUnknownKeys = true`.
  - Non usa l'`ApiClient` generato: la sua autenticazione aggiunge un interceptor al builder che riceve, e senza builder ne crea uno con il logging del corpo completo.
- **`subtitleTrackId`:** "spenti" è `null`, "preferenze del profilo" è il campo assente. Il modello generato si codifica in un `JsonObject`, e per "spenti" si aggiunge `"subtitleTrackId": null`. I tipi generati restano.
- **Test dei corpi:** un test con MockWebServer valida i corpi codificati di `StartPlayback`, `ChangeTracks` e `ReportProgress` contro lo schema del bundle. Il validatore JSON Schema 2020-12 per i test si sceglie nella prima slice, come riga di decisione.
- **Facciata:** sopra il codice generato c'è una facciata scritta a mano, l'unica cosa che l'app vede.
  - Traduce gli errori in `Problem` (RFC 9457), compresi `410 CURSOR_EXPIRED` e `422 NO_COMPATIBLE_PLAN`.
  - Tiene i tipi stretti di `PlaybackSession.mode` ed `Event.type`, come nel web (§7.7).
- **HTTP:** un `OkHttpClient` 5.5.1 di base, e client derivati con `newBuilder()`:
  - quello delle API aggiunge `Authorization: Bearer <profileToken>`, tranne alle operazioni con `security: []` (`listProfiles`, `selectProfile`, `getServerInfo`), e `Accept-Language: it-IT`;
  - quelli di Coil e di Media3 (`OkHttpDataSource`) non portano il Bearer. Il data plane non usa header: il token di sessione è nel path (doc 03 P9).

  Un `401` del control plane cancella il token e porta alla scelta del profilo.
- **URL del server:**
  - si inserisce a mano al primo avvio (per esempio `http://192.168.1.10:8080/`) e si conserva in `SharedPreferences`. La scoperta mDNS arriverà dopo;
  - i locatori del control plane si risolvono su quell'URL, e l'app non costruisce mai URL dei media (doc 03 P1, P9);
  - nessuna logica assume la stessa subnet (§9).
- **HTTP in chiaro** (§4.10): Android lo blocca di default da API 28. Un `domain-config` accetta solo nomi di dominio, non intervalli di indirizzi ([configurazione di sicurezza di rete](https://developer.android.com/privacy-and-security/security-config)), mentre il server può essere un IP qualsiasi della LAN. Quindi:

  ```xml
  <network-security-config>
      <base-config cleartextTrafficPermitted="true" />
  </network-security-config>
  ```

  Con TLS (accesso remoto, ADR futura) il chiaro si spegne, e una CA privata entra con `trust-anchors`.
- **Eventi:** polling come nel web client (§7.7).
  - All'avvio `listEvents` senza cursore. Poi una chiamata ogni 5 s con l'app in primo piano, ogni 15 s durante la riproduzione, nessuna in background (`ProcessLifecycleOwner`).
  - Dopo un errore di rete l'intervallo cresce fino a 60 s. `410 CURSOR_EXPIRED` invalida tutto e riparte.
  - Gli eventi invalidano le schermate interessate con la tabella del web; lo stato sta in ViewModel con `StateFlow`.
- **SSE:** non ora. Una sola TV e pochi eventi non lo giustificano; quando servirà, è un cambio di trasporto (I3) senza toccare il contratto.
- **Rete e `limits.maxBitrate`:**
  - in S5 il sample tipico (19,6 Mb/s) non va mai in rebuffer sul Wi-Fi a 2,4 GHz, mentre un remux 4K60 da circa 100 Mb/s va in rebuffer una volta per circa 3 s;
  - il client **non dichiara** `limits.maxBitrate`. Per un 4K oltre la capacità della rete non c'è alternativa comunque (niente Transcode 4K, P2), e un limite trasformerebbe un rebuffer in `NO_COMPATIBLE_PLAN`.

### 8.9 Capability e audio

#### 8.9.1 Mappatura sul contratto

Il client dichiara **solo capability reali**, lette dalla piattaforma **a ogni avvio di sessione**, perché l'uscita audio può cambiare. Gli override del server per dispositivo (I2) restano la correzione per i casi in cui la piattaforma dichiara male.

| Campo | Regola | API |
|---|---|---|
| `device.class` | `tv` se il modo UI è televisione | `UiModeManager` |
| `device.model` | `"<MANUFACTURER> <MODEL>; Android <release> (API <n>)"`. Sulla TV: «Haier Haier OLED TV AE; Android 11 (API 30)». Gli override si scrivono su questa stringa, non sul nome commerciale | `Build` |
| `device.app` | `"pezzotflix-tv <versionName>"` | `PackageInfo` |
| `containers` | `mkv`, `mp4`, `webm`: gli estrattori di Media3 | fisso |
| `protocols` | `progressive`, `hls-fmp4` | fisso |
| `audioTrackSelection` | `true`: il client sceglie le tracce dentro un Direct Play. Il server ci riconosce un player nativo (`selectsTracks`) | fisso |
| `video[]` | Per `hevc`, `h264`, `av1` e `vp9` contano solo i **decoder hardware**: profili dai `profileLevels`, dimensioni dalle `VideoCapabilities`, `maxBitDepth` 10 se c'è un profilo a 10 bit.<br>**Una voce per fascia di risoluzione**, perché il contratto ha un solo `maxFrameRate` per voce: per esempio `h264` a 1080p fino a 120 fps e a 4K fino a 30 fps. Il motore guarda la dimensione prima del frame rate (`videoFit`), quindi più voci per codec funzionano già | `MediaCodecUtil.getDecoderInfos`, `VideoCapabilities` |
| `hdr[]` | Intersezione fra l'HDR del display e i profili dei decoder: `HDR10`, `HDR10+`, `HLG`, e `DV<n>` per ogni profilo Dolby Vision con un decoder (`DV4`, `DV5`, `DV8`, `DV9`, `DV10` su questa TV).<br>Il motore accetta `DV<profilo>` per qualunque profilo (`clientPlaysDolbyVision`). Il client **non dichiara mai un `DV` generico**, che il motore farebbe valere anche per il P7 | `Display.getHdrCapabilities`, `CodecProfileLevel` |
| `displayHdr` | `Display.isHdr()` | `Display` |
| `audio[]`, `passthrough` | Codifiche che `AudioCapabilities` accetta in bitstream sull'uscita attuale: oggi AC-3 ed E-AC-3, JOC compreso (`eac3`). `maxChannels` = il massimo sondato, fino a 8 | Media3 `AudioCapabilities` |
| `audio[]`, `decode` | Codec con un decoder che Media3 trova, con i canali che il decoder gestisce davvero: oggi `aac`, `flac`, `opus` e `pcm` a 8 canali. Niente `truehd`, `dts` né `dtshd`: sulla TV non c'è un decoder | `MediaCodecUtil` |
| `subtitles` | `text`: `srt`, `webvtt`; `image`: `pgs` (Media3 legge anche `vobsub` e `dvb`); `ass`: `true`, con lo stile parziale del `SsaParser` di Media3 | fisso |
| `limits.maxBitrate` | assente (§8.8) | — |

#### 8.9.2 Audio sulla TV di oggi

Il client non ha una preferenza audio: dichiara cosa la TV sa fare, e il motore sceglie con la scala del doc 04 §4.3.

| Traccia della sorgente | Piano | Sottotitoli |
|---|---|---|
| **AC-3, E-AC-3** (JOC compreso): la traccia italiana tipica | Direct Play, bitstream al processore Dolby del TV | incorporati, resi da Media3 |
| **AAC 5.1**: la traccia inglese tipica; anche FLAC, PCM, Opus | Direct Play, decodificati sulla TV; Android porta il multicanale sui due canali degli altoparlanti | incorporati |
| **TrueHD, DTS-HD MA, DTS** (remux, casi limite) | Direct Stream: il motore scende al **FLAC con i canali della sorgente**, e la TV lo decodifica. Il lossless resta; si perdono gli oggetti Atmos (S5: Blade Runner, TrueHD → FLAC 5.1) | PGS come `.sup` esterno (`client_render`), testo come WebVTT esterno |
| **AAC con PCE** (raro) | il motore non lo copia mai, per nessun client (`audio.ts`): conversione | come sopra se il piano è Direct Stream |

- **Ascolto del proprietario (S5):** l'AAC 5.1 decodificato sulla TV contro lo stesso convertito dal server in E-AC-3 5.1 a 640 kb/s, che il processore Dolby del TV renderebbe sugli altoparlanti.
  - Se vince il primo, o non c'è differenza, non cambia nulla.
  - Se vince il Dolby, la scelta diventa una **politica del server**, non una preferenza nascosta del client: un override per dispositivo (I2) o un campo additivo del contratto (P8), che il motore legge, applica alle tracce multicanale non Dolby e riporta nei `reasons`.
  - Il client continua a dichiarare capability vere, e la ripianificazione mantiene i suoi gradini.
- **Perché nessuna preferenza nel client:**
  - dichiarare AAC o FLAC a 2 canali quando la TV ne decodifica 8 sarebbe falso (il contratto definisce `maxChannels` come i canali che il client decodifica);
  - il server non vedrebbe la scelta, e i suoi motivi direbbero "non decodificato dal client";
  - dopo un'esclusione dell'E-AC-3, la scala resterebbe senza gradini per un AAC 5.1.
- **Estensione FFmpeg:** opzione futura per TrueHD e DTS in Direct Play. Il guadagno sarebbe solo il Direct Play al posto del Direct Stream, non la qualità, perché il FLAC è già lossless. Il costo è un AAR GPL-3.0 compilato per un'altra versione di Media3 (§8.2).

#### 8.9.3 Passthrough lossless con un impianto futuro

- **Come funzionerebbe:** con un AVR o una soundbar su HDMI eARC l'app non cambia logica. `AudioCapabilities` vede TrueHD e DTS-HD sull'uscita, l'app li dichiara in `passthrough`, e il server copia la traccia (doc 04 §4.3). È il trigger del passthrough lossless (H5).
- **Da verificare allora:** sulle TV con API 29–32 Media3 interroga `isDirectPlaybackSupported` sull'uscita attuale, e non usa l'intent HDMI né l'impostazione del surround esterno (codice di `AudioCapabilities`). Bisogna vedere se l'HAL di questo TV espone TrueHD su eARC: il profilo ARC letto oggi ha solo AC-3 ed E-AC-3.

### 8.10 Player

- **Superficie:** `PlayerSurface` di media3-ui-compose su `SurfaceView`, che serve per HDR e Dolby Vision. I sottotitoli usano `SubtitleView` di media3-ui dentro `AndroidView`, alimentata dai `Cue` del player: le note della 1.11 non citano un composable per i sottotitoli (giudizio).
- **Buffer:**
  - `DefaultLoadControl` di Media3 1.11.1 dimensiona il buffer video a 2000 segmenti da 64 KiB, circa 125 MiB, più 200 segmenti per l'audio, e li alloca come `byte[]` nello heap Java (codice di `DefaultLoadControl`);
  - con un heap di 192 MB non sta insieme alla UI: `android:largeHeap="true"` (512 MB) e `setTargetBufferBytes` a 100 MiB come valore di partenza. Le durate restano quelle predefinite, e il tetto in byte vince;
  - 100 MiB sono circa 43 s del sample tipico (19,6 Mb/s), 14 s a 60 Mb/s e 6,5 s ai 128 Mb/s di picco di un remux UHD.
- **Immagini:** con `largeHeap` la cache in memoria predefinita di Coil cresce a circa un quarto di 512 MB. Le si dà un tetto esplicito (64 MB come partenza), da tarare nella prima slice.
- **Tunneling:** spento. In S5 non riduce i frame persi né l'avvio, e con il sample tipico rallenta un seek.
- **Frequenza del display:** Media3 chiede da sé `Surface.setFrameRate` (strategia predefinita: solo se il cambio è senza interruzioni; giudizio dalla documentazione). Il display espone all'app solo 60 e 50 Hz, quindi l'app non può chiedere i 24 Hz. Se a 23,976 fps c'è judder, si interviene sulle impostazioni del TV, non nel codice (verifica del proprietario).
- **Tracce non supportate:** dopo ogni `onTracksChanged`, il client guarda il supporto delle tracce scelte.
  - Con `FORMAT_UNSUPPORTED_TYPE`, `FORMAT_UNSUPPORTED_SUBTYPE` o `FORMAT_UNSUPPORTED_DRM` segnala un fallimento con quella dimensione, invece di riprodurre in silenzio o a schermo nero.
  - Con `FORMAT_EXCEEDS_CAPABILITIES` riproduce, e si affida agli errori veri del decoder. I dispositivi sottodichiarano profili e livelli: in S5 un HEVC livello 6.1 va su un decoder che dichiara il 5.1. Anche il motore ignora livello e tier (`caps.ts`).
  - **Unica eccezione:** una traccia Dolby Vision il cui profilo non è fra gli `hdr[]` dichiarati si segnala come fallimento video (§8.12).
- **Posizioni:**
  - in Direct Play la posizione di Media3 è quella del file;
  - in HLS Media3 riporta il tempo della playlist VOD, che copre il film da 0, e ignora `mediaTimestampOffsetMs`, che il contratto descrive per hls.js. Deve coincidere con la timeline originale anche dopo un seek con riavvio (§8.13, domanda 9);
  - il client riporta sempre posizioni sulla timeline originale (doc 04).
- **Cambio della traccia audio:** il server marca ogni traccia audio `switchWithoutRestart: false` (`view.ts`). Il client chiama `ChangeTracks`, e cambia in locale solo se il piano restituito ha la stessa modalità e lo stesso URL; altrimenti riparte sul nuovo stream dalla posizione corrente.
- **Cambio dei sottotitoli:** una traccia incorporata si sceglie in locale, e il client manda anche `ChangeTracks` per registrare la scelta del profilo (§7.8).
- **Fallimenti e sessione** (doc 04 §8, con le precisazioni di F2):

| Segnale di Media3 | Azione | Note |
|---|---|---|
| Traccia scelta con `FORMAT_UNSUPPORTED_*`, o traccia DV con profilo non dichiarato | `reportPlaybackFailure` con `video`, `audio` o `subtitle` | |
| `PlaybackException` di un renderer: `ERROR_CODE_DECODER_INIT_FAILED`, `ERROR_CODE_DECODING_FAILED`, `ERROR_CODE_DECODING_FORMAT_UNSUPPORTED`, `ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES` | `reportPlaybackFailure`, con il sospetto dal tipo di traccia di `ExoPlaybackException.rendererFormat` | |
| `ERROR_CODE_AUDIO_TRACK_INIT_FAILED`, `ERROR_CODE_AUDIO_TRACK_WRITE_FAILED` | `reportPlaybackFailure` con `audio` | Per esempio un bitstream che l'uscita rifiuta |
| `ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED` o `_MALFORMED` | `reportPlaybackFailure` con `container` | In Direct Play porta al Direct Stream |
| `ERROR_CODE_PARSING_MANIFEST_*` | `reportPlaybackFailure` con `unknown` | La playlist la scrive il server |
| `404` o `410` dal data plane | Il client chiede **una volta** al control plane il motivo della chiusura (`reason` del `410 SESSION_EXPIRED`). Riparte da solo con `StartPlayback` dalla posizione corrente **solo** per `expired`, `stopped`, `shutdown` o un motivo ignoto. Con `terminated`, `failed` o `item_removed` mostra il motivo e non riparte | Con `terminated` un altro dispositivo ha preso il posto: ripartire glielo contenderebbe |
| `503 MEDIA_UNAVAILABLE` con `sessionClosed` | Mostra "il file non è raggiungibile", **senza nuovi tentativi** | Senza `sessionClosed` il `503` è transitorio: si riprova dopo `Retry-After` |
| Altro `5xx` | Definitivo al primo errore (`500 STREAM_FAILED`), poi `reportPlaybackFailure` con `unknown` | Una `LoadErrorHandlingPolicy` propria: nessun retry sui `5xx` diversi da `503` |
| `ERROR_CODE_IO_NETWORK_CONNECTION_*` | Nuovi tentativi con backoff, poi "connessione persa" | |
| Caricamento di un sottotitolo esterno (`.sup`, WebVTT) fallito | `reportPlaybackFailure` con `subtitle` | Un `503` con `Retry-After` vuol dire "in preparazione", come nel web |

- **Limiti:** al massimo 3 tentativi automatici per `StartPlayback` (doc 04 §8). Esauriti, il player mostra il motivo e offre "Riprova".
- **Il client libera il posto** (doc 04 §8, F2):
  - `StopPlayback` quando si esce dal player, quando si rinuncia (errore, tentativi esauriti) e su `onStop` dell'Activity, l'equivalente del `pagehide` del web, tranne che per una sessione già `terminated`, `expired` o `stopped`;
  - un nuovo avvio aspetta al più 3 s lo stop della sessione che sostituisce.
- **Diagnostica:** il pannello "Informazioni tecniche" mostra `mode`, `reasons`, capability dichiarate e ultimo fallimento.
- **Sottotitoli esterni** (solo in Direct Stream):
  - il WebVTT si carica con `SubtitleConfiguration`;
  - il `.sup` ha un'intestazione per segmento (`PG`, PTS, DTS), mentre il `PgsParser` di Media3 legge i segmenti come stanno nei blocchi dell'MKV, quindi il side-load diretto probabilmente non basta (giudizio, §8.13 domanda 10). La riserva è un piccolo parser che divide il `.sup` in display set con i loro tempi e passa ciascuno al `PgsParser`;
  - come ricaricare un `.sup` che cresce senza ripreparare il player si decide con la misura. Se Media3 non lo permette, il PGS esterno si disegna in un overlay proprio, sincronizzato con la posizione del player, come libpgs nel web.

### 8.11 Progetto, UI, distribuzione e test

- **Progetto:** `clients/tv/`, un progetto Gradle con il wrapper (Gradle 9.8.2), `gradle/libs.versions.toml` e tre moduli:
  - `:app`: UI, navigazione, impostazioni;
  - `:player`: Media3, capability, ripianificazione;
  - `:api`: client generato più la facciata.
- **Ambito della UI:** scelta del profilo, Home composta dal server, navigazione del catalogo (film, documentari, serie → stagione → episodio, extra), ricerca, scheda dell'item, player. Niente sezione di gestione: la coda "Da verificare" resta nel web client.
- **Gate:**
  - `npm run verify` non costruisce la TV. Il gate della TV è `gradlew check`: test JVM, Robolectric, Android Lint, warning del compilatore Kotlin come errori;
  - lo lancia l'orchestratore quando cambia il codice TV **o il contratto** (§8.8).
- **Gradle** con impostazioni prudenti come in S5 (heap da 2 GB, 2 worker, niente progetti in parallelo): il portatile ha poca RAM.
- **Distribuzione:**
  - APK di release firmato con una chiave del progetto, tenuta fuori dal repo. Se la chiave si perde basta disinstallare e reinstallare: sul dispositivo restano solo URL del server, profilo e preferenze;
  - installazione con `adb connect <ip-tv>:5555` e `adb install -r`;
  - APK unico con `armeabi-v7a` e `arm64-v8a`;
  - `LEANBACK_LAUNCHER` con banner; `android.software.leanback` e `android.hardware.touchscreen` con `required="false"`.
- **Test:**
  - **capability:** dalle istantanee di S5 (`raw-caps.json`) come fixture, confrontate con la tabella del §8.9.1;
  - **ripianificazione e sessione:** la macchina a stati del §8.10;
  - **facciata API:** con MockWebServer (Problem, `410`, corpi validati contro lo schema, §8.8);
  - **UI:** test di Compose su Robolectric, con l'SDK dei test fissato a 30, per l'ordine del focus;
  - **sulla TV:** prova di fumo via ADB.

### 8.12 Dolby Vision profilo 7

Nessuna regola nuova nel motore: il P7 è un caso limite della libreria reale, e manca un sample (H11).
- **Cosa succede oggi:**
  - un MKV con DV P7 arriva al client in Direct Play con `keep_rpu`, perché il motore assume che un player nativo riproduca il livello base (doc 04 §4.2);
  - su questa TV nessun decoder elenca il profilo 7 (S5), quindi la traccia DV ha un profilo non dichiarato, e il client la segnala come fallimento video (§8.10);
  - la ripianificazione passa al Direct Stream (doc 04 §8). Lì `keep_rpu` etichetta lo stream `hvc1` senza box DV (`playback-plan.ts`), e Media3 lo legge come HEVC HDR10.
- **Costo:** un tentativo automatico.
- **Da misurare con un sample** (§8.13, domanda 12): il Direct Stream `hvc1` con e senza `remove_dovi`. Se la misura lo chiede, la regola diventa un blocco del solo Direct Play per i client nativi, con il doc 04 §4.2 aggiornato.

### 8.13 Domande per S5

Lo stato viene dal [report di S5](../spikes/S5-tv-client.md) al 2026-11-07. Le domande 1, 2 e 4 fissano dei default; le altre sono verifiche.

| # | Domanda | Stato | Se l'esito è negativo |
|---|---|---|---|
| 1 | Il sample tipico in Direct Play (4K HEVC Main10 HDR10, AC-3 5.1, AAC 5.1, PGS e SRT): avvio, seek, frame persi; tunneling | ✅ Avvio in circa 1 s, seek a 2 ore in 0,8 s al primo frame, 0 frame persi su 933. Il tunneling non porta vantaggi: resta spento | — |
| 2 | Sull'uscita Speaker, AC-3 ed E-AC-3 arrivano davvero al processore Dolby, e non come PCM stereo? L'A/V sync regge? | ⏳ `isDirectPlaybackSupported` è vero; resta l'ascolto | Il percorso comune va comunque; la politica Dolby del §8.9.2 perde senso |
| 3 | PGS e SRT incorporati in Direct Play: resa, tempi, posizione, cambio di traccia | PGS ✅ (ritardo mediano 7 ms, 1 frame perso su 1862); SRT ⏳ | PGS: `.sup` anche in Direct Play, con un override del server. SRT: WebVTT esterno |
| 4 | Ascolto del proprietario: AAC 5.1 decodificato sulla TV contro E-AC-3 5.1 a 640 kb/s convertito dal server | ⏳ | — (decide se serve la politica Dolby del server, §8.9.2) |
| 5 | Rete sul Wi-Fi a 2,4 GHz | ✅ Sample tipico senza rebuffer; un remux da circa 100 Mb/s va in rebuffer una volta per circa 3 s | Caso limite: nessun intervento nel codice |
| 6 | Heap con il tetto del buffer e `largeHeap`; nessun intervento del low memory killer durante un film | ⏳ | Tetto più basso |
| 7 | Scorrimento di una griglia con centinaia di locandine | non in S5, che usa le View: **prima slice TV** | Baseline profile e immagini più piccole; poi Leanback per la navigazione |
| 8 | Judder a 23,976 fps | ⏳ verifica a occhio del proprietario | Impostazioni del TV |
| 9 | Direct Stream HLS fMP4 in Media3: avvio, seek con riavvio della pipeline, posizione uguale alla timeline originale, `trun` v1 con CTS negativi, E-AC-3 con `delay_moov`, **FLAC 7.1** | ⏳ i piani del server sono verificati; la riproduzione sulla TV no | Correzione nel segmenter (ADR 0003): il Direct Stream deve funzionare anche in Media3 |
| 10 | Sottotitoli esterni in Direct Stream: `.sup` col side-load di Media3? Ricarica mentre cresce? WebVTT? | ⏳ | Parser proprio o overlay (§8.10) |
| 11 | Remux: HDR10+, DV P5 e DV P8.1 in Direct Play | ✅ DV P5 e P8.1 sui decoder Dolby Vision; un HEVC livello 6.1 va. Resta da vedere a occhio che il pannello entri in Dolby Vision. HDR10+ ⏳ | Override del server per il profilo che non va |
| 12 | DV P7 (H11, serve un sample del proprietario) | ⏳ | §8.12 |

**Aggiornamento a fine S5 (2026-11-07).** Rispetto alla tabella:
- **3:** SRT ✅, ritardo mediano 5 ms.
- **6:** ⚠️ il buffer predefinito (137,5 MiB) sta nei 192 MB ma al limite (PSS 208 MB nel punto più denso del 2001); 120 s / 400 MB vanno in `OutOfMemoryError` senza `largeHeap` e stanno con `largeHeap`. Deciso il tetto di 100 MiB con `largeHeap` (ADR 0008, decisioni dopo S5). Il low memory killer su un film intero resta da osservare.
- **9:** il Direct Stream HLS fMP4 va in Media3 (spezzone di 30 s, primo frame in 456 ms); il seek lungo con riavvio della pipeline resta da misurare. Il **FLAC con blocchi da 4608 campioni si ferma** su audio reale; con 1152 campioni 5.1 e 7.1 vanno: il server passa a 1152 (ADR 0008).
- **10:** ❌ il `.sup` esterno non dà cue in Media3 1.11: parser nel client (ADR 0008, seconda slice TV).

### 8.14 Dipendenze con altre aree

- **ADR 0004:**
  - opzioni del generatore Kotlin allargate (libreria `jvm-retrofit2`, mapping di tipo); restano la versione 7.27.0 e la riserva Fabrikt;
  - il gate di milestone diventa "genera e compila", più il gate sui cambi del contratto (§8.8);
  - la frase sui tipi «`Int?` corretti» non vale per gli istanti in millisecondi (K1).
- **Contratto:** `format: int64` sulle 10 proprietà, nella prima slice TV (additivo, §8.8).
- **Decision Engine:** nessuna modifica richiesta ora.
  - La politica Dolby (§8.9.2) arriva solo se l'ascolto la chiede.
  - Gli override I2 usano il `device.model` del §8.9.1, cioè «Haier Haier OLED TV AE», non il nome commerciale.
- **ADR 0003:** il Direct Stream HLS fMP4, FLAC 7.1 compreso, e i sottotitoli esterni devono funzionare in Media3 (§8.13, domande 9 e 10).
- **ADR 0006:** URL del gateway e HTTP in chiaro; nessuna modifica a Caddy.
- **Doc 04:**
  - §4.3, §5 e §7 allineati a questa area: passthrough verso il processore del TV, AAC con PCE, capability audio su Android, rete;
  - H5, riletta: sulla TV di oggi il bitstream va al processore Dolby del TV, e il lossless non è in gioco (§8.9.3);
  - H11 (§8.12).
- **CLAUDE.md:** "Living room" (TV, AVR e ARC) e "lossless audio passthrough matters" vanno allineati ai fatti del §8.1; li allinea l'orchestratore.
- **Web client (§7):** nessun codice condiviso. Si condividono contratto, vocabolario delle capability, protocollo di ripianificazione e tabella di invalidazione degli eventi.

### 8.15 Raccomandazione

- **Scelta:** app Android nativa in **Kotlin 2.4.21**, con **Jetpack Compose 1.12.1** e **Compose for TV** (tv-material 1.1.0) e il player **Media3 1.11.1**.
  - Build con AGP 9.5.1 e Gradle 9.8.2; compileSdk 37 (lo chiede OkHttp 5.5.1, F3a), targetSdk 36, minSdk 30.
  - Client API generato con OpenAPI Generator 7.27.0 `jvm-retrofit2` e mapping `integer=kotlin.Long`, su Retrofit 3.0.0, OkHttp 5.5.1 e kotlinx-serialization 1.12.0.
  - Audio: solo capability reali. Il caso comune va in Direct Play; TrueHD e DTS scendono al FLAC in Direct Stream.
- **Criteri decisivi:**
  - T1, T2 e T3: solo Media3 nello stesso linguaggio dell'app dà Direct Play, sottotitoli incorporati e capability reali senza ponti;
  - T7: Leanback è deprecata;
  - T4: un linguaggio.
  - Il client HTTP lo decide K1: Ktor non compila sul bundle.
- **Runner-up: Kotlin con Leanback.** Diventerebbe la scelta, solo per le schermate di navigazione, se Compose non reggesse lo scorrimento sul MT5889 (§8.13, domanda 7). Player, capability e client API resterebbero gli stessi.

### 8.16 Domande aperte, rischi e fonti

- **Per il proprietario,** azioni fisiche:
  - l'**ascolto** del §8.13, domanda 4;
  - la **verifica a occhio**: Dolby Vision sul pannello, judder a 23,976 fps;
  - un **sample DV P7** (H11), a bassa priorità.
- **Rischi:**
  - remux sopra i 100 Mb/s sul Wi-Fi a 2,4 GHz (rebuffer, caso limite);
  - memoria: 192 MB di heap senza `largeHeap`, cache delle immagini;
  - Compose su un SoC a 32 bit;
  - 24p su un display che espone all'app solo 60 e 50 Hz;
  - supporto 3.1 «beta» del generatore, coperto dal gate sui cambi del contratto.

  Ogni rischio ha la sua domanda nel §8.13 o la sua riserva (§8.8, §8.15).
- **Fonti** (consultate il 2026-11-07):
  - le versioni e le pagine di rilascio del §8.6, comprese la [pagina di Leanback](https://developer.android.com/jetpack/androidx/releases/leanback) e la [protezione della rete locale](https://developer.android.com/privacy-and-security/local-network-permission);
  - il codice di Media3 sul ramo `release`: [`MatroskaExtractor`](https://raw.githubusercontent.com/androidx/media/release/libraries/extractor/src/main/java/androidx/media3/extractor/mkv/MatroskaExtractor.java), [`MediaCodecUtil`](https://raw.githubusercontent.com/androidx/media/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/mediacodec/MediaCodecUtil.java), [`AudioCapabilities`](https://raw.githubusercontent.com/androidx/media/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/AudioCapabilities.java), [`DefaultLoadControl`](https://raw.githubusercontent.com/androidx/media/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/DefaultLoadControl.java);
  - la [guida a Media3 con Compose](https://developer.android.com/media/media3/ui/compose) e le [novità di Media3 1.11](https://android-developers.googleblog.com/2026/08/media3-1-11-whats-new.html) (2026-08-11);
  - la [migrazione a Compose for TV](https://developer.android.com/training/tv/playback/leanback/migrate-to-compose);
  - la [configurazione di sicurezza di rete](https://developer.android.com/privacy-and-security/security-config);
  - [`dpad`](https://pub.dev/packages/dpad/changelog) per Flutter;
  - i report [S5](../spikes/S5-tv-client.md) e [K1](../spikes/K1-kotlin-codegen.md).
