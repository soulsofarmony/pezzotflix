# S4 — Identificazione da filename e metadata provider in `it-IT`

- **Stato:** Completato (2026-11-04); decisioni del proprietario del 2026-11-05 nelle conclusioni, punto 6. **Test live su TMDB eseguiti il 2026-11-05** con il token del proprietario (sezione "Test live TMDB"): nessuna parte resta bloccata.
- **Domanda:** quanto bene si ricava l'identità di un contenuto da path e filename di una libreria italiana di remux? Quale regola di confidenza separa il match automatico dalla coda "Da verificare"? Quale provider di metadata copre bene l'`it-IT` ed è usabile da un'app privata self-hosted con cache locale?
- **Alimenta:**
  - doc 01 §3.2, §3.3, §3.5, §4.4, §5, D4 (MediaLink, IdentificationCase, ExternalSubtitle);
  - doc 02 §3.3–3.5 (Identifier, Metadata Provider Adapter, Enricher);
  - doc 03 (sottotitoli sidecar, coda "Da verificare");
  - ADR 0007 (provider dei metadata e funzionamento offline), da rivedere con i test live TMDB; ADR futuri sul parser.
- **Codice:** `spikes/s4-identification/`, throwaway:
  - corpus: `corpus.json`, `holdout.json`;
  - parsing: `rules.py`, `parse_eval.py`;
  - matching: `match_eval.py`, `truth_wikidata.json`, `fixtures/candidates_wikidata.json`;
  - matching su TMDB: `build_truth_tmdb.py` → `truth_tmdb.json`, `compare_eval.py` (Wikidata e TMDB affiancati);
  - provider: `wd_sparql.py`, `tmdb_probe.py`;
  - standard di libreria: `check_standard.py`.

## Setup

- Windows 11, Python 3.12.3, venv in `spikes/s4-identification/.venv`. Librerie: **guessit 4.4.0** (rebulk 6.0.1), **parsett 1.8.5** (PTT), rapidfuzz 3.14.6 (`requirements.txt`).
- **Corpus** (`corpus.json`, 131 voci): path relativi alla LibraryRoot, **solo nomi**, nessun media. Ogni voce ha la root (`movies` / `series` / `mixed`) e il parse atteso:
  - kind, titolo con le alternative accettate, anno;
  - stagione ed episodi;
  - edition e parte (disco);
  - per gli extra: tipo e item padre;
  - per i sidecar: lingua, forced, SDH.
- Il corpus include i 10 nomi delle fixture di S1 in `media-samples/library/`: Blade Runner 2049 con `extras/Trailer.mkv`, Dune, Il Buono il Brutto il Cattivo, Long Test, `misc/BDMV_DISC1_t00.mkv`, Oppenheimer, Dark S01E01 con il sidecar `.it.forced.srt`, Dark S01E02-E03.
- Le 16 categorie del corpus:
  - film con anno e film senza anno;
  - trappole: titoli numerici ("1917", "2012", "2001 Odissea…"), "Episodio IV", titolo italiano nella cartella e originale nel file;
  - edition, anche italiane ("Versione Integrale", "Versione estesa");
  - multi-disco e dump MakeMKV;
  - serie: `S01E02`, `1x02`, "Stagione 1/Episodio 2", multi-episodio, speciali S00;
  - extra: cartelle, suffissi Plex, nomi italiani;
  - documentari, sidecar, ambigui;
  - junk: sample, `@eaDir`, `$RECYCLE.BIN`, `test.mkv`.
- **Holdout** (`holdout.json`, 28 voci): scritto **dopo** aver congelato `rules.py` e mai usato per correggerlo. Misura quanto il parser a regole è sovra-adattato al corpus (vedi Limiti per i suoi limiti).
- **Approcci di parsing:**
  - `guessit`: path completo, con il tipo suggerito dalla root (`movie` / `episode`);
  - `parsett`: solo basename, campi mancanti completati dalle cartelle superiori;
  - `rules`: parser scritto a mano sulle convenzioni di cartella (311 righe);
  - `hybrid`: struttura da `rules`, tokenizzazione dei nomi con guessit.
- **Matching:**
  - i candidati vengono da **Wikidata** (senza chiave): ricerca full-text sugli item con un ID TMDB (`haswbstatement:P4947|P4983`), poi dettagli in batch via SPARQL;
  - lo snapshot congelato dei candidati è tracciato in `fixtures/candidates_wikidata.json` (circa 220 KB): solo nomi, ID Wikidata/TMDB e anni, nell'ordine del provider. Sono dati CC0, e `match_eval.py eval` li usa di default;
  - la ground truth (`truth_wikidata.json`) è etichettata a mano da una persona.
- **TMDB** (test live del 2026-11-05, Python 3.12.10 sul portatile di sviluppo, Windows 11):
  - API v3 con il Read Access Token v4 del proprietario (`Authorization: Bearer`), letto da `.env` alla radice (ignorato da git). Il token Bearer viaggia nell'header e non viene mai stampato né scritto: il log degli errori registra l'URL senza query string, la cache usa un hash come nome di file. Il ripiego `TMDB_API_KEY` (chiave v3, non usato in questi test) mette invece la chiave nella query string, e un errore HTTP la riportava nel messaggio dell'eccezione: dal 2026-11-05 `match_eval.py` la sostituisce con `api_key=REDACTED` in ogni errore di `requests`;
  - **al massimo 1 richiesta/s**, una alla volta (pausa di 1 s dopo ogni richiesta), contro i 20 req/s concessi dall'ADR 0007;
  - connessione riusata (`--keepalive`), come farebbe un client di prodotto. Una seconda esecuzione delle ricerche apre una connessione nuova per ogni richiesta, per misurarne il costo;
  - le risposte TMDB restano solo in `out/` (ignorato da git). Nessuna fixture TMDB è tracciata (ADR 0007 punto 10, termini §1.C) e `match_eval.py dump --provider tmdb --freeze` viene rifiutato;
  - ⚠️ **scadenza: cancellare tutta `spikes/s4-identification/out/` entro il 2027-05-05** (6 mesi, termini TMDB §1.C). Il TMDB Content non sta solo in `out/cache/`: titoli, titoli originali, generi, `popularity` e `vote_count` sono anche in `candidates_tmdb*.json`, `tmdb_probe*.json`, `match_tmdb_v2.json` e `compare_eval.json`. I file `match_wikidata_*.json` si rigenerano offline dai file tracciati.
- **Ricostruzione:** `cd spikes/s4-identification && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && .venv/Scripts/python parse_eval.py corpus.json holdout.json && .venv/Scripts/python match_eval.py eval --v1 && .venv/Scripts/python match_eval.py eval --scorer filter && .venv/Scripts/python match_eval.py eval --scorer penalty && .venv/Scripts/python match_eval.py eval && .venv/Scripts/python wd_sparql.py && .venv/Scripts/python build_truth_tmdb.py && .venv/Scripts/python tmdb_probe.py --fresh --keepalive && .venv/Scripts/python match_eval.py dump --provider tmdb --fresh --keepalive && .venv/Scripts/python match_eval.py eval --provider tmdb --live && .venv/Scripts/python compare_eval.py --what-if`
  - Parsing e matching su Wikidata girano **offline** dai file tracciati. I risultati vanno in `out/match_wikidata_<v1|filter|penalty|v2>.json`.
  - `wd_sparql.py` e `match_eval.py dump --freeze` (che rigenera lo snapshot) interrogano Wikidata. Le risposte restano in cache in `out/cache/`, che è ignorato da git: sono offline solo sulla stessa macchina, e altrove i dati di Wikidata possono essere cambiati.
  - `build_truth_tmdb.py` gira offline. `tmdb_probe.py` e `match_eval.py dump --provider tmdb` richiedono `TMDB_READ_TOKEN` (o `TMDB_API_KEY`) e senza escono con `BLOCKED`. `--fresh` ignora la cache per rimisurare la latenza. `match_eval.py eval --provider tmdb --live` e `compare_eval.py` leggono `out/candidates_tmdb.json`, quindi senza chiave funzionano solo sulla stessa macchina. Risultati in `out/tmdb_probe.json`, `out/match_tmdb_v2.json` e `out/compare_eval.json`.
  - Ricerche senza riuso della connessione: `match_eval.py dump --provider tmdb --fresh` (sovrascrive `out/candidates_tmdb.json`). Da ora `dump --provider tmdb` salva latenza e stati HTTP delle ricerche in `out/tmdb_search_latency_<keepalive|cold>.json`; nelle esecuzioni del 2026-11-05 non esisteva ancora (vedi "Latenza ed errori").
  - `out/tmdb_probe_latency_run1.json`, `out/candidates_tmdb_run1_keepalive.json` e `out/candidates_tmdb_run2_cold.json` sono copie fatte a mano dopo le singole esecuzioni: il comando di ricostruzione non li produce.
  - `match_eval.py label` mostra i candidati **senza punteggi**, per rietichettare.

## Risultati

### Q1 — Parsing di path e filename

Accuratezza per campo sul **corpus** (131 voci). Un campo conta solo dove il parse atteso lo definisce. Il confronto ignora maiuscole, accenti e punteggiatura.

