# Home Media Platform
## Video Streaming — Product & System Requirements v0.1

**Stato:** Draft iniziale  
**Scope:** sottosistema Video  
**Fase:** definizione requisiti / pre-architettura

---

## 1. Visione

L'obiettivo è realizzare una piattaforma home media self-hosted per la fruizione della propria collezione audiovisiva digitalizzata.

Il sistema dovrà offrire un'esperienza paragonabile, dal punto di vista della fruizione, a una piattaforma di streaming commerciale, mantenendo però:

- pieno controllo sui file;
- qualità originale dei supporti fisici;
- infrastruttura self-hosted;
- client proprietari;
- indipendenza dai servizi di streaming commerciali.

La piattaforma complessiva sarà composta da più servizi indipendenti.

Il presente documento riguarda esclusivamente il **Video Service**.

Il servizio musicale sarà progettato separatamente.

---

# 2. Principi architetturali generali

L'intera piattaforma dovrà essere containerizzata.

I differenti domini funzionali dovranno essere separati in servizi indipendenti.

In particolare:

```text
Home Media Platform

├── Video Service
├── Music Service             [future]
├── Gateway / Reverse Proxy
├── Video Clients
│   ├── Desktop / Web
│   ├── TV
│   └── Mobile
└── Shared Media Storage
```

Video e musica non devono appartenere allo stesso servizio applicativo.

Ogni servizio deve poter essere:

- avviato;
- fermato;
- riavviato;
- aggiornato;
- sostituito;

indipendentemente dagli altri.

L'indisponibilità del servizio video, ad esempio, non deve rendere indisponibile il servizio musicale.

La prima implementazione sarà orchestrata tramite **Docker / Docker Compose**.

---

# 3. Storage

I file multimediali sono asset esterni ai servizi applicativi.

Il Video Service **non è proprietario dei file originali**.

Concettualmente:

```text
Media Storage
      │
      │ read
      ▼
Video Service
```

Durante il prototipo lo storage potrà essere semplicemente una directory del computer host.

In futuro potrà essere sostituito da:

- dischi dedicati;
- storage collegato al server;
- NAS;
- altra soluzione di storage di rete.

Questa evoluzione non dovrà richiedere una riprogettazione sostanziale del Video Service.

Idealmente il media storage viene montato nel container video in modalità **read-only**, mentre database, cache, thumbnail e altri dati applicativi utilizzano volumi separati.

---

# 4. Sorgenti video

La sorgente principale della libreria sarà costituita da copie digitali dei supporti fisici posseduti.

Il caso d'uso principale è:

```text
Blu-ray / UHD Blu-ray
        ↓
       rip
        ↓
      remux
        ↓
       MKV
```

La piattaforma deve essere progettata assumendo file di qualità molto elevata.

Il remux deve poter preservare i flussi originali senza ricompressione preventiva.

Il sistema deve quindi poter gestire contenuti quali:

- Blu-ray 1080p;
- UHD Blu-ray 4K;
- bitrate elevati;
- HDR, quando presente;
- audio multicanale lossless;
- più tracce audio;
- più tracce sottotitoli.

La qualità del supporto originale deve poter essere mantenuta end-to-end quando il client è in grado di riprodurla.

---

# 5. Strategia di playback

Il comportamento desiderato è:

```text
                 ┌─ Client compatibile
Media originale ─┤
                 └─ Client non compatibile
```

Nel primo caso:

```text
Media originale
      ↓
 DIRECT PLAY
      ↓
    Client
```

Nel secondo:

```text
Media originale
      ↓
 adattamento /
 transcoding
      ↓
    Client
```

## 5.1 Direct Play

Il **Direct Play è il percorso preferenziale**.

Quando rete e client lo consentono, il sistema deve trasmettere il contenuto senza alterare inutilmente i flussi originali.

Questo è particolarmente importante per il client TV principale.

## 5.2 Transcoding

Il transcoding rappresenta un fallback.

Deve essere utilizzabile quando, ad esempio:

- il client non supporta il codec video;
- il client non supporta il codec audio;
- il dispositivo non supporta la risoluzione originale;
- altre incompatibilità rendono impossibile il Direct Play.

L'implementazione concreta del transcoding non viene ancora definita.

---

# 6. Audio e sottotitoli

La selezione delle tracce da conservare avviene durante il processo di ripping/remux.

Il Video Service non deve quindi necessariamente preservare tutte le tracce presenti sul supporto fisico originale.

Tuttavia, tutte le tracce presenti nel media importato devono essere correttamente rilevate.

Il player deve permettere almeno:

- selezione della traccia audio;
- selezione della traccia sottotitoli;
- disattivazione dei sottotitoli.

Non deve esistere l'assunzione:

```text
1 video = 1 audio track
```

---

# 7. Client

La piattaforma non utilizzerà semplicemente client media di terze parti.

L'esperienza utente fa parte del prodotto.

Sono previsti client proprietari per almeno tre categorie.

### Desktop

