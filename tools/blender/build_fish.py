# build_fish.py — builds the Terrace shallow-water fish in Blender and exports it.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_fish.py -- \
#     E:\...\Terrace\plugins\wildlife\client\assets\fish.glb
#
# WHAT IT BUILDS (docs/model-assets.md is the convention this satisfies, and
# its "Wildlife species" section is the joint convention).
#
#   rig                   Empty at the origin; the whole body hangs under it.
#     body                the swept hull: nose cap to peduncle, laterally
#                         compressed, deeper below the centreline than above
#                         (a fish is not vertically symmetric), smooth-shaded.
#     dorsal / anal       midline fins, seated a bite INTO the hull.
#     gill_line           a raised rim around the operculum station.
#     lateral_line        a raised strip down each flank.
#     eye_port / eye_starboard
#     tail                Empty AT THE PEDUNCLE; the forked caudal hangs under
#                         it, so the plugin's yaw sweeps the fin from its root.
#       caudal
#     pectoral_port / pectoral_starboard
#                         Empties at the flank root, authored WITHOUT the rest
#                         dihedral: the sweep is in the fin's outline (rigid,
#                         like the war boat's oar dip) and the dihedral is
#                         animation, owned by species/fish.ts.
#       pectoral_*_blade
#   nose / tail_tip / crown / belly / flank
#                         anchor Empties; the plugin measures FISH_ENVELOPE
#                         from these and refuses an asset that disagrees.
#
# BUILT, NOT DOWNLOADED, and not traced either: unlike the war boat there is no
# reference trace to loft, so the body is a parametric sweep whose profiles are
# the ones the procedural fish shipped with (plugins/wildlife/client/species/
# fish.ts before this pass) — the same silhouette at four times the resolution,
# plus the anatomy the primitive version had no room for.
#
# EVERY DIMENSION IS A NAMED CONSTANT IN GAME SPACE: x forward, y up, z
# lateral, one unit = one cell. `bl()` is the only place the Blender frame
# (x length, y beam, z up) is spoken, so nothing below has to think about it.
#
# CHECKS IT PRINTS AND ASSERTS, because a model is a claim until it is measured:
#   * winding: every analytically wound face agrees with an outward test taken
#     from a point genuinely inside the solid.
#   * envelope: the anchor Empties equal the measured mesh extremes.
#   * attachment: NOTHING FLOATS — every part other than the body has vertices
#     strictly inside the body's closed mesh, by odd ray-crossing parity (the
#     same test as plugins/wildlife/.verify-closed.mts, in Python).

import math
import sys

import bpy

# ----------------------------------------------------------------- dimensions
# Game space (x forward, y up, z lateral), cells. These ARE plugins/wildlife/
# client/species/fish.ts's FISH_ENVELOPE; the install-time assertion there
# compares the anchors below against them and throws on a mismatch.

#: Nose tip. The hull's forward extreme and the envelope's front.
NOSE_X = 0.30
#: The peduncle: where the body stops and the tail hinge sits.
PEDUNCLE_X = -0.26
#: The hull's own rounded aft end, a hair BEHIND the peduncle so the caudal
#: fin's root is buried in solid body rather than butted against its end cap.
HULL_TAIL_X = -0.29
#: Caudal tip: the envelope's aft extreme (FISH_ENVELOPE.length = 0.72).
CAUDAL_TIP_X = -0.42
#: Dorsal tip above the origin, and anal tip below it — the envelope's crown
#: and belly. placement.ts reserves exactly this much water column, so the
#: fins are authored to FILL it rather than to rattle around inside it.
CROWN_Y = 0.17
BELLY_Y = -0.17
#: The body's widest half-width, at the shoulder. The pectorals reach further
#: than this; the envelope's halfWidth is the BODY's, which is what the swim
#: column is fitted against (placement.ts SWIM_PROFILES.fish).
FLANK_Z = 0.08

#: Hull tessellation. 29 stations of 20 segments against the procedural
#: fish's 24 x 14: the fish is the most numerous creature in the world and
#: also the smallest, so the budget is spent on the silhouette's smoothness
#: (which reads at distance) rather than on detail (which does not).
HULL_RINGS = 29
HULL_SEGMENTS = 20

