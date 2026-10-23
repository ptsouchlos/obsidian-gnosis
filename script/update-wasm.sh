#!/usr/bin/env bash
# Refresh the vendored gnosis query client, from a gnosis checkout or a release.
#
# The plugin builds with no Rust toolchain: the `.wasm` and its JS glue are
# committed under vendor/, and this is the only thing that regenerates them.
# The gnosis revision they came from is recorded beside them, so what is in the
# bundle is always traceable to one commit of the ranking code.
#
#   script/update-wasm.sh ../gnosis                   build from a checkout
#   script/update-wasm.sh --release [vX.Y.Z]          a gnosis release (default: the latest)
#   script/update-wasm.sh --archive <file.tar.gz>     a release asset already on disk
#
# A release asset is used as is, never rebuilt: it is checked against the
# .sha256 published with it, and must hold the files vendor/ commits.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/vendor/gnosis-wasm"
repo="ptsouchlos/gnosis"

usage() {
    cat >&2 <<'EOF'
usage: script/update-wasm.sh <path-to-gnosis-checkout>
       script/update-wasm.sh --release [vX.Y.Z]
       script/update-wasm.sh --archive <file.tar.gz>
EOF
    exit 2
}

# tidy_typings: make wasm-pack's typings pass the community directory's
# review, which lints vendored code too. Drop the `/* tslint:disable */` and
# `/* eslint-disable */` lines they open with, since the review rejects a
# blanket disable, and type what crosses the boundary as `unknown` rather than
# `any`, which the review warns about and may not be disabled. The plugin
# already casts every such value to its own type (`src/types.ts`).
tidy_typings() {
    local f
    for f in "$out"/*.d.ts; do
        sed -i -E \
            -e '/^\/\* tslint:disable \*\/$/d' -e '/^\/\* eslint-disable \*\/$/d' \
            -e '/^\s*(\/\*\*|\*)/!s/\bany\b/unknown/g' "$f"
    done
}

# install_archive <file.tar.gz>: verify against <file.tar.gz>.sha256, then
# replace vendor/gnosis-wasm with its contents.
install_archive() {
    local archive dir name stage
    archive="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    dir="$(dirname "$archive")"
    name="$(basename "$archive")"
    [ -f "$archive.sha256" ] || {
        echo "error: no $name.sha256 beside $archive" >&2
        exit 1
    }
    (cd "$dir" && sha256sum --check --quiet "$name.sha256")

    # Unpacked beside vendor/gnosis-wasm, so the swap is a rename on one
    # filesystem, and a bad archive never leaves vendor/ half replaced.
    stage="$(mktemp -d "$here/vendor/.gnosis-wasm.XXXXXX")"
    trap 'rm -rf "$stage"' EXIT
    tar -xzf "$archive" -C "$stage"
    for f in GNOSIS_REV gnosis_wasm.js gnosis_wasm_bg.wasm; do
        [ -f "$stage/$f" ] || {
            echo "error: $name has no $f" >&2
            exit 1
        }
    done
    rm -rf "$out"
    mv "$stage" "$out"
    chmod 755 "$out"
    trap - EXIT
    tidy_typings
    printf 'vendored gnosis %s\n' "$(paste -sd ' ' "$out/GNOSIS_REV")"
}

case "${1:-}" in
"")
    usage
    ;;
--archive)
    install_archive "${2:?usage: script/update-wasm.sh --archive <file.tar.gz>}"
    ;;
--release)
    tag="${2:-}"
    if [ -z "$tag" ]; then
        tag="$(gh release view --repo "$repo" --json tagName --jq .tagName)"
    fi
    download="$(mktemp -d)"
    trap 'rm -rf "$download"' EXIT
    gh release download "$tag" --repo "$repo" --dir "$download" \
        --pattern "gnosis-wasm-$tag.tar.gz" --pattern "gnosis-wasm-$tag.tar.gz.sha256"
    install_archive "$download/gnosis-wasm-$tag.tar.gz"
    rm -rf "$download"
    ;;
-*)
    usage
    ;;
*)
    gnosis="$(cd "$1" && pwd)"
    "$gnosis/script/wasm/build.sh" "$out"

    rev="$(git -C "$gnosis" rev-parse HEAD)"
    status="$(git -C "$gnosis" status --porcelain)"
    {
        printf '%s\n' "$rev"
        if [ -n "$status" ]; then
            printf '%s\n' "(built from a dirty working tree)"
        fi
    } >"$out/GNOSIS_REV"

    # wasm-pack writes a package.json and a .gitignore meant for publishing to
    # npm; neither applies to a vendored copy, and the .gitignore would hide it.
    rm -f "$out/.gitignore" "$out/package.json"
    tidy_typings

    printf 'vendored gnosis %s\n' "$rev"
    ;;
esac
