import {
  Bone,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NearestFilter,
  RGBAFormat,
  Sphere,
  Vector3,
  type Material,
} from 'three';
import type { RigBlueprint } from './rigSkin.ts';

const MATRIX_ELEMENTS = 16;
const MATRIX_TEXELS = 4;

const RGBA_COMPONENTS = 4;

const POSE_SLOT_ATTRIBUTE = 'rigPoseSlot';
const POSE_PALETTE_UNIFORM = 'rigPosePalette';

const POSE_PROGRAM_KEY = 'rigHerd:posePalette';

const POSE_SHADER_PARS = `
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute float ${POSE_SLOT_ATTRIBUTE};
uniform highp sampler2D ${POSE_PALETTE_UNIFORM};

// One bone matrix, from the row this instance names and the bone named by one
// component of skinIndex. Four RGBA texels, column-major — exactly the layout
// three's own <skinning_pars_vertex> reads its bone texture with.
mat4 rigPoseBone( const in float bone, const in int row ) {
\tint col = int( bone ) * ${MATRIX_TEXELS};
\treturn mat4(
\t\ttexelFetch( ${POSE_PALETTE_UNIFORM}, ivec2( col, row ), 0 ),
\t\ttexelFetch( ${POSE_PALETTE_UNIFORM}, ivec2( col + 1, row ), 0 ),
\t\ttexelFetch( ${POSE_PALETTE_UNIFORM}, ivec2( col + 2, row ), 0 ),
\t\ttexelFetch( ${POSE_PALETTE_UNIFORM}, ivec2( col + 3, row ), 0 ) );
}

// The weighted blend of this vertex's four influences, in the pose this
// instance names. A zero weight still costs its four texel fetches: a branch
// per influence would cost more than the fetch on every GPU this runs on, and
// the fetch is from a row already resident.
mat4 rigPoseMatrix() {
\tint row = int( ${POSE_SLOT_ATTRIBUTE} );
\tmat4 blended = rigPoseBone( skinIndex.x, row ) * skinWeight.x;
\tblended += rigPoseBone( skinIndex.y, row ) * skinWeight.y;
\tblended += rigPoseBone( skinIndex.z, row ) * skinWeight.z;
\tblended += rigPoseBone( skinIndex.w, row ) * skinWeight.w;
\treturn blended;
}
`;

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

  const paletteWidth = boneCount * MATRIX_TEXELS;
  const paletteData = new Float32Array(paletteWidth * RGBA_COMPONENTS * poseRows);
  const palette = new DataTexture(paletteData, paletteWidth, poseRows, RGBAFormat, FloatType);
  palette.minFilter = NearestFilter;
  palette.magFilter = NearestFilter;
  palette.generateMipmaps = false;

  const captured = new Uint8Array(poseRows);
  let capturedThisFrame = 0;

  const instanceMatrix = new InstancedBufferAttribute(
    new Float32Array(capacity * MATRIX_ELEMENTS),
    MATRIX_ELEMENTS,
  );
  instanceMatrix.setUsage(DynamicDrawUsage);
  const instanceMatrices = instanceMatrix.array as Float32Array;

  const poseSlotAttribute = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  poseSlotAttribute.setUsage(DynamicDrawUsage);
  const slotValues = poseSlotAttribute.array as Float32Array;

  const bounds = new Sphere(new Vector3(0, 0, 0), 0);
  const meshes: InstancedMesh[] = [];
  const materials: Material[] = [];
  for (const surface of blueprint.surfaces) {
    if (surface.geometry.getAttribute(POSE_SLOT_ATTRIBUTE) !== undefined) {
      throw new Error('createRigHerd: this blueprint already drives a herd');
    }
    surface.geometry.setAttribute(POSE_SLOT_ATTRIBUTE, poseSlotAttribute);

    const material = poseSkinnedMaterial(surface.material, palette);
    materials.push(material);
    const mesh = new InstancedMesh(surface.geometry, material, capacity);
    mesh.instanceMatrix = instanceMatrix;
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

    beginFrame(): void {
      count = 0;
      maxScale = 0;
      if (capturedThisFrame > 0) {
        if (!staticPoses) captured.fill(0);
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
      if (capturedThisFrame > 0) palette.needsUpdate = true;

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
      palette.dispose();
      for (const material of materials) material.dispose();
      for (const mesh of meshes) mesh.dispose();
    },
  };
}

function poseSkinnedMaterial(source: Material, palette: DataTexture): Material {
  const material = source.clone();
  const inherited = source.onBeforeCompile;
  const inheritedKey = source.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer): void => {
    inherited.call(material, shader, renderer);
    shader.uniforms[POSE_PALETTE_UNIFORM] = { value: palette };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${POSE_SHADER_PARS}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\ttransformed = ( rigPoseMatrix() * vec4( transformed, 1.0 ) ).xyz;',
      )
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n\tobjectNormal = mat3( rigPoseMatrix() ) * objectNormal;',
      );
  };
  material.customProgramCacheKey = (): string =>
    `${inheritedKey.call(source)}|${POSE_PROGRAM_KEY}`;
  return material;
}
