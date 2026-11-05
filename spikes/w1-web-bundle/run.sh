#!/usr/bin/env bash
# W1 (throwaway): production bundle size of the web-client candidates, for doc 05 §7.4 and ADR 0005.
# Needs Node 26.13 on PATH and the npm registry. Everything is built under out/ (gitignored-style scratch).
# Usage: bash spikes/w1-web-bundle/run.sh   → prints out/results.txt
set -euo pipefail
cd "$(dirname "$0")"
rm -rf out
mkdir -p out

COMMON='"openapi-fetch":"0.17.0","hls.js":"1.7.4","libpgs":"0.9.0"'
REACT='"react":"19.3.1","react-dom":"19.3.1","@tanstack/react-query":"5.106.1"'
REACT_DEV='"@vitejs/plugin-react":"6.2.1","@types/react":"19.3.0","@types/react-dom":"19.3.0"'

# mk <name> <deps> <devdeps> <plugin import> <plugin call> <entry>
mk() {
  local d="out/$1"
  mkdir -p "$d/src"
  cp src/* "$d/src/"
  printf '{"name":"w1-%s","private":true,"type":"module","dependencies":{%s,%s},"devDependencies":{"vite":"8.3.6","typescript":"6.0.3",%s}}\n' \
    "$1" "$COMMON" "$2" "$3" > "$d/package.json"
  printf 'import %s;\nexport default { plugins: [%s] };\n' "$4" "$5" > "$d/vite.config.js"
  printf '<!doctype html><div id="root"></div><script type="module" src="/src/%s"></script>\n' "$6" > "$d/index.html"
  (cd "$d" && npm i --ignore-scripts --no-audit --no-fund --silent > /dev/null && npx vite build 2>&1 | grep -E 'assets/' | sed "s#^#$1 #") >> out/results.txt
}

mk a0-react-query "$REACT" "$REACT_DEV" "react from '@vitejs/plugin-react'" "react()" react-query.jsx
mk a1-react-tanstack-router "$REACT,\"@tanstack/react-router\":\"1.170.46\"" "$REACT_DEV" "react from '@vitejs/plugin-react'" "react()" react-tanstack-router.jsx
mk a2-react-react-router "$REACT,\"react-router\":\"8.5.1\"" "$REACT_DEV" "react from '@vitejs/plugin-react'" "react()" react-react-router.jsx
mk b0-svelte-query '"svelte":"5.57.3","@tanstack/svelte-query":"6.3.11"' '"@sveltejs/vite-plugin-svelte":"7.3.1"' "{ svelte } from '@sveltejs/vite-plugin-svelte'" "svelte()" svelte-main.js

# Type check in the a1 workspace: strict, skipLibCheck false, with the shims of src/ambient.d.mts.
(
  cd out/a1-react-tanstack-router
  printf '%s\n' '{"compilerOptions":{"target":"ES2024","module":"ESNext","moduleResolution":"bundler","jsx":"react-jsx","strict":true,"noEmit":true,"skipLibCheck":false,"lib":["ES2024","DOM","DOM.Iterable"],"types":[]},"include":["src/check.tsx","src/ambient.d.mts"]}' > tsconfig.json
  if npx tsc -p .; then echo "tsc strict skipLibCheck=false with shims: ok"; else echo "tsc strict skipLibCheck=false with shims: FAIL"; fi
) >> out/results.txt 2>&1

cat out/results.txt
