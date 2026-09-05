# build_deepsea.py — builds the Terrace deep-sea anglerfish in Blender and
# exports it.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_deepsea.py -- \
#     E:\...\Terrace\plugins\wildlife\client\assets\deepsea.glb
#
# WHAT IT BUILDS (docs/model-assets.md is the convention this satisfies, and
# its "Wildlife species" section the joint convention). Pass 9 of the
# fish+whales arc — the last procedural swimmer, and the only one with an
# UNLIT part. build_angelfish.py is the pattern (one hull, tapered blades,
# the asserted checks); build_sperm_whale.py the absolute top/bottom lines.
#
# A Melanocetus (humpback anglerfish):
#   rig                   Empty at the origin; the whole body hangs under it.
#     body                the globular hull: a swept section with ABSOLUTE
#                         back and belly lines (TOP_PROFILE / BOTTOM_PROFILE)
#                         and a width line, so the belly plateau IS the
#                         envelope's BELLY (-0.35) and the width plateau IS
#                         the FLANK (0.275). Blunt-fronted: the whole front is
#                         mouth. Smooth-shaded.
#     jaw                 the lower jaw: a tube swept along an arc from the
#                         throat (buried in the hull) forward and UP to the
#                         tip at x +0.50 — the envelope's NOSE — lined with
#                         two rows of long needle teeth (thin cones, part of
#                         this mesh). A rigid body part, no joint.
#     upper_teeth         needle cones hanging from the snout's underside,
#                         their bases sunk into the hull.
#     dorsal              a small rounded fin on the back; its tip is the
#                         envelope's CROWN (+0.35) — a BODY extreme at rest,
#                         never the lure.
#     anal, pectoral_port / pectoral_starboard
#                         small rounded fins with root thickness; the
#                         pectorals droop PECTORAL_DROOP_RADIANS. Rigid.
#     caudal              a short rounded fan on a stubby peduncle; its rear
#                         vertex is the TAIL_TIP (-0.50). Rigid: the species
#                         sways as a whole (species/deepsea.ts), no tail joint.
#     eye_port / eye_starboard
#                         tiny spheres seated in the head.
#     stalk               the illicium: a thin tube rising from the snout and
#                         arching forward to the esca. BODY geometry under
#                         `rig`; its tip ends at the bulb's CENTRE.
#     lure                Empty at LURE_REST (identity rotation); the joint
#                         species/deepsea.ts bobs in position.y by +-0.05.
#       lure_bulb         the esca: a sphere about the joint, UNLIT
#                         (KHR_materials_unlit -> MeshBasicMaterial in three).
#   nose / tail_tip / crown / belly / flank
#                         anchor Empties; the plugin measures DEEPSEA_ENVELOPE
#                         from these and refuses an asset that disagrees.
#
# WHY THE BULB ALONE HANGS UNDER `lure` (the species sheet's "pick the one
# that does not float at +-0.05 and say why"). The stalk's tip ends at the
# bulb's centre and the bulb's radius (LURE_RADIUS 0.06) exceeds the bob
# (LURE_BOB 0.05), so at either extreme the tip is still 0.01 inside the
# sphere — check_lure_bob PROVES it by parity at rest and at both extremes.
# Hinging stalk + bulb together would translate the stalk's ROOT by 0.05, and
# the root is sunk only STALK_BASE_SINK 0.04 into the hull: it would float.
#
# THE ONE UNLIT MATERIAL. The lure's material is a Background shader wired
# straight to the Material Output: that is what Blender's glTF exporter
# writes as KHR_materials_unlit with the colour as baseColorFactor (probed in
# Blender 5.2.1, 2026-09-05 — an Emission shader does NOT: it exports as an
# emissiveFactor on a black lit material). three's GLTFLoader turns the
# extension into a MeshBasicMaterial, so rigSkin's materialSignature (keyed
# on material.type) bakes the anglerfish to exactly TWO surfaces — the count
# plugins/wildlife/client/index.ts asserts for it. Every other material here
# is a Principled BSDF at ONE roughness, so they bake to the other surface.
#
# EVERY DIMENSION IS A NAMED CONSTANT IN GAME SPACE: x forward, y up, z
# lateral, one unit = one cell. `bl()` is the only place the Blender frame
# (x length, y beam, z up) is spoken.
#
# CHECKS IT PRINTS AND ASSERTS, because a model is a claim until measured:
#   * winding: every hull, tube, cone and eye face agrees with an outward test.
#   * envelope: the anchor Empties equal the measured mesh extremes to 1e-9;
#     the crown is the dorsal (the stalk and the bulb's bob stay under it);
#     the belly is the hull (the jaw, anal fin and pectorals stay above it).
#   * attachment: NOTHING FLOATS — every non-hull part has vertices strictly
#     inside the hull's closed mesh, by odd ray-crossing parity (the same test
#     as plugins/wildlife/.verify-closed.mts, in Python); the stalk's tip has
#     vertices inside the bulb at rest and at both bob extremes.
#   * the lure bob: bulb top at rest + LURE_BOB <= CROWN_Y.

import math
import os
import sys

import bpy

# export_glb.py holds this project's ONE export recipe.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_glb import bake_object_transforms, export_scene_glb  # noqa: E402

# ----------------------------------------------------------------- dimensions
# Game space (x forward, y up, z lateral), cells. The five envelope figures
# ARE plugins/wildlife/client/species/deepsea.ts's DEEPSEA_ENVELOPE; the
# install-time assertion there compares the anchors below against them.

#: The lower jaw's tip: the model's forward extreme and the envelope's nose.
#: Placement's hand-set SWIM_PROFILES.deepsea halfLength is 0.5; the file
#: measures the same, so the two agree without either reading the other.
NOSE_X = 0.50
#: The caudal fan's rear vertex: the envelope's tail_tip.
TAIL_TIP_X = -0.50
#: The dorsal fin's tip: the envelope's crownY and the model's y max. The
#: procedural body's declared crown (models.ts DEEPSEA_ENVELOPE, the
#: BODY_COLUMNS contract) — a BODY extreme, authored at rest.
CROWN_Y = 0.35
#: The hull's belly plateau: the envelope's bellyY and the model's y min —
#: the throat under the huge mouth, the deepest point of a Melanocetus.
BELLY_Y = -0.35
#: The hull's widest half-width: the envelope's halfWidth and the `flank`
#: anchor. The procedural body's ellipsoid measured 0.275 (0.55 across).
FLANK_Z = 0.275

