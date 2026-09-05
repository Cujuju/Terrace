// Turning an authored part-tree into ONE skinned drawable.
//
// THE DEFECT THIS EXISTS TO REMOVE. A creature in this codebase is authored the
// way you would build one out of blocks: a Group per joint, a Mesh per body
// part, each part positioned in its joint's space. That is a good way to WRITE
// a yeti and a bad way to DRAW one, because a renderer charges per Mesh. Live
// measurement, 2026-08-22: monsters and wildlife together were 47 of the
// scene's 102 draw calls, and wildlife managed 22 triangles per call. It is the
// same defect the terrain had (one mesh per chunk) and the structures had (one
// mesh per part) — the unit of AUTHORING keeps becoming the unit of DRAWING.
//
// WHY MERGING ALONE CANNOT FIX IT HERE, unlike for structures. A building holds
// still, so plugins/structures/client/parts.ts can bake every part into one
// surface. A creature's parts MOVE, each under its own joint, and a merged
// geometry has one transform. Of the kraken's 24 meshes only 10 sit still in
// rig space; the other 14 each hang under an animated node, and they are the
// half that grows with articulation. Merging the static ten is the callsite fix
// for half the problem.
//
// SKINNING IS THE CONTRACT FIX, and it is what a character is drawn as
// everywhere outside this file: one mesh, one skeleton, the hierarchy expressed
// as bones instead of as scene-graph nodes.
//
// TWO BINDINGS, ONE BAKE. A part authored as a plain Mesh under a Group is
// bound RIGIDLY — weight 1.0 to exactly one bone, the node it was authored
// under — which is not an approximation of smooth skinning but the correct
// binding for bodies that hinge rather than flex (the industry does the same
// for hard-surface characters: mechs, armour, anything jointed). Rigid weights
// reproduce the old scene-graph transform EXACTLY: both evaluate the same
// product of ancestor matrices, one on the CPU per node, the other on the GPU
// per vertex.
//
// A part that arrives as a SkinnedMesh — a downloaded animal whose artist
// painted real weights across every joint — keeps those weights instead. Its
// vertices are CPU-skinned into rig space at the file's own bind pose (see
// bakeSkinnedPiece) and its four influences are re-indexed onto the bones this
// bake collected. Rigid binding is then the 1/0/0/0 special case of the same
// data, so one shader draws both and no caller has to know which it got. This
// exists because splitting a smooth-skinned deer by dominant weight tore its
// shoulder and hip open mid-stride (owner, 2026-09-04).
//
// WHAT THE CALLER KEEPS. The authoring style does not change. A model file
// still builds its Groups and Meshes exactly as before, notes which nodes it
// wants to animate, and hands the tree to `bakeRig`. What comes back drives
// those same nodes as Bones — `Bone` extends `Object3D`, so an `animate()` body
// that said `joint.rotation.z = …` says the identical thing afterwards.
//
// BLUEPRINT / INSTANCE, and why the split earns its keep. Geometry and material
// depend only on the SPECIES; the pose depends on the individual. So a rig is
// baked once (`bakeRig`) and instantiated per creature (`instantiateRig`),
// which keeps the pool-sharing wildlife/client/models.ts already promises — one
// set of buffers per species, not one per fish — while giving every creature
// its own skeleton to animate.
//
// WHERE THIS LIVES. It is render-kit code: plain Three.js data structures, no
// client state, no plugin state, no DOM, no WebGL. It sits in client/src/render
// because that is where this repo's other render kit sits and because plugins
// already compose with the client by path (client/src/plugins/registry.ts
// imports them the same way, in the other direction). If a third consumer
// appears it should move to a workspace package of its own; nothing here would
// have to change to allow that.

import {
  Bone,
  BufferAttribute,
  Color,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Vector2,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
// Shipped inside the `three` package itself (see its package.json "exports"),
// not a separate dependency.
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  mapIdentitySignature,
  texturesOf,
  uvAttributeName,
  uvChannelsUsed,
} from './materialMaps.ts';

/** Bones per vertex in three's skin attributes. Rigid binding uses only the first. */
const SKIN_INFLUENCES = 4;

/** Floats in a 4x4 matrix, in three's column-major element order. */
const MATRIX_ELEMENTS = 16;

/** RGB channels per vertex in a `color` attribute. */
const COLOR_COMPONENTS = 3;

