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
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Material,
} from 'three';

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
    lambertLike.color?.getHex() ?? -1,
    lambertLike.emissive?.getHex() ?? -1,
    lambertLike.emissiveIntensity ?? 1,
    lambertLike.flatShading === true ? 1 : 0,
    material.transparent === true ? 1 : 0,
    material.opacity,
    material.side,
  ].join('|');
}

/** Position + normal of one geometry, baked through one local matrix. */
function bakeInto(
  target: { positions: number[]; normals: number[] },
  geometry: BufferGeometry,
  local: Matrix4,
): void {
  // toNonIndexed() first: two geometries cannot be concatenated attribute-wise
  // while either carries an index buffer, and the vertex count here is small
  // enough (a whole hut is a few thousand) that de-indexing costs nothing that
  // matters. Flat shading already discards the vertex sharing anyway.
  const baked = (geometry.index === null ? geometry.clone() : geometry.toNonIndexed());
  baked.applyMatrix4(local); // transforms positions AND rotates normals
  const position = baked.getAttribute('position');
  const normal = baked.getAttribute('normal');
  for (let i = 0; i < position.count; i++) {
    target.positions.push(position.getX(i), position.getY(i), position.getZ(i));
    if (normal !== undefined) target.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
  }
  baked.dispose();
}

/**
 * Collapses an authored part list into one part per distinct material, with
 * every local matrix baked into the vertices — see the banner above for why.
 *
 * Group order is FIRST APPEARANCE of each material signature, so the output
 * is deterministic for a given input list (the terrain-math determinism rule
 * does not reach rendering, but a model that shuffles its own mesh order
 * between runs would make every rendering test flaky for no benefit).
 *
 * The input geometries are disposed: they were only ever staging data, are
 * never handed to a renderer, and the merged copies are what the InstancedMesh
 * will hold. Duplicate materials are disposed for the same reason — one
 * representative per signature survives into the returned list.
 */
export function mergeParts(parts: readonly StructurePart[]): StructurePart[] {
  const groups = new Map<string, {
    material: Material;
    positions: number[];
    normals: number[];
  }>();
  const spentGeometries = new Set<BufferGeometry>();
  const spentMaterials = new Set<Material>();

  for (const part of parts) {
    const signature = materialSignature(part.material);
    let group = groups.get(signature);
    if (group === undefined) {
      group = { material: part.material, positions: [], normals: [] };
      groups.set(signature, group);
    } else if (group.material !== part.material) {
      spentMaterials.add(part.material);
    }
    for (const local of part.localMatrices) bakeInto(group, part.geometry, local);
    spentGeometries.add(part.geometry);
  }

  for (const geometry of spentGeometries) geometry.dispose();
  for (const material of spentMaterials) material.dispose();

  const merged: StructurePart[] = [];
  for (const group of groups.values()) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(group.positions), 3));
    if (group.normals.length === group.positions.length) {
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(group.normals), 3));
    } else {
      geometry.computeVertexNormals();
    }
    merged.push({ geometry, material: group.material, localMatrices: [new Matrix4()] });
  }
  return merged;
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
  const vertex = new Vector3();
  let reach = 0;
  for (const part of parts) {
    const position = part.geometry.getAttribute('position');
    if (position === undefined) continue;
    for (const local of part.localMatrices) {
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position as BufferAttribute, i).applyMatrix4(local);
        reach = Math.max(reach, Math.abs(vertex.x), Math.abs(vertex.z));
      }
    }
  }
  return reach;
}
