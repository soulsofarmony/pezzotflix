# S4 — Identificazione da filename e metadata provider in `it-IT`

- **Stato:** Completato con una parte bloccata (2026-11-04). Parsing, matching e confronto dei provider sono misurati. I test live su TMDB sono **bloccati**: nessuna chiave disponibile (vedi Limiti).
- **Domanda:** quanto bene si ricava l'identità di un contenuto da path e filename di una libreria italiana di remux? Quale regola di confidenza separa il match automatico dalla coda "Da verificare"? Quale provider di metadata copre bene l'`it-IT` ed è usabile da un'app privata self-hosted con cache locale?
- **Alimenta:**
  - doc 01 §3.2, §3.3, §3.5, §4.4, §5, D4 (MediaLink, IdentificationCase, ExternalSubtitle);
  - doc 02 §3.3–3.5 (Identifier, Metadata Provider Adapter, Enricher);
  - doc 03 (sottotitoli sidecar, coda "Da verificare");
  - future ADR su provider dei metadata e parser.
- **Codice:** `spikes/s4-identification/`, throwaway:
  - corpus: `corpus.json`, `holdout.json`;
  - parsing: `rules.py`, `parse_eval.py`;
  - matching: `match_eval.py`, `truth_wikidata.json`, `fixtures/candidates_wikidata.json`;
  - provider: `wd_sparql.py`, `tmdb_probe.py`.

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
- **Ricostruzione:** `cd spikes/s4-identification && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && .venv/Scripts/python parse_eval.py corpus.json holdout.json && .venv/Scripts/python match_eval.py eval --v1 && .venv/Scripts/python match_eval.py eval --scorer filter && .venv/Scripts/python match_eval.py eval --scorer penalty && .venv/Scripts/python match_eval.py eval && .venv/Scripts/python wd_sparql.py`
  - Parsing e matching girano **offline** dai file tracciati. I risultati vanno in `out/match_wikidata_<v1|filter|penalty|v2>.json`.
  - `wd_sparql.py` e `match_eval.py dump --freeze` (che rigenera lo snapshot) interrogano Wikidata. Le risposte restano in cache in `out/cache/`, che è ignorato da git: sono offline solo sulla stessa macchina, e altrove i dati di Wikidata possono essere cambiati.
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

Perché "Il Professore (2019)" va in coda: su Wikidata non risulta nessuna opera intitolata esattamente "Il professore" del 2019 (ricerca sui film, 2026-11-04). Le più vicine sono "Aldo Moro - Il professore" (2018), "Il professore e il pazzo" (2019) e "Sergio & Sergei - Il professore e il cosmonauta" (2017/2019), e il nome non ne identifica una. Se il proprietario intendesse "Il professore e il pazzo", che **non** è tra i candidati, la copertura scenderebbe a 95/96.

