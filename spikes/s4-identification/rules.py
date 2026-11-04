"""Hand-written, convention-based path parser (throwaway spike code).

Input: path relative to a LibraryRoot + the root hint (movies | series | mixed).
Output: dict with kind, title, year, season, episodes, edition, part,
extra_type, extra_of, lang, forced, sdh, plus 'reasons' for the review queue.

Strategy: structure first (ignored dirs, sidecar, extras dir, season dir,
title folder), then a small tokenizer for the names.
"""
from __future__ import annotations

import re
import unicodedata

VIDEO_EXT = {"mkv", "mp4", "m4v", "m2ts", "ts", "avi", "mov", "webm"}
SUB_EXT = {"srt", "ass", "ssa", "sup", "vtt", "sub", "idx"}

IGNORED_DIR = re.compile(r"^(@eaDir|\$RECYCLE\.BIN|#recycle|\.recycle|\.Trash.*|lost\+found|System Volume Information|\..*)$", re.I)
SAMPLE = re.compile(r"(^|[\s._\-\[(])sample([\s._\-\])]|$)", re.I)

# extras folder name -> extra type (Plex/Jellyfin conventions + Italian)
EXTRA_DIRS = {
    "extras": None, "extra": None, "bonus": None, "contenuti speciali": None, "speciali extra": None,
    "featurettes": "featurette", "featurette": "featurette",
    "behind the scenes": "behind-the-scenes", "dietro le quinte": "behind-the-scenes", "making of": "behind-the-scenes",
    "deleted scenes": "deleted-scene", "scene eliminate": "deleted-scene", "scene tagliate": "deleted-scene",
    "interviews": "interview", "interviste": "interview",
    "trailers": "trailer", "trailer": "trailer",
    "shorts": "other", "other": "other", "others": "other", "scenes": "other", "clips": "other",
}
# Plex-style suffix: "<movie>-trailer.mkv"
EXTRA_SUFFIX = re.compile(r"-(trailer|featurette|behindthescenes|deleted|interview|scene|short|other)$", re.I)
SUFFIX_TYPE = {"trailer": "trailer", "featurette": "featurette", "behindthescenes": "behind-the-scenes",
               "deleted": "deleted-scene", "interview": "interview", "scene": "other", "short": "other", "other": "other"}
# keywords inside an extra's own name, used when the folder is generic ("Extras")
EXTRA_KEYWORDS = [
    (re.compile(r"\btrailer\b|\bteaser\b", re.I), "trailer"),
    (re.compile(r"scene (eliminate|tagliate)|deleted", re.I), "deleted-scene"),
    (re.compile(r"\bintervist|\binterview", re.I), "interview"),
    (re.compile(r"behind the scenes|dietro le quinte|making of", re.I), "behind-the-scenes"),
    (re.compile(r"featurette", re.I), "featurette"),
]

SEASON_DIR = re.compile(r"^(?:season|stagione|serie|series|s|parte|part)\s*0*(\d{1,3})$", re.I)
SPECIALS_DIR = re.compile(r"^(specials?|speciali)$", re.I)
GENERIC_DIR = re.compile(r"^(misc|varie|film|films|movies|film nuovi|nuovi|da vedere|downloads?|documentari|documentaries|serie tv|series|tv)$", re.I)

# episode patterns (applied to the cleaned stem)
SXXEYY = re.compile(r"\bS(\d{1,2})[ ._-]?E(\d{1,3})((?:[ ._-]*-?[ ._-]*E\d{1,3})*)\b", re.I)
NXMM = re.compile(r"\b(\d{1,2})x(\d{2,3})((?:\s*-\s*(?:\d{1,2}x)?\d{2,3})*)\b", re.I)
IT_SE = re.compile(r"\bstagione\s*(\d{1,2})\b.*?\bepisodio\s*(\d{1,3})\b", re.I)
EP_ONLY = re.compile(r"\b(?:episodio|episode|ep|e)\s*\.?\s*(\d{1,3})\b", re.I)
BARE_NUM = re.compile(r"(?:^|\s-\s)(\d{1,3})$")

