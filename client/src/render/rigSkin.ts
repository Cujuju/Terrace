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
  type Vector2,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
// Shipped inside the `three` package itself (see its package.json "exports"),
// not a separate dependency.
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RIGIDIFY_INSTRUCTION } from './rigAsset.ts';
import {
  mapIdentitySignature,
  texturesOf,
  uvAttributeName,
  uvChannelsUsed,
} from './materialMaps.ts';

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
    // Into rig space: positions by the rest world matrix, normals by its normal
    // matrix — applyMatrix4 does both, which is what keeps a smooth-shaded whale
    // smooth and a rotated cone lit from the right side.
    piece.applyMatrix4(node.matrixWorld);
    paintVertexColor(piece, material);
    bindRigidly(piece, joint);
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

/** A Mesh with a single material and geometry — the only shape a part can take. */
function isDrawableMesh(node: Object3D): node is Mesh & { material: Material } {
  // AN ARMATURE IS NOT BAKEABLE, and used to bake SILENTLY: a SkinnedMesh's
  // geometry is stored at the bind pose, so it merged into a surface posed
  // mid-T-pose with its joints discarded — the animation then drove bones this
  // bake had invented from the node tree, which is not the tree the asset was
  // weighted against. Rejected rather than approximated; the message names the
  // tool that converts one (see RIGIDIFY_INSTRUCTION).
  const skinned = node as Object3D & { isBone?: boolean; isSkinnedMesh?: boolean };
  if (skinned.isBone === true || skinned.isSkinnedMesh === true) {
    throw new Error(
      `bakeRig: node "${node.name || '(unnamed)'}" is part of an armature — ${RIGIDIFY_INSTRUCTION}`,
    );
  }
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
