# 04 — Playback Architecture

- **Stato:** Approvato (2026-10-01). Le ipotesi [H#] restano da verificare con gli spike
- **Deriva da:** [Requisiti v0.1](../requirements/0001-video-service-requirements-v0.1.md) §4–6, §8–9, §18; [01](01-domain-model.md), [02](02-components.md), [03](03-interfaces.md)
- **Convenzione:** le affermazioni marcate **[H#]** sono **ipotesi** da verificare con gli spike (§10). Nessuna decisione tecnologica si basa su un'ipotesi non verificata.

---

## 1. Obiettivo di qualità

> Servire ogni contenuto con la **minima trasformazione necessaria** per quel client.

Si trasforma solo ciò che il client non sa gestire, e ogni trasformazione ha un costo esplicito in qualità e in risorse. La scala di preferenza per ogni dimensione è in §4.

---

## 2. Modalità di delivery

| Modalità | Video | Audio | Container | Sottotitoli | Costo server |
|---|---|---|---|---|---|
| **Direct Play** | originale | originale | originale | originali (resi dal client) | solo I/O |
| **Direct Stream** | **bitstream copiato**: risoluzione, HDR e bitrate intatti | copiato **o** convertito | cambiato se serve | estratti/convertiti (testo) | basso |
| **Transcode** | **ricodificato** | come Direct Stream | nuovo | anche bruciati nel video | alto (4K: molto alto) |

- **Direct Stream ≠ degradazione video.** È la modalità chiave per il browser: un remux Blu-ray quasi mai è riproducibile nel browser così com'è (container MKV, audio TrueHD/DTS-HD, sub PGS), ma il video di solito sì.
- **Il burn-in dei sottotitoli impone il Transcode.** Un sub PGS scelto su un client che non sa renderlo trasforma una sessione 4K "quasi gratis" in una ricodifica completa. Va evitato quando esiste un'alternativa (§4.4).

---

## 3. Algoritmo di decisione (Playback Decision Engine)

Logica **pura** (Componenti §3.9, Interfacce §8). Per ogni file candidato dell'item (Domain Model D2):

```text
per ogni file candidato:
    scegli le tracce (§3.1)
    per ogni dimensione [container, video, audio, sottotitoli, bitrate]:
        valuta contro le ClientCapabilities → nessuna azione | azione minima necessaria
    modalità = la più "pesante" richiesta da una qualsiasi dimensione
    costo = (perdita di qualità, costo server)
scegli il file con: 1) modalità più leggera, 2) qualità più alta, 3) costo server minore
restituisci PlaybackPlan { file, modalità, tracce, azioni per dimensione, motivi }
```

I **motivi** ("audio TrueHD non supportato dal browser → conversione") finiscono nella PlaybackSession e in `ExplainPlaybackDecision` (Interfacce §4.3, §6).

### 3.1 Selezione delle tracce

1. **Scelta esplicita** del client (`StartPlayback`/`ChangeTracks`): viene rispettata sempre, anche se costa una trasformazione.
2. **Ultima scelta** del profilo su quell'item (resume con le stesse tracce).
3. **Preferenze del profilo:** lingua audio preferita; poi, nella lingua scelta, la traccia di **qualità più alta** (politica P1).
4. **Sottotitoli:** secondo la modalità del profilo (off / solo forced / sempre). Con "solo forced" si attiva automaticamente la traccia forced nella lingua dell'audio, se esiste.

---

## 4. Regole per dimensione

### 4.1 Container

| Client | Direct Play di MKV |
|---|---|
| Android TV / mobile (Media3/ExoPlayer) | sì, MKV supportato nativamente |
| Browser | **non affidabile [H1]** → remux verso un container adatto allo streaming nel browser (fMP4 segmentato o equivalente, scelta in S2/S3) |

Remux = Direct Stream, non una degradazione.

### 4.2 Video

| Caso | Azione |
|---|---|
| Codec/profilo/livello supportati, risoluzione ≤ max | nessuna |
| HEVC Main10 nel browser | nessuna **se** decodificabile: Chrome/Edge su Windows con decoder hardware **[H2]**; altrimenti Transcode |
| HDR10 su client/display SDR | Transcode con **tone-mapping** (costoso; candidato all'accelerazione hardware) |
| HDR10 su client HDR | nessuna; metadata HDR preservati nella copia **[H3]** |
| **Dolby Vision profilo 7** (UHD Blu-ray) | La maggior parte dei device riproduce il **base layer HDR10** ignorando l'enhancement layer. Default: servire il file com'è, con fallback HDR10. Conversione in DV profilo 8.1 durante lo stream = evoluzione futura **[H4]** |
| DV profilo 5/8 | DV se supportato, altrimenti HDR10/SDR secondo la compatibilità del base layer |
| Risoluzione > max del client | Transcode con downscale, **oppure** scelta di un altro file dell'item (D2), preferibile |

### 4.3 Audio — scala di qualità

Dal migliore al peggiore:

1. **Passthrough del bitstream originale** (TrueHD/Atmos, DTS-HD MA/DTS:X) verso l'AVR. Qualità originale, oggetti Atmos inclusi.
2. **Decodifica sul client → PCM multicanale** via HDMI. Canali lossless, oggetti Atmos persi. Utile quando il device decodifica TrueHD ma non lo fa passare in bitstream **[H5]**.
3. **Conversione sul server in formato lossless supportato** (es. FLAC multicanale per il browser) **[H6]**. Lossless, Atmos perso. Il browser può comunque fare downmix.
4. **Conversione in lossy multicanale** (E-AC3/AC3 5.1).
5. **Conversione in stereo** (AAC/Opus): solo quando il client è davvero stereo (mobile con cuffie).

- Una **traccia compatibile già presente** nella stessa lingua (es. core AC3 separato dal remux) è un'alternativa a costo zero. Viene preferita **solo** se la politica P1 lo consente.
- Il **passthrough** è una capability distinta dalla **decodifica** (Interfacce §4.1). La TV la dichiara in base a cosa accetta l'AVR sull'HDMI.

### 4.4 Sottotitoli

| Tipo | Client che li rende | Client che non li rende |
|---|---|---|
| Testo (SRT) | in-stream o sidecar | convertiti in formato testo supportato (es. WebVTT) |
| Testo stilizzato (ASS) | render nativo/libreria | conversione in testo semplice (stile perso) **o** burn-in (scelta del profilo; default: testo semplice) |
| **Immagine (PGS/VobSub)** | pass-through (Media3 supporta PGS) | **render lato client** con libreria dedicata se fattibile **[H7]**; ultima risorsa: **burn-in → Transcode** |

### 4.5 Bitrate e rete

- I remux UHD hanno picchi oltre **100 Mbps**. Una LAN cablata gigabit li regge; il **Wi-Fi verso un device TV spesso no** → rischio concreto per il Direct Play (§7).
- Il client può dichiarare un **bitrate max** (misurato o impostato dall'utente). Se il file lo supera, l'alternativa è un altro file dell'item o il Transcode. **Mai in silenzio**: il motivo viene mostrato.

---

## 5. Rilevamento delle capability per piattaforma

| Piattaforma | Come |
|---|---|
| **Web** | API del browser: supporto per tipo MIME/codec, capacità di decodifica con parametri HDR (funzione di trasferimento, gamut), media query per display HDR. Il browser **non fa passthrough audio**: il massimo è la decodifica. Sub: ciò che rende il player che scegliamo |
| **Android TV / mobile** | Elenco dei codec del device (profili/livelli), capacità HDR del display, **capability audio dell'HDMI (EDID dell'AVR)** esposte dal player: codifiche in passthrough e canali |
| **Override lato server** (I2) | Tabella per modello di device/versione app: corregge dichiarazioni errate note. Alimentata anche dai fallimenti reali (§8) |

Le capability si rilevano **a ogni avvio** del client: l'AVR può essere acceso, spento o cambiato.

---

## 6. Sessioni, seek e cambio tracce

### 6.1 Timeline

- **Invariante:** posizione, resume, progress e capitoli sono sempre espressi nella **timeline del media originale**, mai in quella dello stream.
- Uno stream elaborato che parte da 01:47:23 deve riportare le posizioni come 01:47:23+, non come 00:00+. Questo garantisce un resume coerente fra modalità e fra client diversi.

### 6.2 Seek

| Modalità | Seek |
|---|---|
| Direct Play | Gestito dal client con richieste a intervalli sul file originale |
| Direct Stream / Transcode | Gestito dal protocollo di streaming. Se la posizione non è ancora disponibile, lo Stream Delivery **riavvia la pipeline dalla posizione richiesta** (dal keyframe più vicino). Latenza da misurare **[H8]** |

### 6.3 Cambio traccia in corsa

- Audio/sub disponibili nello stream corrente (es. sub testuali sidecar) → cambio **lato client, senza riavvio**. Il flag "cambio senza riavvio" è già nella PlaybackSession.
- Altrimenti → nuova decisione e riavvio della pipeline dalla posizione corrente. Se la nuova traccia impone il burn-in, la UI lo segnala.

---

## 7. Concorrenza e risorse

- **Costi per modalità:** Direct Play ≈ banda + I/O disco; Direct Stream ≈ + CPU bassa; Transcode ≈ CPU/GPU alta (4K HEVC software: probabilmente oltre 1 sessione real-time su CPU desktop, da misurare **[H9]**).
- **Controllo di ammissione a due livelli:**
  - limite di **sessioni** (MVP 1, target 3, §8);
  - limite separato di **Transcode simultanei** (P4). Superato il limite, una nuova sessione che richiede Transcode fallisce con motivo chiaro; Direct Play e Direct Stream restano possibili.
- **Scratch:** i segmenti temporanei vivono in un volume effimero con **quota**. Vengono cancellati alla chiusura della sessione e all'avvio del servizio (sessioni orfane).
- **Rete:** per la TV principale si raccomanda una **connessione cablata**. È un requisito di installazione, non software, ma va scritto nella documentazione utente.

---

## 8. Fallback a runtime

```text
il client riceve il plan → prova a riprodurre
    └─ errore del decoder/player nonostante la capability dichiarata
         → il client lo segnala (sessione, errore, dimensione sospetta)
         → il server ripianifica con una modalità più pesante (Direct Play → Direct Stream → Transcode)
         → registra il caso (device, formato) per la tabella di override
```

Un fallimento in Direct Play non deve lasciare l'utente davanti a uno schermo nero: la ripianificazione è **automatica**. Il motivo resta consultabile nella diagnostica.

---

## 9. Evoluzioni previste (non MVP)

- Accelerazione hardware per Transcode e tone-mapping.
- DV profilo 7 → 8.1 durante lo stream **[H4]**.
- Adaptive bitrate (più qualità in parallelo) per l'accesso remoto: sul lato LAN non serve.
- Trickplay (anteprime sulla barra di seek).
- Più istanze di Stream Delivery (container `video-worker`, Componenti C1).

---

## 10. Ipotesi da verificare → spike

| ID | Ipotesi | Spike |
|---|---|---|
| H1 | I browser non riproducono MKV in modo affidabile | S2 |
| H2 | Chrome/Edge su Windows decodificano HEVC Main10 (anche HDR10) in hardware; Firefox no | S2 |
| H3 | Il remux con video copiato preserva i metadata HDR10 (e DV) | S1/S2 |
| H4 | La conversione DV P7→P8.1 in streaming è fattibile con i tool disponibili | futuro (fase TV) |
| H5 | Il device Android TV scelto fa passthrough TrueHD/DTS-HD verso l'AVR, o almeno li decodifica in PCM | fase client TV |
| H6 | Il browser riproduce FLAC multicanale nel container di streaming scelto | S2 |
| H7 | Esiste un renderer PGS lato browser affidabile (sync, prestazioni in 4K) | S2 |
| H8 | Il riavvio della pipeline al seek in Direct Stream ha una latenza accettabile (obiettivo: < 2–3 s) | S3 |
| H9 | Costo del Transcode 4K software su questo PC | S3 |

---

## 11. Decisioni prese in revisione

| ID | Domanda | Decisione |
|---|---|---|
| P1 | Selezione automatica dell'audio: prima la qualità o prima la compatibilità? | **Prima la qualità**: la traccia migliore nella lingua preferita, con la trasformazione minima. Una traccia compatibile di qualità inferiore si usa solo se la migliore richiederebbe un Transcode video (non succede mai per il solo audio) |
| P2 | Transcode nell'MVP? | **Direct Play + Direct Stream completi; Transcode minimo** (software, 1 sessione, per burn-in e codec non supportati). Accelerazione hardware dopo |
| P3 | PGS nel web client | **Render lato client** se S2 conferma H7; altrimenti burn-in |
| P4 | Transcode simultanei massimi | **1**, indipendente dal limite di sessioni; configurabile |
