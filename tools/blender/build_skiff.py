# build_skiff.py — builds the Terrace rowing skiff in Blender and exports it.
#
# Run headless from WSL (the path INSIDE is a Windows path):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_skiff.py -- \
#     E:\...\plugins\structures\client\assets\skiff.glb
#
# WHAT IT BUILDS. A small open rowing boat: fine stem forward, a shallow
# transom aft, a gentle sheer rising to both ends, two thwarts and a short
# keel strip. It is the smaller cousin of tools/blender/build_war_boat.py and
# follows the same recipe — an ANALYTIC station loft with loud asserts,
# numerically-verified outward winding, Solidify on the skin, Empties for the
# waterline and dryline anchors, transforms applied, then export_scene.gltf.
#
# THE HULL IS CLOSED EVERYWHERE BUT THE RAIL, AND THE INTERIOR IS SEALED. Both
# ends of the loft are capped (see build_hull) and the sole spans the full
# length out to the design surface (see the sole notes below), so there is no
# path from outside the boat to inside it below the gunwale. The two contracts
# are asserted, not asserted-in-prose: assert_only_the_rail_is_open counts the
# boundary edges, assert_sole_meets_planking measures the sole/planking
# crossing, and main() checks the sole's clearance over the waterline against
# SOLE_DRY_CLEARANCE_MIN.
#
# WHY IT IS ONE MESH, ONE MATERIAL, NO TEXTURE. The structures plugin draws up
# to 1 536 skiffs through a single InstancedMesh (see
# plugins/structures/client/skiffModels.ts, SKIFF_INSTANCE_CAPACITY), which
# admits exactly one geometry and one material. Part separation — planking,
# sheer strake, thwarts, keel — is therefore carried by a CORNER colour
# attribute exported as COLOR_0, not by extra materials and not by a map.
#
# WHY THE GUNWALE IS PAINT AND NOT GEOMETRY. A proud rail ribbon costs a
# doubled band plus its own Solidify rim — roughly 100 triangles of the 300
# budget — for a 0.34-unit boat seen from six units away, where the rail is
# under a pixel thick. The sheer strake (the topmost band of the loft) is
# coloured RAIL_COLOR instead: the same read, no triangles.
#
# UNITS. ONE AUTHORING UNIT IS ONE WORLD UNIT (= 4 cells). The war boat is
# authored at 0.9 units long (build_war_boat.py HULL_LENGTH) and its root is
# placed at `boat.x * CELL_WORLD_SIZE` with no scale
# (plugins/boats/client/index.ts:127-131), so authoring units are world units.
# docs/model-assets.md still says "1 unit = 1 cell"; that line predates the
# 2026-08-21 quarter-cell re-sample and is not corrected here.
#
# WINDING. The loft is a U-shaped shell and is wound numerically against a
# reference point that is genuinely inside the hull cavity; the keel prism is
# wound per face against a point on its own centre axis at that face's x
# (the prism is banana-curved by the rocker, so a single global reference
# would be outside its end faces). Thwarts are closed boxes with analytic
# winding and are never flipped.
#
# Blender frame: X = length (bow +X), Y = beam (port +Y), Z = up. The glTF
# exporter with export_yup maps this to +X forward, +Y up.

import sys

import bmesh
import bpy

# ------------------------------------------------------------------ envelope
# The placement cell cannot grow: plugins/structures/client/skiffModels.ts's
# buildSkiffParts sizes the box skiff this replaces at 0.36 x 0.14 x 0.06
# world units, and phase 2 fit-checks the asset against that box the way
# plugins/boats/client/models.ts checks the war boat. These are the HARD
# ceilings, asserted after the build.

ENVELOPE_LENGTH = 0.36
ENVELOPE_BEAM = 0.14
ENVELOPE_HEIGHT = 0.12

# ---------------------------------------------------------------- dimensions
# Every number is chosen against the envelope above with the Solidify skin's
# outward half-thickness (SKIN_THICKNESS / 2) as the margin.

#: Stem-to-transom length of the design surface. Leaves ~0.017 of the 0.36
#: envelope for the skin and for float dust in the exported box.
HULL_LENGTH = 0.340
#: Maximum beam of the design surface, likewise inside the 0.14 envelope.
HULL_BEAM = 0.124
#: Side depth (keel line to rail) amidships. A rowing skiff is shallow: a
#: quarter of its own beam here, which is what stops it reading as a barge.
HULL_DEPTH_MIDSHIPS = 0.074
#: Fraction of the length aft of the bow where the beam is widest. Slightly
#: abaft midships, which is what gives a fine entry and a full run.
MAX_BEAM_STATION_FRACTION = 0.45
#: Half-beam at the stem, as a fraction of the maximum. Not zero: a skiff has
#: a stem BOARD, and a fully collapsed ring would leave a degenerate rim.
STEM_HALF_FRACTION = 0.06
#: Half-beam at the transom, as a fraction of the maximum. A transom stern is
#: what most visibly separates this boat from the double-ended war boat.
TRANSOM_HALF_FRACTION = 0.60
#: How fast the waterplane narrows forward of the widest station. Above 1 =
#: hollow, fine entry.
BOW_FULLNESS_EXPONENT = 1.6
#: The same aft. Higher than the bow's: the run is carried further before it
#: narrows into the transom.
STERN_FULLNESS_EXPONENT = 2.2