/**
 * The weight of a rigidly bound vertex: all of it, on one bone.
 *
 * Named rather than written as a bare 1 at the two places it is stored, because
 * it is the whole binding decision — the moment any creature needs a vertex to
 * be shared between two bones (flesh deforming across a joint, rather than a
 * part hinging with one), this constant is the thing that stops being true.
 */
const RIGID_BIND_WEIGHT = 1;

/**
 * How a material is matched to others it can be drawn with in one call.
 *
 * Asked of the MATERIAL, never declared per part — the same rule
 * structures/parts.ts settled on, and for the same reason: a flag on each
 * part is a flag someone forgets on the part they add next year, while a
 * material either can share a surface or cannot. Colour is deliberately NOT in
 * the signature — and this is where the rule here parts company with
 * structures/parts.ts, whose materialSignature() keeps colour and so emits one
 * surface per colour. Differing colours are exactly what a vertex colour
 * attribute exists to carry, and collapsing them is most of the win.
 *
 * Everything else that changes how a surface is SHADED is in: two parts that
 * disagree about transparency, opacity, shading model, side or blending are two
 * draws, and no amount of vertex data makes them one.
 */
function materialSignature(material: Material): string {
  const shaded = material as Material & {
    flatShading?: boolean;
    emissive?: Color;
    wireframe?: boolean;
  };
  return [
    material.type,
    material.transparent ? 't' : '-',
    material.opacity,
    material.side,
    material.blending,
    material.depthWrite ? 'dw' : '-',
    material.depthTest ? 'dt' : '-',
    shaded.flatShading === true ? 'flat' : 'smooth',
    shaded.wireframe === true ? 'wire' : '-',
    // A texture is per-material state a vertex colour cannot stand in for, and
    // two parts with DIFFERENT maps have nothing to share. Identity, not
    // presence, so two parts sampling the same atlas still merge. EVERY slot,
    // not just the colour one: two parts that differ only in normal map are
    // shaded differently, and merging them would draw both under whichever
    // material reached the group first. See materialMaps.ts for the list.
    mapIdentitySignature(material),
    // The scalars that SCALE those maps, for the same reason and with the same
    // failure if they are left out — a merged surface takes one material, so
    // two parts that disagree about roughness (or about how deep their normal
    // map bites) cannot be one draw. Absent fields are written as '-', so a
    // material class that lacks the field never splits a group.
    shadingScalarSignature(material),
    // Emissive is a uniform, not a vertex attribute, so two parts that glow
    // differently must stay apart. Black (the default) means "not emissive" and
    // merges freely.
    shaded.emissive === undefined ? 'noem' : shaded.emissive.getHexString(),
    // A material whose SHADER has been rewritten (three's onBeforeCompile) is a
    // different program, and no vertex attribute can bridge two programs. Every
    // field above is a parameter three itself keys its program cache on;
    // customProgramCacheKey is the hook by which a material declares the rest,
    // and reading it here is how a merge learns about an injection it cannot
    // otherwise see. Two parts that inject the SAME source still merge, which is
    // what keeps a creature's several furred tones in one draw call.
    material.customProgramCacheKey(),
  ].join('|');
}

/**
 * The scalar uniforms a merge must not average away, in a fixed order.
 *
 * Each one either IS the shading of a surface (roughness, metalness) or scales
 * a map's contribution (the intensities, the displacement pair). None of them
 * can be carried per vertex, which is exactly the test for belonging in the
 * signature — unlike colour, which a vertex attribute does carry and which is
 * therefore deliberately absent (see materialSignature).
 */
const SHADING_SCALAR_FIELDS = [
  'roughness',
  'metalness',
  'aoMapIntensity',
  'lightMapIntensity',
  'emissiveIntensity',
  'displacementScale',
  'displacementBias',
] as const;

/** The scalar uniforms above plus normalScale, which is a Vector2 rather than a number. */
function shadingScalarSignature(material: Material): string {
  type ScalarField = (typeof SHADING_SCALAR_FIELDS)[number];
  const scalars = material as Material & Partial<Record<ScalarField, number>>;
  const parts = SHADING_SCALAR_FIELDS.map((field) => {
    const value = scalars[field];
    return value === undefined ? '-' : String(value);
  });
  const normalScale = (material as Material & { normalScale?: Vector2 }).normalScale;
  parts.push(normalScale === undefined ? '-' : `${normalScale.x}:${normalScale.y}`);
  return parts.join(',');
}

/** One drawable of a baked rig: a merged geometry and the material it draws with. */
interface BakedSurface {
  geometry: BufferGeometry;
  material: Material;
}

