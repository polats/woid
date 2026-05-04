"""Bake palms-down into a UniRig-rigged GLB by rotating the wrist
bones in pose mode and applying the pose as the new rest pose.

Why it exists
-------------
UniRig auto-rigs whatever geometry it sees. Our Trellis input has
palms-forward (Kontext's diffusion prior wins regardless of what we
prompt for), so the rig.glb's wrist bone rest orientation is
palms-forward. When kimodo motion data — authored against SMPL-X
canonical (palms-down) rest — is applied to that rig, the rotation
mismatch shows up as palms-up during animation.

The fix is one rotation per wrist on the rig side: rotate the wrist
bones ~90° around the local arm axis, apply that pose as the new
rest. The inverse-bind-matrices auto-adjust so the visual at rest is
unchanged; the bone's "neutral" orientation is now palms-down. Then
kimodo motion lands correctly.

Usage
-----
    blender --background --python glb_palms_down.py -- \
        path/to/rig.glb mapping.json path/to/rig_palmsdown.glb \
        [--axis Y] [--degrees -90]

`mapping.json` is the output of `kimodo/web/scripts/unirig_mapping.py`
run against `rig.glb` — it tells us which anonymous `bone_N` is the
left and right wrist.

Defaults are `--axis Y --degrees -90`; flip sign or axis if the result
lands at palms-up instead of palms-down. Common combos to try:

    -90 around Y     (default — pronate forearm down)
    +90 around Y     (sup ination — palms up)
    -90 around X     (some Mixamo conventions)
    -90 around Z     (rare, some heuristics-rigged outputs)

Use `--ls` to print bone roll info for a one-time visual check.
"""
import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy

# argparse via "after --" is annoying with bpy; do it ourselves.
def _argv():
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1:]


def _parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("src", type=Path)
    p.add_argument("mapping", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--axis", choices=["X", "Y", "Z"], default="Y",
                   help="local-bone axis to rotate around (default Y)")
    p.add_argument("--degrees", type=float, default=-90.0,
                   help="rotation in degrees applied to the LEFT wrist; "
                        "right wrist gets the opposite sign (default -90)")
    p.add_argument("--ls", action="store_true",
                   help="print wrist bone info and exit (no export)")
    return p.parse_args(_argv())


