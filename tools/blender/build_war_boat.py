# build_war_boat.py — builds the Terrace war boat in Blender and exports it.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_war_boat.py -- \
#     E:\Development\Projects\Terrace\.boat-ref\out\mesh.json \
#     E:\Development\Projects\Terrace\.boat-ref\out\curves.json \
#     E:\...\model-assets\plugins\boats\client\assets\war-boat.glb
#
# WHAT IT BUILDS (docs/model-assets.md is the convention this satisfies).
# The hull is the traced loft from mesh.json's `hull-gamebox` variant — 13
# stations already at the game's dims (length 0.9, beam 0.34, side depth 0.2),
# ring-ordered rail -> keel -> rail — re-based so the keel sits at z=0.
# curves.json is read too: its traced half-breadth plan is CHECKED against the
# mesh stations (asserted within tolerance, printed), so the mesh cannot
# silently stop being the trace. Stem/stern posts come from the same trace
# (thin blades overlapping the hull ends, stretched to bite deeper and stand
# taller) and are JOINED into the hull mesh — shared geometry, not floating
# trim. Strakes, the shield-row stripe and one solid swatch per flat colour
# live in ONE generated baseColor atlas that EVERY baked part samples, so the
# whole boat bakes to a single draw call. Mast, yard and sail are
# separate nodes (the plugin recolours the sail when fighting); four oars hang
# under pivot Empties at the gunwale, dipped per OAR_DIP_RADIANS; anchors are
# Empties.
#
# WINDING. Every face list here is either wound analytically (boxes, cylinders:
# verified normals in the builders) or flipped numerically against an interior
# reference that is genuinely inside the part (hull loft, deck strip, rails,
# posts, sail). The generic flip is NEVER used on tubes or closed boxes, where
# the reference would be outside the solid and the "fix" would be the defect.
#
# Blender frame: X = length (bow +X), Y = beam (port +Y), Z = up. The glTF
# exporter maps this to +X forward, +Y up (see docs/model-assets.md).

import json
import math
import random
import sys

import bpy

# ---------------------------------------------------------------- dimensions
# The game's constants (plugins/boats/client/models.ts says why these and not
# real proportions). The trace is already at these numbers; they are stated
# here so a mismatch fails LOUDLY instead of shipping a wrong-sized boat.

HULL_LENGTH = 0.9
HULL_BEAM = 0.34
HULL_DEPTH = 0.2
MAST_HEIGHT = HULL_LENGTH * 0.66
MAST_RADIUS = 0.022
SAIL_WIDTH = HULL_BEAM * 1.15
SAIL_HEIGHT = MAST_HEIGHT * 0.5
YARD_RADIUS = 0.014
OAR_LENGTH = HULL_BEAM * 0.9
OAR_RADIUS = 0.012
OAR_DIP_RADIANS = 0.38
WATERLINE_Z = HULL_DEPTH * 0.55
DECK_Z = HULL_DEPTH - 0.035

# ------------------------------------------------------------------- atlas
# ONE image, sampled by EVERY baked material, because `bakeRig` merges parts
# by material signature and map identity is part of that key
# (client/src/render/rigSkin.ts). A textured hull beside untextured deck and
# spars is two draw calls per hull however small either half is; pointing all
# of them at one image makes a boat one surface. The flat parts sample a white
# texel, so their own baseColorFactor still supplies their colour — the baker
# folds it into vertex colours and the shader multiplies the two.
HULL_TEX_COLUMNS = 256
# The hull's last column, repeated to the right of it. Mip level n averages
# 2^n source columns, so this many columns keep the white swatch out of the
# stem posts down to the 16x8 mip — far below anything the game camera picks.
MIP_GUARD_COLUMNS = 32
ATLAS_WIDTH = 512
ATLAS_HEIGHT = 256
# The two flat swatches, as [start, end) column ranges. A part that samples one
# gives EVERY vertex the same uv, so its uv derivatives are zero and it reads
# mip 0 — the block's size is belt to the guard's suspenders, not the mechanism.
DECK_SWATCH_COLUMNS = (HULL_TEX_COLUMNS + MIP_GUARD_COLUMNS, 400)
WOOD_SWATCH_COLUMNS = (400, ATLAS_WIDTH)
# The hull pattern's share of the atlas width: authored u in 0..1 maps here.
HULL_U_SPAN = HULL_TEX_COLUMNS / ATLAS_WIDTH



