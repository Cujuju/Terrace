# build_sperm_whale.py — builds the Terrace sperm whale in Blender and exports it.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_sperm_whale.py -- \
#     E:\...\Terrace\plugins\wildlife\client\assets\sperm-whale.glb
#
# WHAT IT BUILDS (docs/model-assets.md is the convention this satisfies, and
# its "Wildlife species" section is the joint convention). Pass 8 of the
# fish+whales arc: the third and last WHALE body, after the humpback
# (build_humpback.py) and the blue whale (build_blue_whale.py, whose pattern
# this repeats). The sperm whale is `whale` variant 2 on the wire
# (plugins/wildlife/client/whaleSpecies.ts WHALE_SPECIES) and, like every whale
# asset, it FILLS the whale placement box exactly — crown 0.670, belly -0.575,
# nose to fluke trailing edge 5.05 — with the hull's own half-width the one free
# envelope figure (plugins/wildlife/client/species/spermWhale.ts
# SPERM_WHALE_HALF_WIDTH): the widest of the three whales.
#
#   rig                   Empty at the origin; the whole body hangs under it.
#     body                the swept hull: a third of it is HEAD, and the head
#                         does not taper — it stops: a boxy (superellipse)
#                         section with a blunt, near-vertical front, the
#                         blowhole a crater at the front-LEFT of the top,
#                         wrinkled prune skin behind the head as shallow
#                         relief on the flanks, NO dorsal fin — a rounded hump
#                         two thirds back that IS the crown, then a row of
#                         knuckles down the tail stock. Smooth-shaded with
#                         numeric normals of the full surface, so the relief
#                         shades. Plain body-tone material.
#     jaw                 the narrow, underslung lower jaw: a rod beneath the
#                         head, stopping short of the snout so the head
#                         overhangs it, its aft end buried in the throat. A
#                         body part, no joint. Its colour is a VERTEX COLOUR
#                         (COLOR_0) under a white material: the pale lip tone,
#                         fading to the body tone where it enters the throat
#                         (rigSkin multiplies material by attribute —
#                         client/src/render/rigSkin.ts paintVertexColor).
#     flipper_port / flipper_starboard
#                         RIGID body parts, no joint: short, paddle-shaped,
#                         lofted with root thickness and camber, rooted low
#                         behind the head; dark both sides, one closed object
#                         each.
#     eye_port / eye_starboard
#                         one per side, at the corner of the mouth, small.
#     flukes              Empty AT THE PEDUNCLE, identity rotation; both fluke
#                         blades hang under it as ONE welded wing
#                         (flukes_blade), so the plugin's pitch about Z sweeps
#                         them from the tail stock. Broad, triangular, with a
#                         DEEP notch; the lobes' trailing edge is the TAIL_TIP.
#   nose / tail_tip / crown / belly / flank
#                         anchor Empties; the plugin measures
#                         SPERM_WHALE_ENVELOPE from these and refuses an asset
#                         that disagrees.
#
# THE CROWN IS THE HUMP, THE BELLY IS THE CHEST. The species sheet fixes the
# hump as the crown (there is no dorsal fin); the back's profile plateaus at
# CROWN_Y over the hump (a monotone profile's plateau IS its value) and the
# knuckles behind it are proven to stay KNUCKLE_BELOW_CROWN under. For the
# belly the sheet offered the jaw's underside or the chest, and this body takes
# the CHEST: the hull's bottom plateaus at BELLY_Y behind the head, and the
# jaw — which shows below the head, as "underslung" requires — bottoms out
# JAW_ABOVE_BELLY above it (asserted), as do the flippers. Both extremes are
# hull geometry at rest, so nothing `animate` assigns can be an extreme.
#
# THE REFERENCE SILHOUETTE is the procedural sperm whale this replaces
# (whaleSpecies.ts spermSet, removed in this pass). Its width profile, on an
# authored length of 6.2 and a max half-width of 0.56, was
#   (0.00 0.72) (0.02 0.86) (0.06 0.95) (0.14 0.99) (0.24 1.00) (0.33 0.97)
#   (0.44 0.90) (0.55 0.79) (0.66 0.65) (0.76 0.50) (0.84 0.37) (0.90 0.26)
#   (0.95 0.16) (1.00 0.08)
# and its height-over-width ratio
#   (0.00 1.02) (0.10 1.06) (0.22 1.08) (0.33 1.06) (0.48 1.02) (0.62 1.10)
#   (0.74 1.34) (0.86 1.75) (0.94 2.10) (1.00 2.30)
# with boxiness 1 -> 0.25 over the head's first 0.33 of the body, a 0.055 hump
# at t 0.68, 5 knuckles 0.030 tall from t 0.72 to 0.93, 16 wrinkles 0.010 deep
# from t 0.34 to 0.62, a jaw (length 2.40, half-width 0.12) at (1.85, -0.60),
# flippers rooted at x 0.95 pitched (0.34, -0.18, -0.20) and flukes rooted at
# x -2.80. That body was fitted into the box at 0.7805 and came out 5.05 long
# but only -0.551..0.473 tall (its scale capped by the length); this one is
# drawn straight into the box.
#
# EVERY DIMENSION IS A NAMED CONSTANT IN GAME SPACE: x forward, y up, z
# lateral, one unit = one cell. `bl()` is the only place the Blender frame
# (x length, y beam, z up) is spoken.
#
# CHECKS IT PRINTS AND ASSERTS, because a model is a claim until measured:
#   * winding: every hull and jaw face agrees with an outward test from its
#     own ring's axis point; every sphere from its centre; and EVERY closed
#     part is handed to Blender's own outward recalculation on a scratch copy,
#     which must not flip a single face.
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
# contract); the half-width is species/spermWhale.ts SPERM_WHALE_HALF_WIDTH.

