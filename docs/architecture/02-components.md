# 02 — Componenti e responsabilità

- **Stato:** Approvato (2026-10-01)
- **Deriva da:** [Requisiti v0.1](../requirements/0001-video-service-requirements-v0.1.md), [01 — Domain Model](01-domain-model.md)
- **Non definisce:** tecnologie, protocolli, formati di API. I componenti sono **logici**: l'ultima sezione propone come raggrupparli in container.

---

## 1. Vista d'insieme

```text
                         ┌───────────────────────────────┐
  Web / TV / Mobile ───► │        Gateway / Proxy        │  (piattaforma)
                         └───────┬───────────────┬───────┘
                                 │               │
                  ┌──────────────▼───┐     ┌─────▼──────────┐
                  │  Video Service   │     │ Music Service  │ [futuro]
                  └──────────────────┘     └────────────────┘

Dentro il Video Service:

 ┌──────────────────────────── API (client-facing + admin) ────────────────────────────┐
 └───┬──────────────┬───────────────┬──────────────────┬──────────────────┬────────────┘
     │              │               │                  │                  │
 ┌───▼────┐   ┌─────▼─────┐   ┌─────▼──────┐    ┌──────▼──────┐    ┌──────▼──────┐
 │Catalog │   │ Profiles &│   │  Artwork   │    │  Playback   │    │   Session   │
 │        │   │WatchState │   │   Store    │    │  Decision   │◄───┤   Manager   │
 └───▲────┘   └─────▲─────┘   └─────▲──────┘    └─────────────┘    └──────┬──────┘
     │              │ progress      │                                     │
     │              └───────────────┼─────────────────────────────────────┤
     │                              │                              ┌──────▼──────┐
 ┌───┴──────────────────────────────┴───┐                          │   Stream    │
 │  Ingest pipeline (Job Runner)        │                          │  Delivery   │
 │  Library Monitor → Media Analyzer →  │                          └──────┬──────┘
 │  Identifier → Metadata Enricher      │                                 │ read
 └───┬───────────────────────────┬──────┘                                 │
     │ read                      │                                        │
 ┌───▼───────────────────┐   ┌───▼──────────────┐                         │
 │ Media Storage (RO)    │◄──┼──────────────────┼─────────────────────────┘
 └───────────────────────┘   │ Metadata Provider│──► API esterne
                             │     Adapter      │
                             └──────────────────┘
```

---

## 2. Componenti di piattaforma

### 2.1 Gateway / Reverse Proxy
- **Fa:** unico punto d'ingresso per i client, instrada verso i servizi (`/video/…`, in futuro `/music/…`), serve gli asset statici dei client web.
- **Non fa:** logica applicativa.
- **Evoluzione:** qui arriveranno TLS, autenticazione e accesso remoto (§9) senza toccare il Video Service.
- **Resilienza:** se il Video Service è giù, il gateway resta su e gli altri servizi continuano a rispondere (§2, §18).

### 2.2 Media Storage
Esterno a tutti i servizi, montato **read-only** (§3). Non è un componente software nostro, ma un **confine**.

### 2.3 Client
Web (MVP), TV e Mobile. Parlano **solo** con il gateway, mai direttamente con lo storage o con altri componenti interni.

---

## 3. Componenti del Video Service

Per ciascuno: responsabilità, dati di cui è **proprietario** (unico che li scrive) e dipendenze.

### 3.1 Library Monitor
- **Fa:** scopre file nuovi, modificati, spostati o scomparsi nelle LibraryRoot e produce eventi di ingest (`file_discovered`, `file_changed`, `file_missing`).
- **Dettagli:**
  - **Scansione periodica completa come meccanismo primario.** Il file watching è solo un'ottimizzazione: con Docker Desktop su Windows e con i NAS gli eventi del filesystem non arrivano in modo affidabile.
  - **Attesa di stabilità:** un file in copia (dimensione che cresce) non viene analizzato finché non si stabilizza.
  - **Root offline ≠ file mancanti:** se un'intera root sparisce, si segna la root offline invece di marcare migliaia di file come `missing` (Domain Model §6.1).
- **Possiede:** stato delle LibraryRoot, inventario grezzo dei path.
- **Dipende da:** Media Storage (lettura).

### 3.2 Media Analyzer
- **Fa:** apre il file e ne estrae i fatti tecnici: container, durata, tracce (codec, lingue, flag, **formato HDR/DV**, **audio lossless/oggetti**, **sottotitoli testo vs immagine**), capitoli, fingerprint.
- **Proprietà:** deterministico e ri-eseguibile. Rianalizzare un file dà lo stesso risultato e arricchisce il modello se l'analyzer migliora.
- **Possiede:** MediaFile (fatti tecnici), MediaStream, Chapter, ExternalSubtitle.
- **Dipende da:** Media Storage (lettura), tool di probing.