#: Half-width along the body as a fraction of FLANK_Z, by station fraction u
#: (0 at the nose, 1 at the hull's aft end): a blunt snout, widest a third of
#: the way back, tapering to a narrow peduncle.
WIDTH_PROFILE = (
    (0.00, 0.18), (0.08, 0.55), (0.20, 0.88), (0.35, 1.00), (0.50, 0.95),
    (0.65, 0.76), (0.80, 0.46), (0.92, 0.26), (1.00, 0.20),
)
#: Height over width ABOVE the centreline: laterally compressed, deepest just
#: behind the head.
TOP_RATIO_PROFILE = (
    (0.00, 1.00), (0.15, 1.40), (0.35, 1.65), (0.55, 1.60), (0.75, 1.40),
    (0.90, 1.10), (1.00, 0.95),
)
#: And BELOW it, deeper than the back by roughly a tenth: the belly of a fish
#: carries the viscera and the back does not. This asymmetry is the one real
#: shape change from the procedural body, and it is what lets the anal fin
#: reach the declared belly without being taller than the dorsal.
BOTTOM_RATIO_PROFILE = (
    (0.00, 1.05), (0.15, 1.55), (0.35, 1.80), (0.55, 1.72), (0.75, 1.45),
    (0.90, 1.12), (1.00, 0.95),
)

#: Fraction of the hull's length spent rounding the nose and the aft end into
#: closed caps. Without them the sweep would end on an open ring, which is a
#: hole; with a pole and a fan it is a solid.
NOSE_CAP_FRACTION = 0.10
TAIL_CAP_FRACTION = 0.06

#: How far a fin root is sunk into the hull. The hull is a sampled sweep, so
#: its true surface between stations sits a little under the profile's value —
#: this is what closes the hairline of daylight a root laid exactly on the
#: profile would show.
FIN_SEAT_BITE = 0.012
#: Midline fins (dorsal, anal, caudal) are blades this thick.
FIN_THICKNESS = 0.012
#: Pectorals are thinner still: they are the smallest surface on the fish.
PECTORAL_THICKNESS = 0.009
#: Points sampled along each curved fin edge. Eight is where a fin's leading
#: edge stops reading as a chain of straight cuts at the play camera.
FIN_CURVE_SAMPLES = 8

#: Dorsal fin: where its root starts and ends, and where its peak sits.
DORSAL_FRONT_X = 0.10
DORSAL_PEAK_X = -0.02
DORSAL_BACK_X = -0.17
#: Anal fin, aft of the vent.
ANAL_FRONT_X = -0.04
ANAL_DEEP_X = -0.11
ANAL_BACK_X = -0.21

#: Caudal fin, authored with x = 0 AT THE HINGE (the tail Empty). Its leading
#: edge starts forward of the hinge so its root is buried in the hull.
CAUDAL_ROOT_X = 0.07
CAUDAL_NOTCH_X = -0.09
#: Half the span of the fork, top lobe to bottom lobe.
CAUDAL_HALF_SPAN = 0.13

#: Pectoral hinge station, and how far down the flank it sits.
PECTORAL_X = 0.10
PECTORAL_Y = -0.03
#: The hinge sits INBOARD of the flank surface, so the blade's root vertices
#: are inside the body whatever the dihedral the animation applies.
PECTORAL_SEAT_FRACTION = 0.78
PECTORAL_REACH = 0.10
PECTORAL_SPAN = 0.075

#: Eyes: station, lift off the centreline, radius, and how far out along the
#: local half-width they sit (under 1, so the inner half is inside the head).
EYE_X = 0.215
EYE_Y = 0.030
EYE_RADIUS = 0.017
EYE_SEAT_FRACTION = 0.88
EYE_SEGMENTS = 10
EYE_RINGS = 6

#: The operculum rim, as a station and how far it stands off the surface.
GILL_X = 0.16
#: Inner lip sunk under the surface (so its vertices are demonstrably inside
#: the body), outer lip raised above it (so the rim catches the light).
LINE_INNER_SCALE = 0.985
LINE_OUTER_SCALE = 1.005
#: The lateral line runs from behind the gill to the peduncle.
LATERAL_FRONT_X = 0.13
LATERAL_BACK_X = -0.24
LATERAL_SAMPLES = 20
#: Half the rim's / line's width along the body.
LINE_HALF_WIDTH = 0.004
#: How much of ONE hull segment's arc the strip spans either side of its
#: centre line. A fifth: at a third the lateral line still read as a bar
#: painted down the flank rather than as a line scored into it.
LINE_ARC_FRACTION = 1.0 / 5.0

#: Colours, as the sRGB hexes the species file declares. Body and fins are the
#: shipped fish's, unchanged (the owner reads a species by its colour); the
#: lines are a darker shade of the body.
#:
#: THESE ARE sRGB AND BLENDER'S BASE COLOR IS LINEAR — see srgb() below. The
#: hexes are written here in the form they appear in the TypeScript so the two
#: can be compared by eye; the conversion happens in exactly one place.
BODY_COLOR = 0xE8A13C
FIN_COLOR = 0xF3C46E
EYE_COLOR = 0x1C1A17
LINE_COLOR = 0xC07F28

