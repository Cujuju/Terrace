# build_saucers.py — build the three flying-saucer models and export each as
# one .glb (docs/model-assets.md convention: units = cells, Y up after export,
# forward = +X, origin on the centreline at the hull's underside).
#
# Built, not modelled by hand, like the war boat: every hull is a lathe of a
# named profile, so a variant is a table of (radius, height) pairs plus a
# palette. Node names are the contract the saucers plugin animates against
# (plugins/saucers/client): meshes `hull`, `ring` (the spinning part), `dome`,
# `lights` (the flashing emissive strip); Empties `muzzle` (laser origin,
# underside) and `top`. One material per mesh — rigSkin cannot bake more.
#
# Run headless from WSL (paths INSIDE are Windows paths):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/build_saucers.py -- E:\out\dir
#
# Writes saucer-a.glb, saucer-b.glb, saucer-c.glb into that directory. Each
# file carries one looping animation, `spin`, on `ring`: one full turn over
# SPIN_FRAMES at SCENE_FPS. Light flashing and lasers are driven at runtime
# (they are state, not shape), so they are not baked here.

import math
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

# ---------------------------------------------------------------- constants

# Authored outer diameter, in cells. The plugin measures the file and fits it
# to its own constant; this is the size the profiles below are drawn at.
OUTER_DIAMETER_CELLS = 4.0

# Segments around the axis for lathed parts. 96 keeps the rim round at the
# game's closest camera without pushing a saucer past ~8k triangles.
LATHE_SEGMENTS = 96

# Edges whose adjacent faces meet at more than this angle are marked sharp,
# which is what keeps a rim crease crisp under smooth shading (4.1+ splits
# normals on sharp edges directly).
SHARP_ANGLE_DEG = 32.0

SCENE_FPS = 60
SPIN_FRAMES = 120  # one revolution per two seconds at SCENE_FPS

# Emissive strength for the glowing parts. glTF carries it through
# KHR_materials_emissive_strength; three.js reads it as emissiveIntensity.
# AUTHORED FOR THE GAME'S RENDERER (client/src/render/scene.ts): ACES at
# exposure 1.25, no bloom, no environment map. Values that need bloom to look
# right are not allowed here — the viewer and the game must agree.
# Kept low enough that ACES does not clip a saturated glow to white.
GLOW_STRENGTH = 1.3
LIGHT_STRENGTH = 2.0

# The game has NO environment map, and a metal with nothing to reflect is a
# black shell under three's PBR. So metalness stays LOW and the metal look —
# brushing, dents, oxide — is baked into the base-colour texture instead.
HULL_METALNESS = 0.35

# Rivet heads are geometry (mesh `rivets`), not paint: a texture dot vanishes
# under mipmapping at the game's camera distance, a bump on the silhouette
# does not. Radius in cells.
RIVET_RADIUS_CELLS = 0.055
RIVET_SINK_CELLS = 0.02      # how far the sphere is buried in the hull

# Hull textures are generated here (no sidecar files): one square image per
# hull, UV-mapped as u = angle around the axis, v = arc length up the profile.
TEXTURE_SIZE = 1024


# ---------------------------------------------------------------- helpers

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # New keys are LINEAR so the spin has no ease at the loop seam (5.x
    # layered actions hide fcurves behind slots; the preference is simpler).
    bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
    scene = bpy.context.scene
    scene.render.fps = SCENE_FPS
    scene.frame_start = 1
    scene.frame_end = SPIN_FRAMES