/** One bone's rest transform and its place in the tree. */
interface BoneDescriptor {
  /** Index into the descriptor list; -1 for the root, whose parent is the instance root. */
  parent: number;
  position: Vector3;
  quaternion: { x: number; y: number; z: number; w: number };
  scale: Vector3;
}

export interface RigBlueprint {
  /**
   * The joint index of an authored node, for the caller to capture at author
   * time and look up per instance. Throws for a node that was not part of the
   * baked tree, because silently handing back a wrong joint would show up as an
   * animation driving the wrong limb — a bug that looks like bad art.
   */
  jointIndex(node: Object3D): number;
  /** Bones every instance will carry, in `jointIndex` order. */
  readonly jointCount: number;
  /** Draw calls one instance of this rig costs. */
  readonly surfaceCount: number;
  /** Frees the merged geometries and the materials created for them. */
  dispose(): void;
  /** @internal — instantiateRig's input; not part of the authoring contract. */
  readonly surfaces: readonly BakedSurface[];
  /** @internal */
  readonly bones: readonly BoneDescriptor[];
  /** @internal */
  readonly boneInverses: readonly Matrix4[];
  /** @internal */
  readonly bounds: Sphere;
}

export interface RigInstance {
  /** Placed and yawed by the caller, exactly as the authored root was. */
  readonly root: Group;
  /** The animated handles, in the blueprint's joint order. */
  readonly joints: readonly Bone[];
  /** The drawn objects — ONE PER MATERIAL GROUP, not one per part. */
  readonly meshes: readonly SkinnedMesh[];
}

/**
 * Bakes an authored part-tree into shared, skinnable buffers.
 *
 * `authoredRoot` must be at the identity transform and unparented: every vertex
 * is baked in ITS space, and a root that had already been placed would bake
 * that placement into the geometry every creature then shares.
 *
 * The tree is consumed as data — nothing in it is drawn afterwards, and the
 * caller is free to let it go. Geometries and materials it referenced are
 * untouched (a model pool typically shares them across species and disposes
 * them itself); what this function allocates, `dispose` frees.
 */
