"""Rebuild gnosis-hero.blend from scratch, using the textures in tex/ (see prep.py).

    ./blender.sh -b -P build_scene.py

This overwrites gnosis-hero.blend, including any hand tweaks made in Blender, so
only run it to start over. Units: 1 Penpot px = 1 mm. Everything hangs off the
"Stack" empty, so rotating or moving that empty re-poses the whole composition.
"""
import math
from pathlib import Path

import bpy

HERE = Path(__file__).resolve().parent
tex_dir = HERE / "tex"
out_blend = HERE / "gnosis-hero.blend"

PX = 0.001
ACCENT = (0.540, 0.361, 0.959)  # hsl(258 88% 66%), Obsidian's default accent


def srgb_to_linear(c):
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def ui_material(name, image_path, emission=0.7, diffuse=0.75):
    """UI surface: mostly self-lit so it keeps its design colors, with a diffuse share so it catches shadows."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    img = nt.nodes.new("ShaderNodeTexImage")
    img.image = bpy.data.images.load(image_path)
    img.interpolation = "Cubic"
    share = nt.nodes.new("ShaderNodeMix")
    share.data_type = "RGBA"
    share.blend_type = "MULTIPLY"
    share.inputs["Factor"].default_value = 1.0
    nt.links.new(img.outputs["Color"], share.inputs["A"])
    share.inputs["B"].default_value = (diffuse, diffuse, diffuse, 1)
    nt.links.new(share.outputs["Result"], bsdf.inputs["Base Color"])
    nt.links.new(img.outputs["Color"], bsdf.inputs["Emission Color"])
    nt.links.new(img.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Emission Strength"].default_value = emission
    bsdf.inputs["Roughness"].default_value = 0.35
    bsdf.inputs["Specular IOR Level"].default_value = 0.25
    return mat


def ui_panel(name, image, w_px, h_px, parent, loc, emission=0.7):
    bpy.ops.mesh.primitive_plane_add(size=1)
    ob = bpy.context.object
    ob.name = name
    ob.scale = (w_px * PX, h_px * PX, 1)
    bpy.ops.object.transform_apply(scale=True)
    ob.data.materials.append(ui_material(name, str(tex_dir / image), emission))
    ob.parent = parent
    ob.location = loc
    return ob


def glass_material():
    mat = bpy.data.materials.new("Glass")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*srgb_to_linear((0.82, 0.80, 0.90)), 1)
    bsdf.inputs["Transmission Weight"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = 0.4  # frosted
    bsdf.inputs["IOR"].default_value = 1.45
    bsdf.inputs["Coat Weight"].default_value = 0.6  # crisp highlight on top of the frost
    bsdf.inputs["Coat Roughness"].default_value = 0.03
    return mat


def rounded_slab(name, w, h, radius, thickness, bevel, mat, segments=10):
    """A rounded-rectangle glass slab whose top face sits at z=0."""
    import bmesh

    bm = bmesh.new()
    pts = []
    corners = [(w / 2 - radius, h / 2 - radius, 0), (-w / 2 + radius, h / 2 - radius, 90),
               (-w / 2 + radius, -h / 2 + radius, 180), (w / 2 - radius, -h / 2 + radius, 270)]
    for cx, cy, start in corners:
        for i in range(segments + 1):
            a = math.radians(start + 90 * i / segments)
            pts.append(bm.verts.new((cx + radius * math.cos(a), cy + radius * math.sin(a), 0)))
    face = bm.faces.new(pts)
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    bmesh.ops.translate(bm, verts=[v for v in ext["geom"] if isinstance(v, bmesh.types.BMVert)], vec=(0, 0, -thickness))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    bev = ob.modifiers.new("Bevel", "BEVEL")
    bev.width = bevel
    bev.segments = 4
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(40)
    ob.modifiers.new("Smooth", "WEIGHTED_NORMAL")
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(mat)
    return ob


def glass_panel(name, image, w_px, h_px, radius_px, parent, loc, glass, thickness=0.012, emission=0.7):
    """Glass slab with the UI printed just above its top face; move the slab and the UI follows."""
    slab = rounded_slab(name, w_px * PX, h_px * PX, radius_px * PX, thickness, 0.004, glass)
    slab.parent = parent
    slab.location = loc
    ui = ui_panel(f"{name} UI", image, w_px, h_px, slab, (0, 0, 0.0004), emission)
    # keep the slab from reflecting/refracting its own UI (reads as doubled text)
    ui.visible_glossy = False
    ui.visible_transmission = False
    return slab


# --- composition -----------------------------------------------------------
# The window stands upright like a monitor facing -Y. In Stack-local coordinates x is right,
# y is up and +z points out of the screen toward the viewer.
stack = bpy.data.objects.new("Stack", None)
scene.collection.objects.link(stack)
stack.rotation_euler = (math.radians(90), 0, 0)

glass = glass_material()
# dimmed so the floating panels lead
glass_panel("Window", "window.png", 1440, 900, 10, stack, (0, 0, 0), glass, thickness=0.018, emission=0.45)
# related panel has come part-way off the window's right edge
glass_panel("Related", "related.png", 300, 580, 10, stack, (0.6, 0.04, 0.1), glass)
# search prompt is the hero: furthest forward, closest to the camera, overlapping the related panel
glass_panel("Search", "search.png", 700, 389, 12, stack, (0.4, 0.0, 0.45), glass)

# wall behind the window
bpy.ops.mesh.primitive_plane_add(size=30)
floor = bpy.context.object
floor.name = "Backdrop"
floor.parent = stack
floor.location = (0, 0, -0.3)
fm = bpy.data.materials.new("Backdrop")
fm.use_nodes = True
fb = fm.node_tree.nodes["Principled BSDF"]
fb.inputs["Base Color"].default_value = (*srgb_to_linear((0.075, 0.075, 0.08)), 1)
fb.inputs["Roughness"].default_value = 0.9
floor.data.materials.append(fm)

# --- lights ----------------------------------------------------------------
def area(name, loc, size, power, color=(1, 1, 1)):
    data = bpy.data.lights.new(name, "AREA")
    data.size = size
    data.energy = power
    data.color = color
    ob = bpy.data.objects.new(name, data)
    ob.location = loc
    scene.collection.objects.link(ob)
    # aim at the stack center
    c = ob.constraints.new("TRACK_TO")
    c.target = stack
    return ob


area("Key", (-1.0, -2.6, 1.8), 1.6, 150)
area("Accent", (2.0, -0.3, 0.8), 3.0, 80, srgb_to_linear(ACCENT))


def glint(name, loc, size, power, size_y=None):
    """Light that only shows up in reflections: sheen and edge glints on the glass, no extra fill."""
    ob = area(name, loc, size, power)
    if size_y:
        ob.data.shape = "RECTANGLE"
        ob.data.size_y = size_y
    ob.visible_diffuse = False
    ob.visible_transmission = False
    ob.visible_volume_scatter = False
    # light linking: only the glass slabs receive it
    ob.light_linking.receiver_collection = glass_slabs
    return ob


glass_slabs = bpy.data.collections.new("Glass slabs")
for slab in (o for o in scene.objects if o.data and getattr(o.data, "materials", None) and o.data.materials[0] == glass):
    glass_slabs.objects.link(slab)
glint("Sheen", (0.5, -2.0, 2.5), 3.5, 35, size_y=0.35)
glint("Rim", (-1.5, 0.2, 0.8), 1.2, 350)
# near the camera: the bevels facing it mirror this straight back into the lens
glint("Edge", (1.2, -2.8, 1.2), 2.5, 700, size_y=0.6)

world = bpy.data.worlds.new("World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (*srgb_to_linear((0.05, 0.05, 0.055)), 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.3
scene.world = world

# --- camera ----------------------------------------------------------------
target = bpy.data.objects.new("CameraTarget", None)
scene.collection.objects.link(target)
target.parent = stack
target.location = (0.42, -0.03, 0.25)

# focus on the search panel: the related panel goes slightly soft, the window more so
focus = bpy.data.objects.new("Focus", None)
focus.parent = stack
focus.location = (0.4, 0.0, 0.45)
scene.collection.objects.link(focus)

cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 50
cam_data.dof.use_dof = True
cam_data.dof.focus_object = focus
cam_data.dof.aperture_fstop = 2.4
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
# off to the right of the screen, like looking at a monitor from the side
azim, elev, dist = math.radians(46), math.radians(6), 2.2
bpy.context.view_layer.update()
tx, ty, tz = target.matrix_world.translation
cam.location = (tx + dist * math.sin(azim) * math.cos(elev), ty - dist * math.cos(azim) * math.cos(elev), tz + dist * math.sin(elev))
tc = cam.constraints.new("TRACK_TO")
tc.target = target
scene.camera = cam

# --- vignette (compositor) -------------------------------------------------
comp = bpy.data.node_groups.new("Vignette", "CompositorNodeTree")
comp.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
rl = comp.nodes.new("CompositorNodeRLayers")
ellipse = comp.nodes.new("CompositorNodeEllipseMask")
ellipse.inputs["Size"].default_value = (0.95, 0.9)
soften = comp.nodes.new("CompositorNodeBlur")
soften.inputs["Size"].default_value = (420, 420)
darken = comp.nodes.new("ShaderNodeMix")
darken.name = "Vignette darken"
darken.data_type = "RGBA"
darken.blend_type = "MULTIPLY"
darken.inputs["Factor"].default_value = 1.0
darken.inputs[7].default_value = (0.3, 0.3, 0.3, 1)  # B color: how dark the corners get
vignette = comp.nodes.new("ShaderNodeMix")
vignette.data_type = "RGBA"
out = comp.nodes.new("NodeGroupOutput")
comp.links.new(ellipse.outputs["Mask"], soften.inputs["Image"])
comp.links.new(rl.outputs["Image"], darken.inputs[6])
comp.links.new(soften.outputs["Image"], vignette.inputs["Factor"])
comp.links.new(darken.outputs[2], vignette.inputs[6])
comp.links.new(rl.outputs["Image"], vignette.inputs[7])
comp.links.new(vignette.outputs[2], out.inputs[0])
scene.compositing_node_group = comp

# --- render ----------------------------------------------------------------
scene.render.engine = "CYCLES"
scene.cycles.samples = 384
scene.cycles.use_denoising = True
scene.render.resolution_x = 2400
scene.render.resolution_y = 1350
scene.display_settings.display_device = "sRGB"
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"

bpy.ops.wm.save_as_mainfile(filepath=str(out_blend), relative_remap=True)
