# build_humpback.py — builds the Terrace humpback whale in Blender and exports it.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_humpback.py -- \
#     E:\...\Terrace\plugins\wildlife\client\assets\humpback.glb
#
# WHAT IT BUILDS (docs/model-assets.md is the convention this satisfies, and
# its "Wildlife species" section is the joint convention). Pass 6 of the
# fish+whales arc: the first WHALE body. The humpback is `whale` variant 0 on
# the wire (plugins/wildlife/client/whaleSpecies.ts WHALE_SPECIES) and, unlike
# the fish before it, it is authored to FILL the whale placement box exactly —
# crown 0.670, belly -0.575, nose to fluke trailing edge 5.05 — with the
# hull's own half-width the one free envelope figure
# (plugins/wildlife/client/species/humpback.ts HUMPBACK_HALF_WIDTH).
#
#   rig                   Empty at the origin; the whole body hangs under it.
#     body                the swept hull: a broad flat rostrum, a barrel chest
#                         collapsing to a tall, laterally flattened tail
#                         stock, the hump two thirds back, and the throat's
#                         ventral pleats as relief (grooves in the hull's own
#                         surface, not a decal). Smooth-shaded with numeric
#                         normals of the full surface, so the relief shades.
#                         Its colour is a VERTEX COLOUR (COLOR_0): the body
#                         tone everywhere, blending into the pale ventral
#                         tone over the pleated throat — a gradient, because
#                         a colour split along faces steps ring by ring
#                         across a leaf-shaped patch (seen 2026-09-04) and a
#                         real throat has no edge. rigSkin multiplies the
#                         material's colour by the attribute
#                         (client/src/render/rigSkin.ts paintVertexColor),
#                         so the material is white and the hexes ride in
#                         the vertices.
#     flipper_port / flipper_starboard (+ _underside)
#                         RIGID body parts, no joint: the humpback's near-
#                         third-of-body flippers, lofted with root thickness
#                         and camber, a scalloped leading edge and a rounded
#                         tip, baked at their hang angle. The starboard
#                         TIP is the envelope's BELLY (see FLIPPER_ROOT_Y).
#     dorsal              the stubby falcate fin on the hump; its tip is the
#                         envelope's CROWN.
#     tubercle_*          knobs on the rostrum's crown, the chin and the jaw
#                         line, as small spheres seated into the hull.
#     eye_port / eye_starboard
#                         one per side, just behind the gape.
#     flukes              Empty AT THE PEDUNCLE, identity rotation; both
#                         fluke blades hang under it as ONE welded wing
#                         (flukes_blade + flukes_underside; see the fluke
#                         constants for why one), so the plugin's pitch
#                         about Z sweeps them from the tail stock. The
#                         lobes' trailing edge is the TAIL_TIP.
#   nose / tail_tip / crown / belly / flank
#                         anchor Empties; the plugin measures
#                         HUMPBACK_ENVELOPE from these and refuses an asset
#                         that disagrees.
#
# THE REFERENCE SILHOUETTE is the procedural humpback this replaces
# (whaleSpecies.ts humpbackSet, removed in this pass). Its width profile, on
# an authored length of 6.2 and a max half-width of 0.60, was
#   (0.00 0.14) (0.04 0.34) (0.09 0.53) (0.15 0.70) (0.22 0.85) (0.30 0.96)
#   (0.36 1.00) (0.45 0.97) (0.55 0.87) (0.65 0.71) (0.74 0.54) (0.82 0.38)
#   (0.89 0.25) (0.95 0.15) (1.00 0.09)
# and its height-over-width ratio
#   (0.00 0.95) (0.10 1.05) (0.25 1.18) (0.40 1.20) (0.55 1.18) (0.70 1.30)
#   (0.82 1.60) (0.92 2.00) (1.00 2.20)
# with tubercles over the first 0.19 of the body (5 rows, 0.030 high), a
# 0.05 hump at t 0.62, flippers rooted at x 1.30 (of +-3.1) pitched
# (0.30, -0.22, -0.16), a dorsal at x -0.85 and flukes rooted at x -2.80.
# That body was fitted into the box at 0.6907 and came out 4.478 long, its
# scale capped by a flipper tip; this one is drawn straight into the box.
#
# EVERY DIMENSION IS A NAMED CONSTANT IN GAME SPACE: x forward, y up, z
# lateral, one unit = one cell. `bl()` is the only place the Blender frame
# (x length, y beam, z up) is spoken.
#
# CHECKS IT PRINTS AND ASSERTS, because a model is a claim until measured:
#   * winding: every hull face agrees with an outward test from its own
#     ring's axis point; every sphere from its centre; and EVERY closed part
#     (hull, fins, spheres) is handed to Blender's own outward recalculation
#     on a scratch copy, which must not flip a single face.
#   * envelope: the anchor Empties equal the measured mesh extremes to 1e-9.
#   * attachment: NOTHING FLOATS — every non-hull part has vertices strictly
#     inside the hull's closed mesh, by odd ray-crossing parity (the same
#     test as plugins/wildlife/.verify-closed.mts, in Python).
#   * the fluke sweep: the flukes pitched +-WHALE_FLUKE_SWING_RADIANS about
#     the peduncle hinge stay inside the box and their x extent only
#     shortens; the body roll's effect on the whole model is printed against
#     the placement clearance (see check_fluke_sweep for why not asserted).

import math
import os
import sys

import bpy

# export_glb.py holds this project's ONE export recipe.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_glb import bake_object_transforms, export_scene_glb  # noqa: E402

# ----------------------------------------------------------------- dimensions
# Game space (x forward, y up, z lateral), cells. The box is
# plugins/wildlife/client/whaleSpecies.ts WHALE_ENVELOPE (the placement
# contract); the half-width is species/humpback.ts HUMPBACK_HALF_WIDTH.

#: WHALE_ENVELOPE.length: nose tip to the flukes' trailing edge.
LENGTH = 5.05
#: WHALE_ENVELOPE.crownY: the dorsal's tip.
CROWN_Y = 0.670
#: WHALE_ENVELOPE.bellyY: the starboard flipper's tip (FLIPPER_ROOT_Y).
BELLY_Y = -0.575
#: The hull's widest half-width, on the chest plateau: the `flank` anchor.
#: A fifth of the length across, as placement.ts's SWIM_PROFILES.whale
#: comment describes the widest of the three whales.
HALF_WIDTH = 0.47

#: The rostrum's pole vertex: the model's forward extreme, the envelope's
#: front. Centred, so the box straddles the origin the way the procedural
#: whale's fitted body did.
NOSE_X = LENGTH / 2
#: The flukes' trailing edge at its furthest lobe: the `tail_tip` anchor.
TAIL_TIP_X = -LENGTH / 2
#: The peduncle: the fluke hinge. The flukes reach FLUKE_REACH behind it.
FLUKE_REACH = 0.525
PEDUNCLE_X = TAIL_TIP_X + FLUKE_REACH
#: The hull's own tapered aft end: AT the hinge. Its tail cap (the last
#: TAIL_CAP_FRACTION) shrinks inside the flukes' root thickness, and the
#: flukes' leading root (FLUKE_ROOT_FRONT_A ahead of the hinge) is buried in
#: the tall tail stock; nothing of the hull sits behind the hinge, so nothing
#: rigid can show through a pitched fluke.
HULL_TAIL_X = PEDUNCLE_X

