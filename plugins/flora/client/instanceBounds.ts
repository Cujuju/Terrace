import { Sphere, type BufferAttribute, type BufferGeometry, type InstancedMesh } from 'three';

export const MATRIX_FLOATS_PER_INSTANCE = 16;

export const COLOR_FLOATS_PER_INSTANCE = 3;

export interface InstanceReach {
  readonly horizontal: number;
  readonly up: number;
  readonly down: number;
}

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

export function scaledReach(reach: InstanceReach, scale: number): InstanceReach {
  return {
    horizontal: reach.horizontal * scale,
    up: reach.up * scale,
    down: reach.down * scale,
  };
}

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

export function uploadAllInstances(
  attribute: BufferAttribute,
  instanceCount: number,
  floatsPerInstance: number,
): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, instanceCount * floatsPerInstance);
  attribute.needsUpdate = true;
}

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