#: ONE roughness and ONE metalness across every material on this model.
#: rigSkin.ts's materialSignature does NOT key on roughness (client/src/render/
#: rigSkin.ts:103-141), so parts that differ only in colour merge into a single
#: draw and the SURVIVING material is whichever the first piece carried. Two
#: roughnesses would therefore mean one of them is silently discarded at bake —
#: so there is only ever one. 0.5 is a wet, slightly glossy body.
SURFACE_ROUGHNESS = 0.5
SURFACE_METALNESS = 0.0

#: How far a numerically checked normal may disagree with the analytic winding
#: before the build fails. Zero would trip on float dust in a near-tangent face.
WINDING_TOLERANCE = 1e-12
#: How far a measured extreme may sit from its anchor. A hundredth of a cell is
#: a seventieth of this fish's length and well under a pixel at the play
#: camera, and it is far above the float32 dust a glTF round trip adds.
ANCHOR_TOLERANCE = 0.01


# ------------------------------------------------------------------ the frame

def bl(x, y, z):
    """Game space (x forward, y up, z lateral) -> Blender (x, y beam, z up).

    The glTF exporter's `export_yup` maps Blender (x, y, z) to glTF
    (x, z, -y), so Blender's +Y is glTF's -Z. Inverting that here is what
    lets every constant above be written in the frame the game speaks.
    """
    return (x, -z, y)


def profile(points):
    """A piecewise-linear profile over u in [0, 1], clamped at both ends."""
    def sample(u):
        if u <= points[0][0]:
            return points[0][1]
        if u >= points[-1][0]:
            return points[-1][1]
        for (u0, v0), (u1, v1) in zip(points, points[1:]):
            if u0 <= u <= u1:
                return v0 + (v1 - v0) * (u - u0) / (u1 - u0)
        raise AssertionError(f'u={u} fell outside the profile')
    return sample


WIDTH = profile(WIDTH_PROFILE)
TOP_RATIO = profile(TOP_RATIO_PROFILE)
BOTTOM_RATIO = profile(BOTTOM_RATIO_PROFILE)

HULL_LENGTH = NOSE_X - HULL_TAIL_X


def cap_factor(u):
    """Rounds the sweep into closed caps at both ends (a quarter ellipse)."""
    if u < NOSE_CAP_FRACTION:
        return math.sqrt(max(0.0, 1.0 - (1.0 - u / NOSE_CAP_FRACTION) ** 2))
    if u > 1.0 - TAIL_CAP_FRACTION:
        t = (u - (1.0 - TAIL_CAP_FRACTION)) / TAIL_CAP_FRACTION
        return math.sqrt(max(0.0, 1.0 - t * t))
    return 1.0


def station_x(u):
    return NOSE_X - u * HULL_LENGTH


def station_u(x):
    return (NOSE_X - x) / HULL_LENGTH


def half_width(u):
    return FLANK_Z * WIDTH(u) * cap_factor(u)


def top_y(u):
    return half_width(u) * TOP_RATIO(u)


def bottom_y(u):
    return half_width(u) * BOTTOM_RATIO(u)


def surface_point(u, theta, scale=1.0):
    """A point on (or offset from) the hull surface, in game space.

    The section is an ellipse whose centre is offset so its top lands on
    `top_y` and its bottom on `-bottom_y`: a single smooth curve rather than
    two half-ellipses meeting in a crease at the flank.
    """
    centre = (top_y(u) - bottom_y(u)) / 2.0
    half = (top_y(u) + bottom_y(u)) / 2.0
    return (
        station_x(u),
        centre + half * math.sin(theta) * scale,
        half_width(u) * math.cos(theta) * scale,
    )


# --------------------------------------------------------------- mesh helpers

def face_normal(a, b, c):
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    return (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )


def check_outward(name, verts, faces, ref):
    """Assert the analytic winding agrees with an outward test from `ref`.

    `ref` must be genuinely inside the solid. Unlike build_war_boat.py's
    flip_to_outward this NEVER rewrites a face: the winding below is derived,
    not guessed, and a disagreement is a bug in the derivation rather than
    something to paper over.
    """
    wrong = 0
    for face in faces:
        normal = face_normal(verts[face[0]], verts[face[1]], verts[face[2]])
        centroid = (
            sum(verts[i][0] for i in face) / len(face),
            sum(verts[i][1] for i in face) / len(face),
            sum(verts[i][2] for i in face) / len(face),
        )
        away = (centroid[0] - ref[0], centroid[1] - ref[1], centroid[2] - ref[2])
        dot = normal[0] * away[0] + normal[1] * away[1] + normal[2] * away[2]
        if dot < -WINDING_TOLERANCE:
            wrong += 1
    print(f'  winding {name}: {len(faces)} faces, {wrong} inward')
    assert wrong == 0, f'{name}: {wrong} faces wound inward'


