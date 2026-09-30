# 03 — Interfacce

- **Stato:** Approvato (2026-10-01)
- **Deriva da:** [Requisiti v0.1](../requirements/0001-video-service-requirements-v0.1.md), [01 — Domain Model](01-domain-model.md), [02 — Componenti](02-components.md)
- **Non definisce:** protocollo (REST, GraphQL, gRPC…), formato di serializzazione, protocollo di streaming (HLS, DASH, progressive…). Queste sono decisioni tecnologiche (doc 05 + ADR). Qui si definiscono **operazioni, dati scambiati e semantica**.

---

## 1. Principi trasversali

| # | Principio | Motivazione |
|---|---|---|
| P1 | I client parlano **solo** con il gateway, tramite un **URL base configurato**. Il server restituisce URL relativi o costruiti a partire dalla richiesta, mai IP o hostname fissi | §9: nessuna assunzione di stessa subnet; l'accesso remoto non deve richiedere riscritture |
| P2 | Ogni richiesta di fruizione porta un **contesto di profilo** astratto. Oggi è il profilo selezionato; domani è un token di autenticazione che contiene il profilo. Le operazioni non cambiano | §14: profilo ≠ account; auth futura |
| P3 | ID **opachi e stabili** (interni, Domain Model §3.1). Il client non costruisce mai ID né path | Portabilità, correzioni manuali |
| P4 | **Localizzazione negoziata** (lingua richiesta dal client, fallback sul titolo originale) | Metadata `it-IT` |
| P5 | Liste **paginate a cursore**, con ordinamento e filtri espliciti | Librerie grandi, UI TV a scorrimento |
| P6 | **Modello di errore uniforme**: codice stabile leggibile dalla macchina, messaggio, dettagli | Client multipli devono reagire allo stesso modo |
| P7 | Posizioni e durate in **millisecondi**, date in UTC | Resume preciso, nessuna ambiguità |
| P8 | **Evoluzione additiva e versionata**: campi nuovi ignorabili, rimozioni solo con nuova versione | L'app TV installata può restare indietro rispetto al server |
| P9 | Gli **endpoint dei media** (byte, manifest, segmenti, sottotitoli) sono autorizzati da un **token nell'URL** legato alla sessione, non da header custom | I player nativi (ExoPlayer, AVPlayer, `<video>`) e il casting spesso non possono impostare header |

---

## 2. Due piani

```text
Control plane  — operazioni applicative (catalogo, profili, playback, gestione)
Data plane     — byte dei media: file originali, stream rimpacchettati/transcodificati,
                 sottotitoli, immagini
```

Il control plane **restituisce locatori** (URL) del data plane. Il client non conosce la forma degli URL del data plane: li usa e basta. Questo permette di spostare lo Stream Delivery in un altro container o su un'altra macchina (Componenti C1) senza toccare i client.

---

## 3. API di fruizione (client-facing)

### 3.1 Server e profili

| Operazione | Input | Output / semantica |
|---|---|---|
| `GetServerInfo` | — | nome, versione API supportate, funzionalità abilitate, stato dei servizi (es. ingest in corso). Senza profilo |
| `ListProfiles` | — | profili con nome e avatar. Senza profilo (schermata "Chi guarda?") |
| `CreateProfile` / `UpdateProfile` / `DeleteProfile` | nome, avatar, **preferenze di riproduzione** (lingue audio ordinate, lingue sub, modalità sub) | profilo |
| `SelectProfile` | id del profilo | **contesto di profilo** da usare nelle richieste successive (P2) |

### 3.2 Navigazione del catalogo

