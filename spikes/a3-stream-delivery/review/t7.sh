#!/bin/sh
# Review check: E1 without the -ss back-off confound. Long Test (GOP 2 s on the grid) and the off-grid open-GOP fixture.
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg
W=/tmp/w; mkdir -p $W; cd /s
$FF -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=24000/1001 -t 60 \
  -c:v libx265 -preset ultrafast -x265-params "open-gop=1:keyint=29:min-keyint=29:scenecut=0:bframes=4:log-level=error" $W/og.mkv
LT="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
hls() { # name file ss start_number
  rm -rf $W/$1; mkdir -p $W/$1
  $FF -hide_banner -loglevel error $3 -t 24 -i "$2" -map 0:v:0 -c:v copy -tag:v hvc1 -copyts -avoid_negative_ts disabled -f hls -hls_time 4 -hls_segment_type fmp4 \
    -hls_playlist_type vod -start_number $4 -hls_segment_options movflags=+frag_discont -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$W/$1/seg-%05d.m4s" $W/$1/main.m3u8
  echo "## $1 [$3]: $(node mp4inspect.mjs frags $W/$1/init.mp4 $(ls $W/$1/seg-*.m4s | head -5) | awk -F'\t' '$2==1{printf "%s@%s ", $1, $4}')"
}
hls lt0 "$LT" "" 0
hls lt12 "$LT" "-noaccurate_seek -ss 12.135" 3
hls og0 $W/og.mkv "" 0
hls og15 $W/og.mkv "-noaccurate_seek -ss 15.859" 4