| Campo | n | guessit | parsett | rules | hybrid |
|---|---|---|---|---|---|
| kind | 131 | 92% | 88% | 100% | 100% |
| titolo | 104 | 91% | 89% | 100% | 96% |
| anno | 104 | 100% | 100% | 100% | 100% |
| stagione | 31 | 90% | 77% | 100% | 100% |
| episodi | 31 | 94% | 97% | 100% | 100% |
| edition | 73 | 89% | 84% | 100% | 100% |
| parte (disco) | 5 | 20% | 0% | 100% | 100% |
| tipo di extra | 13 | 23% | 23% | 100% | 100% |
| item padre dell'extra | 13 | 54% | 8% | 100% | 92% |
| sidecar: lingua / forced / SDH | 9 | 67% / 78% / 78% | 78% / 100% / 78% | 100% | 100% |
| **voce interamente corretta** | 131 | **67%** | **59%** | **100%** | **96%** |
| ms per path | | 13,2 | 2,4 | 0,09 | 8,7 |

Sull'**holdout** (28 voci, mai viste dal parser a regole). Tra parentesi quadre l'intervallo di confidenza al 95% (Wilson):

| | guessit | parsett | rules | hybrid |
|---|---|---|---|---|
| voce interamente corretta | 18/28 (**64%** [46–79]) | 16/28 (**57%** [39–73]) | 25/28 (**89%** [73–96]) | 23/28 (**82%** [64–92]) |
| titolo / anno | 86% / 100% | 91% / 100% | 91% / 100% | 86% / 100% |
| stagione / episodi | 100% / 100% | 71% / 86% | 86% / 86% | 86% / 86% |

Voci interamente corrette per categoria, sul corpus:

| Categoria | n | guessit | parsett | rules | hybrid |
|---|---|---|---|---|---|
| fixture S1 | 10 | 8 | 7 | 10 | 10 |
| film con anno / trappole / senza anno | 12 / 10 / 6 | 11 / 8 / 6 | 12 / 9 / 6 | 12 / 10 / 6 | 12 / 9 / 6 |
| edition | 15 | 7 | 4 | 15 | 14 |
| multi-disco e dump MakeMKV | 8 | 2 | 0 | 8 | 8 |
| serie `SxxEyy` / `1x02` / multi-episodio / speciali | 10 / 4 / 4 / 3 | 10 / 4 / 3 / 2 | 10 / 4 / 3 / 2 | 10 / 4 / 4 / 3 | 10 / 4 / 4 / 3 |
| serie con nomi italiani ("Stagione", "Episodio") | 5 | 3 | 0 | 5 | 4 |
| extra | 12 | 2 | 0 | 12 | 11 |
| documentari | 6 | 6 | 5 | 6 | 5 |
| sidecar | 8 | 4 | 5 | 8 | 8 |
| ambigui | 10 | 10 | 10 | 10 | 10 |
| junk | 8 | 2 | 0 | 8 | 8 |

**Classi di errore** (da `out/failures_*.txt`):

| Classe | Esempio | Chi sbaglia |
|---|---|---|
| **Convenzioni di libreria sconosciute**: extra (cartelle `featurettes/`, `Behind The Scenes/`, `Contenuti speciali/`, suffissi `-trailer` / `-deleted`), cartelle di sistema, nomi da dump | `Dune (2021)/featurettes/Inside the Desert.mkv` → film "Inside the Desert"; `@eaDir/…`, `$RECYCLE.BIN/…` → film | guessit, parsett |
| **Nomi senza identità trasformati in titoli** | `BDMV_DISC1_t00` → titolo "BDMV DISC1 t00"; `test.mkv` → "test"; `00001.m2ts` → "00001" | guessit, parsett; `rules` sull'holdout per `MOVIE_t02` |
| **" - " letto come titolo alternativo** | "Il Signore degli Anelli - La Compagnia dell'Anello" → "Il Signore degli Anelli"; "Il Padrino - Parte II" → "Il Padrino"; "Star Wars Episodio IV - Una nuova speranza" → "Star Wars Episodio IV" | guessit, hybrid |
| **Edition non riconosciute** | "Final Cut", "Assembly Cut", "Black and Chrome", "Black & White", "Director's Definitive Cut", "Versione Integrale" / "Versione estesa", sintassi Plex `{edition-Ultimate Cut}` | guessit, parsett; `rules` solo la sintassi Plex (holdout) |
| **Anno della cartella preso come stagione** | `Band of Brothers (2001)/…Episodio 1…` → stagione 2001; `Il Trono di Spade (2011)/Speciali/Episodio 2.mkv` → stagione 2011 | guessit |
| **Lessico italiano delle serie** | `Stagione 2/Episodio 05.mkv`, `Romanzo Criminale - Stagione 1 - Episodio 2`, `Puntata 3` | parsett; `rules` solo "Puntata" (holdout) |
| **Sidecar**: flag e lingue | `.eng.hi.srt` → lingua *hindi*; `.ita.forced.srt` → "forced" come release group; `.sdh` ignorato | guessit |
| **Parte del disco** | `Disc 1`, `BDMV_DISC2_t01`, `pt1` non riconosciuti | guessit, parsett |
| **Titolo con anno nel nome** | "Blade Runner 2049 (2017)" → titolo "Blade Runner", anno 2049 (primo bug di `rules`, corretto prima del freeze) | `rules` (corretto) |

### Q2 — Matching e confidenza

Le query vengono dal parse di `rules` su corpus + holdout: un film = una query, una serie = una query per tutti i suoi episodi. Sono **114 query**:
- **96** con un'opera reale da trovare;
- **18** il cui esito corretto è "Da verificare":
  - nessun titolo;
  - opera inesistente ("Long Test");
  - errore di parse ("Puntata 3");
  - titolo senza anno condiviso da più opere (Dune, Solaris, King Kong, Up, Suspiria, Nosferatu, Gladiator, Il pianeta delle scimmie);
  - "Il Professore (2019)".

Perché "Il Professore (2019)" va in coda: il nome è **ambiguo per intenzione**. È il titolo italiano esatto di un film poco noto del 2019 (su Wikidata Q130471762, senza etichetta italiana) ed è anche una forma accorciata del noto "Il professore e il pazzo" (2019). Ci sono poi titoli vicini come "Aldo Moro - Il professore" (2018) e "Sergio & Sergei - Il professore e il cosmonauta" (2017/2019). Il motivo è stato **rivisto il 2026-11-05, dopo i test live TMDB**: la prima versione diceva che su Wikidata non esisteva nessuna opera intitolata esattamente "Il professore" del 2019, e TMDB l'ha smentita (sezione "Matching sui candidati TMDB"). L'etichetta resta "Da verificare". Se il proprietario intendesse "Il professore e il pazzo", che **non** è tra i candidati di Wikidata, la copertura scenderebbe a 95/96.

**Copertura dei candidati:** l'opera giusta è nei primi 10 risultati di Wikidata in **95 delle 96** query con un'opera reale. La 96ª ("2012", 2009) è fallita lato provider: la ricerca full-text di un titolo numerico produce migliaia di righe e va in **504 Gateway Timeout** dopo circa 66 s. È successo tre volte, registrate in `out/http_events.log` sul PC originale il 2026-11-04. Quel file non è stato portato sul portatile di sviluppo usato per i test TMDB, quindi qui la prova non è su disco.

**Regola di punteggio** (`match_eval.py`). Punteggio = 0,55 × titolo + 0,35 × anno + 0,10 × tipo:
- **titolo:** massimo di `ratio` e `token_sort_ratio` (rapidfuzz) sul titolo normalizzato (senza accenti, punteggiatura né articoli iniziali `il/lo/la/l'/the/…`), confrontato con **tutti** i titoli del candidato: `it`, `en`, originale (P1476) e alias;
- **anno:** 1,0 se uguale, 0,8 se ±1, 0,3 se ±2, 0 oltre; 0,5 se il file non ha anno;
- **tipo:** film o serie.

Decisione: **auto-match** se il migliore ha punteggio ≥ T **e** distacco dal secondo ≥ M. Altrimenti "Da verificare", con motivo `no_title` / `no_candidates` / `low_score` / `ambiguous`.

Due correzioni nate dagli errori della v1, misurate anche separatamente:
- **filtro:** il tipo dato dalla root/struttura diventa un filtro (nella root `movies` si confrontano solo film);
- **penalità:** un titolo con numeri diversi ("2049" contro "2048", "Parte II") viene penalizzato (× 0,7).

La v2 applica entrambe.

**Senza anno il punteggio massimo è 0,825** (0,55 + 0,35 × 0,5 + 0,10). T fa quindi da **interruttore** per i titoli senza anno:
- T tra 0,70 e 0,80 dà risultati identici, e i titoli senza anno ma unici vanno in automatico;
- con T ≥ 0,85 **tutti** i titoli senza anno vanno in coda.

Risultati a M 0,10. I numeri sono **in-sample**: pesi e correzioni sono stati scelti guardando questi stessi dati. Tra parentesi quadre l'intervallo di confidenza al 95% (Wilson). La recall è data in due modi: sulle query il cui candidato giusto è nella lista (n = 95) e su tutte le opere reali (n = 96).

| Regola | T | auto corretti | auto errati | precision | recall, candidato presente | recall su tutte | di cui auto senza anno | "Da verificare" corretti |
|---|---|---|---|---|---|---|---|---|
| v1 | 0,80 | 85 | 1 | 98,8% [94–100] | 85/95 = 89,5% [82–94] | 85/96 = 88,5% | 5 | 17/18 |
| solo filtro | 0,80 | 92 | 1 | 98,9% [94–100] | 92/95 = 96,8% [91–99] | 92/96 = 95,8% | 10 | 17/18 |
| solo penalità | 0,80 | 87 | 1 | 98,9% [94–100] | 87/95 = 91,6% [84–96] | 87/96 = 90,6% | 6 | 17/18 |
| **v2** | **0,80** | **94** | **1** | **98,9% [94–100]** | **94/95 = 98,9% [94–100]** | **94/96 = 97,9%** | **11 (tutti corretti)** | **17/18** |
| v2 | 0,85 | 83 | 1 | 98,8% [94–100] | 83/95 = 87,4% [79–93] | 83/96 = 86,5% | 0 | 17/18 |

