# build_eel.py — builds the Terrace eel in Blender and exports it.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_eel.py -- \
#     E:\...\Terrace\plugins\wildlife\client\assets\eel.glb
#
# WHAT IT BUILDS (docs/model-assets.md is the convention this satisfies, and
# its "Wildlife species" section is the joint convention). Pass 4 of the
# fish+whales arc: build_fish.py, build_shark.py and build_ray.py are the
# pattern; the eel is the first species whose body is a CHAIN.
#
# THE EEL IS THE WAVE. Nothing on it beats — a travelling S runs nose to tail,
# and client/src/render/rigSkin.ts binds every mesh RIGIDLY to the node it
# hangs under (weight 1.0, no blending), so a bend can only be a chain of
# hinges. bakeRig composes a child node's rotation onto its parent's
# (rigSkin.ts `collect`, parent index per bone; `instantiateRig`, Bones
# parented by that index), so the tree below is exactly the tree
# species/eel.ts drives, five hinges deep:
#
#   rig                          Empty at the origin; the whole body hangs under it.
#   └─ spine0  (station 0.06)    head slice, the eyes, the mouth line, the two
#      │                         pectoral hinges
#      └─ spine1  (0.26)         slice
#         └─ spine2  (0.46)      slice
#            └─ spine3  (0.66)   slice, ridge_a (the dorsal ridge's front half,
#               │                whose crest is the envelope's CROWN)
#               └─ spine4  (0.84)   slice, ridge_b
#                  └─ tail  (PEDUNCLE_X)   Empty at the stem; the paddle hangs
#                                          under it, its tip the TAIL_TIP.
#
# Every Empty rests at the IDENTITY, positioned in its PARENT's frame, so the
# glTF carries the chain as nested nodes (stat_glb.py prints `parent=`).
#
# THE SLICES. Each spine joint carries one rigid hull slice: the body from its
# own station back to the next joint's, plus a SLICE_OVERLAP extension forward
# of its own station that is SUNK a little under the slice ahead of it. The
# visible seam between two slices is therefore AT the hinge between them,
# where a rotation displaces nothing, and the sunk extension behind the seam is
# what the eye would otherwise see through when the bend opens the rim. Every
# ring on every slice samples ONE profile function on ONE station grid
# (RING_STEP), so where two slices meet their rings are the SAME vertices and
# the surface reads continuous at rest; the analytic normals (set as custom
# split normals) make the shading continuous too, which a per-slice
# recomputation would not.
#
# The check that matters for a chain, printed and asserted: the chain is posed
# at every joint's maximum amplitude (species/eel.ts SPINE_AMPLITUDES) and the
# sunk extensions must stay inside the slice ahead; the minimum margin is the
# "minimum slice overlap at max bend" the pass reports.
#
# EVERY DIMENSION IS A NAMED CONSTANT IN GAME SPACE: x forward, y up, z
# lateral, one unit = one cell. `bl()` is the only place the Blender frame
# (x length, y beam, z up) is spoken.
#
# CHECKS IT PRINTS AND ASSERTS, because a model is a claim until measured:
#   * winding: every hull face agrees with an outward test from its slice's axis.
#   * seams: at rest, a slice's rear rim IS the next slice's hinge ring
#     (identical floats); posed at max bend, no extension vertex leaves the
#     slice ahead of it, and no hinge-ring lip exceeds LIP_TOLERANCE.
#   * envelope: the anchor Empties equal the measured mesh extremes.
#   * attachment: NOTHING FLOATS — every non-hull part has vertices strictly
#     inside the union of the (capped) hull slices, by odd ray-crossing parity
#     (the same test as plugins/wildlife/.verify-closed.mts, in Python).

import math
import os
import sys

import bpy

# export_glb.py holds this project's ONE export recipe.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_glb import bake_object_transforms, export_scene_glb  # noqa: E402

# ----------------------------------------------------------------- dimensions
# Game space (x forward, y up, z lateral), cells. The five envelope figures
# ARE plugins/wildlife/client/species/eel.ts's EEL_ENVELOPE; the install-time
# assertion there compares the anchors below against them.

#: The snout's pole vertex: the model's forward extreme and the envelope's front.
NOSE_X = 0.595
#: Nose to stem. The stem (PEDUNCLE_X) is the tail hinge; the paddle adds
#: PADDLE_REACH behind it, so the envelope's length is 0.595 + 0.555 + 0.14.
HULL_LENGTH = 1.15
PEDUNCLE_X = NOSE_X - HULL_LENGTH
PADDLE_REACH = 0.14
TAIL_TIP_X = PEDUNCLE_X - PADDLE_REACH
#: The body's widest half-width, at the plateau behind the head: the FLANK.
MAX_HALF_WIDTH = 0.075
#: The belly's depth below the axis at the deepest station, as the procedural
#: body wrote it (HULL_BELLY = MAX_HALF_WIDTH * 1.15): the envelope's bellyY.
BELLY_DEPTH_RATIO = 1.15
BELLY_Y = -(MAX_HALF_WIDTH * BELLY_DEPTH_RATIO)
#: The dorsal ridge's crest: the envelope's crownY, the model's y max. The
#: procedural eel derived it as its hull's half-height at x = -0.30 (Catmull-
#: Rom profiles, whaleHull.ts profileFromPoints) minus a 0.025 fin-seat bite
#: plus a 0.05 ridge peak; eel.ts keeps that value as a full-precision literal
#: and this is the same literal. The ridge here is BUILT to put a vertex at it.
CROWN_Y = 0.07064932759133065
RIDGE_CREST_X = -0.30

