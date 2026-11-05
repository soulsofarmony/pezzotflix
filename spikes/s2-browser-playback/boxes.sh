#!/usr/bin/env bash
# S2 follow-up (throwaway): rebuild the browser-tested variants h2/h6/h7/h8/p1 exactly as prepare.sh
# does (video copied), plus AAC 5.1 layout probes, with ONE ffmpeg build per run.
#
#   bash spikes/s2-browser-playback/boxes.sh host       # ffmpeg/ffprobe on PATH (8.1.2 Gyan build)
#   bash spikes/s2-browser-playback/boxes.sh jellyfin   # jellyfin-ffmpeg 8.1.3 in pezzotflix/video:dev (one-shot containers)
#
# Output: spikes/s2-browser-playback/out/boxes/<build>/ (gitignored).
# Then: python -I spikes/s2-browser-playback/mp4boxes.py > spikes/s2-browser-playback/out/boxes/report.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
BUILD="${1:?usage: boxes.sh host|jellyfin}"
case "$BUILD" in
  host)
    FFMPEG=(ffmpeg); FFPROBE=(ffprobe) ;;
  jellyfin)
    WIN="$(cygpath -m "$ROOT" 2>/dev/null || echo "$ROOT")"
    D=(env MSYS_NO_PATHCONV=1 docker run --rm -v "$WIN:/work" -w /work)
    FFMPEG=("${D[@]}" --entrypoint /usr/lib/jellyfin-ffmpeg/ffmpeg pezzotflix/video:dev)
    FFPROBE=("${D[@]}" --entrypoint /usr/lib/jellyfin-ffmpeg/ffprobe pezzotflix/video:dev) ;;
  *) echo "unknown build $BUILD" >&2; exit 2 ;;
esac

LIB="media-samples/library/movies"
BR="$LIB/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv"
BUONO="$LIB/Il Buono, il Brutto, il Cattivo (1966)/Il.Buono.il.Brutto.il.Cattivo.1966.1080p.BluRay.REMUX.mkv"
DUNE="$LIB/Dune (2021)/Dune.2021.2160p.UHD.BluRay.REMUX.DV.HDR.mkv"
OPP="$LIB/Oppenheimer (2023)/Oppenheimer (2023).mkv"
O="spikes/s2-browser-playback/out/boxes/$BUILD"
rm -rf "$O"; mkdir -p "$O/probe" "$O/aac" "$O/log"
FF=("${FFMPEG[@]}" -hide_banner -v error -y)

"${FFMPEG[@]}" -hide_banner -version | head -1 > "$O/version.txt"

# --- the browser-tested variants, same arguments as prepare.sh ---------------------------------------
hls() { # name src tag audio-args...
  local name="$1" src="$2" tag="$3"; shift 3
  mkdir -p "$O/$name"
  "${FF[@]}" -i "$src" -map 0:v:0 -map 0:a:0 -c:v copy -tag:v "$tag" "$@" \
    -f hls -hls_time 4 -hls_segment_type fmp4 -hls_playlist_type vod -hls_flags independent_segments \
    -hls_fmp4_init_filename init.mp4 "$O/$name/index.m3u8"
  cat "$O/$name/init.mp4" "$O/$name/index0.m4s" > "$O/$name/first.mp4"   # init + first segment, for ffprobe
}
hls h2-hevc-hdr10-aac   "$BR"   hvc1 -c:a aac -b:a 192k -ac 2
hls h6-dv81-as-hvc1-aac "$DUNE" hvc1 -c:a aac -b:a 192k -ac 2
hls h7-dv81-as-dvh1-aac "$DUNE" dvh1 -strict unofficial -c:a aac -b:a 192k -ac 2
hls h8-dv5-as-dvh1-aac  "$OPP"  dvh1 -strict unofficial -c:a aac -b:a 192k -ac 2
"${FF[@]}" -i "$BR" -map 0:v:0 -map 0:a:0 -c:v copy -tag:v hvc1 -c:a flac \
  -movflags +frag_keyframe+empty_moov+default_base_moof "$O/p1-hevc-hdr10-flac51-frag.mp4"

# DV P8.1 source video as Annex B, to count RPU NAL units (type 62) against h6
"${FF[@]}" -i "$DUNE" -map 0:v:0 -c:v copy -f hevc "$O/dune-src.hevc"

