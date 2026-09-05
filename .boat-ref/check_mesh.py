"""Fresh Blender run: manifold / normal sanity check on each exported GLB."""
import glob, json, os, bpy, bmesh
OUT = r"E:\Development\Projects\Terrace\.boat-ref\out" + "\\"
res = {}
for p in sorted(glob.glob(OUT + "*.glb")):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=p)
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH" or "hull" not in ob.name and "post" not in ob.name:
            continue
        bm = bmesh.new(); bm.from_mesh(ob.data)
        nonman = sum(1 for e in bm.edges if not e.is_manifold)
        vol = bm.calc_volume(signed=True)
        res[f"{os.path.basename(p)}:{ob.name}"] = {
            "non_manifold_edges": nonman, "signed_volume": round(vol, 8),
            "faces": len(bm.faces)}
        bm.free()
print("MESHCHECK", json.dumps(res))
