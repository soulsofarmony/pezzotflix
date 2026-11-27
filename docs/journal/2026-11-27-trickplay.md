# 2026-11-27 — Anteprime sulla barra di seek (trickplay)

Sessione notturna sul fisso (server di casa). Richiesta del proprietario: "scorro sulla timeline col mouse e, stile Netflix, mi compare il riquadro con la preview di quella scena". Poi: "procedi e costruiscilo".

## 1. Libreria

Prima del trickplay, nella stessa sessione (dettagli nel [journal del fisso](2026-11-07-trasloco-sul-fisso.md) §7):
- in libreria L'uccello dalle piume di cristallo, Profondo rosso, Suspiria, Amarcord e Il Casanova di Federico Fellini, tutti abbinati in automatico;
- `E:\Film` ripulita;
- in libreria 30 film, 31 file video in tutto.

Nella cartella di appoggio resta "Investigation of a Citizen Above Suspicion" (Indagine su un cittadino al di sopra di ogni sospetto), non ancora dato per pronto dal proprietario.

## 2. Cosa è stato fatto

- **Decisione:** [ADR 0009](../adr/0009-trickplay-anteprime-seek.md), accettato dopo un passaggio di `design-reviewer`. Il revisore ha trovato 10 problemi seri nella prima bozza; i più importanti:
  - la ricostruzione all'avvio avrebbe riaccodato ogni volta anche i job falliti;
  - la generazione non dava la precedenza al playback;
  - cache e `Cache-Control` contraddicevano l'ADR 0003.

  Tutti corretti prima dell'accettazione.
- **Piano:** [doc 08](../architecture/08-trickplay-plan.md), tre slice in sequenza, ciascuna con un `module-implementer` nel suo worktree:

  | Slice | Commit | Verifica |
  |---|---|---|
  | T1 server | `5a56b9b` | un `code-reviewer`: 1 problema serio (uno spegnimento consumava i tentativi del job) e 7 minori, tutti corretti |
  | T2 browser | `bcc832a` | provato dal vivo in Chrome su 2001 (HLS), Il sorpasso, Todo modo (Transcode, anamorfico) e Winnie the Pooh (Direct Play): dopo il click il film riparte entro circa 1 s dall'ora mostrata |
  | T3 TV | `97949e2` | app 0.3.0, provata sull'emulatore Android TV 11 (API 30) con Psyco e Il dottor Zivago |
  | Ripiego | `d464c4a` | decodifica completa quando quella dei soli keyframe produce troppo poco (§4) |
  | Coda lunga | `cfe0e24` | tolleranza alla fine da 30 a 60 s, timeout del ripiego legato alla durata (§4) |

- **In funzione sul fisso:** servizio `video` e gateway ricostruiti. All'avvio il servizio ha accodato da solo le anteprime dei 31 file.

## 3. Misure

| File | Tempo | Memoria di picco | Output |
|---|---|---|---|
| 2001, 4K HDR10 x265, 21,8 GB | 6 min | 311 MiB | 9 griglie, 6,4 MB |
| Psyco, 1080p H.264, 8,5 GB | 2,5 min | 205 MiB | 7 griglie, 4,3 MB |
| Arancia meccanica, 4K DV remux, 56 GB | 29 min | 452 MiB | 9 griglie, 7,9 MB |

- Ricostruzione dell'intera libreria: circa 3 ore nella notte, con la CPU a priorità bassa.
- Cache: circa 125 MB per 31 file.

## 4. Problemi trovati

- **Blu-ray H.264 con I-frame non IDR** (La classe operaia va in paradiso): con `-skip_frame nokey` il decoder non restituisce niente, 1 riquadro su 692. Non funzionano nemmeno `nointra` e `-flags2 +showall`. La correzione è il ripiego a decodifica completa (`d464c4a`, nota nell'ADR 0009). Il registro di fallimento di quel file è stato cancellato a mano e il job riaccodato nel DB.
- **Suspiria, coda senza keyframe:** l'ultimo keyframe è a 5919 s su 5957 (un GOP di 38 s sui titoli di coda), quindi 592 riquadri su 596 contro un minimo di 593. Il ripiego a decodifica completa è poi scaduto dopo 20 minuti, perché il timeout veniva solo dalla dimensione del file (8,6 GB). Correzione: tolleranza a 60 s e timeout del ripiego pari ad almeno la durata del film (nota nell'ADR 0009). Anche qui il registro di fallimento è stato cancellato a mano e il job riaccodato nel DB.
- **Blocco (ANR) sull'emulatore** dopo un seek in Psyco, con la RAM del fisso a 16 MB liberi. Probabile fame di memoria dell'host, non dimostrata: da tenere d'occhio sulla TV.

## 5. Strumenti installati sul fisso

Tutto in CLAUDE.md, sezione Environment:
- Node 26.13 portatile in `E:\Tools`;
- ffmpeg 8.1.2 con winget. La vecchia 7.0 resta nel PATH e rompe i test d'integrazione: va messa davanti la 8.1.2;
- JDK 21 in `E:\Tools`;
- SDK Android in `E:\Tools\android-sdk`, licenza accettata su richiesta del proprietario;
- AVD `pzf-tv30` in `E:\Tools\avd`.

Il worktree automatico degli agenti si rifiuta di partire su questo PC: `c:` minuscolo nel percorso di lavoro contro `C:` di git. I worktree si creano a mano in `C:\Repo\pezzotflix-wt\`.

## 6. Da fare

- [ ] **Prova sulla TV vera** (piano 08 §5.4): l'app 0.3.0 va installata sulla Haier. Servono due cose dal proprietario:
  - accettare sulla TV l'autorizzazione ADB del fisso ("Consentire il debug USB?", con "consenti sempre");
  - copiare la chiave di firma di release dal portatile (`%USERPROFILE%\.pezzotflix\`) nella stessa cartella del fisso. In alternativa si disinstalla e reinstalla l'app, perdendo indirizzo del server e profilo.

  Da verificare sulla TV: accelerazione col tasto tenuto premuto, memoria e qualità RGB_565 delle griglie, assenza di ANR.
- [ ] **Convivenza col playback** (piano 08 §5.2) con un job in corso, durante un Direct Stream e un Transcode.
- [ ] `TRICKPLAY_VERSION` resta a 1 finché i parametri non cambiano. Un cambio rigenera tutta la libreria, circa 3 ore.
