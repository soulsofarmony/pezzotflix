"""Evaluate filename/path parsers on corpus.json (and holdout.json).

Approaches:
  guessit   - guessit on the full relative path, type hint from the root
  parsett   - PTT (parsett) on the basename, missing fields filled from parent dirs
  rules     - hand-written convention parser (rules.py)
  hybrid    - rules.py structure + guessit as tokenizer for names

Usage: python parse_eval.py [corpus.json ...]   -> out/parse_<corpus>.json + markdown tables on stdout
"""
from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
from collections import defaultdict
from pathlib import Path

from guessit import guessit
from PTT import parse_title

import rules

HERE = Path(__file__).parent
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)
SUB_EXT = rules.SUB_EXT


def norm(s):
    if s is None:
        return None
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c)).casefold()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip() or None


def _lang2(v):
    if v is None:
        return None
    if isinstance(v, list):
        v = v[0] if v else None
        if v is None:
            return None
    a2 = getattr(v, "alpha2", None)
    if a2:
        return a2
    s = str(v).lower()
    return rules.LANG.get(s, s[:2])


def _as_list(v):
    if v is None:
        return None
    return v if isinstance(v, list) else [v]


EXTRA_HINTS = {"Trailer": "trailer", "Extras": "other", "Bonus": "other", "Behind the Scenes": "behind-the-scenes",
               "Deleted Scenes": "deleted-scene", "Featurette": "featurette", "Interview": "interview"}


# ---------------------------------------------------------------- guessit
def run_guessit(path, root):
    opts = {}
    if root == "movies":
        opts["type"] = "movie"
    elif root == "series":
        opts["type"] = "episode"
    g = dict(guessit(path, opts))
    ext = path.rsplit(".", 1)[-1].lower()
    other = _as_list(g.get("other")) or []
    res = {"kind": g.get("type"), "title": g.get("title"), "year": g.get("year"), "season": g.get("season"),
           "episodes": _as_list(g.get("episode")), "edition": g.get("edition"),
           "part": g.get("part") or g.get("cd") or g.get("disc"), "extra_type": None, "extra_of": None,
           "lang": None, "forced": None, "sdh": None}
    if isinstance(res["edition"], list):
        res["edition"] = " ".join(res["edition"])
    if isinstance(res["season"], list):
        res["season"] = res["season"][0]
    if "Sample" in other:
        res["kind"] = "ignore"
    elif ext in SUB_EXT:
        res["kind"] = "sidecar"
        res["lang"] = _lang2(g.get("subtitle_language") or g.get("language"))
        res["forced"] = "Forced" in other or "forced" in str(g.get("episode_title", "")).lower()
        res["sdh"] = "Hearing Impaired" in other or "Closed Caption" in other
    else:
        hit = [EXTRA_HINTS[o] for o in other if o in EXTRA_HINTS]
        if hit:
            res["kind"] = "extra"
            res["extra_type"] = hit[0]
            res["extra_of"] = g.get("title")
    return res


# ---------------------------------------------------------------- parsett
def _ptt(name):
    p = parse_title(name)
    return p


def run_parsett(path, root):
    segs = path.split("/")
    p = _ptt(segs[-1])
    ext = segs[-1].rsplit(".", 1)[-1].lower()
    res = {"kind": "episode" if p.get("episodes") else "movie", "title": p.get("title") or None,
           "year": p.get("year"), "season": (p.get("seasons") or [None])[0], "episodes": p.get("episodes") or None,
           "edition": p.get("edition"), "part": None, "extra_type": None, "extra_of": None,
           "lang": None, "forced": None, "sdh": None}
    # fill missing title/year from parent folders (nearest first)
    for d in reversed(segs[:-1]):
        q = _ptt(d)
        if res["year"] is None and q.get("year"):
            res["year"] = q.get("year")
            if res["kind"] == "episode":
                res["title"] = q.get("title") or res["title"]
        if not res["title"] and q.get("title"):
            res["title"] = q.get("title")
        if res["season"] is None and q.get("seasons"):
            res["season"] = q["seasons"][0]
    if root == "series" and res["episodes"]:
        res["kind"] = "episode"
    if ext in SUB_EXT:
        res["kind"] = "sidecar"
        langs = p.get("languages") or []
        res["lang"] = langs[0][:2] if langs else None
        res["forced"] = "forced" in segs[-1].lower()
        res["sdh"] = None
    if p.get("extras"):
        res["kind"] = "extra"
        res["extra_type"] = EXTRA_HINTS.get(p["extras"][0].title(), "other")
        res["extra_of"] = None
    return res


# ---------------------------------------------------------------- rules / hybrid
def run_rules(path, root):
    return rules.parse(path, root)


_orig_parse_name = rules.parse_name


