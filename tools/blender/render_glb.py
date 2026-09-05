# render_glb.py — neutral studio shots of any .glb, so a model can be judged
# without opening Blender.
#
# Views: iso (roughly the play camera's angle), side, front, top. CPU Cycles —
# the only engine that renders headless without a GPU. Output PNGs are
# UNCOMMITTED eyes-on checks, not artefacts.
#
# The ground plane is optional and says what the model is standing on:
#   --ground  a matte grey deck at y=0, for anything placed on a cell;
#   --water   a sea-blue plane at y=0, for a hull (the waterline bite is the
#             thing the shot is checking);
#   neither   nothing, for a swimmer or flier whose origin is its body centre.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/render_glb.py -- \
#     E:\...\model.glb E:\...\shots [--views iso,side,top] [--ground] \
#     [--name wolf] [--lift 0.11]

import math
import os
import sys

import bpy
from mathutils import Vector

# Render settings. 512px at 64 samples is the smallest shot in which a
# one-cell model's silhouette and material read clearly, and it finishes on CPU
# in seconds rather than minutes.
RENDER_PIXELS = 512
CYCLES_SAMPLES = 64

# The neutral studio: an overcast sky bright enough to light the underside, and
# one sun for a shape-reading shadow. Deliberately colourless — a shot is for
# judging the model, not for selling it.
WORLD_COLOR = (0.55, 0.6, 0.65, 1.0)
WORLD_STRENGTH = 1.2
SUN_ENERGY = 3.0
SUN_ELEVATION_DEG = 50.0
SUN_AZIMUTH_DEG = 30.0

# The stage. Eight cells across is far wider than any single asset, so the
# horizon never cuts through the subject.
STAGE_SIZE_CELLS = 8.0
GROUND_COLOR = (0.30, 0.30, 0.32, 1.0)
WATER_COLOR = (0x2F / 255, 0x6F / 255, 0x8F / 255, 1.0)
STAGE_ROUGHNESS = 0.6

# Camera. A 35mm lens is wide enough to frame a model at close range without
# the barrel distortion a shorter one would add to a straight hull.
CAMERA_LENS_MM = 35.0

# Named views: (azimuth deg, elevation deg, distance in model radii).
# `iso` matches the play camera's ~55 degree downward look.
VIEWS = {
    'iso': (30.0, 55.0, 3.0),
    'game': (30.0, 55.0, 3.0),
    'side': (90.0, 8.0, 2.6),
    'front': (0.0, 8.0, 2.6),
    'bow34': (45.0, 25.0, 2.6),
    'top': (90.0, 89.0, 2.6),
}
DEFAULT_VIEWS = ('iso', 'side', 'top')

# Below this the model is treated as a point and framed at a fixed distance,
# rather than dividing by a radius of zero.
MIN_MODEL_RADIUS_CELLS = 0.01


