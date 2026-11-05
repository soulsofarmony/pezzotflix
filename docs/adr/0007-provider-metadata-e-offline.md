# 0007 — Provider dei metadata (TMDB + base durevole Wikidata) e funzionamento offline

- **Stato:** Accepted (2026-11-06)
- **Data:** 2026-11-05
- **Decisore:** Claude, su delega del proprietario (review: design-reviewer, correzioni applicate)
- **Requisiti collegati:** §11 (ingest automatic-first), §12 (metadata locali, nessuna dipendenza permanente dall'API esterna), §13 (correzioni manuali), §16 (navigazione in italiano); doc 01 §3.5–3.7, D1, D5, D6; doc 02 §3.3–3.5, §3.7, §7; doc 03 §6, §8
- **Valutazione completa:** [05 — §5 Provider dei metadata e funzionamento offline](../architecture/05-technology-evaluation.md#5-provider-dei-metadata-e-funzionamento-offline)

## Contesto

La decisione D5 del proprietario è fissata:
- TMDB è il provider principale, con refresh entro i 6 mesi dei termini;
- Wikidata (CC0) fa da base durevole, conservata indefinitamente;
- i dati TMDB si cancellano alla cessazione della licenza.

Restano da decidere:
- il contratto dell'adapter;
- la ripartizione dei campi tra le sorgenti;
- refresh e scadenza;
- rate limit e `Retry-After`;
- lo stato legale dell'artwork scaricato;
- l'attribuzione;
- il caso, lasciato aperto da D5, di TMDB irraggiungibile per oltre 6 mesi con la licenza attiva;
- soprattutto, il comportamento **senza chiave TMDB**: la chiave non esiste ancora e l'MVP si costruisce stasera.

## Opzioni considerate

### A. Arricchimento TMDB, identificazione e base durevole da Wikidata
- Pro:
  - è la configurazione **misurata** in S4 (v2: precision e recall 98,9% in-sample);
  - ogni item abbinato in automatico ha subito un QID CC0;
  - TMDB si aggancia per ID (in S4 94/94 item avevano l'ID TMDB su Wikidata), senza nuovi rischi di match sbagliato;
  - funziona identica senza chiave.
- Contro:
  - Wikidata è lento e ha limiti stretti (429, `504` sui titoli numerici);
  - la copertura dei titoli poco noti è inferiore;
  - l'identificazione da TMDB resta un fallback non misurato.

### B. Come A, ma con identificazione TMDB-first
- Pro: ricerca veloce e interattiva, catalogo più ampio.
- Contro:
  - soglie non misurate;
  - TMDB ha molti omonimi oscuri (S4, Scoperta 4);
  - senza chiave servirebbe comunque il percorso Wikidata, quindi due percorsi da mantenere.

### C. Solo TMDB
- Contro: alla cessazione (§1.D) la libreria perde titoli e anni. Viola §12 e D5, e non funziona stasera.

### D. Solo Wikidata
- Contro: niente trame, niente poster, episodi italiani scarsi (S4). Va bene come modalità degradata, non come obiettivo.

## Evidenze

- **Termini TMDB** ([API Terms of Use](https://www.themoviedb.org/api-terms-of-use), versione del 2023-10-20, riletti il 2026-11-05):
  - §1.A: TMDB Content include "audio or visual content";
  - §1.C: cache non oltre 6 mesi, niente derivati, niente uso con applicazioni ML/AI;
  - §1.D: purge di tutto il TMDB Content, cache inclusa;
  - §3: logo e avviso.
- **[FAQ TMDB](https://developer.themoviedb.org/docs/faq):** attribuzione di "data and/or images" nella sezione "About" o "Credits". **Staff TMDB** ([forum](https://www.themoviedb.org/talk/5ba32c77925141523700e0c9)): "you can cache data on your end".
- **[Rate limit TMDB](https://developer.themoviedb.org/docs/rate-limiting):** circa 40 req/s, variabile.
- **[Rate limit Wikimedia 2026](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)** (pagina del 2026-10-15): 10 req/min senza User-Agent identificativo, **200 req/min** con un User-Agent conforme che contiene un contatto; `Retry-After` va rispettato, altrimenti si attendono almeno 5 s con backoff. È la spiegazione più probabile dei 429 dello spike S4.
- **[S4](../spikes/S4-identification.md):**
  - copertura Wikidata: etichette IT 97%, ID TMDB e IMDb 94/94, flag documentario 6/6, nessuna trama, poster quasi assenti;
  - regola di matching v2;
  - `504` su "2012";
  - test TMDB bloccati per la chiave mancante.

## Decisione

**Opzione A.**

1. **Contratto dell'adapter.** Estende `MetadataProvider` del doc 03 §8 con:
   - `status()`: `not_configured | ok | degraded | invalid_credentials`;
   - `terms()`: conservazione `durable` o `max_age(giorni)`, attribuzione, purge alla cessazione;
   - `lookupByExternalId()`: il ponte QID ↔ TMDB ↔ IMDb;
   - `fetchImage(ref, size)`.

   I risultati sono tipizzati (`Ok | NotFound | RateLimited(retry_after) | Unavailable | InvalidRequest`). Nessun tipo del provider esce dall'adapter. Il registro contiene solo i provider configurati.
2. **Memorizzazione per sorgente.**
   - Si salva un valore per (item, campo, sorgente) con `fetched_at`, nella tabella `item_field` (ADR 0002).
   - Il valore mostrato segue la precedenza `manual > tmdb (non scaduto) > wikidata > filename`. Eccezione: il titolo originale usa prima Wikidata.
   - Solo il Catalog scrive `item_field`, provenienza e lock, e ricalcola nella stessa transazione la proiezione risolta di `catalog_item` e la riga di ricerca (ADR 0002, punto 4). Scadenza e purge sono operazioni del Catalog, `ExpireProviderValues` e `PurgeProviderData(provider)`, accodate dal Job Runner: si riducono a cancellare le righe `tmdb`.
   - **Le risposte grezze dei provider** stanno solo nella tabella `provider_cache` del DB (TTL 30 giorni per Wikidata, 24 ore per TMDB). Il volume `video-cache` contiene solo derivati ricostruibili (ADR 0006).
   - **Solo `manual` è durevole.** Un campo modificato dal proprietario è `manual` e resta per sempre.
   - **Lock su un valore TMDB non modificato** = "tieni TMDB come sorgente scelta per questo campo":
     - il refresh lo riscarica comunque (i termini impongono di rinnovarlo);
     - se il valore nuovo è diverso, il valore mostrato non cambia da solo: l'item riceve un flag di revisione e il proprietario decide;
     - se i valori TMDB scadono senza refresh (TMDB irraggiungibile, token rimosso), il campo ricade sulla sorgente successiva e la UI lo segnala come "lock senza valore TMDB";
     - per rendere durevole un valore, la UI offre **"fissa come valore manuale"**, che lo copia in una riga `source=manual`.
3. **Ripartizione dei campi:**
   - **Wikidata** (durevole): QID e ID esterni (`P4947` film TMDB, `P4983` serie TMDB, `P345` IMDb, `P4835` serie TheTVDB), titolo IT/EN e originale (`P1476`), alias, anno (`P577`), kind, flag documentario, generi, durata, regista e cast non ordinato.
   - **TMDB** (licenza): titolo e trama it-IT (fallback `en-US` per la trama), tagline, generi localizzati, crediti ordinati con personaggi e foto, stagioni ed episodi it-IT, poster, backdrop, logo e still (`include_image_language=it,null,en`).
   - Un ID TMDB letto su Wikidata è dato CC0. Un ID scritto nel filename (tag `{tmdb-…}`) è contenuto del proprietario ed è durevole.
   - Gli ID numerici TMDB in `external_id` si **conservano** anche quando sono stati ottenuti solo da TMDB, e anche dopo scadenza o purge: sono identificatori, servono per riabbinare l'item, e non sono contenuto descrittivo. È una **interpretazione** dei termini (§1.A, §1.D): va ricontrollata a ogni nuova versione dei termini, e se i termini dicessero il contrario il purge li cancella.
4. **Identificazione:**
   1. **Passo "tag ID"**, prima di ogni matching fuzzy ([standard di libreria](../library-standard.md) §3):
      - si leggono dal filename i tag `{tmdb-…}`, `{imdb-tt…}` e, per le serie, `{tvdb-…}`;
      - lo spazio dei nomi dell'ID TMDB (film o serie) segue il tipo dell'item: un ID di serie dentro `Film/` dà `id_mismatch`;
      - titolo e anno del file devono essere coerenti con l'opera dell'ID (soglia per sottoinsieme di parole, anno ±1), altrimenti `id_mismatch`; se l'opera dell'ID è di un tipo diverso da quello atteso, `kind_mismatch`;
      - **senza chiave TMDB** l'ID si risolve su Wikidata con `haswbstatement`: `P4947` (film TMDB), `P4983` (serie TMDB), `P345` (IMDb), `P4835` (serie TheTVDB);
      - un ID preso dal filename è contenuto del proprietario ed è **durevole**, come un valore `manual`.
   2. **Matching fuzzy** Wikidata-first (S4 v2, T 0,80, M 0,10; D6 per i titoli senza anno), con l'arricchimento TMDB per ID.
   3. La ricerca TMDB fa da fallback, e da ricerca manuale della coda, con soglie prudenti finché non è misurata.
   - **Implementazione** (ADR 0001):
     - il parser a regole di S4 (`spikes/s4-identification/rules.py`) si **riscrive a mano** in TypeScript;
     - `ratio` e `token_sort_ratio` compatibili con rapidfuzz (distanza Indel normalizzata) si scrivono a mano: poche righe, nessuna dipendenza;
     - un **test di parità** confronta parser e punteggi con gli output di rapidfuzz e dello spike sul corpus S4 e sul holdout, salvati come fixture JSON versionate (solo testo: nomi di file e punteggi, nessun media);
     - le soglie T 0,80 e M 0,10 restano invariate.
   - Un provider che fallisce lascia il caso `pending`, mai `needs_review`; il prossimo tentativo è il `run_at` del job (ADR 0002).
5. **Refresh e scadenza:**
   - refresh TMDB dopo `TMDB_REFRESH_AFTER_DAYS` (**90**, con jitter);
   - **scadenza rigida a 180 giorni** (`TMDB_MAX_AGE_DAYS`, solo al ribasso): un job giornaliero esegue `ExpireProviderValues` nel Catalog, che cancella valori, artwork, crediti e righe di `provider_cache` TMDB scaduti. **Chiude il caso aperto di D5**: con TMDB irraggiungibile oltre 6 mesi i dati scadono comunque e l'item ricade su Wikidata e filename;
   - refresh Wikidata ogni 180 giorni e su richiesta;
   - comando di gestione `PurgeProviderData(tmdb)`, operazione del Catalog, idempotente, per la cessazione della licenza. Togliere il token ferma i refresh, ma non è un purge. Il purge cancella:
     - le righe `item_field` con `source=tmdb`, anche se lockate;
     - le righe di `provider_cache` di `tmdb`;
     - le righe di artwork con sorgente `tmdb`, con i loro file in `video-artwork` e le eventuali varianti in `video-cache`;
     - Person e Credit di sorgente `tmdb`.

     Restano gli ID numerici TMDB in `external_id` (punto 3, interpretazione da ricontrollare), i valori `manual` e Wikidata, gli ID dal filename, i MediaLink e lo stato di visione.
6. **Artwork TMDB = TMDB Content** (lettura più difendibile del §1.A):
   - copia locale ammessa, **riscaricata** a ogni refresh e cancellata a scadenza o al purge;
   - **nessuna ricodifica o ridimensionamento** (§1.C, derivati): le varianti si scaricano già pronte dalle taglie del CDN TMDB (`w342`/`w780` poster, `w1280` backdrop, `w300` still, `w185` persone);
   - gli upload del proprietario e i frame generati dal video non sono TMDB Content e restano;
   - i client non fanno mai hotlinking a TMDB (P1).
7. **Rate limiting** (per host, nell'adapter):

   | Host | Limite | Concorrenza |
   |---|---|---|
   | TMDB API | 20 req/s | 4 |
   | TMDB immagini | 10 req/s | 4 |
   | Wikidata Action/REST | 1 req/s | 1 |
   | WDQS | 1 query alla volta, batch di QID, timeout 60 s | 1 |

   - Su `429`/`503` si rispetta `Retry-After` (secondi o data, tetto 10 min) **per tutto l'host**; se manca, backoff esponenziale da 5 s a 5 min con jitter.
   - Circuit breaker dopo 5 fallimenti consecutivi.
   - Se una singola query fallisce più volte, si cambia strategia: per Wikidata, etichetta esatta con anno.
   - User-Agent `Pezzotflix/<versione> (<WIKIDATA_CONTACT>)`. Senza contatto, il limite scende a 10 req/min con un avviso.
8. **Attribuzione:**
   - pagina "Informazioni / Crediti" con il logo TMDB ufficiale non modificato e l'avviso testuale invariato del §3 ("This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB."), seguito dalla traduzione italiana;
   - la pagina si mostra quando TMDB è configurato o quando ci sono dati `tmdb`;
   - in più, "Dati da Wikidata (CC0)";
   - la provenienza per campo è visibile nella gestione.
9. **MVP senza chiave:**
   - con `TMDB_READ_TOKEN` assente, il provider `tmdb` è `not_configured`, senza errori né retry;
   - identificazione e metadata vengono solo da Wikidata;
   - copertine segnaposto generate dal client, upload manuale disponibile, trame vuote.
   - **Quando il token compare nel `.env`**, al successivo `docker compose up -d` (ADR 0006):
     1. il servizio valida il token;
     2. registra il provider;
     3. riconosce il cambio dell'impronta dei provider e accoda un **backfill**: per ID TMDB dove Wikidata lo fornisce, altrimenti con una ricerca vincolata a titolo e anno noti, più un nuovo tentativo sui casi "Da verificare".
   - Il backfill **non cambia mai un MediaLink esistente**.
10. **Vincoli derivati dai termini:**
    - un futuro resolver AI (§11) non riceve TMDB Content;
    - nessuna risposta TMDB registrata va nel repository: le fixture dell'adapter sono sintetiche;
    - la chiave è personale e non va distribuita.

## Conseguenze

- **Più facile:**
  - l'MVP funziona stasera nella configurazione misurata in S4;
  - la perdita di TMDB (scadenza, purge, provider sparito) è un'operazione meccanica e verificabile, con un ripiego automatico su Wikidata;
  - aggiungere TheTVDB o un altro provider significa un adapter in più con i suoi `terms()`.
- **Più difficile:**
  - lo schema conserva più valori per campo;
  - senza TMDB la UI ha bisogno di buoni segnaposto;
  - un poster può sparire dopo 180 giorni se TMDB resta irraggiungibile, perché è il prezzo dei termini;
  - le varianti delle immagini TMDB sono vincolate alle taglie del CDN;
  - un lock su un valore TMDB non lo rende durevole: serve "fissa come valore manuale", e la UI deve spiegarlo;
  - **la prima ingest via Wikidata è lenta:** circa 3 richieste per item a 1 req/s, quindi circa **1,7 ore per 2000 item**. La UI mostra l'avanzamento dell'ingest;
  - il parser e i punteggi portati a mano vanno tenuti allineati alle fixture di parità.
- **Da rivedere:**
  - **appena c'è la chiave**: eseguire `tmdb_probe.py` e `match_eval.py --provider tmdb` (S4) per misurare la qualità `it-IT` e la precision su TMDB. Se TMDB risulta più preciso, si passa all'opzione B (identificazione TMDB-first), con Wikidata agganciato via `haswbstatement:P4947`;
  - **alla progettazione del resolver AI**: rileggere il §1.C;
  - **a ogni nuova versione dei termini TMDB**: la data di riferimento è il 2023-10-20. Va ricontrollata anche l'interpretazione sulla conservazione degli ID numerici TMDB (punto 3).
- **Dipendenze:**
  - ADR 0006 (`.env`, volumi `video-cache` e `video-artwork`, attivazione al riavvio);
  - ADR 0002 (`item_field` per sorgente, proiezione materializzata, `provider_cache`, `job.run_at` come unico prossimo tentativo);
  - ADR 0001 (`fetch` nativo, token bucket per host scritto a mano, parser e matcher portati da S4, sharp solo per le immagini non TMDB);
  - ADR 0004 (stati `not_configured`/`provider_unavailable`, `PurgeProviderData`, provenienza per campo, `Cache-Control` delle immagini TMDB);
  - ADR sulle thumbnail (numero da assegnare): niente ricodifica delle immagini TMDB;
  - ADR 0005 (web client, riservata) e ADR del client TV: pagina "Informazioni", segnaposto, avanzamento dell'ingest, "fissa come valore manuale".
- **Input del proprietario ancora pendenti:**
  - la chiave TMDB (account personale);
  - un contatto (email o URL) per `WIKIDATA_CONTACT`.