def make_object(name, verts, faces, smooth):
    """A Blender mesh object from GAME-space verts (converted here, once)."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([bl(*v) for v in verts], [], [list(f) for f in faces])
    mesh.update()
    mesh.validate()
    for poly in mesh.polygons:
        poly.use_smooth = smooth
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    # BELT AND SUSPENDERS on the winding. Every mesh here is a closed manifold
    # and every face list is derived rather than guessed, but a normal pointing
    # into the solid is invisible in the build log and glaring in the game (the
    # part renders inside-out or vanishes under backface culling), so Blender's
    # own outward recalculation runs over all of them. It is a no-op on a mesh
    # that was already right — which the body's check_outward proves for the
    # one part whose winding is derived by hand rather than by extrusion.
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)
    return obj


def make_empty(name, position, size=0.02):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = 'SPHERE'
    obj.empty_display_size = size
    obj.location = bl(*position)
    bpy.context.collection.objects.link(obj)
    return obj


def parent_to(child, parent):
    """Parent WITHOUT a parent inverse: the child's location is local space."""
    child.parent = parent
    child.matrix_parent_inverse.identity()


def srgb(hex_color):
    """An sRGB hex -> the LINEAR RGBA Blender's Base Color input expects.

    WHY THIS IS NOT `hex / 255`. Every colour in this codebase is written as
    an sRGB hex, which is what three.js reads a `new MeshLambertMaterial({
    color: 0xe8a13c })` as; Blender's Base Color socket and glTF's
    baseColorFactor are both LINEAR. Feeding 0xE8/255 = 0.91 straight in
    therefore asks for a colour whose sRGB encoding is 0.96 — the fish came
    out pale cream instead of warm orange, and every downstream check
    (renders, in-game eyes-on) would have been judging the wrong colour.
    The transfer function is the sRGB standard's, not an approximation.
    """
    def channel(byte):
        c = byte / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (
        channel((hex_color >> 16) & 0xFF),
        channel((hex_color >> 8) & 0xFF),
        channel(hex_color & 0xFF),
        1.0,
    )


def flat_material(name, color):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = SURFACE_ROUGHNESS
    bsdf.inputs['Metallic'].default_value = SURFACE_METALNESS
    return mat


def quad_bezier(p0, p1, p2, samples):
    """Points ALONG a quadratic curve, p0 excluded, p2 included."""
    out = []
    for k in range(1, samples + 1):
        t = k / samples
        s = 1.0 - t
        out.append((
            s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0],
            s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1],
        ))
    return out


def extrude_outline(outline, thickness, to_game):
    """A closed outline swept into a solid blade.

    `outline` is a simple polygon in the blade's own 2D plane, wound
    counter-clockwise; `to_game` maps (a, b, offset) to game space. The caps
    are n-gons — Blender triangulates them on export, which is what lets a
    FORKED caudal be one outline rather than a hand-triangulated fan.
    """
    # CCW OR NOTHING. The cap and side windings below are DERIVED from the
    # outline's orientation, and `to_game` is required to be a right-handed
    # basis (a x b = offset), so a counter-clockwise outline puts the front
    # cap's normal along +offset and every side face's normal outward. Rather
    # than ask each caller to get the orientation right, the shoelace area
    # settles it here: this is the one place the rule can be enforced.
    area = 0.0
    for (a0, b0), (a1, b1) in zip(outline, outline[1:] + outline[:1]):
        area += a0 * b1 - a1 * b0
    if area < 0.0:
        outline = list(reversed(outline))
    half = thickness / 2.0
    count = len(outline)
    verts = [to_game(a, b, +half) for a, b in outline]
    verts += [to_game(a, b, -half) for a, b in outline]
    faces = [list(range(count)), list(reversed(range(count, 2 * count)))]
    for k in range(count):
        k2 = (k + 1) % count
        faces.append([k, k2, count + k2, count + k])
    return verts, faces