#: Where the five spine joints sit, head to stem, as body stations (t = 0 at
#: the nose, 1 at the stem) — species/eel.ts's SPINE_T.
SPINE_T = (0.06, 0.26, 0.46, 0.66, 0.84)
#: Each joint's maximum yaw in species/eel.ts (SPINE_AMPLITUDES): the pose the
#: seam check below is run at. The two must move together.
SPINE_AMPLITUDES = (0.05, 0.09, 0.13, 0.17, 0.21)
#: How far a slice extends forward of its own hinge, sunk under the slice
#: ahead: 0.04 of body length (0.046 cells). At the widest bend, 0.21 rad, the
#: extension's front rim swings 0.046 * sin(0.21) = 0.0096 sideways.
SLICE_OVERLAP = 0.04
#: How deep the extension's rings sit under the surface of the slice ahead.
#: More than the 0.0096 swing above plus the faceting sagitta of a 16-segment
#: ring at radius 0.045 (0.0009), so the rim never shows at max bend.
RIM_SINK = 0.015
#: The station grid every ring is sampled on. Every slice boundary
#: (SPINE_T, SPINE_T - SLICE_OVERLAP, 0, 1) is a multiple of it, which is what
#: makes a rear rim and the next hinge ring the same vertices.
RING_STEP = 0.02
#: Segments around a ring. Divisible by 4, so the exact top, bottom and both
#: flanks of every section are vertices (belly, crown seat and flank anchors
#: are vertices the file carries).
HULL_SEGMENTS = 16
#: The nose rounds off over this much of the body (a quarter ellipse), sampled
#: every NOSE_CAP_STEP so the snout is round rather than conical; the stem
#: rounds off over TAIL_CAP_FRACTION the same way.
NOSE_CAP_FRACTION = 0.06
NOSE_CAP_STEP = 0.01
TAIL_CAP_FRACTION = 0.04
TAIL_CAP_STEP = 0.01

#: Half-width along the body as a fraction of MAX_HALF_WIDTH, by station t:
#: a blunt snout, widest just behind the head, a PLATEAU (t 0.20-0.40) so the
#: flank and belly anchors sit on sampled rings, then a long taper to a thin
#: stem. Monotone cubic (no overshoot: the plateau IS the maximum).
WIDTH_PROFILE = (
    (0.00, 0.55), (0.08, 0.85), (0.20, 1.00), (0.40, 1.00), (0.55, 0.92),
    (0.70, 0.72), (0.85, 0.45), (1.00, 0.30),
)
#: The section is TWO half-ellipses on one width: the upper half-height and
#: the lower half-height as ratios of the half-width. The belly hangs deeper
#: than the back rises (BELLY_DEPTH_RATIO below, 0.80 above at the plateau),
#: which is what puts the envelope's bellyY at -0.08625 while the back stays
#: under the ridge crest at every station — the crest must be the model's y
#: max, and a symmetric tube 0.08625 tall would have overtopped it (the
#: procedural body did, by 0.017; its own envelope never noticed). Toward the
#: stem both halves rise past 1: an eel's tail is taller than it is wide.
UPPER_RATIO_PROFILE = (
    (0.00, 1.00), (0.20, 0.80), (0.40, 0.80), (0.70, 1.00), (1.00, 1.05),
)
LOWER_RATIO_PROFILE = (
    (0.00, 1.00), (0.20, BELLY_DEPTH_RATIO), (0.40, BELLY_DEPTH_RATIO),
    (0.70, BELLY_DEPTH_RATIO), (1.00, 1.05),
)
#: The station the belly and flank anchors are read at: inside both plateaus.
ANCHOR_T = 0.30

#: Which ring segments are painted belly (pale): the faces whose leading
#: vertex index k is in this range, 225 to 315 degrees round from the
#: starboard flank — the bottom quarter of every section, as a strip.
BELLY_SEGMENT_FIRST = 10
BELLY_SEGMENT_LAST = 13

#: The dorsal ridge: from spine3's station back to RIDGE_END_T, in two pieces
#: that meet AT spine4's station (a seam at a hinge opens only a wedge).
#: Its top line is hull_top + w * (CROWN_Y - hull_top) with w a raised-cosine
#: weight that is exactly 1 at the crest and RIDGE_END_WEIGHT at the end, so
#: the crest is the strict maximum and the ridge runs low into the stem
#: where the paddle takes over.
RIDGE_END_T = 0.96
RIDGE_END_WEIGHT = 0.2
#: Stations sampled from the ridge's start to the crest, crest to seam, and
#: seam to end.
RIDGE_SAMPLES_TO_CREST = 6
RIDGE_SAMPLES_TO_SEAM = 4
RIDGE_SAMPLES_TO_END = 8
#: How far the ridge's base sits under the back. Deeper than the faceting
#: sagitta (0.0009) and the lateral shift a bent spine gives the ridge over
#: the neighbouring slice, so its base is never seen.
RIDGE_SINK = 0.012
#: Fin plate thickness: root half-thickness where a fin leaves the body, edge
#: half-thickness at every free edge (a fin has an edge, not a rim).
FIN_ROOT_HALF_THICKNESS = 0.006
EDGE_HALF_THICKNESS = 0.002

#: The paddle, authored with a = 0 AT THE HINGE (the tail Empty): a rounded
#: fan, not a fork. Its root edge starts PADDLE_ROOT_A forward of the hinge,
#: buried in the stem's cap, widens to PADDLE_HALF_SPAN at PADDLE_WIDEST_A
#: and rounds to a single tip vertex at -PADDLE_REACH (x = TAIL_TIP_X). The
#: half-span stands in the XY plane, so it must stay UNDER the ridge crest
#: (the crest is the model's y max): 0.06 leaves it 0.0106 under CROWN_Y. The
#: procedural paddle's 0.075 overtopped its own envelope by 0.0044.
PADDLE_ROOT_A = 0.03
PADDLE_ROOT_HALF_SPAN = 0.012
PADDLE_WIDEST_A = -0.10
PADDLE_HALF_SPAN = 0.06
#: Bezier controls for the root-to-widest and widest-to-tip edges (upper).
PADDLE_ROOT_CONTROL = (-0.03, 0.05)
PADDLE_TIP_CONTROL = (-PADDLE_REACH, 0.04)
PADDLE_CURVE_SAMPLES = 6

#: Pectorals: tiny leaves just behind the head. Hinge Empties at the flank
#: root at REST IDENTITY (flat in the XZ plane in the file); the 0.5 rad rest
#: dihedral is animation and lives in species/eel.ts, which assigns the
#: hinge's rotation outright — so they are NOT envelope extremes (the belly is
#: the hull's). The leaf outline in the hinge's (along, out) plane is the
#: procedural body's: root edge from +0.02 to -0.03 along the flank, tip at
#: (-0.06, 0.055).
PECTORAL_X = 0.40
PECTORAL_Y = -0.03
#: The hinge sits this fraction of the local half-width out from the axis:
#: inside the flank, so the leaf's root is buried.
PECTORAL_SEAT_FRACTION = 0.8
PECTORAL_ROOT_FRONT_A = 0.02
PECTORAL_ROOT_BACK_A = -0.03
PECTORAL_TIP = (-0.06, 0.055)
PECTORAL_LEAD_CONTROL = (-0.01, 0.03)
PECTORAL_TRAIL_CONTROL = (-0.055, 0.02)
PECTORAL_CURVE_SAMPLES = 5
PECTORAL_ROOT_HALF_THICKNESS = 0.005

