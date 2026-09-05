# stat_glb.py — everything a reviewer needs to judge a .glb WITHOUT opening
# Blender, from a FRESH import of the file.
#
# The build script's own counts are pre-export; this is the independent
# re-import (what a downstream tool sees after a round trip).
#
# Printed: the bounding box in world units and its min-Y, one line per mesh
# (tris, material, uv layers), the PBR slots each material actually fills, every
# image's size and colour space, every Empty's position, and whether the file
# carries an armature or a skinned mesh — which client/src/render/rigAsset.ts
# does not consume (the pivot convention is Empties; see docs/model-assets.md).
#
# `--footprint X Z [--height H] [--tolerance T]` turns it into a CHECK: it
# exits non-zero when the model overflows the world units it was budgeted,
# which is the same rule the runtime applies at load.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/stat_glb.py -- \
#     E:\...\model-assets\plugins\boats\client\assets\war-boat.glb \
#     [--footprint 1 1] [--height 1.2] [--tolerance 0.02]

import sys

import bpy
from mathutils import Vector

# How far past its budget a model may reach before the fit check fails.
#
# THE SAME NUMBER THE RUNTIME USES: ASSET_FIT_TOLERANCE_WORLD_UNITS in
# client/src/render/rigAsset.ts, which is where the decision lives (it began as
# boats' BOAT_FIT_TOLERANCE_CELLS and moved when the fit check became shared).
# The fit is authored, not fitted — the number only absorbs float dust in the
# bounding box, never a real overhang. This is the offline copy of that
# constant, and the two must move together.
DEFAULT_FIT_TOLERANCE_WORLD_UNITS = 0.02

# Blender is Z-up; the exported file is Y-up. Every number this tool prints is
# in the EXPORTED frame, because that is the frame the game measures in.
# export_scene.gltf(export_yup=True) maps blender (x, y, z) -> gltf (x, z, -y).


# The collection Blender's glTF IMPORTER parks the objects it fabricated in.
#
# WHY IT MATTERS HERE. Importing a skinned .glb builds a 42-vertex `Icosphere`
# at the origin as the display shape for the file's bones. It is not in the
# file — the exporter skips this collection, which is why the deer's own
# re-export never carries one — but every measure below re-imports through that
# same importer, so without this the sphere sets the bounding box and
# `--footprint` fails on ANY skinned asset (found 2026-09-04 on the deer).
#
# THE COLLECTION IS THE MARKER, verified in Blender 5.2.1 rather than guessed:
# the fabricated Icosphere carries no custom property, no distinguishing name
# beyond "Icosphere", and no parent at all (so "a child of the armature" would
# not have caught it) — its one distinguishing fact is that it, alone of every
# object in the scene, is in `glTF_not_exported` rather than in `Collection`.
GLTF_IMPORTER_SCAFFOLDING_COLLECTION = 'glTF_not_exported'


def is_importer_scaffolding(obj):
    """True for an object the glTF importer invented and will not export."""
    return any(
        collection.name == GLTF_IMPORTER_SCAFFOLDING_COLLECTION
        for collection in obj.users_collection
    )


def model_objects():
    """Every object that is really in the file, in Blender's own order."""
    return [obj for obj in bpy.data.objects if not is_importer_scaffolding(obj)]


def to_export_frame(vector):
    """Blender's Z-up vector as the Y-up vector the exported file will carry."""
    return (vector.x, vector.z, -vector.y)


def clear_scene():
    """Empty every datablock, so a stat run never reports a leftover."""
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)


