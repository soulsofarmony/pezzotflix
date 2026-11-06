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
   - `MEDIA_DIR`: la cartella della libreria sull'host. Un percorso relativo parte da `deploy/`: il default `../media-samples/library` è la libreria di prova. Su Windows va bene anche `E:/Media`. La cartella deve esistere: su Linux un percorso sbagliato ferma `up` con `bind source path does not exist`, invece di montare una cartella vuota. Docker Desktop su Windows invece la crea vuota: in quel caso le radici risultano offline in **Gestione → Radici** e nessun file viene segnato come mancante.
   - `LIBRARY_ROOTS`: le radici della libreria **dentro il container**, sotto `/media`. Il valore di `.env.example` usa le cartelle della libreria di prova (`/media/movies`, `/media/series`). Per la libreria vera, con le cartelle dello [standard della libreria](../docs/library-standard.md):

     ```sh
     LIBRARY_ROOTS=[{"name":"Film","path":"/media/Film","hint":"movies"},{"name":"Serie","path":"/media/Serie","hint":"series"},{"name":"Documentari","path":"/media/Documentari","hint":"movies"}]
     ```

   - `HTTP_PORT`: la porta del gateway, di default 8080.
   - `TMDB_READ_TOKEN`: facoltativo. Senza, la libreria funziona con i soli dati di Wikidata.
   - `MEDIA_GID`: solo su un host Linux o un NAS, il gruppo che può leggere `MEDIA_DIR` (vedi [Utente e permessi](#utente-e-permessi)).
   - `PZF_HOSTS`: facoltativo, i nomi con cui apri l'app oltre all'indirizzo IP (vedi [Indirizzi accettati](#indirizzi-accettati)).
   - `MISSING_REMOVE_AFTER_DAYS`: facoltativo, default 30. Dopo quanti giorni un file sparito da una libreria online esce dal catalogo; `0` spegne la rimozione automatica. I file mancanti si vedono, e si dimenticano a mano, in **Gestione → File mancanti**. Niente viene cancellato: se il file torna, torna con il suo titolo e i suoi progressi. **Un disco per radice:** la protezione contro i dischi smontati guarda la radice intera (vuota, irraggiungibile, o più di metà dei file spariti); un secondo disco montato in una sottocartella di una radice non viene riconosciuto, e dopo il periodo di grazia i suoi file uscirebbero dal catalogo. Mettete ogni disco nella sua radice in `LIBRARY_ROOTS`.
2. Build e avvio:

   ```sh
   docker compose -f deploy/compose.yaml --env-file .env up -d --build
   ```

3. Apri `http://localhost:8080`, oppure `http://<IP del PC>:8080` da un altro dispositivo della rete: compare la scelta del profilo. Alla partenza il Video Service scansiona la libreria; l'avanzamento è in **Gestione → Ingest**. Per i primi 10 secondi circa le chiamate a `/video/*` possono rispondere `503` JSON con `Retry-After`: il gateway aspetta il primo health check riuscito del Video Service.

Comandi utili, con le stesse opzioni `-f deploy/compose.yaml --env-file .env`:

| Comando | Effetto |
|---|---|
| `ps` | stato dei container; `video` diventa `healthy` quando risponde su `/video/healthz` |
| `logs -f video` | log del Video Service (JSON di pino) |
| `up -d --build` | aggiorna dopo un cambio di codice. Il web client è dentro l'immagine del gateway: un cambio del client richiede la build del gateway |
| `down` | ferma tutto; i volumi (database, backup, locandine, cache, chiave dei profili) restano |
| `down -v` | ferma tutto e **cancella tutti i volumi**: database, stato di visione, locandine, **i backup del database** (`video-backup`) e la chiave dei profili (`video-secrets`, quindi ogni dispositivo deve riscegliere il profilo). I media non si toccano mai |
| `watch` | sviluppo: sincronizza `services/video/src` nel container e lo riavvia |

Le immagini `pezzotflix/*` si costruiscono solo in locale (`pull_policy: never`): né `docker compose pull` né un `up` senza immagine le scaricano da Docker Hub, dove potrebbe esserci un'immagine con lo stesso nome di qualcun altro. Se manca, `up` la costruisce; dopo un cambio di codice serve `up -d --build`.

### Volumi

| Volume | Path nel container | Contenuto |
|---|---|---|
| bind mount di `MEDIA_DIR` | `/media` (**read-only**) | la libreria |
| `video-db` | `/data/db` | database SQLite |
| `video-cache` | `/data/cache` | cache ricostruibili |
| `video-artwork` | `/data/artwork` | locandine e immagini |
| `video-thumbnails` | `/data/thumbnails` | anteprime |
| `video-scratch` | `/data/scratch` | segmenti HLS e sottotitoli estratti, temporanei |
| `video-backup` | `/data/backup` | copie del database: una al giorno, tenute 7 giorni, più una a settimana per 4 settimane, e una copia prima di ogni migrazione dello schema |
| `video-secrets` | `/data/secrets` | la chiave che firma i token dei profili: senza volume, ogni nuova build farebbe uscire tutti i profili |
| `gateway-data` | `/data` del gateway | stato di Caddy |

Su Docker Desktop `video-backup` sta nello stesso disco virtuale del database: protegge da un errore o da una migrazione andata male, non dalla perdita del disco.

### Ripristinare un backup

Il database è `/data/db/video.db`. Per sostituirlo con una copia di `/data/backup`, sempre dalla radice (PowerShell o bash; in Git Bash anteponi `MSYS_NO_PATHCONV=1`, altrimenti `/data/...` diventa un percorso di Windows):

1. Ferma solo il Video Service; il gateway risponde `503` nel frattempo.

   ```sh
   docker compose -f deploy/compose.yaml --env-file .env stop video
   ```

2. Guarda le copie disponibili, con data e ora:

   ```sh
   docker compose -f deploy/compose.yaml --env-file .env run --rm --no-deps video ls -l /data/backup
   ```

3. Copia quella scelta sopra il database, in un container usa e getta con gli stessi volumi e lo stesso utente. I file `-wal` e `-shm` del database vecchio vanno tolti, altrimenti SQLite li applicherebbe alla copia:

   ```sh
   docker compose -f deploy/compose.yaml --env-file .env run --rm --no-deps video sh -c 'cp /data/backup/<file> /data/db/video.db.restore && rm -f /data/db/video.db-wal /data/db/video.db-shm && mv /data/db/video.db.restore /data/db/video.db'
   ```

4. Riavvia:

   ```sh
   docker compose -f deploy/compose.yaml --env-file .env start video
   ```

### Utente e permessi

Il Video Service gira sempre come utente e gruppo `1000:1000`: i volumi nominati nascono con quel proprietario, dall'immagine. Per leggere i media prende in più il gruppo `MEDIA_GID` (default 1000). Su un host Linux o un NAS imposta in `.env` un gruppo che può leggere `MEDIA_DIR`, per esempio `MEDIA_GID=100` (il gruppo `users` di molti NAS). Non serve cambiare l'utente: basta che la libreria sia leggibile da quel gruppo.

### Indirizzi accettati

Finché non c'è autenticazione, il gateway risponde solo se l'indirizzo con cui lo si apre (l'header `Host`) è:
- un indirizzo IP, IPv4 o IPv6 tra parentesi quadre, per esempio `http://192.168.1.20:8080` dall'iPad;
- `localhost`;
- uno dei nomi in `PZF_HOSTS`, separati da spazi, per esempio `PZF_HOSTS=pezzotflix.local`.

Ogni porta va bene. Con qualunque altro nome risponde `421`. Così una pagina web aperta in casa non può usare un nome suo (DNS rebinding) per comandare l'app. Dopo un cambio di `PZF_HOSTS` basta `up -d gateway`.

### Gateway

- **Log senza token.** Le URL dei media contengono il token della sessione (`/video/media/s/<token>/…`). Quando una risposta si interrompe (succede a ogni seek in Direct Play) o il Video Service non risponde, Caddy scrive la richiesta nel log: il token viene sostituito con `***`, anche nell'header `Referer`, e gli header `Authorization` e `Cookie` non vengono scritti.
- **Health check.** Il gateway prova `/video/healthz` ogni 10 secondi, con 5 secondi di timeout. Dichiara giù il Video Service dopo 3 prove fallite di fila, non per una sola risposta lenta.
- **Asset del web client.** I file in `/assets/` hanno un nome che cambia a ogni build e restano in cache per un anno. Un asset che non esiste risponde `404`, mai con `index.html`: una scheda rimasta aperta su una build vecchia non mette in cache una pagina HTML al posto di un file JavaScript.

### Uno stack di prova accanto a quello principale

Nome del progetto, porta, tag delle immagini e file `.env` si cambiano dalla shell, senza toccare i file. Così volumi, container e immagini non si mescolano con lo stack principale. Esempio, sempre dalla radice (bash):

```sh
COMPOSE_PROJECT_NAME=pzf-test HTTP_PORT=18280 PZF_IMAGE_TAG=test \
PZF_ENV_FILE="$PWD/.env" MEDIA_DIR="$PWD/media-samples/library" \
docker compose -p pzf-test -f deploy/compose.yaml up -d --build
```

- `PZF_ENV_FILE`: il `.env` passato al Video Service (default: quello della radice).
- `PZF_IMAGE_TAG`: il tag delle immagini `pezzotflix/gateway` e `pezzotflix/video` (default `dev`). Con un tag diverso, la build non sostituisce le immagini dello stack principale.

Per chiuderlo: lo stesso comando con `down -v`, poi `docker image rm pezzotflix/gateway:test pezzotflix/video:test`.

## Test end-to-end

I test sono in `clients/web/test/e2e` (Playwright) e girano contro uno stack avviato. Non fanno parte di `npm run verify`. Creano un profilo `E2E` e risolvono casi di "Da verificare": vanno lanciati su uno [stack di prova](#uno-stack-di-prova-accanto-a-quello-principale), non su quello che usi.

1. Una volta per macchina: installa i browser di Playwright con `npx playwright install chromium firefox` dentro `clients/web`. Edge e Chrome si usano come sono installati sul sistema. Firefox si apre con la finestra, come nello spike S2: senza finestra perde quasi tutti i frame e dichiara HEVC anche quando non sa decodificarlo.
2. Copia `clients/web/test/e2e/samples.example.json` in `clients/web/test/e2e/samples.json` (ignorato da git) e adattalo alla tua libreria:
   - un titolo per ogni caso, **esattamente** come lo mostra il catalogo;
   - in `manualMatches` i file che finiscono in "Da verificare" e servono ai test: il setup li risolve con "crea manualmente".
3. Variabili d'ambiente:
   - `PZF_E2E_BASE_URL` (**obbligatoria**): l'indirizzo del gateway di prova, per esempio `http://localhost:18280`. Senza, i test non partono: non c'è un default, così non finiscono per sbaglio sullo stack principale;
   - `PZF_E2E_SAMPLES`: un altro file di sample al posto di `test/e2e/samples.json`;
   - `PZF_E2E_ALLOW_SKIP`: i casi che possono essere saltati, separati da virgole (per esempio `c4,c7` se la libreria non ha quei file), oppure `1` per tutti.
4. Lancia, dalla radice:

   ```sh
   PZF_E2E_BASE_URL=http://localhost:18280 npm run e2e:smoke -w @pezzotflix/web                  # solo API
   PZF_E2E_BASE_URL=http://localhost:18280 npm run e2e -w @pezzotflix/web -- --project=chromium   # anche edge, chrome, firefox
   ```

Ogni esecuzione parte dal progetto `stack`:
- aspetta che il gateway risponda;
- lancia una scansione e aspetta la fine dell'ingest. I job rimandati a più tardi (un provider che chiede di riprovare) non si aspettano; se l'ingest non finisce in 10 minuti, l'errore riporta i job per tipo e stato;
- risolve i `manualMatches`. Una voce che non corrisponde a un caso in coda o già risolto è un errore;
- controlla che nessun job sia fallito, e che i sample trovati nel catalogo abbiano un file disponibile su una radice online.

Lo **smoke** (`smoke.spec.ts`) verifica poi via API, attraverso il gateway:
- Direct Play: `206` con Range all'inizio e a metà del file;
- Direct Stream: playlist, init e primo segmento HLS; avanzamento salvato e ripresa da quel punto;
- PGS interno al file estratto in `.sup`, e testo interno al file estratto in WebVTT;
- Transcode di una sorgente fino a 1080p, per un client che arriva a 720p: primo segmento H.264.

Un caso senza voce in `samples.json`, o con un titolo che il catalogo non ha, **fallisce**, a meno che `PZF_E2E_ALLOW_SKIP` non lo permetta. Vengono saltati, con il motivo, solo i casi che il browser non sa decodificare (per esempio HEVC su Edge senza l'estensione).

## Note per Docker Desktop su Windows

- Il bind mount di una cartella NTFS è lento, e inotify non arriva dai percorsi Windows: `LIBRARY_WATCH=off`, con una scansione ogni `LIBRARY_SCAN_INTERVAL_MIN` minuti (default 15) o da **Gestione**.
- Il Video Service non pubblica porte: lo si raggiunge solo dal gateway. La sua rete non è `internal`, perché deve raggiungere Wikidata e TMDB.
- I log dei container ruotano a 3 file da 10 MB.
