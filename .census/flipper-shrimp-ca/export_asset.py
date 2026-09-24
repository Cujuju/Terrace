"""Export the saved authoring scene without rebuilding textures or rendering."""
import bpy
import bmesh
import json
import tempfile
from pathlib import Path
from mathutils import Vector


def export_asset(root):
    scene=bpy.context.scene
    asset=next(c for c in scene.collection.children if c.name.startswith('CLUBHOUSE'))
    report=json.loads((root/'verification.json').read_text())
    coords=[o.matrix_world@Vector(p) for o in asset.objects for p in o.bound_box]
    span=max(max(p[i] for p in coords)-min(p[i] for p in coords) for i in (0,1))
    # The glTF roughness packer needs a writable temporary directory.
    temporary=root/'export-tmp'
    temporary.mkdir(exist_ok=True)
    previous_temp=tempfile.tempdir
    tempfile.tempdir=str(temporary)
    try:
        bpy.ops.object.select_all(action='DESELECT')
        for ob in asset.objects: ob.select_set(True)
        bpy.context.view_layer.objects.active=next(o for o in asset.objects if o.type=='MESH')
        bpy.ops.object.convert(target='MESH')
        bpy.ops.object.join()
        joined=bpy.context.object;joined.name='Flipper and Shrimp C+A'
        joined.scale=(.86/span,)*3
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        bpy.ops.export_scene.gltf(filepath=str(root/'flipper-shrimp-ca.glb'),export_format='GLB',use_selection=True,export_apply=True)
        report['gltf_footprint']=.86
        report['gltf_bytes']=(root/'flipper-shrimp-ca.glb').stat().st_size
        (root/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
        print('EXPORTED',report['gltf_bytes'],flush=True)
        bm=bmesh.new();bm.from_mesh(joined.data)
        bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-7)
        bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=1e-8)
        bm.to_mesh(joined.data);bm.free()
        mod=joined.modifiers.new('Lighter presentation mesh','DECIMATE')
        mod.ratio=.48;mod.use_collapse_triangulate=True
        allowed={v.identifier for v in mod.bl_rna.properties['delimit'].enum_items}
        if 'MATERIAL' in allowed: mod.delimit={'MATERIAL'}
        bpy.context.view_layer.objects.active=joined
        bpy.ops.object.modifier_apply(modifier=mod.name)
        joined.data.calc_loop_triangles()
        report['lighter_export_triangles']=len(joined.data.loop_triangles)
        bpy.ops.export_scene.gltf(filepath=str(root/'flipper-shrimp-ca-light.glb'),export_format='GLB',use_selection=True,export_apply=True)
        report['lighter_export_bytes']=(root/'flipper-shrimp-ca-light.glb').stat().st_size
        (root/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
        print('LIGHTER EXPORT',report['lighter_export_triangles'],flush=True)
    finally:
        tempfile.tempdir=previous_temp
        # Only the known empty scratch directory is removed; no recursive delete.
        if temporary.exists() and not any(temporary.iterdir()): temporary.rmdir()


if __name__=='__main__':
    root=Path(__file__).resolve().parent/'revision-3'
    bpy.ops.wm.open_mainfile(filepath=str(root/'flipper-shrimp-ca.blend'))
    export_asset(root)