# MakeMKV / disc dump names: no identity
JUNK_STEM = re.compile(r"^(BDMV_DISC(\d+)_t\d+|title_t\d+|[A-Z]\d_t\d+|\d{4,6}|test|nuovo_file.*|new file.*|video\d*|untitled.*)$", re.I)

# edition tags: longest first; value = canonical label
EDITIONS = [
    (r"extended director'?s cut", "Extended Director's Cut"),
    (r"director'?s definitive cut", "Director's Definitive Cut"),
    (r"director'?s cut|directors cut|dc", "Director's Cut"),
    (r"extended (?:edition|cut)|extended", "Extended"),
    (r"theatrical(?: cut| edition)?", "Theatrical"),
    (r"(?:the )?final cut", "Final Cut"),
    (r"assembly cut", "Assembly Cut"),
    (r"special edition", "Special Edition"),
    (r"black (?:and|&) chrome(?: edition)?", "Black and Chrome"),
    (r"black (?:and|&) white", "Black & White"),
    (r"unrated|uncut", "Unrated"),
    (r"remastered", "Remastered"),
    (r"imax", "IMAX"),
    (r"criterion(?: collection)?", "Criterion"),
    (r"versione integrale", "Versione Integrale"),
    (r"versione estesa", "Versione estesa"),
    (r"edizione speciale", "Edizione speciale"),
    (r"versione cinematografica", "Theatrical"),
]
EDITION_RE = [(re.compile(r"(?<![\w'])" + p + r"(?![\w'])", re.I), v) for p, v in EDITIONS]

# technical tokens: the title ends at the first one
TECH = re.compile(
    r"(?<![\w])(2160p|1080p|1080i|720p|576p|480p|4k|uhd|bluray|blu-ray|bdremux|remux|bdrip|web-?dl|webrip|hdtv|"
    r"hdr10\+?|hdr|dv|dovi|dolby ?vision|hevc|x26[45]|h\.?26[45]|avc|truehd|atmos|dts(?:-hd)?|ma|dts-x|ac3|eac3|aac|flac|"
    r"ita|eng|multi|sub|subs|10bit|proper|repack)(?![\w])", re.I)
YEAR = re.compile(r"[(\[]((?:19|20)\d{2})[)\]]|(?<![\w])((?:19|20)\d{2})(?![\w])")
PART = re.compile(r"(?<![\w])(?:disc|disco|cd|pt|part|parte)\s*\.?\s*(\d{1,2})(?![\w])", re.I)

LANG = {
    "it": "it", "ita": "it", "italian": "it", "italiano": "it",
    "en": "en", "eng": "en", "english": "en", "inglese": "en",
    "de": "de", "ger": "de", "deu": "de", "german": "de", "tedesco": "de",
    "fr": "fr", "fre": "fr", "fra": "fr", "french": "fr", "francese": "fr",
    "es": "es", "spa": "es", "spanish": "es", "spagnolo": "es",
    "ja": "ja", "jpn": "ja", "japanese": "ja",
}
SUB_FORCED = {"forced", "forzati", "forzato"}
SUB_SDH = {"sdh", "hi", "cc", "hoh"}
SUB_OTHER_FLAGS = {"default", "full", "commentary"}


def _clean(s: str) -> str:
    """Release-name separators -> spaces. Dots between letters become spaces; keep 'Ben-Hur'."""
    if " " not in s or s.count(".") >= 3:
        s = re.sub(r"(?<=\w)[._](?=\w)", " ", s)
        s = re.sub(r"(?<=\w)\.(?=\W|$)", " ", s)
    s = s.replace("_", " ")
    return re.sub(r"\s+", " ", s).strip()


def _strip_title(t: str) -> str:
    t = re.sub(r"[\s\-–:,\[\](]+$", "", t)
    t = re.sub(r"^[\s\-–:,\[\]]+", "", t)
    return t.strip()


