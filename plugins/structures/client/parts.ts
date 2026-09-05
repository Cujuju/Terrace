// parts.ts — the PART, the unit every structure model in this plugin is
// assembled from, plus the small shared vocabulary for building one.
//
// A part is (geometry, material, local transforms): one geometry drawn once
// per local matrix, relative to the building's own origin. models.ts's own
// banner explains why a building is a list of these rather than a Group of
// Meshes — a part becomes ONE InstancedMesh shared by every building that
// uses it, so the draw-call count is a property of the MODEL LIBRARY, not of
// how many buildings are standing.
//
// WHY THIS TYPE LIVES IN ITS OWN MODULE (2026-08-22). It used to be declared
// inside models.ts, which was fine while models.ts was the only file that
// built anything. fishingHuts.ts is the second, so the choice was: duplicate
// the interface, or give it a home both can import. The type is the contract
// between "something that builds a model" and "the thing that instances it";
// a contract with two implementers belongs in neither of them.

import {
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Color,
  type Material,
} from 'three';
// The render kit, reached by path exactly as plugins/boats reaches rigSkin —
// see that module's header. Which texture slots exist, which uv channels they
// sample and what makes two materials the same for merging purposes is that
// module's business and no longer this one's: a hand-written slot list here
// would silently merge two parts that differ only in normal map, and silently
// strip the uv set of any slot it had forgotten (see materialMaps.ts's header).
import {
  mapIdentitySignature,
  uvAttributeName,
  uvChannelsUsed,
} from '../../../client/src/render/materialMaps.ts';

/** One part of a building: a geometry, its material, and where it sits. */
export interface StructurePart {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** One matrix per instance this part contributes, per building of this tier. */
  readonly localMatrices: Matrix4[];
}

export const Y_AXIS = new Vector3(0, 1, 0);
export const X_AXIS = new Vector3(1, 0, 0);

/** One full turn, for the ring helpers below. */
export const FULL_TURN_RADIANS = Math.PI * 2;

/** A flat-shaded Lambert material — the only material this plugin ever uses. */
export function lambert(
  color: number,
  options: { emissive?: number; emissiveIntensity?: number } = {},
): MeshLambertMaterial {
  return new MeshLambertMaterial({
    color,
    flatShading: true,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 1,
  });
}

/** A matrix that only translates — the common case for a single-instance part. */
export function at(x: number, y: number, z: number): Matrix4 {
  return new Matrix4().makeTranslation(x, y, z);
}

/** Translate, then yaw about Y, then scale — the general single-instance case. */
export function pose(
  x: number,
  y: number,
  z: number,
  yaw = 0,
  scale: Vector3 = new Vector3(1, 1, 1),
): Matrix4 {
  return new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromAxisAngle(Y_AXIS, yaw),
    scale,
  );
}

/**
 * Position, rotation and NON-UNIFORM scale, composed in the only order that
 * means what it looks like: scale in the geometry's own axes, then rotate,
 * then translate.
 *
 * Reach for this rather than `pose(...).multiply(makeRotationX(...))` whenever
 * the scale is non-uniform. `A.multiply(R)` post-multiplies, so the rotation
 * is applied to the vertex FIRST and the scale then acts on already-rotated
 * axes: a triangle meant to stand 0.62 tall and 0.03 thick comes out 0.03 tall
 * and 0.41 deep — lying flat, which is exactly the bug that shipped two of the
 * fishing huts' gable ends as floating slabs. Uniform scales commute with
 * rotation and are safe either way; non-uniform ones are not.
 */
export function composed(
  position: Vector3,
  rotation: Quaternion,
  scale: Vector3,
): Matrix4 {
  return new Matrix4().compose(position, rotation, scale);
}

/**
 * `count` local transforms evenly spaced around a circle of `radius` at
 * height `y`. `faceOutward` yaws each instance so its local +Z points away
 * from the centre — for parts (a thatch bundle, an arrow slit) whose geometry
 * has a front face that must face out through the wall. `tiltX` then leans
 * each one about its own X axis, which is what hangs an eave bundle down past
 * the roofline instead of standing it straight out.
 */