def setup_world():
    """A blank file with the neutral sky and sun, and nothing else."""
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = CYCLES_SAMPLES
    scene.render.resolution_x = RENDER_PIXELS
    scene.render.resolution_y = RENDER_PIXELS
    scene.render.film_transparent = False

    world = bpy.data.worlds.new('check_world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = WORLD_COLOR
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = WORLD_STRENGTH
    scene.world = world

    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = SUN_ENERGY
    sun.rotation_euler = (
        math.radians(SUN_ELEVATION_DEG), 0, math.radians(SUN_AZIMUTH_DEG),
    )
    bpy.context.collection.objects.link(sun)


def add_stage(kind):
    """A plane at the model's base height, so nothing appears to float."""
    if kind is None:
        return
    bpy.ops.mesh.primitive_plane_add(size=STAGE_SIZE_CELLS, location=(0, 0, 0))
    stage = bpy.context.view_layer.objects.active
    stage.name = 'stage'
    material = bpy.data.materials.new('stage')
    material.use_nodes = True
    bsdf = material.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (
        WATER_COLOR if kind == 'water' else GROUND_COLOR
    )
    bsdf.inputs['Roughness'].default_value = STAGE_ROUGHNESS
    stage.data.materials.append(material)
    return stage


def model_objects():
    """Everything that came out of the .glb (not the studio's own props)."""
    return [
        o for o in bpy.data.objects
        if o.name != 'stage' and o.type not in ('LIGHT', 'CAMERA')
    ]


def lift_model(lift):
    """Raise (or sink) the model relative to the stage plane.

    A boat rests at its waterline, not at its keel, so the shot has to place it
    the way the game does — otherwise the sea line in the picture is not the
    sea line in play.
    """
    if lift == 0.0:
        return
    for obj in model_objects():
        if obj.parent is None:
            obj.location.z += lift


def model_frame():
    """The model's centre and radius in Blender space, for framing the camera."""
    lows, highs = None, None
    for obj in model_objects():
        if obj.type != 'MESH':
            continue
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            if lows is None:
                lows, highs = point.copy(), point.copy()
                continue
            for axis in range(3):
                lows[axis] = min(lows[axis], point[axis])
                highs[axis] = max(highs[axis], point[axis])
    if lows is None:
        raise SystemExit('render_glb: the file contains no meshes to frame')
    centre = (lows + highs) / 2
    radius = max(MIN_MODEL_RADIUS_CELLS, (highs - lows).length / 2)
    return centre, radius


def aim(camera, target, azimuth_deg, elevation_deg, distance):
    """Place the camera on a sphere around the target and point it inward."""
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    camera.location = (
        target[0] + distance * math.cos(el) * math.cos(az),
        target[1] + distance * math.cos(el) * math.sin(az),
        target[2] + distance * math.sin(el),
    )
    # Point local -Z at the target, world +Y as up.
    direction = Vector(target) - Vector(camera.location)
    camera.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


def render_views(glb_path, out_dir, views, stage, lift, name):
    """Import, stage, and write one PNG per requested view."""
    os.makedirs(out_dir, exist_ok=True)
    setup_world()
    bpy.ops.import_scene.gltf(filepath=glb_path)
    lift_model(lift)
    add_stage(stage)

    centre, radius = model_frame()
    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new('check_cam')
    camera_data.lens = CAMERA_LENS_MM
    camera = bpy.data.objects.new('check_cam', camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera

    stem = name or os.path.splitext(os.path.basename(glb_path))[0]
    written = []
    for view in views:
        if view not in VIEWS:
            raise SystemExit(f'render_glb: unknown view "{view}" '
                             f'(have {", ".join(sorted(VIEWS))})')
        azimuth, elevation, radii = VIEWS[view]
        aim(camera, tuple(centre), azimuth, elevation, radius * radii)
        scene.render.filepath = os.path.join(out_dir, f'{stem}_{view}.png')
        bpy.ops.render.render(write_still=True)
        written.append(scene.render.filepath)
        print(f'rendered {scene.render.filepath}')
    return written


def parse_args(args):
    options = {
        'glb': args[0],
        'out_dir': args[1],
        'views': list(DEFAULT_VIEWS),
        'stage': None,
        'lift': 0.0,
        'name': None,
    }
    index = 2
    while index < len(args):
        flag = args[index]
        if flag == '--views':
            options['views'] = args[index + 1].split(',')
            index += 2
        elif flag == '--ground':
            options['stage'] = 'ground'
            index += 1
        elif flag == '--water':
            options['stage'] = 'water'
            index += 1
        elif flag == '--lift':
            options['lift'] = float(args[index + 1])
            index += 2
        elif flag == '--name':
            options['name'] = args[index + 1]
            index += 2
        else:
            raise SystemExit(f'render_glb: unknown option {flag}')
    return options


def main():
    options = parse_args(sys.argv[sys.argv.index('--') + 1:])
    render_views(
        options['glb'], options['out_dir'], options['views'],
        options['stage'], options['lift'], options['name'],
    )


if __name__ == '__main__':
    main()