def srgb(hex_color):
    """An sRGB hex -> the LINEAR RGBA Blender's Base Color input expects.

    WHY THIS IS NOT `hex / 255`. Every colour in this codebase is an sRGB hex
    (what three.js reads `new MeshLambertMaterial({ color })` as); Blender's
    Base Color socket and glTF's baseColorFactor are LINEAR. Feeding 0xE8/255
    straight in asks for a colour whose sRGB encoding is brighter, so the deck,
    spars and sail rendered paler than their hex (found on the fish, 2026-09-04;
    same helper as build_fish.py). The transfer function is the sRGB standard's.

The ATLAS does not go through this: `Image.pixels` on a byte image
    are the raw byte values, and the image is tagged sRGB, so its bytes are
    already what glTF expects of a baseColor texture.
    """
    def channel(byte):
        c = byte / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (channel(hex_color >> 16 & 0xFF), channel(hex_color >> 8 & 0xFF),
            channel(hex_color & 0xFF), 1.0)


# The deck and the spars are now PIXELS in the atlas, not baseColorFactors, so
# they are kept as sRGB hexes: `Image.pixels` on a byte image tagged sRGB take
# the raw byte values (see srgb's docstring), which is why these do not go
# through it and the sail's colour, still a factor, does.
DECK_HEX = 0x8A6A44
WOOD_HEX = 0x53381F
SAIL_COLOR = srgb(0xE8E0CF)

MAST_X = 0.05
OAR_XS = (0.126, -0.162)


def load_inputs(mesh_path, curves_path):
    with open(mesh_path, encoding='utf-8') as handle:
        mesh_data = json.load(handle)
    with open(curves_path, encoding='utf-8') as handle:
        curves = json.load(handle)
    gamebox = mesh_data['hull-gamebox']
    return gamebox['hull'], gamebox['posts'], curves


def check_lineage(hull, posts, curves):
    """The mesh must still be the trace it claims to be — dims plus plan."""
    xs = sorted({round(v[0], 9) for v in hull['verts']})
    assert len(xs) == 13, f'expected 13 traced stations, got {len(xs)}'
    assert abs(max(xs) - min(xs) - HULL_LENGTH) < 1e-6, 'traced length is not 0.9'
    beam = max(abs(v[1]) for v in hull['verts']) * 2
    assert abs(beam - HULL_BEAM) < 0.01, f'traced beam {beam:.3f} is not {HULL_BEAM}'
    # The traced half-breadth plan (400 samples over the length) must agree
    # with the mesh stations: both normalised, sampled at the same xs.
    half = curves['half']
    n = curves['n']
    peak = max(half)
    worst = 0.0
    for x in xs:
        ring = [v for v in hull['verts'] if abs(v[0] - x) < 1e-9]
        mesh_norm = max(abs(v[1]) for v in ring) / (beam / 2) if len(ring) == 17 else 0.0
        idx = min(n - 1, int((x + 0.45) / 0.9 * n))
        curve_norm = half[idx] / peak
        worst = max(worst, abs(mesh_norm - curve_norm))
    print(f'lineage: plan-shape disagreement {worst:.4f} (must be < 0.05)')
    assert worst < 0.05, 'mesh stations drifted from the traced plan'
    assert len(posts['verts']) > 0 and len(posts['faces']) > 0, 'trace has no posts'