export function ringMatrices(
  count: number,
  radius: number,
  y: number,
  faceOutward: boolean,
  tiltX = 0,
  startAngleRadians = 0,
): Matrix4[] {
  const matrices: Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const angle = startAngleRadians + (FULL_TURN_RADIANS * i) / count;
    const matrix = pose(Math.sin(angle) * radius, y, Math.cos(angle) * radius, faceOutward ? angle : 0);
    if (tiltX !== 0) matrix.multiply(new Matrix4().makeRotationX(tiltX));
    matrices.push(matrix);
  }
  return matrices;
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGING: why an authored part is not always a drawn part.
//
// The part list is the AUTHORING unit — a fringe of 24 straw bundles is one
// part with 24 local matrices, and writing it any other way would be
// unreadable. It is NOT automatically the right DRAWING unit. Every part
// becomes its own InstancedMesh with its own capacity buffer, so a model
// authored as 14 parts costs 14 draw calls and 14 × STRUCTURES_CAP ×
// (matrices per part) instance slots — whether or not a single building of
// that model is standing. With ONE coastal model that was a rounding error.
// With TEN (fishingHuts.ts) it is 140 meshes and tens of megabytes of
// permanently-allocated instance buffers for a variant set that can never
// have more than STRUCTURES_CAP members between all ten of them.
//
// mergeParts collapses the authoring list into the drawing list: every part
// that shares a material is baked — local matrix and all — into ONE geometry
// with ONE identity matrix. A ten-part hut becomes six or seven meshes, one
// per distinct material, each costing STRUCTURES_CAP × 1 instances. Nothing
// about the model changes: the same triangles land in the same places, still
// flat-shaded, still per-building instanced through the building matrix.
//
// This is the recurring draw-call defect in this codebase stated as a helper:
// the unit a thing is AUTHORED in keeps becoming the unit it is DRAWN in.
// ─────────────────────────────────────────────────────────────────────────────

/** RGB channels per vertex in a `color` buffer attribute. */
const COLOR_COMPONENTS = 3;

/**
 * How many shareable parts it takes before collapsing them into one
 * vertex-coloured surface is worth doing.
 *
 * One shareable part is ALREADY one draw call, so merging it would buy no
 * reduction and cost a colour attribute plus a geometry copy. Two is the first
 * count where the surface removes a call.
 */
const SURFACE_MERGE_MINIMUM_PARTS = 2;

/**
 * Whether a part's material can be replaced by the shared vertex-coloured
 * surface material without changing a single pixel.
 *
 * This interrogates the MATERIAL rather than reading a flag on the part on
 * purpose. A flag would be one more thing each of models.ts's ~100 part
 * literals has to remember, and the failure mode of forgetting it is silent —
 * a lit window folded into the surface simply stops glowing, in one tier,
 * noticed by nobody. A material's own properties are the ground truth for
 * "can this share a draw call", and they cannot be forgotten.
 */
export function canShareOneSurface(material: Material): material is MeshLambertMaterial {
  if (!(material instanceof MeshLambertMaterial)) return false;
  // A texture needs its own UV space and the surface has no atlas (Durand's
  // sign). ASKED AS "does it sample ANY texture", not as `material.map !==
  // null`: the surface replaces the material outright with one flat
  // vertex-coloured Lambert, so a part carrying only a normal or occlusion map
  // would have that map silently thrown away — the same class of bug the old
  // hand-written slot pair caused everywhere else (materialMaps.ts's header).
  // The slot list is the render kit's, so this cannot fall behind it.
  if (uvChannelsUsed(material).size > 0) return false;
  // Emissive is one uniform for the whole draw call, so anything that glows
  // keeps its own mesh. This is also what holds Durand's ANIMATED materials out
  // of the merge: models.ts's animate() only ever drives emissiveIntensity and
  // opacity, and only on materials whose emissive is non-black — so excluding
  // non-black emissive excludes every animated material by construction, with
  // no list of animated materials for this file to fall out of date with.
  if (material.emissive.getHex() !== 0x000000) return false;
  // Transparency needs its own draw order, and the dancer's opacity is swung
  // per frame by that same animate().
  if (material.transparent || material.opacity < 1) return false;
  // The merged material is flat-shaded and front-faced. Every material in
  // models.ts is both today; these two guards are what keep a future material
  // that is neither from being silently re-shaded by the merge.
  if (!material.flatShading) return false;
  if (material.side !== FrontSide) return false;
  return true;
}

