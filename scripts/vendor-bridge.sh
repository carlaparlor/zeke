#!/bin/sh
# Vendor the GLM-Free-API bridge source into vendor/glm-free-api/.
#
# This is what `zeke setup` does programmatically (src/bridge/build.js). The
# script exists so the same thing can be done by hand, in CI, or on a machine
# where you would rather not run zeke first.
#
#   scripts/vendor-bridge.sh [--refresh] [path/to/GLM-Free-API.zip]
#
# Upstream ships no go.mod on purpose; `zeke setup` creates one named `zai-api`
# because main.go imports zai-api/internal/zbridge.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest="$root/vendor/glm-free-api"
refresh=0

for arg in "$@"; do
  case "$arg" in
    --refresh) refresh=1 ;;
    -h|--help) echo "usage: $0 [--refresh] [zip]"; exit 0 ;;
    *) zip=$arg ;;
  esac
done

zip=${zip:-$(ls "$root"/GLM-Free-API*.zip 2>/dev/null | head -1 || true)}
if [ -z "$zip" ] || [ ! -f "$zip" ]; then
  echo "no GLM-Free-API zip found in $root" >&2
  echo "zeke vendors the bridge from a committed zip; pass its path explicitly." >&2
  exit 1
fi

echo "zip:  $zip"
echo "dest: $dest"

if [ "$refresh" = 1 ]; then
  rm -rf "$dest"
fi

mkdir -p "$dest"

# Extract to a temp dir, then flatten the single top-level directory upstream
# ships (GLM-Free-API-main/), and drop the .assets blobs: they are images for
# the README and cost megabytes the bridge never reads.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

if command -v unzip >/dev/null 2>&1; then
  unzip -q "$zip" -d "$tmp"
else
  node --input-type=module -e '
    const { extractZipNode } = await import(process.argv[1] + "/src/bridge/build.js");
    await extractZipNode(process.argv[2], process.argv[3]);
  ' "$root" "$zip" "$tmp"
fi

# Flatten a single wrapping directory, if there is exactly one.
entries=$(ls -A "$tmp")
count=$(printf '%s\n' "$entries" | grep -c . || true)
if [ "$count" = 1 ]; then
  src="$tmp/$entries"
else
  src="$tmp"
fi

# Copy everything except .assets (and any VCS metadata).
( cd "$src" && find . -name '.assets' -prune -o -name '.git' -prune -o -type f -print ) |
  while IFS= read -r file; do
    mkdir -p "$dest/$(dirname "$file")"
    cp "$src/$file" "$dest/$file"
  done

# Sanity-check the layout zeke's builder requires.
for required in main.go internal/zbridge/middleware.go internal/zbridge/handlers.go; do
  if [ ! -f "$dest/$required" ]; then
    echo "vendored source is missing $required — wrong zip?" >&2
    exit 1
  fi
done

files=$(find "$dest" -type f | wc -l | tr -d ' ')
size=$(du -sh "$dest" | cut -f1)
echo "vendored $files files ($size)"
echo
echo "next: zeke setup        # builds the bridge into \$ZEKE_HOME/bin"
echo "  or: (cd vendor/glm-free-api && go mod init zai-api && go mod tidy && go build -o zai-api .)"
