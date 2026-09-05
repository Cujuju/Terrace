# build_shark.py — builds the Terrace shark in Blender and exports it.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_shark.py -- \
#     E:\...\Terrace\plugins\wildlife\client\assets\shark.glb
#
# WHAT IT BUILDS (docs/model-assets.md is the convention this satisfies, and
# its "Wildlife species" section is the joint convention). Pass 2 of the
# fish+whales arc: the fish (build_fish.py) is the pattern, the shark the
# second species through it.
#
#   rig                   Empty at the origin; the whole body hangs under it.
#     body                the swept hull: pointed snout, round section with
#                         the belly flattened a little, a long taper to a
#                         narrow peduncle that ends in a keel; smooth-shaded.
#     dorsal              the tall triangular first dorsal amidships — the
#                         envelope's CROWN.
#     dorsal_second       the small second dorsal, aft.
#     anal                under the second dorsal.
#     pelvic_port / pelvic_starboard
#                         small paired fins, angled down; no hinge (nothing
#                         animates them), authored in place under `rig`.
#     mouth               a crescent under the snout, corners aft.
#     gill_N_port / gill_N_starboard (N = 1..5)
#                         five slits per flank behind the head, as raised
#                         ridges half-sunk into the hull.
#     eye_port / eye_starboard
#     tail                Empty AT THE PEDUNCLE; the HETEROCERCAL caudal hangs
#                         under it — upper lobe far longer than the lower, a
#                         notch between. Its upper tip is the envelope's
#                         TAIL_TIP.
#       caudal
#     pectoral_port / pectoral_starboard
#                         Empties at the flank root, at REST IDENTITY. The
#                         blade under each carries its sweep AND its anhedral
#                         in the mesh — see "WHY THE ANHEDRAL IS IN THE MESH".
#       pectoral_*_blade
#   nose / tail_tip / crown / belly / flank
#                         anchor Empties; the plugin measures SHARK_ENVELOPE
#                         from these and refuses an asset that disagrees.
#
# WHY THE ANHEDRAL IS IN THE MESH. The fish authors its pectorals flat and
# rolls the hinge in `animate`, because it flutters them. The shark's
# placement contract (plugins/wildlife/client/placement.ts, SWIM_PROFILES.shark
# and BODY_COLUMNS.shark) makes its ANGLED pectoral tip BOTH the envelope's
# bellyY (-0.26) and its halfWidth (0.42), and species/assetSpecies.ts
# measures the file AT REST, before any `animate` runs. A flat-authored blade
# would leave the file's y-min at the pelvics and the install would throw. So
# the rule (docs/model-assets.md): a part that is an envelope extreme is
# authored in its rest pose in the file. The shark's `animate` never touches
# the pectoral hinges, so what is in the file is what the player sees.
#
# EVERY DIMENSION IS A NAMED CONSTANT IN GAME SPACE: x forward, y up, z
# lateral, one unit = one cell. `bl()` is the only place the Blender frame
# (x length, y beam, z up) is spoken, so nothing below has to think about it.
#
# CHECKS IT PRINTS AND ASSERTS, because a model is a claim until it is measured:
#   * winding: every analytically wound body face agrees with an outward test
#     taken from a point genuinely inside the solid.
#   * envelope: the anchor Empties equal the measured mesh extremes.
#   * attachment: NOTHING FLOATS — every part other than the body has vertices
#     strictly inside the body's closed mesh, by odd ray-crossing parity (the
#     same test as plugins/wildlife/.verify-closed.mts, in Python).

import math
import os
import sys

import bpy

# export_glb.py holds this project's ONE export recipe; it is imported rather
# than copied so the shark cannot drift from the boats and the fish.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_glb import bake_object_transforms, export_scene_glb  # noqa: E402

# ----------------------------------------------------------------- dimensions
# Game space (x forward, y up, z lateral), cells. These ARE plugins/wildlife/
# client/species/shark.ts's SHARK_ENVELOPE; the install-time assertion there
# compares the anchors below against them and throws on a mismatch.