# --- ffprobe: stream fields + side data, frame side data -------------------------------------------
P=("${FFPROBE[@]}" -hide_banner -v error -of json)
for f in "$BR" "$DUNE" "$OPP"; do
  n="$(basename "$f" .mkv | tr -c 'A-Za-z0-9.\n' '_')"
  "${P[@]}" -select_streams v:0 -show_streams "$f" > "$O/probe/src-$n.json"
done
for v in h2-hevc-hdr10-aac h6-dv81-as-hvc1-aac h7-dv81-as-dvh1-aac h8-dv5-as-dvh1-aac; do
  "${P[@]}" -select_streams v:0 -show_streams "$O/$v/first.mp4" > "$O/probe/$v.json"
done
"${P[@]}" -select_streams v:0 -show_streams "$O/p1-hevc-hdr10-flac51-frag.mp4" > "$O/probe/p1-hevc-hdr10-flac51-frag.json"
# first 8 decoded frames: is DV RPU side data attached? (h6 = DV P8.1 tagged hvc1, vs the MKV source)
"${P[@]}" -select_streams v:0 -read_intervals '%+#8' -show_frames -show_entries frame=pts_time:frame_side_data=side_data_type \
  "$O/h6-dv81-as-hvc1-aac/first.mp4" > "$O/probe/frames-h6.json"
"${P[@]}" -select_streams v:0 -read_intervals '%+#8' -show_frames -show_entries frame=pts_time:frame_side_data=side_data_type \
  "$DUNE" > "$O/probe/frames-dune-src.json"
# audio layouts that ffmpeg's decoders report for the S1 fixtures (synthetic TrueHD / DTS core / E-AC-3 / AC-3)
for f in "$BR" "$BUONO" "$DUNE"; do
  n="$(basename "$f" .mkv | tr -c 'A-Za-z0-9.\n' '_')"
  "${P[@]}" -select_streams a -show_entries stream=index,codec_name,profile,channels,channel_layout:stream_tags=language "$f" > "$O/probe/audio-$n.json"
done

# --- AAC 5.1: channelConfiguration 6 or PCE? -------------------------------------------------------
# 10 s, one tone per channel (same as prepare_extra.sh), fed to ffmpeg's native AAC encoder
T="sine=f=300:r=48000:d=10[a0];sine=f=500:r=48000:d=10[a1];sine=f=700:r=48000:d=10[a2];sine=f=60:r=48000:d=10[a3];sine=f=900:r=48000:d=10[a4];sine=f=1100:r=48000:d=10[a5];[a0][a1][a2][a3][a4][a5]join=inputs=6"
SIDE="$T:channel_layout=5.1(side):map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-SL|5.0-SR"
BACK="$T:channel_layout=5.1:map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-BL|5.0-BR"
aac() { # name graph-or-input-args... (stderr kept: the encoder logs when it uses a PCE)
  local name="$1"; shift
  "${FFMPEG[@]}" -hide_banner -loglevel info -y "$@" -c:a aac -b:a 384k "$O/aac/$name.mp4" 2> "$O/log/aac-$name.log"
  "${P[@]}" -show_entries stream=codec_name,channels,channel_layout "$O/aac/$name.mp4" > "$O/probe/aac-$name.json"
}
aac side          -filter_complex "$SIDE[a]" -map "[a]"
aac back          -filter_complex "$BACK[a]" -map "[a]"
aac side-aformat  -filter_complex "$SIDE[s];[s]aformat=channel_layouts=5.1[a]" -map "[a]"
aac back-aformat  -filter_complex "$BACK[s];[s]aformat=channel_layouts=5.1[a]" -map "[a]"
# -ac 6 (as in Jellyfin's 5.1 AAC command lines) asks for the default 6-channel layout, i.e. 5.1 (back)
aac side-ac6      -filter_complex "$SIDE[a]" -map "[a]" -ac 6
# realistic decode path: the fixture's TrueHD (Blade Runner) and DTS core (Buono) tracks decoded by ffmpeg
aac truehd         -t 10 -i "$BR" -map 0:a:0
aac truehd-aformat -t 10 -i "$BR" -map 0:a:0 -af aformat=channel_layouts=5.1
aac truehd-ac6     -t 10 -i "$BR" -map 0:a:0 -ac 6
aac dts            -t 10 -i "$BUONO" -map 0:a:0
aac dts-aformat    -t 10 -i "$BUONO" -map 0:a:0 -af aformat=channel_layouts=5.1

du -sh "$O"
