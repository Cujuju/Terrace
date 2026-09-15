import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  type Vector4,
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  attribute,
  cos,
  float,
  fract,
  int,
  select,
  sin,
  smoothstep,
  uniform,
  uniformArray,
  varying,
  vec3,
} from 'three/tsl';
import { WORLD_UNITS_PER_BAND } from '@terrace/shared';
import { puffBillboard, puffMask } from '../../../client/src/plugins/kit/puffDeck.ts';
import {
  compose,
  composeDisplayedOutput,
  discard,
} from '../../../client/src/render/materialSlots.ts';
import { TORNADO_HEIGHT_WORLD_UNITS } from '../protocol.ts';
import {
  FUNNEL_GROUND_RADIUS_WORLD_UNITS,
  FUNNEL_SPIN_TURNS_PER_SECOND,
  MAX_FUNNELS,
  TWO_PI,
  slotSeed,
  type FunnelMesh,
} from './funnelSlots.ts';

export const DEBRIS_PER_FUNNEL = 64;

const DEBRIS_LIFE_SECONDS = 1.4;

const DEBRIS_HEIGHT_FRACTION = 1 / 6;
const DEBRIS_SPREAD_RADII = 3;
const DEBRIS_START_RADIUS_FRACTION = 0.5;

// life * (1 - life) peaks at a quarter, so this makes the peak the stated height.
const DEBRIS_ARC_PEAK_NORMALISER = 4;

const DEBRIS_CURL_TURNS = 0.35;
const DEBRIS_SPIN_FRACTION_OF_VORTEX = 0.6;

const DEBRIS_SIZE_BAND_FRACTION = 0.55;
const DEBRIS_SIZE_SEED_MIN = 0.5;

const SEED_HASH_SPREAD = 3.7;
const SEED_HASH_SPREAD_OFFSET = 0.2;
const SEED_HASH_BEARING = 61.7;
const SEED_HASH_HEIGHT = 13.1;
const SEED_HASH_HEIGHT_OFFSET = 0.5;
const SEED_HASH_SIZE = 29.3;

const DEBRIS_CHIP_EDGE = 0.35;

const DEBRIS_FADE_IN_END = 0.12;
const DEBRIS_FADE_OUT_START = 0.45;

const DEBRIS_PEAK_OPACITY = 0.8;
const DEBRIS_ALPHA_DISCARD = 0.01;

const DEBRIS_RENDER_ORDER = 3;

const GOLDEN_RATIO_CONJUGATE = 0.6180339887;

// A fixed ring of chips per slot, thrown and falling on the GPU. Layout is
// written once; a frame moves the slot uniform and the wrapped life phase.
export function createDebrisMesh(
  stand: Vector4[],
  applyRevealClip: (material: NodeMaterial, label: string) => void,
): FunnelMesh {
  const capacity = MAX_FUNNELS * DEBRIS_PER_FUNNEL;
  const geometry = new PlaneGeometry(2, 2, 1, 1);

  const material = new NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;

  const lifeTurns = uniform(0);
  const spinTurns = uniform(0);

  const standNode = uniformArray<'vec4'>(stand, 'vec4');
  const slot = int(attribute<'float'>('aSlot', 'float').add(0.5));
  const standing = standNode.element(slot);
  const strength = standing.w;
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aPhase = attribute<'float'>('aPhase', 'float');

  const life = varying(fract(lifeTurns.add(aPhase)), 'vLife');

  // Thrown outward and up, then falling back: a parabola in height against a growing radius.
  const radius = float(FUNNEL_GROUND_RADIUS_WORLD_UNITS).mul(
    float(DEBRIS_START_RADIUS_FRACTION).add(
      life.mul(DEBRIS_SPREAD_RADII).mul(fract(aSeed.mul(SEED_HASH_SPREAD).add(SEED_HASH_SPREAD_OFFSET))),
    ),
  );
  const bearing = float(TWO_PI).mul(
    fract(aSeed.mul(SEED_HASH_BEARING)).add(life.mul(DEBRIS_CURL_TURNS)).add(spinTurns),
  );
  const height = float(TORNADO_HEIGHT_WORLD_UNITS * DEBRIS_HEIGHT_FRACTION)
    .mul(DEBRIS_ARC_PEAK_NORMALISER)
    .mul(life)
    .mul(float(1).sub(life))
    .mul(fract(aSeed.mul(SEED_HASH_HEIGHT).add(SEED_HASH_HEIGHT_OFFSET)));

  const mesh = new InstancedMesh(geometry, material, capacity);
  const world = standing.xyz.add(
    vec3(cos(bearing).mul(radius), height, sin(bearing).mul(radius)),
  );

  const size = float(WORLD_UNITS_PER_BAND * DEBRIS_SIZE_BAND_FRACTION).mul(
    float(DEBRIS_SIZE_SEED_MIN).add(fract(aSeed.mul(SEED_HASH_SIZE))),
  );
  // A parked slot's chips shrink to nothing, so they cost no fragments at all.
  const lit = strength.greaterThan(0);
  compose(material, 'position', () => puffBillboard(world, select(lit, size, float(0))));

  // Clipped like the cone: debris thrown across the frontier is over floor never sent.
  applyRevealClip(material, 'tornado debris');

  // Harder-edged than the cloud puffs: this is dirt and chaff, not vapour.
  const chip = puffMask(DEBRIS_CHIP_EDGE);
  discard(material, chip.discarded);

  compose(material, 'color', () => vec3(0.34, 0.27, 0.19));
  // In fast, out slow, and gone before it lands, or the sprites pile into a solid ring.
  const fade = smoothstep(0, DEBRIS_FADE_IN_END, life).mul(
    float(1).sub(smoothstep(DEBRIS_FADE_OUT_START, 1, life)),
  );
  const alpha = chip.puff.mul(fade).mul(strength).mul(DEBRIS_PEAK_OPACITY);
  discard(material, alpha.lessThanEqual(DEBRIS_ALPHA_DISCARD));
  compose(material, 'opacity', () => alpha);
  composeDisplayedOutput(material);

  mesh.name = 'tornado:funnel:debris';
  mesh.count = capacity;
  mesh.renderOrder = DEBRIS_RENDER_ORDER;
  mesh.frustumCulled = false;
  mesh.visible = false;

  const slots = new Float32Array(capacity);
  const seeds = new Float32Array(capacity);
  const phases = new Float32Array(capacity);
  const identity = new Matrix4();
  for (let index = 0; index < capacity; index++) {
    const chipIndex = index % DEBRIS_PER_FUNNEL;
    slots[index] = Math.floor(index / DEBRIS_PER_FUNNEL);
    seeds[index] = (slotSeed(slots[index]!) + index * GOLDEN_RATIO_CONJUGATE) % 1;
    phases[index] = chipIndex / DEBRIS_PER_FUNNEL;
    // Instancing multiplies this in before the position slot; the slot uniform carries the place.
    mesh.setMatrixAt(index, identity);
  }
  mesh.instanceMatrix.needsUpdate = true;
  geometry.setAttribute('aSlot', new InstancedBufferAttribute(slots, 1));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
  geometry.setAttribute('aPhase', new InstancedBufferAttribute(phases, 1));

  return {
    mesh,

    advance(elapsed: number): void {
      lifeTurns.value = (elapsed / DEBRIS_LIFE_SECONDS) % 1;
      spinTurns.value =
        (elapsed * FUNNEL_SPIN_TURNS_PER_SECOND * DEBRIS_SPIN_FRACTION_OF_VORTEX) % 1;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