Con M 0,05 la v1 sale a 96,8% di recall e la v2 resta a 98,9%, ma in entrambe entra un secondo auto-match errato: "Il pianeta delle scimmie" senza anno, abbinato al film del 1968. Con M 0 gli errori diventano 9. La sweep completa è in `out/match_wikidata_*.json`.

**Ablazione** (T 0,80, M 0,10):
- il **filtro** da solo recupera 7 query: Inception, La La Land, Boris, Twin Peaks, Westworld, Friends, Il nome della rosa;
- la **penalità** da sola ne recupera 2: Blade Runner 2049 e Amici miei.

Con v2 (T 0,80, M 0,10):
- **l'unico auto-match sbagliato** è "Il Professore (2019)" → "Aldo Moro - Il professore" (2018): titolo quasi uguale, anno ±1;
- **l'unico risolvibile finito in coda** è "The Office (US)": esistono due "The Office" e il nome non ha anno. Il qualificatore "(US)" non viene usato;
- tutti i titoli senza anno condivisi da più opere (Dune, Solaris, King Kong, Up…) vanno in coda per `ambiguous`;
- 11 titoli senza anno ma **unici tra i primi 10 risultati di Wikidata** vengono abbinati in automatico, tutti correttamente: Pulp Fiction, Inception, Il grande Lebowski, La La Land, Quei bravi ragazzi, Boris, Westworld, Montalbano, Romanzo criminale, Il nome della rosa, Amici miei. È la differenza tra la recall del 98,9% (T 0,80) e quella dell'87,4% (T 0,85). Se abbinarli in automatico è una **scelta di policy del proprietario (→ decisa: D6, auto-match solo con candidato unico)** (vedi Conclusioni);
- i due errori di parse arrivati al provider finiscono in coda come `no_candidates` ("Puntata 3", "MOVIE t02").

I titoli italiani funzionano perché si confrontano anche i titoli originali e gli alias. Alcuni esempi: cartella "Matrix" e file "The.Matrix" → Q83495; "The Thing (1982)" e "La cosa (1982)" → lo stesso item; "Se7en" → "Seven"; "Heat" → "Heat - La sfida".

### Q3 — Provider di metadata in `it-IT`

**Misure su Wikidata** (keyless, `wd_sparql.py`, sui 94 item della ground truth: 66 film, 28 serie):

