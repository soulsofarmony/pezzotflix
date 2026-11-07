#!/usr/bin/env bash
# S5 (throwaway): builds the audio test files for the TV in out/www/gen/ and the samples.json index.
# Never writes into media-samples/. Sources: out/sources/ (FATE samples, fetched by fetch.sh).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/out/sources"
GEN="$HERE/out/www/gen"
TMP="$HERE/out/tmp"
mkdir -p "$GEN" "$TMP" "$HERE/out/www/media"
FF="${FFMPEG:-ffmpeg}"
FONT="C\\:/Windows/Fonts/arial.ttf"
[ -f /c/Windows/Fonts/arial.ttf ] || FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

# A 1080p24 H.264 card with a title and, optionally, timed captions: "start|end|text;..."
card() { # $1=out $2=duration $3=title $4=captions
  local f="color=c=0x14213d:s=1920x1080:r=24:d=$2,drawtext=fontfile='$FONT':text='$3':fontcolor=0xfca311:fontsize=64:x=(w-tw)/2:y=200"
  local IFS=';'
  for c in $4; do
    IFS='|' read -r a b t <<<"$c"
    f="$f,drawtext=fontfile='$FONT':text='$t':fontcolor=white:fontsize=110:x=(w-tw)/2:y=(h-th)/2:enable='between(t,$a,$b)'"
  done
  [ -s "$1" ] || "$FF" -v error -y -f lavfi -i "$f" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p "$1"
}

# ---------------------------------------------------------------- channel identification (pink noise, LFE 50 Hz)
# One burst per channel, in the order of the on-screen caption.
chid() { # $1=out.wav $2=layout $3="CH:start:end ..." (channel names of ffmpeg's join map)
  local n=0 split="" maps="" chains="" dur=17
  for spec in $3; do n=$((n+1)); done
  local i=0
  for spec in $3; do
    IFS=':' read -r ch a b <<<"$spec"
    if [ "$ch" = LFE ]; then src="sine=f=50:r=48000:d=$dur,volume=0.5"; else src="anoisesrc=c=pink:r=48000:a=0.25:d=$dur"; fi
    chains="$chains$src,volume=volume='between(t,$a,$b)':eval=frame[c$i];"
    maps="$maps${maps:+|}$i.0-$ch"
    split="$split[c$i]"
    i=$((i+1))
  done
  [ -s "$1" ] || "$FF" -v error -y -filter_complex "${chains}${split}join=inputs=$n:channel_layout=$2:map=$maps,aformat=sample_fmts=s32" -c:a pcm_s24le "$1"
}

chid "$TMP/ch51.wav" "5.1(side)" "FL:0.5:2.5 FC:3:5 FR:5.5:7.5 SR:8:10 SL:10.5:12.5 LFE:13:15"
chid "$TMP/ch71.wav" "7.1" "FL:0.5:2.5 FC:3:5 FR:5.5:7.5 SR:8:10 BR:10.5:12.5 BL:13:15 SL:15.5:17 LFE:17:17"
card "$TMP/v51.mp4" 17 "Prova canali 5.1 - premi SU per cambiare codec" \
  "0.5|2.5|Anteriore sinistro;3|5|Centrale;5.5|7.5|Anteriore destro;8|10|Surround destro;10.5|12.5|Surround sinistro;13|15|LFE (subwoofer) 50 Hz"
card "$TMP/v71.mp4" 17 "Prova canali 7.1 - premi SU per cambiare codec" \
  "0.5|2.5|Anteriore sinistro;3|5|Centrale;5.5|7.5|Anteriore destro;8|10|Surround destro;10.5|12.5|Posteriore destro;13|15|Posteriore sinistro;15.5|17|Surround sinistro"

