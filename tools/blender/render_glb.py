# render_glb.py — four 512px eyes-on checks of ANY exported model asset.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/render_glb.py -- \
#     E:\...\Terrace\plugins\wildlife\client\assets\fish.glb \
#     E:\...\Terrace\tools\blender\out
#
# THE GENERAL CASE, split out of render_war_boat.py. That script renders the
# boat AT ITS WATERLINE against a sea plane, which is the check a boat needs
# and no other asset does; it stays as the boat's own preset. Everything here
# is asset-agnostic: the model is framed from its own bounding box, so a fish
# 0.7 cells long and a whale 7 cells long both fill the frame.
#
# CPU Cycles — the only engine that renders headless without a GPU. Output
# PNGs are UNCOMMITTED eyes-on checks, not artefacts.

import math
import os
import sys

import bpy
from mathutils import Vector

#: 512 is what the war boat's checks use and what an eyes-on review reads at.
RESOLUTION = 512
#: Cycles samples. 64 is grain-free on flat-coloured game assets.
SAMPLES = 64
#: A neutral grey studio: bright enough to read a dark silhouette, dull enough
#: not to tint the model's own colour.
BACKDROP = (0.55, 0.6, 0.65, 1.0)
#: Held BELOW 1.0 in total so no lit surface clips. With the Standard view
#: transform (below) a clipped channel is a channel discarded: the war boat's
#: settings blew a warm orange fish out to cream, which is exactly the kind of
#: judgement this check exists to support.
BACKDROP_STRENGTH = 0.55
SUN_ENERGY = 1.6
SUN_ELEVATION_DEGREES = 50
SUN_AZIMUTH_DEGREES = 30
LENS_MM = 35
#: How much room to leave around the model, as a multiple of its own radius.
#: 2.6 frames the whole silhouette with margin at a 35 mm lens.
FRAMING_DISTANCE_FACTOR = 2.6

#: (name, azimuth, elevation) — the play camera's angle plus the three
#: orthographic-ish views a model is actually judged from.
VIEWS = (
    ('game', 30.0, 55.0),
    ('side', 90.0, 8.0),
    ('top', 90.0, 89.0),
    ('front', 5.0, 12.0),
)


def setup():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = SAMPLES
    scene.render.resolution_x = RESOLUTION
    scene.render.resolution_y = RESOLUTION
    scene.render.film_transparent = False
    # STANDARD, not Blender's default AgX. AgX is a filmic look transform: it
    # desaturates and rolls off highlights, which is right for photoreal work
    # and wrong for this check — the whole point is to see whether the asset
    # carries the colour the species file declares, and AgX turned a warm
    # orange fish into a pale cream one.
    scene.view_settings.view_transform = 'Standard'
    world = bpy.data.worlds.new('check_world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = BACKDROP
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = BACKDROP_STRENGTH
    scene.world = world

    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = SUN_ENERGY
    sun.rotation_euler = (
        math.radians(SUN_ELEVATION_DEGREES), 0, math.radians(SUN_AZIMUTH_DEGREES))
    bpy.context.collection.objects.link(sun)


def model_bounds():
    """World-space min/max over every imported mesh."""
    lo = Vector((float('inf'),) * 3)
    hi = Vector((float('-inf'),) * 3)
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo[i], point[i]) for i in range(3)))
            hi = Vector((max(hi[i], point[i]) for i in range(3)))
    return lo, hi


def aim(camera, target, azimuth_deg, elevation_deg, distance):
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    camera.location = (
        target[0] + distance * math.cos(el) * math.cos(az),
        target[1] + distance * math.cos(el) * math.sin(az),
        target[2] + distance * math.sin(el),
    )
    # Point local -Z at the target, world +Y as up.
    direction = Vector(target) - Vector(camera.location)
    camera.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    glb_path, out_dir = args[0], args[1]
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(glb_path))[0]

    setup()
    bpy.ops.import_scene.gltf(filepath=glb_path)

    lo, hi = model_bounds()
    target = tuple((lo[i] + hi[i]) / 2 for i in range(3))
    radius = max(hi[i] - lo[i] for i in range(3)) / 2
    distance = radius * FRAMING_DISTANCE_FACTOR
    print(f'{stem}: bounds {tuple(round(v, 4) for v in lo)} .. '
          f'{tuple(round(v, 4) for v in hi)}, framing at {distance:.3f}')

    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new('check_cam')
    cam_data.lens = LENS_MM
    camera = bpy.data.objects.new('check_cam', cam_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera

    for name, az, el in VIEWS:
        aim(camera, target, az, el, distance)
        scene.render.filepath = os.path.join(out_dir, f'{stem}-{name}.png')
        bpy.ops.render.render(write_still=True)
        print(f'rendered {scene.render.filepath}')


main()