#: Sheer rise at the stem above the midships rail. The bow is the end that
#: has to look like it keeps water out.
SHEER_RISE_STEM = 0.014
#: Sheer rise at the transom. Half the stem's — a working boat, not a gondola.
SHEER_RISE_TRANSOM = 0.007
#: How far the keel line lifts at each end (rocker). Small: this hull has to
#: read as flat-floored so it sits ON a flat sea plane without a gap.
KEEL_ROCKER = 0.010

#: Turn of the bilge: where the section's mid point sits across the half-beam
#: and up the side depth. 0.72/0.16 = a flattish floor with flared topsides,
#: which is the section a clinker dinghy actually has.
BILGE_HALF_FRACTION = 0.72
BILGE_HEIGHT_FRACTION = 0.16

#: Stations along the length. Nine, not eleven: the extra pair of rings costs
#: ~40 triangles (doubled by Solidify, plus their rim) and resolves a curve
#: that is already smooth at the game camera. See TRIANGLE_BUDGET.
STATION_COUNT = 9
#: Ring points per station: rail, bilge, keel, bilge, rail.
RING_POINT_COUNT = 5

#: Plank thickness given to the loft skin. Without it the far wall backface-
#: culls and the boat reads see-through from above — the same reason
#: build_war_boat.py solidifies its own loft. Centred (offset 0) so the design
#: surface stays the mid-surface and the envelope grows by half this each way.
SKIN_THICKNESS = 0.006
SKIN_OFFSET_CENTRED = 0.0

#: Thwarts (rowing benches), as fractions of the length from the stem.
THWART_STATION_FRACTIONS = (0.38, 0.66)
#: Height of a thwart's top above the local keel line, as a fraction of the
#: local side depth. High in the boat, as a dinghy's benches are: it has to
#: clear the sole (FLOOR_HEIGHT_FRACTION) by enough to read as a bench.
THWART_HEIGHT_FRACTION = 0.85
#: Fore-and-aft width of a thwart plank.
THWART_PLANK_WIDTH = 0.026
#: Thickness of a thwart plank.
THWART_PLANK_THICKNESS = 0.008
#: How much of the local beam a thwart spans. Just short of the planking, so
#: the two never z-fight along the join.
THWART_BEAM_FRACTION = 0.90

# --------------------------------------------------------------------- sole
# WHY THE BOAT NEEDS A FLOOR AT ALL. The hull is a 0.006-thick shell, so its
# own inner bottom sits ~0.012 above the keel while the sea plane cuts at
# WATERLINE_DEPTH_FRACTION of the side depth — an open shell would render
# SWAMPED, sea visible inside it from the orbit camera. The war boat answers
# this with a deck above its waterline (build_war_boat.py DECK_Z > WATERLINE_Z);
# an open boat answers it with floorboards. Verified in .skiff-shots/skiff-top:
# without this panel the interior renders sea-blue.
#
# WHY THE SOLE IS A SEAL AND NOT A PANEL (2026-09-04, GH #327). Until now the
# sole was an inset rectangle — it stopped at 0.14/0.88 of the length and at
# 0.82 of the local beam, so the interior stayed OPEN to the sea in four
# places: the wedge forward of it, the wedge aft of it, and the bilge gutter
# down each side. From directly above those gaps showed sea inside the rail.
# The sole is now a full-length prism whose port and starboard edges land
# exactly ON THE DESIGN SURFACE at the sole's own height, at the SAME stations
# the hull is lofted from. The design surface is the Solidify MID-surface, so
# those edges finish 0.003 (SKIN_THICKNESS / 2) INSIDE the planking: the two
# solids cross, they never coincide, so there is no gap to see through and no
# coplanar pair to z-fight. `assert_sole_meets_planking` proves the crossing at
# every span midpoint rather than asserting it in prose.

#: Sections along the sole. One per loft station, and deliberately not fewer:
#: the sole's edge is a straight chord between consecutive sections and so is
#: the hull's side, so sharing the stations makes the two curves agree AT the
#: stations exactly and to within float dust between them. A coarser sole would
#: cut its own secant inside the hull's and re-open the bilge gutter this
#: change exists to close.
SOLE_SECTION_COUNT = STATION_COUNT
#: Height of the sole's top above the local keel line, as a fraction of the
#: local side depth. Set by SOLE_DRY_CLEARANCE_MIN, not by eye: 0.56 cleared
#: the STATIC waterline by 0.008 and was under water for most of the client's
#: bob cycle. Asserted against the measured geometry in main().
FLOOR_HEIGHT_FRACTION = 0.60
#: Thickness of the floorboards.
FLOOR_THICKNESS = 0.005

