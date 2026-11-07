# 0008 — Client TV: app Android nativa in Kotlin con Compose for TV e Media3

- **Stato:** Accepted (2026-11-07)
- **Data:** 2026-11-07
- **Decisore:** Claude, su delega del proprietario, dopo il passaggio del `design-reviewer` (correzioni applicate lo stesso giorno). La decisione non aspetta S5: S5 fissa solo alcuni default (doc 05 §8.13).
- **Requisiti collegati:** §5 (Direct Play preferito, tre livelli di consegna), §6 (tracce audio e sottotitoli), §7 (client proprietari; la TV è il caso d'uso principale per la qualità), §8 (sessioni), §9 (LAN, nessuna ipotesi sulla subnet), §14–§16 (profili, progress, Home e ricerca), §18 (qualità, evolvibilità), §20 (tecnologia del client TV); doc 03 P1, P2, P8, P9, §4.1, §7, I2, I3, I5, I6; doc 04 §4–§8, H5, H11, P1, P5
- **Valutazione completa:** [05 — §8 Client TV](../architecture/05-technology-evaluation.md#8-client-tv)
- **Evidenze:**
  - [S5 — Client TV sulla TV del proprietario](../spikes/S5-tv-client.md), con gli artefatti in [`docs/spikes/S5-tv-client/`](../spikes/S5-tv-client/);
  - [K1 — Client Kotlin generato dal contratto](../spikes/K1-kotlin-codegen.md).

## Contesto

Dopo l'MVP web, il client TV deve dare la qualità piena sulla TV del soggiorno (§7). Il dispositivo è misurato in S5 (doc 05 §8.2):
- **Piattaforma:** Haier con Google TV (Android TV 11, API 30), SoC MediaTek MT5889 con userspace **a 32 bit**, 2,95 GB di RAM e heap per app di 192 MB (512 con `largeHeap`).
- **Video e display:**
  - decoder hardware HEVC Main10 4K, AV1, VP9 e AVC;
  - Dolby Vision P4, P5, P8, P9 e P10, ma **non P7**;
  - display HDR10, HDR10+, HLG e Dolby Vision, esposto all'app solo a 1080p, 60 e 50 Hz.
- **Audio:**
  - AC-3 ed E-AC-3 in hardware; AAC, FLAC, Opus e PCM in software;
  - **nessun decoder DTS né TrueHD visibile alle app.**

Tre fatti del proprietario (2026-11-07), riportati qui una volta sola:
1. **Niente AVR né soundbar:** suonano gli altoparlanti Harman Kardon del TV, sull'uscita Speaker. Quell'uscita accetta AC-3, E-AC-3 ed E-AC-3 JOC in bitstream, decodificati dal processore Dolby del TV, e PCM stereo. Il passthrough lossless non è in gioco.
2. **La libreria sarà fatta soprattutto di ricodifiche x265, non di remux.** Il sample tipico (S5):
   - 4K HEVC Main10 HDR10, 21,8 GB, 19,6 Mb/s medi;
   - audio AC-3 5.1 in italiano e AAC 5.1 in inglese;
   - sottotitoli PGS in italiano e SRT in inglese.

   TrueHD, DTS-HD e DV P7 diventano casi limite. I remux restano supportati.
3. **La TV resta sul Wi-Fi a 2,4 GHz** (link a 144 Mb/s) per ora: niente cavo né 5 GHz.

Vincoli già accettati:
- contratto OpenAPI 3.1.1 con codegen Kotlin; l'ADR 0004 (punto 7) rinvia qui la libreria HTTP e la verifica del generatore;
- Direct Stream in HLS fMP4 VOD (ADR 0003);
- token di sessione nel path dei locatori (doc 03 P9);
- ripianificazione automatica per dimensione sospetta, con le precisazioni di F2 (doc 04 §8);
- HTTP in chiaro in LAN finché non c'è TLS (ADR 0006).

## Opzioni considerate

### A. Kotlin, Jetpack Compose con Compose for TV, Media3
- **Pro:**
  - Media3 è il player di riferimento su Android, e nello stesso linguaggio dell'app legge le capability reali;
  - Compose for TV è la UI che Google raccomanda per la TV;
  - il codice del player si riusa in un'app mobile Android.
- **Contro:** lo scorrimento di Compose su un SoC a 32 bit non è misurato; le righe in stile Leanback si scrivono a mano.

### B. Kotlin, Leanback, Media3
- **Pro:** stesso player; righe e focus pronti e provati su dispositivi deboli.
- **Contro:** deprecata secondo la sua pagina di rilascio (anche se esce ancora qualche alpha); View e Fragment; UI non riusabile sul mobile.

### C. React Native for TV con react-native-video
- **Pro:** TypeScript; riuso anche su iOS.
- **Contro:**
  - capability e scelta dei renderer richiedono comunque moduli nativi in Kotlin: due linguaggi e un ponte;
  - il supporto TV è un fork della community;
  - un runtime JavaScript in più nello heap.

### D. Flutter
- **Contro:** nessun target TV ufficiale; il player va scritto in Kotlin dietro un platform channel.

### E. WebView o TWA del web client
- **Contro (vincolo rigido):** niente MKV né PGS nativi, nessun controllo dell'uscita audio. Tutto andrebbe in Direct Stream, il contrario del §5.1.

### Libreria HTTP del client generato
- **`jvm-retrofit2`** (Retrofit 3.0.0 su OkHttp 5.5.1): compila e supera i 7 controlli di K1 con tre mapping di tipo.
- **`jvm-ktor`** (Ktor 3.6.1): il codice generato non compila. `AdminApi` usa il predefinito `State.needs_review` non qualificato, e `CatalogApi` non risolve gli enum `Sort` e `Order` dei parametri di query (K1).
- **Fabrikt:** la riserva dell'ADR 0004.

Punteggi pesati nel doc 05 §8.5: A 4,41, B 3,92, C 3,00, D 2,92; E non passa il vincolo rigido.

## Evidenze

- **S5** (report e artefatti):
  - **il sample tipico va in Direct Play:** avvio in circa 1 s, seek a 2 ore in 0,8 s, 0 frame persi;
  - DV P5 e P8.1 vanno sui decoder Dolby Vision della TV, un HEVC livello 6.1 si riproduce anche se il decoder dichiara il 5.1, e il tunneling non dà guadagni misurabili;
  - i PGS incorporati appaiono con un ritardo mediano di 7 ms;
  - attraverso il server, il sample tipico va in Direct Play, e un TrueHD senza decoder sulla TV va in Direct Stream come FLAC 5.1 con il `.sup` a parte;
  - solo un remux sopra i 100 Mb/s va in rebuffer sul Wi-Fi a 2,4 GHz.
- **K1:** generazione e compilazione delle cinque varianti, con sette controlli su payload d'esempio scritti a mano. Il collegamento HTTP e la validità dei corpi rispetto allo schema non sono provati.
- **Codice di Media3** (ramo `release`, 2026-11-07): `MatroskaExtractor`, `MediaCodecUtil`, `AudioCapabilities`, `DefaultLoadControl` (doc 05 §8.16).
- **Versioni** lette il 2026-11-07 (doc 05 §8.6).

## Decisione

1. **Stack:** app Android nativa in **Kotlin 2.4.21**, UI in **Jetpack Compose 1.12.1** con **Compose for TV** (`tv-material` 1.1.0, lazy list di Compose foundation), player **Media3 1.11.1**.
   - **Ambito della UI:** scelta del profilo, Home composta dal server, navigazione del catalogo (film, documentari, serie → stagione → episodio, extra), ricerca, scheda dell'item, player.
   - Niente sezione di gestione: la coda "Da verificare" resta nel web client.
2. **Build:**
   - `clients/tv/`, progetto Gradle con **AGP 9.5.1** (Kotlin integrato) e **Gradle 9.8.2**; JDK 21, bytecode 17;
   - **compileSdk 37, targetSdk 36, minSdk 30.** Il compileSdk sale a 37 in F3a (2026-11-07) perché OkHttp 5.5.1 lo chiede per compilare; non cambia il comportamento a runtime. Il passaggio del targetSdk a 37 richiede di gestire il permesso di rete locale di Android 17 (`ACCESS_LOCAL_NETWORK`), senza il quale le connessioni in LAN vanno in timeout;
   - moduli `:app`, `:player` e `:api`; versioni fisse in `gradle/libs.versions.toml`.
3. **Librerie e test:**
   - Navigation3 1.2.1; Coil 3.6.3, con un tetto esplicito alla cache in memoria; `SharedPreferences`; DI a mano; librerie Jetpack di base (activity-compose, lifecycle) all'ultima stabile, fissata nello scaffold;
   - test con JUnit, Robolectric 4.17 (SDK dei test fissato a 30), test UI di Compose e MockWebServer di OkHttp 5.5.1.
4. **Client API:** OpenAPI Generator 7.27.0 genera in `build/` a ogni build, con il plugin Gradle della stessa versione oppure con l'immagine Docker dell'ADR 0004.
   - **Generazione:**
     - generatore `kotlin` con `jvm-retrofit2`, `serializationLibrary=kotlinx_serialization`, `enumUnknownDefaultCase=true`, `useCoroutines=true`, `dateLibrary=string`;
     - mapping **`AnyType=JsonElement`, `number=kotlin.Double`, `integer=kotlin.Long`**;
     - si usano solo i sorgenti generati, non il loro `build.gradle`.
   - **Retrofit e OkHttp:**
     - Retrofit 3.0.0 e kotlinx-serialization-json 1.12.0, con `Json` a `explicitNulls = false`, `encodeDefaults = false` e `ignoreUnknownKeys = true`;
     - l'istanza Retrofit la costruisce l'app sulle interfacce generate, non con l'`ApiClient` generato;
     - un `OkHttpClient` base, e client derivati con `newBuilder()`. Il Bearer va solo su quello delle API; immagini e Media3 usano i loro.
   - **`subtitleTrackId`:** "sottotitoli spenti" (`null`) si ottiene codificando il modello generato in un `JsonObject` e aggiungendo `"subtitleTrackId": null`. Un test con MockWebServer valida i corpi codificati contro lo schema del bundle.
   - **Contratto:** oggi non cambia. La prima slice TV aggiunge `format: int64` alle 10 proprietà in millisecondi e in byte (K1), un cambio additivo che serve anche alla riserva Fabrikt.
   - **Gate:** ogni modifica di `services/video/contract/dist/openapi.json` rigenera e compila il client Kotlin:
     - `gradlew :api:check`, quando `clients/tv` esiste;
     - prima di allora, `bash spikes/k1-kotlin-codegen/run.sh retrofit-long`.

     Il gate di milestone dell'ADR 0004 diventa "genera e compila".
5. **Player:**
   - **Superficie e sottotitoli:** `PlayerSurface` su `SurfaceView` (HDR, Dolby Vision). Sottotitoli con `SubtitleView` di media3-ui; i PGS e gli SRT incorporati li rende Media3.
   - **Buffer e tunneling:** `largeHeap` e un tetto in byte al buffer (valori nel doc 05 §8.10). Tunneling spento: S5 non ne misura vantaggi.
   - **Tracce non supportate:** si segnala un fallimento solo per una traccia scelta con `FORMAT_UNSUPPORTED_*`, o per una traccia Dolby Vision il cui profilo non è fra gli `hdr[]` dichiarati.
     - Con `FORMAT_EXCEEDS_CAPABILITIES` si riproduce e si guarda agli errori veri del decoder, perché i dispositivi sottodichiarano profili e livelli (S5: un HEVC livello 6.1 va su un decoder 5.1).
   - **Fallimenti e sessione:** stesso protocollo del doc 04 §8, comprese le precisazioni di F2:
     - dopo un `404`/`410` del data plane il client chiede il motivo, e riparte da solo solo per `expired`, `stopped`, `shutdown` o un motivo ignoto;
     - nessun nuovo tentativo su `503 MEDIA_UNAVAILABLE` con `sessionClosed`;
     - al massimo 3 tentativi automatici;
     - `StopPlayback` quando si esce dal player, quando si rinuncia e su `onStop` dell'Activity.
   - **Cambio della traccia audio:** il server marca ogni traccia audio `switchWithoutRestart: false`. Il client chiama `ChangeTracks`, e cambia in locale solo se il piano restituito ha la stessa modalità e lo stesso URL; altrimenti riparte sul nuovo stream dalla posizione corrente.
   - **Posizioni:**
     - in Direct Play sono quelle del file;
     - in HLS Media3 riporta il tempo della playlist, che parte da 0, e ignora `mediaTimestampOffsetMs`, che serve a hls.js. Il client riporta sempre posizioni sulla timeline originale (doc 05 §8.13, domanda 9).
6. **Capability:** solo quelle reali, lette dalla piattaforma a ogni avvio di sessione (regole nel doc 05 §8.9).
   - Video: decoder hardware, una voce per fascia di risoluzione.
   - `hdr`: l'intersezione fra il display e i profili dei decoder; mai un `DV` generico, che il motore farebbe valere anche per il P7.
   - Audio: `passthrough` per quello che `AudioCapabilities` accetta in bitstream; `decode` con i canali che i decoder gestiscono davvero.
   - `device.model` = `"<produttore> <modello>; Android <versione> (API <n>)"`, e la versione dell'app va in `device.app`.
7. **Audio sulla TV di oggi:**
   - **AC-3 ed E-AC-3, JOC compreso** (la traccia italiana tipica): Direct Play in bitstream al processore Dolby del TV.
   - **AAC 5.1** (la traccia inglese tipica), FLAC, PCM e Opus: Direct Play, decodificati sulla TV. Android porta il multicanale sui due canali degli altoparlanti.
   - **TrueHD e DTS-HD** (remux, casi limite): senza un decoder sulla TV, il motore scende al FLAC con i canali della sorgente, in Direct Stream, e la TV lo decodifica. Il lossless resta; si perdono gli oggetti Atmos, e i PGS passano dal `.sup` esterno.
   - **Un AAC con PCE** non si copia mai, per nessun client (`audio.ts`): per quei file c'è una conversione in più.
   - **Nessuna preferenza audio nascosta nel client.** Se l'ascolto del proprietario (AAC 5.1 decodificato sulla TV contro E-AC-3 5.1 convertito dal server) preferisce il Dolby, la scelta diventa una **politica del server**: un override per dispositivo (I2) o un campo additivo del contratto (P8), che il motore legge e riporta nei `reasons`.
   - L'estensione FFmpeg di Media3 (TrueHD e DTS in Direct Play) resta un'opzione futura, fuori da questa decisione.
8. **Rete:**
   - `base-config cleartextTrafficPermitted="true"`, perché un `domain-config` non accetta intervalli IP;
   - URL del server inserito a mano;
   - eventi in polling come nel web client (dettagli nel doc 05 §8.8);
   - `limits.maxBitrate` non dichiarato.
9. **Distribuzione:** sideload via ADB di un APK di release firmato con una chiave tenuta fuori dal repo. Un solo APK con `armeabi-v7a` e `arm64-v8a`; `LEANBACK_LAUNCHER` con banner.

## Conseguenze

### Più facile
- **Il caso comune va tutto in Direct Play**, senza lavoro del server: HEVC HDR10 con AC-3 o AAC, e PGS o SRT incorporati.
- **DV P5 e P8 in Direct Play** con i decoder Dolby Vision. Il P5, che nel browser dà `NO_COMPATIBLE_PLAN`, sulla TV si riproduce.
- **Server e contratto invariati:** il client dichiara solo capability reali, e il motore le usa come per il web.
- **Un solo linguaggio** nell'app; `:player` e `:api` si riusano sul mobile.

### Più difficile
- **Un secondo ecosistema** (Gradle e Android) accanto a npm, con un gate in più sui cambi del contratto.
- **UI e player scritti una seconda volta:** si condividono contratto, vocabolario delle capability e protocollo di ripianificazione.

### Rischi
- **Remux sopra i 100 Mb/s:** sul Wi-Fi a 2,4 GHz vanno in rebuffer (S5). Sono un caso limite; il rimedio sarebbe fisico.
- **Memoria:** il buffer predefinito di Media3 non sta in 192 MB, quindi servono `largeHeap` e il tetto in byte; il low memory killer resta da osservare.
- **Compose sul MT5889 a 32 bit:** da misurare nella prima slice.
- **24p:** il display espone all'app solo 60 e 50 Hz, quindi l'app non può chiedere i 24 Hz. Resta la verifica a occhio del proprietario.
- **Supporto 3.1 «beta» del generatore:** coperto dal gate sui cambi del contratto.

### Default che fissa S5
Il resto delle verifiche è nel doc 05 §8.13. Qui contano tre domande:
- **1.** Il sample tipico in Direct Play: già ✅ in S5; conferma il tunneling spento.
- **2.** AC-3 ed E-AC-3 arrivano davvero al processore Dolby?
- **4.** L'ascolto dell'AAC 5.1 decodificato contro l'E-AC-3 5.1: decide se serve la politica Dolby del server (punto 7).

### Decisioni dopo S5 (2026-11-07)
S5 ha trovato due ripieghi che sulla TV non funzionano così come sono, e tre obblighi per il client:
- **FLAC del Direct Stream:** il server passa da blocchi da 4608 a **1152 campioni** (`FLAC_FRAME_SAMPLES`, ADR 0003). Con 4608 campioni i frame di audio reale superano i 32 KB del buffer d'ingresso di `c2.android.flac.decoder` e la riproduzione si ferma; con 1152 campioni 5.1 e 7.1 vanno, misurati sulla TV in MKV e in MP4 frammentato. È l'opzione misurata e vale per ogni client nativo. Il cambio si verifica con i test end-to-end dei browser. Fino ad allora un remux con TrueHD o DTS-HD in Direct Stream può fermarsi su questa TV.
- **PGS in Direct Stream:** Media3 1.11 non legge il `.sup` esterno (zero cue). Il client avrà un piccolo parser che divide il `.sup` in display set con i loro tempi e li passa al `PgsParser` di Media3: solo client, nella seconda slice TV. Fino ad allora i PGS dei film in Direct Stream (remux con TrueHD/DTS-HD) non si vedono sulla TV; i PGS incorporati in Direct Play vanno.
- **Tracce del piano:** il client le impone a Media3 con `TrackSelectionOverride`, anche in Direct Play. Senza, Media3 sceglie da sé: nel 2001 ha suonato l'AC-3 italiano mentre il piano diceva AAC inglese.
- **Buffer:** `largeHeap` e tetto di **100 MiB** (il doc 05 §8.10 parte da lì). Il 2001 regge da 30,3 Mb/s sostenuti in su, contro i 65–72 misurati.
- **Schermo acceso** durante la riproduzione (`keepScreenOn`): la TV è andata in standby da sola una volta. **POST senza corpo** del client generato verificate: una POST vuota di `HttpURLConnection` riceve `415`.

### Da rivedere
- **L'ascolto preferisce il Dolby:** politica del server (punto 7), con un override I2 o un campo additivo, e un test del motore.
- **Arriva un impianto audio esterno** (eARC): `AudioCapabilities` vede TrueHD e DTS-HD e l'app li dichiara in `passthrough` (H5). Da verificare che Media3 su API 30 legga le codifiche dell'uscita HDMI.
- **DV P7 (H11):** in Direct Play la traccia DV ha un profilo non dichiarato, quindi il client la segnala (punto 5). La ripianificazione passa al Direct Stream, che con `keep_rpu` è etichettato `hvc1` senza box DV, e Media3 lo legge come HEVC. Costa un tentativo automatico; da misurare con un sample.
- **targetSdk 37:** solo con `ACCESS_LOCAL_NETWORK` dichiarato e chiesto, e con il rifiuto gestito; per la scoperta mDNS c'è il picker di `NsdManager`.
- **Estensione FFmpeg:** se si vogliono TrueHD e DTS in Direct Play.
- **Compose troppo lento:** baseline profile e immagini più piccole, poi Leanback per le sole schermate di navigazione.
- **Accesso remoto e TLS:** il chiaro si spegne e la CA privata entra con `trust-anchors`.
- **Box esterno** (per esempio per il DV P7 con FEL): strada futura facoltativa, senza un acquisto consigliato.
- **Generatore:** se fallisce su un costrutto o regredisce, Fabrikt (ADR 0004).

### Dipendenze
- **ADR 0004:**
  - opzioni del generatore Kotlin allargate (`jvm-retrofit2`, mapping di tipo);
  - il gate di milestone diventa "genera e compila", più il gate sui cambi del contratto (punto 4);
  - la frase sui tipi «`Int?` corretti» non vale per gli istanti in millisecondi (K1).
- **Contratto:** `format: int64` sulle 10 proprietà, nella prima slice TV (additivo).
- **Decision Engine:** nessuna modifica richiesta ora. Gli override I2 usano il `device.model` del punto 6.
- **ADR 0003:** il Direct Stream HLS fMP4, FLAC 7.1 compreso, e i sottotitoli esterni devono funzionare in Media3 (doc 05 §8.13, domande 9 e 10).
- **Doc 04:** §4.3 (passthrough verso il processore del TV, AAC con PCE), §5 (capability audio su Android) e §7 (rete) allineati a questa ADR. H5 resta da rileggere con S5: sulla TV di oggi TrueHD e DTS non passano né si decodificano, e vanno in FLAC.
- **CLAUDE.md:** la descrizione del soggiorno (AVR, passthrough lossless) va allineata; la allinea l'orchestratore.
