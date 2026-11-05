#!/bin/sh
FP=/usr/lib/jellyfin-ffmpeg/ffprobe
F="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
$FP -v error -select_streams v:0 -show_entries packet=size,flags -of csv=p=0 "$F" | awk -F, '{t+=$1; if ($2 ~ /K/) {k+=$1; n++}} END {printf "keyframe packets=%d avg_kf_bytes=%.0f total_video_bytes=%.0f\n", n, k/n, t}'
