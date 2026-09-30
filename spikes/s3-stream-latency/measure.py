"""S3 (throwaway): measure on-the-fly remux/transcode latency and throughput with ffmpeg.

M1  time-to-first-segment for HLS fMP4 remux (video copy) at various seek offsets and audio modes
M2  full remux throughput (x realtime)
M3  seek accuracy: first output timestamp vs requested offset (with -copyts)
M4  transcode throughput: software vs GPU, tone-mapping, PGS burn-in
Results -> out/results.json and printed table.
"""
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LONG = ROOT / "media-samples/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
PGS_SRC = ROOT / "media-samples/library/movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv"
OUT = Path(__file__).resolve().parent / "out"
HLS = OUT / "hls"
FF = ["ffmpeg", "-hide_banner", "-v", "error", "-nostdin", "-y"]


def hls_first_segment(offset: float, audio: list[str], segs: int = 1) -> dict:
    """Start an HLS fMP4 remux at `offset` and time until `segs` segments are listed in the playlist."""
    shutil.rmtree(HLS, ignore_errors=True)
    HLS.mkdir(parents=True)
    cmd = FF + ["-ss", str(offset), "-copyts", "-i", str(LONG), "-map", "0:v:0", "-map", "0:a:0",
                "-c:v", "copy", "-tag:v", "hvc1", *audio,
                "-f", "hls", "-hls_time", "6", "-hls_segment_type", "fmp4", "-hls_playlist_type", "event",
                "-hls_flags", "independent_segments", str(HLS / "index.m3u8")]
    t0 = time.perf_counter()
    proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)
    first = None
    try:
        while time.perf_counter() - t0 < 60:
            pl = HLS / "index.m3u8"
            if pl.exists():
                n = pl.read_text(encoding="utf-8", errors="ignore").count("#EXTINF")
                if n >= 1 and first is None:
                    first = time.perf_counter() - t0
                if n >= segs:
                    break
            if proc.poll() is not None:
                break
            time.sleep(0.01)
        ready = time.perf_counter() - t0
    finally:
        proc.kill()
        proc.wait()
    init = HLS / "init.mp4"
    first_seg = sorted(HLS.glob("*.m4s"))
    start_pts = None
    if first_seg and init.exists():
        # concatenate init+first segment to probe the first video timestamp (original timeline with -copyts)
        probe_file = OUT / "probe_seg.mp4"
        probe_file.write_bytes(init.read_bytes() + first_seg[0].read_bytes())
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
                            "-show_entries", "frame=pts_time", "-of", "csv=p=0", str(probe_file)],
                           capture_output=True, text=True)
        m = re.search(r"[\d.]+", r.stdout)
        start_pts = float(m.group()) if m else None
    return {"offset": offset, "first_segment_s": round(first, 3) if first else None,
            f"{segs}_segments_s": round(ready, 3), "first_video_pts": start_pts}


def throughput(args: list[str], content_s: float, label: str) -> dict:
    t0 = time.perf_counter()
    r = subprocess.run(FF + args, capture_output=True, text=True)
    wall = time.perf_counter() - t0
    return {"label": label, "ok": r.returncode == 0, "content_s": content_s, "wall_s": round(wall, 2),
            "x_realtime": round(content_s / wall, 2), "err": r.stderr.strip()[-300:] if r.returncode else ""}


def main() -> None:
    OUT.mkdir(exist_ok=True)
    res: dict = {"M1": [], "M2": [], "M4": []}
    audio_modes = {
        "copy(truehd)": ["-c:a", "copy", "-strict", "-2"],
        "flac": ["-c:a", "flac"],
        "eac3": ["-c:a", "eac3", "-b:a", "640k"],
        "aac": ["-c:a", "aac", "-b:a", "256k", "-ac", "2"],
    }
    for name, audio in audio_modes.items():
        for off in (0, 150, 283):
            r = hls_first_segment(off, audio, segs=3)
            r["audio"] = name
            res["M1"].append(r)
            print("M1", r)

    null = ["-f", "null", "-"]
    res["M2"].append(throughput(["-i", str(LONG), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "flac"] + null,
                                300, "remux full 5min, audio->flac"))
    res["M2"].append(throughput(["-i", str(LONG), "-map", "0:a:0", "-c:a", "eac3", "-b:a", "640k"] + null,
                                300, "audio only truehd->eac3"))

    T = 20
    seg = ["-ss", "60", "-t", str(T)]
    sw_tm = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,"
             "zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=1920:1080")
    cases = [
        ("SW decode + SW tonemap + x264 veryfast 1080p",
         seg + ["-i", str(LONG), "-map", "0:v:0", "-vf", sw_tm, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"] + null),
        ("SW decode + libplacebo(Vulkan) tonemap + h264_nvenc 1080p",
         ["-init_hw_device", "vulkan"] + seg + ["-i", str(LONG), "-map", "0:v:0", "-vf",
          "libplacebo=w=1920:h=1080:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p",
          "-c:v", "h264_nvenc", "-preset", "p4", "-b:v", "12M"] + null),
        ("CUDA decode + libplacebo(Vulkan) tonemap + h264_nvenc 1080p",
         ["-init_hw_device", "vulkan", "-hwaccel", "cuda"] + seg + ["-i", str(LONG), "-map", "0:v:0", "-vf",
          "libplacebo=w=1920:h=1080:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p",
          "-c:v", "h264_nvenc", "-preset", "p4", "-b:v", "12M"] + null),
        ("CUDA decode + scale_cuda 4K->1080p HDR kept + hevc_nvenc (no tonemap)",
         ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] + seg + ["-i", str(LONG), "-map", "0:v:0",
          "-vf", "scale_cuda=1920:1080", "-c:v", "hevc_nvenc", "-preset", "p4", "-b:v", "15M"] + null),
        ("4K HDR PGS burn-in: SW decode + overlay + hevc_nvenc 4K 10-bit",
         ["-t", str(T), "-i", str(PGS_SRC), "-filter_complex", "[0:v:0][0:s:0]overlay,format=p010le",
          "-c:v", "hevc_nvenc", "-preset", "p4", "-profile:v", "main10", "-b:v", "40M"] + null),
        ("SW decode only (4K HEVC 10-bit)",
         seg + ["-i", str(LONG), "-map", "0:v:0"] + null),
        ("CUDA decode only (4K HEVC 10-bit)",
         ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] + seg + ["-i", str(LONG), "-map", "0:v:0"] + null),
    ]
    for label, args in cases:
        r = throughput(args, T, label)
        # source is 60 fps: x_realtime=1 means 60 fps. A 24 fps film needs only 0.4x of this.
        r["fps"] = round(r["x_realtime"] * 60, 1)
        res["M4"].append(r)
        print("M4", r)

    (OUT / "results.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    shutil.rmtree(HLS, ignore_errors=True)


if __name__ == "__main__":
    main()
