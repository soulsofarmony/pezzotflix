#!/bin/sh
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg
W=/tmp/w; mkdir -p $W; cd /s
$FF -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=24000/1001 -f lavfi -i sine=f=440:sample_rate=48000 -t 30 \
  -c:v libx265 -preset ultrafast -x265-params "open-gop=1:keyint=29:min-keyint=29:scenecut=0:bframes=4:b-pyramid=1:log-level=error" -c:a ac3 -b:a 384k -ac 6 $W/og.mkv
MF="+frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets"
CMD="-map 0:v:0 -map 0:a:0 -c:v copy -tag:v hvc1 -c:a copy -copyts -avoid_negative_ts disabled -output_ts_offset 10 -map_metadata -1 -map_chapters -1 -sn -dn -fflags +bitexact -f mp4 -movflags $MF pipe:1"
$FF -hide_banner -loglevel error -nostdin -i $W/og.mkv $CMD > $W/r0.mp4
$FF -hide_banner -loglevel error -nostdin -noaccurate_seek -ss 3.764 -t 6 -i $W/og.mkv $CMD > $W/r1.mp4
echo "run0 GOP@13.629: $(node pts.mjs $W/r0.mp4 13.6 14.8)"
echo "rest GOP@13.629: $(node pts.mjs $W/r1.mp4 13.6 14.8)"
echo "run0 GOP@14.838: $(node pts.mjs $W/r0.mp4 14.8 16)"
echo "rest GOP@14.838: $(node pts.mjs $W/r1.mp4 14.8 16)"