| Operazione | Input | Output / semantica |
|---|---|---|
| `GetHome` | — | **righe** ordinate: Continua a guardare, Aggiunti di recente, Film, Serie, Documentari (§16). Ogni riga ha titolo, tipo e prima pagina di item, con cursore per il resto. Composta dal server (I1) |
| `ListItems` | filtri (kind, category, genere, anno, risoluzione, HDR, audio, visto/non visto, in watchlist), ordinamento (titolo, anno, aggiunto il, durata), cursore | pagina di **item sintetici** |
| `Search` | testo, filtri opzionali | item sintetici. Cerca su titolo localizzato, titolo originale e, in futuro, persone |
| `GetItem` | id | **dettaglio item** (§3.4) |
| `GetChildren` | id di series/season | stagioni o episodi con lo stato di visione del profilo |
| `GetNextUp` | id della series (opzionale) | prossimo episodio da guardare per il profilo |
| `GetImage` | id dell'artwork o (item, tipo), **variante di dimensione** | immagine. È data plane: cacheabile a lungo e indirizzata da URL restituito nei dati |

### 3.3 Item sintetico (liste e righe)

id, kind, category, titolo, anno, URL immagine (poster/backdrop) con varianti, badge tecnici (4K, HDR/DV, Atmos), **stato del profilo** (visto, progress %, in watchlist), disponibilità (file online sì/no).

### 3.4 Dettaglio item

Tutto il sintetico, più:
- metadata completi (descrizione, generi, cast/regia, durata, edition label);
- parent (serie/stagione) e figli sintetici;
- **extra associati**;
- **versioni disponibili**: un riassunto tecnico per MediaFile (risoluzione, HDR, codec, elenco delle tracce audio e sub con lingua, codec, canali, forced/SDH). Serve alla UI ("4K · Dolby Vision · TrueHD Atmos 7.1 · ITA/ENG") e alla scelta manuale della versione;
- stato del profilo: posizione di resume, visto, conteggio visioni, watchlist.

### 3.5 Stato di visione

| Operazione | Semantica |
|---|---|
| `MarkWatched` / `MarkUnwatched` | Su item riproducibile, stagione o serie (propagato agli episodi). **Idempotente** |
| `AddToWatchlist` / `RemoveFromWatchlist` / `ListWatchlist` | Idempotenti |
| `ListHistory` | ViewingRecord del profilo, paginati |
| `ClearProgress` | Rimuove un item da "Continua a guardare" |

---

## 4. Playback (control plane)

### 4.1 Capability del client

Il client **dichiara** cosa sa fare. Solo lui conosce il proprio decoder, il display e cosa c'è a valle sull'HDMI. Il server può applicare **override** per modelli di dispositivo noti per dichiarare il falso (I2).

```text
ClientCapabilities
├── device: classe (tv | desktop | mobile | tablet), modello, versione dell'app
├── containers: supportati per Direct Play
├── protocols: protocolli di streaming supportati
├── video[]: codec + profili/livelli, risoluzione max, frame rate max, bit depth
├── hdr: formati supportati end-to-end (display incluso): HDR10, HDR10+, HLG, DV (profili)
├── audio[]: codec, canali max, modalità ∈ {decode, passthrough}
│            (es. TrueHD passthrough verso l'AVR ≠ TrueHD decodificato)
├── subtitles: formati renderizzabili dal client (testo, immagine), stili ASS sì/no
└── limits: bitrate max (anche impostato dall'utente), rete (hint)
```

Il formato preciso e il metodo di rilevamento per piattaforma sono in `04-playback-architecture.md`.

### 4.2 Operazioni

