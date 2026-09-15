import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  type Object3D,
} from 'three';
import { MeshLambertNodeMaterial, type NodeMaterial } from 'three/webgpu';
import {
  attribute,
  cameraViewMatrix,
  cos,
  dot,
  float,
  fract,
  int,
  max,
  mix,
  normalize,
  select,
  sin,
  smoothstep,
  sqrt,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { createMassSlots } from './discSlots.ts';
import {
  buildDeckLayout,
  DECK_RADIAL_EXPONENT,
  DECK_TIER_POPULATION_TAPER,
  DECK_TIERS,
  tierPopulations,
} from './cumulusDeckLayout.ts';

export { DECK_RADIAL_EXPONENT, DECK_TIER_POPULATION_TAPER, DECK_TIERS, tierPopulations };
import {
  PUFF_QUAD_FRAGMENT,
  puffAlphaDiscard,
  puffBillboard,
  puffLobeScale,
  puffMask,
} from './puffDeck.ts';
import { CLOUD_BASE_WORLD_Y, CLOUD_HEADROOM_WORLD_UNITS } from './precipitation.ts';
import { DISC_RENDER_ORDER } from './discRig.ts';
import { compose, discard } from '../../render/materialSlots.ts';
import { instanceMatrix } from '../../render/instanceMatrix.ts';
import type { GroundShadeDisc } from '../types.ts';
import type { InterpolatedDisc } from './discInterpolator.ts';

const TWO_PI = Math.PI * 2;

export const DECK_BASE_WORLD_Y = CLOUD_BASE_WORLD_Y;

const DECK_ORDER_HALF_STEP = 0.5;

export const DECK_RENDER_ORDER_CAMERA_ABOVE_BASE = DISC_RENDER_ORDER + DECK_ORDER_HALF_STEP;
export const DECK_RENDER_ORDER_CAMERA_BELOW_BASE = DISC_RENDER_ORDER - DECK_ORDER_HALF_STEP;

export const DECK_THICKNESS_WORLD_UNITS = CLOUD_HEADROOM_WORLD_UNITS / 2;

export const DECK_TOP_RADIUS_FRACTION = 0.55;

export const DECK_TIER_JITTER_WORLD_UNITS = DECK_THICKNESS_WORLD_UNITS / DECK_TIERS / 2;

export const DECK_RIM_FADE_START = 0.8;

// Crown for the cap: fraction of a tier's puff size added as height at the
// top-centre of the stack, falling to zero at the base and at each tier's
// rim. Without it the top tier is a flat disc of coplanar puffs whose union
// ceiling is a plane, which reads as a cut-flat top when seen edge-on. The
// fraction must clear a full top-tier puff radius (~1.0): the rim puffs keep
// their radius above the plane, so anything less leaves the mesa.
export const DECK_DOME_LIFT_FRACTION = 1.5;

export const PUFF_SIZE_TOP_GROWTH = 0.9;

export const PUFF_SIZE_SEED_VARIATION = 0.25;

export const PUFF_NORMAL_FLATNESS = 0.45;

export const PUFF_SOFT_EDGE_FRACTION = 0.55;

export const PUFF_LOBE_AMPLITUDE = 0.18;

export const PUFF_ASPECT_SEED_VARIATION = 0.2;

export const PUFF_COVERAGE_OVERLAP = 2;

export function puffsForCoverage(sizeFraction: number): number {
  return Math.ceil(PUFF_COVERAGE_OVERLAP / (sizeFraction * sizeFraction));
}

const SEED_HASH_TIER_JITTER = 7.31;
const SEED_HASH_PUFF_SIZE = 5.7;
const SEED_HASH_PUFF_ASPECT = 3.37;

export function deckShadeDisc(disc: InterpolatedDisc, darkness: number): GroundShadeDisc {
  return {
    x: disc.x * CELL_WORLD_SIZE,
    z: disc.y * CELL_WORLD_SIZE,
    y: DECK_BASE_WORLD_Y,
    radius: disc.radius * CELL_WORLD_SIZE,
    darkness: darkness * disc.intensity,
    inner: DECK_RIM_FADE_START,
  };
}

export interface CumulusDeckSpec {
  readonly maxMasses: number;
  readonly puffSizeFraction: number;
  readonly color: number;
  readonly name: string;
  readonly applyRevealClip: (material: NodeMaterial, label: string) => void;
}

export interface CumulusDeck {
  readonly object: Object3D;
  readonly puffsPerMass: number;
  claimSlot(): number;
  update(slot: number, disc: InterpolatedDisc): void;
  park(slot: number): void;
  orderAgainstCamera(cameraWorldY: number): void;
  dispose(): void;
}

export const CUMULUS_DECK_DRAW_OBJECTS = 1;

export function createCumulusDeck(spec: CumulusDeckSpec): CumulusDeck {
  const puffsPerMass = puffsForCoverage(spec.puffSizeFraction);
  const capacity = spec.maxMasses * puffsPerMass;

  const slots = createMassSlots(spec.maxMasses);
  const massXZNode = uniformArray<'vec2'>(slots.massXZ, 'vec2');
  const massSizeNode = uniformArray<'vec2'>(slots.massSize, 'vec2');

  const aSlot = attribute<'float'>('aSlot', 'float');
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aTier = attribute<'float'>('aTier', 'float');
  const aPolar = attribute<'vec2'>('aPolar', 'vec2');

  const massSlot = int(aSlot.add(0.5));
  const massCentre = massXZNode.element(massSlot);
  const massRadius = massSizeNode.element(massSlot).x;
  const massFade = massSizeNode.element(massSlot).y;

  // A dome: each tier is drawn over a smaller disc than the one below it.
  const tierRadius = massRadius.mul(mix(float(1), DECK_TOP_RADIUS_FRACTION, aTier));
  const outward = aPolar.x.mul(tierRadius);

  // The rim fades, so the deck has no edge; the mass's intensity fades the whole deck.
  const puffFade = varying(
    massFade.mul(float(1).sub(smoothstep(DECK_RIM_FADE_START, 1, aPolar.x))),
    'vPuffFade',
  );

  const tierJitter = fract(aSeed.mul(SEED_HASH_TIER_JITTER))
    .mul(2)
    .sub(1)
    .mul(DECK_TIER_JITTER_WORLD_UNITS);

  // Bigger toward the top, and never twice the same size in a row.
  const puffSize = massRadius
    .mul(spec.puffSizeFraction)
    .mul(float(1).add(aTier.mul(PUFF_SIZE_TOP_GROWTH)))
    .mul(
      float(1 - PUFF_SIZE_SEED_VARIATION).add(
        fract(aSeed.mul(SEED_HASH_PUFF_SIZE)).mul(2 * PUFF_SIZE_SEED_VARIATION),
      ),
    );

  // Crown the cap toward the middle of each tier, most at the top of the
  // stack: proportional to the puff's own size so the crown scales with the
  // storm. The base tier is untouched, so the precipitation ceiling stays flat.
  const domeLift = aTier
    .mul(aTier)
    .mul(float(1).sub(aPolar.x.mul(aPolar.x)))
    .mul(puffSize)
    .mul(DECK_DOME_LIFT_FRACTION);

  const transformed = vec3(
    massCentre.x.add(cos(aPolar.y).mul(outward)),
    float(DECK_BASE_WORLD_Y)
      .add(aTier.mul(DECK_THICKNESS_WORLD_UNITS))
      .add(tierJitter)
      .add(domeLift),
    massCentre.y.add(sin(aPolar.y).mul(outward)),
  );

  // Oblong per seed and area-neutral: stretched along x by the aspect, squashed along y by the same.
  const aspect = float(1 - PUFF_ASPECT_SEED_VARIATION).add(
    fract(aSeed.mul(SEED_HASH_PUFF_ASPECT)).mul(2 * PUFF_ASPECT_SEED_VARIATION),
  );
  const puffExtent = vec2(aspect, float(1).div(aspect)).mul(puffSize);

  const lobing = { amplitude: PUFF_LOBE_AMPLITUDE, seed: aSeed };
  const mask = puffMask(PUFF_SOFT_EDGE_FRACTION, lobing);
  const alpha = mask.puff.mul(puffFade);

  const lobedQuad = PUFF_QUAD_FRAGMENT.div(puffLobeScale(lobing));
  const puffSphere = vec3(lobedQuad, sqrt(max(0, float(1).sub(dot(lobedQuad, lobedQuad)))));
  const puffUp = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;

  const material = new MeshLambertNodeMaterial({
    color: spec.color,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const geometry = new PlaneGeometry(2, 2, 1, 1);
  const mesh = new InstancedMesh(geometry, material, capacity);

  const centre = instanceMatrix(mesh).mul(vec4(transformed, 1)).xyz;
  // A parked or dark slot collapses its quad to one point: zero area, so no fragment is raised.
  compose(material, 'position', () =>
    select(puffFade.lessThanEqual(0), centre, puffBillboard(centre, puffExtent)),
  );
  discard(material, mask.discarded);
  discard(material, puffAlphaDiscard(alpha));
  compose(material, 'opacity', (previous) => previous.mul(alpha));
  compose(material, 'normal', () => normalize(mix(puffSphere, puffUp, PUFF_NORMAL_FLATNESS)));

  const label = `${spec.name} deck`;
  material.name = label;
  spec.applyRevealClip(material, label);

  mesh.name = `${spec.name}:puffs`;
  mesh.renderOrder = DECK_RENDER_ORDER_CAMERA_ABOVE_BASE;
  mesh.visible = false;
  mesh.frustumCulled = false;

  const identity = new Matrix4();
  for (let instance = 0; instance < capacity; instance++) mesh.setMatrixAt(instance, identity);
  mesh.instanceMatrix.needsUpdate = true;

  const layout = buildDeckLayout(spec.maxMasses, puffsPerMass);
  geometry.setAttribute('aSlot', new InstancedBufferAttribute(layout.slots, 1));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(layout.seeds, 1));
  geometry.setAttribute('aTier', new InstancedBufferAttribute(layout.tiers, 1));
  geometry.setAttribute('aPolar', new InstancedBufferAttribute(layout.polars, 2));

  return {
    object: mesh,
    puffsPerMass,

    claimSlot(): number {
      return slots.claim();
    },

    update(slot: number, disc: InterpolatedDisc): void {
      mesh.visible = slots.update(slot, disc);
    },

    park(slot: number): void {
      mesh.visible = slots.park(slot);
    },

    orderAgainstCamera(cameraWorldY: number): void {
      mesh.renderOrder =
        cameraWorldY >= DECK_BASE_WORLD_Y
          ? DECK_RENDER_ORDER_CAMERA_ABOVE_BASE
          : DECK_RENDER_ORDER_CAMERA_BELOW_BASE;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      slots.reset();
    },
  };
}