Accesso tramite browser/web application.

### TV

Applicazione/interfaccia dedicata alla fruizione sul televisore principale.

Il client TV rappresenta uno dei casi d'uso principali per la riproduzione alla qualità originale.

### Mobile

Client per smartphone/tablet.

L'implementazione tecnologica dei client non è ancora definita.

Potranno eventualmente condividere codice, componenti o tecnologie, ma ciò non costituisce attualmente un requisito.

---

# 8. Concorrenza

### MVP

Il primo prototipo deve supportare correttamente:

**1 sessione di streaming attiva.**

### Target architetturale

L'architettura deve essere progettata senza assumere una singola sessione e deve poter evolvere verso:

**fino a 3 sessioni di streaming simultanee.**

Le sessioni potranno essere eterogenee.

Esempio:

```text
TV
└── 4K Direct Play

Tablet
└── Direct Play / Transcode

Smartphone
└── Direct Play / Transcode
```

Non viene attualmente imposto il requisito di supportare tre transcodifiche 4K simultanee.

Il dimensionamento hardware verrà affrontato successivamente.

---

# 9. Networking

## MVP

La prima versione sarà disponibile esclusivamente sulla:

**LAN domestica.**

Non è necessario implementare immediatamente:

- esposizione pubblica;
- accesso Internet;
- autenticazione Internet-grade;
- gestione della banda WAN;
- remote streaming.

## Evoluzione prevista

L'accesso remoto è considerato una futura evoluzione della piattaforma.

L'architettura non deve introdurre vincoli inutili che rendano necessario riscrivere il Video Service per supportarlo.

In particolare, la logica applicativa non dovrebbe dipendere dall'assunzione che client e server appartengano necessariamente alla stessa subnet.

---

# 10. Libreria

La libreria non deve essere modellata come un semplice elenco di file.

Deve rappresentare un **catalogo audiovisivo strutturato**.

Devono essere previsti almeno:

```text
Movie

Documentary

Series
 ├── Season
 │    ├── Episode
 │    ├── Episode
 │    └── ...
 └── ...

Extra
```

Gli extra devono poter essere associati, quando necessario, ad altri elementi del catalogo.

Il modello dati preciso verrà definito successivamente.

È però un requisito esplicito che l'architettura iniziale **non assuma che ogni Video sia un Movie**.

---

# 11. Ingest della libreria

Il sistema deve utilizzare un modello:

**automatic-first, manually-correctable.**

Flusso concettuale:

```text
Nuovo media
     ↓
Directory monitorata
     ↓
Rilevamento
     ↓
Analisi file
     ↓
Tentativo identificazione
     ↓
 ┌───────────────┐
 │ identificato? │
 └───────┬───────┘
         │
    ┌────┴────┐
   sì         no / ambiguo
    │             │
    ▼             ▼
catalogo      da verificare
                  │
                  ▼
            intervento manuale
```

Il sistema dovrebbe tentare di ricavare automaticamente l'identità del contenuto utilizzando informazioni quali:

- filename;
- struttura delle directory;
- metadata disponibili;
- servizi/database esterni.

L'utilizzo di sistemi AI può essere valutato successivamente come ulteriore resolver per casi ambigui.

Non costituisce al momento una scelta architetturale.

---

# 12. Metadata

Una volta identificato un contenuto, il sistema dovrà poter ottenere automaticamente metadata descrittivi.

Esempi:

- titolo;
- titolo originale;
- anno;
- descrizione;
- poster;
- backdrop;
- generi;
- cast;
- regista;
- altri metadata utili.

La fonte concreta non è ancora stata scelta.

I dati ottenuti automaticamente devono essere memorizzabili localmente.

Il funzionamento della libreria non deve dipendere permanentemente dalla disponibilità dell'API esterna.

---

# 13. Correzione manuale

Qualunque identificazione automatica deve poter essere corretta.

Deve essere possibile:

- associare manualmente un file al contenuto corretto;
- modificare i metadata;
- correggere titolo o anno;
- sostituire poster e artwork;
- modificare informazioni precedentemente importate.

Un'identificazione automatica non deve diventare immutabile.

I contenuti non identificati o identificati con sufficiente ambiguità dovrebbero poter essere presentati in una sezione equivalente a:

**Da verificare / Unmatched Media.**

---

# 14. Profili

La piattaforma deve supportare **profili multipli**.

La libreria multimediale rimane comune.

Lo stato di fruizione è invece associato al singolo profilo.

Concettualmente:

```text
              Shared Library
                    │
       ┌────────────┴────────────┐
       │                         │
   Profile A                 Profile B
       │                         │
   progress                  progress
   history                   history
   watchlist                 watchlist
```

Profilo e account non devono necessariamente coincidere.

Per la versione LAN iniziale è accettabile una selezione del profilo senza un sistema di autenticazione complesso.

L'autenticazione vera potrà essere introdotta con il futuro accesso remoto.

---

# 15. Tracking della visione

Il tracking è parte dell'MVP.