def uv_sphere(centre, radius, segments, rings):
    """A smooth-shaded sphere: poles plus `rings - 1` latitude circles."""
    verts = [(centre[0], centre[1] + radius, centre[2])]
    for i in range(1, rings):
        phi = math.pi * i / rings
        for k in range(segments):
            theta = 2 * math.pi * k / segments
            verts.append((
                centre[0] + radius * math.sin(phi) * math.cos(theta),
                centre[1] + radius * math.cos(phi),
                centre[2] + radius * math.sin(phi) * math.sin(theta),
            ))
    verts.append((centre[0], centre[1] - radius, centre[2]))
    south = len(verts) - 1
    faces = []
    for k in range(segments):
        k2 = (k + 1) % segments
        faces.append([0, 1 + k2, 1 + k])
    for i in range(rings - 2):
        base = 1 + i * segments
        for k in range(segments):
            k2 = (k + 1) % segments
            faces.append([base + k, base + k2, base + segments + k2, base + segments + k])
    base = 1 + (rings - 2) * segments
    for k in range(segments):
        k2 = (k + 1) % segments
        faces.append([south, base + k, base + k2])
    return verts, faces


# ------------------------------------------------------------------ the parts

def build_body():
    """The hull: pole, `HULL_RINGS - 2` full sections, pole."""
    verts = [(NOSE_X, 0.0, 0.0)]
    for i in range(1, HULL_RINGS - 1):
        u = i / (HULL_RINGS - 1)
        for k in range(HULL_SEGMENTS):
            verts.append(surface_point(u, 2 * math.pi * k / HULL_SEGMENTS))
    verts.append((HULL_TAIL_X, 0.0, 0.0))
    tail_pole = len(verts) - 1

    # WINDING, derived rather than guessed and then proved by check_outward:
    # theta runs +z -> +y, and successive rings run AFT (-x), so a face taken
    # (this ring k) -> (this ring k+1) -> (next ring k+1) -> (next ring k) has
    # its normal along +z at theta = 0, which is outward. The two pole fans
    # follow the same circulation.
    faces = []
    for k in range(HULL_SEGMENTS):
        k2 = (k + 1) % HULL_SEGMENTS
        faces.append([0, 1 + k2, 1 + k])
    for i in range(HULL_RINGS - 3):
        base = 1 + i * HULL_SEGMENTS
        for k in range(HULL_SEGMENTS):
            k2 = (k + 1) % HULL_SEGMENTS
            faces.append([base + k, base + k2, base + HULL_SEGMENTS + k2, base + HULL_SEGMENTS + k])
    base = 1 + (HULL_RINGS - 3) * HULL_SEGMENTS
    for k in range(HULL_SEGMENTS):
        k2 = (k + 1) % HULL_SEGMENTS
        faces.append([tail_pole, base + k, base + k2])
    return verts, faces


def midline_fin(outline):
    """A vertical blade on the centreline: outline is (x, y) in game space."""
    return extrude_outline(outline, FIN_THICKNESS, lambda x, y, off: (x, y, off))


def dorsal_outline():
    """Root along the back, peak at CROWN_Y — the envelope's crown."""
    front_root = (DORSAL_FRONT_X, top_y(station_u(DORSAL_FRONT_X)) - FIN_SEAT_BITE)
    back_root = (DORSAL_BACK_X, top_y(station_u(DORSAL_BACK_X)) - FIN_SEAT_BITE)
    peak = (DORSAL_PEAK_X, CROWN_Y)
    outline = [front_root]
    # Leading edge: a taut rise from the root to the peak.
    outline += quad_bezier(front_root, (DORSAL_PEAK_X + 0.03, front_root[1] + 0.02),
                           peak, FIN_CURVE_SAMPLES)
    # Trailing edge: a slack fall back to the body.
    outline += quad_bezier(peak, (DORSAL_PEAK_X - 0.06, CROWN_Y - 0.02),
                           back_root, FIN_CURVE_SAMPLES)
    return outline


def anal_outline():
    """Root along the belly, deepest point at BELLY_Y — the envelope's belly."""
    front_root = (ANAL_FRONT_X, -bottom_y(station_u(ANAL_FRONT_X)) + FIN_SEAT_BITE)
    back_root = (ANAL_BACK_X, -bottom_y(station_u(ANAL_BACK_X)) + FIN_SEAT_BITE)
    deep = (ANAL_DEEP_X, BELLY_Y)
    outline = [back_root]
    outline += quad_bezier(back_root, (ANAL_DEEP_X - 0.04, BELLY_Y + 0.02),
                           deep, FIN_CURVE_SAMPLES)
    outline += quad_bezier(deep, (ANAL_DEEP_X + 0.03, BELLY_Y + 0.02),
                           front_root, FIN_CURVE_SAMPLES)
    return outline