#: The hull runs from the snout (the upper jaw's front) to the aft end of the
#: peduncle. Symmetric about the origin so the body's mass is centred where
#: the procedural ellipsoid's was.
HULL_NOSE_X = 0.36
HULL_TAIL_X = -0.36
HULL_LENGTH = HULL_NOSE_X - HULL_TAIL_X

#: Segments around a ring. Divisible by 4, so the exact top, bottom and both
#: flank lines are vertices.
HULL_SEGMENTS = 20
#: Ring stations (t = 0 at the snout, 1 at the aft end): the snout rounds off
#: over NOSE_CAP_FRACTION sampled at NOSE_CAP_STEPS, the body every
#: RING_STEP, the aft end over TAIL_CAP_FRACTION at TAIL_CAP_STEPS. 0.04 puts
#: rings EXACTLY at BELLY_T (0.28) and FLANK_T (0.40) — asserted.
NOSE_CAP_FRACTION = 0.12
NOSE_CAP_STEPS = (0.015, 0.035, 0.06, 0.09, 0.12)
RING_STEP = 0.04
TAIL_CAP_FRACTION = 0.10
TAIL_CAP_STEPS = (0.92, 0.95, 0.975, 0.99)
#: The snout cap's bluntness: a superellipse power. 2 is a round dome; 3
#: holds most of the section out to the front so the whole front reads as
#: mouth (the sperm whale's wall uses 4).
NOSE_CAP_POWER = 3.0

#: The back, as ABSOLUTE y by station: a high snout, a crest just ahead of
#: the middle, a steady fall to a low peduncle. Monotone cubic, so the
#: plateau is exact and nothing overshoots.
TOP_PROFILE = (
    (0.00, 0.12), (0.06, 0.20), (0.15, 0.27), (0.30, 0.31), (0.42, 0.31),
    (0.55, 0.28), (0.70, 0.20), (0.85, 0.11), (1.00, 0.05),
)
#: The belly, ABSOLUTE y by station: a deep throat plateauing at BELLY_Y over
#: t 0.20-0.35 (the ring at BELLY_T samples it exactly), rising to the
#: peduncle behind.
BOTTOM_PROFILE = (
    (0.00, -0.04), (0.06, -0.16), (0.12, -0.27), (0.20, -0.35), (0.35, -0.35),
    (0.50, -0.31), (0.65, -0.22), (0.80, -0.12), (1.00, -0.04),
)
#: Half-width by station, ABSOLUTE: a plateau at FLANK_Z over t 0.35-0.45
#: (the ring at FLANK_T samples it exactly), the globular head ahead of it,
#: the quick taper to a stubby peduncle behind.
WIDTH_PROFILE = (
    (0.00, 0.10), (0.08, 0.19), (0.20, 0.25), (0.35, FLANK_Z), (0.45, FLANK_Z),
    (0.60, 0.22), (0.75, 0.14), (0.90, 0.07), (1.00, 0.04),
)
#: The ring stations that carry the belly and flank anchors — on their
#: plateaus, so the sampled mesh is the profile's exact value there.
BELLY_T = 0.28
FLANK_T = 0.40

#: The lower jaw: a tube along a quadratic arc from the throat (its root,
#: inside the hull) through a low forward control to the upturned tip at the
#: nose. Elliptical sections, wider than tall, tapering to the tip.
JAW_ROOT = (0.16, -0.24)
JAW_CONTROL = (0.40, -0.30)
JAW_TIP = (NOSE_X, -0.02)
JAW_ROOT_HALF_WIDTH = 0.11
JAW_ROOT_HALF_HEIGHT = 0.05
JAW_TIP_HALF_WIDTH = 0.035
JAW_TIP_HALF_HEIGHT = 0.03
JAW_RINGS = 10
JAW_SEGMENTS = 12
#: The tip narrows to a point over the last fraction of the arc, on a sine
#: ease (smooth at the join). The sections lean FORWARD where the arc turns
#: up, so a full-size ring near the tip would reach past the nose anchor; a
#: pointed tip puts the arc's end vertex — the anchor — at the front.
JAW_TIP_TAPER_FRACTION = 0.3
#: The jaw's underside must stay this far above the belly plateau: the hull,
#: not a rod, is the envelope's lowest point. Asserted.
JAW_ABOVE_BELLY = 0.02

#: Teeth: thin cones. The lower row rises from the jaw's top surface along
#: its length in two rows either side of the midline, leaning back; the
#: upper row hangs from the snout's underside, leaning forward. Long needles
#: at the front, shorter aft. TOOTH_SINK is how far a base centre sits under
#: the surface it grows from, so the base ring is buried.
TOOTH_RADIUS = 0.011
TOOTH_SEGMENTS = 5
LOWER_TOOTH_STATIONS = (0.32, 0.44, 0.56, 0.68, 0.78, 0.86)
LOWER_TOOTH_LENGTHS = (0.13, 0.13, 0.12, 0.11, 0.10, 0.08)
LOWER_TOOTH_ROW_FRACTION = 0.55
LOWER_TOOTH_DIRECTION = (-0.25, 1.0, 0.0)
LOWER_TOOTH_SINK_FRACTION = 0.75
UPPER_TOOTH_STATIONS = (0.04, 0.08, 0.12)
UPPER_TOOTH_LENGTHS = (0.10, 0.11, 0.10)
UPPER_TOOTH_HALF_ARC_RADIANS = 0.35
UPPER_TOOTH_DIRECTION = (0.15, -1.0, 0.0)
UPPER_TOOTH_SINK_SCALE = 0.85

