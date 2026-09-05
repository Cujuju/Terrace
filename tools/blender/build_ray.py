# build_ray.py — builds the Terrace ray in Blender and exports it.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_ray.py -- \
#     E:\...\Terrace\plugins\wildlife\client\assets\ray.glb
#
# WHAT IT BUILDS (docs/model-assets.md is the convention this satisfies, and
# its "Wildlife species" section is the joint convention). Pass 3 of the
# fish+whales arc: build_fish.py and build_shark.py are the pattern, the ray
# the third species through it and the FIRST whose joints are not
# SWIMMER_JOINTS — a ray flaps, it does not beat a tail.
#
#   rig                   Empty at the origin; the whole body hangs under it.
#     disc                the body: a swept LENS section, blunt at the head,
#                         full through the middle, rounding off behind the
#                         tail hinge, its edges thinning to nothing so the
#                         wings grow out of it; smooth-shaded. Its underside
#                         is the envelope's BELLY at rest.
#     lobe_port / lobe_starboard
#                         the two cephalic lobes curling forward of the mouth
#                         — their tips are the envelope's NOSE.
#     eye_port / eye_starboard
#                         domes on top of the head; their tops are the
#                         envelope's CROWN at rest.
#     mouth               a ridge across the underside of the head.
#     gill_N_port / gill_N_starboard (N = 1..5)
#                         five transverse slits per side on the underside, as
#                         raised ridges half-sunk into the disc.
#     tail                Empty at the disc's rear (TAIL_ROOT_X); the whip
#                         hangs under it, its pole vertex the envelope's
#                         TAIL_TIP.
#       whip
#     wing_port / wing_starboard
#                         Empties at the wing roots INSIDE the disc, at REST
#                         IDENTITY (the flap is animation and lives in
#                         species/ray.ts). The wing under each is a tapered
#                         two-sheet grid, not a plate: thick where it leaves
#                         the disc, an edge at the tip and along both margins.
#                         Its tip is the envelope's FLANK.
#       wing_*_blade
#   nose / tail_tip / crown / belly / flank
#                         anchor Empties; the plugin measures the ray's REST
#                         envelope from these and refuses a file that disagrees.
#
# TWO ENVELOPES — why the numbers here are NOT plugins/wildlife/client/
# placement.ts's. The ray's placement envelope (species/ray.ts RAY_ENVELOPE)
# is SWEPT: its crownY/bellyY are a wing tip at the top and bottom of its
# 0.30 rad beat (±0.2244), which nothing in a file authored with the wings
# flat ever reaches, and installSpeciesAsset measures the file AT REST. So the
# species declares a second, REST envelope (RAY_REST_ENVELOPE), and THAT is
# what this script's anchors satisfy: the eye domes for the crown, the disc's
# underside for the belly, the flat wing tip for the flank, lobe tip and whip
# tip for the length. The swept envelope is derived in ray.ts as rest plus
# the flap's reach and is never measured off the file.
#
# EVERY DIMENSION IS A NAMED CONSTANT IN GAME SPACE: x forward, y up, z
# lateral, one unit = one cell. `bl()` is the only place the Blender frame
# (x length, y beam, z up) is spoken, so nothing below has to think about it.
#
# CHECKS IT PRINTS AND ASSERTS, because a model is a claim until it is measured:
#   * winding: every analytically wound disc face agrees with an outward test
#     taken from a point genuinely inside the solid, and every wing sheet face
#     points to the side of the wing it was built for.
#   * envelope: the anchor Empties equal the measured mesh extremes (rest).
#   * attachment: NOTHING FLOATS — every part other than the disc has vertices
#     strictly inside the disc's closed mesh, by odd ray-crossing parity (the
#     same test as plugins/wildlife/.verify-closed.mts, in Python).

import math
import os
import sys

import bpy

# export_glb.py holds this project's ONE export recipe; it is imported rather
# than copied so the ray cannot drift from the boats, the fish and the shark.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_glb import bake_object_transforms, export_scene_glb  # noqa: E402

# ----------------------------------------------------------------- dimensions
# Game space (x forward, y up, z lateral), cells. The five envelope figures
# ARE plugins/wildlife/client/species/ray.ts's RAY_REST_ENVELOPE; the
# install-time assertion there compares the anchors below against them.

#: A cephalic lobe's tip: the model's forward extreme and the envelope's front.
#: The same 0.33 the procedural ray's envelope has always summed from.
NOSE_X = 0.33
#: The whip's tip: the envelope's aft extreme (length = 0.33 - (-0.76) = 1.09).
TAIL_TIP_X = -0.76
#: The disc's half-height at its thickest station. Its underside there is the
#: REST belly (RAY_REST_ENVELOPE.bellyY = -0.05), and it is the MAX_HALF_HEIGHT
#: term of the swept envelope's formula in ray.ts.
DISC_HALF_HEIGHT = 0.05
#: How far the eye domes stand above the disc's back. Their tops are the REST
#: crown: RAY_REST_ENVELOPE.crownY = DISC_HALF_HEIGHT + EYE_DOME_ABOVE_DISC.
EYE_DOME_ABOVE_DISC = 0.012
REST_CROWN_Y = DISC_HALF_HEIGHT + EYE_DOME_ABOVE_DISC
REST_BELLY_Y = -DISC_HALF_HEIGHT
#: Where each wing hinges (inside the disc) and how far its tip reaches out
#: from the hinge, both the procedural ray's; their sum is the envelope's
#: halfWidth (0.59) and, with the wings flat, the model's z extent.
WING_ROOT_X = 0.04
WING_ROOT_Z = 0.09
WING_SPAN = 0.50
FLANK_Z = WING_ROOT_Z + WING_SPAN
#: The tail hinge: at the disc's rear, the procedural ray's station.
TAIL_ROOT_X = -0.26

