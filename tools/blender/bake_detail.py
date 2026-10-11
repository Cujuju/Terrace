# bake_detail.py — bake procedural surface detail into a model's shared UV atlas.
#
# Input: a .glb whose meshes carry the one shared atlas (tools/blender/uv_atlas.py).
# Output: three 1024 px PNGs a model's lit materials all sample —
#   <name>-detail.png       sRGB, multiplies each material's baseColorFactor
#   <name>-normal.png       linear, tangent space, OpenGL (+Y), glTF's convention
#   <name>-roughness.png    linear glTF metallicRoughness: G multiplies
#                           roughnessFactor, B = 0 (every material is dielectric)
#
# WHY A MULTIPLIER, NOT THE COLOUR. The palette stays in each material's factor,
# so parts that differ only in colour keep merging into one draw (rigSkin.ts
# folds colour into vertex colours) and nothing in a plugin that tints a factor
# changes meaning. The maps only add detail around 1.0.
#
# Run headless (paths INSIDE are Windows paths):
#   blender.exe --background --factory-startup --python tools/blender/bake_detail.py -- \
#     <model>.glb <out-dir> <profile>

import json
import math
import os
import struct
import sys

import bpy
import numpy as np

TEXELS = 1024

# Matches uv_atlas.ISLAND_MARGIN_TEXELS: dilate each island across its gutter.
BAKE_MARGIN_TEXELS = 16

# Samples per texel. Procedural detail finer than a texel aliases at 1 sample;
# 16 averages it out, and more changes nothing visible at this resolution.
BAKE_SAMPLES = 16
BAKE_SEED = 0

# Darkest a detail map may multiply a factor by. The palette is authored in the
# factors; detail deeper than this reads as a different colour, not texture.
DETAIL_ALBEDO_FLOOR = 0.62

# Countershading: the top of the body is this much darker than the belly.
COUNTERSHADE_DEPTH = 0.18

# Relief height as a fraction of one feature's spacing (a scale, a wrinkle).
# Above ~0.2 the baked normals read as geometry the silhouette does not have.
RELIEF_FRACTION = 0.15

# Wet eyes: roughness multiplier on the material's 0.5 factor.
EYE_ROUGHNESS = 0.35

# Feature counts along the model's longest extent.
SCALES_PER_LENGTH = 48
# Rim of a scale, in Voronoi cell units (a cell is ~1 wide): a thin dark outline.
SCALE_RIM_WIDTH = 0.12
FIN_RAYS_PER_LENGTH = 90
WRINKLES_PER_LENGTH = 140
MOTTLE_PER_LENGTH = 5
# Broad blotching: subtle, or it reads as dirt rather than pigment.
MOTTLE_FLOOR = 0.94
BARNACLES_PER_LENGTH = 28
# Fraction of the skin a barnacle patch covers; the noise threshold that yields it.
BARNACLE_THRESHOLD = 0.72

# Material-name suffix -> surface kind, per profile. The suffix is the part of a
# material's name after the model prefix ("fish_fin" -> "fin").
PROFILES = {
    'fish': {'body': 'scales', 'fin': 'fin', 'eye': 'eye', 'line': 'plain'},
    'angelfish': {'body': 'scales', 'fin': 'fin', 'eye': 'eye', 'bar': 'plain'},
    'shark': {'body': 'skin', 'fin': 'skin', 'eye': 'eye', 'line': 'plain'},
    'ray': {'body': 'skin', 'eye': 'eye', 'line': 'plain'},
    'eel': {'body': 'skin', 'belly': 'skin', 'fin': 'fin', 'eye': 'eye'},
    'humpback': {'hull': 'barnacled', 'body': 'barnacled', 'ventral': 'skin', 'eye': 'eye'},
    'blue_whale': {'hull': 'skin', 'body': 'skin', 'ventral': 'skin', 'eye': 'eye'},
    'sperm_whale': {'body': 'wrinkled', 'jaw': 'skin', 'eye': 'eye'},
    'deepsea': {'body': 'skin', 'detail': 'plain'},
}


