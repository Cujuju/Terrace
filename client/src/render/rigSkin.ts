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
// still, so plugins/structures/client/partMerge.ts can bake every part into one
// surface. A creature's parts MOVE, each under its own joint, and a merged
// geometry has one transform. Of the kraken's 24 meshes only 10 sit still in
// rig space; the other 14 each hang under an animated node, and they are the
// half that grows with articulation. Merging the static ten is the callsite fix
// for half the problem.
//
// SKINNING IS THE CONTRACT FIX, and it is what a character is drawn as
// everywhere outside this file: one mesh, one skeleton, the hierarchy expressed
// as bones instead of as scene-graph nodes. Every vertex here is bound RIGIDLY
// — weight 1.0 to exactly one bone, the node it was authored under — which is
// not an approximation of smooth skinning but the correct binding for bodies
// that hinge rather than flex (the industry does the same for hard-surface
// characters: mechs, armour, anything jointed). Rigid weights reproduce the old
// scene-graph transform EXACTLY: both evaluate the same product of ancestor
// matrices, one on the CPU per node, the other on the GPU per vertex.
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
  Matrix4,
  Mesh,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
// Shipped inside the `three` package itself (see its package.json "exports"),
// not a separate dependency — same import structures/partMerge.ts uses.
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Bones per vertex in three's skin attributes. Rigid binding uses only the first. */
const SKIN_INFLUENCES = 4;

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
 * structures/partMerge.ts settled on, and for the same reason: a flag on each
 * part is a flag someone forgets on the part they add next year, while a
 * material either can share a surface or cannot. Colour is deliberately NOT in
 * the signature: differing colours are exactly what a vertex colour attribute
 * exists to carry, and collapsing them is most of the win.
 *
 * Everything else that changes how a surface is SHADED is in: two parts that
 * disagree about transparency, opacity, shading model, side or blending are two
 * draws, and no amount of vertex data makes them one.
 */
function materialSignature(material: Material): string {
  const shaded = material as Material & {
    flatShading?: boolean;
    map?: unknown;
    emissive?: Color;
    emissiveMap?: unknown;
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
    // presence, so two parts sampling the same atlas still merge.
    shaded.map === undefined || shaded.map === null ? 'nomap' : idOf(shaded.map),
    shaded.emissiveMap === undefined || shaded.emissiveMap === null
      ? 'noemap'
      : idOf(shaded.emissiveMap),
    // Emissive is a uniform, not a vertex attribute, so two parts that glow
    // differently must stay apart. Black (the default) means "not emissive" and
    // merges freely.
    shaded.emissive === undefined ? 'noem' : shaded.emissive.getHexString(),
  ].join('|');
}

function idOf(value: unknown): string {
  const withUuid = value as { uuid?: string };
  return typeof withUuid.uuid === 'string' ? withUuid.uuid : 'unknown';
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
    // Into rig space: positions by the rest world matrix, normals by its normal
    // matrix — applyMatrix4 does both, which is what keeps a smooth-shaded whale
    // smooth and a rotated cone lit from the right side.
    piece.applyMatrix4(node.matrixWorld);
    paintVertexColor(piece, material);
    bindRigidly(piece, joint);
    stripUnbakeableAttributes(piece);

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

    boundingRadius = Math.max(boundingRadius, poseInvariantReach(node));
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
      for (const surface of surfaces) {
        surface.geometry.dispose();
        surface.material.dispose();
      }
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

/** A Mesh with a single material and geometry — the only shape a part can take. */
function isDrawableMesh(node: Object3D): node is Mesh & { material: Material } {
  if (!(node as Mesh).isMesh) return false;
  const material = (node as Mesh).material;
  if (Array.isArray(material)) {
    throw new Error('bakeRig: a multi-material part cannot be baked — split it into parts');
  }
  return true;
}

/**
 * Writes the material's own colour into every vertex, so parts that differed
 * only by colour can share one draw. Geometry that already carries colours
 * keeps them — a part authored with per-vertex colour has said something the
 * material cannot.
 */
function paintVertexColor(geometry: BufferGeometry, material: Material): void {
  if (geometry.getAttribute('color') !== undefined) return;
  const source = (material as Material & { color?: Color }).color;
  const colour = source ?? new Color(0xffffff);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * COLOR_COMPONENTS);
  for (let v = 0; v < count; v++) {
    colors[v * COLOR_COMPONENTS] = colour.r;
    colors[v * COLOR_COMPONENTS + 1] = colour.g;
    colors[v * COLOR_COMPONENTS + 2] = colour.b;
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

/**
 * Drops attributes that would stop parts merging.
 *
 * `mergeGeometries` requires every input to carry the SAME attribute set, and
 * these rigs are untextured — a stray `uv` on one primitive (Three's sphere and
 * box builders always emit one) would otherwise force it into a draw of its
 * own. Nothing samples a texture here; the check for a `map` in
 * materialSignature is what keeps that assumption honest if one ever appears.
 */
function stripUnbakeableAttributes(geometry: BufferGeometry): void {
  for (const name of ['uv', 'uv1', 'uv2', 'uv3', 'tangent']) {
    if (geometry.getAttribute(name) !== undefined) geometry.deleteAttribute(name);
  }
  geometry.morphAttributes = {};
}

/** A copy of the material that reads its colour per vertex. */
function vertexColoured(material: Material): Material {
  const clone = material.clone();
  clone.vertexColors = true;
  const tinted = clone as Material & { color?: Color };
  // White, because the vertex colours now carry the part's own colour and the
  // shader MULTIPLIES the two.
  if (tinted.color !== undefined) tinted.color = new Color(0xffffff);
  return clone;
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
  // Root-first, because a link's translation is stretched by the scales ABOVE
  // it and those are the ones already walked past when the chain is read the
  // other way round.
  const chain: Object3D[] = [];
  for (let node: Object3D | null = mesh; node !== null; node = node.parent) chain.unshift(node);

  let reach = 0;
  let scale = 1;
  for (const node of chain) {
    reach += node.position.length() * scale;
    scale *= Math.max(node.scale.x, node.scale.y, node.scale.z);
  }

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