# 5.1: every codec a Blu-ray remux or our server can carry, same signal, one track each.
OUT="$GEN/canali-5.1-otto-codec.mkv"
[ -s "$OUT" ] || "$FF" -v error -y -i "$TMP/v51.mp4" -i "$TMP/ch51.wav" -i "$TMP/ch51.wav" -i "$TMP/ch51.wav" -i "$TMP/ch51.wav" \
  -i "$TMP/ch51.wav" -i "$TMP/ch51.wav" -i "$TMP/ch51.wav" -i "$TMP/ch51.wav" \
  -map 0:v -map 1:a -map 2:a -map 3:a -map 4:a -map 5:a -map 6:a -map 7:a -map 8:a -c:v copy \
  -c:a:0 truehd -c:a:1 dca -b:a:1 1509k -c:a:2 eac3 -b:a:2 640k -c:a:3 ac3 -b:a:3 640k -c:a:4 flac -c:a:5 pcm_s24le \
  -c:a:6 aac -b:a:6 640k -filter:a:6 aformat=channel_layouts=5.1 -c:a:7 aac -b:a:7 192k -ac:a:7 2 \
  -metadata:s:a:0 title="1 TrueHD 5.1" -metadata:s:a:1 title="2 DTS 5.1 (core)" -metadata:s:a:2 title="3 E-AC-3 5.1 640k" \
  -metadata:s:a:3 title="4 AC-3 5.1 640k" -metadata:s:a:4 title="5 FLAC 5.1" -metadata:s:a:5 title="6 PCM 5.1 24 bit" \
  -metadata:s:a:6 title="7 AAC 5.1" -metadata:s:a:7 title="8 AAC 2.0" -metadata:s:a language=ita -strict -2 "$OUT"

OUT="$GEN/canali-7.1-tre-codec.mkv"
[ -s "$OUT" ] || "$FF" -v error -y -i "$TMP/v71.mp4" -i "$TMP/ch71.wav" -i "$TMP/ch71.wav" -i "$TMP/ch71.wav" \
  -map 0:v -map 1:a -map 2:a -map 3:a -c:v copy -c:a:0 truehd -c:a:1 flac -c:a:2 pcm_s24le \
  -metadata:s:a:0 title="1 TrueHD 5.1 (encoder ffmpeg: niente 7.1)" -metadata:s:a:1 title="2 FLAC 7.1" -metadata:s:a:2 title="3 PCM 7.1 24 bit" \
  -metadata:s:a language=ita -strict -2 "$OUT" || echo "7.1 TrueHD not encodable here: see report"

# ---------------------------------------------------------------- real bitstreams (FATE suite), copied
real() { # $1=out $2=src $3=loops $4=title
  card "$TMP/card-$(basename "$1" .mkv).mp4" "$5" "$4" ""
  [ -s "$1" ] || "$FF" -v error -y -i "$TMP/card-$(basename "$1" .mkv).mp4" -stream_loop "$3" -i "$2" -map 0:v -map 1:a -c copy \
    -metadata:s:a:0 language=eng -metadata:s:a:0 title="$4" -shortest -strict -2 "$1"
}
real "$GEN/reale-truehd-atmos-7.1.mkv" "$SRC/atmos.thd" 99 "TrueHD Atmos 7.1 (bitstream reale, FATE)" 10
real "$GEN/reale-dts-hd-ma-7.1.mkv" "$SRC/master_audio_7.1_24bit.dts" 1 "DTS-HD MA 7.1 (bitstream reale, FATE)" 25
real "$GEN/reale-eac3-joc-atmos-7.1.mkv" "$SRC/the_great_wall_7.1.eac3" 3 "E-AC-3 JOC Atmos 7.1 (bitstream reale, FATE)" 20

# ---------------------------------------------------------------- owner listening comparison, same real mix
# Source: the DTS-HD MA 7.1 mix (12.5 s), decoded and looped 4x (50 s). Track 1 is TrueHD (lossless, decoded in
# software on the TV); tracks 2-3 are what our server would make from that TrueHD (E-AC-3 5.1 640k, FLAC).
[ -s "$TMP/mix71.wav" ] || "$FF" -v error -y -stream_loop 3 -i "$SRC/master_audio_7.1_24bit.dts" -c:a pcm_s24le "$TMP/mix71.wav"
[ -s "$TMP/mix.thd.mka" ] || "$FF" -v error -y -i "$TMP/mix71.wav" -c:a truehd -strict -2 "$TMP/mix.thd.mka" 2>/dev/null \
  || "$FF" -v error -y -i "$TMP/mix71.wav" -af "aformat=channel_layouts=5.1(side)" -c:a truehd -strict -2 "$TMP/mix.thd.mka"
card "$TMP/vcmp.mp4" 50 "Confronto - premi SU per cambiare traccia" \
  "0|50|1 TrueHD  -  2 E-AC-3 5.1  -  3 FLAC  -  4 DTS-HD MA"
