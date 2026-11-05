# Sessione sul portatile — 2026-11-05

Diario della sessione ripresa sul portatile dal [passaggio di consegne](2026-11-06-handoff.md). Si aggiorna a ogni commit importante. **Claude: per riprendere leggi `CLAUDE.md`, poi questo file.**

## 1. Fatto

| Commit | Cosa |
|---|---|
| `6a7b8ae` | Ambiente del portatile in CLAUDE.md, worktree degli agenti ignorati da git |
| `593b836` | **S4, test live TMDB** con la chiave del proprietario, e revisione dell'ADR 0007. TMDB resta il provider dei metadata in italiano; l'identificazione resta su Wikidata (opzione A confermata) |
| `2ed688f` | **F1a.1**, moduli library (scansione, fingerprint, spostamenti, radici smontate, sidecar) e analyzer (ffprobe → MediaFacts). 242 test |
| `3b79530` | Standard di libreria: cartelle dei NAS ignorate, collegamenti simbolici non seguiti |
| `b99d99a` | ADR 0007: il contatto Wikidata di default è l'URL pubblico del repository |
| (questo commit) | **S2 chiuso**: report, revisione (54 rilievi applicati), propagazione nei doc 02/03/04, nuove decisioni P5, I5, I6 e ipotesi H11 |
| (commit successivo) | Contratto: campi `audioTrackSelection` e `displayHdr`, vocabolario fisso dei codec, definizioni di `delivery`, `stream.mimeType` con i `codecs` |

## 2. In corso

- **F1a.2**, identifier e scrittura nel catalogo: agente in worktree.

## 3. Prossimi passi

1. ADR 0003 (streaming) e ADR 0005 (web client), un tech-evaluator e un design-reviewer ciascuno.
2. F1a.2 → review e commit; poi F1a.3 (lettura del catalogo e admin) in parallelo con F1a.4 (adapter Wikidata e TMDB, Enricher, artwork, scadenza e purge).
3. F1b (playback) dopo l'ADR 0003. Il brief in `.claude/prompts/f1b-profiles-playback-delivery.md` è superato e va riscritto con gli esiti di S2:
   - AC-3/E-AC-3 solo in Edge;
   - FLAC, AAC 5.1 con channelConfiguration 6 e Opus in Chrome e Firefox;
   - `audioTrackSelection` false;
   - `displayHdr`;
   - layout `5.1` prima di AAC e Opus;
   - ripianificazione per dimensione sospetta;
   - DV P8.1 come `hvc1` e P7 con `remove_dovi`.
4. F1c (web client) dopo l'ADR 0005; F2 integrazione; report finale.

## 4. Punti aperti per l'ADR 0003

- **Estrazione dei sottotitoli embedded** (PGS → `.sup`, testo → WebVTT): leggere una traccia vuol dire leggere tutto il file, cioè minuti dal bind mount. L'output va nel volume cache persistente. Opzioni da misurare:
  - un'uscita in più del processo di remux, dalla posizione di partenza;
  - un'estrazione in background, all'ingest o al primo playback.
- **Buffer di hls.js:** dimensionare `maxBufferLength` / `maxMaxBufferLength` / `maxBufferSize` sul bitrate, per restare sotto la quota video di Chromium (150 MiB). La quota audio (12 MiB) non è stata messa alla prova.
- **DV P7 (H11):** `hevc_metadata=remove_dovi=1` esiste nell'immagine, ma l'effetto su un P7 non è misurato.

## 5. In attesa del proprietario

- **Verifica dei colori su un monitor SDR** in Chrome, Edge e Firefox, anche con un remux UHD vero con metadata statici: decide **P5**. Se fallisce si riapre P2.
- **Ascolto 5.1** delle clip c1–c7 (`spikes/s2-browser-playback/index.html`). Serve un'uscita HDMI verso l'AVR: il PC originale ha solo uscite stereo.
- **Un sample Dolby Vision profilo 7** (UHD Blu-ray), per H11.
- Percorsi reali della libreria, modello della TV, ADB, eARC, porta 8080 nel firewall.

## 6. Scadenze

- **Entro il 2027-05-05: cancellare `spikes/s4-identification/out/`.** Contiene risposte TMDB e, per i termini (§1.C), non si conservano oltre 6 mesi.
