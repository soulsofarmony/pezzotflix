"""Keyless Wikidata SPARQL probe: it-IT coverage of the labelled items (throwaway).

For every item in truth_wikidata.json:
  movies/series: Italian label, itwiki article, Italian description, image (P18), TMDB id, IMDb id, genre
  series: number of season items and episode items linked (P179 'part of the series'),
          and how many episodes have an Italian label.
Usage: python wd_sparql.py -> out/wd_sparql.json + summary (HTTP cached in out/cache/)
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import match_eval as me

HERE = Path(__file__).parent
EP = "https://query.wikidata.org/sparql"

Q_ITEMS = """
SELECT ?item ?it ?en ?itwiki ?descIt ?img ?tmdbM ?tmdbT ?imdb ?doc WHERE {
  VALUES ?item { %s }
  OPTIONAL { ?item rdfs:label ?it FILTER(LANG(?it) = "it") }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?itwiki schema:about ?item ; schema:isPartOf <https://it.wikipedia.org/> }
  OPTIONAL { ?item schema:description ?descIt FILTER(LANG(?descIt) = "it") }
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?item wdt:P4947 ?tmdbM }
  OPTIONAL { ?item wdt:P4983 ?tmdbT }
  OPTIONAL { ?item wdt:P345 ?imdb }
  BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:Q93204 } || EXISTS { ?item wdt:P136 wd:Q93204 } AS ?doc)
}"""

Q_EPISODES = """
SELECT ?series (COUNT(DISTINCT ?season) AS ?seasons) (COUNT(DISTINCT ?ep) AS ?eps) (COUNT(DISTINCT ?epIt) AS ?epsIt) WHERE {
  VALUES ?series { %s }
  OPTIONAL { ?season wdt:P31 wd:Q3464665 ; wdt:P179 ?series }
  OPTIONAL { ?ep wdt:P31 wd:Q21191270 ; wdt:P179 ?series .
             OPTIONAL { ?ep rdfs:label ?l FILTER(LANG(?l) = "it") BIND(?ep AS ?epIt) } }
} GROUP BY ?series"""


def sparql(q):
    """Through match_eval.http_get_json: responses cached in out/cache/ (re-runs on this machine are offline;
    a cached call reports ~0 s)."""
    t0 = time.perf_counter()
    data = me.http_get_json(EP, {"query": q, "format": "json"})
    return data["results"]["bindings"], time.perf_counter() - t0


def main():
    cands = me.load_candidates()  # tracked snapshot in fixtures/ (or out/ with --live)
    truth = json.loads((HERE / "truth_wikidata.json").read_text(encoding="utf-8"))["truth"]
    kinds = {}
    for q in cands:
        t = truth.get(q["key"])
        if t and t.startswith("Q"):
            kinds[t] = q["kind"]
    vals = " ".join(f"wd:{x}" for x in kinds)
    items, dt1 = sparql(Q_ITEMS % vals)
    agg = {}
    for b in items:
        qid = b["item"]["value"].rsplit("/", 1)[-1]
        a = agg.setdefault(qid, {"qid": qid, "kind": kinds[qid]})
        for k in ("it", "en", "itwiki", "descIt", "img", "tmdbM", "tmdbT", "imdb"):
            if k in b:
                a[k] = b[k]["value"]
        a["doc"] = b.get("doc", {}).get("value") == "true"
    series = [q for q, k in kinds.items() if k == "tv"]
    eps, dt2 = sparql(Q_EPISODES % " ".join(f"wd:{x}" for x in series))
    for b in eps:
        qid = b["series"]["value"].rsplit("/", 1)[-1]
        agg[qid].update(seasons=int(b["seasons"]["value"]), eps=int(b["eps"]["value"]), eps_it=int(b["epsIt"]["value"]))
    rows = list(agg.values())
    (me.OUT / "wd_sparql.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    n = len(rows)
    print(f"items={n} (movies={sum(r['kind']=='movie' for r in rows)}, series={len(series)}) query_s={dt1:.2f}+{dt2:.2f}")
    loc = sum(1 for r in rows if r.get("it") and r.get("en") and r["it"] != r["en"])
    for label, k in (("label it", "it"), ("itwiki", "itwiki"), ("descr it", "descIt"), ("P18 image", "img"), ("IMDb id", "imdb")):
        print(f"{label}: {sum(1 for r in rows if r.get(k))}/{n}")
    print(f"label it != en: {loc}/{n}")
    print(f"tmdb id: {sum(1 for r in rows if r.get('tmdbM') or r.get('tmdbT'))}/{n}")
    print(f"documentary flag: {sum(r['doc'] for r in rows)}/{n}")
    for r in rows:
        if r["kind"] == "tv":
            print(f"  {r.get('it') or r.get('en')}: seasons={r.get('seasons')} eps={r.get('eps')} eps_it={r.get('eps_it')}")
    for r in rows:
        print(f"  {r['qid']} it={r.get('it')!r} en={r.get('en')!r} desc={r.get('descIt')!r} doc={r['doc']}")


if __name__ == "__main__":
    main()