#: How far a fin root is sunk into the hull: deeper than the faceting sagitta
#: of a 20-segment ring on a 0.3 half-height (0.004) and of the ring spacing
#: along the back, so no hairline of daylight shows at a root.
FIN_SEAT_BITE = 0.015
#: Fin plate thickness: root half-thickness where a fin leaves the body, edge
#: half-thickness at every free edge (a lens section, not a plate).
FIN_ROOT_HALF_THICKNESS = 0.012
EDGE_HALF_THICKNESS = 0.003
#: Points sampled along each curved fin edge; root stations along the hull.
FIN_CURVE_SAMPLES = 6
FIN_ROOT_SAMPLES = 5

#: The dorsal: a small rounded fin, root on the back, peak at the crown.
DORSAL_FRONT_X = -0.02
DORSAL_PEAK_X = -0.09
DORSAL_BACK_X = -0.17
DORSAL_LEAD_CONTROL = (-0.05, 0.345)
DORSAL_TRAIL_CONTROL = (-0.15, 0.32)
#: The anal fin: smaller, under the belly line behind the plateau; its tip
#: stays ANAL_TIP_Y, well above the belly (asserted).
ANAL_FRONT_X = -0.06
ANAL_DEEP_X = -0.12
ANAL_BACK_X = -0.18
ANAL_TIP_Y = -0.28
ANAL_LEAD_CONTROL = (-0.08, -0.275)
ANAL_TRAIL_CONTROL = (-0.16, -0.26)

#: The caudal fan, in the XY plane: root buried in the hull ahead of the
#: aft end, two rounded lobes, a rear vertex exactly at TAIL_TIP_X. The rear
#: controls sit AT TAIL_TIP_X so the curve is a convex combination of points
#: no further back than the tip — it cannot overshoot the anchor.
CAUDAL_ROOT_X = -0.28
CAUDAL_ROOT_HALF_HEIGHT = 0.04
CAUDAL_LOBE = (-0.47, 0.11)
CAUDAL_LOBE_CONTROL = (-0.40, 0.13)
CAUDAL_REAR_CONTROL = (TAIL_TIP_X, 0.07)

#: Pectorals: small rounded paddles at the flank, seated inside the hull
#: (PECTORAL_SEAT_FRACTION of the local half-width out from the axis) and
#: drooping PECTORAL_DROOP_RADIANS from horizontal. Rigid, no hinge — the
#: species has no fin animation. Their tips reach past the flank anchor: the
#: upper-bound case the install allows.
PECTORAL_X = 0.02
PECTORAL_Y = -0.12
PECTORAL_SEAT_FRACTION = 0.8
PECTORAL_DROOP_RADIANS = 0.35
PECTORAL_ROOT_FRONT_A = 0.03
PECTORAL_ROOT_BACK_A = -0.05
PECTORAL_TIP = (-0.07, 0.10)
PECTORAL_LEAD_CONTROL = (0.02, 0.07)
PECTORAL_TRAIL_CONTROL = (-0.09, 0.05)
PECTORAL_CURVE_SAMPLES = 5

#: Eyes: tiny spheres seated in the head, EYE_SEAT_SCALE of the way out along
#: the section at (EYE_T, EYE_THETA) — mostly buried, a little proud.
EYE_T = 0.14
EYE_THETA = 0.6
EYE_SEAT_SCALE = 0.92
EYE_RADIUS = 0.02
EYE_SEGMENTS = 8
EYE_RINGS = 5

#: The illicium: a thin tube along a quadratic arc from a base sunk
#: STALK_BASE_SINK under the back at STALK_BASE_X, over an arch, to the
#: bulb's centre. Its arch stays STALK_BELOW_CROWN under the crown (asserted).
STALK_BASE_X = 0.22
STALK_BASE_SINK = 0.04
STALK_CONTROL = (0.33, 0.38)
STALK_RADIUS = 0.012
STALK_RINGS = 12
STALK_SEGMENTS = 6
STALK_BELOW_CROWN = 0.02

#: The esca: the `lure` joint's rest position and the bulb's radius. The
#: species bobs the joint +-LURE_BOB in y (species/deepsea.ts
#: DEEPSEA_LURE_BOB — the same number, restated here only for the check):
#: top at rest 0.29, at the top of the bob 0.34, under the crown. Its x
#: extent (0.48) stays behind the nose (0.50). Radius > bob, which is what
#: keeps the stalk's tip inside it (header).
LURE_REST = (0.42, 0.23, 0.0)
LURE_RADIUS = 0.06
LURE_BOB = 0.05
LURE_SEGMENTS = 12
LURE_RINGS = 8

#: Colours, as the sRGB hexes the species file declares. THESE ARE sRGB AND
#: BLENDER'S BASE COLOR IS LINEAR — see srgb() below. Body and fins near-
#: black; ONE very dark tone for teeth and eyes (a shade paler, so the
#: needles read against the body); the lure the one bright thing, unlit.
BODY_COLOR = 0x161C26
DETAIL_COLOR = 0x3A4150
LURE_COLOR = 0xA8FBFF

#: ONE roughness and ONE metalness across every LIT material on this model.
#: rigSkin.ts's materialSignature keys on roughness and metalness but NOT on
#: colour, so the body and detail colours bake to ONE surface; the unlit lure
#: is a different material.type and is the second — exactly the two
#: plugins/wildlife/client/index.ts asserts for the deepsea herd.
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
#: Step for the finite-difference curve tangents.
TANGENT_EPSILON = 1e-5


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
    control points IS the extreme, exactly, so the belly and flank read off
    their plateaus are the true extremes.
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


TOP = monotone_profile(TOP_PROFILE)
BOTTOM = monotone_profile(BOTTOM_PROFILE)
WIDTH = monotone_profile(WIDTH_PROFILE)


def cap_factor(t):
    """Closes the sweep at both ends: a blunt superellipse at the snout (the
    mouth spans the front), a quarter circle at the tail."""
    if t < NOSE_CAP_FRACTION:
        s = 1.0 - t / NOSE_CAP_FRACTION
        return (max(0.0, 1.0 - s ** NOSE_CAP_POWER)) ** (1.0 / NOSE_CAP_POWER)
    if t > 1.0 - TAIL_CAP_FRACTION:
        s = (t - (1.0 - TAIL_CAP_FRACTION)) / TAIL_CAP_FRACTION
        return math.sqrt(max(0.0, 1.0 - s * s))
    return 1.0