#: Eyes: small spheres flush on the snout's sides, centres this fraction of
#: the local half-width out, so they stand a little proud and are otherwise
#: buried in the head.
EYE_X = 0.50
EYE_Y = 0.02
EYE_SEAT_FRACTION = 0.85
EYE_RADIUS = 0.02
EYE_SEGMENTS = 8
EYE_RINGS = 5

#: The mouth: a slight underslung line across the snout's underside, as a
#: surface ridge (inner lip sunk, crest raised) in the fin colour. `theta` is
#: the section angle (0 = starboard flank, pi/2 = back, 3pi/2 = underside).
MOUTH_T = 0.045
MOUTH_HALF_ARC_RADIANS = 1.1
MOUTH_ARC_SAMPLES = 7
LINE_INNER_SCALE = 0.94
LINE_OUTER_SCALE = 1.012
#: Half the mouth line's width along the body, in cells.
LINE_HALF_WIDTH = 0.004

#: Colours, as the sRGB hexes the species file declares. THESE ARE sRGB AND
#: BLENDER'S BASE COLOR IS LINEAR — see srgb() below.
BODY_COLOR = 0x3D4220
BELLY_COLOR = 0x8C8A66
FIN_COLOR = 0x333A1C
EYE_COLOR = 0x0F0F0C

#: ONE roughness and ONE metalness across every material on this model.
#: rigSkin.ts's materialSignature keys on roughness and metalness but NOT on
#: colour, so four colours at one roughness bake to ONE surface — the draw
#: budget plugins/wildlife/client/index.ts asserts for the eel. 0.5 is a wet,
#: slightly glossy body.
SURFACE_ROUGHNESS = 0.5
SURFACE_METALNESS = 0.0

#: How far a numerically checked normal may disagree with the analytic winding
#: before the build fails. Zero would trip on float dust in a near-tangent face.
WINDING_TOLERANCE = 1e-12
#: How far a measured extreme may sit from its anchor. The install tolerates
#: ENVELOPE_TOLERANCE_CELLS (0.01, species/assetSpecies.ts) to absorb the
#: float32 round trip; a BUILD is authored and has no round trip, so here the
#: extremes must be the anchors to float dust — a part that overtopped the
#: crest by 0.004 would install and still be wrong art.
ANCHOR_TOLERANCE = 1e-9
#: How far a hinge ring may stand proud of the slice ahead at max bend — a
#: fifth of the install tolerance, itself "well under a pixel at the play
#: camera".
LIP_TOLERANCE = 0.002
#: Step for the finite-difference surface normals.
NORMAL_EPSILON = 1e-5


# ------------------------------------------------------------------ the frame

def bl(x, y, z):
    """Game space (x forward, y up, z lateral) -> Blender (x, y beam, z up).

    The glTF exporter's `export_yup` maps Blender (x, y, z) to glTF
    (x, z, -y), so Blender's +Y is glTF's -Z. Inverting that here is what
    lets every constant above be written in the frame the game speaks.
    """
    return (x, -z, y)


def monotone_profile(points):
    """A monotone cubic (Fritsch-Butland) through `points`, clamped outside.

    Chosen over Catmull-Rom because it cannot overshoot: a plateau in the
    control points IS the maximum, exactly, so the anchors read off the
    plateau are the true extremes. Chosen over piecewise-linear because the
    eel is a smooth tube and a kink at every control point would be a ring
    of shading on the body.
    """
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    n = len(points)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0] = d[0]
    m[-1] = d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0.0:
            m[i] = 0.0
        else:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def sample(t):
        if t <= xs[0]:
            return ys[0]
        if t >= xs[-1]:
            return ys[-1]
        i = 0
        while t > xs[i + 1]:
            i += 1
        if ys[i] == ys[i + 1]:
            # A plateau is EXACTLY its value (the Hermite terms would sum to
            # it within an ulp; the anchors read off it deserve the exact one).
            return ys[i]
        s = (t - xs[i]) / h[i]
        s2 = s * s
        s3 = s2 * s
        return (
            (2 * s3 - 3 * s2 + 1) * ys[i]
            + (s3 - 2 * s2 + s) * h[i] * m[i]
            + (-2 * s3 + 3 * s2) * ys[i + 1]
            + (s3 - s2) * h[i] * m[i + 1]
        )
    return sample


WIDTH = monotone_profile(WIDTH_PROFILE)
UPPER_RATIO = monotone_profile(UPPER_RATIO_PROFILE)
LOWER_RATIO = monotone_profile(LOWER_RATIO_PROFILE)


def cap_factor(u):
    """Rounds the sweep into closed caps at both ends (a quarter ellipse)."""
    if u < NOSE_CAP_FRACTION:
        return math.sqrt(max(0.0, 1.0 - (1.0 - u / NOSE_CAP_FRACTION) ** 2))
    if u > 1.0 - TAIL_CAP_FRACTION:
        t = (u - (1.0 - TAIL_CAP_FRACTION)) / TAIL_CAP_FRACTION
        return math.sqrt(max(0.0, 1.0 - t * t))
    return 1.0


def station_x(t):
    """Rig-space x of a body station t."""
    return NOSE_X - t * HULL_LENGTH


def station_t(x):
    """Body station of a rig-space x."""
    return (NOSE_X - x) / HULL_LENGTH


def half_width(t):
    return MAX_HALF_WIDTH * WIDTH(t) * cap_factor(t)


def half_height_up(t):
    return half_width(t) * UPPER_RATIO(t)


def half_height_down(t):
    return half_width(t) * LOWER_RATIO(t)


def surface_point(t, theta, scale=1.0):
    """A point on (or scaled off) the hull surface, in game space.

    Two half-ellipses on one width: theta = 0 is the starboard flank, pi/2
    the back, pi the port flank, 3pi/2 the belly. The halves share the flank
    tangent, so the section is smooth there; only its curvature changes.
    """
    s = math.sin(theta)
    h = half_height_up(t) if s >= 0.0 else half_height_down(t)
    return (station_x(t), h * s * scale, half_width(t) * math.cos(theta) * scale)


