"""S5 (throwaway): writes out/www/samples.json, the list the TV app shows under "Sample diretti".

Paths are relative to the nginx root: /media/... is media-samples/library (read-only), /gen/... is out/www/gen.
"""
import json
import pathlib
import sys

www = pathlib.Path(sys.argv[1])
LIB = [
    ("2001 (file del proprietario): x265 4K HDR10 19,6 Mb/s + AC-3 ita / AAC 5.1 eng + PGS ita", "media/movies/2001 - Odissea nello spazio (1968)/2001 - Odissea nello spazio (1968) - 2160p.mkv"),
    ("4K HEVC HDR10 60p ~100 Mb/s + TrueHD/E-AC-3/AC-3 + PGS", "media/movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv"),
    ("4K Dolby Vision P8.1 + TrueHD/E-AC-3", "media/movies/Dune (2021)/Dune.2021.2160p.UHD.BluRay.REMUX.DV.HDR.mkv"),
    ("4K Dolby Vision P5 + FLAC 5.1", "media/movies/Oppenheimer (2023)/Oppenheimer (2023).mkv"),
    ("1080p AVC + DTS 5.1 core / AC-3 + PGS", "media/movies/Il Buono, il Brutto, il Cattivo (1966)/Il.Buono.il.Brutto.il.Cattivo.1966.1080p.BluRay.REMUX.mkv"),
    ("4K HDR10 lungo 5 min, GOP 2 s, TrueHD + E-AC-3", "media/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"),
    ("1080p AVC + AC-3/E-AC-3 + PGS (episodio)", "media/series/Dark (2017)/Season 01/Dark - S01E01 - Segreti.mkv"),
]
GEN = [
    ("Ascolto 2001: 1 AAC 5.1 (TV) / 2 E-AC-3 5.1 (server) / 3 AC-3 ita", "gen/ascolto-2001-aac-vs-eac3.mkv"),
    ("Prova canali 5.1: 8 codec (SU cambia codec)", "gen/canali-5.1-otto-codec.mkv"),
    ("Prova canali 7.1: FLAC/PCM (TrueHD solo 5.1)", "gen/canali-7.1-tre-codec.mkv"),
    ("Confronto ascolto: TrueHD / E-AC-3 5.1 / FLAC / DTS-HD MA", "gen/confronto-truehd-eac3-flac.mkv"),
    ("FLAC 5.1/7.1 blocchi 4608 vs 1152 (MKV)", "gen/flac-blocchi.mkv"),
    ("FLAC 5.1/7.1 blocchi 4608 vs 1152 (MP4 frammentato)", "gen/flac-blocchi.mp4"),
    ("TrueHD Atmos 7.1 reale (FATE)", "gen/reale-truehd-atmos-7.1.mkv"),
    ("DTS-HD MA 7.1 reale (FATE)", "gen/reale-dts-hd-ma-7.1.mkv"),
    ("E-AC-3 JOC Atmos 7.1 reale (FATE)", "gen/reale-eac3-joc-atmos-7.1.mkv"),
]
out = [{"title": t, "path": p} for t, p in LIB]
out += [{"title": t, "path": p} for t, p in GEN if (www / p).exists()]
(www / "samples.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"samples.json: {len(out)} entries")