def main() -> int:
    args = _parse()
    if not args.src.exists():
        print(f"err: {args.src} not found", file=sys.stderr)
        return 1
    mapping = json.loads(args.mapping.read_text())
    left_name = mapping.get("left_wrist")
    right_name = mapping.get("right_wrist")
    if not left_name or not right_name:
        print(f"err: mapping.json missing left_wrist / right_wrist", file=sys.stderr)
        return 1

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.src))

    arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
    if arm is None:
        print("err: no armature in GLB", file=sys.stderr)
        return 1

    bpy.context.view_layer.objects.active = arm

    if args.ls:
        # One-time inspection: print the wrist bones' world matrices so
        # we can decide which axis to rotate around.
        bpy.ops.object.mode_set(mode="POSE")
        for label, name in [("LEFT", left_name), ("RIGHT", right_name)]:
            pb = arm.pose.bones.get(name)
            if not pb:
                print(f"  {label} ({name}): NOT FOUND")
                continue
            head = pb.head
            tail = pb.tail
            print(f"  {label} ({name}):")
            print(f"    head world: ({head.x:+.3f}, {head.y:+.3f}, {head.z:+.3f})")
            print(f"    tail world: ({tail.x:+.3f}, {tail.y:+.3f}, {tail.z:+.3f})")
            print(f"    direction:  ({(tail-head).x:+.3f}, {(tail-head).y:+.3f}, {(tail-head).z:+.3f})")
            print(f"    matrix:")
            for row in pb.matrix:
                print(f"      [{row[0]:+.3f} {row[1]:+.3f} {row[2]:+.3f} {row[3]:+.3f}]")
        return 0

    # The bake sequence for SKINNED meshes is more involved than
    # `pose.armature_apply()` alone:
    #
    # 1. Pose-mode: rotate the wrist bones to the desired rest.
    # 2. Apply the mesh's Armature modifier with the bones still posed
    #    — this BAKES the wrist-rotation deformation into vertex data.
    #    (For a bone-only `armature_apply`, the inverse-bind matrices
    #     compensate exactly, so the rotation cancels in `alignMode='rest'`
    #     and is invisible during animation. We hit that earlier — all
    #     six axis/sign variants looked identical because the IBM
    #     undoes the rest change.)
    # 3. `pose.armature_apply()` — current pose is the new rest pose.
    # 4. Re-add the Armature modifier so the mesh skins to the armature
    #    again at the new rest. Vertex groups (skin weights) are
    #    preserved on the mesh through step 2.
    # 5. Export.
    #
    # This mirrors what kimodo's BLENDER_STUDIO_RIGID_GLBS.md describes
    # for rigid bundles, generalized for a single skinned mesh.

    rad = math.radians(args.degrees)
    axis_idx = {"X": 0, "Y": 1, "Z": 2}[args.axis]

    # Step 1: pose-mode rotate the wrist bones.
    bpy.ops.object.mode_set(mode="POSE")
    for bone_name, sign in [(left_name, 1.0), (right_name, -1.0)]:
        pb = arm.pose.bones.get(bone_name)
        if pb is None:
            print(f"WARN: bone '{bone_name}' missing in armature; skipping", file=sys.stderr)
            continue
        pb.rotation_mode = "XYZ"
        euler = [0.0, 0.0, 0.0]
        euler[axis_idx] = sign * rad
        pb.rotation_euler = euler
        print(f"  posed {bone_name}: axis {args.axis} by {sign * args.degrees:+.1f}°")
    bpy.ops.object.mode_set(mode="OBJECT")

    # Step 2: find every mesh skinned to this armature and apply its
    # Armature modifier. Apply bakes the deformation (i.e. the wrist
    # rotation) into vertex positions. Without this, the rotation cancels
    # against the IBM and never reaches animation output for skinned
    # meshes — see the comment block above.
    skinned_meshes = []
    for o in bpy.context.scene.objects:
        if o.type != "MESH":
            continue
        for mod in o.modifiers:
            if mod.type == "ARMATURE" and mod.object == arm:
                skinned_meshes.append((o, mod.name))
                break
    if not skinned_meshes:
        print("WARN: no skinned meshes attached to this armature; "
              "nothing to bake", file=sys.stderr)

    for mesh, mod_name in skinned_meshes:
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = mesh
        mesh.select_set(True)
        # `modifier_apply` requires the modifier's object to be active
        # and selected. Apply removes the modifier; the deformation it
        # was producing becomes the new mesh-data vertex positions.
        bpy.ops.object.modifier_apply(modifier=mod_name)
        print(f"  baked Armature modifier into '{mesh.name}'")

    # Step 3: now the bones are still posed (mesh data captured the
    # deformation). Set the current pose as the new rest.
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply()
    bpy.ops.object.mode_set(mode="OBJECT")
    print("  set current pose as new rest")

    # Step 4: reattach the Armature modifier on each mesh so the GLB
    # exports with skinning. Vertex groups stayed on the mesh through
    # the bake; the new modifier just connects them to the armature
    # at the new rest.
    for mesh, _ in skinned_meshes:
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = mesh
        mesh.select_set(True)
        new_mod = mesh.modifiers.new(name="Armature", type="ARMATURE")
        new_mod.object = arm
        new_mod.use_vertex_groups = True
        # Keep the modifier first in the stack so any other modifiers
        # apply on top of skinning, not before. (Most rigs only have
        # the armature modifier — defensive ordering for unusual rigs.)
        try:
            bpy.ops.object.modifier_move_to_index(modifier=new_mod.name, index=0)
        except RuntimeError:
            pass

    # Step 5: export.
    args.out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(args.out),
        export_format="GLB",
    )
    print(f"wrote {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