export function bakeRig(authoredRoot: Object3D): RigBlueprint {
  if (authoredRoot.parent !== null) {
    throw new Error('bakeRig: the authored root must be unparented');
  }
  authoredRoot.updateMatrixWorld(true);

  // EVERY node becomes a bone, meshes included. A Mesh that carries children is
  // both a drawable and a joint (the whale's flukes hang off its body that way),
  // and deciding case by case which nodes "really" move is a judgement this
  // module cannot make and does not need to: an unmoving bone costs one matrix.
  const nodes: Object3D[] = [];
  const bones: BoneDescriptor[] = [];
  const indexOf = new Map<Object3D, number>();
  const collect = (node: Object3D, parent: number): void => {
    const index = nodes.length;
    nodes.push(node);
    indexOf.set(node, index);
    bones.push({
      parent,
      position: node.position.clone(),
      quaternion: {
        x: node.quaternion.x,
        y: node.quaternion.y,
        z: node.quaternion.z,
        w: node.quaternion.w,
      },
      scale: node.scale.clone(),
    });
    for (const child of node.children) collect(child, index);
  };
  collect(authoredRoot, -1);

  // The rest pose is the bind pose: a bone's inverse-bind matrix undoes exactly
  // the transform its vertices were baked with, so the two cancel at rest and
  // the creature starts in the pose it was authored in.
  const boneInverses = nodes.map((node) => node.matrixWorld.clone().invert());

  // Group the parts by what can be drawn together, keeping the tree's order so
  // a rig always bakes to the same surfaces in the same order.
  const grouped = new Map<string, { material: Material; pieces: BufferGeometry[] }>();
  let boundingRadius = 0;
  for (const node of nodes) {
    if (!isDrawableMesh(node)) continue;
    const material = node.material;
    const joint = indexOf.get(node)!;

    const piece = node.geometry.clone();
    const skinned = asSkinnedMesh(node);
    let reach: number;
    if (skinned === null) {
      // Into rig space: positions by the rest world matrix, normals by its normal
      // matrix — applyMatrix4 does both, which is what keeps a smooth-shaded whale
      // smooth and a rotated cone lit from the right side.
      piece.applyMatrix4(node.matrixWorld);
      bindRigidly(piece, joint);
      reach = poseInvariantReach(node);
    } else {
      reach = bakeSkinnedPiece(piece, skinned, indexOf);
    }
    paintVertexColor(piece, material);
    stripUnbakeableAttributes(piece, material);

    // Indexing joins the signature, because `mergeGeometries` refuses a mix and
    // the only way to force one is to EXPAND the indexed parts to non-indexed —
    // which triples their vertex count. Measured on the whale, whose hull is
    // indexed and whose extruded fins are not: forcing them together took one
    // body from 19 638 vertices to 57 996, for no change to the surface. One
    // extra draw call through the same material is the cheaper half of that
    // trade by a wide margin.
    const signature = `${materialSignature(material)}|${piece.getIndex() === null ? 'flat' : 'indexed'}`;
    const group = grouped.get(signature);
    if (group === undefined) grouped.set(signature, { material, pieces: [piece] });
    else group.pieces.push(piece);

    boundingRadius = Math.max(boundingRadius, reach);
  }

  const surfaces: BakedSurface[] = [];
  for (const { material, pieces } of grouped.values()) {
    const geometry = pieces.length === 1 ? pieces[0]! : mergeGeometries(pieces, false);
    if (geometry === null) {
      throw new Error('bakeRig: could not merge parts that share a material signature');
    }
    for (const piece of pieces) {
      if (piece !== geometry) piece.dispose();
    }
    // A bone can swing a vertex anywhere on the sphere its chain can reach, so
    // the bind-pose bound would cull a creature that is still on screen. See
    // poseInvariantReach: this radius holds for EVERY pose, which is what lets
    // frustum culling stay on.
    geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), boundingRadius);
    surfaces.push({ geometry, material: vertexColoured(material) });
  }

  const bounds = new Sphere(new Vector3(0, 0, 0), boundingRadius);
  let disposed = false;

  return {
    jointIndex(node: Object3D): number {
      const index = indexOf.get(node);
      if (index === undefined) throw new Error('bakeRig: node was not part of the baked rig');
      return index;
    },
    jointCount: nodes.length,
    surfaceCount: surfaces.length,
    surfaces,
    bones,
    boneInverses,
    bounds,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const maps = new Set<Texture>();
      for (const surface of surfaces) {
        surface.geometry.dispose();
        // EVERY slot the material samples, asked of materialMaps.ts rather than
        // listed here: a hand-written pair of slots leaked a PBR asset's normal,
        // roughness and occlusion textures on every blueprint disposal.
        for (const texture of texturesOf(surface.material)) maps.add(texture);
        surface.material.dispose();
      }
      // The textures a surface samples are freed WITH the blueprint. The clone
      // shares the SOURCE asset's texture objects (see vertexColoured), so this
      // is shared ownership: the asset's own dispose frees them too, and three
      // tolerates the double dispose — dispose() only drops the GPU upload,
      // which the second call finds already gone. What must never happen is the
      // reverse: disposing the asset while a blueprint still samples it pulls
      // the texels out from under a living rig, so callers free blueprints
      // first (see RigAsset.dispose).
      for (const map of maps) map.dispose();
    },
  };
}

/**
 * One creature: its own skeleton and root, sharing the blueprint's buffers.
 *
 * The skinned meshes and the root bone are siblings under `root`, which is what
 * three's default AttachedBindMode expects — it re-derives `bindMatrixInverse`
 * from the mesh's world matrix every frame (verified in three 0.185's
 * SkinnedMesh.updateMatrixWorld), so skinning stays correct however the caller
 * moves, turns or scales `root`.
 */
export function instantiateRig(blueprint: RigBlueprint): RigInstance {
  const root = new Group();
  const joints: Bone[] = [];

  for (const descriptor of blueprint.bones) {
    const bone = new Bone();
    bone.position.copy(descriptor.position);
    bone.quaternion.set(
      descriptor.quaternion.x,
      descriptor.quaternion.y,
      descriptor.quaternion.z,
      descriptor.quaternion.w,
    );
    bone.scale.copy(descriptor.scale);
    joints.push(bone);
    if (descriptor.parent < 0) root.add(bone);
    else joints[descriptor.parent]!.add(bone);
  }

  // Cloned per instance: a Skeleton keeps the array it is given, and two
  // creatures must not share matrices one of them might later recompute.
  const skeleton = new Skeleton(joints, blueprint.boneInverses.map((matrix) => matrix.clone()));

  const meshes: SkinnedMesh[] = [];
  for (const surface of blueprint.surfaces) {
    const mesh = new SkinnedMesh(surface.geometry, surface.material);
    root.add(mesh);
    // Identity bind matrix: the geometry was baked in the rig root's own space,
    // and the bone inverses were taken there too, so no further base transform
    // is involved.
    mesh.bind(skeleton, new Matrix4());
    meshes.push(mesh);
  }

  return { root, joints, meshes };
}