/**
 * A material's identity for merging purposes. Two separately-constructed
 * materials with identical settings are the same material as far as the GPU
 * is concerned, and builders construct one per part for readability, so
 * comparing by object identity alone would merge almost nothing.
 */
function materialSignature(material: Material): string {
  const lambertLike = material as MeshLambertMaterial;
  return [
    material.type,
    // COLOUR STAYS IN THE SIGNATURE. Step 1's vertex-coloured surface is what
    // collapses parts that differ only in colour; anything that reaches step 2
    // could not join that surface (it glows, it is transparent, it is
    // textured), and for those the colour is a uniform of the draw call, so
    // two differently-coloured parts are two draws whether this file likes it
    // or not. Folding them together here would repaint one of them.
    lambertLike.color?.getHex() ?? -1,
    lambertLike.emissive?.getHex() ?? -1,
    lambertLike.emissiveIntensity ?? 1,
    lambertLike.flatShading === true ? 1 : 0,
    material.transparent === true ? 1 : 0,
    material.opacity,
    material.side,
    // Every texture slot, by texture IDENTITY and uv channel, from the render
    // kit's one list — never a hand-written `map`/`emissiveMap` pair here.
    // Two authored parts that differ only in normal map are two different
    // surfaces, and before this they merged into one shaded by whichever
    // material happened to be first (materialMaps.ts's header).
    mapIdentitySignature(material),
  ].join('|');
}

/** Floats one vertex occupies in a `uv` buffer attribute. */
const UV_COMPONENTS = 2;

/**
 * One accumulating merge group: the flat attribute arrays every part baked into
 * it appends to.
 *
 * `uvs` is one array per uv ATTRIBUTE NAME (`uv`, `uv1`, …) — present exactly
 * when the group's material samples that channel, and absent otherwise, so an
 * untextured merge carries no uv arrays at all and costs nothing.
 */
interface MergeGroupData {
  positions: number[];
  normals: number[];
  colors?: number[];
  uvs?: Map<string, number[]>;
}

/**
 * The uv arrays a group needs, keyed by attribute name — empty when the
 * material samples no texture.
 *
 * ASKED OF THE MATERIAL, never of the geometry: a geometry may carry a uv set
 * nothing samples (three drops it at upload anyway), and — the failure that
 * matters — a material may sample a channel on the SECOND uv set (glTF
 * `texCoord: 1`), which a "copy `uv` if present" rule would strip. The channel
 * list is materialMaps.ts's answer, so it cannot fall behind the slot list.
 */
function uvArraysFor(material: Material): Map<string, number[]> | undefined {
  const channels = uvChannelsUsed(material);
  if (channels.size === 0) return undefined;
  const uvs = new Map<string, number[]>();
  for (const channel of channels) uvs.set(uvAttributeName(channel), []);
  return uvs;
}

/**
 * Position + normal of one geometry, baked through one local matrix — its
 * material's colour per vertex when the target is accumulating a shared
 * vertex-coloured surface, and its uv sets when the target's material samples
 * textures.
 *
 * UVs RIDE THROUGH UNTRANSFORMED, which is the whole of what "keeping" them
 * means: the matrix moves the vertex in the world, not the texel it reads.
 * They were dropped here until 2026-09-04, which was invisible while every
 * merged material was a flat colour (canShareOneSurface refuses a textured
 * one, so nothing textured used to reach step 2 either) and is not invisible
 * now that a tier can be an imported, textured model: a textured part merged
 * without its uv set samples one texel for every triangle — the whole building
 * painted one flat colour.
 */
