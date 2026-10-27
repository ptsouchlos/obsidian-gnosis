"""Turn the raw Penpot exports in tex/raw/ into the textures the Blender scene uses.

    python3 prep.py   # needs Pillow

Raw exports (see README.md for how to make them), all with the Dark theme active:
    window.png   "Related notes · ready" screen at 2x
    search.png   the SearchPrompt board from "Search · semantic results" at 3x (with its shadow)
    related.png  the right split of "Related notes · ready" at 3x
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

HERE = Path(__file__).resolve().parent
# Faint border that keeps a floating panel's outline against the window behind it.
HAIRLINE = (255, 255, 255, 40)


def rounded(im, radius, hairline=0):
    """Rounded-corner alpha, optionally with a HAIRLINE border."""
    im = im.convert("RGBA")
    s = 4  # supersample the mask for a clean edge
    mask = Image.new("L", (im.width * s, im.height * s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, mask.width - 1, mask.height - 1), radius * s, fill=255)
    im.putalpha(ImageChops.multiply(im.getchannel("A"), mask.resize(im.size, Image.LANCZOS)))
    if hairline:
        border = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ImageDraw.Draw(border).rounded_rectangle(
            (0, 0, im.width - 1, im.height - 1), radius, outline=HAIRLINE, width=hairline
        )
        im = Image.alpha_composite(im, border)
    return im


raw, out = HERE / "tex" / "raw", HERE / "tex"

# Empty the right split under its tab header: the related panel floats in front of it instead.
win = Image.open(raw / "window.png").convert("RGB")
ImageDraw.Draw(win).rectangle((2284, 80, 2879, 1745), fill=win.getpixel((2860, 1500)))
rounded(win, 10 * 2).save(out / "window.png")

# The board export carries its drop shadow as padding; keep only the opaque panel.
search = Image.open(raw / "search.png").convert("RGBA")
search = search.crop(search.getchannel("A").point(lambda v: 255 if v >= 250 else 0).getbbox())
rounded(search, 12 * 3, hairline=4).save(out / "search.png")

# Drop the empty tail under the last related result.
related = Image.open(raw / "related.png").crop((0, 0, 900, 1740))
rounded(related, 10 * 3, hairline=4).save(out / "related.png")
print("textures ->", out)