def station_x(t):
    """Rig-space x of a body station t."""
    return HULL_NOSE_X - t * HULL_LENGTH


def station_t(x):
    """Body station of a rig-space x."""
    return (HULL_NOSE_X - x) / HULL_LENGTH


def mid_y(t):
    """The section's centre height: halfway between back and belly."""
    return (TOP(t) + BOTTOM(t)) / 2


def half_width(t):
    return WIDTH(t) * cap_factor(t)


def surface_point(t, theta, scale=1.0):
    """A point on (or scaled off) the hull.

    The section is two half-ellipses on a common width, the upper reaching
    TOP(t) and the lower BOTTOM(t): theta = 0 is the starboard flank, pi/2
    the back, pi the port flank, 3pi/2 the belly. Both halves close under the
    same cap factor.
    """
    mid = mid_y(t)
    s = math.sin(theta)
    half_height = (TOP(t) - mid) if s >= 0.0 else (mid - BOTTOM(t))
    return (
        station_x(t),
        mid + half_height * cap_factor(t) * s * scale,
        half_width(t) * math.cos(theta) * scale,
    )


def hull_top(x):
    """The back's height on the centreline at rig-space x."""
    return surface_point(station_t(x), math.pi / 2)[1]


def hull_bottom(x):
    """The belly's height on the centreline at rig-space x."""
    return surface_point(station_t(x), 3 * math.pi / 2)[1]


def hull_axis_point(x):
    """The point on the hull's own axis at rig-space x — inside the hull, the
    reference an outward test on a section face is taken from."""
    return (x, mid_y(station_t(x)), 0.0)


# --------------------------------------------------------------- mesh helpers

def face_normal(a, b, c):
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    return (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )


def check_outward(name, verts, faces, ref_of):
    """Assert the analytic winding agrees with an outward test.

    `ref_of(centroid)` gives a point inside the solid on its local axis. This
    NEVER rewrites a face: the winding is derived, and a disagreement is a
    bug in the derivation.
    """
    wrong = 0
    for face in faces:
        normal = face_normal(verts[face[0]], verts[face[1]], verts[face[2]])
        centroid = (
            sum(verts[i][0] for i in face) / len(face),
            sum(verts[i][1] for i in face) / len(face),
            sum(verts[i][2] for i in face) / len(face),
        )
        ref = ref_of(centroid)
        away = (centroid[0] - ref[0], centroid[1] - ref[1], centroid[2] - ref[2])
        dot = normal[0] * away[0] + normal[1] * away[1] + normal[2] * away[2]
        if dot < -WINDING_TOLERANCE:
            wrong += 1
    print(f'  winding {name}: {len(faces)} faces, {wrong} inward')
    assert wrong == 0, f'{name}: {wrong} faces wound inward'


def make_object(name, verts, faces, smooth, flat_faces=()):
    """A Blender mesh object from GAME-space verts (converted here, once).

    `smooth` shades every face smooth; the face indices in `flat_faces` are
    then set flat.
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
    # check_outward proves for every closed solid here.
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
    """An sRGB hex -> the LINEAR RGBA Blender's colour sockets expect.

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


