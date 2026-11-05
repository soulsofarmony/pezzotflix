#!/bin/sh
# Throwaway (ADR 0003). E5d: two-pass subtitle extraction ([X, end) first, then [0, X)) merged by concatenation.
# E6: hevc_metadata=remove_dovi=1 on DV P8.1, NAL types counted on the Annex B stream.
set -u
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg; FP=/usr/lib/jellyfin-ffmpeg/ffprobe
LT="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
H="node /s/helpers.mjs"; W=/tmp/w; rm -rf $W; mkdir -p $W
$H supshift /m/sources/pgs-sample2.sup $W/60s.sup 6 10 && $H supinfo $W/60s.sup
$FF -hide_banner -loglevel error -y -t 60 -i "$LT" -i $W/60s.sup -map 0:v:0 -map 1:0 -c copy $W/fx.mkv
$FF -hide_banner -loglevel error -y -i $W/fx.mkv -map 0:s:0 -c copy $W/full.sup; echo "full:   $($H supinfo $W/full.sup)"
s=$(date +%s%N)
$FF -hide_banner -loglevel error -y -noaccurate_seek -ss 30.2 -i $W/fx.mkv -map 0:s:0 -c copy $W/p1.sup; echo "pass1:  $($H supinfo $W/p1.sup)"
X1=$($H supinfo $W/p1.sup | sed -E 's/.*first=([0-9.]+).*/\1/')
$FF -hide_banner -loglevel error -y -t $X1 -i $W/fx.mkv -map 0:s:0 -c copy $W/p2.sup; echo "pass2:  $($H supinfo $W/p2.sup) (-t $X1)"
cat $W/p2.sup $W/p1.sup > $W/merged.sup; echo "merged: $($H supinfo $W/merged.sup)"
cmp -s $W/full.sup $W/merged.sup && echo "merged == full (byte identical)" || echo "merged != full"
echo "== E6"
DV=/m/sources/jf-4k-dv-p8.1.mp4
$FF -hide_banner -loglevel error -y -t 1 -i $DV -map 0:v:0 -c:v copy -bsf:v hevc_mp4toannexb -f hevc $W/a.hevc; echo "copy:        $($H naltypes $W/a.hevc)"
$FF -hide_banner -loglevel error -y -t 1 -i $DV -map 0:v:0 -c:v copy -bsf:v hevc_metadata=remove_dovi=1,hevc_mp4toannexb -f hevc $W/b.hevc; echo "remove_dovi: $($H naltypes $W/b.hevc)"
$FF -hide_banner -loglevel error -y -t 1 -i $DV -map 0:v:0 -c:v copy -bsf:v dovi_rpu=strip=1,hevc_mp4toannexb -f hevc $W/c.hevc; echo "dovi_rpu strip: $($H naltypes $W/c.hevc)"
$FP -v error -select_streams v:0 -read_intervals %+#1 -show_frames -show_entries frame_side_data=side_data_type -of csv=p=0 $W/b.hevc | sort -u | sed 's/^/  remove_dovi frame side data: /'
$FP -v error -select_streams v:0 -read_intervals %+#1 -show_frames -show_entries frame_side_data=side_data_type -of csv=p=0 $W/a.hevc | sort -u | sed 's/^/  copy frame side data: /'