| Operazione | Input | Output / semantica |
|---|---|---|
| `StartPlayback` | item, capability, (opzionali) versione/file scelto, traccia audio, traccia sub, posizione di partenza | **PlaybackSession** (§4.3). Se la posizione non è indicata, usa il resume del profilo. Tracce preselezionate dalle preferenze del profilo, poi dall'ultima scelta su quell'item |
| `ReportProgress` | sessione, posizione, stato (playing/paused/buffering), timestamp del client | Funziona anche da **heartbeat** (intervallo nell'ordine dei secondi). **Vince l'ultimo timestamp**: i report fuori ordine vengono ignorati |
| `ChangeTracks` | sessione, audio e/o sub | Nuova PlaybackSession o locatori aggiornati. Può cambiare modalità: un sub PGS scelto su un browser può imporre il burn-in |
| `ChangeVersion` | sessione, file | Come `ChangeTracks` ma sul file (es. 4K → 1080p) |
| `StopPlayback` | sessione, posizione finale | Chiude il ViewingRecord, aggiorna WatchState (soglia del 90%, Domain Model D3) e libera le risorse. **Idempotente** |
| `ListActiveSessions` | — | Sessioni attive (per la gestione e per l'errore di limite raggiunto) |

Una sessione senza heartbeat oltre un timeout viene **chiusa dal server**, che salva l'ultima posizione nota.

### 4.3 PlaybackSession (risposta)

```text
PlaybackSession
├── sessionId, scadenza
├── mode: direct_play | direct_stream | transcode   (+ motivo leggibile, es. "audio TrueHD non supportato")
├── stream: locatore del data plane + protocollo
├── tracks
│   ├── audio[]: id, lingua, codec, canali, selezionata, "cambio senza riavvio" sì/no
│   └── subtitles[]: id, lingua, forced/SDH, selezionata, delivery ∈ {embedded, sidecar URL, burned}
├── resumePositionMs, durationMs
├── chapters[]
└── trickplay / thumbnail di anteprima [futuro]
```

Il **motivo** della modalità serve alla diagnostica: si deve poter capire perché un film non va in Direct Play.

### 4.4 Errori specifici

| Codice | Quando | Dati aggiuntivi |
|---|---|---|
| `SESSION_LIMIT_REACHED` | Superato il limite di concorrenza (MVP 1) | sessioni attive (per offrire "interrompi l'altra") |
| `MEDIA_UNAVAILABLE` | Nessun file online (root offline, file mancante) | — |
| `NO_COMPATIBLE_PLAN` | Nessuna modalità possibile (es. transcode disabilitato e client incompatibile) | motivo |
| `SESSION_EXPIRED` | Sessione chiusa per timeout | — |

---

## 5. Data plane

| Risorsa | Semantica richiesta |
|---|---|
| **File originale** (Direct Play) | Byte del file così com'è, con **richieste a intervalli** (seek) e dimensione nota. Nessuna modifica |
| **Stream elaborato** (Direct Stream / Transcode) | Forma dipendente dal protocollo scelto. Deve supportare **seek** senza ricominciare dall'inizio e un avvio rapido |
| **Sottotitoli sidecar** | Tracce testuali convertite in un formato che il client sa rendere |
| **Immagini** | Varianti di dimensione, cacheabili a lungo (immutabili per URL) |

Tutte le risorse di sessione sono autorizzate dal **token di sessione nell'URL** (P9) e smettono di funzionare alla chiusura della sessione. Le immagini non dipendono dalla sessione.

---

## 6. API di gestione (sezione del web client, Componenti C3)

| Area | Operazioni |
|---|---|
| Librerie | `ListLibraryRoots`, `AddLibraryRoot`, `UpdateLibraryRoot` (hint del contenuto), `RemoveLibraryRoot`, `TriggerScan` (root o tutto) |
| Job | `GetIngestStatus` (in coda, in corso, falliti con motivo), `RetryJob` |
| Da verificare | `ListIdentificationCases` (per stato), `GetIdentificationCase` (file, fatti tecnici, candidati con punteggio ed evidenze) |
| Risoluzione | `SearchProvider` (testo, kind, anno: per il match manuale), `ResolveCase` (→ item esistente, → nuovo item da riferimento esterno, → nuovo item manuale), `IgnoreCase` |
| Link | `LinkFile` / `UnlinkFile` (file ↔ item, anche multi-episodio), `RematchItem` (nuovo riferimento esterno) |
| Metadata | `UpdateItemMetadata` (i campi modificati diventano **locked**), `UnlockFields`, `RefreshMetadata` |
| Artwork | `ListArtwork` (item, tipo), `SelectArtwork`, `UploadArtwork` |
| Diagnostica | `GetMediaFileDetails` (tutte le tracce, HDR, capitoli), `ExplainPlaybackDecision` (item × capability → piano e motivi, senza avviare nulla) |

`ExplainPlaybackDecision` espone la logica pura del Decision Engine: è lo strumento principale per verificare che il Direct Play venga preferito davvero.

---

## 7. Notifiche server → client

| Evento | Uso |
|---|---|
| `library.item_added` / `library.item_updated` / `library.item_removed` | Aggiornare griglie e dettaglio |
| `ingest.progress` | Stato indicizzazione nella gestione |
| `identification.needs_review` | Badge "Da verificare" |
| `playback.session_terminated` | Il server ha chiuso la sessione (timeout, limite, gestione) |

Il contratto definisce eventi e payload. Il trasporto è una decisione tecnologica: nell'MVP può bastare il polling (I3).

---

## 8. Interfacce interne tra moduli

Contratti tra i componenti di [02](02-components.md). Sono dati in ingresso e dati in uscita, **serializzabili**: nessun oggetto condiviso in memoria attraversa un confine che potrebbe diventare un processo separato (C1).

| Interfaccia | Operazioni | Note |
|---|---|---|
| **MediaProbe** | `analyze(root, relativePath) → MediaFacts` | Deterministica. MediaFacts rispecchia MediaFile + MediaStream + Chapter |
| **MetadataProvider** | `search(query, kind, year?, lang) → Candidate[]`, `getDetails(ref, lang) → NormalizedMetadata`, `getSeason(ref, n, lang)`, `getImages(ref) → ImageRef[]` | Contratto neutro: nessun tipo del provider esce dall'adapter |
| **Resolver** | `resolve(MediaFacts, PathInfo, context) → ScoredCandidate[]` (con evidenze) | Catena ordinata; un nuovo resolver (AI) implementa la stessa firma |
| **PlaybackDecision** | `decide(files: MediaFacts[], ClientCapabilities, ProfilePrefs, constraints) → PlaybackPlan` | **Pura**: stesso input, stesso output. Base di `ExplainPlaybackDecision` |
| **StreamDelivery** | `start(PlaybackPlan) → StreamHandle{locators}`, `stop(handle)`, `status(handle)` | Confine estraibile (C1). Il file è riferito come root + path relativo, mai come path assoluto dell'host |
| **JobRunner** | `enqueue(type, payload, priority, idempotencyKey)` | L'idempotency key evita doppie analisi dello stesso file |

### 8.1 Eventi di dominio interni

`FileDiscovered`, `FileChanged`, `FileMissing`, `FileMoved`, `RootOffline`, `RootOnline`, `FileAnalyzed`, `FileIdentified`, `IdentificationNeedsReview`, `CatalogItemCreated`, `CatalogItemUpdated`, `MetadataRefreshed`, `PlaybackStarted`, `ProgressReported`, `PlaybackEnded`, `ItemWatched`.

Servono a disaccoppiare la pipeline di ingest e ad alimentare le notifiche del §7.

---

## 9. Decisioni prese in revisione

| ID | Domanda | Decisione |
|---|---|---|
| I1 | Home composta dal server o dal client? | **Server**: righe coerenti su web/TV/mobile, meno richieste; il client decide solo la resa |
| I2 | Capability del client: dichiarate, profili per dispositivo lato server, o ibrido? | **Ibrido**: dichiarate dal client + tabella di override lato server per dispositivi con quirk noti |
| I3 | Notifiche push dall'MVP o polling? | **Polling nell'MVP**, contratto degli eventi già definito; push quando serve (TV/mobile) |
| I4 | Contract-first (specifica leggibile dalla macchina nel repo, client generati) o code-first? | **Contract-first**: tre client di tecnologie diverse devono restare allineati; il formato della specifica segue la scelta del protocollo |
