#!/usr/bin/env bash
# Install the built plugin into a vault, for trying it in Obsidian.
#
# The community-plugin channel ships three files and so does this: main.js,
# manifest.json, styles.css. Nothing else is needed, and nothing else is
# copied — if the plugin works from these three it works from a release.
#
#   script/install.sh ~/vaults/notes
set -euo pipefail

vault="${1:?usage: script/install.sh <vault>}"
here="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$here/main.js" ]; then
    printf 'main.js is missing — run `npm run build` first\n' >&2
    exit 1
fi

id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$here/manifest.json")"
dest="$vault/.obsidian/plugins/$id"
mkdir -p "$dest"
cp "$here/main.js" "$here/manifest.json" "$here/styles.css" "$dest/"
printf 'installed %s into %s\n' "$id" "$dest"