#: WHALE_ENVELOPE.length: nose tip to the flukes' trailing edge.
LENGTH = 5.05
#: WHALE_ENVELOPE.crownY: the hump's plateau (CROWN_T).
CROWN_Y = 0.670
#: WHALE_ENVELOPE.bellyY: the chest's bottom plateau (BELLY_T).
BELLY_Y = -0.575
#: The hull's widest half-width, over the head and chest: the `flank` anchor.
#: The widest of the three whales — the procedural body's fitted hull
#: measured 0.4375, and a sperm whale is a barrel with a box on the front.
HALF_WIDTH = 0.44

#: The front's pole vertex: the model's forward extreme, the envelope's
#: front. Centred, so the box straddles the origin the way the procedural
#: whale's fitted body did.
NOSE_X = LENGTH / 2
#: The flukes' trailing edge at its furthest lobe: the `tail_tip` anchor.
TAIL_TIP_X = -LENGTH / 2
#: The peduncle: the fluke hinge. The flukes reach FLUKE_REACH behind it.
FLUKE_REACH = 0.50
PEDUNCLE_X = TAIL_TIP_X + FLUKE_REACH
#: The hull's own tapered aft end: AT the hinge. Its tail cap (the last
#: TAIL_CAP_FRACTION) shrinks inside the flukes' root thickness, and the
#: flukes' leading root (FLUKE_ROOT_FRONT_A ahead of the hinge) is buried in
#: the tail stock; nothing of the hull sits behind the hinge, so nothing
#: rigid can show through a pitched fluke.
HULL_TAIL_X = PEDUNCLE_X

HULL_LENGTH = NOSE_X - HULL_TAIL_X

#: The back's height and the belly's depth along the body, ABSOLUTE y by
#: station t (0 the front, 1 the hull's aft end). Two lines rather than a
#: centreline plus a height so the head can be a tall box (a flat top at
#: HEAD_TOP_Y and a flat bottom the jaw hangs under), the back can dip behind
#: the head and rise into the HUMP — whose plateau t 0.64-0.69 IS CROWN_Y —
#: the chest can sit on its own plateau at BELLY_Y (t 0.40-0.50), and the
#: tail stock can RISE toward the peduncle. Monotone cubic through each (no
#: overshoot: a plateau is the extreme). The section centre is their mean and
#: the half-height half their difference. Over the last tenth the two converge
#: to about the flukes' root thickness, so the stock sinks into the wing's
#: upper surface rather than riding over it (the humpback's lesson).
HEAD_TOP_Y = 0.585
TOP_PROFILE = (
    (0.00, 0.50), (0.04, 0.56), (0.10, HEAD_TOP_Y), (0.30, HEAD_TOP_Y),
    (0.42, 0.565), (0.52, 0.585), (0.60, 0.645), (0.64, CROWN_Y),
    (0.69, CROWN_Y), (0.74, 0.62), (0.80, 0.52), (0.86, 0.42),
    (0.92, 0.30), (0.96, 0.21), (1.00, 0.16),
)
#: The head's flat underside: what the jaw shows BELOW. Raised from -0.46
#: after the first side render, where the jaw read as a hairline: at -0.43
#: about 0.12 of the jaw's 0.18 depth shows under the head.
HEAD_BOTTOM_Y = -0.43
BOTTOM_PROFILE = (
    (0.00, -0.34), (0.04, -0.42), (0.12, HEAD_BOTTOM_Y), (0.30, HEAD_BOTTOM_Y),
    (0.36, -0.52), (0.40, BELLY_Y), (0.50, BELLY_Y), (0.60, -0.535),
    (0.70, -0.44), (0.80, -0.30), (0.88, -0.16), (0.94, -0.03),
    (0.97, 0.06), (1.00, 0.10),
)
#: Half-width as a fraction of HALF_WIDTH by station: nearly full at the
#: blunt front, a PLATEAU over the whole head and chest (t 0.14-0.34, where
#: the flank anchor is read), then a long collapse to the tail stock.
WIDTH_PROFILE = (
    (0.00, 0.70), (0.03, 0.88), (0.08, 0.97), (0.14, 1.00), (0.34, 1.00),
    (0.44, 0.95), (0.54, 0.86), (0.64, 0.72), (0.74, 0.56), (0.82, 0.42),
    (0.88, 0.30), (0.94, 0.19), (1.00, 0.12),
)
#: Ring stations on the three plateaus where the anchors are read (asserted
#: to be stations in main).
FLANK_T = 0.235
CROWN_T = 0.665
BELLY_T = 0.44

#: The section is a SUPERELLIPSE: |z/hw|^p + |y/hh|^p = 1. Power 2 is the
#: ellipse the other whales are; higher fills the corners toward a box. The
#: head is boxy (HEAD_SECTION_POWER) to HEAD_BOX_END_T and eases to round by
#: HEAD_BOX_FADE_T — a third of the animal is a squared-off head, the rest a
#: barrel.
HEAD_SECTION_POWER = 3.4
ROUND_SECTION_POWER = 2.0
HEAD_BOX_END_T = 0.30
HEAD_BOX_FADE_T = 0.50