def unlit_material(name, color):
    """A Background shader on the Material Output: what the glTF exporter
    writes as KHR_materials_unlit (see the header)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.remove(tree.nodes['Principled BSDF'])
    background = tree.nodes.new('ShaderNodeBackground')
    background.inputs['Color'].default_value = color
    tree.links.new(background.outputs['Background'], tree.nodes['Material Output'].inputs['Surface'])
    return mat


def quad_bezier_at(p0, p1, p2, t):
    s = 1.0 - t
    return tuple(s * s * a + 2 * s * t * b + t * t * c for a, b, c in zip(p0, p1, p2))


def quad_bezier(p0, p1, p2, samples):
    """Points ALONG a quadratic curve, p0 excluded, p2 included."""
    return [quad_bezier_at(p0, p1, p2, k / samples) for k in range(1, samples + 1)]


def lerp(a, b, s):
    return a + (b - a) * min(1.0, max(0.0, s))


def normalised(v):
    length = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    return (v[0] / length, v[1] / length, v[2] / length)


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def add(a, b, scale=1.0):
    return (a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale)


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


def arc_tube(p0, p1, p2, half_width_at, half_height_at, rings, segments, tip_pole):
    """A tube swept along the planar (XY) quadratic arc p0 -> p2 with an
    elliptical section (z half-width, in-plane half-height) at each of
    `rings` stations, capped at the root by a fan and at the tip by a pole
    vertex at p2 (`tip_pole` True; the rings then stop one step short of it)
    or by a fan on the last ring (at p2).

    WINDING, derived then proved by check_outward: the in-plane section
    normal is n = z x T (T the forward tangent); phi runs +z -> +n. A face
    (this ring k) -> (next ring k) -> (next ring k+1) -> (this ring k+1) has
    normal (T) x (d/dphi) = T x n = T x (z x T) = z(T.T) - T(T.z) = +z at
    phi = 0, which is outward on the starboard flank. Around a ring, k -> k+1
    is counter-clockwise in the (z, n) plane whose normal is z x n = -T: so
    the ROOT cap fans (centre, k, k+1) to face -T and the TIP fans
    (tip, k+1, k) to face +T. Returns game-space verts, faces and the arc's
    INTERIOR centre points (the outward reference; the end centres are
    dropped because a cap's reference must not lie in the cap's own plane,
    where the test would pass trivially).
    """
    verts = []
    faces = []
    centres = []
    ring_starts = []
    for r in range(rings):
        s = r / rings if tip_pole else r / (rings - 1)
        centre = quad_bezier_at(p0, p1, p2, s)
        ahead = quad_bezier_at(p0, p1, p2, min(1.0, s + TANGENT_EPSILON))
        behind = quad_bezier_at(p0, p1, p2, max(0.0, s - TANGENT_EPSILON))
        tangent = normalised((ahead[0] - behind[0], ahead[1] - behind[1], 0.0))
        normal = cross((0.0, 0.0, 1.0), tangent)
        centres.append((centre[0], centre[1], 0.0))
        ring_starts.append(len(verts))
        w, h = half_width_at(s), half_height_at(s)
        for k in range(segments):
            phi = 2 * math.pi * k / segments
            verts.append((
                centre[0] + h * math.sin(phi) * normal[0],
                centre[1] + h * math.sin(phi) * normal[1],
                w * math.cos(phi),
            ))
    # Root cap: a fan about the root centre, facing -T (backwards along the arc).
    root_centre = len(verts)
    verts.append(centres[0])
    r0 = ring_starts[0]
    for k in range(segments):
        k2 = (k + 1) % segments
        faces.append([root_centre, r0 + k, r0 + k2])
    for r in range(rings - 1):
        cur, nxt = ring_starts[r], ring_starts[r + 1]
        for k in range(segments):
            k2 = (k + 1) % segments
            faces.append([cur + k, nxt + k, nxt + k2, cur + k2])
    last = ring_starts[-1]
    if tip_pole:
        tip = len(verts)
        verts.append((p2[0], p2[1], 0.0))
        for k in range(segments):
            k2 = (k + 1) % segments
            faces.append([tip, last + k2, last + k])
    else:
        tip_centre = len(verts)
        verts.append(centres[-1])
        for k in range(segments):
            k2 = (k + 1) % segments
            faces.append([tip_centre, last + k2, last + k])
    return verts, faces, centres[1:-1]


def cone(base, direction, length, radius, segments):
    """A closed cone: base ring about `base` perpendicular to `direction`,
    apex `length` along it. WINDING: (u, v, d) right-handed with phi running
    u -> v, so a side (k, k+1, apex) faces outward and the base fan
    (k+1, k, centre) faces -d."""
    d = normalised(direction)
    seed = (0.0, 0.0, 1.0) if abs(d[2]) < 0.9 else (1.0, 0.0, 0.0)
    u = normalised(cross(seed, d))
    v = cross(d, u)
    verts = []
    for k in range(segments):
        phi = 2 * math.pi * k / segments
        verts.append(add(add(base, u, radius * math.cos(phi)), v, radius * math.sin(phi)))
    apex = len(verts)
    verts.append(add(base, d, length))
    centre = len(verts)
    verts.append(base)
    faces = []
    for k in range(segments):
        k2 = (k + 1) % segments
        faces.append([k, k2, apex])
        faces.append([k2, k, centre])
    return verts, faces, add(base, d, length / 2)


def append_solid(verts, faces, more_verts, more_faces):
    """Merge a second solid into a vertex/face list (one mesh, two shells)."""
    offset = len(verts)
    verts.extend(more_verts)
    faces.extend([[i + offset for i in face] for face in more_faces])


# ------------------------------------------------------------------ the hull

def hull_stations():
    """Every ring station, snout to aft end; the anchor stations must be rings."""
    body = list(NOSE_CAP_STEPS)
    k = 1
    while NOSE_CAP_FRACTION + k * RING_STEP < 1.0 - TAIL_CAP_FRACTION - 1e-9:
        body.append(round(NOSE_CAP_FRACTION + k * RING_STEP, 9))
        k += 1
    body += list(TAIL_CAP_STEPS)
    assert all(a < b for a, b in zip(body, body[1:])), 'rings out of order'
    for anchor_t in (BELLY_T, FLANK_T):
        assert any(abs(t - anchor_t) < 1e-9 for t in body), f'no ring at anchor station {anchor_t}'
    return body


def build_hull():
    """The globular body: pole, one ring per station, pole.

    WINDING, derived then proved by check_outward: theta runs +z -> +y and
    successive rings run AFT (-x), so a face taken (this ring k) -> (this
    ring k+1) -> (next ring k+1) -> (next ring k) has its normal along
    (d/dtheta) x (d/dt) = (+y) x (-x) = +z at theta = 0, which is outward on
    the starboard flank; the pole fans follow the same circulation.
    """
    stations = hull_stations()
    verts = [(HULL_NOSE_X, mid_y(0.0), 0.0)]
    ring_starts = []
    for t in stations:
        ring_starts.append(len(verts))
        for k in range(HULL_SEGMENTS):
            verts.append(surface_point(t, 2 * math.pi * k / HULL_SEGMENTS))
    pole_tail = len(verts)
    verts.append((HULL_TAIL_X, mid_y(1.0), 0.0))
    faces = []
    r0 = ring_starts[0]
    for k in range(HULL_SEGMENTS):
        k2 = (k + 1) % HULL_SEGMENTS
        faces.append([0, r0 + k2, r0 + k])
    for r in range(len(ring_starts) - 1):
        cur, nxt = ring_starts[r], ring_starts[r + 1]
        for k in range(HULL_SEGMENTS):
            k2 = (k + 1) % HULL_SEGMENTS
            faces.append([cur + k, cur + k2, nxt + k2, nxt + k])
    rl = ring_starts[-1]
    for k in range(HULL_SEGMENTS):
        k2 = (k + 1) % HULL_SEGMENTS
        faces.append([pole_tail, rl + k, rl + k2])
    return {'verts': verts, 'faces': faces, 'stations': stations, 'ring_starts': ring_starts}


# ------------------------------------------------------------------ the parts

def midline_to_game(a, b, off):
    # (a, b) = (x, y): x x y = +z, so off runs along +z.
    return (a, b, off)


def dorsal():
    """A small rounded fin on the back, peak at CROWN_Y."""
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
    """A smaller rounded fin under the belly line, tip at ANAL_TIP_Y."""
    xs = [ANAL_FRONT_X + (ANAL_BACK_X - ANAL_FRONT_X) * k / FIN_ROOT_SAMPLES
          for k in range(FIN_ROOT_SAMPLES + 1)]
    root = [(x, hull_bottom(x) + FIN_SEAT_BITE) for x in xs]
    deep = (ANAL_DEEP_X, ANAL_TIP_Y)
    outline = [root[0]]
    outline += quad_bezier(root[0], ANAL_LEAD_CONTROL, deep, FIN_CURVE_SAMPLES)
    outline += quad_bezier(deep, ANAL_TRAIL_CONTROL, root[-1], FIN_CURVE_SAMPLES)
    outline += list(reversed(root[1:-1]))

    def half_at(a, b):
        seat = hull_bottom(a) + FIN_SEAT_BITE
        return lerp(FIN_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS, (seat - b) / (seat - ANAL_TIP_Y))
    return tapered_blade(outline, half_at, midline_to_game)


def caudal():
    """The short rounded fan in the XY plane, rear vertex at TAIL_TIP_X."""
    root_top = (CAUDAL_ROOT_X, CAUDAL_ROOT_HALF_HEIGHT)
    root_bottom = (CAUDAL_ROOT_X, -CAUDAL_ROOT_HALF_HEIGHT)
    tip = (TAIL_TIP_X, 0.0)
    lower_lobe = (CAUDAL_LOBE[0], -CAUDAL_LOBE[1])
    outline = [root_top]
    outline += quad_bezier(root_top, CAUDAL_LOBE_CONTROL, CAUDAL_LOBE, FIN_CURVE_SAMPLES)
    outline += quad_bezier(CAUDAL_LOBE, CAUDAL_REAR_CONTROL, tip, FIN_CURVE_SAMPLES)
    outline += quad_bezier(tip, (CAUDAL_REAR_CONTROL[0], -CAUDAL_REAR_CONTROL[1]), lower_lobe,
                           FIN_CURVE_SAMPLES)
    outline += quad_bezier(lower_lobe, (CAUDAL_LOBE_CONTROL[0], -CAUDAL_LOBE_CONTROL[1]),
                           root_bottom, FIN_CURVE_SAMPLES)

    def half_at(a, _b):
        return lerp(FIN_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS,
                    (CAUDAL_ROOT_X - a) / (CAUDAL_ROOT_X - TAIL_TIP_X))
    return tapered_blade(outline, half_at, midline_to_game)


def pectoral_outline():
    front = (PECTORAL_ROOT_FRONT_A, 0.0)
    back = (PECTORAL_ROOT_BACK_A, 0.0)
    outline = [front]
    outline += quad_bezier(front, PECTORAL_LEAD_CONTROL, PECTORAL_TIP, PECTORAL_CURVE_SAMPLES)
    outline += quad_bezier(PECTORAL_TIP, PECTORAL_TRAIL_CONTROL, back, PECTORAL_CURVE_SAMPLES)
    return outline


def pectoral_blade(seat, side):
    """A pectoral paddle in GAME space: a along x from `seat`, b outward and
    down by PECTORAL_DROOP_RADIANS on `side`'s flank, off = a x b (a
    right-handed basis by construction)."""
    e_a = (1.0, 0.0, 0.0)
    e_b = (0.0, -math.sin(PECTORAL_DROOP_RADIANS), side * math.cos(PECTORAL_DROOP_RADIANS))
    e_off = cross(e_a, e_b)

    def half_at(_a, b):
        return lerp(FIN_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS, b / PECTORAL_TIP[1])

    def to_game(a, b, off):
        return add(add(add(seat, e_a, a), e_b, b), e_off, off)
    return tapered_blade(pectoral_outline(), half_at, to_game)


def jaw():
    """The lower jaw with its teeth, one mesh: the tube along the jaw arc
    plus a cone per tooth, bases sunk into the tube's top surface."""
    def taper(s):
        if s < 1.0 - JAW_TIP_TAPER_FRACTION:
            return 1.0
        return math.sin(math.pi / 2 * (1.0 - s) / JAW_TIP_TAPER_FRACTION)

    def w_at(s):
        return lerp(JAW_ROOT_HALF_WIDTH, JAW_TIP_HALF_WIDTH, s) * taper(s)

    def h_at(s):
        return lerp(JAW_ROOT_HALF_HEIGHT, JAW_TIP_HALF_HEIGHT, s) * taper(s)
    p0, p1, p2 = (JAW_ROOT[0], JAW_ROOT[1], 0.0), (JAW_CONTROL[0], JAW_CONTROL[1], 0.0), (JAW_TIP[0], JAW_TIP[1], 0.0)
    verts, faces, centres = arc_tube(p0, p1, p2, w_at, h_at, JAW_RINGS, JAW_SEGMENTS, tip_pole=True)
    tube_faces = len(faces)
    tooth_refs = []
    for s, length in zip(LOWER_TOOTH_STATIONS, LOWER_TOOTH_LENGTHS):
        centre = quad_bezier_at(p0, p1, p2, s)
        ahead = quad_bezier_at(p0, p1, p2, min(1.0, s + TANGENT_EPSILON))
        behind = quad_bezier_at(p0, p1, p2, max(0.0, s - TANGENT_EPSILON))
        tangent = normalised((ahead[0] - behind[0], ahead[1] - behind[1], 0.0))
        up = cross((0.0, 0.0, 1.0), tangent)
        for side in (-1.0, 1.0):
            z = side * LOWER_TOOTH_ROW_FRACTION * w_at(s)
            # The base sits on the section at that z, sunk toward the axis.
            rise = h_at(s) * math.sqrt(max(0.0, 1.0 - (z / w_at(s)) ** 2)) * LOWER_TOOTH_SINK_FRACTION
            base = add((centre[0], centre[1], z), up, rise)
            tooth_verts, tooth_faces, axis_mid = cone(base, LOWER_TOOTH_DIRECTION, length, TOOTH_RADIUS, TOOTH_SEGMENTS)
            tooth_refs.append((len(faces), len(faces) + len(tooth_faces), axis_mid))
            append_solid(verts, faces, tooth_verts, tooth_faces)
    return verts, faces, centres, tube_faces, tooth_refs


