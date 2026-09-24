"""Asset QA: inspect the exported glTF and render the actual imported mesh."""
import bpy
import json
import math
import struct
import sys
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parent/'revision-3'
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'flipper-shrimp-ca.blend'))
scene=bpy.context.scene
collection=next(c for c in scene.collection.children if c.name.startswith('CLUBHOUSE'))
camera=scene.camera
oldloc=camera.location.copy();oldrot=camera.rotation_euler.copy();oldscale=camera.data.ortho_scale
scene.render.resolution_x=1400;scene.render.resolution_y=850
camera.location=(1.3,-16,11.4)
camera.rotation_euler=(Vector((0,1,7.8))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.ortho_scale=8.15
scene.render.filepath=str(ROOT/'mascots-closeup.png')
bpy.ops.render.render(write_still=True)
camera.location=(5.7,-12,5.5)
camera.rotation_euler=(Vector((2.45,-2.7,.80))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.ortho_scale=4.9
scene.render.filepath=str(ROOT/'stone-and-barnacles.png')
if '--reuse-static-renders' not in sys.argv or not (ROOT/'stone-and-barnacles.png').exists():
    bpy.ops.render.render(write_still=True)
scene.render.resolution_x=1400;scene.render.resolution_y=1050
camera.location=(.8,-16,15)
camera.rotation_euler=(Vector((0,-.80,2.4))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.ortho_scale=6.4
scene.render.filepath=str(ROOT/'slides-closeup.png')
if '--reuse-static-renders' not in sys.argv or not (ROOT/'slides-closeup.png').exists():
    bpy.ops.render.render(write_still=True)
slide_checks=[]
for item in collection.objects:
    if item.name in ('Blue sweeping flume','Coral sweeping flume'):
        evaluated=item.evaluated_get(bpy.context.evaluated_depsgraph_get())
        surface=evaluated.to_mesh()
        side=-1 if item.name.startswith('Blue') else 1
        intruding=sum(1 for v in surface.vertices if 1.40<v.co.z<1.64 and ((v.co.x-side*3.58)/1.55)**2+((v.co.y+1.25)/1.78)**2<1)
        evaluated.to_mesh_clear()
        slide_checks.append({'name':item.name,'upward_faces':sum(p.normal.z>0 for p in item.data.polygons),'faces':len(item.data.polygons),'vertices_inside_lounge_deck':intruding})
overlay_count=sum(o.name.startswith('Slide running water') for o in collection.objects)
lanterns=[o for o in collection.objects if o.name.startswith(('Amber lantern','Lighthouse glowing lantern'))]
emission_source={}
for lamp in lanterns:
    bs=next(n for n in lamp.data.materials[0].node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    emission_source[lamp.name]=float(bs.inputs['Emission Strength'].default_value)
surface_maps={}
for name in ('Limestone','Warm stone','Barnacled timber','Dolphin painted relief','Shrimp painted relief'):
    mat=bpy.data.materials[name]
    surface_maps[name]=[n.image.name for n in mat.node_tree.nodes if n.type=='TEX_IMAGE' and n.image]
camera.location=oldloc;camera.rotation_euler=oldrot;camera.data.ortho_scale=oldscale
scene.render.resolution_x=1200;scene.render.resolution_y=1200

# Inspect the binary export rather than relying on the authoring object count.
raw=(ROOT/'flipper-shrimp-ca.glb').read_bytes()
magic,version,total=struct.unpack_from('<III',raw,0)
assert magic==0x46546c67 and version==2 and total==len(raw)
length,kind=struct.unpack_from('<II',raw,12)
gltf=json.loads(raw[20:20+length])
triangles=sum(gltf['accessors'][p['indices']]['count']//3 for m in gltf['meshes'] for p in m['primitives'])
assert all(p.get('mode',4)==4 for m in gltf['meshes'] for p in m['primitives'])
assert len(gltf.get('images',[]))>=20
assert all('bufferView' in i for i in gltf['images'])
alpha=[m['name'] for m in gltf['materials'] if m.get('alphaMode') in ('BLEND','MASK')]
assert len(alpha)>=2, alpha
coloured=[gltf['materials'][p['material']]['name'] for m in gltf['meshes'] for p in m['primitives'] if 'COLOR_0' in p['attributes']]
emissive=[{'name':m['name'],'factor':m.get('emissiveFactor'),
           'strength':m.get('extensions',{}).get('KHR_materials_emissive_strength',{}).get('emissiveStrength',1)}
          for m in gltf['materials'] if any(m.get('emissiveFactor',[0,0,0]))]

# This affects the disposable QA process only.
for ob in list(collection.objects): bpy.data.objects.remove(ob,do_unlink=True)
before=set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=str(ROOT/'flipper-shrimp-ca.glb'))
imported=set(bpy.data.objects)-before
meshes=[o for o in imported if o.type=='MESH']
assert len(meshes)==1
ob=meshes[0]
assert abs(max(ob.dimensions.x,ob.dimensions.y)-.86)<.001
factor=11.0600004196167/.86
ob.scale*=factor
bpy.context.view_layer.update()
scene.render.filepath=str(ROOT/'export-roundtrip.png')
bpy.ops.render.render(write_still=True)
report=json.loads((ROOT/'verification.json').read_text())
report['export_verified']={
    'triangles':triangles,'mesh_count':len(gltf['meshes']),
    'material_primitives':sum(len(m['primitives']) for m in gltf['meshes']),
    'embedded_images':len(gltf['images']),'alpha_materials':alpha,
    'self_contained':True,'roundtrip_render':'export-roundtrip.png',
    'mascot_closeup':'mascots-closeup.png',
    'slide_closeup':'slides-closeup.png',
    'slide_surfaces':slide_checks,'separate_slide_water_overlays':overlay_count,
    'vertex_colour_materials':coloured,
    'emissive_materials':emissive,
    'lantern_emission_strengths':emission_source,
    'surface_image_maps':surface_maps,
}
(ROOT/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report['export_verified']),flush=True)

# Validate the lighter file independently, including its alpha decals.
for item in imported: bpy.data.objects.remove(item,do_unlink=True)
before=set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=str(ROOT/'flipper-shrimp-ca-light.glb'))
light_imported=set(bpy.data.objects)-before
light_meshes=[o for o in light_imported if o.type=='MESH']
assert len(light_meshes)==1
light=light_meshes[0]
assert abs(max(light.dimensions.x,light.dimensions.y)-.86)<.001
light.data.calc_loop_triangles()
assert len(light.data.loop_triangles)==report['lighter_export_triangles']
light.scale*=factor
bpy.context.view_layer.update()
scene.render.filepath=str(ROOT/'lighter-export-roundtrip.png')
bpy.ops.render.render(write_still=True)
report['lighter_export_verified']={
    'triangles':len(light.data.loop_triangles),'mesh_count':1,
    'roundtrip_render':'lighter-export-roundtrip.png',
    'footprint':.86,
}
(ROOT/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report['lighter_export_verified']),flush=True)

# Dim the studio on the re-imported GLB to make retained emission directly visible.
for light in scene.objects:
    if light.type=='LIGHT': light.data.energy*=.018
bg=next(n for n in scene.world.node_tree.nodes if n.type=='BACKGROUND')
bg.inputs['Strength'].default_value=.012
scene.render.filepath=str(ROOT/'emission-check.png')
bpy.ops.render.render(write_still=True)