function bakeInto(
  target: MergeGroupData,
  geometry: BufferGeometry,
  local: Matrix4,
  color?: Color,
): void {
  // toNonIndexed() first: two geometries cannot be concatenated attribute-wise
  // while either carries an index buffer, and the vertex count here is small
  // enough (a whole hut is a few thousand) that de-indexing costs nothing that
  // matters. Flat shading already discards the vertex sharing anyway.
  const baked = (geometry.index === null ? geometry.clone() : geometry.toNonIndexed());
  baked.applyMatrix4(local); // transforms positions AND rotates normals
  const position = baked.getAttribute('position');
  const normal = baked.getAttribute('normal');
  // Resolved once per part rather than per vertex, and MISSING IS FATAL: the
  // loader guarantees a uv attribute for every channel an asset's material
  // samples (rigAsset.ts), so a gap here means a part was assembled by hand
  // with a textured material and no UVs — which would otherwise merge into a
  // geometry whose uv array is short, i.e. a surface reading garbage texels.
  const uvSources: Array<{ target: number[]; source: BufferAttribute }> = [];
  for (const [attribute, values] of target.uvs ?? []) {
    const source = baked.getAttribute(attribute) as BufferAttribute | undefined;
    if (source === undefined) {
      baked.dispose();
      throw new Error(
        `mergeParts: a part whose material samples uv channel "${attribute}" carries no ` +
          `such attribute — it cannot share a merged surface`,
      );
    }
    uvSources.push({ target: values, source });
  }
  for (let i = 0; i < position.count; i++) {
    target.positions.push(position.getX(i), position.getY(i), position.getZ(i));
    if (normal !== undefined) target.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    // NO COLOUR-SPACE CONVERSION HERE, DELIBERATELY. A Material.color is
    // already in the renderer's LINEAR working space (three converts the
    // authored sRGB hex on construction), and a `color` buffer attribute is
    // read as linear too — so the channels copy across verbatim. Converting
    // would apply the sRGB transfer a second time and wash every building out.
    if (target.colors !== undefined && color !== undefined) {
      target.colors.push(color.r, color.g, color.b);
    }
    for (const { target: values, source } of uvSources) {
      values.push(source.getX(i), source.getY(i));
    }
  }
  baked.dispose();
}

/** Builds the output geometry for one accumulated group. */
function geometryOf(group: MergeGroupData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(group.positions), 3));
  if (group.normals.length === group.positions.length) {
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(group.normals), 3));
  } else {
    geometry.computeVertexNormals();
  }
  if (group.colors !== undefined) {
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(group.colors), COLOR_COMPONENTS));
  }
  for (const [attribute, values] of group.uvs ?? []) {
    geometry.setAttribute(attribute, new BufferAttribute(new Float32Array(values), UV_COMPONENTS));
  }
  return geometry;
}

/**
 * Collapses an authored part list into the far shorter list actually drawn,
 * with every local matrix baked into the vertices — see the banner above for
 * why. Two reductions, in this order:
 *
 *   1. Every part whose material canShareOneSurface() accepts becomes ONE
 *      vertex-coloured surface, however many distinct colours went in. Colour
 *      is what a `color` attribute exists to carry, and collapsing it is most
 *      of the win: a building's parts differ overwhelmingly by colour alone.
 *   2. Whatever is left — the glowing, the transparent, the textured — is
 *      grouped by full material signature, colour included, because for those
 *      the colour is not the only thing that differs and the surface material
 *      cannot represent them.
 *
 * Step 2 alone was the original contract, and it is why a tier of a hundred
 * differently-coloured Lambert parts still cost dozens of draws: each distinct
 * colour is its own signature. Step 1 is what removes that floor.
 *
 * Order is deterministic for a given input list — the surface first when there
 * is one, then each signature group by FIRST APPEARANCE. (The terrain-math
 * determinism rule does not reach rendering, but a model that shuffles its own
 * mesh order between runs would make every rendering test flaky for no
 * benefit.)
 *
 * The input geometries are disposed: they were only ever staging data, are
 * never handed to a renderer, and the merged copies are what the InstancedMesh
 * will hold. Materials are disposed for the same reason — one representative
 * per signature survives, and the shareable ones survive not at all, having
 * been replaced by the single surface material.
 */
/**
 * Step 1 on its own: the shareable parts become one vertex-coloured surface,
 * and everything else is returned UNTOUCHED — the same part objects, holding
 * the same material objects, in their authored order.
 *
 * That last property is the whole reason this is separate from mergeParts().
 * A caller that keeps handles to its own materials — Durand's keeps five, for
 * animate() to pulse — cannot survive step 2, which disposes every duplicate
 * signature and would silently drop one of two identically-authored materials
 * (the marquee's two phase groups are exactly that). Step 1 can never take a
 * held material, because canShareOneSurface() rejects everything emissive or
 * transparent, which is everything animate() drives, by construction.
 *
 * So: hold material handles → this. Hold none → mergeParts(), which reduces
 * further.
 */
