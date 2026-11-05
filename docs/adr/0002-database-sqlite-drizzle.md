# 0002 — Database: SQLite (WAL) con better-sqlite3 e Drizzle ORM

- **Stato:** Accepted (2026-11-06)
- **Data:** 2026-11-05
- **Decisore:** Claude, su delega del proprietario (review: design-reviewer, correzioni applicate)
- **Requisiti collegati:** §3 (DB su volume separato), §8, §11–13 (ingest, metadata in cache locale, correzioni), §14–15 (stato per profilo), §18 (portabilità, resilienza), §20 (database aperto); doc 01 §3.5, §5.2, §7; doc 02 §3.12, §6, §7; doc 03 P5, §7, §8
- **Valutazione completa:** [05 — §2 Database e migrazioni](../architecture/05-technology-evaluation.md#2-database-e-migrazioni)

## Contesto

Il Video Service persiste:
- catalogo con provenienza e campi locked;
- fatti tecnici dei media;
- `MediaLink` e `IdentificationCase`;
- profili e stato di visione per profilo;
- una coda persistente di job con priorità, retry e chiave di idempotenza;
- gli eventi per il polling.

Il dimensionamento è di qualche migliaio di item, un nodo e un solo processo scrittore. Le sessioni sono runtime (doc 02 §7). Il doc 02 §6 prevede un container `video-db` solo **se** la tecnologia lo richiede. L'ADR 0006 vieta il DB su bind mount NTFS e prevede il volume nominato `video-db`.

## Opzioni considerate

### A. SQLite 3.53 in WAL, nel processo, con better-sqlite3
- Pro:
  - nessun servizio in più;
  - backup online coerente con `db.backup()`;
  - transazioni ACID, `UPDATE … RETURNING` per il claim dei job;
  - FTS5 con rimozione dei diacritici;
  - test su DB in memoria;
  - prebuild per tutte le piattaforme.
- Contro:
  - un solo scrittore;
  - il driver è sincrono sull'event loop;
  - WAL non funziona su file system di rete, quindi solo su volume locale;
  - più istanze del servizio richiederebbero una migrazione.

### B. PostgreSQL 18.6 in un container `video-db`
- Pro: concorrenza piena, `pg_trgm`/`unaccent`, `LISTEN/NOTIFY`, code già pronte (pg-boss), più istanze possibili.
- Contro:
  - un container da gestire (upgrade di major, healthcheck, `pg_dump` in un sidecar);
  - test più lenti;
  - capacità oltre il bisogno dell'MVP e del target (§8).

### Query layer (vincolato all'ADR 0001)
- **Drizzle ORM 0.45.4 + drizzle-kit 0.31.11:**
  - una sola sorgente (schema TS) per tipi e migrazioni SQL generate e rivedibili;
  - la 1.0 è in RC.
- **Kysely 0.29.8:** stabile, ma tipi e migrazioni sono due sorgenti, e `kysely-codegen` 0.20.0 non accetta better-sqlite3 13.
- **Prisma:** `latest` su npm è una RC della 8; scartato.

## Evidenze

- **Smoke test** (2026-11-05, host Windows, Node 22.14), dettagli in [05 §2.5](../architecture/05-technology-evaluation.md#25-esperimento-2026-11-05-smoke-test-host-windows-node-2214):
  - `drizzle-kit generate` → `0000_init.sql` leggibile;
  - `migrate()` su un DB in WAL;
  - `UNIQUE` sulla chiave di idempotenza con `ON CONFLICT DO NOTHING`;
  - claim atomico con `UPDATE … WHERE id = (SELECT … ORDER BY priority DESC, run_at LIMIT 1) RETURNING *`;
  - FTS5 `unicode61 remove_diacritics 2` ("citta" → "La città incantata").
- **Ripetizione su Node 26** (2026-11-05, host Windows, Node 26.13.0 portabile, npm 11.20.0): migrazioni, FTS5 e better-sqlite3 13.0.3 (SQLite 3.53.4) passano. Il primo passo di build della fase F0 ripete i test dentro `node:26.13.0-trixie-slim` (ADR 0001).
- [sqlite.org/wal.html](https://sqlite.org/wal.html): WAL richiede che tutti i processi stiano sullo stesso host e non funziona su file system di rete.
- Versioni verificate il 2026-11-05: better-sqlite3 13.0.3 (SQLite 3.53.4), drizzle-orm 0.45.4, drizzle-kit 0.31.11, PostgreSQL 18.6 ([versions.json](https://www.postgresql.org/versions.json)).

## Decisione

**Opzione A: SQLite in WAL con better-sqlite3 13.0.3, query e migrazioni con Drizzle ORM 0.45.4 / drizzle-kit 0.31.11.**

1. **File e apertura:**
   - `/data/db/video.db` nel volume nominato `video-db`, montato su `/data/db` (ADR 0006 §3, `DATA_DIR=/data`), mai su bind mount;
   - un'unica connessione nel processo del Video Service;
   - PRAGMA all'apertura: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`; `PRAGMA optimize` alla chiusura e ogni giorno.
2. **Migrazioni:**
   - lo schema Drizzle in `services/video/src/db/schema/` è la fonte di verità;
   - `drizzle-kit generate` produce file SQL in `services/video/migrations/`, versionati e rivisti nel diff;
   - le parti che Drizzle non esprime (tabella virtuale FTS5, trigger) vanno in migrazioni `--custom`;
   - **mai** `drizzle-kit push` né l'introspezione (`drizzle-kit pull`): non conoscono la tabella FTS5 e i trigger, e li eliminerebbero o li riscriverebbero. Lo schema cambia solo con `generate` più migrazioni `--custom`;
   - `migrate()` gira all'avvio **prima** di `listen`, dopo un backup automatico pre-migrazione;
   - una migrazione già applicata non si modifica mai;
   - le modifiche distruttive si fanno in due passi (espandi, poi contrai).
3. **Convenzioni di schema:**
   - ID `TEXT` UUIDv7 (ADR 0001);
   - tempi `INTEGER` in millisecondi UTC (doc 03 P7);
   - booleani in `INTEGER`;
   - gli enum hanno anche un `CHECK` nel DB, non solo il tipo TS;
   - JSON in colonne `TEXT` (`mode: 'json'`) solo per dati non interrogati (evidenze dei candidati, payload dei job);
   - le righe `item_field` (un valore per item, campo e sorgente, ADR 0007), la provenienza e i lock dei campi del CatalogItem (doc 01 §3.5) sono scritti **solo** dal modulo Catalog (doc 02 §4).
4. **Proiezione risolta materializzata:**
   - le colonne `title`, `original_title`, `sort_title`, `year` e `duration` di `catalog_item` contengono il valore risolto secondo la precedenza di ADR 0007;
   - il Catalog le ricalcola **nella stessa transazione** di ogni modifica alle righe `item_field` dell'item, e nella stessa transazione aggiorna la riga FTS5 di `catalog_search`;
   - liste, ordinamento, paginazione keyset e ricerca leggono solo la proiezione, mai `item_field`;
   - anche la scadenza e il purge dei valori dei provider sono operazioni del Catalog (`ExpireProviderValues`, `PurgeProviderData(provider)`), accodate dal Job Runner: nessun altro modulo scrive `item_field`, provenienza o lock, quindi proiezione e indice non possono divergere.
5. **Dati dei provider:**
   - le risposte grezze dei provider stanno **solo** nella tabella `provider_cache` del DB (provider, chiave della richiesta, corpo, `fetched_at`), mai su file;
   - il volume `video-cache` contiene solo cache **derivate e ricostruibili** (varianti delle immagini ridimensionate, output grezzo di ffprobe): cancellarlo è sempre sicuro;
   - `PurgeProviderData(tmdb)` è quindi una sequenza di `DELETE` mirate più la cancellazione dei file collegati (dettaglio in ADR 0007).
6. **Coda dei job** (nessun broker esterno):
   - tabella `job` con `type`, `payload`, `priority`, `state`, `attempts`, `run_at`, `last_error`, `idempotency_key`;
   - indice unico parziale sulla chiave di idempotenza per i job non terminali;
   - claim atomico con `UPDATE … RETURNING`;
   - `job.run_at` è l'**unica** fonte del prossimo tentativo (backoff, `Retry-After`, provider non disponibile). `identification_case` non ha un proprio `not_before`;
   - concorrenza per tipo e trigger periodici nel Job Runner (ADR 0001, regola 6);
   - all'avvio i job `running` tornano `queued` (doc 02 §7).
7. **Eventi per il polling:**
   - tabella `domain_event` con id intero monotono, che fa da cursore di `GET /video/api/v1/events?cursor=` (ADR 0004), e retention di 7 giorni;
   - un cursore più vecchio della retention riceve `CURSOR_EXPIRED` (HTTP 410), e il client si risincronizza rileggendo lo stato.
8. **Ricerca:** tabella virtuale FTS5 `catalog_search` (titolo localizzato e originale, tokenizer `unicode61 remove_diacritics 2`), aggiornata dal Catalog nella stessa transazione della modifica (punto 4).
9. **Paginazione:** keyset (chiave d'ordinamento + id), mai `OFFSET`. Il cursore opaco è codificato dall'API.
10. **Backup:**
    - job giornaliero `db.backup()` verso `/data/backup`, cioè il volume **`video-backup`**, separato da `video-db` (ADR 0006 §3);
    - `PRAGMA integrity_check` sulla copia;
    - retention di 7 giornalieri e 4 settimanali;
    - restore = fermare `video`, copiare il file nel volume, eliminare `-wal`/`-shm`, riavviare;
    - un test Vitest copre backup, riapertura e integrity check;
    - **limite noto:** su Docker Desktop `video-backup` sta nello stesso disco virtuale WSL (vhdx) di `video-db`. Il backup protegge da corruzione ed errori applicativi, **non** dalla perdita del disco. Un backup fuori dall'host avrà una sua ADR;
    - nell'MVP il backup copre **solo il database**: l'artwork caricato dal proprietario (`video-artwork`) non ha backup.
11. **Test:** ogni file di test apre un DB `:memory:` (o un file temporaneo) e applica le migrazioni reali.
12. **Writes e event loop:**
    - transazioni brevi;
    - l'inventario delle scansioni scrive a lotti di circa 500 righe per transazione;
    - si applica il criterio di accettazione sull'event loop dell'ADR 0001.

## Conseguenze

- **Più facile:**
  - nessun container `video-db`: il servizio parte con un volume;
  - backup e restore sono operazioni su file;
  - test d'integrazione veloci e senza infrastruttura;
  - lo stesso file si sposta da Windows a Linux;
  - scadenza e purge dei dati TMDB sono `DELETE` mirate in un solo modulo, con proiezione e indice di ricerca aggiornati nella stessa transazione.
- **Più difficile:**
  - un solo processo scrittore: `video-worker` futuro **non** accede al DB, coerente con la StreamDelivery serializzabile di doc 03 §8;
  - niente ricerca fuzzy integrata, perché FTS5 fa token e prefissi;
  - i `CHECK` vanno scritti a mano;
  - la proiezione materializzata va ricalcolata a ogni scrittura di `item_field`: un test verifica che coincida con la risoluzione calcolata da zero.
- **Da rivedere:**
  - quando Drizzle 1.0 diventa `latest` su npm: upgrade come attività a sé, con `drizzle-kit up` e una verifica delle migrazioni, mai con la RC;
  - se servono più istanze o più processi scrittori, oppure ricerca fuzzy: migrazione a PostgreSQL 18, per cui lo schema Drizzle e il SQL standard limitano il costo;
  - se l'event loop delay supera il criterio dell'ADR 0001;
  - con l'ADR del backup fuori dall'host (oggi backup sullo stesso disco).
- **Dipendenze:**
  - ADR 0006 §3: mount `/data/db` (`video-db`) e `/data/backup` (`video-backup`); nessun servizio `video-db`;
  - ADR 0004: cursori keyset, eventi da `domain_event`, `CURSOR_EXPIRED`;
  - ADR 0007: valori per sorgente in `item_field`, risposte dei provider in `provider_cache`, base durevole Wikidata (D5) separata dai dati TMDB, così scadenza e purge restano `DELETE` mirate;
  - ADR 0001: Job Runner scritto a mano sopra la tabella `job`.
