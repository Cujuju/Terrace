# import_model.py — turn an arbitrary downloaded model into a Terrace asset.
#
# WHY THIS EXISTS. The runtime loader (client/src/render/rigAsset.ts) enforces a
# convention — one material per mesh, uv wherever a texture is sampled, pivots
# as Empties, a footprint measured in cells, forward +X, Y up — and a model
# downloaded from Poly Haven or Quaternius matches none of it. Fixing that by
# hand in Blender is not repeatable and leaves no record of what was done. This
# script IS the record: every normalisation the convention needs, as a flag.
#
# It never invents art. It rotates, scales, recentres, splits and re-parents
# what the source already contains, then exports through the one export recipe
# in export_glb.py.
#
# Usage (paths INSIDE are Windows paths — the Blender binary is a Windows one):
#   "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
#     --background --python tools/blender/import_model.py -- \
#     E:\in\Wolf.glb E:\out\wolf.glb \
#     --forward -Y --footprint 0.8 0.8 --origin ground --rigidify \
#     --drop Icosphere \
#     --rename Wolf=wolf_body --anchor mouth=0.35,0.25,0 --max-texture 512
#
# Sources: .glb, .gltf, .fbx, .obj, .blend.

import os
import sys

import bpy
from mathutils import Matrix, Vector

# Import the project's one export recipe rather than restating it. Blender runs
# this file as a script, so its directory is not on the path by default.
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from export_glb import bake_object_transforms, export_scene_glb  # noqa: E402
from stat_glb import print_stats, world_corners  # noqa: E402

# The object types an asset may contain. Everything else in a downloaded file
# (cameras, lights, curves, lattices, the author's rendering scaffolding) is
# scenery for the screenshot on the download page, not part of the model.
KEEPABLE_TYPES = {'MESH', 'EMPTY', 'ARMATURE'}

# The axis names accepted for --forward/--up, as unit vectors in BLENDER's
# frame (Z-up), which is the frame the source sits in after import.
AXES = {
    '+X': Vector((1, 0, 0)), '-X': Vector((-1, 0, 0)),
    '+Y': Vector((0, 1, 0)), '-Y': Vector((0, -1, 0)),
    '+Z': Vector((0, 0, 1)), '-Z': Vector((0, 0, -1)),
}

# The convention's own axes, in Blender's frame: a model faces +X, and +Z here
# becomes +Y in the exported (Y-up) file. See docs/model-assets.md.
CONVENTION_FORWARD = '+X'
CONVENTION_UP = '+Z'

# How big a joint Empty draws in Blender. Purely cosmetic (Empties have no
# geometry), sized so a 1-cell creature's pivots stay legible in the viewport.
JOINT_DISPLAY_SIZE = 0.05

# Vertices weighing less than this on every bone are treated as unweighted and
# fall back to the armature's first root bone. Not zero, because exporters
# routinely leave dust weights (1e-7) on vertices the artist never painted.
MIN_MEANINGFUL_WEIGHT = 1e-4


# ----------------------------------------------------------------- importing


def clear_scene():
    """Start from an empty file: Blender's startup scene ships a cube."""
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials,
                 bpy.data.images, bpy.data.armatures):
        for item in list(coll):
            coll.remove(item)


def import_source(path):
    """Load one source file, dispatching on its extension.

    Every importer is left at its defaults: guessing an axis convention per
    format would hide the guess, and --forward/--up make it explicit instead.
    """
    extension = os.path.splitext(path)[1].lower()
    if extension in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif extension == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    elif extension == '.obj':
        bpy.ops.wm.obj_import(filepath=path)
    elif extension == '.blend':
        bpy.ops.wm.open_mainfile(filepath=path)
    else:
        raise SystemExit(f'import_model: unsupported source type "{extension}"')


