#!/usr/bin/env bash
# K1 (throwaway): does OpenAPI Generator 7.27.0 produce a Kotlin client that compiles and decodes
# hand-written sample payloads of the Pezzotflix contract? Report: docs/spikes/K1-kotlin-codegen.md.
# Needs Docker. Uses openapitools/openapi-generator-cli:v7.27.0 and gradle:9.8.2-jdk21 (about 1.8 GB
# of images) and Python 3 for the int64 variant. Everything is written under out/ (gitignored).
# Usage:
#   bash spikes/k1-kotlin-codegen/run.sh                  → all five variants
#   bash spikes/k1-kotlin-codegen/run.sh retrofit-long    → only the variant chosen by ADR 0008
#     (the contract-change gate of ADR 0008 until clients/tv exists: it must print 14 "OK" lines)
# Results go to stdout and to out/results.txt.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd -W 2>/dev/null || pwd)"   # Windows path under Git Bash, for docker -v
REPO="$(cd ../.. && (pwd -W 2>/dev/null || pwd))"
export MSYS_NO_PATHCONV=1
rm -rf out
mkdir -p out/spec out/gen out/harness

cp "$REPO/services/video/contract/dist/openapi.json" out/spec/openapi.json
python -I int64.py out/spec/openapi.json out/spec/openapi-int64.json > out/int64.txt

GEN_IMAGE=openapitools/openapi-generator-cli:v7.27.0
PROPS='serializationLibrary=kotlinx_serialization,enumUnknownDefaultCase=true,useCoroutines=true,omitGradleWrapper=true,packageName=dev.pezzotflix.api,dateLibrary=string,sourceFolder=src/main/kotlin'
MAP='AnyType=JsonElement,number=kotlin.Double'
IMPORTS='JsonElement=kotlinx.serialization.json.JsonElement'

# gen <variant> <spec file> <library> [type mappings]
gen() {
  local extra=()
  if [ -n "${4:-}" ]; then extra=(--type-mappings="$4" --import-mappings="$IMPORTS"); fi
  docker run --rm -m 1g -v "$HERE/out:/w" "$GEN_IMAGE" generate -i "/w/spec/$2" -g kotlin \
    -o "/w/gen/$1" --library "$3" "${extra[@]}" --additional-properties="$PROPS" > "out/gen-$1.log" 2>&1 \
    && echo "generate $1: ok" || echo "generate $1: FAILED (out/gen-$1.log)"
}

ALL=(retrofit-raw ktor-mapped retrofit-mapped retrofit-int64 retrofit-long)
if [ "$#" -gt 0 ]; then VARIANTS=("$@"); else VARIANTS=("${ALL[@]}"); fi

for v in "${VARIANTS[@]}"; do
  case "$v" in
    retrofit-raw)    gen "$v" openapi.json       jvm-retrofit2 ;;
    ktor-mapped)     gen "$v" openapi.json       jvm-ktor      "$MAP" ;;
    retrofit-mapped) gen "$v" openapi.json       jvm-retrofit2 "$MAP" ;;
    retrofit-int64)  gen "$v" openapi-int64.json jvm-retrofit2 "$MAP" ;;
    retrofit-long)   gen "$v" openapi.json       jvm-retrofit2 "$MAP,integer=kotlin.Long" ;;
    *) echo "unknown variant: $v (one of: ${ALL[*]})" >&2; exit 2 ;;
  esac
done

cp harness/build.gradle.kts out/harness/
{
  echo 'rootProject.name = "k1-probe"'
  echo 'dependencyResolutionManagement { repositories { mavenCentral() } }'
  for v in "${VARIANTS[@]}"; do echo "include(\"$v\")"; mkdir -p "out/harness/$v"; done
} > out/harness/settings.gradle.kts

# Variants in sequence, one container each; a compile failure does not stop the others.
for v in "${VARIANTS[@]}"; do
  echo "==== $v" | tee -a out/results.txt
  docker run --rm -m 3g -v "$HERE/out/gen:/gen:ro" -v "$HERE/probe:/probe:ro" -v "$HERE/out/harness:/work" \
    -v pzf-k1-gradle:/home/gradle/.gradle -w /work gradle:9.8.2-jdk21 \
    gradle --no-daemon -q -Dorg.gradle.jvmargs=-Xmx1g ":$v:run" > "out/run-$v.log" 2>&1 || true
  # Probe lines start with "OK   ", "FAIL " or "----"; Gradle's "FAILURE:" means the variant did not compile.
  grep -E '^(OK   |FAIL |----)' "out/run-$v.log" | tee -a out/results.txt \
    || { echo "compile FAILED, first errors:"; grep -E '^e: |Caused by: java' "out/run-$v.log" | head -5; } | tee -a out/results.txt
done
docker volume rm pzf-k1-gradle > /dev/null