#: Snout tip. The hull's forward extreme and the envelope's front.
NOSE_X = 0.70
#: The peduncle: where the body stops and the tail hinge sits.
PEDUNCLE_X = -0.68
#: The hull's own rounded aft end, behind the peduncle so the caudal's root is
#: buried in solid body rather than butted against its end cap.
HULL_TAIL_X = -0.74
#: The upper caudal lobe's tip: the envelope's aft extreme
#: (SHARK_ENVELOPE.length = 0.70 - (-1.02) = 1.72).
CAUDAL_TIP_X = -1.02
#: First-dorsal tip above the origin — the envelope's crown.
CROWN_Y = 0.40
#: The angled pectoral tip below the origin — the envelope's belly — and how
#: far out from the centreline that same tip reaches — the envelope's
#: halfWidth. Both are the PECTORAL TIP, which is what placement.ts says it
#: fits the shark's column with, and why the anhedral is in the mesh.
BELLY_Y = -0.26
FLANK_Z = 0.42
#: The BODY's widest half-width, at the shoulder. Printed for the record; it
#: is not an envelope figure for this species.
BODY_HALF_WIDTH = 0.13

#: Hull tessellation. 40 stations of 24 segments: the shark is 2.4x the fish's
#: length and its silhouette is the whole point (the first dorsal and the
#: heterocercal tail are the species tells), so the budget goes on a smooth
#: sweep rather than on surface detail.
HULL_RINGS = 40
HULL_SEGMENTS = 24

#: Half-width along the body as a fraction of BODY_HALF_WIDTH, by station
#: fraction u (0 at the snout, 1 at the hull's aft end): a pointed snout,
#: widest a third of the way back at the pectorals, a long taper to a narrow
#: peduncle.
WIDTH_PROFILE = (
    (0.00, 0.06), (0.05, 0.30), (0.12, 0.60), (0.22, 0.85), (0.35, 1.00),
    (0.50, 0.92), (0.65, 0.72), (0.80, 0.46), (0.92, 0.27), (1.00, 0.20),
)
#: Height over width ABOVE the centreline: a round section, a little taller
#: than wide through the middle, rising again at the peduncle into the keel.
TOP_RATIO_PROFILE = (
    (0.00, 0.80), (0.12, 1.00), (0.35, 1.20), (0.60, 1.15), (0.85, 1.00),
    (0.95, 1.15), (1.00, 1.35),
)
#: And BELOW it: flatter than the back by a sixth through the belly. A
#: shark's underside is the flat side; the keel at the peduncle is symmetric.
BOTTOM_RATIO_PROFILE = (
    (0.00, 0.70), (0.12, 0.90), (0.35, 1.02), (0.60, 0.98), (0.85, 0.90),
    (0.95, 1.10), (1.00, 1.30),
)

#: Fraction of the hull's length spent rounding the snout and the aft end into
#: closed caps. The snout cap is short because the snout is pointed: the
#: width profile already brings it near a point, so the cap only closes it.
NOSE_CAP_FRACTION = 0.05
TAIL_CAP_FRACTION = 0.05

#: How far a fin root is sunk into the hull. The hull is a sampled sweep, so
#: its true surface between stations sits a little under the profile's value;
#: a bigger hull than the fish's needs a deeper bite to close the seam.
FIN_SEAT_BITE = 0.02

#: Fins are TAPERED blades: this thick (half-thickness) at the root, so the
#: root reads as flesh blending into the body, thinning to EDGE_HALF_THICKNESS
#: at the tips and free edges so the fin has an edge rather than a rim. The
#: first dorsal and caudal are the fleshiest; the paired fins are thinner.
DORSAL_ROOT_HALF_THICKNESS = 0.018
CAUDAL_ROOT_HALF_THICKNESS = 0.015
PECTORAL_ROOT_HALF_THICKNESS = 0.012
SMALL_FIN_ROOT_HALF_THICKNESS = 0.008
EDGE_HALF_THICKNESS = 0.002
#: Points sampled along each curved fin edge. Ten, up from the fish's eight:
#: the shark's fins are three times the size and a chain of straight cuts on
#: the dorsal's leading edge would read at the play camera.
FIN_CURVE_SAMPLES = 10

#: First dorsal: root stations and the peak. A tall triangle, swept back,
#: with a concave trailing edge; its peak is CROWN_Y.
DORSAL_FRONT_X = 0.24
DORSAL_PEAK_X = -0.04
DORSAL_BACK_X = -0.16
#: Its leading edge bows out a little (a shark's first dorsal is convex in
#: front); its trailing edge is drawn in. Bezier control offsets.
DORSAL_LEAD_CONTROL = (0.10, 0.36)
DORSAL_TRAIL_CONTROL = (-0.09, 0.22)

