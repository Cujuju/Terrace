# export_glb.py — apply transforms and export the open scene as one .glb.
#
# Reusable for any model asset (docs/model-assets.md): bakes object
# scale/rotation into the mesh data, keeps Y-up, and embeds textures so the
# .glb is a single self-contained file.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/export_glb.py -- \
#     E:\path\to\model.blend E:\path\to\model.glb

import sys

import bpy


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    blend_path, out_path = args[0], args[1]

    bpy.ops.wm.open_mainfile(filepath=blend_path)

    # Apply scale AND rotation into the mesh data: the convention's axes must
    # be in the vertices, not in object transforms a baker would have to undo.
    # Location is kept — an anchor's position IS its location. One object at a
    # time: the op applies to the selection, and a shared selection risks a
    # double-apply.
    for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.select_all(action='DESELECT')

    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        # Embed: AUTO packs the images into the .glb's buffer views instead of
        # writing sidecar files nobody will ship.
        export_image_format='AUTO',
    )
    print(f'exported {out_path}')


main()
