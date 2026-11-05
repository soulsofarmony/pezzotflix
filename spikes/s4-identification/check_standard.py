"""S4 (throwaway): check the examples of docs/library-standard.md against the spike parser (rules.py).

OK  = parser behaves as the standard requires.
GAP = known spike-parser limitation, listed in docs/library-standard.md section 8 (expected).
FAIL = unexpected behaviour (neither OK nor the documented GAP).

Run: spikes/s4-identification/.venv/Scripts/python.exe spikes/s4-identification/check_standard.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rules  # noqa: E402

# (label, path relative to root, root hint, expected subset, None or (gap_note, keys the gap may break))
# For GAP cases, 'expected' is what the STANDARD requires; the check passes as GAP when the parser differs.
CASES = [
    ("film 4K", "Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p.mkv", "movies",
     {"kind": "movie", "title": "Blade Runner 2049", "year": 2017, "reasons": []}, None),
    ("film 1080p (versione)", "Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 1080p.mkv", "movies",
     {"kind": "movie", "title": "Blade Runner 2049", "year": 2017, "reasons": []}, None),
    ("film con virgole", "Il Buono, il Brutto, il Cattivo (1966)/Il Buono, il Brutto, il Cattivo (1966).mkv", "movies",
     {"kind": "movie", "title": "Il Buono, il Brutto, il Cattivo", "year": 1966, "reasons": []}, None),
    ("titolo con ' - '", "Mission - Impossible (1996)/Mission - Impossible (1996).mkv", "movies",
     {"kind": "movie", "title": "Mission - Impossible", "year": 1996, "reasons": []}, None),
    ("edizione nel vocabolario", "Blade Runner (1982) {edition-Final Cut}/Blade Runner (1982) {edition-Final Cut} - 2160p.mkv", "movies",
     {"kind": "movie", "title": "Blade Runner", "year": 1982, "edition": "Final Cut"}, None),
    ("edizione testo libero", "Zack Snyder's Justice League (2021) {edition-Ultimate Cut}/Zack Snyder's Justice League (2021) {edition-Ultimate Cut}.mkv", "movies",
     {"kind": "movie", "year": 2021, "edition": "Ultimate Cut"}, ("edition free text", {"edition"})),
    ("ID con anno", "Il Professore (2019) {tmdb-NNNNN}/Il Professore (2019) {tmdb-NNNNN} - 1080p.mkv", "movies",
     {"kind": "movie", "title": "Il Professore", "year": 2019}, None),
    ("ID senza anno", "Il Professore {tmdb-NNNNN}/Il Professore {tmdb-NNNNN}.mkv", "movies",
     {"kind": "movie", "title": "Il Professore"}, ("id tag not parsed", {"title"})),
    ("extra Trailers/", "Blade Runner 2049 (2017)/Trailers/Trailer ufficiale.mkv", "movies",
     {"kind": "extra", "extra_type": "trailer", "extra_of": "Blade Runner 2049"}, None),
    ("extra Behind The Scenes/", "Il Buono, il Brutto, il Cattivo (1966)/Behind The Scenes/Il making of.mkv", "movies",
     {"kind": "extra", "extra_type": "behind-the-scenes"}, None),
    ("extra IT dietro le quinte/", "Blade Runner 2049 (2017)/dietro le quinte/Il making of.mkv", "movies",
     {"kind": "extra", "extra_type": "behind-the-scenes"}, None),
    ("extra suffisso Plex", "Blade Runner 2049 (2017)/Blade Runner 2049 (2017)-trailer.mkv", "movies",
     {"kind": "extra", "extra_type": "trailer", "extra_of": "Blade Runner 2049"}, None),
    ("extra Other/", "Blade Runner 2049 (2017)/Other/Galleria.mkv", "movies",
     {"kind": "extra", "extra_type": "other"}, None),
    ("extra di stagione", "Dark (2017)/Season 01/Extras/Recap.mkv", "series",
     {"kind": "extra", "extra_of": "Dark", "season": 1}, ("season extras", {"season"})),
    ("sidecar it.forced", "Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p.it.forced.srt", "movies",
     {"kind": "sidecar", "lang": "it", "forced": True}, None),
    ("sidecar en.sdh", "Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p.en.sdh.srt", "movies",
     {"kind": "sidecar", "lang": "en", "sdh": True}, None),
    ("sidecar .sup", "Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p.it.forced.sup", "movies",
     {"kind": "sidecar", "lang": "it", "forced": True}, None),
    ("episodio Season NN", "The Office (2005) {tmdb-2316}/Season 01/The Office (2005) {tmdb-2316} - S01E01 - Pilot.mkv", "series",
     {"kind": "episode", "title": "The Office", "year": 2005, "season": 1, "episodes": [1], "reasons": []}, None),
    ("multi-episodio", "The Office (2005) {tmdb-2316}/Season 01/The Office (2005) {tmdb-2316} - S01E02-E03.mkv", "series",
     {"kind": "episode", "season": 1, "episodes": [2, 3], "reasons": []}, None),
    ("speciale Season 00", "The Office (2005) {tmdb-2316}/Season 00/The Office (2005) {tmdb-2316} - S00E01 - Webisode.mkv", "series",
     {"kind": "episode", "season": 0, "episodes": [1], "reasons": []}, None),
    ("episodio Stagione NN (lettura)", "Dark (2017)/Stagione 01/Dark (2017) - S01E01.mkv", "series",
     {"kind": "episode", "title": "Dark", "season": 1, "episodes": [1], "reasons": []}, None),
    ("documentario", "Free Solo (2018)/Free Solo (2018) - 2160p.mkv", "movies",
     {"kind": "movie", "title": "Free Solo", "year": 2018, "reasons": []}, None),
    # non-conformant
    ("NC multi-parte", "Film (2001)/Film (2001) - Disco 1.mkv", "movies",
     {"kind": "movie", "part": 1, "reasons": ["multi_part"]}, ("multi_part not emitted", {"reasons"})),
    ("NC senza anno", "Inception/Inception.mkv", "movies",
     {"kind": "movie", "title": "Inception", "reasons": ["no_year"]}, None),
    ("NC extra orfano", "Extras/Trailer.mkv", "movies",
     {"kind": "extra", "reasons": ["orphan_extra"]}, None),
    ("NC stagione incoerente", "Serie X (2010)/Season 02/Serie X (2010) - S01E05.mkv", "series",
     {"kind": "episode", "reasons": ["season_dir_mismatch"]}, None),
    ("NC sidecar senza lingua", "Film (2001)/Film (2001).srt", "movies",
     {"kind": "sidecar", "reasons": ["sidecar_no_lang"]}, None),
    ("NC nome grezzo", "title_t00.mkv", "movies",
     {"kind": "movie", "reasons": ["no_title"]}, None),
    ("NC BDMV", "Film (2001)/BDMV/STREAM/00001.m2ts", "movies",
     {"reasons": ["disc_structure"]}, ("disc structure classified as movie", {"reasons"})),
    ("NC iso", "Film (2001)/Film (2001).iso", "movies",
     {"reasons": ["disc_structure"]}, ("iso ignored as not_video", {"reasons"})),
    ("sample cartella", "Film (2001)/Sample/Film (2001)-sample.mkv", "movies",
     {"kind": "ignore"}, None),
    ("'Sample' nel titolo", "Dark (2017)/Season 01/Dark (2017) - S01E01 - Sample Rate.mkv", "series",
     {"kind": "episode", "season": 1, "episodes": [1]}, ("sample matched as substring", {"kind", "season", "episodes"})),
    ("NC VIDEO_TS", "Film (2001)/VIDEO_TS/VTS_01_1.VOB", "movies",
     {"reasons": ["disc_structure"]}, ("VIDEO_TS ignored as not_video", {"reasons"})),
    ("cartella samples/", "Blade Runner 2049 (2017)/samples/clip.mkv", "movies",
     {"kind": "ignore"}, ("samples/ not ignored", {"kind"})),
    ("sidecar hi senza lingua = hindi", "Film (2001)/Film (2001).hi.srt", "movies",
     {"kind": "sidecar", "lang": "hi"}, ("bare hi read as SDH", {"lang"})),
]


def matches(res: dict, exp: dict) -> dict[str, str]:
    bad = {}
    for k, v in exp.items():
        got = res.get(k)
        if k == "reasons":
            if sorted(got or []) != sorted(v):
                bad[k] = f"reasons={got}"
        elif got != v:
            bad[k] = f"{k}={got!r}"
    return bad


def main() -> int:
    counts = {"OK": 0, "GAP": 0, "FAIL": 0}
    for label, path, root, exp, gap in CASES:
        bad = matches(rules.parse(path, root), exp)
        note_gap, gap_keys = gap if gap else (None, set())
        if not bad:
            # a documented gap that now passes must be removed from the doc
            status, note = ("FAIL", "gap documented but parser now conforms") if gap else ("OK", "")
        elif gap and set(bad) <= gap_keys:
            status, note = "GAP", f"{note_gap}: " + ", ".join(bad.values())
        else:
            unexpected = {k: v for k, v in bad.items() if k not in gap_keys}
            status, note = "FAIL", "unexpected: " + ", ".join(unexpected.values())
        counts[status] += 1
        print(f"{status:4} {label:32} {note}")
    print(f"\nOK={counts['OK']} GAP={counts['GAP']} FAIL={counts['FAIL']} / {len(CASES)}")
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