def material(name, rgb, *, metallic=0.0, roughness=0.5, emission=None,
             emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = emission_strength
    return mat


# ------------------------------------------------------------ metal textures
#
# Three DIFFERENT metals, one per craft, each its own algorithm rather than one
# generator with the dials moved: brushed gunmetal (A), hammered aluminium (B)
# and oxidised iron (C). All share the UV frame the lathe writes: u around the
# hull, v up the profile. Values are sRGB bytes written straight to the image.

def _uv_grid():
    n = TEXTURE_SIZE
    u = np.linspace(0.0, 1.0, n, endpoint=False)[None, :]
    v = np.linspace(0.0, 1.0, n, endpoint=False)[:, None]
    return n, u, v


def _smooth_noise(rng, cells_v, cells_u):
    """Coarse gaussian grid, bilinearly upsampled to the texture: soft drift."""
    n = TEXTURE_SIZE
    coarse = rng.normal(0.0, 1.0, (cells_v + 1, cells_u + 1))
    coarse[:, -1] = coarse[:, 0]           # tile seamlessly around the hull
    yv = np.linspace(0.0, cells_v, n, endpoint=False)
    xu = np.linspace(0.0, cells_u, n, endpoint=False)
    y0 = np.floor(yv).astype(int); x0 = np.floor(xu).astype(int)
    fy = (yv - y0)[:, None]; fx = (xu - x0)[None, :]
    c00 = coarse[y0][:, x0]; c01 = coarse[y0][:, x0 + 1]
    c10 = coarse[y0 + 1][:, x0]; c11 = coarse[y0 + 1][:, x0 + 1]
    out = (c00 * (1 - fx) + c01 * fx) * (1 - fy) + (c10 * (1 - fx) + c11 * fx) * fy
    return out / (np.abs(out).max() + 1e-6)


def _panel_seams(u, v, wedges, rings, width, dark):
    """Dark plate seams: vertical lines at wedge boundaries, horizontal at the
    ring positions, with a pale bevel just beside each. Returns a multiplier."""
    du = 0.5 - np.abs(((u * wedges) % 1.0) - 0.5)          # 0 at a seam
    wedge = np.exp(-(du / (width * wedges)) ** 2)
    bevel = np.exp(-((du - width * wedges * 1.8) / (width * wedges)) ** 2)
    ring = np.zeros_like(v); rbevel = np.zeros_like(v)
    for rv in rings:
        ring = np.maximum(ring, np.exp(-((v - rv) / width) ** 2))
        rbevel = np.maximum(rbevel, np.exp(-((np.abs(v - rv) - width * 1.8) / width) ** 2))
    seam = np.maximum(wedge, ring)
    lift = np.maximum(bevel, rbevel)
    return (1.0 - dark * seam) * (1.0 + 0.06 * lift)


def _rivet_shadows(u, v, count, rows, radius_uv):
    """Soft contact shadow under each geometric rivet head, so the row still
    reads from a distance where the head itself is a pixel."""
    ru = ((u * count) % 1.0) - 0.5
    du = ru / count
    out = np.zeros_like(u * v)
    for rv in rows:
        r2 = (du ** 2 + (v - rv) ** 2) / (radius_uv * 1.5) ** 2
        out = np.maximum(out, np.clip(1.0 - r2, 0.0, 1.0))
    return 1.0 - 0.28 * out


def _to_image(name, rgb):
    n = TEXTURE_SIZE
    rgb = np.clip(rgb, 0.0, 1.0)
    pixels = np.concatenate([rgb, np.ones((n, n, 1))], axis=2).astype(np.float32)
    img = bpy.data.images.new(name, n, n, alpha=False)
    img.pixels.foreach_set(pixels.ravel())
    img.pack()
    return img


def brushed_gunmetal(name, *, wedges, rings, rivet_count, rivet_rows, seed):
    """Turned dark steel: dense circumferential hairlines whose contrast drifts
    in sheen bands, a few long bright scratches, cool blue-grey base."""
    n, u, v = _uv_grid()
    rng = np.random.default_rng(seed)
    hair = rng.normal(0.0, 1.0, (n, 1))                       # one value per row
    hair = hair / (np.abs(hair).max() + 1e-6)
    sheen = _smooth_noise(rng, 2, 20)                          # bands around
    scratch_rows = rng.random((n, 1)) < 0.05
    scratch_on = rng.random((n, n)) < 0.6
    scratch = np.where(scratch_rows & scratch_on, 1.0, 0.0)
    drift = _smooth_noise(rng, 5, 5)
    shade = 1.0 + 0.16 * hair * (0.5 + 0.9 * sheen) + 0.14 * scratch + 0.08 * drift
    shade *= _panel_seams(u, v, wedges, rings, 0.0035, 0.55)
    shade *= _rivet_shadows(u, v, rivet_count, rivet_rows, 0.009)
    base = np.array([0.40, 0.42, 0.47])
    tint = np.array([0.02, 0.01, -0.02]) * sheen[:, :, None]  # warm/cool sheen
    return _to_image(name, base[None, None, :] * shade[:, :, None] + tint)


def hammered_aluminium(name, *, wedges, rings, rivet_count, rivet_rows, seed):
    """Bright planished aluminium: a field of overlapping shallow dimples, each
    lit from the upper left, over a faint fine grain and light plate seams."""
    n, u, v = _uv_grid()
    rng = np.random.default_rng(seed)
    dimples = np.zeros((n, n))
    light = np.zeros((n, n))
    count = 2600
    cx = rng.random(count); cy = rng.random(count)
    rad = rng.uniform(0.010, 0.022, count)
    yy = v; xx = u
    for k in range(count):
        # Wrap in u so dimples cross the seam column cleanly.
        dx = ((xx - cx[k] + 0.5) % 1.0) - 0.5
        dy = yy - cy[k]
        r2 = (dx * dx + dy * dy) / (rad[k] ** 2)
        inside = np.clip(1.0 - r2, 0.0, 1.0)
        # Facing term: bright toward the light (up-left), dark away from it.
        facing = (-dx - dy) / (rad[k] + 1e-9)
        dimples = np.maximum(dimples, inside)
        light += inside * facing
    light = light / (np.abs(light).max() + 1e-6)
    grain = rng.normal(0.0, 1.0, (n, 1)); grain /= np.abs(grain).max() + 1e-6
    drift = _smooth_noise(rng, 4, 4)
    shade = 1.0 + 0.22 * light - 0.05 * dimples + 0.03 * grain + 0.05 * drift
    shade *= _panel_seams(u, v, wedges, rings, 0.0045, 0.5)
    shade *= _rivet_shadows(u, v, rivet_count, rivet_rows, 0.010)
    base = np.array([0.80, 0.82, 0.85])
    return _to_image(name, base[None, None, :] * shade[:, :, None])


def oxidised_iron(name, *, wedges, rings, rivet_count, rivet_rows, seed):
    """Weathered cast iron with a green-black patina: pitted surface, rust
    blooms in low-frequency patches, rust streaks running DOWN the hull from
    each rivet row, heavy dark weld seams between coarse plates."""
    n, u, v = _uv_grid()
    rng = np.random.default_rng(seed)
    pits = (rng.random((n, n)) < 0.035).astype(float)
    pits = np.maximum(pits, np.roll(pits, 1, axis=1) * 0.6)    # slightly elongated
    bloom = _smooth_noise(rng, 7, 7)
    rust = np.clip((bloom - 0.25) / 0.5, 0.0, 1.0)             # patches where noise is high
    # Streaks: per-column intensity below each rivet row, decaying with distance.
    col = np.clip(_smooth_noise(rng, 1, 90), 0.0, 1.0)
    streak = np.zeros((n, n))
    for rv in rivet_rows:
        below = np.clip((v - rv) / 0.12, 0.0, None)
        streak = np.maximum(streak, col * np.exp(-below * 4.0) * (v >= rv))
    grain = rng.normal(0.0, 1.0, (n, 1)); grain /= np.abs(grain).max() + 1e-6
    drift = _smooth_noise(rng, 5, 5)
    shade = 1.0 + 0.05 * grain + 0.10 * drift - 0.45 * pits
    shade *= _panel_seams(u, v, wedges, rings, 0.006, 0.7)
    shade *= _rivet_shadows(u, v, rivet_count, rivet_rows, 0.012)
    base = np.array([0.24, 0.29, 0.25])
    rust_col = np.array([0.46, 0.25, 0.12])
    mix = np.clip(rust * 0.7 + streak * 0.9, 0.0, 1.0)[:, :, None]
    rgb = (base[None, None, :] * (1.0 - mix) + rust_col[None, None, :] * mix) * shade[:, :, None]
    return _to_image(name, rgb)


def textured_material(name, image, *, metallic=HULL_METALNESS, roughness):
    mat = bpy.data.materials.new(name)
    nodes = mat.node_tree.nodes
    bsdf = nodes['Principled BSDF']
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image
    mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


def finish_mesh(obj, mat):
    """Smooth shading with sharp creases, one material, origin left at world 0."""
    mesh = obj.data
    for poly in mesh.polygons:
        poly.use_smooth = True
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.normal_update()
    limit = math.radians(SHARP_ANGLE_DEG)
    for edge in bm.edges:
        if len(edge.link_faces) == 2:
            angle = edge.calc_face_angle(0.0)
            edge.smooth = angle <= limit
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mat)
    bpy.context.collection.objects.link(obj)
    return obj


