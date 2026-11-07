#!/usr/bin/env bash
# S5 (throwaway): real audio bitstreams from the FFmpeg FATE suite, into out/sources/ (gitignored, never media-samples/).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HERE/out/sources"
cd "$HERE/out/sources"
for u in truehd/atmos.thd dts/master_audio_7.1_24bit.dts dts/dtsx_7.1.4_24bit.dts dts/dcadec-suite/xll_51_24_48_768.dtshd \
         eac3/the_great_wall_7.1.eac3 eac3/serenity_english_5.1_1536_small.eac3; do
  [ -s "$(basename "$u")" ] || curl -sSf -o "$(basename "$u")" "https://fate-suite.ffmpeg.org/$u"
done
ls -la