#: The disc's own extent. Nose blunt and forward of the lobes' roots, rear
#: rounding off just behind the tail hinge so the whip's root is buried in
#: solid disc rather than butted against a cap.
DISC_NOSE_X = 0.28
DISC_TAIL_X = -0.32
#: The disc's widest half-width. Well outside the wing root (WING_ROOT_Z) at
#: every station a wing root spans, so the wing's inner edge is never seen,
#: and wide enough that the lens section below has thinned to about the
#: wing's own thickness by the time the wing emerges from it.
DISC_HALF_WIDTH = 0.16

#: Disc tessellation. 24 stations of 28 segments: the disc is the smoothly
#: curved thing the wings grow out of, and 28 around keeps the lens section's
#: rounder middle smooth enough that a surface ridge sunk to LINE_INNER_SCALE
#: stays inside the faceted surface. 28 is divisible by 4, so the exact top
#: and bottom of every section are vertices (the belly anchor is one of them).
HULL_RINGS = 24
HULL_SEGMENTS = 28

#: Half-width along the disc as a fraction of DISC_HALF_WIDTH, by station
#: fraction u (0 at the disc's nose, 1 at its tail): a broad blunt head, a
#: plateau at full width from u = 0.28 to 0.50 (so several sampled rings sit
#: at exactly DISC_HALF_HEIGHT, which is what makes the belly anchor exact),
#: then a long taper that keeps the disc wider than WING_ROOT_Z as far aft as
#: the wing's trailing root (x = -0.22, u = 0.83).
WIDTH_PROFILE = (
    (0.00, 0.55), (0.10, 0.85), (0.28, 1.00), (0.50, 1.00), (0.70, 0.92),
    (0.85, 0.78), (0.95, 0.55), (1.00, 0.40),
)
#: The disc's height follows its width: thickest where widest. A ray's body is
#: a lens, not a tube.
HEIGHT_PROFILE = WIDTH_PROFILE
#: Section shape: a LENS, y = +-H * (1 - (z/W)^2) ** SECTION_EDGE_EXPONENT.
#: An ellipse (exponent 0.5) meets its edge at a right angle, so a flat wing
#: leaving it makes a 60-70 degree crease and reads as a plate in a slot; at
#: 1.5 the section's slope goes to ZERO at the edge — the disc thins into a
#: knife edge the way a ray's body flattens into its wings — and where the
#: wing's back emerges (|z| ~ 0.10, where the disc is the wing's thickness)
#: the disc slopes about 25 degrees, which is a fillet, not a step.
SECTION_EDGE_EXPONENT = 1.5

#: Fraction of the disc's length spent rounding each end into a closed cap.
NOSE_CAP_FRACTION = 0.06
TAIL_CAP_FRACTION = 0.06

#: HOW THE WING BECOMES THE DISC'S SKIN. Two separate meshes can only read as
#: one surface where they meet TANGENT, and a flat plate of any thickness
#: leaving a lens that is still sloping makes a crease (the first build's
#: 0.026 root against a 23-degree slope read as a plate in a slot). So the
#: wing has two thickness laws added together:
#:   * the BLADE — WING_BLADE_ROOT_HALF_THICKNESS at the root mid-chord,
#:     tapering to EDGE_HALF_THICKNESS at the tip (power WING_SPAN_TAPER_
#:     EXPONENT) and to both margins (a half-sine in chord); and
#:   * the BLEND — at the hinge line (b = 0) the wing's back is set ON the
#:     disc's back over that line (less SEAM_SINK), leaving with the disc's
#:     own slope, and the excess over the blade decays as a parabola to zero
#:     over the distance that slope needs — so the wing's back is tangent to
#:     the disc's where it emerges and envelopes the disc's thin edge beyond.
#: A ray's body IS this: a lens thinning without a break into its wings.
WING_BLADE_ROOT_HALF_THICKNESS = 0.012
WING_SPAN_TAPER_EXPONENT = 1.5
#: How far under the disc's back the wing's back sits at the hinge line. Not
#: zero (two coincident surfaces z-fight along the line); at this depth the
#: two curves cross ~0.02 outboard at under ten degrees, which is invisible.
SEAM_SINK = 0.001
#: Every free edge — wing margins and tip, lobe margins — thins to this: a fin
#: has an edge, not a rim.
EDGE_HALF_THICKNESS = 0.002
#: Wing planform, in the HINGE's own (along, out) plane: `a` forward along x
#: from the hinge, `b` outward from it. Leading root well forward on the
#: disc's shoulder, trailing root near the tail hinge so the trailing edge
#: runs back into the body, tip aft of the hinge — the eagle-ray sweep.
WING_LEAD_ROOT_A = 0.20
WING_TRAIL_ROOT_A = -0.26
WING_TIP_A = -0.16
#: Bezier controls: leading edge slightly convex forward, trailing edge
#: concave (drawn aft mid-span), as (along, out).
WING_LEAD_CONTROL = (0.19, 0.24)
WING_TRAIL_CONTROL = (-0.34, 0.20)
#: Grid resolution: rows across the span (root to the row before the tip; the
#: tip itself is a single vertex pair) and columns along the chord. Twelve by
#: ten keeps the curved margins smooth at the play camera and the pair of
#: wings near a thousand triangles. Rows are biased toward the root (span
#: fraction = (row fraction) ** WING_ROW_ROOT_BIAS) so the blend's parabola,
#: ~0.08 wide, is sampled by four rows rather than two.
WING_SPAN_ROWS = 12
WING_CHORD_COLUMNS = 10
WING_ROW_ROOT_BIAS = 1.6