#: Segments around a ring: QUADRANT_SEGMENTS per quadrant, uniform in the
#: section angle, so the flank lines (0, pi), the back (pi/2) and the belly
#: (3pi/2) are vertex rows and the blowhole's centre (BLOWHOLE_ARC, two grid
#: steps port of the back line) is one too — plus BLOWHOLE_EXTRA_ARCS extra
#: rows either side of that centre so the crater has a slope.
QUADRANT_SEGMENTS = 7
#: Ring stations (t = 0 at the front, 1 at the hull's aft end): the front
#: rounds off over NOSE_CAP_FRACTION sampled at NOSE_CAP_STEPS — short, and
#: a high-power superellipse in BOTH plan and height (NOSE_CAP_POWER), which
#: is what makes the front a wall rather than a dome (the procedural body's
#: "almost no axial reach on the nose cap" said the same thing) — then the
#: body every RING_STEP, denser through the wrinkle and knuckle windows (see
#: hull_stations), the aft end over TAIL_CAP_FRACTION.
NOSE_CAP_FRACTION = 0.06
NOSE_CAP_STEPS = (0.012, 0.024, 0.036, 0.048, 0.06)
NOSE_CAP_POWER = 4.0
RING_STEP = 0.025
#: The tail cap is LONG so the stock sinks into the wing (see TOP_PROFILE).
TAIL_CAP_FRACTION = 0.08
TAIL_CAP_STEPS = (0.935, 0.955, 0.972, 0.985, 0.994)

#: The blowhole: a crater at the front-LEFT of the head's top (a sperm
#: whale's is famously off-centre, to port), BLOWHOLE_T back from the front
#: (a ring station) and BLOWHOLE_ARC port of the back line (a vertex row).
#: A parabolic bowl BLOWHOLE_DEPTH deep and BLOWHOLE_RADIUS across, ringed by
#: a lip BLOWHOLE_RIM tall out to BLOWHOLE_RIM_RADIUS; distances are measured
#: on the surface, with the arc scaled by the head's half-height there.
#: Extra ring stations and vertex rows a half step either side of the centre
#: give the bowl a slope instead of a single sunk vertex.
BLOWHOLE_T = 0.085
BLOWHOLE_ARC = math.pi / 2 + 2 * (math.pi / 2 / QUADRANT_SEGMENTS)
BLOWHOLE_DEPTH = 0.03
BLOWHOLE_RADIUS = 0.10
BLOWHOLE_RIM = 0.012
BLOWHOLE_RIM_RADIUS = 0.17
BLOWHOLE_EXTRA_STATIONS = (0.0725, 0.0975)
BLOWHOLE_EXTRA_ARCS = (0.11,)

#: The wrinkles: prune skin behind the head, WRINKLE_COUNT shallow grooves
#: across the flanks from WRINKLE_T_START to WRINKLE_T_END, each
#: WRINKLE_DEPTH into the hull along its normal, with a sine window along the
#: body and strongest at the flank lines (nothing on the back or the belly).
#: The groove is a cosine in the station, sampled WRINKLE_VERTICES_PER_WRINKLE
#: times per wrinkle: THREE, not two, because with a vertex at each crest and
#: each trough every vertex normal is the same and the grooves shade flat
#: (the blue whale's pleats taught this). Seven grooves stand for the
#: animal's many: the window is 1.3 cells long and the hull budget stops
#: there.
WRINKLE_COUNT = 7
WRINKLE_VERTICES_PER_WRINKLE = 3
WRINKLE_DEPTH = 0.014
WRINKLE_T_START = 0.36
WRINKLE_T_END = 0.64

#: The knuckles: KNUCKLE_COUNT bumps down the ridge of the tail stock behind
#: the hump, from KNUCKLE_T_START to KNUCKLE_T_END, KNUCKLE_HEIGHT tall at
#: the first and fading by KNUCKLE_FADE toward the last, confined to the back
#: (a cubed up-weight). Sampled as the wrinkles are. KNUCKLE_BELOW_CROWN is
#: what the build asserts, so a knuckle can never quietly become the crown.
KNUCKLE_COUNT = 5
KNUCKLE_VERTICES_PER_KNUCKLE = 3
KNUCKLE_HEIGHT = 0.032
KNUCKLE_T_START = 0.74
KNUCKLE_T_END = 0.925
KNUCKLE_FADE = 0.5
KNUCKLE_BELOW_CROWN = 0.02

#: The jaw: a rod from JAW_TIP_X (JAW_SETBACK behind the front, so the head
#: overhangs it) aft to JAW_AFT_X, its centre line falling from JAW_AFT_Y
#: inside the throat to JAW_TIP_Y at the tip, JAW_HALF_WIDTH by
#: JAW_HALF_HEIGHT in section at its fullest (JAW_PROFILE, by jaw station:
#: a rounded tip, full through the middle, slimming where it is buried).
#: Its underside lands at JAW_TIP_Y - JAW_HALF_HEIGHT = -0.55, JAW_ABOVE_BELLY
#: above the chest: the chest is the belly, as the header says.
JAW_SETBACK = 0.42
JAW_LENGTH = 1.40
JAW_TIP_X = NOSE_X - JAW_SETBACK
JAW_AFT_X = JAW_TIP_X - JAW_LENGTH
JAW_TIP_Y = -0.46
JAW_AFT_Y = -0.40
JAW_HALF_WIDTH = 0.075
JAW_HALF_HEIGHT = 0.09
JAW_PROFILE = (
    (0.00, 0.00), (0.05, 0.50), (0.15, 0.85), (0.35, 1.00), (0.70, 0.95),
    (1.00, 0.55),
)
JAW_RINGS = 16
JAW_SEGMENTS = 12
JAW_ABOVE_BELLY = 0.02
#: The lip tone fades to the body tone over this window of jaw station, so
#: the pale jaw melts into the throat instead of ending at a line.
JAW_TINT_FADE_START = 0.55
JAW_TINT_FADE_END = 0.95

