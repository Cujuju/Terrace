"""Review actual exported Ricks GLBs under day, night and zero external light."""
from pathlib import Path
import json
import math
import sys
import bpy
import numpy as np
from mathutils import Vector

kit=Path(__file__).parent
root=kit.parent/'ricks'
sys.path.insert(0,str(kit.parent.parent/'tools'/'blender'))
import render_glb as studio

report={}
for quality,folder in (('original',root),('low',root/'low')):
    studio.setup_world()
    bpy.ops.import_scene.gltf(filepath=str(folder/'ricks.glb'))
    center,radius=studio.model_frame()
    scene=bpy.context.scene
    scene.cycles.samples=32
    scene.cycles.use_denoising=True
    scene.cycles.max_bounces=0
    scene.cycles.diffuse_bounces=0
    scene.cycles.glossy_bounces=0
    scene.render.resolution_x=1400
    scene.render.resolution_y=1050
    scene.render.resolution_percentage=100
    scene.view_settings.view_transform='AgX'
    camera=bpy.data.objects.new('ReviewCamera',bpy.data.cameras.new('ReviewCamera'))
    bpy.context.collection.objects.link(camera);scene.camera=camera
    camera.data.type='ORTHO';camera.data.ortho_scale=1.20
    target=Vector((0,-.01,.18))
    studio.aim(camera,target,-60,30,radius*5)
    ground=studio.add_stage('ground')
    ground.data.materials[0].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.30,.29,.265,1)
    material=bpy.data.materials['ricks_PBR']
    emission=material.node_tree.nodes['Principled BSDF'].inputs['Emission Strength']
    strength=emission.default_value
    results={}
    states=(('day',.65,2.),('night',.015,.035),('unlit',0.,0.),('emission-off',0.,0.))
    for label,ambient,sun in states:
        scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=ambient
        bpy.data.objects['sun'].data.energy=sun
        emission.default_value=0 if label=='emission-off' else strength
        scene.render.film_transparent=label in ('unlit','emission-off')
        output=folder/('ricks-'+label+'.png')
        scene.render.filepath=str(output)
        bpy.ops.render.render(write_still=True)
        im=bpy.data.images.load(str(output),check_existing=False)
        im.colorspace_settings.name='Non-Color'
        data=np.array(im.pixels[:]).reshape(-1,4)
        results[label]={'external_world_strength':ambient,'external_sun_strength':sun,
                        'emission_strength':float(emission.default_value),
                        'bright_pixels':int(np.count_nonzero(data[:,:3].max(axis=1)>.12))}
        bpy.data.images.remove(im)
    assert results['unlit']['bright_pixels']>1000
    assert results['emission-off']['bright_pixels']==0
    report[quality]=results
report['indirect_bounces']=0
report['bloom']=False
report['passed']=True
(root/'lighting-verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2),flush=True)