#: How far the sole's top must stand above the waterline, in world units, for
#: the interior to be dry at every point of the client's float cycle.
#:
#: DERIVATION. Phase 5 contracts the client to a bob amplitude of 0.006 world
#: units and floats the hull at the RENDERED sea surface rather than at
#: SEA_LEVEL, leaving 0.004 of float margin for the difference between the
#: authored waterline and wherever the surface actually lands (chiefly
#: client/src/config.ts's WATER_SURFACE_LIFT, 1/32 = 0.031, which the old
#: skiffModels.ts comment wrongly called "far smaller than any clearance
#: here"). 0.006 + 0.004 = 0.010. Both halves are the CLIENT's numbers; this
#: asset is contracted against them and exports `dryline` so the client can
#: assert the same contract from its side at load.
SOLE_DRY_CLEARANCE_MIN = 0.010

#: Keel strip: the stations it spans, as fractions of the length from the stem.
KEEL_STRIP_START_FRACTION = 0.25
KEEL_STRIP_END_FRACTION = 0.78
#: Sections along the keel strip. Four: the rocker over this span is 0.002, so
#: more would spend triangles resolving a curve thinner than the strip itself.
KEEL_STRIP_SECTION_COUNT = 4
#: Half-width of the strip where it meets the planking.
KEEL_STRIP_HALF_WIDTH = 0.006
#: How far the strip stands proud of the planking. This is the boat's lowest
#: point and the reason the final rebase exists.
KEEL_STRIP_PROUD = 0.006

#: Where the sea surface cuts the hull, as a fraction of the midships side
#: depth. The low end of the brief's 45-55% band, so the boat sits IN the
#: water and the sole (FLOOR_HEIGHT_FRACTION) still clears it. Phase 2 lifts
#: each instance by -waterline.y.
WATERLINE_DEPTH_FRACTION = 0.45

#: Reference height for the loft's outward-winding test, as a fraction of the
#: midships side depth. Mid-depth on the centreline is inside the hull cavity
#: at EVERY station (the narrowest, the stem, still has the centreline), which
#: is the precondition flip_to_outward needs.
HULL_WINDING_REF_HEIGHT_FRACTION = 0.50

#: Triangle ceiling after export. Worst case is 1 536 instances of this mesh
#: in one draw (skiffModels.ts SKIFF_INSTANCE_CAPACITY).
TRIANGLE_BUDGET = 300

# ------------------------------------------------------------------- palette
# One material, four vertex colours. Same wood family as the war boat
# (build_war_boat.py WOOD_COLOR 0x53381f, its hull texture base 0x6b4a2f) and
# the same two colours the box skiff used, so nothing on the water shifts hue.

#: Planking. skiffModels.ts SKIFF_HULL_COLOR, unchanged.
PLANK_COLOR = (0x6B / 255, 0x4A / 255, 0x30 / 255, 1.0)
#: The sheer strake, standing in for a gunwale rail. Darker than the planking
#: so the top edge reads as an edge at gameplay distance.
RAIL_COLOR = (0x4A / 255, 0x32 / 255, 0x20 / 255, 1.0)
#: Thwarts. skiffModels.ts SKIFF_THWART_COLOR, unchanged.
THWART_COLOR = (0x4A / 255, 0x32 / 255, 0x20 / 255, 1.0)
#: Keel strip. Darkest: wet, worn wood under the boat.
KEEL_COLOR = (0x3A / 255, 0x26 / 255, 0x16 / 255, 1.0)
#: The sole. Lightest: dry, scuffed floorboards, which is what makes the
#: interior read as an interior from above rather than as more planking.
FLOOR_COLOR = (0x84 / 255, 0x62 / 255, 0x42 / 255, 1.0)

#: Blender's colour-attribute name, and the exporter's ACTIVE layer.
COLOR_ATTRIBUTE_NAME = 'Color'
#: Non-metallic, dry-ish wood. Matches build_war_boat.py's flat_material.
WOOD_ROUGHNESS = 0.85

MESH_NAME = 'skiff'
WATERLINE_ANCHOR_NAME = 'waterline'
#: The asset's own statement of "the interior is sealed below this height".
#: Exported as a second Empty beside `waterline`; phase 5 asserts
#: dryline.y - waterline.y >= its bob amplitude at load, so a re-author that
#: lowers the sole, or a client that raises the bob, fails loudly instead of
#: quietly showing sea inside the boat.
DRYLINE_ANCHOR_NAME = 'dryline'

#: The ONLY boundary the pre-Solidify hull may have: the gunwale, as ONE
#: CLOSED LOOP. Two rail lines of (STATION_COUNT - 1) edges each, plus the top
#: edge of each end cap — the cap is an n-gon over its whole station ring, so
#: its rail-to-rail chord closes the loop across that end instead of leaving
#: the sides' two boundaries dangling. A shell whose only boundary is one loop
#: is a disc with one hole, which is precisely "an open boat": Solidify's rim
#: is the gunwale and nothing else. Counted with bmesh in main() — a hole
#: anywhere else changes this number.
HULL_OPEN_BOUNDARY_EDGE_COUNT = 2 * (STATION_COUNT - 1) + 2

#: Tolerance for the analytic self-checks below (float dust, not slack).
EPSILON = 1e-6