#: Flippers. Short paddles: rooted low behind the head at FLIPPER_ROOT_X /
#: FLIPPER_ROOT_Y (below the section centre), spanning FLIPPER_SPAN — under
#: a tenth of the body — hung FLIPPER_HANG_RADIANS below level and swept aft
#: to FLIPPER_TIP_A. The tip lands at root_y - SPAN x sin(hang) = -0.517,
#: above the belly: the chest is the belly.
FLIPPER_ROOT_X = 0.80
FLIPPER_ROOT_Y = -0.33
FLIPPER_SPAN = 0.48
FLIPPER_HANG_RADIANS = 0.40
#: The hinge-less root sits this fraction of the local half-width out from
#: the axis: inside the flank, so the root is buried.
FLIPPER_SEAT_FRACTION = 0.75
#: Root half-chord, and the outline's mean line: a quadratic from the root
#: through FLIPPER_MEAN_CONTROL_A (at half span) to FLIPPER_TIP_A.
FLIPPER_ROOT_HALF_CHORD = 0.16
FLIPPER_MEAN_ROOT_A = 0.0
FLIPPER_MEAN_CONTROL_A = -0.02
FLIPPER_TIP_A = -0.18
#: Half-chord taper: power 2 is an ellipse's rounding — a PADDLE, full
#: through the span and rounded at the tip — with a gentle linear taper.
FLIPPER_TIP_ROUNDING_POWER = 2.0
FLIPPER_TAPER = 0.25
#: Span stations and chord segments of the loft.
FLIPPER_SPAN_SEGMENTS = 12
FLIPPER_CHORD_SEGMENTS = 4
FLIPPER_ROOT_HALF_THICKNESS = 0.04

#: Flukes, authored with a = 0 AT THE HINGE (the flukes Empty), b outward.
#: Root chord from FLUKE_ROOT_FRONT_A (buried in the tail stock) back to the
#: NOTCH, FLUKE_NOTCH_A behind the hinge. The two blades are lofted from the
#: centreline out and WELDED there into one wing (their root rows are the
#: same points, mirrored): two blades meeting at the centreline either share
#: a face (a z-fighting slot down the notch) or split their smooth normals
#: along a crease, and a wing does neither (the humpback's lesson). The
#: leading edge runs nearly straight back to a pointed tip at (FLUKE_TIP_A,
#: FLUKE_HALF_SPAN) — TRIANGULAR — and the trailing edge runs aft from the
#: notch to its lobe at FLUKE_LOBE_S (exactly FLUKE_REACH behind the hinge:
#: the tail tip) and forward again to the tip. BROAD (nearly three tenths of
#: the body across) and the notch DEEP: reach less notch is 0.22 of a cell,
#: twice the blue whale's.
FLUKE_HALF_SPAN = 0.72
FLUKE_ROOT_FRONT_A = 0.36
FLUKE_NOTCH_A = 0.28
FLUKE_TIP_A = -0.30
FLUKE_LEAD_CONTROL_A = 0.16
FLUKE_LOBE_S = 0.40
#: Twenty span stations so the lobe (s 0.40) is a station and the trailing
#: edge's extreme is a vertex, exactly.
FLUKE_SPAN_SEGMENTS = 20
FLUKE_CHORD_SEGMENTS = 4
FLUKE_ROOT_HALF_THICKNESS = 0.055

#: Camber of the lofted flippers: the mean line bows UP by this fraction of
#: the local chord at mid-chord.
FIN_CAMBER_FRACTION = 0.04
#: Where along the chord a fin is thickest: the thickness runs as
#: sin(pi c^POWER), and 0.7 puts the peak near 37 percent of chord — a foil,
#: thick at the shoulder and tapering to its trailing edge.
FIN_THICKNESS_PEAK_POWER = 0.7
#: The flukes' own: their thickest station is where the tail stock's back
#: sinks into them (a quarter chord, 0.5), and their camber is half the
#: flippers', so the stock meets a wing surface that is level rather than
#: still rising (the humpback's lesson).
FLUKE_THICKNESS_PEAK_POWER = 0.5
FLUKE_CAMBER_FRACTION = 0.02
#: Half-thickness at every free edge (a lens section, not a plate).
EDGE_HALF_THICKNESS = 0.005

#: Eyes: one per side at the corner of the mouth — the head's aft end, low,
#: just above the jaw — mostly buried, and SMALL.
EYE_T = 0.30
EYE_ARC_BELOW_FLANK = 0.75
EYE_RADIUS = 0.035
EYE_SINK = 0.5
EYE_SEGMENTS = 8
EYE_RINGS = 4

#: Colours, as sRGB hexes. THESE ARE sRGB AND BLENDER'S BASE COLOR AND
#: COLOR_0 ARE LINEAR — see srgb() below. BODY_COLOR is the WHALE_COLOR the
#: procedural whales wore, the colour the owner reads a whale by; LIP_COLOR
#: is the sperm whale's white lower jaw and lips, the one paler tone the
#: species sheet allows, on the jaw only, where it rides in the vertex
#: colour under a white material; the hull, the fins and the eyes are plain
#: materials.
BODY_COLOR = 0x39506B
LIP_COLOR = 0xB8C4CF
EYE_COLOR = 0x0B0E13

#: ONE roughness and ONE metalness across every material on this model.
#: rigSkin.ts's materialSignature keys on roughness and metalness but NOT on
#: colour, so three colours at one roughness bake to ONE surface — the draw
#: budget plugins/wildlife/client/index.ts asserts for each whale. 0.5 is a
#: wet, slightly glossy body.
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
    control points IS the extreme, exactly, so the crown, the belly and the
    flank read off their plateaus are the true extremes.
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
JAW = monotone_profile(JAW_PROFILE)


def smoothstep(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3.0 - 2.0 * u)