HULL_LENGTH = NOSE_X - HULL_TAIL_X

#: The back's height and the belly's depth along the body, ABSOLUTE y by
#: station t (0 the nose, 1 the hull's aft end). Two lines rather than a
#: centreline plus a height so the belly can be barrel-deep under a flatter
#: back and the tail stock can RISE toward the peduncle, which is the
#: humpback's line from the side. Monotone cubic through each (no
#: overshoot: the chest plateau IS the deepest point). The section centre is
#: their mean and the half-height half their difference. Over the last
#: tenth the two converge to about the flukes' root thickness, so the stock
#: sinks into the wing's upper surface rather than riding over it as a
#: ridge (seen 2026-09-04).
TOP_PROFILE = (
    (0.00, 0.00), (0.06, 0.13), (0.14, 0.26), (0.24, 0.37), (0.34, 0.45),
    (0.44, 0.48), (0.54, 0.47), (0.64, 0.44), (0.74, 0.40), (0.84, 0.33),
    (0.92, 0.24), (0.97, 0.18), (1.00, 0.14),
)
BOTTOM_PROFILE = (
    (0.00, -0.07), (0.06, -0.22), (0.14, -0.35), (0.24, -0.45), (0.34, -0.51),
    (0.44, -0.51), (0.54, -0.47), (0.64, -0.39), (0.74, -0.28), (0.84, -0.15),
    (0.92, -0.02), (0.97, 0.06), (1.00, 0.10),
)
#: Half-width as a fraction of HALF_WIDTH by station: a broad rostrum (the
#: humpback's head is wide and flat), a PLATEAU over the chest (t 0.34-0.44,
#: where the flank anchor is read), then the collapse to a tail stock a
#: fraction of the chest's width — and, with the height lines above, taller
#: than it is wide.
WIDTH_PROFILE = (
    (0.00, 0.30), (0.06, 0.55), (0.14, 0.78), (0.24, 0.93), (0.34, 1.00),
    (0.44, 1.00), (0.54, 0.92), (0.64, 0.76), (0.74, 0.56), (0.84, 0.36),
    (0.92, 0.20), (0.97, 0.12), (1.00, 0.08),
)
#: The chest plateau's station, where the `flank` anchor sits (a ring
#: station: NOSE_CAP_FRACTION + 11 x RING_STEP).
FLANK_T = 0.38

#: Segments around a ring, NON-UNIFORM (see ring_thetas): QUADRANT_SEGMENTS
#: per quadrant over the back and flanks — so the flank lines (0, pi) and the
#: back (pi/2) are vertex rows — FLANK_TO_PLEAT_SEGMENTS from each flank-low
#: to the pleated arc, and PLEAT_VERTICES_PER_PLEAT per pleat across it.
QUADRANT_SEGMENTS = 6
FLANK_TO_PLEAT_SEGMENTS = 3
#: Ring stations (t = 0 at the nose, 1 at the hull's aft end): the nose
#: rounds off over NOSE_CAP_FRACTION sampled at NOSE_CAP_STEPS, the body
#: every RING_STEP, the aft end over TAIL_CAP_FRACTION.
NOSE_CAP_FRACTION = 0.05
NOSE_CAP_STEPS = (0.012, 0.025, 0.038, 0.05)
RING_STEP = 0.03
#: The tail cap is LONG — a stock that pinched to nothing over the last
#: three percent rode over the flukes' upper surface as a ridge ending in a
#: point (seen 2026-09-04); over eight percent it sinks into the wing.
TAIL_CAP_FRACTION = 0.08
TAIL_CAP_STEPS = (0.935, 0.955, 0.972, 0.985, 0.994)

#: The hump: a rise of the back, Gaussian along the body about HUMP_T (two
#: thirds back, where the species carries it), on the top of the section
#: only (weighted by the square of the upward component).
HUMP_T = 0.70
HUMP_SIGMA_T = 0.09
HUMP_HEIGHT = 0.10

#: The ventral pleats: PLEAT_COUNT grooves across the throat, each
#: PLEAT_DEPTH into the hull along its normal, spanning PLEAT_HALF_ARC either
#: side of the belly line (3pi/2) at the widest and running from
#: PLEAT_T_START (the chin) to PLEAT_T_END (the navel) with a sine window
#: along the body. The groove is a cosine in the ring index, sampled
#: PLEAT_VERTICES_PER_PLEAT times per pleat: THREE, not two, because with a
#: vertex at each crest and each trough every vertex normal is the same and
#: the grooves shade flat — the two mid-slope vertices are what make them
#: read. An even count keeps the belly line a crest. The outer grooves fade
#: with a parabola in arc so the pleats die out at the flanks, and the
#: throat's pale patch follows the same window: PLEAT_HALF_ARC scaled by the
#: square root of the sine along the body, so it is a leaf from chin to
#: navel and not a rectangle, its edge blended over THROAT_BLEND_ARC of
#: section angle.
PLEAT_COUNT = 8
PLEAT_VERTICES_PER_PLEAT = 3
PLEAT_HALF_ARC = 0.9
PLEAT_DEPTH = 0.014
PLEAT_T_START = 0.05
PLEAT_T_END = 0.50
THROAT_BLEND_ARC = 0.3

#: Flippers. Rooted low on the chest at FLIPPER_ROOT_X (about a third of
#: the body back from the nose), spanning nearly a third of the body, hung
#: FLIPPER_HANG_RADIANS below level and swept aft to FLIPPER_TIP_A. The root
#: height is DERIVED so the tip is the envelope's belly: the tip vertex is
#: at root_y - SPAN x sin(hang), so root_y = BELLY_Y + SPAN x sin(hang).
FLIPPER_ROOT_X = 1.00
FLIPPER_SPAN = 1.55
FLIPPER_HANG_RADIANS = 0.20
FLIPPER_ROOT_Y = BELLY_Y + FLIPPER_SPAN * math.sin(FLIPPER_HANG_RADIANS)
#: The hinge-less root sits this fraction of the local half-width out from
#: the axis: inside the flank, so the root is buried.
FLIPPER_SEAT_FRACTION = 0.75
#: Root half-chord, and the outline's mean line: a quadratic from the root
#: through FLIPPER_MEAN_CONTROL_A (at half span) to FLIPPER_TIP_A.
FLIPPER_ROOT_HALF_CHORD = 0.25
FLIPPER_MEAN_ROOT_A = 0.01
FLIPPER_MEAN_CONTROL_A = -0.02
FLIPPER_TIP_A = -0.30
#: Half-chord taper: elliptical toward the tip (a rounded tip), narrowed
#: linearly by FLIPPER_TAPER over the span.
FLIPPER_TIP_ROUNDING_POWER = 2.2
FLIPPER_TAPER = 0.25
#: The scalloped leading edge — the humpback's tell: FLIPPER_SCALLOPS bumps
#: of FLIPPER_SCALLOP_AMPLITUDE forward, over the outer part of the span
#: from FLIPPER_SCALLOP_START.
FLIPPER_SCALLOPS = 5
FLIPPER_SCALLOP_AMPLITUDE = 0.03
FLIPPER_SCALLOP_START = 0.35
#: Span stations and chord segments of the loft.
FLIPPER_SPAN_SEGMENTS = 24
FLIPPER_CHORD_SEGMENTS = 4
FLIPPER_ROOT_HALF_THICKNESS = 0.05