def drop_non_model_objects(named=()):
    """Delete everything that is not mesh, Empty or armature, plus `named`.

    A downloaded scene carries the author's studio: cameras, lights, backdrops.
    Exporting those would ship furniture inside the creature's bounding box.

    `named` is --drop, for the junk that IS a mesh: the pivot ball, the
    collision proxy, the turntable the author modelled around. A stray mesh is
    not just ugly — it sets the bounding box, so the footprint fit would be
    computed for the junk instead of for the model.
    """
    wanted = set(named)
    for obj in list(bpy.data.objects):
        if obj.type not in KEEPABLE_TYPES:
            print(f'  dropped {obj.name} [{obj.type}]')
            bpy.data.objects.remove(obj, do_unlink=True)
        elif obj.name in wanted:
            print(f'  dropped {obj.name} [{obj.type}, named by --drop]')
            wanted.discard(obj.name)
            bpy.data.objects.remove(obj, do_unlink=True)
    if wanted:
        raise SystemExit(f'import_model: --drop named nothing: {sorted(wanted)}')


# ------------------------------------------------------------------ framing


def roots():
    """Top-level objects: transforming these moves the whole model once."""
    return [o for o in bpy.data.objects if o.parent is None]


def transform_model(matrix):
    """Apply one world-space matrix to the model, via its roots only.

    Children follow their parents, so touching a child as well would apply the
    transform to it twice.
    """
    for obj in roots():
        obj.matrix_world = matrix @ obj.matrix_world
    bpy.context.view_layer.update()


def orientation_matrix(forward_name, up_name):
    """Rotate the source's (forward, up) onto the convention's (+X, +Z).

    Rows of a rotation matrix are the axes it sends to +X, +Y, +Z, so the
    matrix whose rows are (forward, up x forward, up) maps forward to +X and up
    to +Z — a right-handed frame, hence no accidental mirroring.
    """
    forward = AXES[forward_name]
    up = AXES[up_name]
    if abs(forward.dot(up)) > 1e-6:
        raise SystemExit(f'import_model: --forward {forward_name} and --up {up_name} '
                         f'are not perpendicular')
    side = up.cross(forward)
    return Matrix((forward, side, up)).to_4x4()


def scale_scene(factor):
    """Uniformly resize the whole model without leaving scale on any object.

    Scaling the ROOT object instead would put a scale factor on every joint
    Empty, and a joint is supposed to carry a position and a rotation only —
    the size belongs in the vertices, which is the same rule export_glb.py's
    transform bake enforces for rotation. Under a uniform scale that is exactly
    two operations: multiply every mesh's vertices, and multiply every object's
    local translation (a parent-space offset scales with its parent).
    """
    scale = Matrix.Scale(factor, 4)
    scaled_meshes = set()
    for obj in bpy.data.objects:
        parent_inverse = obj.matrix_parent_inverse.copy()
        parent_inverse.translation = parent_inverse.translation * factor
        obj.matrix_parent_inverse = parent_inverse
        obj.location = obj.location * factor
        if obj.type == 'MESH' and obj.data.name not in scaled_meshes:
            scaled_meshes.add(obj.data.name)
            obj.data.transform(scale)
    bpy.context.view_layer.update()


def mesh_bounds():
    """The model's world bounding box in BLENDER's frame, as (min, max).

    Measured from each mesh's own axis-aligned box, transformed corner by
    corner — deliberately the SAME conservative measure three.js applies in
    Box3.setFromObject, which is what the runtime fit check uses. An exact
    per-vertex bound would read smaller than the number the game will judge the
    asset by, and the tool must not pass a model the loader would reject.
    """
    lows, highs = None, None
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        for point in world_corners(obj):
            if lows is None:
                lows, highs = point.copy(), point.copy()
                continue
            for axis in range(3):
                lows[axis] = min(lows[axis], point[axis])
                highs[axis] = max(highs[axis], point[axis])
    if lows is None:
        raise SystemExit('import_model: the source contains no meshes')
    return lows, highs


def fit_to_footprint(footprint, height):
    """Uniform-scale the model so its box fits the cells it was budgeted.

    UNIFORM, always: a footprint is a budget, not a target shape, and squashing
    one axis to hit it would be the tool silently redesigning the art. The
    binding constraint wins — the smallest of the per-axis ratios — so the
    result fits every budgeted axis and touches at least one of them.

    Blender is Z-up: the footprint's X and Z are Blender's x and y, and the
    height is Blender's z.
    """
    lows, highs = mesh_bounds()
    size = highs - lows
    budgets = [footprint[0], footprint[1], height]
    ratios = []
    for axis in range(3):
        if budgets[axis] is None or size[axis] <= 0:
            continue
        ratios.append(budgets[axis] / size[axis])
    if not ratios:
        return
    scale = min(ratios)
    scale_scene(scale)
    lows, highs = mesh_bounds()
    scaled = highs - lows
    print(f'  scaled by {scale:.6f} -> {scaled.x:.3f} x {scaled.y:.3f} cells, '
          f'{scaled.z:.3f} high')