def surface_normal(t, theta):
    """The outward unit normal of the analytic hull at (t, theta).

    d/dtheta x d/dt: theta runs +z -> +y and t runs aft (-x), so at theta = 0
    the product is +y x -x = +z, which is outward on the starboard flank.
    """
    p_t0 = surface_point(max(0.0, t - NORMAL_EPSILON), theta)
    p_t1 = surface_point(min(1.0, t + NORMAL_EPSILON), theta)
    p_a0 = surface_point(t, theta - NORMAL_EPSILON)
    p_a1 = surface_point(t, theta + NORMAL_EPSILON)
    du = (p_t1[0] - p_t0[0], p_t1[1] - p_t0[1], p_t1[2] - p_t0[2])
    da = (p_a1[0] - p_a0[0], p_a1[1] - p_a0[1], p_a1[2] - p_a0[2])
    n = (
        da[1] * du[2] - da[2] * du[1],
        da[2] * du[0] - da[0] * du[2],
        da[0] * du[1] - da[1] * du[0],
    )
    length = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
    return (n[0] / length, n[1] / length, n[2] / length)


def sink_radially(point, depth):
    """`point` moved `depth` straight toward the body axis in its section."""
    x, y, z = point
    r = math.hypot(y, z)
    f = (r - depth) / r
    return (x, y * f, z * f)


def radial_margin(point):
    """How far inside the analytic hull `point` is, along its own section ray.

    Positive = inside, negative = outside, in cells. rho is the point's
    elliptical radius against the section at its station; the margin is the
    distance from the point to the surface along the ray from the axis.
    """
    x, y, z = point
    t = station_t(x)
    if t <= 0.0 or t >= 1.0:
        return -math.inf
    w = half_width(t)
    h = half_height_up(t) if y >= 0.0 else half_height_down(t)
    if w <= 0.0 or h <= 0.0:
        return -math.inf
    rho = math.sqrt((z / w) ** 2 + (y / h) ** 2)
    if rho == 0.0:
        return min(w, h)
    return math.hypot(y, z) * (1.0 / rho - 1.0)


def hull_top(x):
    """The back's height on the centreline at rig-space x."""
    return half_height_up(station_t(x))


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

    `ref` must be on the slice's axis inside it. This NEVER rewrites a face:
    the winding is derived, and a disagreement is a bug in the derivation.
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


def make_object(name, verts, faces, smooth, flat_faces=(), normals=None):
    """A Blender mesh object from GAME-space verts (converted here, once).

    `smooth` shades every face smooth; the face indices in `flat_faces` are
    then set flat. `normals`, when given, are per-vertex GAME-space normals
    set as custom split normals AFTER Blender's own consistency pass — the
    hull's analytic normals, so two slices shade identically along a seam.
    """
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([bl(*v) for v in verts], [], [list(f) for f in faces])
    mesh.update()
    mesh.validate()
    flat = set(flat_faces)
    for index, poly in enumerate(mesh.polygons):
        poly.use_smooth = smooth and index not in flat
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    # BELT AND SUSPENDERS on the winding: Blender's own outward recalculation
    # runs over every mesh; a no-op on one that was already right, which
    # check_outward proves for the hull.
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)
    if normals is not None:
        mesh.normals_split_custom_set_from_vertices([bl(*n) for n in normals])
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

    Every colour in this codebase is an sRGB hex (what three.js reads a
    material colour as); Blender's Base Color and glTF's baseColorFactor are
    LINEAR. The transfer function is the sRGB standard's.
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


def quad_bezier_at(p0, p1, p2, t):
    s = 1.0 - t
    return (
        s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0],
        s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1],
    )


def quad_bezier(p0, p1, p2, samples):
    """Points ALONG a quadratic curve, p0 excluded, p2 included."""
    return [quad_bezier_at(p0, p1, p2, k / samples) for k in range(1, samples + 1)]


def lerp(a, b, s):
    return a + (b - a) * min(1.0, max(0.0, s))


def tapered_blade(outline, half_at, to_game):
    """A closed outline swept into a solid blade of VARYING thickness.

    `outline` is a simple polygon in the blade's own 2D plane; `half_at(a, b)`
    gives the half-thickness at each outline point; `to_game` maps
    (a, b, offset) to game space and must be a right-handed basis
    (a x b = offset). CCW OR NOTHING: the shoelace area settles the outline's
    orientation, so the caps face +-offset and every side faces outward.

    Returns (verts, faces, cap_face_indices). Sides are planar and shaded
    flat, caps smooth — see make_object.
    """
    area = 0.0
    for (a0, b0), (a1, b1) in zip(outline, outline[1:] + outline[:1]):
        area += a0 * b1 - a1 * b0
    if area < 0.0:
        outline = list(reversed(outline))
    count = len(outline)
    verts = [to_game(a, b, +half_at(a, b)) for a, b in outline]
    verts += [to_game(a, b, -half_at(a, b)) for a, b in outline]
    faces = [list(range(count)), list(reversed(range(count, 2 * count)))]
    for k in range(count):
        k2 = (k + 1) % count
        faces.append([k, k2, count + k2, count + k])
    return verts, faces, (0, 1)


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


def compact(verts, normals, faces):
    """Keep only the vertices `faces` reference, re-indexing the faces."""
    used = sorted({i for face in faces for i in face})
    remap = {old: new for new, old in enumerate(used)}
    return (
        [verts[i] for i in used],
        [normals[i] for i in used],
        [[remap[i] for i in face] for face in faces],
    )


# ------------------------------------------------------------------ the hull

def grid_stations(t0, t1):
    """Stations from t0 to t1 inclusive on the RING_STEP grid.

    Computed as INTEGER grid index times the step, never as t0 plus offsets,
    so the same station reached from two slices is the same float — which is
    what lets check_seams demand a rear rim and a hinge ring be identical.
    """
    k0, k1 = round(t0 / RING_STEP), round(t1 / RING_STEP)
    assert abs(k0 * RING_STEP - t0) < 1e-9 and abs(k1 * RING_STEP - t1) < 1e-9, (
        f'[{t0}, {t1}] is off the ring grid')
    return [k * RING_STEP for k in range(k0, k1 + 1)]


