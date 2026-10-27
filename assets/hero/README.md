# Hero render

The Blender scene behind `docs/images/hero.png` (top of the README) and
`docs/images/social-card.png` (the 1200×630 image for link previews). The UI
on the panels is exported from the plugin's Penpot design, so it changes only
when the design does.

| File | What it is |
| --- | --- |
| `gnosis-hero.blend` | The scene: open it to tweak the camera, lights or layout by hand. |
| `tex/raw/` | The Penpot exports, unedited. |
| `tex/` | The textures the scene uses, made from the exports by `prep.py`. |
| `prep.py` | Rounds the exports' corners, adds a hairline edge, and empties the window's right split. |
| `build_scene.py` | Builds `gnosis-hero.blend` from scratch. |
| `render.py` | Renders the images into `docs/images/`. |
| `blender.sh` | Runs Blender from this folder, with the color fix below when it's in place. |
| `fix-ocio.sh` | Works around a broken color config in some Blender builds. |

## Rendering

```sh
./blender.sh -b gnosis-hero.blend -P render.py
```

This renders both images with Cycles; at 384 samples, expect a few minutes
each. To check a tweak quickly, render one image at a smaller size and sample
count:

```sh
./blender.sh -b gnosis-hero.blend -P render.py -- 1200x675 /tmp/preview.png 64
```

To tweak the scene, run `./blender.sh` with no arguments, then save the
`.blend` when you're done.

### Washed-out renders

Some distro builds of Blender, including Fedora's 5.2, ship a color config
newer than their color library can read. Blender then logs
`Loading the OCIO profile ... failed` and renders without color management,
which looks flat and grey. Run `./fix-ocio.sh` once: it writes a patched copy
of the config to `.ocio/` (not committed), and `blender.sh` uses it from then
on.

## Updating the UI

1. In Penpot, open the plugin's design file and make sure the **Dark** theme
   is active.
2. Export these boards as PNG into `tex/raw/`:
   - `window.png`: the "Related notes · ready" screen, at 2x.
   - `search.png`: the SearchPrompt board inside "Search · semantic results",
     at 3x, with its shadow.
   - `related.png`: the right split of "Related notes · ready", at 3x.
3. Run `python3 prep.py` (it needs Pillow).
4. Render. The `.blend` picks up the new textures by path.

If you've just switched Penpot's theme, check the exported text colors. Penpot
caches each text's layout, glyph colors included, and a theme switch doesn't
refresh it. Retyping a text refreshes it. That includes the texts in the main
components, which instances fall back to.

`prep.py`'s crop and fill rectangles are in export pixels, so if a board
changes size, update them to match.

## Rebuilding the scene

```sh
./blender.sh -b -P build_scene.py
```

This overwrites `gnosis-hero.blend`, including any changes made in Blender by
hand, so only run it to start over. The scene uses 1 mm per Penpot px.
Everything hangs off the `Stack` empty, so moving or rotating it re-poses the
whole composition.