def recentre(origin_mode):
    """Move the model so its origin is where the game expects to hold it.

    `ground`: the footprint centre at the lowest point — a walker's feet, a
    building's base, a boat's keel, all of which are placed by standing them on
    a cell. `centre`: the box centre — a swimmer or a flier, which is placed by
    its body and never touches the ground.
    """
    lows, highs = mesh_bounds()
    middle = (lows + highs) / 2
    if origin_mode == 'ground':
        offset = Vector((-middle.x, -middle.y, -lows.z))
    else:
        offset = -middle
    transform_model(Matrix.Translation(offset))
    lows, highs = mesh_bounds()
    print(f'  origin={origin_mode}: min-height now {lows.z:.4f}, '
          f'centre ({(lows.x + highs.x) / 2:.4f}, {(lows.y + highs.y) / 2:.4f})')


# ------------------------------------------------------- splitting materials


def select_only(obj):
    """Make `obj` the one selected, active object — what the ops act on."""
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)


def split_by_material():
    """One object per material.

    bakeRig (client/src/render/rigSkin.ts) draws one surface per material and
    rigAsset rejects a mesh carrying several, because a merged multi-material
    mesh has no single material to bake with. Splitting is lossless: the same
    triangles, grouped by the thing that decides how they are drawn.
    """
    for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
        if len(obj.data.materials) < 2:
            continue
        base = obj.name
        before = set(bpy.data.objects)
        select_only(obj)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='MATERIAL')
        bpy.ops.object.mode_set(mode='OBJECT')
        # Name each piece after the material it now carries: the name is what a
        # reviewer reads in stat_glb output, and "Wolf.003" says nothing.
        for piece in [obj] + [o for o in bpy.data.objects if o not in before]:
            material = piece.data.materials[0]
            if material is not None:
                piece.name = f'{base}_{material.name}'
                piece.data.name = piece.name
        print(f'  split {base} into {len(bpy.data.objects) - len(before) + 1} '
              f'single-material meshes')
    bpy.ops.object.select_all(action='DESELECT')

    # Remember the material on each mesh: --rigidify splits these again, by
    # bone, and names the results "<bone>_<material>".
    for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
        if len(obj.data.materials) == 1 and obj.data.materials[0] is not None:
            obj['material_name'] = obj.data.materials[0].name


# ------------------------------------------------------------- rigidifying


def armatures():
    return [o for o in bpy.data.objects if o.type == 'ARMATURE']


def build_joint_empties(armature):
    """One Empty per bone, at the bone's head, oriented like the bone.

    THE ONLY ANIMATION MODEL THIS GAME HAS is a node per joint with meshes
    rigidly under it (client/src/render/rigSkin.ts binds every vertex weight
    1.0 to exactly one node). An armature is not consumed at all, so it is
    converted here, once, offline — rather than being half-honoured at runtime.

    bone.matrix_local is the bone's rest transform in armature space, with the
    head at its translation, so composing it with the armature's own world
    matrix puts the Empty exactly where the bone rests.
    """
    empties = {}
    # Parents first, so a child's local transform is computed against a parent
    # that is already in its final place.
    for bone in _bones_parents_first(armature.data.bones):
        empty = bpy.data.objects.new(bone.name, None)
        empty.empty_display_type = 'PLAIN_AXES'
        empty.empty_display_size = JOINT_DISPLAY_SIZE
        bpy.context.collection.objects.link(empty)
        world = armature.matrix_world @ bone.matrix_local
        if bone.parent is not None:
            parent_empty = empties[bone.parent.name]
            empty.parent = parent_empty
            empty.matrix_basis = parent_empty.matrix_world.inverted() @ world
        else:
            empty.matrix_basis = world
        bpy.context.view_layer.update()
        empties[bone.name] = empty
    return empties


