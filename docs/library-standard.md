# Standard della libreria media

- **Stato:** Accettato (2026-11-05). Decisioni del proprietario più le scelte di §10, accettate da Claude su delega del proprietario dopo due passaggi di `design-reviewer`
- **Deriva da:** [Requisiti v0.1](requirements/0001-video-service-requirements-v0.1.md) §3, §10, §11, §13; [doc 01](architecture/01-domain-model.md) §3, §4.1, §4.4, D2, D6, D7; [spike S4](spikes/S4-identification.md)
- **Scopo:** stabilire come **nominare e organizzare** i file perché Pezzotflix li identifichi con la minore ambiguità possibile. È il riferimento per l'Identifier e per i futuri strumenti di normalizzazione.
- **Decisioni del proprietario già prese (2026-11-05):**
  - nomi di cartelle in inglese nello standard (italiano accettato in lettura);
  - ID esterno "fidati, ma controlla" (§3.3);
  - cartella radice "conta, con paracadute" (§2).

  Le altre scelte di questo standard sono in §10, con chi le ha prese.

---

## 1. Principi

1. **Lo standard è del proprietario, non di Pezzotflix.**
   - Lo storage è montato in sola lettura (requisiti §3; doc 01, invariante 3): Pezzotflix **non rinomina e non sposta mai** i file.
   - Portare i file allo standard è compito di strumenti esterni (§9).
2. **Tollerante in lettura.**
   - Un file non conforme non viene rifiutato: Pezzotflix lo interpreta al meglio.
   - Se l'identità non è certa, lo manda in **"Da verificare"** con un motivo esplicito (§7).
3. **Il nome conforme riduce molto l'ambiguità, ma non la elimina.**
   - Titolo + anno (o un ID esterno, §3.3) rendono l'abbinamento quasi sempre automatico.
   - I casi vicini finiscono comunque in coda. In S4 l'unico abbinamento sbagliato su Wikidata riguarda un nome conforme con anno ("Il Professore (2019)"); sulla ricerca TMDB si aggiunge un titolo senza anno ("Up").
   - I numeri di S4 sono in-sample su Wikidata. Su TMDB, misurato il 2026-11-05 con la stessa regola, la precision è simile e la recall più bassa: l'identificazione resta su Wikidata (ADR 0007).
   - Senza anno vale D6: auto-match solo con un candidato unico.
4. **Compatibile con Plex e Jellyfin dove possibile**, così la stessa libreria resta leggibile anche da altri strumenti (fonti consultate il 2026-11-05, §11). Differenze deliberate:
   - `{edition-…}` è riconosciuto da Plex (con Plex Pass) ma il suo supporto **non è documentato da Jellyfin** (documentazione al 2026-11-05). Con una cartella per edizione Jellyfin le mostra comunque come film separati;
   - i nomi italiani delle cartelle (`Stagione 01`, `Dietro le quinte`…) sono accettati da Pezzotflix in lettura, ma non fanno parte dello standard perché Plex e Jellyfin non li riconoscono.
5. **Nessun item diviso su più file** (D7).
   - Più file per lo stesso item sono ammessi solo come **versioni alternative**, ad esempio 1080p e 4K (D2).
   - Un singolo file può contenere più episodi (§4).

---

## 2. Radici della libreria

Ogni radice è una `LibraryRoot` (doc 01 §4.1) con un **hint** sul contenuto. I nomi delle cartelle sono liberi: conta l'hint configurato. Quelli qui sotto sono il default consigliato.

| Cartella radice | Hint | Contiene |
|---|---|---|
| `Film/` | `movies` | Film e i loro extra |
| `Serie/` | `series` | Serie, stagioni, episodi e i loro extra |
| `Documentari/` | `movies` | Documentari singoli. Le serie documentarie vanno in `Serie/` |