def slice_stations(i):
    """The (t, sink) rings of slice i, nose to stem, plus its pole flags.

    Slice i owns the body from SPINE_T[i] back to the next joint's station,
    and reaches SLICE_OVERLAP forward of its own hinge with rings sunk
    RIM_SINK under the slice ahead. The head slice starts at the nose pole
    with the cap sampled finely; the last ends at the stem pole the same way.
    """
    head = i == 0
    last = i == len(SPINE_T) - 1
    own = SPINE_T[i]
    end = 1.0 if last else SPINE_T[i + 1]
    stations = []
    if head:
        cap = int(round(NOSE_CAP_FRACTION / NOSE_CAP_STEP))
        stations += [(k * NOSE_CAP_STEP, 0.0) for k in range(1, cap)]
        stations += [(t, 0.0) for t in grid_stations(NOSE_CAP_FRACTION, end)]
    else:
        front = own - SLICE_OVERLAP
        for t in grid_stations(front, end):
            stations.append((t, RIM_SINK if t < own - 1e-9 else 0.0))
    if last:
        # The grid rings inside the tail cap give way to the cap's finer ones
        # (the stem pole itself is a vertex, not a ring).
        tail_start = 1.0 - TAIL_CAP_FRACTION
        stations = [(t, sink) for t, sink in stations if t <= tail_start + 1e-9]
        cap = int(round(TAIL_CAP_FRACTION / TAIL_CAP_STEP))
        stations += [(tail_start + k * TAIL_CAP_STEP, 0.0) for k in range(1, cap)]
    assert all(a[0] < b[0] for a, b in zip(stations, stations[1:])), 'rings out of order'
    return stations, head, last


def build_slice(i):
    """One hull slice: rings on the shared grid, faces split body/belly.

    Returns a dict with GAME-space verts and analytic normals, the body and
    belly face lists, the ring starts and (t, sink) per ring, and the pole
    indices (or -1). WINDING, derived then proved by check_outward: theta runs
    +z -> +y and successive rings run AFT (-x), so a face taken (this ring k)
    -> (this ring k+1) -> (next ring k+1) -> (next ring k) has its normal along
    +z at theta = 0, which is outward; the pole fans follow the same
    circulation.
    """
    stations, head, last = slice_stations(i)
    verts, normals, ring_starts = [], [], []
    pole_nose = pole_tail = -1
    if head:
        pole_nose = 0
        verts.append((NOSE_X, 0.0, 0.0))
        normals.append((1.0, 0.0, 0.0))
    for t, sink in stations:
        ring_starts.append(len(verts))
        for k in range(HULL_SEGMENTS):
            theta = 2 * math.pi * k / HULL_SEGMENTS
            point = surface_point(t, theta)
            verts.append(sink_radially(point, sink) if sink > 0.0 else point)
            normals.append(surface_normal(t, theta))
    if last:
        pole_tail = len(verts)
        verts.append((PEDUNCLE_X, 0.0, 0.0))
        normals.append((-1.0, 0.0, 0.0))

    def is_belly(k):
        return BELLY_SEGMENT_FIRST <= k <= BELLY_SEGMENT_LAST

    body, belly = [], []
    if pole_nose >= 0:
        r0 = ring_starts[0]
        for k in range(HULL_SEGMENTS):
            k2 = (k + 1) % HULL_SEGMENTS
            (belly if is_belly(k) else body).append([pole_nose, r0 + k2, r0 + k])
    for r in range(len(ring_starts) - 1):
        cur, nxt = ring_starts[r], ring_starts[r + 1]
        for k in range(HULL_SEGMENTS):
            k2 = (k + 1) % HULL_SEGMENTS
            (belly if is_belly(k) else body).append([cur + k, cur + k2, nxt + k2, nxt + k])
    if pole_tail >= 0:
        rl = ring_starts[-1]
        for k in range(HULL_SEGMENTS):
            k2 = (k + 1) % HULL_SEGMENTS
            (belly if is_belly(k) else body).append([pole_tail, rl + k, rl + k2])
    return {
        'verts': verts, 'normals': normals, 'body': body, 'belly': belly,
        'ring_starts': ring_starts, 'stations': stations,
        'pole_nose': pole_nose, 'pole_tail': pole_tail,
    }


def closed_faces(s):
    """The slice's faces plus virtual caps over its open rims — for the parity
    test only. Never exported: the rims are inside the neighbouring slice."""
    verts = list(s['verts'])
    faces = list(s['body']) + list(s['belly'])
    for ring_index, open_end in ((0, s['pole_nose'] < 0), (-1, s['pole_tail'] < 0)):
        if not open_end:
            continue
        r0 = s['ring_starts'][ring_index]
        centre = len(verts)
        verts.append((verts[r0][0], 0.0, 0.0))
        for k in range(HULL_SEGMENTS):
            faces.append([centre, r0 + k, r0 + (k + 1) % HULL_SEGMENTS])
    return verts, faces


def ring_vertices(s, ring_index):
    r0 = s['ring_starts'][ring_index]
    return s['verts'][r0:r0 + HULL_SEGMENTS]


# ------------------------------------------------------------------ the parts

def ridge_weight(x, start_x, seam_x, end_x):
    """The ridge's height weight: 0 at the start, exactly 1 at the crest,
    RIDGE_END_WEIGHT at the end, raised-cosine between."""
    if x >= RIDGE_CREST_X:
        s = (start_x - x) / (start_x - RIDGE_CREST_X)
        return 0.5 * (1.0 - math.cos(math.pi * s))
    s = (RIDGE_CREST_X - x) / (RIDGE_CREST_X - end_x)
    return 1.0 - (1.0 - RIDGE_END_WEIGHT) * 0.5 * (1.0 - math.cos(math.pi * s))


def ridge_top(x, start_x, seam_x, end_x):
    top = hull_top(x)
    return top + ridge_weight(x, start_x, seam_x, end_x) * (CROWN_Y - top)


