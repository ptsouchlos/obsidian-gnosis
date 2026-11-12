#!/usr/bin/env bash
# Refresh the vendored gnosis wasm bundles, from a gnosis checkout or a release.
#
# The plugin builds with no Rust toolchain: the `.wasm` and its JS glue are
# committed under vendor/, and this is the only thing that regenerates them.
# The gnosis revision each came from is recorded beside it in GNOSIS_REV, so
# what is in a bundle is always traceable to one commit of gnosis.
#
# Two bundles are vendored, each in its own directory:
#
#   vendor/gnosis-wasm/     the query client: the index, ranking, and search
#   vendor/gnosis-extract/  the PDF text extractor (parse_pdf, pdf-extract)
#
# The extraction bundle is kept separate from the query client on purpose: a
# panic in pdf-extract is a trap under the wasm-release profile, and the plugin
# must not let one malformed PDF take down the instance that still holds the
# build's queries. The plugin runs every PDF in the extraction bundle's own
# wasm instance (src/worker/extract-worker.ts); a trap or a hang there kills
# only that instance, and the file is skipped.
#
# Each directory holds the bundle's .wasm, its JS glue, its typings, the crate
# README, and the shared LICENSE and THIRD_PARTY_NOTICES.txt. One notices file
# covers both: the query client links every crate the extraction bundle links.
#
#   script/update-wasm.sh ../gnosis                   build from a checkout
#   script/update-wasm.sh --release [vX.Y.Z]          a gnosis release (default: the latest)
#   script/update-wasm.sh --archive <wasm> <extract>  release assets already on disk
#
# A release asset is used as is, never rebuilt: it is checked against the
# .sha256 published with it, and must hold the files vendor/ commits.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out_wasm="$here/vendor/gnosis-wasm"
out_extract="$here/vendor/gnosis-extract"
repo="ptsouchlos/gnosis"

usage() {
    cat >&2 <<'EOF'
usage: script/update-wasm.sh <path-to-gnosis-checkout>
       script/update-wasm.sh --release [vX.Y.Z]
       script/update-wasm.sh --archive <wasm.tar.gz> <extract.tar.gz>
EOF
    exit 2
}

