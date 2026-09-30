#!/usr/bin/env bash
# S1 (throwaway): download public test sources into media-samples/sources.
set -euo pipefail
DEST="$(dirname "$0")/../../media-samples/sources"
mkdir -p "$DEST"
JF=https://repo.jellyfin.org/test-videos
get() { [ -s "$DEST/$2" ] || curl -fL --retry 3 -o "$DEST/$2" "$1"; }
get "$JF/SDR/AVC/Test%20Jellyfin%201080p%20AVC%2030M.mp4"                "jf-1080p-avc-30M.mp4"
get "$JF/HDR/HDR10/HEVC/Test%20Jellyfin%204K%20HEVC%20HDR10%20100M.mp4"  "jf-4k-hevc-hdr10-100M.mp4"
get "$JF/HDR/Dolby%20Vision/Test%20Jellyfin%204K%20DV%20P8.1.mp4"        "jf-4k-dv-p8.1.mp4"
get "$JF/HDR/Dolby%20Vision/Test%20Jellyfin%204K%20DV%20P5.mp4"          "jf-4k-dv-p5.mp4"
PGS=https://raw.githubusercontent.com/C0bra5/PGS-Subtitle-Parser/master/sample
get "$PGS/sup1.sup" "pgs-sample1.sup"
get "$PGS/sup2.sup" "pgs-sample2.sup"
ls -la "$DEST"