def ridge_piece(xs, start_x, seam_x, end_x):
    """One piece of the dorsal ridge: a plate in the XY plane over stations
    `xs` (forward to aft), base RIDGE_SINK under the back, top on the ridge
    line; root-thick at the base, an edge on top. Closed: two sheets, top and
    bottom strips, two end caps. Winding derived: the +z sheet is taken with
    its circulation about +z."""
    n = len(xs)
    base = [(x, hull_top(x) - RIDGE_SINK) for x in xs]
    top = [(x, ridge_top(x, start_x, seam_x, end_x)) for x in xs]
    verts = []
    for side in (+1.0, -1.0):
        verts += [(x, y, side * FIN_ROOT_HALF_THICKNESS) for x, y in base]
        verts += [(x, y, side * EDGE_HALF_THICKNESS) for x, y in top]

    def v(side, row, i):
        return (0 if side > 0 else 2 * n) + row * n + i

    faces = []
    for i in range(n - 1):
        # Stations run AFT (-x). +z sheet: (base i) -> (top i) -> (top i+1) ->
        # (base i+1) runs +y then -x, and (+y) x (-x) = +z. The -z sheet is
        # the mirror loop; the top strip runs -z then -x ((-z) x (-x) = +y);
        # the bottom strip -x then -z (= -y); the caps +x at the front and -x
        # at the rear by the same rule.
        faces.append([v(+1, 0, i), v(+1, 1, i), v(+1, 1, i + 1), v(+1, 0, i + 1)])
        faces.append([v(-1, 0, i), v(-1, 0, i + 1), v(-1, 1, i + 1), v(-1, 1, i)])
        faces.append([v(+1, 1, i), v(-1, 1, i), v(-1, 1, i + 1), v(+1, 1, i + 1)])
        faces.append([v(+1, 0, i), v(+1, 0, i + 1), v(-1, 0, i + 1), v(-1, 0, i)])
    faces.append([v(+1, 0, 0), v(-1, 0, 0), v(-1, 1, 0), v(+1, 1, 0)])
    faces.append([v(+1, 0, n - 1), v(+1, 1, n - 1), v(-1, 1, n - 1), v(-1, 0, n - 1)])
    return verts, faces


def ridge_stations():
    """The ridge's stations: start (spine3) -> crest -> seam (spine4) -> end,
    with the crest and the seam sampled exactly."""
    start_x = station_x(SPINE_T[3])
    seam_x = station_x(SPINE_T[4])
    end_x = station_x(RIDGE_END_T)
    a = [start_x + (RIDGE_CREST_X - start_x) * k / RIDGE_SAMPLES_TO_CREST
         for k in range(RIDGE_SAMPLES_TO_CREST + 1)]
    a += [RIDGE_CREST_X + (seam_x - RIDGE_CREST_X) * k / RIDGE_SAMPLES_TO_SEAM
          for k in range(1, RIDGE_SAMPLES_TO_SEAM + 1)]
    b = [seam_x + (end_x - seam_x) * k / RIDGE_SAMPLES_TO_END
         for k in range(RIDGE_SAMPLES_TO_END + 1)]
    return a, b, start_x, seam_x, end_x


def paddle():
    """The tail paddle in the TAIL HINGE's (a along x, b up) plane, off = z."""
    root_top = (PADDLE_ROOT_A, PADDLE_ROOT_HALF_SPAN)
    widest = (PADDLE_WIDEST_A, PADDLE_HALF_SPAN)
    tip = (-PADDLE_REACH, 0.0)
    upper = [root_top]
    upper += quad_bezier(root_top, PADDLE_ROOT_CONTROL, widest, PADDLE_CURVE_SAMPLES)
    upper += quad_bezier(widest, PADDLE_TIP_CONTROL, tip, PADDLE_CURVE_SAMPLES)
    lower = [(a, -b) for a, b in reversed(upper[:-1])]
    outline = upper + lower

    def half_at(a, _b):
        return lerp(FIN_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS,
                    (PADDLE_ROOT_A - a) / (PADDLE_ROOT_A + PADDLE_REACH))

    def to_game(a, b, off):
        # (a, b) = (x, y): x x y = +z, so off runs along +z.
        return (a, b, off)
    return tapered_blade(outline, half_at, to_game)


def pectoral_outline():
    front = (PECTORAL_ROOT_FRONT_A, 0.0)
    back = (PECTORAL_ROOT_BACK_A, 0.0)
    outline = [front]
    outline += quad_bezier(front, PECTORAL_LEAD_CONTROL, PECTORAL_TIP, PECTORAL_CURVE_SAMPLES)
    outline += quad_bezier(PECTORAL_TIP, PECTORAL_TRAIL_CONTROL, back, PECTORAL_CURVE_SAMPLES)
    return outline


def pectoral_blade(side):
    """A pectoral leaf in its HINGE's frame: a along x, b outward, flat."""
    def half_at(_a, b):
        return lerp(PECTORAL_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS, b / PECTORAL_TIP[1])

    def to_game(a, b, off):
        # a along x, b outward along side*z: a x b = side * (x x z) = -side*y,
        # so the offset runs along -side*y — the same right-handed basis as
        # build_ray.py's wing_basis.
        return (a, -side * off, side * b)
    return tapered_blade(pectoral_outline(), half_at, to_game)


def mouth():
    """The mouth line: a surface ridge across the snout's underside.

    Three vertices per station — inner lip forward, raised crest, inner lip
    aft — banded into a closed solid whose floor sits under the surface. The
    same construction as the fish's lateral line and the ray's mouth.
    """
    du = LINE_HALF_WIDTH / HULL_LENGTH
    verts, faces = [], []
    for i in range(MOUTH_ARC_SAMPLES):
        phi = MOUTH_HALF_ARC_RADIANS * (2.0 * i / (MOUTH_ARC_SAMPLES - 1) - 1.0)
        theta = 3 * math.pi / 2 + phi
        verts.append(surface_point(MOUTH_T - du, theta, LINE_INNER_SCALE))
        verts.append(surface_point(MOUTH_T, theta, LINE_OUTER_SCALE))
        verts.append(surface_point(MOUTH_T + du, theta, LINE_INNER_SCALE))
    for i in range(MOUTH_ARC_SAMPLES - 1):
        a, b = 3 * i, 3 * (i + 1)
        faces.append([a, a + 1, b + 1, b])
        faces.append([a + 1, a + 2, b + 2, b + 1])
        faces.append([a + 2, a, b, b + 2])
    last = 3 * (MOUTH_ARC_SAMPLES - 1)
    faces.append([0, 1, 2])
    faces.append([last + 2, last + 1, last])
    return verts, faces


# ------------------------------------------------------------------ the checks

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
    """Fan-triangulate for the parity test only."""
    out = []
    for face in faces:
        for k in range(1, len(face) - 1):
            out.append((verts[face[0]], verts[face[k]], verts[face[k + 1]]))
    return out


def inside_any(point, shells):
    """Inside the UNION of closed shells: inside at least one of them."""
    return any(ray_hits(point, shell) % 2 == 1 for shell in shells)