def upper_teeth():
    """Needle cones hanging from the snout's underside, bases in the hull."""
    verts, faces, refs = [], [], []
    for t, length in zip(UPPER_TOOTH_STATIONS, UPPER_TOOTH_LENGTHS):
        for side in (-1.0, 1.0):
            theta = 3 * math.pi / 2 + side * UPPER_TOOTH_HALF_ARC_RADIANS
            base = surface_point(t, theta, UPPER_TOOTH_SINK_SCALE)
            tooth_verts, tooth_faces, axis_mid = cone(base, UPPER_TOOTH_DIRECTION, length, TOOTH_RADIUS, TOOTH_SEGMENTS)
            refs.append((len(faces), len(faces) + len(tooth_faces), axis_mid))
            append_solid(verts, faces, tooth_verts, tooth_faces)
    return verts, faces, refs


def stalk():
    """The illicium: a thin round tube from under the back to the bulb's centre."""
    base = (STALK_BASE_X, hull_top(STALK_BASE_X) - STALK_BASE_SINK, 0.0)
    control = (STALK_CONTROL[0], STALK_CONTROL[1], 0.0)
    return arc_tube(base, control, LURE_REST, lambda _s: STALK_RADIUS, lambda _s: STALK_RADIUS,
                    STALK_RINGS, STALK_SEGMENTS, tip_pole=False)


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


