"""Render a clean front-orthographic T-pose reference PNG from a kimodo
stylized character GLB. Used as the right-hand "anatomy reference" that
the bridge composites alongside each character's avatar before sending
to FLUX.1-Kontext for T-pose generation.

Run via:
    blender --background --python render_tpose_reference.py -- \
        /home/paul/projects/kimodo/web/public/models/male_stylized.glb \
        /home/paul/projects/woid/agent-sandbox/pi-bridge/assets/tpose_reference.png

Run once whenever the source GLB changes; check the output PNG into git.
"""
import os
import sys
import math

import bpy

# Argv after `--` is for our script.
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) != 2:
    raise SystemExit("usage: blender --background --python <this> -- <input.glb> <output.png>")
src_glb, out_png = argv

# ── Reset scene ───────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)

# ── Import GLB ────────────────────────────────────────────────
bpy.ops.import_scene.gltf(filepath=src_glb)

# Compute the bounding box across all imported mesh objects so we can
# frame the camera to fit the figure exactly.
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes:
    raise SystemExit(f"no meshes found in {src_glb}")

# Mixamo / kimodo skinned-mesh GLBs often have unreliable bound_box
# values (computed against rest geometry, not the deformed-by-armature
# pose). Walk actual vertex positions through the world+armature
# transform to get a real bbox. Also clear any embedded animation so
# we render rest pose, not whatever frame 0 of the GLB's clip lands on.
for action in list(bpy.data.actions):
    bpy.data.actions.remove(action)
for arm in [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]:
    arm.animation_data_clear()

# Note on palm orientation: the bundled paladin's authored rest pose is
# already palms-down (gauntlet plates extend horizontally from the wrist
# — visually consistent with palms-down). No wrist re-pose needed for
# this character. If you swap to a Mixamo char whose default rest is
# palms-forward (most generic Mixamo rigs are), add a pose-mode rotate
# of the LeftHand/RightHand bones around their local Y axis here before
# the bbox computation below.

bpy.context.view_layer.update()

from mathutils import Vector
# Some Mixamo / kimodo GLBs ship with low-vertex debug primitives
# (icospheres etc.) alongside the real character meshes. Including them
# in the bbox shifts the framing — e.g. an Icosphere from -1 to 1 below
# the feet pulls the bbox z-min to -1 and the camera-center off by a
# meter. Filter to meshes with enough vertices to be the actual body.
MIN_VERTS = 500
mins = Vector((float("inf"),) * 3)
maxs = Vector((-float("inf"),) * 3)
for m in meshes:
    # Use evaluated mesh so armature deformation (rest pose now that
    # actions are cleared) is reflected in vertex coords.
    eval_obj = m.evaluated_get(bpy.context.evaluated_depsgraph_get())
    eval_mesh = eval_obj.to_mesh()
    if len(eval_mesh.vertices) < MIN_VERTS:
        eval_obj.to_mesh_clear()
        continue
    for v in eval_mesh.vertices:
        wc = m.matrix_world @ v.co
        for i in range(3):
            mins[i] = min(mins[i], wc[i])
            maxs[i] = max(maxs[i], wc[i])
    eval_obj.to_mesh_clear()
center = (mins + maxs) / 2.0
size = maxs - mins
fig_h = size.z

print(f"[render] fig bbox mins={tuple(round(v,3) for v in mins)} "
      f"maxs={tuple(round(v,3) for v in maxs)} "
      f"size={tuple(round(v,3) for v in size)} "
      f"center={tuple(round(v,3) for v in center)}", flush=True)

# ── World background — flat off-white (matches prompt) ────────
world = bpy.data.worlds.new("World")
bpy.context.scene.world = world
world.use_nodes = True
nodes = world.node_tree.nodes
links = world.node_tree.links
for n in list(nodes):
    nodes.remove(n)
out = nodes.new(type="ShaderNodeOutputWorld")
bg = nodes.new(type="ShaderNodeBackground")
# Off-white: matches the "plain off-white background" described in the
# Kontext prompt; FLUX.1-Kontext will composite on this color cleanly.
bg.inputs[0].default_value = (0.96, 0.94, 0.90, 1.0)
bg.inputs[1].default_value = 1.0
links.new(bg.outputs[0], out.inputs[0])

# ── Lighting: a simple key + fill so the silhouette reads ─────
key = bpy.data.lights.new("Key", type="SUN")
key.energy = 3.0
key_obj = bpy.data.objects.new("Key", key)
bpy.context.scene.collection.objects.link(key_obj)
key_obj.rotation_euler = (math.radians(45), 0, math.radians(-25))

fill = bpy.data.lights.new("Fill", type="SUN")
fill.energy = 1.5
fill_obj = bpy.data.objects.new("Fill", fill)
bpy.context.scene.collection.objects.link(fill_obj)
fill_obj.rotation_euler = (math.radians(70), 0, math.radians(180))

# ── Camera: orthographic, front view (looking +Y → -Y), centered ─
cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
# Ortho scale = world-space units across the LARGEST viewport dim.
# A T-pose figure has arm-span ≈ body height, so we frame to the larger
# of the two so the arms are NOT cropped at the sides. Render canvas
# (768×1024) is portrait, so fit-to-width vs fit-to-height needs to
# pick the dimension that requires more world-units.
fit_w = size.x  # world width = arm-span at T
fit_h = size.z  # world height = body height
canvas_aspect = scene_resolution = 768 / 1024  # = 0.75
# Ortho scale is in world-units of whichever axis is wider in pixels.
# For a 768x1024 portrait canvas, the larger pixel-axis is the height.
# So ortho_scale measures world-units across the canvas height.
# We want the figure's bbox to fit within the canvas with a margin:
#   world-height-needed = max(fit_h, fit_w / canvas_aspect)
needed = max(fit_h, fit_w / canvas_aspect)
cam_data.ortho_scale = needed * 1.10
cam = bpy.data.objects.new("Camera", cam_data)
bpy.context.scene.collection.objects.link(cam)
# Place the camera in front of the figure on the +Y axis, looking down -Y.
# Up axis = +Z (Blender default after glTF import).
cam.location = (center.x, center.y - 5.0, center.z)
cam.rotation_euler = (math.radians(90), 0, 0)  # rotate so -Z view-axis points at +Y in world
bpy.context.scene.camera = cam

# ── Render settings ───────────────────────────────────────────
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 768
scene.render.resolution_y = 1024
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.render.film_transparent = False
scene.render.filepath = out_png

bpy.ops.render.render(write_still=True)
print(f"[render] wrote {out_png} ({scene.render.resolution_x}x{scene.render.resolution_y})", flush=True)
