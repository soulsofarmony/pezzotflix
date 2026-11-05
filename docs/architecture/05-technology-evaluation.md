# 05 — Valutazione tecnologica

- **Stato:** in revisione. Le ADR collegate sono in stato **Proposed**; le accetta l'orchestratore dopo il passaggio del `design-reviewer` (CLAUDE.md, decisioni delegate dal proprietario il 2026-11-05).
- **Data:** 2026-11-05
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

**Numeri riservati:** ADR 0003 (protocollo di streaming) e ADR 0005 (web client). Si scrivono dopo lo spike S2, prima del lavoro su Stream Delivery e sulla UI. Altre ADR previste, senza numero: client TV, accelerazione hardware del transcode (dopo H10), thumbnail, CI ospitata, backup fuori dall'host.

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
- **ADR:** [0001 — TypeScript su Node.js 26 con Fastify 5](../adr/0001-runtime-backend-typescript-node-fastify.md) (Proposed)
- **Data:** 2026-11-05
- **Aree collegate:** [database](#2-database-e-migrazioni) (ADR 0002), [contratto API](#3-formato-del-contratto-api-e-codegen) (ADR 0004), [deploy](#4-deploy-e-gateway) (ADR 0006), [metadata](#5-provider-dei-metadata-e-funzionamento-offline) (ADR 0007), ADR 0003 (protocollo di streaming) e ADR 0005 (web client), riservate

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
- **ADR 0003, protocollo di streaming** (numero riservato, scritta dopo S2): il runtime serve playlist e segmenti fMP4 dallo scratch con `@fastify/send`. La scelta HLS/DASH non cambia questa ADR.
- **ADR 0005, web client** (numero riservato, scritta dopo S2): stesso TypeScript 6.0.3 e Vitest 5 nel workspace npm.
- **ADR 0007 (provider dei metadata):** limiti per host del rate limiter; parser e matcher portati da S4.

### 1.8 Domande aperte

- **TypeScript 7.0 (tsgo):** quando `typescript-eslint` e `openapi-typescript` lo supporteranno, si potrà usare `tsgo --noEmit` per un type-check più rapido. Non blocca.
- **Host di sviluppo:** risolta il 2026-11-05. L'host ha un Node 26.13.0 portabile (npm 11.20.0), e lo smoke test del database passa su questa versione. Resta da ripetere la verifica dentro `node:26.13.0-trixie-slim` al primo passo di F0.


---

## 2. Database e migrazioni

- **Area:** motore di database, driver, query layer e migrazioni, backup
- **ADR:** [0002 — SQLite (WAL) con better-sqlite3 e Drizzle](../adr/0002-database-sqlite-drizzle.md) (Proposed)
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
- **ADR:** [0004 — OpenAPI 3.1 scritto a mano, con codegen TS e Kotlin](../adr/0004-contratto-api-openapi-3-1.md) (Proposed)
- **Data:** 2026-11-05
- **Aree collegate:** [runtime](#1-runtime-e-framework-del-backend) (ADR 0001), [database](#2-database-e-migrazioni) (ADR 0002), [deploy](#4-deploy-e-gateway) (ADR 0006), ADR 0003 (protocollo di streaming) e ADR 0005 (web client), riservate, e ADR del client TV

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
- **ADR 0003, protocollo di streaming** (numero riservato): il token nel path è un **vincolo** sulla forma dei locatori HLS/DASH.
- **ADR del client TV:** il client Kotlin generato (`jvm-ktor` o `jvm-retrofit2`/OkHttp) va scelto lì insieme allo stack Android. Qui si garantisce solo che la generazione funzioni.

### 3.8 Domande aperte

- **Libreria HTTP Kotlin del client generato** (Ktor contro Retrofit/OkHttp): decide l'ADR del client TV. Il generatore supporta entrambe.
- **Toolchain sullo spec reale:** l'orchestratore prova `redocly bundle`, fastify-openapi-glue e openapi-typescript sullo spec multi-file vero durante F0.
- **Generatore Kotlin:** la verifica completa è rinviata all'ADR del client TV. Trigger: inizio del lavoro sul client TV, oppure un fallimento della generazione al gate di milestone.
- **Push al posto del polling** (SSE): quando arriveranno TV e mobile (I3). Il contratto degli eventi è già quello, cambia il trasporto.


---

## 4. Deploy e gateway

- **Stato:** Proposta (2026-11-05). ADR collegato: [0006 — Deploy e gateway](../adr/0006-deploy-e-gateway.md)
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
- **Permessi:** il Dockerfile crea con `mkdir -p` tutti i mount point (`/data/db`, `/data/cache`, `/data/artwork`, `/data/thumbnails`, `/data/scratch`, `/data/backup`, `/media`) e ne fa il `chown` all'utente del servizio prima di `USER`, così i volumi nominati nuovi nascono con il proprietario giusto. Per i bind mount su Linux si documentano `PUID`/`PGID`.
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
  - `MEDIA_DIR`, `HTTP_PORT`, `TZ`, `LOG_LEVEL`, `DATA_DIR` (default `/data`), `PUID`/`PGID` (solo bind mount su Linux);
  - `LIBRARY_SCAN_INTERVAL_MIN`, `LIBRARY_WATCH`;
  - `SESSION_MAX`, `TRANSCODE_MAX`, `SCRATCH_MAX_BYTES`, `HWACCEL`, `FFMPEG_PATH`;
  - `TMDB_READ_TOKEN`, `WIKIDATA_CONTACT` (ADR 0007).
- Come caricare il `.env` della radice con i file Compose in `deploy/` (un `compose.yaml` alla radice con `include`, oppure `--env-file`) si decide in implementazione. I vincoli: un solo `.env`, nessun segreto nei file versionati.
- Una modifica del `.env` diventa effettiva con `docker compose up -d`, che ricrea il container. Nessuna configurazione a caldo nell'MVP.

### 4.10 Rete e TLS

- **MVP:** HTTP in LAN sulla porta `${HTTP_PORT}`, `auto_https off`. Su Windows può servire una regola del firewall per raggiungere la porta di Docker Desktop dagli altri dispositivi: è un passo del proprietario, con UAC.
- **Futuro remoto** (§9): HTTPS automatico di Caddy (ACME) o `tls internal` in LAN, e autenticazione davanti a `/video/*`, senza modifiche al Video Service (doc 02 §2.1). Per la challenge DNS serve una build di Caddy con il plugin del provider DNS (`xcaddy`).
- **Da tenere presente per il client TV:** Android blocca di default il traffico HTTP in chiaro. L'app TV dovrà dichiararlo permesso per la LAN, finché non c'è TLS. Va nell'ADR del client TV.

### 4.11 Dipendenze con altre aree

- **ADR 0001 (runtime):** immagine base `node:26.13.0-trixie-slim` fissata per digest e `node --watch` dentro `compose watch`. Se la base cambiasse distribuzione, cambierebbe il pacchetto `jellyfin-ffmpeg8` da installare (esiste anche per bookworm).
- **ADR 0002 (database):** SQLite embedded, file `/data/db/video.db` nel volume `video-db`, backup in `video-backup`; nessun container di database.
- **ADR 0007 (provider):** `.env` dei provider, risposte in `provider_cache` nel DB, artwork TMDB in `video-artwork`.
- **ADR 0003, protocollo di streaming** (numero riservato, scritta dopo S2): i segmenti HLS/fMP4 passano dal gateway con `flush_interval -1`; il Range del Direct Play è verificato in G1; la quota dello scratch dipende dalla durata dei segmenti tenuti.
- **Accelerazione hardware:** override GPU, versione di jellyfin-ffmpeg abbinata al driver, probe all'avvio.
- **ADR 0005, web client** (numero riservato, scritta dopo S2): la sua build entra nell'immagine del gateway (multi-stage). Il dev server, se c'è, gira sull'host.
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

- **Stato:** Proposta (2026-11-05). ADR collegato: [0007 — Provider dei metadata e funzionamento offline](../adr/0007-provider-metadata-e-offline.md)
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
- **ADR 0005 (web client, riservata) e client TV:** pagina "Informazioni" con logo e avviso, segnaposto delle copertine, avanzamento dell'ingest, "fissa come valore manuale".

### 5.16 Raccomandazione

- **Strategia A.**
  - TMDB è la fonte primaria di **arricchimento**: trame, poster, cast ordinato, episodi in `it-IT`. I suoi dati scadono dopo 180 giorni e vengono rinnovati ogni 90.
  - Wikidata è la fonte di **identificazione** e la **base durevole**, collegata via QID e ID TMDB.
  - Tutto è memorizzato per sorgente, con la precedenza `manual > tmdb > wikidata > filename`; solo `manual` (e gli ID dal filename) sono durevoli.
  - Prima del matching fuzzy si usano i tag ID del filename.
  - L'artwork TMDB è trattato come TMDB Content: riscaricato a ogni refresh, mai ricodificato, cancellato a scadenza o al purge.
  - Senza chiave l'MVP gira con Wikidata e i segnaposto, e TMDB si attiva al riavvio con un backfill automatico.
- **Runner-up:** B (identificazione TMDB-first). Sarebbe diventata la scelta con una precision più alta su TMDB: misurata il 2026-11-05 in S4, non lo è (ADR 0007, revisione).
