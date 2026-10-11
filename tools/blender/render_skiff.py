# render_skiff.py — seven Cycles checks of the exported skiff.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/render_skiff.py -- \
#     E:\...\plugins\structures\client\assets\skiff.glb \
#     E:\...\plugins\boats\client\assets\war-boat.glb \
#     E:\...\.skiff-shots
#
# Views: `game` is the actual play camera (~55 deg down at six world units) and
# is the only one that answers "does it read?"; side/top/bow34/stern34 are
# close checks for shape, see-through walls and inverted normals; `scale` puts
# the war boat alongside so the two boats can be compared as a fleet. CPU
# Cycles — the only engine that renders headless without a GPU. The PNGs are
# eyes-on checks, not artefacts: they are NOT committed.
#
# The sea is a plane at z = 0 and every boat is sunk by its own `waterline`
# anchor, so these shots check the waterline bite as well as the shape.
#
# `stern34` and `top-bobcrest` exist for GH #327 (2026-09-04). The stern
# three-quarter is the view the missing transom hid in — every other close view
# looks at the boat from forward of amidships. `top-bobcrest` re-renders the
# top view with the sea raised by BOB_CREST_LIFT, which is where the client's
# float cycle actually puts the surface relative to the authored waterline: a
# sole that is dry at rest but wet at the crest fails the same defect, so the
# check has to be run at the crest and not only at rest.

import math
import os
import sys

import bpy
from mathutils import Vector

#: Square output size. Bigger than build_war_boat's 512 because this boat is a
#: third of the war boat's length and the close views need the pixels.
RENDER_SIZE = 640
#: Cycles samples. 64 is grain-free enough to tell a black inverted face from a
#: dark plank, which is all these shots have to resolve.
CYCLES_SAMPLES = 64
#: Camera focal length, matching render_war_boat.py so distances compare.
CAMERA_LENS_MM = 35
#: Distance for the close checks, sized for a 0.36-unit boat (render_war_boat
#: uses 3.0 for a 0.9-unit one — the same boat-lengths of standoff).
CLOSE_DISTANCE = 1.2
#: The game camera's distance and elevation: the brief's "~55 deg down, 6+
#: world units away", i.e. render_war_boat.py's own `game` view.
GAME_DISTANCE = 6.0
GAME_ELEVATION_DEG = 55.0
#: Distance for the two-boat scale shot: far enough to frame 0.8 units of
#: separation plus both hulls.
SCALE_DISTANCE = 2.4
#: How far to starboard the war boat sits in the scale shot.
SCALE_SEPARATION = 0.8
#: Aim point: the centreline, a little above the sea so the boat is not
#: half out of frame at the close distances.
TARGET = (0.0, 0.0, 0.03)

SEA_COLOR = (0x2F / 255, 0x6F / 255, 0x8F / 255, 1.0)
SEA_ROUGHNESS = 0.6
SEA_PLANE_SIZE = 8
SKY_COLOR = (0.55, 0.6, 0.65, 1.0)
SKY_STRENGTH = 1.2
SUN_ENERGY = 3.0
SUN_ELEVATION_DEG = 50
SUN_AZIMUTH_DEG = 30

WATERLINE_ANCHOR_NAME = 'waterline'

#: How far the sea plane is raised for the worst-case dryness check, in world
#: units. The bob amplitude phase 5 contracts the client to (build_skiff.py
#: SOLE_DRY_CLEARANCE_MIN derives its 0.010 from this 0.006 plus 0.004 of float
#: margin), so this is the crest of the float cycle: the highest the surface
#: ever reaches relative to the boat's authored waterline.
BOB_CREST_LIFT = 0.006