#: Cephalic lobes: paddles in the horizontal plane forward of the disc's nose,
#: rooted in the head between LOBE_INNER_Z and LOBE_OUTER_Z, tip at NOSE_X
#: curled in toward the centreline. Seated a little below the mid-plane, at
#: the level of the mouth.
LOBE_ROOT_X = 0.22
LOBE_INNER_Z = 0.03
LOBE_OUTER_Z = 0.08
LOBE_TIP_Z = 0.052
LOBE_Y = -0.01
LOBE_ROOT_HALF_THICKNESS = 0.012
#: Bezier controls for the outer (convex) and inner (curling) edges, as (x, z).
LOBE_OUTER_CONTROL = (0.31, 0.088)
LOBE_INNER_CONTROL = (0.31, 0.030)
#: Points sampled along each curved lobe edge.
LOBE_CURVE_SAMPLES = 8

#: Eyes: domes on the head's shoulders, either side, seated where the lens
#: has begun to fall away so they read as eyes at the sides of a ray's head
#: rather than balls on its back. The centre height is DERIVED so the dome's
#: top vertex lands exactly on REST_CROWN_Y.
EYE_X = 0.16
EYE_Z = 0.095
EYE_RADIUS = 0.022
EYE_CENTRE_Y = REST_CROWN_Y - EYE_RADIUS
EYE_SEGMENTS = 10
EYE_RINGS = 6

#: The whip, authored with x = 0 AT THE HINGE (the tail Empty). Its root
#: starts forward of the hinge, buried in the disc; it rises a little toward
#: the tip and ends in a pole vertex at TAIL_TIP_X.
TAIL_ROOT_A = 0.05
TAIL_TIP_RISE = 0.03
TAIL_ROOT_RADIUS = 0.018
TAIL_TIP_RADIUS = 0.003
TAIL_STATIONS = 12
TAIL_RADIAL_SEGMENTS = 8

#: Surface ridges (mouth, gill slits): inner lip sunk under the surface (so
#: its vertices are demonstrably inside the disc), outer lip raised above it
#: (so the line catches the light). The inner scale is deeper than the
#: shark's 0.985 because the lens section's middle bends more per segment
#: than a circle's.
LINE_INNER_SCALE = 0.975
LINE_OUTER_SCALE = 1.006
#: Half the ridge's width along the body.
LINE_HALF_WIDTH = 0.005
#: Points sampled along each ridge's arc.
LINE_ARC_SAMPLES = 5

#: The mouth: a ridge across the underside of the head, bowed forward at its
#: centre. `theta` is the section angle (0 = starboard flank, pi/2 = back,
#: 3pi/2 = underside centre).
MOUTH_X = 0.235
MOUTH_BOW = 0.015
MOUTH_HALF_ARC_RADIANS = 0.7

#: Five gill slits per side on the underside, from just behind the mouth to
#: just aft of the wing hinge: each a short transverse arc centred this far
#: round from the underside's centre, spanning this much of the section
#: either side of that.
GILL_COUNT = 5
GILL_FIRST_X = 0.12
GILL_LAST_X = -0.04
GILL_CENTRE_OFFSET_RADIANS = 0.55
GILL_HALF_ARC_RADIANS = 0.25

#: Colours, as the sRGB hexes the species file declares: the shipped ray's
#: slate blue-grey (seabed-coloured from above), near-black eyes; the ridge
#: lines a darker shade of the body.
#:
#: THESE ARE sRGB AND BLENDER'S BASE COLOR IS LINEAR — see srgb() below.
BODY_COLOR = 0x3F4B5A
EYE_COLOR = 0x0F1114
LINE_COLOR = 0x262D36

#: ONE roughness and ONE metalness across every material on this model.
#: rigSkin.ts's materialSignature keys on roughness and metalness
#: (client/src/render/rigSkin.ts, SHADING_SCALAR_FIELDS) but NOT on colour, so
#: parts that differ only in colour merge into a single draw. Three colours at
#: one roughness is one surface — the draw budget plugins/wildlife/client/
#: index.ts asserts for the ray; a second roughness would be a second surface
#: and a boot-time failure. 0.5 is a wet, slightly glossy body.
SURFACE_ROUGHNESS = 0.5
SURFACE_METALNESS = 0.0