#: Flukes, authored with a = 0 AT THE HINGE (the flukes Empty), b outward.
#: Root chord from FLUKE_ROOT_FRONT_A (buried in the tall tail stock) back
#: to the NOTCH, FLUKE_NOTCH_A behind the hinge. The two blades are lofted
#: from the centreline out and WELDED there into one wing (their root rows
#: are the same points, mirrored): two blades meeting at the centreline
#: either share a face (a z-fighting slot down the notch, seen 2026-09-04)
#: or split their smooth normals along a crease, and a wing does neither.
#: The leading edge sweeps back to a pointed tip at
#: (FLUKE_TIP_A, FLUKE_HALF_SPAN); the trailing edge bows aft from the notch
#: to its lobe at FLUKE_LOBE_S (exactly FLUKE_REACH behind the hinge: the
#: tail tip) and forward again to the tip, with FLUKE_SERRATIONS scallops
#: cut FORWARD into it (they are zero at the lobe, so the lobe stays the
#: extreme).
FLUKE_HALF_SPAN = 0.78
FLUKE_ROOT_FRONT_A = 0.40
FLUKE_NOTCH_A = 0.36
FLUKE_TIP_A = -0.42
FLUKE_LEAD_CONTROL_A = 0.30
FLUKE_LOBE_S = 0.5
FLUKE_SERRATIONS = 4
FLUKE_SERRATION_AMPLITUDE = 0.035
FLUKE_SPAN_SEGMENTS = 16
FLUKE_CHORD_SEGMENTS = 4
FLUKE_ROOT_HALF_THICKNESS = 0.07

#: The dorsal: a stubby falcate fin seated a bite into the hump, root from
#: DORSAL_FRONT_X back to DORSAL_BACK_X, tip at DORSAL_TIP_X and CROWN_Y.
#: The leading edge leans back (power > 1), the trailing edge is hollow
#: (power < 1).
DORSAL_FRONT_X = -0.74
DORSAL_BACK_X = -1.02
DORSAL_TIP_X = -0.90
DORSAL_LEAD_POWER = 1.4
DORSAL_TRAIL_POWER = 0.6
DORSAL_SPAN_SEGMENTS = 6
DORSAL_CHORD_SEGMENTS = 3
DORSAL_ROOT_HALF_THICKNESS = 0.035

#: Camber of the lofted fins: the mean line bows UP by this fraction of the
#: local chord at mid-chord. Zero for the midline dorsal.
FIN_CAMBER_FRACTION = 0.04
#: Where along the chord a fin is thickest: the thickness runs as
#: sin(pi c^POWER), and 0.7 puts the peak near 37 percent of chord — a foil,
#: thick at the shoulder and tapering to its trailing edge.
FIN_THICKNESS_PEAK_POWER = 0.7
#: The flukes' own: their thickest station is where the tail stock's back
#: sinks into them (a quarter chord, 0.5), and their camber is half the
#: flippers', so the stock meets a wing surface that is level rather than
#: still rising — a crease there read as a cut across the peduncle
#: (seen 2026-09-04).
FLUKE_THICKNESS_PEAK_POWER = 0.5
FLUKE_CAMBER_FRACTION = 0.02
#: Half-thickness at every free edge (a lens section, not a plate).
EDGE_HALF_THICKNESS = 0.005
#: How far a fin root is sunk below the hull surface, so no hairline shows.
FIN_SEAT_BITE = 0.03

#: Tubercles: TUBERCLE_ROWS rows across the rostrum's crown from
#: TUBERCLE_T_FIRST every TUBERCLE_ROW_STEP, alternately three and two wide
#: at TUBERCLE_ACROSS_RADIANS about the back line; one row along each jaw
#: line at JAW_LINE_RADIANS from the belly line; a pair on the chin. Each a
#: small sphere with its centre sunk TUBERCLE_SINK of its radius into the
#: hull.
TUBERCLE_RADIUS = 0.038
TUBERCLE_ROWS = 5
TUBERCLE_T_FIRST = 0.03
TUBERCLE_ROW_STEP = 0.04
TUBERCLE_ACROSS_RADIANS = 0.42
JAW_LINE_RADIANS = 1.15
JAW_TUBERCLE_TS = (0.06, 0.11, 0.16, 0.21)
CHIN_TUBERCLE_T = 0.03
CHIN_TUBERCLE_RADIANS = 0.35
TUBERCLE_SINK = 0.45
TUBERCLE_SEGMENTS = 6
TUBERCLE_RINGS = 3

#: Eyes: one per side just behind the gape, low on the head, mostly buried.
EYE_T = 0.26
EYE_ARC_BELOW_FLANK = 0.32
EYE_RADIUS = 0.045
EYE_SINK = 0.5
EYE_SEGMENTS = 8
EYE_RINGS = 4

#: Colours, as sRGB hexes. THESE ARE sRGB AND BLENDER'S BASE COLOR AND
#: COLOR_0 ARE LINEAR — see srgb() below. BODY_COLOR is models.ts's
#: WHALE_COLOR, the colour the owner reads a whale by; the ventral tone is
#: the humpback's white throat and fin undersides, kept a pale slate so it
#: does not glare under water. On the hull both ride in the vertex colour
#: under a white material; the fin undersides and the eyes are plain
#: materials.
BODY_COLOR = 0x39506B
VENTRAL_COLOR = 0xB9C6D2
EYE_COLOR = 0x0B0E13

#: ONE roughness and ONE metalness across every material on this model.
#: rigSkin.ts's materialSignature keys on roughness and metalness but NOT on
#: colour, so three colours at one roughness bake to ONE surface — the draw
#: budget plugins/wildlife/client/index.ts asserts for the humpback. 0.5 is
#: a wet, slightly glossy body.
SURFACE_ROUGHNESS = 0.5
SURFACE_METALNESS = 0.0

#: The animation the sweep check reproduces: species/whale.ts's
#: WHALE_FLUKE_SWING_RADIANS and WHALE_BODY_ROLL_FRACTION; and the water
#: placement.ts's SWIM_PROFILES.whale keeps above and below the origin
#: (minClearance / minSubmergence), which the rolled extremes are printed
#: against.
FLUKE_SWING_RADIANS = 0.3
BODY_ROLL_FRACTION = 0.12
PLACEMENT_CLEARANCE = 0.7

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
    control points IS the extreme, exactly, so the flank and the chest read
    off their plateaus are the true extremes.
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


def centre_y(t):
    return (TOP(t) + BOTTOM(t)) / 2


def half_height(t):
    return (TOP(t) - BOTTOM(t)) / 2 * cap_factor(t)