def _bones_parents_first(bones):
    ordered = []
    seen = set()

    def visit(bone):
        if bone.name in seen:
            return
        if bone.parent is not None:
            visit(bone.parent)
        seen.add(bone.name)
        ordered.append(bone)

    for bone in bones:
        visit(bone)
    return ordered


def dominant_bone_per_vertex(obj, bone_names, fallback_index):
    """For each vertex, the index (into bone_names) it weighs most on.

    A vertex that hinges between two bones has to pick one, because the bake
    gives it weight 1.0 on a single node either way. Picking the heaviest is
    the choice that moves the fewest vertices away from where smooth skinning
    would have put them.
    """
    group_bone = {}
    for group in obj.vertex_groups:
        if group.name in bone_names:
            group_bone[group.index] = bone_names.index(group.name)

    dominant = []
    for vertex in obj.data.vertices:
        best_index, best_weight = fallback_index, MIN_MEANINGFUL_WEIGHT
        for element in vertex.groups:
            bone_index = group_bone.get(element.group)
            if bone_index is None:
                continue
            if element.weight > best_weight:
                best_index, best_weight = bone_index, element.weight
        dominant.append(best_index)
    return dominant


def tag_faces_with_bones(obj, dominant):
    """Give every face the bone most of its vertices belong to.

    Faces, not vertices, are what a mesh can be split along: a triangle cut in
    half would leave a hole. The majority vote keeps each face whole and puts
    it under the joint that carries most of it.
    """
    attribute = obj.data.attributes.new(name='rigidify_bone', type='INT', domain='FACE')
    used = {}
    for polygon in obj.data.polygons:
        tally = {}
        for vertex_index in polygon.vertices:
            bone_index = dominant[vertex_index]
            tally[bone_index] = tally.get(bone_index, 0) + 1
        # Ties break on the lowest bone index, so the split is deterministic.
        winner = min(tally.items(), key=lambda item: (-item[1], item[0]))[0]
        attribute.data[polygon.index].value = winner
        used[winner] = used.get(winner, 0) + len(polygon.vertices)
    return used


def separate_by_bone_tag(obj, bone_indices):
    """Split one tagged mesh into one object per bone that owns faces.

    Blender only knows how to separate the SELECTION, so the tag is read back
    inside edit mode once per bone. The face attribute survives the split,
    which is how each resulting piece still knows which bone it is.
    """
    import bmesh

    before = set(bpy.data.objects)
    for bone_index in bone_indices[:-1]:
        select_only(obj)
        bpy.ops.object.mode_set(mode='EDIT')
        mesh = bmesh.from_edit_mesh(obj.data)
        layer = mesh.faces.layers.int.get('rigidify_bone')
        for face in mesh.faces:
            face.select_set(face[layer] == bone_index)
        bmesh.update_edit_mesh(obj.data)
        bpy.ops.mesh.separate(type='SELECTED')
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    return [obj] + [o for o in bpy.data.objects if o not in before]


def rigidify():
    """Convert every armature into the Empty-per-joint convention.

    Prints bone -> vertex count, because the only way to see that a split went
    somewhere sane is to see where the vertices landed.
    """
    for armature in armatures():
        armature_name = armature.name
        bone_names = [bone.name for bone in armature.data.bones]
        if not bone_names:
            raise SystemExit(f'import_model: armature "{armature.name}" has no bones')
        root_index = next(
            i for i, bone in enumerate(armature.data.bones) if bone.parent is None
        )
        # Free the bone names before the Empties claim them: Blender's names are
        # unique across ALL objects, so a mesh already called "Body" would push
        # the "Body" joint to "Body.001" and the plugin's node lookup would miss.
        for index, obj in enumerate([o for o in bpy.data.objects if o.type == 'MESH']):
            obj.name = f'_part_{index}'
        empties = build_joint_empties(armature)

        bound = [
            o for o in bpy.data.objects
            if o.type == 'MESH' and any(m.type == 'ARMATURE' and m.object == armature
                                        for m in o.modifiers)
        ]
        counts = {}
        for obj in bound:
            dominant = dominant_bone_per_vertex(obj, bone_names, root_index)
            used = tag_faces_with_bones(obj, dominant)
            pieces = separate_by_bone_tag(obj, sorted(used.keys()))
            material = obj.get('material_name') or 'part'
            for piece in pieces:
                bone_index = piece.data.attributes['rigidify_bone'].data[0].value
                bone_name = bone_names[bone_index]
                counts[bone_name] = counts.get(bone_name, 0) + len(piece.data.vertices)
                _attach_to_joint(piece, empties[bone_name], f'{bone_name}_{material}')

        adopt_orphans_of(armature, empties, bone_names[root_index])
        bpy.data.objects.remove(armature, do_unlink=True)

        print(f'  rigidified {armature_name}: '
              f'{len(bone_names)} bones, {len(counts)} carrying geometry')
        for bone_name in sorted(counts, key=lambda n: -counts[n]):
            print(f'    {bone_name}: {counts[bone_name]} verts')


