"""Render the hero images from gnosis-hero.blend.

    ./blender.sh -b gnosis-hero.blend -P render.py
        renders every image in OUTPUTS into docs/images/
    ./blender.sh -b gnosis-hero.blend -P render.py -- 1920x1080 /tmp/preview.png [samples]
        renders one image, e.g. to check a tweak quickly

Nothing is saved back to the .blend; only the output size changes between images.
"""
import sys
from pathlib import Path

import bpy

HERE = Path(__file__).resolve().parent
IMAGES = HERE.parent.parent / "docs" / "images"

OUTPUTS = [
    (2400, 1350, IMAGES / "hero.png"),
    (1200, 630, IMAGES / "social-card.png"),
]


def render(width, height, out, samples=None):
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    if samples:
        scene.cycles.samples = samples
    scene.render.filepath = str(out)
    bpy.ops.render.render(write_still=True)


args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
if args:
    size, out, *rest = args
    w, h = (int(n) for n in size.split("x"))
    render(w, h, Path(out), int(rest[0]) if rest else None)
else:
    for w, h, out in OUTPUTS:
        render(w, h, out)