OUT="$GEN/confronto-truehd-eac3-flac.mkv"
[ -s "$OUT" ] || "$FF" -v error -y -i "$TMP/vcmp.mp4" -i "$TMP/mix.thd.mka" -stream_loop 3 -i "$SRC/master_audio_7.1_24bit.dts" \
  -map 0:v -map 1:a -map 1:a -map 1:a -map 2:a -c:v copy -c:a:0 copy \
  -c:a:1 eac3 -b:a:1 640k -filter:a:1 "aformat=channel_layouts=5.1(side)" -c:a:2 flac -c:a:3 copy \
  -metadata:s:a:0 title="1 TrueHD (decodifica software sulla TV)" -metadata:s:a:1 title="2 E-AC-3 5.1 640k (conversione del server)" \
  -metadata:s:a:2 title="3 FLAC (conversione del server)" -metadata:s:a:3 title="4 DTS-HD MA 7.1 originale" \
  -metadata:s:a language=ita -shortest -strict -2 "$OUT"

# ---------------------------------------------------------------- FLAC frame size vs the TV's FLAC decoder input buffer
# The TV's c2.android.flac.decoder has 32768-byte input buffers; real 24-bit 5.1 at 4608 samples/frame (the server's
# FLAC_FRAME_SAMPLES) makes ~34 KB frames. Same real mix, 5.1 and 7.1, 4608 vs 1152 samples/frame, in MKV and in
# fragmented MP4 (the container of the server's HLS fMP4 Direct Stream).
card "$TMP/vflac.mp4" 50 "FLAC - blocchi da 4608 o 1152 campioni" \
  "0|50|1 5.1 4608  -  2 5.1 1152  -  3 7.1 4608  -  4 7.1 1152"
for ext in mkv mp4; do
  OUT="$GEN/flac-blocchi.$ext"
  MF=(); [ "$ext" = mp4 ] && MF=(-movflags +frag_keyframe+empty_moov+default_base_moof)
  [ -s "$OUT" ] || "$FF" -v error -y -i "$TMP/vflac.mp4" -i "$TMP/mix71.wav" \
    -map 0:v -map 1:a -map 1:a -map 1:a -map 1:a -c:v copy -c:a flac \
    -filter:a:0 "aformat=channel_layouts=5.1(side)" -frame_size:a:0 4608 \
    -filter:a:1 "aformat=channel_layouts=5.1(side)" -frame_size:a:1 1152 \
    -frame_size:a:2 4608 -frame_size:a:3 1152 \
    -metadata:s:a:0 title="1 FLAC 5.1 24 bit, blocchi 4608" -metadata:s:a:1 title="2 FLAC 5.1 24 bit, blocchi 1152" \
    -metadata:s:a:2 title="3 FLAC 7.1 24 bit, blocchi 4608" -metadata:s:a:3 title="4 FLAC 7.1 24 bit, blocchi 1152" \
    -metadata:s:a language=ita -shortest "${MF[@]}" "$OUT"
done

# ---------------------------------------------------------------- owner listening pair on the real library file
# ADR 0008: AAC 5.1 decoded by the TV (PCM, downmixed to 2 ch by Android) vs E-AC-3 5.1 640k made by the server from
# the same AAC track (bitstream to the TV's Dolby decoder). 4 min of 2001 from 26:00 (Blue Danube, then dialogue);
# track 3 is the original AC-3 ita for reference. Reads the owner's file, writes only to out/www/gen.
O2001="$HERE/../../media-samples/library/movies/2001 - Odissea nello spazio (1968)/2001 - Odissea nello spazio (1968) - 2160p.mkv"
OUT="$GEN/ascolto-2001-aac-vs-eac3.mkv"
if [ -f "$O2001" ] && [ ! -s "$OUT" ]; then
  "$FF" -v error -y -ss 1560 -t 240 -i "$O2001" -map 0:v:0 -map 0:a:1 -map 0:a:1 -map 0:a:0 -c:v copy \
    -c:a:0 copy -c:a:1 eac3 -b:a:1 640k -filter:a:1 "aresample=48000,aformat=channel_layouts=5.1" -c:a:2 copy \
    -metadata:s:a:0 title="1 AAC 5.1 eng (decodificato dalla TV)" \
    -metadata:s:a:1 title="2 E-AC-3 5.1 640k eng (conversione del server dallo stesso AAC)" \
    -metadata:s:a:2 title="3 AC-3 5.1 ita originale (riferimento, altra lingua)" \
    -disposition:a:0 default -disposition:a:1 0 -disposition:a:2 0 -sn "$OUT"
fi

# ---------------------------------------------------------------- index for the app
python3 "$HERE/samples_index.py" "$HERE/out/www" 2>/dev/null || python "$HERE/samples_index.py" "$HERE/out/www"
ls -la "$GEN"

# PGS .sup as the server serves it in Direct Stream (client_render): a copy of the S1 sample, in out/ only.
cp -n "$HERE/../../media-samples/sources/pgs-sample1.sup" "$GEN/pgs-sample1.sup" 2>/dev/null || true
