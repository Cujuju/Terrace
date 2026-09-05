# export_glb.py — apply transforms and export the open scene as one .glb.
#
# Reusable for any model asset (docs/model-assets.md): bakes object
# scale/rotation into the mesh data, keeps Y-up, and embeds textures so the
# .glb is a single self-contained file.
#
# Two entry points:
#   - as a script, it opens a .blend and exports it (the war-boat flow);
#   - as a module, `bake_object_transforms()` + `export_scene_glb()` are what
#     import_model.py calls, so there is exactly ONE definition of what this
#     project's export settings are.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/export_glb.py -- \
#     E:\path\to\model.blend E:\path\to\model.glb

import sys

import bpy


def bake_object_transforms():
    """Bake every mesh object's rotation and scale into its mesh data.

    The convention's axes must be in the vertices, not in object transforms a
    baker would have to undo. Location is kept — an anchor's position IS its
    location. One object at a time: the op applies to the selection, and a
    shared selection risks a double-apply.
    """
    for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.select_all(action='DESELECT')


def export_scene_glb(out_path):
    """Write the open scene to `out_path` with this project's one export recipe.

    Y-up (the convention's frame), textures embedded (no sidecar files nobody
    will ship), and NO animation tracks: motion in this game is written in the
    plugin that owns the creature, never read from the file — see
    client/src/render/rigSkin.ts, which consumes a rest pose and nothing else.
    """
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
        export_animations=False,
    )
    print(f'exported {out_path}')


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    blend_path, out_path = args[0], args[1]

    bpy.ops.wm.open_mainfile(filepath=blend_path)
    bake_object_transforms()
    export_scene_glb(out_path)


if __name__ == '__main__':
    main()
