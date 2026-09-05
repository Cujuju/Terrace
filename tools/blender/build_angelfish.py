# build_angelfish.py — builds the Terrace angelfish in Blender and exports it.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_angelfish.py -- \
#     E:\...\Terrace\plugins\wildlife\client\assets\angelfish.glb
#
# WHAT IT BUILDS (docs/model-assets.md is the convention this satisfies, and
# its "Wildlife species" section is the joint convention). Pass 5 of the
# fish+whales arc: build_fish.py is the pattern (one hull, SWIMMER_JOINTS),
# build_eel.py the helpers (monotone profiles, analytic normals, tapered
# blades, the asserted checks).
#
#   rig                   Empty at the origin; the whole body hangs under it.
#     body                the swept disc: nose cap to a rounded aft end just
#                         behind the peduncle, TALL and thin, smooth-shaded
#                         with analytic normals.
#     bar_front_* / bar_rear_*
#                         THE BARS ARE GEOMETRY (the species sheet's design
#                         decision): the hull's own faces at two stations,
#                         raised off the flank by a lens-section bump and
#                         painted near-black. The front bar's outermost
#                         vertex is the envelope's FLANK (0.085).
#     dorsal / anal       the sail and its mirror: long triangular blades
#                         seated a bite into the back and belly, their tips
#                         the envelope's CROWN and BELLY.
#     eye_port / eye_starboard, mouth
#     tail                Empty AT THE PEDUNCLE; the forked caudal hangs under
#                         it (its tip the TAIL_TIP), so the plugin's yaw
#                         sweeps the fin from its root.
#     pectoral_port / pectoral_starboard
#                         Empties at the flank root, at REST IDENTITY (flat in
#                         the file); the 0.55 rad dihedral is animation and
#                         lives in species/angelfish.ts.
#   nose / tail_tip / crown / belly / flank
#                         anchor Empties; the plugin measures
#                         ANGELFISH_ENVELOPE from these and refuses an asset
#                         that disagrees.
#
# THE BARS, because they are the one thing on this fish that is neither a
# hull nor a fin. The placement contract's halfWidth (0.085) is a BAR's outer
# face, 0.015 proud of a hull that is 0.07 across at its widest, and the
# install checks the `flank` anchor against it — so the bars cannot be paint.
# The procedural body hung two slabs through the hull. Here each bar is a
# LOCALLY THICKENED SECTION: the hull's surface function carries a bump —
# a raised cosine along the body over BAR_HALF_LENGTH_X and around the
# section over BAR_HALF_ARC, exactly BAR_PROUD at the bar's centre ring on
# the flank line and exactly zero at its rim — so the bar feathers into the
# body with no edge, no seam and nothing to float. Its faces are split off
# into their own mesh for the bar colour, the way build_eel.py splits the
# belly strip. The custom normals on those faces are the SMOOTH hull's, not
# the bump's: the bump is a silhouette fact (the flank anchor) and not a
# shading fact, which is what keeps the bars reading as markings rather than
# as ridges. Their colour footprint is a plain band, rim ring to rim ring and
# BAR_ARC_SEGMENTS either side of the flank line: a stepped lens outline was
# tried first (2026-09-04) and read as notches from the play camera.
#
# EVERY DIMENSION IS A NAMED CONSTANT IN GAME SPACE: x forward, y up, z
# lateral, one unit = one cell. `bl()` is the only place the Blender frame
# (x length, y beam, z up) is spoken.
#
# CHECKS IT PRINTS AND ASSERTS, because a model is a claim until measured:
#   * winding: every hull face agrees with an outward test from the axis;
#     every eye likewise from its centre.
#   * envelope: the anchor Empties equal the measured mesh extremes to 1e-9.
#   * attachment: NOTHING FLOATS — every non-hull part has vertices strictly
#     inside the hull's closed mesh, by odd ray-crossing parity (the same
#     test as plugins/wildlife/.verify-closed.mts, in Python).
#   * the bars: the front bar's centre-ring flank vertex IS the flank anchor;
#     every bar rim vertex sits ON the smooth hull (bump zero there).

import math
import os
import sys

import bpy

# export_glb.py holds this project's ONE export recipe.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_glb import bake_object_transforms, export_scene_glb  # noqa: E402

# ----------------------------------------------------------------- dimensions
# Game space (x forward, y up, z lateral), cells. The five envelope figures
# ARE plugins/wildlife/client/species/angelfish.ts's ANGELFISH_ENVELOPE; the
# install-time assertion there compares the anchors below against them.

