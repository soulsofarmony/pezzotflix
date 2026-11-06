# 04 — Playback Architecture

- **Stato:** Approvato (2026-10-01). Aggiornato il 2026-11-05 con gli esiti di S2 e della loro revisione (§2, §4, §5, §6.3, §7, §8, §10 con la nuova H11, §11). Le ipotesi [H#] ancora aperte restano da verificare con gli spike
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
| **Direct Play** | originale | originale | originale | originali, resi dal client: dal file, oppure estratti e serviti a parte | solo I/O. Se i sottotitoli embedded vanno serviti a parte, anche la loro estrazione, che legge tutto il file (§4.4) |
| **Direct Stream** | **bitstream copiato**: risoluzione, HDR e bitrate intatti | copiato **o** convertito | cambiato se serve | estratti: testo convertito in WebVTT (delivery `sidecar`), immagine come `.sup` a parte per il render lato client (delivery `client_render`, Interfacce §4.3) | basso, più l'estrazione dei sottotitoli (§4.4) |
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
scegli il file con: 1) nessun transcode video prima di un transcode, 2) qualità più alta,
                   3) modalità più leggera, 4) fileId (ordine stabile)   (decisione P6)
restituisci PlaybackPlan { file, modalità, tracce, azioni per dimensione, motivi }
```

I **motivi** ("audio TrueHD non supportato dal browser → conversione") finiscono nella PlaybackSession e in `ExplainPlaybackDecision` (Interfacce §4.3, §6).

### 3.1 Selezione delle tracce

1. **Scelta esplicita** del client (`StartPlayback`/`ChangeTracks`): viene rispettata sempre, anche se costa una trasformazione.
2. **Ultima scelta** del profilo su quell'item (resume con le stesse tracce).
3. **Preferenze del profilo:** lingua audio preferita; poi, nella lingua scelta, la traccia di **qualità più alta** (politica P1).
4. **Sottotitoli:** secondo la modalità del profilo (off / solo forced / sempre). Con "solo forced" si attiva automaticamente la traccia forced nella lingua dell'audio, se esiste.

Precisazioni decise in F1b (2026-11-05, orchestratore su delega):
- **Le tracce sono per file.** Una scelta esplicita vale sul file per cui è stata fatta. Su un'altra versione dello stesso item si cerca la traccia equivalente (lingua, codec, canali, commento, SDH, forced) come scelta ricordata; se non c'è, decidono le preferenze. Su un item con più versioni, chi indica una traccia deve indicare anche il file.
- **L'ultima scelta è morbida.** Passa dalle stesse regole delle preferenze (commento in fondo, fallback di P1) e non fa mai fallire il piano. Una scelta che il profilo non ha mai fatto non viene ricordata: "sconosciuta" non vuol dire "spenta".
- **Sottotitoli "spenti" per un titolo** (scelta esplicita o ricordata) vuol dire niente sottotitoli completi. La traccia forced nella lingua dell'audio resta, come in "solo forced", perché fa parte del film (dialoghi in un'altra lingua). La modalità "off" del profilo non cambia.

Precisazioni decise in F1b.4 (2026-11-06, orchestratore su delega):
- **Transcode software fino a 1080p.**
  - Encoder: libx264 veryfast, CRF 21 con un tetto di bitrate (VBV), livello H.264 dalla tabella.
  - HDR → SDR: zscale e tonemap hable, poi bt709.
  - Deinterlacciamento `bwdif`, solo sui frame marcati come interlacciati.
  - IDR forzati sulla griglia da 4 s.
  - Riavvio con un segmento di pre-roll (ADR 0003, decisione 4).
- **Burn-in.**
  - PGS con un overlay.
  - Testo con libass, su un file ASS già estratto.
  - Un sidecar `.sup` non si imprime: il motore non lo pianifica.
  - Nel burn-in di un ASS interno al file mancano i font allegati all'MKV (lacuna nota).
- **Un sottotitolo interno fallito** sul server esclude la traccia al successivo avvio che la seleziona, con una ripianificazione immediata.

---

## 4. Regole per dimensione

### 4.1 Container

| Client | Direct Play di MKV |
|---|---|
| Android TV / mobile (Media3/ExoPlayer) | sì, MKV supportato nativamente |
| Browser | **non affidabile** ([H1 ✅](../spikes/S2-browser-playback.md)): il browser scarta in silenzio l'audio che non decodifica (TrueHD, DTS) e non lascia scegliere la traccia. Direct Play di MKV **solo se il file ha una sola traccia audio, supportata dal browser**; altrimenti remux in fMP4 (Direct Stream; protocollo nell'ADR 0003).<br>Finché non è misurato altro, la traccia deve avere un codec provato in MKV: AAC, oppure AC-3/E-AC-3 in Edge (S2, d1–d3). FLAC, Opus e PCM in MKV non sono misurati.<br>Le sorgenti **Dolby Vision** nel browser vanno sempre in Direct Stream con `hvc1` (§4.2): il DV in MKV non è misurato |

- Remux = Direct Stream, non una degradazione.
- La regola del browser vale per ogni client che non sa scegliere la traccia audio dentro un container multi-traccia: lo dichiara con `audioTrackSelection` (Interfacce §4.1).

### 4.2 Video

| Caso | Azione |
|---|---|
| Codec/profilo/livello supportati, risoluzione ≤ max | nessuna |
| HEVC Main10 nel browser | nessuna **se** il browser lo decodifica: Chrome, Edge e Firefox su Windows con decoder hardware; Edge e Firefox richiedono l'estensione HEVC di Windows ([H2](../spikes/S2-browser-playback.md)). Altrimenti Transcode, che per il 4K nell'MVP non c'è (P2) |
| HDR10 su client/display SDR | Se il client presenta da sé l'HDR10 su SDR (il browser lo fa senza errori; resa da verificare: [S2](../spikes/S2-browser-playback.md), P5): nessuna azione, con il motivo esplicito nella sessione. Altrimenti Transcode con **tone-mapping** (costoso; candidato all'accelerazione hardware; per il 4K nell'MVP non c'è, P2) |
| HDR10 su client HDR | nessuna: la segnalazione HDR (BT.2020/PQ) resta nella copia, in MKV e in fMP4 ([H3 ✅](../spikes/S2-browser-playback.md)). I metadata statici nel bitstream (SEI) restano; i box `mdcv`/`clli` dell'fMP4 ci sono solo se il container sorgente li porta |
| **Dolby Vision profilo 7** (UHD Blu-ray) | La maggior parte dei device riproduce il **base layer HDR10** ignorando l'enhancement layer. Default: servire il file com'è, con fallback HDR10. Conversione in DV profilo 8.1 durante lo stream = evoluzione futura **[H4]** |
| DV profilo 5/8 | DV se supportato, altrimenti HDR10/SDR secondo la compatibilità del base layer |
| **Dolby Vision nel browser** | Nessun browser riproduce DV ([S2](../spikes/S2-browser-playback.md)): con il tag `dvh1` lo stream viene rifiutato.<br>- **P8.1:** si serve come HDR10 con il tag `hvc1`, video copiato e RPU nel flusso, senza box DV (misurato in S2).<br>- **P7:** non misurato, manca un sample (S1). Regola provvisoria **[H11]**, come fa Jellyfin per i client solo HDR10: si tolgono i layer DV (RPU ed EL) con un filtro di bitstream, senza ricodificare il video: `hevc_metadata=remove_dovi=1` di jellyfin-ffmpeg (l'opzione c'è nell'immagine; l'effetto su un P7 è da verificare). `dovi_rpu=strip=1` di FFmpeg non basta: toglie solo l'ultima unità NAL e lascia l'EL. Poi si serve come HDR10 con `hvc1`.<br>- Verso il browser **mai** `-strict unofficial` né un box DV.<br>- Un MKV con DV non va in Direct Play nel browser finché non è misurato (§4.1).<br>- **P5:** non ha un base layer compatibile: serve un Transcode, che per il 4K nell'MVP non c'è (P2). Da F1b.4 vale a ogni risoluzione: un DV senza base HDR10, HLG o SDR, anche con base ignota, dà `NO_COMPATIBLE_PLAN`, perché il tone-map HDR10 darebbe colori sbagliati.<br>Un errore fatale MSE porta alla ripianificazione (§8) e, per il 4K, a `NO_COMPATIBLE_PLAN` (P2) |
| Risoluzione > max del client | Transcode con downscale, **oppure** scelta di un altro file dell'item (D2), preferibile |

### 4.3 Audio — scala di qualità

Dal migliore al peggiore:

1. **Passthrough del bitstream originale** (TrueHD/Atmos, DTS-HD MA/DTS:X) verso l'AVR. Qualità originale, oggetti Atmos inclusi.
2. **Decodifica sul client → PCM multicanale** via HDMI. Canali lossless, oggetti Atmos persi. Utile quando il device decodifica TrueHD ma non lo fa passare in bitstream **[H5]**.
3. **Conversione sul server in formato lossless supportato**: FLAC multicanale (5.1 misurato in S2; 7.1 solo via API), che nel browser va in Chrome, Edge e Firefox ([H6 ✅](../spikes/S2-browser-playback.md)). Lossless, Atmos perso. Il browser può comunque fare downmix.
4. **Conversione in lossy multicanale.**
   - E-AC-3/AC-3 5.1 dove il client li decodifica. Nel browser solo Edge, e solo se Windows ha il decoder Dolby: le installazioni pulite di Windows 11 24H2 non hanno il codec AC-3 (S2, scoperta 3). Misurato in fMP4 con E-AC-3/AC-3 5.1 a 640 kb/s codificati da ffmpeg.
   - Altrimenti AAC 5.1 con channelConfiguration 6, oppure Opus 5.1.
   - **Mai AAC con PCE**, che fallisce in Chromium ed esce muto in Firefox.
   - Prima dell'encoder AAC o Opus il layout va portato da `5.1(side)`, che i decoder di ffmpeg danno per i codec dei Blu-ray, a `5.1` con i surround posteriori (`aformat=channel_layouts=5.1` o `-ac 6`). Per l'AAC evita il PCE. Per l'Opus serve con ffmpeg upstream, che rifiuta 5.1(side); jellyfin-ffmpeg lo rimappa da sé (S2).
   - Dopo l'encoder AAC lo Stream Delivery controlla che il channelConfiguration nell'`esds` sia diverso da 0. Se è 0 scarta lo stream e scende di un gradino.
5. **Conversione in stereo** (AAC/Opus): solo quando il client è davvero stereo (mobile con cuffie).

- Se il client decodifica la traccia scelta (es. AC-3 italiano in Edge), l'audio si copia: nessuna azione, prima di qualunque gradino della scala. La copia in fMP4 verso Edge di una traccia E-AC-3/AC-3 della sorgente è dedotta da S2, non misurata, in particolare l'E-AC-3 7.1 con substream dipendente: se fallisce, interviene la ripianificazione del §8.
- Il server non copia verso il browser una traccia AAC della sorgente con channelConfiguration 0 (PCE).
- Una **traccia compatibile già presente** nella stessa lingua (es. core AC3 separato dal remux) è un'alternativa a costo zero. Viene preferita **solo** se la politica P1 lo consente.
- Il **passthrough** è una capability distinta dalla **decodifica** (Interfacce §4.1). La TV la dichiara in base a cosa accetta l'AVR sull'HDMI.
- **Nel browser ogni stream porta una sola traccia audio, con un codec dichiarato dal client.** Con audio e video negli stessi segmenti (un solo SourceBuffer, come nello spike) un codec audio non supportato fa cadere anche il video. Con tracce separate l'esito dipende dal player (hls.js rende fatale l'errore quando non ha alternative) e non è misurato. Il packaging si decide nell'ADR 0003 ([S2](../spikes/S2-browser-playback.md), scoperta 1).

### 4.4 Sottotitoli

| Tipo | Client che li rende | Client che non li rende |
|---|---|---|
| Testo (SRT) | in-stream o sidecar | convertiti in formato testo supportato (es. WebVTT) |
| Testo stilizzato (ASS) | render nativo/libreria | conversione in testo semplice (stile perso) **o** burn-in (scelta del profilo; default: testo semplice) |
| **Immagine (PGS/VobSub)** | pass-through (Media3 supporta PGS) | **render lato client** con libreria dedicata. Nel browser il server serve il `.sup` a parte (delivery `client_render`, Interfacce §4.3) e il render è pilotato frame per frame ([H7 ✅](../spikes/S2-browser-playback.md), P3; VobSub non misurato). Ultima risorsa: **burn-in → Transcode**, che per il 4K nell'MVP non c'è (P2) |

- **Timeline dei cue.** I cue dei sottotitoli (`.sup` e WebVTT) sono nella timeline originale. In HLS fMP4 la timeline del player non coincide da sola con quella originale: i segmenti portano un offset costante dichiarato (`stream.mediaTimestampOffsetMs`), e hls.js aggiunge uno scarto che dipende dal primo frammento caricato (37–203 ms misurati, ADR 0003). Il client ricava `timelineOffsetMs` a ogni `INIT_PTS_FOUND` e applica ai sottotitoli lo stesso offset che usa per `ReportProgress`: per i PGS `renderAtTimestamp(mediaTime + timelineOffset)`; per il WebVTT con `<track>` i cue vanno spostati (ADR 0005). In Direct Play l'offset è 0. In S2 le due timeline coincidevano: il caso con offset è da verificare in F1c.
- **Estrazione dei sottotitoli embedded: decisa nell'ADR 0003.** Servire a parte una traccia embedded (immagine o testo) vuol dire estrarla, e l'estrazione legge tutto il file: per 50–80 GB dal bind mount sono minuti (circa 13–21, stima da S3). In S2 i `.sup` erano estratti in anticipo.
  - Il risultato va nel volume di **cache persistente**, non nello scratch, perché il media è montato in sola lettura (§7).
  - **Scelta (ADR 0003):** estrazione di tutte le tracce del file nella cache, al primo playback, in due passaggi. Il primo parte 60 s prima della posizione della sessione e va alla fine; il secondo copre l'inizio; poi si fondono. Il file si serve mentre cresce, come una sola risposta in streaming. La lettura è limitata in byte, per lasciare I/O al playback.
  - Finché l'estrazione è in corso, la traccia lo dichiara nella sessione con `availability: growing`; a fine estrazione l'evento `playback.subtitle_ready` dice al client di rileggere l'URL. `switchWithoutRestart` riguarda solo lo stream (§6.3).

### 4.5 Bitrate e rete

- I remux UHD hanno picchi oltre **100 Mbps**. Una LAN cablata gigabit li regge; il **Wi-Fi verso un device TV spesso no** → rischio concreto per il Direct Play (§7).
- Il client può dichiarare un **bitrate max** (misurato o impostato dall'utente). Se il file lo supera, l'alternativa è un altro file dell'item o il Transcode. **Mai in silenzio**: il motivo viene mostrato.
- **Buffer del browser.** Chromium tiene al massimo 150 MiB di video e 12 MiB di audio per stream MSE. Con i default di hls.js (30 s di buffer in avanti) un remux UHD a circa 100 Mbps ne chiede circa 352 MiB: compare `bufferFullError`, hls.js riduce il buffer e riscarica il frammento ([S2](../spikes/S2-browser-playback.md)). A 100 Mbps 150 MiB valgono circa 12 s.
  - La causa è il buffer in avanti, non la durata dei segmenti: segmenti più corti non cambiano i byte nel buffer.
  - Raccomandazione per l'ADR 0005: dimensionare `maxBufferLength`, `maxMaxBufferLength` e `maxBufferSize` di hls.js dal bitrate dello stream, perché il buffer in avanti resti sotto i 150 MiB con margine.
  - Il limite audio (12 MiB) non è stato esercitato: la FLAC di prova pesava circa 0,2 Mbps. Una FLAC 5.1/7.1 reale a 4–6 Mbps lo riempie in circa 20 s, quindi il `bufferFullError` è atteso anche sul 1080p. Da misurare con una traccia multicanale reale su un film intero.

---

## 5. Rilevamento delle capability per piattaforma

| Piattaforma | Come |
|---|---|
| **Web** | API del browser ([S2](../spikes/S2-browser-playback.md)), secondo la decisione I6 (Interfacce §9):<br>- `MediaSource.isTypeSupported` su un **elenco fisso di stringhe di codec** (es. `hvc1.2.4.L153.B0`, `hvc1.2.4.H153.B0`, `hvc1.2.4.L183.B0`, `flac`, `mp4a.40.2`, `ec-3`). Il risultato si dichiara nei campi esistenti (`video[].codec`, `profiles`, `audio[].codec`) con un vocabolario fisso. Sono affidabili, salvo l'AAC multicanale: `mp4a.40.2` non distingue l'AAC con PCE, che Chromium rifiuta; il server non lo produce e non lo copia (§4.3). Il successo di `addSourceBuffer` non è affidabile;<br>- **prima di avviare il player**, `isTypeSupported` sulla stringa esatta di `stream.mimeType` della sessione: se è false, `reportPlaybackFailure` con la dimensione sospetta (§8);<br>- `mediaCapabilities.decodingInfo` con i parametri HDR (funzione di trasferimento, gamut). Dice se il browser decodifica, non come presenta: Firefox risponde sì anche a HDR10+ e ad AV1 HDR10;<br>- `matchMedia('(dynamic-range: high)')` all'avvio della sessione per il display (`displayHdr`);<br>- browser, versione e sistema nel modello del dispositivo (`device.model`): servono agli override (I2);<br>- `audio[].maxChannels` indica cosa decodifica il browser (es. 8 per FLAC), non i canali dell'uscita: il downmix lo fa il browser (§4.3, punto 3). `AudioContext.destination.maxChannelCount` serve solo alla diagnostica;<br>- `mkv` in `containers` se `canPlayType('video/x-matroska')` non è vuoto: la risposta vale per il container. `canPlayType` per MKV non è stato provato con i codec audio delle sorgenti, quindi non si usa per decidere il Direct Play: i codec si giudicano da `audio[]` e `video[]` (§4.1);<br>- `audioTracks` non è disponibile senza flag, quindi `audioTrackSelection` = no.<br>Il browser **non fa passthrough audio**: il massimo è la decodifica. Sub: ciò che rende il player che scegliamo (PGS con il renderer lato client, P3) |
| **Android TV / mobile** | Elenco dei codec del device (profili/livelli), capacità HDR del display, **capability audio dell'HDMI (EDID dell'AVR)** esposte dal player: codifiche in passthrough e canali |
| **Override lato server** (I2) | Tabella per modello di device/versione app: corregge dichiarazioni errate note. Alimentata anche dai fallimenti reali (§8) |

Le capability si rilevano **a ogni avvio** del client: l'AVR può essere acceso, spento o cambiato.

---

## 6. Sessioni, seek e cambio tracce

### 6.1 Timeline

- **Invariante:** posizione, resume, progress e capitoli sono sempre espressi nella **timeline del media originale**, mai in quella dello stream.
- La timeline originale è **PTS − `start_time`** del file, cioè quello che un browser riporta in Direct Play (ADR 0003). Indice dei keyframe, segmenti e sottotitoli estratti usano questo dominio.
- Uno stream elaborato che parte da 01:47:23 deve riportare le posizioni come 01:47:23+, non come 00:00+. Questo garantisce un resume coerente fra modalità e fra client diversi.

### 6.2 Seek

| Modalità | Seek |
|---|---|
| Direct Play | Gestito dal client con richieste a intervalli sul file originale |
| Direct Stream / Transcode | Gestito dal protocollo di streaming (HLS fMP4, playlist VOD dell'intero film, ADR 0003). Se il segmento richiesto non è ancora disponibile, lo Stream Delivery **riavvia la pipeline** dal keyframe indicizzato che precede il segmento e scarta quel GOP, così il riavvio è invisibile anche con GOP aperti. Latenza: H8 ✅ (S3), più il GOP di pre-roll |

### 6.3 Cambio traccia in corsa

- Audio/sub disponibili nello stream corrente (es. sub testuali sidecar, PGS resi dal client da un `.sup` già estratto) → cambio **lato client, senza riavvio**. Il flag "cambio senza riavvio" è già nella PlaybackSession e riguarda solo lo stream: vale per ogni traccia servita a parte con un URL. Lo stato dell'estrazione sta nella disponibilità della traccia (`growing` o `complete`, §4.4).
- Altrimenti → nuova decisione e riavvio della pipeline dalla posizione corrente. Se la nuova traccia impone il burn-in, la UI lo segnala.

---

## 7. Concorrenza e risorse

- **Costi per modalità:** Direct Play ≈ banda + I/O disco; Direct Stream ≈ + CPU bassa; Transcode ≈ CPU/GPU alta (4K HEVC software: probabilmente oltre 1 sessione real-time su CPU desktop, da misurare **[H9]**).
- **Controllo di ammissione a due livelli:**
  - limite di **sessioni** (MVP 1, target 3, §8);
  - limite separato di **Transcode simultanei** (P4). Superato il limite, una nuova sessione che richiede Transcode fallisce con motivo chiaro; Direct Play e Direct Stream restano possibili.
- **Scratch:** i segmenti temporanei vivono in un volume effimero con **quota**. Vengono cancellati alla chiusura della sessione e all'avvio del servizio (sessioni orfane).
- **Cache:** i sottotitoli embedded estratti (`.sup`, WebVTT) vanno nel volume di cache, che persiste fra le sessioni, perché il media è in sola lettura e l'estrazione legge tutto il file. Quando estrarli lo decide l'ADR 0003 (§4.4). Nella stessa cache, sotto `delivery/`, sta l'indice dei keyframe di ogni file.
- **Rete:** per la TV principale si raccomanda una **connessione cablata**. È un requisito di installazione, non software, ma va scritto nella documentazione utente.

---

## 8. Fallback a runtime

```text
il client riceve il plan → prova a riprodurre
    └─ errore del decoder/player nonostante la capability dichiarata
         → il client lo segnala (sessione, errore, dimensione sospetta)
         → il server ripianifica partendo dalla dimensione sospetta, con la modifica minima
         → registra il caso (device, formato) per la tabella di override
