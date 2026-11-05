#!/bin/sh
# Review check: does a .sup extracted from a real PGS track grow with the read position, with and without -flush_packets 1?
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg
F="/m/library/movies/Il Buono, il Brutto, il Cattivo (1966)/Il.Buono.il.Brutto.il.Cattivo.1966.1080p.BluRay.REMUX.mkv"
W=/tmp/w; mkdir -p $W
for FL in "-flush_packets 1" ""; do
  rm -f $W/g.sup
  ( $FF -hide_banner -loglevel error -y -readrate 1 -i "$F" -map 0:s:0 -c copy -copyts $FL -f sup $W/g.sup ) &
  P=$!
  out=""; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do sleep 1; out="$out t${i}=$(stat -c %s $W/g.sup 2>/dev/null)"; done
  kill $P 2>/dev/null; wait $P 2>/dev/null
  echo "[${FL:-no flush}]$out"
done
