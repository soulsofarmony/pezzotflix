#!/bin/sh
# Throwaway (ADR 0003). Runs inside pezzotflix/video:dev with media mounted read-only on /m and /out writable.
# E1: ffmpeg hls muxer, restart at a keyframe: are segment boundaries the same as in a run from 0?
# E2: one fragmented MP4 (frag_keyframe) per run: are fragment timestamps the same after a restart?
set -eu
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg
F="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
W=/tmp/w; rm -rf $W; mkdir -p $W
I="node /s/mp4inspect.mjs"
COMMON="-map 0:v:0 -map 0:a:0 -c:v copy -tag:v hvc1 -af aformat=channel_layouts=5.1 -c:a aac -b:a 640k -copyts -avoid_negative_ts disabled -map_metadata -1 -map_chapters -1"

hls() { # $1 name, $2 -ss value, $3 start_number, $4 hls_time
  mkdir -p $W/$1
  $FF -hide_banner -loglevel error -ss $2 -t 40 -i "$F" $COMMON -f hls -hls_time $4 -hls_segment_type fmp4 \
    -hls_playlist_type vod -hls_list_size 0 -start_number $3 -hls_segment_options movflags=+frag_discont \
    -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$W/$1/seg-%05d.m4s" $W/$1/main.m3u8
  echo "## $1 (ss=$2 start_number=$3 hls_time=$4)"
  grep -E 'EXTINF|seg-' $W/$1/main.m3u8 | paste - - | head -8
  $I frags $W/$1/init.mp4 $(ls $W/$1/seg-*.m4s | head -6) | awk -F'\t' '$2==1{print "  video", $1, "tfdt", $3, "pts0", $4, "dur", $5}'
}
echo "=== E1 hls muxer, hls_time 5, GOP 2 s"
hls h0 0 0 5
hls h16 16 3 5
echo "=== E1b hls muxer, hls_time 4"
hls g0 0 0 4
hls g12 12 3 4

echo "=== E2 fragmented mp4 per run (frag_keyframe), same restart"
frag() { # $1 name, $2 -ss
  s=$(date +%s%N)
  $FF -hide_banner -loglevel error -ss $2 -t 20 -i "$F" $COMMON -f mp4 \
    -movflags +frag_keyframe+empty_moov+default_base_moof+frag_discont -frag_duration 0 pipe:1 > $W/$1.mp4
  e=$(date +%s%N); echo "## $1 ss=$2 wall_ms=$(( (e - s) / 1000000 ))"
  $I init $W/$1.mp4
  $I frags $W/$1.mp4 | head -12 | sed 's/^/  /'
}
frag f0 0
frag f16 16
echo "=== E2b time to first fragment from a deep offset (pipe, first 4 MB)"
for ss in 150 284; do
  s=$(date +%s%N)
  $FF -hide_banner -loglevel error -ss $ss -i "$F" $COMMON -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof pipe:1 | head -c 60000000 > $W/ttf.mp4 || true
  e=$(date +%s%N); echo "ss=$ss first_60MB_ms=$(( (e - s) / 1000000 ))"
  $I frags $W/ttf.mp4 | head -2 | sed 's/^/  /'
done
