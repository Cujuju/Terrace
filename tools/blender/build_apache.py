"""Build a textured, rigid-jointed Apache GLB. Run with Blender --background --python.

Arguments after --: output directory. No external textures or Python dependencies.
"""

import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(__file__))
from export_glb import export_scene_glb

FOOTPRINT = 1.0
TRIANGLE_BUDGET = 1000
ATLAS_SIZE = 1024
TILE_SIZE = ATLAS_SIZE // 4
UV_PADDING = 10
ROTOR_RADIUS = 7.3
ROTOR_CENTRE = (0.0, 0.0, 2.15)
TAIL_ROTOR_CENTRE = (-7.65, 0.30, 1.70)
GUN_CENTRE = (3.45, 0.0, -0.65)
MAIN_WHEEL_RADIUS = 0.42
MAIN_WHEEL_WIDTH = 0.30
MAIN_WHEEL_SIDES = 10
PARTS = {}

# Each tile is reused across matching surfaces; detail never adds geometry.
PALETTE = [
    (69, 76, 46), (79, 85, 54), (51, 61, 45), (29, 44, 48),
    (31, 52, 60), (39, 43, 36), (30, 33, 31), (96, 104, 65),
    (65, 72, 47), (27, 29, 28), (76, 80, 72), (48, 54, 37),
    (49, 57, 39), (54, 73, 79), (59, 64, 45), (58, 65, 43),
]
HULL, PANEL, VENT, GLASS, WINDSCREEN, BLADE, RUBBER, WING = range(8)
TAIL, DARK, STEEL, ROCKET, MISSILE, SENSOR, MARKING, PLAIN = range(8, 16)


