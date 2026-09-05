"""Headless Blender: build hulls from out/mesh.json, render 4 views, export GLB."""
import json
import math
import sys
import bpy
import bmesh
from mathutils import Vector

OUT = r"E:\Development\Projects\Terrace\.boat-ref\out" + "\\"

HULL_LENGTH = 0.9
MAST_HEIGHT = HULL_LENGTH * 0.66
MAST_RADIUS = 0.022
YARD_RADIUS = 0.014
YARD_HALF = HULL_LENGTH * 0.34 * 1.15 / 2 + 0.03   # SAIL_WIDTH/2 + YARD_OVERHANG
SUBSURF_LEVEL = 1
CYL_VERTS = 12             # mast/yard cylinder sides; the spars are ~2 px wide
                           # at the game camera, so 12 is already generous.
RES = 512
GAME_CAM_ELEV_DEG = 55.0
GAME_CAM_DIST = 6.0
CLOSE_CAM_DIST = 2.0


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mk_mesh(name, verts, faces):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [list(f) for f in faces])
    me.validate(verbose=False)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def clean(ob, merge=1e-5):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # recalc_face_normals makes the shell CONSISTENT but can settle on the
    # inward orientation; a closed shell whose normals face out has positive
    # signed volume, so use that as the arbiter and flip if it is negative.
    if bm.calc_volume(signed=True) < 0.0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def material(name, rgba, rough=0.7):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    return m


def tri_count(ob, depsgraph):
    ev = ob.evaluated_get(depsgraph)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    n = (len(me.loop_triangles), len(me.vertices))
    ev.to_mesh_clear()
    return n


def aim(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def build_scene(variant, data):
    clear()
    sc = bpy.context.scene
    try:
        sc.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = sc.render.resolution_y = RES
    sc.render.film_transparent = False
    sc.world = bpy.data.worlds.new("W")
    sc.world.use_nodes = True
    sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.38, 0.42, 1)
    sc.world.node_tree.nodes["Background"].inputs[1].default_value = 1.0

    wood = material("wood", (0.30, 0.19, 0.10, 1))
    spar = material("spar", (0.42, 0.29, 0.16, 1))
    grey = material("ground", (0.55, 0.55, 0.55, 1), rough=0.95)

    ground_z = min(v[2] for v in data["hull"]["verts"]) - 0.005
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, ground_z))
    bpy.context.object.data.materials.append(grey)

    parts = []
    hull = mk_mesh("hull", data["hull"]["verts"], data["hull"]["faces"])
    clean(hull)
    hull.data.materials.append(wood)
    if data["hull"]["creases"]:
        hull.data.attributes.new("crease_edge", "FLOAT", "EDGE")
    if variant != "hull-current":
        sub = hull.modifiers.new("sub", "SUBSURF")
        sub.levels = sub.render_levels = SUBSURF_LEVEL
        for p in hull.data.polygons:
            p.use_smooth = True
    parts.append(hull)

    if data["posts"]["verts"]:
        posts = mk_mesh("posts", data["posts"]["verts"], data["posts"]["faces"])
        clean(posts)
        posts.data.materials.append(wood)
        parts.append(posts)

    # mast + yard, so the silhouette is comparable with the in-game boat
    deck_z = max(v[2] for v in data["hull"]["verts"])
    bpy.ops.mesh.primitive_cylinder_add(vertices=CYL_VERTS, radius=MAST_RADIUS, depth=MAST_HEIGHT,
                                        location=(0, 0, deck_z + MAST_HEIGHT / 2))
    mast = bpy.context.object
    mast.data.materials.append(spar)
    parts.append(mast)
    bpy.ops.mesh.primitive_cylinder_add(vertices=CYL_VERTS, radius=YARD_RADIUS, depth=YARD_HALF * 2,
                                        rotation=(math.pi / 2, 0, 0),
                                        location=(0, 0, deck_z + MAST_HEIGHT * 0.85))
    yard = bpy.context.object
    yard.data.materials.append(spar)
    parts.append(yard)

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    bpy.context.collection.objects.link(sun)

    return parts, deck_z


def render_views(variant, parts, deck_z):
    sc = bpy.context.scene
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    bpy.context.collection.objects.link(cam)
    sc.camera = cam
    focus = Vector((0, 0, deck_z * 0.5))
    e = math.radians(GAME_CAM_ELEV_DEG)
    d = CLOSE_CAM_DIST
    views = {
        "game": (GAME_CAM_DIST * math.cos(e) * math.cos(math.radians(35)),
                 -GAME_CAM_DIST * math.cos(e) * math.sin(math.radians(35)),
                 GAME_CAM_DIST * math.sin(e)),
        "side": (0, -d, 0.05),
        "top": (0, 0.0001, d),
        "bow34": (d * 0.80, -d * 0.52, d * 0.34),
    }
    for name, pos in views.items():
        cam.location = Vector(pos) + focus
        aim(cam, focus)
        sc.render.filepath = OUT + f"{variant}-{name}.png"
        bpy.ops.render.render(write_still=True)


def main():
    data = json.load(open(OUT + "mesh.json"))
    report = {}
    for variant, d in data.items():
        parts, deck_z = build_scene(variant, d)
        dg = bpy.context.evaluated_depsgraph_get()
        tot = [0, 0]
        for p in parts:
            t, v = tri_count(p, dg)
            tot[0] += t
            tot[1] += v
        # level-2 count for the hull, for the report
        lvl2 = None
        if variant != "hull-current":
            parts[0].modifiers["sub"].levels = parts[0].modifiers["sub"].render_levels = 2
            dg = bpy.context.evaluated_depsgraph_get()
            lvl2 = tri_count(parts[0], dg)[0]
            parts[0].modifiers["sub"].levels = parts[0].modifiers["sub"].render_levels = SUBSURF_LEVEL
        report[variant] = {"tris_L1": tot[0], "verts_L1": tot[1], "hull_tris_L2": lvl2}

        render_views(variant, parts, deck_z)
        for o in bpy.context.scene.objects:
            o.select_set(o in parts)
        bpy.context.view_layer.objects.active = parts[0]
        bpy.ops.export_scene.gltf(filepath=OUT + variant + ".glb",
                                  export_format="GLB", use_selection=True,
                                  export_apply=True, export_yup=True)
    json.dump(report, open(OUT + "counts-build.json", "w"), indent=1)
    print("REPORT", json.dumps(report))


main()