def parse_name(name: str) -> dict:
    """Parse a single file/folder name (no extension) into title/year/edition/part."""
    raw = _clean(name)
    out = {"title": None, "year": None, "edition": None, "part": None}
    if JUNK_STEM.match(raw.replace(" ", "_")) or JUNK_STEM.match(raw):
        m = re.match(r"BDMV_DISC(\d+)", raw.replace(" ", "_"), re.I)
        if m:
            out["part"] = int(m.group(1))
        out["junk"] = True
        return out
    cut = len(raw)
    # year: first candidate that is not at position 0 (so "1917 (2019)", "2012 2009" work)
    # prefer a bracketed year; otherwise the last bare year ("Blade Runner 2049 2017", "2012 2009")
    yms = [m for m in YEAR.finditer(raw) if not (m.start() == 0 and not raw.startswith(("(", "[")))]
    tech = TECH.search(raw)
    if tech:
        yms = [m for m in yms if m.start() < tech.start()] or yms
    br = [m for m in yms if m.group(1)]
    ym = br[0] if br else (yms[-1] if yms else None)
    if ym:
        out["year"] = int(ym.group(1) or ym.group(2))
        cut = min(cut, ym.start())
    for rx, label in EDITION_RE:
        m = rx.search(raw)
        if m and m.start() > 0:
            out["edition"] = label
            cut = min(cut, m.start())
            break
    m = PART.search(raw)
    if m and m.start() > 0:
        out["part"] = int(m.group(1))
        cut = min(cut, m.start())
    m = TECH.search(raw)
    if m and m.start() > 0:
        cut = min(cut, m.start())
    title = _strip_title(raw[:cut])
    # bare "Title (Year)" folder with an edition after the year: still fine
    out["title"] = title or None
    return out


def _season_from_dir(seg: str):
    if SPECIALS_DIR.match(seg):
        return 0
    m = SEASON_DIR.match(seg.strip())
    return int(m.group(1)) if m else None


def _episode_from_stem(stem: str):
    s = _clean(stem)
    m = SXXEYY.search(s)
    if m:
        eps = [int(m.group(2))] + [int(x) for x in re.findall(r"E(\d{1,3})", m.group(3), re.I)]
        return int(m.group(1)), eps, s[: m.start()]
    m = NXMM.search(s)
    if m:
        eps = [int(m.group(2))] + [int(x) for x in re.findall(r"(?:\d{1,2}x)?(\d{2,3})", m.group(3))]
        return int(m.group(1)), eps, s[: m.start()]
    m = IT_SE.search(s)
    if m:
        return int(m.group(1)), [int(m.group(2))], s[: m.start()]
    m = EP_ONLY.search(s)
    if m:
        return None, [int(m.group(1))], s[: m.start()]
    m = BARE_NUM.search(s)
    if m:
        return None, [int(m.group(1))], s[: m.start()]
    return None, None, s


def _parse_sidecar(stem: str):
    """'<video stem>.<lang>[.forced|.sdh]' -> (video_stem, lang, forced, sdh)."""
    parts = stem.split(".")
    lang, forced, sdh = None, False, False
    while len(parts) > 1:
        tok = parts[-1].lower()
        if tok in SUB_FORCED:
            forced = True
        elif tok in SUB_SDH:
            sdh = True
        elif tok in SUB_OTHER_FLAGS:
            pass
        elif tok in LANG and lang is None:
            lang = LANG[tok]
        else:
            break
        parts.pop()
    return ".".join(parts), lang, forced, sdh


def _norm_dir(seg: str) -> str:
    return re.sub(r"[\s._-]+", " ", seg).strip().lower()


