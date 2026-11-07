#!/usr/bin/env bash
# S5 (throwaway): Direct Stream (HLS fMP4) from the pzf-s5 stack played on the TV, with a far seek (pipeline restart),
# plus an embedded SRT run on 2001. Usage: bash ds_tests.sh [hls|srt]...  (default: both)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export MSYS_NO_PATHCONV=1
ADB="${ADB:-$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe}"
DEV="${DEV:-192.168.1.8:5555}"; HOST="${HOST:-192.168.1.5}"; PKG=dev.pezzotflix.s5probe
API="http://$HOST:18380"; F="http://$HOST:18381"
a() { "$ADB" -s "$DEV" "$@"; }
enc() { python -I -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }
O2001="$F/$(enc "media/movies/2001 - Odissea nello spazio (1968)/2001 - Odissea nello spazio (1968) - 2160p.mkv")"
D="$HERE/out/results/ds"; mkdir -p "$D"
j() { python -I -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2]) or "")' "$1" "$2"; }

play() { # name maxwait extras...
  local name="$1" maxw="$2"; shift 2
  a shell input keyevent KEYCODE_WAKEUP; a logcat -c
  a shell "am start -S -n $PKG/.PlayerActivity --ez auto true --ef volume 0.05 --es title '$name' $*" >/dev/null
  local t=0
  while [ $t -lt "$maxw" ]; do sleep 2; t=$((t+2)); a logcat -d -s PZF_S5:I | grep -q '"ev":"summary"' && break; done
  a logcat -d -s PZF_S5:I > "$D/$name.log"
  a logcat -d | grep -E -A25 "Exception" | grep -v PZF_S5 | head -80 > "$D/$name.stack.txt"
  echo "[ds] $name (${t}s): $(grep -o '"ev":"summary".*' "$D/$name.log" | head -1 | cut -c1-160)"
}

hls() {
for item in "Blade Runner"; do  # Long Test is not in the stack catalog (not identified)
  w() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
  s=$(python -I "$(w "$HERE/ds_session.py")" "$API" "$item" "$(w "$HERE/out/results/client-caps-noffmpeg.json")")
  echo "$s" | python -I -c 'import json,sys; d=json.load(sys.stdin); d.pop("token"); print(json.dumps(d, ensure_ascii=False))' > "$D/${item// /-}.session.json"
  url=$(j "$s" url); sub=$(j "$s" subUrl); seek=250000; [ "$item" = "Blade Runner" ] && seek=20000
  extra=""; [ -n "$sub" ] && extra="--es subUrl '$sub' --es subMime $(j "$s" subMime) --es subLang ita"
  play "${item// /-}-hls" 90 "--es url '$url' --es mime application/x-mpegURL --es api '$API' --es token '$(j "$s" token)' --es session '$(j "$s" session)' --es ffmpeg off --ei playSec 10 --el seekToMs $seek --ei afterSeekSec 10 $extra"
done
}
# Embedded SRT (eng) in Direct Play on 2001, from 28:00, as Q3 does for the PGS.
srt() { play 2001-srt-eng 70 "--es url '$O2001' --ei subIndex 0 --el startMs 1680000 --ei playSec 40 --es ffmpeg off"; }
for g in ${@:-hls srt}; do "$g"; done
a shell input keyevent KEYCODE_HOME
