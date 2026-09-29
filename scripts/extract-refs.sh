#!/bin/sh
# Regenerate the read-only upstream reference sources under refs/ from the two
# committed zips.
#
# refs/ is gitignored: it is 60 MB+ of upstream code that zeke does not ship and
# does not depend on at runtime. It exists so a contributor can read the real
# GLM-Free-API handlers and oh-my-pi's agent loop next to zeke's own source.
#
# Usage: scripts/extract-refs.sh [--glm|--omp]
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
refs="$root/refs"

want_glm=1
want_omp=1
case "${1:-}" in
  --glm) want_omp=0 ;;
  --omp) want_glm=0 ;;
  "") ;;
  *) echo "usage: $0 [--glm|--omp]" >&2; exit 2 ;;
esac

# `unzip` is not always present; fall back to Node's own zlib-free path via the
# same extractor zeke uses at runtime, so this works anywhere zeke works.
extract() {
  zip=$1
  dest=$2
  [ -f "$zip" ] || { echo "missing $zip" >&2; exit 1; }
  rm -rf "$dest"
  mkdir -p "$dest"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$zip" -d "$dest"
  else
    echo "unzip not found; using zeke's extractor" >&2
    node -e '
      const { extractZipNode } = await import("./src/bridge/build.js");
      const [zip, dest] = process.argv.slice(1);
      await extractZipNode(zip, dest);
    ' --input-type=module "$zip" "$dest"
  fi
}

if [ "$want_glm" = 1 ]; then
  zip=$(ls "$root"/GLM-Free-API*.zip 2>/dev/null | head -1 || true)
  if [ -n "$zip" ]; then
    extract "$zip" "$refs/glm"
    echo "glm  -> refs/glm/$(ls "$refs/glm" | head -1)"
  else
    echo "no GLM-Free-API zip found; skipping" >&2
  fi
fi

if [ "$want_omp" = 1 ]; then
  zip=$(ls "$root"/oh-my-pi*.zip 2>/dev/null | head -1 || true)
  if [ -n "$zip" ]; then
    extract "$zip" "$refs/omp"
    echo "omp  -> refs/omp/$(ls "$refs/omp" | head -1)"
  else
    echo "no oh-my-pi zip found; skipping" >&2
  fi
fi

echo "done. refs/ is gitignored and regenerable."
