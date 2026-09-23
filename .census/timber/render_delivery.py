import bpy, pathlib, sys, math
from mathutils import Vector
ROOT=pathlib.Path(__file__).parent
SRC=ROOT.parents[1]/'plugins/structures/client/assets/timber-house.glb'
sys.path.insert(0,str(ROOT.parents[1]/'tools/blender'))
import render_glb as r
for kind,path in [('before',SRC),('after',ROOT/'timber-house.glb')]:
 if '--after-only' in sys.argv and kind=='before': continue
 r.setup_world(); bpy.ops.import_scene.gltf(filepath=str(path),merge_vertices=False)
 scene=bpy.context.scene; scene.cycles.samples=64; scene.render.resolution_x=1200; scene.render.resolution_y=1200; scene.render.resolution_percentage=100
 scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.65
 bpy.data.objects['sun'].data.energy=2
 scene.view_settings.view_transform='AgX'
 camera=bpy.data.objects.new('Review camera',bpy.data.cameras.new('Review camera')); bpy.context.collection.objects.link(camera); scene.camera=camera
 camera.data.type='ORTHO'; camera.data.ortho_scale=1.18
 target=Vector((0,0,.235)); r.aim(camera,target,45,45,2.4)
 scene.render.filepath=str(ROOT/(kind+'-45deg.png')); bpy.ops.render.render(write_still=True)
 camera.data.ortho_scale=.50; target=Vector((.18,.24,.19)); r.aim(camera,target,45,25,2.4)
 scene.render.filepath=str(ROOT/(kind+'-closeup.png')); bpy.ops.render.render(write_still=True)
 print('Rendered',kind,flush=True)


