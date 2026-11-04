"""Matching + confidence prototype (throwaway).

1. Builds provider queries from the rules.py parse of corpus.json + holdout.json
   (movies -> movie query; episodes -> one series query per series).
2. Gets candidates from a provider:
     --provider wikidata (default, keyless)  MediaWiki search on items with a TMDB id (P4947 movie / P4983 tv)
     --provider tmdb                          /search/movie|tv with language=it-IT (needs TMDB_READ_TOKEN or TMDB_API_KEY)
   All HTTP responses are cached in out/cache/ (gitignored: re-runs on the same machine are offline;
   elsewhere 'eval' and 'label' run offline from the tracked snapshot in fixtures/).
3. Scores candidates and decides auto-match vs "Da verificare"; sweeps threshold/margin
   and reports precision/recall against truth_<provider>.json (hand-labelled).

Usage:
  python match_eval.py dump [--freeze]  -> out/candidates_<provider>.json; --freeze also writes the tracked
                                           snapshot fixtures/candidates_<provider>.json (names/IDs/years only)
  python match_eval.py label            -> labelling view without scores (provider rank order)
  python match_eval.py eval [--v1 | --scorer v1|filter|penalty|v2] [--live]
                                        -> precision/recall tables; reads the frozen snapshot unless --live
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

import requests
from rapidfuzz import fuzz

import rules

HERE = Path(__file__).parent
OUT = HERE / "out"
CACHE = OUT / "cache"
CACHE.mkdir(parents=True, exist_ok=True)
RATE_LIMITED = []
TIMEOUTS = []
SEARCH_FAILED = []
SEARCH_ROWS = []
LATENCY = []
UA = "pezzotflix-spike-s4/0.1 (private self-hosted media research script; python-requests)"
PROVIDER = "wikidata"
for i, a in enumerate(sys.argv):
    if a == "--provider":
        PROVIDER = sys.argv[i + 1]


def http_get_json(url, params=None, headers=None):
    key = hashlib.sha1((url + json.dumps(params, sort_keys=True)).encode()).hexdigest()
    f = CACHE / f"{key}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    h = {"User-Agent": UA}
    h.update(headers or {})
    for attempt in range(6):
        t0 = time.perf_counter()
        try:
            r = requests.get(url, params=params, headers=h, timeout=90)
        except requests.Timeout:
            TIMEOUTS.append(url)
            print("  timeout, retrying", file=sys.stderr)
            if attempt >= 1:
                raise
            continue
        LATENCY.append(time.perf_counter() - t0)
        if r.status_code >= 400:
            with open(OUT / "http_events.log", "a", encoding="utf-8") as log:
                log.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {r.status_code} retry-after={r.headers.get('Retry-After')} "
                          f"{time.perf_counter() - t0:.1f}s {url}\n")
        if r.status_code >= 500:
            if attempt >= 1:
                break
            time.sleep(5)
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", "0") or 0) or 5 * (attempt + 1)
            RATE_LIMITED.append(wait)
            print(f"  429 rate limited, waiting {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue
        break
    r.raise_for_status()
    data = r.json()
    f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    time.sleep(1.0)
    return data


# ------------------------------------------------------------------ queries
def build_queries():
    qs = {}
    for cp in ("corpus.json", "holdout.json"):
        for e in json.loads((HERE / cp).read_text(encoding="utf-8"))["entries"]:
            p = rules.parse(e["path"], e["root"])
            if p["kind"] == "movie" and p["title"]:
                kind = "movie"
            elif p["kind"] == "episode" and p["title"]:
                kind = "tv"
            elif p["kind"] == "movie" and not p["title"]:
                qs[f"none:{e['id']}"] = {"key": f"none:{e['id']}", "title": None, "year": None, "kind": "movie", "ids": [e["id"]]}
                continue
            else:
                continue
            key = f"{kind}:{p['title']}:{p['year']}"
            q = qs.setdefault(key, {"key": key, "title": p["title"], "year": p["year"], "kind": kind, "ids": []})
            q["ids"].append(e["id"])
    return list(qs.values())


# ------------------------------------------------------------------ wikidata
WD_API = "https://www.wikidata.org/w/api.php"


def _years(claims, props):
    ys = []
    for p in props:
        for c in claims.get(p, []):
            try:
                t = c["mainsnak"]["datavalue"]["value"]["time"]
                ys.append(int(t[1:5]))
            except (KeyError, ValueError):
                pass
    return sorted(set(ys))


WD_SPARQL = "https://query.wikidata.org/sparql"
WD_DETAILS = """
SELECT ?item ?kind
  (SAMPLE(?it) AS ?itl) (SAMPLE(?en) AS ?enl)
  (GROUP_CONCAT(DISTINCT ?orig; separator="|") AS ?origs)
  (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliases)
  (GROUP_CONCAT(DISTINCT STR(YEAR(?date)); separator="|") AS ?years)
  (GROUP_CONCAT(DISTINCT STR(YEAR(?start)); separator="|") AS ?starts)
  (SAMPLE(?tm) AS ?tmdbm) (SAMPLE(?tt) AS ?tmdbt) (SAMPLE(?descIt) AS ?desc)
  (SAMPLE(?itw) AS ?itwiki) (SAMPLE(?img) AS ?image) (SAMPLE(?sl) AS ?sitelinks)