export function mergeSharedSurface(parts: readonly StructurePart[]): StructurePart[] {
  const { surface, rest } = collapseSharedSurface(parts);
  return surface === null ? [...parts] : [surface, ...rest];
}

/**
 * The shareable parts of `parts` baked into one vertex-coloured surface, and
 * whatever could not join it. Returns a null surface — and `rest` as the whole
 * input — when there is nothing to gain, so neither caller special-cases it.
 *
 * The geometries and materials folded into the surface are disposed here: they
 * were staging data, never uploaded, and the surface holds their copies now.
 */
function collapseSharedSurface(
  parts: readonly StructurePart[],
): { surface: StructurePart | null; rest: readonly StructurePart[] } {
  // Carrying the narrowed material alongside the part: canShareOneSurface is a
  // type guard on the MATERIAL, and filtering a part list cannot narrow a field.
  const shareable: { part: StructurePart; material: MeshLambertMaterial }[] = [];
  for (const part of parts) {
    if (canShareOneSurface(part.material)) shareable.push({ part, material: part.material });
  }
  // Below the minimum the surface earns nothing, so those parts fall back to
  // the caller's own handling rather than being copied for no reduction.
  if (shareable.length < SURFACE_MERGE_MINIMUM_PARTS) return { surface: null, rest: parts };

  const surface: { positions: number[]; normals: number[]; colors: number[] } =
    { positions: [], normals: [], colors: [] };
  // Through Sets because a geometry or a material may back several parts, and
  // disposing one twice is a wasted call at best.
  const spentGeometries = new Set<BufferGeometry>();
  const spentMaterials = new Set<Material>();
  for (const { part, material } of shareable) {
    for (const local of part.localMatrices) bakeInto(surface, part.geometry, local, material.color);
    spentGeometries.add(part.geometry);
    spentMaterials.add(material);
  }
  for (const geometry of spentGeometries) geometry.dispose();
  for (const material of spentMaterials) material.dispose();
  return {
    surface: {
      geometry: geometryOf(surface),
      material: new MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      localMatrices: [new Matrix4()],
    },
    rest: parts.filter((part) => !canShareOneSurface(part.material)),
  };
}

export function mergeParts(parts: readonly StructurePart[]): StructurePart[] {
  const { surface, rest } = collapseSharedSurface(parts);
  const spentGeometries = new Set<BufferGeometry>();
  const spentMaterials = new Set<Material>();
  const merged: StructurePart[] = [];
  if (surface !== null) merged.push(surface);

  const groups = new Map<string, MergeGroupData & { material: Material }>();
  for (const part of rest) {
    const signature = materialSignature(part.material);
    let group = groups.get(signature);
    if (group === undefined) {
      // The uv sets come from the group's own material, and every part that
      // joins this group samples the same textures on the same channels — the
      // signature above says so, map identity and channel included.
      group = {
        material: part.material,
        positions: [],
        normals: [],
        uvs: uvArraysFor(part.material),
      };
      groups.set(signature, group);
    } else if (group.material !== part.material) {
      spentMaterials.add(part.material);
    }
    for (const local of part.localMatrices) bakeInto(group, part.geometry, local);
    spentGeometries.add(part.geometry);
  }

  for (const group of groups.values()) {
    merged.push({ geometry: geometryOf(group), material: group.material, localMatrices: [new Matrix4()] });
  }

  for (const geometry of spentGeometries) geometry.dispose();
  // A material kept as a group representative must outlive this call; only the
  // genuinely spent ones are disposed, and a shareable part's material is
  // always spent because the surface material replaced it.
  for (const material of spentMaterials) {
    if (!merged.some((part) => part.material === material)) material.dispose();
  }
  return merged;
}

/**
 * Walks every vertex of every part through its local matrices, handing each
 * world-space position to `visit`. The one place this file iterates geometry,
 * so the reach measurements below cannot drift apart.
 */