# tidy_typings <dir>: make wasm-pack's typings pass the community directory's
# review, which lints vendored code too. Drop the `/* tslint:disable */` and
# `/* eslint-disable */` lines they open with, since the review rejects a
# blanket disable, and type what crosses the boundary as `unknown` rather than
# `any`, which the review warns about and may not be disabled. The plugin
# already casts every such value to its own type (`src/types.ts`).
tidy_typings() {
    local dir="$1" f
    for f in "$dir"/*.d.ts; do
        [ -e "$f" ] || continue
        sed -i -E \
            -e '/^\/\* tslint:disable \*\/$/d' -e '/^\/\* eslint-disable \*\/$/d' \
            -e '/^\s*(\/\*\*|\*)/!s/\bany\b/unknown/g' "$f"
    done
}

# drop_npm <dir>: wasm-pack writes a package.json and a .gitignore meant for
# publishing to npm; neither applies to a vendored copy, and the .gitignore
# would hide the directory from git.
drop_npm() {
    rm -f "$1/.gitignore" "$1/package.json"
}

# install_archive <archive> <dest> <required-file>...: verify <archive> against
# <archive>.sha256, then replace <dest> with its contents.
install_archive() {
    local archive dest dir name stage f
    archive="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    dest="$2"
    shift 2
    dir="$(dirname "$archive")"
    name="$(basename "$archive")"
    [ -f "$archive.sha256" ] || {
        echo "error: no $name.sha256 beside $archive" >&2
        exit 1
    }
    (cd "$dir" && sha256sum --check --quiet "$name.sha256")

    # Unpacked beside vendor/, so the swap is a rename on one filesystem, and a
    # bad archive never leaves the directory half replaced.
    stage="$(mktemp -d "$here/vendor/.staging.XXXXXX")"
    trap 'rm -rf "$stage"' EXIT
    tar -xzf "$archive" -C "$stage"
    for f in "$@"; do
        [ -f "$stage/$f" ] || {
            echo "error: $name has no $f" >&2
            exit 1
        }
    done
    rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    mv "$stage" "$dest"
    chmod 755 "$dest"
    trap - EXIT
    tidy_typings "$dest"
}

case "${1:-}" in
"")
    usage
    ;;
--archive)
    wasm_archive="${2:?usage: script/update-wasm.sh --archive <wasm.tar.gz> <extract.tar.gz>}"
    extract_archive="${3:?usage: script/update-wasm.sh --archive <wasm.tar.gz> <extract.tar.gz>}"
    install_archive "$wasm_archive" "$out_wasm" \
        GNOSIS_REV gnosis_wasm.js gnosis_wasm_bg.wasm
    install_archive "$extract_archive" "$out_extract" \
        GNOSIS_REV gnosis_extract.js gnosis_extract_bg.wasm
    printf 'vendored gnosis %s\n' "$(head -n1 "$out_wasm/GNOSIS_REV")"
    ;;
--release)
    tag="${2:-}"
    if [ -z "$tag" ]; then
        tag="$(gh release view --repo "$repo" --json tagName --jq .tagName)"
    fi
    download="$(mktemp -d)"
    trap 'rm -rf "$download"' EXIT
    gh release download "$tag" --repo "$repo" --dir "$download" \
        --pattern "gnosis-wasm-$tag.tar.gz" --pattern "gnosis-wasm-$tag.tar.gz.sha256" \
        --pattern "gnosis-extract-$tag.tar.gz" --pattern "gnosis-extract-$tag.tar.gz.sha256"
    install_archive "$download/gnosis-wasm-$tag.tar.gz" "$out_wasm" \
        GNOSIS_REV gnosis_wasm.js gnosis_wasm_bg.wasm
    install_archive "$download/gnosis-extract-$tag.tar.gz" "$out_extract" \
        GNOSIS_REV gnosis_extract.js gnosis_extract_bg.wasm
    printf 'vendored gnosis %s\n' "$(head -n1 "$out_wasm/GNOSIS_REV")"
    rm -rf "$download"
    ;;
-*)
    usage
    ;;
*)
    gnosis="$(cd "$1" && pwd)"

    for s in script/wasm/build.sh script/wasm/build-extract.sh script/release/notices.sh LICENSE; do
        [ -f "$gnosis/$s" ] || {
            echo "error: no $s in $gnosis; is this a gnosis checkout with the PDF extraction bundle?" >&2
            exit 1
        }
    done

    # Both bundles build from the one checkout, into their own vendor
    # directories, over the copies already committed.
    mkdir -p "$out_wasm" "$out_extract"
    "$gnosis/script/wasm/build.sh" "$out_wasm"
    "$gnosis/script/wasm/build-extract.sh" "$out_extract"

    # The shared LICENSE and the third-party notices for both bundles' crate
    # graphs. One notices file covers both: the query client links every crate
    # the extraction bundle links (see script/release/notices.sh in gnosis).
    notices="$(mktemp)"
    trap 'rm -f "$notices"' EXIT
    "$gnosis/script/release/notices.sh" "$notices"
    cp "$gnosis/LICENSE" "$out_wasm/LICENSE"
    cp "$gnosis/LICENSE" "$out_extract/LICENSE"
    # cat, not cp: a mktemp file is 0600, and vendor/ commits 0644.
    cat "$notices" >"$out_wasm/THIRD_PARTY_NOTICES.txt"
    cat "$notices" >"$out_extract/THIRD_PARTY_NOTICES.txt"
    chmod 644 "$out_wasm/THIRD_PARTY_NOTICES.txt" "$out_extract/THIRD_PARTY_NOTICES.txt"

    rev="$(git -C "$gnosis" rev-parse HEAD)"
    status="$(git -C "$gnosis" status --porcelain)"
    {
        printf '%s\n' "$rev"
        if [ -n "$status" ]; then
            printf '%s\n' "(built from a dirty working tree)"
        fi
    } | tee "$out_wasm/GNOSIS_REV" >"$out_extract/GNOSIS_REV"

    drop_npm "$out_wasm"
    drop_npm "$out_extract"
    tidy_typings "$out_wasm"
    tidy_typings "$out_extract"

    printf 'vendored gnosis %s\n' "$rev"
    ;;
esac