#: The snout's pole vertex: the model's forward extreme and the envelope's front.
NOSE_X = 0.25
#: The peduncle: the tail hinge. The procedural body centred a 0.50 hull at
#: the origin, so its peduncle sat at -0.25 and its nose at +0.25.
PEDUNCLE_X = -0.25
#: The hull's own rounded aft end, a hair BEHIND the peduncle so the caudal
#: root is buried in solid body rather than butted against an end cap.
HULL_TAIL_X = -0.28
#: Behind the peduncle the caudal fin reaches this far back — to the
#: `tail_tip` anchor, so the envelope's length is 0.25 + 0.25 + 0.13 = 0.63.
CAUDAL_REACH = 0.13
TAIL_TIP_X = PEDUNCLE_X - CAUDAL_REACH
#: The dorsal tip: the envelope's crownY, the model's y max. The procedural
#: body derived it as its hull's half-height at x = -0.06 (Catmull-Rom width
#: and height-ratio profiles, whaleHull.ts profileFromPoints: 0.1237741...)
#: minus a 0.035 fin-seat bite plus a 0.24 dorsal peak; angelfish.ts keeps
#: that value as a full-precision literal and this is the same literal. The
#: dorsal here is BUILT to put a vertex at it.
CROWN_Y = 0.3287741112302734
#: The anal tip: the envelope's bellyY, the model's y min, derived the same
#: way (half-height at x = -0.05, 0.1302764..., minus the bite, minus 0.22).
BELLY_Y = -0.3152764129638672
#: A bar's outer face: the envelope's halfWidth and the `flank` anchor.
FLANK_Z = 0.085
#: The hull's widest half-width — under the bar, on the width plateau.
MAX_HALF_WIDTH = 0.07
#: How far a bar stands proud of the flank at its centre. Exactly what makes
#: the front bar's outermost vertex the flank anchor.
BAR_PROUD = FLANK_Z - MAX_HALF_WIDTH
#: The two bars' stations (the species sheet's), and half their length along
#: the body (the procedural slab's 0.035).
BAR_FRONT_X = 0.08
BAR_REAR_X = -0.10
BAR_XS = (BAR_FRONT_X, BAR_REAR_X)
BAR_HALF_LENGTH_X = 0.035
#: How far round the section a bar reaches from the flank line, in hull
#: SEGMENTS (so its top and bottom edges are vertex rows): 4 of 24 is 60
#: degrees, sin 60 = 0.866 of the hull's height — the sheet's "~0.88, crowns
#: and heels buried".
BAR_ARC_SEGMENTS = 4
#: Rings within a bar: the two rim rings (bump zero), two shoulders, the
#: centre. Odd, so the centre ring is sampled exactly.
BAR_RINGS = 5

HULL_LENGTH = NOSE_X - HULL_TAIL_X

#: Segments around a ring. Divisible by 4, so the exact top, bottom and both
#: flank lines are vertices; 24 so the bars' 60-degree reach is a vertex row.
HULL_SEGMENTS = 24
#: Ring stations (t = 0 at the nose, 1 at the hull's aft end) outside the
#: bars: the nose rounds off over NOSE_CAP_FRACTION sampled at NOSE_CAP_STEPS,
#: the body every RING_STEP, the aft end over TAIL_CAP_FRACTION.
NOSE_CAP_FRACTION = 0.10
NOSE_CAP_STEPS = (0.02, 0.045, 0.07, 0.10)
RING_STEP = 0.05
TAIL_CAP_FRACTION = 0.06
TAIL_CAP_STEPS = (0.955, 0.97, 0.985)
#: A body ring closer than this (in t) to a bar ring is dropped: a sliver
#: band between two rings 0.003 apart is a shading line for nothing.
MIN_RING_GAP = 0.02

#: Half-width along the body as a fraction of MAX_HALF_WIDTH, by station t:
#: a narrow snout, a PLATEAU under the front bar (t 0.24-0.40; the bar's five
#: rings all sit on it, so the bump alone shapes the bar), then the disc's
#: quick taper to a thin peduncle. Monotone cubic (no overshoot: the plateau
#: IS the maximum).
WIDTH_PROFILE = (
    (0.00, 0.50), (0.10, 0.82), (0.24, 1.00), (0.40, 1.00), (0.55, 0.90),
    (0.70, 0.68), (0.85, 0.42), (1.00, 0.24),
)
#: Height over width: the disc. Two and a half times its width at the crown
#: of the curve (2.6 at t 0.28, just ahead of the middle, as the procedural
#: body had it), a steep forehead, and a peduncle only a little taller than
#: it is wide.
HEIGHT_RATIO_PROFILE = (
    (0.00, 1.40), (0.12, 2.10), (0.28, 2.60), (0.42, 2.55), (0.58, 2.20),
    (0.72, 1.85), (0.86, 1.45), (1.00, 1.15),
)