def inside_count(verts, shell):
    return sum(1 for v in verts if ray_hits(v, shell) % 2 == 1)


def check_attachment(shell, parts):
    """NOTHING FLOATS: every part has vertices strictly inside the hull.

    Bounds overlap is not enough — two shapes can share a bounding box and
    never touch — so this is the odd-crossing parity test the owner requires
    (plugins/wildlife/.verify-closed.mts), against the hull's closed mesh.
    """
    print('  attachment (vertices strictly inside the hull):')
    floating = []
    for name, verts in parts:
        inside = inside_count(verts, shell)
        state = f'{inside}/{len(verts)} inside' if inside else 'FLOATING'
        print(f'    {name:20} {state}')
        if inside == 0:
            floating.append(name)
    assert not floating, f'parts float free of the hull: {floating}'


def check_lure_bob(stalk_verts, bulb_local):
    """The stalk's tip stays inside the bulb at rest and at both bob extremes,
    and the bulb's top at the top of its bob stays under the crown."""
    print('  lure bob (stalk vertices strictly inside the bulb):')
    for label, dy in (('rest', 0.0), (f'+{LURE_BOB}', LURE_BOB), (f'-{LURE_BOB}', -LURE_BOB)):
        moved = [(x + LURE_REST[0], y + LURE_REST[1] + dy, z + LURE_REST[2]) for x, y, z in bulb_local['verts']]
        shell = triangulate(moved, bulb_local['faces'])
        inside = inside_count(stalk_verts, shell)
        print(f'    bulb at {label:6} {inside}/{len(stalk_verts)} stalk vertices inside')
        assert inside > 0, f'the stalk tip leaves the bulb at {label}'
    top_rest = LURE_REST[1] + LURE_RADIUS
    print(f'    bulb top at rest {top_rest:+.4f}; + bob {LURE_BOB} = {top_rest + LURE_BOB:+.4f} '
          f'<= crown {CROWN_Y:+.4f} by {CROWN_Y - top_rest - LURE_BOB:.4f}')
    assert top_rest + LURE_BOB <= CROWN_Y + ANCHOR_TOLERANCE, 'the bobbing lure would become the crown'
    bulb_front = LURE_REST[0] + LURE_RADIUS
    print(f'    bulb front {bulb_front:+.4f} behind the nose {NOSE_X:+.4f} by {NOSE_X - bulb_front:.4f}')
    assert bulb_front < NOSE_X, 'the bulb would become the nose'


def check_envelope(all_verts, hull_verts, jaw_verts, stalk_verts, anal_verts, pectoral_verts, tube_max_y):
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
    stalk_top = max(v[1] for v in stalk_verts)
    print(f'    the crown is the dorsal ({CROWN_Y:+.4f}); the hull\'s back tops out at {hull_top_max:+.4f}, '
          f'{CROWN_Y - hull_top_max:.4f} under it; the stalk\'s arch at {stalk_top:+.4f}, '
          f'{CROWN_Y - stalk_top:.4f} under it')
    assert CROWN_Y - stalk_top >= STALK_BELOW_CROWN, 'the stalk arch crowds the crown'
    hull_bottom_min = min(v[1] for v in hull_verts)
    jaw_min = min(v[1] for v in jaw_verts)
    anal_min = min(v[1] for v in anal_verts)
    pectoral_min = min(v[1] for v in pectoral_verts)
    print(f'    the belly is the hull\'s throat ({hull_bottom_min:+.4f}); the jaw\'s underside {jaw_min:+.4f}, '
          f'{jaw_min - BELLY_Y:.4f} above it; the anal fin {anal_min:+.4f}, {anal_min - BELLY_Y:.4f} above; '
          f'the pectorals {pectoral_min:+.4f}, {pectoral_min - BELLY_Y:.4f} above')
    assert abs(hull_bottom_min - BELLY_Y) < ANCHOR_TOLERANCE, 'the hull does not reach the belly'
    assert jaw_min - BELLY_Y >= JAW_ABOVE_BELLY, 'the jaw hangs below the belly'
    assert anal_min > BELLY_Y and pectoral_min > BELLY_Y, 'a fin hangs below the belly'
    print(f'    jaw tube (without teeth) tops out at {tube_max_y:+.4f}; the snout pole sits at '
          f'{mid_y(0.0):+.4f}: gape {mid_y(0.0) - tube_max_y:.4f} at the front')
    reach_z = max(abs(v[2]) for v in all_verts)
    print(f'    widest thing on the model {reach_z:.4f} (the drooping pectorals; flank is the hull\'s '
          f'width plateau, the upper-bound case the install allows)')
    print(f'    length {max_x - min_x:.4f}, halfLength {(max_x - min_x) / 2:.4f}')


# ------------------------------------------------------------------ the build

def add_part(name, verts, faces, material, joint, smooth, flat_faces=()):
    """A mesh authored in the frame of `joint` (the rig, or the lure whose
    bulb is authored about it), hung under it."""
    obj = make_object(name, verts, faces, smooth, flat_faces)
    obj.data.materials.append(material)
    parent_to(obj, joint)
    return obj


def blade_flat_faces(faces, caps):
    return [i for i in range(len(faces)) if i not in caps]


