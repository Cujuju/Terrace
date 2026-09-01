// Drawing a WHOLE SPECIES from one baked rig: instances, not individuals.
//
// THE DEFECT THIS EXISTS TO REMOVE. `./rigSkin.ts` collapsed the unit of
// AUTHORING (a Group per joint, a Mesh per part) into the unit of DRAWING (one
// skinned surface per material). It left one level standing: every individual
// still got a `Group`, a `Skeleton`, a `Bone` per joint and a `SkinnedMesh` per
// surface of its own. At the wildlife population cap that is ~8 300 Object3Ds
// for 850 creatures, and three walks EVERY one of them in
// `scene.updateMatrixWorld` before culling can reject anything — measured at
// 2.3–2.5 ms/frame against a 7.1 ms budget (perf review 2026-08-29, A2). Only
// removing nodes fixes that, so this module removes them: a herd of any size is
// one `InstancedMesh` per baked surface and no per-individual node at all.
//
// WHAT AN INDIVIDUAL STILL GETS, and how. Two things vary per creature: WHERE it
// is (position, heading, size class) and WHAT POSE it is in. Placement rides
// three's own `instanceMatrix`. The pose rides a small floating-point texture —
// the same shape three's own skinning uses, four RGBA texels per bone matrix —
// with ONE ROW PER POSE rather than one texture per creature, and a per-instance
// attribute naming the row. The vertex shader reads the row the instance names
// and the bone the vertex was rigidly bound to, which is exactly the product
// `SkinnedMesh` would have computed, evaluated from shared data.
//
// WHY POSES ARE SHARED, and what that costs. A creature's animation here is a
// LOOP driven by one scalar: elapsed time plus the individual's own phase
// offset. Two creatures at the same point of that loop are in the identical
// pose, byte for byte — so a herd only ever needs as many distinct poses as
// there are distinct phases it cares to tell apart. The caller picks that count
// (`poseSlots`); the cost of a frame becomes O(species × poseSlots) instead of
// O(creatures), and every creature keeps its own placement exactly. The price is
// that phase is QUANTISED to a slot: two creatures less than one slot apart on
// the cycle animate identically. The caller chooses `poseSlots` against its own
// fastest animation — see the wildlife plugin's POSE_SLOTS_PER_HERD for the
// derivation this was designed around.
//
// WHAT THE CALLER KEEPS. The animation is still written against `Bone`s —
// `herd.joints[i].rotation.z = …`, the same statement `instantiateRig` allowed —
// only it is now run once per POSE rather than once per creature, against a
// scratch rig that is never in the scene.

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

/** Floats in a 4×4 matrix, and the RGBA texels it takes to carry them. */
const MATRIX_ELEMENTS = 16;
const MATRIX_TEXELS = 4;

/** Components in one texel of an `RGBAFormat` texture. */
const RGBA_COMPONENTS = 4;

/** Name of the per-instance attribute naming a pose row, in JS and in GLSL. */
const POSE_SLOT_ATTRIBUTE = 'rigPoseSlot';
/** Name of the palette sampler uniform, in JS and in GLSL. */
const POSE_PALETTE_UNIFORM = 'rigPosePalette';

/**
 * Marker appended to every patched material's program cache key.
 *
 * `onBeforeCompile` rewrites the shader source, and three's program cache does
 * not hash that source — `customProgramCacheKey` is the only way a material can
 * declare that its program differs. Without this, a herd's material could be
 * handed the program compiled for the unpatched material it was cloned from.
 */
const POSE_PROGRAM_KEY = 'rigHerd:posePalette';

/** The declarations the patched vertex shader needs, and the palette read. */
const POSE_SHADER_PARS = `
attribute vec4 skinIndex;
attribute float ${POSE_SLOT_ATTRIBUTE};
uniform highp sampler2D ${POSE_PALETTE_UNIFORM};

// One bone matrix, from the row this instance names and the bone this vertex
// was rigidly bound to. Four RGBA texels, column-major — exactly the layout
// three's own <skinning_pars_vertex> reads its bone texture with.
mat4 rigPoseMatrix() {
\tint col = int( skinIndex.x ) * ${MATRIX_TEXELS};
\tint row = int( ${POSE_SLOT_ATTRIBUTE} );
\treturn mat4(
\t\ttexelFetch( ${POSE_PALETTE_UNIFORM}, ivec2( col, row ), 0 ),
\t\ttexelFetch( ${POSE_PALETTE_UNIFORM}, ivec2( col + 1, row ), 0 ),
\t\ttexelFetch( ${POSE_PALETTE_UNIFORM}, ivec2( col + 2, row ), 0 ),
\t\ttexelFetch( ${POSE_PALETTE_UNIFORM}, ivec2( col + 3, row ), 0 ) );
}
`;