#: How far a fin root is sunk into the hull: deeper than the faceting sagitta
#: of a 24-segment ring on a 0.18 half-height (0.0015) and of the ring
#: spacing along the back, so no hairline of daylight shows at a root.
FIN_SEAT_BITE = 0.012
#: Fin plate thickness: root half-thickness where a fin leaves the body, edge
#: half-thickness at every free edge (a lens section, not a plate).
FIN_ROOT_HALF_THICKNESS = 0.006
EDGE_HALF_THICKNESS = 0.002
#: Points sampled along each curved fin edge.
FIN_CURVE_SAMPLES = 8
#: Root stations sampled along the back (dorsal) and belly (anal), so the
#: root follows the hull rather than cutting a chord through it.
FIN_ROOT_SAMPLES = 6

#: The dorsal: the sail. Root from the nape back to the peduncle's shoulder,
#: peak (the crown) far aft, so the fin sweeps up and BACK the way a
#: Pterophyllum's does. Leading edge taut and slightly convex, trailing edge
#: falling steeply and a little hollow.
DORSAL_FRONT_X = 0.10
DORSAL_PEAK_X = -0.14
DORSAL_BACK_X = -0.21
DORSAL_LEAD_CONTROL = (-0.04, 0.29)
DORSAL_TRAIL_CONTROL = (-0.16, 0.11)
#: The anal fin: the sail's mirror, its front root a little further back
#: (behind the vent), its tip the belly.
ANAL_FRONT_X = 0.04
ANAL_DEEP_X = -0.13
ANAL_BACK_X = -0.21
ANAL_LEAD_CONTROL = (-0.05, -0.27)
ANAL_TRAIL_CONTROL = (-0.16, -0.10)

#: The caudal, authored with a = 0 AT THE HINGE (the tail Empty): a small
#: fork. Its root starts CAUDAL_ROOT_A forward of the hinge, buried in the
#: hull; the two lobe tips sit at -CAUDAL_REACH (x = TAIL_TIP_X) and
#: +-CAUDAL_HALF_SPAN; the notch between them at CAUDAL_NOTCH_A.
CAUDAL_ROOT_A = 0.05
CAUDAL_NOTCH_A = -0.07
CAUDAL_HALF_SPAN = 0.10
CAUDAL_LEAD_CONTROL = (-0.03, 0.05)
CAUDAL_NOTCH_CONTROL = (-0.11, 0.045)

#: Pectorals: small leaves between the bars. Hinge Empties at the flank root
#: at REST IDENTITY (flat in the XZ plane in the file); the 0.55 rad rest
#: dihedral is animation and lives in species/angelfish.ts, which assigns
#: the hinge's rotation outright — so they are NOT envelope extremes. Flat,
#: they reach past the flank anchor: the upper-bound case the install
#: allows. The leaf outline in the hinge's (along, out) plane is the
#: procedural body's: root from +0.02 to -0.04 along the flank, tip at
#: (-0.07, 0.07), a rounded root.
PECTORAL_X = 0.0
PECTORAL_Y = -0.04
#: The hinge sits this fraction of the local half-width out from the axis:
#: inside the flank, so the leaf's root is buried.
PECTORAL_SEAT_FRACTION = 0.8
PECTORAL_ROOT_FRONT_A = 0.02
PECTORAL_ROOT_BACK_A = -0.04
PECTORAL_TIP = (-0.07, 0.07)
PECTORAL_LEAD_CONTROL = (-0.01, 0.04)
PECTORAL_TRAIL_CONTROL = (-0.07, 0.03)
PECTORAL_CURVE_SAMPLES = 5
PECTORAL_ROOT_HALF_THICKNESS = 0.005

#: Eyes: small spheres on the head, ahead of the front bar, centres this
#: fraction of the local half-width out so they stand a little proud and are
#: otherwise buried.
EYE_X = 0.16
EYE_Y = 0.03
EYE_SEAT_FRACTION = 0.85
EYE_RADIUS = 0.02
EYE_SEGMENTS = 8
EYE_RINGS = 5

#: The mouth: a small line across the snout's underside, as a surface ridge
#: (inner lip sunk, crest raised). `theta` is the section angle (0 =
#: starboard flank, pi/2 = back, 3pi/2 = underside).
MOUTH_T = 0.03
MOUTH_HALF_ARC_RADIANS = 0.8
MOUTH_ARC_SAMPLES = 7
LINE_INNER_SCALE = 0.90
LINE_OUTER_SCALE = 1.012
#: Half the mouth line's width along the body, in cells.
LINE_HALF_WIDTH = 0.004

#: Colours, as the sRGB hexes the species file declares. THESE ARE sRGB AND
#: BLENDER'S BASE COLOR IS LINEAR — see srgb() below. The mouth line takes
#: the bar colour.
BODY_COLOR = 0xE8B83C
BAR_COLOR = 0x23232A
FIN_COLOR = 0xDFA838
EYE_COLOR = 0x141310

