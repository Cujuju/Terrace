"""Fresh orthographic profile and quarter-view renders of the exported Apache GLB."""

from datetime import datetime
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
import render_glb

PROFILE_WIDTH = 1536
PROFILE_HEIGHT = 512
PROFILE_MARGIN = 1.12
QUARTER_PIXELS = 1024
QUARTER_LENS_MM = 50


def main():
    asset, directory = sys.argv[sys.argv.index('--')+1:]
    os.makedirs(directory, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    stem = f'apache-profile-rebuild-{stamp}'
    render_glb.setup_world()
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(asset))
    centre, radius = render_glb.model_frame()
    scene = bpy.context.scene
    scene.render.resolution_x = PROFILE_WIDTH
    scene.render.resolution_y = PROFILE_HEIGHT
    data = bpy.data.cameras.new('profile_camera')
    data.type = 'ORTHO'
    data.ortho_scale = PROFILE_MARGIN
    camera = bpy.data.objects.new('profile_camera',data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    render_glb.aim(camera,tuple(centre),90,0,radius*3)
    scene.render.filepath = os.path.join(directory,f'{stem}_side.png')
    bpy.ops.render.render(write_still=True)
    print(f'rendered {scene.render.filepath}')
    render_glb.RENDER_PIXELS = QUARTER_PIXELS
    render_glb.CAMERA_LENS_MM = QUARTER_LENS_MM
    render_glb.render_views(asset,directory,['bow34','game'],None,0,stem)


if __name__ == '__main__':
    main()
