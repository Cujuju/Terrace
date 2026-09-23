import bpy, sys, pathlib, math
from mathutils import Vector
ROOT=pathlib.Path(__file__).parent
sys.path.insert(0,str(ROOT.parents[1]/'tools/blender'))
import render_glb as studio
studio.setup_world()
bpy.ops.import_scene.gltf(filepath=str(ROOT/'longhouse.glb'))
stage=studio.add_stage('ground')
stage.data.materials[0].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.24,.25,.24,1)
scene=bpy.context.scene
scene.cycles.samples=40
scene.render.resolution_x=1200; scene.render.resolution_y=1000; scene.render.resolution_percentage=100
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.75
bpy.data.objects['sun'].data.energy=2.0
scene.view_settings.view_transform='AgX'
cam=bpy.data.objects.new('ReviewCamera',bpy.data.cameras.new('ReviewCamera')); bpy.context.collection.objects.link(cam); scene.camera=cam
cam.data.type='ORTHO'
shots=[('longhouse-beauty',-63,27,1.98,(0,-.07,.29)),('longhouse-45deg',-48,45,2.05,(0,-.065,.29)),('longhouse-front',-90,12,1.28,(0,-.06,.31)),('longhouse-side',0,12,1.96,(0,-.065,.30)),('longhouse-closeup',-57,24,.92,(0,-.57,.35))]
if '--quick' in sys.argv:
 shots=shots[:1]; scene.render.resolution_x=960; scene.render.resolution_y=800; scene.cycles.samples=24
for name,az,el,scale,target in shots:
 cam.data.ortho_scale=scale; studio.aim(cam,Vector(target),az,el,3.8)
 scene.render.filepath=str(ROOT/(name+'.png')); bpy.ops.render.render(write_still=True)
 print('RENDERED',name,flush=True)

