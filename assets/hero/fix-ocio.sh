#!/bin/sh
# Some distro builds of Blender (e.g. Fedora's 5.2) ship an OCIO 2.5 color config that their
# OCIO 2.4 library can't read. Blender then silently disables color management and every render
# comes out washed out. This writes a locally patched copy to .ocio/, which blender.sh picks up.
# Only needed when Blender logs "Loading the OCIO profile ... failed" on startup.
set -eu
here=$(dirname "$(readlink -f "$0")")
src=$(blender -b --factory-startup --python-expr \
	"import bpy; print('CM_DIR=' + bpy.utils.system_resource('DATAFILES', path='colormanagement'))" 2>/dev/null |
	sed -n 's/^CM_DIR=//p')
rm -rf "$here/.ocio"
cp -r "$src" "$here/.ocio"
# Declare the version the library supports and drop the keys 2.4 doesn't know.
sed -i \
	-e 's/^ocio_profile_version: 2\.5/ocio_profile_version: 2.4/' \
	-e '/^ *interop_id:/d' \
	-e '/^ *interchange:$/{N;d}' \
	"$here/.ocio/config.ocio"
echo "patched config written to $here/.ocio/config.ocio"