/**
 * A Mesh with a single material and geometry — the only shape a part can take.
 *
 * A SkinnedMesh passes: it IS a Mesh (three sets both flags), and the bake
 * takes its own weights rather than inventing one bone for it — see
 * `bakeSkinnedPiece`. A Bone is not a Mesh and simply draws nothing, which is
 * what it is for.
 */
function isDrawableMesh(node: Object3D): node is Mesh & { material: Material } {
  if (!(node as Mesh).isMesh) return false;
  const material = (node as Mesh).material;
  if (Array.isArray(material)) {
    throw new Error('bakeRig: a multi-material part cannot be baked — split it into parts');
  }
  return true;
}

/**
 * Folds the material's own colour into every vertex, so parts that differed
 * only by colour can share one draw.
 *
 * MULTIPLIED IN, never skipped. A `color` attribute that is already there is
 * not the part's colour — in this codebase it is a per-vertex SHADE, values
 * either side of 1 that mottle a broad mass (see
 * plugins/monsters/client/geometry.ts, applyShadeVariation). The shader
 * multiplies material colour by vertex colour, so a shaded part means exactly
 * `material.color * shade`; taking the shade to BE the colour and then
 * whitening the material (see `vertexColoured`) threw the part's real colour
 * away, and a near-black kraken came out near-white. Multiplying reproduces the
 * unbaked shading for both cases at once — an absent attribute is the shade
 * 1 everywhere.
 */
function paintVertexColor(geometry: BufferGeometry, material: Material): void {
  const source = (material as Material & { color?: Color }).color;
  const colour = source ?? new Color(0xffffff);
  const count = geometry.getAttribute('position').count;
  const shade = geometry.getAttribute('color');
  const colors = new Float32Array(count * COLOR_COMPONENTS);
  for (let v = 0; v < count; v++) {
    colors[v * COLOR_COMPONENTS] = colour.r * (shade === undefined ? 1 : shade.getX(v));
    colors[v * COLOR_COMPONENTS + 1] = colour.g * (shade === undefined ? 1 : shade.getY(v));
    colors[v * COLOR_COMPONENTS + 2] = colour.b * (shade === undefined ? 1 : shade.getZ(v));
  }
  geometry.setAttribute('color', new BufferAttribute(colors, COLOR_COMPONENTS));
}

/** Binds every vertex of a part to the one bone it was authored under. */
function bindRigidly(geometry: BufferGeometry, joint: number): void {
  const count = geometry.getAttribute('position').count;
  const indices = new Uint16Array(count * SKIN_INFLUENCES);
  const weights = new Float32Array(count * SKIN_INFLUENCES);
  for (let v = 0; v < count; v++) {
    indices[v * SKIN_INFLUENCES] = joint;
    weights[v * SKIN_INFLUENCES] = RIGID_BIND_WEIGHT;
  }
  geometry.setAttribute('skinIndex', new BufferAttribute(indices, SKIN_INFLUENCES));
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, SKIN_INFLUENCES));
}

/** The node, narrowed, if it arrived as an armature-bound mesh. */
function asSkinnedMesh(node: Object3D): SkinnedMesh | null {
  // three's own flag rather than `instanceof`, so a node that arrived through a
  // second copy of three is still recognised.
  return (node as Object3D & { isSkinnedMesh?: boolean }).isSkinnedMesh === true
    ? (node as SkinnedMesh)
    : null;
}

/**
 * How far a per-vertex weight set may miss summing to 1 before it is rescaled.
 *
 * A thousandth. glTF stores weights as float32 or as normalised bytes/shorts,
 * and both round trips leave dust an order of magnitude under this; anything
 * larger is an exporter that did not normalise, and drawing it unnormalised
 * shrinks or swells the surface by exactly the shortfall.
 */
const SKIN_WEIGHT_SUM_TOLERANCE = 1e-3;

