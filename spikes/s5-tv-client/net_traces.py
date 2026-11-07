"""S5 (throwaway): pull the per-second throughput traces out of NetActivity logs into trace JSONs for net_model.py.

Usage: python -I net_traces.py out/results/net/run1.log [...]  -> writes <log>.trace.json next to each log
"""
import json
import pathlib
import statistics
import sys

for p in map(pathlib.Path, sys.argv[1:]):
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        if '"netSummary"' not in line:
            continue
        s = json.loads(line[line.index("{"):])
        per = s["perSecMbps"]
        w5 = [sum(per[i:i + 5]) / 5 for i in range(len(per) - 4)]
        label = f"{p.parent.name}/{s['label']}"
        out = {"label": label, "perSecMbps": per}
        p.with_suffix(".trace.json").write_text(json.dumps(out))
        print(json.dumps({"label": label, "seconds": len(per), "avg": round(statistics.mean(per), 1),
                          "median": round(statistics.median(per), 1), "min1s": min(per),
                          "p5": round(sorted(per)[len(per) // 20], 1), "worst5s": round(min(w5), 1),
                          "best5s": round(max(w5), 1), "secsBelow40": sum(x < 40 for x in per),
                          "secsBelow20": sum(x < 20 for x in per)}))