def lathe(name, profile, mat, segments=LATHE_SEGMENTS, close_top=True,
          close_bottom=True):
    """Revolve a list of (radius, z) pairs about Z. Profile runs bottom → top.

    A radius of exactly 0 at either end closes that end with a fan; otherwise
    the end is left as a rim ring (or capped flat when close_* is set).
    """
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new('uv')
    # v = normalised arc length along the profile, so seams in the texture
    # land at even intervals up the hull regardless of the profile's shape.
    arc = [0.0]
    for (r0, z0), (r1, z1) in zip(profile, profile[1:]):
        arc.append(arc[-1] + math.hypot(r1 - r0, z1 - z0))
    total = arc[-1] or 1.0
    rings = []
    where = {}  # vert -> (i, k) for UVs
    for k, (r, z) in enumerate(profile):
        if r <= 0.0:
            pole = bm.verts.new((0.0, 0.0, z))
            where[pole] = (None, k)
            rings.append([pole] * segments)
            continue
        ring = []
        for i in range(segments):
            a = 2.0 * math.pi * i / segments
            vert = bm.verts.new((r * math.cos(a), r * math.sin(a), z))
            where[vert] = (i, k)
            ring.append(vert)
        rings.append(ring)

    def set_uvs(face, i_wrap):
        # A loop on the seam column (i == 0 reached from i == segments-1) takes
        # u = 1 so the texture does not smear backwards across one quad.
        for loop in face.loops:
            i, k = where[loop.vert]
            if i is None:
                u = (i_wrap + 0.5) / segments
            else:
                u = i / segments
                if i == 0 and i_wrap == segments - 1:
                    u = 1.0
            loop[uv_layer].uv = (u, arc[k] / total)

    for k in range(len(rings) - 1):
        lo, hi = rings[k], rings[k + 1]
        for i in range(segments):
            j = (i + 1) % segments
            quad = [lo[i], lo[j], hi[j], hi[i]]
            # Collapse a fan where one ring is the pole vertex.
            uniq = []
            for v in quad:
                if v not in uniq:
                    uniq.append(v)
            if len(uniq) >= 3:
                set_uvs(bm.faces.new(uniq), i)
    if close_bottom and profile[0][0] > 0.0:
        f = bm.faces.new(list(reversed(rings[0])))
        for loop in f.loops:
            loop[uv_layer].uv = (where[loop.vert][0] / segments, 0.0)
    if close_top and profile[-1][0] > 0.0:
        f = bm.faces.new(rings[-1])
        for loop in f.loops:
            loop[uv_layer].uv = (where[loop.vert][0] / segments, 1.0)
    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return finish_mesh(bpy.data.objects.new(name, mesh), mat)