/**
 * Bakes an armature-bound part into rig space, KEEPING the artist's weights.
 *
 * WHY CPU-SKINNING AND NOT `applyMatrix4`. A SkinnedMesh's positions are stored
 * at the BIND pose, in the skin's own space, and the transform that puts them
 * where the file draws them is per VERTEX, not per node. So each vertex goes
 * through the same product three's shader would apply at rest — mirroring
 * `SkinnedMesh.applyBoneTransform` (three 0.185, client/node_modules/three/src/
 * objects/SkinnedMesh.js:319-366) and `<skinning_vertex>` exactly:
 *
 *     v_rig = matrixWorld . bindMatrixInverse . ( SUM wi . Bi.matrixWorld .
 *             boneInverses[i] ) . bindMatrix . v
 *
 * The leading `matrixWorld . bindMatrixInverse` is what the scene graph applies
 * around the shader's result; under three's default AttachedBindMode the two
 * cancel (SkinnedMesh.updateMatrixWorld re-derives bindMatrixInverse from
 * matrixWorld), and writing the product out means this is right whichever bind
 * mode the file's loader chose. THE FILE'S REST POSE IS NOT ASSUMED TO BE ITS
 * BIND POSE: `Bi.matrixWorld` is read as it stands, so a file posed away from
 * its bind pose bakes at the pose it is in.
 *
 * AFTER THIS, REST IS BIND BY CONSTRUCTION. The bake's own inverse for a bone
 * is `node.matrixWorld.invert()` (see bakeRig), the exact inverse of the matrix
 * folded in here, so the two cancel at rest for a weighted vertex exactly as
 * they do for a rigid one — one rule for both kinds of part.
 *
 * Returns the part's pose-invariant reach; see the loop below.
 */
function bakeSkinnedPiece(
  piece: BufferGeometry,
  mesh: SkinnedMesh,
  indexOf: ReadonlyMap<Object3D, number>,
): number {
  const skeleton = mesh.skeleton;
  const bones = skeleton.bones;

  // THE REMAP. The file's skinIndex addresses `skeleton.bones`; the baked
  // attributes must address the bake's own depth-first node list. A bone that
  // is not in the baked tree cannot happen for the unparented scene bakeRig
  // demands — every bone is a descendant of the root — so this throw is a
  // guard, not a path, and it names the mesh because that is what a reader
  // would go looking at.
  const remap = new Uint16Array(bones.length);
  const boneOffsets: Matrix4[] = [];
  const boneReach: number[] = [];
  const bonePositions: Vector3[] = [];
  for (let b = 0; b < bones.length; b++) {
    const bone = bones[b]!;
    const index = indexOf.get(bone);
    if (index === undefined) {
      throw new Error(
        `bakeRig: skinned mesh "${mesh.name || '(unnamed)'}" is weighted to bone ` +
          `"${bone.name || '(unnamed)'}", which is not part of the baked tree`,
      );
    }
    remap[b] = index;
    boneOffsets.push(new Matrix4().multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[b]!));
    boneReach.push(chainReach(bone).reach);
    bonePositions.push(new Vector3().setFromMatrixPosition(bone.matrixWorld));
  }

  const pre = mesh.bindMatrix;
  const post = new Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);

  const positions = piece.getAttribute('position');
  const normals = piece.getAttribute('normal');
  const sourceIndex = piece.getAttribute('skinIndex');
  const sourceWeight = piece.getAttribute('skinWeight');
  if (sourceIndex === undefined || sourceWeight === undefined) {
    throw new Error(
      `bakeRig: skinned mesh "${mesh.name || '(unnamed)'}" carries no skinIndex/skinWeight`,
    );
  }

  const count = positions.count;
  const bakedIndices = new Uint16Array(count * SKIN_INFLUENCES);
  const bakedWeights = new Float32Array(count * SKIN_INFLUENCES);
  const blended = new Matrix4();
  const normalMatrix = new Matrix3();
  const vertex = new Vector3();
  const weights = new Float32Array(SKIN_INFLUENCES);
  let reach = 0;

  for (let v = 0; v < count; v++) {
    let sum = 0;
    for (let i = 0; i < SKIN_INFLUENCES; i++) {
      const weight = sourceWeight.getComponent(v, i);
      weights[i] = weight;
      sum += weight;
    }
    if (sum <= 0) {
      // An unweighted vertex would collapse onto the origin under a zero
      // matrix. The first influence takes all of it, which is the rigid
      // binding — the same fallback import_model.py makes offline.
      weights[0] = RIGID_BIND_WEIGHT;
      sum = RIGID_BIND_WEIGHT;
    }
    if (Math.abs(sum - 1) > SKIN_WEIGHT_SUM_TOLERANCE) {
      for (let i = 0; i < SKIN_INFLUENCES; i++) weights[i]! /= sum;
    }

    blended.elements.fill(0);
    for (let i = 0; i < SKIN_INFLUENCES; i++) {
      const weight = weights[i]!;
      const bone = sourceIndex.getComponent(v, i);
      bakedIndices[v * SKIN_INFLUENCES + i] = remap[bone]!;
      bakedWeights[v * SKIN_INFLUENCES + i] = weight;
      if (weight === 0) continue;
      const offset = boneOffsets[bone]!.elements;
      for (let e = 0; e < MATRIX_ELEMENTS; e++) blended.elements[e]! += offset[e]! * weight;
    }
    blended.premultiply(post).multiply(pre);

    vertex.fromBufferAttribute(positions, v).applyMatrix4(blended);
    positions.setXYZ(v, vertex.x, vertex.y, vertex.z);
    if (normals !== undefined) {
      normalMatrix.getNormalMatrix(blended);
      vertex.fromBufferAttribute(normals, v).applyMatrix3(normalMatrix).normalize();
      normals.setXYZ(v, vertex.x, vertex.y, vertex.z);
    }

    // POSE-INVARIANT REACH FOR A WEIGHTED VERTEX. Its posed position is a convex
    // blend of what each influencing bone would put it at, so it never leaves
    // the largest of those bones' reach balls: how far that bone's origin can
    // travel (chainReach) plus how far the vertex sits from it at rest. The max
    // over influences holds for every pose, which is what lets frustum culling
    // stay on — the same property poseInvariantReach gives a rigid part.
    vertex.fromBufferAttribute(positions, v);
    for (let i = 0; i < SKIN_INFLUENCES; i++) {
      if (weights[i] === 0) continue;
      const bone = sourceIndex.getComponent(v, i);
      const candidate = boneReach[bone]! + vertex.distanceTo(bonePositions[bone]!);
      if (candidate > reach) reach = candidate;
    }
  }

  positions.needsUpdate = true;
  if (normals !== undefined) normals.needsUpdate = true;
  piece.setAttribute('skinIndex', new BufferAttribute(bakedIndices, SKIN_INFLUENCES));
  piece.setAttribute('skinWeight', new BufferAttribute(bakedWeights, SKIN_INFLUENCES));
  return reach;
}

