"""S1 (throwaway): probe every media file under media-samples/library with ffprobe
and map the raw output to the fields required by the domain model (doc 01 §4).

Writes out/probe-raw/<name>.json (full ffprobe) and out/summary.md (model view).
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "media-samples" / "library"
OUT = Path(__file__).resolve().parent / "out"
MEDIA_EXT = {".mkv", ".mp4", ".m2ts"}
IMAGE_SUBS = {"hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"}
LOSSLESS_AUDIO = {"truehd", "mlp", "flac", "alac"} | {f"pcm_{x}" for x in ("s16le", "s24le", "s32le", "bluray")}


def ffprobe(path: Path) -> dict:
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
           "-show_chapters", str(path)]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", check=True).stdout)


def first_frame_side_data(path: Path) -> list:
    """HDR10 mastering display / content light level live in frame side data."""
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
           "-show_frames", "-show_entries", "frame=side_data_list", "-print_format", "json", str(path)]
    frames = json.loads(subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8").stdout or "{}").get("frames", [])
    return frames[0].get("side_data_list", []) if frames else []


def hdr_format(stream: dict, frame_sd: list) -> str:
    sd_types = {sd.get("side_data_type") for sd in stream.get("side_data_list", [])}
    dovi = next((sd for sd in stream.get("side_data_list", []) if "DOVI" in sd.get("side_data_type", "")), None)
    trc = stream.get("color_transfer")
    frame_types = {sd.get("side_data_type") for sd in frame_sd}
    base = {"smpte2084": "HDR10" if "Mastering display metadata" in frame_types else "PQ",
            "arib-std-b67": "HLG"}.get(trc, "SDR")
    if any("HDR Dynamic Metadata SMPTE2094-40" in t for t in frame_types):
        base = "HDR10+"
    if dovi:
        compat = dovi.get("dv_bl_signal_compatibility_id")
        return f"DV p{dovi.get('dv_profile')} (BL compat {compat} → {base})"
    return base if sd_types is not None else base


def summarize(path: Path, data: dict) -> str:
    fmt = data["format"]
    rel = path.relative_to(LIB)
    lines = [f"### `{rel.as_posix()}`",
             f"- container: `{fmt.get('format_name')}` · durata {float(fmt.get('duration', 0)):.1f}s · "
             f"bitrate {int(fmt.get('bit_rate', 0)) / 1e6:.1f} Mbps · size {int(fmt['size']) / 1e6:.1f} MB",
             f"- capitoli: {len(data.get('chapters', []))}",
             "", "| # | tipo | codec | profilo | lingua | titolo | flag | dettagli |", "|---|---|---|---|---|---|---|---|"]
    for s in data["streams"]:
        tags, disp = s.get("tags", {}), s.get("disposition", {})
        flags = ",".join(k for k, v in disp.items() if v and k in {"default", "forced", "comment", "hearing_impaired", "attached_pic"})
        t = s["codec_type"]
        if t == "video":
            detail = (f"{s.get('width')}x{s.get('height')} · {s.get('pix_fmt')} · {s.get('r_frame_rate')} · "
                      f"{hdr_format(s, first_frame_side_data(path))} · "
                      f"prim={s.get('color_primaries')} trc={s.get('color_transfer')}")
        elif t == "audio":
            lossless = s.get("codec_name") in LOSSLESS_AUDIO
            detail = (f"{s.get('channels')}ch {s.get('channel_layout')} · {s.get('sample_rate')} Hz · "
                      f"{'lossless' if lossless else 'lossy'}")
        elif t == "subtitle":
            detail = "immagine" if s.get("codec_name") in IMAGE_SUBS else "testo"
        else:
            detail = ""
        lines.append(f"| {s['index']} | {t} | {s.get('codec_name')} | {s.get('profile', '')} | "
                     f"{tags.get('language', '')} | {tags.get('title', '')} | {flags} | {detail} |")
    sidecars = sorted(p.name for p in path.parent.glob(path.stem + ".*.srt"))
    if sidecars:
        lines.append(f"\n- sidecar: {', '.join(sidecars)}")
    return "\n".join(lines) + "\n"


def main() -> int:
    raw_dir = OUT / "probe-raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in LIB.rglob("*") if p.suffix.lower() in MEDIA_EXT)
    parts = ["# S1 — probe summary\n"]
    for p in files:
        data = ffprobe(p)
        (raw_dir / (p.stem + ".json")).write_text(json.dumps(data, indent=2), encoding="utf-8")
        parts.append(summarize(p, data))
    (OUT / "summary.md").write_text("\n".join(parts), encoding="utf-8")
    print(f"probed {len(files)} files -> {OUT / 'summary.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
