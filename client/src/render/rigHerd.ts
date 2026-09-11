import { Bone, InstancedBufferAttribute, InstancedMesh, Matrix4, Sphere, Vector3 } from 'three';
import {
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  type Node,
  type NodeMaterial,
  type StorageBufferNode,
} from 'three/webgpu';
import { Fn, attribute, int, normalLocal, storage, vec4 } from 'three/tsl';
import { instanceMatrix as instanceMatrixNode } from './instanceMatrix.ts';
import { compose } from './materialSlots.ts';
import { toNodeMaterial } from './nodeMaterialFrom.ts';
import type { RigBlueprint } from './rigSkin.ts';

const MATRIX_ELEMENTS = 16;

const POSE_SLOT_ATTRIBUTE = 'rigPoseSlot';

const TWO_PI = Math.PI * 2;

export interface RigHerdOptions {
  readonly capacity: number;
  readonly poseSlots: number;
  readonly poseVariants?: number;
  readonly staticPoses?: boolean;
}

export interface RigHerd {
  readonly meshes: readonly InstancedMesh[];
  readonly joints: readonly Bone[];
  readonly posePalette: StorageBufferAttribute;
  beginFrame(): void;
  poseSlotOf(phase: number, variant?: number): number;
  poseSlotPhase(slot: number): number;
  needsPose(slot: number): boolean;
  capturePose(slot: number): void;
  place(slot: number, x: number, y: number, z: number, yaw: number, scale: number): void;
  placeMatrix(slot: number, matrix: Matrix4, reach: number): void;
  endFrame(): void;
  dispose(): void;
}

export function createRigHerd(blueprint: RigBlueprint, options: RigHerdOptions): RigHerd {
  const { capacity, poseSlots, poseVariants = 1, staticPoses = false } = options;
  if (capacity <= 0) throw new Error('createRigHerd: capacity must be positive');
  if (poseSlots <= 0) throw new Error('createRigHerd: poseSlots must be positive');
  if (poseVariants <= 0) throw new Error('createRigHerd: poseVariants must be positive');
  const poseRows = poseSlots * poseVariants;

  const boneCount = blueprint.jointCount;

  const joints: Bone[] = [];
  const parents: number[] = [];
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
    parents.push(descriptor.parent);
  }
  const boneWorlds = joints.map(() => new Matrix4());
  const boneScratch = new Matrix4();

  // One row of boneCount mat4s per pose slot; only rows captured this frame are uploaded.
  const rowElements = boneCount * MATRIX_ELEMENTS;
  const palette = new StorageBufferAttribute(poseRows * boneCount, MATRIX_ELEMENTS);
  const paletteData = palette.array as Float32Array;

  const captured = new Uint8Array(poseRows);
  const capturedRows = new Uint8Array(poseRows);
  let capturedThisFrame = 0;

  const instanceMatrix = new StorageInstancedBufferAttribute(capacity, MATRIX_ELEMENTS);
  const instanceMatrices = instanceMatrix.array as Float32Array;

  const poseSlotAttribute = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const slotValues = poseSlotAttribute.array as Float32Array;

  const bounds = new Sphere(new Vector3(0, 0, 0), 0);
  const meshes: InstancedMesh[] = [];
  const materials: NodeMaterial[] = [];
  for (const surface of blueprint.surfaces) {
    if (surface.geometry.getAttribute(POSE_SLOT_ATTRIBUTE) !== undefined) {
      throw new Error('createRigHerd: this blueprint already drives a herd');
    }
    surface.geometry.setAttribute(POSE_SLOT_ATTRIBUTE, poseSlotAttribute);

    const material = toNodeMaterial(surface.material.clone());
    materials.push(material);
    const mesh = new InstancedMesh(surface.geometry, material, capacity);
    mesh.instanceMatrix = instanceMatrix;
    poseSkin(material, mesh, palette, boneCount);
    mesh.count = 0;
    mesh.boundingSphere = bounds;
    meshes.push(mesh);
  }

  let count = 0;
  let minX = 0;
  let minY = 0;
  let minZ = 0;
  let maxX = 0;
  let maxY = 0;
  let maxZ = 0;
  let maxScale = 0;

  function noteBounds(x: number, y: number, z: number, scale: number): void {
    if (count === 0) {
      minX = maxX = x;
      minY = maxY = y;
      minZ = maxZ = z;
    } else {
      if (x < minX) minX = x;
      else if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      else if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      else if (z > maxZ) maxZ = z;
    }
    if (scale > maxScale) maxScale = scale;
  }

  return {
    meshes,
    joints,
    posePalette: palette,

    beginFrame(): void {
      count = 0;
      maxScale = 0;
      if (capturedThisFrame > 0) {
        if (!staticPoses) captured.fill(0);
        capturedRows.fill(0);
        palette.clearUpdateRanges();
        capturedThisFrame = 0;
      }
    },

    poseSlotOf(phase: number, variant: number = 0): number {
      const cycles = phase / TWO_PI;
      const fraction = cycles - Math.floor(cycles);
      const withinVariant = Math.floor(fraction * poseSlots);
      const slot =
        withinVariant < 0 ? 0 : withinVariant >= poseSlots ? poseSlots - 1 : withinVariant;
      const band = variant > 0 && variant < poseVariants ? Math.floor(variant) : 0;
      return band * poseSlots + slot;
    },

    poseSlotPhase(slot: number): number {
      return ((slot % poseSlots) / poseSlots) * TWO_PI;
    },

    needsPose(slot: number): boolean {
      return captured[slot] === 0;
    },

    capturePose(slot: number): void {
      let target = slot * boneCount * MATRIX_ELEMENTS;
      for (let i = 0; i < boneCount; i++) {
        const bone = joints[i]!;
        bone.updateMatrix();
        const world = boneWorlds[i]!;
        const parent = parents[i]!;
        if (parent < 0) world.copy(bone.matrix);
        else world.multiplyMatrices(boneWorlds[parent]!, bone.matrix);
        boneScratch.multiplyMatrices(world, blueprint.boneInverses[i]!);
        paletteData.set(boneScratch.elements, target);
        target += MATRIX_ELEMENTS;
      }
      captured[slot] = 1;
      capturedRows[slot] = 1;
      capturedThisFrame++;
    },

    place(slot: number, x: number, y: number, z: number, yaw: number, scale: number): void {
      if (count >= capacity) return;
      const cos = Math.cos(yaw) * scale;
      const sin = Math.sin(yaw) * scale;
      const at = count * MATRIX_ELEMENTS;
      instanceMatrices[at] = cos;
      instanceMatrices[at + 1] = 0;
      instanceMatrices[at + 2] = -sin;
      instanceMatrices[at + 3] = 0;
      instanceMatrices[at + 4] = 0;
      instanceMatrices[at + 5] = scale;
      instanceMatrices[at + 6] = 0;
      instanceMatrices[at + 7] = 0;
      instanceMatrices[at + 8] = sin;
      instanceMatrices[at + 9] = 0;
      instanceMatrices[at + 10] = cos;
      instanceMatrices[at + 11] = 0;
      instanceMatrices[at + 12] = x;
      instanceMatrices[at + 13] = y;
      instanceMatrices[at + 14] = z;
      instanceMatrices[at + 15] = 1;
      slotValues[count] = slot;
      noteBounds(x, y, z, scale);
      count++;
    },

    placeMatrix(slot: number, matrix: Matrix4, reach: number): void {
      if (count >= capacity) return;
      const at = count * MATRIX_ELEMENTS;
      instanceMatrices.set(matrix.elements, at);
      slotValues[count] = slot;
      noteBounds(matrix.elements[12]!, matrix.elements[13]!, matrix.elements[14]!, reach);
      count++;
    },

    endFrame(): void {
      if (capturedThisFrame > 0) {
        addCapturedRowRanges(palette, capturedRows, rowElements);
        palette.needsUpdate = true;
      }

      const halfX = (maxX - minX) / 2;
      const halfY = (maxY - minY) / 2;
      const halfZ = (maxZ - minZ) / 2;
      bounds.center.set(minX + halfX, minY + halfY, minZ + halfZ);
      bounds.radius =
        count === 0
          ? 0
          : Math.sqrt(halfX * halfX + halfY * halfY + halfZ * halfZ) +
            blueprint.bounds.radius * maxScale;

      for (const mesh of meshes) mesh.count = count;
      if (count === 0) return;
      instanceMatrix.clearUpdateRanges();
      instanceMatrix.addUpdateRange(0, count * MATRIX_ELEMENTS);
      instanceMatrix.needsUpdate = true;
      poseSlotAttribute.clearUpdateRanges();
      poseSlotAttribute.addUpdateRange(0, count);
      poseSlotAttribute.needsUpdate = true;
    },

    dispose(): void {
      for (const material of materials) material.dispose();
      for (const mesh of meshes) mesh.dispose();
    },
  };
}