/**
 * The uv channels three can read from a geometry: `uv`, `uv1`, `uv2`, `uv3`.
 *
 * FOUR IS THREE'S OWN LIMIT, not a budget chosen here — WebGLPrograms.js
 * :388-390 derives `vertexUv1s`, `vertexUv2s` and `vertexUv3s` from the active
 * channels and knows no fourth, so a texture asking for channel 4 is a file
 * three could not draw whatever this function did.
 */
const BAKEABLE_UV_CHANNELS = [0, 1, 2, 3] as const;

/**
 * Drops attributes that would stop parts merging.
 *
 * `mergeGeometries` requires every input to carry the SAME attribute set, so a
 * uv set is kept if and only if the part's material SAMPLES that channel, and
 * stripped otherwise: a stray `uv` on an untextured primitive (Three's sphere
 * and box builders always emit one) would force it into a draw of its own,
 * while a textured part without one cannot be drawn at all. Which channels are
 * sampled comes from materialMaps.ts, so a normal map on the second uv set
 * keeps `uv1` alive exactly as a base colour map keeps `uv`. Groups are keyed
 * by map identity AND channel (see materialSignature), so every piece in a
 * group agrees about its uv sets BY CONSTRUCTION — a mapped group whose member
 * lacked one never reaches the merge, it throws below.
 *
 * `tangent` is always dropped. three derives the tangent frame in the fragment
 * shader when the attribute is absent (ShaderChunk/normal_fragment_begin.glsl.js
 * :24-31: `#ifdef USE_TANGENT` reads vTangent, `#else` calls getTangentFrame
 * from the view position and the normal-map uv), so a normal-mapped part is
 * shaded correctly without it — and keeping it would split every merge between
 * an exporter that wrote tangents and one that did not.
 */
function stripUnbakeableAttributes(geometry: BufferGeometry, material: Material): void {
  const sampled = uvChannelsUsed(material);
  for (const channel of sampled) {
    const attribute = uvAttributeName(channel);
    if (geometry.getAttribute(attribute) === undefined) {
      throw new Error(
        `bakeRig: a part's material samples uv channel ${channel} but the part carries no ` +
          `${attribute} attribute — a merge cannot invent coordinates, and drawing it ` +
          `unmapped would paint it one flat texel`,
      );
    }
  }
  for (const channel of BAKEABLE_UV_CHANNELS) {
    if (sampled.has(channel)) continue;
    const attribute = uvAttributeName(channel);
    if (geometry.getAttribute(attribute) !== undefined) geometry.deleteAttribute(attribute);
  }
  if (geometry.getAttribute('tangent') !== undefined) geometry.deleteAttribute('tangent');
  geometry.morphAttributes = {};
}

