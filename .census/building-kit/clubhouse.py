"""Flipper & Shrimp's Place geometry and paint, after the owner-selected pier concept with curved character slides."""
import math
from pathlib import Path
import bpy
import numpy as np

UP = np.array([0., 0., 1.])
DECK = 1.35          # Lower lobe deck top.
UPPER = 2.5          # Back deck top, carrying the clubhouse and lighthouse.
POOL_WATER = 1.0     # Raised pool surface inside the stone basin.
FOOTPRINT = 8.6      # Construction-unit footprint shared with Ricks (0.86 world units).
SMILE_WIDTH = .010      # Painted smile half-thickness as a fraction of body length; ~6 px on the low atlas.
PLANAR_TOLERANCE = 1e-4  # Out-of-plane fraction beyond which a lofted quad is split; keeps texel density uniform.
LIGHTHOUSE = (3.75, 3.0)
LIGHTHOUSE_TOWER = 3.3  # Lantern level with the mascots' heads, as in the concept.


def build(low, g):
    box, solid = g['box'], g['solid']
    palette = g['PALETTE']
    palette.update(
        timber=(.43, .33, .23), wall=(.52, .42, .31), stone=(.62, .60, .55),
        water=(.07, .60, .66), fall=(.72, .93, .96), foam=(.93, .97, .98),
        piling=(.33, .26, .19), rope=(.74, .62, .42), clapboard=(.84, .81, .72),
        teal=(.14, .47, .53), shingle=(.20, .45, .60), brass=(.74, .57, .28),
        dolphin=(.40, .57, .78), belly=(.89, .91, .93), eyewhite=(.97, .97, .95),
        pupil=(.04, .05, .07), mouth=(.36, .07, .10), shrimp=(.95, .44, .29),
        shrimpband=(.99, .63, .46), shrimpbelly=(.99, .80, .66), slideblue=(.30, .67, .89), slidecoral=(.96, .52, .45),
        wave=(.24, .52, .80), lighthouse=(.93, .92, .88), umbrellablue=(.24, .50, .80),
        umbrellacoral=(.95, .47, .40), canvas=(.96, .95, .90), buoy=(.86, .20, .16),
        leaf=(.24, .54, .21), palmtrunk=(.52, .41, .28), amber=(1., .72, .30),
        shell=(.98, .79, .68), coral=(.96, .44, .44), flag=(.18, .43, .64),
        sign=(236/255, 221/255, 188/255))
    sides = 6 if low else 8
    body_sides = 8 if low else 10

    def frame(direction, side):
        direction = direction/np.linalg.norm(direction)
        if side is None:
            # Lateral frame: u horizontal across the path, v pointing up out of it.
            u = np.cross(direction, UP); u /= np.linalg.norm(u)
            return u, np.cross(u, direction)
        u = np.asarray(side, float) - direction*np.dot(side, direction)
        if np.linalg.norm(u) < 1e-4:
            u = np.cross(direction, [1., 0., 0.])
        u /= np.linalg.norm(u)
        return u, np.cross(direction, u)

    def loft(points, sections, side, kind_of, label, cap=True, frames=None, meta=None):
        """Sweep closed 2D sections (one per point) along a path; kind_of(offset, ring) picks each face's paint."""
        points = np.asarray(points, float)
        coords, offsets = [], []
        for i, p in enumerate(points):
            direction = points[min(i+1, len(points)-1)]-points[max(i-1, 0)]
            u, v = frames[i] if frames is not None else frame(direction, side)
            for a, b in sections[i]:
                offsets.append(a*u+b*v)
                coords.append(p+a*u+b*v)
        n = len(sections[0])
        faces, kinds = [], []
        for j in range(len(points)-1):
            for k in range(n):
                face = (j*n+k, j*n+(k+1) % n, (j+1)*n+(k+1) % n, (j+1)*n+k)
                kind = kind_of(np.mean([offsets[f] for f in face], axis=0), j)
                # Planar per-face UV projection needs planar faces; split warped quads.
                q = np.array([coords[i] for i in face])
                normal = np.cross(q[1]-q[0], q[2]-q[0])
                size = max(np.linalg.norm(q[2]-q[0]), np.linalg.norm(q[3]-q[1]))
                warped = np.linalg.norm(normal) > 0 and abs(np.dot(q[3]-q[0], normal/np.linalg.norm(normal))) > PLANAR_TOLERANCE*size
                for part in ((face[0], face[1], face[2]), (face[0], face[2], face[3])) if warped else (face,):
                    faces.append(part)
                    kinds.append(kind)
        if cap:
            faces += [tuple(reversed(range(n))), tuple(range((len(points)-1)*n, len(points)*n))]
            kinds += [kind_of(np.zeros(3), 0), kind_of(np.zeros(3), len(points)-2)]
        # One connected solid with per-face paint, so winding recalculation sees a closed shell.
        offset = len(g['vertices'])
        g['vertices'].extend([tuple(p) for p in coords])
        start = len(g['polygons'])
        for face, kind in zip(faces, kinds):
            g['polygons'].append(tuple(offset+i for i in face))
            g['tags'].append(dict(kind=kind, grain=np.array((0., 0., 1.)), smooth=len(face) <= 4, **(meta or {})))
        g['parts'].append(dict(name=label, first_face=start, face_count=len(faces)))

    def ellipse(w, h, count=None):
        count = count or body_sides
        return [(w*math.cos(t), h*math.sin(t)) for t in np.linspace(0, math.tau, count, endpoint=False)]

    def plain(kind):
        return lambda offset, ring: kind

    def tube(points, radius, kind, label, count=None, side=(0, -1, 0)):
        radii = np.broadcast_to(np.asarray(radius, float), (len(points),))
        loft(points, [ellipse(r, r, count or sides) for r in radii], side, plain(kind), label)

    def cylinder(x, y, z, radius, height, kind, top=None, count=None, label='Cylinder', phase=None, grounded=False):
        count = count or sides
        upper = radius if top is None else top
        phase = math.pi/count if phase is None else phase
        ring = lambda r, zz: [(x+r*math.cos(i*math.tau/count+phase), y+r*math.sin(i*math.tau/count+phase), zz) for i in range(count)]
        a, b = ring(radius, z), ring(upper, z+height)
        # A grounded solid rests on another surface, so its underside is never seen and gets no texels.
        faces = ([] if grounded else [tuple(reversed(range(count)))])+[tuple(range(count, 2*count))]
        faces += [(i, (i+1) % count, (i+1) % count+count, i+count) for i in range(count)]
        solid(a+b, faces, kind, label=label)

    def disc(center, normal, radius, depth, kind, label, count=None):
        """Thin cylinder facing along `normal`, for eyes, portholes and mouths."""
        count = count or sides
        normal = np.asarray(normal, float)/np.linalg.norm(normal)
        u, v = frame(normal, UP if abs(normal[2]) < .9 else [1., 0., 0.])
        c = np.asarray(center, float)
        ring = [(math.cos(i*math.tau/count)*u+math.sin(i*math.tau/count)*v)*radius for i in range(count)]
        coords = [c+r for r in ring]+[c+r+normal*depth for r in ring]
        faces = [tuple(reversed(range(count))), tuple(range(count, 2*count))]
        faces += [(i, (i+1) % count, (i+1) % count+count, i+count) for i in range(count)]
        solid(coords, faces, kind, label=label)

    def plate(outline, origin, u, v, depth, kind, label, **meta):
        """Extrude a 2D outline drawn on plane (origin, u, v) by `depth` along u x v."""
        u, v = np.asarray(u, float), np.asarray(v, float)
        normal = np.cross(u, v)
        origin = np.asarray(origin, float)
        front = [origin+a*u+b*v for a, b in outline]
        coords = front+[p+normal*depth for p in front]
        n = len(outline)
        faces = [tuple(reversed(range(n))), tuple(range(n, 2*n))]
        faces += [(i, (i+1) % n, (i+1) % n+n, i+n) for i in range(n)]
        solid(coords, faces, kind, label=label, **meta)

    def polygon_slab(center, radius_x, radius_y, count, z, height, kind, label, phase=0., grounded=False):
        cx, cy = center
        ring = [(cx+radius_x*math.cos(phase+i*math.tau/count), cy+radius_y*math.sin(phase+i*math.tau/count)) for i in range(count)]
        coords = [(x, y, z) for x, y in ring]+[(x, y, z+height) for x, y in ring]
        faces = ([] if grounded else [tuple(reversed(range(count)))])+[tuple(range(count, 2*count))]
        faces += [(i, (i+1) % count, (i+1) % count+count, i+count) for i in range(count)]
        solid(coords, faces, kind, label=label)
        return ring

    def ring_wall(center, rx, ry, thickness, count, z, height, kind, label, skip=()):
        cx, cy = center
        at = lambda i, r: (cx+(rx-r)*math.cos(i*math.tau/count), cy+(ry-r)*math.sin(i*math.tau/count))
        for i in range(count):
            if i in skip:
                continue
            j = i+1
            quad = [at(i, 0), at(j, 0), at(j, thickness), at(i, thickness)]
            coords = [(x, y, z) for x, y in quad]+[(x, y, z+height) for x, y in quad]
            solid(coords, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], kind, label=label)

    def smooth_path(controls, count):
        """Uniform Catmull-Rom through the control points."""
        c = np.asarray(controls, float)
        c = np.vstack((2*c[0]-c[1], c, 2*c[-1]-c[-2]))
        out = []
        for t in np.linspace(0, len(controls)-1, count):
            i = min(int(t), len(controls)-2)
            f = t-i
            p0, p1, p2, p3 = c[i], c[i+1], c[i+2], c[i+3]
            out.append(.5*((2*p1)+(-p0+p2)*f+(2*p0-5*p1+4*p2-p3)*f*f+(-p0+3*p1-3*p2+p3)*f**3))
        return np.array(out)

    def post(x, y, z0, z1, width=.16, kind='timber', label='Rail post'):
        box((x, y, (z0+z1)/2), (width, width, z1-z0), kind, label=label)

    def rope(a, b, sag=.10, label='Rope rail'):
        a, b = np.asarray(a, float), np.asarray(b, float)
        if low:
            g['beam'](a, b, .09, .09, kind='rope', bevel=False, label=label)
            return
        mid = (a+b)/2-UP*sag
        tube(smooth_path([a, mid, b], 4 if low else 5), .045, 'rope', label, count=4)

    def railing(points, z0, height, lantern_every=0, buoys=False):
        for i, (x, y) in enumerate(points):
            post(x, y, z0, z0+height+.08)
            if lantern_every and i % lantern_every == 1:
                box((x, y, z0+height+.24), (.16, .16, .22), 'amber', label='Emissive post lantern')
                box((x, y, z0+height+.38), (.22, .22, .06), 'teal', label='Lantern cap')
            if buoys and not low and i % 3 == 2:
                cylinder(x, y-.14, z0+height-.52, .09, .30, 'buoy', count=6, label='Hanging buoy')
        for (xa, ya), (xb, yb) in zip(points, points[1:]):
            rope((xa, ya, z0+height-.02), (xb, yb, z0+height-.02))
            if not low:
                rope((xa, ya, z0+height*.52), (xb, yb, z0+height*.52), .06)

    def stilt(x, y, top, radius=.17):
        cylinder(x, y, 0, radius, top, 'piling', count=5 if low else 6, label='Pier piling', grounded=True)
        if not low:
            cylinder(x, y, top*.55, radius+.03, .10, 'rope', count=6, label='Piling rope wrap')

    # ---- Lagoon, pier decks and stilts -------------------------------------
    # Rounded-square lagoon covering every piling, with a wobbling shoreline.
    ring = []
    for i in range(14):
        a = i*math.tau/14+.12
        c, sn = math.cos(a), math.sin(a)
        r = 5.2/max(abs(c), abs(sn))**.9*(1+.03*math.sin(i*2.3))
        ring.append((r*c, r*sn))
    solid([(x, y, 0) for x, y in ring]+[(x, y, .07) for x, y in ring],
          [tuple(range(14, 28))]+[(i, (i+1) % 14, (i+1) % 14+14, i+14) for i in range(14)],
          'water', label='Shallow lagoon')
    for x, y, s in ((-1.6, -4.4, .55), (1.7, -4.2, .45), (-4.2, -2.9, .5), (3.9, -3.3, .6), (-2.6, -4.0, .35)):
        cylinder(x, y, 0, s, s*.75, 'stone', top=s*.65, count=6, label='Lagoon boulder', grounded=True)

    lobes = []
    for side in (-1, 1):
        center = (side*3.35, -1.35)
        rim = polygon_slab(center, 1.65, 1.75, 10, DECK-.22, .22, 'wall', 'Round pier lounge deck')
        lobes.append((side, center, rim))
        for i, (x, y) in enumerate(rim):
            if (x-center[0])*side > -.4 or y < center[1]-.6:
                stilt(x*.96+center[0]*.04, y*.96+center[1]*.04, DECK-.22)
        outer = [p for p in rim if (p[0]-center[0])*side > -.9 or p[1] < center[1]-1.2]
        outer.sort(key=lambda p: math.atan2(p[1]-center[1], (p[0]-center[0])*side))
        railing([(x*.95+center[0]*.05, y*.95+center[1]*.05) for x, y in outer], DECK, .62, lantern_every=3, buoys=True)
    box((0, 2.9, UPPER-.13), (9.8, 4.0, .26), 'wall', label='Upper pier deck')
    for x in (-4.7, -2.9, -1.1, 1.1, 2.9, 4.7):
        stilt(x, 1.05, UPPER-.26)
        stilt(x, 4.7, UPPER-.26)
    rail_left = [(-4.8, 1.0), (-4.0, 1.0), (-3.2, 1.0), (-2.5, 1.0)]
    railing(rail_left, UPPER, .62)
    railing([(-x, y) for x, y in reversed(rail_left)], UPPER, .62)
    for side in (-1, 1):
        railing([(side*4.85, 1.2), (side*4.85, 2.5), (side*4.85, 3.9)], UPPER, .62)
        # Bracing steps from each lounge deck up to the back deck.
        for k in range(4):
            box((side*4.2, .55+k*.18, DECK+(UPPER-DECK)*(k+.5)/4-.06), (1.0, .34, .12), 'timber', label='Deck-to-deck stair tread')

    # ---- Raised stone pool, stepping stones and front dock ---------------
    pool_center = (0, -1.25)
    ring_wall(pool_center, 2.1, 2.2, .40, 12, 0, 1.18, 'stone', 'Stone pool basin wall')
    polygon_slab(pool_center, 1.75, 1.85, 12, .07, POOL_WATER-.07, 'water', 'Turquoise pool water', grounded=True)
    for x, y in ((-.8, -2.5), (0, -2.75), (.8, -2.5)):
        cylinder(x, y, POOL_WATER-.12, .30, .20, 'stone', top=.26, count=6, label='Pool stepping stone')
    box((0, -4.25, .45), (2.1, 1.5, .18), 'wall', label='Front boardwalk dock')
    for x in (-.95, .95):
        for y in (-4.9, -3.6):
            stilt(x, y, .36, .14)
    for k in range(4):
        box((0, -3.52+k*.1, .56+k*.16), (1.5, .34, .16), 'timber', label='Dock stair up to pool rim')
    post(-.8, -4.95, .54, 1.25, .2, label='Dock mooring post')
    post(.8, -4.95, .54, 1.25, .2, label='Dock mooring post')
    box((.8, -4.95, 1.38), (.18, .18, .18), 'amber', label='Emissive dock lantern')

    # ---- Waterfall from the upper deck into the pool --------------------
    for k, (w, z0, z1) in enumerate(((2.5, 0, 1.55), (1.7, 1.55, 2.25))):
        box((0, .72+k*.18, (z0+z1)/2), (w, .75, z1-z0), 'stone', label='Stacked stone waterfall tier')
    box((0, .30, 1.35), (1.05, .10, .72), 'fall', label='Lower cascade sheet')
    box((0, .52, 2.05), (.80, .10, .55), 'fall', label='Upper cascade sheet')
    for x in (-.95, .95):
        cylinder(x, .05, POOL_WATER, .10, .75, 'foam', top=.03, count=6, label='Bubbling jet')
    disc((0, .25, POOL_WATER+.005), UP, .55, .03, 'foam', 'Cascade splash ring')

    # ---- Clubhouse on the upper deck -----------------------------------
    hx, hy, corner, cy = 2.45, 1.45, .75, 3.15
    octagon = [(-hx+corner, -hy), (hx-corner, -hy), (hx, -hy+corner), (hx, hy-corner),
               (hx-corner, hy), (-hx+corner, hy), (-hx, hy-corner), (-hx, -hy+corner)]
    top = UPPER+2.05
    coords = [(x, cy+y, UPPER) for x, y in octagon]+[(x, cy+y, top) for x, y in octagon]
    solid(coords, [tuple(range(8, 16))]+[(i, (i+1) % 8, (i+1) % 8+8, i+8) for i in range(8)],
          'clapboard', label='Weathered clapboard clubhouse')
    widened = [(x*1.06, y*1.08) for x, y in octagon]
    coords = [(x, cy+y, top) for x, y in widened]+[(x, cy+y, top+.22) for x, y in widened]
    solid(coords, [tuple(reversed(range(8))), tuple(range(8, 16))]+[(i, (i+1) % 8, (i+1) % 8+8, i+8) for i in range(8)],
          'teal', label='Teal roof cornice')
    front = cy-hy
    arch = [(-.55, 0), (.55, 0), (.55, 1.05)]+[(.55*math.cos(t), 1.05+.45*math.sin(t)) for t in np.linspace(0, math.pi, 5 if low else 7)[1:-1]]+[(-.55, 1.05)]
    plate(arch, (0, front-.02, UPPER), (1, 0, 0), (0, 0, 1), .08, 'teal', 'Arched teal double door')
    plate([(x*1.18, z*1.08) for x, z in arch], (0, front+.01, UPPER), (1, 0, 0), (0, 0, 1), .04, 'timber', 'Door surround')
    box((0, front-.14, UPPER+1.02), (.06, .03, 1.0), 'timber', label='Door leaf split')
    for x in (-.18, .18):
        disc((x, front-.11, UPPER+.72), (0, -1, 0), .05, .04, 'brass', 'Door knob', count=6)
    plate([(-.95, 0), (.95, 0), (.75, .55), (-.75, .55)], (0, front-.08, UPPER+1.62), (1, 0, 0), (0, -.45, .9), .08, 'shingle', 'Door canopy')
    disc((0, front-.08, UPPER+1.95), (0, -1, 0), .09, .05, 'amber', 'Emissive door lantern', count=6)
    for x in (-1.45, 1.45):
        disc((x, front-.04, UPPER+1.45), (0, -1, 0), .46, .10, 'brass', 'Brass porthole rim')
        disc((x, front-.10, UPPER+1.45), (0, -1, 0), .34, .04, 'amber', 'Emissive porthole glass')
    for x in (-.85, .85):
        cylinder_center = (x, front-.10, UPPER+.55)
        if low:
            disc(cylinder_center, (0, -1, 0), .33, .06, 'buoy', 'Life ring', count=6)
            continue
        loft(smooth_path([np.array(cylinder_center)+.28*np.array([math.cos(t), 0, math.sin(t)]) for t in np.linspace(0, math.tau, 9)], 9),
             [ellipse(.07, .07, 4)]*9, (0, -1, 0),
             lambda offset, ring: 'buoy' if ring % 2 == 0 else 'canvas', 'Life ring', cap=True)
    for side in (-1, 1):
        disc((side*(hx+.02), cy, UPPER+1.2), (side, 0, 0), .40, .08, 'brass', 'Side porthole rim')
        disc((side*(hx+.08), cy, UPPER+1.2), (side, 0, 0), .30, .03, 'amber', 'Emissive side porthole')

    # ---- Main sign, waves, shell crest and the two mascots --------------
    sign_front = front-.05
    sign_z0, sign_z1 = top+.35, top+2.15
    box((0, sign_front+.10, (sign_z0+sign_z1)/2), (4.2, .16, sign_z1-sign_z0+.24), 'timber', label='Main sign frame')
    box((0, sign_front, (sign_z0+sign_z1)/2), (3.9, .08, sign_z1-sign_z0), 'sign', label='FLIPPER & SHRIMP\'S PLACE sign',
        paint='main', paint_bounds=(-1.95, 1.95, sign_z0, sign_z1))
    for x in (-1.5, 1.5):
        post(x, sign_front+.35, top, sign_z0+.2, .22, label='Sign post')
    shell_base = np.array([0, sign_front+.05, sign_z1+.05])
    ribs = 5 if low else 7
    for k in range(ribs):
        a0 = math.pi*(.08+.84*k/ribs); a1 = math.pi*(.08+.84*(k+1)/ribs)
        outline = [(0, 0), (.95*math.cos(a0), .85*math.sin(a0)), (.95*math.cos(a1), .85*math.sin(a1))]
        plate(outline, shell_base+[0, -.02*(k % 2), 0], (1, 0, 0), (0, 0, 1), .16, 'shell' if k % 2 else 'shrimpband', 'Scallop crest rib')

    wave_body = [(-.75, 0), (.55, 0), (.40, .30), (.30, .70), (.38, 1.00), (.55, 1.12), (.70, 1.05), (.62, 1.30),
                 (.40, 1.42), (.10, 1.38), (-.20, 1.15), (-.45, .70)]
    wave_foam = [(-.20, 1.15), (.10, 1.38), (.40, 1.42), (.62, 1.30), (.70, 1.05), (.60, 1.14), (.40, 1.27), (.12, 1.25), (-.10, 1.06)]

    def wave(origin, facing, scale, label, along=(1, 0, 0), depth=.30):
        """Curling cartoon wave: a thick blue silhouette with a white foam crest on its front face."""
        along = np.asarray(along, float)
        front = np.cross(along, UP)
        origin = np.asarray(origin, float)
        plate([(x*facing*scale, z*scale) for x, z in wave_body], origin, along, UP, depth, 'wave', label)
        plate([(x*facing*scale, z*scale) for x, z in wave_foam], origin+front*depth, along, UP, .05, 'foam', label+' foam crest')
    wave((-2.55, sign_front+.35, top), 1, 1.05, 'Curling blue wave')
    wave((2.55, sign_front+.35, top), -1, 1.05, 'Curling blue wave')

    # ---- Cartoon dolphin and shrimp, shared by the sign mascots and the slide heads ----
    def rotate(vector, axis, angle):
        axis = np.asarray(axis, float)/np.linalg.norm(axis)
        vector = np.asarray(vector, float)
        return vector*math.cos(angle)+np.cross(axis, vector)*math.sin(angle)+axis*np.dot(axis, vector)*(1-math.cos(angle))

    def body_frame(nose, forward, up, length, bend):
        """Centreline marched back from the nose; `bend` radians over the whole length curls it about the side axis."""
        forward = np.asarray(forward, float)/np.linalg.norm(forward)
        up = np.asarray(up, float)-forward*np.dot(up, forward); up /= np.linalg.norm(up)
        side = np.cross(forward, up)
        steps = 64
        points = [np.asarray(nose, float)]
        for i in range(steps):
            heading = rotate(forward, side, bend*(i+.5)/steps)
            points.append(points[-1]-heading*length/steps)
        points = np.array(points)

        def at(t):
            x = t*steps; i = min(int(x), steps-1); f = x-i
            return (points[i]*(1-f)+points[i+1]*f, rotate(forward, side, bend*t), rotate(up, side, bend*t))
        return at, side

    def cartoon_eye(center, normal, radius, look, label):
        """White eye, black pupil glancing along `look`, and a catch-light."""
        normal = np.asarray(normal, float)/np.linalg.norm(normal)
        look = np.asarray(look, float)-normal*np.dot(look, normal)
        look = look/np.linalg.norm(look) if np.linalg.norm(look) > 1e-6 else look
        center = np.asarray(center, float)
        disc(center, normal, radius, radius*.30, 'eyewhite', label+' eye', count=8)
        pupil = center+normal*radius*.30+look*radius*.28
        disc(pupil, normal, radius*.56, radius*.10, 'pupil', label+' pupil', count=8)
        glint = np.cross(normal, look) if np.linalg.norm(look) > 1e-6 else UP
        disc(pupil+normal*radius*.10+(UP-normal*np.dot(UP, normal))*radius*.22+look*radius*.08, normal, radius*.17, radius*.05,
             'eyewhite', label+' catch-light', count=6)

    def form_loft(at, side, stations, width_of, height_of, centre_of, kind_of, label, meta, count):
        """Loft elliptical sections along body_frame stations with per-ring dorsal offset."""
        centres, frames, sections = [], [], []
        for t in stations:
            p, f, u = at(t)
            centres.append(p+u*centre_of(t))
            frames.append((side, u))
            sections.append(ellipse(width_of(t), height_of(t), count))
        loft(centres, sections, None, kind_of, label, frames=frames, meta=meta)

    def dolphin_form(nose, forward, up, length, bend, t_end, label, fins=True):
        """Bottlenose cartoon dolphin: beak, melon forehead, white underside, painted smile, fins and fluke."""
        L = length
        at, side = body_frame(nose, forward, up, L, bend)
        table = np.array([  # t, half-width, half-height, dorsal offset (fractions of length)
            (0.00, .022, .022, -.045), (.03, .034, .033, -.045), (.07, .045, .042, -.043), (.11, .072, .078, -.030),
            (.15, .120, .140, .005), (.20, .150, .170, .015), (.28, .178, .198, .012), (.38, .198, .210, .008),
            (.50, .188, .192, .004), (.62, .150, .152, 0), (.74, .100, .100, 0), (.84, .060, .066, 0),
            (.92, .040, .045, 0), (1.0, .030, .035, 0)])
        ts, ws, hs, cs = table.T
        width_of = lambda t: float(np.interp(t, ts, ws))*L
        height_of = lambda t: float(np.interp(t, ts, hs))*L
        centre_of = lambda t: float(np.interp(t, ts, cs))*L
        keep = [i for i in range(len(ts)) if ts[i] <= t_end+1e-9]
        if low:
            keep = [i for i in keep if i not in (1, 6, 8, 10, 12)] or keep
        stations = [ts[i] for i in keep]
        if stations[-1] < t_end-1e-6:
            stations.append(t_end)
        head_point, head_forward, head_up = at(.08)
        meta = dict(decal='dolphin', decal_origin=head_point+head_up*centre_of(.08), decal_forward=head_forward,
                    decal_up=head_up, decal_length=L)

        def kind_of(offset, ring):
            _, _, u = at(stations[ring])
            return 'belly' if np.dot(offset, u) < -.30*height_of(stations[ring]) else 'dolphin'
        form_loft(at, side, stations, width_of, height_of, centre_of, kind_of, label+' body', meta, body_sides)

        t_eye = .185
        p, f, u = at(t_eye)
        for s in (-1, 1):
            rise = .035*L
            out = width_of(t_eye)*math.sqrt(max(0., 1-((rise-centre_of(t_eye))/height_of(t_eye))**2))
            centre = p+u*rise+side*s*out*.97
            cartoon_eye(centre, side*s*.80+f*.45+u*.25, .040*L, f+u*.3, label)
        if fins and t_end >= .5:
            p, f, u = at(.46)
            base = p+u*(centre_of(.46)+height_of(.46)*.92)-side*.0125*L
            plate([(a*L, b*L) for a, b in ((-.05, 0), (.11, 0), (.17, .14), (.12, .13), (.02, .05))], base, -f, u, .025*L, 'dolphin', label+' dorsal fin')
            p, f, u = at(.30)
            for s in (-1, 1):
                out = side*s
                base = p+u*(centre_of(.30)-height_of(.30)*.55)+out*width_of(.30)*.75
                spread = -u*.55+out*.85
                plate([(a*L, b*L) for a, b in ((-.03, 0), (.06, 0), (.14, .13), (.09, .12))], base, -f, spread/np.linalg.norm(spread), .018*L, 'dolphin', label+' flipper')
        if t_end >= 1:
            p, f, u = at(1.)
            fluke = [(-.02, 0), (.05, .035), (.10, .13), (.135, .125), (.09, .025), (.10, 0), (.09, -.025), (.135, -.125), (.10, -.13), (.05, -.035)]
            plate([(a*L, b*L) for a, b in fluke], p-u*.01*L, -f, side, .02*L, 'dolphin', label+' tail fluke')
        elif t_end >= .28:
            p, f, u = at(t_end-.02)
            base = p+u*(centre_of(t_end)+height_of(t_end)*.90)-side*.0125*L
            plate([(a*L, b*L) for a, b in ((-.02, 0), (.10, 0), (.14, .11), (.10, .10), (.02, .04))], base, -f, u, .025*L, 'dolphin', label+' dorsal fin')
        p, f, u = at(.075)
        return p+u*(centre_of(.075)-height_of(.075)*1.05)+f*.01*L

    def shrimp_form(face, forward, up, length, bend, label, walking_legs=True, waving=False, antenna_reach=1.):
        """Cartoon shrimp: carapace with rostrum, stalked eyes, long antennae, segmented abdomen, legs and tail fan."""
        L = length
        at, side = body_frame(face, forward, up, L, bend)
        ts = [0., .04, .10, .18, .26, .33]
        radius = [.10, .15, .185, .20, .195, .185]
        joint = [False]*len(ts)
        for k in range(6):
            start = .34+.10*k; big = .180-.020*k
            for dt, factor, is_joint in ((.006, 1., False), (.060, .97, False), (.097, .86, True)):
                if low and dt == .060:
                    continue
                ts.append(start+dt); radius.append(big*factor); joint.append(is_joint)
        ts.append(.965); radius.append(.050); joint.append(False)
        ts, radius = np.array(ts), np.array(radius)
        width_of = lambda t: float(np.interp(t, ts, radius))*L*.86
        height_of = lambda t: float(np.interp(t, ts, radius))*L
        centre_of = lambda t: 0.
        p0, f0, u0 = at(0.)
        meta = dict(decal='shrimp', decal_origin=p0, decal_forward=f0, decal_up=u0, decal_length=L)

        def kind_of(offset, ring):
            _, _, u = at(ts[ring])
            if np.dot(offset, u) < -.45*height_of(ts[ring]):
                return 'shrimpbelly'
            banded = joint[ring] or joint[min(ring+1, len(joint)-1)]
            return 'shrimpband' if banded and ts[ring] > .34 else 'shrimp'
        form_loft(at, side, ts, width_of, height_of, centre_of, kind_of, label+' segmented body', meta, body_sides)

        p, f, u = at(.07)
        plate([(a*L, b*L) for a, b in ((0, 0), (.22, .075), (.18, .095), (.15, .080), (.12, .090), (.09, .070), (.06, .075), (.02, .035))],
              p+u*height_of(.07)*.80-side*.01*L, f, u, .02*L, 'shrimp', label+' rostrum spike')
        for s in (-1, 1):
            base = p+u*height_of(.07)*.55+side*s*width_of(.07)*.55
            tip = base+u*.13*L+f*.05*L+side*s*.05*L
            tube(smooth_path([base, (base+tip)/2+side*s*.01*L, tip], 3), .018*L, 'shrimp', label+' eye stalk', count=5)
            cartoon_eye(tip, f*.75+side*s*.45+u*.25, .062*L, f-u*.2, label)
            start = p0+u0*.07*L+side*s*.05*L
            reach = L*antenna_reach
            antenna = smooth_path([start, start+f0*.25*reach+u0*.35*reach+side*s*.05*L, start-f0*.30*reach+u0*.80*reach+side*s*.15*L,
                                   start-f0*.95*reach+u0*.60*reach+side*s*.28*L], 5 if low else 8)
            tube(antenna, .011*L, 'shrimp', label+' long antenna', count=4)
            if not low:
                short = smooth_path([start, start+f0*.14*L+u0*.10*L+side*s*.07*L, start+f0*.20*L+u0*.03*L+side*s*.12*L], 4)
                tube(short, .009*L, 'shrimp', label+' antennule', count=4)
        mouth = p0-u0*.06*L+f0*.005*L
        claw_t = .08
        p, f, u = at(claw_t)
        for s in (-1, 1):
            shoulder = p-u*height_of(claw_t)*.55+side*s*width_of(claw_t)*.70
            if waving:
                hand = shoulder+f*.20*L+u*.05*L+side*s*.22*L
                elbow = shoulder+f*.02*L-u*.10*L+side*s*.20*L
            else:
                hand = shoulder+f*.24*L-u*.10*L+side*s*.08*L
                elbow = shoulder+f*.10*L-u*.14*L+side*s*.10*L
            tube(smooth_path([shoulder, elbow, hand], 4), .022*L, 'shrimp', label+' claw arm', count=5)
            reach = hand-elbow; reach /= np.linalg.norm(reach)
            across = np.cross(reach, side); across /= np.linalg.norm(across)
            for finger in (-1, 1):
                plate([(0, 0), (.09*L, finger*.035*L), (.11*L, finger*.015*L), (.04*L, 0)], hand-side*.01*L, reach, across, .02*L, 'shrimp', label+' pincer')
        if walking_legs:
            for k, t in enumerate((.14, .20, .26, .32) if not low else (.18, .30)):
                p, f, u = at(t)
                for s in (-1, 1):
                    hip = p-u*height_of(t)*.75+side*s*width_of(t)*.55
                    leg = smooth_path([hip, hip-u*.12*L+side*s*.08*L+f*.03*L, hip-u*.20*L+side*s*.06*L+f*.08*L], 3)
                    tube(leg, .012*L, 'shrimpbelly', label+' walking leg', count=4)
        p, f, u = at(.965)
        fan = [(0, 0), (.06, .11), (.14, .15), (.17, .08), (.19, .035), (.20, 0), (.19, -.035), (.17, -.08), (.14, -.15), (.06, -.11)]
        plate([(a*L, b*L) for a, b in fan], p-u*.01*L, -f, side, .02*L, 'shrimpband', label+' tail fan')
        return mouth

    # Sign mascots: equal size, flanking the top corners of the sign.
    dolphin_form((-1.62, sign_front-.30, top+2.95), (.50, 0, .87), (-.87, 0, .50), 2.75, 1.25, 1., 'Dolphin mascot')
    shrimp_form((2.95, sign_front-.30, top+2.40), (-.90, 0, .40), (.40, 0, .90), 2.6, 3.0, 'Shrimp mascot', waving=True, antenna_reach=.75)

    # ---- Character-head slide towers and curved flumes -------------------
    def flume(controls, kind, label):
        path = smooth_path(controls, 9 if low else 18)
        outer, inner, rim = .40, .31, .09
        arc = np.linspace(math.pi, 2*math.pi, 4 if low else 7)
        # Closed U section: outer arc left to right, then the inner arc back.
        profile = [(outer*math.cos(t), outer*math.sin(t)+rim) for t in arc]
        profile += [(inner*math.cos(t), inner*math.sin(t)+rim) for t in arc[::-1]]
        loft(path, [profile]*len(path), None, plain(kind), label)
        return path

    def slide_head(center, facing_x, kind_flume, animal, label):
        cx, cy, cz = center
        forward = np.array([facing_x*.30, -1, -.30]); forward /= np.linalg.norm(forward)
        up = UP-forward*np.dot(UP, forward)
        if animal == 'dolphin':
            mouth = dolphin_form(np.array(center)+forward*.95, forward, up, 3.4, 0., .31, label)
        else:
            mouth = shrimp_form(np.array(center)+forward*.55, forward, up, 2.7, 2.4, label, walking_legs=False, antenna_reach=.5)
        cylinder(cx, cy+.25, UPPER, .55, max(cz-UPPER-.45, .1), 'timber', top=.45, count=sides, label=label+' pedestal')
        disc(mouth-forward*.02, forward*.6-UP*.8, .30, .05, 'mouth', label+' open mouth')
        s = -facing_x
        controls = [mouth+forward*.05-UP*.05, mouth+[facing_x*.10, -.50, -.35], (s*1.20, -.65, 1.90),
                    (s*1.50, -1.35, 1.48), (s*.95, -2.05, 1.14), (s*.30, -1.80, POOL_WATER+.05)]
        path = flume(controls, kind_flume, label+' curved flume')
        support = path[len(path)//2]
        post(support[0], support[1], POOL_WATER, support[2]-.3, .16, label=label+' flume support')

    slide_head((-1.75, .75, UPPER+.75), 1, 'slideblue', 'dolphin', 'Dolphin slide')
    slide_head((1.75, .75, UPPER+.75), -1, 'slidecoral', 'shrimp', 'Shrimp slide')

    # ---- Lighthouse and shack on the back deck ---------------------------
    lx, ly = LIGHTHOUSE
    tower = UPPER+LIGHTHOUSE_TOWER
    cylinder(lx, ly, UPPER, .82, LIGHTHOUSE_TOWER, 'lighthouse', top=.60, count=sides, label='Striped lighthouse tower', grounded=True)
    cylinder(lx, ly, tower, .92, .14, 'timber', count=sides, label='Lighthouse gallery deck')
    if not low:
        for k in range(8):
            a = k*math.tau/8
            post(lx+.84*math.cos(a), ly+.84*math.sin(a), tower+.14, tower+.50, .07, label='Gallery rail post')
    cylinder(lx, ly, tower+.47, .88, .06, 'rope', count=sides, label='Gallery rope rail')
    cylinder(lx, ly, tower+.14, .50, .62, 'amber', count=sides, label='Emissive lighthouse lantern')
    cylinder(lx, ly, tower+.76, .62, .55, 'teal', top=.06, count=sides, label='Teal lighthouse dome')
    post(lx, ly, tower+1.25, tower+2.0, .05, label='Flag pole')
    plate([(0, 0), (.55, -.05), (.60, -.22), (0, -.30)], (lx+.03, ly, tower+1.97), (1, 0, 0), (0, 0, 1), .03, 'flag', 'Anchor pennant')

    sx, sy = -3.75, 3.7
    box((sx, sy, UPPER+.65), (1.7, 1.6, 1.3), 'clapboard', label='Bait shack')
    apex = (sx, sy, UPPER+2.05)
    eave = [(sx-1.0, sy-.95, UPPER+1.25), (sx+1.0, sy-.95, UPPER+1.25), (sx+1.0, sy+.95, UPPER+1.25), (sx-1.0, sy+.95, UPPER+1.25)]
    solid(eave+[apex], [(3, 2, 1, 0), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)], 'shingle', label='Shingled shack roof')
    box((sx, sy-.82, UPPER+.50), (.55, .05, .95), 'teal', label='Shack door')
    disc((sx+.55, sy-.82, UPPER+.85), (0, -1, 0), .16, .04, 'amber', 'Emissive shack lamp', count=6)

    # ---- The two small signs --------------------------------------------
    for x, key, label in ((-3.4, 'no-fishing', 'NO FISHING sign'), (3.35, 'wigglers', 'WATER WIGGLERS WELCOME sign')):
        for px in (x-.55, x+.55):
            post(px, 1.30, UPPER, UPPER+1.62, .12, label='Sign post')
        box((x, 1.24, UPPER+1.10), (1.40, .07, .99), 'sign', label=label, paint=key, paint_bounds=(x-.70, x+.70, UPPER+.605, UPPER+1.595))

    # ---- Lounges: equal dolphin and shrimp amenities --------------------
    def umbrella(x, y, kind, label):
        post(x, y, DECK, DECK+1.25, .07, label=label+' pole')
        count = 8
        rim = [(x+1.0*math.cos(k*math.tau/count), y+1.0*math.sin(k*math.tau/count), DECK+1.05) for k in range(count)]
        for k in range(count):
            a, b = np.array(rim[k]), np.array(rim[(k+1) % count])
            apex = np.array((x, y, DECK+1.45))
            solid([a, b, apex, a-UP*.05, b-UP*.05, apex-UP*.05], [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)],
                  kind if k % 2 else 'canvas', label=label+' canopy panel')

    def chair(x, y, angle, kind, label):
        forward = np.array([math.sin(angle), -math.cos(angle), 0])
        across = np.array([math.cos(angle), math.sin(angle), 0])
        base = np.array([x, y, DECK])
        plate([(-.28, 0), (.28, 0), (.28, .12), (-.28, .12)], base+forward*.35, across, UP, .75, 'timber', label+' frame')
        plate([(-.25, 0), (.25, 0), (.25, .10), (-.25, .10)], base+forward*.30+UP*.18, across, UP, .60, kind, label+' seat')
        plate([(-.25, 0), (.25, 0), (.25, .55), (-.25, .55)], base-forward*.30+UP*.25, across, UP-forward*.55, .08, kind, label+' back')

    for side, center, _ in lobes:
        kind = 'umbrellablue' if side < 0 else 'umbrellacoral'
        cx, cy = center
        umbrella(cx-side*.15, cy+.15, kind, 'Dolphin lounge umbrella' if side < 0 else 'Shrimp lounge umbrella')
        cylinder(cx-side*.15, cy+.15, DECK, .30, .48, 'timber', top=.34, count=6, label='Lounge table')
        for k, dx in enumerate((-.75, .75)):
            chair(cx-side*.15+dx, cy-.35, side*.25*(1 if k else -1), 'slideblue' if side < 0 else 'slidecoral', 'Lounge chair')
    # Dolphin lounge backed by a wave; shrimp lounge sheltered by a scallop shell.
    wave((-3.85, .10, DECK), 1, .95, 'Dolphin lounge wave backrest')
    shell_center = np.array([4.55, -1.05, DECK])
    for k in range(ribs):
        a0 = math.pi*(.05+.9*k/ribs); a1 = math.pi*(.05+.9*(k+1)/ribs)
        outline = [(0, 0), (1.25*math.cos(a0), 1.35*math.sin(a0)), (1.25*math.cos(a1), 1.35*math.sin(a1))]
        plate(outline, shell_center, (0, 1, 0), (-.25, 0, 1), .14, 'shell' if k % 2 else 'shrimpband', 'Shrimp lounge scallop canopy')
    for x, y in ((3.9, -2.55), (4.45, -2.2)):
        cylinder(x, y, DECK, .10, .55, 'coral', top=.04, count=5, label='Coral sprig')

    # ---- Palms ------------------------------------------------------------
    def palm(x, y, z, lean, label):
        trunk = smooth_path([(x, y, z), (x+lean[0]*.3, y+lean[1]*.3, z+1.1), (x+lean[0], y+lean[1], z+2.2)], 6)
        tube(trunk, np.linspace(.17, .11, len(trunk)), 'palmtrunk', label+' trunk', count=5)
        crown = trunk[-1]
        fronds = 4 if low else 7
        for k in range(fronds):
            a = k*math.tau/fronds
            out = np.array([math.cos(a), math.sin(a), 0])
            blade = smooth_path([crown, crown+out*.65+UP*.28, crown+out*1.25-UP*.25], 3 if low else 4)
            widths = np.interp(np.arange(len(blade)), [0, 1, len(blade)-1], [.45, 1., .15])
            loft(blade, [[(-.22*w, -.03), (.22*w, -.03), (.22*w, .03), (-.22*w, .03)] for w in widths], None, plain('leaf'), label+' frond')
        cylinder(crown[0], crown[1], crown[2]-.18, .16, .2, 'palmtrunk', top=.08, count=5, label=label+' coconut cluster')
    palm(-4.55, .35, DECK, (-.25, -.15), 'Dolphin-side palm')
    palm(4.6, .45, UPPER, (.2, -.2), 'Shrimp-side palm')

    # ---- Fit to the shared footprint --------------------------------------
    vertices = np.array(g['vertices'])
    fit = FOOTPRINT/max(np.ptp(vertices[:, 0]), np.ptp(vertices[:, 1]))
    g['vertices'][:] = (vertices*fit).tolist()

    paint = {}
    for key in ('main', 'no-fishing', 'wigglers'):
        image = bpy.data.images.load(str(Path(__file__).parent/'clubhouse-paint'/(key+'.png')))
        image.colorspace_settings.name = 'Non-Color'
        paint[key] = np.array(image.pixels[:], float).reshape(image.size[1], image.size[0], 4)[::-1, :, :3].copy()
        bpy.data.images.remove(image)

    def painted(pos, ch):
        key = ch['paint']; x0, x1, z0, z1 = ch['paint_bounds']
        im = paint[key]; h, w = im.shape[:2]
        uv = np.column_stack(((pos[:, 0]-x0)/(x1-x0), 1-(pos[:, 2]-z0)/(z1-z0)))
        # Integrate the painting over each atlas texel so thin strokes survive downsampling.
        spanx = (w-1)/((x1-x0)*fit*g['density']); spany = (h-1)/((z1-z0)*fit*g['density'])
        sampled = np.zeros((len(pos), 3))
        for ox in (-.375, -.125, .125, .375):
            for oy in (-.375, -.125, .125, .375):
                xx = np.clip(uv[:, 0]*(w-1)+ox*spanx, 0, w-1); yy = np.clip(uv[:, 1]*(h-1)+oy*spany, 0, h-1)
                ix = xx.astype(int); iy = yy.astype(int); jx = np.minimum(ix+1, w-1); jy = np.minimum(iy+1, h-1)
                fx = (xx-ix)[:, None]; fy = (yy-iy)[:, None]
                sampled += ((im[iy, ix]*(1-fx)+im[iy, jx]*fx)*(1-fy)+(im[jy, ix]*(1-fx)+im[jy, jx]*fx)*fy)/16
        return sampled

    def noise(a, b, frequency, seed=0.):
        a = a*frequency; b = b*frequency
        return .5+.25*np.sin(a*1.7+b*2.3+seed)*np.sin(a*3.1-b*1.3+seed*2)+.25*np.sin(a*5.3+b*4.1+seed*3)

    def surface(pos, ch):
        p = pos/fit; x, y, z = p.T; kind = ch['kind']; count = len(p)
        n = ch['n']; color = np.array(palette.get(kind, (1, 0, 1)))
        flat = np.zeros(count)
        if kind == 'sign':
            if n[1] < -.8:
                return painted(p, ch), flat, np.full(count, .9)
            return np.tile(color*.85, (count, 1)), flat, np.full(count, .9)
        if kind == 'water':
            ripple = np.sin(x*6.1+np.sin(y*3.3)*1.4)*np.sin(y*5.7-np.sin(x*2.9)*1.2)
            caustic = np.clip(np.abs(ripple), 0, 1)**6
            depth = np.clip(np.hypot(x, y)/5.4, 0, 1)
            rgb = color*(.90+.18*depth)[:, None]+caustic[:, None]*.20
            return np.clip(rgb, 0, 1), .0015*ripple, np.full(count, .12)
        if kind == 'fall':
            streak = .5+.5*np.sin(x*23+np.sin(z*5)*2)
            return np.clip(color*(.92+.10*streak)[:, None], 0, 1), .001*streak, np.full(count, .15)
        if kind == 'piling':
            wet = np.clip((.85-z)/.5, 0, 1)
            fibre = np.sin((x+y)*40+np.sin(z*6))*.05
            algae = np.array((.19, .29, .17))
            rgb = color*(1+fibre)[:, None]*(1-wet[:, None])+algae*wet[:, None]
            return np.clip(rgb, 0, 1), .002*fibre, np.full(count, .9)
        if kind == 'clapboard':
            board = z/.26; joint = np.exp(-(np.minimum(board % 1, 1-board % 1)/.07)**2)
            weather = noise(x+y, z, 1.8, 3)
            rgb = color*(1-.20*joint+.10*(weather-.5)-.05*np.sin(np.floor(board)*7.3))[:, None]
            return np.clip(rgb, 0, 1), -.004*joint, np.full(count, .9)
        if kind == 'shingle':
            row = (z if abs(n[2]) < .95 else y)/.22; tile = (x+y)/.30+(np.floor(row) % 2)*.5
            seam = np.maximum(np.exp(-(np.minimum(row % 1, 1-row % 1)/.08)**2), np.exp(-(np.minimum(tile % 1, 1-tile % 1)/.05)**2))
            rgb = color*(1-.25*seam+.06*np.sin(np.floor(tile)*5.1+np.floor(row)*3.3))[:, None]
            return np.clip(rgb, 0, 1), -.004*seam, np.full(count, .8)
        if kind == 'rope':
            twist = .5+.5*np.sin((x+y+z)*55)
            return np.clip(color*(.85+.2*twist)[:, None], 0, 1), .0015*twist, np.full(count, .95)
        if kind == 'lighthouse':
            swell = .12*np.sin(np.arctan2(y-LIGHTHOUSE[1], x-LIGHTHOUSE[0])*3)
            band = ((z > UPPER+.80+swell) & (z < UPPER+1.45+swell)) | ((z > UPPER+2.15+swell) & (z < UPPER+2.60+swell))
            rgb = np.where(band[:, None], np.array(palette['wave']), color)
            return rgb, flat, np.full(count, .7)
        if kind in ('buoy',):
            stripe = (np.floor(z/.10) % 2 == 0)
            return np.where(stripe[:, None], color, np.array(palette['canvas'])), flat, np.full(count, .5)
        if kind in ('dolphin', 'belly', 'shrimp', 'shrimpband', 'shrimpbelly'):
            rgb = np.tile(color, (count, 1))*(1+.03*np.sin(x*9+y*7+z*11))[:, None]
            if ch.get('decal'):
                # Painted smile in the head's own frame (lengths as fractions of the body length).
                rel = p-np.asarray(ch['decal_origin']); length = ch['decal_length']
                f, u = np.asarray(ch['decal_forward']), np.asarray(ch['decal_up'])
                a, b, across = rel@f/length, rel@u/length, rel@np.cross(f, u)/length
                if ch['decal'] == 'dolphin':
                    behind_tip = .08-a
                    line = -.005+.05*np.clip(behind_tip/.16, 0, 1)**2.2
                    smile = (behind_tip > .004) & (behind_tip < .165) & (np.abs(b-line) < SMILE_WIDTH)
                else:
                    line = -.035+2.5*across**2
                    smile = (a > -.04) & (np.abs(across) < .06) & (np.abs(b-line) < SMILE_WIDTH*1.2)
                rgb[smile] = palette['mouth']
            return np.clip(rgb, 0, 1), flat, np.full(count, .35)
        if kind in ('slideblue', 'slidecoral', 'wave', 'shell', 'teal', 'umbrellablue', 'umbrellacoral', 'canvas'):
            sheen = .04*np.sin(x*9+y*7+z*11)
            rough = .35 if kind.startswith('slide') or kind in ('dolphin', 'belly', 'shrimp', 'shrimpband') else .75
            if kind == 'shell':
                ridges = .5+.5*np.sin(np.arctan2(z-p[:, 2].min(), x)*28)
                return np.clip(color*(.88+.16*ridges)[:, None], 0, 1), .002*ridges, np.full(count, .6)
            return np.clip(color*(1+sheen)[:, None], 0, 1), flat, np.full(count, rough)
        if kind == 'leaf':
            vein = np.exp(-((x*3.1+y*2.7+z*2) % 1-.5)**2/.01)
            return np.clip(color*(1+.12*vein)[:, None], 0, 1), flat, np.full(count, .8)
        if kind in ('eyewhite', 'pupil', 'mouth', 'amber', 'brass', 'foam', 'coral', 'flag', 'palmtrunk'):
            return np.tile(color, (count, 1)), flat, np.full(count, .45 if kind in ('pupil', 'brass') else .8)
        return None

    def emission(pos, ch, color):
        return color if ch['kind'] == 'amber' else np.zeros_like(color)

    g['custom_surface'] = surface
    g['emissive_surface'] = emission
    g['EMISSION_STRENGTH'] = 2.0
    g['TEXTURE_PROVENANCE'] = ('Original procedural paint: weathered planks and clapboard, pilings with algae line, stone, '
                               'lagoon water with caustics, glossy character and slide colours, emissive lanterns and portholes. '
                               'Sign lettering typeset with Arial Rounded MT Bold by prepare_clubhouse_paint.ps1. No concept pixels used.')
    placement = {'front_gltf': '+Z', 'origin': 'Footprint centred in X and Z; construction origin at ground Y=0',
                 'deliberate_difference': ('Pier, lighthouse, shack, clubhouse, sign with equal dolphin and shrimp mascots, two character-head '
                                           'curved slides, cascade, lounges and both small signs retained. Rear extrapolated. Small props '
                                           '(barrels, plant pots, seagull, extra lanterns, ropes on every post) omitted for the game budget. '
                                           'Low simplifies sections, drops buoys, gallery posts and piling wraps; envelope identical.')}
    return "Original Flipper & Shrimp's Place geometry authored after the owner-selected pier concept with curved character slides; no third-party mesh.", placement