def parse_args():
    args = sys.argv[sys.argv.index('--') + 1:]
    if len(args) != 3 or args[2] not in PROFILES:
        raise SystemExit(f'usage: -- <model.glb> <out-dir> <{"|".join(PROFILES)}>')
    return args


def unlit_material_names(path):
    """Names of KHR_materials_unlit materials, read from the file itself."""
    with open(path, 'rb') as f:
        head = f.read(20)
        length = struct.unpack_from('<I', head, 12)[0]
        doc = json.loads(f.read(length))
    return {m['name'] for m in doc.get('materials', [])
            if 'KHR_materials_unlit' in m.get('extensions', {})}


def model_bounds(objects):
    corners = np.array([obj.matrix_world @ v.co for obj in objects for v in obj.data.vertices])
    return corners.min(axis=0), corners.max(axis=0)


class Graph:
    """Thin node-building helper over one material's tree."""

    def __init__(self, material):
        if material.node_tree is None:
            material.use_nodes = True
        self.tree = material.node_tree
        self.tree.nodes.clear()

    def node(self, kind, **settings):
        n = self.tree.nodes.new(kind)
        for key, value in settings.items():
            setattr(n, key, value)
        return n

    def link(self, out, into):
        self.tree.links.new(out, into)

    def math(self, op, a, b=None):
        n = self.node('ShaderNodeMath', operation=op)
        for socket, value in zip(n.inputs, (a, b)):
            if value is None:
                continue
            if isinstance(value, (int, float)):
                socket.default_value = value
            else:
                self.link(value, socket)
        return n.outputs[0]

    def remap(self, value, lo, hi, out_lo, out_hi):
        n = self.node('ShaderNodeMapRange', clamp=True)
        self.link(value, n.inputs['Value'])
        n.inputs['From Min'].default_value = lo
        n.inputs['From Max'].default_value = hi
        n.inputs['To Min'].default_value = out_lo
        n.inputs['To Max'].default_value = out_hi
        return n.outputs['Result']

    def noise(self, vector, scale, detail=4.0, roughness=0.5):
        n = self.node('ShaderNodeTexNoise')
        self.link(vector, n.inputs['Vector'])
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = roughness
        return n.outputs['Fac']


def surface(g, kind, pos, up):
    """(albedo multiplier, roughness multiplier, relief height, feature spacing)."""
    mottle = g.remap(g.noise(pos, MOTTLE_PER_LENGTH, detail=2.0), 0.3, 0.7, MOTTLE_FLOOR, 1.0)
    shade = g.math('MULTIPLY', mottle, g.remap(up, 0.45, 1.0, 1.0, 1.0 - COUNTERSHADE_DEPTH))

    if kind == 'eye':
        return 1.0, EYE_ROUGHNESS, None, 1.0
    if kind == 'plain':
        return mottle, 1.0, None, 1.0
    if kind == 'scales':
        v = g.node('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE')
        g.link(pos, v.inputs['Vector'])
        v.inputs['Scale'].default_value = SCALES_PER_LENGTH
        # 0 on a scale's rim, 1 once SCALE_RIM_WIDTH inside it: a domed plate.
        plate = g.remap(v.outputs['Distance'], 0.0, SCALE_RIM_WIDTH, 0.0, 1.0)
        albedo = g.math('MULTIPLY', shade, g.remap(plate, 0.0, 1.0, DETAIL_ALBEDO_FLOOR, 1.0))
        rough = g.remap(plate, 0.0, 1.0, 1.0, 0.8)
        return albedo, rough, plate, 1.0 / SCALES_PER_LENGTH
    if kind == 'fin':
        w = g.node('ShaderNodeTexWave', wave_type='BANDS', bands_direction='X')
        g.link(pos, w.inputs['Vector'])
        w.inputs['Scale'].default_value = FIN_RAYS_PER_LENGTH
        w.inputs['Distortion'].default_value = 1.5
        rays = w.outputs['Fac']
        albedo = g.math('MULTIPLY', mottle, g.remap(rays, 0.0, 1.0, DETAIL_ALBEDO_FLOOR + 0.08, 1.0))
        return albedo, 1.0, rays, 1.0 / FIN_RAYS_PER_LENGTH
    if kind in ('skin', 'wrinkled', 'barnacled'):
        count = WRINKLES_PER_LENGTH * (0.6 if kind == 'wrinkled' else 1.0)
        fine = g.noise(pos, count, detail=6.0, roughness=0.6)
        if kind == 'wrinkled':
            w = g.node('ShaderNodeTexWave', wave_type='BANDS', bands_direction='X')
            g.link(pos, w.inputs['Vector'])
            w.inputs['Scale'].default_value = count / 3.0
            w.inputs['Distortion'].default_value = 6.0
            fine = g.math('MULTIPLY', fine, w.outputs['Fac'])
        albedo = g.math('MULTIPLY', shade, g.remap(fine, 0.3, 0.7, DETAIL_ALBEDO_FLOOR + 0.12, 1.0))
        rough = g.remap(fine, 0.3, 0.7, 0.9, 1.0)
        height = fine
        if kind == 'barnacled':
            spots = g.remap(g.noise(pos, BARNACLES_PER_LENGTH, detail=3.0), BARNACLE_THRESHOLD, BARNACLE_THRESHOLD + 0.04, 0.0, 1.0)
            albedo = g.math('MAXIMUM', albedo, g.math('MULTIPLY', spots, 1.0))
            height = g.math('MAXIMUM', fine, spots)
        return albedo, rough, height, 1.0 / count
    raise ValueError(f'unknown surface kind {kind}')


