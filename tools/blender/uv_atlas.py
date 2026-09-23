# uv_atlas.py — lay every mesh of one model into ONE shared 0..1 UV atlas.
#
# A model's parts must sample one texture set: the rig baker merges parts into
# one draw only when every shading input matches (docs/model-assets.md, "Merge
# rule"), so a texture per part would multiply draws. Baking into that set
# also needs islands that never overlap, including across objects.
#
# Call it after bake_object_transforms(), so island sizes are measured in the
# shipped frame, and before export.

import math

import bpy

UV_LAYER_NAME = 'atlas'

# The texture resolution the atlas is laid out for; the margin is in its texels.
ATLAS_TEXELS = 1024

# Gutter between islands. 16 texels at 1024 is still 1 texel at the 64 px mip,
# which is as small as a creature on screen samples; bake dilation fills it.
ISLAND_MARGIN_TEXELS = 16
ISLAND_MARGIN = ISLAND_MARGIN_TEXELS / ATLAS_TEXELS

# Faces bending less than this share an island. Smart UV Project's own default:
# on these low-poly bodies it keeps seams few, and the stretch it allows is
# invisible under baked procedural detail.
SEAM_ANGLE_DEGREES = 66.0


def unwrap_shared_atlas(objects):
    """Give each mesh in `objects` an 'atlas' UV layer, packed jointly, no overlaps.

    Refuses a mesh that already has UVs (its layout is authored; replacing it is
    a decision, not a side effect) and mesh data shared between objects (both
    would land on one island, so a bake would paint one over the other).
    """
    meshes = [o for o in objects if o.type == 'MESH']
    if not meshes:
        raise ValueError('unwrap_shared_atlas: no mesh objects given')
    owners = {}
    for obj in meshes:
        if obj.data.uv_layers:
            raise ValueError(f'unwrap_shared_atlas: {obj.name} already has UVs')
        if obj.data.name in owners:
            raise ValueError(
                f'unwrap_shared_atlas: {obj.name} shares mesh data with {owners[obj.data.name]}')
        owners[obj.data.name] = obj.name
        obj.data.uv_layers.new(name=UV_LAYER_NAME)

    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(
        angle_limit=math.radians(SEAM_ANGLE_DEGREES),
        island_margin=ISLAND_MARGIN,
        area_weight=0.0,
        correct_aspect=True,
        scale_to_bounds=False,
    )
    # Re-pack jointly: smart_project's own pack leaves space a concave packer uses.
    bpy.ops.uv.pack_islands(
        rotate=True,
        margin_method='FRACTION',
        margin=ISLAND_MARGIN,
        shape_method='CONCAVE',
    )
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