def half_width(t):
    return HALF_WIDTH * WIDTH(t) * cap_factor(t)


def smooth_point(t, theta):
    """A point on the SMOOTH hull, before the hump and the pleats.

    The section is one ellipse about its centre line: theta = 0 is the
    starboard flank, pi/2 the back, pi the port flank, 3pi/2 the belly.
    """
    return (
        station_x(t),
        centre_y(t) + half_height(t) * math.sin(theta),
        half_width(t) * math.cos(theta),
    )


def unit(v):
    length = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    return (v[0] / length, v[1] / length, v[2] / length)


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def surface_normal_of(point_fn, t, theta):
    """The outward unit normal of `point_fn(t, theta)` by finite differences.

    d/dtheta x d/dt: theta runs +z -> +y and t runs aft (-x), so at theta = 0
    the product is +y x -x = +z, which is outward on the starboard flank.
    """
    p_t0 = point_fn(max(0.0, t - NORMAL_EPSILON), theta)
    p_t1 = point_fn(min(1.0, t + NORMAL_EPSILON), theta)
    p_a0 = point_fn(t, theta - NORMAL_EPSILON)
    p_a1 = point_fn(t, theta + NORMAL_EPSILON)
    du = (p_t1[0] - p_t0[0], p_t1[1] - p_t0[1], p_t1[2] - p_t0[2])
    da = (p_a1[0] - p_a0[0], p_a1[1] - p_a0[1], p_a1[2] - p_a0[2])
    return unit(cross(da, du))


def smooth_normal(t, theta):
    return surface_normal_of(smooth_point, t, theta)


PLEAT_ARC_START = 3 * math.pi / 2 - PLEAT_HALF_ARC
PLEAT_ARC_SEGMENTS = PLEAT_COUNT * PLEAT_VERTICES_PER_PLEAT
PLEAT_SEGMENT_ARC = 2 * PLEAT_HALF_ARC / PLEAT_ARC_SEGMENTS


def hump(t, theta):
    """The hump's rise along the normal at (t, theta): on the back only."""
    up = max(0.0, math.sin(theta))
    return HUMP_HEIGHT * math.exp(-((t - HUMP_T) / HUMP_SIGMA_T) ** 2) * up * up


def pleat_window(t):
    """The pleats' strength along the body: a sine from chin to navel."""
    if t <= PLEAT_T_START or t >= PLEAT_T_END:
        return 0.0
    return math.sin(math.pi * (t - PLEAT_T_START) / (PLEAT_T_END - PLEAT_T_START))


def throat_half_arc(t):
    """How far either side of the belly line the pale throat reaches at t."""
    return PLEAT_HALF_ARC * math.sqrt(pleat_window(t))


def throat_weight(t, theta):
    """0 on the body, 1 on the pale throat, a smoothstep across the leaf's
    edge over THROAT_BLEND_ARC."""
    phi = abs(theta - 3 * math.pi / 2)
    u = (throat_half_arc(t) - phi) / THROAT_BLEND_ARC + 0.5
    u = min(1.0, max(0.0, u))
    return u * u * (3.0 - 2.0 * u)


def lerp_color(a, b, w):
    return tuple(a[i] + (b[i] - a[i]) * w for i in range(4))


def pleat(t, theta):
    """The pleats' depth (negative, along the normal) at (t, theta)."""
    phi = theta - 3 * math.pi / 2
    along = pleat_window(t)
    if abs(phi) >= PLEAT_HALF_ARC or along == 0.0:
        return 0.0
    fade = 1.0 - (phi / PLEAT_HALF_ARC) ** 2
    pleats = (theta - PLEAT_ARC_START) / (PLEAT_SEGMENT_ARC * PLEAT_VERTICES_PER_PLEAT)
    groove = (1.0 - math.cos(2 * math.pi * pleats)) / 2
    return -PLEAT_DEPTH * along * fade * groove


def surface_point(t, theta):
    """A point on the hull AS BUILT: the smooth section plus the hump and
    the pleats along the smooth normal."""
    p = smooth_point(t, theta)
    relief = hump(t, theta) + pleat(t, theta)
    if relief == 0.0:
        return p
    n = smooth_normal(t, theta)
    return (p[0] + n[0] * relief, p[1] + n[1] * relief, p[2] + n[2] * relief)


def surface_normal(t, theta):
    """The normal of the hull AS BUILT — so the hump and the pleats shade."""
    return surface_normal_of(surface_point, t, theta)


def hull_top(x):
    """The back's height on the centreline at rig-space x, hump included."""
    return surface_point(station_t(x), math.pi / 2)[1]


# --------------------------------------------------------------- mesh helpers

def face_normal(verts, face):
    """Newell's method: valid for any planar-ish polygon, including a root
    cap whose first three vertices are nearly collinear."""
    n = [0.0, 0.0, 0.0]
    for k in range(len(face)):
        a = verts[face[k]]
        b = verts[face[(k + 1) % len(face)]]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    return tuple(n)


def centroid(verts, face):
    return (
        sum(verts[i][0] for i in face) / len(face),
        sum(verts[i][1] for i in face) / len(face),
        sum(verts[i][2] for i in face) / len(face),
    )


def check_outward(name, verts, faces, ref_of):
    """Assert the analytic winding agrees with an outward test from
    `ref_of(face)`, a point inside the solid on the axis the face's section
    is star-shaped about. This NEVER rewrites a face: the winding is
    derived, and a disagreement is a bug in the derivation.
    """
    wrong = 0
    for face in faces:
        normal = face_normal(verts, face)
        c = centroid(verts, face)
        ref = ref_of(face)
        away = (c[0] - ref[0], c[1] - ref[1], c[2] - ref[2])
        dot = normal[0] * away[0] + normal[1] * away[1] + normal[2] * away[2]
        if dot < -WINDING_TOLERANCE:
            wrong += 1
    print(f'  winding {name}: {len(faces)} faces, {wrong} inward')
    assert wrong == 0, f'{name}: {wrong} faces wound inward'


def check_winding_with_blender(name, verts, faces):
    """Blender's own outward recalculation on a SCRATCH copy of a closed
    solid must agree with the derived winding on every face. The copy is
    deleted; the real objects are built from the derived faces untouched."""
    mesh = bpy.data.meshes.new(f'{name}_winding_check')
    mesh.from_pydata([bl(*v) for v in verts], [], [list(f) for f in faces])
    mesh.update()
    obj = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    flipped = 0
    for index, poly in enumerate(mesh.polygons):
        mine = bl(*face_normal(verts, faces[index]))
        theirs = poly.normal
        if mine[0] * theirs[0] + mine[1] * theirs[1] + mine[2] * theirs[2] < 0.0:
            flipped += 1
    bpy.data.objects.remove(obj)
    bpy.data.meshes.remove(mesh)
    print(f'  blender recalc {name}: {len(faces)} faces, {flipped} it would flip')
    assert flipped == 0, f'{name}: Blender would flip {flipped} faces'


