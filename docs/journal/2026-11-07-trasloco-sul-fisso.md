# Trasloco del server sul PC fisso — 2026-11-07

Per riprendere sul PC fisso. **Claude: leggi prima `CLAUDE.md`, poi questo file, poi parti dal §4.** Il dettaglio di quello che è stato fatto è nel [diario del portatile](2026-11-05-sessione-portatile.md).

## 1. A che punto siamo

- Su `main` ci sono:
  - l'MVP completo: server, web client e stack Compose;
  - l'app per la TV, F3a e F3b ([doc 07](../architecture/07-tv-client-plan.md)).
- **Prima prova sulla TV vera** (2026-11-07), contro lo stack del portatile. Il 2001 è andato in Direct Play con:
  - audio AC-3 ita;
  - PGS ita incorporati, scelti dal menu;
  - ripresa dal punto giusto;
  - le capability vere della TV.

  Il resto della prova è nel [doc 07 §7](../architecture/07-tv-client-plan.md#7-prova-sulla-tv-vera).
- Il proprietario vuole il server sul fisso. Ci resta finché non arriva il mini-PC; poi il trasloco porta solo i volumi.

## 2. Decisioni per il trasloco

- **Si parte da zero.** Profili, stato di visione e catalogo del portatile non si portano (ok del proprietario, 2026-11-07): il fisso nasce con volumi nuovi.
- **Libreria vera, senza i file di prova.** Sul fisso `MEDIA_DIR` punta al disco dei film. I file costruiti dagli spike non entrano nel catalogo di casa: sono in `media-samples/library` (Blade Runner 2049, Dune, Dark, Long Test e gli altri).
  - Le prove che la libreria vera non copre si fanno con uno [stack di prova](../../deploy/README.md#uno-stack-di-prova-accanto-a-quello-principale), sul portatile o sul fisso. Un esempio è un remux con TrueHD in Direct Stream.
- **Lo stack 8080 del portatile si ferma** quando la TV passa al fisso. Gli stack di prova restano possibili su tutti e due i PC.
- Il fisso diventa un server di casa su Windows con Docker Desktop: deve restare acceso e con l'utente collegato. Gli accorgimenti sono in [`deploy/README.md`, "Server di casa su Windows"](../../deploy/README.md#server-di-casa-su-windows).

## 3. Prima di andare al fisso (proprietario, sul portatile)

Su una chiavetta o un disco esterno, mai in chat né in un commit:
1. la riga `TMDB_READ_TOKEN=…` del `.env` alla radice del repository;
2. la cartella `C:\Users\SimoneMen\.pezzotflix\`, con la chiave di firma dell'app TV e gli APK. Copiarla sul fisso fa anche da backup della chiave;
3. il 2001 (`media-samples/library/movies/2001 - Odissea nello spazio (1968)/`, 21,8 GB), solo se sul fisso non c'è già.

## 4. Sul fisso: cosa fa Claude, in ordine

1. **Repository.** Il fisso è fermo a F0 (2026-11-06).
   - Prima di tutto `git status`: se ci sono file locali, si guardano e si chiede al proprietario. Non si buttano.
   - Poi `git pull`.
2. **Strumenti.**
   - Si aggiornano Docker Desktop (era alla 4.98, engine 29) e WSL.
   - Node 26.13 serve solo per sviluppare (`npm run verify`), non per lo stack.
3. **Stack vecchi.**
   - Si guardano con `docker compose ls -a`, `docker volume ls` e `docker image ls "pezzotflix/*"`.
   - Lo stack `pezzotflix` provato con F0 ha un database con lo schema di allora e nessun dato vero.
   - Si toglie con `docker compose -p pezzotflix down -v`, insieme alle vecchie immagini `pezzotflix/*`.
   - Prima si elenca al proprietario cosa si toglie.
4. **Configurazione.** Il `.env` nasce da `.env.example`.
   - `TMDB_READ_TOKEN`: la incolla il proprietario dal file copiato. Claude non la legge e non la stampa.
   - `MEDIA_DIR`: il disco o la cartella dei film, per esempio `E:/Media`.
   - `LIBRARY_ROOTS`: una radice per tipo, con le cartelle dello [standard della libreria](../library-standard.md) (`Film`, `Serie`, `Documentari`) e un disco per radice. Se i film non seguono lo standard, prima si guarda come sono organizzati, poi si decide con il proprietario.
   - `LIBRARY_SCAN_INTERVAL_MIN=15` (il valore di partenza): sui dischi NTFS i cambi non arrivano al container, quindi vale la scansione periodica.
   - `HTTP_PORT=8080`; `PZF_HOSTS` resta vuoto.
5. **Avvio.**
   - `docker compose -f deploy/compose.yaml --env-file .env up -d --build`.
   - `ps` deve mostrare `video` come `healthy`; poi si apre `http://localhost:8080`.
   - La prima scansione della libreria vera richiede tempo: analisi, identificazione, locandine. L'avanzamento è in **Gestione → Ingest** e i casi dubbi in **Da verificare**.
6. **Rete.** I comandi sono in `deploy/README.md`.
   - L'indirizzo del fisso si legge con `ipconfig`. Meglio il cavo.
   - Il profilo della rete deve essere **Privato**.
   - Serve una regola del firewall per la porta 8080. Chiede l'amministratore: la lancia il proprietario.
   - Prova da un altro dispositivo: `http://<IP del fisso>:8080/video/healthz`, dal portatile o dall'iPad.
7. **Windows.**
   - Niente sospensione quando è collegato alla corrente.
   - Docker Desktop si avvia all'accesso.
   - Dopo un riavvio, per esempio per gli aggiornamenti, Docker Desktop riparte solo quando l'utente accede.
8. **TV.**
   - Nell'app: Home → Cambia profilo → Cambia server, `http://<IP del fisso>:8080`, poi si crea o si sceglie il profilo. Non serve reinstallare.
   - ADB dal fisso serve solo per leggere il logcat:
     - si installa con `winget install Google.PlatformTools`;
     - si collega con `adb connect <IP della TV>:5555`;
     - la prima volta la TV chiede di autorizzare la chiave del fisso.
9. **Portatile.** Quando la TV va sul fisso, lo stack 8080 del portatile si ferma con `docker compose -f deploy/compose.yaml --env-file .env down`. I volumi restano finché il proprietario non dice di toglierli.
10. **Diario.** Si annotano qui l'esito, l'IP del fisso, i percorsi e cosa manca. Poi si aggiorna `CLAUDE.md` e si fanno commit e push.

## 5. Cosa serve dal proprietario

- Dove stanno i film sul fisso (disco e cartelle).
- I file del §3, copiati.
- Il prompt di amministratore per il firewall, ed eventualmente per il profilo della rete.
- Sul router, la prenotazione DHCP per il fisso e per la TV.
  - La TV oggi usa un MAC Wi‑Fi casuale (`5a-53-29-3a-30-c2`, IP `192.168.1.15`).
  - Prima, nelle impostazioni di rete della TV, la rete di casa va passata al MAC del dispositivo; poi si fa la prenotazione.
- Il fisso col cavo, se possibile.

## 6. Dopo il primo setup

- **Resto della prova sulla TV** (doc 07 §7), con la libreria vera. Il remux con TrueHD in Direct Stream si prova con uno stack di prova, se la libreria non ne ha uno.
- **Backup:** il volume `video-backup` sta nel disco virtuale di Docker. Va copiato fuori dal PC ogni tanto (`deploy/README.md`).
- **Transcode in hardware:** la scheda NVIDIA del fisso (NVENC, H10 ✅) lo rende possibile. È una decisione a parte (P2) e non serve ora.
- **Sviluppo dell'app TV dal fisso**, se servirà:
  - JDK 21;
  - Android SDK, con platform 37 e build-tools 37.0.0;
  - la chiave di firma in `%USERPROFILE%\.pezzotflix\` (§3);
  - poi si segue `clients/tv/README.md`.

## 7. Esito sul fisso (2026-11-12)

- **Macchina.** Il fisso ha ora **8 GB di RAM** (manca un banco) e il disco C: quasi pieno (42 GB liberi). E: è un SSD Samsung 870 EVO da 4 TB.
  - `%USERPROFILE%\.wslconfig`: la VM di WSL (Docker) ha al massimo **3 GB** di RAM e 4 GB di swap in `E:\Docker\wsl-swap.vhdx`.
  - Dischi di Docker Desktop spostati in `E:\Docker\wsl` (impostazione `CustomWslDistroDir`; copia della vecchia configurazione in `%APPDATA%\Docker\settings-store.json.bak-2026-11-12`). Docker Desktop si avvia all'accesso.
  - Docker Desktop aggiornato alla 4.99 (engine 29.9.3), WSL 3.0.5.
  - Sospensione disattivata con l'alimentazione da rete.
- **Libreria.** `E:\Film` è la cartella di appoggio del proprietario e **non** si monta. La libreria è `E:\Libreria Pezzottoflix` (`MEDIA_DIR`), con la sola radice `Film` per ora; `Serie` e `Documentari` si aggiungono a `LIBRARY_ROOTS` quando nascono le cartelle.
  - Primo film: Shining, spostato da `E:\Film` e rinominato secondo lo standard in `Film/Shining (1980)/Shining (1980) - 2160p.mkv`. Abbinato in automatico su Wikidata. Avviso del keyframe index: Cues dell'MKV inattendibili, indice ricostruito dal probe.
  - Arancia meccanica (remux DV ibrido, 56 GB) è ancora in `E:\Film`.
- **Stack.** Vecchio stack F0 rimosso con i suoi volumi (ok del proprietario). Nuovo stack `pezzotflix` su, `video` healthy, `http://localhost:8080`. Gli altri progetti Docker del proprietario sul fisso non sono stati toccati.
- **Rete.** IP del fisso `192.168.1.16`, via cavo (Ethernet). NordVPN è installato (interfaccia NordLynx): se blocca la LAN va attivata la sua opzione per la rete locale.
- **Manca:**
  - [x] profilo Ethernet Privato e regola firewall per la 8080 (proprietario, 2026-11-12): il server risponde da un altro PC;
  - [x] `TMDB_READ_TOKEN` nel `.env` (2026-11-12): provider `wikidata,tmdb` ok;
  - [ ] passaggio della TV a `http://192.168.1.16:8080`;
  - [ ] prenotazione DHCP sul router per fisso e TV;
  - [ ] fermare lo stack 8080 del portatile.
