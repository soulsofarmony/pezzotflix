#!/usr/bin/env bash
# S3/H10 v2 (throwaway): GPU pipelines + I/O inside Docker Desktop (WSL2), with full logs.
# Every test writes its complete stderr to out/h10v2/<id>.log; summary goes to out/h10v2/summary.tsv.
# Source is read both from the NTFS bind mount (RO) and from a Docker volume, to separate I/O from GPU cost.
set -uo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && (pwd -W 2>/dev/null || pwd))"
OUT="$HERE/out/h10v2"; rm -rf "$OUT"; mkdir -p "$OUT"
SRC_DIR="$ROOT/media-samples/library/movies/Long Test (2024)"
SRC_NAME="Long Test (2024) - 2160p.mkv"
VOL=pzf-h10v2
IMG9=lscr.io/linuxserver/ffmpeg:latest
IMG8=lscr.io/linuxserver/ffmpeg:8.1.2
IMGJF=jellyfin/jellyfin:latest
GPU=(--gpus all -e NVIDIA_DRIVER_CAPABILITIES=all)
REPS="${REPS:-2}"

now() { python -c 'import time;print(time.time())'; }
summary() { printf '%s\n' "$*" >> "$OUT/summary.tsv"; }
printf 'id\trep\trc\twall_s\tffmpeg_fps\tffmpeg_speed\tlast_error\n' > "$OUT/summary.tsv"

# run <id> <rep> <cmd...> : full stderr+stdout to log, parse last fps/speed from -stats output
run() {
  local id="$1" rep="$2"; shift 2
  local log="$OUT/$id.r$rep.log" t0 t1 rc
  { echo "# $(date -Is)"; printf '# cmd:'; printf ' %q' "$@"; echo; } > "$log"
  t0=$(now); "$@" >> "$log" 2>&1; rc=$?; t1=$(now)
  local stats fps speed err
  stats=$(tr '\r' '\n' < "$log" | grep -E '^frame=' | tail -1)
  fps=$(sed -nE 's/.*fps= *([0-9.]+).*/\1/p' <<<"$stats")
  speed=$(sed -nE 's/.*speed= *([0-9.]+)x.*/\1/p' <<<"$stats")
  err=$(grep -iE 'error|not support|failed|no such' "$log" | head -1 | cut -c1-160)
  summary "$id	$rep	$rc	$(python -c "print(round($t1-$t0,2))")	${fps:-}	${speed:-}	${err:-}"
  printf '%-34s r%s rc=%-3s fps=%-6s speed=%-6s %s\n' "$id" "$rep" "$rc" "${fps:--}" "${speed:--}" "${err:-}"
}

# --- environment facts ---
{
  echo "## host"; date -Is
  wsl --version 2>/dev/null | tr -d '\0'
  docker version --format 'docker client {{.Client.Version}} / engine {{.Server.Version}}'
  nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
  powershell.exe -NoProfile -Command "'C: free GB = ' + [int]((Get-Volume -DriveLetter C).SizeRemaining/1GB)"
  for img in $IMG9 $IMG8; do docker pull -q "$img" >/dev/null; echo "## $img"; docker run --rm "$img" -hide_banner -version | head -1; done
  docker pull -q $IMGJF >/dev/null; echo "## $IMGJF"; docker run --rm --entrypoint /usr/lib/jellyfin-ffmpeg/ffmpeg $IMGJF -hide_banner -version | head -1
  echo "## filters tonemap_* / *_cuda per image"
  for img in $IMG9 $IMG8; do echo "-- $img"; docker run --rm "$img" -hide_banner -filters 2>/dev/null | grep -E 'tonemap|_cuda|libplacebo' ; done
  echo "-- $IMGJF"; docker run --rm --entrypoint /usr/lib/jellyfin-ffmpeg/ffmpeg $IMGJF -hide_banner -filters 2>/dev/null | grep -E 'tonemap|_cuda|libplacebo'
  echo "## Vulkan device list inside container ($IMG9)"
  docker run --rm "${GPU[@]}" $IMG9 -hide_banner -v verbose -init_hw_device vulkan=vk -f lavfi -i nullsrc=s=64x64 -t 0.04 -f null - 2>&1 | grep -E 'GPU listing|^\[Vulkan.*[0-9]: |selected'
  echo "## NVIDIA user-space libs inside container"
  docker run --rm "${GPU[@]}" --entrypoint sh $IMG9 -c 'ls /usr/lib/x86_64-linux-gnu | grep -iE "libcuda|nvcuvid|nvidia-encode|nvidia-.*vk|GLX_nvidia"; ls /usr/share/vulkan/icd.d /etc/vulkan/icd.d 2>/dev/null'
} > "$OUT/env.txt" 2>&1
cat "$OUT/env.txt"

