import {
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { MeshLambertNodeMaterial, type NodeMaterial } from 'three/webgpu';
import {
  attribute,
  cameraViewMatrix,
  cos,
  dot,
  float,
  fract,
  max,
  mix,
  normalize,
  pow,
  sin,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { CYCLONE_EYE_RADIUS_FRACTION, CYCLONE_RADIUS_CELLS } from '../protocol.ts';
import {
  PUFF_QUAD,
  puffAlphaDiscard,
  puffBillboard,
  puffMask,
} from '../../../client/src/plugins/kit/puffDeck.ts';
import {
  DECK_BASE_WORLD_Y,
  DECK_RENDER_ORDER_CAMERA_ABOVE_BASE,
  DECK_RENDER_ORDER_CAMERA_BELOW_BASE,
  DECK_THICKNESS_WORLD_UNITS,
  PUFF_NORMAL_FLATNESS,
  PUFF_SOFT_EDGE_FRACTION,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import { compose, discard } from '../../../client/src/render/materialSlots.ts';
import { instanceMatrix } from '../../../client/src/render/instanceMatrix.ts';

export const ARMS_PER_SPIRAL = 9;
export const POSITIONS_PER_ARM = 90;

export const MAX_SPIRALS = 2;

export const ARM_WRAP_TURNS = 0.85;

export const SPIRAL_SPIN_TURNS_PER_SECOND = 0.02;

export const PUFF_SIZE_RADIUS_FRACTION = 0.085;

export const CYCLONE_DECK_BASE_WORLD_Y = DECK_BASE_WORLD_Y;

export const CYCLONE_RIM_HEIGHT_MULTIPLE = 2;

export const CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS = DECK_THICKNESS_WORLD_UNITS;
export const CYCLONE_RIM_HEIGHT_WORLD_UNITS =
  DECK_THICKNESS_WORLD_UNITS * CYCLONE_RIM_HEIGHT_MULTIPLE;

export const CYCLONE_TOWER_FALLOFF_EXPONENT = 0.5;

export const CYCLONE_EYEWALL_PUFF_GROWTH = 0.6;

export const PUFF_SIZE_SEED_MIN = 0.7;
export const PUFF_SIZE_SEED_SPAN = 0.6;

export const CYCLONE_NOMINAL_RADIUS_WORLD_UNITS = CYCLONE_RADIUS_CELLS * CELL_WORLD_SIZE;

export const CYCLONE_EYEWALL_SOFT_EDGE = PUFF_SOFT_EDGE_FRACTION;
export const CYCLONE_RIM_SOFT_EDGE = 0;

export const CYCLONE_EYEWALL_PUFF_HALF_WIDTH_FRACTION =
  PUFF_SIZE_RADIUS_FRACTION *
  (1 + CYCLONE_EYEWALL_PUFF_GROWTH) *
  (PUFF_SIZE_SEED_MIN + PUFF_SIZE_SEED_SPAN);
export const CYCLONE_BAND_INNER_RADIUS_FRACTION =
  CYCLONE_EYE_RADIUS_FRACTION + CYCLONE_EYEWALL_PUFF_HALF_WIDTH_FRACTION;

export const CYCLONE_TIER_JITTER_FRACTION = 0.5;

export function towerHeightAt(along: number): number {
  return (
    CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS +
    (CYCLONE_RIM_HEIGHT_WORLD_UNITS - CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS) * along
  );
}

export function tierRiseAt(along: number): number {
  const wall = 1 - Math.pow(along, CYCLONE_TOWER_FALLOFF_EXPONENT);
  return (
    CYCLONE_NOMINAL_RADIUS_WORLD_UNITS *
    PUFF_SIZE_RADIUS_FRACTION *
    (1 + CYCLONE_EYEWALL_PUFF_GROWTH * wall) *
    PUFF_SIZE_SEED_MIN
  );
}

export function tiersAt(along: number): number {
  return Math.round(towerHeightAt(along) / tierRiseAt(along)) + 1;
}

export function alongAt(index: number): number {
  return (index + 0.5) / POSITIONS_PER_ARM;
}

export const PUFFS_PER_ARM: number = (() => {
  let total = 0;
  for (let index = 0; index < POSITIONS_PER_ARM; index++) total += tiersAt(alongAt(index));
  return total;
})();
export const PUFFS_PER_SPIRAL = ARMS_PER_SPIRAL * PUFFS_PER_ARM;

export const CYCLONE_DECK_COLOR = 0xdbdeeb;

export const CYCLONE_EYEWALL_SHADE = 0.28;

export const CYCLONE_DECK_PEAK_OPACITY = 0.55;

export const SPIRAL_RIM_FADE_START = 0.85;

export const CYCLONE_SHADE_DARKNESS = 0.15;

export const CYCLONE_SHADE_CORE_FRACTION = CYCLONE_EYE_RADIUS_FRACTION;

export const SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE = DECK_RENDER_ORDER_CAMERA_ABOVE_BASE;
export const SPIRAL_RENDER_ORDER_CAMERA_BELOW_BASE = DECK_RENDER_ORDER_CAMERA_BELOW_BASE;

const TWO_PI = Math.PI * 2;

const BAND_HALF_WIDTH_EYEWALL_FRACTION = 0.012;
const BAND_HALF_WIDTH_RIM_FRACTION = 0.057;

const SEED_HASH_SCATTER_BEARING = 13.7;
const SEED_HASH_SCATTER_SPAN = 7.13;
const SEED_HASH_SCATTER_SPAN_OFFSET = 0.17;
const SEED_HASH_PUFF_SIZE = 5.7;
const SEED_HASH_TIER_JITTER = 7.31;

const GOLDEN_RATIO_CONJUGATE = 0.6180339887;

function seedHash(seed: number, multiplier: number): number {
  return (seed * multiplier) % 1;
}

interface Spiral {
  x: number;
  z: number;
  radiusWorldUnits: number;
  readonly seed: number;
  alive: boolean;
  presence: number;
  intensity: number;
  slotBase: number;
  writtenStrength: number;
}

export const SPIRAL_DISPERSE_SECONDS = 30;

export interface SpiralSource {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly radiusCells: number;
  readonly intensity: number;
}

export interface SpiralRenderer {
  readonly root: Group;
  apply(live: readonly SpiralSource[]): void;
  update(dt: number, elapsed: number): void;
  orderAgainstCamera(cameraWorldY: number): void;
  dispose(): void;
}

function unitFromId(id: number): number {
  let h = id >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

export function createSpiral(
  applyRevealClip: (material: NodeMaterial, label: string) => void,
): SpiralRenderer {
  const root = new Group();
  root.name = 'cyclone:spiral';

  const capacity = MAX_SPIRALS * PUFFS_PER_SPIRAL;
  const geometry = new PlaneGeometry(2, 2, 1, 1);

  const material = new MeshLambertNodeMaterial({
    color: CYCLONE_DECK_COLOR,
    opacity: CYCLONE_DECK_PEAK_OPACITY,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const elapsedUniform = uniform(0);

  const aArm = attribute<'float'>('aArm', 'float');
  const aAlong = attribute<'float'>('aAlong', 'float');
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aRadius = attribute<'float'>('aRadius', 'float');
  const aStrength = attribute<'float'>('aStrength', 'float');
  const aRise = attribute<'float'>('aRise', 'float');

  // The eyewall profile: 1 at the eyewall, 0 at the rim; size, solidity and shade read off it.
  const wall = varying(float(1).sub(pow(aAlong, CYCLONE_TOWER_FALLOFF_EXPONENT)), 'vWall');

  // The logarithmic spiral: wrap positive, spin negative, so the arms trail an anticlockwise turn.
  const radius = aRadius.mul(mix(float(CYCLONE_BAND_INNER_RADIUS_FRACTION), 1, aAlong));
  const angle = float(TWO_PI).mul(
    aArm.add(aAlong.mul(ARM_WRAP_TURNS)).sub(elapsedUniform.mul(SPIRAL_SPIN_TURNS_PER_SECOND)),
  );

  // A scatter across the arm's width, narrow at the eyewall and wide at the rim.
  const scatterAngle = fract(aSeed.mul(SEED_HASH_SCATTER_BEARING)).mul(TWO_PI);
  const scatter = aRadius
    .mul(mix(float(BAND_HALF_WIDTH_EYEWALL_FRACTION), BAND_HALF_WIDTH_RIM_FRACTION, aAlong))
    .mul(fract(aSeed.mul(SEED_HASH_SCATTER_SPAN).add(SEED_HASH_SCATTER_SPAN_OFFSET)));

  // The offset from the eye; the instance matrix carries the eye. Y is absolute: a fixed cloud base.
  const transformed = vec3(
    cos(angle).mul(radius).add(cos(scatterAngle).mul(scatter)),
    float(CYCLONE_DECK_BASE_WORLD_Y).add(aRise),
    sin(angle).mul(radius).add(sin(scatterAngle).mul(scatter)),
  );

  // Bigger at the eyewall, and varying with the seed so the deck is not a grid of clones.
  const puffSize = aRadius
    .mul(PUFF_SIZE_RADIUS_FRACTION)
    .mul(float(1).add(wall.mul(CYCLONE_EYEWALL_PUFF_GROWTH)))
    .mul(float(PUFF_SIZE_SEED_MIN).add(fract(aSeed.mul(SEED_HASH_PUFF_SIZE)).mul(PUFF_SIZE_SEED_SPAN)));

  const mesh = new InstancedMesh(geometry, material, capacity);
  compose(material, 'position', () =>
    puffBillboard(instanceMatrix(mesh).mul(vec4(transformed, 1)).xyz, puffSize),
  );

  // Solid at the eyewall, a smear at the rim, so the wall occludes rather than tints.
  const softEdge = mix(float(CYCLONE_RIM_SOFT_EDGE), CYCLONE_EYEWALL_SOFT_EDGE, wall);
  const mask = puffMask(softEdge);
  discard(material, mask.discarded);

  // Darkest at the eyewall: a multiplier on the albedo, so the deck is still lit.
  compose(material, 'color', (previous) =>
    previous.mul(mix(float(1), CYCLONE_EYEWALL_SHADE, wall)),
  );

  // The outer tenth fades out, so the deck has no edge.
  const edge = float(1).sub(smoothstep(SPIRAL_RIM_FADE_START, 1, aAlong));
  const alpha = mask.puff.mul(edge).mul(aStrength);
  discard(material, puffAlphaDiscard(alpha));
  compose(material, 'opacity', (previous) => previous.mul(alpha));

  const puffSphere = vec3(PUFF_QUAD, sqrt(max(0, float(1).sub(dot(PUFF_QUAD, PUFF_QUAD)))));
  const puffUp = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  compose(material, 'normal', () => normalize(mix(puffSphere, puffUp, PUFF_NORMAL_FLATNESS)));

  const label = 'cyclone spiral';
  material.name = label;
  applyRevealClip(material, label);

  mesh.name = 'cyclone:spiral:puffs';
  mesh.count = 0;
  mesh.renderOrder = SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE;
  mesh.frustumCulled = false;
  root.add(mesh);

  const arms = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const alongs = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const seeds = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const radii = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const rises = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  for (const attribute of [arms, alongs, seeds, radii, strengths, rises]) {
  }
  geometry.setAttribute('aArm', arms);
  geometry.setAttribute('aAlong', alongs);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aRadius', radii);
  geometry.setAttribute('aStrength', strengths);
  geometry.setAttribute('aRise', rises);

  const spirals = new Map<number, Spiral>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);

  let layoutDirty = false;
  let drawn = 0;

  function writeLayout(): void {
    const armArray = arms.array as Float32Array;
    const alongArray = alongs.array as Float32Array;
    const seedArray = seeds.array as Float32Array;
    const radiusArray = radii.array as Float32Array;
    const strengthArray = strengths.array as Float32Array;
    const riseArray = rises.array as Float32Array;
    drawn = 0;

    for (const spiral of spirals.values()) {
      position.set(spiral.x, 0, spiral.z);
      matrix.compose(position, rotation, scale);
      const strength = spiral.presence * spiral.intensity;
      spiral.slotBase = drawn;
      spiral.writtenStrength = strength;

      for (let arm = 0; arm < ARMS_PER_SPIRAL; arm++) {
        for (let i = 0; i < POSITIONS_PER_ARM; i++) {
          const along = alongAt(i);
          const tiers = tiersAt(along);
          const rise = tierRiseAt(along);
          for (let tier = 0; tier < tiers; tier++) {
            mesh.setMatrixAt(drawn, matrix);
            armArray[drawn] = arm / ARMS_PER_SPIRAL;
            alongArray[drawn] = along;
            const seed = (spiral.seed + drawn * GOLDEN_RATIO_CONJUGATE) % 1;
            seedArray[drawn] = seed;
            radiusArray[drawn] = spiral.radiusWorldUnits;
            strengthArray[drawn] = strength;
            riseArray[drawn] =
              tier * rise +
              seedHash(seed, SEED_HASH_TIER_JITTER) * rise * CYCLONE_TIER_JITTER_FRACTION;
            drawn++;
          }
        }
      }
    }

    mesh.count = drawn;
    markUploaded(mesh.instanceMatrix, drawn);
    markUploaded(arms, drawn);
    markUploaded(alongs, drawn);
    markUploaded(seeds, drawn);
    markUploaded(radii, drawn);
    markUploaded(strengths, drawn);
    markUploaded(rises, drawn);
  }

  function markUploaded(attribute: InstancedBufferAttribute, instances: number): void {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, instances * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  return {
    root,

    apply(live): void {
      for (const spiral of spirals.values()) spiral.alive = false;

      for (const storm of live) {
        const radiusWorldUnits = storm.radiusCells * CELL_WORLD_SIZE;
        const existing = spirals.get(storm.id);
        if (existing !== undefined) {
          existing.alive = true;
          if (existing.x !== storm.x || existing.z !== storm.z || existing.radiusWorldUnits !== radiusWorldUnits) {
            layoutDirty = true;
          }
          existing.x = storm.x;
          existing.z = storm.z;
          existing.radiusWorldUnits = radiusWorldUnits;
          existing.intensity = storm.intensity;
          continue;
        }
        if (spirals.size >= MAX_SPIRALS) continue;
        spirals.set(storm.id, {
          x: storm.x,
          z: storm.z,
          radiusWorldUnits,
          seed: unitFromId(storm.id),
          alive: true,
          presence: 1,
          intensity: storm.intensity,
          slotBase: 0,
          writtenStrength: Number.NaN,
        });
        layoutDirty = true;
      }
    },

    update(dt, elapsed): void {
      elapsedUniform.value = elapsed;

      if (spirals.size === 0) {
        mesh.count = 0;
        drawn = 0;
        return;
      }

      for (const [id, spiral] of spirals) {
        if (spiral.alive) {
          spiral.presence = 1;
        } else {
          spiral.presence -= dt / SPIRAL_DISPERSE_SECONDS;
          if (spiral.presence <= 0) {
            spirals.delete(id);
            layoutDirty = true;
          }
        }
      }

      if (spirals.size === 0) {
        mesh.count = 0;
        drawn = 0;
        layoutDirty = false;
        return;
      }

      if (layoutDirty) {
        writeLayout();
        layoutDirty = false;
        return;
      }

      const strengthArray = strengths.array as Float32Array;
      let touched = false;
      for (const spiral of spirals.values()) {
        const strength = spiral.presence * spiral.intensity;
        if (strength === spiral.writtenStrength) continue;
        strengthArray.fill(strength, spiral.slotBase, spiral.slotBase + PUFFS_PER_SPIRAL);
        spiral.writtenStrength = strength;
        touched = true;
      }
      if (touched) markUploaded(strengths, drawn);
    },

    orderAgainstCamera(cameraWorldY): void {
      mesh.renderOrder =
        cameraWorldY >= CYCLONE_DECK_BASE_WORLD_Y
          ? SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE
          : SPIRAL_RENDER_ORDER_CAMERA_BELOW_BASE;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
      spirals.clear();
    },
  };
}
