#!/usr/bin/env bash
# S5 (throwaway): drives the probe app on the TV over ADB and saves logs in out/results/<group>/.
# Usage: bash run_tests.sh caps|video|audio|pgs|net|mem|q7|all
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

# run <group> <name> <wait-seconds-max> <am start extras...>
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
      a shell "dumpsys SurfaceFlinger | grep -iE 'dataspace|hdr|BT2020|PQ|HLG' | head -40" > "$d/$name.sf.txt"
      memdone=1
    fi
    a logcat -d -s PZF_S5:I | grep -q '"ev":"summary"' && break
  done
  a logcat -d -s PZF_S5:I > "$d/$name.log"
  a logcat -d | grep -iE "dolby|dovi|hdr|vdec|omx.ms|audio_hw|ms12|passthr|AudioTrack" | grep -v PZF_S5 | tail -150 > "$d/$name.vendor.txt"
  local s; s=$(grep -o '"ev":"summary".*' "$d/$name.log" | head -1 | cut -c1-200)
  echo "[$group] $name (${t}s): ${s:-NO SUMMARY}"
}

caps() {
  mkdir -p "$HERE/out/results"; wake
  a shell "am start -S -n $PKG/.CapsActivity --ez auto true" >/dev/null; sleep 8
  for f in raw-caps.json client-caps.json client-caps-noffmpeg.json; do a pull /sdcard/Android/data/$PKG/files/$f "$(cygpath -m "$HERE/out/results/$f")" >/dev/null; done
  echo "caps pulled"
}

o2001() { # main case: Direct Play, far seeks, PGS ita, both audio tracks, memory
  run o2001 video 90 "--es url '$O2001' --ei subIndex -1 --ei playSec 25 --el seekToMs 7200000 --ei afterSeekSec 15"
  run o2001 video-syncseek 90 "--es url '$O2001' --ei subIndex -1 --ei playSec 15 --el seekToMs 4500000 --ei afterSeekSec 15 --es seekMode sync"
  run o2001 video-tunnel 90 "--es url '$O2001' --ei subIndex -1 --ei playSec 15 --el seekToMs 3600000 --ei afterSeekSec 15 --ez tunnel true"
  run o2001 audio-ac3 60 "--es url '$O2001' --ei subIndex -1 --ei audioIndex 0 --ei playSec 10 --el seekToMs 600000"
  run o2001 audio-aac51 60 "--es url '$O2001' --ei subIndex -1 --ei audioIndex 1 --ei playSec 10 --el seekToMs 600000"
  run o2001 audio-ac3-noffmpeg 60 "--es url '$O2001' --ei subIndex -1 --ei audioIndex 0 --es ffmpeg off --ei playSec 10 --el seekToMs 600000"
  # PGS ita is the third text group (srt eng, srt eng SDH, PGS ita). Densest cue minutes: 28-29 and 64-65 (ffprobe).
  run o2001 pgs-ita 130 "--es url '$O2001' --ei subIndex 2 --el startMs 1680000 --ei playSec 40 --el seekToMs 3840000 --ei afterSeekSec 40"
  MEMAT=50 run o2001 mem-default 100 "--es url '$O2001' --ei subIndex -1 --ei playSec 55 --el seekToMs 3000000 --ei afterSeekSec 10"
  MEMAT=80 run o2001 mem-120s 130 "--es url '$O2001' --ei subIndex -1 --ei playSec 85 --el seekToMs 3000000 --ei afterSeekSec 10 --ei bufferMb 400 --ei minBufSec 120 --ei maxBufSec 120"
}

hot() { # Q5/Q6 on the densest part of 2001 (from 109:25, 36.7 Mb/s over 120 s): default buffer vs a 120 s buffer
  MEMAT=60 run hot default 150 "--es url '$O2001' --ei subIndex -1 --el startMs 6565000 --ei playSec 100 --el seekToMs 6800000 --ei afterSeekSec 10"
  MEMAT=60 run hot cap400-120s 150 "--es url '$O2001' --ei subIndex -1 --el startMs 6565000 --ei playSec 100 --el seekToMs 6800000 --ei afterSeekSec 10 --ei bufferMb 400 --ei minBufSec 120 --ei maxBufSec 120"
  MEMAT=60 run hot cap150-120s 150 "--es url '$O2001' --ei subIndex -1 --el startMs 6565000 --ei playSec 100 --el seekToMs 6800000 --ei afterSeekSec 10 --ei bufferMb 150 --ei minBufSec 120 --ei maxBufSec 120"
}

video() { # Q2: Direct Play over HTTP Range, no subtitles, FFmpeg on (TrueHD tracks need it)
  run video br2049-hdr10 60 "--es url '$BR' --ei subIndex -1"
  run video dune-dv81 60 "--es url '$DUNE' --ei subIndex -1"
  run video opp-dv5 60 "--es url '$OPP' --ei subIndex -1"
  run video buono-1080p 60 "--es url '$BUONO' --ei subIndex -1"
  run video long-4k 90 "--es url '$LONG' --ei subIndex -1 --ei playSec 20 --el seekToMs 250000 --ei afterSeekSec 15"
  run video long-4k-syncseek 90 "--es url '$LONG' --ei subIndex -1 --ei playSec 20 --el seekToMs 250000 --ei afterSeekSec 15 --es seekMode sync"
  run video br2049-tunnel 60 "--es url '$BR' --ei subIndex -1 --ez tunnel true"
  run video dune-dv81-tunnel 60 "--es url '$DUNE' --ei subIndex -1 --ez tunnel true"
}

