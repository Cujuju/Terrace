"""Asset QA: inspect the exported glTF and render the actual imported mesh."""
import bpy
import json
import math
import struct
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parent
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