def atlas():
    rng = np.random.default_rng(64)
    pixels = np.zeros((ATLAS_SIZE, ATLAS_SIZE, 4), dtype=np.float32)
    rough = np.ones_like(pixels)
    for tile, colour in enumerate(PALETTE):
        tx, ty = (tile % 4) * TILE_SIZE, (tile // 4) * TILE_SIZE
        p = pixels[ty:ty + TILE_SIZE, tx:tx + TILE_SIZE]
        noise = rng.normal(0, 1.1, (TILE_SIZE, TILE_SIZE, 1))
        p[:, :, :3] = np.clip((np.array(colour) + noise) / 255, 0, 1)
        p[:, :, 3] = 1
        r = rough[ty:ty + TILE_SIZE, tx:tx + TILE_SIZE]
        r[:, :, :3] = 0.78

        def rect(x0, y0, x1, y1, c):
            p[y0:y1, x0:x1, :3] = np.array(c) / 255

        def frame(x0, y0, x1, y1, c, w=2):
            rect(x0, y0, x1, y0 + w, c)
            rect(x0, y1 - w, x1, y1, c)
            rect(x0, y0, x0 + w, y1, c)
            rect(x1 - w, y0, x1, y1, c)

        def circle(cx, cy, radius, c):
            yy, xx = np.ogrid[:TILE_SIZE, :TILE_SIZE]
            p[(xx - cx) ** 2 + (yy - cy) ** 2 <= radius ** 2, :3] = np.array(c) / 255

        if tile in (HULL, PANEL, WING, TAIL, MARKING):
            frame(22, 23, 234, 230, (36, 43, 28))
            rect(25, 229, 231, 231, (101, 106, 73))
            rect(25, 140, 231, 142, (44, 50, 33))
            frame(40, 47, 103, 100, (39, 45, 30))
            rect(91, 70, 98, 75, (146, 145, 114))
            for i in range(5):
                rect(147 + i * 12, 59, 151 + i * 12, 88, (31, 39, 26))
        if tile in (GLASS, WINDSCREEN):
            yy, xx = np.mgrid[:TILE_SIZE, :TILE_SIZE]
            shine = np.clip((yy - xx * 0.24) / 256, 0, 1)[..., None]
            p[:, :, :3] = (np.array((17, 24, 27)) + shine * np.array((47, 56, 62))) / 255
            if tile == GLASS:
                rect(60, 35, 97, 144, (24, 28, 27))
                rect(75, 38, 135, 114, (32, 36, 33))
                circle(114, 146, 27, (65, 69, 60))
                rect(116, 140, 142, 149, (18, 24, 23))
                reflection = (xx > 157 + yy*.18) & (xx < 180 + yy*.18)
                p[reflection, :3] = np.array((100, 118, 124))/255
            frame(10, 10, 246, 246, (57, 64, 44), 15)
            frame(25, 25, 231, 231, (11, 19, 20), 3)
            rect(34, 214, 220, 218, (129, 142, 140))
            r[:, :, :3] = 0.19
        if tile == VENT:
            frame(22, 22, 234, 234, (101, 103, 70), 4)
            for y in range(34, 224, 15):
                rect(31, y, 224, y + 9, (17, 23, 19))
                rect(31, y + 9, 224, y + 11, (89, 95, 69))
        if tile == BLADE:
            rect(12, 22, 244, 28, (83, 87, 78))
            rect(219, 28, 236, 232, (80, 85, 73))
            rect(39, 28, 41, 232, (17, 21, 20))
        if tile == RUBBER:
            circle(128, 128, 96, (17, 20, 19))
            circle(128, 128, 53, (78, 84, 66))
            circle(128, 128, 34, (40, 47, 37))
            circle(128, 128, 14, (120, 126, 104))
        if tile == ROCKET:
            circle(128, 128, 106, (116, 122, 94))
            circle(128, 128, 98, (38, 43, 32))
            for row in range(-2, 3):
                for col in range(-2, 3):
                    x, y = 128 + col * 34 + (row % 2) * 17, 128 + row * 31
                    if (x - 128) ** 2 + (y - 128) ** 2 < 75 ** 2:
                        circle(x, y, 13, (110, 115, 87))
                        circle(x, y, 10, (10, 15, 13))
        if tile == MISSILE:
            rect(192, 12, 207, 244, (190, 171, 78))
            rect(53, 12, 57, 244, (119, 125, 87))
        if tile == SENSOR:
            circle(128, 128, 98, (14, 23, 24))
            circle(128, 128, 80, (37, 73, 80))
            circle(112, 147, 48, (69, 112, 121))
            circle(94, 169, 18, (158, 195, 191))
            r[:, :, :3] = 0.16
        if tile in (DARK, STEEL):
            r[:, :, :3] = 0.42
        if tile == MARKING:
            # A deliberately tiny stencil: readable at inspection scale only.
            glyphs = {'0': ['111','101','101','101','111'],
                      '6': ['111','100','111','101','111'],
                      '4': ['101','101','111','001','001']}
            for index, char in enumerate('064'):
                for row, line in enumerate(glyphs[char]):
                    for col, bit in enumerate(line):
                        if bit == '1':
                            x, y = 128 + index * 25 + col * 6, 177 - row * 6
                            rect(x, y, x + 5, y + 5, (159, 163, 124))

    material = bpy.data.materials.new('apache_olive_atlas')
    material.use_nodes = True
    material.use_backface_culling = True
    bsdf = material.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Metallic'].default_value = 0.12
    for name, data, socket, space in (
        ('apache_basecolor', pixels, 'Base Color', 'sRGB'),
        ('apache_roughness', rough, 'Roughness', 'Non-Color'),
    ):
        img = bpy.data.images.new(name, ATLAS_SIZE, ATLAS_SIZE, alpha=True)
        img.colorspace_settings.name = space
        img.pixels.foreach_set(data.ravel())
        img.pack()
        node = material.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = img
        material.node_tree.links.new(node.outputs['Color'], bsdf.inputs[socket])
    return material


def add(name, vertices, faces, tiles=PLAIN):
    verts, polys, labels = PARTS.setdefault(name, ([], [], []))
    offset = len(verts)
    verts.extend(vertices)
    polys.extend([tuple(offset + i for i in face) for face in faces])
    labels.extend([tiles] * len(faces) if isinstance(tiles, int) else tiles)


def loft(name, rings, sides=8, tile=HULL, cap=PLAIN):
    vertices = []
    for x, y, z, ry, rz in rings:
        for i in range(sides):
            angle = (i + 0.5) * math.tau / sides
            vertices.append((x, y + ry * math.cos(angle), z + rz * math.sin(angle)))
    faces = [tuple(reversed(range(sides)))]
    labels = [cap]
    for j in range(len(rings) - 1):
        for i in range(sides):
            faces.append((j*sides+i, j*sides+(i+1)%sides,
                          (j+1)*sides+(i+1)%sides, (j+1)*sides+i))
            labels.append(tile)
    faces.append(tuple((len(rings)-1)*sides+i for i in range(sides)))
    labels.append(cap)
    add(name, vertices, faces, labels)


def prism(name, outline, thickness, axis=2, tile=PLAIN):
    n = len(outline)
    vertices = []
    for sign in (-1, 1):
        for point in outline:
            p = list(point)
            p[axis] += sign * thickness / 2
            vertices.append(p)
    faces = [tuple(reversed(range(n))), tuple(range(n, n*2))]
    faces.extend((i, (i+1)%n, (i+1)%n+n, i+n) for i in range(n))
    add(name, vertices, faces, tile)


def rod(name, start, end, radius, tile=STEEL, sides=6, cap=None):
    direction = Vector(end) - Vector(start)
    u = direction.normalized().cross(Vector((0, 0, 1)))
    if u.length < 0.01:
        u = direction.normalized().cross(Vector((0, 1, 0)))
    u.normalize()
    v = direction.normalized().cross(u)
    vertices = [tuple(Vector(p) + radius*(u*math.cos(i*math.tau/sides) +
                v*math.sin(i*math.tau/sides))) for p in (start, end) for i in range(sides)]
    faces = [tuple(reversed(range(sides))), tuple(range(sides, 2*sides))]
    faces.extend((i, (i+1)%sides, (i+1)%sides+sides, i+sides) for i in range(sides))
    add(name, vertices, faces, [tile if cap is None else cap]*2 + [tile]*sides)


def main_wheel(centre):
    x, y, z = centre
    vertices = []
    for offset, radius in ((-MAIN_WHEEL_WIDTH/2, MAIN_WHEEL_RADIUS*.82),
                           (0, MAIN_WHEEL_RADIUS),
                           (MAIN_WHEEL_WIDTH/2, MAIN_WHEEL_RADIUS*.82)):
        for i in range(MAIN_WHEEL_SIDES):
            angle = (i+.5)*math.tau/MAIN_WHEEL_SIDES
            vertices.append((x+radius*math.cos(angle),y+offset,z+radius*math.sin(angle)))
    n = MAIN_WHEEL_SIDES
    faces = [tuple(reversed(range(n))),tuple(range(2*n,3*n))]
    for row in range(2):
        faces.extend((row*n+i,row*n+(i+1)%n,(row+1)*n+(i+1)%n,(row+1)*n+i)
                     for i in range(n))
    add('fuselage',vertices,faces,[RUBBER]*2+[DARK]*(n*2))


def build_geometry():
    loft('fuselage', [(-3.0,0,0,.48,.48),(-1.9,0,-.04,.78,.73),
         (.1,0,-.08,.87,.79),(2.8,0,-.10,.76,.66),
         (4.85,0,-.06,.53,.43),(5.65,0,-.05,.38,.31)])
    loft('fuselage', [(-7.8,0,.72,.12,.17),(-6.7,0,.52,.22,.24),
         (-3.0,0,.08,.47,.46)], sides=6, tile=TAIL)
    # Six-sided angular tandem canopy, with painted frames on each glass face.
    canopy = [(-.15,.63,.54,1.34),(1.45,.63,.56,1.39),
              (2.3,.60,.52,1.37),(3.1,.56,.44,1.04),
              (4.2,.48,.35,.79),(4.85,.40,.30,.36)]
    verts = []
    for x, width, base, top in canopy:
        verts.extend([(x,-width,base),(x,-width,top-.18),(x,-width*.67,top),
                      (x,width*.67,top),(x,width,top-.18),(x,width,base)])
    faces, labels = [tuple(reversed(range(6)))], [PANEL]
    for j in range(len(canopy)-1):
        for i in range(6):
            faces.append((j*6+i,j*6+(i+1)%6,(j+1)*6+(i+1)%6,(j+1)*6+i))
            glass = GLASS if i in (0,4) and j in (1,3) else WINDSCREEN
            solid = i == 5 or (i == 2 and j in (1,3))
            labels.append(PANEL if j == 0 else PLAIN if solid else glass)
    faces.append(tuple(range((len(canopy)-1)*6,len(canopy)*6)))
    labels.append(PLAIN)
    add('fuselage', verts, faces, labels)
    for side in (-1,1):
        y = side*.94
        engine_face_start = len(PARTS['fuselage'][2])
        loft('fuselage', [(-2.6,y,.6,.30,.27),(-2.25,y,.64,.45,.38),
             (-.45,y,.70,.47,.42),(.35,y,.68,.34,.32)], sides=6, tile=PANEL, cap=VENT)
        outer_engine_face = 5 if side == 1 else 2
        PARTS['fuselage'][2][engine_face_start + 7 + outer_engine_face] = MARKING
        loft('fuselage', [(-3.12,y,.59,.25,.21),(-2.5,y,.64,.33,.25)],
             sides=6, tile=STEEL, cap=DARK)
        prism('fuselage', [(.05,side*.6,.05),(-1.05,side*.65,.05),
              (-1.55,side*2.8,-.10),(-.60,side*2.8,-.10)], .12, tile=WING)
        # One pod and two silhouette missiles per wing; launch tubes are paint.
        rod('fuselage',(-1.55,side*1.8,-.52),(.18,side*1.8,-.52),.29,
            tile=PANEL,sides=8,cap=ROCKET)
        for row in (-1,1):
            my = side*2.50 + row*.14
            loft('fuselage',[(-2.0,my,-.42,.085,.085),(-.25,my,-.42,.085,.085),
                            (.18,my,-.42,.025,.025)],sides=4,tile=MISSILE,cap=DARK)
        wheel = (2.05,side*1.35,-1.40)
        rod('fuselage',(3.05,side*.60,-.48),wheel,.105,tile=PLAIN,sides=4)
        rod('fuselage',(1.35,side*.65,-.46),wheel,.07,tile=STEEL,sides=4)
        main_wheel(wheel)
    prism('fuselage',[(-7.40,0,.59),(-6.55,0,.62),(-7.35,0,2.35),
                     (-8.05,0,2.50)],.13,axis=1,tile=TAIL)
    prism('fuselage',[(-6.05,-1.2,.61),(-6.75,-1.2,.61),
                     (-6.75,1.2,.61),(-6.05,1.2,.61)],.09,tile=WING)
    rod('fuselage',(-6.85,0,.41),(-7.48,0,-.62),.075,tile=PLAIN,sides=4)
    rod('fuselage',(-7.15,0,.60),(-7.48,0,-.62),.055,sides=4)
    rod('fuselage',(-7.48,-.12,-.69),(-7.48,.12,-.69),.25,tile=RUBBER,sides=8)
    rod('fuselage',(0,0,.65),ROTOR_CENTRE,.15)
    rod('main_rotor',(0,0,2.06),(0,0,2.26),.34,tile=STEEL,sides=6)
    for i in range(4):
        angle = math.radians(18) + i*math.pi/2
        shape = [(.28,-.14,2.18),(ROTOR_RADIUS,-.18,2.11),
                 (ROTOR_RADIUS-.16,.15,2.11),(.28,.20,2.18)]
        outline = [(x*math.cos(angle)-y*math.sin(angle),
                    x*math.sin(angle)+y*math.cos(angle),z) for x,y,z in shape]
        prism('main_rotor',outline,.035,tile=BLADE)
    rod('fuselage',(0,0,2.26),(0,0,2.66),.095)
    # Low-sided Longbow radome, kept static above the rotor joint.
    rod('fuselage',(0,0,2.62),(0,0,2.89),.55,tile=PLAIN,sides=10)
    cx, cy, cz = TAIL_ROTOR_CENTRE
    rod('tail_rotor',(cx,cy-.1,cz),(cx,cy+.1,cz),.13,sides=4)
    for angle in (25,80,205,260):
        a = math.radians(angle)
        outline = [(cx+r*math.cos(a)-w*math.sin(a),cy,
                    cz+r*math.sin(a)+w*math.cos(a))
                   for r,w in ((.1,-.07),(1.0,-.08),(1.0,.08),(.1,.07))]
        prism('tail_rotor',outline,.025,axis=1,tile=BLADE)
    loft('fuselage',[(5.28,0,.02,.27,.27),(5.60,0,.02,.42,.42),
                    (5.90,0,.02,.28,.29)], sides=6,tile=DARK,cap=SENSOR)
    rod('chin_gun',GUN_CENTRE,(3.45,0,-1.14),.19,tile=DARK)
    rod('chin_gun',(3.30,0,-1.14),(4.7,0,-1.14),.065,tile=STEEL)


def make_mesh(name, material, parent, pivot, scale, centre):
    vertices, faces, tiles = PARTS[name]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple((Vector(v)-Vector(pivot))*scale) for v in vertices], [], faces)
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    uv = mesh.uv_layers.new(name='UVMap')
    for face, tile in zip(mesh.polygons, tiles):
        points = [mesh.vertices[mesh.loops[i].vertex_index].co for i in face.loop_indices]
        normal_axis = max(range(3), key=lambda a: abs(face.normal[a]))
        axes = [a for a in range(3) if a != normal_axis]
        lo = [min(p[a] for p in points) for a in axes]
        hi = [max(p[a] for p in points) for a in axes]
        for loop, p in zip(face.loop_indices, points):
            local = [(p[a]-lo[j])/max(hi[j]-lo[j],1e-8) for j,a in enumerate(axes)]
            uv.data[loop].uv = tuple(((tile%4 if j==0 else tile//4)*TILE_SIZE +
                UV_PADDING + local[j]*(TILE_SIZE-2*UV_PADDING))/ATLAS_SIZE for j in range(2))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    obj.location = (Vector(pivot)-centre)*scale if name == 'fuselage' else (0,0,0)
    mesh.materials.append(material)
    return obj


def empty(name, location, parent=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.parent = parent
    return obj


def main():
    args = sys.argv[sys.argv.index('--')+1:]
    out = os.path.abspath(args[0])
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    material = atlas()
    build_geometry()
    all_vertices = np.array([v for vertices,_,_ in PARTS.values() for v in vertices])
    low, high = all_vertices.min(axis=0), all_vertices.max(axis=0)
    # Fit both complete rotor sweeps, including blade thickness and chord.
    swept_low, swept_high = low[:2].copy(), high[:2].copy()
    for name, pivot, axes in [('main_rotor', ROTOR_CENTRE, (0,1)),
                              ('tail_rotor', TAIL_ROTOR_CENTRE, (0,2))]:
        points = np.array(PARTS[name][0]) - np.array(pivot)
        radius = np.sqrt((points[:,axes]**2).sum(axis=1)).max()
        for axis in axes:
            if axis < 2:
                swept_low[axis] = min(swept_low[axis], pivot[axis]-radius)
                swept_high[axis] = max(swept_high[axis], pivot[axis]+radius)
    scale = FOOTPRINT / max(swept_high-swept_low)
    centre = Vector((low+high)/2)
    root = empty('rig',(0,0,0))
    for name in PARTS:
        pivot = {'main_rotor': ROTOR_CENTRE, 'tail_rotor': TAIL_ROTOR_CENTRE,
                 'chin_gun': GUN_CENTRE}.get(name,(0,0,0))
        parent = root if name == 'fuselage' else empty(
            name+'_pivot',(Vector(pivot)-centre)*scale,root)
        make_mesh(name,material,parent,pivot,scale,centre)
    for name, point in [('muzzle',(4.7,0,-1.14)),('nose',(5.90,0,.02)),
                        ('tail_tip',(-7.8,0,.72)),('top',(0,0,2.89))]:
        parent = bpy.data.objects['chin_gun_pivot'] if name == 'muzzle' else root
        origin = Vector(GUN_CENTRE) if name == 'muzzle' else centre
        empty(name,(Vector(point)-origin)*scale,parent)
    count = sum(len(face)-2 for _,faces,_ in PARTS.values() for face in faces)
    if count > TRIANGLE_BUDGET:
        raise RuntimeError(f'{count} triangles exceeds {TRIANGLE_BUDGET}')
    bpy.context.view_layer.update()
    export_scene_glb(os.path.join(out,'apache.glb'))
    print(f'APACHE: {count} triangles, {len(PARTS)} meshes, 1 material; swept footprint {FOOTPRINT}')


if __name__ == '__main__':
    main()
