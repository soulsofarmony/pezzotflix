"""TMDB it-IT coverage probe (throwaway). Needs TMDB_READ_TOKEN (v4) or TMDB_API_KEY (v3).

The token comes from the environment or the gitignored repo-root .env (match_eval.tmdb_auth). It is never
printed, logged or written: http_events.log records the URL without query string, the cache key is a hash.

Items: every distinct ref in truth_tmdb.json (build_truth_tmdb.py: TMDB ids from the Wikidata truth, CC0).
Per item:
  /movie|tv/{id}?language=it-IT&append_to_response=images,translations&include_image_language=it,null,en
     ('it' images are exactly those that include_image_language=it,null returns; 'en' is the fallback of ADR 0007)
  /movie/{id}/credits or /tv/{id}/aggregate_credits ?language=it-IT (ordered cast, characters, photos, director)
  tv: /tv/{id}/season/{n}?language=it-IT for every season n >= 1, and season 1 also in en-US
      (to tell a real Italian episode name/overview from a fallback)
Measures: it-IT title (present, from an Italian translation, different from the original for non-Italian
originals), Italian overview (and not the English one), Italian poster/logo, whether the default poster_path
for it-IT is an Italian poster, documentary genre (id 99), agreement with Wikidata (year, title: a check BY ID
of truth_tmdb.json), per-request latency p50/p95 (HTTP time only, without the 1 s pause), HTTP errors and 404s.
Rate: match_eval.http_get_json pauses 1 s after every live request (<= 1 req/s; ADR 0007 allows 20 req/s).
Responses are cached in out/cache/ (gitignored; TMDB terms 1.C: delete within 6 months). --fresh re-measures.

Usage: python tmdb_probe.py [--fresh] [--keepalive] -> out/tmdb_probe.json + summary
       (--keepalive reuses one connection, as a product client would; without it every request opens TCP+TLS)
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

import requests
from rapidfuzz import fuzz

import match_eval as me

HERE = Path(__file__).parent
BASE = "https://api.themoviedb.org/3"
PLACEHOLDER = re.compile(r"^(episodio|episode|puntata|ep\.?)\s*\d+$", re.I)
# Expected documentaries (corpus category 'documentary'; Le Mans 66 is in Documentari/ but is fiction)
DOC_TRUE = {"movie:Free Solo:2018", "movie:Il sale della terra:2014", "tv:Planet Earth II:2016",
            "tv:Our Planet:2019", "tv:Cosmos - Odissea nello spazio:2014", "movie:Senna:2010"}
# Wikidata data of the MANUAL truth entry (build_truth_tmdb.py), same SPARQL lookup
WD_MANUAL = {"tmdb:movie:14161": {"ref": "Q184605", "title_it": "2012", "title_en": "2012", "original": [],
                                  "aliases": [], "years": [2009]}}
CALLS = []  # one row per live HTTP response: call type, latency, status


def get(call, url, params, auth):
    n0 = len(me.LATENCY)
    data, err = None, None
    try:
        data = me.http_get_json(url, {**params, **auth["params"]}, auth["headers"])
    except requests.HTTPError as ex:
        err = ex.response.status_code if ex.response is not None else "http_error"
    except requests.RequestException as ex:
        err = type(ex).__name__
    for lat, st in zip(me.LATENCY[n0:], me.STATUS[n0:]):
        CALLS.append({"call": call, "latency_s": round(lat, 4), "status": st})
    return data, err


def pct(xs, p):
    xs = sorted(xs)
    return xs[max(0, -(-len(xs) * p // 100) - 1)] if xs else None


def tsim(a_list, b_list):
    best = 0.0
    for a in a_list:
        for b in b_list:
            if a and b:
                x, y = me.tnorm(a), me.tnorm(b)
                best = max(best, fuzz.ratio(x, y), fuzz.token_sort_ratio(x, y))
    return best / 100


def episodes_stats(eps):
    named = [e for e in eps if (e.get("name") or "").strip() and not PLACEHOLDER.match(e["name"].strip())]
    return {"eps": len(eps), "named_it": len(named), "overview_it": sum(1 for e in eps if (e.get("overview") or "").strip()),
            "still": sum(1 for e in eps if e.get("still_path"))}


def probe_item(ref, keys, wd, auth):
    _, ep, tid = ref.split(":")
    row = {"ref": ref, "keys": keys, "kind": ep, "qid": wd["ref"] if wd else None,
           "wd94": not ref in WD_MANUAL, "doc_expected": any(k in DOC_TRUE for k in keys)}
    d, err = get("details", f"{BASE}/{ep}/{tid}", {"language": "it-IT", "append_to_response": "images,translations",
                                                   "include_image_language": "it,null,en"}, auth)
    if d is None:
        row["error"] = err
        return row
    title, orig = d.get("title") or d.get("name"), d.get("original_title") or d.get("original_name")
    date = d.get("release_date") or d.get("first_air_date") or ""
    tr = (d.get("translations") or {}).get("translations", [])
    it_tr = [t for t in tr if t.get("iso_639_1") == "it"]
    en_tr = sorted((t for t in tr if t.get("iso_639_1") == "en"), key=lambda t: t.get("iso_3166_1") != "US")
    en_overview = next((t["data"].get("overview") for t in en_tr if t["data"].get("overview")), None)
    overview = (d.get("overview") or "").strip()
    imgs = d.get("images") or {}
    langs = lambda kind: Counter(i.get("iso_639_1") or "null" for i in imgs.get(kind, []))
    pl, bl, ll = langs("posters"), langs("backdrops"), langs("logos")
    default_lang = next((i.get("iso_639_1") or "null" for i in imgs.get("posters", [])
                         if i.get("file_path") == d.get("poster_path")), "other" if d.get("poster_path") else None)
    year = int(date[:4]) if date[:4].isdigit() else None
    row.update({
        "error": None, "title_it": title, "original": orig, "original_language": d.get("original_language"),
        "year": year, "title_present": bool(title), "localized": bool(title) and title != orig,
        "it_translation": bool(it_tr), "it_translation_regions": sorted(t.get("iso_3166_1") for t in it_tr),
        "it_translation_title": any((t["data"].get("title") or t["data"].get("name") or "").strip() for t in it_tr),
        "it_translation_overview": any((t["data"].get("overview") or "").strip() for t in it_tr),
        "overview_it": bool(overview), "overview_is_en": bool(overview) and overview == (en_overview or "").strip(),
        "tagline_it": bool((d.get("tagline") or "").strip()),
        "posters": dict(pl), "poster_it": pl.get("it", 0) > 0, "poster_default_lang": default_lang,
        "poster_any": bool(d.get("poster_path")), "backdrops": dict(bl), "backdrop": bool(d.get("backdrop_path")),
        "logos": dict(ll), "logo_it": ll.get("it", 0) > 0, "logo_en": ll.get("en", 0) > 0,
        "genres": [g["name"] for g in d.get("genres", [])], "doc": any(g.get("id") == 99 for g in d.get("genres", [])),
    })
    # credits (D5: TMDB for cast; ADR 0007 point 3: ordered credits with characters and photos)
    cpath = f"{BASE}/movie/{tid}/credits" if ep == "movie" else f"{BASE}/tv/{tid}/aggregate_credits"
    cr, err = get("credits", cpath, {"language": "it-IT"}, auth)
    if cr is None:
        row["credits"] = {"error": err}
    else:
        cast, crew = cr.get("cast", []), cr.get("crew", [])
        char = (lambda c: (c.get("character") or "").strip()) if ep == "movie" else \
               (lambda c: any((r.get("character") or "").strip() for r in c.get("roles", [])))
        top = cast[:10]
        row["credits"] = {"error": None, "cast": len(cast), "ordered": all("order" in c for c in cast),
                          "top10": len(top), "top10_character": sum(1 for c in top if char(c)),
                          "top10_photo": sum(1 for c in top if c.get("profile_path")),
                          "director": any(c.get("job") == "Director" for c in crew) if ep == "movie"
                          else bool(d.get("created_by"))}
    if wd:
        wd_titles = [wd.get("title_it"), wd.get("title_en"), *wd.get("original", []), *wd.get("aliases", [])]
        row["wd_check"] = {
            "year_ok": year is not None and any(abs(year - y) <= 1 for y in wd.get("years", [])),
            "wd_years": wd.get("years", [])[:4], "title_sim": round(tsim([title, orig], wd_titles), 3),
            "wd_title_it": wd.get("title_it"),
            "it_title_equal_wd": bool(wd.get("title_it")) and me.tnorm(title) == me.tnorm(wd["title_it"])}
    if ep == "tv":
        seasons = sorted(s["season_number"] for s in d.get("seasons", []) if s.get("season_number", 0) >= 1)
        row["seasons"] = len(seasons)
        tot = {"eps": 0, "named_it": 0, "overview_it": 0, "still": 0}
        for n in seasons:
            s, err = get("season_it", f"{BASE}/tv/{tid}/season/{n}", {"language": "it-IT"}, auth)
            if s is None:
                row.setdefault("season_errors", []).append((n, err))
                continue
            st = episodes_stats(s.get("episodes", []))
            for k in tot:
                tot[k] += st[k]
            if n == 1:
                row["s1"] = st
                s_en, err = get("season_en", f"{BASE}/tv/{tid}/season/1", {"language": "en-US"}, auth)
                if s_en is not None:
                    en = {e["episode_number"]: e for e in s_en.get("episodes", [])}
                    same_name = same_ov = 0
                    for e in s.get("episodes", []):
                        e_en = en.get(e["episode_number"], {})
                        nm = (e.get("name") or "").strip()
                        if nm and not PLACEHOLDER.match(nm) and nm == (e_en.get("name") or "").strip():
                            same_name += 1
                        ov = (e.get("overview") or "").strip()
                        if ov and ov == (e_en.get("overview") or "").strip():
                            same_ov += 1
                    row["s1"].update(name_same_as_en=same_name, overview_same_as_en=same_ov,
                                     en=episodes_stats(s_en.get("episodes", [])))
        row["all_seasons"] = tot
    return row


def summarize(rows, label):
    ok = [r for r in rows if not r.get("error")]
    n = len(ok)
    foreign = [r for r in ok if r["original_language"] != "it"]
    native = [r for r in ok if r["original_language"] == "it"]
    c = lambda xs, k: sum(1 for r in xs if r.get(k))
    s = {"label": label, "items": len(rows), "ok": n, "errors": Counter(str(r["error"]) for r in rows if r.get("error")),
         "title_present": c(ok, "title_present"), "it_translation_title": c(ok, "it_translation_title"),
         "foreign_original": len(foreign), "foreign_localized": c(foreign, "localized"),
         "foreign_it_translation_title": c(foreign, "it_translation_title"),
         "italian_original": len(native), "italian_title_equals_original": sum(1 for r in native if not r["localized"]),
         "overview_it": c(ok, "overview_it"), "overview_is_en": c(ok, "overview_is_en"),
         "tagline_it": c(ok, "tagline_it"),
         "poster_any": c(ok, "poster_any"), "poster_it": c(ok, "poster_it"),
         "poster_default_lang": Counter(r["poster_default_lang"] for r in ok),
         "poster_null_any": sum(1 for r in ok if r["posters"].get("null")),
         "posters_it_median": pct([r["posters"].get("it", 0) for r in ok], 50),
         "backdrop": c(ok, "backdrop"), "logo_it": c(ok, "logo_it"), "logo_en": c(ok, "logo_en"),
         "logo_it_or_en": sum(1 for r in ok if r["logo_it"] or r["logo_en"]),
         "doc_flag": sorted(r["keys"][0] for r in ok if r["doc"]),
         "doc_expected": sorted(r["keys"][0] for r in ok if r["doc_expected"])}
    cr = [r["credits"] for r in ok if r.get("credits") and not r["credits"].get("error")]
    mv = [r for r in ok if r["kind"] == "movie" and r.get("credits") and not r["credits"].get("error")]
    s["credits"] = {"ok": len(cr), "errors": sum(1 for r in ok if (r.get("credits") or {}).get("error")),
                    "with_cast": sum(1 for c in cr if c["cast"]), "cast_median": pct([c["cast"] for c in cr], 50),
                    "ordered": sum(1 for c in cr if c["ordered"]),
                    "top10_character": f"{sum(c['top10_character'] for c in cr)}/{sum(c['top10'] for c in cr)}",
                    "top10_photo": f"{sum(c['top10_photo'] for c in cr)}/{sum(c['top10'] for c in cr)}",
                    "movie_director": f"{sum(1 for r in mv if r['credits']['director'])}/{len(mv)}",
                    "tv_created_by": f"{sum(1 for r in ok if r['kind'] == 'tv' and (r.get('credits') or {}).get('director'))}"
                                     f"/{sum(1 for r in ok if r['kind'] == 'tv')}"}
    s["movies"], s["series"] = sum(1 for r in ok if r["kind"] == "movie"), sum(1 for r in ok if r["kind"] == "tv")
    s["poster_it_movies"] = sum(1 for r in ok if r["kind"] == "movie" and r["poster_it"])
    s["poster_it_series"] = sum(1 for r in ok if r["kind"] == "tv" and r["poster_it"])
    s["logo_it_movies"] = sum(1 for r in ok if r["kind"] == "movie" and r["logo_it"])
    s["logo_it_series"] = sum(1 for r in ok if r["kind"] == "tv" and r["logo_it"])
    wd = [r for r in ok if r.get("wd_check")]
    s["wd_year_mismatch"] = [(r["keys"][0], r["year"], r["wd_check"]["wd_years"]) for r in wd if not r["wd_check"]["year_ok"]]
    s["wd_title_low"] = [(r["keys"][0], r["title_it"], r["original"], r["wd_check"]["title_sim"]) for r in wd
                         if r["wd_check"]["title_sim"] < 0.8]
    with_wd_it = [r for r in wd if r["wd_check"]["wd_title_it"]]
    s["it_title_equal_wd"] = f"{sum(r['wd_check']['it_title_equal_wd'] for r in with_wd_it)}/{len(with_wd_it)}"
    s["it_title_differs_wd"] = [(r["keys"][0], r["title_it"], r["wd_check"]["wd_title_it"]) for r in with_wd_it
                                if not r["wd_check"]["it_title_equal_wd"]]
    tv = [r for r in ok if r["kind"] == "tv"]
    if tv:
        agg = lambda part, k: sum(r.get(part, {}).get(k, 0) for r in tv)
        s["tv"] = {"series": len(tv), "seasons": sum(r.get("seasons", 0) for r in tv),
                   "s1_eps": agg("s1", "eps"), "s1_named_it": agg("s1", "named_it"),
                   "s1_overview_it": agg("s1", "overview_it"), "s1_name_same_as_en": agg("s1", "name_same_as_en"),
                   "s1_overview_same_as_en": agg("s1", "overview_same_as_en"),
                   "s1_still": agg("s1", "still"),
                   "all_eps": agg("all_seasons", "eps"), "all_named_it": agg("all_seasons", "named_it"),
                   "all_overview_it": agg("all_seasons", "overview_it"), "all_still": agg("all_seasons", "still"),
                   "series_s1_full_names": sum(1 for r in tv if r.get("s1") and r["s1"]["eps"] and r["s1"]["named_it"] == r["s1"]["eps"]),
                   "series_s1_full_overview": sum(1 for r in tv if r.get("s1") and r["s1"]["eps"] and r["s1"]["overview_it"] == r["s1"]["eps"]),
                   "series_all_zero_names": [r["keys"][0] for r in tv if not r["all_seasons"]["named_it"]],
                   "series_all_ge90_names": sum(1 for r in tv if r["all_seasons"]["eps"] and r["all_seasons"]["named_it"] >= 0.9 * r["all_seasons"]["eps"]),
                   "season_errors": [(r["keys"][0], r["season_errors"]) for r in tv if r.get("season_errors")]}
    return s


def main():
    auth = me.tmdb_auth()
    if auth is None:
        print("BLOCKED: set TMDB_READ_TOKEN or TMDB_API_KEY (env or repo-root .env, gitignored)")
        sys.exit(2)
    truth = json.loads((HERE / "truth_tmdb.json").read_text(encoding="utf-8"))["truth"]
    wd_truth = json.loads((HERE / "truth_wikidata.json").read_text(encoding="utf-8"))["truth"]
    wd_q = {q["key"]: q for q in json.loads((HERE / "fixtures" / "candidates_wikidata.json").read_text(encoding="utf-8"))["queries"]}
    refs = {}
    for key, ref in truth.items():
        if ref:
            refs.setdefault(ref, []).append(key)
    rows = []
    for i, (ref, keys) in enumerate(refs.items(), 1):
        qid = wd_truth.get(keys[0])
        wd = next((c for c in wd_q[keys[0]]["candidates"] if c["ref"] == qid), None) or WD_MANUAL.get(ref)
        rows.append(probe_item(ref, keys, wd, auth))
        if i % 10 == 0:
            print(f"  {i}/{len(refs)} items, {len(CALLS)} live requests", file=sys.stderr)
    lat_file, keepalive = me.OUT / "tmdb_probe_latency.json", "--keepalive" in sys.argv
    if me.FRESH:  # latency only from a full live run (--fresh); a cached re-run keeps the last live measurement
        lat_file.write_text(json.dumps({"keepalive": keepalive, "calls": CALLS}), encoding="utf-8")
    else:
        prev = lat_file if lat_file.exists() else me.OUT / "tmdb_probe.json"
        if prev.exists():
            p = json.loads(prev.read_text(encoding="utf-8"))
            live_now = len(CALLS)
            CALLS[:] = p.get("calls", [])
            keepalive = p.get("keepalive", (p.get("summary") or {}).get("keepalive"))
            print(f"note: cached re-run ({live_now} live requests now); latency and status from the last --fresh run "
                  f"({prev.name})", file=sys.stderr)
            if prev.name == "tmdb_probe.json":
                lat_file.write_text(json.dumps({"keepalive": keepalive, "calls": CALLS}), encoding="utf-8")
    lat = {}
    for call in ("details", "credits", "season_it", "season_en", "all"):
        xs = [c["latency_s"] for c in CALLS if call == "all" or c["call"] == call]
        if xs:
            lat[call] = {"n": len(xs), "p50": pct(xs, 50), "p95": pct(xs, 95), "max": max(xs)}
    status = Counter(c["status"] for c in CALLS)
    summary = {"all": summarize(rows, "all distinct refs"), "wd94": summarize([r for r in rows if r["wd94"]], "Wikidata 94"),
               "latency": lat, "keepalive": keepalive, "status": dict(status), "http_404": status.get(404, 0),
               "http_errors": sum(v for k, v in status.items() if k >= 400), "timeouts": len(me.TIMEOUTS),
               "rate_limited": me.RATE_LIMITED}
    (me.OUT / "tmdb_probe.json").write_text(json.dumps({"summary": summary, "rows": rows, "calls": CALLS},
                                                       ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=str))
    if not CALLS:
        print("note: no live run recorded: latency not measured (use --fresh)", file=sys.stderr)


if __name__ == "__main__":
    main()