#: ONE roughness and ONE metalness across every material on this model.
#: rigSkin.ts's materialSignature keys on roughness and metalness but NOT on
#: colour, so four colours at one roughness bake to ONE surface — the draw
#: budget plugins/wildlife/client/index.ts asserts for the angelfish. 0.5 is
#: a wet, slightly glossy body.
SURFACE_ROUGHNESS = 0.5
SURFACE_METALNESS = 0.0

#: How far a numerically checked normal may disagree with the analytic winding
#: before the build fails. Zero would trip on float dust in a near-tangent face.
WINDING_TOLERANCE = 1e-12
#: How far a measured extreme may sit from its anchor. The install tolerates
#: ENVELOPE_TOLERANCE_WORLD_UNITS (0.01, species/assetSpecies.ts) to absorb
#: the float32 round trip; a BUILD is authored and has no round trip, so here
#: the extremes must be the anchors to float dust.
ANCHOR_TOLERANCE = 1e-9
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
    control points IS the maximum, exactly, so the flank read off the plateau
    is the true extreme. Chosen over piecewise-linear because a kink at every
    control point would be a ring of shading on a smooth disc.
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
            # A plateau is EXACTLY its value.
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
HEIGHT_RATIO = monotone_profile(HEIGHT_RATIO_PROFILE)


def cap_factor(t):
    """Rounds the sweep into closed caps at both ends (a quarter ellipse)."""
    if t < NOSE_CAP_FRACTION:
        return math.sqrt(max(0.0, 1.0 - (1.0 - t / NOSE_CAP_FRACTION) ** 2))
    if t > 1.0 - TAIL_CAP_FRACTION:
        s = (t - (1.0 - TAIL_CAP_FRACTION)) / TAIL_CAP_FRACTION
        return math.sqrt(max(0.0, 1.0 - s * s))
    return 1.0


def station_x(t):
    """Rig-space x of a body station t."""
    return NOSE_X - t * HULL_LENGTH


def station_t(x):
    """Body station of a rig-space x."""
    return (NOSE_X - x) / HULL_LENGTH


def half_width(t):
    return MAX_HALF_WIDTH * WIDTH(t) * cap_factor(t)


def half_height(t):
    return half_width(t) * HEIGHT_RATIO(t)


def smooth_point(t, theta, scale=1.0):
    """A point on (or scaled off) the SMOOTH hull, before the bars' bump.

    The section is one ellipse about the axis: theta = 0 is the starboard
    flank, pi/2 the back, pi the port flank, 3pi/2 the belly.
    """
    return (
        station_x(t),
        half_height(t) * math.sin(theta) * scale,
        half_width(t) * math.cos(theta) * scale,
    )


def smooth_normal(t, theta):
    """The outward unit normal of the SMOOTH hull at (t, theta).

    d/dtheta x d/dt: theta runs +z -> +y and t runs aft (-x), so at theta = 0
    the product is +y x -x = +z, which is outward on the starboard flank. On
    the width plateau at theta = 0 both partials are axis-aligned, so the
    normal there is exactly +z — which is what puts the bar's bump exactly on
    the flank anchor.
    """
    p_t0 = smooth_point(max(0.0, t - NORMAL_EPSILON), theta)
    p_t1 = smooth_point(min(1.0, t + NORMAL_EPSILON), theta)
    p_a0 = smooth_point(t, theta - NORMAL_EPSILON)
    p_a1 = smooth_point(t, theta + NORMAL_EPSILON)
    du = (p_t1[0] - p_t0[0], p_t1[1] - p_t0[1], p_t1[2] - p_t0[2])
    da = (p_a1[0] - p_a0[0], p_a1[1] - p_a0[1], p_a1[2] - p_a0[2])
    n = (
        da[1] * du[2] - da[2] * du[1],
        da[2] * du[0] - da[0] * du[2],
        da[0] * du[1] - da[1] * du[0],
    )
    length = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
    return (n[0] / length, n[1] / length, n[2] / length)


def raised_cosine(u):
    """1 at u = 0, exactly 0 at |u| >= 1, smooth between (zero slope at both)."""
    u = abs(u)
    if u >= 1.0:
        return 0.0
    return 0.5 * (1.0 + math.cos(math.pi * u))


def flank_distance(theta):
    """Angular distance from `theta` to the nearer flank line (0 or pi)."""
    wrapped = math.fmod(theta, 2 * math.pi)
    if wrapped < 0.0:
        wrapped += 2 * math.pi
    return min(wrapped, abs(wrapped - math.pi), 2 * math.pi - wrapped)


BAR_HALF_ARC = 2 * math.pi * BAR_ARC_SEGMENTS / HULL_SEGMENTS


