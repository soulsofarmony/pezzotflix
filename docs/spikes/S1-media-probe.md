# S1 — Media probe

- **Stato:** Completato (2026-10-01)
- **Domanda:** cosa espongono davvero i remux tramite ffprobe? Il Domain Model (doc 01 §4) cattura tutto ciò che serve alla decisione di playback?
- **Alimenta:** doc 01 §4.3, doc 04 H3, futura ADR sul media analyzer
- **Codice:** `spikes/s1-media-probe/` (`fetch.sh`, `build_fixtures.sh`, `probe.py`), throwaway

## Setup

- ffmpeg/ffprobe **7.0** (gyan.dev full build), Windows 11.
- **Sorgenti video** (licenza CC BY-SA, [repo.jellyfin.org/test-videos](https://repo.jellyfin.org/test-videos/)):
  - 1080p AVC 30 Mbps;
  - 4K HEVC "HDR10" 100 Mbps;
  - 4K Dolby Vision P8.1 e P5.
- **PGS:** `.sup` da [C0bra5/PGS-Subtitle-Parser](https://github.com/C0bra5/PGS-Subtitle-Parser/tree/master/sample).
- **Fixture:** 8 MKV "remux-like" da 30 s in `media-samples/library/`.
  - Il video è **sempre copiato**; audio e sottotitoli sono sintetizzati per imitare layout reali di Blu-ray: più lingue, lossless, commento, PGS forced/SDH, SRT, ASS, capitoli, sidecar `.it.forced.srt`.
  - Casi coperti: film UHD, film 1080p, DV P8.1, DV P5, episodio, file multi-episodio, extra, file dal nome ambiguo.
- **Ricostruzione:** `bash spikes/s1-media-probe/fetch.sh && bash spikes/s1-media-probe/build_fixtures.sh && python spikes/s1-media-probe/probe.py`.

## Risultati

### Cosa si ricava in modo affidabile

| Campo del modello | Fonte ffprobe | Esito |
|---|---|---|
| Container, durata, bitrate complessivo, dimensione | `format` | ✅ |
| Capitoli (titolo, inizio, fine) | `chapters` | ✅ |
| Tracce N per tipo, indice, codec, profilo codec | `streams` | ✅ |
| Lingua | tag `language` (ISO 639-2: `ita`, `eng`, `deu`) | ✅ Può mancare o valere `und`: va gestito |
| Titolo della traccia | tag `title` | ✅ |
| default / forced / commento / SDH | `disposition` (`default`, `forced`, `comment`, `hearing_impaired`) | ✅ Tutti preservati nel remux |
| Video: risoluzione, pix_fmt (bit depth), frame rate, primaries, transfer | `streams` | ✅ |
| Audio: canali, layout, sample rate | `streams` | ✅ |
| Sottotitoli testo vs immagine | `codec_name` (`subrip`, `ass` vs `hdmv_pgs_subtitle`) | ✅ |
| **Dolby Vision**: profilo, livello, BL compat id, presenza di EL/RPU | side data di stream `DOVI configuration record` | ✅ |
| Metadata HDR statici (mastering display, MaxCLL/MaxFALL) | side data **di frame** (serve leggere il primo frame) | ✅ quando presenti |
| Sidecar | filesystem (`<stem>.<lang>[.forced].srt`) | ✅ Convenzione di nome da parsare |

Costo: un probe di container e tracce su un file 4K da 373 MB richiede **circa 70 ms**. La lettura dei side data del primo frame aggiunge poco. L'analisi non è un collo di bottiglia per l'ingest.

### Scoperte

1. **"HDR10" senza metadata statici.** Il sample HDR10 di Jellyfin è PQ + BT.2020 **senza** SEI di mastering display né MaxCLL. Succede anche nel mondo reale.
   - La classificazione HDR deve basarsi su **transfer + primaries** (PQ → HDR10, HLG → HLG).
   - I metadata statici sono **attributi opzionali**, non una condizione per essere HDR.
2. **DV profilo 5 non ha fallback** (BL compat id 0, niente primaries/transfer dichiarati). Un client senza DV mostra colori sbagliati.
   - Il modello deve distinguere i DV **con base layer compatibile** (P8.1 → HDR10, P8.4 → HLG, P7 → HDR10) da quelli **senza** (P5).
   - Per P5 su un client non-DV serve una conversione vera: Transcode con mappatura dei colori.
3. **H3 confermata:** il remux con video copiato in MKV preserva config record DOVI, RPU e SEI HDR (verificato su P8.1 e P5, sulla sorgente HDR10 e dopo il remux).
4. **Insidia nel remux:** una sorgente MP4 DV P5 ha il codec tag `dvh1`, che il muxer Matroska di ffmpeg 7.0 rifiuta ("Tag dvh1 incompatible"). Con `-tag:v hvc1` si risolve e il DOVI resta intatto.
   - La pipeline di Direct Stream dovrà **gestire esplicitamente i codec tag** per container, anche verso fMP4: `hvc1`/`hev1`/`dvh1`/`dvhe` incidono sulla compatibilità dei player.
5. **Lossless:** dipende dal codec (TrueHD, FLAC, PCM) **e** dal profilo per DTS (`DTS` core = lossy, `DTS-HD MA` = lossless). Il campo `profile` è necessario, non basta `codec_name`.
6. **Lingue mancanti:** tracce senza tag o con `und` sono comuni nei rip (fixture `BDMV_DISC1_t00`). Preselezione delle tracce e UI devono prevederle.

### Lacune (sample non ottenibili in automatico)

| Caso | Perché conta | Come coprirlo |
|---|---|---|
| **DV profilo 7 (FEL/MEL)** | Formato tipico degli UHD Blu-ray | Sample su Mega ([Kodi wiki](https://kodi.wiki/view/Samples)), da scaricare a mano, oppure il primo remux UHD reale |
| **TrueHD Atmos**, **DTS-HD MA**, **DTS:X** | Rilevare gli oggetti Atmos e il lossless DTS dal `profile` | ffmpeg non li codifica; servono sample reali (link Mega/Drive sulla stessa pagina) |
| **HDR10+** | Metadata dinamici solo nei SEI di frame (SMPTE 2094-40) | Sample Kodi/Mega |
| File lunghi (2 h, 40–80 GB) | Costo del fingerprint, indici di seek | Primi remux reali; per il seek, spike S3 |

Nessuna lacuna cambia la **struttura** del modello. Riguardano valori da riconoscere (stringhe di profilo) e vanno verificate con file reali.

## Conclusioni e raccomandazioni

- ✅ Il Domain Model §4.3 è **confermato** nella struttura. Tre precisazioni:
  - HDR classificato da transfer + primaries; metadata statici e dinamici come attributi opzionali;
  - per il DV: profilo, livello, **BL compat id**, **presenza di EL** (FEL/MEL per P7);
  - "lossless" derivato da codec + profilo.
- ✅ ffprobe (ffmpeg ≥ 7) è sufficiente come fonte di fatti tecnici per il Media Analyzer. Confronto con alternative (mediainfo) solo se le lacune su Atmos/DTS:X non si chiudono.
- ⚠️ Il Direct Stream deve gestire i codec tag per container (scoperta 4): va inserito nei casi di test di S2/S3.
- 📥 **Azione per il proprietario:** quando possibile, procurare un sample DV P7 e uno TrueHD Atmos / DTS-HD MA (link sulla pagina Kodi Samples) da mettere in `media-samples/sources/`.