def make_object(name, verts, faces, normals=None):
    """A Blender mesh object from GAME-space verts (converted here, once),
    every face shaded smooth. `normals`, when given, are per-vertex
    GAME-space normals set as custom split normals — the hull's numeric
    surface normals. The winding is the derived one, already checked."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([bl(*v) for v in verts], [], [list(f) for f in faces])
    mesh.update()
    mesh.validate()
    for poly in mesh.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if normals is not None:
        mesh.normals_split_custom_set_from_vertices([bl(*n) for n in normals])
    return obj


def make_empty(name, position, size=0.05):
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


#: The name of the hull's colour attribute; the exporter writes it as COLOR_0.
TINT_ATTRIBUTE = 'tint'


def tinted_material(name):
    """A white material whose Base Color is the mesh's TINT_ATTRIBUTE: the
    exporter turns that node into COLOR_0 with a white baseColorFactor, and
    rigSkin multiplies the two back together."""
    mat = flat_material(name, (1.0, 1.0, 1.0, 1.0))
    nodes = mat.node_tree.nodes
    attribute = nodes.new('ShaderNodeVertexColor')
    attribute.layer_name = TINT_ATTRIBUTE
    mat.node_tree.links.new(attribute.outputs['Color'], nodes['Principled BSDF'].inputs['Base Color'])
    return mat


def paint_tints(obj, tints):
    """Per-vertex linear RGBA onto the object's mesh as TINT_ATTRIBUTE."""
    layer = obj.data.color_attributes.new(name=TINT_ATTRIBUTE, type='FLOAT_COLOR', domain='POINT')
    for index, tint in enumerate(tints):
        layer.data[index].color = tint


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


def compact(verts, faces, normals=None):
    """Keep only the vertices `faces` reference, re-indexing the faces."""
    used = sorted({i for face in faces for i in face})
    remap = {old: new for new, old in enumerate(used)}
    return (
        [verts[i] for i in used],
        [[remap[i] for i in face] for face in faces],
        None if normals is None else [normals[i] for i in used],
    )


# ------------------------------------------------------------------ the hull

def ring_thetas():
    """Section angles of one ring, starboard flank round the back to the
    port flank uniformly, then denser across the pleated belly. Returns the
    angles and the index range [first, last] of the pleat-arc vertices."""
    thetas = []
    quadrant = math.pi / 2 / QUADRANT_SEGMENTS
    for i in range(2 * QUADRANT_SEGMENTS + 1):
        thetas.append(i * quadrant)
    flank_to_pleat = (math.pi / 2 - PLEAT_HALF_ARC) / FLANK_TO_PLEAT_SEGMENTS
    for j in range(1, FLANK_TO_PLEAT_SEGMENTS + 1):
        thetas.append(math.pi + j * flank_to_pleat)
    first = len(thetas) - 1
    for k in range(1, PLEAT_ARC_SEGMENTS + 1):
        thetas.append(PLEAT_ARC_START + k * PLEAT_SEGMENT_ARC)
    last = len(thetas) - 1
    for j in range(1, FLANK_TO_PLEAT_SEGMENTS):
        thetas.append(3 * math.pi / 2 + PLEAT_HALF_ARC + j * flank_to_pleat)
    return thetas, first, last


THETAS, PLEAT_FIRST, PLEAT_LAST = ring_thetas()
HULL_SEGMENTS = len(THETAS)


def hull_stations():
    """Every ring station, nose to aft end."""
    body = list(NOSE_CAP_STEPS)
    k = 1
    while NOSE_CAP_FRACTION + k * RING_STEP < 1.0 - TAIL_CAP_FRACTION - 1e-9:
        body.append(NOSE_CAP_FRACTION + k * RING_STEP)
        k += 1
    body += list(TAIL_CAP_STEPS)
    assert all(a < b for a, b in zip(body, body[1:])), 'rings out of order'
    return body


def build_hull():
    """The whale: pole, one ring per station, pole.

    Returns GAME-space verts, the surface normals, the per-vertex tints,
    the faces, and the ring bookkeeping the checks read. WINDING, derived
    then proved by check_outward: theta runs +z -> +y and successive rings
    run AFT (-x), so a face taken (this ring k) -> (this ring k+1) -> (next
    ring k+1) -> (next ring k) has its normal along +z at theta = 0, which
    is outward; the pole fans follow the same circulation.
    """
    stations = hull_stations()
    body_tint = srgb(BODY_COLOR)
    throat_tint = srgb(VENTRAL_COLOR)
    verts = [(NOSE_X, centre_y(0.0), 0.0)]
    normals = [(1.0, 0.0, 0.0)]
    tints = [body_tint]
    ring_starts = []
    for t in stations:
        ring_starts.append(len(verts))
        for theta in THETAS:
            verts.append(surface_point(t, theta))
            normals.append(surface_normal(t, theta))
            tints.append(lerp_color(body_tint, throat_tint, throat_weight(t, theta)))
    pole_tail = len(verts)
    verts.append((HULL_TAIL_X, centre_y(1.0), 0.0))
    normals.append((-1.0, 0.0, 0.0))
    tints.append(body_tint)

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
    return {
        'verts': verts, 'normals': normals, 'tints': tints, 'faces': faces,
        'ring_starts': ring_starts, 'stations': stations, 'pole_tail': pole_tail,
    }


def hull_axis_ref(hull):
    """For check_outward: the axis point of the ring pair a face spans."""
    stations = hull['stations']
    ring_starts = hull['ring_starts']

    def ring_of(index):
        if index == 0:
            return -1
        if index == hull['pole_tail']:
            return len(stations)
        return (index - ring_starts[0]) // HULL_SEGMENTS

    def ref_of(face):
        rings = [ring_of(i) for i in face]
        lo = max(0, min(rings))
        hi = min(len(stations) - 1, max(rings))
        t = (stations[lo] + stations[hi]) / 2
        return (station_x(t), centre_y(t), 0.0)
    return ref_of


# ------------------------------------------------------------------ the fins