def check_attachment(shells, parts):
    """NOTHING FLOATS: every part has vertices strictly inside the hull.

    Bounds overlap is not enough — two shapes can share a bounding box and
    never touch — so this is the odd-crossing parity test the owner requires
    (plugins/wildlife/.verify-closed.mts), against each slice's closed shell,
    OR-ed over the slices.
    """
    print('  attachment (vertices strictly inside the hull slices):')
    floating = []
    for name, verts in parts:
        inside = sum(1 for v in verts if inside_any(v, shells))
        state = f'{inside}/{len(verts)} inside' if inside else 'FLOATING'
        print(f'    {name:20} {state}')
        if inside == 0:
            floating.append(name)
    assert not floating, f'parts float free of the hull: {floating}'


def yaw_about(point, hinge_x, angle):
    """`point` rotated by `angle` about the +y axis through (hinge_x, 0, 0) —
    three's `rotation.y = angle` on a joint at that station."""
    x, y, z = point
    dx = x - hinge_x
    c, s = math.cos(angle), math.sin(angle)
    return (hinge_x + dx * c + z * s, y, -dx * s + z * c)


def check_seams(slices):
    """The chain's own check: rest continuity, and the overlap at max bend.

    At REST a slice's rear rim and the next slice's hinge ring must be the
    same floats (one profile, one grid). At MAX BEND — the next joint yawed
    by its SPINE_AMPLITUDE, either way — every sunk extension vertex must
    still be strictly inside the slice ahead (parity against its capped
    shell), and its analytic radial margin is the overlap this pass reports.
    The hinge ring itself, which the yaw tilts, may stand proud of the slice
    ahead by no more than LIP_TOLERANCE.
    """
    print('  seams:')
    min_margin = math.inf
    worst_lip = 0.0
    for i in range(len(slices) - 1):
        ahead, behind = slices[i], slices[i + 1]
        hinge_t = SPINE_T[i + 1]
        hinge_x = station_x(hinge_t)
        rear_rim = ring_vertices(ahead, -1)
        hinge_ring_index = next(
            r for r, (t, _sink) in enumerate(behind['stations']) if abs(t - hinge_t) < 1e-9)
        hinge_ring = ring_vertices(behind, hinge_ring_index)
        assert rear_rim == hinge_ring, f'seam {i}/{i + 1}: rim and hinge ring differ'
        shell = triangulate(*closed_faces(ahead))
        extension = []
        for r in range(hinge_ring_index):
            extension += ring_vertices(behind, r)
        amplitude = SPINE_AMPLITUDES[i + 1]
        seam_margin = math.inf
        seam_lip = 0.0
        outside = 0
        for sign in (+1.0, -1.0):
            for v in extension:
                posed = yaw_about(v, hinge_x, sign * amplitude)
                seam_margin = min(seam_margin, radial_margin(posed))
                if ray_hits(posed, shell) % 2 == 0:
                    outside += 1
            for v in hinge_ring:
                posed = yaw_about(v, hinge_x, sign * amplitude)
                seam_lip = max(seam_lip, -radial_margin(posed))
        print(f'    spine{i}/spine{i + 1} at {amplitude:.2f} rad: rest rim identical; '
              f'{len(extension)} extension vertices, {outside} outside the slice ahead; '
              f'min radial margin {seam_margin:+.4f}; hinge-ring lip {seam_lip:.4f}')
        assert outside == 0, f'seam {i}/{i + 1}: {outside} extension vertices left the slice ahead'
        assert seam_lip <= LIP_TOLERANCE, f'seam {i}/{i + 1}: lip {seam_lip} > {LIP_TOLERANCE}'
        min_margin = min(min_margin, seam_margin)
        worst_lip = max(worst_lip, seam_lip)
    print(f'    minimum slice overlap at max bend {min_margin:.4f} (RIM_SINK {RIM_SINK}); '
          f'worst hinge-ring lip {worst_lip:.4f}')
    assert min_margin > 0.0


def check_envelope(all_verts, hull_verts):
    """The anchors are the measured extremes, not a second set of numbers."""
    max_x = max(v[0] for v in all_verts)
    min_x = min(v[0] for v in all_verts)
    max_y = max(v[1] for v in all_verts)
    min_y = min(v[1] for v in all_verts)
    span_z = max(abs(v[2]) for v in hull_verts)
    print('  envelope (measured vs declared):')
    for label, measured, declared in (
        ('nose', max_x, NOSE_X),
        ('tail_tip', min_x, TAIL_TIP_X),
        ('crown', max_y, CROWN_Y),
        ('belly', min_y, BELLY_Y),
        ('flank', span_z, MAX_HALF_WIDTH),
    ):
        print(f'    {label:9} {measured:+.6f} vs {declared:+.6f}  '
              f'(off by {abs(measured - declared):.7f})')
        assert abs(measured - declared) < ANCHOR_TOLERANCE, (
            f'{label}: measured {measured:.4f}, anchor says {declared:.4f}')
    hull_top_max = max(v[1] for v in hull_verts)
    print(f'    hull back tops out at {hull_top_max:+.4f}, {CROWN_Y - hull_top_max:.4f} under the crest')
    assert hull_top_max < CROWN_Y, 'the back overtops the ridge crest'
    reach_z = max(abs(v[2]) for v in all_verts)
    print(f'    widest thing on the model {reach_z:.4f} (the flat pectorals; flank is the BODY, '
          f'as for the fish)')
    print(f'    length {max_x - min_x:.4f}, halfLength {(max_x - min_x) / 2:.4f}')


# ------------------------------------------------------------------ the build

def offset_all(verts, offset):
    return [(x - offset[0], y - offset[1], z - offset[2]) for x, y, z in verts]


def add_part(name, world_verts, faces, material, joint, joint_position, smooth,
             flat_faces=(), normals=None):
    """A mesh authored in GAME space, hung under `joint` (a pure translation
    at `joint_position`) — so its local vertices are world minus the joint."""
    obj = make_object(name, offset_all(world_verts, joint_position), faces, smooth,
                      flat_faces, normals)
    obj.data.materials.append(material)
    parent_to(obj, joint)
    return obj


