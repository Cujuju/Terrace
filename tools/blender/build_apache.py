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
MAIN_WHEEL_WIDTH = 0.25
MAIN_WHEEL_SIDES = 10
PARTS = {}


def profile_point(u, v, lateral=0):
    return ((PROFILE_MAST_X-u)/PROFILE_PIXELS_PER_UNIT, lateral,
            (PROFILE_DATUM_Y-v)/PROFILE_PIXELS_PER_UNIT)


ROTOR_CENTRE = profile_point(225, 22)
TAIL_ROTOR_CENTRE = profile_point(524, 43, .36)
GUN_CENTRE = profile_point(143, 117)
MUZZLE = profile_point(101, 125)
NOSE = profile_point(59, 98.5)
TAIL_TIP = profile_point(515, 120)
TOP = profile_point(225, 8)
CANOPY_U_RANGE = (100, 200)
CANOPY_V_RANGE = (45, 96)
BODY_U_RANGE = (75, 520)
BODY_V_RANGE = (75, 135)
ENGINE_U_RANGE = (225, 325)
ENGINE_V_RANGE = (54, 89)

# Each tile is reused across matching surfaces; detail never adds geometry.
PALETTE = [
    (83, 86, 64), (89, 92, 70), (51, 57, 45), (29, 44, 48),
    (31, 52, 60), (39, 43, 36), (30, 33, 31), (96, 104, 65),
    (78, 82, 62), (27, 29, 28), (100, 105, 101), (48, 54, 37),
    (49, 57, 39), (54, 73, 79), (83, 86, 64), (76, 80, 59),
]
HULL, PANEL, VENT, GLASS, WINDSCREEN, BLADE, RUBBER, WING = range(8)
TAIL, DARK, STEEL, ROCKET, MISSILE, SENSOR, MARKING, PLAIN = range(8, 16)
PNVS = PANEL  # Dedicated upper sensor face; nacelles use the continuous MARKING tile.