### 3.3 Identifier (Matcher)
- **Fa:** per ogni MediaFile non ancora collegato produce **candidati** con confidenza. Poi crea un `MediaLink` automatico o apre un `IdentificationCase` in `needs_review`.
- **Struttura a catena di resolver** (§11), in ordine: struttura directory + filename → metadata interni al file → ricerca sul provider esterno → *(futuro)* resolver AI. Aggiungere un resolver non cambia il resto.
- **Non tocca mai** i link `manual` (Domain Model §5.1).
- **Possiede:** MediaLink (`origin=auto`), IdentificationCase.
- **Dipende da:** Media Analyzer (fatti), Metadata Provider Adapter (ricerca), Catalog (item esistenti a cui agganciarsi).

### 3.4 Metadata Provider Adapter
- **Fa:** isola le API esterne (ricerca, dettagli, artwork, persone) dietro un **contratto interno neutro**. È l'unico componente che conosce un provider specifico.
- **Gestisce:** rate limiting, retry, cache delle risposte, lingua (`it-IT` con fallback sull'originale).
- **Perché:** il provider non è ancora scelto (§12). Cambiarlo o affiancarne un secondo tocca solo questo componente.
- **Possiede:** nessun dato di dominio (solo la cache delle risposte).

### 3.5 Metadata Enricher
- **Fa:** applica i metadata ottenuti ai CatalogItem **rispettando provenienza e campi locked**. Crea Season/Episode mancanti, scarica l'artwork tramite l'Artwork Store, pianifica i refresh.
- **Degrado:** se il provider non risponde, l'item resta nel catalogo con i metadata disponibili (anche solo il titolo dal filename) e il refresh viene riprovato. La libreria non si blocca (§12).
- **Dipende da:** Metadata Provider Adapter, Catalog, Artwork Store.

### 3.6 Catalog
- **Fa:** è il cuore del dominio catalogo.
  - Gerarchie Series → Season → Episode ed Extra associati.
  - Correzioni manuali: rematch, modifica dei campi con lock, scelta dell'artwork (§13).
  - Query di navigazione: liste per kind/category, **ricerca** (titolo italiano e originale), **filtri** (genere, anno, risoluzione, HDR…), **ordinamento**, "Aggiunti di recente" (§16).
- **Possiede:** CatalogItem, ExternalId, Person, Credit, MediaLink `manual`.

### 3.7 Artwork Store
- **Fa:**
  - Conserva localmente l'artwork (dal provider, caricato a mano, generato dal video).
  - Produce **varianti** per dimensione e client (una thumbnail della griglia non deve scaricare un poster da 2 MB).
  - Genera i frame dal video (still degli episodi; in futuro l'anteprima nella barra di seek).
- **Possiede:** Artwork e file immagine nel volume dati.

### 3.8 Profiles & Watch State
- **Fa:**
  - Gestisce profili e preferenze (lingue audio/sub).
  - Registra progress, WatchState, ViewingRecord e Watchlist.
  - Calcola le viste derivate: **Continua a guardare**, **prossimo episodio**, serie/stagione vista (Domain Model §7).
- **Possiede:** Profile, PlaybackProgress, WatchState, ViewingRecord, WatchlistEntry.
- **Non conosce** file e delivery: riceve eventi di progress dal Session Manager.

### 3.9 Playback Decision Engine
- **Fa:** decide *come* servire un item a un client.
  - **Input:** file disponibili per l'item (Domain Model D2), capability del client, preferenze del profilo, vincoli di rete.
  - **Output:** file scelto, **modalità** (`direct_play` / `direct_stream` / `transcode`), tracce selezionate e trasformazioni necessarie (conversione audio, burn-in dei sottotitoli immagine, downscale, tone-mapping HDR→SDR).
- **Proprietà:** **logica pura, senza I/O**. È il componente più testabile e il più critico per la qualità (§5, §18: "evitare degradazioni non necessarie").
- **Possiede:** nessun dato.

### 3.10 Session Manager
- **Fa:**
  - Crea e traccia le `PlaybackSession`.
  - Applica il limite di concorrenza (MVP 1, target 3, §8).
  - Riceve heartbeat e progress dal client e li inoltra a Profiles & Watch State.
  - Libera le risorse (processi, file temporanei) su stop, timeout o abbandono.
  - Gestisce il **cambio in corsa** (traccia audio o sottotitoli, seek), che può richiedere una nuova decisione di delivery.
- **Possiede:** PlaybackSession (runtime).
- **Dipende da:** Playback Decision Engine, Stream Delivery, Profiles & Watch State.

### 3.11 Stream Delivery
- **Fa:** esegue la decisione.
  - **Direct Play:** serve il file originale così com'è, con accesso a intervalli per il seek.
  - **Direct Stream:** rimpacchetta al volo copiando il video. Converte solo ciò che serve (container, audio).
  - **Transcode:** ricodifica (fallback).
  - **Sottotitoli:** i testuali vengono serviti in un formato leggibile dal client; quelli immagine passano in pass-through se il client li supporta, altrimenti vengono bruciati nel video.
- **Gestisce:** processi di elaborazione media, file temporanei/segmenti (volume **scratch** effimero), futura accelerazione hardware.
- **Proprietà:** è il componente più **pesante** e l'unico con picchi di CPU/GPU. Deve essere isolabile (vedi §6, C1).
- **Dipende da:** Media Storage (lettura), scratch.

### 3.12 Job Runner
- **Fa:** esegue il lavoro in background dell'ingest (analisi, identificazione, metadata, artwork, generazione dei frame).
  - Coda persistente e retry con backoff.
  - Priorità: l'utente che corregge un match viene prima della scansione iniziale di 500 film.
  - Visibilità dello stato ("sto indicizzando 12/340").
- **Perché:** l'ingest è asincrono e può durare ore alla prima scansione. Non deve mai rallentare il playback.

### 3.13 API
- **Fa:** unica superficie del Video Service verso i client, attraverso il gateway.
  - **Parte fruizione:** catalogo, profili, playback, progress.
  - **Parte gestione:** coda "Da verificare", correzioni, root, rescan, stato dei job.
- **Dettagli** in `03-interfaces.md`.

---

## 4. Proprietà dei dati

| Dato | Proprietario (unico che scrive) | Lettori |
|---|---|---|
| LibraryRoot, inventario path | Library Monitor | Analyzer, API gestione |
| MediaFile, MediaStream, Chapter | Media Analyzer | Identifier, Decision Engine, Delivery, Catalog (filtri) |
| MediaLink auto, IdentificationCase | Identifier | Catalog, API gestione |
| CatalogItem, metadata, MediaLink manual | Catalog (+ Enricher per i campi non locked) | tutti |
| Artwork | Artwork Store | API, client |
| Profile, progress, stato di visione | Profiles & Watch State | API, Decision Engine (preferenze) |
| PlaybackSession | Session Manager | API |

L'Enricher scrive i metadata del catalogo **solo** tramite le regole del Catalog (provenienza/lock). Ci sono due scrittori, ma una sola regola.

---

## 5. Flussi principali

### 5.1 Ingest (§11)
```text
Library Monitor ──file_discovered──► Job Runner
   → Media Analyzer   (fatti tecnici, fingerprint; se fingerprint noto → "spostato", stop)
   → Identifier       (candidati)
        ├─ confidente → MediaLink(auto) → Metadata Enricher → Artwork Store → item visibile
        └─ ambiguo    → IdentificationCase(needs_review) → coda "Da verificare"
```

### 5.2 Correzione manuale (§13)
```text
Utente (API gestione) → Catalog: MediaLink(manual) / campo locked / artwork scelto
                      → Enricher: refresh dal nuovo ExternalId, senza toccare i campi locked
```

### 5.3 Playback (§5, §15)
```text
Client ──"voglio riprodurre item X" + capability──► Session Manager
   → Decision Engine (file, modalità, tracce)
   → Stream Delivery (avvia direct/remux/transcode)
   ◄── URL dello stream + tracce disponibili + posizione di resume (da Profiles)
Client ──heartbeat/progress──► Session Manager ──► Profiles & Watch State
Client ──stop / timeout──► Session Manager: libera risorse, chiude ViewingRecord
```

---

## 6. Raggruppamento in container (MVP)

| Container | Contiene | Volumi |
|---|---|---|
| `gateway` | Gateway + asset statici del web client | — |
| `video` | Tutti i componenti §3 (monolite modulare) | media **RO**, dati app (artwork, cache), scratch effimero |
| `video-db` | Database, **se** la tecnologia scelta richiede un server separato | dati DB |

**C1 — decisione:** il Video Service nasce come **monolite modulare**, con confini interni netti che seguono questo documento.
- Stream Delivery è dietro un'interfaccia interna, così potrà diventare un container `video-worker` separato quando servirà: più sessioni, GPU dedicata, macchina diversa.
- Anche nel monolite l'elaborazione media gira in **processi figli**: un crash del transcode non abbatte il catalogo.
- **Perché non microservizi subito:** il requisito di indipendenza (§2) riguarda i **domini** (video vs musica), non i moduli interni al video. Separarli adesso aggiungerebbe complessità operativa senza un beneficio nell'MVP.

---

## 7. Comportamento in caso di guasto

| Guasto | Effetto atteso |
|---|---|
| Provider metadata irraggiungibile | Ingest continua; item con metadata parziali; refresh riprovato. Playback non impattato |
| Root di storage offline | Root segnata offline, item "non disponibili"; niente cancellazioni; ritorno automatico |
| Crash del processo di transcode/remux | Sessione in errore, il client può riprovare (anche con un'altra modalità); il resto del servizio è intatto |
| Video Service giù | Gateway e altri servizi restano su; i client mostrano "video non disponibile" |
| Riavvio del Video Service | Job ripresi dalla coda persistente; sessioni runtime perse (il client riapre); progress già salvato non perso |

---

## 8. Decisioni prese in revisione

| ID | Domanda | Decisione |
|---|---|---|
| C1 | Video Service: monolite modulare o componenti in container separati fin da subito? | Monolite modulare con Stream Delivery estraibile (§6) |
| C2 | Chi serve gli asset statici del web client? | Il gateway (un container in meno); container dedicato solo se il client avrà un server proprio |
| C3 | Dove vive l'interfaccia di gestione (coda "Da verificare", correzioni)? | Una sezione del web client; in LAN senza auth, in futuro protetta da ruolo |
