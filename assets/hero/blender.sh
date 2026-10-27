#!/bin/sh
# Run Blender from this directory, with the patched color config from fix-ocio.sh when present.
#   ./blender.sh                  open gnosis-hero.blend to tweak it
#   ./blender.sh -b -P render.py  any other Blender arguments pass straight through
here=$(dirname "$(readlink -f "$0")")
cd "$here" || exit 1
if [ -f .ocio/config.ocio ]; then
	export OCIO="$here/.ocio/config.ocio"
fi
if [ $# -eq 0 ]; then
	set -- gnosis-hero.blend
fi
exec blender "$@"