WHERE {
  VALUES ?item { %s }
  OPTIONAL { ?item rdfs:label ?it FILTER(LANG(?it) = "it") }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item wdt:P1476 ?orig }
  OPTIONAL { ?item skos:altLabel ?alias FILTER(LANG(?alias) IN ("it", "en")) }
  OPTIONAL { ?item wdt:P577 ?date }
  OPTIONAL { ?item wdt:P580 ?start }
  OPTIONAL { ?item wdt:P4947 ?tm }
  OPTIONAL { ?item wdt:P4983 ?tt }
  OPTIONAL { ?item schema:description ?descIt FILTER(LANG(?descIt) = "it") }
  OPTIONAL { ?itw schema:about ?item ; schema:isPartOf <https://it.wikipedia.org/> }
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?item wikibase:sitelinks ?sl }
} GROUP BY ?item ?kind"""
_WD_DETAILS = {}


WD_SEARCH = """
SELECT ?item ?ord WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "Search";
                    mwapi:srsearch "%s"; mwapi:srlimit "10".
    ?item wikibase:apiOutputItem mwapi:title.
    ?ord wikibase:apiOrdinal true.
  }
} ORDER BY ?ord"""


def wikidata_search(q):
    """Full-text search on items that have a TMDB id. Runs through WDQS (MWAPI service): during the spike the
    anonymous Action API answered 429 after a handful of requests (the Retry-After values seen on the console
    were not saved; since then every >=400 response is appended to out/http_events.log)."""
    if not q["title"]:
        return []
    text = q["title"].replace('"', " ") + " haswbstatement:P4947|P4983"
    try:
        data = http_get_json(WD_SPARQL, {"query": WD_SEARCH % text, "format": "json"})
    except requests.RequestException as ex:
        SEARCH_FAILED.append((q["key"], str(ex)[:60]))
        return []
    # MWAPI keeps paginating past srlimit (one query returned thousands of rows): keep the top 10 by rank
    rows = sorted(data["results"]["bindings"], key=lambda b: int(b["ord"]["value"]))
    SEARCH_ROWS.append((q["key"], len(rows)))
    return [b["item"]["value"].rsplit("/", 1)[-1] for b in rows[:10]]


def wikidata_details(ids):
    ids = [i for i in dict.fromkeys(ids) if i not in _WD_DETAILS]
    for k in range(0, len(ids), 150):
        chunk = ids[k:k + 150]
        q = WD_DETAILS % " ".join(f"wd:{i}" for i in chunk)
        data = http_get_json(WD_SPARQL, {"query": q, "format": "json"})
        for b in data["results"]["bindings"]:
            g = lambda n: b.get(n, {}).get("value")
            qid = g("item").rsplit("/", 1)[-1]
            sp = lambda n: [x for x in (g(n) or "").split("|") if x]
            kind = "movie" if g("tmdbm") else "tv"
            years = sorted({int(y) for y in sp("years")}) if kind == "movie" else (sorted({int(y) for y in sp("starts")}) or sorted({int(y) for y in sp("years")}))
            _WD_DETAILS[qid] = {"ref": qid, "kind": kind, "title_it": g("itl"), "title_en": g("enl"), "original": sp("origs"),
                                "aliases": sp("aliases")[:12], "years": years, "tmdb": [g("tmdbm") or g("tmdbt")],
                                "itwiki": bool(g("itwiki")), "desc_it": g("desc"), "image": bool(g("image")),
                                "sitelinks": int(g("sitelinks") or 0)}
    return _WD_DETAILS


def wikidata_candidates(q):
    ids = wikidata_search(q)
    det = wikidata_details(ids)
    return [dict(det[i], rank=r) for r, i in enumerate(ids, 1) if i in det]  # copies: scores are per query


# ------------------------------------------------------------------ tmdb (blocked without key)
def tmdb_auth():
    env = dict(os.environ)
    dotenv = HERE.parent.parent / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"'))
    if env.get("TMDB_READ_TOKEN"):
        return {"headers": {"Authorization": f"Bearer {env['TMDB_READ_TOKEN']}"}, "params": {}}
    if env.get("TMDB_API_KEY"):
        return {"headers": {}, "params": {"api_key": env["TMDB_API_KEY"]}}
    return None


def tmdb_candidates(q):
    auth = tmdb_auth()
    if auth is None:
        raise SystemExit("BLOCKED: no TMDB_READ_TOKEN / TMDB_API_KEY in env or .env")
    if not q["title"]:
        return []
    ep = "movie" if q["kind"] == "movie" else "tv"
    params = {"query": q["title"], "language": "it-IT", "include_adult": "false", **auth["params"]}
    if q["year"]:
        params["year" if ep == "movie" else "first_air_date_year"] = q["year"]
    res = http_get_json(f"https://api.themoviedb.org/3/search/{ep}", params, auth["headers"])["results"]
    if not res and q["year"]:  # year may be off by one: retry without it
        params.pop("year", None); params.pop("first_air_date_year", None)
        res = http_get_json(f"https://api.themoviedb.org/3/search/{ep}", params, auth["headers"])["results"]
    out = []
    for r in res[:10]:
        date = r.get("release_date") or r.get("first_air_date") or ""
        out.append({"ref": f"tmdb:{ep}:{r['id']}", "kind": q["kind"], "title_it": r.get("title") or r.get("name"),
                    "title_en": None, "original": [r.get("original_title") or r.get("original_name")], "aliases": [],
                    "years": [int(date[:4])] if date[:4].isdigit() else [], "popularity": r.get("popularity")})
    return out


CANDIDATES = {"wikidata": wikidata_candidates, "tmdb": tmdb_candidates}

# ------------------------------------------------------------------ scoring
ARTICLES = re.compile(r"^(il|lo|la|i|gli|le|l|un|uno|una|the|a|an|der|die|das|le|les)\s+")


def tnorm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).casefold().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return ARTICLES.sub("", s)


def title_sim(q, c):
    qt = tnorm(q)
    best = 0.0
    for t in [c.get("title_it"), c.get("title_en"), *c.get("original", []), *c.get("aliases", [])]:
        if not t:
            continue
        ct = tnorm(t)
        best = max(best, fuzz.ratio(qt, ct), fuzz.token_sort_ratio(qt, ct))
    return best / 100


def year_score(qy, cys):
    if qy is None:
        return 0.5
    if not cys:
        return 0.3
    d = min(abs(qy - y) for y in cys)
    return {0: 1.0, 1: 0.8, 2: 0.3}.get(d, 0.0)


W_TITLE, W_YEAR, W_KIND = 0.55, 0.35, 0.10


# Scorer variants: v1 = plain weighted score; v2 = kind filter + number penalty;
# "filter" / "penalty" = one fix each (ablation).
SCORER = "v2"
for _i, _a in enumerate(sys.argv):
    if _a == "--v1":
        SCORER = "v1"
    if _a == "--scorer":
        SCORER = sys.argv[_i + 1]
KIND_FILTER = SCORER in ("v2", "filter")
NUM_PENALTY = SCORER in ("v2", "penalty")


def _nums(t):
    return set(re.findall(r"\d+", tnorm(t or "")))


def title_sim_v2(q, c):
    """Like title_sim, but a title whose numbers differ ("2049" vs "2048", "Parte II") is penalised."""
    qt, qn = tnorm(q), _nums(q)
    best = 0.0
    for t in [c.get("title_it"), c.get("title_en"), *c.get("original", []), *c.get("aliases", [])]:
        if not t:
            continue
        ct = tnorm(t)
        s = max(fuzz.ratio(qt, ct), fuzz.token_sort_ratio(qt, ct)) / 100
        if _nums(t) != qn:
            s *= 0.7
        best = max(best, s)
    return best


def score(q, c):
    s_t = title_sim_v2(q["title"], c) if NUM_PENALTY else title_sim(q["title"], c)
    s_y = year_score(q["year"], c["years"])
    s_k = 1.0 if c["kind"] == q["kind"] else 0.0
    return round(W_TITLE * s_t + W_YEAR * s_y + W_KIND * s_k, 4), {"title": round(s_t, 3), "year": s_y, "kind": s_k}


# Without a year in the name the best possible score is 0.55 + 0.35*0.5 + 0.10 = 0.825:
# any threshold T <= 0.825 allows auto-matching titles without a year, any T > 0.825 forbids it.
MAX_SCORE_NO_YEAR = W_TITLE + W_YEAR * 0.5 + W_KIND


def decide(q, cands, T, M):
    """-> (decision, best_ref, reason). decision in {auto, review}."""
    if not q["title"]:
        return "review", None, "no_title"
    if not cands:
        return "review", None, "no_candidates"
    if KIND_FILTER:  # the kind from the root/structure is a filter, not a soft signal
        cands = [c for c in cands if c["kind"] == q["kind"]] or cands
    scored = sorted(((score(q, c)[0], c["ref"]) for c in cands), reverse=True)
    best, ref = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0.0
    if best < T:
        return "review", ref, "low_score"
    if best - second < M:
        return "review", ref, "ambiguous"
    return "auto", ref, "ok"


# ------------------------------------------------------------------ main
FIXTURE = HERE / "fixtures" / f"candidates_{PROVIDER}.json"
SNAPSHOT_FIELDS = ("ref", "kind", "title_it", "title_en", "original", "aliases", "years", "tmdb")


def dump():
    qs = build_queries()
    fn = CANDIDATES[PROVIDER]
    if PROVIDER == "wikidata":  # searches first, then one batched SPARQL for all details
        t0 = time.perf_counter()
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(4) as ex:  # WDQS allows 5 parallel queries per IP
            allids = [i for ids in ex.map(wikidata_search, qs) for i in ids]
        print("search rows (top):", sorted(SEARCH_ROWS, key=lambda x: -x[1])[:5], file=sys.stderr)
        print(f"searches done in {time.perf_counter()-t0:.1f}s, {len(allids)} ids", file=sys.stderr)
        t0 = time.perf_counter()
        wikidata_details(allids)
        print(f"details done in {time.perf_counter()-t0:.1f}s, 429s so far: {RATE_LIMITED}", file=sys.stderr)
    if LATENCY:
        L = sorted(LATENCY)
        print(f"http requests={len(L)} median={L[len(L)//2]:.2f}s p90={L[int(len(L)*0.9)]:.2f}s max={L[-1]:.2f}s "
              f"timeouts={len(TIMEOUTS)} 429={RATE_LIMITED} search_failed={SEARCH_FAILED}", file=sys.stderr)
    out = []
    for q in qs:
        cands = fn(q)
        for c in cands:
            c["score"], c["signals"] = score(q, c) if q["title"] else (0, {})
        out.append({**q, "candidates": cands})  # kept in provider rank order
    (OUT / f"candidates_{PROVIDER}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    if "--freeze" in sys.argv:  # tracked snapshot: names/IDs/years only, provider rank order, no scores
        snap = [{"key": q["key"], "title": q["title"], "year": q["year"], "kind": q["kind"], "ids": q["ids"],
                 "candidates": [{k: c.get(k) for k in SNAPSHOT_FIELDS} for c in q["candidates"]]} for q in out]
        FIXTURE.parent.mkdir(exist_ok=True)
        FIXTURE.write_text(json.dumps({"_doc": f"Frozen {PROVIDER} candidates for S4 (names, IDs, years only), "
                                               "provider rank order. Produced by 'match_eval.py dump --freeze'.",
                                       "queries": snap}, ensure_ascii=False, indent=1), encoding="utf-8")
        print("frozen ->", FIXTURE, file=sys.stderr)
    print(len(out), "queries")


def load_candidates():
    if "--live" in sys.argv:
        return json.loads((OUT / f"candidates_{PROVIDER}.json").read_text(encoding="utf-8"))
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["queries"]


def label():
    """Labelling view WITHOUT scores: candidates in provider rank order."""
    for q in load_candidates():
        print(f"{q['key']}  (files: {', '.join(q['ids'])})")
        for i, c in enumerate(q["candidates"], 1):
            print(f"   {i:2d}. {c['ref']:11s} {c['kind']:5s} it={c['title_it']!r} en={c['title_en']!r} years={c['years'][:3]}")


def wilson(k, n, z=1.96):
    """95% Wilson score interval for a proportion k/n."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    den = 1 + z * z / n
    mid = (p + z * z / (2 * n)) / den
    half = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / den
    return (max(0.0, mid - half), min(1.0, mid + half))


