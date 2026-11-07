"""S5 (throwaway): bitrate profile of the 4K samples as Direct Play sends them (all streams of the file).

For each file: average, and peak over sliding 1 s / 5 s / 30 s windows, from ffprobe packet sizes and
timestamps. Writes out/results/bitrate.json and prints a table. Usage: python -I bitrate.py FFPROBE FILE...
"""
import json
import pathlib
import subprocess
import sys

ffprobe, files = sys.argv[1], sys.argv[2:]
out_dir = pathlib.Path(__file__).resolve().parent / "out" / "results"
out_dir.mkdir(parents=True, exist_ok=True)
results = []
for f in files:
    p = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "packet=pts_time,dts_time,size", "-of", "csv=p=0", f],
        capture_output=True, text=True, check=True,
    )
    per_s: dict[int, int] = {}
    for line in p.stdout.splitlines():
        parts = line.split(",")
        if len(parts) < 3:
            continue
        t = parts[0] if parts[0] not in ("", "N/A") else parts[1]
        if t in ("", "N/A"):
            continue
        sec = int(float(t))
        per_s[sec] = per_s.get(sec, 0) + int(parts[2])
    n = max(per_s) + 1
    bps = [per_s.get(i, 0) * 8 for i in range(n)]
    size = pathlib.Path(f).stat().st_size
    dur = float(subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f],
                               capture_output=True, text=True, check=True).stdout.strip())

    def peak(w: int) -> float:
        if n < w:
            return sum(bps) / n
        return max(sum(bps[i:i + w]) / w for i in range(n - w + 1))

    r = {
        "file": pathlib.Path(f).name, "durationS": round(dur, 2), "sizeBytes": size,
        "avgMbps": round(size * 8 / dur / 1e6, 1),
        "peak1sMbps": round(peak(1) / 1e6, 1), "peak5sMbps": round(peak(5) / 1e6, 1), "peak30sMbps": round(peak(30) / 1e6, 1),
        "perSecMbps": [round(b / 1e6, 1) for b in bps],
    }
    results.append(r)
    print(f"{r['file'][:60]:60} dur {r['durationS']:7.1f}s avg {r['avgMbps']:6.1f}  peak 1s {r['peak1sMbps']:6.1f}  5s {r['peak5sMbps']:6.1f}  30s {r['peak30sMbps']:6.1f} Mb/s")
(out_dir / "bitrate.json").write_text(json.dumps(results, indent=1))
