#!/usr/bin/env bash
# S5 (throwaway): Range-capable file server for the TV app (nginx, everything mounted read-only).
#   /           → spikes/s5-tv-client/out/www   (samples.json, gen/ test files)
#   /media/...  → media-samples/library
# Usage: bash spikes/s5-tv-client/serve.sh [port]   (default 18381). Stop: docker rm -f pzf-s5-files
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${1:-18381}"
mkdir -p "$HERE/out/www/media" "$HERE/out/www/gen"
# Git Bash: keep container paths as they are; give Docker Windows-style host paths.
export MSYS_NO_PATHCONV=1
win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
docker rm -f pzf-s5-files >/dev/null 2>&1 || true
docker run -d --name pzf-s5-files -p "$PORT:80" \
  -v "$(win "$HERE/out/www"):/usr/share/nginx/html:ro" \
  -v "$(win "$ROOT/media-samples/library"):/usr/share/nginx/html/media:ro" \
  nginx:alpine >/dev/null
echo "File server on http://<laptop IP>:$PORT/ (samples.json, /media/, /gen/)"
