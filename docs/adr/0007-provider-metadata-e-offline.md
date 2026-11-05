# 0007 — Provider dei metadata (TMDB + base durevole Wikidata) e funzionamento offline

- **Stato:** Accepted (2026-11-06)
- **Data:** 2026-11-05
- **Decisore:** Claude, su delega del proprietario (review: design-reviewer, correzioni applicate)
- **Revisione:** dopo i test live TMDB di S4 (2026-11-05), che prima mancavano per la chiave. L'opzione A resta, ora con le misure. Cambiano le opzioni A e B, le Evidenze, i punti 3, 4, 6, 7 e 9 e le Conseguenze.
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
- soprattutto, il comportamento **senza chiave TMDB**: la chiave non esisteva ancora e l'MVP si costruisce stasera. La chiave è arrivata il 2026-11-05 e i test TMDB di S4 sono stati eseguiti (Evidenze); il comportamento senza chiave resta, perché la chiave può mancare o essere tolta.

## Opzioni considerate

### A. Arricchimento TMDB, identificazione e base durevole da Wikidata
- Pro:
  - è la configurazione **misurata** in S4 (v2: precision e recall 98,9% in-sample);
  - ogni item abbinato in automatico ha subito un QID CC0;
  - TMDB si aggancia per ID (in S4 94/94 item avevano l'ID TMDB su Wikidata), senza nuovi rischi di match sbagliato. Verificato con la chiave: i 95 ID TMDB presi da Wikidata rispondono tutti e sono coerenti per anno (±1) e titolo;
  - funziona identica senza chiave.
- Contro:
  - Wikidata è lento e ha limiti stretti (429, `504` sui titoli numerici);
  - la copertura dei titoli poco noti è inferiore;
  - la ricerca TMDB, usata come ripiego automatico, ha bisogno di condizioni in più della regola v2 (punto 4.3).

### B. Come A, ma con identificazione TMDB-first
- Pro:
  - ricerca veloce (p50 0,18 s) e catalogo più ampio;
  - **recupero dei candidati migliore** (S4, 2026-11-05): l'opera giusta è nella lista in 96/96 query e al primo posto in 95/96, contro 95/96 e 83/95 su Wikidata.
- Contro:
  - **misurata in S4 con la stessa regola v2, non ritarata:**
    - precision 97,7% (IC 92–99%) contro 98,9% di Wikidata. La differenza è una sola query e non è significativa;
    - recall 88,5% contro 97,9%;
    - anche con lo spareggio per voti, costruito dopo aver visto gli errori, la recall resta sotto Wikidata (95,8%);
  - il distacco di recall viene soprattutto dalla regola, non dal catalogo. TMDB ha molti omonimi poco noti (S4, Scoperte 4 e 11): 7 query perse sono omonimi con l'anno, che lo spareggio per voti recupera. Altre 2 restano in coda perché la ricerca non restituisce i titoli alternativi;
  - la condizione posta da questo ADR per passare a B ("se TMDB risulta più preciso") **non è soddisfatta**;
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
  - **test live TMDB (2026-11-05)**, sugli stessi 94 item più "2012":
    - copertura `it-IT`: trama italiana 94/94, nessuna identica a quella inglese. Il titolo è nella risposta per 94/94, ma per 37 è il titolo predefinito, senza una traduzione italiana; dove c'è, coincide con l'etichetta italiana di Wikidata in 87/91 casi. Poster in italiano 78/94 (film 65/66, serie 13/28), backdrop 94/94, logo in italiano o inglese 94/94, cast ordinato 94/94. Documentari 6/6 senza falsi positivi (Wikidata: 6/6 con 1 falso positivo);
    - episodi (28 serie, 1.529 episodi): titolo italiano 96%, trama italiana 99,5%. Wikidata ha il 65% dei titoli e nessuna trama;
    - matching con la regola v2: vedi opzione B;
    - 831 risposte senza errori (nessun 404, 429 o 5xx, nessun timeout) a ≤ 1 req/s. Latenza p50 0,18–0,21 s con la connessione riusata, 0,54 s per la ricerca aprendo una connessione nuova a ogni richiesta;
    - il testo del §1.A chiude la questione dell'artwork: è TMDB Content (punto 6).

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
   - **TMDB** (licenza): titolo e trama it-IT (fallback `en-US` per la trama, che in S4 non è servito per nessuna opera e per 8 episodi su 1.529), tagline, generi localizzati, crediti ordinati con personaggi e foto, stagioni ed episodi it-IT, poster, backdrop, logo e still (`include_image_language=it,null,en`). Per ogni tipo di immagine si sceglie nell'ordine `it → null → en`: conta soprattutto per le serie, 15/28 senza poster italiano in S4.
   - **Flag documentario:** decide Wikidata, che è durevole, così `category` non cambia alla scadenza dei dati TMDB. Il genere TMDB (99) fa da conferma: se non concorda, l'item riceve un flag di revisione, come per il lock del punto 2, e il proprietario decide con un valore `manual`. In S4 il genere TMDB è stato più preciso (6/6 senza falsi positivi contro 1), ma per un solo item: è un'evidenza debole.
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
   3. **Ricerca TMDB**, misurata in S4 (opzione B): è la **ricerca manuale** della coda "Da verificare" e il **ripiego automatico** quando Wikidata non risponde o non ha candidati (per esempio "2012", che su Wikidata va in `504`). Un auto-match di ripiego segue la regola v2, con queste condizioni in più:
      - **nome con l'anno:** se il caso è `ambiguous`, vince il candidato più votato tra quelli entro M dal migliore, purché abbia almeno 10 volte i voti del secondo (spareggio per voti, S4). Misurato solo in-sample: recupera i 7 omonimi poco noti senza errori nuovi;
      - **nome senza l'anno:** l'unicità di D6 si verifica su Wikidata, non sui primi risultati TMDB. Su TMDB i primi 10 nascondono omonimi ("Up": un solo film tra i primi 10 di 7.473 risultati, un secondo "Up" su Wikidata);
      - **titolo esatto poco votato:** se un candidato con il titolo esatto ha molti meno voti di un candidato dello stesso anno con un titolo simile, il caso va in coda. È l'errore di "Il Professore (2019)", che nessuna delle altre condizioni evita; la soglia del rapporto si fissa in implementazione;
      - **titoli alternativi** (`alternative_titles`) per i casi `low_score`: la ricerca non restituisce gli alias, che su Wikidata salvavano "Star Wars Episodio IV" e "Le Mans 66".

      Sono regole costruite dopo aver visto gli errori: vanno nelle fixture di test e si ritarano con la libreria reale.
   - I dati dei candidati presi da TMDB e salvati nell'IdentificationCase (titoli, anni, `vote_count`) sono TMDB Content: scadono e si cancellano con gli altri valori TMDB (punto 5).
   - **Implementazione** (ADR 0001):
     - il parser a regole di S4 (`spikes/s4-identification/rules.py`) si **riscrive a mano** in TypeScript;
     - la normalizzazione dei titoli non deve cancellare le lettere non latine: lo spike riduce a "1917" un titolo in cirillico che contiene quel numero e crea un falso omonimo (S4, Scoperta 13). Si corregge con una normalizzazione Unicode **prima** di congelare le fixture di parità, altrimenti il test fissa l'errore nel prodotto;
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
     - Person e Credit di sorgente `tmdb`;
     - i dati TMDB dei candidati negli IdentificationCase (titoli, anni, voti). Il caso resta, con i punteggi e i candidati Wikidata.

     Anche `ExpireProviderValues` tratta i dati TMDB dei candidati come gli altri valori TMDB.

     Restano gli ID numerici TMDB in `external_id` (punto 3, interpretazione da ricontrollare), i valori `manual` e Wikidata, gli ID dal filename, i MediaLink e lo stato di visione.
6. **Artwork TMDB = TMDB Content.** Il §1.A definisce TMDB Content come "any content (including audio or visual content) or other information available through, on, or from the TMDB APIs or TMDB": un poster scaricato dal CDN di TMDB è contenuto visivo ottenuto da TMDB, e nessuna fonte TMDB esclude le immagini (S4, Q3, "Conflitto"). Quindi:
   - copia locale ammessa, **riscaricata** a ogni refresh e cancellata a scadenza o al purge;
   - **nessuna ricodifica o ridimensionamento** (§1.C, derivati): le varianti si scaricano già pronte dalle taglie del CDN TMDB (`w342`/`w780` poster, `w1280` backdrop, `w300` still, `w185` persone; i loghi arrivano fino a `w500`). Le taglie le dichiara `/configuration`: l'adapter le legge da lì e non le dà per scontate;
   - **ordine di download:** prima poster e backdrop, che servono alla Home; poi, a priorità bassa, logo, still e foto dei primi 10 del cast e del regista. Le altre foto delle persone (mediana del cast in S4: 64 persone) si scaricano solo quando un client le chiede;
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
   - **Una connessione persistente per host** (keep-alive): in S4 una ricerca TMDB costa 0,18 s (p50) con la connessione riusata e 0,54 s aprendone una nuova. Con queste latenze bastano circa 4 richieste in parallelo per arrivare a 20 req/s. In S4 nessun 429 su 831 risposte, ma a ≤ 1 req/s: il limite di 20 req/s resta da osservare in esercizio.
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
   - Dal 2026-11-05 la chiave è nel `.env` della macchina di sviluppo, quindi l'MVP gira con TMDB configurato. Il percorso senza chiave resta un requisito e ha i suoi test.
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
  - **con la chiave, il backfill TMDB si aggiunge all'ingest Wikidata**, non la sostituisce, perché l'identificazione resta su Wikidata. Stima da S4, non misurata su una libreria vera:
    - le chiamate API per dettagli e crediti (circa 4.000 per 2.000 film) richiedono 3–4 minuti a 20 req/s;
    - le immagini, a 10 req/s, pesano di più: con circa 14 immagini per film (poster, backdrop, logo, primi 10 del cast) sono circa 47 minuti. Per questo le foto oltre i primi 10 si scaricano solo su richiesta (punto 6);
    - le serie aggiungono una richiesta per stagione e uno still per episodio;
  - il parser e i punteggi portati a mano vanno tenuti allineati alle fixture di parità;
  - la ricerca TMDB di ripiego ha più regole della ricerca Wikidata (punto 4.3), e quelle regole sono tarate solo in-sample.
- **Da rivedere:**
  - ~~appena c'è la chiave: misurare la qualità `it-IT` e la precision su TMDB, e passare all'opzione B se TMDB risulta più preciso.~~ **Fatto il 2026-11-05** (S4, "Test live TMDB"): TMDB non è più preciso, l'opzione A resta. Si riapre se, sulla libreria reale, la regola con lo spareggio per voti supera Wikidata in precision **e** recall;
  - **con la libreria reale:** ritarare lo spareggio per voti e il rapporto del "titolo esatto poco votato" (punto 4.3);
  - **alla progettazione del resolver AI**: rileggere il §1.C;
  - **a ogni nuova versione dei termini TMDB**: la data di riferimento è il 2023-10-20. Va ricontrollata anche l'interpretazione sulla conservazione degli ID numerici TMDB (punto 3).
- **Dipendenze:**
  - ADR 0006 (`.env`, volumi `video-cache` e `video-artwork`, attivazione al riavvio);
  - ADR 0002 (`item_field` per sorgente, proiezione materializzata, `provider_cache`, `job.run_at` come unico prossimo tentativo);
  - ADR 0001 (`fetch` nativo, token bucket per host scritto a mano, parser e matcher portati da S4, sharp solo per le immagini non TMDB);
  - ADR 0004 (stati `not_configured`/`provider_unavailable`, `PurgeProviderData`, provenienza per campo, `Cache-Control` delle immagini TMDB);
  - ADR sulle thumbnail (numero da assegnare): niente ricodifica delle immagini TMDB;
  - [ADR 0005](0005-web-client-react-vite.md) (web client) e ADR del client TV: pagina "Informazioni", segnaposto, avanzamento dell'ingest, "fissa come valore manuale".
- **Input del proprietario:**
  - la chiave TMDB (account personale): **fornita il 2026-11-05**, solo nel `.env` gitignorato;
  - contatto per `WIKIDATA_CONTACT`: per default è l'URL pubblico del repository (`https://github.com/soulsofarmony/pezzotflix`, già nella configurazione e raggiungibile il 2026-11-05). La politica Wikimedia accetta un URL; il proprietario può impostare un altro contatto nel `.env`.
- **Dati TMDB dello spike:** `spikes/s4-identification/out/` contiene risposte TMDB (gitignorate) e va cancellata entro il **2027-05-05** (§1.C, 6 mesi).
