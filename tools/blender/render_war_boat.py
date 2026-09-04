# render_war_boat.py — four 512px checks of the exported war boat.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/render_war_boat.py -- \
#     E:\...\model-assets\plugins\boats\client\assets\war-boat.glb \
#     E:\...\model-assets\tools\blender\out
#
# Views: game (~55 deg down at distance 6, the actual play camera), side, top,
# bow three-quarter. CPU Cycles — the only engine that renders headless
# without a GPU. Output PNGs are UNCOMMITTED eyes-on checks, not artefacts.

import math
import os
import sys

import bpy
from mathutils import Vector


def setup():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 64
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.film_transparent = False
    world = bpy.data.worlds.new('check_world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.6, 0.65, 1.0)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.2
    scene.world = world

    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    bpy.context.collection.objects.link(sun)

    # Sea disc at y=0 world: the shots check the waterline bite, not just shape.
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))
    sea = bpy.context.view_layer.objects.active
    sea.name = 'sea'
    mat = bpy.data.materials.new('sea')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (0x2F / 255, 0x6F / 255, 0x8F / 255, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.6
    sea.data.materials.append(mat)


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

    setup()
    bpy.ops.import_scene.gltf(filepath=glb_path)

    # Rest the keel at the waterline the game uses: origin + waterline lift.
    waterline = bpy.data.objects.get('waterline')
    lift = -(waterline.location.z if waterline else 0.11)
    for obj in bpy.data.objects:
        if obj.parent is None and obj.name != 'sea' and obj.type != 'LIGHT':
            if obj.type == 'CAMERA':
                continue
            obj.location.z += lift

    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new('check_cam')
    cam_data.lens = 35
    camera = bpy.data.objects.new('check_cam', cam_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    target = (0.05, 0.0, 0.15)

    views = [
        ('game', 30.0, 55.0, 6.0),
        ('side', 90.0, 8.0, 3.0),
        ('top', 90.0, 89.0, 3.0),
        ('bow34', 45.0, 25.0, 3.0),
    ]
    for name, az, el, dist in views:
        aim(camera, target, az, el, dist)
        scene.render.filepath = os.path.join(out_dir, f'war-boat-{name}.png')
        bpy.ops.render.render(write_still=True)
        print(f'rendered {scene.render.filepath}')


main()
