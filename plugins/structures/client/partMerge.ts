// Collapsing a building's PARTS into one drawable.
//
// A building is authored in ./models.ts as a small fixed list of parts — a
// wall, a roof, a door, a ring of stones — each with its own geometry, its own
// colour and one or more local transforms. Until this module existed that was
// also how a building was DRAWN: one InstancedMesh per (tier, part), ~108 of
// them across the six tiers plus Durand's and the site variants. That is the
// same mistake the terrain made by drawing one mesh per chunk — the unit of
// AUTHORING had become the unit of DRAWING — and a real GPU charges per draw
// call, not per part (measured 2026-08-21: the terrain super-mesh cut 647 draw
// calls to 240 and frame time by ~31% on an RTX 3090).
//
// A part's colour is the only thing that made it a separate draw call, and a
// colour is expressible PER VERTEX. So every part whose material is a plain
// opaque flat-shaded Lambert surface is baked once — its geometry cloned per
// local transform, painted with its material's colour, and merged — into a
// single geometry drawn with one shared vertex-coloured material. What comes
// back is still a StructurePart list, so models.ts's instancing, capacity,
// per-race tinting and dispose paths are untouched: the merged surface is
// simply a part with one identity transform.
//
// Parts a merged surface cannot reproduce exactly — lit windows, the campfire,
// the harbour beacon, Durand's whole animated sign — keep their own mesh. See
// canShareOneSurface for why that is asked of the MATERIAL rather than declared
// by a flag on each of the hundred part literals in models.ts.
//
// The trade is the same one the terrain super-mesh made: coarser frustum
// culling. It costs nothing here — every mesh in this plugin already spans
// every building of its tier across the whole world, so a merged part's
// bounding sphere is no larger than the ones it replaced.
//
// THIS FILE TOUCHES NO DOM AND NO WEBGL, deliberately: models.ts builds
// Durand's sign texture from a `document` canvas at module init and so cannot
// be imported outside a browser, while everything below is plain Three.js data
// structures. That is what lets ../test/partMerge.test.ts assert this contract
// headlessly, the way plugins/boats/test/models.test.ts asserts its own.

import {
  BufferAttribute,
  FrontSide,
  Matrix4,
  MeshLambertMaterial,
  type BufferGeometry,
  type Color,
  type Material,
} from 'three';
// Shipped inside the `three` package itself (see its package.json "exports"),
// not a separate dependency.
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** One (geometry, material, local transforms) triple — the shape a building is authored as. */
export interface StructurePart {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** One matrix per instance this part contributes, per building of this tier. */
  readonly localMatrices: Matrix4[];
}

/** RGB channels per vertex in a `color` buffer attribute. */
const COLOR_COMPONENTS = 3;

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
  // A texture needs its own UV space and the merge has no atlas (Durand's sign).
  if (material.map !== null) return false;
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
 * Bakes every mergeable part of one building into a single geometry, and
 * returns that merged part followed by the parts that had to stay their own
 * draw call. Order within the un-merged tail is preserved; the merged surface
 * is always first.
 *
 * Called once per tier at model-build time, never per frame.
 */
export function mergeSurfaceParts(parts: readonly StructurePart[]): StructurePart[] {
  const surface: { readonly part: StructurePart; readonly color: Color }[] = [];
  const rest: StructurePart[] = [];
  for (const part of parts) {
    if (canShareOneSurface(part.material)) surface.push({ part, color: part.material.color });
    else rest.push(part);
  }
  // One mergeable part is already one draw call; merging it would only cost a
  // colour attribute and a geometry copy for no reduction at all.
  if (surface.length < 2) return [...parts];

  const baked: BufferGeometry[] = [];
  for (const { part, color } of surface) {
    for (const local of part.localMatrices) {
      // The local transform is baked into the vertices here — that is the whole
      // point: after the merge a building places ONE instance, not one per part
      // per local transform.
      const geometry = part.geometry.clone().applyMatrix4(local);
      const vertexCount = geometry.getAttribute('position').count;
      const colors = new Float32Array(vertexCount * COLOR_COMPONENTS);
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        // NO COLOUR-SPACE CONVERSION HERE, DELIBERATELY. A Material.color is
        // already in the renderer's LINEAR working space (three converts the
        // authored sRGB hex on construction), and a `color` buffer attribute is
        // read as linear too — so the channels copy across verbatim. Converting
        // would apply the sRGB transfer a second time and wash every building
        // out.
        colors[vertex * COLOR_COMPONENTS] = color.r;
        colors[vertex * COLOR_COMPONENTS + 1] = color.g;
        colors[vertex * COLOR_COMPONENTS + 2] = color.b;
      }
      geometry.setAttribute('color', new BufferAttribute(colors, COLOR_COMPONENTS));
      baked.push(geometry);
    }
  }

  // Widened on purpose: mergeGeometries returns null on incompatible inputs,
  // which the shipped .d.ts does not admit (it declares BufferGeometry). The
  // annotation is what lets the guard below exist at all.
  const merged: BufferGeometry | null = mergeGeometries(baked, false);
  if (merged === null) {
    // Only reachable if a part arrives with a different attribute set than the
    // rest — loud at boot beats a tier quietly missing from the world.
    throw new Error('structures: could not merge a tier surface — parts have incompatible attributes');
  }
  // Clones, never uploaded to the GPU; mergeGeometries has copied their data.
  for (const geometry of baked) geometry.dispose();

  const surfaceMaterial = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return [{ geometry: merged, material: surfaceMaterial, localMatrices: [new Matrix4()] }, ...rest];
}