def blade_flat_faces(faces, caps):
    return [i for i in range(len(faces)) if i not in caps]


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    out_path = args[0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    body_material = flat_material('eel_body', srgb(BODY_COLOR))
    belly_material = flat_material('eel_belly', srgb(BELLY_COLOR))
    fin_material = flat_material('eel_fin', srgb(FIN_COLOR))
    eye_material = flat_material('eel_eye', srgb(EYE_COLOR))

    print('eel build:')

    # ---- the chain: rig, then five nested spine Empties, then the tail ----
    rig = make_empty('rig', (0.0, 0.0, 0.0))
    spines, spine_positions = [], []
    parent, parent_x = rig, 0.0
    for i, t in enumerate(SPINE_T):
        x = station_x(t)
        joint = make_empty(f'spine{i}', (x - parent_x, 0.0, 0.0))
        parent_to(joint, parent)
        spines.append(joint)
        spine_positions.append((x, 0.0, 0.0))
        parent, parent_x = joint, x
    tail = make_empty('tail', (PEDUNCLE_X - parent_x, 0.0, 0.0))
    parent_to(tail, spines[-1])
    tail_position = (PEDUNCLE_X, 0.0, 0.0)

    # ---- the hull: one slice (+ belly strip) per spine joint ----
    slices = [build_slice(i) for i in range(len(SPINE_T))]
    hull_verts = []
    shells = []
    for i, s in enumerate(slices):
        xs = [v[0] for v in s['verts']]
        ref = ((min(xs) + max(xs)) / 2, 0.0, 0.0)
        check_outward(f'slice{i}', s['verts'], s['body'] + s['belly'], ref)
        body_v, body_n, body_f = compact(s['verts'], s['normals'], s['body'])
        belly_v, belly_n, belly_f = compact(s['verts'], s['normals'], s['belly'])
        add_part(f'slice{i}', body_v, body_f, body_material, spines[i], spine_positions[i],
                 smooth=True, normals=body_n)
        add_part(f'belly{i}', belly_v, belly_f, belly_material, spines[i], spine_positions[i],
                 smooth=True, normals=belly_n)
        hull_verts += s['verts']
        shells.append(triangulate(*closed_faces(s)))
    check_seams(slices)

    parts = []

    # ---- the dorsal ridge, two pieces meeting at spine4's hinge ----
    ridge_a_xs, ridge_b_xs, start_x, seam_x, end_x = ridge_stations()
    for name, xs, joint_index in (('ridge_a', ridge_a_xs, 3), ('ridge_b', ridge_b_xs, 4)):
        verts, faces = ridge_piece(xs, start_x, seam_x, end_x)
        add_part(name, verts, faces, fin_material, spines[joint_index],
                 spine_positions[joint_index], smooth=False)
        parts.append((name, verts))
    crest_proud = CROWN_Y - hull_top(RIDGE_CREST_X)
    print(f'  ridge: crest {CROWN_Y:.6f} at x {RIDGE_CREST_X}, {crest_proud:.4f} proud of the back '
          f'({hull_top(RIDGE_CREST_X):.4f}); runs x {start_x:.3f} -> {end_x:.3f}, seam at {seam_x:.3f}')

    # ---- the paddle, under the tail hinge ----
    paddle_local, faces, caps = paddle()
    paddle_obj = make_object('paddle', paddle_local, faces, True, blade_flat_faces(faces, caps))
    paddle_obj.data.materials.append(fin_material)
    parent_to(paddle_obj, tail)
    paddle_world = [(a + tail_position[0], b, c) for a, b, c in paddle_local]
    parts.append(('paddle', paddle_world))

    # ---- pectoral hinges (identity, flat) and leaves, under spine0 ----
    seat_z = PECTORAL_SEAT_FRACTION * half_width(station_t(PECTORAL_X))
    # Right-handed frame with +X forward and +Y up puts PORT at -Z
    # (left = up x forward = Y x X = -Z), which is the sign the convention names.
    for name, side in (('pectoral_port', -1.0), ('pectoral_starboard', 1.0)):
        hinge_world = (PECTORAL_X, PECTORAL_Y, side * seat_z)
        hinge = make_empty(name, offset_all([hinge_world], spine_positions[0])[0])
        parent_to(hinge, spines[0])
        blade_local, faces, caps = pectoral_blade(side)
        blade = make_object(f'{name}_blade', blade_local, faces, True, blade_flat_faces(faces, caps))
        blade.data.materials.append(fin_material)
        parent_to(blade, hinge)
        parts.append((name, [(a + hinge_world[0], b + hinge_world[1], c + hinge_world[2])
                             for a, b, c in blade_local]))

    # ---- eyes, under spine0 ----
    eye_z = EYE_SEAT_FRACTION * half_width(station_t(EYE_X))
    for name, side in (('eye_port', -1.0), ('eye_starboard', 1.0)):
        verts, faces = uv_sphere((EYE_X, EYE_Y, side * eye_z), EYE_RADIUS, EYE_SEGMENTS, EYE_RINGS)
        check_outward(name, verts, faces, (EYE_X, EYE_Y, side * eye_z))
        add_part(name, verts, faces, eye_material, spines[0], spine_positions[0], smooth=True)
        parts.append((name, verts))

    # ---- the mouth line, under spine0 ----
    verts, faces = mouth()
    add_part('mouth', verts, faces, fin_material, spines[0], spine_positions[0], smooth=False)
    parts.append(('mouth', verts))

    # ---- checks, on the GAME-space vertices the parts were authored from ----
    check_attachment(shells, parts)
    all_verts = list(hull_verts)
    for _name, verts in parts:
        all_verts.extend(verts)
    check_envelope(all_verts, hull_verts)

    # ---- anchors: what the plugin measures EEL_ENVELOPE from ----
    make_empty('nose', (NOSE_X, 0.0, 0.0))
    make_empty('tail_tip', (TAIL_TIP_X, 0.0, 0.0))
    make_empty('crown', (RIDGE_CREST_X, CROWN_Y, 0.0))
    make_empty('belly', (station_x(ANCHOR_T), BELLY_Y, 0.0))
    # The body's widest station — the envelope's halfWidth is the BODY, as for
    # the fish; the flat pectorals reach further and are checked as an upper
    # bound only.
    make_empty('flank', (station_x(ANCHOR_T), 0.0, MAX_HALF_WIDTH))

    bake_object_transforms()
    export_scene_glb(out_path)

    total_tris = 0
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        total_tris += tris
        print(f'  {obj.name}: {len(mesh.polygons)} polys, {tris} tris')
    print(f'eel -> {out_path}: {total_tris} tris total')


main()
