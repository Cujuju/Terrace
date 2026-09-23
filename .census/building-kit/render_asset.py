"""Render delivered PNG GLBs with matched cameras, without running Terrace."""
import bpy,sys,math,json
from pathlib import Path
from mathutils import Vector
KIT=Path(__file__).parent
NAME=sys.argv[sys.argv.index('--id')+1]
ROOT=KIT.parent/NAME
LOW='--low' in sys.argv
if LOW:ROOT=ROOT/'low'
sys.path.insert(0,str(KIT.parent.parent/'tools'/'blender'))
import render_glb as studio
studio.setup_world()
bpy.ops.import_scene.gltf(filepath=str(ROOT/(NAME+'.glb')))
if '--clay' in sys.argv:
    for material in bpy.data.materials:
        if not material.use_nodes:continue
        node=material.node_tree.nodes.get('Principled BSDF')
        for label in ('Base Color','Normal'):
            for link in list(node.inputs[label].links):material.node_tree.links.remove(link)
        node.inputs['Base Color'].default_value=(.5,.5,.5,1)
centre,radius=studio.model_frame()
stage=studio.add_stage('ground')
stage.data.materials[0].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.24,.25,.24,1)
scene=bpy.context.scene
scene.cycles.samples=24
scene.cycles.use_denoising=True
scene.render.resolution_x=1000;scene.render.resolution_y=900;scene.render.resolution_percentage=100
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.75
bpy.data.objects['sun'].data.energy=2.0
scene.view_settings.view_transform='AgX'
cam=bpy.data.objects.new('ReviewCamera',bpy.data.cameras.new('ReviewCamera'));bpy.context.collection.objects.link(cam);scene.camera=cam
cam.data.type='ORTHO'
# Fixed framing from ORIGINAL bounds for identical LOD cameras.
report=json.loads((KIT.parent/NAME/'verification.json').read_text())
lo=report['bounds_gltf_y_up']['min'];hi=report['bounds_gltf_y_up']['max']
centre=Vector(((lo[0]+hi[0])/2,-(lo[2]+hi[2])/2,(lo[1]+hi[1])/2))
width=hi[0]-lo[0];depth=hi[2]-lo[2];height=hi[1]-lo[1]
scale=max(math.hypot(width,depth)*1.18,height*1.35)
front=json.loads((ROOT/'build-report.json').read_text())['placement']['front_gltf']
az=-48 if front=='+Z' else -42
target=centre.copy();target.z=height*.40
shots=[('45deg',az,45,scale,target)]
close=target.copy();close.z=height*.55
if front=='+Z':close.y=-(hi[2]*.65)
else:close.x=hi[0]*.55
shots.append(('closeup',az,25,scale*.58,close))
if NAME=='durands':
    straight=centre.copy();straight.z=height*.49
    shots.append(('front',-90,8,scale*.87,straight))
if '--quick' in sys.argv:shots=shots[:1];scene.render.resolution_x=800;scene.render.resolution_y=720;scene.cycles.samples=16
for label,az,el,sc,target in shots:
    cam.data.ortho_scale=sc;studio.aim(cam,target,az,el,radius*5)
    output=ROOT/(NAME+'-'+label+('-clay' if '--clay' in sys.argv else '')+'.png')
    pending=output.with_name('.render-'+output.name)
    scene.render.filepath=str(pending);bpy.ops.render.render(write_still=True)
    pending.replace(output)
    print('RENDERED',NAME,label,flush=True)
