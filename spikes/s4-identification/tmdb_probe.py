"""TMDB it-IT coverage probe (BLOCKED until a key is provided).

Reads TMDB_READ_TOKEN (v4 bearer) or TMDB_API_KEY (v3) from the environment or the
gitignored repo-root .env. Never commit a key.

For every item labelled in truth_wikidata.json that has a TMDB id on Wikidata (P4947/P4983):
  - /movie/{id} or /tv/{id}  ?language=it-IT&append_to_response=images,translations
                             &include_image_language=it,null
  - for tv: /tv/{id}/season/1?language=it-IT  (episode titles/overviews in Italian)
Measures: localized title present/different from original, Italian overview present,
Italian-language poster available, Italian episode names, request latency.

Then run the matching on TMDB candidates:  python match_eval.py dump --provider tmdb
(and label truth_tmdb.json the same way as truth_wikidata.json).

Usage: python tmdb_probe.py  -> out/tmdb_probe.json + summary table
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import match_eval as me

HERE = Path(__file__).parent
BASE = "https://api.themoviedb.org/3"


def main():
    auth = me.tmdb_auth()
    if auth is None:
        print("BLOCKED: set TMDB_READ_TOKEN or TMDB_API_KEY (env or repo-root .env, gitignored)")
        sys.exit(2)
    cands = me.load_candidates()  # tracked snapshot in fixtures/
    truth = json.loads((HERE / "truth_wikidata.json").read_text(encoding="utf-8"))["truth"]
    items = []
    for q in cands:
        t = truth.get(q["key"])
        c = next((c for c in q["candidates"] if c["ref"] == t), None)
        if c and c.get("tmdb"):
            items.append((q["key"], c["kind"], c["tmdb"][0]))
    rows = []
    for key, kind, tid in items:
        ep = "movie" if kind == "movie" else "tv"
        params = {"language": "it-IT", "append_to_response": "images,translations",
                  "include_image_language": "it,null", **auth["params"]}
        t0 = time.perf_counter()
        d = me.http_get_json(f"{BASE}/{ep}/{tid}", params, auth["headers"])
        dt = time.perf_counter() - t0
        title = d.get("title") or d.get("name")
        orig = d.get("original_title") or d.get("original_name")
        posters = d.get("images", {}).get("posters", [])
        row = {"key": key, "kind": kind, "tmdb": tid, "title_it": title, "original": orig,
               "localized": bool(title) and title != orig, "overview_it": bool(d.get("overview")),
               "poster_it": any(p.get("iso_639_1") == "it" for p in posters),
               "poster_any": bool(d.get("poster_path")), "backdrop": bool(d.get("backdrop_path")),
               "genres": [g["name"] for g in d.get("genres", [])], "latency_s": round(dt, 3)}
        if ep == "tv":
            s = me.http_get_json(f"{BASE}/tv/{tid}/season/1", {"language": "it-IT", **auth["params"]}, auth["headers"])
            eps = s.get("episodes", [])
            # TMDB returns "Episodio N" when no Italian name exists
            named = [e for e in eps if e.get("name") and not e["name"].lower().startswith(("episodio", "episode"))]
            row.update(episodes_s1=len(eps), ep_names_it=len(named), ep_overview_it=sum(1 for e in eps if e.get("overview")))
        rows.append(row)
    (me.OUT / "tmdb_probe.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    n = len(rows)
    print(f"items={n}")
    for k in ("localized", "overview_it", "poster_it", "poster_any", "backdrop"):
        print(f"{k}: {sum(r[k] for r in rows)}/{n}")
    tv = [r for r in rows if r["kind"] == "tv"]
    if tv:
        print("tv S1 episodes with Italian name:", sum(r["ep_names_it"] for r in tv), "/", sum(r["episodes_s1"] for r in tv))
        print("tv S1 episodes with Italian overview:", sum(r["ep_overview_it"] for r in tv), "/", sum(r["episodes_s1"] for r in tv))


if __name__ == "__main__":
    main()
