#!/bin/sh
# Throwaway (ADR 0003). E4: E-AC-3 copy into fMP4 on a pipe; E5: subtitle extraction cost and a growing .sup;
# E6: hevc_metadata=remove_dovi on a DV P8.1 sample; E7: keyframe list by seek probing.
set -u
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg; FP=/usr/lib/jellyfin-ffmpeg/ffprobe
LT="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
BR="/m/library/movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv"
W=/tmp/w; rm -rf $W; mkdir -p $W
I="node /s/mp4inspect.mjs"
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }

echo "=== E4 E-AC-3 copy, delay_moov instead of empty_moov"
$FF -hide_banner -loglevel error -t 6 -i "$LT" -map 0:v:0 -map 0:a:1 -c copy -tag:v hvc1 -copyts -output_ts_offset 10 \
  -f mp4 -movflags +frag_keyframe+delay_moov+default_base_moof+frag_discont pipe:1 > $W/eac3.mp4 && $I init $W/eac3.mp4 && $I frags $W/eac3.mp4 | head -3

echo "=== E5a sequential read of the 1.66 GB file from the NTFS bind mount (cat), 2 runs"
for r in 1 2; do s=$(date +%s%N); cat "$LT" > /dev/null; t=$(ms $s); echo "cat run$r ms=$t MBps=$(( 1663907 / t ))"; done
echo "=== E5b extract every subtitle track of Blade Runner (373 MB) in one pass vs one track"
s=$(date +%s%N); $FF -hide_banner -loglevel error -i "$BR" -map 0:s:0 -c copy $W/s4.sup; echo "one PGS track ms=$(ms $s) bytes=$(stat -c %s $W/s4.sup)"
s=$(date +%s%N); $FF -hide_banner -loglevel error -i "$BR" -map 0:s:0 -c copy $W/a4.sup -map 0:s:1 -c copy $W/a5.sup -map 0:s:2 -c:s webvtt $W/a6.vtt -map 0:s:3 -c:s webvtt $W/a7.vtt
echo "all 4 tracks ms=$(ms $s)"; ls -l $W/a4.sup $W/a5.sup $W/a6.vtt $W/a7.vtt | awk '{print "  ",$5,$9}'
echo "=== E5c extra .sup output of the remux process, started at 10 s, read at real time: does the file grow?"
( $FF -hide_banner -loglevel error -readrate 1 -noaccurate_seek -ss 10.2 -i "$BR" -map 0:v:0 -c:v copy -tag:v hvc1 -copyts -output_ts_offset 10 \
    -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof+frag_discont $W/remux.mp4 \
    -map 0:s:1 -c:s copy -copyts -flush_packets 1 -f sup $W/grow.sup ) &
P=$!
for i in 1 2 3 4 5 6 7 8; do sleep 2; echo "  t+$((i*2))s grow.sup=$(stat -c %s $W/grow.sup 2>/dev/null) remux.mp4=$(stat -c %s $W/remux.mp4 2>/dev/null)"; done
kill $P 2>/dev/null; wait $P 2>/dev/null
$FP -v error -show_entries packet=pts_time,size -of csv=p=0 $W/grow.sup | head -4 | sed 's/^/  pkt /'
$FP -v error -show_entries packet=pts_time,size -of csv=p=0 $W/a5.sup | head -4 | sed 's/^/  full /'

echo "=== E6 hevc_metadata=remove_dovi=1 on DV P8.1 (sources/jf-4k-dv-p8.1.mp4)"
DV=/m/sources/jf-4k-dv-p8.1.mp4
for bsf in none hevc_metadata=remove_dovi=1; do
  if [ $bsf = none ]; then B=""; else B="-bsf:v $bsf"; fi
  $FF -hide_banner -loglevel error -t 2 -i $DV -map 0:v:0 -c:v copy $B -tag:v hvc1 -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof $W/dv.mp4
  echo "  bsf=$bsf init=$($I init $W/dv.mp4)"
  $FP -v error -select_streams v:0 -read_intervals %+#3 -show_frames -show_entries frame=side_data_list $W/dv.mp4 2>/dev/null | grep -c "Dolby Vision" | sed 's/^/    frames side_data DV mentions: /'
  $FF -hide_banner -loglevel error -i $W/dv.mp4 -map 0:v:0 -c:v copy -bsf:v trace_headers -f null - 2>&1 | grep -c "nal_unit_type.*= 62" | sed 's/^/    NAL type 62 (RPU) count: /'
done

echo "=== E7 keyframe list by seek probing: one ffprobe, one interval every 4 s (75 seeks on 300 s)"
IV=$(awk 'BEGIN{for(t=4;t<300;t+=4){printf "%s%d%%+#1",(t>4?",":""),t}}')
s=$(date +%s%N); $FP -v error -select_streams v:0 -read_intervals "$IV" -show_entries packet=pts_time,flags -of csv=p=0 "$LT" > $W/kf.csv; echo "seek-probe ms=$(ms $s) rows=$(wc -l < $W/kf.csv) keyframes=$(grep -c K $W/kf.csv)"; head -3 $W/kf.csv
