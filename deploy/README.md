# deploy

Orchestrazione Docker Compose della piattaforma ([ADR 0006](../docs/adr/0006-deploy-e-gateway.md)).

Principi: media storage montato **read-only**; database, cache e artwork su volumi separati; ogni servizio isolato dagli altri.

| File | Cosa |
|---|---|
| `compose.yaml` | i due servizi: `gateway` (unica porta pubblicata) e `video` (solo dietro il gateway) |
| `gateway.Dockerfile` | immagine del gateway: build del web client, poi Caddy con la build in `/srv/web` |
| `Caddyfile` | web client (SPA) e proxy di `/video/*` verso il Video Service, con health check attivo |
| `video.Dockerfile` | immagine del Video Service: Node 26 e jellyfin-ffmpeg 8.1.3 |

## Come si avvia

Serve Docker con Compose v2 (su Windows Docker Desktop con WSL2). Tutti i comandi partono dalla **radice del repository**.

1. Configurazione: copia `.env.example` in `.env` e controlla queste chiavi.
   - `MEDIA_DIR`: la cartella della libreria sull'host. Un percorso relativo parte da `deploy/`: il default `../media-samples/library` è la libreria di prova. Su Windows va bene anche `E:/Media`.
   - `LIBRARY_ROOTS`: le radici della libreria **dentro il container**, sotto `/media`.
   - `HTTP_PORT`: la porta del gateway, di default 8080.
   - `TMDB_READ_TOKEN`: facoltativo. Senza, la libreria funziona con i soli dati di Wikidata.
2. Build e avvio:

   ```sh
   docker compose -f deploy/compose.yaml --env-file .env up -d --build
   ```

3. Apri `http://localhost:8080`: compare la scelta del profilo. Alla partenza il Video Service scansiona la libreria; l'avanzamento è in **Gestione → Ingest**. Per i primi 10 secondi circa le chiamate a `/video/*` possono rispondere `503` JSON con `Retry-After`: il gateway aspetta il primo health check riuscito del Video Service.

Comandi utili, con le stesse opzioni `-f deploy/compose.yaml --env-file .env`:

| Comando | Effetto |
|---|---|
| `ps` | stato dei container; `video` diventa `healthy` quando risponde su `/video/healthz` |
| `logs -f video` | log del Video Service (JSON di pino) |
| `up -d --build` | aggiorna dopo un cambio di codice. Il web client è dentro l'immagine del gateway: un cambio del client richiede la build del gateway |
| `down` | ferma tutto; i volumi (database, locandine, cache) restano |
| `down -v` | ferma tutto e **cancella i volumi**: database, stato di visione e locandine si perdono. I media non si toccano mai |
| `watch` | sviluppo: sincronizza `services/video/src` nel container e lo riavvia |

### Volumi

| Volume | Path nel container | Contenuto |
|---|---|---|
| bind mount di `MEDIA_DIR` | `/media` (**read-only**) | la libreria |
| `video-db` | `/data/db` | database SQLite |
| `video-cache` | `/data/cache` | cache ricostruibili |
| `video-artwork` | `/data/artwork` | locandine e immagini |
| `video-thumbnails` | `/data/thumbnails` | anteprime |
| `video-scratch` | `/data/scratch` | segmenti HLS e sottotitoli estratti, temporanei |
| `video-backup` | `/data/backup` | backup giornalieri del database |
| `gateway-data` | `/data` del gateway | stato di Caddy |

### Uno stack di prova accanto a quello principale

Nome del progetto, porta, tag delle immagini e file `.env` si cambiano dalla shell, senza toccare i file. Così volumi, container e immagini non si mescolano con lo stack principale. Esempio, sempre dalla radice (bash):

```sh
COMPOSE_PROJECT_NAME=pzf-test HTTP_PORT=18280 PZF_IMAGE_TAG=test \
PZF_ENV_FILE="$PWD/.env" MEDIA_DIR="$PWD/media-samples/library" \
docker compose -f deploy/compose.yaml up -d --build
```

- `PZF_ENV_FILE`: il `.env` passato al Video Service (default: quello della radice).
- `PZF_IMAGE_TAG`: il tag delle immagini `pezzotflix/gateway` e `pezzotflix/video` (default `dev`). Con un tag diverso, la build non sostituisce le immagini dello stack principale.

Per chiuderlo: lo stesso comando con `down -v`, poi `docker image rm pezzotflix/gateway:test pezzotflix/video:test`.

## Test end-to-end

I test sono in `clients/web/test/e2e` (Playwright) e girano contro lo stack avviato. Non fanno parte di `npm run verify`.

1. Una volta per macchina: installa i browser di Playwright con `npx playwright install chromium firefox` dentro `clients/web`. Edge e Chrome si usano come sono installati sul sistema. Firefox si apre con la finestra, come nello spike S2: senza finestra perde quasi tutti i frame e dichiara HEVC anche quando non sa decodificarlo.
2. Copia `clients/web/test/e2e/samples.example.json` in `clients/web/test/e2e/samples.json` (ignorato da git) e adattalo alla tua libreria:
   - un titolo per ogni caso, come lo mostra il catalogo;
   - in `manualMatches` i file che finiscono in "Da verificare" e servono ai test: il setup li risolve con "crea manualmente".
3. Variabili d'ambiente:
   - `PZF_E2E_BASE_URL`: l'indirizzo del gateway, di default `http://localhost:8080`;
   - `PZF_E2E_SAMPLES`: il percorso assoluto di `samples.json`.
4. Lancia, dalla radice:

   ```sh
   npm run e2e:smoke -w @pezzotflix/web                   # solo API: un comando per tutto lo stack
   npm run e2e -w @pezzotflix/web -- --project=chromium    # i test nel browser; anche edge, chrome, firefox
   ```

Ogni esecuzione parte dal progetto `stack`:
- aspetta che il gateway risponda;
- lancia una scansione e aspetta la fine dell'ingest;
- risolve i `manualMatches`;
- controlla che nessun job sia fallito.

Lo **smoke** (`smoke.spec.ts`) verifica poi via API, attraverso il gateway:
- Direct Play: `206` con Range all'inizio e a metà del file;
- Direct Stream: playlist, init e primo segmento HLS; avanzamento salvato e ripresa da quel punto;
- PGS interno al file estratto in `.sup`, e testo interno al file estratto in WebVTT;
- Transcode di una sorgente fino a 1080p, per un client che arriva a 720p: primo segmento H.264.

Un caso senza voce in `samples.json` viene saltato, con il motivo.

## Note per Docker Desktop su Windows

- Il bind mount di una cartella NTFS è lento, e inotify non arriva dai percorsi Windows: `LIBRARY_WATCH=off`, con una scansione ogni `LIBRARY_SCAN_INTERVAL_MIN` minuti (default 15) o da **Gestione**.
- Il Video Service non pubblica porte: lo si raggiunge solo dal gateway. La sua rete non è `internal`, perché deve raggiungere Wikidata e TMDB.
- I log dei container ruotano a 3 file da 10 MB.