#: How far a numerically checked normal may disagree with the analytic winding
#: before the build fails. Zero would trip on float dust in a near-tangent face.
WINDING_TOLERANCE = 1e-12
#: How far a measured extreme may sit from its anchor. The SAME number as
#: species/assetSpecies.ts's ENVELOPE_TOLERANCE_CELLS: it absorbs float32
#: round-trip dust and nothing else.
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
HEIGHT = profile(HEIGHT_PROFILE)

DISC_LENGTH = DISC_NOSE_X - DISC_TAIL_X


def cap_factor(u):
    """Rounds the sweep into closed caps at both ends (a quarter ellipse)."""
    if u < NOSE_CAP_FRACTION:
        return math.sqrt(max(0.0, 1.0 - (1.0 - u / NOSE_CAP_FRACTION) ** 2))
    if u > 1.0 - TAIL_CAP_FRACTION:
        t = (u - (1.0 - TAIL_CAP_FRACTION)) / TAIL_CAP_FRACTION
        return math.sqrt(max(0.0, 1.0 - t * t))
    return 1.0


def station_x(u):
    return DISC_NOSE_X - u * DISC_LENGTH


def station_u(x):
    return (DISC_NOSE_X - x) / DISC_LENGTH


def half_width(u):
    return DISC_HALF_WIDTH * WIDTH(u) * cap_factor(u)


def half_height(u):
    return DISC_HALF_HEIGHT * HEIGHT(u) * cap_factor(u)


def lens_height(s):
    """The lens section's height fraction at lateral fraction s in [-1, 1]."""
    return (1.0 - min(1.0, s * s)) ** SECTION_EDGE_EXPONENT


def surface_point(u, theta, scale=1.0):
    """A point on (or offset from) the disc surface, in game space.

    The section is a LENS (SECTION_EDGE_EXPONENT) about the body axis,
    symmetric top and bottom, parametrised by theta with z = W cos(theta):
    theta = 0 is the starboard edge, pi/2 the back, 3pi/2 the underside's
    centre. Since 1 - cos^2 = sin^2, the height is H |sin|^(2 * exponent).
    """
    return (
        station_x(u),
        math.copysign(half_height(u) * lens_height(math.cos(theta)), math.sin(theta)) * scale,
        half_width(u) * math.cos(theta) * scale,
    )


def disc_surface_y(x, z):
    """The disc's back height at (x, z), or 0 outside it — for the record."""
    u = station_u(x)
    w = half_width(u)
    if w <= 0.0 or abs(z) >= w:
        return 0.0
    return half_height(u) * lens_height(z / w)


def disc_surface_slope(x, z):
    """|dy/dz| of the disc's back at (x, z): the lens law differentiated."""
    u = station_u(x)
    w = half_width(u)
    s = abs(z) / w
    if s >= 1.0:
        return 0.0
    return half_height(u) * SECTION_EDGE_EXPONENT * (1.0 - s * s) ** (
        SECTION_EDGE_EXPONENT - 1.0) * 2.0 * s / w


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

    `ref` must be genuinely inside the solid. This NEVER rewrites a face: the
    winding is derived, not guessed, and a disagreement is a bug in the
    derivation rather than something to paper over.
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


def check_sheet_normals(name, verts, faces, sheet_faces, direction):
    """Assert every face of one wing sheet points along `direction`.

    A wing is a thin plate, not a star-shaped solid, so check_outward's
    single reference point does not apply; but each of its two sheets has one
    side it must face, and that is checked here for every sheet face.
    """
    wrong = 0
    for index in sheet_faces:
        face = faces[index]
        normal = face_normal(verts[face[0]], verts[face[1]], verts[face[2]])
        dot = normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2]
        if dot < -WINDING_TOLERANCE:
            wrong += 1
    print(f'  winding {name}: {len(sheet_faces)} sheet faces, {wrong} reversed')
    assert wrong == 0, f'{name}: {wrong} sheet faces wound the wrong way'