def profile_point(profile, t):
    """(r, z) at normalised arc length t along the profile, matching the v the
    lathe writes into UVs — so a rivet row lands where the texture expects."""
    arc = [0.0]
    for (r0, z0), (r1, z1) in zip(profile, profile[1:]):
        arc.append(arc[-1] + math.hypot(r1 - r0, z1 - z0))
    target = t * arc[-1]
    for k in range(len(arc) - 1):
        if arc[k + 1] >= target:
            f = (target - arc[k]) / ((arc[k + 1] - arc[k]) or 1.0)
            (r0, z0), (r1, z1) = profile[k], profile[k + 1]
            return (r0 + (r1 - r0) * f, z0 + (z1 - z0) * f)
    return profile[-1]


def rivet_rows(name, profile, rows, count, mat):
    """Rows of rivet heads sitting ON the hull: small spheres sunk a little
    below the surface, merged into one mesh named `name`."""
    bm = bmesh.new()
    for t in rows:
        r, z = profile_point(profile, t)
        for i in range(count):
            a = 2.0 * math.pi * i / count
            centre = Vector(((r - RIVET_SINK_CELLS) * math.cos(a),
                             (r - RIVET_SINK_CELLS) * math.sin(a), z))
            geom = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6,
                                             radius=RIVET_RADIUS_CELLS)
            for vtx in geom['verts']:
                vtx.co = vtx.co + centre
    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return finish_mesh(bpy.data.objects.new(name, mesh), mat)