// Each run of captured rows becomes one update range, so a frame uploads a few
// contiguous writes instead of the whole palette.
function addCapturedRowRanges(
  palette: StorageBufferAttribute,
  capturedRows: Uint8Array,
  rowElements: number,
): void {
  let runStart = -1;
  for (let row = 0; row <= capturedRows.length; row++) {
    const hit = row < capturedRows.length && capturedRows[row] === 1;
    if (hit && runStart < 0) runStart = row;
    if (!hit && runStart >= 0) {
      palette.addUpdateRange(runStart * rowElements, (row - runStart) * rowElements);
      runStart = -1;
    }
  }
}

// One bone matrix, from the row this instance names and the bone named by one
// component of skinIndex.
function poseBone(
  palette: StorageBufferNode<'mat4'>,
  bone: Node<'float'>,
  row: Node<'int'>,
  boneCount: number,
): Node<'mat4'> {
  return palette.element(row.mul(boneCount).add(int(bone)));
}

// The weighted blend of this vertex's four influences, in the pose this instance
// names. A zero weight still costs its matrix fetch; a branch would cost more.
function poseMatrix(palette: StorageBufferNode<'mat4'>, boneCount: number): Node<'mat4'> {
  const row = int(attribute<'float'>(POSE_SLOT_ATTRIBUTE, 'float'));
  const index = attribute<'vec4'>('skinIndex', 'vec4');
  const weight = attribute<'vec4'>('skinWeight', 'vec4');
  return poseBone(palette, index.x, row, boneCount)
    .mul(weight.x)
    .add(poseBone(palette, index.y, row, boneCount).mul(weight.y))
    .add(poseBone(palette, index.z, row, boneCount).mul(weight.z))
    .add(poseBone(palette, index.w, row, boneCount).mul(weight.w));
}

// three has already placed positionLocal by the instance matrix when the slot runs, so the
// pose is applied to the raw vertex and the instance transform re-applied outside it.
function poseSkin(
  material: NodeMaterial,
  mesh: InstancedMesh,
  palette: StorageBufferAttribute,
  boneCount: number,
): void {
  compose(material, 'position', () =>
    Fn(() => {
      const pose = poseMatrix(storage(palette, 'mat4', palette.count), boneCount);
      const instance = instanceMatrixNode(mesh);
      const normal = attribute<'vec3'>('normal', 'vec3');
      normalLocal.assign(instance.mul(pose.mul(vec4(normal, 0))).xyz);
      return instance.mul(pose.mul(vec4(attribute<'vec3'>('position', 'vec3'), 1))).xyz;
    })(),
  );
}