def evaluate():
    data = load_candidates()
    truth = json.loads((HERE / f"truth_{PROVIDER}.json").read_text(encoding="utf-8"))["truth"]
    n_real = sum(1 for q in data if truth.get(q["key"]))
    rows = []
    for T in (0.70, 0.75, 0.80, 0.85, 0.90):
        for M in (0.0, 0.05, 0.10, 0.15):
            tp = fp = fn = rev_ok = rev_should = 0
            errs, missed, noyear_auto = [], [], []
            for q in data:
                t = truth.get(q["key"])
                d, ref, why = decide(q, q["candidates"], T, M)
                in_list = t is not None and any(c["ref"] == t for c in q["candidates"])
                if d == "auto" and q["title"] and q["year"] is None:
                    noyear_auto.append((q["key"], ref == t))
                if t is None:
                    rev_should += 1
                    if d == "review":
                        rev_ok += 1
                    else:
                        fp += 1
                        errs.append((q["key"], "auto on should-review", ref))
                else:
                    if d == "auto" and ref == t:
                        tp += 1
                    elif d == "auto":
                        fp += 1
                        errs.append((q["key"], "wrong auto", ref, t))
                    elif in_list:
                        fn += 1
                        missed.append((q["key"], why))
            n_match = sum(1 for q in data if truth.get(q["key"]) and any(c["ref"] == truth[q["key"]] for c in q["candidates"]))
            prec = tp / (tp + fp) if tp + fp else 1.0
            rows.append({"T": T, "M": M, "tp": tp, "fp": fp, "missed": fn, "precision": prec,
                         "precision_ci95": wilson(tp, tp + fp), "recall_in_list": tp / n_match if n_match else 0.0,
                         "recall_in_list_ci95": wilson(tp, n_match), "recall_all": tp / n_real if n_real else 0.0,
                         "should_review": rev_should, "review_ok": rev_ok, "errors": errs, "missed_list": missed,
                         "noyear_auto": noyear_auto, "n_match": n_match, "n_real": n_real})
    print(f"scorer={SCORER} queries={len(data)} real works={n_real} with correct candidate in list={rows[0]['n_match']} "
          f"should-review={rows[0]['should_review']} max score without year={MAX_SCORE_NO_YEAR:.3f}")
    print("| T | M | auto corretti | auto errati | mancati | precision [IC 95%] | recall, candidato presente [IC 95%] "
          "| recall su tutte | auto senza anno (corretti) | da verificare corretti |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        pl, ph = r["precision_ci95"]
        rl, rh = r["recall_in_list_ci95"]
        ny = r["noyear_auto"]
        print(f"| {r['T']:.2f} | {r['M']:.2f} | {r['tp']} | {r['fp']} | {r['missed']} "
              f"| {100*r['precision']:.1f}% [{100*pl:.0f}–{100*ph:.0f}] "
              f"| {r['tp']}/{r['n_match']} = {100*r['recall_in_list']:.1f}% [{100*rl:.0f}–{100*rh:.0f}] "
              f"| {r['tp']}/{r['n_real']} = {100*r['recall_all']:.1f}% | {len(ny)} ({sum(ok for _, ok in ny)}) "
              f"| {r['review_ok']}/{r['should_review']} |")
    (OUT / f"match_{PROVIDER}_{SCORER}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> out/match_{PROVIDER}_{SCORER}.json")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "eval"
    {"dump": dump, "eval": evaluate, "label": label}[cmd]()