#: Second dorsal, aft: much smaller, the same shape.
DORSAL2_FRONT_X = -0.40
DORSAL2_PEAK_X = -0.50
DORSAL2_BACK_X = -0.56
DORSAL2_HEIGHT = 0.07
#: Bezier controls as (x, fraction of the fin's height above its root).
DORSAL2_LEAD_CONTROL = (-0.44, 0.85)
DORSAL2_TRAIL_CONTROL = (-0.52, 0.40)

#: Anal fin, under the second dorsal.
ANAL_FRONT_X = -0.44
ANAL_DEEP_X = -0.54
ANAL_BACK_X = -0.59
ANAL_DEPTH = 0.07
#: Bezier controls as (x, fraction of the fin's depth below its root).
ANAL_LEAD_CONTROL = (-0.48, 0.85)
ANAL_TRAIL_CONTROL = (-0.56, 0.40)

#: Caudal fin, authored with x = 0 AT THE HINGE (the tail Empty). Its root
#: starts forward of the hinge so it is buried in the hull. HETEROCERCAL: the
#: upper lobe sweeps far up and back to CAUDAL_TIP_X, the lower lobe is short,
#: and a notch sits between them below the upper lobe's trailing edge.
CAUDAL_ROOT_X = 0.10
CAUDAL_ROOT_HALF_HEIGHT = 0.022
CAUDAL_UPPER_RISE = 0.36
CAUDAL_LOWER_REACH = 0.22
CAUDAL_LOWER_DROP = 0.16
CAUDAL_NOTCH_X = -0.15
CAUDAL_NOTCH_Y = 0.01
#: The subterminal notch — the small step near the upper lobe's tip that
#: every shark tail carries.
CAUDAL_SUBTERMINAL_X = -0.30
CAUDAL_SUBTERMINAL_Y = 0.24
#: Bezier controls for the five caudal edges, in the hinge's space.
CAUDAL_UPPER_LEAD_CONTROL = (-0.10, 0.16)
CAUDAL_UPPER_TRAIL_CONTROL = (-0.32, 0.28)
CAUDAL_NOTCH_CONTROL = (-0.21, 0.10)
CAUDAL_LOWER_LEAD_CONTROL = (-0.20, -0.06)
CAUDAL_LOWER_TRAIL_CONTROL = (-0.08, -0.07)

#: Pectoral hinge station, and how far down the flank it sits.
PECTORAL_X = 0.15
PECTORAL_Y = -0.05
#: The hinge sits INBOARD of the flank surface, so the blade's root vertices
#: are inside the body.
PECTORAL_SEAT_FRACTION = 0.78
#: The blade's root chord along the body, in the hinge's space.
PECTORAL_ROOT_FRONT_A = 0.10
PECTORAL_ROOT_BACK_A = -0.20
#: The tip's station: swept back this far behind the hinge.
PECTORAL_TIP_A = -0.30
#: Bezier controls for the leading (nearly straight, swept) and trailing
#: (concave) edges, as (along, fraction of span).
PECTORAL_LEAD_CONTROL = (-0.02, 0.55)
PECTORAL_TRAIL_CONTROL = (-0.27, 0.40)
#: Fixed-point steps for pectoral_geometry(). The correction per step is
#: O(edge thickness / span) ~ 0.5%, so eight steps leave an error far below
#: float32 resolution.
PECTORAL_SOLVE_ITERATIONS = 8

#: Pelvics: paired, small, angled down; authored in place (no hinge).
PELVIC_X = -0.30
PELVIC_SEAT_FRACTION = 0.6
PELVIC_ANHEDRAL_RADIANS = 0.5
PELVIC_ROOT_FRONT_A = 0.05
PELVIC_ROOT_BACK_A = -0.07
PELVIC_TIP_A = -0.12
PELVIC_SPAN = 0.10
PELVIC_LEAD_CONTROL = (-0.01, 0.5)
PELVIC_TRAIL_CONTROL = (-0.10, 0.4)