def bake_material(kind, lo, hi, image_node_name='bake_target'):
    material = bpy.data.materials.new(f'bake_{kind}')
    g = Graph(material)
    length = float(max(hi - lo))
    geo = g.node('ShaderNodeNewGeometry')
    pos_node = g.node('ShaderNodeVectorMath', operation='SCALE')
    g.link(geo.outputs['Position'], pos_node.inputs[0])
    pos_node.inputs['Scale'].default_value = 1.0 / length
    pos = pos_node.outputs['Vector']
    sep = g.node('ShaderNodeSeparateXYZ')
    g.link(geo.outputs['Position'], sep.inputs[0])
    up = g.remap(sep.outputs['Z'], float(lo[2]), float(hi[2]), 0.0, 1.0)

    albedo, rough, height, spacing = surface(g, kind, pos, up)

    bsdf = g.node('ShaderNodeBsdfPrincipled')
    out = g.node('ShaderNodeOutputMaterial')
    g.link(bsdf.outputs['BSDF'], out.inputs['Surface'])
    for value, socket in ((albedo, 'Base Color'), (rough, 'Roughness')):
        target = bsdf.inputs[socket]
        if isinstance(value, (int, float)):
            target.default_value = (value, value, value, 1.0) if socket == 'Base Color' else value
        elif socket == 'Base Color':
            rgb = g.node('ShaderNodeCombineColor')
            for i in range(3):
                g.link(value, rgb.inputs[i])
            g.link(rgb.outputs['Color'], target)
        else:
            g.link(value, target)
    # Relief is baked as world-unit height through emission; normals come from its
    # gradient (see normals_from_height). Blender's Bump node smears at chart edges.
    bsdf.inputs['Emission Strength'].default_value = 1.0
    if height is not None:
        amplitude = g.math('MULTIPLY', height, spacing * length * RELIEF_FRACTION)
        grey = g.node('ShaderNodeCombineColor')
        for i in range(3):
            g.link(amplitude, grey.inputs[i])
        g.link(grey.outputs['Color'], bsdf.inputs['Emission Color'])
    else:
        bsdf.inputs['Emission Color'].default_value = (0.0, 0.0, 0.0, 1.0)

    tex = g.node('ShaderNodeTexImage', name=image_node_name)
    g.tree.nodes.active = tex
    return material, tex


def new_image(name, colour_space, fill):
    image = bpy.data.images.new(name, TEXELS, TEXELS, alpha=False)
    image.colorspace_settings.name = colour_space
    image.generated_color = fill
    return image


def save(image, path):
    image.filepath_raw = path
    image.file_format = 'PNG'
    image.save()
    print(f'wrote {path}')


