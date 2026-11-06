# 06 — Piano MVP (vertical slice)

- **Stato:** Accettato (2026-11-06), Claude su delega del proprietario
- **Deriva da:** [Requisiti](../requirements/0001-video-service-requirements-v0.1.md) §19; [01](01-domain-model.md)–[04](04-playback-architecture.md); [standard di libreria](../library-standard.md); [ADR](../adr/README.md) 0001–0007

---

## 1. Obiettivo

Il vertical slice dei requisiti §19, **non usa-e-getta**:

```text
MKV locali → Video Service in container → indicizzazione → catalogo → web client
→ selezione → playback (Direct Play / Direct Stream) → progress → resume
```

### 1.1 Definition of done

1. `docker compose up -d` avvia `gateway` (Caddy, con il web client) e `video` (Fastify). Su `http://localhost:8080` si apre la scelta del profilo.
2. Una `LibraryRoot` configurata da `.env` viene scansionata (scansione periodica più `TriggerScan`). I file di `media-samples/library` vengono analizzati con ffprobe, identificati con le regole dello standard e Wikidata, e catalogati: film, serie con stagioni ed episodi, extra.
3. Home con le righe Continua a guardare, Aggiunti di recente, Film, Serie, Documentari; pagina dell'item con versioni e tracce; ricerca per titolo.
4. Il playback nel browser parte in **Direct Play** quando il browser lo regge, altrimenti in **Direct Stream** (HLS fMP4, video copiato, audio convertito se serve). Il seek funziona, la timeline è quella originale.
5. Progress salvato via heartbeat; visto oltre il 90%; resume dalla posizione salvata; il tutto per profilo.
6. Coda **"Da verificare"** nella sezione di gestione: elenco dei casi con motivo e candidati, risoluzione verso un candidato, ignora.
7. Test verdi: unit test sui moduli puri (parser, matcher, Decision Engine), test del contratto sulle API, un test end-to-end che riproduce un file di esempio.

### 1.2 Fuori dal primo slice (dopo, nello stesso codice)

- Transcode software per sorgenti fino a 1080p (P2): fatto in F1b.4, dentro l'MVP.
- Arricchimento TMDB: l'adapter c'è, si attiva quando esiste `TMDB_READ_TOKEN` (ADR 0007).
- Upload dell'artwork, watchlist, history UI, eventi push, app TV.

---

## 2. Struttura del repository

```text
package.json                 workspace npm (ADR 0001)
services/video/              Video Service (Node 26, TypeScript, Fastify)
  contract/                  OpenAPI 3.1 multi-file (ADR 0004), sorgente di verità
  src/
    app/                     bootstrap, config, logging, error handler (Problem Details)
    modules/
      library/               Library Monitor: scansione, fingerprint, stati del file
      analyzer/              Media Analyzer: ffprobe → MediaFacts
      identifier/            parser dello standard + matcher + Resolver chain
      metadata/              MetadataProvider (Wikidata, TMDB), Enricher
      catalog/               CatalogItem, MediaLink, query di Home e ricerca
      profiles/              profili, progress, WatchState, ViewingRecord
      playback/              Decision Engine (puro), Session Manager
      delivery/              Stream Delivery (Direct Play range, Direct Stream HLS)
      jobs/                  Job Runner su tabella SQLite
      admin/                 API di gestione (casi, scan, diagnostica)
    db/                      schema Drizzle, migrazioni, connessione
  test/
clients/web/                 web client (ADR 0005)
deploy/                      compose.yaml, Caddyfile, Dockerfile del gateway e del Video Service (override GPU non ancora presente)
```

I confini dei moduli sono verificati da dependency-cruiser (ADR 0001). In particolare `playback/decision` non importa nulla di I/O, e `delivery` dipende solo da tipi serializzabili, così resta estraibile in `video-worker`.

---

## 3. Ordine di costruzione

| Fase | Contenuto | Chi |
|---|---|---|
| F0 | Scheletro: workspace, config, DB e migrazioni, schema completo, error handler, health, contratto OpenAPI con tutte le operazioni MVP, codegen TS, Compose + Caddy + Dockerfile, CI locale (`npm test`, lint, confini) | orchestratore |
| F1a | **Ingest:** library, analyzer, identifier (porting delle regole e dei GAP dello standard), metadata (Wikidata, TMDB dietro flag), jobs, catalog (scrittura), admin dei casi | agente in worktree |
| F1b | **Playback:** Decision Engine con capability del browser, Session Manager (limite 1, heartbeat, timeout), Stream Delivery (Direct Play, Direct Stream HLS fMP4 con riavvio al seek, scratch con quota), profiles e progress | agente in worktree |
| F1c | **Web client:** profili, Home, dettaglio, ricerca, player (hls.js e PGS secondo S2/ADR 0005), sezione "Da verificare" | agente in worktree |
| F2 | Integrazione, test end-to-end su `media-samples/library`, review del codice, correzioni | orchestratore + `code-reviewer` |

F1a, F1b e F1c lavorano in parallelo **sul contratto e sullo schema congelati in F0**. Una modifica al contratto passa dall'orchestratore.

---

## 4. Strategia di test

- **Unit:** parser e matcher (riusano come casi il corpus di S4 e gli esempi dello standard, ricreati come fixture di test), Decision Engine (tabella di casi: browser × formati di S1/S2), Range e playlist.
- **Contratto:** ogni risposta viene validata contro la spec (ADR 0004); una spec che cambia in modo incompatibile fa fallire la CI (oasdiff).
- **Integrazione:** DB SQLite in memoria; ffprobe e ffmpeg reali sui fixture di `media-samples/` quando presenti, altrimenti test saltati con un avviso.
- **End-to-end:** lo stack in Compose, scansione, una chiamata `StartPlayback`, primo segmento HLS o 206 Range ricevuto, progress salvato.

---

## 5. Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Esito di S2 su HEVC/HDR e PGS nel browser | Il Decision Engine legge le capability dichiarate dal client. Il web client le rileva con `isTypeSupported` su un elenco fisso di stringhe di codec e verifica `stream.mimeType` prima di avviare il player (doc 04 §5, doc 03 I6). Nessuna assunzione nel server |
| Throughput del bind mount NTFS (circa 500 Mbps) | Una sola sessione nell'MVP; misura nei test end-to-end |
| Rate limit di Wikidata nella prima scansione | User-Agent conforme con contatto (URL del repo), cache, batch (ADR 0007) |
| Integrazione di tre filoni paralleli | Contratto e schema congelati in F0, worktree separati, merge e test end-to-end dell'orchestratore |