- **Prima la struttura, poi l'hint.** Una struttura forte (`SxxEyy` nel nome, una cartella `Season NN`) stabilisce il tipo (episodio) in qualunque radice. L'hint filtra i casi senza struttura forte.
- **Hint `mixed`** (doc 01 §4.1): nessun filtro per tipo e nessun `kind_mismatch`.
- **L'hint conta, con paracadute** (decisione del proprietario):
  - l'abbinamento cerca prima solo tra i candidati del tipo indicato dall'hint;
  - se nel tipo atteso non c'è un candidato convincente ma ce n'è uno forte di un altro tipo (ad esempio un film TV o una miniserie in un unico file senza `SxxEyy`, finiti in `Film/`), il file **non viene abbinato** e va in coda con il motivo `kind_mismatch` ("forse è nella cartella sbagliata").
  - In S4 il filtro per tipo ha recuperato 7 abbinamenti.
- **Documentari:** che un item sia un documentario (`category`, D1) si ricava **prima di tutto dal genere del provider**. La cartella `Documentari/` è un segnale di supporto. In S4 "Le Mans 66", archiviato tra i documentari, è un film di finzione.

---

## 3. Film

### 3.1 Nome e versioni

```text
Film/
└── Titolo (Anno)/
    ├── Titolo (Anno) - 2160p.mkv
    └── Titolo (Anno) - 1080p.mkv
```

- **Cartella e file:** `Titolo (Anno)`, con l'anno di **prima uscita** tra parentesi.
  - Il titolo può essere italiano o originale: l'abbinamento li confronta entrambi.
- **Versioni alternative** della stessa edizione (D2):
  - stanno nella stessa cartella, con un suffisso dopo ` - ` (`2160p`, `1080p`, `3D`…);
  - il nome deve iniziare **esattamente** come la cartella (lo richiede Jellyfin per raggruppare le versioni);
  - il suffisso è informativo: le caratteristiche tecniche vere le legge il Media Analyzer dal file.