def caudal_outline():
    """The fork, in the TAIL HINGE's space: x = 0 is the peduncle."""
    tip_x = CAUDAL_TIP_X - PEDUNCLE_X
    root = (CAUDAL_ROOT_X, 0.0)
    top_tip = (tip_x, CAUDAL_HALF_SPAN)
    notch = (CAUDAL_NOTCH_X, 0.0)
    bottom_tip = (tip_x, -CAUDAL_HALF_SPAN)
    outline = [root]
    outline += quad_bezier(root, (-0.03, 0.045), top_tip, FIN_CURVE_SAMPLES)
    outline += quad_bezier(top_tip, (CAUDAL_NOTCH_X - 0.02, 0.045), notch, FIN_CURVE_SAMPLES)
    outline += quad_bezier(notch, (CAUDAL_NOTCH_X - 0.02, -0.045), bottom_tip, FIN_CURVE_SAMPLES)
    outline += quad_bezier(bottom_tip, (-0.03, -0.045), root, FIN_CURVE_SAMPLES)
    return outline[:-1]


def pectoral_outline(side):
    """A swept-back paddle in the hinge's XZ plane; `side` is its z sign.

    The sweep is IN THE OUTLINE, not in the hinge: a yawed hinge would swing
    the root out of the flank, while a swept outline keeps the root on the
    body whatever dihedral the animation rolls the hinge to.
    """
    root_front = (0.03, 0.0)
    tip = (-PECTORAL_REACH, side * PECTORAL_SPAN)
    root_back = (-0.05, 0.0)
    outline = [root_front]
    outline += quad_bezier(root_front, (-0.01, side * 0.04), tip, FIN_CURVE_SAMPLES)
    outline += quad_bezier(tip, (-0.09, side * 0.03), root_back, FIN_CURVE_SAMPLES)
    return outline


def gill_rim():
    """A closed rim around the operculum station."""
    u = station_u(GILL_X)
    front_u = station_u(GILL_X + LINE_HALF_WIDTH)
    back_u = station_u(GILL_X - LINE_HALF_WIDTH)
    verts, faces = [], []
    for k in range(HULL_SEGMENTS):
        theta = 2 * math.pi * k / HULL_SEGMENTS
        verts.append(surface_point(front_u, theta, LINE_INNER_SCALE))
        verts.append(surface_point(u, theta, LINE_OUTER_SCALE))
        verts.append(surface_point(back_u, theta, LINE_INNER_SCALE))
    for k in range(HULL_SEGMENTS):
        a = 3 * k
        b = 3 * ((k + 1) % HULL_SEGMENTS)
        # Front flank, crest, back flank: three bands around the ring.
        faces.append([a, a + 1, b + 1, b])
        faces.append([a + 1, a + 2, b + 2, b + 1])
        # The inner floor closes the solid.
        faces.append([a + 2, a, b, b + 2])
    return verts, faces


def lateral_strip(side):
    """A strip down one flank, from behind the gill to the peduncle."""
    theta = 0.0 if side > 0 else math.pi
    verts, faces = [], []
    for i in range(LATERAL_SAMPLES):
        t = i / (LATERAL_SAMPLES - 1)
        x = LATERAL_FRONT_X + (LATERAL_BACK_X - LATERAL_FRONT_X) * t
        u = station_u(x)
        # A fraction of one segment's arc either side of the flank line.
        spread = 2 * math.pi / HULL_SEGMENTS * LINE_ARC_FRACTION
        verts.append(surface_point(u, theta + spread, LINE_INNER_SCALE))
        verts.append(surface_point(u, theta, LINE_OUTER_SCALE))
        verts.append(surface_point(u, theta - spread, LINE_INNER_SCALE))
    for i in range(LATERAL_SAMPLES - 1):
        a, b = 3 * i, 3 * (i + 1)
        faces.append([a, a + 1, b + 1, b])
        faces.append([a + 1, a + 2, b + 2, b + 1])
        faces.append([a + 2, a, b, b + 2])
    # End caps, so the strip is closed.
    last = 3 * (LATERAL_SAMPLES - 1)
    faces.append([0, 1, 2])
    faces.append([last + 2, last + 1, last])
    return verts, faces


# ------------------------------------------------------------------ the check