| Aspetto | Esito |
|---|---|
| Etichetta italiana | 91/94 (97%). Mancano Friends, Planet Earth II e La La Land: quest'ultimo, il 2026-11-04, non aveva **nessuna** etichetta it/en ed è stato trovato solo tramite alias e titolo originale |
| Titolo italiano diverso dall'inglese | 54/94: la localizzazione conta davvero |
| Voce su it.wikipedia | 92/94 |
| Descrizione italiana | 92/94, ma è una riga ("film del 1972 diretto da Francis Ford Coppola"), **non una trama** |
| Immagine (P18) | 33/94, e quasi mai un poster (i poster sono coperti da copyright, non stanno su Commons) |
| ID TMDB / ID IMDb | **94/94 / 94/94**: Wikidata fa da ponte tra gli ID |
| Episodi delle 28 serie | 1.242 item episodio, **810** con etichetta italiana. 6 serie su 28 hanno **zero** episodi (Boris, Mare fuori, Suburra, Romanzo criminale, L'amica geniale, Planet Earth II); solo 5 serie hanno ≥ 90% di titoli italiani |
| Flag documentario (P31/P136) | Segnalati 6/6 documentari veri; "Le Mans 66", che è in `Documentari/` ma è un film di finzione, non è segnalato; 1 falso positivo (C'era una volta in America). Su TMDB (genere 99): 6/6, nessun falso positivo (vedi Test live TMDB). La differenza è **un solo item** su 94, con 6 positivi: è una prova debole |
| Accesso | Vedi sotto |

Accesso a Wikidata, osservazioni **aneddotiche**: valori visti a console durante lo spike e non salvati, salvo dove indicato.
- L'**Action API** anonima ha risposto **429** dopo poche richieste (circa 10, con una pausa di 0,2 s tra l'una e l'altra), con `Retry-After` tra 4 e 41 s.
- Sullo **SPARQL endpoint** (WDQS), con 4 query parallele, sono arrivati altri 429 (`Retry-After` fino a 120 s).
- Le due query di `wd_sparql.py` (94 item, episodi di 28 serie) hanno richiesto da 1,6 a 21 s in tre esecuzioni.
- La ricerca di "2012" è andata in 504 dopo circa 66 s. Questo è **salvato**: tre eventi in `out/http_events.log`, che da ora registra ogni risposta ≥ 400. Il file è sul PC originale (2026-11-04), non sul portatile dei test TMDB.
- Conclusione: Wikidata **non è adatto a chiamate interattive**.

**Confronto** (fonti consultate il 2026-11-04):

| | TMDB | TheTVDB | OMDb | Wikidata | fanart.tv |
|---|---|---|---|---|---|
| `it-IT` | parametro `language=it-IT` (ISO 639-1 + paese) su titoli e trame; immagini con lingua (`include_image_language`). **Misurato il 2026-11-05:** trame 94/94, titolo da una traduzione italiana 57/94 (gli altri sono il titolo predefinito), poster italiani 78/94 | traduzioni per lingua (non misurato) | **nessun parametro di lingua**: solo inglese | etichette 97%, nessuna trama, episodi italiani scarsi (misurato) | solo artwork, con lingua |
| Serie / stagioni / episodi | sì; misurato: titolo italiano per il 96% e trama italiana per il 99,5% di 1.529 episodi | sì, il punto di forza (anche ordinamenti alternativi) | parametri Season/Episode | parziale e disomogeneo (misurato) | no |
| Artwork | poster, backdrop, logo, still (misurato: poster, backdrop e logo per 94/94, still per 1.526/1.529 episodi) | sì | poster solo per i patron | quasi nulla | logo, clearart, ecc. |
| Chiave | sì (account) | sì (account + chiave) | sì (1.000 richieste/giorno gratis) | **no** | sì (chiave di progetto obbligatoria, personale opzionale) |
| Rate limit | circa **40 richieste/s**, variabile; 429 se si supera. Nessun 429 a ≤ 1 req/s (misurato) | non documentato sulla pagina | 1.000/giorno (free) | WDQS: 60 s di CPU al minuto, 5 query parallele, 429 con `Retry-After` | a livelli |
| Termini per uso privato | licenza **non commerciale** con attribuzione (logo TMDB + avviso di non endorsement) | **gratis sotto 50k$/anno** di ricavi, con attribuzione | dati **CC BY-NC 4.0** | **CC0** | chiave e termini propri |
| Cache locale | ⚠️ **"non oltre 6 mesi"** (§1.C); **cancellazione** di tutto il TMDB Content, cache inclusa, alla cessazione della licenza (§1.D) | non documentata sulla pagina | — | illimitata (CC0) | — |

Fonti:
- TMDB: [termini d'uso API](https://www.themoviedb.org/api-terms-of-use) (versione "last updated October 20, 2023", letta il 2026-11-04 e riletta il 2026-11-05), [FAQ](https://developer.themoviedb.org/docs/faq) (letta il 2026-11-05), [rate limiting](https://developer.themoviedb.org/docs/rate-limiting), [lingue](https://developer.themoviedb.org/docs/languages);
- TheTVDB: [API information](https://thetvdb.com/api-information), [piani](https://thetvdb.com/api-information/signup);
- OMDb: [sito](https://www.omdbapi.com/), [API key](https://www.omdbapi.com/apikey.aspx);
- Wikidata: [licenza CC0](https://www.wikidata.org/wiki/Wikidata:Licensing), [limiti di WDQS](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual);
- fanart.tv: [personal API keys](https://medium.com/fanart-tv/what-are-fanart-tv-personal-api-keys-472f60222856) (fonte secondaria).

**Conflitto tra requisito e termini TMDB** (→ deciso dal proprietario, D5). Il requisito §12 dice che "il funzionamento della libreria non deve dipendere **permanentemente** dalla disponibilità dell'API esterna". Il doc 01 §3.5 prevede che tutti i metadata e l'artwork siano copiati localmente. I termini TMDB invece:
- vietano di mettere in cache "for longer than 6 months any information obtained through or from TMDB" (§1.C);
- alla cessazione della licenza impongono di "promptly delete or otherwise purge all TMDB Content, including any cached content" (§1.D).

Un refresh periodico entro 6 mesi rispetta il §1.C solo finché il provider resta raggiungibile e la licenza resta attiva. **Non risolve il caso** che il requisito vuole coprire: provider sparito o licenza cessata. → **Deciso dal proprietario il 2026-11-05 (D5, rete di sicurezza)**; testo originale: il conflitto resta **aperto**, per il proprietario e per l'ADR sul provider. Possibili mitigazioni, da valutare:
- **dati CC0 di Wikidata** (titoli it/originali, anno, ID esterni, generi, persone) come base conservabile senza limiti, sempre disponibile se TMDB sparisce;
- le **correzioni manuali** (campi `locked`, doc 01 §3.5) come contenuto del proprietario, non TMDB Content;
- una domanda, ora **risolta dal testo dei termini** (2026-11-05): l'artwork scaricato da TMDB (poster, backdrop) è "TMDB Content"? **Sì.**
  - Il §1.A definisce TMDB Content come "any content (including audio or visual content) or other information available through, on, or from the TMDB APIs or TMDB". Un poster scaricato dal CDN di TMDB è contenuto visivo ottenuto da TMDB;
  - la [FAQ](https://developer.themoviedb.org/docs/faq) tratta le immagini come parte di ciò che l'API fornisce ("use our movie, TV show or actor images and/or data in your application"), chiede l'attribuzione per "the data and/or images" e precisa "We do not claim ownership of any of the images or data in the API";
  - nessuna fonte TMDB nomina le immagini dentro la definizione né le esclude. Quindi l'artwork ricade negli stessi limiti di cache (§1.C) e di cancellazione (§1.D), come già assume l'ADR 0007, punto 6.

### Test live TMDB (2026-11-05)

Eseguiti con il token del proprietario (vedi Setup) sui **95 ID TMDB distinti** di `truth_tmdb.json`: i 94 item misurati su Wikidata, più "2012". Richieste:
- `/movie/{id}` o `/tv/{id}` con `language=it-IT`, `append_to_response=images,translations` e `include_image_language=it,null,en`. I poster `it` contati sono esattamente quelli che restituirebbe `it,null`; `en` serve a misurare il ripiego previsto dall'ADR 0007;
- `/movie/{id}/credits` per i film e `/tv/{id}/aggregate_credits` per le serie;
- per le serie, ogni stagione ≥ 1 in `it-IT`, e la stagione 1 anche in `en-US`, per distinguere un titolo italiano vero da un ripiego;
- per il matching, `/search/movie` o `/search/tv` (sotto).

Risultati della sonda in `out/tmdb_probe.json`.

**Verifica degli ID (ponte Wikidata → TMDB):**
- 95/95 ID risolti (HTTP 200, nessun 404);
- per tutti e 95 l'anno di TMDB coincide entro ±1 con quello di Wikidata e il titolo ha similarità ≥ 0,80 con un titolo di Wikidata: nessun ID da correggere;
- il titolo italiano di TMDB coincide (normalizzato) con l'etichetta italiana di Wikidata in 87/91 casi. Le 4 differenze sono sottotitoli o disambiguatori: "Mission: Impossible - Dead Reckoning Parte uno", "Free Solo - Sfida estrema" e "The Office (US)" su TMDB, "Doctor Who (2005)" su Wikidata.

**Copertura `it-IT`** (gli stessi 94 item di Q3: 66 film e 28 serie):

| Aspetto | TMDB | Wikidata (Q3) |
|---|---|---|
| Titolo nella risposta `it-IT` | 94/94, ma **per costruzione**: se la traduzione italiana non ha un titolo, TMDB restituisce il titolo predefinito. Titolo da una traduzione italiana: **57/94**; per gli altri 37 è il titolo predefinito (`it_translation_title` in `out/tmdb_probe_summary.txt`). La prova che i titoli sono giusti è il confronto con Wikidata: uguali all'etichetta italiana in **87/91** (vedi "Verifica degli ID"). Hanno un titolo anche La La Land, Friends e Planet Earth II ("Pianeta Terra II"), che su Wikidata non hanno l'etichetta | etichetta italiana presente: 91/94. Non è un confronto alla pari: qui si contano etichette presenti, su TMDB il titolo c'è sempre |
| Titolo diverso dall'originale, opere non italiane | 43/77. Degli altri 34, **31 coincidono con l'etichetta italiana di Wikidata** (sono titoli che in Italia restano invariati: Dune, Inception, Breaking Bad…), 2 non hanno etichetta su Wikidata (La La Land, Friends) e 1 differisce solo per un disambiguatore (Doctor Who). Per le 17 opere italiane coincide con l'originale, a meno di una maiuscola in Gomorra | etichetta it diversa da quella en: 54/94 |
| Trama italiana | **94/94**, nessuna identica alla trama inglese | nessuna trama: la descrizione (92/94) è di una riga |
| Tagline italiana | 61/94 | — |
| Poster | 94/94. **In italiano 78/94: film 65/66, serie 13/28.** Senza testo (`null`) 90/94 | immagine P18 per 33/94, quasi mai un poster |
| `poster_path` predefinito con `language=it-IT` | in italiano 78/94, cioè ogni volta che esiste un poster italiano; altrimenti in inglese (15) o in un'altra lingua (Cowboy Bebop) | — |
| Backdrop | 94/94 | — |
| Logo | in italiano 53/94 (film 44/66, serie 9/28); in italiano o inglese 94/94 | — |
| Documentario (genere 99) | 6/6, nessun falso positivo: non sono segnalati né "C'era una volta in America" né "Le Mans 66". Un item di differenza su 94: prova debole | 6/6, 1 falso positivo |
| Crediti | cast ordinato per 94/94 (mediana 64 persone). Nei primi 10 del cast, personaggio per 919/920 e foto per 904/920. Regista per 66/66 film, creatori per 23/28 serie | non misurati |

**Episodi** (28 serie, 136 stagioni):

| | TMDB, stagione 1 | TMDB, tutte le stagioni | Wikidata, tutte (Q3) |
|---|---|---|---|
| Episodi | 297 | 1.529 | 1.242 item episodio |
| con titolo italiano | 270 (91%) | 1.470 (96%) | 810 (65%) |
| con trama italiana | **297 (100%)** | **1.521 (99,5%)** | nessuna trama |
| con still | 297 | 1.526 | — |
| serie con titoli italiani | tutti: 26/28 | almeno il 90%: 25/28 | almeno il 90%: 5/28 |
| serie senza nessun titolo italiano | 2: La casa di carta, Romanzo criminale | 1: Romanzo criminale | 6 serie senza nessun episodio |

- I 27 episodi della stagione 1 senza titolo italiano (La casa di carta, Romanzo criminale) non hanno un titolo neanche in `en-US`: TMDB risponde "Episodio N" / "Episode N". Sono serie con episodi senza titolo, non traduzioni mancanti. Su tutte le stagioni i 59 senza titolo sono di Romanzo criminale (22), Gomorra (22) e La casa di carta (15); per le stagioni dopo la prima il confronto con l'inglese non è stato fatto.
- 39 titoli della stagione 1 sono uguali all'inglese, soprattutto di Cowboy Bebop (25) e Better Call Saul (7): titoli lasciati in originale. Nessuna trama italiana della stagione 1 è identica a quella inglese (0/297): i dati italiani sono traduzioni, non ripieghi.
- Le 6 serie senza episodi su Wikidata (Boris, Mare fuori, Suburra, Romanzo criminale, L'amica geniale, Planet Earth II) su TMDB hanno da 6 a 74 episodi ciascuna, tutti con la trama italiana. Se TMDB li abbia proprio tutti non è verificato.

**Latenza ed errori** (una richiesta alla volta, al massimo 1 al secondo, connessione riusata salvo dove indicato):

| Chiamata | Richieste | p50 | p95 | max |
|---|---|---|---|---|
| dettagli (con `images` e `translations`) | 95 | 0,206 s | 0,499 s | 0,643 s |
| crediti | 95 | 0,204 s | 0,274 s | 0,288 s |
| stagione `it-IT` | 136 | 0,186 s | 0,268 s | 0,594 s |
| stagione `en-US` | 28 | 0,183 s | 0,331 s | 0,438 s |
| ricerca (`/search/movie` o `/search/tv`) | 109 | 0,178 s | 0,209 s | 0,639 s |
| ricerca, **con una connessione nuova per ogni richiesta** | 109 | 0,539 s | 0,681 s | 1,706 s |

- I valori sono quelli della **prima** esecuzione di ogni richiesta:
  - dettagli e stagioni dalla prima esecuzione della sonda (`out/tmdb_probe_latency_run1.json`, copia fatta a mano);
  - crediti dalla seconda, che li chiedeva per la prima volta (`out/tmdb_probe.json`);
  - ricerche dalle due esecuzioni di `match_eval.py dump --provider tmdb`. Senza riuso della connessione il valore è **salvato** (`out/dump_cold_stderr.txt`). Con `--keepalive` latenza e stati delle 109 ricerche sono **visti solo a console** e non salvati, come i valori aneddotici di Wikidata in Q3: rimisurarli richiederebbe una nuova esecuzione, non fatta. Da ora `dump` li scrive in `out/tmdb_search_latency_<keepalive|cold>.json`.
- Ripetute circa 20 minuti dopo, le stesse richieste rispondono in circa metà tempo (dettagli p50 0,108 s, stagioni 0,095 s). La causa probabile è una cache lato TMDB, non verificata. Per una prima ingest valgono i valori della tabella.
- **Errori: nessuno.** 831 risposte, tutte HTTP 200: nessun 404, 429 o 5xx e nessun timeout. Di queste, 722 sono salvate (sonda e ricerche senza riuso); i 109 stati delle ricerche con `--keepalive` sono visti solo a console. Su questa macchina `out/http_events.log`, che registra ogni risposta ≥ 400, non è mai stato creato.
- Due esecuzioni delle 109 ricerche, a pochi minuti di distanza, danno liste identiche: 114 query su 114 con gli stessi candidati, nello stesso ordine e con la stessa `popularity`.
- Stima, non misura, **solo per le chiamate API**: con queste latenze bastano 4 richieste in parallelo per arrivare al limite di 20 req/s dell'ADR 0007. Dettagli e crediti di 2.000 film (4.000 richieste) richiederebbero così 3–4 minuti.
- A questo si aggiunge il download delle copie locali dell'artwork (ADR 0007, punto 6), a 10 req/s sull'host delle immagini (punto 7). Anche questa è una stima: poster in due taglie, backdrop e logo fanno 4 immagini per film. Con le foto dei primi 10 del cast si arriva a circa 14 immagini, cioè circa 28.000 download e **circa 47 minuti** per 2.000 film. Con il cast completo (mediana 64 persone) sono ore, meno le persone in comune tra i film. Le serie aggiungono una richiesta per stagione e uno still per episodio.
- Con l'opzione A, che lo spike conferma, questo tempo **si somma** alla prima ingest via Wikidata (circa 1,7 ore per 2.000 item, stima dell'ADR 0007), non la sostituisce: l'identificazione su Wikidata avviene prima dell'arricchimento TMDB.

**Dimensioni delle immagini** (ADR 0007, punto 6): la risposta di esempio della [documentazione di `/configuration`](https://developer.themoviedb.org/reference/configuration-details) (letta il 2026-11-05) elenca tutte le taglie previste dall'ADR: poster `w342` e `w780`, backdrop `w1280`, still `w300` e persone `w185`. Per i loghi arriva fino a `w500`, più `original`. Nessuno script dello spike chiama `/configuration` e nessuna sua risposta è in `out/cache/`: la fonte è la documentazione, non una misura.

**Artwork come "TMDB Content":** la risposta è nei termini, vedi "Conflitto tra requisito e termini TMDB" sopra.

#### Matching sui candidati TMDB

Ground truth `truth_tmdb.json`, costruita da `build_truth_tmdb.py` **senza usare la ricerca TMDB** che si valuta:
- 95 query: l'ID TMDB è il valore P4947 (film) o P4983 (serie) del QID etichettato a mano in `truth_wikidata.json`, preso dallo snapshot congelato (dati CC0). Lo script si ferma se il tipo su Wikidata non corrisponde a quello della query;
- 1 query, "2012", la cui ricerca su Wikidata era andata in 504: l'ID viene da una query SPARQL su Wikidata per etichetta esatta (Q184605, film del 2009 di Roland Emmerich, P4947 = 14161);
- 18 query "Da verificare": le stesse etichette `null` di Wikidata, fissate prima di qualunque chiamata a TMDB. Per 17 l'esito dipende solo dal nome. Per "Il Professore (2019)" il primo motivo dipendeva invece dal provider ("su Wikidata non c'è un 'Il professore' del 2019") e TMDB l'ha smentito: l'etichetta resta `null`, con il motivo rivisto dopo i test (Q2, "ambiguo per intenzione");
- controllo **per ID**, non per ricerca: vedi "Verifica degli ID", nessuna correzione necessaria;
- il file contiene solo identificatori e, per ogni voce, la sua fonte.

Candidati (`match_eval.py dump --provider tmdb`):
- `/search/movie` o `/search/tv` con `language=it-IT` e, se il nome ha l'anno, `year` o `first_air_date_year`. Senza risultati si riprova senza anno (un caso, "Long Test"). Si tengono i primi 10;
- ogni candidato ha il titolo `it-IT` e il titolo originale: la ricerca non restituisce alias;
- la ricerca filtrata per anno restituisce pochi risultati: mediana 1, 90° percentile 5, massimo 103 (Dune, 2021). Senza anno la mediana è 9,5 e il massimo 7.473 ("Up");
- l'opera giusta è nella lista in **96/96** query (su Wikidata 95/96, perché "2012" va in 504) e al **primo posto in 95/96** (Wikidata 83/95).

La regola è la stessa v2 di Q2, **non ritarata**: questi numeri sono fuori campione rispetto ai candidati TMDB, ma query, etichette e regola sono state messe a punto su questo stesso corpus. Il **tasso di auto-match** è la quota delle query abbinate in automatico, giuste o sbagliate; il resto va in "Da verificare". "Blade Runner 2049 (2017)" sta sia nel corpus sia nell'holdout, per questo il totale è 114 query e non 93 + 22.

Risultati con le soglie della v2 di S4 (T 0,80, M 0,10), adottate dall'ADR 0007 punto 4 (D6 lascia i valori all'implementazione), da `compare_eval.py`:

| Provider | Insieme | query | opere reali (candidato giusto in lista) | auto corretti | auto errati | precision [IC 95%] | recall, candidato presente [IC 95%] | recall su tutte | tasso di auto-match | auto senza anno (corretti) | "Da verificare" corretti |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Wikidata | corpus | 93 | 78 (77) | 76 | 1 | 98,7% [93–100] | 76/77 = 98,7% [93–100] | 76/78 = 97,4% | 77/93 = 82,8% | 10 (10) | 14/15 |
| TMDB | corpus | 93 | 78 (78) | 69 | 2 | 97,2% [90–99] | 69/78 = 88,5% [80–94] | 69/78 = 88,5% | 71/93 = 76,3% | 10 (9) | 13/15 |
| Wikidata | holdout | 22 | 19 (19) | 19 | 0 | 100% [83–100] | 19/19 = 100% [83–100] | 19/19 = 100% | 19/22 = 86,4% | 1 (1) | 3/3 |
| TMDB | holdout | 22 | 19 (19) | 17 | 0 | 100% [82–100] | 17/19 = 89,5% [69–97] | 17/19 = 89,5% | 17/22 = 77,3% | 1 (1) | 3/3 |
| Wikidata | **totale** | 114 | 96 (95) | **94** | **1** | **98,9% [94–100]** | 94/95 = 98,9% [94–100] | **94/96 = 97,9%** | 95/114 = 83,3% | 11 (11) | 17/18 |
| TMDB | **totale** | 114 | 96 (96) | **85** | **2** | **97,7% [92–99]** | 85/96 = 88,5% [81–93] | **85/96 = 88,5%** | 87/114 = 76,3% | 11 (10) | 16/18 |

Dove TMDB perde (sul totale: 11 opere reali in coda e 2 auto errati):
- **Omonimi poco noti dello stesso anno o di quello vicino** (7 query, `ambiguous`; con un anno di scarto il punteggio è 0,93, entro M dal migliore). In tutte l'opera giusta è prima nel ranking e ha da 329 a oltre 20.000 volte i voti della concorrente (contando 1 voto per chi ne ha 0):
  - le concorrenti hanno tutte **meno di 50 voti**, spesso nessuno;
  - le opere colpite sono Dune, Arrival, Alien, Parasite, Ben-Hur, Terminator 2 e 1917; le concorrenti sono omonimi, titoli quasi uguali o identici dopo la normalizzazione, e un making-of;
  - due esempi: Dune (2021) contro "Dűne" (2020), perché normalizzata "ű" diventa "u"; 1917 (2019) contro "Неизвестный 1917-й" (2018), che la normalizzazione dello spike riduce a "1917" (Scoperta 13).
- **Omonimi senza anno** (2 query, `ambiguous`, come vuole D6): La La Land (contro due omonimi poco noti) e Boris (tre serie omonime). Su Wikidata erano unici tra i primi 10.
- **Titolo del file né italiano né originale su TMDB** (2 query, `low_score`): "Star Wars Episodio IV - Una nuova speranza" (su TMDB "Guerre stellari" / "Star Wars") e "Le Mans 66" (su TMDB "Le Mans '66 - La grande sfida" / "Ford v Ferrari"). Su Wikidata li salvavano gli alias.
- **I 2 auto errati** sono entrambi su query "Da verificare":
  - "Up" senza anno → Up (2009). Su Wikidata i primi 10 contenevano due film "Up", del 2009 e del 1984, quindi `ambiguous`. Tra i primi 10 dei 7.473 risultati di TMDB c'è solo quello del 2009 (pagina 1 in cache, 20 risultati). Che l'"Up" del 1984 sia anche su TMDB lo dice Wikidata: Q7897926 ha P4947 = 244655 nello snapshot tracciato. Sul sito TMDB quella voce è un **cortometraggio** di 14 minuti datato 1985 (verifica della revisione, non salvata dallo spike), e questo conta per decidere se debba bloccare un auto-match secondo D6 (Scoperta 12);
  - "Il Professore (2019)" → un film poco noto, con **meno di 50 voti**, che su TMDB ha proprio il titolo italiano "Il professore" (2019); su Wikidata è Q130471762, senza etichetta italiana. Nella stessa ricerca il primo risultato è "Il professore e il pazzo" (2019), con **oltre 1.000 voti**, a punteggio 0,80: la regola sceglie il titolo esatto (punteggio 1,0, distacco 0,195). È un errore preciso: **un titolo esatto poco noto batte un titolo quasi uguale molto noto dello stesso anno**. Nessuna delle condizioni di ripiego proposte sotto lo evita (vedi Conclusioni, punto 3). Con l'altra etichetta plausibile, cioè se il file fosse davvero quel film, la precision di TMDB salirebbe a 86/87 = 98,9%, come Wikidata (94/95), con intervalli di confidenza sovrapposti.

**Varianti esplorative.** Sono **in-sample**, cioè costruite dopo aver visto questi errori, e non sono valori validati. Sul totale delle 114 query, con T 0,80 e M 0,10:

| Variante | Wikidata: auto corretti / errati, recall su tutte | TMDB: auto corretti / errati, recall su tutte | TMDB: precision, tasso di auto-match |
|---|---|---|---|
| v2 (riferimento) | 94 / 1, 97,9% | 85 / 2, 88,5% | 97,7%, 76,3% |
| v2 + normalizzazione Unicode | 94 / 1, 97,9% (invariato) | 86 / 2, 89,6% (recupera "1917") | 97,7%, 77,2% |
| v2 + spareggio per voti, solo con l'anno | — (lo snapshot di Wikidata non ha voti) | **92 / 2, 95,8%** | 97,9%, 82,5% |
| v2 + normalizzazione Unicode + spareggio per voti | — | 92 / 2, 95,8% | 97,9%, 82,5% |

- **Spareggio per voti:** se il nome ha l'anno e la query è `ambiguous`, vince il candidato più votato tra quelli entro M dal migliore, purché abbia almeno 10 volte i voti del secondo; con 100 volte il risultato è lo stesso. Recupera tutti e 7 i casi di omonimi poco noti senza errori nuovi: corpus 75/78 (96,2%), holdout 18/19 (94,7%). I titoli senza anno restano sotto D6.
- **Spareggio per popolarità sui titoli senza anno**, che cambierebbe D6:
  - con un rapporto ≥ 2 aggiungerebbe 5 auto-match: 2 giusti (La La Land, Boris) e 3 sbagliati su query "Da verificare" (Dune → 2021, King Kong → 2005, Nosferatu → 2024);
  - con ≥ 5 ne resterebbero 1 giusto e 1 sbagliato (Nosferatu, rapporto 7,9), con ≥ 10 solo La La Land (26×);
  - la popolarità non separa il film famoso dal titolo davvero ambiguo: D6 resta com'è.
- In tutte le varianti restano in coda "Star Wars Episodio IV" e "Le Mans 66" (servirebbero i titoli alternativi), La La Land e Boris (D6), e restano i 2 auto errati.

## Scoperte

1. **Il problema difficile non è il tokenizer, è la struttura.**
   - Su titolo, anno ed episodi in stile `SxxEyy` le librerie vanno bene (anno 100%, serie `SxxEyy` 10/10).
   - Cadono su ciò che è **convenzione della libreria**: extra, sidecar, cartelle di sistema, dump MakeMKV, lessico italiano.
   - Le librerie per nomi di release non sanno cosa sia una cartella `extras/`: è un compito dell'Identifier, non della libreria.
2. **Il parser a regole è sovra-adattato, ma regge.** Scende da 100% sul corpus a **89% sull'holdout** (25/28, IC 73–96%), comunque sopra guessit (64%, IC 46–79%). I tre errori dell'holdout sono convenzioni nuove (`{edition-…}`, "Puntata", `MOVIE_t02`). Si correggono aggiungendo una regola e un caso di test: il corpus diventa la specifica.
3. **guessit come tokenizer peggiora i titoli italiani**: spezza su " - " ("Il Padrino - Parte II", "Il Signore degli Anelli - La Compagnia dell'Anello"). Per questo l'ibrido rende meno delle sole regole.
4. **L'anno è il segnale più forte del matching.**
   - Con l'anno l'ambiguità quasi scompare, su Wikidata. Su TMDB no: restano omonimi poco noti dello stesso anno o di quello vicino (Scoperta 11).
   - Senza l'anno l'ambiguità è reale (Dune 1984 / 2021) e la coda è l'esito giusto, ma un titolo unico si può abbinare: è la scelta di T.
   - Previsione dello spike, **misurata il 2026-11-05 e smentita in parte**. Si prevedeva che "unico tra i primi 10 di Wikidata" non si trasferisse a TMDB, e che con TMDB quasi tutti i titoli senza anno risultassero ambigui, salvo un segnale di **popolarità**. Su TMDB invece i titoli senza anno abbinati in automatico sono 11, come su Wikidata (10 corretti più "Up", Scoperta 12). Gli omonimi poco noti colpiscono soprattutto le query **con** l'anno, e il segnale che li separa sono i **voti** (`vote_count`). Per i titoli senza anno la popolarità non separa il film famoso dal titolo davvero ambiguo (Test live TMDB, varianti).
   - Il **tipo dalla root** usato come filtro è la correzione che rende di più (7 query recuperate su 9).
5. **Gli errori di parse non hanno prodotto match sbagliati**: i due arrivati al provider ("Puntata 3", "MOVIE t02") non hanno trovato candidati e sono finiti in coda. Con n = 2 non basta per dire che il matcher fa sempre da rete di sicurezza. Il rischio vero restano i **falsi positivi plausibili** (Il Professore → Aldo Moro): servono un distacco minimo e la correzione manuale.
6. **Il provider può fallire per la singola query** ("2012" → 504), non solo essere irraggiungibile. Serve un esito distinto da "nessun candidato": va riprovato, non messo in coda.
7. **I sidecar `.sup` possono esistere** (il corpus è sintetico): un sottotitolo esterno può essere **PGS (immagine)**, non solo testo.
8. **"Documentario" va preso prima di tutto dal genere del provider**, non dalla cartella: "Le Mans 66" sta in `Documentari/` ma è un film di finzione. Misurato su Wikidata (6/6, 1 falso positivo) e su TMDB (genere 99: 6/6, nessun falso positivo). La differenza tra i due è un solo item su 94 (6 positivi): è una prova debole a favore di TMDB, non basta per spostare la fonte principale.
9. **Multi-disco ≠ versioni.** `Disc 1` / `Disc 2` e `BDMV_DISC1` / `DISC2` sono **parti in sequenza** dello stesso item, non file alternativi come 1080p e 4K (D2).
10. **TMDB copre l'italiano dove Wikidata non arriva.**
    - Trame italiane per 94/94 opere (Wikidata nessuna).
    - Sugli episodi: titolo italiano per il 96% e trama per il 99,5% di 1.529 episodi. Wikidata ha il titolo italiano per il 65%, nessuna trama e 6 serie senza episodi.
    - Poster italiani per 78/94 opere.
    - Senza TMDB la libreria resta navigabile, ma senza trame, con pochi poster e con molti episodi senza titolo: è il degrado previsto da D5, ora quantificato.
11. **Su TMDB il ranking è quasi perfetto, la regola no.**
    - L'opera giusta è al primo posto in 95/96 query (Wikidata 83/95).
    - La regola v2 però guarda solo titolo, anno e tipo. Anche con la ricerca filtrata per anno restano omonimi poco noti, dello stesso anno o di quello vicino, che pareggiano quasi il punteggio: un making-of, titoli quasi uguali, opere con pochissimi voti.
    - Lo spareggio per voti, applicato solo quando il nome ha l'anno, recupera tutti e 7 i casi senza errori nuovi (in-sample).
12. **Il "candidato unico" di D6 dipende da quanti candidati si guardano ("Up").** L'"Up" del 1984 (TMDB 244655 secondo Wikidata P4947; un cortometraggio) non è nella prima pagina di risultati TMDB: la regola vede un solo "Up" e lo abbina in automatico. Che TMDB lo metta più in basso perché ordina anche per popolarità è un'ipotesi, **non verificata**.
    - Controllare tutti i risultati con titolo esatto su TMDB non è praticabile: "Up" ha 7.473 risultati (374 pagine da 20) e la ricerca TMDB non ha un filtro per titolo esatto.
    - L'unicità di un titolo senza anno va quindi verificata **su Wikidata**, che con l'opzione A è già il percorso principale. In alternativa, su un numero limitato di pagine TMDB, il cui costo va misurato (non fatto).
    - Resta da decidere se un cortometraggio omonimo debba bloccare l'auto-match di D6.
13. **La normalizzazione dei titoli non deve cancellare le lettere non latine.**
    - `tnorm` dello spike riduce "Неизвестный 1917-й" a "1917" e crea un falso omonimo.
    - Una normalizzazione Unicode non cambia nulla su Wikidata e recupera "1917" su TMDB.
    - Va corretta prima di congelare le fixture di parità previste dall'ADR 0007, altrimenti il test di parità fissa l'errore nel prodotto.
14. **Le serie spesso non hanno un poster italiano**: 15/28, contro 1/66 film.
    - Il `poster_path` predefinito con `language=it-IT` sceglie già un poster italiano ogni volta che esiste (78/78), altrimenti ricade sull'inglese.
    - La catena `it → null → en` dell'ADR 0007 serve soprattutto alle serie e ai loghi (logo italiano 53/94, italiano o inglese 94/94).
15. **Il costo vero della latenza è la connessione.** Con la connessione riusata una ricerca TMDB costa 0,18 s (p50, valore visto a console e non salvato); aprendo una connessione nuova per ogni richiesta, come faceva lo spike, 0,54 s (salvato). Anche dettagli, crediti e stagioni, misurati con la connessione riusata e salvati, stanno tra 0,18 e 0,21 s (p50).

## Limiti

- **TMDB misurato su opere famose**: 95 ID, quelli della ground truth. La copertura `it-IT` di titoli meno noti, film italiani minori e serie recenti sarà più bassa. Le misure sono di un solo giorno (2026-11-05) e da una sola rete. I dati di TMDB sono contributi degli utenti e cambiano nel tempo.
- **Rate limit TMDB non messo alla prova**: al massimo 1 req/s per scelta (ADR 0007: 20 req/s). Il comportamento oltre i 20–40 req/s (429, `Retry-After`) non è misurato.
- **Candidati TMDB senza alias**: lo spike confronta solo il titolo `it-IT` e il titolo originale dei risultati di ricerca. Titoli alternativi (`/alternative_titles`) e traduzioni non sono usati, e due delle 11 opere finite in coda dipendono da questo.
- **Ground truth TMDB derivata da quella di Wikidata**: ne eredita i limiti (una sola persona, etichette "Da verificare" decise a priori). Due esiti dipendono dall'etichetta: "Up" e "Il Professore (2019)", il cui motivo è stato rivisto dopo i test TMDB (l'etichetta no). La differenza di precision tra i due provider dipende da queste due query.
- **Valori TMDB visti solo a console**: latenza e stati HTTP delle 109 ricerche con la connessione riusata (p50 0,178 s). Il `dump` ora li salva, ma per questi test non sono su disco. Anche i tre 504 di Wikidata (`out/http_events.log`) sono solo sul PC originale.
- **Fonti non salvate dallo spike**: le taglie di `/configuration` vengono dalla documentazione TMDB, e la natura dell'"Up" del 1984 su TMDB (cortometraggio) da una verifica sul sito fatta in revisione.
- **Varianti del matcher in-sample** (normalizzazione Unicode, spareggio per voti): sono nate guardando gli errori su TMDB e vanno validate sulla libreria reale.
- **Titolo italiano degli episodi riconosciuto per esclusione**: "Episodio N" / "Episode N" conta come titolo assente. I 39 titoli della stagione 1 uguali all'inglese sono plausibili (titoli lasciati in originale), ma non sono verificati uno per uno.
- **Crediti TMDB**: misurati presenza, ordine, personaggi e foto, non la lingua dei nomi dei personaggi.
- **TheTVDB e fanart.tv non testati** (chiave necessaria, nessuna registrazione fatta per vincolo). Per TheTVDB caching, rate limit e lingue non sono documentati sulle pagine consultate.
- **Corpus sintetico** scritto dallo stesso autore del parser a regole. Il 100% sul corpus è ottimistico: il dato da usare è l'holdout.
- **Anche l'holdout** l'ha scritto lo stesso autore, che conosceva già il design delle regole: è meno indipendente di un campione reale. Con n = 28 l'intervallo è ampio (89%, IC 73–96%). Va ripetuto con i path veri del proprietario.
- **Numeri del matching in-sample:** la v2 e le soglie sono nate dagli errori della v1 su questi stessi dati. Gli intervalli di confidenza (n = 95) misurano solo il rumore di campionamento, non l'adattamento: pesi e soglie sono un punto di partenza, non valori validati.
- **Ground truth** etichettata da una sola persona, partendo da un dump che **mostrava anche i punteggi** della v1: è possibile un bias. Ora `match_eval.py label` dà una vista senza punteggi per rietichettare. Gli esiti "Da verificare" per i titoli ambigui sono una scelta di policy.
- **Misure di Wikidata** sui soli item della ground truth (94), un campione di opere famose: la copertura su titoli meno noti sarà più bassa. I dati di Wikidata cambiano nel tempo (vedi La La Land).
- **Rate limit e latenze di Wikidata** in gran parte aneddotici (vedi Q3). Solo i 504 sono salvati.
- **Tag ID e `{edition-…}` in testo libero non gestiti** dal parser dello spike: con l'anno il titolo resta corretto, senza anno il tag `{tmdb-…}` finisce nel titolo; `{edition-…}` è riconosciuto solo se l'etichetta è nel vocabolario. Elenco completo dei limiti e verifica degli esempi dello standard: `check_standard.py` (25 OK, 10 GAP attesi, 0 FAIL al 2026-11-05) e [standard §8](../library-standard.md).
- **Metadata interni al file** (titolo nel container MKV) non letti, anche se il doc 02 §3.3 li prevede come secondo resolver.

## Conclusioni e raccomandazioni

1. ✅ **Parsing: i nomi reggono, con un parser per convenzioni.** Raccomandazione per l'ADR:
   - un **parser per convenzioni di struttura**, di proprietà del progetto, con il corpus di S4 (corpus + holdout, da estendere con i path reali) come **suite di test di contratto**;
   - una libreria tipo guessit **non è sufficiente da sola** (67% / 64%). Può fare da fallback solo per i nomi in stile release e solo se il linguaggio scelto la rende disponibile; guessit è LGPL-3.0, Python, mantenuto (4.4.0 del 2026-07-31);
   - parsett (MIT, 1.8.5 del 2026-02-14) è peggiore su questo corpus (59% / 57%).
2. ✅ **Matching:** regola a punteggio pesato con soglia **e** distacco minimo, tipo dalla root come filtro e penalità sui numeri.
   - In-sample, con T 0,80 e M 0,10, precision e recall sono 98,9% (IC 94–100%) e tutti i casi ambigui vanno in coda.
   - **Provata su TMDB il 2026-11-05 senza ritararla**, quindi fuori campione rispetto a quei candidati: precision 97,7% (IC 92–99%) e recall 88,5%. Le soglie reggono anche lì:
     - T 0,75 dà gli stessi risultati di T 0,80, mentre T 0,70 recupera solo "Le Mans 66" (unico candidato, punteggio 0,707);
     - M 0,05 recupera 4 opere ma aggiunge l'errore già visto su Wikidata ("Il pianeta delle scimmie" senza anno), M 0,15 ne perde 4: M 0,10 resta il miglior compromesso;
     - gli errori nuovi vengono dagli omonimi e dai titoli mancanti, non dalle soglie.
   - Per la libreria: due correzioni **in-sample** da portare nel prodotto, entrambe misurate. La prima è la normalizzazione Unicode (neutra su Wikidata). La seconda, solo se si abbina su TMDB, è lo spareggio per voti quando il nome ha l'anno.
   - Da ritarare con la libreria reale.
3. **Provider: TMDB come primario** (D5), misurato il 2026-11-05 (sezione "Test live TMDB"):
   - ✅ **come primario per i metadata in italiano.** Trame 94/94, poster italiani 78/94 (film 65/66, serie 13/28), backdrop 94/94. Titoli: uno nella risposta `it-IT` per 94/94, da una traduzione italiana per 57/94, e uguali all'etichetta italiana di Wikidata in 87/91. Sugli episodi, titolo italiano per il 96% e trama per il 99,5% di 1.529. Cast ordinato per 94/94, con personaggio e foto per quasi tutti i primi 10 (919/920 e 904/920). Documentari 6/6 senza falsi positivi (un item meglio di Wikidata: prova debole). Wikidata non ha trame e copre il 65% dei titoli degli episodi;
   - ✅ **aggancio per ID**: i 95 ID TMDB presi da Wikidata sono tutti validi e coerenti per anno e titolo. L'opzione A dell'ADR 0007 regge (identificazione su Wikidata, arricchimento TMDB per ID);
   - ❌ **non come primario per l'identificazione** (opzione B dell'ADR 0007, "TMDB-first"): **la condizione dell'ADR 0007 ("se TMDB risulta più preciso") non è soddisfatta con la regola v2.**
     - Precision: TMDB non è più preciso (97,7% contro 98,9%), ma la differenza è **una query** e non è significativa: con l'altra etichetta plausibile per "Il Professore (2019)" entrambi sono al 98,9% (86/87 e 94/95), con intervalli [92–99] e [94–100] sovrapposti.
     - Recall: 88,5% contro 97,9%. Il gap è **soprattutto del matcher dello spike**, non del recupero di TMDB: 9 delle 11 opere in coda sono omonimi con l'anno che lo spareggio per voti recupera (7) o casi `low_score` senza titoli alternativi (2). Il recupero di TMDB è anzi migliore: opera giusta in lista 96/96 e al primo posto 95/96, contro 95/96 e 83/95 su Wikidata.
     - Anche con lo spareggio per voti, in-sample, TMDB resta sotto Wikidata (95,8% di recall, 2 auto errati contro 1);
   - ✅ **ricerca TMDB come ripiego e come ricerca manuale della coda.** Ha il candidato giusto in 96/96 query e al primo posto in 95/96, compreso "2012", che su Wikidata va in 504, e risponde in 0,18 s (p50, visto a console). Per un auto-match di ripiego servono:
     - lo spareggio per voti quando il nome ha l'anno (Scoperta 11);
     - per i titoli senza anno, l'unicità verificata su Wikidata, non sui primi 10 risultati TMDB (Scoperta 12);
     - i titoli alternativi per i casi `low_score`;
     - **caso aperto**, che nessuna di queste condizioni copre ("Il Professore (2019)"): un titolo esatto poco noto batte un titolo quasi uguale molto noto dello stesso anno. Una possibile regola, da misurare: mandare in coda un match esatto il cui `vote_count` è molto più basso di quello di un candidato dello stesso anno;
   - accesso gratuito non commerciale, rate limit ampio: nessun errore su 831 risposte a ≤ 1 req/s;
   - **attribuzione obbligatoria** (logo TMDB e avviso) nella UI, ad esempio in una pagina "Informazioni";
   - il **conflitto sulla cache** (§1.C / §1.D contro il requisito §12) → deciso (D5): rete di sicurezza con base CC0 Wikidata. Anche la questione dell'artwork è chiusa: **l'artwork scaricato è TMDB Content** per il testo del §1.A (Q3, "Conflitto"), quindi cache e cancellazione valgono anche per poster, backdrop e loghi;
   - TheTVDB resta non misurato (traduzioni per lingua documentate).
4. ✅ **Wikidata come provider complementare**, non primario.
   - CC0, senza chiave, ponte di ID (TMDB/IMDb 94/94), etichette italiane 97%: è anche la candidata per la base di dati conservabile senza limiti (mitigazione del conflitto).
   - Non ha trame né poster, gli episodi italiani sono scarsi e l'API anonima ha limiti stretti.
   - OMDb è scartato (solo inglese, CC BY-NC). TheTVDB è un'alternativa per le serie da valutare con una chiave.
5. **Impatto sui documenti 01–04** (note per la revisione; docs 01–04 non modificati da questo spike):
   - **Doc 01 §5.2 IdentificationCase:**
     - motivi espliciti di `needs_review`: `no_title`, `no_candidates`, `low_score`, `ambiguous`, `multi_part` (→ D7); dopo lo spike il proprietario ha deciso anche `kind_mismatch` (hint della radice "con paracadute") e `id_mismatch` (tag ID "fidati, ma controlla"), vedi lo [standard di libreria](../library-standard.md) §7;
     - avvisi di parse: `season_assumed_1`, `season_dir_mismatch`, `sidecar_no_lang`, `orphan_extra`;
     - un provider che fallisce (`provider_unavailable`) **non** è un `needs_review`: il caso resta `pending`, con un retry pianificato. Nel frattempo il file resta visibile con il titolo ricavato dal filename (doc 02 §3.5, "Degrado");
     - per ogni candidato vanno salvati punteggio e segnali (titolo, anno, tipo), come già previsto.
   - **Doc 01 §4.4 ExternalSubtitle:** lingua **nullable**, `forced`, `sdh` e **formato**. Un sidecar può essere PGS (`.sup`), quindi va trattato come le tracce immagine del doc 04.
   - **Doc 01 §3.2 e §3.5 `category`:** il segnale principale è il genere del provider, con la cartella `Documentari/` come segnale di supporto. La fonte durevole resta Wikidata (6/6, 1 falso positivo); il genere TMDB (6/6, nessun falso positivo, misurato il 2026-11-05) fa da conferma, perché un item di differenza è una prova debole. `category` deve avere una **provenienza** ed essere **bloccabile** come gli altri campi.
   - **Doc 01 §4.1 LibraryRoot:** l'hint `movies` / `series` usato come **filtro di tipo** nel matching è la correzione che rende di più (recall da 89,5% a 96,8% da sola). Il doc 01 lo chiama "hint", però: un file messo nella root sbagliata verrebbe abbinato all'opera omonima del tipo "giusto". Mitigazioni: il filtro si applica solo se lascia candidati, e a punteggio basso il caso va in coda. Da decidere se l'hint resta un suggerimento o diventa un vincolo.
   - **Doc 01 §3.3 Extra:** convenzioni di cartella (`extras`, `featurettes`, `behind the scenes`, `deleted scenes`, `trailers`, `contenuti speciali`…) e suffissi Plex (`-trailer`) bastano per tipo e item padre (100% sul corpus).
   - **Doc 02 §3.3–3.5:**
     - il Metadata Provider Adapter gestisce 429 / `Retry-After` e i fallimenti per singola query;
     - l'Identifier tratta "provider non disponibile" come caso da **riprovare**;
     - l'Enricher pianifica il refresh rispettando la finestra di cache del provider, secondo D5.
   - **Doc 03:**
     - riga 152: "Sottotitoli sidecar" sono descritti come tracce testuali, e la riga 127 prevede la delivery "sidecar URL". Un sidecar `.sup` non può essere servito così: servono mux nello stream, render lato client (come i PGS embedded, P3) o burn-in;
     - riga 165: i nuovi motivi di coda e gli stati diventano **enum dell'API** (`ListIdentificationCases`, `GetIdentificationCase`) e vanno nel contratto.
   - **Dopo i test live TMDB (2026-11-05)**, note per la revisione (ADR e documenti non modificati da questo spike):
     - **doc 01 D5:** la questione dell'artwork come "TMDB Content" è chiusa dai termini (§1.A): sì;
     - **doc 01 D6:** il "candidato unico" va valutato su una lista che non nasconda omonimi. Su TMDB i primi 10 non bastano ("Up"), e controllare tutti i risultati con titolo esatto non è praticabile (7.473 risultati per "Up", nessun filtro per titolo esatto): l'unicità si verifica su Wikidata, già percorso principale con l'opzione A. Da decidere se un cortometraggio omonimo blocca l'auto-match;
     - **doc 01 §3.6 Artwork:** la scelta per lingua segue l'ordine `it → null → en` per tipo. Conta soprattutto per le serie, 15/28 senza poster italiano;
     - **doc 02 §3.4 Metadata Provider Adapter:** riusare la connessione (ricerca p50 0,18 s, visto a console, contro 0,54 s, salvato); conservare il `vote_count` dei candidati, che serve allo spareggio; correggere la normalizzazione Unicode dei titoli prima delle fixture di parità.
   - **ADR 0007**, note per la revisione:
     - opzione A confermata. La voce "Da rivedere" sull'opzione B si chiude con le misure del punto 3, e l'input pendente "chiave TMDB" è soddisfatto;
     - opzione B: il ❌ si regge sul criterio dell'ADR ("più preciso") e sul gap di recall, che è soprattutto del matcher; la differenza di precision è una sola query e non è significativa (punto 3);
     - punto 4.3 (ricerca TMDB come ripiego "con soglie prudenti finché non è misurata"): ora è misurata. Per un auto-match di ripiego servono lo spareggio per voti quando il nome ha l'anno, l'unicità su Wikidata per i titoli senza anno e i titoli alternativi per i casi `low_score`. Resta un **caso aperto** ("Il Professore (2019)"): un titolo esatto poco noto che batte un titolo quasi uguale molto noto dello stesso anno, per esempio da mandare in coda quando il `vote_count` del match esatto è molto più basso di quello di un candidato dello stesso anno;
     - punto 4, implementazione: la normalizzazione Unicode va corretta prima di congelare le fixture di parità (Scoperta 13);
     - punto 3, ripartizione dei campi: il flag documentario **resta su Wikidata** (durevole, CC0); il genere TMDB fa da conferma. La differenza misurata (0 falsi positivi contro 1) è un solo item ed è una prova debole. Se si preferisse TMDB, `category` cambierebbe fonte alla scadenza dei dati TMDB, e il cambio di provenienza andrebbe gestito in modo esplicito. Le trame quasi mai hanno bisogno del ripiego `en-US` (0/94 opere, 8/1.529 episodi);
     - punto 5, scadenza e purge: i dati dei candidati presi da TMDB e salvati negli IdentificationCase (titoli, anni, `vote_count`, anche dalla ricerca di ripiego) sono TMDB Content e vanno inclusi in `ExpireProviderValues` e `PurgeProviderData`;
     - punto 6: l'artwork è TMDB Content per il testo del §1.A, non più solo come "lettura più difendibile". Le taglie del CDN risultano dalla documentazione di `/configuration` (non da una chiamata salvata);
     - punto 7: nessun 429 a ≤ 1 req/s, e la connessione va riusata;
     - Conseguenze: le chiamate API di un backfill TMDB per ID costano minuti (circa 3–4 per dettagli e crediti di 2.000 film a 20 req/s). Il download dell'artwork a 10 req/s aggiunge circa 47 minuti con le foto dei primi 10 del cast, ore con il cast completo (stima). Con l'opzione A questo tempo si somma alla prima ingest via Wikidata (circa 1,7 ore), non la sostituisce.
   - **Altri punti ormai superati**, aggiornati dall'orchestratore il 2026-11-05 insieme alla revisione dell'ADR 0007 (questo spike non li modifica):
     - [standard di libreria](../library-standard.md) §1.3;
     - [doc 05](../architecture/05-technology-evaluation.md) §5, criteri M3/M4 ("G: non misurato") e B indicata come seconda scelta;
     - [ADR 0007](../adr/0007-provider-metadata-e-offline.md), i "Contro" dell'opzione A e le "Evidenze": dicono che TMDB non è misurato, o che l'unico match errato di S4 è "Il Professore" (TMDB aggiunge "Up");
     - [doc 01](../architecture/01-domain-model.md), invariante 5 ("questione aperta per l'ADR");
     - `CLAUDE.md`, passo 5 della fase corrente ("TMDB live blocked: no key").
6. ✅ **Decisioni del proprietario (2026-11-05)**, registrate in [doc 01 §11](../architecture/01-domain-model.md) (D5–D7):
   1. **Cache TMDB contro "offline permanente" → rete di sicurezza (D5).**
      - TMDB resta il provider principale per trame, poster e cast, con un refresh automatico entro la finestra dei termini (6 mesi).
      - In parallelo si conserva una base durevole CC0 da Wikidata: titoli IT/originale, anno, ID esterni.
      - Se la licenza TMDB cessa, i dati TMDB vengono cancellati (§1.D), ma restano la base Wikidata e le correzioni manuali.
      - Il requisito §12 non cambia.
      - Resta per l'ADR sul provider: se l'artwork scaricato è "TMDB Content". → **Risolta il 2026-11-05 dal testo dei termini: sì** (Q3, "Conflitto").
   2. **Titoli senza anno → auto-match solo con candidato unico (D6).** Si applicano soglia e distacco minimo; i valori si fissano in implementazione e restano configurabili.
   3. **Film su più file → fuori dal modello (D7).**
      - Il proprietario fissa uno **standard di libreria**, in [`docs/library-standard.md`](../library-standard.md): un file per film.
      - Le eventuali catene di conversione verso lo standard saranno strumenti separati e futuri.
      - I file multi-parte vengono riconosciuti e messi in coda con motivo `multi_part`.
7. 📥 **Azioni per il proprietario:**
   - ✅ ~~creare una chiave TMDB e metterla in `.env` alla radice~~: **fatto il 2026-11-05**. Il token è in `.env` (ignorato da git), `tmdb_probe.py` e `match_eval.py dump --provider tmdb` sono stati eseguiti (sezione "Test live TMDB");
   - ⚠️ **entro il 2027-05-05** (orchestratore o proprietario): cancellare `spikes/s4-identification/out/`, che contiene TMDB Content (termini §1.C, vedi Setup). Il promemoria va anche nel journal;
   - quando possibile, fornire l'**elenco reale dei path** della libreria (solo nomi) per estendere il corpus. Servirà anche a validare le due correzioni del matcher nate da TMDB (punto 2).