def loft_fin(stations, chord_segments, root_half_thickness, camber_fraction, to_game,
             cap_root=True, peak_power=FIN_THICKNESS_PEAK_POWER):
    """A fin lofted between its leading and trailing edges.

    `stations` are (b, a_lead, a_trail) from the root (first) to the tip
    (last, a single vertex at the mean of its two edges). Between them the
    chord is sampled `chord_segments` deep; each sample is offset +-h along
    the third axis of `to_game(a, b, off)` — which must be a right-handed
    basis, a x b = off — about a mean line bowed by the camber. h is
    EDGE_HALF_THICKNESS at every free edge and at the tip, rising to
    `root_half_thickness` at the root's thickest chord station
    (`peak_power`, FIN_THICKNESS_PEAK_POWER by default).

    Returns verts, faces, and the face indices of the underside sheet. The
    root row's vertices are the first 2 x (chord_segments + 1): the +off row
    then the -off row, which weld_mirrored relies on. `cap_root` closes the
    root with an n-gon; a half to be welded leaves it open.
    WINDING (derived, then proved by check_winding_with_blender): a +off
    sheet quad taken (i, j) -> (i+1, j) -> (i+1, j+1) has edges b then
    (chord = -a), and b x -a = a x b = +off, outward on that sheet; the
    -off sheet is the reverse; the edge strips face +-a; the root cap runs
    the +off row forward and the -off row back, which is -b.
    """
    N = len(stations) - 1
    M = chord_segments
    up_sign = 1.0 if to_game(0.0, 0.0, 1.0)[1] > to_game(0.0, 0.0, -1.0)[1] else -1.0
    verts = []
    plus_rows = []
    minus_rows = []
    for i in range(N):
        b, a_lead, a_trail = stations[i]
        s = i / N
        chord = a_lead - a_trail
        rows = ([], [])
        for sign, row in ((1.0, rows[0]), (-1.0, rows[1])):
            for j in range(M + 1):
                c = j / M
                a = a_lead - chord * c
                foil = math.sin(math.pi * c ** peak_power)
                h = EDGE_HALF_THICKNESS + (root_half_thickness - EDGE_HALF_THICKNESS) * (1.0 - s) * foil
                camber = up_sign * camber_fraction * chord * math.sin(math.pi * c)
                row.append(len(verts))
                verts.append(to_game(a, b, camber + sign * h))
        plus_rows.append(rows[0])
        minus_rows.append(rows[1])
    b, a_lead, a_trail = stations[N]
    tip = len(verts)
    verts.append(to_game((a_lead + a_trail) / 2, b, 0.0))

    faces = []
    plus = []
    minus = []
    for i in range(N - 1):
        P0, P1, M0, M1 = plus_rows[i], plus_rows[i + 1], minus_rows[i], minus_rows[i + 1]
        for j in range(M):
            plus.append(len(faces))
            faces.append([P0[j], P1[j], P1[j + 1], P0[j + 1]])
            minus.append(len(faces))
            faces.append([M0[j], M0[j + 1], M1[j + 1], M1[j]])
        faces.append([P0[0], M0[0], M1[0], P1[0]])
        faces.append([P0[M], P1[M], M1[M], M0[M]])
    P0, M0 = plus_rows[N - 1], minus_rows[N - 1]
    for j in range(M):
        plus.append(len(faces))
        faces.append([P0[j], tip, P0[j + 1]])
        minus.append(len(faces))
        faces.append([M0[j], M0[j + 1], tip])
    faces.append([P0[0], M0[0], tip])
    faces.append([P0[M], tip, M0[M]])
    if cap_root:
        faces.append(list(plus_rows[0]) + list(reversed(minus_rows[0])))
    underside = plus if up_sign < 0 else minus
    return verts, faces, underside


def weld_mirrored(starboard, port, chord_segments):
    """Two open-rooted halves into one wing: the port root row IS the
    starboard root row (mirrored across the centreline, its +off row lands
    on the starboard -off row and vice versa), so the port half's root
    vertices are dropped and its faces re-pointed at the starboard's."""
    s_verts, s_faces, s_under = starboard
    p_verts, p_faces, p_under = port
    row = chord_segments + 1
    for k in range(row):
        for a, b in ((p_verts[k], s_verts[row + k]), (p_verts[row + k], s_verts[k])):
            assert math.dist(a, b) < ANCHOR_TOLERANCE, 'fluke halves do not meet at the root'
    offset = len(s_verts) - 2 * row

    def remap(i):
        if i < row:
            return row + i
        if i < 2 * row:
            return i - row
        return i + offset
    verts = s_verts + p_verts[2 * row:]
    faces = s_faces + [[remap(i) for i in f] for f in p_faces]
    underside = list(s_under) + [len(s_faces) + i for i in p_under]
    return verts, faces, underside


def quad_bezier_1d(p0, p1, p2, s):
    u = 1.0 - s
    return u * u * p0 + 2 * u * s * p1 + s * s * p2


def flipper_stations():
    """(b, a_lead, a_trail) along the span: the mean line swept aft, an
    elliptically rounded, tapering chord, and the scalloped leading edge."""
    out = []
    N = FLIPPER_SPAN_SEGMENTS
    for i in range(N + 1):
        s = i / N
        mean = quad_bezier_1d(FLIPPER_MEAN_ROOT_A, FLIPPER_MEAN_CONTROL_A, FLIPPER_TIP_A, s)
        rounding = math.sqrt(max(0.0, 1.0 - s ** FLIPPER_TIP_ROUNDING_POWER))
        half = FLIPPER_ROOT_HALF_CHORD * rounding * (1.0 - FLIPPER_TAPER * s)
        scallop = 0.0
        if s > FLIPPER_SCALLOP_START:
            u = (s - FLIPPER_SCALLOP_START) / (1.0 - FLIPPER_SCALLOP_START)
            scallop = FLIPPER_SCALLOP_AMPLITUDE * max(0.0, math.sin(math.pi * FLIPPER_SCALLOPS * u))
        out.append((s * FLIPPER_SPAN, mean + half + scallop, mean - half))
    return out


def flipper_to_game(side):
    """The flipper's frame: a along x, b outward and DOWN by the hang, off =
    a x b. Returns (to_game, root) with the root at the seat inside the
    flank."""
    seat_z = FLIPPER_SEAT_FRACTION * half_width(station_t(FLIPPER_ROOT_X))
    root = (FLIPPER_ROOT_X, FLIPPER_ROOT_Y, side * seat_z)
    e_b = (0.0, -math.sin(FLIPPER_HANG_RADIANS), side * math.cos(FLIPPER_HANG_RADIANS))
    e_off = cross((1.0, 0.0, 0.0), e_b)

    def to_game(a, b, off):
        return (
            root[0] + a + b * e_b[0] + off * e_off[0],
            root[1] + b * e_b[1] + off * e_off[1],
            root[2] + b * e_b[2] + off * e_off[2],
        )
    return to_game, root


def fluke_lobe_profile(s):
    """0 at the root, EXACTLY 1 at FLUKE_LOBE_S, easing to the tip's value."""
    tip_value = (-FLUKE_TIP_A - FLUKE_NOTCH_A) / (FLUKE_REACH - FLUKE_NOTCH_A)
    if s <= FLUKE_LOBE_S:
        return math.sin(math.pi / 2 * s / FLUKE_LOBE_S)
    u = (s - FLUKE_LOBE_S) / (1.0 - FLUKE_LOBE_S)
    return 1.0 - (1.0 - tip_value) * u * u


def fluke_stations():
    """(b, a_lead, a_trail) along one blade's span, a = 0 at the hinge."""
    out = []
    N = FLUKE_SPAN_SEGMENTS
    for i in range(N + 1):
        s = i / N
        lead = quad_bezier_1d(FLUKE_ROOT_FRONT_A, FLUKE_LEAD_CONTROL_A, FLUKE_TIP_A, s)
        trail = -(FLUKE_NOTCH_A + (FLUKE_REACH - FLUKE_NOTCH_A) * fluke_lobe_profile(s))
        serration = FLUKE_SERRATION_AMPLITUDE * (1.0 - math.cos(2 * math.pi * FLUKE_SERRATIONS * s)) / 2
        trail += serration * (1.0 - s)
        if i == N:
            lead = trail = FLUKE_TIP_A
        out.append((s * FLUKE_HALF_SPAN, lead, trail))
    return out