def ray_hits(point, triangles):
    """Möller-Trumbore crossings of a fixed off-axis ray from `point`."""
    direction = (0.5774, 0.5774, 0.5774)
    hits = 0
    for a, b, c in triangles:
        e1 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        e2 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        p = (
            direction[1] * e2[2] - direction[2] * e2[1],
            direction[2] * e2[0] - direction[0] * e2[2],
            direction[0] * e2[1] - direction[1] * e2[0],
        )
        det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]
        if abs(det) < 1e-12:
            continue
        inv = 1.0 / det
        s = (point[0] - a[0], point[1] - a[1], point[2] - a[2])
        u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv
        if u < 0.0 or u > 1.0:
            continue
        q = (
            s[1] * e1[2] - s[2] * e1[1],
            s[2] * e1[0] - s[0] * e1[2],
            s[0] * e1[1] - s[1] * e1[0],
        )
        v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inv
        if v < 0.0 or u + v > 1.0:
            continue
        t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv
        if t > 1e-9:
            hits += 1
    return hits


def triangulate(verts, faces):
    """Fan-triangulate for the parity test only — the caps are convex here."""
    out = []
    for face in faces:
        for k in range(1, len(face) - 1):
            out.append((verts[face[0]], verts[face[k]], verts[face[k + 1]]))
    return out


def check_attachment(body_verts, body_faces, parts):
    """NOTHING FLOATS: every part has vertices strictly inside the body.

    Bounds overlap is not enough — two shapes can share a bounding box and
    never touch — so this is the odd-crossing parity test the owner requires
    (plugins/wildlife/.verify-closed.mts), against the body's closed mesh.
    """
    triangles = triangulate(body_verts, body_faces)
    print('  attachment (vertices strictly inside the body):')
    floating = []
    for name, verts in parts:
        inside = sum(1 for v in verts if ray_hits(v, triangles) % 2 == 1)
        state = f'{inside}/{len(verts)} inside' if inside else 'FLOATING'
        print(f'    {name:24} {state}')
        if inside == 0:
            floating.append(name)
    assert not floating, f'parts float free of the body: {floating}'


def check_envelope(all_verts, body_verts):
    """The anchors are the measured extremes, not a second set of numbers."""
    max_x = max(v[0] for v in all_verts)
    min_x = min(v[0] for v in all_verts)
    max_y = max(v[1] for v in all_verts)
    min_y = min(v[1] for v in all_verts)
    body_z = max(abs(v[2]) for v in body_verts)
    print('  envelope (measured vs declared):')
    for label, measured, declared in (
        ('nose', max_x, NOSE_X),
        ('tail_tip', min_x, CAUDAL_TIP_X),
        ('crown', max_y, CROWN_Y),
        ('belly', min_y, BELLY_Y),
        ('flank', body_z, FLANK_Z),
    ):
        print(f'    {label:9} {measured:+.4f} vs {declared:+.4f}  '
              f'(off by {abs(measured - declared):.5f})')
        assert abs(measured - declared) < ANCHOR_TOLERANCE, (
            f'{label}: measured {measured:.4f}, anchor says {declared:.4f}')
    span_z = max(abs(v[2]) for v in all_verts)
    print(f'    pectoral span reaches {span_z:.4f} at rest — the envelope\'s '
          f'halfWidth is the BODY\'s ({FLANK_Z}), by design')


# ------------------------------------------------------------------ the build

