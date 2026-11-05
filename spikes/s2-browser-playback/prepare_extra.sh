#!/usr/bin/env bash
# S2 (throwaway): extra channel-identification variants for the automated run.
# 10 s of 1080p AVC (video copied) + synthetic 5.1(side) audio with one tone per channel:
#   (Opus: layout 5.1 back, as libopus mapping family 1 requires; same order L R C LFE Ls Rs)
#   FL 300 Hz, FR 500 Hz, FC 700 Hz, LFE 60 Hz, SL 900 Hz, SR 1100 Hz
# Output: out/media/c*-*/ (HLS fMP4) and out/media/c*-prog.mp4 (progressive fMP4)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
M="$HERE/out/media"
SRC="$M/d1-avc-aac.mkv"
FF=(ffmpeg -hide_banner -v error -y)
TONES="sine=f=300:r=48000:d=10[a0];sine=f=500:r=48000:d=10[a1];sine=f=700:r=48000:d=10[a2];sine=f=60:r=48000:d=10[a3];sine=f=900:r=48000:d=10[a4];sine=f=1100:r=48000:d=10[a5];[a0][a1][a2][a3][a4][a5]join=inputs=6:channel_layout=5.1(side):map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-SL|5.0-SR[a]"

TONES_BACK="${TONES/5.1(side)/5.1}"; TONES_BACK="${TONES_BACK/4.0-SL|5.0-SR/4.0-BL|5.0-BR}"
hls() { # name audio-args...
  local name="$1"; shift
  rm -rf "${M:?}/${name:?}"; mkdir -p "$M/$name"
  "${FF[@]}" -t 10 -i "$SRC" -filter_complex "${TONES_OVR:-$TONES}" -map 0:v:0 -map "[a]" -c:v copy -tag:v avc1 "$@" -t 10 \
    -f hls -hls_time 4 -hls_segment_type fmp4 -hls_playlist_type vod -hls_flags independent_segments \
    -hls_fmp4_init_filename init.mp4 "$M/$name/index.m3u8"
}
hls c1-avc-flac51  -c:a flac
hls c2-avc-eac351  -c:a eac3 -b:a 640k
hls c3-avc-ac351   -c:a ac3 -b:a 640k
TONES_OVR="$TONES_BACK" hls c4-avc-opus51  -c:a libopus -b:a 384k -mapping_family 1
hls c5-avc-aac51   -c:a aac -b:a 384k
# AAC from 5.1(side) gets channelConfiguration=0 + PCE; 5.1 (back) gets the standard channelConfiguration=6
TONES_OVR="$TONES_BACK" hls c7-avc-aac51-back -c:a aac -b:a 384k
"${FF[@]}" -t 10 -i "$SRC" -filter_complex "$TONES" -map 0:v:0 -map "[a]" -c:v copy -tag:v avc1 -c:a flac -t 10 \
  -movflags +frag_keyframe+empty_moov+default_base_moof "$M/c6-avc-flac51-prog.mp4"
# MKV with only a browser-unsupported audio track (no AC3/E-AC3 companion)
"${FF[@]}" -t 10 -i "$M/d3-hevc-hdr10-truehd.mkv" -map 0:v:0 -map 0:a:0 -c copy "$M/d5-hevc-truehd-only.mkv"
"${FF[@]}" -t 10 -i "$M/d2-avc-dts.mkv" -map 0:v:0 -map 0:a:0 -c copy "$M/d6-avc-dts-only.mkv"
du -sh "$M"/c* "$M"/d5* "$M"/d6*