def texel_world_size(objects):
    """World length one atlas texel spans. uv_atlas packs at one density, so it is
    the ratio of total surface area to total UV area."""
    surface, uv_area = 0.0, 0.0
    for obj in objects:
        mesh = obj.data
        uv = mesh.uv_layers.active.data
        for poly in mesh.polygons:
            surface += poly.area
            corners = [uv[i].uv for i in poly.loop_indices]
            for a, b in zip(corners[1:-1], corners[2:]):
                o = corners[0]
                uv_area += abs((a.x - o.x) * (b.y - o.y) - (b.x - o.x) * (a.y - o.y)) / 2.0
    return math.sqrt(surface / uv_area) / TEXELS


def normals_from_height(h, texel_size):
    """Tangent-space OpenGL normals of a height field laid out in UV space.

    MikkTSpace aligns the tangent with +U and the bitangent with +V, so the
    height's texel gradient IS the tangent-frame slope. Blender's pixel rows run
    bottom-up, i.e. along +V, which is glTF's +Y (green) convention.
    """
    dv, du = np.gradient(h, texel_size)
    n = np.stack([-du, -dv, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    rgba = np.empty(h.shape + (4,), dtype=np.float32)
    rgba[..., :3] = n * 0.5 + 0.5
    rgba[..., 3] = 1.0
    return rgba


def main():
    src, out_dir, profile_name = parse_args()
    profile = PROFILES[profile_name]
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(src))[0]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    lo, hi = model_bounds(meshes)
    unlit = unlit_material_names(src)

    targets, kinds = [], {}
    for obj in meshes:
        source = obj.material_slots[0].material
        if source.name in unlit:
            print(f'  {obj.name}: {source.name} is unlit — left untextured')
            continue
        suffix = source.name.split('_')[-1]
        if suffix not in profile:
            raise SystemExit(f'{obj.name}: material {source.name} has no surface in profile {profile_name}')
        kind = profile[suffix]
        if kind not in kinds:
            kinds[kind] = bake_material(kind, lo, hi)
        obj.material_slots[0].material = kinds[kind][0]
        targets.append(obj)
        print(f'  {obj.name}: {source.name} -> {kind}')

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = BAKE_SAMPLES
    scene.cycles.seed = BAKE_SEED
    bake = scene.render.bake
    bake.margin = BAKE_MARGIN_TEXELS
    bake.margin_type = 'EXTEND'
    bake.use_clear = True

    bpy.ops.object.select_all(action='DESELECT')
    for obj in targets:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]

    def run(image, **settings):
        for _, tex in kinds.values():
            tex.image = image
        bpy.ops.object.bake(**settings)

    albedo = new_image(f'{stem}-detail', 'sRGB', (1.0, 1.0, 1.0, 1.0))
    run(albedo, type='DIFFUSE', pass_filter={'COLOR'})
    save(albedo, os.path.join(out_dir, f'{stem}-detail.png'))

    height = bpy.data.images.new(f'{stem}-height', TEXELS, TEXELS, alpha=False, float_buffer=True)
    height.colorspace_settings.name = 'Non-Color'
    run(height, type='EMIT')
    h = np.array(height.pixels[:], dtype=np.float64).reshape(TEXELS, TEXELS, 4)[..., 0]
    normal = new_image(f'{stem}-normal', 'Non-Color', (0.5, 0.5, 1.0, 1.0))
    normal.pixels.foreach_set(normals_from_height(h, texel_world_size(targets)).ravel())
    save(normal, os.path.join(out_dir, f'{stem}-normal.png'))

    rough = new_image(f'{stem}-rough-raw', 'Non-Color', (1.0, 1.0, 1.0, 1.0))
    run(rough, type='ROUGHNESS')
    px = np.array(rough.pixels[:], dtype=np.float32).reshape(TEXELS, TEXELS, 4)
    packed = np.empty_like(px)
    packed[..., 0] = 1.0
    packed[..., 1] = px[..., 0]
    packed[..., 2] = 0.0
    packed[..., 3] = 1.0
    mr = new_image(f'{stem}-roughness', 'Non-Color', (1.0, 1.0, 0.0, 1.0))
    mr.pixels.foreach_set(packed.ravel())
    save(mr, os.path.join(out_dir, f'{stem}-roughness.png'))


main()