def check_cones(name, verts, faces, first_face, refs):
    """Every cone in a merged mesh, checked from its own axis midpoint."""
    for start, end, axis_mid in refs:
        check_outward(f'{name} cone @{start}', verts, faces[start:end], lambda _c, m=axis_mid: m)


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    out_path = args[0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    body_material = flat_material('deepsea_body', srgb(BODY_COLOR))
    detail_material = flat_material('deepsea_detail', srgb(DETAIL_COLOR))
    lure_material = unlit_material('deepsea_lure', srgb(LURE_COLOR))

    print('deepsea build:')

    # ---- the rig root: every part of the fish hangs under it ----
    rig = make_empty('rig', (0.0, 0.0, 0.0))

    # ---- the hull ----
    hull = build_hull()
    print(f'  hull: {len(hull["stations"])} rings x {HULL_SEGMENTS} segments')
    check_outward('hull', hull['verts'], hull['faces'], lambda c: hull_axis_point(c[0]))
    add_part('body', hull['verts'], hull['faces'], body_material, rig, smooth=True)
    shell = triangulate(hull['verts'], hull['faces'])

    parts = []

    # ---- the lower jaw and its teeth ----
    jaw_verts, jaw_faces, jaw_centres, tube_face_count, tooth_refs = jaw()

    def jaw_axis(centroid):
        return min(jaw_centres, key=lambda c: (c[0] - centroid[0]) ** 2 + (c[1] - centroid[1]) ** 2)
    check_outward('jaw tube', jaw_verts, jaw_faces[:tube_face_count], jaw_axis)
    check_cones('jaw tooth', jaw_verts, jaw_faces, tube_face_count, tooth_refs)
    tube_vertex_count = JAW_RINGS * JAW_SEGMENTS + 2
    add_part('jaw', jaw_verts, jaw_faces, body_material, rig, smooth=True)
    parts.append(('jaw', jaw_verts))
    tube_max_y = max(v[1] for v in jaw_verts[:tube_vertex_count])

    # ---- the upper teeth ----
    upper_verts, upper_faces, upper_refs = upper_teeth()
    check_cones('upper tooth', upper_verts, upper_faces, 0, upper_refs)
    add_part('upper_teeth', upper_verts, upper_faces, detail_material, rig, smooth=True)
    parts.append(('upper_teeth', upper_verts))

    # ---- midline fins ----
    fins = {}
    for name, (verts, faces, caps) in (('dorsal', dorsal()), ('anal', anal()), ('caudal', caudal())):
        add_part(name, verts, faces, body_material, rig, True, blade_flat_faces(faces, caps))
        parts.append((name, verts))
        fins[name] = verts

    # ---- pectorals: rigid paddles seated in the flanks ----
    # Right-handed frame with +X forward and +Y up puts PORT at -Z
    # (left = up x forward = Y x X = -Z).
    pectoral_verts = []
    seat_z = PECTORAL_SEAT_FRACTION * half_width(station_t(PECTORAL_X))
    for name, side in (('pectoral_port', -1.0), ('pectoral_starboard', 1.0)):
        seat = (PECTORAL_X, PECTORAL_Y, side * seat_z)
        verts, faces, caps = pectoral_blade(seat, side)
        add_part(name, verts, faces, body_material, rig, True, blade_flat_faces(faces, caps))
        parts.append((name, verts))
        pectoral_verts += verts

    # ---- eyes ----
    for name, side in (('eye_port', -1.0), ('eye_starboard', 1.0)):
        theta = EYE_THETA if side > 0 else math.pi - EYE_THETA
        centre = surface_point(EYE_T, theta, EYE_SEAT_SCALE)
        verts, faces = uv_sphere(centre, EYE_RADIUS, EYE_SEGMENTS, EYE_RINGS)
        check_outward(name, verts, faces, lambda _c, m=centre: m)
        add_part(name, verts, faces, detail_material, rig, smooth=True)
        parts.append((name, verts))

    # ---- the stalk: body geometry, its tip at the bulb's centre ----
    stalk_verts, stalk_faces, stalk_centres = stalk()

    def stalk_axis(centroid):
        return min(stalk_centres, key=lambda c: (c[0] - centroid[0]) ** 2 + (c[1] - centroid[1]) ** 2)
    check_outward('stalk', stalk_verts, stalk_faces, stalk_axis)
    add_part('stalk', stalk_verts, stalk_faces, body_material, rig, smooth=True)
    parts.append(('stalk', stalk_verts))

    # ---- the lure joint (identity) and the unlit bulb under it ----
    lure = make_empty('lure', LURE_REST)
    parent_to(lure, rig)
    bulb_verts, bulb_faces = uv_sphere((0.0, 0.0, 0.0), LURE_RADIUS, LURE_SEGMENTS, LURE_RINGS)
    check_outward('lure_bulb', bulb_verts, bulb_faces, lambda _c: (0.0, 0.0, 0.0))
    add_part('lure_bulb', bulb_verts, bulb_faces, lure_material, lure, smooth=True)

    # ---- checks, on the GAME-space vertices the parts were authored from ----
    check_attachment(shell, parts)
    check_lure_bob(stalk_verts, {'verts': bulb_verts, 'faces': bulb_faces})
    all_verts = list(hull['verts'])
    for _name, verts in parts:
        all_verts.extend(verts)
    all_verts.extend([(x + LURE_REST[0], y + LURE_REST[1], z + LURE_REST[2]) for x, y, z in bulb_verts])
    check_envelope(all_verts, hull['verts'], jaw_verts, stalk_verts, fins['anal'], pectoral_verts, tube_max_y)

    # ---- anchors: what the plugin measures DEEPSEA_ENVELOPE from ----
    make_empty('nose', (JAW_TIP[0], JAW_TIP[1], 0.0))
    make_empty('tail_tip', (TAIL_TIP_X, 0.0, 0.0))
    make_empty('crown', (DORSAL_PEAK_X, CROWN_Y, 0.0))
    make_empty('belly', (station_x(BELLY_T), BELLY_Y, 0.0))
    make_empty('flank', (station_x(FLANK_T), mid_y(FLANK_T), FLANK_Z))

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
    print(f'deepsea -> {out_path}: {total_tris} tris total')


main()