audio() { # Q1: every track type, FFmpeg extension off and on
  for ff in off on; do
    for i in 0 1 2 3 4 5 6 7; do run audio-$ff ch51-a$i 40 "--es url '$G/canali-5.1-otto-codec.mkv' --ei audioIndex $i --es ffmpeg $ff --ei playSec 6 --el seekToMs 3000"; done
    for i in 0 1 2; do run audio-$ff ch71-a$i 40 "--es url '$G/canali-7.1-tre-codec.mkv' --ei audioIndex $i --es ffmpeg $ff --ei playSec 6 --el seekToMs 3000"; done
    for i in 0 1 2 3; do run audio-$ff cmp-a$i 40 "--es url '$G/confronto-truehd-eac3-flac.mkv' --ei audioIndex $i --es ffmpeg $ff --ei playSec 6 --el seekToMs 3000"; done
    run audio-$ff real-truehd-atmos 40 "--es url '$G/reale-truehd-atmos-7.1.mkv' --es ffmpeg $ff --ei playSec 5 --el seekToMs 2000"
    run audio-$ff real-dtshd-ma 40 "--es url '$G/reale-dts-hd-ma-7.1.mkv' --es ffmpeg $ff --ei playSec 5 --el seekToMs 2000"
    run audio-$ff real-eac3-joc 40 "--es url '$G/reale-eac3-joc-atmos-7.1.mkv' --es ffmpeg $ff --ei playSec 5 --el seekToMs 2000"
  done
}

pgs() { # Q3: embedded PGS in MKV (4K and 1080p), plus a .sup sideloaded as the server serves it in Direct Stream
  run pgs br2049-pgs-forced 70 "--es url '$BR' --ei subIndex 0 --ei playSec 12 --el seekToMs 1000 --ei afterSeekSec 12"
  run pgs br2049-pgs-full 70 "--es url '$BR' --ei subIndex 1 --ei playSec 12 --el seekToMs 1000 --ei afterSeekSec 12"
  run pgs buono-pgs 70 "--es url '$BUONO' --ei subIndex 0 --ei playSec 12 --el seekToMs 1000 --ei afterSeekSec 12"
  run pgs buono-sup-sideload 70 "--es url '$BUONO' --es subUrl '$G/pgs-sample1.sup' --es subMime application/pgs --ei playSec 12 --el seekToMs 1000 --ei afterSeekSec 12"
}

net() { # Q5: sustained throughput, 3 x 180 s
  mkdir -p "$HERE/out/results/net"
  for r in 1 2 3; do
    wake; a logcat -c
    a shell "am start -S -n $PKG/.NetActivity --es url '$LONG' --ei seconds 180 --es label run$r --ez auto true" >/dev/null
    for t in $(seq 1 100); do sleep 3; a logcat -d -s PZF_S5:I | grep -q netSummary && break; done
    a logcat -d -s PZF_S5:I > "$HERE/out/results/net/run$r.log"
    grep -o '"avgMbps":[0-9.]*\|"medianMbps":[0-9.]*\|"worst5sMbps":[0-9.]*\|"minMbps":[0-9.]*' "$HERE/out/results/net/run$r.log" | tr '\n' ' '; echo
  done
}

mem() { # Q6: PSS during 4K playback, Media3 default buffer vs byte caps vs a large time buffer
  MEMAT=40 run mem long-default 80 "--es url '$LONG' --ei subIndex -1 --ei playSec 45 --el seekToMs 200000 --ei afterSeekSec 10"
  MEMAT=40 run mem long-cap64 80 "--es url '$LONG' --ei subIndex -1 --ei playSec 45 --el seekToMs 200000 --ei afterSeekSec 10 --ei bufferMb 64"
  MEMAT=60 run mem long-cap400-120s 100 "--es url '$LONG' --ei subIndex -1 --ei playSec 65 --el seekToMs 200000 --ei afterSeekSec 10 --ei bufferMb 400 --ei minBufSec 120 --ei maxBufSec 120"
  MEMAT=40 run mem br2049-default 80 "--es url '$BR' --ei subIndex -1 --ei playSec 20 --el seekToMs 1000 --ei afterSeekSec 9"
}

q7() { # Q7: through the real API (pzf-s5 stack), StartPlayback with the app's own capabilities
  local d="$HERE/out/results/q7"; mkdir -p "$d"
  for ff in on off; do
    for item in Odissea Blade Dune Oppenheimer; do
      wake; a logcat -c
      a shell "am start -S -n $PKG/.MainActivity --es server http://$HOST:18380 --es autoItem $item --es ffmpeg $ff" >/dev/null
      for t in $(seq 1 30); do sleep 2; a logcat -d -s PZF_S5:I | grep -q '"ev":"summary"' && break; done
      a logcat -d -s PZF_S5:I > "$d/$item-ffmpeg-$ff.log"
      echo "[q7] $item ffmpeg=$ff: $(grep -o '"ev":"summary".*' "$d/$item-ffmpeg-$ff.log" | cut -c1-160)"
    done
  done
}

case "${1:-all}" in
  all) caps; o2001; video; audio; pgs; mem; q7; net ;;
  *) "$1" ;;
esac
a shell input keyevent KEYCODE_HOME