def torus(name, major, minor, z, mat, major_segments=LATHE_SEGMENTS,
          minor_segments=16, squash=1.0):
    """A ring of tube radius `minor` at radius `major`, height z. `squash`
    flattens the tube vertically (a light strip rather than a pipe)."""
    profile = []
    for i in range(minor_segments):
        a = 2.0 * math.pi * i / minor_segments
        profile.append((major + minor * math.cos(a), z + minor * math.sin(a) * squash))
    profile.append(profile[0])
    return lathe(name, profile, mat, segments=major_segments,
                 close_top=False, close_bottom=False)


def stud_ring(name, count, radius, z, stud_radius, mat, elongate=1.0):
    """`count` small spheres around the axis, merged into ONE mesh so they
    share one material and one flash."""
    bm = bmesh.new()
    for i in range(count):
        a = 2.0 * math.pi * i / count
        centre = Vector((radius * math.cos(a), radius * math.sin(a), z))
        geom = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8,
                                         radius=stud_radius)
        for v in geom['verts']:
            v.co.x *= elongate
            v.co = v.co + centre
    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return finish_mesh(bpy.data.objects.new(name, mesh), mat)


def vane_ring(name, count, inner, outer, z, thickness, height, mat):
    """`count` radial fins between two radii, merged with a thin tube so the
    whole thing is one spinning part."""
    bm = bmesh.new()
    for i in range(count):
        a = 2.0 * math.pi * i / count
        geom = bmesh.ops.create_cube(bm, size=1.0)
        for v in geom['verts']:
            v.co = Vector(((inner + outer) / 2 + v.co.x * (outer - inner),
                           v.co.y * thickness,
                           z + v.co.z * height))
            rot = Vector((v.co.x * math.cos(a) - v.co.y * math.sin(a),
                          v.co.x * math.sin(a) + v.co.y * math.cos(a),
                          v.co.z))
            v.co = rot
    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    fins = finish_mesh(bpy.data.objects.new(name + '_fins', mesh), mat)
    tube = torus(name, (inner + outer) / 2, thickness * 0.9, z, mat,
                 minor_segments=8)
    # Join fins into the tube so the result is ONE object named `name`.
    bpy.ops.object.select_all(action='DESELECT')
    fins.select_set(True)
    tube.select_set(True)
    bpy.context.view_layer.objects.active = tube
    bpy.ops.object.join()
    return tube


def empty(name, z):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = 'PLAIN_AXES'
    obj.empty_display_size = 0.2
    obj.location = (0.0, 0.0, z)
    bpy.context.collection.objects.link(obj)
    return obj


def spin(obj, direction=1):
    obj.rotation_mode = 'XYZ'
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.keyframe_insert(data_path='rotation_euler', index=2, frame=1)
    obj.rotation_euler = (0.0, 0.0, direction * 2.0 * math.pi)
    obj.keyframe_insert(data_path='rotation_euler', index=2, frame=SPIN_FRAMES + 1)
    obj.animation_data.action.name = 'spin'


def export(out_path):
    for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_force_sampling=True,
        export_image_format='AUTO',
    )
    tris = sum(len(m.data.polygons) for m in bpy.data.objects if m.type == 'MESH')
    print(f'exported {out_path} ({tris} polygons)')


# ---------------------------------------------------------------- variants

R = OUTER_DIAMETER_CELLS / 2.0