# ------------------------------------------------------------------- shape
def half_beam_fraction(t):
    """Half-beam at length fraction `t` (0 = transom, 1 = stem), of the max."""
    peak = MAX_BEAM_STATION_FRACTION
    if t >= peak:
        run = (t - peak) / (1.0 - peak)
        return 1.0 - (1.0 - STEM_HALF_FRACTION) * run ** BOW_FULLNESS_EXPONENT
    run = (peak - t) / peak
    return 1.0 - (1.0 - TRANSOM_HALF_FRACTION) * run ** STERN_FULLNESS_EXPONENT


def sheer_rise(t):
    """How far the rail stands above the midships rail at length fraction t."""
    peak = MAX_BEAM_STATION_FRACTION
    if t >= peak:
        run = (t - peak) / (1.0 - peak)
        return SHEER_RISE_STEM * run * run
    run = (peak - t) / peak
    return SHEER_RISE_TRANSOM * run * run


def keel_lift(t):
    """Rocker: how far the keel line stands above its midships low point."""
    peak = MAX_BEAM_STATION_FRACTION
    if t >= peak:
        run = (t - peak) / (1.0 - peak)
    else:
        run = (peak - t) / peak
    return KEEL_ROCKER * run * run


def station_frame(t):
    """(x, half_beam, keel_z, side_depth) at length fraction t."""
    x = (t - 0.5) * HULL_LENGTH
    half = half_beam_fraction(t) * HULL_BEAM / 2.0
    keel_z = keel_lift(t)
    depth = HULL_DEPTH_MIDSHIPS + sheer_rise(t)
    return x, half, keel_z, depth


def design_half_width_at(half, keel_z, depth, z):
    """Half-width of the DESIGN SURFACE at height `z` on a station.

    Only the topsides band is modelled — from the turn of the bilge up to the
    rail — because that is the only band the sole can land in (its own height
    fraction is asserted to sit inside it). The loft is ruled between the
    section's corner points, so the half-width there is a straight
    interpolation between the bilge point and the rail point, which is exactly
    what the hull's quads render.
    """
    bilge_y = half * BILGE_HALF_FRACTION
    bilge_z = keel_z + depth * BILGE_HEIGHT_FRACTION
    rail_z = keel_z + depth
    assert bilge_z - EPSILON <= z <= rail_z + EPSILON, (
        f'z {z:.6f} is outside the topsides band [{bilge_z:.6f}, {rail_z:.6f}]')
    run = (z - bilge_z) / (rail_z - bilge_z)
    return bilge_y + run * (half - bilge_y)


def station_ring(t):
    """The five section points, port rail -> keel -> starboard rail."""
    x, half, keel_z, depth = station_frame(t)
    bilge_y = half * BILGE_HALF_FRACTION
    bilge_z = keel_z + depth * BILGE_HEIGHT_FRACTION
    rail_z = keel_z + depth
    return [
        (x, -half, rail_z),
        (x, -bilge_y, bilge_z),
        (x, 0.0, keel_z),
        (x, bilge_y, bilge_z),
        (x, half, rail_z),
    ]


# ------------------------------------------------------------------ geometry
def face_normal(a, b, c):
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    return (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )


def flip_to_outward(faces, verts, ref):
    """Wind faces so normals point away from a point INSIDE the part."""
    fixed = []
    for face in faces:
        normal = face_normal(verts[face[0]], verts[face[1]], verts[face[2]])
        centroid = (
            sum(verts[i][0] for i in face) / len(face),
            sum(verts[i][1] for i in face) / len(face),
            sum(verts[i][2] for i in face) / len(face),
        )
        away = (centroid[0] - ref[0], centroid[1] - ref[1], centroid[2] - ref[2])
        dot = normal[0] * away[0] + normal[1] * away[1] + normal[2] * away[2]
        fixed.append(face if dot >= 0 else list(reversed(face)))
    return fixed


def assert_outward(faces, verts, ref, label):
    """Numeric proof, not a claim: every normal points away from `ref`."""
    for face in faces:
        normal = face_normal(verts[face[0]], verts[face[1]], verts[face[2]])
        centroid = (
            sum(verts[i][0] for i in face) / len(face),
            sum(verts[i][1] for i in face) / len(face),
            sum(verts[i][2] for i in face) / len(face),
        )
        dot = sum(normal[k] * (centroid[k] - ref[k]) for k in range(3))
        assert dot > 0.0, f'{label}: inward-facing face {face} (dot {dot:.3e})'


