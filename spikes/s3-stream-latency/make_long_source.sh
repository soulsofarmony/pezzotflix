#!/usr/bin/env bash
# S3 (throwaway): 5-min 4K HEVC Main10 HDR10 source with a realistic 2 s GOP + TrueHD 5.1 ita + E-AC3 eng.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/media-samples/sources/jf-4k-hevc-hdr10-100M.mp4"
OUT="$ROOT/media-samples/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
mkdir -p "$(dirname "$OUT")"
DUR=300
ffmpeg -v error -stats -y -stream_loop -1 -i "$SRC" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=$DUR" \
  -map 0:v:0 -map 1:a -map 1:a -t "$DUR" \
  -c:v hevc_nvenc -preset p5 -profile:v main10 -pix_fmt p010le -b:v 60M -maxrate 90M -bufsize 120M \
  -g 120 -bf 3 -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -filter:a:0 "aformat=channel_layouts=5.1" -c:a:0 truehd -strict -2 -metadata:s:a:0 language=ita \
  -filter:a:1 "aformat=channel_layouts=5.1" -c:a:1 eac3 -b:a:1 640k -metadata:s:a:1 language=eng \
  "$OUT"
ls -la "$OUT"
