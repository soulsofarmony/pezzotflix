#!/bin/sh
# Throwaway (ADR 0003). E5c redo: a fixture with PGS cues every ~2 s over 60 s (built in /tmp, never in media-samples),
# then (1) extraction from X=30 s to the end at real time: does the .sup grow while ffmpeg runs?
# (2) pass [0, X) + pass [X, end): does concatenation equal a full extraction (same packet PTS list)?
# (3) remove_dovi on DV P8.1, counting NAL types with trace_headers.
set -u
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg; FP=/usr/lib/jellyfin-ffmpeg/ffprobe
LT="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
W=/tmp/w; rm -rf $W; mkdir -p $W
# 6 copies of a 10 s PGS sample, each shifted by 10 s -> cues over 0..60 s
L=$W/list.txt; : > $L; for i in 0 1 2 3 4 5; do printf "file '/m/sources/pgs-sample2.sup'\nduration 10\n" >> $L; done
$FF -hide_banner -loglevel error -y -t 60 -i "$LT" -f concat -safe 0 -i $L -map 0:v:0 -map 1:0 -c copy -t 60 $W/fx.mkv
echo "fixture subtitle packets: $($FP -v error -select_streams s:0 -show_entries packet=pts_time -of csv=p=0 $W/fx.mkv | wc -l)"
$FP -v error -select_streams s:0 -show_entries packet=pts_time -of csv=p=0 $W/fx.mkv > $W/full.pts
echo "== (1) growth at real time from 30.2 s"
( $FF -hide_banner -loglevel error -y -readrate 1 -noaccurate_seek -ss 30.2 -i $W/fx.mkv -map 0:s:0 -c copy -flush_packets 1 -f sup $W/grow.sup ) &
P=$!
for i in 1 2 3 4 5 6; do sleep 2; echo "  t+$((i*2))s bytes=$(stat -c %s $W/grow.sup 2>/dev/null)"; done
kill $P 2>/dev/null; wait $P 2>/dev/null
echo "== (2) split passes"
$FF -hide_banner -loglevel error -y -noaccurate_seek -ss 30.2 -i $W/fx.mkv -map 0:s:0 -c copy -f sup $W/p1.sup
X1=$($FP -v error -show_entries packet=pts_time -of csv=p=0 $W/p1.sup | head -1); echo "  pass1 first pts=$X1"
$FF -hide_banner -loglevel error -y -t $X1 -i $W/fx.mkv -map 0:s:0 -c copy -f sup $W/p2.sup
cat $W/p2.sup $W/p1.sup > $W/merged.sup
$FP -v error -show_entries packet=pts_time -of csv=p=0 $W/merged.sup > $W/merged.pts
echo "  full=$(wc -l < $W/full.pts) p2=$($FP -v error -show_entries packet=pts_time -of csv=p=0 $W/p2.sup | wc -l) p1=$($FP -v error -show_entries packet=pts_time -of csv=p=0 $W/p1.sup | wc -l) merged=$(wc -l < $W/merged.pts)"
if cmp -s $W/full.pts $W/merged.pts; then echo "  merged PTS list == full extraction"; else echo "  DIFF"; diff $W/full.pts $W/merged.pts | head; fi
$FF -hide_banner -loglevel error -y -i $W/fx.mkv -map 0:s:0 -c copy -f sup $W/fullx.sup; cmp $W/fullx.sup $W/merged.sup && echo "  merged bytes == full extraction bytes"
echo "== (3) remove_dovi on DV P8.1: NAL unit types in the first 30 frames"
DV=/m/sources/jf-4k-dv-p8.1.mp4
for B in "" "-bsf:v hevc_metadata=remove_dovi=1"; do
  $FF -hide_banner -loglevel error -y -t 0.5 -i $DV -map 0:v:0 -c:v copy $B -tag:v hvc1 $W/dv.mp4
  $FF -hide_banner -loglevel debug -i $W/dv.mp4 -map 0:v:0 -c:v copy -bsf:v trace_headers -f null - 2>&1 | grep -oE "nal_unit_type +[01]+ = [0-9]+" | awk '{print $NF}' | sort -n | uniq -c | tr '\n' ' ' | sed "s/^/  [${B:-copy}] type counts: /"; echo
  $FP -v error -select_streams v:0 -show_entries stream_side_data=side_data_type -of csv=p=0 $W/dv.mp4 | sed "s/^/  stream side data: /"
done