def box_verts(center, size):
    """Solid box; faces wound outward (bottom, top, front, back, left, right)."""
    cx, cy, cz = center
    sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
    verts = [
        (cx - sx, cy - sy, cz - sz), (cx + sx, cy - sy, cz - sz),
        (cx + sx, cy + sy, cz - sz), (cx - sx, cy + sy, cz - sz),
        (cx - sx, cy - sy, cz + sz), (cx + sx, cy - sy, cz + sz),
        (cx + sx, cy + sy, cz + sz), (cx - sx, cy + sy, cz + sz),
    ]
    faces = [
        [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
        [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5],
    ]
    return verts, faces


def make_object(name, verts, faces, face_colors):
    """A flat-shaded mesh carrying one CORNER colour per face."""
    assert len(face_colors) == len(faces), (
        f'{name}: {len(face_colors)} colours for {len(faces)} faces')
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh.validate()
    layer = mesh.color_attributes.new(
        name=COLOR_ATTRIBUTE_NAME, type='BYTE_COLOR', domain='CORNER')
    for poly in mesh.polygons:
        poly.use_smooth = False
        for loop_index in poly.loop_indices:
            layer.data[loop_index].color = face_colors[poly.index]
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def vertex_color_material(name):
    """One material, base colour driven by COLOR_ATTRIBUTE_NAME.

    The Color Attribute node is what makes the Cycles check renders show the
    same paint the glTF COLOR_0 carries — without it the renders would lie.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    attribute = nodes.new('ShaderNodeVertexColor')
    attribute.layer_name = COLOR_ATTRIBUTE_NAME
    bsdf = nodes['Principled BSDF']
    links.new(attribute.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = WOOD_ROUGHNESS
    bsdf.inputs['Metallic'].default_value = 0.0
    return mat


def build_hull():
    """The station loft: verts, quads and one colour per quad."""
    verts = []
    for index in range(STATION_COUNT):
        verts.extend(station_ring(index / (STATION_COUNT - 1)))
    faces, colors = [], []
    for index in range(STATION_COUNT - 1):
        base = index * RING_POINT_COUNT
        for band in range(RING_POINT_COUNT - 1):
            faces.append([
                base + band,
                base + band + 1,
                base + RING_POINT_COUNT + band + 1,
                base + RING_POINT_COUNT + band,
            ])
            # Bands 0 and 3 are the sheer strake, rail-to-bilge on each side.
            is_sheer_strake = band in (0, RING_POINT_COUNT - 2)
            colors.append(RAIL_COLOR if is_sheer_strake else PLANK_COLOR)

    # END CAPS, BOTH ENDS. The loft only skins the sides, so before this each
    # end ring was a hole. At the transom (TRANSOM_HALF_FRACTION 0.60) that is
    # the missing back plate the owner reported; at the stem
    # (STEM_HALF_FRACTION 0.06) it is a hole too, merely one too thin to see at
    # this scale today. Both are capped: the contract worth having is "the loft
    # is closed everywhere except the rail", and two triangles of stem board
    # cost less than a hole that only stays invisible while nobody widens the
    # stem. Each ring is planar in x and convex (the bilge point sits below the
    # rail-to-keel chord), so one n-gon per end is a valid face.
    #
    # Appended BEFORE Solidify on purpose: the skin then thickens the caps with
    # the rest of the planking, and the boundary they close stops generating
    # rim faces — the caps cost 12 triangles after doubling and remove 16 of
    # rim, so closing the boat is cheaper than leaving it open.
    #
    # Colour is PLANK_COLOR, not RAIL_COLOR: the transom IS planking. The sheer
    # strake is a band read along the SIDE and painting a whole end panel with
    # it would read as a dark slab, not as an edge.
    for base in (0, (STATION_COUNT - 1) * RING_POINT_COUNT):
        faces.append(list(range(base, base + RING_POINT_COUNT)))
        colors.append(PLANK_COLOR)

    ref = (0.0, 0.0, HULL_DEPTH_MIDSHIPS * HULL_WINDING_REF_HEIGHT_FRACTION)
    faces = flip_to_outward(faces, verts, ref)
    assert_outward(faces, verts, ref, 'hull loft')
    return verts, faces, colors


def closed_prism(verts, faces, colors, sections, color, label):
    """Appends a closed prism swept along x through `sections`.

    `sections` is a list of (x, ring, interior_z) — one ring of n points per
    station, in a consistent order, plus a z on the prism's own centre axis at
    that x. Both prisms below are bent by the keel rocker, so a single global
    interior reference would fall OUTSIDE their end caps: side faces are wound
    against the axis point at their own x, and each cap against the axis point
    of the NEIGHBOURING section, which is the nearest point guaranteed to be
    inside the solid and at a different x (a cap is planar in x, so an
    reference at its own x would give a zero dot and decide nothing).
    """
    ring_size = len(sections[0][1])
    base = len(verts)
    for _x, ring, _interior_z in sections:
        assert len(ring) == ring_size, f'{label}: ragged sections'
        verts.extend(ring)

    def axis_point(index):
        x, _ring, interior_z = sections[index]
        return (x, 0.0, interior_z)

    for index in range(len(sections) - 1):
        near = base + index * ring_size
        far = near + ring_size
        for edge in range(ring_size):
            face = [
                near + edge,
                near + (edge + 1) % ring_size,
                far + (edge + 1) % ring_size,
                far + edge,
            ]
            ref = tuple(
                (axis_point(index)[k] + axis_point(index + 1)[k]) / 2 for k in range(3))
            wound = flip_to_outward([face], verts, ref)
            assert_outward(wound, verts, ref, f'{label} side')
            faces.extend(wound)
            colors.append(color)

    last = base + (len(sections) - 1) * ring_size
    for cap, ref_index in ((list(range(base, base + ring_size)), 1),
                           (list(range(last, last + ring_size)), len(sections) - 2)):
        ref = axis_point(ref_index)
        wound = flip_to_outward([cap], verts, ref)
        assert_outward(wound, verts, ref, f'{label} cap')
        faces.extend(wound)
        colors.append(color)


def sole_section(fraction):
    """One sole section: (x, ring, interior_z, top_z, top_edge_y).

    The ring is a trapezoid, not a rectangle: the topsides flare, so the sole's
    TOP edge and its BOTTOM edge meet the design surface at different
    half-widths. Following both keeps the whole port/starboard face on the
    design surface — a rectangle would push its bottom corners outboard of the
    mid-surface, eating into the 0.003 of skin that is the only thing keeping
    the sole from poking through the planking.
    """
    x, half, keel_z, depth = station_frame(fraction)
    top = keel_z + depth * FLOOR_HEIGHT_FRACTION
    bottom = top - FLOOR_THICKNESS
    top_edge = design_half_width_at(half, keel_z, depth, top)
    bottom_edge = design_half_width_at(half, keel_z, depth, bottom)
    ring = [
        (x, -top_edge, top),
        (x, top_edge, top),
        (x, bottom_edge, bottom),
        (x, -bottom_edge, bottom),
    ]
    return x, ring, top - FLOOR_THICKNESS / 2, top, top_edge


def assert_sole_meets_planking(fractions):
    """Numeric proof that the sole ends INSIDE the skin at every span midpoint.

    At the stations themselves the sole edge is ON the design surface by
    construction. BETWEEN them both surfaces are ruled, but they are ruled over
    different quantities — the hull interpolates its corner POINTS, the sole
    interpolates a half-width already solved at each station's own height — so
    the two chords do not coincide exactly. This measures that disagreement at
    the midpoint of every span, where a linear interpolation is furthest from
    what it approximates, and requires it to stay inside the skin's outward
    half-thickness. Inside the skin means the sole is buried in the planking:
    no gap to see sea through, no coplanar faces to z-fight.
    """
    worst = 0.0
    for index in range(len(fractions) - 1):
        near, far = fractions[index], fractions[index + 1]
        _nx, _nr, _ni, near_top, near_edge = sole_section(near)
        _fx, _fr, _fi, far_top, far_edge = sole_section(far)
        # The sole's own chord, sampled halfway along the span.
        sole_z = (near_top + far_top) / 2.0
        sole_y = (near_edge + far_edge) / 2.0
        # The hull's ruled surface over the same span, at the same height: the
        # loft's bilge and rail points interpolated, then solved for that z.
        mid = []
        for fraction in (near, far):
            _x, half, keel_z, depth = station_frame(fraction)
            mid.append((
                half * BILGE_HALF_FRACTION, keel_z + depth * BILGE_HEIGHT_FRACTION,
                half, keel_z + depth,
            ))
        bilge_y = (mid[0][0] + mid[1][0]) / 2.0
        bilge_z = (mid[0][1] + mid[1][1]) / 2.0
        rail_y = (mid[0][2] + mid[1][2]) / 2.0
        rail_z = (mid[0][3] + mid[1][3]) / 2.0
        run = (sole_z - bilge_z) / (rail_z - bilge_z)
        hull_y = bilge_y + run * (rail_y - bilge_y)
        worst = max(worst, abs(sole_y - hull_y))
    limit = SKIN_THICKNESS / 2.0
    print(f'  sole/planking worst mid-span disagreement {worst:.6f} '
          f'(skin half-thickness {limit:.6f})')
    assert worst < limit, (
        f'sole edge misses the planking by {worst:.6f} >= {limit:.6f}')


def build_fittings():
    """Sole, thwarts and keel strip — joined to the hull AFTER Solidify.

    Returns (verts, faces, colors, sole_top_min) — the lowest point of the
    sole's top surface, MEASURED off the emitted vertices, which is the height
    the `dryline` anchor and the dry-clearance assert are taken from.
    """
    verts, faces, colors = [], [], []

    # ---- the sole: a full-length seal above the waterline (see FLOOR_*) -----
    # Transom station to stem station, at the loft's own stations: see the
    # SOLE_SECTION_COUNT and "WHY THE SOLE IS A SEAL" notes above.
    fractions = [index / (SOLE_SECTION_COUNT - 1) for index in range(SOLE_SECTION_COUNT)]
    assert_sole_meets_planking(fractions)
    floor_sections = []
    sole_top_min = float('inf')
    for fraction in fractions:
        x, ring, interior_z, _top, _top_edge = sole_section(fraction)
        floor_sections.append((x, ring, interior_z))
        # Read off the emitted vertices, not off FLOOR_HEIGHT_FRACTION: the
        # dry-clearance contract has to be measured from the geometry that
        # actually ships.
        sole_top_min = min(sole_top_min, max(point[2] for point in ring))
    closed_prism(verts, faces, colors, floor_sections, FLOOR_COLOR, 'sole')

    # ---- thwarts: closed boxes, analytic winding, never flipped ----
    # Raising the sole eats into the space under the benches, so the clearance
    # is measured here (thwart underside minus the sole top at the SAME
    # station) instead of being left to the reader to subtract two fractions.
    for fraction in THWART_STATION_FRACTIONS:
        x, half, keel_z, depth = station_frame(fraction)
        top = keel_z + depth * THWART_HEIGHT_FRACTION
        sole_top_here = keel_z + depth * FLOOR_HEIGHT_FRACTION
        gap = top - THWART_PLANK_THICKNESS - sole_top_here
        print(f'  thwart at t={fraction}: underside {gap:.4f} above the sole')
        assert gap > EPSILON, f'thwart at t={fraction} sits on or below the sole'
        box_v, box_f = box_verts(
            (x, 0.0, top - THWART_PLANK_THICKNESS / 2),
            (THWART_PLANK_WIDTH, half * 2 * THWART_BEAM_FRACTION,
             THWART_PLANK_THICKNESS))
        offset = len(verts)
        verts.extend(box_v)
        faces.extend([[i + offset for i in face] for face in box_f])
        colors.extend([THWART_COLOR] * len(box_f))

    # ---- keel strip: a triangular prism under the planking, on the rocker ---
    keel_span = KEEL_STRIP_END_FRACTION - KEEL_STRIP_START_FRACTION
    keel_sections = []
    for index in range(KEEL_STRIP_SECTION_COUNT):
        fraction = KEEL_STRIP_START_FRACTION + keel_span * index / (KEEL_STRIP_SECTION_COUNT - 1)
        x, _half, keel_z, _depth = station_frame(fraction)
        keel_sections.append((x, [
            (x, -KEEL_STRIP_HALF_WIDTH, keel_z),
            (x, KEEL_STRIP_HALF_WIDTH, keel_z),
            (x, 0.0, keel_z - KEEL_STRIP_PROUD),
        ], keel_z - KEEL_STRIP_PROUD / 2))
    closed_prism(verts, faces, colors, keel_sections, KEEL_COLOR, 'keel strip')

    return verts, faces, colors, sole_top_min


def measure(objects):
    """World-space min/max over every mesh object's evaluated vertices."""
    lo = [float('inf')] * 3
    hi = [float('-inf')] * 3
    for obj in objects:
        for vert in obj.data.vertices:
            world = obj.matrix_world @ vert.co
            for axis in range(3):
                lo[axis] = min(lo[axis], world[axis])
                hi[axis] = max(hi[axis], world[axis])
    return lo, hi


def assert_only_the_rail_is_open(mesh):
    """The loft is closed everywhere but the gunwale — counted, not claimed.

    Runs on the PRE-Solidify hull, which is where the contract lives: every
    boundary edge Solidify finds becomes a rim, so "the only rim is the rail"
    and "the only boundary is the rail" are the same statement. An open edge is
    one with a single face; a rail edge is one whose two vertices are both rail
    points, i.e. the first or last point of their station ring.
    """
    bm = bmesh.new()
    bm.from_mesh(mesh)
    try:
        open_edges = [edge for edge in bm.edges if len(edge.link_faces) != 2]
        strays = [
            tuple(vert.index for vert in edge.verts)
            for edge in open_edges
            if any(vert.index % RING_POINT_COUNT not in (0, RING_POINT_COUNT - 1)
                   for vert in edge.verts)
        ]
        count = len(open_edges)
    finally:
        bm.free()
    print(f'  hull boundary edges before Solidify: {count} '
          f'(want {HULL_OPEN_BOUNDARY_EDGE_COUNT}, the gunwale loop)')
    assert not strays, f'open edges away from the rail: {strays}'
    assert count == HULL_OPEN_BOUNDARY_EDGE_COUNT, (
        f'{count} boundary edges, want {HULL_OPEN_BOUNDARY_EDGE_COUNT}')


def main():
    out_path = sys.argv[sys.argv.index('--') + 1:][0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    material = vertex_color_material('skiff_wood')

    hull_verts, hull_faces, hull_colors = build_hull()
    hull = make_object(MESH_NAME, hull_verts, hull_faces, hull_colors)
    hull.data.materials.append(material)
    assert_only_the_rail_is_open(hull.data)

    # Solidify BEFORE the fittings are joined: the thwarts and the keel strip
    # are already closed solids, and thickening them would bury a second shell
    # inside each one.
    solid = hull.modifiers.new('skin', 'SOLIDIFY')
    solid.thickness = SKIN_THICKNESS
    solid.offset = SKIN_OFFSET_CENTRED
    bpy.context.view_layer.objects.active = hull
    hull.select_set(True)
    bpy.ops.object.modifier_apply(modifier=solid.name)
    hull.select_set(False)

    fit_verts, fit_faces, fit_colors, sole_top_design_z = build_fittings()
    fittings = make_object('skiff_fittings', fit_verts, fit_faces, fit_colors)
    fittings.data.materials.append(material)

    # ONE mesh object: the plugin's InstancedMesh takes one geometry.
    bpy.ops.object.select_all(action='DESELECT')
    hull.select_set(True)
    fittings.select_set(True)
    bpy.context.view_layer.objects.active = hull
    bpy.ops.object.join()
    bpy.ops.object.select_all(action='DESELECT')
    skiff = bpy.data.objects[MESH_NAME]
    for poly in skiff.data.polygons:
        poly.use_smooth = False
    assert len(skiff.data.materials) == 1, (
        f'{MESH_NAME}: {len(skiff.data.materials)} materials after join, want 1')

    # Rebase so the lowest point of the boat is exactly z = 0 (the convention's
    # "origin on the centreline at the keel"): the keel strip stands proud of
    # the planking, so the design surface's own keel line is NOT the low point.
    # Solidify pushes the fine stem and the full transom out by different
    # amounts along x, so the solid is NOT centred on the design surface's
    # mid-length: re-centre it here rather than shipping an origin that is a
    # millimetre off the boat's own middle.
    lo, hi = measure([skiff])
    skiff.location.x = -(lo[0] + hi[0]) / 2
    keel_rebase_lift = -lo[2]
    skiff.location.z = keel_rebase_lift
    waterline_z = keel_rebase_lift + HULL_DEPTH_MIDSHIPS * WATERLINE_DEPTH_FRACTION
    # The sole's lowest top, carried through the same rebase the mesh gets.
    dryline_z = keel_rebase_lift + sole_top_design_z

    for name, height in ((WATERLINE_ANCHOR_NAME, waterline_z),
                         (DRYLINE_ANCHOR_NAME, dryline_z)):
        anchor = bpy.data.objects.new(name, None)
        anchor.empty_display_type = 'SPHERE'
        anchor.empty_display_size = 0.02
        anchor.location = (0.0, 0.0, height)
        bpy.context.collection.objects.link(anchor)

    bpy.context.view_layer.objects.active = skiff
    skiff.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    skiff.select_set(False)

    lo, hi = measure([skiff])
    size = [hi[axis] - lo[axis] for axis in range(3)]
    print(f'measured box (blender XYZ): {size[0]:.4f} x {size[1]:.4f} x {size[2]:.4f}')
    print(f'  keel bottom z = {lo[2]:.6f} (must be 0), waterline z = {waterline_z:.4f}')
    sole_dry_clearance = dryline_z - waterline_z
    print(f'  dryline z = {dryline_z:.4f}, sole clears the waterline by '
          f'{sole_dry_clearance:.4f} (min {SOLE_DRY_CLEARANCE_MIN})')
    assert sole_dry_clearance >= SOLE_DRY_CLEARANCE_MIN, (
        f'sole clears the waterline by only {sole_dry_clearance:.4f}, '
        f'need {SOLE_DRY_CLEARANCE_MIN}')
    assert abs(lo[2]) < EPSILON, f'keel bottom is {lo[2]:.6f}, not 0'
    assert abs(lo[0] + hi[0]) < EPSILON, 'hull is not centred on x'
    assert abs(lo[1] + hi[1]) < EPSILON, 'hull is not centred on the centreline'
    assert size[0] <= ENVELOPE_LENGTH, f'length {size[0]:.4f} > {ENVELOPE_LENGTH}'
    assert size[1] <= ENVELOPE_BEAM, f'beam {size[1]:.4f} > {ENVELOPE_BEAM}'
    assert size[2] <= ENVELOPE_HEIGHT, f'height {size[2]:.4f} > {ENVELOPE_HEIGHT}'
    # The sea plane must really cut the hull: some boat under it, and the
    # LOWEST rail (midships, where the sheer does not rise) still above it.
    # Measured against the geometry, not restated from WATERLINE_DEPTH_FRACTION.
    midships_rail_z = keel_rebase_lift + HULL_DEPTH_MIDSHIPS + keel_lift(
        MAX_BEAM_STATION_FRACTION)
    freeboard = midships_rail_z - waterline_z
    print(f'  draught {waterline_z - lo[2]:.4f}, freeboard amidships {freeboard:.4f}, '
          f'waterline at {(waterline_z - lo[2]) / size[2] * 100:.0f}% of box height')
    assert waterline_z > lo[2] + EPSILON, 'the waterline is at or below the keel'
    assert freeboard > EPSILON, 'the waterline is at or above the midships rail'

    tris = sum(len(p.vertices) - 2 for p in skiff.data.polygons)
    print(f'{MESH_NAME}: {len(skiff.data.polygons)} polys, {tris} tris, '
          f'{len(skiff.data.vertices)} verts')
    assert tris <= TRIANGLE_BUDGET, f'{tris} tris > budget {TRIANGLE_BUDGET}'
    assert COLOR_ATTRIBUTE_NAME in skiff.data.color_attributes, 'colour attribute lost'

    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_texcoords=False,
        export_materials='EXPORT',
        # ACTIVE, not the MATERIAL default: the paint must ship whether or not
        # the exporter decides the Principled tree "uses" the attribute.
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=False,
        export_image_format='NONE',
    )
    print(f'skiff -> {out_path}')


main()