def setup():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = CYCLES_SAMPLES
    scene.render.resolution_x = RENDER_SIZE
    scene.render.resolution_y = RENDER_SIZE
    scene.render.film_transparent = False
    world = bpy.data.worlds.new('check_world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = SKY_COLOR
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = SKY_STRENGTH
    scene.world = world

    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = SUN_ENERGY
    sun.rotation_euler = (math.radians(SUN_ELEVATION_DEG), 0, math.radians(SUN_AZIMUTH_DEG))
    bpy.context.collection.objects.link(sun)

    bpy.ops.mesh.primitive_plane_add(size=SEA_PLANE_SIZE, location=(0, 0, 0))
    sea = bpy.context.view_layer.objects.active
    sea.name = 'sea'
    mat = bpy.data.materials.new('sea')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = SEA_COLOR
    bsdf.inputs['Roughness'].default_value = SEA_ROUGHNESS
    sea.data.materials.append(mat)


def import_boat(glb_path, beam_offset):
    """Imports one .glb, sinks it to its own waterline, slides it to starboard.

    Returns the imported roots so a later import can be moved independently —
    both files carry an Empty called `waterline`, so names alone cannot tell
    the two boats apart after the second import renames one of them.
    """
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    imported = [obj for obj in bpy.data.objects if obj not in before]
    anchors = [obj for obj in imported
               if obj.type == 'EMPTY' and obj.name.split('.')[0] == WATERLINE_ANCHOR_NAME]
    assert len(anchors) == 1, f'{glb_path}: {len(anchors)} waterline anchors, want 1'
    lift = -anchors[0].location.z
    for obj in imported:
        if obj.parent is None:
            obj.location.z += lift
            obj.location.y += beam_offset
    print(f'imported {glb_path}: waterline lift {lift:.4f}, beam offset {beam_offset}')
    return imported


def aim(camera, target, azimuth_deg, elevation_deg, distance):
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    camera.location = (
        target[0] + distance * math.cos(el) * math.cos(az),
        target[1] + distance * math.cos(el) * math.sin(az),
        target[2] + distance * math.sin(el),
    )
    direction = Vector(target) - Vector(camera.location)
    camera.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    skiff_path, war_boat_path, out_dir = args[0], args[1], args[2]
    os.makedirs(out_dir, exist_ok=True)

    setup()
    import_boat(skiff_path, 0.0)

    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new('check_cam')
    cam_data.lens = CAMERA_LENS_MM
    camera = bpy.data.objects.new('check_cam', cam_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera

    views = [
        ('game', 30.0, GAME_ELEVATION_DEG, GAME_DISTANCE, TARGET),
        ('side', 90.0, 8.0, CLOSE_DISTANCE, TARGET),
        ('top', 90.0, 89.0, CLOSE_DISTANCE, TARGET),
        ('bow34', 45.0, 25.0, CLOSE_DISTANCE, TARGET),
        # From abaft the port quarter: the only close view that sees the
        # transom, and so the only one that can catch it being open.
        ('stern34', 135.0, 25.0, CLOSE_DISTANCE, TARGET),
    ]
    for name, az, el, dist, target in views:
        aim(camera, target, az, el, dist)
        scene.render.filepath = os.path.join(out_dir, f'skiff-{name}.png')
        bpy.ops.render.render(write_still=True)
        print(f'rendered {scene.render.filepath}')

    # The top view again with the sea at the crest of the client's bob. The
    # plane is raised rather than the boat lowered so the camera framing is
    # identical to skiff-top.png and the two can be flicked between.
    sea = bpy.data.objects['sea']
    sea.location.z = BOB_CREST_LIFT
    aim(camera, TARGET, 90.0, 89.0, CLOSE_DISTANCE)
    scene.render.filepath = os.path.join(out_dir, 'skiff-top-bobcrest.png')
    bpy.ops.render.render(write_still=True)
    print(f'rendered {scene.render.filepath} (sea raised {BOB_CREST_LIFT})')
    sea.location.z = 0.0

    # Last view: the war boat alongside, so the skiff can be judged as the
    # smaller cousin it is meant to be rather than in isolation.
    import_boat(war_boat_path, SCALE_SEPARATION)
    scale_target = (0.0, SCALE_SEPARATION / 2, 0.05)
    aim(camera, scale_target, 20.0, 35.0, SCALE_DISTANCE)
    scene.render.filepath = os.path.join(out_dir, 'skiff-scale.png')
    bpy.ops.render.render(write_still=True)
    print(f'rendered {scene.render.filepath}')


main()
