"""S4 (throwaway helper): freeze the parity fixtures of the product Identifier (F1a.2).

Writes two JSON fixtures under services/video/test/fixtures/ (text only: file names, CC0 Wikidata
candidates, scores; no media, no TMDB responses):

  identifier-corpus.json  corpus.json + holdout.json entries (id, root, path, expected parse)
  identifier-parity.json  rapidfuzz ratio / token_sort_ratio on string pairs, the product title
                          normalisation, and the v2 decision on the frozen Wikidata snapshot

The normalisation here is the product one (ADR 0007 point 4, S4 Scoperta 13), not match_eval.tnorm:
letters of every script survive. It mirrors services/video/src/modules/identifier/normalize.ts:
  NFKD -> drop marks (category M*) -> casefold -> '&' to ' and ' -> every char that is not a
  letter (L*) or number (N*) becomes a space -> collapse spaces -> drop one leading article.

Run (venv from requirements.txt):
  spikes/s4-identification/.venv/Scripts/python.exe -X utf8 spikes/s4-identification/dump_parity.py
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

from rapidfuzz import fuzz

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent.parent / "services" / "video" / "test" / "fixtures"

ARTICLES = re.compile(r"^(il|lo|la|i|gli|le|l|un|uno|una|the|a|an|der|die|das|le|les)\s+")
W_TITLE, W_YEAR, W_KIND = 0.55, 0.35, 0.10
T, M = 0.80, 0.10


def tnorm(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.category(c).startswith("M"))
    s = s.casefold().replace("&", " and ")
    s = "".join(c if unicodedata.category(c)[0] in "LN" else " " for c in s)
    s = " ".join(s.split())
    return ARTICLES.sub("", s)


def nums(t: str | None) -> list[str]:
    return sorted(set(re.findall(r"\d+", tnorm(t))))


def titles_of(c: dict) -> list[str]:
    return [t for t in [c.get("title_it"), c.get("title_en"), *c.get("original", []), *c.get("aliases", [])] if t]


def title_sim(q: str, c: dict) -> float:
    qt, qn = tnorm(q), set(nums(q))
    best = 0.0
    for t in titles_of(c):
        ct = tnorm(t)
        s = max(fuzz.ratio(qt, ct), fuzz.token_sort_ratio(qt, ct)) / 100
        if set(nums(t)) != qn:
            s *= 0.7
        best = max(best, s)
    return best


def year_score(qy, cys) -> float:
    if qy is None:
        return 0.5
    if not cys:
        return 0.3
    d = min(abs(qy - y) for y in cys)
    return {0: 1.0, 1: 0.8, 2: 0.3}.get(d, 0.0)


def score(q: dict, c: dict) -> float:
    s_k = 1.0 if c["kind"] == q["kind"] else 0.0
    return round(W_TITLE * title_sim(q["title"], c) + W_YEAR * year_score(q["year"], c["years"]) + W_KIND * s_k, 4)


def decide(q: dict, cands: list[dict]):
    """The S4 v2 rule (match_eval.decide with KIND_FILTER), with the product normalisation."""
    if not q["title"]:
        return "review", None, "no_title"
    if not cands:
        return "review", None, "no_candidates"
    same = [c for c in cands if c["kind"] == q["kind"]]
    pool = same or cands
    scored = sorted(((score(q, c), c["ref"]) for c in pool), reverse=True)
    best, ref = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0.0
    if best < T:
        return "review", ref, "low_score"
    if best - second < M:
        return "review", ref, "ambiguous"
    return "auto", ref, "ok"


EXTRA_PAIRS = [
    ("1917", "Неизвестный 1917-й"),
    ("Москва 1980", "1980"),
    ("Dune", "Dűne"),
    ("", ""),
    ("a", ""),
    ("", "Inception"),
    ("Léon", "Leon"),
    ("Ocean's Eleven", "Ocean’s Eleven"),
    ("Ο Ταχυδρόμος", "ο ταχυδρομος"),
    ("ΟΔΥΣΣΕΑΣ", "οδυσσεας"),
    ("千と千尋の神隠し", "千と千尋"),
    ("𝔄𝔩𝔦𝔢𝔫 𝟑", "Alien 3"),
    ("Straße", "strasse"),
    ("Il Signore degli Anelli - La Compagnia dell'Anello", "La Compagnia dell'Anello"),
    ("Fast & Furious", "Fast and Furious"),
    ("L'odio", "La haine"),
    ("C'era una volta il West", "C’era una volta il West"),
    ("Amélie", "Amélie"),
    ("Kış Uykusu", "Kis Uykusu"),
    ("Café   Society", "cafe society"),
    ("Le Mans '66", "Le Mans 66"),
    ("Star Wars: Episodio IV", "Guerre stellari"),
    ("1/2", "½"),
    ("Ⅳ", "IV"),
    ("Mission - Impossible", "Mission: Impossible"),
    ("Le Mans 66 - La grande sfida", "Ford v Ferrari"),
]


PAIR_COLUMNS = ["a", "b", "aNorm", "bNorm", "aNums", "bNums", "rawRatio", "rawTokenSortRatio", "ratio", "tokenSortRatio"]


def pair_row(a: str, b: str) -> list:
    na, nb = tnorm(a), tnorm(b)
    return [a, b, na, nb, nums(a), nums(b), fuzz.ratio(a, b), fuzz.token_sort_ratio(a, b),
            fuzz.ratio(na, nb), fuzz.token_sort_ratio(na, nb)]


def dump_lines(obj: dict, list_keys: tuple[str, ...]) -> str:
    """JSON with one element per line for the long lists: small diffs, no indentation bloat."""
    head = {k: v for k, v in obj.items() if k not in list_keys}
    parts = [json.dumps(head, ensure_ascii=False)[:-1]]
    for k in list_keys:
        rows = ",\n".join(json.dumps(r, ensure_ascii=False) for r in obj[k])
        parts.append(f',\n"{k}": [\n{rows}\n]')
    return "".join(parts) + "\n}\n"


def main() -> None:
    snap = json.loads((HERE / "fixtures" / "candidates_wikidata.json").read_text(encoding="utf-8"))["queries"]
    pairs, seen = [], set()
    for a, b in EXTRA_PAIRS:
        seen.add((a, b))
        pairs.append(pair_row(a, b))
    queries = []
    for q in snap:
        cands = q["candidates"]
        for c in cands:
            for t in titles_of(c):
                if q["title"] and (q["title"], t) not in seen:
                    seen.add((q["title"], t))
                    pairs.append(pair_row(q["title"], t))
        d, ref, why = decide(q, cands)
        queries.append({
            "key": q["key"], "title": q["title"], "year": q["year"], "kind": q["kind"],
            "candidates": [{k: c.get(k) for k in ("ref", "kind", "title_it", "title_en", "original", "aliases", "years", "tmdb")}
                           for c in cands],
            "scores": {c["ref"]: score(q, c) for c in cands} if q["title"] else {},
            "decision": {"outcome": d, "ref": ref, "reason": why},
        })
    parity = {
        "_doc": "Frozen by spikes/s4-identification/dump_parity.py: rapidfuzz 3.14.6 scores on string pairs "
                "(S4 corpus queries x CC0 Wikidata candidate titles, plus edge cases), the product title "
                "normalisation, and the v2 decision (T 0.80, M 0.10) on the S4 Wikidata snapshot. Regenerate, "
                "never edit by hand.",
        "pairColumns": PAIR_COLUMNS,
        "pairs": pairs,
        "queries": queries,
    }
    entries = []
    for name in ("corpus.json", "holdout.json"):
        for e in json.loads((HERE / name).read_text(encoding="utf-8"))["entries"]:
            entries.append({"set": name.split(".")[0], "id": e["id"], "cat": e["cat"], "root": e["root"],
                            "path": e["path"], "exp": e["exp"]})
    corpus = {
        "_doc": "S4 corpus and holdout (relative paths and expected parses only, no media), copied by "
                "spikes/s4-identification/dump_parity.py. Lists are accepted alternatives.",
        "entries": entries,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "identifier-parity.json").write_text(dump_lines(parity, ("pairs", "queries")), encoding="utf-8")
    (OUT_DIR / "identifier-corpus.json").write_text(dump_lines(corpus, ("entries",)), encoding="utf-8")
    auto = sum(1 for q in queries if q["decision"]["outcome"] == "auto")
    print(f"pairs={len(pairs)} queries={len(queries)} auto={auto} corpus entries={len(entries)} -> {OUT_DIR}")


if __name__ == "__main__":
    main()