def world_corners(obj):
    """The eight corners of one mesh's own box, in world space.

    Computed from the vertices rather than read off `obj.bound_box`, which
    Blender caches and does not refresh when a script rewrites the mesh data.

    THE BOX IS TRANSFORMED CORNER BY CORNER, not recomputed from the moved
    vertices, because that is exactly what three.js Box3.setFromObject does and
    the runtime fit check is a Box3 (plugins/boats/client/models.ts,
    installBoatKit). For a rotated part the result is a little larger than the
    part; measuring tighter here than the game measures would let a model
    through that the loader then rejects.
    """
    mesh = obj.data
    if len(mesh.vertices) == 0:
        return []
    lows = [float('inf')] * 3
    highs = [float('-inf')] * 3
    for vertex in mesh.vertices:
        for axis in range(3):
            lows[axis] = min(lows[axis], vertex.co[axis])
            highs[axis] = max(highs[axis], vertex.co[axis])
    corners = []
    for x in (lows[0], highs[0]):
        for y in (lows[1], highs[1]):
            for z in (lows[2], highs[2]):
                corners.append(obj.matrix_world @ Vector((x, y, z)))
    return corners


def world_bounds():
    """The (min, max) corner of every mesh's world bounding box, export frame."""
    lows, highs = None, None
    for obj in model_objects():
        if obj.type != 'MESH':
            continue
        for corner in world_corners(obj):
            point = to_export_frame(corner)
            if lows is None:
                lows, highs = list(point), list(point)
                continue
            for axis in range(3):
                lows[axis] = min(lows[axis], point[axis])
                highs[axis] = max(highs[axis], point[axis])
    return lows, highs


def texture_slots(material):
    """Which PBR slot each image in a material feeds, best effort.

    Blender's glTF importer labels the image nodes it creates with the slot
    name ("Base Color", "Normal", "Metallic Roughness", "Occlusion",
    "Emissive"), so the label is the answer for anything that came from a glTF.
    For a hand-built .blend there is no label, so the node's first downstream
    input name stands in.
    """
    if not material or not material.use_nodes:
        return []
    found = []
    for node in material.node_tree.nodes:
        if node.type != 'TEX_IMAGE':
            continue
        name = node.image.name if node.image else '(no image)'
        found.append(f'{node.label or _downstream_input(node) or "(unlabelled)"}={name}')
    return found


def _downstream_input(node):
    """The name of the socket this texture node ultimately feeds, if traceable."""
    for output in node.outputs:
        for link in output.links:
            target = link.to_node
            if target.type == 'BSDF_PRINCIPLED':
                return link.to_socket.name
            deeper = _downstream_input(target)
            if deeper:
                return deeper
    return None


def scalar_slots(material):
    """The non-textured PBR values worth seeing: colour, metallic, roughness."""
    if not material or not material.use_nodes:
        return []
    for node in material.node_tree.nodes:
        if node.type != 'BSDF_PRINCIPLED':
            continue
        color = node.inputs['Base Color'].default_value
        return [
            'baseColor=({:.2f}, {:.2f}, {:.2f}, {:.2f})'.format(*color),
            'metallic={:.2f}'.format(node.inputs['Metallic'].default_value),
            'roughness={:.2f}'.format(node.inputs['Roughness'].default_value),
        ]
    return []


