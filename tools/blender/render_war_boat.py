# render_war_boat.py — the war boat's four 512px checks, as render_glb.py runs
# them.
#
# Kept as its own entry point because the boat needs two things a generic shot
# does not know: it floats (the sea plane, not a ground deck) and it rests at
# its waterline anchor rather than on its keel. Everything else — the studio,
# the camera, the views — is render_glb.py's.
#
# Views: game (~55 deg down, the actual play camera), side, top, bow
# three-quarter. Output PNGs are UNCOMMITTED eyes-on checks, not artefacts.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/render_war_boat.py -- \
#     E:\...\model-assets\plugins\boats\client\assets\war-boat.glb \
#     E:\...\model-assets\tools\blender\out

import os
import sys

import bpy

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from render_glb import render_views  # noqa: E402

# The boat's own views, in the order the reviewer reads them.
WAR_BOAT_VIEWS = ('game', 'side', 'top', 'bow34')

# Where the hull sits when the sea plane is at zero, if the asset carries no
# `waterline` Empty to measure. Matches BOAT_SHAPE's authored waterline lift in
# plugins/boats/client/models.ts, and is only a fallback: the anchor wins.
FALLBACK_WATERLINE_LIFT_CELLS = 0.11


def waterline_lift(glb_path):
    """How far to sink the hull so its `waterline` anchor meets the sea.

    Read from the file itself, by importing it once into a throwaway scene:
    the shot has to use the number the game uses, and the game reads it from
    the same Empty (installBoatKit, plugins/boats/client/models.ts).
    """
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    anchor = bpy.data.objects.get('waterline')
    if anchor is None:
        return -FALLBACK_WATERLINE_LIFT_CELLS
    # Blender is Z-up after import, so the anchor's height is its local z.
    return -anchor.location.z


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    glb_path, out_dir = args[0], args[1]
    render_views(
        glb_path, out_dir, list(WAR_BOAT_VIEWS),
        stage='water', lift=waterline_lift(glb_path), name='war-boat',
    )


if __name__ == '__main__':
    main()