def fluke_to_game(side):
    """The fluke's frame in the HINGE's space: a along x, b outward along
    side x z, off = a x b = -side x y."""
    def to_game(a, b, off):
        return (a, -side * off, side * b)
    return to_game


def dorsal_stations():
    out = []
    N = DORSAL_SPAN_SEGMENTS
    height = CROWN_Y - (hull_top(DORSAL_TIP_X) - FIN_SEAT_BITE)
    for i in range(N + 1):
        s = i / N
        lead = DORSAL_FRONT_X + (DORSAL_TIP_X - DORSAL_FRONT_X) * s ** DORSAL_LEAD_POWER
        trail = DORSAL_BACK_X + (DORSAL_TIP_X - DORSAL_BACK_X) * s ** DORSAL_TRAIL_POWER
        out.append((s * height, lead, trail))
    return out


def dorsal_to_game(a, b, off):
    """a along x, b up FROM THE SEAT under that x (so the root follows the
    hump's back), off = x x y = +z."""
    return (a, b + hull_top(a) - FIN_SEAT_BITE, off)


# ------------------------------------------------------------------ the knobs

def seated_sphere(t, theta, radius, sink, segments, rings):
    """A sphere on the hull at (t, theta), its centre sunk `sink` of its
    radius below the surface along the outward normal."""
    p = surface_point(t, theta)
    n = surface_normal(t, theta)
    depth = sink * radius
    centre = (p[0] - n[0] * depth, p[1] - n[1] * depth, p[2] - n[2] * depth)
    verts, faces = uv_sphere(centre, radius, segments, rings)
    return centre, verts, faces


def tubercle_sites():
    """(t, theta) of every tubercle: the rostrum's crown rows, staggered
    three and two wide; the chin pair; the jaw lines."""
    sites = []
    for row in range(TUBERCLE_ROWS):
        t = TUBERCLE_T_FIRST + row * TUBERCLE_ROW_STEP
        offsets = (-1.0, 0.0, 1.0) if row % 2 == 0 else (-0.5, 0.5)
        for k in offsets:
            sites.append((t, math.pi / 2 + k * TUBERCLE_ACROSS_RADIANS))
    for side in (-1.0, 1.0):
        sites.append((CHIN_TUBERCLE_T, 3 * math.pi / 2 + side * CHIN_TUBERCLE_RADIANS))
        for t in JAW_TUBERCLE_TS:
            sites.append((t, 3 * math.pi / 2 + side * JAW_LINE_RADIANS))
    return sites


# ------------------------------------------------------------------ the checks

def ray_hits(point, triangles):
    """Möller-Trumbore crossings of a fixed off-axis ray from `point`."""
    direction = (0.5774, 0.5774, 0.5774)
    hits = 0
    for a, b, c in triangles:
        e1 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        e2 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        p = cross(direction, e2)
        det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]
        if abs(det) < 1e-12:
            continue
        inv = 1.0 / det
        s = (point[0] - a[0], point[1] - a[1], point[2] - a[2])
        u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv
        if u < 0.0 or u > 1.0:
            continue
        q = cross(s, e1)
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
        print(f'    {name:24} {state}')
        if inside == 0:
            floating.append(name)
    assert not floating, f'parts float free of the hull: {floating}'


def check_envelope(all_verts, hull_verts, flipper_verts):
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
        ('flank', span_z, HALF_WIDTH),
    ):
        print(f'    {label:9} {measured:+.6f} vs {declared:+.6f}  '
              f'(off by {abs(measured - declared):.7f})')
        assert abs(measured - declared) < ANCHOR_TOLERANCE, (
            f'{label}: measured {measured:.4f}, anchor says {declared:.4f}')
    hull_top_max = max(v[1] for v in hull_verts)
    hull_bottom_min = min(v[1] for v in hull_verts)
    flipper_min = min(v[1] for v in flipper_verts)
    print(f'    hull back tops out at {hull_top_max:+.4f}, {CROWN_Y - hull_top_max:.4f} under the '
          f'crown; chest bottoms at {hull_bottom_min:+.4f}, {hull_bottom_min - BELLY_Y:.4f} '
          f'above the belly (a flipper tip, {flipper_min:+.6f})')
    reach_z = max(abs(v[2]) for v in all_verts)
    print(f'    widest thing on the model {reach_z:.4f} (the flippers; flank is the hull\'s '
          f'chest, the upper-bound case the install allows)')
    print(f'    length {max_x - min_x:.4f}, halfLength {(max_x - min_x) / 2:.4f}')


def check_fluke_sweep(fluke_world, hinge, body_verts):
    """The flukes pitched +-FLUKE_SWING_RADIANS about the hinge (z axis)
    stay inside the box and their x extent only shortens — the sheet's
    argument for ONE envelope, asserted. The body roll (BODY_ROLL_FRACTION
    of the swing, about the origin) is then applied to everything and
    PRINTED against placement.ts's clearance: a roll of 0.036 rad lifts a
    crown 0.9 behind the origin by 0.03, which is exactly the 0.7 - 0.67
    the swim profile leaves — a property of the animation the procedural
    whale already had, not of this file, so it is reported, not asserted."""
    def pitched(v, angle, about):
        dx, dy = v[0] - about[0], v[1] - about[1]
        c, s = math.cos(angle), math.sin(angle)
        return (about[0] + dx * c - dy * s, about[1] + dx * s + dy * c, v[2])

    reach = max(math.hypot(v[0] - hinge[0], v[1] - hinge[1]) for v in fluke_world)
    rest_min_x = min(v[0] for v in fluke_world)
    print(f'  fluke sweep: hinge x {hinge[0]:+.4f} y {hinge[1]:+.4f}, tip reach {reach:.4f} '
          f'from the hinge')
    for swing in (FLUKE_SWING_RADIANS, -FLUKE_SWING_RADIANS):
        posed = [pitched(v, swing, hinge) for v in fluke_world]
        ys = [v[1] for v in posed]
        min_x = min(v[0] for v in posed)
        print(f'    flukes {swing:+.2f} rad: y [{min(ys):+.4f}, {max(ys):+.4f}] '
              f'(box {BELLY_Y:+.3f}..{CROWN_Y:+.3f}); x min {min_x:+.4f} vs rest '
              f'{rest_min_x:+.4f} ({rest_min_x - min_x:+.4f} shorter)')
        assert BELLY_Y - ANCHOR_TOLERANCE <= min(ys) and max(ys) <= CROWN_Y + ANCHOR_TOLERANCE
        assert min_x >= rest_min_x - ANCHOR_TOLERANCE
        roll = swing * BODY_ROLL_FRACTION
        rolled = [pitched(v, roll, (0.0, 0.0)) for v in posed + body_verts]
        ys = [v[1] for v in rolled]
        print(f'    + body roll {roll:+.4f} rad: whole model y [{min(ys):+.4f}, {max(ys):+.4f}] '
              f'against placement clearance +-{PLACEMENT_CLEARANCE}')


# ------------------------------------------------------------------ the build

def add_part(name, verts, faces, material, joint, normals=None):
    """A mesh authored in the frame of `joint` (the rig, or the hinge whose
    blade is authored about it), hung under it."""
    obj = make_object(name, verts, faces, normals)
    obj.data.materials.append(material)
    parent_to(obj, joint)
    return obj