/**
 * A copy of the material that reads its colour per vertex.
 *
 * EVERY MAP SLOT SURVIVES THE CLONE BY REFERENCE (verified in three 0.185's
 * MeshStandardMaterial.copy, client/node_modules/three/src/materials/
 * MeshStandardMaterial.js:418-449 — `this.map = source.map` and one such line
 * for lightMap, aoMap, emissiveMap, bumpMap, normalMap, displacementMap,
 * roughnessMap, metalnessMap, alphaMap and envMap, with the intensities and
 * normalScale beside them). Sharing the texture object rather than duplicating it is what
 * lets the blueprint free what it draws with while the source asset owns the
 * file's originals — and it makes the final shading the intended three-way
 * multiply: vertex colour (the part's own tint, folded in by paintVertexColor)
 * × map texel × material.color, whitened below so it contributes no fourth
 * factor. An untextured part's texel is 1 everywhere, so the same shader
 * draws both halves of a half-textured rig.
 */
function vertexColoured(material: Material): Material {
  const clone = material.clone();
  // THE SHADER HOOKS DO NOT SURVIVE A CLONE. Material.copy() copies the
  // properties three knows about; onBeforeCompile and customProgramCacheKey are
  // functions the caller assigned to the instance and it copies neither, so a
  // material with an injected shader came out of here as a plain one — the
  // injection silently gone, and gone only in the baked path, which is the one
  // every rigged creature takes. Carried across explicitly, so a material that
  // rewrites its own shader means the same thing baked as it does unbaked.
  clone.onBeforeCompile = material.onBeforeCompile;
  clone.customProgramCacheKey = material.customProgramCacheKey;
  clone.vertexColors = true;
  const tinted = clone as Material & { color?: Color };
  // White, because the vertex colours now carry the part's own colour and the
  // shader MULTIPLIES the two.
  if (tinted.color !== undefined) tinted.color = new Color(0xffffff);
  return clone;
}

/**
 * How far a node's ORIGIN can travel from the rig's origin over every pose, and
 * the scale its children's own offsets are stretched by.
 *
 * Root-first, because a link's translation is stretched by the scales ABOVE it
 * and those are the ones already walked past when the chain is read the other
 * way round. Scale is folded in as the largest component of each link's scale:
 * a non-uniform scale can only stretch a vector by its largest axis.
 */
function chainReach(node: Object3D): { reach: number; scale: number } {
  const chain: Object3D[] = [];
  for (let link: Object3D | null = node; link !== null; link = link.parent) chain.unshift(link);
  let reach = 0;
  let scale = 1;
  for (const link of chain) {
    reach += link.position.length() * scale;
    scale *= Math.max(link.scale.x, link.scale.y, link.scale.z);
  }
  return { reach, scale };
}

/**
 * The furthest any vertex of this part can ever be from the rig's origin, over
 * EVERY pose the skeleton can take.
 *
 * A rotation about a joint moves a vertex on a sphere centred at that joint, so
 * the worst case is every link in the chain pointing the same way: the sum of
 * the chain's translation lengths, plus the vertex's own distance from its
 * bone. That bound holds whatever the animation does, which is the property the
 * bind-pose bounding sphere lacks — a tentacle swung outward would leave a
 * bind-pose sphere and be culled while still on screen.
 *
 * Scale is folded in as the largest component of each link's scale: a
 * non-uniform scale can only stretch a vector by its largest axis.
 */
function poseInvariantReach(mesh: Mesh): number {
  const { reach, scale } = chainReach(mesh);
  const positions = mesh.geometry.getAttribute('position');
  let furthest = 0;
  for (let v = 0; v < positions.count; v++) {
    const x = positions.getX(v);
    const y = positions.getY(v);
    const z = positions.getZ(v);
    const distance = Math.sqrt(x * x + y * y + z * z);
    if (distance > furthest) furthest = distance;
  }
  // `scale` now carries every link's scale, the mesh's own included, which is
  // what a vertex offset inside the mesh is stretched by.
  return reach + furthest * scale;
}