#: Eyes: station, lift off the centreline, radius, and how far out along the
#: local half-width they sit (under 1, so the inner half is inside the head).
EYE_X = 0.50
EYE_Y = 0.03
EYE_RADIUS = 0.026
EYE_SEAT_FRACTION = 0.88
EYE_SEGMENTS = 10
EYE_RINGS = 6

#: Surface ridges (mouth, gill slits): inner lip sunk under the surface (so
#: its vertices are demonstrably inside the body), outer lip raised above it
#: (so the line catches the light).
LINE_INNER_SCALE = 0.985
LINE_OUTER_SCALE = 1.006
#: Half the ridge's width along the body.
LINE_HALF_WIDTH = 0.005
#: Points sampled along each ridge's arc.
LINE_ARC_SAMPLES = 7

#: The mouth: a crescent under the snout, its corners aft of its centre.
#: `theta` is the section angle (0 = starboard flank, pi/2 = back).
MOUTH_CORNER_X = 0.50
MOUTH_BOW = 0.08
MOUTH_HALF_ARC_RADIANS = 0.9

#: Five gill slits per flank, from the first (just behind the eye) to the
#: fifth (at the pectoral's leading edge); each spans this much of the
#: section's arc either side of the flank line.
GILL_COUNT = 5
GILL_FIRST_X = 0.42
GILL_LAST_X = 0.28
GILL_HALF_ARC_RADIANS = 0.55

#: Colours, as the sRGB hexes the species file declares: the shipped shark's
#: grey body, its fins a shade darker, near-black eyes (the owner reads a
#: species by its colour). The ridge lines are a darker shade of the fin.
#:
#: THESE ARE sRGB AND BLENDER'S BASE COLOR IS LINEAR — see srgb() below. The
#: hexes are written here in the form they appear in the TypeScript so the two
#: can be compared by eye; the conversion happens in exactly one place.
BODY_COLOR = 0x6B7886
FIN_COLOR = 0x5A6674
EYE_COLOR = 0x0F1114
LINE_COLOR = 0x3F4852