function forEachVertex(parts: readonly StructurePart[], visit: (vertex: Vector3) => void): void {
  const vertex = new Vector3();
  for (const part of parts) {
    const position = part.geometry.getAttribute('position');
    if (position === undefined) continue;
    for (const local of part.localMatrices) {
      for (let i = 0; i < position.count; i++) {
        visit(vertex.fromBufferAttribute(position as BufferAttribute, i).applyMatrix4(local));
      }
    }
  }
}

/**
 * The worst-case distance in the XZ PLANE — √(x² + z²) — any vertex sits from
 * the building's origin.
 *
 * THIS, not the axis-aligned reach below, is what decides whether a building
 * can hang over a terrace edge, because every building is drawn at a random
 * yaw (protocol.ts's structureVariation): turn a model 45° and its corner
 * swings out to its radial reach, up to √2 further than its axis-aligned one.
 * Measured 2026-08-23 across the shipped models, three tiers and Durand's
 * exceeded the axis bound once rotated — the tiers still inside the ground
 * the server surveys, Durand's not.
 */
export function partsRadialReach(parts: readonly StructurePart[]): number {
  let reach = 0;
  forEachVertex(parts, (vertex) => {
    reach = Math.max(reach, Math.hypot(vertex.x, vertex.z));
  });
  return reach;
}

/**
 * Uniformly scales a part list down — about the building's own origin — until
 * its radial reach fits `maxRadius`, and leaves it alone if it already does.
 *
 * A SAFETY NET, not a substitute for building models to size: it exists so one
 * cosmetic landmark can never render standing on ground the server has not
 * checked, whatever a later edit does to its geometry. Uniform, so the model's
 * proportions are untouched — it is the same building, slightly smaller.
 * Premultiplying the scale is what makes it uniform about the ORIGIN rather
 * than about each part's own centre; a uniform scale commutes with rotation,
 * so no part's orientation moves (see `composed` for when that stops being
 * true).
 */
export function fitToRadius(parts: readonly StructurePart[], maxRadius: number): StructurePart[] {
  const reach = partsRadialReach(parts);
  if (reach <= maxRadius || reach === 0) return parts.map((part) => part);
  // Aim a hair INSIDE the limit rather than exactly at it. Vertices live in
  // Float32Array, and the merge step bakes each matrix through that storage,
  // so a model fitted to the bound exactly lands a few parts per billion
  // outside it once rounded — physically irrelevant, but it makes "fits" a
  // coin flip for any test that asserts the bound strictly, and a guarantee
  // that holds to within rounding is not a guarantee.
  const FIT_SAFETY_MARGIN = 0.999;
  const target = maxRadius * FIT_SAFETY_MARGIN;
  const shrink = new Matrix4().makeScale(target / reach, target / reach, target / reach);
  return parts.map((part) => ({
    geometry: part.geometry,
    material: part.material,
    localMatrices: part.localMatrices.map((local) => new Matrix4().multiplyMatrices(shrink, local)),
  }));
}

/**
 * How high above its own origin the highest vertex of these parts sits — the
 * model's standing height, measured through every local matrix.
 *
 * Measured the same vertex-by-vertex way partsReach is, and for the same
 * reason: a Box3 over a rotated part over-reports a pitched roof panel, and
 * this number is compared against a stated height budget (models.ts's
 * TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS), so over-reporting would fail
 * models that fit.
 */
export function partsStandingHeight(parts: readonly StructurePart[]): number {
  let height = 0;
  forEachVertex(parts, (vertex) => {
    height = Math.max(height, vertex.y);
  });
  return height;
}

/**
 * The worst-case distance, in X or Z, any vertex of these parts sits from the
 * building's own origin — measured through every local matrix, VERTEX BY
 * VERTEX.
 *
 * Not a Box3: a bounding box over a rotated part is the AABB of an AABB, which
 * over-reports a tilted roof panel or a triangular gable end by up to 41% and
 * would fail models that actually fit. The footprint bound is worth measuring
 * exactly, because it is the one model property the SERVER has already
 * committed ground to (suitability.ts's hasClearFootprint).
 */
export function partsReach(parts: readonly StructurePart[]): number {
  let reach = 0;
  forEachVertex(parts, (vertex) => {
    reach = Math.max(reach, Math.abs(vertex.x), Math.abs(vertex.z));
  });
  return reach;
}
