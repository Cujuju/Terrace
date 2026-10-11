"""Matched dark-studio views of delivered emissive saloon GLBs; no game process."""
import bpy,sys,json,math
from pathlib import Path
from mathutils import Vector
KIT=Path(__file__).parent
ROOT=KIT.parent/'durands'
if '--low' in sys.argv: ROOT=ROOT/'low'
sys.path.insert(0,str(KIT.parent.parent/'tools'/'blender'))
import render_glb as studio
studio.setup_world()
bpy.ops.import_scene.gltf(filepath=str(ROOT/'durands.glb'))
centre,radius=studio.model_frame()
studio.add_stage('ground')
scene=bpy.context.scene
scene.cycles.samples=32
scene.cycles.use_denoising=True
scene.cycles.diffuse_bounces=0
scene.cycles.glossy_bounces=0
# Emissive surfaces stay bright; avoid depicting extra lamp illumination that
# the real-time game does not calculate from the material alone.
for mat in bpy.data.materials:
    if hasattr(mat.cycles,'emission_sampling'): mat.cycles.emission_sampling='NONE'
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.20,.27,.40,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.035
bpy.data.objects['sun'].data.energy=.12
bpy.data.objects['sun'].data.color=(.48,.60,1.0)
scene.view_settings.view_transform='AgX'
scene.render.resolution_x=1000;scene.render.resolution_y=900;scene.render.resolution_percentage=100
cam=bpy.data.objects.new('NightReviewCamera',bpy.data.cameras.new('NightReviewCamera'))
bpy.context.collection.objects.link(cam);scene.camera=cam;cam.data.type='ORTHO'
report=json.loads((KIT.parent/'durands'/'verification.json').read_text())
lo=report['bounds_gltf_y_up']['min'];hi=report['bounds_gltf_y_up']['max']
height=hi[1]-lo[1]
cam.data.ortho_scale=max(math.hypot(hi[0]-lo[0],hi[2]-lo[2])*1.18,height*1.35)
target=Vector(((lo[0]+hi[0])/2,-(lo[2]+hi[2])/2,height*.40))
studio.aim(cam,target,-48,35,radius*5)
output=ROOT/'durands-night.png';pending=ROOT/'.render-durands-night.png'
scene.render.filepath=str(pending);bpy.ops.render.render(write_still=True);pending.replace(output)