const TWO_PI = Math.PI * 2;

export interface RigHerdOptions {
  /** The most individuals this herd will ever be asked to draw in one frame. */
  readonly capacity: number;
  /** Distinct poses one frame may hold. See the header: this quantises phase. */
  readonly poseSlots: number;
}

export interface RigHerd {
  /**
   * The drawn objects — ONE PER BAKED SURFACE, whatever the population. Added
   * to a scene once, by the caller, and never re-parented.
   */
  readonly meshes: readonly InstancedMesh[];
  /**
   * The scratch rig the caller animates, in the blueprint's joint order. Not in
   * the scene and never drawn: posing it and calling `capturePose` is how a
   * pose reaches the palette.
   */
  readonly joints: readonly Bone[];
  /** Forgets last frame's individuals and poses. Call once per frame, first. */
  beginFrame(): void;
  /** The pose row a creature with this phase offset (radians) is drawn from. */
  poseSlotOf(phase: number): number;
  /** The phase (radians) the caller should pose the joints at for this row. */
  poseSlotPhase(slot: number): number;
  /** Whether this frame still needs the caller to pose and capture this row. */
  needsPose(slot: number): boolean;
  /** Copies the scratch rig's current pose into `slot`. */
  capturePose(slot: number): void;
  /**
   * Draws one individual at a world position, yaw and uniform scale, in the
   * pose held by `slot`. Beyond `capacity` the individual is DROPPED rather
   * than allowed to overrun the buffers — a creature that is not drawn is a
   * smaller failure than a frame that throws, and the caller's own population
   * cap is what keeps it from happening.
   */
  place(slot: number, x: number, y: number, z: number, yaw: number, scale: number): void;
  /** Uploads the frame's poses and placements. Call once per frame, last. */
  endFrame(): void;
  /** Frees the palette and the materials this herd created. */
  dispose(): void;
}

/**
 * Builds the drawables and the shared pose palette for one baked rig.
 *
 * The blueprint's surface geometries gain a per-instance attribute, so a
 * blueprint feeds exactly ONE herd; a second call on the same blueprint throws
 * rather than let two herds fight over one attribute buffer.
 */