def parse(path: str, root: str = "mixed") -> dict:
    segs = [s for s in path.replace("\\", "/").split("/") if s]
    fname = segs[-1]
    dirs = segs[:-1]
    stem, _, ext = fname.rpartition(".")
    ext = ext.lower()
    res = {"kind": None, "title": None, "year": None, "season": None, "episodes": None, "edition": None,
           "part": None, "extra_type": None, "extra_of": None, "lang": None, "forced": None, "sdh": None,
           "reasons": []}

    # 1. ignore: system/hidden dirs, samples, non-media
    if any(IGNORED_DIR.match(d) for d in dirs) or fname.startswith("$") or fname.startswith("."):
        res["kind"] = "ignore"; res["reasons"].append("system_dir"); return res
    if SAMPLE.search(stem) or any(d.lower() == "sample" for d in dirs):
        res["kind"] = "ignore"; res["reasons"].append("sample"); return res

    # 2. sidecar subtitles: language/flags; attached to the video with the same stem
    if ext in SUB_EXT:
        vstem, lang, forced, sdh = _parse_sidecar(stem)
        res.update(kind="sidecar", lang=lang, forced=forced, sdh=sdh, sidecar_of=vstem)
        if lang is None:
            res["reasons"].append("sidecar_no_lang")
        return res
    if ext not in VIDEO_EXT:
        res["kind"] = "ignore"; res["reasons"].append("not_video"); return res

    # drop generic container dirs at the top ("Documentari/", "misc/", "Film nuovi/")
    while dirs and GENERIC_DIR.match(_norm_dir(dirs[0])):
        dirs = dirs[1:]

    # 3. extras: a known extras dir anywhere in the path, or a Plex-style suffix
    for i, d in enumerate(dirs):
        nd = _norm_dir(d)
        if nd in EXTRA_DIRS:
            etype = EXTRA_DIRS[nd]
            if etype is None:
                etype = next((t for rx, t in EXTRA_KEYWORDS if rx.search(stem)), "other")
            owner = dirs[0] if i > 0 else None
            res.update(kind="extra", extra_type=etype, title=_clean(stem))
            if owner:
                p = parse_name(owner)
                res["extra_of"], res["year"] = p["title"], p["year"]
            else:
                res["reasons"].append("orphan_extra")
            return res
    m = EXTRA_SUFFIX.search(stem)
    if m:
        p = parse_name(stem[: m.start()])
        res.update(kind="extra", extra_type=SUFFIX_TYPE[m.group(1).lower()], extra_of=p["title"], year=p["year"])
        return res
    if stem.strip().lower() in {"trailer", "teaser"}:
        p = parse_name(dirs[0]) if dirs else {"title": None, "year": None}
        res.update(kind="extra", extra_type="trailer", extra_of=p["title"], year=p["year"])
        return res

    # 4. episodes: season dir, SxxEyy/1x02/Stagione-Episodio in the stem, or series root
    season_dir = None
    for d in dirs[1:]:
        s = _season_from_dir(_norm_dir(d))
        if s is not None:
            season_dir = s
    season, eps, before = _episode_from_stem(stem)
    strong_ep = season is not None  # SxxEyy, 1x02, Stagione N Episodio M
    is_episode = strong_ep or season_dir is not None or (root == "series" and eps is not None)
    if root == "movies" and not strong_ep:
        is_episode = False
    if is_episode and eps:
        series_dir = dirs[0] if dirs else None
        if series_dir:
            p = parse_name(series_dir)
        else:
            p = parse_name(before)
        if season is None:
            season = season_dir if season_dir is not None else 1
            if season_dir is None:
                res["reasons"].append("season_assumed_1")
        elif season_dir is not None and season_dir != season and season_dir != 0:
            res["reasons"].append("season_dir_mismatch")
        res.update(kind="episode", title=p["title"], year=p["year"], season=season, episodes=eps)
        return res

    # 5. movie: name from the file; fall back to (or complete from) the title folder
    res["kind"] = "movie"
    f = parse_name(stem)
    d = parse_name(dirs[0]) if dirs else {"title": None, "year": None, "edition": None, "part": None}
    if f.get("junk") or not f["title"]:
        title, year = d["title"], d["year"]
        if not title:
            res["reasons"].append("no_title")
    else:
        title, year = f["title"], f["year"] or d["year"]
    res.update(title=title, year=year, edition=f["edition"] or d.get("edition"), part=f["part"])
    if year is None and title:
        res["reasons"].append("no_year")
    return res


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        print(p, "->", parse(p))
