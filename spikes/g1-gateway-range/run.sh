#!/bin/sh
# Throwaway: compare gateway Range pass-through and upstream read-ahead.
set -u
export MSYS_NO_PATHCONV=1
D=$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)
mkdir -p out
docker network create g1net >/dev/null 2>&1
docker volume create g1data >/dev/null
docker run --rm -v g1data:/data alpine:latest sh -c '[ -f /data/big.bin ] || head -c 1073741824 /dev/urandom > /data/big.bin; ls -l /data'
docker rm -f g1origin g1caddy g1nginx g1nginxnb >/dev/null 2>&1
docker run -d --name g1origin --network g1net --network-alias origin -v g1data:/data:ro -v "$D/Caddyfile.origin:/etc/caddy/Caddyfile:ro" caddy:2.11-alpine >/dev/null
docker run -d --name g1caddy --network g1net -v "$D/Caddyfile.proxy:/etc/caddy/Caddyfile:ro" caddy:2.11-alpine >/dev/null
docker run -d --name g1nginx --network g1net -v "$D/nginx-default.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.30-alpine >/dev/null
docker run -d --name g1nginxnb --network g1net -v "$D/nginx-nobuf.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.30-alpine >/dev/null
sleep 3
docker exec g1caddy caddy version > out/versions.txt; docker exec g1nginx nginx -v 2>> out/versions.txt
for P in g1caddy g1nginx g1nginxnb; do
  for r in 1 2; do
    echo "== $P run $r" 
    docker run --rm --network g1net curlimages/curl:latest -s -o /dev/null -H 'Range: bytes=500000000-500000999' -w 'range: code=%{http_code} size=%{size_download} ttfb=%{time_starttransfer}\n' http://$P:8080/big.bin
    docker run --rm --network g1net curlimages/curl:latest -s -o /dev/null -w 'full: code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' http://$P:8080/big.bin
    docker run --rm --network g1net curlimages/curl:latest -s -o /dev/null --limit-rate 5M --max-time 4 -w 'throttled: client_got=%{size_download}\n' http://$P:8080/big.bin
    sleep 2
    echo -n "origin bytes written for last request: "; docker logs g1origin 2>/dev/null | tail -1 | sed -n 's/.*"size":\([0-9]*\).*/\1/p'
  done
done
docker logs g1origin > out/origin.log 2>&1
docker rm -f g1origin g1caddy g1nginx g1nginxnb >/dev/null
