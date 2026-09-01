// What every flora rig has to do after it writes instance matrices, factored
// out of the five places that were each doing it wrong in the same two ways
// (GH #257, #262).
//
// THE TWO JOBS, and why they belong together in one module rather than in each
// rig:
//
//   1. THE BOUNDING SPHERE. `InstancedMesh.computeBoundingSphere()` reads back
//      every matrix the rig just wrote — `getMatrixAt` (a 16-float copy) plus a
//      sphere transform plus a union, per instance, with no early-out. At the
//      meadow's real population that is ~7 ms of re-deriving an extent the
//      placement loop already knew. The sphere is genuinely consumed (none of
//      these rigs disables `frustumCulled`), so it has to be computed CHEAPLY,
//      not dropped: the placements give the box the plants stand in, and the
//      built geometry gives the reach one plant adds around its own origin.
//      `client/src/render/water.ts`, `terrainMeshes.ts`, `riverRig.ts` and
//      `frontierFog.ts` all already do exactly this substitution.
//
//   2. THE UPLOAD RANGE. three's `WebGLAttributes.updateBuffer` takes the
//      "whole array" branch whenever `updateRanges` is empty, and `mesh.count`
//      is never consulted — so a rig allocated at its CAP re-uploads the CAP
//      every time it touches one instance (28 MB for the meadow, 10 MB for the
//      fringe). `addUpdateRange` indexes by array ELEMENT, not by instance,
//      which is the unit slip these helpers exist to make impossible.
//      Precedent: `plugins/volcanoes/client/lavaFlow.ts:557-563`.
//
// Pure arithmetic and three's own types — no plugin state, so a rig can call
// these from a full rebuild and from a per-cell delta alike.

import { Sphere, type BufferAttribute, type BufferGeometry, type InstancedMesh } from 'three';

/** Floats per instance in `InstancedMesh.instanceMatrix` — one `Matrix4`. */
export const MATRIX_FLOATS_PER_INSTANCE = 16;

/** Floats per instance in `InstancedMesh.instanceColor` — one RGB triple. */
export const COLOR_FLOATS_PER_INSTANCE = 3;

/**
 * How far one instance reaches from its own origin, in the mesh's LOCAL space,
 * as a yaw-invariant pad: instances are placed with a rotation about Y only, so
 * a horizontal radius and a vertical rise/drop describe every orientation the
 * rig can produce.
 */
export interface InstanceReach {
  /** Radius in the XZ plane, world units. */
  readonly horizontal: number;
  /** Rise above the placement's ground Y, world units. Never negative. */
  readonly up: number;
  /** Drop below the placement's ground Y, world units. Never negative. */
  readonly down: number;
}

/**
 * The reach of a built geometry about its own origin.
 *
 * The horizontal term is the furthest BOX CORNER, not the box's half-extent:
 * yaw can swing any corner onto any axis, so the corner distance is the only
 * bound that survives an arbitrary rotation about Y. Slightly loose against the
 * true swept shape, and loose in the safe direction — a sphere that is a few
 * per cent too big culls a little less, where one that is too small makes the
 * population vanish at the screen edge.
 */
export function geometryReach(geometry: BufferGeometry): InstanceReach {
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (box === null) return { horizontal: 0, up: 0, down: 0 };

  const horizontal = Math.max(
    Math.hypot(box.min.x, box.min.z),
    Math.hypot(box.min.x, box.max.z),
    Math.hypot(box.max.x, box.min.z),
    Math.hypot(box.max.x, box.max.z),
  );
  return {
    horizontal,
    up: Math.max(0, box.max.y),
    down: Math.max(0, -box.min.y),
  };
}

/**
 * A clustered rig's reach: its geometry is planted at lattice points spread
 * around the plant's centre, and each copy carries a per-instance height roll.
 * `extraHorizontal` is that planting spread in world units; `upFactor` is the
 * tallest height roll (1 + the rig's height spread).
 */
export function clusteredReach(
  stem: InstanceReach,
  extraHorizontal: number,
  upFactor: number,
): InstanceReach {
  return {
    horizontal: stem.horizontal + extraHorizontal,
    up: stem.up * upFactor,
    down: stem.down * upFactor,
  };
}

/** The same reach at the rig's largest per-plant scale — every axis scales together. */
export function scaledReach(reach: InstanceReach, scale: number): InstanceReach {
  return {
    horizontal: reach.horizontal * scale,
    up: reach.up * scale,
    down: reach.down * scale,
  };
}

/**
 * The axis-aligned box the PLACEMENTS stand in — one point per plant, not one
 * per instance, which is the whole saving. Mutable and reused across rebuilds:
 * a rig owns exactly one of these per mesh group.
 */
export interface PlacementExtent {
  empty: boolean;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export function createPlacementExtent(): PlacementExtent {
  return { empty: true, minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
}

export function clearPlacementExtent(extent: PlacementExtent): void {
  extent.empty = true;
}

/** Grows the box to contain one placement's ground point. */
export function includePlacement(
  extent: PlacementExtent,
  x: number,
  y: number,
  z: number,
): void {
  if (extent.empty) {
    extent.empty = false;
    extent.minX = extent.maxX = x;
    extent.minY = extent.maxY = y;
    extent.minZ = extent.maxZ = z;
    return;
  }
  if (x < extent.minX) extent.minX = x;
  else if (x > extent.maxX) extent.maxX = x;
  if (y < extent.minY) extent.minY = y;
  else if (y > extent.maxY) extent.maxY = y;
  if (z < extent.minZ) extent.minZ = z;
  else if (z > extent.maxZ) extent.maxZ = z;
}

/**
 * Writes the mesh's culling sphere from the placement box plus one plant's
 * reach — the substitution `computeBoundingSphere()` is being spared.
 *
 * An EMPTY extent leaves an empty sphere, which is exactly what three's own
 * `computeBoundingSphere` leaves for `count === 0`, so a rig with nothing
 * standing behaves as it did before.
 */
export function writeInstanceSphere(
  mesh: InstancedMesh,
  extent: PlacementExtent,
  reach: InstanceReach,
): void {
  if (mesh.boundingSphere === null) mesh.boundingSphere = new Sphere();
  const sphere = mesh.boundingSphere;
  if (extent.empty) {
    sphere.makeEmpty();
    return;
  }

  const minX = extent.minX - reach.horizontal;
  const maxX = extent.maxX + reach.horizontal;
  const minY = extent.minY - reach.down;
  const maxY = extent.maxY + reach.up;
  const minZ = extent.minZ - reach.horizontal;
  const maxZ = extent.maxZ + reach.horizontal;

  sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  sphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
}

/**
 * Marks the whole live population for upload and nothing beyond it — the
 * replacement for a bare `needsUpdate = true` on a CAP-sized buffer.
 *
 * Clears first: a full rewrite supersedes whatever per-slot ranges a delta had
 * queued since the last render.
 */
export function uploadAllInstances(
  attribute: BufferAttribute,
  instanceCount: number,
  floatsPerInstance: number,
): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, instanceCount * floatsPerInstance);
  attribute.needsUpdate = true;
}

/**
 * Marks one run of instances for upload, ACCUMULATING with any run already
 * queued this frame — three merges adjacent and overlapping ranges itself when
 * it uploads, then clears them, so a delta may queue one run per touched slot.
 */
export function uploadInstanceRun(
  attribute: BufferAttribute,
  firstInstance: number,
  instanceCount: number,
  floatsPerInstance: number,
): void {
  if (instanceCount <= 0) return;
  attribute.addUpdateRange(firstInstance * floatsPerInstance, instanceCount * floatsPerInstance);
  attribute.needsUpdate = true;
}