def bar_bump(t, theta):
    """How far the hull stands proud of its smooth self at (t, theta): the
    bars' lens, BAR_PROUD at a bar's centre on the flank line, zero at its rim."""
    x = station_x(t)
    along = flank_distance(theta) / BAR_HALF_ARC
    total = 0.0
    for bar_x in BAR_XS:
        total += BAR_PROUD * raised_cosine((x - bar_x) / BAR_HALF_LENGTH_X) * raised_cosine(along)
    return total


def surface_point(t, theta, scale=1.0):
    """A point on the hull AS BUILT: the smooth section plus the bars' bump
    along the smooth normal. `scale` is a radial scale of the smooth section
    (the mouth line's lips), applied before the bump."""
    p = smooth_point(t, theta, scale)
    bump = bar_bump(t, theta)
    if bump == 0.0:
        return p
    n = smooth_normal(t, theta)
    return (p[0] + n[0] * bump, p[1] + n[1] * bump, p[2] + n[2] * bump)


def hull_top(x):
    """The back's height on the centreline at rig-space x."""
    return half_height(station_t(x))


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

    `ref` must be on the solid's axis inside it. This NEVER rewrites a face:
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
    hull's analytic normals, so the bars shade as the smooth hull does.
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
    # check_outward proves for the hull and the eyes.
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

def bar_ring_stations():
    """The five rings of each bar, as (t, bar index): rim, shoulder, centre,
    shoulder, rim — the centre EXACTLY at the bar's station."""
    out = []
    for index, bar_x in enumerate(BAR_XS):
        for k in range(BAR_RINGS):
            offset = BAR_HALF_LENGTH_X * (2.0 * k / (BAR_RINGS - 1) - 1.0)
            out.append((station_t(bar_x + offset), index))
    return out


def hull_stations():
    """Every ring station, nose to aft end, and which bar (if any) each ring
    belongs to: the bar rings, plus every body ring not crowding one."""
    bars = bar_ring_stations()
    body = list(NOSE_CAP_STEPS)
    k = 1
    while NOSE_CAP_FRACTION + k * RING_STEP < 1.0 - TAIL_CAP_FRACTION - 1e-9:
        body.append(NOSE_CAP_FRACTION + k * RING_STEP)
        k += 1
    body += list(TAIL_CAP_STEPS)
    stations = [(t, -1) for t in body if all(abs(t - bt) >= MIN_RING_GAP for bt, _ in bars)]
    stations += bars
    stations.sort()
    assert all(a[0] < b[0] for a, b in zip(stations, stations[1:])), 'rings out of order'
    return stations


