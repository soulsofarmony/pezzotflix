#!/usr/bin/env bash
# S5 (throwaway): network runs with the laptop's Wi-Fi band logged every 10 s (the laptop roams between
# 5 GHz and 2.4 GHz on its own; on 2.4 GHz it shares airtime with the TV). Usage: bash net2.sh [runs] [seconds]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export MSYS_NO_PATHCONV=1
ADB="${ADB:-$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe}"
a() { "$ADB" -s "${DEV:-192.168.1.8:5555}" "$@"; }
URL="http://${HOST:-192.168.1.5}:18381/media/movies/Long%20Test%20%282024%29/Long%20Test%20%282024%29%20-%202160p.mkv"
D="$HERE/out/results/net2"; mkdir -p "$D"
RUNS="${1:-3}"; SECS="${2:-180}"
for r in $(seq 1 "$RUNS"); do
  a shell input keyevent KEYCODE_WAKEUP; a logcat -c
  a shell "am start -S -n dev.pezzotflix.s5probe/.NetActivity --es url '$URL' --ei seconds $SECS --es label net2-run$r --ez auto true" >/dev/null
  : > "$D/run$r.band.txt"
  for t in $(seq 1 $((SECS / 10 + 6))); do
    echo "$(date +%H:%M:%S) $(netsh wlan show interfaces | tr -d '\r' | grep -E 'BSSID|GHz' | tr -s ' ' | tr '\n' ' ')" >> "$D/run$r.band.txt"
    a logcat -d -s PZF_S5:I | grep -q netSummary && break
    sleep 10
  done
  a logcat -d -s PZF_S5:I > "$D/run$r.log"
  echo "run$r: $(grep -o '"avgMbps":[0-9.]*\|"medianMbps":[0-9.]*\|"worst5sMbps":[0-9.]*\|"minMbps":[0-9.]*' "$D/run$r.log" | tr '\n' ' ') band: $(grep -c '2,4 GHz\|2.4 GHz' "$D/run$r.band.txt") samples on 2.4 GHz of $(wc -l < "$D/run$r.band.txt")"
done
a shell input keyevent KEYCODE_HOME
