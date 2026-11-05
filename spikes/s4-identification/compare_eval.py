"""Side-by-side matching metrics, Wikidata vs TMDB, on corpus / holdout / combined (throwaway).

Same scorer and decision as match_eval.py (v2: kind filter + number penalty), at the D6 operating point
T 0.80 (accept) and M 0.10 (gap to the second): a title without a year auto-matches only if it is unique.
  Wikidata: fixtures/candidates_wikidata.json (tracked snapshot) + truth_wikidata.json
  TMDB:     out/candidates_tmdb.json ('match_eval.py dump --provider tmdb', gitignored) + truth_tmdb.json
Split: a query belongs to the corpus if one of its files is in corpus.json, to the holdout if one is in
holdout.json ('Blade Runner 2049 (2017)' is in both); 'combined' is the deduplicated union (114 queries).
Also: --what-if prints exploratory variants, all in-sample (designed after seeing the TMDB misses): a popularity
tie-break for titles without a year (TMDB), Unicode-aware title normalization (both providers), and a vote-count
tie-break for 'ambiguous' queries WITH a year (TMDB; D6 untouched).

Usage: python compare_eval.py [--T 0.80] [--M 0.10] [--what-if] -> table + out/compare_eval.json
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import match_eval as me

HERE = Path(__file__).parent


def arg(name, default):
    return float(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


T, M = arg("--T", 0.80), arg("--M", 0.10)
CORPUS = {e["id"] for e in json.loads((HERE / "corpus.json").read_text(encoding="utf-8"))["entries"]}
HOLDOUT = {e["id"] for e in json.loads((HERE / "holdout.json").read_text(encoding="utf-8"))["entries"]}
SPLITS = {"corpus": lambda q: any(i in CORPUS for i in q["ids"]),
          "holdout": lambda q: any(i in HOLDOUT for i in q["ids"]),
          "combined": lambda q: True}


def load(provider):
    if provider == "wikidata":
        data = json.loads((HERE / "fixtures" / "candidates_wikidata.json").read_text(encoding="utf-8"))["queries"]
    else:
        data = json.loads((me.OUT / "candidates_tmdb.json").read_text(encoding="utf-8"))
    truth = json.loads((HERE / f"truth_{provider}.json").read_text(encoding="utf-8"))["truth"]
    return data, truth


def metrics(data, truth, decide=None):
    decide = decide or me.decide
    tp = fp = missed = rev_ok = 0
    n_real = n_should = n_match = 0
    errors, misses, noyear, reasons = [], [], [], Counter()
    for q in data:
        t = truth.get(q["key"])
        d, ref, why = decide(q, q["candidates"], T, M)
        in_list = bool(t) and any(c["ref"] == t for c in q["candidates"])
        if d == "auto" and q["title"] and q["year"] is None:
            noyear.append((q["key"], ref == t))
        if t is None:
            n_should += 1
            if d == "review":
                rev_ok += 1
            else:
                fp += 1
                errors.append((q["key"], "auto on should-review", ref))
            continue
        n_real += 1
        n_match += in_list
        if d == "auto" and ref == t:
            tp += 1
        elif d == "auto":
            fp += 1
            errors.append((q["key"], "wrong auto", ref, t))
        else:
            reasons[why if in_list else f"{why} (not in list)"] += 1
            if in_list:
                missed += 1
                misses.append((q["key"], why))
    n = len(data)
    pl, ph = me.wilson(tp, tp + fp)
    rl, rh = me.wilson(tp, n_match)
    return {"queries": n, "real": n_real, "should_review": n_should, "in_list": n_match,
            "auto_ok": tp, "auto_wrong": fp, "missed": missed,
            "precision": tp / (tp + fp) if tp + fp else 1.0, "precision_ci95": (pl, ph),
            "recall_in_list": tp / n_match if n_match else 0.0, "recall_in_list_ci95": (rl, rh),
            "recall_all": tp / n_real if n_real else 0.0,
            "auto_rate": (tp + fp) / n if n else 0.0, "noyear_auto": noyear,
            "review_ok": rev_ok, "real_to_review_reasons": dict(reasons), "errors": errors, "misses": misses}


def what_if_popularity(data, truth):
    """Exploratory, in-sample: titles WITHOUT a year that the D6 rule sends to the queue as 'ambiguous'. Among the
    candidates within M of the best score, auto-pick the most popular one if its TMDB popularity is at least
    k times the second. Reports what that would gain (right picks) and break (wrong picks, incl. the null labels)."""
    rows = []
    for q in data:
        if not q["title"] or q["year"] is not None or not q["candidates"]:
            continue
        d, ref, why = me.decide(q, q["candidates"], T, M)
        sc = sorted(((me.score(q, c)[0], c) for c in q["candidates"]), key=lambda x: -x[0])
        best = sc[0][0]
        tied = sorted((c for s, c in sc if best - s < M and best >= T), key=lambda c: -(c.get("popularity") or 0))
        if len(tied) < 2:
            rows.append({"key": q["key"], "decision": d, "why": why, "tied": len(tied)})
            continue
        p1, p2 = tied[0].get("popularity") or 0, tied[1].get("popularity") or 0
        rows.append({"key": q["key"], "decision": d, "why": why, "tied": len(tied), "pick": tied[0]["ref"],
                     "pick_title": tied[0]["title_it"], "pick_year": tied[0]["years"][:1],
                     "ratio": round(p1 / p2, 2) if p2 else None, "truth": truth.get(q["key"]),
                     "pick_ok": tied[0]["ref"] == truth.get(q["key"])})
    out = {"rows": rows}
    for k in (2, 5, 10):
        amb = [r for r in rows if r.get("pick") and r["decision"] == "review" and (r["ratio"] is None or r["ratio"] >= k)]
        out[f"k{k}"] = {"would_auto": len(amb), "right": sum(r["pick_ok"] for r in amb),
                        "wrong_real": sum(1 for r in amb if not r["pick_ok"] and r["truth"]),
                        "wrong_should_review": sum(1 for r in amb if not r["truth"])}
    return out


def tnorm_unicode(s):
    """Like match_eval.tnorm, but keeps non-Latin letters: tnorm turns e.g. 'Москва 1980' into '1980'."""
    s = me.unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not me.unicodedata.combining(c)).casefold().replace("&", " and ")
    s = me.re.sub(r"[\W_]+", " ", s).strip()
    return me.ARTICLES.sub("", s)


def votes_tiebreak(k):
    """Exploratory, TMDB only, in-sample: an 'ambiguous' query WITH a year auto-matches the most voted candidate
    among those within M of the best score, if it has at least k times the votes of the second most voted.
    Titles without a year are untouched (D6)."""
    def decide(q, cands, T_, M_):
        d, ref, why = me.decide(q, cands, T_, M_)
        if d != "review" or why != "ambiguous" or q["year"] is None:
            return d, ref, why
        sc = sorted(((me.score(q, c)[0], c) for c in cands), key=lambda x: -x[0])
        tied = sorted((c for s, c in sc if sc[0][0] - s < M_), key=lambda c: -(c.get("vote_count") or 0))
        v1, v2 = tied[0].get("vote_count") or 0, tied[1].get("vote_count") or 0
        return ("auto", tied[0]["ref"], "ok_votes") if v1 >= k * max(v2, 1) else (d, ref, why)
    return decide


def variants(res_out):
    """Prints and stores the exploratory variants (in-sample: they were designed after seeing the TMDB misses)."""
    rows = []
    loaded = {p: load(p) for p in ("wikidata", "tmdb")}
    orig_tnorm = me.tnorm
    for name, prov, norm, dec in (("v2 (riferimento)", "wikidata", None, None), ("v2 (riferimento)", "tmdb", None, None),
                                  ("v2 + normalizzazione Unicode", "wikidata", tnorm_unicode, None),
                                  ("v2 + normalizzazione Unicode", "tmdb", tnorm_unicode, None),
                                  ("v2 + voti x10, solo con anno", "tmdb", None, votes_tiebreak(10)),
                                  ("v2 + voti x100, solo con anno", "tmdb", None, votes_tiebreak(100)),
                                  ("v2 + Unicode + voti x10, solo con anno", "tmdb", tnorm_unicode, votes_tiebreak(10))):
        me.tnorm = norm or orig_tnorm
        data, truth = loaded[prov]
        for s, f in SPLITS.items():
            m = metrics([q for q in data if f(q)], truth, dec)
            rows.append((name, prov, s, m))
        me.tnorm = orig_tnorm
    print("\n| Variante | Provider | Insieme | auto corretti | auto errati | precision | recall su tutte | tasso di auto-match | \"Da verificare\" corretti |")
    print("|---|---|---|---|---|---|---|---|---|")
    for name, prov, s, m in rows:
        print(f"| {name} | {prov} | {s} | {m['auto_ok']} | {m['auto_wrong']} | {100*m['precision']:.1f}% "
              f"| {m['auto_ok']}/{m['real']} = {100*m['recall_all']:.1f}% "
              f"| {m['auto_ok'] + m['auto_wrong']}/{m['queries']} = {100*m['auto_rate']:.1f}% | {m['review_ok']}/{m['should_review']} |")
        if s == "combined" and name != "v2 (riferimento)":
            print(f"|   | | errori: {m['errors']} | mancati: {m['misses']} | | | | | |")
    res_out["variants"] = [{"variant": n, "provider": p, "split": s, **m} for n, p, s, m in rows]


def main():
    res = {}
    for provider in ("wikidata", "tmdb"):
        try:
            data, truth = load(provider)
        except FileNotFoundError as ex:
            print(f"{provider}: missing {ex.filename} (TMDB needs 'match_eval.py dump --provider tmdb')")
            continue
        res[provider] = {s: metrics([q for q in data if f(q)], truth) for s, f in SPLITS.items()}
        if provider == "tmdb" and "--what-if" in sys.argv:
            res["what_if_popularity"] = what_if_popularity(data, truth)
    print(f"T={T:.2f} M={M:.2f} scorer=v2")
    print("| Provider | Insieme | query | opere reali (candidato giusto in lista) | auto corretti | auto errati "
          "| precision [IC 95%] | recall, candidato presente [IC 95%] | recall su tutte | tasso di auto-match "
          "| auto senza anno (corretti) | \"Da verificare\" corretti |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for provider, splits in res.items():
        if provider == "what_if_popularity":
            continue
        for s, m in splits.items():
            pl, ph = m["precision_ci95"]
            rl, rh = m["recall_in_list_ci95"]
            ny = m["noyear_auto"]
            print(f"| {provider} | {s} | {m['queries']} | {m['real']} ({m['in_list']}) | {m['auto_ok']} | {m['auto_wrong']} "
                  f"| {100*m['precision']:.1f}% [{100*pl:.0f}–{100*ph:.0f}] "
                  f"| {m['auto_ok']}/{m['in_list']} = {100*m['recall_in_list']:.1f}% [{100*rl:.0f}–{100*rh:.0f}] "
                  f"| {m['auto_ok']}/{m['real']} = {100*m['recall_all']:.1f}% "
                  f"| {m['auto_ok'] + m['auto_wrong']}/{m['queries']} = {100*m['auto_rate']:.1f}% "
                  f"| {len(ny)} ({sum(ok for _, ok in ny)}) | {m['review_ok']}/{m['should_review']} |")
    for provider in ("wikidata", "tmdb"):
        if provider in res:
            m = res[provider]["combined"]
            print(f"\n{provider} combined: errors={m['errors']}\n  misses={m['misses']}\n  reasons={m['real_to_review_reasons']}")
    if "what_if_popularity" in res:
        w = res["what_if_popularity"]
        print("\nwhat-if popularity (no-year titles):", {k: v for k, v in w.items() if k != "rows"})
        for r in w["rows"]:
            print("  ", r)
    if "--what-if" in sys.argv and "tmdb" in res:
        variants(res)
    (me.OUT / "compare_eval.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
