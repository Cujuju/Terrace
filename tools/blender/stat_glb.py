# stat_glb.py — tri count and node list from a FRESH Blender import of a .glb.
#
# The build script's own counts are pre-export; this is the independent
# re-import (what a downstream tool sees after a round trip).
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/stat_glb.py -- \
#     E:\...\model-assets\plugins\boats\client\assets\war-boat.glb

import sys

import bpy


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    glb_path = args[0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    bpy.ops.import_scene.gltf(filepath=glb_path)

    print(f'fresh import of {glb_path}:')
    total_tris = 0
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        kind = obj.type
        extra = ''
        if obj.type == 'MESH':
            mesh = obj.data
            tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
            total_tris += tris
            mats = [m.name if m else '(none)' for m in mesh.materials]
            has_uv = bool(mesh.uv_layers)
            extra = f' {len(mesh.polygons)} polys, {tris} tris, uv={has_uv}, mats={mats}'
        elif obj.type == 'EMPTY':
            extra = f' at ({obj.location.x:.3f}, {obj.location.y:.3f}, {obj.location.z:.3f})'
        print(f'  {obj.name} [{kind}]{extra}')
    print(f'total: {total_tris} tris')


main()