```

**Ripianificazione per dimensione sospetta** (trasformazione minima, §1 e P1). Il formato fallito resta escluso per tutta la sessione.

| Dimensione sospetta | Cosa fa il server |
|---|---|
| **Audio** | Scende di un gradino nella scala del §4.3. Da Direct Play passa a Direct Stream con l'audio convertito; da Direct Stream resta in Direct Stream, con un altro formato audio (es. da E-AC-3 a FLAC) |
| **Sottotitoli** | Passa al trattamento successivo del §4.4 per quella traccia. Se non c'è (es. burn-in su 4K, P2), la riproduzione prosegue **senza quella traccia**, e la sessione riporta il motivo |
| **Video, container o sconosciuta** | Modalità più pesante: Direct Play → Direct Stream → Transcode |

Se il gradino richiesto per audio, video o container non esiste (Transcode 4K, P2), la sessione fallisce con `NO_COMPATIBLE_PLAN` e un motivo chiaro.

Un fallimento in Direct Play non deve lasciare l'utente davanti a uno schermo nero: la ripianificazione è **automatica**. Il motivo resta consultabile nella diagnostica.

**Fallimenti lato server** (ADR 0003). Quando fallisce lo Stream Delivery (ffmpeg esce con errore, un riavvio non torna sul keyframe atteso), il server tiene il **proprio registro** del fallimento: uscita del processo, classificazione dello stderr, posizione. Il data plane risponde `500` `STREAM_FAILED` dopo un solo tentativo automatico del server; da lì l'errore è terminale per lo stream: ogni richiesta del data plane di quella sessione risponde subito `500`, senza nuovi tentativi e senza consumare il limite dei tentativi automatici, e si recupera solo con `ReportPlaybackFailure`. Il web client, che con hls.js non legge il corpo, chiama da solo `ReportPlaybackFailure` con dimensione `unknown`. Il server sceglie la dimensione sospetta e la modifica minima dal proprio registro, non da quella indicata dal client. Un fallimento di formato scoperto dal server (es. channelConfiguration 0 dopo l'encoder AAC) ripianifica allo stesso modo, con il motivo nei `reasons`.

**Limite dei tentativi automatici:** al più **3 tentativi automatici per ogni `StartPlayback`**, contando insieme ripianificazioni e riavvii della sessione. Esauriti i tentativi, il client smette di riprovare da solo e offre all'utente un nuovo tentativo manuale, con il motivo dell'ultimo fallimento (ADR 0005).

**Nel browser** contano come fallimenti di playback:
- gli errori fatali del player MSE: un codec rifiutato da `addSourceBuffer`, un append fallito. Il client ferma il player, senza lasciargli ritentare lo stesso stream, e chiede la ripianificazione indicando la dimensione sospetta ([S2](../spikes/S2-browser-playback.md), scoperta 4);
- una stringa di `stream.mimeType` che `isTypeSupported` rifiuta prima dell'avvio (§5, I6);
- **l'audio che sparisce senza errore** nel Direct Play (MKV o MP4 progressivo). Se dopo qualche secondo di riproduzione `webkitAudioDecodedByteCount` resta a 0 (Chromium) o `mozHasAudio` è false (Firefox), il client segnala la dimensione audio. Le due proprietà non sono standard: se mancano, il client non segnala. In MSE Chromium dà già un errore fatale. L'AAC con PCE in Firefox non si vede da questi segnali (S2, c5): lo previene solo il controllo del server dopo l'encoder (§4.3).

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
| H1 | I browser non riproducono MKV in modo affidabile | ✅ **Confermata** da [S2](../spikes/S2-browser-playback.md):<br>- Chrome, Edge e Firefox aprono l'MKV ma **scartano in silenzio** TrueHD e DTS: video senza audio, nessun errore;<br>- Edge suona la prima traccia AC-3/E-AC-3 che trova, senza guardare la lingua; nei casi provati la traccia di default era quella non decodificabile;<br>- `audioTracks` è dietro flag e MSE non accetta MKV.<br>→ Nel browser si usa il Direct Stream (fMP4), salvo gli MKV con una sola traccia audio decodificata dal browser (§4.1) |
| H2 | Chrome/Edge su Windows decodificano HEVC Main10 (anche HDR10) in hardware; Firefox no | ✅/❌ [S2](../spikes/S2-browser-playback.md):<br>- ✅ Chrome (`D3D11VideoDecoder`) ed Edge (`VDAVideoDecoder`, Media Foundation) decodificano in hardware HEVC Main10 HDR10 4K a ~100 Mbps e 60 fps: circa 60 fps, 0–3 frame persi per finestra da 3 s in HLS/fMP4;<br>- ❌ "Firefox no" è smentito: Firefox 159 riproduce gli stessi file, solo con decodifica hardware.<br>- Edge e Firefox richiedono l'estensione HEVC di Windows.<br>- Misurato su un solo PC (RTX 3060 Ti) |
| H3 | Il remux con video copiato preserva i metadata HDR10 (e DV) | ✅ **Confermata** in MKV da [S1](../spikes/S1-media-probe.md) (DV P8.1/P5, HDR10) e in fMP4/HLS da [S2](../spikes/S2-browser-playback.md): BT.2020/PQ arrivano al decoder. Il box DV si scrive solo con `-strict unofficial` (`dvh1.08.09`).<br>- **Nessun browser riproduce DV**: `dvh1` è rifiutato ovunque.<br>- DV P8.1 va servito come `hvc1`, cioè come HDR10 del base layer, e così va ovunque. Gli RPU DV restano nel bitstream (1797 access unit su 1797).<br>- DV P5 nel browser richiede un Transcode.<br>- Metadata statici: nel DV P8.1 restano nei SEI (137/144, 30 ciascuno come nella sorgente) ed Edge li legge. Nessun box `mdcv`/`clli`, perché gli MKV di prova non li hanno nel container; il sample HDR10 non ne ha |
| H4 | La conversione DV P7→P8.1 in streaming è fattibile con i tool disponibili | futuro (fase TV) |
| H5 | Il device Android TV scelto fa passthrough TrueHD/DTS-HD verso l'AVR, o almeno li decodifica in PCM | fase client TV |
| H6 | Il browser riproduce FLAC multicanale nel container di streaming scelto | ✅ **Confermata** da [S2](../spikes/S2-browser-playback.md): FLAC 5.1 in fMP4, sia HLS sia progressivo, va in Chrome, Edge e Firefox con 6 canali nell'ordine corretto.<br>- In MSE vanno ovunque FLAC, Opus 5.1, AAC 2.0 e AAC 5.1 con channelConfiguration 6.<br>- AC-3/E-AC-3 vanno solo in Edge.<br>- AAC 5.1 con PCE fallisce; TrueHD e DTS non vanno in nessun browser.<br>- Il PCE nasce dal layout 5.1(side), che i decoder di ffmpeg danno per i codec dei Blu-ray. Con `aformat=channel_layouts=5.1` (o `-ac 6`) l'AAC esce con channelConfiguration 6, a mix invariato.<br>- 6.1 e 7.1 non provati: FLAC a 8 canali solo via API.<br>- Una corsa di sviluppo di Edge, la prima a freddo, ha dato L/R/C ruotati: 1 caso su 10 esecuzioni di c1, causa non isolata.<br>- L'ascolto su un impianto 5.1 non è ancora fatto (proprietario): serve anche a ripetere quel caso |
| H7 | Esiste un renderer PGS lato browser affidabile (sync, prestazioni in 4K) | ✅ **Confermata** da [S2](../spikes/S2-browser-playback.md) con libpgs 0.9.0 (Worker + OffscreenCanvas), su video 1080p e 4K HEVC HDR10: 5/5 cue in tutte le 24 esecuzioni, 0–2 frame persi per finestra da 10,6 s (un caso 16, su 4K in Chrome).<br>- ✅ Sync 4–42 ms se il render è pilotato da `requestVideoFrameCallback`.<br>- ⚠️ Sync 21–283 ms con il `timeupdate` predefinito.<br>- PGS a composizione 4K non misurati: secondo fonti di forum quelli degli UHD Blu-ray sono 1080p |
| H8 | Il riavvio della pipeline al seek in Direct Stream ha una latenza accettabile (obiettivo: < 2–3 s) | ✅ **Confermata** da [S3](../spikes/S3-stream-latency.md): 1° segmento 0,16–0,25 s, indipendente dall'offset. Seek granulare al GOP |
| H9 | Costo del Transcode 4K software su questo PC | ❌ [S3](../spikes/S3-stream-latency.md): 4K HDR → 1080p SDR software a 14 fps (0,6× per film 24p), **non in tempo reale**. GPU (NVENC + libplacebo) 67–84 fps. Burn-in PGS 4K ≈0,9×. → **P2 rivista** (§11) |
| H10 | NVENC/CUDA e Vulkan (libplacebo) funzionano dentro un container Docker Desktop su WSL2 | ✅/❌ [S3](../spikes/S3-stream-latency.md), rimisurata il 2026-11-04 con WSL 3.0.3 / Docker Desktop 4.98:<br>- ✅ CUDA decode, NVENC (ffmpeg 8.x; ffmpeg 9.0 richiede un driver ≥ 610) e `tonemap_cuda` (jellyfin-ffmpeg) funzionano. 4K HDR → 1080p SDR su GPU a 106 fps, circa 4,4× il tempo reale per un film 24p;<br>- ❌ Vulkan/libplacebo e OpenCL non sono esposti.<br>- Overhead del container circa 2× rispetto all'host.<br>- Bind mount NTFS circa 500 Mbps |
| H11 | Nel browser un DV profilo 7 (UHD Blu-ray) si riproduce come HDR10 con `hvc1`, togliendo RPU ed EL con un filtro di bitstream senza ricodificare il video (`hevc_metadata=remove_dovi=1` di jellyfin-ffmpeg) | ⚠️ **Aperta**, nata da [S2](../spikes/S2-browser-playback.md): nessun sample P7 (S1, azione del proprietario).<br>- Va misurata sia la copia così com'è (NAL EL presenti) sia la rimozione dei layer DV.<br>- `dovi_rpu=strip=1` di FFmpeg toglie solo l'ultima unità NAL e lascia l'EL.<br>- Finché non è misurata vale la regola provvisoria del §4.2.<br>- **Evidenza parziale (ADR 0003, E6):** su un P8.1 il filtro toglie tutte le RPU (62 → 0) e lascia i SEI HDR10; anche VPS/SPS/PPS passano da 4 a 2. Sull'EL di un P7 non si può dire nulla |

---

## 11. Decisioni prese in revisione

| ID | Domanda | Decisione |
|---|---|---|
| P1 | Selezione automatica dell'audio: prima la qualità o prima la compatibilità? | **Prima la qualità**: la traccia migliore nella lingua preferita, con la trasformazione minima. Una traccia compatibile di qualità inferiore si usa solo se la migliore richiederebbe un Transcode video (non succede mai per il solo audio) |
| P2 | Transcode nell'MVP? | **Rivista il 2026-11-04 dopo S3 (H9 ❌), opzione (b), approvata dal proprietario.** Direct Play + Direct Stream completi per tutte le sorgenti. Transcode **software solo per sorgenti fino a 1080p** (1 alla volta, per burn-in e codec non supportati). Le sorgenti **4K si servono solo in Direct Play o Direct Stream**: se servirebbe un Transcode, la sessione fallisce con motivo chiaro. Il transcode con accelerazione hardware (backend da decidere con ADR) si rivaluta dopo H10.<br>**Deviazione temporanea dai requisiti §5.2**, che chiedono il transcode anche quando il client non supporta il codec o la risoluzione originale: per il 4K nell'MVP non c'è.<br>**Dipendenze:** il 4K nel web client (unico client MVP) richiede **H2** (HEVC Main10 decodificato dal browser) e, per i PGS, **H7** (render lato client, P3); il burn-in su 4K non è disponibile. Per il DV profilo 7 richiede anche **H11** (§4.2), aperta.<br>**Se S2 smentisce H2 o H7:** si porta nell'MVP il transcode con accelerazione hardware (se H10 lo consente), oppure il downscale a 1080p prima del burn-in/transcode software. Decisione del proprietario dopo S2.<br>**Esito di S2 (2026-11-05): la condizione non scatta** ([S2](../spikes/S2-browser-playback.md)).<br>- La parte di H2 da cui dipende P2 è confermata: Chrome ed Edge decodificano HEVC Main10 4K in hardware.<br>- La parte smentita («Firefox no») è a favore, perché anche Firefox 159 lo decodifica in hardware.<br>- H7 è confermata (P3).<br>- Non serve quindi una decisione del proprietario.<br>Restano senza strada nel web client, come P2 già accetta, i casi 4K del §4.2: DV P5, browser senza decoder HEVC, HDR10 su display SDR se P5 viene ritirata per un browser. Da verificare: DV P7 (H11).<br>_Versione originale: Transcode minimo software per ogni sorgente._ |
| P3 | PGS nel web client | **Render lato client** se S2 conferma H7; altrimenti burn-in.<br>**Esito di S2 (2026-11-05): H7 confermata, quindi render lato client** ([S2](../spikes/S2-browser-playback.md)).<br>- Il render va pilotato da `requestVideoFrameCallback` → `renderAtTimestamp(t)`: con `timeupdate` il ritardo arriva a 283 ms. t sta sulla timeline originale: in Direct Play è `mediaTime`; in HLS fMP4 è `mediaTime` più `timelineOffsetMs`, che il client ricava a ogni `INIT_PTS_FOUND` da `initPTS` e da `stream.mediaTimestampOffsetMs` (§4.4, ADR 0003). Da verificare dopo un seek con riavvio della pipeline.<br>- Il `.sup` si serve con delivery `client_render`; estrazione e servizio mentre cresce sono decisi nell'ADR 0003 (§4.4).<br>- Il burn-in resta il fallback per i client senza renderer. Con P2 vale solo per sorgenti fino a 1080p |
| P4 | Transcode simultanei massimi | **1**, indipendente dal limite di sessioni; configurabile |
| P5 | HDR10 su un display SDR, quando il client sa convertire da sé (es. il browser): conversione del client o Transcode? | **Decisa il 2026-11-05 dopo S2 (Claude, su delega); rivista lo stesso giorno dopo la revisione di S2.** Nessuna trasformazione. Se il client dichiara di accettare HDR10 con un display SDR (`hdr` contiene HDR10, `displayHdr` = no), il server serve l'HDR10 e il client lo presenta da sé. La sessione riporta il motivo: "HDR10 su display SDR: conversione lasciata al browser" (per un client che non è un browser: "… lasciata al client"). Il Transcode con tone-mapping resta per i client che non sanno convertire; per il 4K nell'MVP non c'è (P2).<br>- `displayHdr` cambia solo il motivo, non il piano. Fra più versioni dello stesso item (Domain Model D2) si sceglie come per ogni client, quindi anche il 4K HDR10 su un display SDR. Se un override toglie HDR10 a un browser, la versione SDR, se esiste, vince da sé.<br>- Il web client mette browser, versione e sistema nel modello del dispositivo (`device.model`), così un override (I2) può colpire un browser.<br>**Perché:** con la regola precedente ogni film 4K HDR10 su un monitor SDR fallirebbe (P2). La premessa è più debole di quanto sembri: S2 ha misurato la riproduzione dell'HDR10 su display SDR, non la qualità della conversione ([S2](../spikes/S2-browser-playback.md), scoperta 5). In Firefox su Windows la resa BT.2020/PQ su SDR è un difetto aperto ([Bugzilla 1948087](https://bugzilla.mozilla.org/show_bug.cgi?id=1948087)), e `decodingInfo` risponde sì anche a HDR10+.<br>**Da riguardare** dopo la verifica visiva del proprietario, in Chrome, Edge e Firefox, anche su un remux UHD reale con metadata statici (il sample HDR10 di S2 non ne ha): se la conversione di un browser risulta inaccettabile, l'override per dispositivo (Interfacce I2) toglie HDR10 dalle sue capability.<br>**Se la verifica fallisce:** per il 4K la sessione fallisce con `NO_COMPATIBLE_PLAN` (P2), salvo una versione 1080p dell'item (D2); fino a 1080p si passa al Transcode con tone-mapping. Sul PC del proprietario (due monitor SDR) è tutta la libreria 4K HDR10 in quel browser. In quel caso si riapre P2 (tone-mapping su GPU, H10 ✅ per `tonemap_cuda`), con una decisione del proprietario.<br>_Versione originale (§4.2): Transcode con tone-mapping per ogni client o display SDR._ |
| P6 | Più versioni dello stesso item (D2): prima la modalità più leggera o prima la qualità? | **Prima la qualità** (decisa il 2026-11-05 dall'orchestratore, su delega, durante F1b). Fra i piani che non transcodificano il video (Direct Play e Direct Stream) vince la versione di qualità più alta: pixel serviti, HDR mantenuto, profondità di colore, audio lossless (solo se lossless anche la sorgente), canali e, a parità di tutto il resto, bitrate video più alto (un remux batte un encode della stessa risoluzione). La modalità più leggera decide solo a parità di qualità; una versione che richiede il transcode video perde sempre. Motivo: il Direct Stream copia il video e S3 ha misurato il remux come economico, quindi preferire un 1080p in Direct Play a un 4K in Direct Stream degraderebbe il media senza necessità (requisiti §18, CLAUDE.md). Se il client non regge il 4K, la versione 4K non è servibile e vince la 1080p |