#: ONE roughness and ONE metalness across every material on this model.
#: rigSkin.ts's materialSignature keys on roughness and metalness
#: (client/src/render/rigSkin.ts, SHADING_SCALAR_FIELDS) but NOT on colour, so
#: parts that differ only in colour merge into a single draw. Four colours at
#: one roughness is one surface — the draw budget plugins/wildlife/client/
#: index.ts asserts for the shark; a second roughness would be a second
#: surface and a boot-time failure. 0.5 is a wet, slightly glossy body.
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
    return BODY_HALF_WIDTH * WIDTH(u) * cap_factor(u)


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
    color: 0x6b7886 })` as; Blender's Base Color socket and glTF's
    baseColorFactor are both LINEAR. Feeding 0x6B/255 straight in would ask
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


def midline_fin(outline, root_y, extent, root_half):
    """A vertical blade on the centreline: outline is (x, y) in game space.

    Thickness tapers from `root_half` at `root_y` to the edge thickness at
    `extent` away from it.
    """
    def half_at(_x, y):
        return lerp(root_half, EDGE_HALF_THICKNESS, abs(y - root_y) / extent)
    return tapered_blade(outline, half_at, lambda x, y, off: (x, y, off))


def dorsal_outline():
    """Root along the back, peak at CROWN_Y — the envelope's crown."""
    front_root = (DORSAL_FRONT_X, top_y(station_u(DORSAL_FRONT_X)) - FIN_SEAT_BITE)
    back_root = (DORSAL_BACK_X, top_y(station_u(DORSAL_BACK_X)) - FIN_SEAT_BITE)
    peak = (DORSAL_PEAK_X, CROWN_Y)
    outline = [front_root]
    outline += quad_bezier(front_root, DORSAL_LEAD_CONTROL, peak, FIN_CURVE_SAMPLES)
    outline += quad_bezier(peak, DORSAL_TRAIL_CONTROL, back_root, FIN_CURVE_SAMPLES)
    return outline, front_root[1]


def dorsal2_outline():
    """The second dorsal: the first's shape at a fraction of the size."""
    front_root = (DORSAL2_FRONT_X, top_y(station_u(DORSAL2_FRONT_X)) - FIN_SEAT_BITE)
    back_root = (DORSAL2_BACK_X, top_y(station_u(DORSAL2_BACK_X)) - FIN_SEAT_BITE)
    peak = (DORSAL2_PEAK_X, front_root[1] + DORSAL2_HEIGHT)
    outline = [front_root]
    lead = (DORSAL2_LEAD_CONTROL[0], front_root[1] + DORSAL2_HEIGHT * DORSAL2_LEAD_CONTROL[1])
    trail = (DORSAL2_TRAIL_CONTROL[0], front_root[1] + DORSAL2_HEIGHT * DORSAL2_TRAIL_CONTROL[1])
    outline += quad_bezier(front_root, lead, peak, FIN_CURVE_SAMPLES)
    outline += quad_bezier(peak, trail, back_root, FIN_CURVE_SAMPLES)
    return outline, front_root[1]


def anal_outline():
    """Root along the belly, the same small swept triangle, hanging down."""
    front_root = (ANAL_FRONT_X, -bottom_y(station_u(ANAL_FRONT_X)) + FIN_SEAT_BITE)
    back_root = (ANAL_BACK_X, -bottom_y(station_u(ANAL_BACK_X)) + FIN_SEAT_BITE)
    deep = (ANAL_DEEP_X, front_root[1] - ANAL_DEPTH)
    outline = [back_root]
    trail = (ANAL_TRAIL_CONTROL[0], front_root[1] - ANAL_DEPTH * ANAL_TRAIL_CONTROL[1])
    lead = (ANAL_LEAD_CONTROL[0], front_root[1] - ANAL_DEPTH * ANAL_LEAD_CONTROL[1])
    outline += quad_bezier(back_root, trail, deep, FIN_CURVE_SAMPLES)
    outline += quad_bezier(deep, lead, front_root, FIN_CURVE_SAMPLES)
    return outline, front_root[1]


def caudal_outline():
    """The heterocercal tail, in the TAIL HINGE's space: x = 0 is the peduncle.

    Counter-clockwise from the root's top corner: up the upper lobe's leading
    edge to the tip, back down its trailing edge through the subterminal
    notch to the main notch, out along the lower lobe and back to the root.
    """
    tip_x = CAUDAL_TIP_X - PEDUNCLE_X
    root_top = (CAUDAL_ROOT_X, CAUDAL_ROOT_HALF_HEIGHT)
    root_bottom = (CAUDAL_ROOT_X, -CAUDAL_ROOT_HALF_HEIGHT)
    upper_tip = (tip_x, CAUDAL_UPPER_RISE)
    subterminal = (CAUDAL_SUBTERMINAL_X, CAUDAL_SUBTERMINAL_Y)
    notch = (CAUDAL_NOTCH_X, CAUDAL_NOTCH_Y)
    lower_tip = (-CAUDAL_LOWER_REACH, -CAUDAL_LOWER_DROP)
    outline = [root_bottom, root_top]
    # Upper lobe leading edge: a long, slightly convex sweep up and back.
    outline += quad_bezier(root_top, CAUDAL_UPPER_LEAD_CONTROL, upper_tip, FIN_CURVE_SAMPLES)
    # Its trailing edge: down to the subterminal step, then in to the notch.
    outline += quad_bezier(upper_tip, CAUDAL_UPPER_TRAIL_CONTROL, subterminal, FIN_CURVE_SAMPLES)
    outline += quad_bezier(subterminal, CAUDAL_NOTCH_CONTROL, notch, FIN_CURVE_SAMPLES)
    # Lower lobe: out to its tip and back under the root.
    outline += quad_bezier(notch, CAUDAL_LOWER_LEAD_CONTROL, lower_tip, FIN_CURVE_SAMPLES)
    outline += quad_bezier(lower_tip, CAUDAL_LOWER_TRAIL_CONTROL, root_bottom, FIN_CURVE_SAMPLES)
    return outline[:-1]


def caudal_blade():
    def half_at(x, y):
        # Elliptical distance from the hinge: thick at the root, thin at every
        # lobe tip, medium at the notch.
        reach = -(CAUDAL_TIP_X - PEDUNCLE_X)
        s = math.sqrt((x / reach) ** 2 + (y / CAUDAL_UPPER_RISE) ** 2)
        return lerp(CAUDAL_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS, s)
    return tapered_blade(caudal_outline(), half_at, lambda x, y, off: (x, y, off))


def paired_fin_basis(side, anhedral):
    """The right-handed (a, b, off) -> game-space basis of a paired fin.

    `a` runs forward along x, `b` runs OUTWARD along the fin's span, tilted
    down from the flank by `anhedral`; `off` = a x b is the blade's normal.
    `side` is -1 for port (-Z) and +1 for starboard.
    """
    b_axis = (0.0, -math.sin(anhedral), side * math.cos(anhedral))
    # a x b with a = (1, 0, 0): (0, -b.z, b.y).
    off_axis = (0.0, -b_axis[2], b_axis[1])

    def to_game(a, b, off):
        return (
            a,
            b * b_axis[1] + off * off_axis[1],
            b * b_axis[2] + off * off_axis[2],
        )
    return to_game


def paired_outline(root_front_a, root_back_a, tip_a, span, lead_control, trail_control):
    """A swept paddle in the fin's own (along, span) plane."""
    root_front = (root_front_a, 0.0)
    tip = (tip_a, span)
    root_back = (root_back_a, 0.0)
    outline = [root_front]
    outline += quad_bezier(root_front, (lead_control[0], span * lead_control[1]), tip,
                           FIN_CURVE_SAMPLES)
    outline += quad_bezier(tip, (trail_control[0], span * trail_control[1]), root_back,
                           FIN_CURVE_SAMPLES)
    return outline


def pectoral_geometry(seat_z):
    """The pectoral's span and anhedral, SOLVED so the blade's extreme vertices
    land exactly on the envelope: y-min = BELLY_Y, z-max = FLANK_Z.

    A tapered blade's tip is two vertices, the outline point pushed
    EDGE_HALF_THICKNESS either way along the blade normal. In the (outward,
    down) plane the normal is (-sin a, cos a) for anhedral a, so with span b:
        lowest vertex   down = b sin a + h cos a
        widest vertex   out  = b cos a + h sin a
    Setting those to the hinge-to-envelope distances D and O gives
    tan a = (D - h cos a) / (O - h sin a), which a fixed-point iteration from
    atan2(D, O) converges on in a handful of steps (h is a hundredth of b).
    The result is exact, and check_envelope proves it rather than trusts it.
    """
    out = FLANK_Z - seat_z
    down = PECTORAL_Y - BELLY_Y
    h = EDGE_HALF_THICKNESS
    anhedral = math.atan2(down, out)
    for _ in range(PECTORAL_SOLVE_ITERATIONS):
        anhedral = math.atan2(down - h * math.cos(anhedral), out - h * math.sin(anhedral))
    span = (out - h * math.sin(anhedral)) / math.cos(anhedral)
    return span, anhedral


def surface_ridge(stations):
    """A closed ridge along a path of (x, theta) points on the hull surface.

    Three vertices per station — inner lip forward, raised crest, inner lip
    aft — banded into a solid whose inner floor sits under the surface. The
    same construction as the fish's lateral line; the shark uses it for gill
    slits (paths in theta at fixed x) and the mouth (a bowed path).
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


def gill_stations(x, side):
    """One slit: an arc across the flank at station x."""
    centre = 0.0 if side > 0 else math.pi
    return [
        (x, centre + GILL_HALF_ARC_RADIANS * (2.0 * i / (LINE_ARC_SAMPLES - 1) - 1.0))
        for i in range(LINE_ARC_SAMPLES)
    ]


def mouth_stations():
    """The mouth: an arc under the snout, bowed forward at its centre."""
    stations = []
    for i in range(LINE_ARC_SAMPLES):
        phi = MOUTH_HALF_ARC_RADIANS * (2.0 * i / (LINE_ARC_SAMPLES - 1) - 1.0)
        bow = math.cos(phi * (math.pi / 2) / MOUTH_HALF_ARC_RADIANS)
        stations.append((MOUTH_CORNER_X + MOUTH_BOW * bow, -math.pi / 2 + phi))
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
    """Fan-triangulate for the parity test only — the body's faces are quads."""
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
    """The anchors are the measured extremes, not a second set of numbers.

    Unlike the fish, the shark's `flank` IS the model's z extent: the
    envelope's halfWidth is the pectoral tip (placement.ts), so the whole
    model's widest vertex is what is measured against it.
    """
    max_x = max(v[0] for v in all_verts)
    min_x = min(v[0] for v in all_verts)
    max_y = max(v[1] for v in all_verts)
    min_y = min(v[1] for v in all_verts)
    span_z = max(abs(v[2]) for v in all_verts)
    print('  envelope (measured vs declared):')
    for label, measured, declared in (
        ('nose', max_x, NOSE_X),
        ('tail_tip', min_x, CAUDAL_TIP_X),
        ('crown', max_y, CROWN_Y),
        ('belly', min_y, BELLY_Y),
        ('flank', span_z, FLANK_Z),
    ):
        print(f'    {label:9} {measured:+.4f} vs {declared:+.4f}  '
              f'(off by {abs(measured - declared):.5f})')
        assert abs(measured - declared) < ANCHOR_TOLERANCE, (
            f'{label}: measured {measured:.4f}, anchor says {declared:.4f}')
    body_z = max(abs(v[2]) for v in body_verts)
    print(f'    body half-width {body_z:.4f} (BODY_HALF_WIDTH {BODY_HALF_WIDTH}); the '
          f'envelope\'s halfWidth is the PECTORAL TIP, by placement.ts\'s contract')
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


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    out_path = args[0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    body_material = flat_material('shark_body', srgb(BODY_COLOR))
    fin_material = flat_material('shark_fin', srgb(FIN_COLOR))
    eye_material = flat_material('shark_eye', srgb(EYE_COLOR))
    line_material = flat_material('shark_line', srgb(LINE_COLOR))

    print('shark build:')

    # ---- the rig root: every part of the shark hangs under it ----
    rig = make_empty('rig', (0.0, 0.0, 0.0))

    # ---- body ----
    body_verts, body_faces = build_body()
    # (0, 0, 0) is inside the hull at every station the faces cover (every
    # section straddles y = 0), and the hull is star-shaped about its own
    # axis, so this reference is valid.
    check_outward('body', body_verts, body_faces, (0.0, 0.0, 0.0))
    add_part('body', body_verts, body_faces, body_material, rig, smooth=True)

    parts = []

    # ---- midline fins ----
    outline, root_y = dorsal_outline()
    verts, faces, caps = midline_fin(outline, root_y, CROWN_Y - root_y,
                                     DORSAL_ROOT_HALF_THICKNESS)
    add_part('dorsal', verts, faces, fin_material, rig, True, blade_flat_faces(faces, caps))
    parts.append(('dorsal', verts))

    outline, root_y = dorsal2_outline()
    verts, faces, caps = midline_fin(outline, root_y, DORSAL2_HEIGHT,
                                     SMALL_FIN_ROOT_HALF_THICKNESS)
    add_part('dorsal_second', verts, faces, fin_material, rig, True,
             blade_flat_faces(faces, caps))
    parts.append(('dorsal_second', verts))

    outline, root_y = anal_outline()
    verts, faces, caps = midline_fin(outline, root_y, ANAL_DEPTH, SMALL_FIN_ROOT_HALF_THICKNESS)
    add_part('anal', verts, faces, fin_material, rig, True, blade_flat_faces(faces, caps))
    parts.append(('anal', verts))

    # ---- the tail hinge, AT THE PEDUNCLE ----
    tail = make_empty('tail', (PEDUNCLE_X, 0.0, 0.0))
    parent_to(tail, rig)
    caudal_local, faces, caps = caudal_blade()
    caudal = add_part('caudal', caudal_local, faces, fin_material, tail, True,
                      blade_flat_faces(faces, caps))
    # The blade is authored in the HINGE's own space, so its local location is
    # zero and the empty carries the peduncle offset.
    caudal.location = (0.0, 0.0, 0.0)
    parts.append(('caudal', [(x + PEDUNCLE_X, y, z) for x, y, z in caudal_local]))

    # ---- pectorals: hinge Empties at the flank root, blades under them ----
    seat_z = half_width(station_u(PECTORAL_X)) * PECTORAL_SEAT_FRACTION
    span, anhedral = pectoral_geometry(seat_z)
    print(f'  pectoral: span {span:.4f}, anhedral {math.degrees(anhedral):.2f} deg, '
          f'seat z {seat_z:.4f}')
    pectoral_outline = paired_outline(PECTORAL_ROOT_FRONT_A, PECTORAL_ROOT_BACK_A,
                                      PECTORAL_TIP_A, span,
                                      PECTORAL_LEAD_CONTROL, PECTORAL_TRAIL_CONTROL)

    def pectoral_half_at(_a, b):
        return lerp(PECTORAL_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS, b / span)

    tip_world = None
    # Right-handed frame with +X forward and +Y up puts PORT at -Z
    # (left = up x forward = Y x X = -Z), which is the sign the convention names.
    for name, side in (('pectoral_port', -1.0), ('pectoral_starboard', 1.0)):
        hinge_position = (PECTORAL_X, PECTORAL_Y, side * seat_z)
        hinge = make_empty(name, hinge_position)
        parent_to(hinge, rig)
        blade_local, faces, caps = tapered_blade(
            pectoral_outline, pectoral_half_at, paired_fin_basis(side, anhedral))
        blade = add_part(f'{name}_blade', blade_local, faces, fin_material, hinge, True,
                         blade_flat_faces(faces, caps))
        blade.location = (0.0, 0.0, 0.0)
        world = [(x + hinge_position[0], y + hinge_position[1], z + hinge_position[2])
                 for x, y, z in blade_local]
        parts.append((name, world))
        if side > 0:
            tip_world = min(world, key=lambda v: v[1])

    # ---- pelvics: in place under the rig, angled down ----
    pelvic_seat_z = half_width(station_u(PELVIC_X)) * PELVIC_SEAT_FRACTION
    pelvic_y = -bottom_y(station_u(PELVIC_X)) + FIN_SEAT_BITE
    pelvic_outline = paired_outline(PELVIC_ROOT_FRONT_A, PELVIC_ROOT_BACK_A, PELVIC_TIP_A,
                                    PELVIC_SPAN, PELVIC_LEAD_CONTROL, PELVIC_TRAIL_CONTROL)

    def pelvic_half_at(_a, b):
        return lerp(SMALL_FIN_ROOT_HALF_THICKNESS, EDGE_HALF_THICKNESS, b / PELVIC_SPAN)

    for name, side in (('pelvic_port', -1.0), ('pelvic_starboard', 1.0)):
        seat = (PELVIC_X, pelvic_y, side * pelvic_seat_z)
        to_game = paired_fin_basis(side, PELVIC_ANHEDRAL_RADIANS)

        def placed(a, b, off, seat=seat, to_game=to_game):
            x, y, z = to_game(a, b, off)
            return (x + seat[0], y + seat[1], z + seat[2])
        verts, faces, caps = tapered_blade(pelvic_outline, pelvic_half_at, placed)
        add_part(name, verts, faces, fin_material, rig, True, blade_flat_faces(faces, caps))
        parts.append((name, verts))

    # ---- eyes ----
    eye_z = half_width(station_u(EYE_X)) * EYE_SEAT_FRACTION
    for name, side in (('eye_port', -1.0), ('eye_starboard', 1.0)):
        verts, faces = uv_sphere((EYE_X, EYE_Y, side * eye_z), EYE_RADIUS,
                                 EYE_SEGMENTS, EYE_RINGS)
        add_part(name, verts, faces, eye_material, rig, smooth=True)
        parts.append((name, verts))

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
    check_attachment(body_verts, body_faces, parts)

    all_verts = list(body_verts)
    for _name, verts in parts:
        all_verts.extend(verts)
    check_envelope(all_verts, body_verts)

    # ---- anchors: what the plugin measures SHARK_ENVELOPE from ----
    make_empty('nose', (NOSE_X, 0.0, 0.0))
    make_empty('tail_tip', (CAUDAL_TIP_X, CAUDAL_UPPER_RISE, 0.0))
    make_empty('crown', (DORSAL_PEAK_X, CROWN_Y, 0.0))
    # belly AND flank are the starboard pectoral's tip vertex: the one point
    # that is both the lowest and the widest thing on the shark.
    make_empty('belly', (tip_world[0], BELLY_Y, tip_world[2]))
    make_empty('flank', (tip_world[0], BELLY_Y, FLANK_Z))

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
    print(f'shark -> {out_path}: {total_tris} tris total')


main()