export function createRigHerd(blueprint: RigBlueprint, options: RigHerdOptions): RigHerd {
  const { capacity, poseSlots } = options;
  if (capacity <= 0) throw new Error('createRigHerd: capacity must be positive');
  if (poseSlots <= 0) throw new Error('createRigHerd: poseSlots must be positive');

  const boneCount = blueprint.jointCount;

  // The scratch rig: one Bone per joint at its rest transform, UNPARENTED. The
  // tree is expressed by the descriptors' parent indices and walked flat below
  // (bakeRig collects depth-first, so a parent always precedes its children),
  // which is both cheaper than Object3D.updateMatrixWorld and immune to anyone
  // adding these to a scene by accident.
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

  // The palette: one ROW per pose slot, MATRIX_TEXELS texels per bone.
  const paletteWidth = boneCount * MATRIX_TEXELS;
  const paletteData = new Float32Array(paletteWidth * RGBA_COMPONENTS * poseSlots);
  const palette = new DataTexture(paletteData, paletteWidth, poseSlots, RGBAFormat, FloatType);
  // Nearest and no mipmaps: this is a lookup table read with texelFetch, not an
  // image — any filtering would blend two unrelated bone matrices.
  palette.minFilter = NearestFilter;
  palette.magFilter = NearestFilter;
  palette.generateMipmaps = false;

  const captured = new Uint8Array(poseSlots);
  let capturedThisFrame = 0;

  // ONE attribute per herd, shared by every surface — deliberately. three's
  // WebGLAttributes keys its GPU buffers by attribute identity, so a rig that
  // bakes to two surfaces uploads one copy of the placements and one of the
  // slots, not two.
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
    // Ours, refreshed in endFrame from the individuals actually placed. Set
    // here so three never falls back to InstancedMesh.computeBoundingSphere,
    // which walks every instance matrix.
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

  return {
    meshes,
    joints,

    beginFrame(): void {
      count = 0;
      maxScale = 0;
      if (capturedThisFrame > 0) {
        captured.fill(0);
        capturedThisFrame = 0;
      }
    },

    poseSlotOf(phase: number): number {
      // Phase is an unbounded offset in radians (the caller's is a golden-angle
      // multiple of an entity id), so fold it onto one cycle before slotting.
      const cycles = phase / TWO_PI;
      const fraction = cycles - Math.floor(cycles);
      const slot = Math.floor(fraction * poseSlots);
      // Guard the float edge: `fraction` can round to exactly 1 for a large phase.
      return slot < 0 ? 0 : slot >= poseSlots ? poseSlots - 1 : slot;
    },

    poseSlotPhase(slot: number): number {
      return (slot / poseSlots) * TWO_PI;
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
        // The bind-pose inverse undoes the transform the vertices were baked
        // with, exactly as Skeleton.update does — see rigSkin.bakeRig.
        boneScratch.multiplyMatrices(world, blueprint.boneInverses[i]!);
        paletteData.set(boneScratch.elements, target);
        target += MATRIX_ELEMENTS;
      }
      captured[slot] = 1;
      capturedThisFrame++;
    },

    place(slot: number, x: number, y: number, z: number, yaw: number, scale: number): void {
      if (count >= capacity) return;
      // Written straight into the buffer rather than through Matrix4.compose:
      // the transform is only ever a yaw, a uniform scale and a translation, so
      // a quaternion round trip would be arithmetic with a known answer. The
      // layout is three's — column-major, translation in the last column.
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
      count++;
    },

    endFrame(): void {
      if (capturedThisFrame > 0) palette.needsUpdate = true;

      // The herd's own bound: the box its individuals' origins span, plus the
      // pose-invariant reach of one creature at the largest scale drawn (see
      // rigSkin.poseInvariantReach — that radius holds for every pose, which is
      // what lets frustum culling stay on).
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
      // Ranged, so a herd well under capacity does not upload the whole buffer
      // every frame.
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

/**
 * A copy of a baked surface's material that poses its vertices from the palette.
 *
 * The bone product is applied to POSITION and NORMAL and nothing else, which is
 * what three's own `<skinning_vertex>` does — and it is applied INSIDE the
 * instance transform, because `<project_vertex>` multiplies `transformed` by
 * `instanceMatrix` afterwards. So a creature is posed in rig space and then
 * placed, exactly as a `SkinnedMesh` under a placed root was.
 */
function poseSkinnedMaterial(source: Material, palette: DataTexture): Material {
  const material = source.clone();
  // THE SHADER HOOKS DO NOT SURVIVE A CLONE (see rigSkin.vertexColoured, which
  // learned this the same way). Chained rather than replaced: a material that
  // rewrites its own shader must still mean what it meant unposed.
  const inherited = source.onBeforeCompile;
  const inheritedKey = source.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer): void => {
    inherited.call(material, shader, renderer);
    shader.uniforms[POSE_PALETTE_UNIFORM] = { value: palette };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${POSE_SHADER_PARS}`)
      // Appended to the stock chunks rather than replacing them, so the
      // branches they carry (alpha hash, tangents) keep working. Both chunks
      // read the palette for themselves: MeshBasicMaterial guards
      // <beginnormal_vertex> behind USE_ENVMAP, so neither may depend on the
      // other having run.
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\ttransformed = ( rigPoseMatrix() * vec4( transformed, 1.0 ) ).xyz;',
      )
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n\tobjectNormal = mat3( rigPoseMatrix() ) * objectNormal;',
      );
  };
  // Asked of the SOURCE, not of the clone. three's default implementation is
  // `this.onBeforeCompile.toString()`, so asking the clone would stringify the
  // patch below and answer with a page of our own source — the question this
  // half of the key means to ask is what the material declared BEFORE it was
  // patched, and only the source can still answer that.
  material.customProgramCacheKey = (): string =>
    `${inheritedKey.call(source)}|${POSE_PROGRAM_KEY}`;
  return material;
}