def _parse_name_guessit(name):
    base = _orig_parse_name(name)
    if base.get("junk"):
        return base
    g = dict(guessit(name + ".mkv", {"type": "movie"}))
    ed = g.get("edition")
    if isinstance(ed, list):
        ed = " ".join(ed)
    return {"title": g.get("title"), "year": g.get("year"), "edition": ed or base["edition"],
            "part": g.get("part") or g.get("cd") or g.get("disc") or base["part"]}


def run_hybrid(path, root):
    rules.parse_name = _parse_name_guessit
    try:
        return rules.parse(path, root)
    finally:
        rules.parse_name = _orig_parse_name


APPROACHES = {"guessit": run_guessit, "parsett": run_parsett, "rules": run_rules, "hybrid": run_hybrid}
FIELDS = ["kind", "title", "year", "season", "episodes", "edition", "part", "extra_type", "extra_of", "lang", "forced", "sdh"]


def field_ok(field, expv, got):
    if field in ("title", "edition", "extra_of"):
        # compact compare: punctuation/spacing/accents/case-insensitive ("Director's" == "Directors");
        # for editions the words "edition"/"the" are not significant
        def c(v):
            v = norm(v)
            if v is None:
                return None
            if field == "edition":
                v = re.sub(r"(edition|the)", " ", v)
            return v.replace(" ", "") or None
        if expv is None:
            return c(got) is None
        return c(got) in {c(x) for x in expv}
    if field == "episodes":
        return (list(got) if got else None) == expv
    if field in ("forced", "sdh"):
        return bool(got) == bool(expv)
    return got == expv


def evaluate(corpus_path):
    data = json.loads(Path(corpus_path).read_text(encoding="utf-8"))["entries"]
    report = {}
    for name, fn in APPROACHES.items():
        t0 = time.perf_counter()
        rows = []
        for e in data:
            try:
                got = fn(e["path"], e["root"])
            except Exception as ex:  # a crash counts as all-wrong
                got = {"error": repr(ex)}
            checks = {f: field_ok(f, e["exp"][f], got.get(f)) for f in FIELDS if f in e["exp"]}
            rows.append({"id": e["id"], "cat": e["cat"], "path": e["path"], "got": {k: got.get(k) for k in FIELDS + ["reasons"] if k in got},
                         "checks": checks, "ok": all(checks.values())})
        dt = (time.perf_counter() - t0) / len(data) * 1000
        report[name] = {"rows": rows, "ms_per_path": dt}
    return data, report


def tables(data, report, label):
    lines = [f"\n### {label} ({len(data)} entries)\n"]
    names = list(report)
    lines.append("| Campo | n | " + " | ".join(names) + " |")
    lines.append("|---|---|" + "---|" * len(names))
    for f in FIELDS:
        n = sum(1 for e in data if f in e["exp"])
        if not n:
            continue
        cells = []
        for a in names:
            ok = sum(1 for r in report[a]["rows"] if f in r["checks"] and r["checks"][f])
            cells.append(f"{ok}/{n} ({100*ok/n:.0f}%)")
        lines.append(f"| {f} | {n} | " + " | ".join(cells) + " |")
    cells = []
    for a in names:
        ok = sum(r["ok"] for r in report[a]["rows"])
        cells.append(f"**{ok}/{len(data)} ({100*ok/len(data):.0f}%)**")
    lines.append(f"| **entry completa** | {len(data)} | " + " | ".join(cells) + " |")
    cells = [f"{report[a]['ms_per_path']:.2f}" for a in names]
    lines.append("| ms per path | | " + " | ".join(cells) + " |")

    cats = sorted({e["cat"] for e in data}, key=lambda c: [e["cat"] for e in data].index(c))
    lines.append("\n| Categoria | n | " + " | ".join(names) + " |")
    lines.append("|---|---|" + "---|" * len(names))
    for c in cats:
        n = sum(1 for e in data if e["cat"] == c)
        cells = [f"{sum(r['ok'] for r in report[a]['rows'] if r['cat'] == c)}/{n}" for a in names]
        lines.append(f"| {c} | {n} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


if __name__ == "__main__":
    corpora = sys.argv[1:] or [str(HERE / "corpus.json")]
    for cp in corpora:
        data, report = evaluate(cp)
        stem = Path(cp).stem
        (OUT / f"parse_{stem}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        md = tables(data, report, stem)
        (OUT / f"parse_{stem}.md").write_text(md, encoding="utf-8")
        print(md)
        # failure listing
        with open(OUT / f"failures_{stem}.txt", "w", encoding="utf-8") as fh:
            for a, rep in report.items():
                for r in rep["rows"]:
                    if not r["ok"]:
                        bad = [f for f, v in r["checks"].items() if not v]
                        fh.write(f"[{a}] {r['id']} {r['path']}\n    bad={bad} got={ {k: r['got'].get(k) for k in bad} }\n")
