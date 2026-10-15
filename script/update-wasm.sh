#!/usr/bin/env bash
# Refresh the vendored gnosis query client from a gnosis checkout.
#
# The plugin builds with no Rust toolchain: the `.wasm` and its JS glue are
# committed under vendor/, and this is the only thing that regenerates them.
# The gnosis revision they came from is recorded beside them, so what is in the
# bundle is always traceable to one commit of the ranking code.
#
#   script/update-wasm.sh ../gnosis
set -euo pipefail

gnosis="${1:?usage: script/update-wasm.sh <path-to-gnosis-checkout>}"
gnosis="$(cd "$gnosis" && pwd)"
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/vendor/gnosis-wasm"

"$gnosis/script/wasm/build.sh" "$out"

rev="$(git -C "$gnosis" rev-parse HEAD)"
status="$(git -C "$gnosis" status --porcelain)"
{
    printf '%s\n' "$rev"
    if [ -n "$status" ]; then
        printf '%s\n' "(built from a dirty working tree)"
    fi
} > "$out/GNOSIS_REV"

# wasm-pack writes a package.json and a .gitignore meant for publishing to npm;
# neither applies to a vendored copy, and the .gitignore would hide it.
rm -f "$out/.gitignore" "$out/package.json"

printf 'vendored gnosis %s\n' "$rev"