def add_fin(name, verts, faces, underside, top_material, under_material, joint):
    """A lofted fin as two objects under one joint: the blade with its
    upper sheet and edges in the body colour, and its underside sheet in the
    ventral tone. The closed solid is what the winding check saw."""
    check_winding_with_blender(name, verts, faces)
    under = set(underside)
    top_faces = [f for i, f in enumerate(faces) if i not in under]
    under_faces = [faces[i] for i in underside]
    tv, tf, _ = compact(verts, top_faces)
    add_part(name, tv, tf, top_material, joint)
    uv, uf, _ = compact(verts, under_faces)
    add_part(f'{name}_underside', uv, uf, under_material, joint)


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    out_path = args[0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    body_material = flat_material('humpback_body', srgb(BODY_COLOR))
    hull_material = tinted_material('humpback_hull')
    ventral_material = flat_material('humpback_ventral', srgb(VENTRAL_COLOR))
    eye_material = flat_material('humpback_eye', srgb(EYE_COLOR))

    print('humpback build:')

    # ---- the rig root: every part of the whale hangs under it ----
    rig = make_empty('rig', (0.0, 0.0, 0.0))

    # ---- the hull, its throat a vertex-colour gradient ----
    hull = build_hull()
    hull_faces = hull['faces']
    throat_vertices = sum(1 for tint in hull['tints'] if tint != srgb(BODY_COLOR))
    print(f'  hull: {len(hull["stations"])} rings x {HULL_SEGMENTS} segments '
          f'({throat_vertices} vertices tinted toward the throat tone)')
    check_outward('hull', hull['verts'], hull_faces, hull_axis_ref(hull))
    check_winding_with_blender('hull', hull['verts'], hull_faces)
    body = add_part('body', hull['verts'], hull_faces, hull_material, rig, normals=hull['normals'])
    paint_tints(body, hull['tints'])
    shell = triangulate(hull['verts'], hull_faces)

    parts = []
    flipper_verts = []

    # ---- flippers: rigid, baked at their hang, the starboard tip the belly ----
    # Right-handed frame with +X forward and +Y up puts PORT at -Z
    # (left = up x forward = Y x X = -Z).
    for name, side in (('flipper_port', -1.0), ('flipper_starboard', 1.0)):
        to_game, _root = flipper_to_game(side)
        verts, faces, underside = loft_fin(
            flipper_stations(), FLIPPER_CHORD_SEGMENTS, FLIPPER_ROOT_HALF_THICKNESS,
            FIN_CAMBER_FRACTION, to_game)
        add_fin(name, verts, faces, underside, body_material, ventral_material, rig)
        parts.append((name, verts))
        flipper_verts.extend(verts)

    # ---- the dorsal on the hump ----
    verts, faces, _underside = loft_fin(
        dorsal_stations(), DORSAL_CHORD_SEGMENTS, DORSAL_ROOT_HALF_THICKNESS, 0.0, dorsal_to_game)
    check_winding_with_blender('dorsal', verts, faces)
    add_part('dorsal', verts, faces, body_material, rig)
    parts.append(('dorsal', verts))

    # ---- tubercles and eyes, seated into the hull ----
    tubercle_verts = []
    for index, (t, theta) in enumerate(tubercle_sites()):
        centre, verts, faces = seated_sphere(t, theta, TUBERCLE_RADIUS, TUBERCLE_SINK,
                                             TUBERCLE_SEGMENTS, TUBERCLE_RINGS)
        name = f'tubercle_{index:02d}'
        check_outward(name, verts, faces, lambda _face, c=centre: c)
        add_part(name, verts, faces, body_material, rig)
        tubercle_verts.extend(verts)
        parts.append((name, verts))
    for name, side in (('eye_port', -1.0), ('eye_starboard', 1.0)):
        theta = (math.pi if side < 0 else 0.0) - side * EYE_ARC_BELOW_FLANK
        centre, verts, faces = seated_sphere(EYE_T, theta, EYE_RADIUS, EYE_SINK, EYE_SEGMENTS, EYE_RINGS)
        check_outward(name, verts, faces, lambda _face, c=centre: c)
        check_winding_with_blender(name, verts, faces)
        add_part(name, verts, faces, eye_material, rig)
        parts.append((name, verts))

    # ---- the fluke hinge, AT THE PEDUNCLE; the welded wing under it ----
    peduncle_t = station_t(PEDUNCLE_X)
    hinge = (PEDUNCLE_X, centre_y(peduncle_t), 0.0)
    flukes = make_empty('flukes', hinge)
    parent_to(flukes, rig)
    halves = [
        loft_fin(fluke_stations(), FLUKE_CHORD_SEGMENTS, FLUKE_ROOT_HALF_THICKNESS,
                 FLUKE_CAMBER_FRACTION, fluke_to_game(side), cap_root=False,
                 peak_power=FLUKE_THICKNESS_PEAK_POWER)
        for side in (1.0, -1.0)
    ]
    local, faces, underside = weld_mirrored(halves[0], halves[1], FLUKE_CHORD_SEGMENTS)
    add_fin('flukes_blade', local, faces, underside, body_material, ventral_material, flukes)
    fluke_world = [(a + hinge[0], b + hinge[1], c + hinge[2]) for a, b, c in local]
    parts.append(('flukes_blade', fluke_world))

    # ---- checks, on the GAME-space vertices the parts were authored from ----
    check_attachment(shell, parts)
    all_verts = list(hull['verts'])
    for _name, verts in parts:
        all_verts.extend(verts)
    check_envelope(all_verts, hull['verts'], flipper_verts)
    body_verts = [v for v in all_verts if v not in fluke_world]
    check_fluke_sweep(fluke_world, hinge, body_verts)

    # ---- anchors: what the plugin measures HUMPBACK_ENVELOPE from ----
    make_empty('nose', (NOSE_X, centre_y(0.0), 0.0))
    make_empty('tail_tip', (TAIL_TIP_X, hinge[1], 0.0))
    make_empty('crown', (DORSAL_TIP_X, CROWN_Y, 0.0))
    starboard_tip = flipper_to_game(1.0)[0](FLIPPER_TIP_A, FLIPPER_SPAN, 0.0)
    make_empty('belly', (starboard_tip[0], BELLY_Y, starboard_tip[2]))
    # The hull's chest at its widest — the envelope's halfWidth is the BODY's;
    # the flippers reach further and are checked as an upper bound only.
    make_empty('flank', (station_x(FLANK_T), centre_y(FLANK_T), HALF_WIDTH))

    bake_object_transforms()
    export_scene_glb(out_path)

    total_tris = 0
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        total_tris += tris
        if not obj.name.startswith('tubercle_'):
            print(f'  {obj.name}: {len(mesh.polygons)} polys, {tris} tris')
    tubercles = [o for o in bpy.data.objects if o.name.startswith('tubercle_')]
    print(f'  tubercles x {len(tubercles)}: '
          f'{sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in tubercles)} tris')
    print(f'humpback -> {out_path}: {total_tris} tris total')


main()