def print_stats(label):
    """Print the whole stats block for the scene currently open.

    import_model.py ends with this same block, so the tool's own report and an
    independent re-import of what it wrote can be diffed line for line.
    """
    print(f'stats for {label}:')

    lows, highs = world_bounds()
    if lows is None:
        print('  bbox: (no meshes)')
    else:
        size = [highs[axis] - lows[axis] for axis in range(3)]
        print(
            '  bbox world units: x={:.3f} y={:.3f} z={:.3f}  min-y={:.3f}  '
            'centre-xz=({:.3f}, {:.3f})'.format(
                size[0], size[1], size[2], lows[1],
                (lows[0] + highs[0]) / 2, (lows[2] + highs[2]) / 2,
            )
        )

    # The same filter the box uses: a fabricated display sphere is not a mesh
    # this file has, so it must not appear in the counts a reviewer reads either.
    scene = model_objects()
    meshes = [o for o in scene if o.type == 'MESH']
    empties = [o for o in scene if o.type == 'EMPTY']
    armatures = [o for o in scene if o.type == 'ARMATURE']
    skinned = [o for o in meshes if any(m.type == 'ARMATURE' for m in o.modifiers)]

    total_tris = 0
    print(f'  meshes: {len(meshes)}')
    for obj in sorted(meshes, key=lambda o: o.name):
        mesh = obj.data
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        total_tris += tris
        mats = [m.name if m else '(none)' for m in mesh.materials]
        uvs = [layer.name for layer in mesh.uv_layers]
        colors = [layer.name for layer in mesh.color_attributes]
        print(
            f'    {obj.name}: {tris} tris, materials={mats}, uv={uvs}, '
            f'colors={colors}, parent={obj.parent.name if obj.parent else "(none)"}'
        )
    print(f'  total: {total_tris} tris')

    print(f'  materials: {len(bpy.data.materials)}')
    for material in sorted(bpy.data.materials, key=lambda m: m.name):
        slots = texture_slots(material) + scalar_slots(material)
        print(f'    {material.name}: {", ".join(slots) if slots else "(no nodes)"}')

    print(f'  images: {len(bpy.data.images)}')
    for image in sorted(bpy.data.images, key=lambda i: i.name):
        print(
            f'    {image.name}: {image.size[0]}x{image.size[1]}, '
            f'colorspace={image.colorspace_settings.name}'
        )

    print(f'  empties: {len(empties)}')
    for obj in sorted(empties, key=lambda o: o.name):
        position = to_export_frame(obj.matrix_world.translation)
        print(
            '    {}: ({:.3f}, {:.3f}, {:.3f})  parent={}'.format(
                obj.name, position[0], position[1], position[2],
                obj.parent.name if obj.parent else '(none)',
            )
        )

    print(f'  armatures: {len(armatures)}   skinned meshes: {len(skinned)}')
    return lows, highs


def check_fit(lows, highs, footprint, height, tolerance):
    """Fail when the model overflows its budgeted cells.

    Mirrors the runtime rule (plugins/boats/client/models.ts, installBoatKit):
    the whole silhouette must sit inside the footprint plus the tolerance, so a
    model that passes here cannot be rejected at load for its size.
    """
    if lows is None:
        print('FIT FAIL: the file has no meshes to measure')
        return False
    size = [highs[axis] - lows[axis] for axis in range(3)]
    budget = [footprint[0], height, footprint[1]]
    axes = 'xyz'
    ok = True
    for axis in range(3):
        if budget[axis] is None:
            continue
        if size[axis] > budget[axis] + tolerance:
            print(
                'FIT FAIL: {} = {:.3f} cells exceeds {:.3f} + {:.3f} tolerance'.format(
                    axes[axis], size[axis], budget[axis], tolerance
                )
            )
            ok = False
    if ok:
        print('FIT OK: within {} x {} cells{}, tolerance {}'.format(
            footprint[0], footprint[1],
            '' if height is None else f' and {height} high', tolerance,
        ))
    return ok


def parse_args(args):
    """glb path plus the optional fit budget."""
    glb_path = args[0]
    footprint, height, tolerance = None, None, DEFAULT_FIT_TOLERANCE_WORLD_UNITS
    index = 1
    while index < len(args):
        flag = args[index]
        if flag == '--footprint':
            footprint = (float(args[index + 1]), float(args[index + 2]))
            index += 3
        elif flag == '--height':
            height = float(args[index + 1])
            index += 2
        elif flag == '--tolerance':
            tolerance = float(args[index + 1])
            index += 2
        else:
            raise SystemExit(f'stat_glb: unknown option {flag}')
    return glb_path, footprint, height, tolerance


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    glb_path, footprint, height, tolerance = parse_args(args)

    clear_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)

    lows, highs = print_stats(f'fresh import of {glb_path}')
    if footprint is not None or height is not None:
        if not check_fit(lows, highs, footprint or (None, None), height, tolerance):
            sys.exit(1)


if __name__ == '__main__':
    main()
