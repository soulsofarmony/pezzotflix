"""Builds truth_tmdb.json: the expected TMDB ref per matching query (throwaway).

The truth must NOT come from the TMDB search being evaluated. Sources, in this order:
  1. truth_wikidata.json (hand-labelled QIDs) joined with fixtures/candidates_wikidata.json (frozen Wikidata
     data, CC0): the TMDB id is the P4947 (movie) / P4983 (tv) value of the labelled QID. The kind must match
     the query kind, otherwise the script stops.
  2. null stays null: the 'Da verificare' labels of truth_wikidata.json (no title, non-existent work, parse
     error, title without year shared by several works). These labels were fixed before any TMDB call.
     Exception, 'Il Professore (2019)': the label stays null, but its first reason ('no work titled exactly
     Il professore (2019) on Wikidata') depended on the provider and TMDB disproved it (tmdb:movie:607926 is
     'Il professore', 2019). The reason was revised after the TMDB run: the name is the exact title of an
     obscure 2019 film and a shortened form of the well-known 'Il professore e il pazzo' (2019), so it is
     ambiguous by intent (NULL_REASON below).
  3. MANUAL: queries the Wikidata truth could not resolve, each with an independent source.
The resulting ids are then checked BY ID, never by search: tmdb_probe.py fetches /movie|tv/{id} and compares
year and titles with Wikidata ('wd_check' in out/tmdb_probe.json). A mismatch is corrected here, in MANUAL,
with its source.

Usage: python build_truth_tmdb.py -> truth_tmdb.json (TMDB ids only: identifiers, no TMDB content)
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent

MANUAL = {
    # Wikidata search for "2012" timed out in S4 (504), so truth_wikidata.json has a placeholder.
    "movie:2012:2009": ("tmdb:movie:14161",
                        "Wikidata SPARQL 2026-11-05, exact label '2012' + P31 film: Q184605 (2009, Roland Emmerich), "
                        "P4947=14161, P345=tt1190080"),
}

# null labels whose reason is not the generic one. Revised on 2026-11-05, after the TMDB run.
NULL_REASON = {
    "movie:Il Professore:2019": (
        "null as in truth_wikidata.json, reason revised after the TMDB run: ambiguous by intent, the exact Italian "
        "title of an obscure 2019 film (tmdb:movie:607926, Wikidata Q130471762) and a shortened form of the "
        "well-known 'Il professore e il pazzo' (2019)"),
}


def main():
    wd_truth = json.loads((HERE / "truth_wikidata.json").read_text(encoding="utf-8"))["truth"]
    queries = json.loads((HERE / "fixtures" / "candidates_wikidata.json").read_text(encoding="utf-8"))["queries"]
    truth, source = {}, {}
    for q in queries:
        key, t = q["key"], wd_truth[q["key"]]
        if key in MANUAL:
            truth[key], source[key] = MANUAL[key]
            continue
        if t is None:
            truth[key], source[key] = None, NULL_REASON.get(
                key, "null as in truth_wikidata.json (decided by the name, not the provider)")
            continue
        c = next((c for c in q["candidates"] if c["ref"] == t), None)
        if c is None or not (c.get("tmdb") or [None])[0]:
            raise SystemExit(f"{key}: QID {t} has no TMDB id in the Wikidata snapshot: add it to MANUAL")
        if c["kind"] != q["kind"]:
            raise SystemExit(f"{key}: kind {c['kind']} on Wikidata vs {q['kind']} in the query: check by hand")
        prop = "P4947" if c["kind"] == "movie" else "P4983"
        truth[key] = f"tmdb:{c['kind']}:{c['tmdb'][0]}"
        source[key] = f"wikidata {t} {prop} (fixtures/candidates_wikidata.json)"
    doc = ("Expected TMDB ref per query, built by build_truth_tmdb.py WITHOUT the TMDB search: TMDB ids come from "
           "the Wikidata truth (P4947/P4983 of the hand-labelled QID, frozen snapshot) or from MANUAL with an "
           "independent source; null = 'Da verificare', the same labels as truth_wikidata.json, fixed before any "
           "TMDB call ('Il Professore (2019)': label unchanged, reason revised after the TMDB run). Ids verified by ID lookup in tmdb_probe.py (year/title against Wikidata). "
           "Only identifiers: no TMDB content.")
    out = {"_doc": doc, "truth": truth, "source": source}
    (HERE / "truth_tmdb.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    n_real = sum(1 for v in truth.values() if v)
    print(f"queries={len(truth)} real={n_real} null={len(truth) - n_real} manual={len(MANUAL)} "
          f"distinct refs={len({v for v in truth.values() if v})}")


if __name__ == "__main__":
    main()
