#!/bin/sh
# Review check: two-pass PGS extraction on a real PGS track (E5d), with and without -copyts.
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg; FP=/usr/lib/jellyfin-ffmpeg/ffprobe
F="/m/library/movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv"
W=/tmp/w; mkdir -p $W
pk() { $FP -v error -show_entries packet=pts_time,size -of csv=p=0 "$1" | tr '\n' ' '; echo; }
$FF -hide_banner -loglevel error -y -i "$F" -map 0:4 -c copy $W/full.sup; echo "full:            $(pk $W/full.sup)"
echo "source packets:  $($FP -v error -select_streams 4 -show_entries packet=pts_time,size -of csv=p=0 "$F" | tr '\n' ' ')"
for X in 5 6.5; do
  $FF -hide_banner -loglevel error -y -noaccurate_seek -ss $X -i "$F" -map 0:4 -c copy $W/p1n.sup; echo "X=$X pass1 no copyts: $(pk $W/p1n.sup)"
  $FF -hide_banner -loglevel error -y -noaccurate_seek -ss $X -i "$F" -map 0:4 -c copy -copyts $W/p1c.sup; echo "X=$X pass1 copyts:    $(pk $W/p1c.sup)"
  X1=$($FP -v error -show_entries packet=pts_time -of csv=p=0 $W/p1c.sup | head -1)
  $FF -hide_banner -loglevel error -y -t $X1 -i "$F" -map 0:4 -c copy -copyts $W/p2.sup; echo "X=$X pass2 -t $X1:   $(pk $W/p2.sup)"
  cat $W/p2.sup $W/p1c.sup > $W/m.sup; cmp -s $W/m.sup $W/full.sup && echo "  merged == full" || echo "  merged != full: $(pk $W/m.sup)"
done