def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    out_path = args[0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    body_material = flat_material('fish_body', srgb(BODY_COLOR))
    fin_material = flat_material('fish_fin', srgb(FIN_COLOR))
    eye_material = flat_material('fish_eye', srgb(EYE_COLOR))
    line_material = flat_material('fish_line', srgb(LINE_COLOR))

    print('fish build:')

    # ---- the rig root: every part of the fish hangs under it ----
    rig = make_empty('rig', (0.0, 0.0, 0.0))

    # ---- body ----
    body_verts, body_faces = build_body()
    # (0, 0, 0) is inside the hull at every station the faces cover, and the
    # hull is star-shaped about its own axis, so this reference is valid.
    check_outward('body', body_verts, body_faces, (0.0, 0.0, 0.0))
    body = make_object('body', body_verts, body_faces, smooth=True)
    body.data.materials.append(body_material)
    parent_to(body, rig)

    # ---- midline fins ----
    dorsal_verts, dorsal_faces = midline_fin(dorsal_outline())
    dorsal = make_object('dorsal', dorsal_verts, dorsal_faces, smooth=False)
    dorsal.data.materials.append(fin_material)
    parent_to(dorsal, rig)

    anal_verts, anal_faces = midline_fin(anal_outline())
    anal = make_object('anal', anal_verts, anal_faces, smooth=False)
    anal.data.materials.append(fin_material)
    parent_to(anal, rig)

    # ---- the tail hinge, AT THE PEDUNCLE ----
    tail = make_empty('tail', (PEDUNCLE_X, 0.0, 0.0))
    parent_to(tail, rig)
    caudal_local, caudal_faces = midline_fin(caudal_outline())
    caudal = make_object('caudal', caudal_local, caudal_faces, smooth=False)
    caudal.data.materials.append(fin_material)
    parent_to(caudal, tail)
    # The blade is authored in the HINGE's own space, so its local location is
    # zero and the empty carries the peduncle offset.
    caudal.location = (0.0, 0.0, 0.0)
    caudal_world = [(x + PEDUNCLE_X, y, z) for x, y, z in caudal_local]

    # ---- pectorals: hinge Empties at the flank root, blades under them ----
    seat_z = half_width(station_u(PECTORAL_X)) * PECTORAL_SEAT_FRACTION
    pectoral_world = {}
    # Right-handed frame with +X forward and +Y up puts PORT at -Z
    # (left = up x forward = Y x X = -Z), which is the sign fish.ts drives.
    for name, side in (('pectoral_port', -1.0), ('pectoral_starboard', 1.0)):
        hinge_position = (PECTORAL_X, PECTORAL_Y, side * seat_z)
        hinge = make_empty(name, hinge_position)
        parent_to(hinge, rig)
        blade_local, blade_faces = extrude_outline(
            # (a, b, off) -> (x, y, z) with a x b = off: a right-handed basis,
            # which is what extrude_outline's derived winding assumes.
            pectoral_outline(side), PECTORAL_THICKNESS,
            lambda a, b, off: (a, -off, b))
        blade = make_object(f'{name}_blade', blade_local, blade_faces, smooth=False)
        blade.data.materials.append(fin_material)
        parent_to(blade, hinge)
        blade.location = (0.0, 0.0, 0.0)
        pectoral_world[name] = [
            (x + hinge_position[0], y + hinge_position[1], z + hinge_position[2])
            for x, y, z in blade_local
        ]

    # ---- eyes ----
    eye_u = station_u(EYE_X)
    eye_z = half_width(eye_u) * EYE_SEAT_FRACTION
    eye_world = {}
    for name, side in (('eye_port', -1.0), ('eye_starboard', 1.0)):
        verts, faces = uv_sphere((EYE_X, EYE_Y, side * eye_z), EYE_RADIUS,
                                 EYE_SEGMENTS, EYE_RINGS)
        eye = make_object(name, verts, faces, smooth=True)
        eye.data.materials.append(eye_material)
        parent_to(eye, rig)
        eye_world[name] = verts

    # ---- gill rim and lateral lines ----
    gill_verts, gill_faces = gill_rim()
    gill = make_object('gill_line', gill_verts, gill_faces, smooth=False)
    gill.data.materials.append(line_material)
    parent_to(gill, rig)

    lateral_world = {}
    for name, side in (('lateral_line_port', -1.0), ('lateral_line_starboard', 1.0)):
        verts, faces = lateral_strip(side)
        strip = make_object(name, verts, faces, smooth=False)
        strip.data.materials.append(line_material)
        parent_to(strip, rig)
        lateral_world[name] = verts

    # ---- checks, on the GAME-space vertices the parts were authored from ----
    parts = [
        ('dorsal', dorsal_verts),
        ('anal', anal_verts),
        ('caudal', caudal_world),
        ('gill_line', gill_verts),
    ]
    parts += [(name, verts) for name, verts in pectoral_world.items()]
    parts += [(name, verts) for name, verts in eye_world.items()]
    parts += [(name, verts) for name, verts in lateral_world.items()]
    check_attachment(body_verts, body_faces, parts)

    all_verts = list(body_verts)
    for _name, verts in parts:
        all_verts.extend(verts)
    check_envelope(all_verts, body_verts)

    # ---- anchors: what the plugin measures FISH_ENVELOPE from ----
    make_empty('nose', (NOSE_X, 0.0, 0.0))
    make_empty('tail_tip', (CAUDAL_TIP_X, 0.0, 0.0))
    make_empty('crown', (DORSAL_PEAK_X, CROWN_Y, 0.0))
    make_empty('belly', (ANAL_DEEP_X, BELLY_Y, 0.0))
    make_empty('flank', (station_x(0.35), 0.0, FLANK_Z))

    # Bake rotations and scales into the mesh data; keep locations, because an
    # anchor's (and a hinge's) position IS its location.
    for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.select_all(action='DESELECT')

    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
    )

    total_tris = 0
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        total_tris += tris
        print(f'  {obj.name}: {len(mesh.polygons)} polys, {tris} tris')
    print(f'fish -> {out_path}: {total_tris} tris total')


main()