def make_object(name, verts, faces, smooth, flat_faces=()):
    """A Blender mesh object from GAME-space verts (converted here, once).

    `smooth` shades every face smooth; the face indices in `flat_faces` are
    then set flat. Blender treats a smooth/flat boundary as a sharp edge, which
    is how a tapered blade gets a rounded face and a crisp edge from one mesh.
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
    # BELT AND SUSPENDERS on the winding. Every mesh here is a closed manifold
    # and every face list is derived rather than guessed, but a normal pointing
    # into the solid is invisible in the build log and glaring in the game (the
    # part renders inside-out or vanishes under backface culling), so Blender's
    # own outward recalculation runs over all of them. It is a no-op on a mesh
    # that was already right — which check_outward / check_sheet_normals prove
    # for the parts whose winding is derived by hand.
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
    color: 0x3f4b5a })` as; Blender's Base Color socket and glTF's
    baseColorFactor are both LINEAR. Feeding 0x3F/255 straight in would ask
    for a colour whose sRGB encoding is a much paler grey, and every
    downstream check (renders, in-game eyes-on) would be judging the wrong
    colour. The transfer function is the sRGB standard's, not an approximation.
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
    """The point on a quadratic curve at parameter t."""
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
    gives the half-thickness at each outline point (thick at the root, thin at
    the free edges — a fin, not a plate); `to_game` maps (a, b, offset) to game
    space. The caps are n-gons that Blender triangulates on export; with the
    taper they are shallow domes, which is the rounded fin face.

    Returns (verts, faces, cap_face_indices). The side faces are planar (each
    lies in the plane through its outline edge and the offset direction), so
    they are shaded flat and the caps smooth — see make_object.

    CCW OR NOTHING. The cap and side windings are DERIVED from the outline's
    orientation, and `to_game` is required to be a right-handed basis
    (a x b = offset), so a counter-clockwise outline puts the front cap's
    normal along +offset and every side face's normal outward. The shoelace
    area settles the orientation here, the one place the rule can be enforced.
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


# ------------------------------------------------------------------ the parts

def build_disc():
    """The disc: pole, `HULL_RINGS - 2` full sections, pole."""
    verts = [(DISC_NOSE_X, 0.0, 0.0)]
    for i in range(1, HULL_RINGS - 1):
        u = i / (HULL_RINGS - 1)
        for k in range(HULL_SEGMENTS):
            verts.append(surface_point(u, 2 * math.pi * k / HULL_SEGMENTS))
    verts.append((DISC_TAIL_X, 0.0, 0.0))
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


def belly_station():
    """The x of a sampled ring that sits at exactly DISC_HALF_HEIGHT.

    The belly anchor must be a vertex the file actually carries, so it is
    taken from the first ring inside the profile's plateau, and the plateau is
    asserted rather than assumed.
    """
    for i in range(1, HULL_RINGS - 1):
        u = i / (HULL_RINGS - 1)
        if HEIGHT(u) == 1.0 and cap_factor(u) == 1.0:
            return station_x(u)
    raise AssertionError('no sampled ring sits at the disc\'s full height')


def wing_basis(side):
    """The right-handed (a, b, off) -> game-space basis of a wing.

    `a` runs forward along x, `b` runs OUTWARD along the span (flat, in the
    hinge's rest pose), and `off` = a x b is the blade's normal: -y for
    starboard (+Z), +y for port (-Z). Deriving faces in this frame once gives
    both wings a correct winding, because the map is a rotation.
    """
    def to_game(a, b, off):
        return (a, -side * off, side * b)
    return to_game


def wing_grid():
    """The wing as a two-sheet grid in its (a, b, off) frame.

    Rows run across the span (t, root to the row before the tip) along the
    leading and trailing Bezier edges; columns run the chord between them
    (w, leading to trailing). Half-thickness is the BLADE plus the BLEND
    described at WING_BLADE_ROOT_HALF_THICKNESS: an edge everywhere the wing
    ends, and the disc's own back where it begins.

    Returns (verts, faces, top_faces, bottom_faces, blend) with faces derived,
    in the frame's right-handed sense, so that the +off sheet faces +off
    (check_sheet_normals proves it); `blend` is the smallest excess the blend
    had to add at the hinge line, printed and asserted non-negative.
    """
    root_lead = (WING_LEAD_ROOT_A, 0.0)
    root_trail = (WING_TRAIL_ROOT_A, 0.0)
    tip = (WING_TIP_A, WING_SPAN)

    def blade_half(t, w):
        return EDGE_HALF_THICKNESS + (WING_BLADE_ROOT_HALF_THICKNESS - EDGE_HALF_THICKNESS) * (
            (1.0 - t) ** WING_SPAN_TAPER_EXPONENT * math.sin(math.pi * w))

    least_excess = math.inf

    def half_at(t, w, a, b):
        nonlocal least_excess
        blade = blade_half(t, w)
        # The disc's back over the hinge line at this chord station, and the
        # slope it leaves it with; the wing meets both there.
        x = WING_ROOT_X + a
        back = disc_surface_y(x, WING_ROOT_Z) - SEAM_SINK
        excess = back - blade_half(0.0, w)
        if t == 0.0:
            least_excess = min(least_excess, excess)
        if excess <= 0.0:
            return blade
        slope = disc_surface_slope(x, WING_ROOT_Z)
        reach = 2.0 * excess / slope
        if b >= reach:
            return blade
        return blade + excess * (1.0 - b / reach) ** 2

    rows = WING_SPAN_ROWS
    cols = WING_CHORD_COLUMNS + 1
    verts = []
    for i in range(rows):
        t = (i / rows) ** WING_ROW_ROOT_BIAS
        lead = quad_bezier_at(root_lead, WING_LEAD_CONTROL, tip, t)
        trail = quad_bezier_at(tip, WING_TRAIL_CONTROL, root_trail, 1.0 - t)
        for j in range(cols):
            w = j / (cols - 1)
            a = lead[0] + (trail[0] - lead[0]) * w
            b = lead[1] + (trail[1] - lead[1]) * w
            verts.append((a, b, +half_at(t, w, a, b)))
    bottom = len(verts)
    verts += [(a, b, -off) for a, b, off in verts[:bottom]]
    tip_top = len(verts)
    verts.append((tip[0], tip[1], +EDGE_HALF_THICKNESS))
    tip_bottom = len(verts)
    verts.append((tip[0], tip[1], -EDGE_HALF_THICKNESS))

    def top(i, j):
        return i * cols + j

    def bot(i, j):
        return bottom + i * cols + j

    faces, top_faces, bottom_faces = [], [], []
    last = rows - 1
    # +off sheet: (this row j) -> (next row j) -> (next row j+1) -> (this row
    # j+1) runs +b then -a, and b x (-a) = a x b = +off.
    for i in range(last):
        for j in range(cols - 1):
            top_faces.append(len(faces))
            faces.append([top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1)])
            bottom_faces.append(len(faces))
            faces.append([bot(i, j), bot(i, j + 1), bot(i + 1, j + 1), bot(i + 1, j)])
    # Tip fans, the same circulation.
    for j in range(cols - 1):
        top_faces.append(len(faces))
        faces.append([top(last, j), tip_top, top(last, j + 1)])
        bottom_faces.append(len(faces))
        faces.append([bot(last, j), bot(last, j + 1), tip_bottom])
    # Root strip (b = 0, inside the disc): faces -b.
    for j in range(cols - 1):
        faces.append([top(0, j), top(0, j + 1), bot(0, j + 1), bot(0, j)])
    # Leading margin (w = 0): faces +a. Trailing margin (w = 1): faces -a.
    for i in range(last):
        faces.append([top(i, 0), bot(i, 0), bot(i + 1, 0), top(i + 1, 0)])
        faces.append([top(i, cols - 1), top(i + 1, cols - 1), bot(i + 1, cols - 1),
                      bot(i, cols - 1)])
    faces.append([top(last, 0), bot(last, 0), tip_bottom, tip_top])
    faces.append([top(last, cols - 1), tip_top, tip_bottom, bot(last, cols - 1)])
    return verts, faces, top_faces, bottom_faces, least_excess


def lobe_outline():
    """One cephalic lobe in the horizontal (x, out) plane, root at the head."""
    root_inner = (LOBE_ROOT_X, LOBE_INNER_Z)
    root_outer = (LOBE_ROOT_X, LOBE_OUTER_Z)
    tip = (NOSE_X, LOBE_TIP_Z)
    outline = [root_inner, root_outer]
    outline += quad_bezier(root_outer, LOBE_OUTER_CONTROL, tip, LOBE_CURVE_SAMPLES)
    outline += quad_bezier(tip, LOBE_INNER_CONTROL, root_inner, LOBE_CURVE_SAMPLES)
    return outline[:-1]


def lobe_blade(side):
    """A lobe: tapered from its root in the head to an edge at its tip."""
    reach = NOSE_X - LOBE_ROOT_X

    def half_at(x, _b):
        return lerp(LOBE_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS, (x - LOBE_ROOT_X) / reach)

    def to_game(a, b, off):
        # (a, b) is (x, outward); a x b = -y for starboard, +y for port — the
        # same right-handed basis as wing_basis, shifted down to LOBE_Y.
        return (a, LOBE_Y - side * off, side * b)
    return tapered_blade(lobe_outline(), half_at, to_game)


def whip():
    """The tail, in the TAIL HINGE's space: a tapering tube ending in a pole.

    Stations run from TAIL_ROOT_A (buried in the disc) aft to the tip at
    TAIL_TIP_X, rising TAIL_TIP_RISE on a parabola so the whip trails a
    little above the disc's plane. Rings are wound the same way as the
    disc's (angle positive about the direction of travel, -x), so the same
    face circulation is outward.
    """
    tip_a = TAIL_TIP_X - TAIL_ROOT_X
    verts = [(TAIL_ROOT_A, 0.0, 0.0)]
    for i in range(TAIL_STATIONS):
        s = i / TAIL_STATIONS
        centre = (TAIL_ROOT_A + (tip_a - TAIL_ROOT_A) * s, TAIL_TIP_RISE * s * s, 0.0)
        radius = lerp(TAIL_ROOT_RADIUS, TAIL_TIP_RADIUS, s)
        for k in range(TAIL_RADIAL_SEGMENTS):
            phi = 2 * math.pi * k / TAIL_RADIAL_SEGMENTS
            verts.append((centre[0], centre[1] - radius * math.cos(phi),
                          centre[2] + radius * math.sin(phi)))
    verts.append((tip_a, TAIL_TIP_RISE, 0.0))
    tip = len(verts) - 1
    faces = []
    for k in range(TAIL_RADIAL_SEGMENTS):
        k2 = (k + 1) % TAIL_RADIAL_SEGMENTS
        faces.append([0, 1 + k2, 1 + k])
    for i in range(TAIL_STATIONS - 1):
        base = 1 + i * TAIL_RADIAL_SEGMENTS
        for k in range(TAIL_RADIAL_SEGMENTS):
            k2 = (k + 1) % TAIL_RADIAL_SEGMENTS
            faces.append([base + k, base + k2, base + TAIL_RADIAL_SEGMENTS + k2,
                          base + TAIL_RADIAL_SEGMENTS + k])
    base = 1 + (TAIL_STATIONS - 1) * TAIL_RADIAL_SEGMENTS
    for k in range(TAIL_RADIAL_SEGMENTS):
        k2 = (k + 1) % TAIL_RADIAL_SEGMENTS
        faces.append([tip, base + k, base + k2])
    return verts, faces


def surface_ridge(stations):
    """A closed ridge along a path of (x, theta) points on the disc surface.

    Three vertices per station — inner lip forward, raised crest, inner lip
    aft — banded into a solid whose inner floor sits under the surface. The
    same construction as the fish's lateral line and the shark's slits.
    """
    verts, faces = [], []
    for x, theta in stations:
        verts.append(surface_point(station_u(x + LINE_HALF_WIDTH), theta, LINE_INNER_SCALE))
        verts.append(surface_point(station_u(x), theta, LINE_OUTER_SCALE))
        verts.append(surface_point(station_u(x - LINE_HALF_WIDTH), theta, LINE_INNER_SCALE))
    for i in range(len(stations) - 1):
        a, b = 3 * i, 3 * (i + 1)
        faces.append([a, a + 1, b + 1, b])
        faces.append([a + 1, a + 2, b + 2, b + 1])
        faces.append([a + 2, a, b, b + 2])
    last = 3 * (len(stations) - 1)
    faces.append([0, 1, 2])
    faces.append([last + 2, last + 1, last])
    return verts, faces


UNDERSIDE_THETA = 3 * math.pi / 2


def gill_stations(x, side):
    """One slit: a short transverse arc on the underside, off the centreline."""
    centre = UNDERSIDE_THETA + side * GILL_CENTRE_OFFSET_RADIANS
    return [
        (x, centre + GILL_HALF_ARC_RADIANS * (2.0 * i / (LINE_ARC_SAMPLES - 1) - 1.0))
        for i in range(LINE_ARC_SAMPLES)
    ]


def mouth_stations():
    """The mouth: an arc across the underside of the head, bowed forward."""
    stations = []
    for i in range(LINE_ARC_SAMPLES):
        phi = MOUTH_HALF_ARC_RADIANS * (2.0 * i / (LINE_ARC_SAMPLES - 1) - 1.0)
        bow = math.cos(phi * (math.pi / 2) / MOUTH_HALF_ARC_RADIANS)
        stations.append((MOUTH_X + MOUTH_BOW * bow, UNDERSIDE_THETA + phi))
    return stations


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
    """Fan-triangulate for the parity test only — the disc's faces are quads."""
    out = []
    for face in faces:
        for k in range(1, len(face) - 1):
            out.append((verts[face[0]], verts[face[k]], verts[face[k + 1]]))
    return out


def check_attachment(disc_verts, disc_faces, parts):
    """NOTHING FLOATS: every part has vertices strictly inside the disc.

    Bounds overlap is not enough — two shapes can share a bounding box and
    never touch — so this is the odd-crossing parity test the owner requires
    (plugins/wildlife/.verify-closed.mts), against the disc's closed mesh.
    """
    triangles = triangulate(disc_verts, disc_faces)
    print('  attachment (vertices strictly inside the disc):')
    floating = []
    for name, verts in parts:
        inside = sum(1 for v in verts if ray_hits(v, triangles) % 2 == 1)
        state = f'{inside}/{len(verts)} inside' if inside else 'FLOATING'
        print(f'    {name:24} {state}')
        if inside == 0:
            floating.append(name)
    assert not floating, f'parts float free of the disc: {floating}'


def check_envelope(all_verts, disc_verts):
    """The anchors are the measured REST extremes, not a second set of numbers.

    Like the shark's, the ray's `flank` IS the model's z extent: the
    envelope's halfWidth is the wing tip (placement.ts), flat at rest.
    """
    max_x = max(v[0] for v in all_verts)
    min_x = min(v[0] for v in all_verts)
    max_y = max(v[1] for v in all_verts)
    min_y = min(v[1] for v in all_verts)
    span_z = max(abs(v[2]) for v in all_verts)
    print('  rest envelope (measured vs declared):')
    for label, measured, declared in (
        ('nose', max_x, NOSE_X),
        ('tail_tip', min_x, TAIL_TIP_X),
        ('crown', max_y, REST_CROWN_Y),
        ('belly', min_y, REST_BELLY_Y),
        ('flank', span_z, FLANK_Z),
    ):
        print(f'    {label:9} {measured:+.4f} vs {declared:+.4f}  '
              f'(off by {abs(measured - declared):.5f})')
        assert abs(measured - declared) < ANCHOR_TOLERANCE, (
            f'{label}: measured {measured:.4f}, anchor says {declared:.4f}')
    disc_z = max(abs(v[2]) for v in disc_verts)
    print(f'    disc half-width {disc_z:.4f} (DISC_HALF_WIDTH {DISC_HALF_WIDTH}); the '
          f'envelope\'s halfWidth is the WING TIP, by placement.ts\'s contract')
    print(f'    length {max_x - min_x:.4f}, halfLength {(max_x - min_x) / 2:.4f}')


# ------------------------------------------------------------------ the build

def add_part(name, verts, faces, material, parent, smooth, flat_faces=()):
    obj = make_object(name, verts, faces, smooth, flat_faces)
    obj.data.materials.append(material)
    parent_to(obj, parent)
    return obj


def blade_flat_faces(faces, caps):
    """Every face index that is NOT a cap: the sides are shaded flat."""
    return [i for i in range(len(faces)) if i not in caps]


def offset_all(verts, offset):
    return [(x + offset[0], y + offset[1], z + offset[2]) for x, y, z in verts]


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    out_path = args[0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    body_material = flat_material('ray_body', srgb(BODY_COLOR))
    eye_material = flat_material('ray_eye', srgb(EYE_COLOR))
    line_material = flat_material('ray_line', srgb(LINE_COLOR))

    print('ray build:')

    # ---- the rig root: every part of the ray hangs under it ----
    rig = make_empty('rig', (0.0, 0.0, 0.0))

    # ---- disc ----
    disc_verts, disc_faces = build_disc()
    # (0, 0, 0) is inside the disc at every station the faces cover (every
    # section straddles y = 0), and the sweep is star-shaped about its own
    # axis, so this reference is valid.
    check_outward('disc', disc_verts, disc_faces, (0.0, 0.0, 0.0))
    add_part('disc', disc_verts, disc_faces, body_material, rig, smooth=True)

    parts = []

    # ---- wings: hinge Empties inside the disc, tapered grids under them ----
    wing_local, wing_faces, top_faces, bottom_faces, least_excess = wing_grid()
    check_sheet_normals('wing +off sheet', wing_local, wing_faces, top_faces, (0.0, 0.0, 1.0))
    check_sheet_normals('wing -off sheet', wing_local, wing_faces, bottom_faces, (0.0, 0.0, -1.0))
    over_root = disc_surface_y(WING_ROOT_X, WING_ROOT_Z)
    print(f'  wing: blade root half-thickness {WING_BLADE_ROOT_HALF_THICKNESS}; disc back over '
          f'the hinge line {over_root:.4f} at the hinge station, sloping '
          f'{math.degrees(math.atan(disc_surface_slope(WING_ROOT_X, WING_ROOT_Z))):.1f} deg; '
          f'least blend excess along the root {least_excess:+.4f}')
    assert least_excess > 0.0, 'the wing blade stands proud of the disc somewhere along its root'
    # Right-handed frame with +X forward and +Y up puts PORT at -Z
    # (left = up x forward = Y x X = -Z), which is the sign the convention names.
    tip_world = None
    for name, side in (('wing_port', -1.0), ('wing_starboard', 1.0)):
        hinge_position = (WING_ROOT_X, 0.0, side * WING_ROOT_Z)
        hinge = make_empty(name, hinge_position)
        parent_to(hinge, rig)
        to_game = wing_basis(side)
        blade_local = [to_game(a, b, off) for a, b, off in wing_local]
        blade = add_part(f'{name}_blade', blade_local, wing_faces, body_material, hinge,
                         smooth=True)
        # The blade is authored in the HINGE's own space, so its local location
        # is zero and the Empty carries the root offset.
        blade.location = (0.0, 0.0, 0.0)
        world = offset_all(blade_local, hinge_position)
        parts.append((name, world))
        if side > 0:
            tip_world = max(world, key=lambda v: v[2])

    # ---- cephalic lobes ----
    for name, side in (('lobe_port', -1.0), ('lobe_starboard', 1.0)):
        verts, faces, caps = lobe_blade(side)
        add_part(name, verts, faces, body_material, rig, True, blade_flat_faces(faces, caps))
        parts.append((name, verts))

    # ---- eyes ----
    for name, side in (('eye_port', -1.0), ('eye_starboard', 1.0)):
        verts, faces = uv_sphere((EYE_X, EYE_CENTRE_Y, side * EYE_Z), EYE_RADIUS,
                                 EYE_SEGMENTS, EYE_RINGS)
        add_part(name, verts, faces, eye_material, rig, smooth=True)
        parts.append((name, verts))

    # ---- the tail hinge, at the disc's rear ----
    tail = make_empty('tail', (TAIL_ROOT_X, 0.0, 0.0))
    parent_to(tail, rig)
    whip_local, faces = whip()
    whip_obj = add_part('whip', whip_local, faces, body_material, tail, smooth=True)
    whip_obj.location = (0.0, 0.0, 0.0)
    parts.append(('whip', offset_all(whip_local, (TAIL_ROOT_X, 0.0, 0.0))))

    # ---- mouth and gill slits ----
    verts, faces = surface_ridge(mouth_stations())
    add_part('mouth', verts, faces, line_material, rig, smooth=False)
    parts.append(('mouth', verts))

    for n in range(GILL_COUNT):
        x = GILL_FIRST_X + (GILL_LAST_X - GILL_FIRST_X) * n / (GILL_COUNT - 1)
        for suffix, side in (('port', -1.0), ('starboard', 1.0)):
            name = f'gill_{n + 1}_{suffix}'
            verts, faces = surface_ridge(gill_stations(x, side))
            add_part(name, verts, faces, line_material, rig, smooth=False)
            parts.append((name, verts))

    # ---- checks, on the GAME-space vertices the parts were authored from ----
    check_attachment(disc_verts, disc_faces, parts)

    all_verts = list(disc_verts)
    for _name, verts in parts:
        all_verts.extend(verts)
    check_envelope(all_verts, disc_verts)

    # ---- anchors: what the plugin measures RAY_REST_ENVELOPE from ----
    make_empty('nose', (NOSE_X, LOBE_Y, LOBE_TIP_Z))
    make_empty('tail_tip', (TAIL_TIP_X, TAIL_TIP_RISE, 0.0))
    make_empty('crown', (EYE_X, REST_CROWN_Y, EYE_Z))
    make_empty('belly', (belly_station(), REST_BELLY_Y, 0.0))
    # The starboard wing's tip, flat at rest: the one point that is the widest
    # thing on the ray, and the envelope's halfWidth by placement.ts's contract.
    make_empty('flank', (tip_world[0], 0.0, FLANK_Z))

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
    print(f'ray -> {out_path}: {total_tris} tris total')


main()