def adopt_orphans_of(armature, empties, root_bone_name):
    """Re-home anything else the armature was carrying onto its joint Empties.

    A glTF skin's leaf joints arrive as Blender Empties parented TO A BONE
    ("Tail8_end" and friends), and so do any anchors the author left in the
    file. Deleting the armature without this would silently drop them to the
    world origin, which is how a pivot ends up detached from the animal it
    belongs to.
    """
    for obj in [o for o in bpy.data.objects if o.parent is armature]:
        bone_name = obj.parent_bone if obj.parent_type == 'BONE' else root_bone_name
        empty = empties.get(bone_name) or empties[root_bone_name]
        world = obj.matrix_world.copy()
        obj.parent = empty
        obj.parent_type = 'OBJECT'
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_basis = empty.matrix_world.inverted() @ world
        bpy.context.view_layer.update()


def _attach_to_joint(piece, empty, name):
    """Parent one split mesh under its joint, keeping it exactly where it is."""
    for modifier in [m for m in piece.modifiers if m.type == 'ARMATURE']:
        piece.modifiers.remove(modifier)
    piece.vertex_groups.clear()
    piece.data.attributes.remove(piece.data.attributes['rigidify_bone'])
    world = piece.matrix_world.copy()
    piece.parent = empty
    piece.matrix_parent_inverse = Matrix.Identity(4)
    piece.matrix_basis = empty.matrix_world.inverted() @ world
    piece.name = name
    piece.data.name = name
    bpy.context.view_layer.update()


# --------------------------------------------------------- names and anchors


def apply_renames(renames):
    """Rename authored nodes to the names the plugin will ask for.

    A plugin addresses a joint BY NAME (plugins/boats/client/models.ts
    OAR_PIVOTS, and every species file), so a downloaded model's "Bone.014" has
    to become "oar_port_1" somewhere. Here, where the change is recorded in the
    command line, rather than by hand in Blender.
    """
    for old, new in renames:
        obj = bpy.data.objects.get(old)
        if obj is None:
            raise SystemExit(f'import_model: --rename {old}={new}: no object named "{old}"')
        obj.name = new
        if obj.type == 'MESH':
            obj.data.name = new
        print(f'  renamed {old} -> {new}')


def add_anchors(anchors):
    """Add measuring points as Empties, in the OUTPUT frame.

    An anchor is how a plugin reads a constant off the art instead of guessing
    it (`waterline`, `deck_top`, `fire_top` in the boat kit). The coordinates
    are given in the exported Y-up frame — the frame the reviewer read them in
    — and converted back to Blender's here.
    """
    for name, (x, y, z) in anchors:
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = 'PLAIN_AXES'
        empty.empty_display_size = JOINT_DISPLAY_SIZE
        bpy.context.collection.objects.link(empty)
        # Inverse of to_export_frame: gltf (x, y, z) came from blender (x, -z, y).
        empty.location = Vector((x, -z, y))
        print(f'  anchor {name} at export ({x}, {y}, {z})')


# ------------------------------------------------------------------ textures


