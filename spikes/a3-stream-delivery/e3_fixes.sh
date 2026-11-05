#!/bin/sh
# Throwaway (ADR 0003). Fixes for E1/E2: seek target, negative audio tfdt, constant output offset.
set -eu
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg
F="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
W=/tmp/w; rm -rf $W; mkdir -p $W
I="node /s/mp4inspect.mjs"
V="-map 0:v:0 -c:v copy -tag:v hvc1"
A="-map 0:a:0 -af aformat=channel_layouts=5.1 -c:a aac -b:a 640k"
MF="-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof+frag_discont"
run() { # name, input opts, output opts
  n=$1; shift; inopts=$1; shift
  $FF -hide_banner -loglevel error $inopts -t 12 -i "$F" $V $A -copyts -avoid_negative_ts disabled -map_metadata -1 -map_chapters -1 "$@" $MF pipe:1 > $W/$n.mp4
  echo "## $n [$inopts] [$*]"
  $I frags $W/$n.mp4 | head -6 | awk -F'\t' '{printf "  trk%s tfdt=%s pts0=%s dur=%s\n",$2,$3,$4,$5}'
}
run a_ss16_accurate "-ss 16"
run b_ss16.2_noaccurate "-noaccurate_seek -ss 16.2"
run c_ss16.2_accurate "-ss 16.2"
run d_ss0_offset10 "-ss 0" -output_ts_offset 10
run e_ss16.2_noacc_offset10 "-noaccurate_seek -ss 16.2" -output_ts_offset 10
MF="-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof"; run f_ss16.2_no_fragdiscont "-noaccurate_seek -ss 16.2"; MF="-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof+frag_discont"
echo "## hls muxer from 0: audio track of the first segments"
mkdir -p $W/h
$FF -hide_banner -loglevel error -t 12 -i "$F" $V $A -copyts -avoid_negative_ts disabled -f hls -hls_time 4 -hls_segment_type fmp4 \
  -hls_playlist_type vod -hls_segment_options movflags=+frag_discont -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$W/h/seg-%05d.m4s" $W/h/main.m3u8
$I frags $W/h/init.mp4 $W/h/seg-00000.m4s $W/h/seg-00001.m4s | awk -F'\t' '{printf "  %s trk%s tfdt=%s pts0=%s dur=%s\n",$1,$2,$3,$4,$5}'
echo "## AAC without aformat (5.1(side) -> PCE?)"
$FF -hide_banner -loglevel error -t 2 -i "$F" -map 0:a:0 -c:a aac -b:a 640k $MF pipe:1 > $W/pce.mp4; $I init $W/pce.mp4
echo "## FLAC and Opus 5.1 init"
$FF -hide_banner -loglevel error -t 2 -i "$F" -map 0:a:0 -c:a flac $MF pipe:1 > $W/flac.mp4; $I init $W/flac.mp4
$FF -hide_banner -loglevel error -t 2 -i "$F" -map 0:a:0 -af aformat=channel_layouts=5.1 -c:a libopus -b:a 448k $MF pipe:1 > $W/opus.mp4; $I init $W/opus.mp4
$FF -hide_banner -loglevel error -t 2 -i "$F" -map 0:a:1 -c:a copy $MF pipe:1 > $W/eac3copy.mp4; $I init $W/eac3copy.mp4