def atlas():
    rng = np.random.default_rng(64)
    pixels = np.zeros((ATLAS_SIZE, ATLAS_SIZE, 4), dtype=np.float32)
    rough = np.ones_like(pixels)
    normals = np.ones_like(pixels)
    yy, xx = np.mgrid[:TILE_SIZE, :TILE_SIZE]
    for tile, colour in enumerate(PALETTE):
        tx, ty = (tile % 4) * TILE_SIZE, (tile // 4) * TILE_SIZE
        p = pixels[ty:ty + TILE_SIZE, tx:tx + TILE_SIZE]
        noise = rng.normal(0, 1.1, (TILE_SIZE, TILE_SIZE, 1))
        p[:, :, :3] = np.clip((np.array(colour) + noise) / 255, 0, 1)
        p[:, :, 3] = 1
        r = rough[ty:ty + TILE_SIZE, tx:tx + TILE_SIZE]
        r[:, :, :3] = 0.78
        height = np.zeros((TILE_SIZE, TILE_SIZE), dtype=np.float32)

        def rect(x0, y0, x1, y1, c):
            p[y0:y1, x0:x1, :3] = np.array(c) / 255

        def frame(x0, y0, x1, y1, c, w=2):
            rect(x0, y0, x1, y0 + w, c)
            rect(x0, y1 - w, x1, y1, c)
            rect(x0, y0, x0 + w, y1, c)
            rect(x1 - w, y0, x1, y1, c)
            height[y0:y1,x0:x1] = .12
            height[y0+w:y1-w,x0+w:x1-w] = .35
            # A narrow lip and soft grime outside the panel seam.
            rect(x0+w,y1-w-1,x1-w,y1-w,(min(c[0]+30,130),min(c[1]+30,135),min(c[2]+25,115)))

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

        if tile in (WING, MARKING):
            frame(22, 23, 234, 230, (36, 43, 28))
            rect(25, 229, 231, 231, (101, 106, 73))
            rect(25, 140, 231, 142, (44, 50, 33))
            frame(40, 47, 103, 100, (39, 45, 30))
            rect(91, 70, 98, 75, (146, 145, 114))
            for i in range(5):
                rect(147 + i * 12, 59, 151 + i * 12, 88, (31, 39, 26))
        if tile == TAIL:
            frame(32,28,223,232,(51,58,42),1)
            rect(186,30,188,219,(57,64,47))
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
                window_polygon(outer,(77,84,67))
                window_polygon(inner,(26,38,42))
            window_polygon([(110,80),(125,67),(145,59),(141,68),(129,71),(120,82)],(110,135,145))
            window_polygon([(157,56),(182,54),(178,61),(166,64),(156,72)],(133,151,154))
            window_polygon([(120,82),(124,74),(128,72),(131,75),(130,79),(141,77),(139,81)],(19,26,27))
            window_polygon([(160,74),(163,65),(168,62),(172,65),(170,69),(177,69),(175,74)],(20,27,28))
            r[:,:,:3] = .26
        if tile == VENT:
            radius = np.sqrt((xx-128)**2+(yy-128)**2)
            p[:,:,:3] = np.array((77,83,62))/255
            circle(128,128,103,(38,44,32))
            circle(128,128,91,(12,17,15))
            circle(128,128,49,(26,31,26))
            circle(128,128,31,(57,62,48))
            for angle in np.arange(12)*math.tau/12:
                circle(128+62*math.cos(angle),128+62*math.sin(angle),4,(45,52,44))
            height[:] = .35*np.exp(-((radius-102)/7)**2)
            r[:,:,:3] = .67
        if tile == BLADE:
            rect(12, 22, 244, 28, (83, 87, 78))
            rect(219, 28, 236, 232, (80, 85, 73))
            rect(39, 28, 41, 232, (17, 21, 20))
        if tile == RUBBER:
            radius = np.sqrt((xx-128)**2+(yy-128)**2)
            tyre = 19+12*np.exp(-((radius-85)/21)**2)
            p[:,:,:3] = tyre[...,None]*np.array((1.,1.05,1.))/255
            height[:] = .8*np.exp(-((radius-80)/26)**2)
            for rad,c in [(56,(15,18,16)),(49,(90,95,77)),(42,(50,55,43)),
                          (25,(33,39,32)),(16,(106,113,93)),(7,(54,60,48))]:
                circle(128,128,rad,c)
            for angle in np.arange(6)*math.tau/6:
                circle(128+34*math.cos(angle),128+34*math.sin(angle),5,(16,21,18))
            height[radius<49] = .2
            height[radius<25] = .05
            height[radius<16] = .6
            r[:,:,:3] = .9
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
        if tile in (SENSOR,PNVS):
            p[:,:,:3] = np.array((54,60,46))/255
            r[:,:,:3] = .73
            lenses = [(169,126,61),(66,158,37),(66,81,26)] if tile == SENSOR else [(128,128,87)]
            for cx,cy,radius in lenses:
                circle(cx,cy,radius+9,(22,28,23))
                circle(cx,cy,radius+5,(89,94,78))
                circle(cx,cy,radius,(9,17,20))
                circle(cx,cy,radius*.81,(22,36,41))
                circle(cx-radius*.14,cy+radius*.16,radius*.62,(40,57,62))
                circle(cx-radius*.25,cy+radius*.35,radius*.35,(68,87,93))
                circle(cx-radius*.30,cy+radius*.43,radius*.12,(154,171,167))
                distance = np.sqrt((xx-cx)**2+(yy-cy)**2)
                height += .4*np.exp(-((distance-radius-5)/3)**2)
                r[distance<radius,:3] = .14
            for cx,cy in ((33,35),(223,35),(33,219),(223,219)):
                circle(cx,cy,3,(115,121,103))
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

        # Paint broad curvature, contact shadows and wear into the existing UVs.
        # These survive diffuse-only lighting and cost no additional triangles.
        if tile in (HULL,WING,TAIL,MARKING,PLAIN):
            shade = .70+.38*(yy/TILE_SIZE)+.07*np.sin(xx*.018+yy*.007)
            if tile == HULL:
                u = BODY_U_RANGE[0]+(xx-UV_PADDING)/(TILE_SIZE-2*UV_PADDING)*(BODY_U_RANGE[1]-BODY_U_RANGE[0])
                v = BODY_V_RANGE[1]-(yy-UV_PADDING)/(TILE_SIZE-2*UV_PADDING)*(BODY_V_RANGE[1]-BODY_V_RANGE[0])
                shade -= .28*np.exp(-((u-274)/60)**4-((v-91)/7)**2)
                shade -= .19*np.exp(-((u-225)/55)**4-((v-106)/8)**2)
                shade += .13*np.exp(-((v-101)/12)**2)
            elif tile == MARKING:
                shade += .14*np.exp(-((yy-184)/50)**2)
                shade -= .18*np.exp(-((xx-28)/13)**2)
            p[:,:,:3] *= shade[...,None]
            r[:,:,:3] = np.clip(.78+noise/120-.07*(yy/TILE_SIZE)[...,None],.55,.88)
        if tile in (GLASS,WINDSCREEN):
            p[:,:,:3] *= (.79+.31*yy/TILE_SIZE)[...,None]
            glass = (p[:,:,2]>p[:,:,0]*1.12) & (p[:,:,2]>.12)
            reflected_sky = np.exp(-((yy-xx*.28-160)/31)**2)
            glint = np.exp(-((xx*.42+yy-218)/3.5)**2)
            p[glass,:3] += (reflected_sky[...,None]*np.array((.08,.10,.12))+
                            glint[...,None]*np.array((.13,.15,.16)))[glass]
            r[glass,:3] = .21
        if tile == STEEL:
            p[:,:,:3] *= (.60+.72*np.exp(-((xx-165)/58)**2))[...,None]
            r[:,:,:3] = .31
        if tile == DARK:
            p[:,:,:3] *= (.66+.52*np.sin(math.pi*xx/TILE_SIZE)**2)[...,None]
            r[:,:,:3] = .78
        if tile == RUBBER:
            p[:,:,:3] *= (.72+.36*yy/TILE_SIZE)[...,None]
        dy,dx = np.gradient(height)
        tangent = np.stack((-dx*1.8,-dy*1.8,np.ones_like(dx)),axis=-1)
        tangent /= np.linalg.norm(tangent,axis=-1,keepdims=True)
        normals[ty:ty+TILE_SIZE,tx:tx+TILE_SIZE,:3] = tangent*.5+.5
        # Extend edge pixels through the atlas gutters to prevent mip seams.
        for array in (p,r,normals[ty:ty+TILE_SIZE,tx:tx+TILE_SIZE]):
            array[:UV_PADDING] = array[UV_PADDING]
            array[-UV_PADDING:] = array[-UV_PADDING-1]
            array[:,:UV_PADDING] = array[:,UV_PADDING:UV_PADDING+1]
            array[:,-UV_PADDING:] = array[:,-UV_PADDING-1:-UV_PADDING]

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
    img = bpy.data.images.new('apache_normal',ATLAS_SIZE,ATLAS_SIZE,alpha=True)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(normals.ravel())
    img.pack()
    tex = material.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = img
    normal = material.node_tree.nodes.new('ShaderNodeNormalMap')
    normal.space = 'TANGENT'
    normal.uv_map = 'UVMap'
    normal.inputs['Strength'].default_value = .65
    material.node_tree.links.new(tex.outputs['Color'],normal.inputs['Color'])
    material.node_tree.links.new(normal.outputs['Normal'],bsdf.inputs['Normal'])
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
    caps = (cap,cap) if isinstance(cap,int) else cap
    labels = [caps[0]]
    for j in range(len(rings) - 1):
        for i in range(sides):
            faces.append((j*sides+i, j*sides+(i+1)%sides,
                          (j+1)*sides+(i+1)%sides, (j+1)*sides+i))
            labels.append(tile)
    faces.append(tuple((len(rings)-1)*sides+i for i in range(sides)))
    labels.append(caps[1])
    visible = [(face,label) for face,label in zip(faces,labels) if label is not None]
    add(name,vertices,[item[0] for item in visible],[item[1] for item in visible])


def prism(name, outline, thickness, axis=2, tile=PLAIN, open_root=False):
    n = len(outline)
    vertices = []
    for sign in (-1, 1):
        for point in outline:
            p = list(point)
            p[axis] += sign * thickness / 2
            vertices.append(p)
    faces = [tuple(reversed(range(n))), tuple(range(n, n*2))]
    faces.extend((i, (i+1)%n, (i+1)%n+n, i+n) for i in range(n))
    if open_root:
        faces.pop()  # The final edge is buried in the rotor hub.
    add(name, vertices, faces, tile)


def rod(name, start, end, radius, tile=STEEL, sides=6, cap=None, open_ends=False):
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
    labels = [tile if cap is None else cap]*2 + [tile]*sides
    add(name, vertices, faces[2:] if open_ends else faces,
        labels[2:] if open_ends else labels)


def gear_leg(side):
    # Splayed oleo, trailing knuckle, separate drag brace, and inboard axle.
    rings = [(164,114,.55,.12),(178,135,1.17,.095),(189,145,1.38,.085)]
    vertices = []
    for j,(u,v,y,radius) in enumerate(rings):
        p = Vector(profile_point(u,v,side*y))
        start,end = rings[max(0,j-1)],rings[min(len(rings)-1,j+1)]
        direction = (Vector(profile_point(end[0],end[1],side*end[2]))-
                     Vector(profile_point(start[0],start[1],side*start[2]))).normalized()
        across = direction.cross(Vector((0,0,1))).normalized()
        normal = direction.cross(across)
        for i in range(4):
            a = (i+.5)*math.tau/4
            vertices.append(tuple(p+radius*(across*math.cos(a)+normal*math.sin(a))))
    faces = [(j*4+i,j*4+(i+1)%4,(j+1)*4+(i+1)%4,(j+1)*4+i)
             for j in range(2) for i in range(4)]
    add('fuselage',vertices,faces,[PLAIN]*4+[STEEL]*4)
    rod('fuselage',profile_point(187,114,side*.62),profile_point(178,135,side*1.17),
        .052,tile=PLAIN,sides=4,open_ends=True)
    rod('fuselage',profile_point(189,145,side*1.36),profile_point(189,145,side*1.56),
        .085,tile=STEEL,sides=4,open_ends=True)
    main_wheel(profile_point(189,145,side*1.55))


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
    faces, labels = [tuple(reversed(range(6)))], [PLAIN]
    for j in range(len(canopy)-1):
        for i in range(5):  # The lower shell is buried inside the hull.
            faces.append((j*6+i,j*6+(i+1)%6,(j+1)*6+(i+1)%6,(j+1)*6+i))
            labels.append(GLASS if j < 4 and i in (0,4) else
                          WINDSCREEN if j < 3 and i != 5 else PLAIN)
    faces.append(tuple(range((len(canopy)-1)*6,len(canopy)*6)))
    labels.append(PLAIN)
    add('fuselage', verts, faces, labels)
    prism('fuselage',[profile_point(u,v) for u,v in
                     [(176,49),(180,43),(195,42),(204,46)]],1.0,axis=1,tile=PLAIN)
    for side in (-1,1):
        y = side*1.02
        loft('fuselage', [(*profile_point(319,74,y),.38,.37),
                         (*profile_point(308,72,y),.47,.46),
                         (*profile_point(247,70,y),.47,.45),
                         (*profile_point(238,70,y),.34,.34),
                         (*profile_point(232,70,y),.28,.28)],sides=8,tile=MARKING,cap=(DARK,VENT))
        prism('fuselage',[profile_point(215,95,side*.65),profile_point(264,98,side*.65),
                         profile_point(237,109,side*2.6),profile_point(197,108,side*2.6)],.08,tile=WING)
        # One pod and two silhouette missiles per wing; launch tubes are paint.
        rod('fuselage',profile_point(257,120,side*1.8),profile_point(197,120,side*1.8),.27,
            tile=PLAIN,sides=7,cap=ROCKET)
        for row in (-1,1):
            my = side*2.38 + row*.13
            loft('fuselage',[(*profile_point(266,115,my),.075,.075),
                            (*profile_point(194,115,my),.055,.055)],sides=4,tile=MISSILE,cap=DARK)
        gear_leg(side)
    prism('fuselage',[profile_point(u,v) for u,v in [(298,128),(302,129),(302,137),(313,140),(298,140)]],
          .065,axis=1,tile=PLAIN)
    prism('fuselage',[profile_point(u,v) for u,v in
                     [(480,102),(511,45),(531,20),(554,20),(551,43),(516,111)]],.13,axis=1,tile=TAIL)
    prism('fuselage',[profile_point(515,105,-1.3),profile_point(540,108,-1.3),
                     profile_point(540,108,1.3),profile_point(515,105,1.3)],.055,tile=WING)
    tail_wheel = profile_point(536,145)
    rod('fuselage',profile_point(510,122),profile_point(530,138),.072,tile=PLAIN,sides=4,open_ends=True)
    rod('fuselage',profile_point(519,125),profile_point(530,138),.043,sides=4,open_ends=True)
    rod('fuselage',profile_point(530,138),tail_wheel,.05,tile=DARK,sides=4,open_ends=True)
    rod('fuselage',profile_point(536,145,-.09),profile_point(536,145,.09),.20,tile=RUBBER,sides=8)
    rod('fuselage',profile_point(225,46),ROTOR_CENTRE,.095,open_ends=True)
    rod('main_rotor',profile_point(225,26),profile_point(225,19),.35,tile=STEEL,sides=4)
    for i in range(4):
        angle = i*math.pi/2
        rotor_z = ROTOR_CENTRE[2]
        shape = [(.10,-.14,rotor_z),(ROTOR_RADIUS,-.18,rotor_z-.02),
                 (ROTOR_RADIUS-.16,.15,rotor_z-.02),(.10,.20,rotor_z)]
        outline = [(x*math.cos(angle)-y*math.sin(angle),
                    x*math.sin(angle)+y*math.cos(angle),z) for x,y,z in shape]
        prism('main_rotor',outline,.035,tile=BLADE,open_root=True)
    rod('fuselage',profile_point(225,22),profile_point(225,8),.10,tile=STEEL,sides=4)
    rod('fuselage',profile_point(225,9),profile_point(225,8),.22,tile=DARK,sides=4)
    cx, cy, cz = TAIL_ROTOR_CENTRE
    rod('tail_rotor',(cx,0,cz),(cx,cy+.1,cz),.13,sides=4)
    # Two opposed pairs, with the Apache's 55/125 degree scissor spacing.
    for index,angle in enumerate((36,161,216,341)):
        a = math.radians(angle)
        blade_y = cy+(.055 if index%2 else -.055)
        outline = [(cx+r*math.cos(a)-w*math.sin(a),blade_y,
                    cz+r*math.sin(a)+w*math.cos(a))
                   for r,w in ((.025,-.055),(1.55,-.12),(1.55,.12),(.025,.055))]
        prism('tail_rotor',outline,.025,axis=1,tile=BLADE,open_root=True)
    # Provisional imaging pod: owner requested a new housing/mounting reconstruction
    # from closer frontal references; the current flat optical face is not final.
    loft('fuselage',[(*profile_point(80,99),.36,.29),(*profile_point(67,99),.48,.37),
                    (*NOSE,.42,.30)],sides=8,tile=DARK,cap=(DARK,SENSOR))
    # Separate upper night-vision housing, seated on the nose deck.
    loft('fuselage',[(*profile_point(82,85,.08),.30,.20),
                    (*profile_point(69,85,.08),.27,.19)],sides=4,tile=PLAIN,cap=(PLAIN,PNVS))
    rod('chin_gun',GUN_CENTRE,profile_point(145,131),.14,tile=DARK,sides=4,open_ends=True)
    prism('chin_gun',[profile_point(u,v) for u,v in [(132,129),(149,130),(151,139),(134,137)]],
          .25,axis=1,tile=DARK)
    rod('chin_gun',profile_point(135,132),MUZZLE,.035,tile=DARK,sides=5,cap=DARK)
    for side in (-1,1):
        rod('chin_gun',profile_point(117,114,side*.16),profile_point(145,139,side*.16),
            .026,tile=DARK,sides=3,open_ends=True)


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
        face.use_smooth = tile in (HULL,DARK,MARKING)
        points = [mesh.vertices[mesh.loops[i].vertex_index].co for i in face.loop_indices]
        normal_axis = max(range(3), key=lambda a: abs(face.normal[a]))
        axes = [a for a in range(3) if a != normal_axis]
        lo = [min(p[a] for p in points) for a in axes]
        hi = [max(p[a] for p in points) for a in axes]
        for loop, p in zip(face.loop_indices, points):
            local = [(p[a]-lo[j])/max(hi[j]-lo[j],1e-8) for j,a in enumerate(axes)]
            if tile in (GLASS,HULL,MARKING):
                model_point = p/scale + Vector(pivot)
                u = PROFILE_MAST_X-model_point.x*PROFILE_PIXELS_PER_UNIT
                v = PROFILE_DATUM_Y-model_point.z*PROFILE_PIXELS_PER_UNIT
                urange,vrange = {GLASS:(CANOPY_U_RANGE,CANOPY_V_RANGE),
                                HULL:(BODY_U_RANGE,BODY_V_RANGE),
                                MARKING:(ENGINE_U_RANGE,ENGINE_V_RANGE)}[tile]
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
