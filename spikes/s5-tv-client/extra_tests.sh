#!/usr/bin/env bash
# S5 (throwaway): drives the probe app on the TV over ADB and saves logs in out/results/<group>/.
# Usage: bash extra_tests.sh flac|pair|hotlh  (added after the first round; same helpers as run_tests.sh)
# Needs: the app installed, serve.sh running (port 18381); for q7 the pzf-s5 stack on 18380.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export MSYS_NO_PATHCONV=1
ADB="${ADB:-$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe}"
DEV="${DEV:-192.168.1.8:5555}"
HOST="${HOST:-192.168.1.5}"
F="http://$HOST:18381"
PKG=dev.pezzotflix.s5probe
a() { "$ADB" -s "$DEV" "$@"; }
# The TV goes to standby on its own: wake it before every run (no settings are changed).
wake() { a shell input keyevent KEYCODE_WAKEUP; }
enc() { python -I -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

BR="$F/$(enc "media/movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv")"
DUNE="$F/$(enc "media/movies/Dune (2021)/Dune.2021.2160p.UHD.BluRay.REMUX.DV.HDR.mkv")"
OPP="$F/$(enc "media/movies/Oppenheimer (2023)/Oppenheimer (2023).mkv")"
BUONO="$F/$(enc "media/movies/Il Buono, il Brutto, il Cattivo (1966)/Il.Buono.il.Brutto.il.Cattivo.1966.1080p.BluRay.REMUX.mkv")"
LONG="$F/$(enc "media/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv")"
G="$F/gen"
# The owner's typical library file (x265 re-encode, 21.8 GB, 148.8 min, ~19.6 Mb/s): main case.
O2001="$F/$(enc "media/movies/2001 - Odissea nello spazio (1968)/2001 - Odissea nello spazio (1968) - 2160p.mkv")"

# run <group> <name> <wait-seconds-max> <am start extras...>  (as run_tests.sh, plus the Java stack of any error)
run() {
  local group="$1" name="$2" maxw="$3"; shift 3
  local d="$HERE/out/results/$group"; mkdir -p "$d"
  wake; a logcat -c
  a shell "am start -S -n $PKG/.PlayerActivity --ez auto true --ef volume 0.05 --es title '$name' $*" >/dev/null
  local t=0 memdone=0
  while [ $t -lt "$maxw" ]; do
    sleep 2; t=$((t+2))
    if [ $memdone = 0 ] && [ $t -ge "${MEMAT:-14}" ]; then
      a shell dumpsys meminfo $PKG > "$d/$name.meminfo.txt"
      a shell dumpsys media.audio_flinger > "$d/$name.audioflinger.txt"
      memdone=1
    fi
    a logcat -d -s PZF_S5:I | grep -q '"ev":"summary"' && break
  done
  a logcat -d -s PZF_S5:I > "$d/$name.log"
  a logcat -d | grep -E -A25 "Exception|OutOfMemory" | grep -v PZF_S5 | head -80 > "$d/$name.stack.txt"
  local s; s=$(grep -o '"ev":"summary".*' "$d/$name.log" | head -1 | cut -c1-200)
  echo "[$group] $name (${t}s): ${s:-NO SUMMARY}"
}

flac() { # FLAC frame size vs the TV's 32 KB decoder input buffer, MKV and fragmented MP4, no FFmpeg (ADR 0008)
  for ext in mkv mp4; do
    for i in 0 1 2 3; do run flac $ext-a$i 40 "--es url '$G/flac-blocchi.$ext' --ei audioIndex $i --es ffmpeg off --ei playSec 8 --el seekToMs 20000"; done
  done
  run flac cmp-flac-stack 40 "--es url '$G/confronto-truehd-eac3-flac.mkv' --ei audioIndex 2 --es ffmpeg off --ei playSec 8 --el seekToMs 3000"
}

pair() { # the owner's listening pair on 2001: AAC 5.1 decoded on the TV vs E-AC-3 5.1 from the server (ADR 0008)
  for i in 0 1 2; do run pair a$i 40 "--es url '$G/ascolto-2001-aac-vs-eac3.mkv' --ei audioIndex $i --es ffmpeg off --ei subIndex -1 --ei playSec 8 --el seekToMs 60000"; done
}

hotlh() { # Q6 again with largeHeap (512 MB): the 120 s / 400 MB buffer on the densest part of 2001
  MEMAT=60 run hot-largeheap cap400-120s 150 "--es url '$O2001' --ei subIndex -1 --el startMs 6565000 --ei playSec 100 --el seekToMs 6800000 --ei afterSeekSec 10 --ei bufferMb 400 --ei minBufSec 120 --ei maxBufSec 120"
  MEMAT=60 run hot-largeheap default 150 "--es url '$O2001' --ei subIndex -1 --el startMs 6565000 --ei playSec 100 --el seekToMs 6800000 --ei afterSeekSec 10"
}

for g in "$@"; do "$g"; done
a shell input keyevent KEYCODE_HOME
