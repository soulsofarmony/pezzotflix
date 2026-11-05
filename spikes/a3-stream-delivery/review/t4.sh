#!/bin/sh
# Review check: 23.976 fps open-GOP HEVC with B-pyramid, keyframes off the 4 s grid (keyint 29), AC-3 audio.
# Is the seek probe boundary B_k the keyframe where "-noaccurate_seek -ss B_k+0.135" lands? Same tfdt as the run from 0?
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg; FP=/usr/lib/jellyfin-ffmpeg/ffprobe
W=/tmp/w; mkdir -p $W; cd /s
$FF -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=24000/1001 -f lavfi -i sine=f=440:sample_rate=48000 -t 60 \
  -c:v libx265 -preset ultrafast -x265-params "open-gop=1:keyint=29:min-keyint=29:scenecut=0:bframes=4:b-pyramid=1:log-level=error" \
  -c:a ac3 -b:a 384k -ac 6 $W/og.mkv
echo "has_b_frames=$($FP -v error -select_streams v:0 -show_entries stream=has_b_frames -of csv=p=0 $W/og.mkv)"
# keyframe NAL types of the first keyframes (CRA=21, IDR=19/20)
$FF -hide_banner -loglevel debug -t 3 -i $W/og.mkv -map 0:v:0 -c copy -bsf:v trace_headers -f null - 2>&1 | grep -oE "nal_unit_type +[01]+ = (19|20|21)" | awk '{print $NF}' | sort | uniq -c | tr '\n' ' '; echo
IV=$(awk 'BEGIN{for(t=4;t<60;t+=4){printf "%s%d%%+#1",(t>4?",":""),t}}')
$FP -v error -select_streams v:0 -read_intervals "$IV" -show_entries packet=pts_time,flags -of csv=p=0 $W/og.mkv > $W/probe.csv
echo "probe: $(tr '\n' ' ' < $W/probe.csv)"
$FP -v error -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 $W/og.mkv | grep K | cut -d, -f1 > $W/allkf.txt
echo "all keyframes: $(head -20 $W/allkf.txt | tr '\n' ' ')"
MF="+frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets"
CMD="-map 0:v:0 -map 0:a:0 -c:v copy -tag:v hvc1 -c:a copy -copyts -avoid_negative_ts disabled -output_ts_offset 10 -map_metadata -1 -map_chapters -1 -sn -dn -fflags +bitexact -f mp4 -movflags $MF pipe:1"
$FF -hide_banner -loglevel error -nostdin -i $W/og.mkv $CMD > $W/r0.mp4
node mp4inspect.mjs frags $W/r0.mp4 | awk -F'\t' '$2==1{printf "%s/%s ", $3, $4}' > $W/r0v.txt; echo "run0 video tfdt/pts0: $(cut -c1-400 $W/r0v.txt)"
for B in $(cut -d, -f1 $W/probe.csv | sed -n '1p;3p;5p;7p;9p'); do
  SS=$(awk -v b=$B 'BEGIN{printf "%.6f", b+0.135}')
  $FF -hide_banner -loglevel error -nostdin -noaccurate_seek -ss $SS -t 6 -i $W/og.mkv $CMD > $W/rk.mp4
  echo "B=$B ss=$SS restart first frags: $(node mp4inspect.mjs frags $W/rk.mp4 | head -3 | awk -F'\t' '{printf "trk%s tfdt=%s pts0=%s | ", $2,$3,$4}')"
done
