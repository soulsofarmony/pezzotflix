#!/usr/bin/env bash
# S1 (throwaway): assemble remux-like MKV fixtures from public sources.
# Video is always stream-copied (like a real remux); audio/subs are synthesized
# to emulate Blu-ray track layouts (multi-language, lossless, commentary, PGS, forced).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/media-samples/sources"
LIB="$ROOT/media-samples/library"
TMP="$ROOT/spikes/s1-media-probe/out/tmp"
mkdir -p "$TMP"
DUR=30   # seconds per fixture

# --- synthetic track sources -------------------------------------------------
tone() { # $1=file $2=layout
  [ -s "$1" ] || ffmpeg -v error -y -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=$DUR" \
    -f lavfi -i "sine=frequency=550:sample_rate=48000:duration=$DUR" \
    -filter_complex "[0][1]amerge=inputs=2,aformat=channel_layouts=$2" -c:a pcm_s24le "$1"
}
tone "$TMP/a51.wav" 5.1
tone "$TMP/a20.wav" stereo

cat > "$TMP/it.srt" <<'SRT'
1
00:00:02,000 --> 00:00:06,000
Sottotitolo di prova in italiano.

2
00:00:10,000 --> 00:00:14,000
Seconda riga: àèìòù.
SRT
cat > "$TMP/en.ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,0,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:03.00,0:00:07.00,Default,,0,0,0,,{\i1}Styled{\i0} English test line.
ASS
cat > "$TMP/chapters.txt" <<'CH'
;FFMETADATA1
[CHAPTER]
TIMEBASE=1/1000
START=0
END=10000
title=Capitolo 1
[CHAPTER]
TIMEBASE=1/1000
START=10000
END=20000
title=Capitolo 2
[CHAPTER]
TIMEBASE=1/1000
START=20000
END=30000
title=Capitolo 3
CH

# --- builders ----------------------------------------------------------------
# mux <out> <video-src> <audio-spec...> -- <sub-spec...>
# audio spec: file|codec|lang|title|disposition   sub spec: file|lang|title|disposition
mux() {
  local out="$1" vsrc="$2"; shift 2
  local inputs=(-t "$DUR" -i "$vsrc") maps=(-map 0:v:0) meta=() n=1 a=0 s=0
  while [ "$1" != "--" ]; do
    IFS='|' read -r f c lang title disp <<<"$1"
    inputs+=(-i "$f"); maps+=(-map "$n:a:0")
    meta+=(-c:a:$a "$c" -metadata:s:a:$a "language=$lang" -metadata:s:a:$a "title=$title" -disposition:a:$a "$disp")
    n=$((n+1)); a=$((a+1)); shift
  done; shift
  for spec in "$@"; do
    IFS='|' read -r f lang title disp <<<"$spec"
    inputs+=(-i "$f"); maps+=(-map "$n:s:0")
    meta+=(-metadata:s:s:$s "language=$lang" -metadata:s:s:$s "title=$title" -disposition:s:$s "$disp")
    n=$((n+1)); s=$((s+1))
  done
  mkdir -p "$(dirname "$out")"
  # MP4 sources may carry a 'dvh1' codec tag (DV profile 5) that the matroska muxer rejects;
  # retagging keeps the DOVI configuration record intact (finding for H3).
  local vtag=()
  [ "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_tag_string -of default=nw=1:nk=1 "$vsrc" | head -1 | tr -d '\r')" = "dvh1" ] && vtag=(-tag:v hvc1)
  ffmpeg -v error -y "${inputs[@]}" -i "$TMP/chapters.txt" "${maps[@]}" -map_chapters "$n" \
    -c:v copy "${vtag[@]}" -c:s copy "${meta[@]}" -strict -2 -t "$DUR" "$out"
  # subtitles that need conversion (srt/ass) are copied as-is into mkv: ffmpeg handles srt->subrip, ass->ass
  echo "built: ${out#$ROOT/}"
}

PGS1="$SRC/pgs-sample1.sup"; PGS2="$SRC/pgs-sample2.sup"

# 1) UHD HDR10 remux: TrueHD ita default, E-AC3 eng, AC3 ita commentary; PGS forced + full; SRT; ASS
mux "$LIB/movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv" \
  "$SRC/jf-4k-hevc-hdr10-100M.mp4" \
  "$TMP/a51.wav|truehd|ita|TrueHD 5.1|default" \
  "$TMP/a51.wav|eac3|eng|E-AC3 5.1|0" \
  "$TMP/a20.wav|ac3|ita|Commento del regista|comment" \
  -- \
  "$PGS1|ita|Forced|forced" \
  "$PGS2|ita|Completi|0" \
  "$TMP/it.srt|ita|SRT|0" \
  "$TMP/en.ass|eng|ASS styled|0"

# 2) Blu-ray 1080p AVC remux: DTS core eng default, AC3 ita; PGS eng SDH
mux "$LIB/movies/Il Buono, il Brutto, il Cattivo (1966)/Il.Buono.il.Brutto.il.Cattivo.1966.1080p.BluRay.REMUX.mkv" \
  "$SRC/jf-1080p-avc-30M.mp4" \
  "$TMP/a51.wav|dca|eng|DTS 5.1|default" \
  "$TMP/a51.wav|ac3|ita|AC3 5.1|0" \
  -- \
  "$PGS1|eng|SDH|hearing_impaired"

# 3) DV profile 8.1 (HDR10-compatible) remux
mux "$LIB/movies/Dune (2021)/Dune.2021.2160p.UHD.BluRay.REMUX.DV.HDR.mkv" \
  "$SRC/jf-4k-dv-p8.1.mp4" \
  "$TMP/a51.wav|truehd|eng|TrueHD 5.1|default" \
  "$TMP/a51.wav|eac3|ita|E-AC3 5.1|0" \
  -- \
  "$TMP/it.srt|ita|Forced|forced"

# 4) DV profile 5 (no HDR10 fallback) remux
mux "$LIB/movies/Oppenheimer (2023)/Oppenheimer (2023).mkv" \
  "$SRC/jf-4k-dv-p5.mp4" \
  "$TMP/a51.wav|flac|eng|FLAC 5.1|default" \
  --

# 5) Series: single episode + multi-episode file + sidecar subtitle
mux "$LIB/series/Dark (2017)/Season 01/Dark - S01E01 - Segreti.mkv" \
  "$SRC/jf-1080p-avc-30M.mp4" \
  "$TMP/a51.wav|ac3|deu|AC3 5.1|default" \
  "$TMP/a51.wav|eac3|ita|E-AC3 5.1|0" \
  -- \
  "$PGS2|ita|Italiano|0"
cp "$TMP/it.srt" "$LIB/series/Dark (2017)/Season 01/Dark - S01E01 - Segreti.it.forced.srt"
mux "$LIB/series/Dark (2017)/Season 01/Dark - S01E02-E03.mkv" \
  "$SRC/jf-1080p-avc-30M.mp4" \
  "$TMP/a51.wav|ac3|deu|AC3 5.1|default" \
  --

# 6) Extra: trailer, stereo AAC, attached to a movie folder
mux "$LIB/movies/Blade Runner 2049 (2017)/extras/Trailer.mkv" \
  "$SRC/jf-1080p-avc-30M.mp4" \
  "$TMP/a20.wav|aac|eng|Stereo|default" \
  --

# 7) Ambiguous / unmatched name for the identification queue
mux "$LIB/movies/misc/BDMV_DISC1_t00.mkv" \
  "$SRC/jf-1080p-avc-30M.mp4" \
  "$TMP/a51.wav|ac3|und||default" \
  --