Lo stato deve essere mantenuto separatamente per ogni profilo.

Devono essere previsti almeno:

### Playback progress

Memorizzazione della posizione corrente.

Esempio:

```text
Film
01:47:23 / 02:31:00
```

### Resume

Possibilità di riprendere automaticamente la riproduzione dal punto precedente.

### Continue Watching

Visualizzazione dei contenuti iniziati e non terminati.

### Watched state

Possibilità di determinare se un contenuto è già stato visto.

### History

Cronologia delle visualizzazioni associata al profilo.

---

# 16. Navigazione

La prima versione non necessita di un recommendation engine.

Non sono attualmente richieste funzionalità quali:

- "Perché hai guardato...";
- raccomandazioni AI;
- collaborative filtering;
- suggerimenti personalizzati;
- recommendation engine.

La priorità è **navigare efficacemente la propria collezione**.

La UI potrà quindi offrire elementi deterministici quali:

```text
Home

├── Continua a guardare
├── Aggiunti di recente
├── Film
├── Serie
└── Documentari
```

Sono inoltre previste funzionalità di:

- ricerca;
- filtro;
- ordinamento;
- navigazione del catalogo.

---

# 17. Casi limite deliberatamente esclusi

Il progetto non deve tentare in questa fase di modellare ogni possibile caso collezionistico.

Ad esempio, versioni differenti dello stesso film — theatrical cut, director's cut, Final Cut, diverse edizioni fisiche — possono inizialmente essere rappresentate come elementi distinti.

Non viene quindi richiesto per l'MVP un modello complesso:

```text
Work
 └── Edition
      └── Media Version
```

Questo potrà essere introdotto successivamente se emergerà una necessità reale.

---

# 18. Requisiti non funzionali

Il sistema dovrà privilegiare:

### Modularità

Il Video Service deve essere indipendente dagli altri servizi della piattaforma.

### Portabilità

Il sistema deve poter passare progressivamente da:

```text
Developer PC
     ↓
Mini PC / Home Server
     ↓
Dedicated Storage / NAS
```

senza una riscrittura applicativa.

### Resilienza

Il fallimento di un servizio non deve causare il fallimento degli altri domini della piattaforma.

### Qualità

Il sistema deve evitare conversioni o degradazioni del media quando non necessarie.

### Evolvibilità

Decisioni relative a:

- accesso remoto;
- autenticazione;
- NAS;
- hardware definitivo;
- recommendation engine;
- streaming musicale;

devono poter essere introdotte successivamente.

---

# 19. MVP iniziale

Il primo prototipo non deve tentare di realizzare l'intera piattaforma.

Un primo vertical slice ragionevole dovrà permettere:

```text
Media MKV locale
      ↓
Video Service containerizzato
      ↓
Indicizzazione
      ↓
Catalogo
      ↓
Web Client
      ↓
Selezione film
      ↓
Playback
      ↓
Salvataggio progress
      ↓
Resume
```

Per il primo prototipo:

- storage locale;
- Docker Compose;
- LAN;
- singolo stream;
- singolo client web iniziale;
- nessun accesso remoto;
- nessuna recommendation;
- nessun Music Service necessario;
- nessuna infrastruttura NAS necessaria.

Il prototipo dovrà però essere coerente con i requisiti del sistema definitivo e non costituire un'implementazione usa-e-getta.

---

# 20. Decisioni deliberatamente ancora aperte

Il brainstorming svolto finora **non è sufficiente per scegliere responsabilmente lo stack tecnico**.

Restano intenzionalmente aperte:

- linguaggio/framework del Video Service;
- database;
- protocollo/API tra client e server;
- strategia concreta di streaming;
- implementazione Direct Play;
- implementazione transcoding;
- motore di transcoding;
- modalità di capability detection dei client;
- player video;
- tecnologia client TV;
- tecnologia client mobile;
- API/provider dei metadata;
- sistema di filesystem watching;
- formato e strategia delle thumbnail;
- reverse proxy;
- strategia di caching;
- hardware server;
- accelerazione hardware;
- NAS;
- struttura definitiva dei container;
- autenticazione futura;
- remote streaming.

Queste non devono essere decise per comodità o per abitudine.

La fase successiva del progetto dovrà trasformare i requisiti di questo documento in **componenti e responsabilità**, e solo successivamente confrontare le tecnologie adatte a implementarli.

---

# 21. Stato attuale del progetto

Abbiamo quindi definito **cosa deve essere il sistema video**, ma non ancora **come costruirlo**.

Il prossimo documento tecnico dovrà partire da questi requisiti e definire:

```text
Requirements
      ↓
Domain Model
      ↓
System Components
      ↓
Component Responsibilities
      ↓
Interfaces
      ↓
Playback Architecture
      ↓
Technology Evaluation
      ↓
Technology Selection
      ↓
MVP Implementation Plan
```

Questo ordine è intenzionale: la tecnologia dovrà derivare dai requisiti, non il contrario.