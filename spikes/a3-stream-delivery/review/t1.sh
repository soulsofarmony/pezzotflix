#!/bin/sh
# Review check: exact ADR 0003 command, run from 0 vs restart at B=16 (k=4). Is the init identical? Are tfdt identical?
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg; FP=/usr/lib/jellyfin-ffmpeg/ffprobe
F="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
W=/tmp/w; mkdir -p $W; cd /s
MF="+frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets"
run() { # name, ss-opts, audio-opts
  n=$1; ss=$2; shift 2
  $FF -hide_banner -loglevel error -nostdin $ss -t 12 -i "$F" -map 0:v:0 -map 0:a:0 -c:v copy -tag:v hvc1 "$@" -copyts -avoid_negative_ts disabled -output_ts_offset 10 -map_metadata -1 -map_chapters -1 -sn -dn -fflags +bitexact -f mp4 -movflags $MF pipe:1 > $W/$n.mp4
  node rv.mjs initsplit $W/$n.mp4 $W/$n.init >/dev/null
  echo "## $n [$ss] [$*] init=$(md5sum < $W/$n.init | cut -c1-12) size=$(stat -c %s $W/$n.init)"
  node rv.mjs elst $W/$n.mp4 | sed 's/^/   /'
  node mp4inspect.mjs frags $W/$n.mp4 | head -4 | sed 's/^/   /'
}
run flac0 "" -c:a flac
run flac16 "-noaccurate_seek -ss 16.135" -c:a flac
run aac0 "" -af aformat=channel_layouts=5.1 -c:a aac -b:a 640k
run aac16 "-noaccurate_seek -ss 16.135" -af "aformat=channel_layouts=5.1,atrim=start=16" -c:a aac -b:a 640k
echo "== file start_time"
for f in /m/library/movies/*/*.mkv /m/sources/*.mp4; do echo "$($FP -v error -show_entries format=start_time -of csv=p=0 "$f") $(basename "$f")"; done
