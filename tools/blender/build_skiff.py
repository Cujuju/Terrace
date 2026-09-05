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
# numerically-verified outward winding, Solidify on the skin, an Empty as the
# waterline anchor, transforms applied, then export_scene.gltf.
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

#: The stations the sole spans, as fractions of the length from the stem.
#: Nearly the whole boat: the top-down check render showed sea through the
#: uncovered bilge wedges when the sole stopped at 0.28/0.76.
FLOOR_START_FRACTION = 0.14
FLOOR_END_FRACTION = 0.88
#: Sections along the sole. Four: enough to follow the taper of the run.
FLOOR_SECTION_COUNT = 4
#: How much of the local beam the floorboards span. Short of the planking, so
#: the two never z-fight where the sole meets the bilge.
FLOOR_BEAM_FRACTION = 0.82
#: Height of the sole's top above the local keel line, as a fraction of the
#: local side depth. Above WATERLINE_DEPTH_FRACTION: that is the whole point.
FLOOR_HEIGHT_FRACTION = 0.56
#: Thickness of the floorboards.
FLOOR_THICKNESS = 0.005

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


def build_fittings():
    """Sole, thwarts and keel strip — joined to the hull AFTER Solidify."""
    verts, faces, colors = [], [], []

    # ---- the sole: floorboards above the waterline (see FLOOR_* constants) --
    floor_span = FLOOR_END_FRACTION - FLOOR_START_FRACTION
    floor_sections = []
    for index in range(FLOOR_SECTION_COUNT):
        fraction = FLOOR_START_FRACTION + floor_span * index / (FLOOR_SECTION_COUNT - 1)
        x, half, keel_z, depth = station_frame(fraction)
        edge = half * FLOOR_BEAM_FRACTION
        top = keel_z + depth * FLOOR_HEIGHT_FRACTION
        bottom = top - FLOOR_THICKNESS
        floor_sections.append((x, [
            (x, -edge, top),
            (x, edge, top),
            (x, edge, bottom),
            (x, -edge, bottom),
        ], top - FLOOR_THICKNESS / 2))
    closed_prism(verts, faces, colors, floor_sections, FLOOR_COLOR, 'sole')

    # ---- thwarts: closed boxes, analytic winding, never flipped ----
    for fraction in THWART_STATION_FRACTIONS:
        x, half, keel_z, depth = station_frame(fraction)
        top = keel_z + depth * THWART_HEIGHT_FRACTION
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

    return verts, faces, colors


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


def main():
    out_path = sys.argv[sys.argv.index('--') + 1:][0]

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    material = vertex_color_material('skiff_wood')

    hull_verts, hull_faces, hull_colors = build_hull()
    hull = make_object(MESH_NAME, hull_verts, hull_faces, hull_colors)
    hull.data.materials.append(material)

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

    fit_verts, fit_faces, fit_colors = build_fittings()
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

    anchor = bpy.data.objects.new(WATERLINE_ANCHOR_NAME, None)
    anchor.empty_display_type = 'SPHERE'
    anchor.empty_display_size = 0.02
    anchor.location = (0.0, 0.0, waterline_z)
    bpy.context.collection.objects.link(anchor)

    bpy.context.view_layer.objects.active = skiff
    skiff.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    skiff.select_set(False)

    lo, hi = measure([skiff])
    size = [hi[axis] - lo[axis] for axis in range(3)]
    print(f'measured box (blender XYZ): {size[0]:.4f} x {size[1]:.4f} x {size[2]:.4f}')
    print(f'  keel bottom z = {lo[2]:.6f} (must be 0), waterline z = {waterline_z:.4f}')
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
