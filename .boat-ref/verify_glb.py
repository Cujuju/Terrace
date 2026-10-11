"""Fresh Blender run: import each exported GLB and count triangles/vertices."""
import glob, json, os, bpy
OUT = r"E:\Development\Projects\Terrace\.boat-ref\out" + "\\"
res = {}
for p in sorted(glob.glob(OUT + "*.glb")):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=p)
    tris = verts = 0
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        me = ob.data
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        verts += len(me.vertices)
    res[os.path.basename(p)] = {"tris": tris, "verts": verts,
                                "bytes": os.path.getsize(p)}
json.dump(res, open(OUT + "counts-glb.json", "w"), indent=1)
print("GLBCOUNTS", json.dumps(res))