def build_hull():
    """The disc: pole, one ring per station, pole; faces split body / bars.

    Returns GAME-space verts, the SMOOTH analytic normals (the bars shade as
    the hull they are part of), the body faces, one face list per bar side,
    and the ring bookkeeping the checks read. WINDING, derived then proved by
    check_outward: theta runs +z -> +y and successive rings run AFT (-x), so
    a face taken (this ring k) -> (this ring k+1) -> (next ring k+1) ->
    (next ring k) has its normal along +z at theta = 0, which is outward;
    the pole fans follow the same circulation.
    """
    stations = hull_stations()
    verts = [(NOSE_X, 0.0, 0.0)]
    normals = [(1.0, 0.0, 0.0)]
    ring_starts = []
    for t, _bar in stations:
        ring_starts.append(len(verts))
        for k in range(HULL_SEGMENTS):
            theta = 2 * math.pi * k / HULL_SEGMENTS
            verts.append(surface_point(t, theta))
            normals.append(smooth_normal(t, theta))
    pole_tail = len(verts)
    verts.append((HULL_TAIL_X, 0.0, 0.0))
    normals.append((-1.0, 0.0, 0.0))

    def bar_reach(ring_index):
        """How many segments either side of a flank line this ring's aft
        band paints: BAR_ARC_SEGMENTS between two rings of one bar, else none."""
        _t, bar = stations[ring_index]
        if bar < 0 or stations[ring_index + 1][1] != bar:
            return 0
        return BAR_ARC_SEGMENTS

    def bar_side(k, reach):
        """Which flank (starboard 0 / port 1) the face led by segment k
        paints, or -1. A face spans segments k..k+1; it is painted when both
        its leading and trailing vertex rows are within `reach` of the line."""
        if reach == 0:
            return -1
        for side, centre in ((0, 0), (1, HULL_SEGMENTS // 2)):
            lead = (k - centre) % HULL_SEGMENTS
            lead = min(lead, HULL_SEGMENTS - lead)
            trail = (k + 1 - centre) % HULL_SEGMENTS
            trail = min(trail, HULL_SEGMENTS - trail)
            if lead <= reach and trail <= reach:
                return side
        return -1

    body = []
    bars = [[[], []] for _ in BAR_XS]
    r0 = ring_starts[0]
    for k in range(HULL_SEGMENTS):
        k2 = (k + 1) % HULL_SEGMENTS
        body.append([0, r0 + k2, r0 + k])
    for r in range(len(ring_starts) - 1):
        cur, nxt = ring_starts[r], ring_starts[r + 1]
        reach = bar_reach(r)
        for k in range(HULL_SEGMENTS):
            k2 = (k + 1) % HULL_SEGMENTS
            face = [cur + k, cur + k2, nxt + k2, nxt + k]
            side = bar_side(k, reach)
            if side < 0:
                body.append(face)
            else:
                bars[stations[r][1]][side].append(face)
    rl = ring_starts[-1]
    for k in range(HULL_SEGMENTS):
        k2 = (k + 1) % HULL_SEGMENTS
        body.append([pole_tail, rl + k, rl + k2])
    return {
        'verts': verts, 'normals': normals, 'body': body, 'bars': bars,
        'ring_starts': ring_starts, 'stations': stations,
    }


def all_hull_faces(hull):
    faces = list(hull['body'])
    for sides in hull['bars']:
        for side in sides:
            faces += side
    return faces


# ------------------------------------------------------------------ the parts

def midline_to_game(a, b, off):
    # (a, b) = (x, y): x x y = +z, so off runs along +z.
    return (a, b, off)


def dorsal():
    """The sail, in the XY plane: root along the back, peak at CROWN_Y."""
    xs = [DORSAL_FRONT_X + (DORSAL_BACK_X - DORSAL_FRONT_X) * k / FIN_ROOT_SAMPLES
          for k in range(FIN_ROOT_SAMPLES + 1)]
    root = [(x, hull_top(x) - FIN_SEAT_BITE) for x in xs]
    peak = (DORSAL_PEAK_X, CROWN_Y)
    outline = [root[0]]
    outline += quad_bezier(root[0], DORSAL_LEAD_CONTROL, peak, FIN_CURVE_SAMPLES)
    outline += quad_bezier(peak, DORSAL_TRAIL_CONTROL, root[-1], FIN_CURVE_SAMPLES)
    outline += list(reversed(root[1:-1]))

    def half_at(a, b):
        seat = hull_top(a) - FIN_SEAT_BITE
        return lerp(FIN_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS, (b - seat) / (CROWN_Y - seat))
    return tapered_blade(outline, half_at, midline_to_game)


def anal():
    """The sail's mirror: root along the belly, deepest point at BELLY_Y."""
    xs = [ANAL_FRONT_X + (ANAL_BACK_X - ANAL_FRONT_X) * k / FIN_ROOT_SAMPLES
          for k in range(FIN_ROOT_SAMPLES + 1)]
    root = [(x, -hull_top(x) + FIN_SEAT_BITE) for x in xs]
    deep = (ANAL_DEEP_X, BELLY_Y)
    outline = [root[0]]
    outline += quad_bezier(root[0], ANAL_LEAD_CONTROL, deep, FIN_CURVE_SAMPLES)
    outline += quad_bezier(deep, ANAL_TRAIL_CONTROL, root[-1], FIN_CURVE_SAMPLES)
    outline += list(reversed(root[1:-1]))

    def half_at(a, b):
        seat = -hull_top(a) + FIN_SEAT_BITE
        return lerp(FIN_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS, (seat - b) / (seat - BELLY_Y))
    return tapered_blade(outline, half_at, midline_to_game)


def caudal():
    """The fork in the TAIL HINGE's (a along x, b up) plane, off = z."""
    root = (CAUDAL_ROOT_A, 0.0)
    top_tip = (-CAUDAL_REACH, CAUDAL_HALF_SPAN)
    notch = (CAUDAL_NOTCH_A, 0.0)
    bottom_tip = (-CAUDAL_REACH, -CAUDAL_HALF_SPAN)
    outline = [root]
    outline += quad_bezier(root, CAUDAL_LEAD_CONTROL, top_tip, FIN_CURVE_SAMPLES)
    outline += quad_bezier(top_tip, CAUDAL_NOTCH_CONTROL, notch, FIN_CURVE_SAMPLES)
    outline += quad_bezier(notch, (CAUDAL_NOTCH_CONTROL[0], -CAUDAL_NOTCH_CONTROL[1]),
                           bottom_tip, FIN_CURVE_SAMPLES)
    outline += quad_bezier(bottom_tip, (CAUDAL_LEAD_CONTROL[0], -CAUDAL_LEAD_CONTROL[1]),
                           root, FIN_CURVE_SAMPLES)[:-1]

    def half_at(a, _b):
        return lerp(FIN_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS,
                    (CAUDAL_ROOT_A - a) / (CAUDAL_ROOT_A + CAUDAL_REACH))
    return tapered_blade(outline, half_at, midline_to_game)


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
        # so the offset runs along -side*y — a right-handed basis.
        return (a, -side * off, side * b)
    return tapered_blade(pectoral_outline(), half_at, to_game)


def mouth():
    """The mouth line: a surface ridge across the snout's underside.

    Three vertices per station — inner lip forward, raised crest, inner lip
    aft — banded into a closed solid whose floor sits under the surface.
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


def check_attachment(shell, parts):
    """NOTHING FLOATS: every part has vertices strictly inside the hull.

    Bounds overlap is not enough — two shapes can share a bounding box and
    never touch — so this is the odd-crossing parity test the owner requires
    (plugins/wildlife/.verify-closed.mts), against the hull's closed mesh.
    """
    print('  attachment (vertices strictly inside the hull):')
    floating = []
    for name, verts in parts:
        inside = sum(1 for v in verts if ray_hits(v, shell) % 2 == 1)
        state = f'{inside}/{len(verts)} inside' if inside else 'FLOATING'
        print(f'    {name:20} {state}')
        if inside == 0:
            floating.append(name)
    assert not floating, f'parts float free of the hull: {floating}'


def check_bars(hull):
    """The bars are the hull: the front bar's centre flank vertex is the
    flank anchor, every rim ring lies on the smooth hull, and nothing on the
    rear bar reaches the front bar's face."""
    stations = hull['stations']
    verts = hull['verts']
    print('  bars:')
    for index, bar_x in enumerate(BAR_XS):
        rings = [r for r, (_t, bar) in enumerate(stations) if bar == index]
        assert len(rings) == BAR_RINGS
        centre = hull['ring_starts'][rings[BAR_RINGS // 2]]
        starboard = verts[centre]
        port = verts[centre + HULL_SEGMENTS // 2]
        proud = abs(starboard[2]) - half_width(stations[rings[BAR_RINGS // 2]][0])
        rim_off = 0.0
        for r in (rings[0], rings[-1]):
            t = stations[r][0]
            start = hull['ring_starts'][r]
            for k in range(HULL_SEGMENTS):
                theta = 2 * math.pi * k / HULL_SEGMENTS
                p, s = verts[start + k], smooth_point(t, theta)
                rim_off = max(rim_off, math.dist(p, s))
        print(f'    bar {index} at x {bar_x:+.3f}: centre flank z {starboard[2]:+.6f} / '
              f'{port[2]:+.6f}, {proud:.4f} proud of the hull; rim rings off the smooth '
              f'hull by {rim_off:.2e}; {sum(len(s) for s in hull["bars"][index])} faces')
        assert rim_off < ANCHOR_TOLERANCE, f'bar {index}: rim leaves the smooth hull'
        assert abs(starboard[2] + port[2]) < ANCHOR_TOLERANCE, f'bar {index}: not mirrored'
    front_centre = hull['ring_starts'][
        [r for r, (_t, bar) in enumerate(stations) if bar == 0][BAR_RINGS // 2]]
    assert abs(verts[front_centre][2] - FLANK_Z) < ANCHOR_TOLERANCE, (
        f'front bar face {verts[front_centre][2]} is not the flank anchor {FLANK_Z}')


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
        ('flank', span_z, FLANK_Z),
    ):
        print(f'    {label:9} {measured:+.6f} vs {declared:+.6f}  '
              f'(off by {abs(measured - declared):.7f})')
        assert abs(measured - declared) < ANCHOR_TOLERANCE, (
            f'{label}: measured {measured:.4f}, anchor says {declared:.4f}')
    hull_top_max = max(v[1] for v in hull_verts)
    hull_bottom_min = min(v[1] for v in hull_verts)
    print(f'    hull back tops out at {hull_top_max:+.4f}, {CROWN_Y - hull_top_max:.4f} under the '
          f'crown; belly line {hull_bottom_min:+.4f}, {hull_bottom_min - BELLY_Y:.4f} above the belly')
    reach_z = max(abs(v[2]) for v in all_verts)
    print(f'    widest thing on the model {reach_z:.4f} (the flat pectorals; flank is the front '
          f'bar\'s face, the upper-bound case the install allows)')
    print(f'    length {max_x - min_x:.4f}, halfLength {(max_x - min_x) / 2:.4f}')


# ------------------------------------------------------------------ the build

def add_part(name, verts, faces, material, joint, smooth, flat_faces=(), normals=None):
    """A mesh authored in the frame of `joint` (the rig, or a hinge whose
    blade is authored about it), hung under it."""
    obj = make_object(name, verts, faces, smooth, flat_faces, normals)
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

    body_material = flat_material('angelfish_body', srgb(BODY_COLOR))
    bar_material = flat_material('angelfish_bar', srgb(BAR_COLOR))
    fin_material = flat_material('angelfish_fin', srgb(FIN_COLOR))
    eye_material = flat_material('angelfish_eye', srgb(EYE_COLOR))

    print('angelfish build:')

    # ---- the rig root: every part of the fish hangs under it ----
    rig = make_empty('rig', (0.0, 0.0, 0.0))

    # ---- the hull, its bars split off by colour ----
    hull = build_hull()
    hull_faces = all_hull_faces(hull)
    print(f'  hull: {len(hull["stations"])} rings x {HULL_SEGMENTS} segments')
    # The axis midpoint is inside the disc, and the disc is star-shaped about
    # its axis (the bars' bumps are outward along the normal), so this
    # reference is valid.
    check_outward('hull', hull['verts'], hull_faces, ((NOSE_X + HULL_TAIL_X) / 2, 0.0, 0.0))
    body_v, body_n, body_f = compact(hull['verts'], hull['normals'], hull['body'])
    add_part('body', body_v, body_f, body_material, rig, smooth=True, normals=body_n)
    for index, name in enumerate(('bar_front', 'bar_rear')):
        for side, sides in (('starboard', 0), ('port', 1)):
            v, n, f = compact(hull['verts'], hull['normals'], hull['bars'][index][sides])
            add_part(f'{name}_{side}', v, f, bar_material, rig, smooth=True, normals=n)
    check_bars(hull)
    shell = triangulate(hull['verts'], hull_faces)

    parts = []

    # ---- midline fins ----
    for name, (verts, faces, caps) in (('dorsal', dorsal()), ('anal', anal())):
        add_part(name, verts, faces, fin_material, rig, True, blade_flat_faces(faces, caps))
        parts.append((name, verts))

    # ---- the tail hinge, AT THE PEDUNCLE; the caudal under it ----
    tail = make_empty('tail', (PEDUNCLE_X, 0.0, 0.0))
    parent_to(tail, rig)
    caudal_local, faces, caps = caudal()
    add_part('caudal', caudal_local, faces, fin_material, tail, True, blade_flat_faces(faces, caps))
    parts.append(('caudal', [(a + PEDUNCLE_X, b, c) for a, b, c in caudal_local]))

    # ---- pectoral hinges (identity, flat) and leaves ----
    seat_z = PECTORAL_SEAT_FRACTION * half_width(station_t(PECTORAL_X))
    # Right-handed frame with +X forward and +Y up puts PORT at -Z
    # (left = up x forward = Y x X = -Z), which is the sign angelfish.ts drives.
    for name, side in (('pectoral_port', -1.0), ('pectoral_starboard', 1.0)):
        hinge_world = (PECTORAL_X, PECTORAL_Y, side * seat_z)
        hinge = make_empty(name, hinge_world)
        parent_to(hinge, rig)
        blade_local, faces, caps = pectoral_blade(side)
        add_part(f'{name}_blade', blade_local, faces, fin_material, hinge, True,
                 blade_flat_faces(faces, caps))
        parts.append((name, [(a + hinge_world[0], b + hinge_world[1], c + hinge_world[2])
                             for a, b, c in blade_local]))

    # ---- eyes ----
    eye_z = EYE_SEAT_FRACTION * half_width(station_t(EYE_X))
    for name, side in (('eye_port', -1.0), ('eye_starboard', 1.0)):
        centre = (EYE_X, EYE_Y, side * eye_z)
        verts, faces = uv_sphere(centre, EYE_RADIUS, EYE_SEGMENTS, EYE_RINGS)
        check_outward(name, verts, faces, centre)
        add_part(name, verts, faces, eye_material, rig, smooth=True)
        parts.append((name, verts))

    # ---- the mouth line ----
    verts, faces = mouth()
    add_part('mouth', verts, faces, bar_material, rig, smooth=False)
    parts.append(('mouth', verts))

    # ---- checks, on the GAME-space vertices the parts were authored from ----
    check_attachment(shell, parts)
    all_verts = list(hull['verts'])
    for _name, verts in parts:
        all_verts.extend(verts)
    check_envelope(all_verts, hull['verts'])

    # ---- anchors: what the plugin measures ANGELFISH_ENVELOPE from ----
    make_empty('nose', (NOSE_X, 0.0, 0.0))
    make_empty('tail_tip', (TAIL_TIP_X, 0.0, 0.0))
    make_empty('crown', (DORSAL_PEAK_X, CROWN_Y, 0.0))
    make_empty('belly', (ANAL_DEEP_X, BELLY_Y, 0.0))
    # The front bar's outer face on the flank line — the envelope's halfWidth
    # is a BAR's face, as the procedural body declared it; the flat pectorals
    # reach further and are checked as an upper bound only.
    make_empty('flank', (BAR_FRONT_X, 0.0, FLANK_Z))

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
    print(f'angelfish -> {out_path}: {total_tris} tris total')


main()