def cap_factor(t):
    """Rounds the sweep into closed caps at both ends: a superellipse of
    NOSE_CAP_POWER at the front (a wall with rounded edges), a quarter
    ellipse at the tail."""
    if t < NOSE_CAP_FRACTION:
        u = 1.0 - t / NOSE_CAP_FRACTION
        return max(0.0, 1.0 - u ** NOSE_CAP_POWER) ** (1.0 / NOSE_CAP_POWER)
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


def section_power(t):
    """The section's superellipse power at t: boxy over the head, easing to
    round behind it."""
    u = (t - HEAD_BOX_END_T) / (HEAD_BOX_FADE_T - HEAD_BOX_END_T)
    return HEAD_SECTION_POWER + (ROUND_SECTION_POWER - HEAD_SECTION_POWER) * smoothstep(u)


def superellipse(theta, power):
    """(across, up) on the unit superellipse |x|^p + |y|^p = 1 at the
    section angle theta: theta = 0 is +across (starboard), pi/2 is up."""
    c = math.cos(theta)
    s = math.sin(theta)
    e = 2.0 / power
    return (math.copysign(abs(c) ** e, c), math.copysign(abs(s) ** e, s))


def smooth_point(t, theta):
    """A point on the SMOOTH hull, before the relief.

    theta = 0 is the starboard flank, pi/2 the back, pi the port flank,
    3pi/2 the belly.
    """
    across, up = superellipse(theta, section_power(t))
    return (
        station_x(t),
        centre_y(t) + half_height(t) * up,
        half_width(t) * across,
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


#: The head's half-height at the blowhole: what scales the crater's arc
#: distance onto the surface.
BLOWHOLE_LOCAL_RADIUS = (TOP(BLOWHOLE_T) - BOTTOM(BLOWHOLE_T)) / 2


def blowhole(t, theta):
    """The crater's relief along the normal at (t, theta): a parabolic bowl
    inside BLOWHOLE_RADIUS, a raised lip out to BLOWHOLE_RIM_RADIUS."""
    dx = (t - BLOWHOLE_T) * HULL_LENGTH
    darc = (theta - BLOWHOLE_ARC) * BLOWHOLE_LOCAL_RADIUS
    r = math.hypot(dx, darc)
    if r >= BLOWHOLE_RIM_RADIUS:
        return 0.0
    if r < BLOWHOLE_RADIUS:
        return -BLOWHOLE_DEPTH * (1.0 - (r / BLOWHOLE_RADIUS) ** 2)
    u = (r - BLOWHOLE_RADIUS) / (BLOWHOLE_RIM_RADIUS - BLOWHOLE_RADIUS)
    return BLOWHOLE_RIM * math.sin(math.pi * u)


def groove(t, start, end, count):
    """A cosine bump train along the body: 0 at `start`, `count` crests to
    `end`, sampled by the ring stations (see hull_stations)."""
    phase = (t - start) / ((end - start) / count)
    return (1.0 - math.cos(2 * math.pi * phase)) / 2


def wrinkle(t, theta):
    """The wrinkles' depth (negative, along the normal) at (t, theta):
    strongest at the flank lines, nothing on the back or the belly."""
    if t <= WRINKLE_T_START or t >= WRINKLE_T_END:
        return 0.0
    along = math.sin(math.pi * (t - WRINKLE_T_START) / (WRINKLE_T_END - WRINKLE_T_START))
    flank = 1.0 - abs(math.sin(theta))
    return -WRINKLE_DEPTH * along * flank * groove(t, WRINKLE_T_START, WRINKLE_T_END, WRINKLE_COUNT)


def knuckle(t, theta):
    """The knuckles' rise (along the normal) at (t, theta): on the back only,
    fading down the stock."""
    if t <= KNUCKLE_T_START or t >= KNUCKLE_T_END:
        return 0.0
    up = max(0.0, math.sin(theta)) ** 3
    u = (t - KNUCKLE_T_START) / (KNUCKLE_T_END - KNUCKLE_T_START)
    return KNUCKLE_HEIGHT * up * (1.0 - KNUCKLE_FADE * u) * groove(t, KNUCKLE_T_START, KNUCKLE_T_END, KNUCKLE_COUNT)


def surface_point(t, theta):
    """A point on the hull AS BUILT: the smooth section plus the blowhole,
    the wrinkles and the knuckles along the smooth normal."""
    p = smooth_point(t, theta)
    relief = blowhole(t, theta) + wrinkle(t, theta) + knuckle(t, theta)
    if relief == 0.0:
        return p
    n = smooth_normal(t, theta)
    return (p[0] + n[0] * relief, p[1] + n[1] * relief, p[2] + n[2] * relief)


def surface_normal(t, theta):
    """The normal of the hull AS BUILT — so the relief shades."""
    return surface_normal_of(surface_point, t, theta)


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


#: The name of the jaw's colour attribute; the exporter writes it as COLOR_0.
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


def lerp_color(a, b, w):
    return tuple(a[i] + (b[i] - a[i]) * w for i in range(4))


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


# ------------------------------------------------------------------ the hull

def ring_thetas():
    """Section angles of one ring: the quadrant grid all the way round,
    with the blowhole's extra rows slipped in either side of its centre."""
    step = math.pi / 2 / QUADRANT_SEGMENTS
    thetas = [i * step for i in range(4 * QUADRANT_SEGMENTS)]
    assert any(abs(theta - BLOWHOLE_ARC) < 1e-9 for theta in thetas), 'the blowhole is not a vertex row'
    for arc in BLOWHOLE_EXTRA_ARCS:
        thetas.append(BLOWHOLE_ARC - arc)
        thetas.append(BLOWHOLE_ARC + arc)
    thetas.sort()
    assert len(set(thetas)) == len(thetas), 'a blowhole row lands on a grid row'
    return thetas


THETAS = ring_thetas()
HULL_SEGMENTS = len(THETAS)


def window_stations(start, end, count, per):
    """The ring stations of a relief window: `count x per` steps from just
    after `start` to `end` inclusive."""
    n = count * per
    return [start + (end - start) * k / n for k in range(1, n + 1)]


def hull_stations():
    """Every ring station, front to aft end: the nose cap, the head every
    RING_STEP with the blowhole's extra stations, the wrinkle window at
    WRINKLE_VERTICES_PER_WRINKLE per wrinkle, the hump every RING_STEP, the
    knuckle window at KNUCKLE_VERTICES_PER_KNUCKLE per knuckle, the tail
    cap."""
    body = list(NOSE_CAP_STEPS)
    k = 1
    while NOSE_CAP_FRACTION + k * RING_STEP < WRINKLE_T_START - 1e-9:
        body.append(NOSE_CAP_FRACTION + k * RING_STEP)
        k += 1
    body.append(WRINKLE_T_START)
    body += list(BLOWHOLE_EXTRA_STATIONS)
    body += window_stations(WRINKLE_T_START, WRINKLE_T_END, WRINKLE_COUNT, WRINKLE_VERTICES_PER_WRINKLE)
    k = 1
    while WRINKLE_T_END + k * RING_STEP < KNUCKLE_T_START - 1e-9:
        body.append(WRINKLE_T_END + k * RING_STEP)
        k += 1
    body.append(KNUCKLE_T_START)
    body += window_stations(KNUCKLE_T_START, KNUCKLE_T_END, KNUCKLE_COUNT, KNUCKLE_VERTICES_PER_KNUCKLE)
    body += list(TAIL_CAP_STEPS)
    body.sort()
    assert all(b - a > 1e-9 for a, b in zip(body, body[1:])), 'rings out of order or doubled'
    assert body[-1] < 1.0 and body[0] > 0.0
    return body


def build_hull():
    """The whale: pole, one ring per station, pole.

    Returns GAME-space verts, the surface normals, the faces, and the ring
    bookkeeping the checks read. WINDING, derived
    then proved by check_outward: theta runs +z -> +y and successive rings
    run AFT (-x), so a face taken (this ring k) -> (this ring k+1) -> (next
    ring k+1) -> (next ring k) has its normal along +z at theta = 0, which
    is outward; the pole fans follow the same circulation.
    """
    stations = hull_stations()
    verts = [(NOSE_X, centre_y(0.0), 0.0)]
    normals = [(1.0, 0.0, 0.0)]
    ring_starts = []
    for t in stations:
        ring_starts.append(len(verts))
        for theta in THETAS:
            verts.append(surface_point(t, theta))
            normals.append(surface_normal(t, theta))
    pole_tail = len(verts)
    verts.append((HULL_TAIL_X, centre_y(1.0), 0.0))
    normals.append((-1.0, 0.0, 0.0))

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
        'verts': verts, 'normals': normals, 'faces': faces,
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


# ------------------------------------------------------------------- the jaw

def jaw_centre(s):
    """The jaw's centre line at jaw station s (0 the tip, 1 the buried aft
    end)."""
    return (JAW_TIP_X - s * JAW_LENGTH, JAW_TIP_Y + (JAW_AFT_Y - JAW_TIP_Y) * s)


def jaw_point(s, theta):
    cx, cy = jaw_centre(s)
    scale = JAW(s)
    return (cx, cy + JAW_HALF_HEIGHT * scale * math.sin(theta), JAW_HALF_WIDTH * scale * math.cos(theta))


def jaw_normal(s, theta):
    """Outward normal by the same finite differences as the hull's; the
    tube runs aft (-x) as the hull does, so the same circulation is
    outward."""
    return surface_normal_of(jaw_point, s, theta)


def build_jaw():
    """The jaw as a swept tube: a pole at the tip, JAW_RINGS rings, a pole
    at the aft end. Same winding derivation as the hull. Tinted the lip
    tone, fading to the body tone over JAW_TINT_FADE_START..END so the rod
    melts into the throat."""
    body_tint = srgb(BODY_COLOR)
    lip_tint = srgb(LIP_COLOR)
    tip_x, tip_y = jaw_centre(0.0)
    aft_x, aft_y = jaw_centre(1.0)
    verts = [(tip_x, tip_y, 0.0)]
    normals = [(1.0, 0.0, 0.0)]
    tints = [lip_tint]
    stations = [k / JAW_RINGS for k in range(1, JAW_RINGS)] + [1.0 - 1e-3]
    ring_starts = []
    for s in stations:
        ring_starts.append(len(verts))
        fade = 1.0 - smoothstep((s - JAW_TINT_FADE_START) / (JAW_TINT_FADE_END - JAW_TINT_FADE_START))
        tint = lerp_color(body_tint, lip_tint, fade)
        for k in range(JAW_SEGMENTS):
            theta = 2 * math.pi * k / JAW_SEGMENTS
            verts.append(jaw_point(s, theta))
            normals.append(jaw_normal(s, theta))
            tints.append(tint)
    pole_aft = len(verts)
    verts.append((aft_x, aft_y, 0.0))
    normals.append((-1.0, 0.0, 0.0))
    tints.append(body_tint)

    faces = []
    r0 = ring_starts[0]
    for k in range(JAW_SEGMENTS):
        k2 = (k + 1) % JAW_SEGMENTS
        faces.append([0, r0 + k2, r0 + k])
    for r in range(len(ring_starts) - 1):
        cur, nxt = ring_starts[r], ring_starts[r + 1]
        for k in range(JAW_SEGMENTS):
            k2 = (k + 1) % JAW_SEGMENTS
            faces.append([cur + k, cur + k2, nxt + k2, nxt + k])
    rl = ring_starts[-1]
    for k in range(JAW_SEGMENTS):
        k2 = (k + 1) % JAW_SEGMENTS
        faces.append([pole_aft, rl + k, rl + k2])

    def ring_of(index):
        if index == 0:
            return -1
        if index == pole_aft:
            return len(stations)
        return (index - r0) // JAW_SEGMENTS

    def ref_of(face):
        rings = [ring_of(i) for i in face]
        lo = max(0, min(rings))
        hi = min(len(stations) - 1, max(rings))
        cx, cy = jaw_centre((stations[lo] + stations[hi]) / 2)
        return (cx, cy, 0.0)
    return verts, normals, tints, faces, ref_of


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
    """(b, a_lead, a_trail) along the span: the mean line swept gently aft
    and an elliptically rounded chord — a paddle."""
    out = []
    N = FLIPPER_SPAN_SEGMENTS
    for i in range(N + 1):
        s = i / N
        mean = quad_bezier_1d(FLIPPER_MEAN_ROOT_A, FLIPPER_MEAN_CONTROL_A, FLIPPER_TIP_A, s)
        rounding = math.sqrt(max(0.0, 1.0 - s ** FLIPPER_TIP_ROUNDING_POWER))
        half = FLIPPER_ROOT_HALF_CHORD * rounding * (1.0 - FLIPPER_TAPER * s)
        out.append((s * FLIPPER_SPAN, mean + half, mean - half))
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
    assert abs(FLUKE_LOBE_S * N - round(FLUKE_LOBE_S * N)) < 1e-9, 'the lobe is not a span station'
    for i in range(N + 1):
        s = i / N
        lead = quad_bezier_1d(FLUKE_ROOT_FRONT_A, FLUKE_LEAD_CONTROL_A, FLUKE_TIP_A, s)
        trail = -(FLUKE_NOTCH_A + (FLUKE_REACH - FLUKE_NOTCH_A) * fluke_lobe_profile(s))
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


# ------------------------------------------------------------------ the eyes

def seated_sphere(t, theta, radius, sink, segments, rings):
    """A sphere on the hull at (t, theta), its centre sunk `sink` of its
    radius below the surface along the outward normal."""
    p = surface_point(t, theta)
    n = surface_normal(t, theta)
    depth = sink * radius
    centre = (p[0] - n[0] * depth, p[1] - n[1] * depth, p[2] - n[2] * depth)
    verts, faces = uv_sphere(centre, radius, segments, rings)
    return centre, verts, faces


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


def check_envelope(all_verts, hull, jaw_verts, flipper_verts):
    """The anchors are the measured extremes, not a second set of numbers;
    and the crown is the HUMP and the belly the CHEST, with the knuckles,
    the jaw and the flippers proven to sit inside them."""
    hull_verts = hull['verts']
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
    ring_starts = hull['ring_starts']
    stations = hull['stations']

    def ring_max_y(t_from, t_to):
        best = -math.inf
        for r, t in enumerate(stations):
            if t_from <= t <= t_to:
                best = max(best, max(v[1] for v in hull_verts[ring_starts[r]:ring_starts[r] + HULL_SEGMENTS]))
        return best
    hump_max = ring_max_y(0.60, KNUCKLE_T_START)
    knuckle_max = ring_max_y(KNUCKLE_T_START, KNUCKLE_T_END)
    head_max = ring_max_y(0.0, HEAD_BOX_END_T)
    jaw_min = min(v[1] for v in jaw_verts)
    flipper_min = min(v[1] for v in flipper_verts)
    print(f'    the crown is the hump ({hump_max:+.6f}); the head\'s top is {head_max:+.4f}, '
          f'{CROWN_Y - head_max:.4f} under it; the tallest knuckle {knuckle_max:+.4f}, '
          f'{CROWN_Y - knuckle_max:.4f} under it')
    print(f'    the belly is the hull\'s chest ({min(v[1] for v in hull_verts):+.6f}); the jaw\'s '
          f'underside {jaw_min:+.4f}, {jaw_min - BELLY_Y:.4f} above it; the flippers reach '
          f'{flipper_min:+.4f}, {flipper_min - BELLY_Y:.4f} above it')
    assert abs(hump_max - CROWN_Y) < ANCHOR_TOLERANCE, 'the crown is not the hump'
    assert knuckle_max <= CROWN_Y - KNUCKLE_BELOW_CROWN + ANCHOR_TOLERANCE, 'a knuckle is the crown'
    assert head_max < CROWN_Y, 'the head is the crown'
    assert jaw_min >= BELLY_Y + JAW_ABOVE_BELLY - ANCHOR_TOLERANCE, 'the jaw is the belly'
    assert flipper_min > BELLY_Y, 'a flipper is the belly'
    reach_z = max(abs(v[2]) for v in all_verts)
    print(f'    widest thing on the model {reach_z:.4f} (a fin; flank is the hull\'s '
          f'head and chest, the upper-bound case the install allows)')
    print(f'    length {max_x - min_x:.4f}, halfLength {(max_x - min_x) / 2:.4f}')


def check_head(hull):
    """The head is a THIRD of the animal and does not taper: the width holds
    its plateau to HEAD_BOX_END_T, and the boxy section's corner sits
    further out than a round one's would."""
    plateau_from = None
    for t in hull['stations']:
        if abs(half_width(t) - HALF_WIDTH) < ANCHOR_TOLERANCE:
            if plateau_from is None:
                plateau_from = t
            plateau_to = t
    head_share = station_x(0.0) - station_x(HEAD_BOX_END_T)
    corner = superellipse(math.pi / 4, HEAD_SECTION_POWER)
    print(f'  head: full width from t {plateau_from:.3f} to {plateau_to:.3f}; the boxy section '
          f'ends at t {HEAD_BOX_END_T} ({head_share:.2f} of {LENGTH} cells: {head_share / LENGTH:.0%}); '
          f'the corner at 45 degrees sits at {corner[0]:.3f} of the beam against a round '
          f'section\'s {math.cos(math.pi / 4):.3f}')
    assert plateau_to >= HEAD_BOX_END_T, 'the head tapers before the box ends'


def check_fluke_sweep(fluke_world, hinge, body_verts):
    """The flukes pitched +-FLUKE_SWING_RADIANS about the hinge (z axis)
    stay inside the box and their x extent only shortens — the sheet's
    argument for ONE envelope, asserted. The body roll (BODY_ROLL_FRACTION
    of the swing, about the origin) is then applied to everything and
    PRINTED against placement.ts's clearance: a roll of 0.036 rad lifts a
    crown 0.5 behind the origin by 0.02, inside the 0.7 - 0.67 the swim
    profile leaves — a property of the animation the procedural whale
    already had, not of this file, so it is reported, not asserted."""
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


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    out_path = args[0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    body_material = flat_material('sperm_whale_body', srgb(BODY_COLOR))
    jaw_material = tinted_material('sperm_whale_jaw')
    eye_material = flat_material('sperm_whale_eye', srgb(EYE_COLOR))

    print('sperm whale build:')

    # ---- the rig root: every part of the whale hangs under it ----
    rig = make_empty('rig', (0.0, 0.0, 0.0))

    # ---- the hull ----
    hull = build_hull()
    hull_faces = hull['faces']
    for label, t in (('flank', FLANK_T), ('crown', CROWN_T), ('belly', BELLY_T), ('blowhole', BLOWHOLE_T)):
        assert any(abs(s - t) < 1e-9 for s in hull['stations']), f'{label} station {t} is not a ring'
    print(f'  hull: {len(hull["stations"])} rings x {HULL_SEGMENTS} segments')
    check_outward('hull', hull['verts'], hull_faces, hull_axis_ref(hull))
    check_winding_with_blender('hull', hull['verts'], hull_faces)
    check_head(hull)
    add_part('body', hull['verts'], hull_faces, body_material, rig, normals=hull['normals'])
    shell = triangulate(hull['verts'], hull_faces)

    parts = []

    # ---- the jaw: an underslung rod, its aft end in the throat ----
    jaw_verts, jaw_normals, jaw_tints, jaw_faces, jaw_ref = build_jaw()
    lip_vertices = sum(1 for tint in jaw_tints if tint != srgb(BODY_COLOR))
    print(f'  jaw: {JAW_RINGS} rings x {JAW_SEGMENTS} segments, tip x {JAW_TIP_X:+.3f} '
          f'({JAW_SETBACK} behind the front), aft x {JAW_AFT_X:+.3f}; '
          f'{lip_vertices} vertices tinted toward the lip tone')
    check_outward('jaw', jaw_verts, jaw_faces, jaw_ref)
    check_winding_with_blender('jaw', jaw_verts, jaw_faces)
    jaw = add_part('jaw', jaw_verts, jaw_faces, jaw_material, rig, normals=jaw_normals)
    paint_tints(jaw, jaw_tints)
    parts.append(('jaw', jaw_verts))

    # ---- flippers: rigid paddles, baked at their hang, dark both sides ----
    # Right-handed frame with +X forward and +Y up puts PORT at -Z
    # (left = up x forward = Y x X = -Z).
    flipper_verts = []
    for name, side in (('flipper_port', -1.0), ('flipper_starboard', 1.0)):
        to_game, _root = flipper_to_game(side)
        verts, faces, _underside = loft_fin(
            flipper_stations(), FLIPPER_CHORD_SEGMENTS, FLIPPER_ROOT_HALF_THICKNESS,
            FIN_CAMBER_FRACTION, to_game)
        check_winding_with_blender(name, verts, faces)
        add_part(name, verts, faces, body_material, rig)
        parts.append((name, verts))
        flipper_verts.extend(verts)

    # ---- eyes, at the corner of the mouth ----
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
    local, faces, _underside = weld_mirrored(halves[0], halves[1], FLUKE_CHORD_SEGMENTS)
    # One closed object in the body tone: dark both sides, as the flippers.
    check_winding_with_blender('flukes_blade', local, faces)
    add_part('flukes_blade', local, faces, body_material, flukes)
    fluke_world = [(a + hinge[0], b + hinge[1], c + hinge[2]) for a, b, c in local]
    parts.append(('flukes_blade', fluke_world))

    # ---- checks, on the GAME-space vertices the parts were authored from ----
    check_attachment(shell, parts)
    all_verts = list(hull['verts'])
    for _name, verts in parts:
        all_verts.extend(verts)
    check_envelope(all_verts, hull, jaw_verts, flipper_verts)
    body_verts = [v for v in all_verts if v not in fluke_world]
    check_fluke_sweep(fluke_world, hinge, body_verts)

    # ---- anchors: what the plugin measures SPERM_WHALE_ENVELOPE from ----
    make_empty('nose', (NOSE_X, centre_y(0.0), 0.0))
    make_empty('tail_tip', (TAIL_TIP_X, hinge[1], 0.0))
    # The crown is the hump and the belly the chest, on their plateaus; the
    # flank the head and chest at their widest. The flippers and flukes reach
    # further out and are checked as an upper bound only.
    make_empty('crown', (station_x(CROWN_T), CROWN_Y, 0.0))
    make_empty('belly', (station_x(BELLY_T), BELLY_Y, 0.0))
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
        print(f'  {obj.name}: {len(mesh.polygons)} polys, {tris} tris')
    print(f'sperm whale -> {out_path}: {total_tris} tris total')


main()
