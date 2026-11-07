# K1 — Client Kotlin generato dal contratto

- **Stato:** Completato (2026-11-07)
- **Domanda:** OpenAPI Generator 7.27.0 produce dal bundle del contratto un client Kotlin che compila e decodifica i payload del contratto? Con quale libreria HTTP, `jvm-retrofit2` o `jvm-ktor`?
- **Alimenta:** ADR 0004 punto 7 (verifica del generatore Kotlin, rinviata all'ADR del client TV); [ADR 0008](../adr/0008-client-tv-kotlin-compose-media3.md) (client API della TV); doc 05 §8.7.
- **Codice:** `spikes/k1-kotlin-codegen/` (`run.sh`, `harness/`, `probe/`, `int64.py`), throwaway. Output in `out/` (gitignored).

## Setup

- **Host:** portatile, Docker Engine 28.1.1.
- **Generatore:** immagine `openapitools/openapi-generator-cli:v7.27.0`, generatore `kotlin`.
  - Opzioni comuni: `serializationLibrary=kotlinx_serialization`, `enumUnknownDefaultCase=true`, `useCoroutines=true`, `dateLibrary=string`, `packageName=dev.pezzotflix.api`.
  - Input: il bundle versionato `services/video/contract/dist/openapi.json`, così com'è. La variante `int64` usa una copia a cui `int64.py` aggiunge `format: int64` agli interi il cui nome finisce in `At`, `Ts`, `Since` o `Bytes`, più `at`.
- **Compilazione:** immagine `gradle:9.8.2-jdk21`, Kotlin 2.4.21 sulla JVM (plugin `jvm` e `serialization`).
  - Retrofit 3.0.0, `converter-kotlinx-serialization` 3.0.0, OkHttp 5.5.1, kotlinx-serialization-json 1.12.0, kotlinx-coroutines 1.11.0; per Ktor 3.6.1 con `content-negotiation` e `serialization-kotlinx-json`.
  - Il `build.gradle` generato non si usa: si compilano solo i sorgenti generati più la sonda.
- **Sonda** (`probe/common/Probe.kt`): sette controlli su **payload d'esempio scritti a mano** nel formato del contratto. Non sono risposte registrate dal server. Ogni controllo gira con due configurazioni di `Json`: quella del codice generato (`encodeDefaults = true`, `isLenient`, `ignoreUnknownKeys`) e una con `explicitNulls = false` ed `encodeDefaults = false`.

| # | Controllo | Cosa mette alla prova |
|---|---|---|
| 1 | Decodifica di una `PlaybackSession` con `expiresAt` = 1794067200000 e un campo sconosciuto | istanti in millisecondi, campi in più |
| 2 | Decodifica di una sessione con `mode` = `warp_play` e `protocol` = `dash-cmaf` | enum aperti |
| 3 | Decodifica di un `EventPage` con `at` = 1794067200000 | istanti in millisecondi |
| 4 | Decodifica di un `EventPage` con `at` piccolo e `payload` libero | `payload` come oggetto libero |
| 5 | Decodifica di un `ItemPage` con `nextCursor: null` | campi nulli |
| 6 | Decodifica di un `MediaFileEntry` con `sizeBytes` = 64000000000 e `missingSince` in millisecondi | dimensioni in byte |
| 7 | Codifica di una `StartPlaybackRequest` con le capability della TV | corpo di una richiesta |

- **Varianti:**

| Variante | Libreria | Mapping di tipo |
|---|---|---|
| `retrofit-raw` | `jvm-retrofit2` | nessuno |
| `ktor-mapped` | `jvm-ktor` | `AnyType=JsonElement`, `number=kotlin.Double` |
| `retrofit-mapped` | `jvm-retrofit2` | `AnyType=JsonElement`, `number=kotlin.Double` |
| `retrofit-int64` | `jvm-retrofit2` | come sopra, sul bundle con `format: int64` |
| `retrofit-long` | `jvm-retrofit2` | come sopra, più `integer=kotlin.Long`, sul bundle invariato |

`JsonElement` è importato da kotlinx.serialization (`--import-mappings=JsonElement=kotlinx.serialization.json.JsonElement`). Con il nome completo dentro `--type-mappings` il generatore produce un tipo storpiato (`KotlinxserializationjsonJsonElement`).

- **Ricostruzione:** `bash spikes/k1-kotlin-codegen/run.sh` per tutte le varianti, `bash spikes/k1-kotlin-codegen/run.sh retrofit-long` per la sola variante scelta. Circa 2 minuti per variante, più il primo download delle dipendenze.

## Risultati

La generazione riesce per tutte e cinque le varianti, con l'avviso "3.1 beta" del generatore.

| Variante | Compilazione | Controlli superati (per ciascuna configurazione di `Json`) |
|---|---|---|
| `retrofit-raw` | ❌ errore interno del plugin kotlinx.serialization: «Serializer for element of type kotlin.Any has not been found» | — |
| `ktor-mapped` | ❌ `AdminApi.kt:337`: il valore predefinito `State.needs_review` del parametro non è qualificato («Unresolved reference»; `State` è un enum annidato nelle classi del modello). `CatalogApi.kt:204`: «Unresolved reference» per gli enum `Sort` e `Order` dei parametri di query | — |
| `retrofit-mapped` | ✅ | **4 su 7**: falliscono 1, 3 e 6 con «Failed to parse int» (`$.expiresAt`, `$.events[0].at`, `$.sizeBytes`) |
| `retrofit-int64` | ✅ | **7 su 7** |
| `retrofit-long` | ✅ | **7 su 7** |

- **`retrofit-raw`:** le `Map<String, kotlin.Any>` generate per gli oggetti liberi (`Event.payload`, `Candidate.evidence`, `IdentificationCase.parsed`, `MediaFileDetails.facts`) non hanno un serializer. `number` diventa `java.math.BigDecimal` con `@Contextual`.
- **`ktor-mapped`:**
  - oltre agli errori di compilazione, l'`ApiClient` generato installa `ContentNegotiation` senza un convertitore JSON;
  - il suo `build.gradle` non ha `ktor-serialization-kotlinx-json`.
- **`retrofit-int64`:** le proprietà toccate da `int64.py` sono 10:
  - `Event.at`, `ActiveSession.startedAt`, `PlaybackSession.expiresAt`, `ProgressReport.clientTs`;
  - `LibraryRoot.lastScanAt`, `IdentificationCase.updatedAt`;
  - `MediaVersion.sizeBytes`, `MediaFileEntry.sizeBytes`, `MediaFileEntry.missingSince`, `MediaFileDetails.sizeBytes`.
- **`retrofit-long`:** nei sorgenti generati non resta nessun `kotlin.Int`. Anche indici e conteggi diventano `Long`.

**Altri fatti del codice generato** (`retrofit-long`):
- gli enum sconosciuti diventano `unknown_default_open_api`, il `payload` libero una mappa di `JsonElement`;
- i path sono relativi (`video/api/v1/...`) e le funzioni sono `suspend` con risultato `Response<T>`;
- l'`ApiClient` accetta un `OkHttpClient.Builder` e ha un'autenticazione `HttpBearerAuth` chiamata `profileToken`. L'autenticazione aggiunge un interceptor al builder ricevuto; senza builder, l'`ApiClient` ne crea uno con un logging del corpo completo;
- `StartPlaybackRequest` ha tutti i campi facoltativi con predefinito `null`: il tri-stato di `subtitleTrackId` (assente = preferenze del profilo, `null` = spenti) non si esprime con il modello da solo;
- il `build.gradle` generato fissa versioni vecchie (Kotlin 2.4.0, kotlinx-serialization 1.11.0, logging-interceptor 5.4.0; Ktor 3.5.1).

**Codifica (controllo 7):**
- con la configurazione generata il corpo contiene `"app":null` e gli altri `null`, che la validazione del server (Ajv sullo schema) rifiuterebbe per i campi non nullabili;
- con `explicitNulls = false` ed `encodeDefaults = false` i `null` spariscono;
- "superato" vuol dire solo che la codifica non lancia eccezioni: il corpo **non è validato** contro lo schema.

## Limiti

- I payload sono d'esempio, scritti a mano: non coprono tutte le operazioni e non sono risposte vere del server.
- Il collegamento di Retrofit (chiamate HTTP, interceptor, gestione degli errori) non è provato: la sonda usa solo i modelli e la serializzazione.
- La compilazione è sulla JVM, non con AGP per Android.

## Conclusione

- **`jvm-ktor` è scartato:** il codice generato non compila sul bundle.
- **`jvm-retrofit2` funziona** con i mapping `AnyType=JsonElement`, `number=kotlin.Double` e `integer=kotlin.Long`, più `Json` con `explicitNulls = false` ed `encodeDefaults = false`. Il contratto non deve cambiare.
- `format: int64` sulle 10 proprietà funziona altrettanto bene, ed è utile anche per un generatore senza mapping globale (la riserva Fabrikt dell'ADR 0004). L'ADR 0008 lo mette fra i passi della prima slice TV.
- **Da fare nella prima slice TV:** un test con MockWebServer che validi i corpi codificati contro lo schema del bundle, compreso il caso `subtitleTrackId: null`.
- La frase dell'ADR 0004 sui tipi «`Int?` corretti» non vale per gli istanti in millisecondi.
