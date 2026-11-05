# 0004 — Contratto API: OpenAPI 3.1 scritto a mano, validazione da spec, codegen TS e Kotlin

- **Stato:** Accepted (2026-11-06)
- **Data:** 2026-11-05
- **Decisore:** Claude, su delega del proprietario (review: design-reviewer, correzioni applicate)
- **Requisiti collegati:** §7 (client web, TV, mobile), §9 (nessuna assunzione di subnet, remoto futuro), §18 (evolvibilità), §20 (protocollo/API aperto); doc 03 P1–P9, §2, §5, §7, I3, I4
- **Valutazione completa:** [05 — §3 Formato del contratto API e codegen](../architecture/05-technology-evaluation.md#3-formato-del-contratto-api-e-codegen)

## Contesto

Il doc 03 (I4) impone un contratto **contract-first**: una specifica machine-readable nel repo da cui si generano i client. I client sono web (subito), Android TV in Kotlin/Media3 (dopo) e mobile (dopo).

La semantica è già fissata:
- control plane REST/JSON che restituisce locatori del data plane;
- data plane HTTP puro con `Range`, autorizzato da un token nell'URL (P9);
- cursori (P5), errori uniformi (P6), millisecondi e UTC (P7);
- evoluzione additiva e versionata (P8);
- polling degli eventi (I3).

Il server è Fastify (ADR 0001); il gateway Caddy instrada `/video/api/*` e `/video/media/*` senza riscrivere il path (ADR 0006).

## Opzioni considerate

### A. OpenAPI 3.1 scritto a mano (YAML multi-file)
- Pro:
  - standard universale;
  - descrive anche il data plane (206, binari);
  - il server registra route e validazione dallo stesso file (fastify-openapi-glue);
  - codegen TS maturo;
  - nessun linguaggio in più.
- Contro:
  - YAML verboso e ripetitivo;
  - il supporto 3.1 di OpenAPI Generator (Kotlin) è dichiarato **beta**.

### B. TypeSpec 1.17 → OpenAPI 3.1
- Pro: conciso (`Page<T>`, errori comuni), emette lo stesso OpenAPI 3.1, quindi a valle cambia poco.
- Contro: un compilatore e un linguaggio in più, il YAML generato va comunque rivisto, ed è meno noto.

### C. Protobuf + Connect
- Pro: evoluzione dei campi eccellente, codegen forte (connect-es 2.3.0).
- Contro:
  - il data plane resta fuori, quindi due contratti;
  - errori e paginazione da ridefinire;
  - connect-kotlin è pre-1.0 (0.10.0);
  - debug meno diretto.

## Evidenze

- **Smoke test** (2026-11-05), dettagli in [05 §3.5](../architecture/05-technology-evaluation.md#35-esperimento-2026-11-05-smoke-test):
  - spec 3.1.1 con `type: [T, "null"]`, enum, default, route 206;
  - **openapi-typescript 7.13.0** → `number | null` corretti;
  - **fastify-openapi-glue 4.12.0** + Ajv2020 → 400 su query non valida, campi non dichiarati rimossi dalla risposta;
  - **OpenAPI Generator 7.27.0** (`kotlin`, `jvm-ktor`, kotlinx.serialization, `enumUnknownDefaultCase=true`) → `Int?`/`String?` corretti ed enum con caso sconosciuto, con l'avviso "3.1 beta";
  - gli errori di Fastify di default **non** sono Problem Details.
- Versioni verificate sui registry il 2026-11-05 (npm, PyPI, GitHub releases).

## Decisione

**Opzione A: OpenAPI 3.1.1 scritto a mano.**

1. **Posizione e struttura:**
   - `services/video/contract/openapi.yaml` (radice) con `paths/` e `components/` in file separati;
   - **Redocly CLI 2.75.0** per `lint` e `bundle`;
   - il bundle `services/video/contract/dist/openapi.json` **si versiona**: è l'unico input dei generatori. `npm run verify` lo rigenera e fallisce se c'è un diff;
   - **nessun pacchetto di contratto condiviso:** ogni client genera i propri tipi dal bundle versionato (il web client nel suo workspace, il client TV nel suo progetto).
2. **Lint**, con le regole di Redocly più quelle del progetto, che definiscono il sottoinsieme 3.1 "portabile":
   - `operationId` obbligatorio e in camelCase;
   - ogni operazione ha una risposta `default` `application/problem+json`;
   - nullabilità dei tipi semplici solo come `type: [T, "null"]`;
   - un riferimento nullable si scrive `oneOf: [{ $ref: … }, { type: "null" }]`;
   - niente `const` né `$ref` con fratelli negli schemi esposti ai client;
   - **regola di `v1`: niente unioni `oneOf` con `discriminator`.** `PlaybackSession` è un solo schema con l'enum `mode` e i campi specifici della modalità opzionali; il payload di un evento è un oggetto generico, il cui contenuto dipende dal campo `type`. Il `oneOf` è ammesso solo nella forma nullable qui sopra.
3. **Breaking change:** **oasdiff 1.35.0** (immagine Docker) confronta lo spec con l'ultima milestone su `main`; gira come **gate di milestone**, non a ogni commit. Un breaking change dentro `v1` blocca la milestone (P8).
4. **Server:**
   - **fastify-openapi-glue 4.12.0** registra le route dallo spec, con gli handler per `operationId`;
   - i path nello spec sono **assoluti** (`/video/api/v1/…`, `/video/media/…`), con `servers: [{ url: "/" }]` e nessun `prefix` nella configurazione di glue: il path dello spec è quello che arriva dal gateway, senza riscritture (ADR 0006);
   - un futuro `video-worker` registra dallo stesso spec solo le operazioni con il tag `media`;
   - **Ajv 8.20.0** in modalità 2020-12 come validator compiler (coercizione della query, default, campi sconosciuti ignorati);
   - `securityHandlers` per il contesto di profilo;
   - un `setErrorHandler` mappa ogni errore su Problem Details.
5. **Conformità delle risposte:**
   - la serializzazione di Fastify rimuove i campi non dichiarati ma **non valida** tipi e campi obbligatori;
   - nei test Vitest un helper valida ogni risposta di `inject()` contro lo schema dello spec;
   - come **gate di milestone**, **Schemathesis 4.33.1** (immagine Docker) gira contro il container avviato (`schemathesis run`, tutti i check).
6. **Codegen TypeScript:**
   - **openapi-typescript 7.13.0** genera `schema.d.ts` dal bundle versionato, e anche `schema.d.ts` si versiona; `npm run verify` rigenera e fallisce se c'è un diff;
   - tipizza sia gli handler del server (`operations[...]`) sia il web client;
   - per il web client il runtime è **openapi-fetch 0.17.0**;
   - `overrides` npm per usare TypeScript 6.0.3 (peer dichiarato `^5.x`, verificato funzionante).
7. **Codegen Kotlin:**
   - **OpenAPI Generator 7.27.0** via immagine Docker `openapitools/openapi-generator-cli:v7.27.0`, generatore `kotlin`, `serializationLibrary=kotlinx_serialization`, `enumUnknownDefaultCase=true`;
   - la libreria HTTP (`jvm-ktor` o `jvm-retrofit2`) la decide l'ADR del client TV;
   - a ogni milestone il client Kotlin si genera dal bundle con l'immagine Docker (gate: la generazione riesce senza errori), così le regressioni grossolane del supporto 3.1 beta emergono presto;
   - la verifica completa del generatore Kotlin (compilazione, libreria HTTP, uso reale) è **rinviata all'ADR del client TV** (punto aperto, vedi Conseguenze);
   - fallback: Fabrikt 28.4.0.
8. **Convenzioni del contratto:**
   - **Base path:** control plane `/video/api/v1/…`, data plane `/video/media/…`. La major è nel path; dentro `v1` si fanno solo modifiche additive.
   - **Token di sessione nel path** (`/video/media/s/{sessionToken}/…`), mai in query. Gli URI relativi delle playlist HLS ereditano il path ma non la query (RFC 3986 §5.2), quindi segmenti e sottotitoli restano autorizzati senza riscrivere le playlist (P9). Le route del data plane sono nello spec (tag `media`), ma i client usano solo i locatori restituiti (P3).
     - Il token è di 32 byte casuali in base64url, confrontato a tempo costante, e mascherato nei log (ADR 0001, regola 7).
   - **Errori:** RFC 9457 `application/problem+json` con le estensioni `code` (enum stabile: `VALIDATION_FAILED`, `NOT_FOUND`, `SESSION_LIMIT_REACHED`, `MEDIA_UNAVAILABLE`, `NO_COMPATIBLE_PLAN`, `SESSION_EXPIRED`, `CURSOR_EXPIRED`, …) ed `errors[]` per la validazione.
   - **Paginazione:** `?limit=&cursor=` → `{ items, nextCursor }`, con `nextCursor: string | null`. Il parametro si chiama `cursor` **ovunque**, eventi compresi. Il cursore è opaco e keyset (ADR 0002). Un cursore non più valido (per esempio oltre la retention degli eventi) dà `CURSOR_EXPIRED` con HTTP **410**, e il client si risincronizza: rilegge lo stato e riparte senza cursore.
   - **Contesto di profilo (P2):**
     - `SelectProfile` restituisce un `profileToken` opaco, inviato come `Authorization: Bearer` sul control plane;
     - nell'MVP è un riferimento al profilo, senza segreto;
     - con l'auth futura diventa un token vero e il contratto non cambia.
   - **Enum aperti:** i client gestiscono valori sconosciuti (Kotlin `enumUnknownDefaultCase`, ramo `default` in TS). Aggiungere un valore è additivo.
   - **Eventi:** `GET /video/api/v1/events?cursor=<cursor>` → `{ events, nextCursor }`, con i tipi del doc 03 §7. Il payload è un oggetto generico che dipende da `type` (punto 2).
   - **Tempi e date:** `…Ms` interi per posizioni e durate, date ISO 8601 in UTC (P7).
   - **Immagini:** tutti gli URL delle immagini sono **indirizzati per contenuto** (l'hash del file è nell'URL), quindi un'immagine nuova ha sempre un URL nuovo.
     - Immagini non TMDB (upload, frame dal video, varianti nostre): `Cache-Control: public, max-age=31536000, immutable`.
     - Immagini con sorgente `tmdb`: `Cache-Control: public, max-age=2592000` (30 giorni), **senza** `immutable`, così le copie nei client non sopravvivono a lungo alla scadenza o al purge dei dati TMDB (ADR 0007).
9. **OpenAPI 3.2** (settembre 2025) non si adotta finché openapi-typescript, fastify-openapi-glue e OpenAPI Generator non lo supportano in modo verificato.

## Conseguenze

- **Più facile:**
  - un solo artefatto descrive control plane e data plane, valida il server e genera i client;
  - i breaking change sono intercettati al gate di milestone (oasdiff), e il diff del codegen a ogni `npm run verify`;
  - i client vecchi tollerano campi ed enum nuovi.
- **Più difficile:**
  - YAML lungo da mantenere a mano;
  - il sottoinsieme 3.1 "portabile" va rispettato per non rompere il generatore Kotlin (beta su 3.1);
  - senza unioni discriminate nello spec, i tipi generati per `PlaybackSession` e per i payload degli eventi sono larghi: il restringimento per `mode` e `type` si scrive a mano nei client;
  - un `overrides` npm da tenere finché `openapi-typescript` non dichiara TypeScript 6.
- **Punti aperti:**
  - **verifica della toolchain sullo spec reale (fase F0, orchestratore):** `redocly bundle`, fastify-openapi-glue e openapi-typescript sullo spec multi-file vero (riferimenti tra file, `oneOf` nullable, path assoluti). Se uno strumento fallisce, si corregge lo spec dentro il sottoinsieme portabile o si rivede questa ADR prima di proseguire;
  - **verifica del generatore Kotlin:** rinviata all'ADR del client TV. Trigger: inizio del lavoro sul client TV, oppure un fallimento della generazione al gate di milestone.
- **Da rivedere:**
  - se lo spec diventa troppo ripetitivo: passaggio a TypeSpec 1.x, a valle invariato;
  - quando OpenAPI Generator toglie la beta su 3.1, oppure se fallisce su un costrutto: Fabrikt;
  - all'arrivo di TV e mobile, per push (SSE) al posto del polling, cambiando solo il trasporto (I3);
  - all'arrivo dell'auth, per la semantica del `profileToken`.
- **Dipendenze:**
  - ADR 0001 (Fastify, TypeScript 6, Vitest, `npm run verify`, token e log);
  - ADR 0002 (cursori keyset, `domain_event`, `CURSOR_EXPIRED`);
  - ADR 0006 (prefissi del gateway senza riscrittura, `Authorization` passato invariato);
  - ADR 0007 (sorgente delle immagini, che decide il `Cache-Control`);
  - [ADR 0003](0003-streaming-hls-fmp4-segmenter.md), streaming (accettata il 2026-11-05): token nel path come vincolo sui locatori;
  - [ADR 0005](0005-web-client-react-vite.md), web client (accettata il 2026-11-05): openapi-fetch e generazione dei tipi dal bundle;
  - ADR del client TV (numero da assegnare): libreria HTTP del client Kotlin e verifica del generatore;
  - ADR della CI ospitata (numero da assegnare): per ora gate locali e di milestone.
