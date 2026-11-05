"""S2 follow-up (throwaway): which tone ends up in which decoded channel of the AAC 5.1 probes.

The probes from boxes.sh carry one tone per input channel: FL 300, FR 500, FC 700, LFE 60,
SL/BL 900, SR/BR 1100 Hz. Each file is decoded with the ffmpeg on PATH to raw s16le, in the
decoder's own channel order, and a Goertzel filter measures each tone on every channel over
one second (2-3 s). Prints a markdown table.

  python -I spikes/s2-browser-playback/chanmap.py [boxes_dir]
"""

import math
import pathlib
import struct
import subprocess
import sys

TONES = {"FL": 300, "FR": 500, "FC": 700, "LFE": 60, "SL/BL": 900, "SR/BR": 1100}
RATE, START, LEN = 48000, 2 * 48000, 48000
NAMES = ("side", "back", "side-aformat", "back-aformat", "side-ac6")


def decode(path):
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_frames", "-read_intervals", "%+#5",
         "-show_entries", "frame=channels,channel_layout", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.split()[0]
    channels, layout = probe.split(",")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-c:a", "pcm_s16le", "-"],
                         capture_output=True, check=True).stdout
    n = int(channels)
    samples = struct.unpack(f"<{len(raw) // 2}h", raw)
    return layout, [samples[c::n][START:START + LEN] for c in range(n)]


def goertzel_db(x, freq):
    k = 2 * math.cos(2 * math.pi * freq / RATE)
    s1 = s2 = 0.0
    for v in x:
        s1, s2 = v + k * s1 - s2, s1
    power = s1 * s1 + s2 * s2 - k * s1 * s2
    amp = 2 * math.sqrt(max(power, 0.0)) / len(x) / 32768  # peak amplitude, full scale = 1
    return 20 * math.log10(amp) if amp > 0 else -200.0


def main():
    default = pathlib.Path(__file__).resolve().parent / "out" / "boxes"
    root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else default
    print("| Build | Probe | Decoded layout | Decoded ch0..ch5: dominant tone (dBFS) |")
    print("|---|---|---|---|")
    for build in sorted(p for p in root.iterdir() if p.is_dir()):
        for name in NAMES:
            f = build / "aac" / f"{name}.mp4"
            if not f.exists():
                continue
            layout, chans = decode(f)
            cells = []
            for x in chans:
                levels = {label: goertzel_db(x, hz) for label, hz in TONES.items()}
                best = max(levels, key=levels.get)
                others = max(v for k, v in levels.items() if k != best)
                cells.append(f"{best} {TONES[best]} Hz ({levels[best]:.1f}; next {others:.1f})")
            print(f"| {build.name} | {name} | {layout} | " + " ; ".join(cells) + " |")


if __name__ == "__main__":
    main()