def station_frames(hull):
    """Per-station (x, gunwale_half, gunwale_z, keel_z), bow-ward ascending."""
    stations = []
    for x in sorted({round(v[0], 9) for v in hull['verts']}):
        ring = [v for v in hull['verts'] if abs(v[0] - x) < 1e-9]
        if len(ring) == 17:
            # Ring order: index 0 rail ... 8 keel ... 16 rail.
            gun = ring[0]
            stations.append((x, abs(gun[1]), gun[2], min(v[2] for v in ring)))
        else:
            stations.append((x, 0.0, max(v[2] for v in ring), min(v[2] for v in ring)))
    return stations


def lerp_station(stations, x):
    """Gunwale (half-beam, z) at an arbitrary x by linear interpolation."""
    ends = [s for s in stations if s[1] > 1e-9]
    if x <= ends[0][0]:
        return ends[0][1], ends[0][2]
    if x >= ends[-1][0]:
        return ends[-1][1], ends[-1][2]
    for (x0, y0, z0, _), (x1, y1, z1, _) in zip(ends, ends[1:]):
        if x0 <= x <= x1:
            t = (x - x0) / (x1 - x0)
            return y0 + t * (y1 - y0), z0 + t * (z1 - z0)
    raise AssertionError(f'oar x={x} outside the traced stations')


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


def make_object(name, verts, faces, uvs):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh.validate()
    if uvs is not None:
        assert len(uvs) == len(verts), f'{name}: {len(uvs)} uvs for {len(verts)} verts'
        layer = mesh.uv_layers.new(name='UVMap')
        for poly in mesh.polygons:
            for loop_index in poly.loop_indices:
                layer.data[loop_index].uv = uvs[mesh.loops[loop_index].vertex_index]
    for poly in mesh.polygons:
        poly.use_smooth = False
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def make_empty(name, location, size=0.03):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = 'SPHERE'
    obj.empty_display_size = size
    obj.location = location
    bpy.context.collection.objects.link(obj)
    return obj


