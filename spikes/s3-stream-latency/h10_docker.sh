#!/usr/bin/env bash
# S3/H10 (throwaway): GPU pipelines + NTFS bind-mount I/O inside a Docker Desktop (WSL2) container.
set -uo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd -W 2>/dev/null || pwd)"
IMG=lscr.io/linuxserver/ffmpeg:latest
F=/media/library/movies/Long\ Test\ \(2024\)/Long\ Test\ \(2024\)\ -\ 2160p.mkv
run() { # label, ffmpeg args...
  local label="$1"; shift
  local t0=$(date +%s.%N)
  out=$(docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all -v "$ROOT/media-samples:/media:ro" \
        $IMG -hide_banner -v error -nostdin "$@" 2>&1); rc=$?
  local wall=$(python -c "print(round($(date +%s.%N)-$t0,2))")
  printf '%-62s rc=%-3s wall=%6ss  %s\n' "$label" "$rc" "$wall" "$(echo "$out" | tail -1 | cut -c1-120)"
}
docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all $IMG -hide_banner -version | head -1
run "container startup only (ffmpeg -version)"                 -version
run "I/O: full remux 5 min (copy) from NTFS bind mount RO"     -i "$F" -map 0 -c copy -f null -
run "CUDA decode only 20s 4K HEVC10"                           -hwaccel cuda -hwaccel_output_format cuda -ss 60 -t 20 -i "$F" -map 0:v:0 -f null -
run "CUDA decode + scale_cuda + hevc_nvenc 1080p HDR kept 20s" -hwaccel cuda -hwaccel_output_format cuda -ss 60 -t 20 -i "$F" -map 0:v:0 -vf scale_cuda=1920:1080 -c:v hevc_nvenc -preset p4 -b:v 15M -f null -
run "SW decode + libplacebo(Vulkan) tonemap + h264_nvenc 20s"  -init_hw_device vulkan=vk -filter_hw_device vk -ss 60 -t 20 -i "$F" -map 0:v:0 -vf "libplacebo=w=1920:h=1080:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p" -c:v h264_nvenc -preset p4 -b:v 12M -f null -
run "CUDA decode + libplacebo(Vulkan) + h264_nvenc 20s"        -init_hw_device vulkan=vk -filter_hw_device vk -hwaccel cuda -ss 60 -t 20 -i "$F" -map 0:v:0 -vf "libplacebo=w=1920:h=1080:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p" -c:v h264_nvenc -preset p4 -b:v 12M -f null -
run "CUDA decode + tonemap_opencl + h264_nvenc 20s"            -init_hw_device cuda=cu -init_hw_device opencl=ocl -filter_hw_device ocl -hwaccel cuda -ss 60 -t 20 -i "$F" -map 0:v:0 -vf "format=p010,hwupload,tonemap_opencl=tonemap=bt2390:transfer=bt709:matrix=bt709:primaries=bt709:format=nv12,hwdownload,format=nv12,scale=1920:1080" -c:v h264_nvenc -preset p4 -b:v 12M -f null -