def build_a():
    """A — the classic: wide lenticular disc, brushed gunmetal, a neon-blue
    rim ring and a second seam ring under a low deck; twelve portholes."""
    clear_scene()
    A_RINGS = (0.20, 0.40, 0.60, 0.78)
    A_RIVET_ROWS = (0.22, 0.38, 0.62, 0.76)
    A_RIVETS = 48
    hull_img = brushed_gunmetal('hull_a_tex', wedges=16, rings=A_RINGS,
                                rivet_count=A_RIVETS, rivet_rows=A_RIVET_ROWS, seed=11)
    hull_mat = textured_material('hull_a', hull_img, roughness=0.45)
    rivet_mat = material('rivets_a', (0.55, 0.57, 0.62), metallic=HULL_METALNESS, roughness=0.4)
    dome_mat = material('dome_a', (0.05, 0.08, 0.12), metallic=0.2, roughness=0.12)
    ring_mat = material('ring_a', (0.10, 0.35, 1.0), emission=(0.25, 0.55, 1.0),
                        emission_strength=GLOW_STRENGTH)
    light_mat = material('lights_a', (0.8, 0.95, 1.0), emission=(0.7, 0.9, 1.0),
                         emission_strength=LIGHT_STRENGTH)
    hull_profile = [
        (0.00, 0.26), (0.45, 0.16), (0.95, 0.08), (1.45, 0.05), (1.82, 0.06),
        (1.98, 0.11), (R, 0.17), (1.97, 0.23), (1.86, 0.29), (1.60, 0.38),
        (1.30, 0.47), (1.10, 0.55), (1.02, 0.64), (1.00, 0.70), (0.86, 0.72),
        (0.70, 0.775), (0.58, 0.815), (0.54, 0.83),
    ]
    hull = lathe('hull', hull_profile, hull_mat, close_top=False)
    rivet_rows('rivets', hull_profile, A_RIVET_ROWS, A_RIVETS, rivet_mat)
    ring = torus('ring', 1.99, 0.045, 0.17, ring_mat, squash=1.4)
    # The deck seam is the same glowing material joined into the ring mesh,
    # so both bands spin as one part.
    seam = torus('ring_seam', 1.01, 0.03, 0.67, ring_mat, squash=1.2)
    bpy.ops.object.select_all(action='DESELECT')
    seam.select_set(True)
    ring.select_set(True)
    bpy.context.view_layer.objects.active = ring
    bpy.ops.object.join()
    # Cockpit: the lens CONTINUES the hull's curve — its rim starts on the
    # hull's last ring with the same slope, then eases over to the crown, so
    # the only break is the material change. The hull is left open under it.
    dome = lathe('dome', [(0.54, 0.83), (0.46, 0.858), (0.36, 0.88),
                          (0.24, 0.90), (0.12, 0.912), (0.0, 0.916)], dome_mat)
    stud_ring('lights', 12, 1.22, 0.50, 0.045, light_mat, elongate=1.6)
    empty('muzzle', 0.05)
    empty('top', 0.916)
    spin(ring, +1)


def build_b():
    """B — the bell: deeper plated silver hull stepping up to a dark deck
    turret with a flush lens, an amber band plus shoulder lamps, and a
    glowing underside ring that spins."""
    clear_scene()
    B_RINGS = (0.24, 0.44, 0.62, 0.80)
    B_RIVET_ROWS = (0.26, 0.42, 0.64, 0.78)
    B_RIVETS = 40
    hull_img = hammered_aluminium('hull_b_tex', wedges=12, rings=B_RINGS,
                                  rivet_count=B_RIVETS, rivet_rows=B_RIVET_ROWS, seed=23)
    hull_mat = textured_material('hull_b', hull_img, roughness=0.38)
    rivet_mat = material('rivets_b', (0.62, 0.64, 0.68), metallic=HULL_METALNESS, roughness=0.35)
    dome_mat = material('dome_b', (0.08, 0.10, 0.13), metallic=0.2, roughness=0.10)
    ring_mat = material('ring_b', (1.0, 0.45, 0.1), emission=(1.0, 0.5, 0.15),
                        emission_strength=GLOW_STRENGTH)
    light_mat = material('lights_b', (1.0, 0.75, 0.35), emission=(1.0, 0.7, 0.3),
                         emission_strength=LIGHT_STRENGTH)
    deck_mat = material('deck_b', (0.13, 0.14, 0.17), metallic=HULL_METALNESS, roughness=0.5)
    # Hull: panel grooves in the underside and a stepped upper body, so the
    # silver reads as plating rather than one smooth shell.
    hull_profile = [
        (0.00, 0.06), (0.30, 0.06), (0.62, 0.02), (0.90, 0.02), (1.05, 0.08),
        (1.20, 0.11), (1.22, 0.09), (1.26, 0.09), (1.28, 0.12),
        (1.55, 0.18), (1.57, 0.16), (1.61, 0.16), (1.63, 0.19),
        (1.85, 0.25), (1.97, 0.32), (R, 0.40), (1.95, 0.49), (1.80, 0.56),
        (1.58, 0.62), (1.48, 0.62), (1.44, 0.66), (1.30, 0.72), (1.14, 0.80),
        (1.10, 0.84), (1.10, 0.88), (0.98, 0.96), (0.90, 1.00),
    ]
    hull = lathe('hull', hull_profile, hull_mat)
    rivet_rows('rivets', hull_profile, B_RIVET_ROWS, B_RIVETS, rivet_mat)
    # A dark deck band caps the silver: a low turret with the cockpit lens on it.
    deck = lathe('deck', [(0.0, 0.99), (0.84, 0.99), (0.88, 1.02), (0.88, 1.12),
                          (0.80, 1.16), (0.62, 1.19), (0.0, 1.20)], deck_mat)
    ring = torus('ring', 0.76, 0.05, 0.03, ring_mat, minor_segments=12, squash=0.6)
    dome = lathe('dome', [(0.0, 1.19), (0.44, 1.19), (0.50, 1.21), (0.46, 1.245),
                          (0.30, 1.265), (0.0, 1.27)], dome_mat)
    # Two lamp rings in one mesh: the amber band on the flank and a sparser
    # ring of running lights on the turret's shoulder.
    lights = stud_ring('lights', 24, 1.73, 0.46, 0.05, light_mat, elongate=1.2)
    shoulder = stud_ring('lights_shoulder', 8, 0.89, 1.07, 0.035, light_mat)
    bpy.ops.object.select_all(action='DESELECT')
    shoulder.select_set(True)
    lights.select_set(True)
    bpy.context.view_layer.objects.active = lights
    bpy.ops.object.join()
    empty('muzzle', 0.02)
    empty('top', 1.27)
    spin(ring, -1)