- **Caratteri speciali:**
  - i caratteri non ammessi dal filesystem (`: ? * " < > | / \`) si sostituiscono con ` - ` o si omettono, ad esempio `Mission - Impossible (1996)`;
  - gli articoli restano al loro posto, ad esempio `Il Buono, il Brutto, il Cattivo (1966)`.

### 3.2 Edizioni

Le edizioni (Director's Cut, Extended, Final Cut…) sono **item distinti** (doc 01 §3.4, `editionLabel`). Ognuna ha la sua cartella, con il tag `{edition-…}` nella cartella e nel file, come fa Plex:

```text
Film/
├── Blade Runner (1982) {edition-Final Cut}/
│   └── Blade Runner (1982) {edition-Final Cut} - 2160p.mkv
└── Blade Runner (1982) {edition-Theatrical}/
    └── Blade Runner (1982) {edition-Theatrical} - 1080p.mkv
```

- L'etichetta è **testo libero** e diventa `editionLabel`. Plex accetta al massimo 32 caratteri.

### 3.3 ID esterno (opzionale)

Un ID esterno si scrive come tag, **sia nella cartella sia nel file** (lo richiede Jellyfin quando ci sono più versioni):

```text
Film/Il Professore (2019) {tmdb-NNNNN}/Il Professore (2019) {tmdb-NNNNN} - 1080p.mkv
```

- Sono ammessi `{tmdb-…}` e `{imdb-tt…}` (per le serie anche `{tvdb-…}`).
- L'ordine dei tag tra graffe è libero.
- **Fidati, ma controlla** (decisione del proprietario):
  - l'ID indica il candidato;
  - lo **spazio dei nomi** dell'ID TMDB (film o serie, che su TMDB sono separati) segue il tipo dell'item: struttura prima, poi hint. Un ID di serie dentro `Film/` dà `id_mismatch`;
  - titolo e anno del file devono essere **coerenti** con quelli dell'ID:
    - il titolo si confronta con **tutti** i titoli dell'ID (italiano, originale, alias) e basta che uno dei due titoli contenga l'altro (somiglianza per sottoinsieme di parole). La soglia è più larga di quella dell'auto-match, così un titolo breve come "Il Professore" resta coerente con un titolo lungo;
    - l'anno, se presente nel nome, deve coincidere ±1. Senza anno si controlla solo il titolo;
  - se non lo sono, il file non viene abbinato e va in coda con il motivo `id_mismatch` ("codice e nome non corrispondono"). Così un errore di battitura nell'ID non collega in silenzio il film sbagliato.
- Consigliato per i casi ambigui: titoli omonimi, remake, titoli molto brevi.

---

## 4. Serie

```text
Serie/
└── Titolo (Anno)/
    ├── Season 00/
    │   └── Titolo (Anno) - S00E01 - Titolo dello speciale.mkv
    ├── Season 01/
    │   ├── Titolo (Anno) - S01E01 - Titolo episodio.mkv
    │   └── Titolo (Anno) - S01E02-E03 - Titolo episodio doppio.mkv
    └── Season 02/
        └── …
```

- **Cartella della serie:** `Titolo (Anno)`, con l'anno della prima stagione.
  - L'anno distingue serie omonime: in S4 ci sono due serie "The Office".
  - Sono ammessi gli ID `{tmdb-…}`, `{tvdb-…}`, `{imdb-…}`, con la regola di §3.3.
- **Cartella della stagione:** `Season NN`, con due cifre. È la forma che Plex e Jellyfin richiedono, e Jellyfin sconsiglia di abbreviare in `S01`.
  - Gli **speciali** vanno in `Season 00`.
  - In lettura è accettato anche `Stagione NN`.
- **File dell'episodio:** `Titolo (Anno) - SxxEyy - Titolo episodio.mkv`.
  - Conta **solo `SxxEyy`**, con almeno due cifre per la stagione e per l'episodio.
  - Il titolo dell'episodio è facoltativo e solo informativo: quello vero arriva dai metadata.
  - **Multi-episodio** (un file con due episodi consecutivi): `S01E02-E03`.
- **Coerenza stagione/cartella:** il numero di stagione nel nome deve coincidere con la cartella; altrimenti viene registrato l'avviso `season_dir_mismatch` (§7.2).
  - Eccezione: in `Season 00` la stagione del file non viene controllata. Il parser di S4 si comporta già così.
- **Da evitare nei nomi dei file:** `1x02`, "Stagione 1 Episodio 2", "Puntata 3" e numeri nudi. Pezzotflix prova a leggerli, ma non è garantito: in S4 "Puntata" non viene riconosciuta.

---

## 5. Extra

Gli extra (doc 01 §3.3, `kind = extra`) stanno in **sottocartelle tipizzate dentro la cartella dell'item** a cui appartengono. Il nome della sottocartella dà il tipo. Lo standard usa i nomi inglesi di Plex e Jellyfin; Pezzotflix accetta anche gli equivalenti italiani.

| Sottocartella (standard) | `extraType` | Equivalenti accettati in lettura |
|---|---|---|
| `Trailers/` | trailer | `trailer/` |
| `Featurettes/` | featurette | `featurette/` |
| `Behind The Scenes/` | behind-the-scenes | `dietro le quinte/`, `making of/` |
| `Deleted Scenes/` | deleted-scene | `scene eliminate/`, `scene tagliate/` |
| `Interviews/` | interview | `interviste/` |
| `Scenes/` | other | `clips/` |
| `Shorts/` | other | — |
| `Other/` | other | `others/` |
| `Extras/` (solo Jellyfin) | other, o il tipo dedotto dal nome del file (es. "Trailer…") | `extra/`, `bonus/`, `contenuti speciali/` |

```text
Film/Blade Runner 2049 (2017)/
├── Blade Runner 2049 (2017) - 2160p.mkv
├── Trailers/
│   └── Trailer ufficiale.mkv
└── Behind The Scenes/
    └── Il making of.mkv
```

- Il nome del file dell'extra è il suo **titolo visualizzato**.
- **In alternativa**, i suffissi in stile Plex nella cartella dell'item: `Titolo (Anno)-trailer.mkv`, `-featurette`, `-behindthescenes`, `-deleted`, `-interview`, `-scene`, `-short`, `-other`. In questo caso il titolo visualizzato è l'etichetta del tipo ("Trailer"); se più extra hanno lo stesso tipo, si numerano.
- **Extra di una serie:**
  - nella cartella della serie, se riguardano tutta la serie;
  - nella cartella della stagione, se riguardano una sola stagione.
  - Gli extra di un singolo episodio (doc 01 §3.3) non hanno una convenzione dedicata: si associano a mano (§13).
- Un extra fuori da qualsiasi cartella di item resta **orfano**. È uno stato valido (doc 01 §3.3): viene catalogato e si può associare a mano.

---

## 6. Sottotitoli esterni (sidecar)

```text
Titolo (Anno) - 2160p.mkv
Titolo (Anno) - 2160p.it.srt
Titolo (Anno) - 2160p.it.forced.srt
Titolo (Anno) - 2160p.en.sdh.srt
Titolo (Anno) - 2160p.it.forced.sup
```

- **Forma:** `<nome del video>.<lingua>[.forced][.sdh].<estensione>`, nella stessa cartella del video e con lo **stesso nome** (stem).
- **Lingua:**
  - codice ISO 639-1 (`it`, `en`) o 639-2 (`ita`, `eng`), subito dopo il nome del video;
  - senza lingua il file viene associato lo stesso, con l'avviso `sidecar_no_lang`.
- **Flag:**
  - `forced` per i forzati;
  - `sdh` (o `cc`) per i sottotitoli per non udenti;
  - `hi` va scritto **solo dopo** il codice lingua, perché da solo significa hindi.
- **Formati:** testo (`.srt`, `.ass`) o immagine (`.sup` PGS).
  - Un sidecar PGS segue le stesse regole di resa dei PGS embedded (doc 04 §4.4, P3).
  - Il **meccanismo di delivery** dei sidecar immagine è ancora da definire: doc 03 prevede oggi solo sidecar testuali (impatto aperto di S4).
- I sottotitoli **dentro l'MKV** sono preferibili ai sidecar: tracce e flag (`default`, `forced`) vengono letti direttamente (S1).

---

## 7. Cosa non è conforme, e cosa succede

Esistono due livelli:
- un **motivo di coda** manda il file in "Da verificare" (`IdentificationCase` in stato `needs_review`, doc 01 §5);
- un **avviso** viene registrato, ma l'identificazione prosegue.

### 7.1 Motivi di coda

| Codice | Quando | Fonte |
|---|---|---|
| `no_title` | Né il file né la cartella danno un titolo (es. `title_t00.mkv` senza cartella valida) | S4 |
| `no_candidates` | Il provider non restituisce candidati | S4 |
| `low_score` | Il miglior candidato è sotto soglia | S4 |
| `ambiguous` | Due candidati troppo vicini, distacco minimo non raggiunto (anche senza anno, D6) | S4 |
| `multi_part` | File di un film diviso su più parti (`Disco 1`, `BDMV_DISC2`…), D7 | S4 |
| `kind_mismatch` | Il candidato forte è di un tipo diverso da quello dell'hint (§2) | **nuovo, proposto** |
| `id_mismatch` | Tag ID presente, ma titolo e anno non coerenti con l'ID (§3.3) | **nuovo, proposto** |
| `disc_structure` | Struttura di disco (`BDMV/`, `VIDEO_TS/`) o immagine `.iso`: non riproducibile così com'è | **nuovo, proposto** |

- **Come si risolvono `multi_part` e `disc_structure`:** solo con **Ignora** (`IgnoreCase`, doc 03) oppure correggendo i file fuori da Pezzotflix e rifacendo la scansione. Collegarli a mano a un item ricreerebbe un item su più file (D7) o collegherebbe un file non riproducibile. Il vincolo va riportato negli enum di doc 03.
- `no_year` **non** è un motivo di coda: è un segnale del parser. Con un candidato unico il file viene abbinato (D6); altrimenti finisce in coda come `ambiguous`, `low_score` o `no_candidates`.
- Se il provider non risponde, il caso **non** va in coda: resta in attesa (`pending`) e viene riprovato. Il file resta visibile con il titolo ricavato dal nome (S4; doc 02 §3.5).

### 7.2 Avvisi

| Codice | Quando |
|---|---|
| `season_assumed_1` | Episodio senza stagione esplicita: si assume la stagione 1 |
| `season_dir_mismatch` | La stagione nel nome non coincide con la cartella (escluse `Season 00` e `Stagione 00`) |
| `sidecar_no_lang` | Sottotitolo esterno senza lingua |
| `orphan_extra` | Extra fuori da qualsiasi cartella di item |

L'elenco definitivo dei codici e dei loro valori nell'API si fissa nell'allineamento del design dopo gli spike (doc 01 `IdentificationCase`, doc 03 `GetIdentificationCase`).

### 7.3 File ignorati

- Cartelle di sistema o nascoste: `$RECYCLE.BIN`, `.Trash…`, `lost+found`, `System Volume Information`, cartelle che iniziano con `.`.
- Cartelle di servizio dei NAS (Synology, QNAP): `@eaDir`, `#snapshot`, `#recycle`, `@Recycle`, `@Recently-Snapshot`, `.@__thumb`.
- **Collegamenti simbolici** (e junction di Windows): non vengono seguiti, così un collegamento non può portare fuori dalla radice né creare cicli. La scansione li conta e li registra nel log. Un film va messo nella radice come file vero.
- **Sample:** solo una cartella `sample/` o `samples/` (Jellyfin la tratta come extra; Pezzotflix la ignora) o un nome che finisce con `-sample`, **mai** "sample" come parola qualunque del titolo.
- Estensioni che non sono né video né sottotitoli. **Eccezione:** `.iso`, `BDMV/` e `VIDEO_TS/` non vengono ignorati, ma vanno in coda come `disc_structure`.

### 7.4 Portabilità dei nomi

- Il confronto di nomi di cartelle, flag ed estensioni **ignora maiuscole e minuscole** (`trailers/` = `Trailers/`, `.IT.srt` = `.it.srt`).
- I nomi vengono **normalizzati in Unicode NFC** prima del confronto: un titolo accentato scritto in NFD da un NAS o da macOS coincide con lo stesso titolo in NFC.
- Il **container consigliato è MKV**, ma non è un requisito di conformità: MP4 e altri container vengono letti normalmente.

---

## 8. Stato della verifica

Gli esempi di questo standard sono verificati con il parser dello spike S4 (throwaway):

```text
spikes/s4-identification/.venv/Scripts/python.exe spikes/s4-identification/check_standard.py
```

Lo script classifica ogni esempio come **OK** (comportamento conforme allo standard), **GAP** (limite noto del parser dello spike, che rompe solo i campi attesi) o **FAIL** (regressione). Al 2026-11-05: 25 OK, 10 GAP, 0 FAIL su 35 esempi.

**Limiti noti, da colmare nel parser di prodotto:**

| Limite | Effetto oggi | Verificato dallo script |
|---|---|---|
| Tag `{tmdb-…}` / `{imdb-…}` / `{tvdb-…}` | Non estratti. Con l'anno il titolo esce comunque giusto; **senza anno il tag finisce nel titolo** | sì |
| `{edition-…}` in testo libero | Riconosciuto solo se l'etichetta è nel vocabolario delle edizioni (es. `Final Cut` sì, `Ultimate Cut` no) | sì |
| `multi_part` | Il parser rileva la parte (`part = 1`) ma non emette il motivo | sì |
| `BDMV/…/00001.m2ts` | **Classificato come film** senza motivi: sarebbe abbinato e verrebbe riprodotto un segmento di playlist | sì |
| `.iso` | Ignorato come "non video" invece di andare in coda | sì |
| `VIDEO_TS/` | Ignorato come "non video" invece di andare in coda | sì |
| Extra di stagione (`Season 01/Extras/…`) | Associati alla serie, senza stagione | sì |
| "sample" | Riconosciuto anche come parola del titolo ("Sample Rate" → ignorato); `samples/` non ignorata | sì |
| `hi` senza lingua (`Film.hi.srt`) | Letto come SDH senza lingua invece che come hindi | sì |
| Lingue dei sidecar | Solo 6 lingue note | no |
| `kind_mismatch`, `id_mismatch` | Non implementati (decisioni successive allo spike) | no |

---

## 9. Normalizzazione (futuro, fuori MVP)

Portare una libreria esistente allo standard è compito di **strumenti separati**, come lo sono ripping e remux, che avvengono a monte di Pezzotflix (requisiti §4, §6). Esempi:
- **rinomina guidata** a partire da una proposta di Pezzotflix, con titolo, anno e ID già abbinati;
- **unione delle parti** multi-disco in un solo MKV (mkvmerge);
- **estrazione o inserimento** dei sidecar nell'MKV.

Questi strumenti scrivono sullo storage, quindi **non** fanno parte del Video Service, che lo monta in sola lettura.

---

## 10. Altre scelte di questo standard

Scelte contenute nello standard che il proprietario non ha preso in modo esplicito. Le ha accettate **Claude su delega del proprietario** (CLAUDE.md, "Delegated decisions") il 2026-11-05, dopo due passaggi di `design-reviewer`. Il proprietario può cambiarle in qualunque momento.

| # | Scelta | Motivo |
|---|---|---|
| L1 | Una cartella per ogni edizione, con `{edition-…}` nella cartella e nel file (§3.2) | Convenzione Plex; con Jellyfin le edizioni restano comunque item separati |
| L2 | Tre codici di coda nuovi: `kind_mismatch`, `id_mismatch`, `disc_structure` (§7.1) | Servono alle decisioni del proprietario su hint e ID, e a non riprodurre strutture di disco |
| L3 | Strutture di disco e `.iso` non riproducibili: in coda, si risolvono solo con Ignora o correggendo i file (§7.1) | Requisiti §4: la sorgente prevista è il remux MKV; servire playlist di disco è fuori scope |
| L4 | Titolo visualizzato degli extra = nome del file; per i suffissi Plex, l'etichetta del tipo (§5) | Nessun metadata esterno affidabile per gli extra |
| L5 | Anno = prima uscita; per le serie, la prima stagione (§3.1, §4) | È l'anno usato da TMDB, Wikidata, Plex e Jellyfin |
| L6 | Radici di default `Film/`, `Serie/`, `Documentari/`, con `Documentari/` sotto hint `movies` e le serie documentarie in `Serie/` (§2) | Rispecchia la navigazione Film / Serie / Documentari (requisiti §16); la natura di documentario viene dal genere |

---

## 11. Esempio completo e fonti

```text
Film/
├── Blade Runner (1982) {edition-Final Cut}/
│   └── Blade Runner (1982) {edition-Final Cut} - 2160p.mkv
├── Blade Runner 2049 (2017)/
│   ├── Blade Runner 2049 (2017) - 2160p.mkv
│   ├── Blade Runner 2049 (2017) - 2160p.it.forced.srt
│   ├── Blade Runner 2049 (2017) - 1080p.mkv
│   └── Trailers/
│       └── Trailer ufficiale.mkv
└── Il Buono, il Brutto, il Cattivo (1966)/
    ├── Il Buono, il Brutto, il Cattivo (1966).mkv
    └── Behind The Scenes/
        └── Il making of.mkv
Serie/
└── The Office (2005) {tmdb-2316}/
    ├── Season 00/
    │   └── The Office (2005) {tmdb-2316} - S00E01 - Webisode.mkv
    └── Season 01/
        ├── The Office (2005) {tmdb-2316} - S01E01 - Pilot.mkv
        └── The Office (2005) {tmdb-2316} - S01E02-E03.mkv
Documentari/
└── Free Solo (2018)/
    └── Free Solo (2018) - 2160p.mkv
```

- `{tmdb-2316}` è l'ID reale di The Office (US) (Wikidata Q23831, P4983). Il doppio episodio `S01E02-E03` è **illustrativo**: non esiste nella serie reale.

**Fonti** (consultate il 2026-11-05):
- Plex, film (edizioni, ID, versioni): <https://support.plex.tv/articles/naming-and-organizing-your-movie-media-files/>
- Plex, serie (cartelle di stagione in inglese, ID, multi-episodio, Season 00; pagina non leggibile in automatico, citazione da verificare a mano): <https://support.plex.tv/articles/naming-and-organizing-your-tv-show-files/>
- Plex, extra dei film: <https://support.plex.tv/articles/local-files-for-trailers-and-extras/>
- Plex, extra delle serie: <https://support.plex.tv/articles/local-files-for-tv-show-trailers-and-extras/>
- Jellyfin, film (versioni multiple, ID in cartella e file, cartelle extra): <https://jellyfin.org/docs/general/server/media/movies/>
- Jellyfin, serie ("Season", niente `S01`): <https://jellyfin.org/docs/general/server/media/shows/>
- Jellyfin, ID dei provider: <https://jellyfin.org/docs/general/server/metadata/identifiers/>
- Jellyfin, `{edition-}` non supportato (richiesta aperta): <https://forum.jellyfin.org/t-naming-parity-with-plex>
