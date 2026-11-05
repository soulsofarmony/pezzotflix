#!/bin/sh
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg
F="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
W=/tmp/w; mkdir -p $W; cd /s
MF="+frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets"
CMD="-map 0:v:0 -map 0:a:1 -c:v copy -tag:v hvc1 -c:a copy -copyts -avoid_negative_ts disabled -output_ts_offset 10 -map_metadata -1 -map_chapters -1 -sn -dn -fflags +bitexact -f mp4 -movflags $MF pipe:1"
$FF -hide_banner -loglevel error -nostdin -t 20 -i "$F" $CMD > $W/r0.mp4
$FF -hide_banner -loglevel error -nostdin -noaccurate_seek -ss 16.135 -t 4 -i "$F" $CMD > $W/r1.mp4
echo "run0 frags 24-30: $(node mp4inspect.mjs frags $W/r0.mp4 | awk -F'\t' '$3>=24 && $3<30 {printf "trk%s %s/%s | ", $2,$3,$4}')"
echo "rest frags:       $(node mp4inspect.mjs frags $W/r1.mp4 | head -4 | awk -F'\t' '{printf "trk%s %s/%s | ", $2,$3,$4}')"
echo "run0 GOP@26 first PTS: $(node pts.mjs $W/r0.mp4 25.9 26.5 | cut -c1-80)"
echo "rest GOP@26 first PTS: $(node pts.mjs $W/r1.mp4 25.9 26.5 | cut -c1-80)"
