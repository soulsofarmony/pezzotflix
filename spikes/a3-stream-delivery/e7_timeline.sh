#!/bin/sh
# Throwaway (ADR 0003). E7: final flags. Does negative_cts_offsets give the exact keyframe PTS, and does
# -ss Bk+0.135 (compensating ffmpeg's 3/23 s back-off with B-frames) land exactly on the keyframe?
# Run: docker run --rm --entrypoint sh -v <media-samples>:/m:ro -v <this dir>:/s pezzotflix/video:dev /s/e7_timeline.sh
FF=/usr/lib/jellyfin-ffmpeg/ffmpeg
F="/m/library/movies/Long Test (2024)/Long Test (2024) - 2160p.mkv"
for MF in "+frag_keyframe+delay_moov+default_base_moof+frag_discont" "+frag_keyframe+delay_moov+default_base_moof+frag_discont+negative_cts_offsets"; do
  for ss in "" "-noaccurate_seek -ss 16.135"; do
    $FF -hide_banner -loglevel error -y $ss -t 6 -i "$F" -map 0:v:0 -map 0:a:0 -c:v copy -tag:v hvc1 -af aformat=channel_layouts=5.1 -c:a flac \
      -copyts -avoid_negative_ts disabled -output_ts_offset 10 -f mp4 -movflags $MF /tmp/o.mp4
    echo "## $MF [$ss]"; node /s/mp4inspect.mjs frags /tmp/o.mp4 | head -2 | sed "s/^/  /"
  done
done
/usr/lib/jellyfin-ffmpeg/ffprobe -v error -select_streams v:0 -show_entries stream=has_b_frames -of csv=p=0 "$F"