def build_c():
    """C — the stinger: flat dark-green hull with a hard rim crease, a faceted
    magenta vane ring that spins, a low elongated dome and eight red lights."""
    clear_scene()
    C_RINGS = (0.30, 0.55, 0.78)
    C_RIVET_ROWS = (0.33, 0.52, 0.81)
    C_RIVETS = 28
    hull_img = oxidised_iron('hull_c_tex', wedges=8, rings=C_RINGS,
                             rivet_count=C_RIVETS, rivet_rows=C_RIVET_ROWS, seed=37)
    hull_mat = textured_material('hull_c', hull_img, roughness=0.62)
    rivet_mat = material('rivets_c', (0.30, 0.33, 0.30), metallic=HULL_METALNESS, roughness=0.6)
    dome_mat = material('dome_c', (0.10, 0.04, 0.10), metallic=0.2, roughness=0.15)
    ring_mat = material('ring_c', (0.9, 0.1, 0.8), emission=(1.0, 0.2, 0.9),
                        emission_strength=GLOW_STRENGTH)
    light_mat = material('lights_c', (1.0, 0.2, 0.15), emission=(1.0, 0.15, 0.1),
                         emission_strength=LIGHT_STRENGTH)
    hull_profile = [
        (0.00, 0.16), (0.55, 0.08), (1.20, 0.03), (1.75, 0.03), (R, 0.10),
        (R, 0.24), (1.72, 0.30), (1.38, 0.30), (1.24, 0.40), (1.02, 0.46),
        (0.82, 0.50), (0.66, 0.575), (0.54, 0.62), (0.50, 0.635),
    ]
    hull = lathe('hull', hull_profile, hull_mat, close_top=False)
    rivet_rows('rivets', hull_profile, C_RIVET_ROWS, C_RIVETS, rivet_mat)
    ring = vane_ring('ring', 10, 1.30, 1.66, 0.355, 0.05, 0.09, ring_mat)
    # Lens continues the hull slope, as on A.
    dome = lathe('dome', [(0.50, 0.635), (0.42, 0.665), (0.32, 0.69),
                          (0.20, 0.708), (0.10, 0.718), (0.0, 0.72)], dome_mat)
    stud_ring('lights', 8, 1.92, 0.17, 0.05, light_mat, elongate=1.0)
    empty('muzzle', 0.04)
    empty('top', 0.72)
    spin(ring, +1)


def main():
    out_dir = sys.argv[sys.argv.index('--') + 1]
    for suffix, build in (('a', build_a), ('b', build_b), ('c', build_c)):
        build()
        export(f'{out_dir}\\saucer-{suffix}.glb')


main()
