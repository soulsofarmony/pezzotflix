"""S5 (throwaway): how much player buffer a file needs at a given sustained throughput (leaky bucket).

For a per-second bitrate profile b[i] and a constant network rate T, the buffer that avoids any stall is the
largest deficit over any interval: max over a<=b of sum(b[a..b]) - T*(b-a+1). It must be filled before the
interval starts (start-up or quieter scenes). Also reports the windowed peaks and, for a measured throughput trace,
the same deficit with the real per-second rates repeated in a loop.
Usage: python -I net_model.py out/results/bitrate-2001.json [throughput-trace.json ...]
"""
import json
import pathlib
import sys


def max_deficit_bits(rates_bps: list[float], net_bps) -> float:
    # Kadane over (rate - net): the worst cumulative excess of consumption over download.
    best = cur = 0.0
    for i, r in enumerate(rates_bps):
        n = net_bps(i)
        cur = max(0.0, cur + r - n)
        best = max(best, cur)
    return best


def peaks(rates: list[float], w: int) -> float:
    if len(rates) < w:
        return sum(rates) / len(rates)
    s = sum(rates[:w])
    best = s
    for i in range(w, len(rates)):
        s += rates[i] - rates[i - w]
        best = max(best, s)
    return best / w


files = json.loads(pathlib.Path(sys.argv[1]).read_text())
traces = [json.loads(pathlib.Path(p).read_text()) for p in sys.argv[2:]]
out = []
for f in files:
    r = [x * 1e6 for x in f["perSecMbps"]]
    avg = sum(r) / len(r)
    row = {"file": f["file"], "avgMbps": round(avg / 1e6, 1)}
    for w in (1, 5, 30, 60, 300):
        row[f"peak{w}sMbps"] = round(peaks(r, w) / 1e6, 1)
    row["bufferNeeded"] = {}
    for t in (20, 25, 30, 35, 40, 50, 60, 80):
        bits = max_deficit_bits(r, lambda i, t=t: t * 1e6)
        row["bufferNeeded"][t] = {"MB": round(bits / 8 / 1e6, 1), "sAtAvg": round(bits / avg, 1)}
    for tr in traces:
        per = [x * 1e6 for x in tr["perSecMbps"]]
        bits = max_deficit_bits(r, lambda i, per=per: per[i % len(per)])
        row["bufferNeeded"][f"trace:{tr.get('label', '?')}"] = {"MB": round(bits / 8 / 1e6, 1), "sAtAvg": round(bits / avg, 1)}
    out.append(row)
    print(json.dumps(row))
pathlib.Path(sys.argv[1]).with_name(pathlib.Path(sys.argv[1]).stem + "-buffer-model.json").write_text(json.dumps(out, indent=1))