**Copertura dei candidati:** l'opera giusta è nei primi 10 risultati di Wikidata in **95 delle 96** query con un'opera reale. La 96ª ("2012", 2009) è fallita lato provider: la ricerca full-text di un titolo numerico produce migliaia di righe e va in **504 Gateway Timeout** dopo circa 66 s. È successo tre volte, registrate in `out/http_events.log`.

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
- 11 titoli senza anno ma **unici tra i primi 10 risultati di Wikidata** vengono abbinati in automatico, tutti correttamente: Pulp Fiction, Inception, Il grande Lebowski, La La Land, Quei bravi ragazzi, Boris, Westworld, Montalbano, Romanzo criminale, Il nome della rosa, Amici miei. È la differenza tra la recall del 98,9% (T 0,80) e quella dell'87,4% (T 0,85). Se abbinarli in automatico è una **scelta di policy del proprietario** (vedi Conclusioni);
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
| Flag documentario (P31/P136) | Misurato **su Wikidata, non su TMDB**. Segnalati 6/6 documentari veri; "Le Mans 66", che è in `Documentari/` ma è un film di finzione, non è segnalato; 1 falso positivo (C'era una volta in America) |
| Accesso | Vedi sotto |

Accesso a Wikidata, osservazioni **aneddotiche**: valori visti a console durante lo spike e non salvati, salvo dove indicato.
- L'**Action API** anonima ha risposto **429** dopo poche richieste (circa 10, con una pausa di 0,2 s tra l'una e l'altra), con `Retry-After` tra 4 e 41 s.
- Sullo **SPARQL endpoint** (WDQS), con 4 query parallele, sono arrivati altri 429 (`Retry-After` fino a 120 s).
- Le due query di `wd_sparql.py` (94 item, episodi di 28 serie) hanno richiesto da 1,6 a 21 s in tre esecuzioni.
- La ricerca di "2012" è andata in 504 dopo circa 66 s. Questo è **salvato**: tre eventi in `out/http_events.log`, che da ora registra ogni risposta ≥ 400.
- Conclusione: Wikidata **non è adatto a chiamate interattive**.

**Confronto** (fonti consultate il 2026-11-04):

| | TMDB | TheTVDB | OMDb | Wikidata | fanart.tv |
|---|---|---|---|---|---|
| `it-IT` | parametro `language=it-IT` (ISO 639-1 + paese) su titoli e trame; immagini con lingua (`include_image_language`). **Non misurato: manca la chiave** | traduzioni per lingua (non misurato) | **nessun parametro di lingua**: solo inglese | etichette 97%, nessuna trama, episodi italiani scarsi (misurato) | solo artwork, con lingua |
| Serie / stagioni / episodi | sì | sì, il punto di forza (anche ordinamenti alternativi) | parametri Season/Episode | parziale e disomogeneo (misurato) | no |
| Artwork | poster, backdrop, logo, still | sì | poster solo per i patron | quasi nulla | logo, clearart, ecc. |
| Chiave | sì (account) | sì (account + chiave) | sì (1.000 richieste/giorno gratis) | **no** | sì (chiave di progetto obbligatoria, personale opzionale) |
| Rate limit | circa **40 richieste/s**, variabile; 429 se si supera | non documentato sulla pagina | 1.000/giorno (free) | WDQS: 60 s di CPU al minuto, 5 query parallele, 429 con `Retry-After` | a livelli |
| Termini per uso privato | licenza **non commerciale** con attribuzione (logo TMDB + avviso di non endorsement) | **gratis sotto 50k$/anno** di ricavi, con attribuzione | dati **CC BY-NC 4.0** | **CC0** | chiave e termini propri |
| Cache locale | ⚠️ **"non oltre 6 mesi"** (§1.C); **cancellazione** di tutto il TMDB Content, cache inclusa, alla cessazione della licenza (§1.D) | non documentata sulla pagina | — | illimitata (CC0) | — |

Fonti:
- TMDB: [termini d'uso API](https://www.themoviedb.org/api-terms-of-use) (versione "last updated October 20, 2023", letta il 2026-11-04), [rate limiting](https://developer.themoviedb.org/docs/rate-limiting), [lingue](https://developer.themoviedb.org/docs/languages);
- TheTVDB: [API information](https://thetvdb.com/api-information), [piani](https://thetvdb.com/api-information/signup);
- OMDb: [sito](https://www.omdbapi.com/), [API key](https://www.omdbapi.com/apikey.aspx);
- Wikidata: [licenza CC0](https://www.wikidata.org/wiki/Wikidata:Licensing), [limiti di WDQS](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual);
- fanart.tv: [personal API keys](https://medium.com/fanart-tv/what-are-fanart-tv-personal-api-keys-472f60222856) (fonte secondaria).

**Conflitto aperto tra requisito e termini TMDB.** Il requisito §12 dice che "il funzionamento della libreria non deve dipendere **permanentemente** dalla disponibilità dell'API esterna". Il doc 01 §3.5 prevede che tutti i metadata e l'artwork siano copiati localmente. I termini TMDB invece:
- vietano di mettere in cache "for longer than 6 months any information obtained through or from TMDB" (§1.C);
- alla cessazione della licenza impongono di "promptly delete or otherwise purge all TMDB Content, including any cached content" (§1.D).

Un refresh periodico entro 6 mesi rispetta il §1.C solo finché il provider resta raggiungibile e la licenza resta attiva. **Non risolve il caso** che il requisito vuole coprire: provider sparito o licenza cessata. Il conflitto resta **aperto**, per il proprietario e per l'ADR sul provider. Possibili mitigazioni, da valutare:
- **dati CC0 di Wikidata** (titoli it/originali, anno, ID esterni, generi, persone) come base conservabile senza limiti, sempre disponibile se TMDB sparisce;
- le **correzioni manuali** (campi `locked`, doc 01 §3.5) come contenuto del proprietario, non TMDB Content;
- una domanda **non risolta**: l'artwork scaricato da TMDB (poster, backdrop) è "TMDB Content" (§1.A include "audio or visual content")? Se sì, ricade negli stessi limiti di cache e cancellazione.

**Test live TMDB:** ⏸️ **bloccati.** `TMDB_API_KEY` / `TMDB_READ_TOKEN` non sono presenti né nell'ambiente né in un `.env`. `tmdb_probe.py` e `match_eval.py dump --provider tmdb` escono con `BLOCKED`. Sono pronti a misurare:
- titolo localizzato;
- trama in italiano;
- poster in italiano;
- titoli e trame italiani degli episodi della stagione 1;
- latenza;
- precision/recall del matching sui candidati TMDB (richiede `truth_tmdb.json`, da etichettare con `match_eval.py label`).

## Scoperte

1. **Il problema difficile non è il tokenizer, è la struttura.**
   - Su titolo, anno ed episodi in stile `SxxEyy` le librerie vanno bene (anno 100%, serie `SxxEyy` 10/10).
   - Cadono su ciò che è **convenzione della libreria**: extra, sidecar, cartelle di sistema, dump MakeMKV, lessico italiano.
   - Le librerie per nomi di release non sanno cosa sia una cartella `extras/`: è un compito dell'Identifier, non della libreria.
2. **Il parser a regole è sovra-adattato, ma regge.** Scende da 100% sul corpus a **89% sull'holdout** (25/28, IC 73–96%), comunque sopra guessit (64%, IC 46–79%). I tre errori dell'holdout sono convenzioni nuove (`{edition-…}`, "Puntata", `MOVIE_t02`). Si correggono aggiungendo una regola e un caso di test: il corpus diventa la specifica.
3. **guessit come tokenizer peggiora i titoli italiani**: spezza su " - " ("Il Padrino - Parte II", "Il Signore degli Anelli - La Compagnia dell'Anello"). Per questo l'ibrido rende meno delle sole regole.
4. **L'anno è il segnale più forte del matching.**
   - Con l'anno l'ambiguità quasi scompare.
   - Senza l'anno l'ambiguità è reale (Dune 1984 / 2021) e la coda è l'esito giusto, ma un titolo unico si può abbinare: è la scelta di T.
   - "Unico tra i primi 10 di Wikidata" **non si trasferisce a TMDB**: TMDB restituisce molti item oscuri con lo stesso titolo (corti, film TV, omonimi locali). Con TMDB, quasi tutti i titoli senza anno risulterebbero ambigui, oppure servirà un segnale di **popolarità** (`popularity`), da misurare.
   - Il **tipo dalla root** usato come filtro è la correzione che rende di più (7 query recuperate su 9).
5. **Gli errori di parse non hanno prodotto match sbagliati**: i due arrivati al provider ("Puntata 3", "MOVIE t02") non hanno trovato candidati e sono finiti in coda. Con n = 2 non basta per dire che il matcher fa sempre da rete di sicurezza. Il rischio vero restano i **falsi positivi plausibili** (Il Professore → Aldo Moro): servono un distacco minimo e la correzione manuale.
6. **Il provider può fallire per la singola query** ("2012" → 504), non solo essere irraggiungibile. Serve un esito distinto da "nessun candidato": va riprovato, non messo in coda.
7. **I sidecar `.sup` possono esistere** (il corpus è sintetico): un sottotitolo esterno può essere **PGS (immagine)**, non solo testo.
8. **"Documentario" va preso prima di tutto dal genere del provider**, non dalla cartella: "Le Mans 66" sta in `Documentari/` ma è un film di finzione. Misurato su Wikidata, da rimisurare su TMDB.
9. **Multi-disco ≠ versioni.** `Disc 1` / `Disc 2` e `BDMV_DISC1` / `DISC2` sono **parti in sequenza** dello stesso item, non file alternativi come 1080p e 4K (D2).

## Limiti

- **TMDB non misurato** (manca la chiave). La copertura `it-IT` di TMDB, della trama e dei poster in italiano è dichiarata dalla documentazione, non verificata qui. Anche il matching su TMDB non è misurato. I candidati di Wikidata sono un sostituto ragionevole (ricerca full-text su titoli multilingua e alias), ma ranking, densità di omonimi e campi sono diversi (Scoperta 4).
- **TheTVDB e fanart.tv non testati** (chiave necessaria, nessuna registrazione fatta per vincolo). Per TheTVDB caching, rate limit e lingue non sono documentati sulle pagine consultate.
- **Corpus sintetico** scritto dallo stesso autore del parser a regole. Il 100% sul corpus è ottimistico: il dato da usare è l'holdout.
- **Anche l'holdout** l'ha scritto lo stesso autore, che conosceva già il design delle regole: è meno indipendente di un campione reale. Con n = 28 l'intervallo è ampio (89%, IC 73–96%). Va ripetuto con i path veri del proprietario.
- **Numeri del matching in-sample:** la v2 e le soglie sono nate dagli errori della v1 su questi stessi dati. Gli intervalli di confidenza (n = 95) misurano solo il rumore di campionamento, non l'adattamento: pesi e soglie sono un punto di partenza, non valori validati.
- **Ground truth** etichettata da una sola persona, partendo da un dump che **mostrava anche i punteggi** della v1: è possibile un bias. Ora `match_eval.py label` dà una vista senza punteggi per rietichettare. Gli esiti "Da verificare" per i titoli ambigui sono una scelta di policy.
- **Misure di Wikidata** sui soli item della ground truth (94), un campione di opere famose: la copertura su titoli meno noti sarà più bassa. I dati di Wikidata cambiano nel tempo (vedi La La Land).
- **Rate limit e latenze di Wikidata** in gran parte aneddotici (vedi Q3). Solo i 504 sono salvati.
- **Metadata interni al file** (titolo nel container MKV) non letti, anche se il doc 02 §3.3 li prevede come secondo resolver.

## Conclusioni e raccomandazioni

1. ✅ **Parsing: i nomi reggono, con un parser per convenzioni.** Raccomandazione per l'ADR:
   - un **parser per convenzioni di struttura**, di proprietà del progetto, con il corpus di S4 (corpus + holdout, da estendere con i path reali) come **suite di test di contratto**;
   - una libreria tipo guessit **non è sufficiente da sola** (67% / 64%). Può fare da fallback solo per i nomi in stile release e solo se il linguaggio scelto la rende disponibile; guessit è LGPL-3.0, Python, mantenuto (4.4.0 del 2026-07-31);
   - parsett (MIT, 1.8.5 del 2026-02-14) è peggiore su questo corpus (59% / 57%).
2. ✅ **Matching:** regola a punteggio pesato con soglia **e** distacco minimo, tipo dalla root come filtro e penalità sui numeri.
   - In-sample, con T 0,80 e M 0,10, precision e recall sono 98,9% (IC 94–100%) e tutti i casi ambigui vanno in coda.
   - Da ritarare con TMDB e con la libreria reale.
3. ⚠️ **Provider: TMDB come primario**, da confermare quando c'è la chiave.
   - Tra le pagine consultate, è l'unico con `it-IT` **documentato** su trame, episodi e artwork con lingua. TheTVDB ha traduzioni per lingua, ma non sono misurate.
   - Accesso gratuito non commerciale, rate limit ampio.
   - **Attribuzione obbligatoria** (logo TMDB e avviso) nella UI, ad esempio in una pagina "Informazioni".
   - Il **conflitto sulla cache** (§1.C / §1.D contro il requisito §12) resta **aperto**: vedi Q3 e le domande al proprietario.
4. ✅ **Wikidata come provider complementare**, non primario.
   - CC0, senza chiave, ponte di ID (TMDB/IMDb 94/94), etichette italiane 97%: è anche la candidata per la base di dati conservabile senza limiti (mitigazione del conflitto).
   - Non ha trame né poster, gli episodi italiani sono scarsi e l'API anonima ha limiti stretti.
   - OMDb è scartato (solo inglese, CC BY-NC). TheTVDB è un'alternativa per le serie da valutare con una chiave.
5. **Impatto sui documenti 01–04** (note per la revisione; docs 01–04 non modificati da questo spike):
   - **Doc 01 §5.2 IdentificationCase:**
     - motivi espliciti di `needs_review`: `no_title`, `no_candidates`, `low_score`, `ambiguous`, `multi_part` (vedi la domanda 3 sotto);
     - avvisi di parse: `season_assumed_1`, `season_dir_mismatch`, `sidecar_no_lang`, `orphan_extra`;
     - un provider che fallisce (`provider_unavailable`) **non** è un `needs_review`: il caso resta `pending`, con un retry pianificato. Nel frattempo il file resta visibile con il titolo ricavato dal filename (doc 02 §3.5, "Degrado");
     - per ogni candidato vanno salvati punteggio e segnali (titolo, anno, tipo), come già previsto.
   - **Doc 01 §4.4 ExternalSubtitle:** lingua **nullable**, `forced`, `sdh` e **formato**. Un sidecar può essere PGS (`.sup`), quindi va trattato come le tracce immagine del doc 04.
   - **Doc 01 §3.2 e §3.5 `category`:** il segnale principale è il genere del provider (6/6 su Wikidata, da verificare su TMDB), con la cartella `Documentari/` come segnale di supporto. `category` deve avere una **provenienza** ed essere **bloccabile** come gli altri campi.
   - **Doc 01 §4.1 LibraryRoot:** l'hint `movies` / `series` usato come **filtro di tipo** nel matching è la correzione che rende di più (recall da 89,5% a 96,8% da sola). Il doc 01 lo chiama "hint", però: un file messo nella root sbagliata verrebbe abbinato all'opera omonima del tipo "giusto". Mitigazioni: il filtro si applica solo se lascia candidati, e a punteggio basso il caso va in coda. Da decidere se l'hint resta un suggerimento o diventa un vincolo.
   - **Doc 01 §3.3 Extra:** convenzioni di cartella (`extras`, `featurettes`, `behind the scenes`, `deleted scenes`, `trailers`, `contenuti speciali`…) e suffissi Plex (`-trailer`) bastano per tipo e item padre (100% sul corpus).
   - **Doc 02 §3.3–3.5:**
     - il Metadata Provider Adapter gestisce 429 / `Retry-After` e i fallimenti per singola query;
     - l'Identifier tratta "provider non disponibile" come caso da **riprovare**;
     - l'Enricher pianifica il refresh rispettando la finestra di cache del provider, secondo l'esito del conflitto sulla cache.
   - **Doc 03:**
     - riga 152: "Sottotitoli sidecar" sono descritti come tracce testuali, e la riga 127 prevede la delivery "sidecar URL". Un sidecar `.sup` non può essere servito così: servono mux nello stream, render lato client (come i PGS embedded, P3) o burn-in;
     - riga 165: i nuovi motivi di coda e gli stati diventano **enum dell'API** (`ListIdentificationCases`, `GetIdentificationCase`) e vanno nel contratto.
6. ❓ **Domande per il proprietario:**
   1. **Cache TMDB contro il requisito "offline permanente":** si accetta che, se TMDB sparisce o la licenza cessa, i metadata TMDB vadano cancellati (§1.D), tenendo come base duratura i dati CC0 di Wikidata e le correzioni manuali? Oppure il requisito §12 va riformulato? Va deciso nell'ADR sul provider, insieme alla domanda sull'artwork come "TMDB Content".
   2. **Titoli senza anno:** abbinarli in automatico quando il titolo è unico (T ≤ 0,825; in questo campione 11 abbinamenti, tutti corretti) o mandarli sempre in coda (T > 0,825; recall 87,4% invece di 98,9%)? Con TMDB la prima opzione sarà meno efficace (Scoperta 4).
   3. **Film su più file** (Disc 1 / Disc 2): sono nello scope, o i dischi vengono uniti al momento del remux?
      - **Opzione economica:** riconoscerli (il parser lo fa, 100% sul corpus) e mandarli in coda con motivo `multi_part`.
      - **Se sono nello scope**, gli effetti sono più ampi di un `partIndex` sul MediaLink:
        - doc 01 D4 / §7.2: il progress è per item ed è legato a un solo file usato, quindi va definita una timeline che attraversa le parti;
        - doc 03: la sessione e i locatori riferiscono un solo file;
        - doc 04: piano e timeline originale sono per file (§6.1), quindi serve un concatenamento o un cambio di file a metà sessione.
7. 📥 **Azioni per il proprietario:**
   - creare una chiave TMDB (account personale, uso non commerciale) e metterla in `.env` alla radice (`TMDB_READ_TOKEN=…`, già ignorato da git), poi eseguire `python tmdb_probe.py` e `python match_eval.py dump --provider tmdb`;
   - quando possibile, fornire l'**elenco reale dei path** della libreria (solo nomi) per estendere il corpus.