def report_and_resize_images(max_texture):
    """Print every image, and shrink the ones above the budget.

    Colour space is printed rather than changed: Blender's glTF exporter copies
    a clean source image's bytes through untouched (blender/exp/material/
    encode_image.py, __encode_from_image) and lets the glTF slot define the
    encoding — baseColor and emissive are sRGB by the spec, normal/ORM linear —
    so the file is right as long as the importer classified the image right,
    which this print is the check for. A resized image is re-saved through
    Image.save(), which honours the image's own colorspace_settings, so the
    classification survives the downscale too.
    """
    for image in sorted(bpy.data.images, key=lambda i: i.name):
        width, height = image.size
        note = ''
        if max_texture is not None and max(width, height) > max_texture:
            ratio = max_texture / max(width, height)
            image.scale(max(1, int(width * ratio)), max(1, int(height * ratio)))
            note = f' -> {image.size[0]}x{image.size[1]}'
        print(f'  image {image.name}: {width}x{height}{note}, '
              f'colorspace={image.colorspace_settings.name}')


# --------------------------------------------------------------------- args


def parse_args(args):
    """The command line, one option at a time (argparse fights Blender's argv)."""
    options = {
        'source': args[0],
        'out': args[1],
        'forward': CONVENTION_FORWARD,
        'up': CONVENTION_UP,
        'footprint': None,
        'height': None,
        'origin': 'ground',
        'rigidify': False,
        'drop': [],
        'renames': [],
        'anchors': [],
        'max_texture': None,
    }
    index = 2
    while index < len(args):
        flag = args[index]
        if flag == '--forward':
            options['forward'] = args[index + 1].upper()
            index += 2
        elif flag == '--up':
            options['up'] = args[index + 1].upper()
            index += 2
        elif flag == '--footprint':
            options['footprint'] = (float(args[index + 1]), float(args[index + 2]))
            index += 3
        elif flag == '--height':
            options['height'] = float(args[index + 1])
            index += 2
        elif flag == '--origin':
            options['origin'] = args[index + 1]
            index += 2
        elif flag == '--rigidify':
            options['rigidify'] = True
            index += 1
        elif flag == '--drop':
            options['drop'].append(args[index + 1])
            index += 2
        elif flag == '--rename':
            old, new = args[index + 1].split('=', 1)
            options['renames'].append((old, new))
            index += 2
        elif flag == '--anchor':
            name, coordinates = args[index + 1].split('=', 1)
            values = tuple(float(v) for v in coordinates.split(','))
            if len(values) != 3:
                raise SystemExit(f'import_model: --anchor {name} needs x,y,z')
            options['anchors'].append((name, values))
            index += 2
        elif flag == '--max-texture':
            options['max_texture'] = int(args[index + 1])
            index += 2
        else:
            raise SystemExit(f'import_model: unknown option {flag}')
    if options['forward'] not in AXES or options['up'] not in AXES:
        raise SystemExit('import_model: --forward/--up must be one of ' + ', '.join(AXES))
    if options['origin'] not in ('ground', 'centre'):
        raise SystemExit('import_model: --origin must be ground or centre')
    return options


def main():
    options = parse_args(sys.argv[sys.argv.index('--') + 1:])

    clear_scene()
    print(f'importing {options["source"]}')
    import_source(options['source'])
    drop_non_model_objects(options['drop'])

    transform_model(orientation_matrix(options['forward'], options['up']))
    print(f'  oriented: forward {options["forward"]} -> +X, up {options["up"]} -> +Y (exported)')

    # SHAPE FIRST, SIZE SECOND. Splitting a mesh and hanging its parts off
    # joints changes the measured bounding box — each part contributes its own
    # axis-aligned box, and a rotated part's box is bigger than the part. So
    # the model is cut up and its transforms baked BEFORE it is measured;
    # measuring first would fit a silhouette the exported file no longer has,
    # and the runtime would then reject a model the tool called a fit.
    split_by_material()

    if armatures():
        if not options['rigidify']:
            raise SystemExit(
                'import_model: the source has an armature, which this game does not '
                'consume (pivots are Empties — see docs/model-assets.md). Pass '
                '--rigidify to convert it, or remove it in the source.'
            )
        rigidify()

    apply_renames(options['renames'])
    bake_object_transforms()

    if options['footprint'] is not None or options['height'] is not None:
        fit_to_footprint(options['footprint'] or (None, None), options['height'])
    recentre(options['origin'])

    add_anchors(options['anchors'])
    report_and_resize_images(options['max_texture'])

    export_scene_glb(options['out'])
    print_stats(f'pre-export scene for {options["out"]}')


if __name__ == '__main__':
    main()
