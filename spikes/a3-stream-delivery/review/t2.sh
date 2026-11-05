#!/bin/sh
FP=/usr/lib/jellyfin-ffmpeg/ffprobe
for f in /m/library/movies/*/*.mkv; do
  echo "## $(basename "$f") size=$(stat -c %s "$f") dur=$($FP -v error -show_entries format=duration -of csv=p=0 "$f")"
  $FP -v error -select_streams s -show_entries stream=index,codec_name:stream_tags=language -of csv=p=0 "$f" | tr '\n' ' '; echo
  for s in $($FP -v error -select_streams s -show_entries stream=index -of csv=p=0 "$f"); do
    n=$($FP -v error -select_streams $s -show_entries packet=pts_time -of csv=p=0 "$f" | awk -F, '$1>0' | wc -l)
    r=$($FP -v error -select_streams $s -show_entries packet=pts_time -of csv=p=0 "$f" | awk -F, '$1>0' | sed -n '1p;$p' | tr '\n' ' ')
    echo "   stream $s packets_pts>0=$n range=$r"
  done
  $FP -v error -select_streams v:0 -show_entries stream=codec_name,has_b_frames,avg_frame_rate,r_frame_rate -of csv=p=0 "$f"
done