# --- stage source into a Docker volume (ext4 inside the WSL VM) ---
docker volume rm -f $VOL >/dev/null 2>&1; docker volume create $VOL >/dev/null
docker run --rm -v "$SRC_DIR:/src:ro" -v $VOL:/dst alpine cp "/src/$SRC_NAME" /dst/long.mkv

BIND=(-v "$SRC_DIR:/src:ro"); FB="/src/$SRC_NAME"
VOLM=(-v $VOL:/src:ro);       FV="/src/long.mkv"

for r in $(seq 1 "$REPS"); do
  # I/O: raw sequential read of the whole 1.66 GB file
  run io-read-bind     $r docker run --rm "${BIND[@]}" alpine sh -c "cat '$FB' > /dev/null"
  run io-read-volume   $r docker run --rm "${VOLM[@]}" alpine sh -c "cat '$FV' > /dev/null"
  # I/O: full remux (copy) 5 min, as Direct Stream would read it
  run remux-bind       $r docker run --rm "${BIND[@]}" $IMG9 -hide_banner -nostdin -stats -i "$FB" -map 0 -c copy -f null -
  run remux-volume     $r docker run --rm "${VOLM[@]}" $IMG9 -hide_banner -nostdin -stats -i "$FV" -map 0 -c copy -f null -

  CLIP=(-ss 60 -t 20)
  # ffmpeg 9.0: CUDA decode, NVENC (expected to need driver >= 610)
  run ff9-cuda-decode          $r docker run --rm "${GPU[@]}" "${VOLM[@]}" $IMG9 -hide_banner -nostdin -stats -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$FV" -map 0:v:0 -f null -
  run ff9-hevc_nvenc           $r docker run --rm "${GPU[@]}" "${VOLM[@]}" $IMG9 -hide_banner -nostdin -stats -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$FV" -map 0:v:0 -vf scale_cuda=1920:1080 -c:v hevc_nvenc -preset p4 -b:v 15M -f null -
  # ffmpeg 8.1.2
  run ff8-cuda-decode          $r docker run --rm "${GPU[@]}" "${VOLM[@]}" $IMG8 -hide_banner -nostdin -stats -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$FV" -map 0:v:0 -f null -
  run ff8-scalecuda-hevcnvenc  $r docker run --rm "${GPU[@]}" "${VOLM[@]}" $IMG8 -hide_banner -nostdin -stats -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$FV" -map 0:v:0 -vf scale_cuda=1920:1080 -c:v hevc_nvenc -preset p4 -b:v 15M -f null -
  run ff8-scalecuda-hevcnvenc-bind $r docker run --rm "${GPU[@]}" "${BIND[@]}" $IMG8 -hide_banner -nostdin -stats -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$FB" -map 0:v:0 -vf scale_cuda=1920:1080 -c:v hevc_nvenc -preset p4 -b:v 15M -f null -
  # jellyfin-ffmpeg: CUDA tone-mapping (HDR10 -> SDR 1080p) fully on GPU
  JF=(docker run --rm "${GPU[@]}" "${VOLM[@]}" --entrypoint /usr/lib/jellyfin-ffmpeg/ffmpeg $IMGJF -hide_banner -nostdin -stats)
  run jf-cuda-decode           $r "${JF[@]}" -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$FV" -map 0:v:0 -f null -
  run jf-scalecuda-hevcnvenc   $r "${JF[@]}" -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$FV" -map 0:v:0 -vf scale_cuda=1920:1080 -c:v hevc_nvenc -preset p4 -b:v 15M -f null -
  run jf-tonemapcuda-h264nvenc $r "${JF[@]}" -init_hw_device cuda=cu -filter_hw_device cu -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$FV" -map 0:v:0 -vf "scale_cuda=w=1920:h=1080:format=p010,tonemap_cuda=tonemap=bt2390:peak=100:desat=0:t=bt709:m=bt709:p=bt709:format=nv12" -c:v h264_nvenc -preset p4 -b:v 12M -f null -
  run jf-tonemapcuda-only      $r "${JF[@]}" -init_hw_device cuda=cu -filter_hw_device cu -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$FV" -map 0:v:0 -vf "scale_cuda=w=1920:h=1080:format=p010,tonemap_cuda=tonemap=bt2390:peak=100:desat=0:t=bt709:m=bt709:p=bt709:format=nv12" -f null -
  # host baseline (Windows ffmpeg, same clip, same pipeline that works upstream)
  run host-scalecuda-hevcnvenc $r ffmpeg -hide_banner -nostdin -stats -hwaccel cuda -hwaccel_output_format cuda "${CLIP[@]}" -i "$SRC_DIR/$SRC_NAME" -map 0:v:0 -vf scale_cuda=1920:1080 -c:v hevc_nvenc -preset p4 -b:v 15M -f null -
done

docker volume rm -f $VOL >/dev/null
echo; column -t -s $'\t' "$OUT/summary.tsv"
