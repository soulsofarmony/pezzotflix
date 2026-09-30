#!/usr/bin/env bash
# S2 (throwaway): build browser test variants from the S1 fixtures + vendor JS libs.
# Output: spikes/s2-browser-playback/out/{media,vendor}
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LIB="$ROOT/media-samples/library/movies"
M="$HERE/out/media"; V="$HERE/out/vendor"
mkdir -p "$M" "$V"

BR="$LIB/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv"          # 4K HEVC HDR10 + TrueHD/E-AC3/AC3 + PGS/SRT/ASS
BUONO="$LIB/Il Buono, il Brutto, il Cattivo (1966)/Il.Buono.il.Brutto.il.Cattivo.1966.1080p.BluRay.REMUX.mkv" # AVC + DTS/AC3 + PGS
TRAILER="$LIB/Blade Runner 2049 (2017)/extras/Trailer.mkv"                                # AVC + AAC
DUNE="$LIB/Dune (2021)/Dune.2021.2160p.UHD.BluRay.REMUX.DV.HDR.mkv"                      # DV P8.1
OPP="$LIB/Oppenheimer (2023)/Oppenheimer (2023).mkv"                                      # DV P5

FF=(ffmpeg -hide_banner -v error -y)

# --- direct play candidates (original files, served with Range) ---
cp -f "$TRAILER" "$M/d1-avc-aac.mkv"
cp -f "$BUONO"   "$M/d2-avc-dts.mkv"
cp -f "$BR"      "$M/d3-hevc-hdr10-truehd.mkv"
"${FF[@]}" -i "$TRAILER" -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart "$M/d4-avc-aac.mp4"

# --- HLS fMP4 remux variants (video always copied) ---
hls() { # name src tag audio-args...
  local name="$1" src="$2" tag="$3"; shift 3
  rm -rf "$M/$name"; mkdir -p "$M/$name"
  "${FF[@]}" -i "$src" -map 0:v:0 -map 0:a:0 -c:v copy -tag:v "$tag" "$@" \
    -f hls -hls_time 4 -hls_segment_type fmp4 -hls_playlist_type vod -hls_flags independent_segments \
    -hls_fmp4_init_filename init.mp4 "$M/$name/index.m3u8"
}
hls h1-avc-aac          "$TRAILER" avc1 -c:a aac -b:a 192k -ac 2
hls h2-hevc-hdr10-aac   "$BR"      hvc1 -c:a aac -b:a 192k -ac 2
hls h3-hevc-hdr10-flac51 "$BR"     hvc1 -c:a flac
hls h4-hevc-hdr10-eac351 "$BR"     hvc1 -c:a eac3 -b:a 640k
hls h5-hevc-hdr10-ac351 "$BR"      hvc1 -c:a ac3 -b:a 640k
hls h6-dv81-as-hvc1-aac "$DUNE"    hvc1 -c:a aac -b:a 192k -ac 2
hls h7-dv81-as-dvh1-aac "$DUNE"    dvh1 -strict unofficial -c:a aac -b:a 192k -ac 2
hls h8-dv5-as-dvh1-aac  "$OPP"     dvh1 -strict unofficial -c:a aac -b:a 192k -ac 2

# --- progressive fragmented MP4 (native <video>, no MSE) ---
"${FF[@]}" -i "$BR" -map 0:v:0 -map 0:a:0 -c:v copy -tag:v hvc1 -c:a flac \
  -movflags +frag_keyframe+empty_moov+default_base_moof "$M/p1-hevc-hdr10-flac51-frag.mp4"

# --- subtitles: PGS extracted as .sup (what the server would serve), SRT -> WebVTT ---
"${FF[@]}" -i "$BUONO" -map 0:s:0 -c copy "$M/buono-eng-sdh.sup"
"${FF[@]}" -i "$BR"    -map 0:s:0 -c copy "$M/br-ita-forced.sup"
"${FF[@]}" -i "$BR"    -map 0:s:2 -c:s webvtt "$M/br-ita.vtt"
# 1080p AVC HLS of the PGS source (for PGS-over-1080p test)
hls h9-buono-avc-aac "$BUONO" avc1 -c:a aac -b:a 192k -ac 2

# --- vendor libraries (served same-origin: libpgs needs a same-origin worker) ---
curl -fsSL -o "$V/hls.min.js"        https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js
curl -fsSL -o "$V/libpgs.js"         https://cdn.jsdelivr.net/npm/libpgs@0.9.0/dist/libpgs.js
curl -fsSL -o "$V/libpgs.worker.js"  https://cdn.jsdelivr.net/npm/libpgs@0.9.0/dist/libpgs.worker.js

du -sh "$M" "$V"
ls "$M"