def flat_material(name, color):
    """Colour from baseColorFactor alone — the sail, which is never baked."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = 0.85
    bsdf.inputs['Metallic'].default_value = 0.0
    return mat




def texel(hex_color):
    """An sRGB hex -> the byte triple `Image.pixels` wants (see srgb)."""
    return (hex_color >> 16 & 0xFF) / 255, (hex_color >> 8 & 0xFF) / 255, (hex_color & 0xFF) / 255


def swatch_uv(columns):
    """The uv at the middle of a swatch block, in atlas coordinates."""
    return ((columns[0] + columns[1]) / 2 / ATLAS_WIDTH, 0.5)


def boat_atlas():
    """The boat's one baseColor image: hull strakes, then the flat swatches.

    Left `HULL_TEX_COLUMNS` columns: plank strakes with seams, grain and the
    shield-row stripes, exactly the pattern the hull carried when it had the
    texture to itself. Then `MIP_GUARD_COLUMNS` of the hull's last column, then
    one solid block per flat colour.
    """
    rng = random.Random(20260903)
    pixels = [0.0] * (ATLAS_WIDTH * ATLAS_HEIGHT * 4)
    base = texel(0x6B4A2F)
    seam = texel(0x3A2616)
    shields = [texel(0xB03A2E), texel(0xE8E0CF), texel(0xC8962E), texel(0x2E2E2E)]
    # v=0 is one rail, v=1 the other; 8 strakes a side over the 17-ring loft.
    strake_rows = 8
    for row in range(ATLAS_HEIGHT):
        v = row / (ATLAS_HEIGHT - 1)
        side = min(v, 1.0 - v) * 2.0  # 0 at a rail, 1 at the keel
        in_stripe = side < 0.10
        pos = (1.0 - side) * strake_rows
        seam_line = abs(pos - round(pos)) < 0.06
        for col in range(HULL_TEX_COLUMNS):
            shade = 0.92 + 0.08 * rng.random()
            r, g, b = base[0] * shade, base[1] * shade, base[2] * shade
            if seam_line and not in_stripe:
                r, g, b = seam
            if in_stripe:
                r, g, b = shields[(col // 16) % len(shields)]
            # Butt joints: a vertical seam every ~64px, staggered per strake.
            if ((col + round(pos) * 37) % 64) == 0 and not in_stripe:
                r, g, b = seam
            i = (row * ATLAS_WIDTH + col) * 4
            pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3] = r, g, b, 1.0
        edge = (row * ATLAS_WIDTH + HULL_TEX_COLUMNS - 1) * 4
        for col in range(HULL_TEX_COLUMNS, HULL_TEX_COLUMNS + MIP_GUARD_COLUMNS):
            i = (row * ATLAS_WIDTH + col) * 4
            pixels[i:i + 4] = pixels[edge:edge + 4]
        for columns, colour in ((DECK_SWATCH_COLUMNS, texel(DECK_HEX)),
                                (WOOD_SWATCH_COLUMNS, texel(WOOD_HEX))):
            for col in range(*columns):
                i = (row * ATLAS_WIDTH + col) * 4
                pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3] = (*colour, 1.0)
    image = bpy.data.images.new('war_boat_atlas', ATLAS_WIDTH, ATLAS_HEIGHT)
    image.pixels.foreach_set(pixels)
    image.update()
    return image


def mapped_material(name, image):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image
    bsdf = nodes['Principled BSDF']
    links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.85
    bsdf.inputs['Metallic'].default_value = 0.0
    return mat


def cylinder_verts(radius, length, sides, axis):
    """Solid cylinder on the origin; side faces wound outward, caps closed."""
    verts = []
    for end in (-length / 2, length / 2):
        for k in range(sides):
            a = 2 * math.pi * k / sides
            if axis == 'Y':
                verts.append((radius * math.cos(a), end, radius * math.sin(a)))
            else:
                verts.append((radius * math.cos(a), radius * math.sin(a), end))
    faces = []
    for k in range(sides):
        k2 = (k + 1) % sides
        faces.append([k, k2, sides + k2, sides + k])
    faces.append(list(reversed(range(sides))))
    faces.append([sides + k for k in range(sides)])
    return verts, faces


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


def rot_x(point, angle):
    x, y, z = point
    c, s = math.cos(angle), math.sin(angle)
    return (x, c * y - s * z, s * y + c * z)


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    mesh_path, curves_path, out_path = args[0], args[1], args[2]
    hull, posts, curves = load_inputs(mesh_path, curves_path)

    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            coll.remove(item)

    check_lineage(hull, posts, curves)
    stations = station_frames(hull)

    # Re-base: keel amidships -> z=0, side depth -> exactly HULL_DEPTH.
    mid = min([s for s in stations if s[1] > 1e-9], key=lambda s: abs(s[0]))
    keel_z, gun_z = mid[3], mid[2]
    depth_scale = HULL_DEPTH / (gun_z - keel_z)

    def lift(z):
        return (z - keel_z) * depth_scale

    print(f'trace depth {(gun_z - keel_z):.4f} -> {HULL_DEPTH}, keel {keel_z:.4f} -> 0')

    # ---- hull loft (traced verts/faces, re-based, wound outward) ----
    raw_verts = hull['verts']
    hull_verts = [(v[0], v[1], lift(v[2])) for v in raw_verts]
    hull_faces = flip_to_outward(
        [list(f) for f in hull['faces']], hull_verts, (0.0, 0.0, 0.1))
    # UV: u along the length, v across the section (rail 0 -> keel .5 -> rail 1).
    hull_uvs = []
    for v in raw_verts:
        u = (v[0] + 0.45) / 0.9 * HULL_U_SPAN
        ring = [w for w in raw_verts if abs(w[0] - v[0]) < 1e-9]
        hull_uvs.append((u, ring.index(v) / 16) if len(ring) == 17 else (u, 0.5))

    all_verts = list(hull_verts)
    all_faces = list(hull_faces)
    all_uvs = list(hull_uvs)

    # ---- posts: traced blades, stretched, joined = shared geometry ----
    # The trace's posts overlap the hull ends but barely bite; scaling z 1.3
    # about z=0.05 drives their heels into the hull solid AND raises their tops
    # so they read at game distance. Wound against each blade's own centroid
    # (convex solid: the reference is genuinely inside every face).
    post_base = len(all_verts)
    for v in posts['verts']:
        z = 0.05 + (v[2] - 0.05) * 1.3
        all_verts.append((v[0], v[1], lift(z)))
        u = min(1.0, max(0.0, (v[0] + 0.45) / 0.9)) * HULL_U_SPAN
        all_uvs.append((u, 0.5))
    for face in posts['faces']:
        blade = [i + post_base for i in face]
        centroid = (
            sum(all_verts[i][0] for i in blade) / len(blade),
            0.0,
            sum(all_verts[i][2] for i in blade) / len(blade),
        )
        all_faces.extend(flip_to_outward([blade], all_verts, centroid))

    # ---- gunwale rails: ribbons down the sheer, sampling the shield stripe --
    for side in (-1.0, 1.0):
        ribbon = []
        for x, half, gz, _keel in stations:
            if half < 0.01:
                continue
            gz = lift(gz)
            ribbon.append((x, side * half, gz + 0.006))
            ribbon.append((x, side * half * 0.98, gz - 0.032))
        start = len(all_verts)
        all_verts.extend(ribbon)
        v_row = 0.03 if side < 0 else 0.97
        for x, _y, _z in ribbon:
            all_uvs.append(((x + 0.45) / 0.9 * HULL_U_SPAN, v_row))
        for k in range(len(ribbon) // 2 - 1):
            quad = [start + 2 * k, start + 2 * k + 1, start + 2 * k + 3, start + 2 * k + 2]
            all_faces.extend(flip_to_outward([quad], all_verts, (0.0, side * 10.0, 0.1)))

    # ONE material for every part the rig bakes — see the atlas constants for
    # why that, and not four, is what makes a hull one draw call.
    boat_material = mapped_material('boat_atlas', boat_atlas())
    deck_uv = swatch_uv(DECK_SWATCH_COLUMNS)
    wood_uv = swatch_uv(WOOD_SWATCH_COLUMNS)

    hull_obj = make_object('hull', all_verts, all_faces, all_uvs)
    hull_obj.data.materials.append(boat_material)

    # Solidify: the loft is a skin with no thickness — from above, the far
    # wall's backface would cull and the hull would read see-through.
    solid = hull_obj.modifiers.new('hull_solid', 'SOLIDIFY')
    solid.thickness = 0.012
    bpy.context.view_layer.objects.active = hull_obj
    hull_obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=solid.name)
    hull_obj.select_set(False)

    # ---- deck + thwarts (one node, flat) ----
    deck_verts, deck_faces = [], []
    inner = [s for s in stations if abs(s[0]) <= 0.37 and s[1] > 1e-9]
    for x, half, _gz, _kz in inner:
        w = half * 0.85
        deck_verts.append((x, -w, DECK_Z))
        deck_verts.append((x, w, DECK_Z))
    strip_faces = []
    for k in range(len(inner) - 1):
        strip_faces.append([2 * k, 2 * k + 1, 2 * k + 3, 2 * k + 2])
    # The strip is near-horizontal: flipping it alone is safe. Thwarts are
    # closed boxes with analytic winding and are never flipped.
    deck_faces.extend(flip_to_outward(strip_faces, deck_verts, (0.0, 0.0, 1.0)))
    for tx in (-0.18, 0.0, 0.18):
        half, _gz = lerp_station(stations, tx)
        verts, faces = box_verts((tx, 0.0, DECK_Z + 0.011), (0.055, half * 2 * 0.9, 0.022))
        off = len(deck_verts)
        deck_faces.extend([[i + off for i in f] for f in faces])
        deck_verts.extend(verts)
    deck_obj = make_object('deck', deck_verts, deck_faces, [deck_uv] * len(deck_verts))
    deck_obj.data.materials.append(boat_material)

    # ---- mast + yard (analytic cylinders, no flip needed) ----
    mast_verts, mast_faces = cylinder_verts(MAST_RADIUS, MAST_HEIGHT, 8, 'Z')
    mast_verts = [(MAST_X + x, y, DECK_Z + MAST_HEIGHT / 2 + z) for x, y, z in mast_verts]
    mast_obj = make_object('mast', mast_verts, mast_faces, [wood_uv] * len(mast_verts))
    mast_obj.data.materials.append(boat_material)

    sail_cz = DECK_Z + MAST_HEIGHT * 0.62
    yard_cz = sail_cz + SAIL_HEIGHT / 2
    yard_verts, yard_faces = cylinder_verts(YARD_RADIUS, SAIL_WIDTH + 0.06, 8, 'Y')
    yard_verts = [(MAST_X + x, y, yard_cz + z) for x, y, z in yard_verts]
    yard_obj = make_object('yard', yard_verts, yard_faces, [wood_uv] * len(yard_verts))
    yard_obj.data.materials.append(boat_material)

    # ---- sail: its own node, NOT baked (the plugin recolours it to fight) ---
    # A thin SOLID, not a plane: single-sided planes vanish from behind, and a
    # solid needs no double-sided flag to read from every camera.
    sail_verts, sail_faces = box_verts(
        (MAST_X + 0.008, 0.0, sail_cz), (0.015, SAIL_WIDTH, SAIL_HEIGHT))
    sail_obj = make_object('sail', sail_verts, sail_faces,
                           [(0.0, 0.0)] * len(sail_verts))
    sail_obj.data.materials.append(flat_material('sail_canvas', SAIL_COLOR))

    # ---- oars: pivot Empty at the gunwale, shaft+blade mesh dipped under it -
    # Base rotation lays +Z onto the beam; the dip tilts the blade down.
    # Port (+Y): -pi/2 - dip; starboard: +pi/2 + dip. Meshes keep analytic
    # winding (no flip): the dip is a rigid rotation, which preserves it.
    oar_names = []
    for side_name, side in (('port', 1.0), ('starboard', -1.0)):
        for num, ox in enumerate(OAR_XS, start=1):
            half, gz = lerp_station(stations, ox)
            pivot = make_empty(f'oar_{side_name}_{num}', (ox, side * half, lift(gz) - 0.008))
            shaft_v, shaft_f = cylinder_verts(OAR_RADIUS, OAR_LENGTH, 6, 'Z')
            shaft_v = [(x, y, z + OAR_LENGTH / 2) for x, y, z in shaft_v]
            blade_v, blade_f = box_verts((0, 0, OAR_LENGTH - 0.045), (0.055, 0.008, 0.11))
            off = len(shaft_v)
            mesh_v = shaft_v + blade_v
            mesh_f = shaft_f + [[i + off for i in f] for f in blade_f]
            theta = (-math.pi / 2 - OAR_DIP_RADIANS) if side > 0 else (math.pi / 2 + OAR_DIP_RADIANS)
            mesh_v = [rot_x(p, theta) for p in mesh_v]
            oar_obj = make_object(f'oar_{side_name}_{num}_shaft', mesh_v, mesh_f,
                                  [wood_uv] * len(mesh_v))
            oar_obj.data.materials.append(boat_material)
            oar_obj.parent = pivot
            oar_names.append(pivot.name)

    # ---- anchors ----
    make_empty('waterline', (0.0, 0.0, WATERLINE_Z))
    make_empty('deck_top', (0.0, 0.0, DECK_Z))
    make_empty('fire_top', (MAST_X, 0.0, DECK_Z + MAST_HEIGHT + 0.02))

    # Bake rotations into the mesh data (the oar dip must survive as geometry:
    # the plugin only ever yaws the pivots). One object at a time — the op
    # applies to the selection, and a shared selection would double-apply.
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
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        total_tris += tris
        print(f'  {obj.name}: {len(mesh.polygons)} polys, {tris} tris')
    print(f'war boat -> {out_path}: {total_tris} tris total')
    print(f'oars: {oar_names}')


main()
