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
PROFILE_PIXELS_PER_UNIT = 30.0
PROFILE_MAST_X = 225.0
PROFILE_DATUM_Y = 110.0
ROTOR_RADIUS = 7.3
MAIN_WHEEL_RADIUS = 10 / PROFILE_PIXELS_PER_UNIT
MAIN_WHEEL_WIDTH = 0.30
MAIN_WHEEL_SIDES = 10
PARTS = {}


def profile_point(u, v, lateral=0):
    return ((PROFILE_MAST_X-u)/PROFILE_PIXELS_PER_UNIT, lateral,
            (PROFILE_DATUM_Y-v)/PROFILE_PIXELS_PER_UNIT)


ROTOR_CENTRE = profile_point(225, 22)
TAIL_ROTOR_CENTRE = profile_point(524, 43, .27)
GUN_CENTRE = profile_point(138, 117)
MUZZLE = profile_point(101, 125)
NOSE = profile_point(59, 98.5)
TAIL_TIP = profile_point(515, 120)
TOP = profile_point(225, 8)
CANOPY_U_RANGE = (100, 200)
CANOPY_V_RANGE = (45, 96)
BODY_U_RANGE = (75, 520)
BODY_V_RANGE = (75, 135)

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

        def polygon(points, colour):
            yy, xx = np.mgrid[:TILE_SIZE, :TILE_SIZE]
            inside = np.zeros((TILE_SIZE,TILE_SIZE),dtype=bool)
            for a,b in zip(points,points[1:]+points[:1]):
                if a[1] == b[1]:
                    continue
                inside ^= ((a[1] > yy) != (b[1] > yy)) & (
                    xx < (b[0]-a[0])*(yy-a[1])/(b[1]-a[1])+a[0])
            p[inside,:3] = np.array(colour)/255

        def window_polygon(points, colour):
            polygon([(UV_PADDING+(u-CANOPY_U_RANGE[0])/(CANOPY_U_RANGE[1]-CANOPY_U_RANGE[0])*(TILE_SIZE-2*UV_PADDING),
                      UV_PADDING+(CANOPY_V_RANGE[1]-v)/(CANOPY_V_RANGE[1]-CANOPY_V_RANGE[0])*(TILE_SIZE-2*UV_PADDING))
                     for u,v in points],colour)

        if tile in (PANEL, WING, TAIL, MARKING):
            frame(22, 23, 234, 230, (36, 43, 28))
            rect(25, 229, 231, 231, (101, 106, 73))
            rect(25, 140, 231, 142, (44, 50, 33))
            frame(40, 47, 103, 100, (39, 45, 30))
            rect(91, 70, 98, 75, (146, 145, 114))
            for i in range(5):
                rect(147 + i * 12, 59, 151 + i * 12, 88, (31, 39, 26))
        if tile == HULL:
            def body_rect(u0,v0,u1,v1,c):
                x0,x1 = [round(UV_PADDING+(u-BODY_U_RANGE[0])/(BODY_U_RANGE[1]-BODY_U_RANGE[0])*(TILE_SIZE-2*UV_PADDING)) for u in (u0,u1)]
                y0,y1 = [round(UV_PADDING+(BODY_V_RANGE[1]-v)/(BODY_V_RANGE[1]-BODY_V_RANGE[0])*(TILE_SIZE-2*UV_PADDING)) for v in (v1,v0)]
                frame(x0,y0,x1,y1,c,1)
            for bounds in [(86,95,102,108),(166,95,184,114),(196,94,226,117),
                           (254,98,281,124),(330,98,338,117),(370,107,449,123)]:
                body_rect(*bounds,(47,54,34))
            for u in (151,190,290,348,480):
                body_rect(u,84,u+2,129,(56,64,39))
        if tile == WINDSCREEN:
            yy, xx = np.mgrid[:TILE_SIZE, :TILE_SIZE]
            shine = np.clip((yy - xx * 0.24) / 256, 0, 1)[..., None]
            p[:, :, :3] = (np.array((17, 24, 27)) + shine * np.array((47, 56, 62))) / 255
            frame(10, 10, 246, 246, (57, 64, 44), 15)
            frame(25, 25, 231, 231, (11, 19, 20), 3)
            rect(34, 214, 220, 218, (129, 142, 140))
            r[:, :, :3] = 0.19
        if tile == GLASS:
            p[:,:,:3] = np.array(PALETTE[PLAIN])/255
            panes = [([(103,92),(108,77),(124,64),(150,53),(149,81)],
                      [(106,89),(111,77),(126,65),(147,57),(146,79)]),
                     ([(152,52),(187,49),(189,58),(180,77),(152,82)],
                      [(155,55),(184,52),(186,58),(178,74),(155,78)])]
            for outer, inner in panes:
                window_polygon(outer,(119,123,104))
                window_polygon(inner,(26,38,42))
            window_polygon([(110,80),(125,67),(145,59),(141,68),(129,71),(120,82)],(110,135,145))
            window_polygon([(157,56),(182,54),(178,61),(166,64),(156,72)],(133,151,154))
            window_polygon([(120,82),(124,74),(128,72),(131,75),(130,79),(141,77),(139,81)],(19,26,27))
            window_polygon([(160,74),(163,65),(168,62),(172,65),(170,69),(177,69),(175,74)],(20,27,28))
            r[:,:,:3] = .26
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
    bsdf = next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
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
    # Stations trace the owner's side elevation: image x, roof y, belly y, half-width.
    stations = [(80,83,111,.34),(100,78,115,.47),(110,92,116,.52),
                (194,78,121,.73),(291,80,128,.80),
                (322,80,133,.59),(346,85,133,.41),(380,88,127,.31),
                (480,98,128,.18),(515,110,128,.10)]
    vertices = []
    for u,top,bottom,width in stations:
        bevel = min(3,(bottom-top)/4)
        vertices.extend(profile_point(u,v,y) for v,y in
                        [(top,0),(top+bevel,width),(bottom-bevel,width),
                         (bottom,0),(bottom-bevel,-width),(top+bevel,-width)])
    faces = [tuple(reversed(range(6)))]
    for j in range(len(stations)-1):
        faces.extend((j*6+i,j*6+(i+1)%6,(j+1)*6+(i+1)%6,(j+1)*6+i)
                     for i in range(6))
    faces.append(tuple(range((len(stations)-1)*6,len(stations)*6)))
    add('fuselage',vertices,faces,HULL)
    # Six-sided angular tandem canopy, with painted frames on each glass face.
    canopy = [(100,78,94,.47),(116,64,91,.52),(143,52,85,.61),
              (173,48,80,.61),(199,43,77,.63),(245,46,77,.66),
              (290,56,82,.65),(321,76,84,.49)]
    verts = []
    for u,top,bottom,width in canopy:
        shoulder = float(np.interp(u,[s[0] for s in stations],[s[1] for s in stations]))+5
        bottom = max(bottom,shoulder)
        verts.extend(profile_point(u,v,y) for v,y in
                     [(bottom,-width),(top+3,-width),(top,-width*.66),
                      (top,width*.66),(top+3,width),(bottom,width)])
    faces, labels = [tuple(reversed(range(6)))], [PANEL]
    for j in range(len(canopy)-1):
        for i in range(6):
            faces.append((j*6+i,j*6+(i+1)%6,(j+1)*6+(i+1)%6,(j+1)*6+i))
            labels.append(GLASS if j < 4 and i in (0,4) else
                          WINDSCREEN if j < 3 and i != 5 else PLAIN)
    faces.append(tuple(range((len(canopy)-1)*6,len(canopy)*6)))
    labels.append(PLAIN)
    add('fuselage', verts, faces, labels)
    prism('fuselage',[profile_point(u,v) for u,v in
                     [(176,49),(180,43),(195,42),(204,46)]],1.0,axis=1,tile=PLAIN)
    for side in (-1,1):
        y = side*.93
        engine_face_start = len(PARTS['fuselage'][2])
        loft('fuselage', [(*profile_point(317,74,y),.38,.40),
                         (*profile_point(306,72,y),.46,.45),
                         (*profile_point(245,70,y),.46,.43)],sides=6,tile=PANEL,cap=VENT)
        outer_engine_face = 5 if side == 1 else 2
        PARTS['fuselage'][2][engine_face_start + 7 + outer_engine_face] = MARKING
        loft('fuselage',[(*profile_point(245,70,y),.29,.30),
                        (*profile_point(231,70,y),.25,.27)],sides=6,tile=PLAIN,cap=DARK)
        prism('fuselage',[profile_point(218,91,side*.65),profile_point(268,96,side*.65),
                         profile_point(277,107,side*2.6),profile_point(243,104,side*2.6)],.09,tile=WING)
        # One pod and two silhouette missiles per wing; launch tubes are paint.
        rod('fuselage',profile_point(257,120,side*1.8),profile_point(197,120,side*1.8),.27,
            tile=PANEL,sides=8,cap=ROCKET)
        for row in (-1,1):
            my = side*2.38 + row*.13
            loft('fuselage',[(*profile_point(266,115,my),.075,.075),
                            (*profile_point(205,115,my),.075,.075),
                            (*profile_point(194,115,my),.022,.022)],sides=4,tile=MISSILE,cap=DARK)
        wheel = profile_point(189,145,side*1.12)
        rod('fuselage',profile_point(164,118,side*.55),wheel,.085,tile=PLAIN,sides=4)
        rod('fuselage',profile_point(187,120,side*.62),wheel,.065,tile=STEEL,sides=4)
        main_wheel(wheel)
    prism('fuselage',[profile_point(u,v) for u,v in
                     [(480,102),(511,45),(531,20),(554,20),(551,43),(516,111)]],.13,axis=1,tile=TAIL)
    prism('fuselage',[profile_point(493,104,-1.2),profile_point(527,105,-1.2),
                     profile_point(527,105,1.2),profile_point(493,104,1.2)],.07,tile=WING)
    tail_wheel = profile_point(536,145)
    rod('fuselage',profile_point(510,123),tail_wheel,.065,tile=PLAIN,sides=4)
    rod('fuselage',profile_point(519,125),tail_wheel,.045,sides=4)
    rod('fuselage',profile_point(536,145,-.09),profile_point(536,145,.09),.20,tile=RUBBER,sides=8)
    rod('fuselage',profile_point(225,46),ROTOR_CENTRE,.095)
    rod('main_rotor',profile_point(225,26),profile_point(225,19),.35,tile=STEEL,sides=4)
    for i in range(4):
        angle = i*math.pi/2
        rotor_z = ROTOR_CENTRE[2]
        shape = [(.28,-.14,rotor_z),(ROTOR_RADIUS,-.18,rotor_z-.02),
                 (ROTOR_RADIUS-.16,.15,rotor_z-.02),(.28,.20,rotor_z)]
        outline = [(x*math.cos(angle)-y*math.sin(angle),
                    x*math.sin(angle)+y*math.cos(angle),z) for x,y,z in shape]
        prism('main_rotor',outline,.035,tile=BLADE)
    rod('fuselage',profile_point(225,22),profile_point(225,8),.10,tile=STEEL,sides=4)
    rod('fuselage',profile_point(225,9),profile_point(225,8),.22,tile=DARK,sides=5)
    cx, cy, cz = TAIL_ROTOR_CENTRE
    rod('tail_rotor',(cx,cy-.1,cz),(cx,cy+.1,cz),.13,sides=4)
    for angle in (46,151,226,331):
        a = math.radians(angle)
        outline = [(cx+r*math.cos(a)-w*math.sin(a),cy,
                    cz+r*math.sin(a)+w*math.cos(a))
                   for r,w in ((.1,-.09),(1.55,-.12),(1.55,.12),(.1,.09))]
        prism('tail_rotor',outline,.025,axis=1,tile=BLADE)
    loft('fuselage',[(*profile_point(80,99),.29,.29),(*profile_point(68,99),.36,.36),
                    (*profile_point(62,98),.32,.32),
                    (*NOSE,.12,.12)],sides=6,tile=DARK,cap=SENSOR)
    rod('fuselage',profile_point(79,82),profile_point(70,82),.16,tile=PLAIN,sides=4,cap=DARK)
    rod('chin_gun',GUN_CENTRE,profile_point(143,132),.12,tile=DARK,sides=4)
    rod('chin_gun',profile_point(143,132),MUZZLE,.045,tile=STEEL)
    rod('chin_gun',profile_point(117,118),profile_point(143,136),.04,tile=DARK,sides=4)


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
        face.use_smooth = tile in (HULL,DARK)
        points = [mesh.vertices[mesh.loops[i].vertex_index].co for i in face.loop_indices]
        normal_axis = max(range(3), key=lambda a: abs(face.normal[a]))
        axes = [a for a in range(3) if a != normal_axis]
        lo = [min(p[a] for p in points) for a in axes]
        hi = [max(p[a] for p in points) for a in axes]
        for loop, p in zip(face.loop_indices, points):
            local = [(p[a]-lo[j])/max(hi[j]-lo[j],1e-8) for j,a in enumerate(axes)]
            if tile in (GLASS,HULL):
                model_point = p/scale + Vector(pivot)
                u = PROFILE_MAST_X-model_point.x*PROFILE_PIXELS_PER_UNIT
                v = PROFILE_DATUM_Y-model_point.z*PROFILE_PIXELS_PER_UNIT
                urange,vrange = (CANOPY_U_RANGE,CANOPY_V_RANGE) if tile == GLASS else (BODY_U_RANGE,BODY_V_RANGE)
                local = [(u-urange[0])/(urange[1]-urange[0]),(vrange[1]-v)/(vrange[1]-vrange[0])]
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


def build_asset(out):
    os.makedirs(out, exist_ok=True)
    PARTS.clear()
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
    for name, point in [('muzzle',MUZZLE),('nose',NOSE),('tail_tip',TAIL_TIP),('top',TOP)]:
        parent = bpy.data.objects['chin_gun_pivot'] if name == 'muzzle' else root
        origin = Vector(GUN_CENTRE) if name == 'muzzle' else centre
        empty(name,(Vector(point)-origin)*scale,parent)
    count = sum(len(face)-2 for _,faces,_ in PARTS.values() for face in faces)
    if count > TRIANGLE_BUDGET:
        raise RuntimeError(f'{count} triangles exceeds {TRIANGLE_BUDGET}')
    bpy.context.view_layer.update()
    root['profile_scale'] = scale
    root['profile_centre'] = list(centre)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in [root,*root.children_recursive]:
        obj.select_set(True)
    export_scene_glb(os.path.join(out,'apache.glb'), selected_only=True)
    print(f'APACHE: {count} triangles, {len(PARTS)} meshes, 1 material; swept footprint {FOOTPRINT}')
    return root


def main():
    args = sys.argv[sys.argv.index('--')+1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build_asset(os.path.abspath(args[0]))


if __name__ == '__main__':
    main()
