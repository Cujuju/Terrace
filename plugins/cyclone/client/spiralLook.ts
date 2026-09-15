import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  type Vector2,
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
  pow,
  sin,
  smoothstep,
  sqrt,
  uniform,
  uniformArray,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import {
  PUFF_QUAD_FRAGMENT,
  puffAlphaDiscard,
  puffBillboard,
  puffMask,
} from '../../../client/src/plugins/kit/puffDeck.ts';
import {
  DECK_RENDER_ORDER_CAMERA_ABOVE_BASE,
  DECK_RENDER_ORDER_CAMERA_BELOW_BASE,
  PUFF_NORMAL_FLATNESS,
  PUFF_SOFT_EDGE_FRACTION,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import { compose, discard } from '../../../client/src/render/materialSlots.ts';
import { CYCLONE_EYE_RADIUS_FRACTION } from '../protocol.ts';
import {
  CYCLONE_BAND_INNER_RADIUS_FRACTION,
  CYCLONE_DECK_BASE_WORLD_Y,
  CYCLONE_EYEWALL_PUFF_GROWTH,
  CYCLONE_TOWER_FALLOFF_EXPONENT,
  PUFF_SIZE_RADIUS_FRACTION,
  PUFF_SIZE_SEED_MIN,
  PUFF_SIZE_SEED_SPAN,
  SPIRAL_CAPACITY,
  writeSpiralLayout,
} from './spiralLayout.ts';

export const ARM_WRAP_TURNS = 0.85;

export const SPIRAL_SPIN_TURNS_PER_SECOND = 0.02;

export const CYCLONE_EYEWALL_SOFT_EDGE = PUFF_SOFT_EDGE_FRACTION;
export const CYCLONE_RIM_SOFT_EDGE = 0;

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

export interface SpiralMesh {
  readonly mesh: InstancedMesh;
  advance(elapsed: number): void;
  orderAgainstCamera(cameraWorldY: number): void;
  dispose(): void;
}

// One draw for every arm of every slot. Layout attributes are written once; a
// frame only moves the slot uniforms and the CPU-wrapped spin phase.
export function createSpiralMesh(
  centre: Vector2[],
  size: Vector2[],
  applyRevealClip: (material: NodeMaterial, label: string) => void,
): SpiralMesh {
  const geometry = new PlaneGeometry(2, 2, 1, 1);

  const material = new MeshLambertNodeMaterial({
    color: CYCLONE_DECK_COLOR,
    opacity: CYCLONE_DECK_PEAK_OPACITY,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const spinTurns = uniform(0);

  const centreNode = uniformArray<'vec2'>(centre, 'vec2');
  const sizeNode = uniformArray<'vec2'>(size, 'vec2');
  const slot = int(attribute<'float'>('aSlot', 'float').add(0.5));
  const eye = centreNode.element(slot);
  const reach = sizeNode.element(slot);
  const aRadius = reach.x;
  const aStrength = reach.y;

  const aArm = attribute<'float'>('aArm', 'float');
  const aAlong = attribute<'float'>('aAlong', 'float');
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aRise = attribute<'float'>('aRise', 'float');

  // The eyewall profile: 1 at the eyewall, 0 at the rim; size, solidity and shade read off it.
  const wall = varying(float(1).sub(pow(aAlong, CYCLONE_TOWER_FALLOFF_EXPONENT)), 'vWall');

  // The logarithmic spiral: wrap positive, spin negative, so the arms trail an anticlockwise turn.
  const radius = aRadius.mul(mix(float(CYCLONE_BAND_INNER_RADIUS_FRACTION), 1, aAlong));
  const angle = float(TWO_PI).mul(aArm.add(aAlong.mul(ARM_WRAP_TURNS)).sub(spinTurns));

  // A scatter across the arm's width, narrow at the eyewall and wide at the rim.
  const scatterAngle = fract(aSeed.mul(SEED_HASH_SCATTER_BEARING)).mul(TWO_PI);
  const scatter = aRadius
    .mul(mix(float(BAND_HALF_WIDTH_EYEWALL_FRACTION), BAND_HALF_WIDTH_RIM_FRACTION, aAlong))
    .mul(fract(aSeed.mul(SEED_HASH_SCATTER_SPAN).add(SEED_HASH_SCATTER_SPAN_OFFSET)));

  // The slot uniform carries the eye. Y is absolute: a fixed cloud base.
  const world = vec3(
    eye.x.add(cos(angle).mul(radius)).add(cos(scatterAngle).mul(scatter)),
    float(CYCLONE_DECK_BASE_WORLD_Y).add(aRise),
    eye.y.add(sin(angle).mul(radius)).add(sin(scatterAngle).mul(scatter)),
  );

  // Bigger at the eyewall, and varying with the seed so the deck is not a grid of clones.
  const puffSize = aRadius
    .mul(PUFF_SIZE_RADIUS_FRACTION)
    .mul(float(1).add(wall.mul(CYCLONE_EYEWALL_PUFF_GROWTH)))
    .mul(float(PUFF_SIZE_SEED_MIN).add(fract(aSeed.mul(SEED_HASH_PUFF_SIZE)).mul(PUFF_SIZE_SEED_SPAN)));

  const mesh = new InstancedMesh(geometry, material, SPIRAL_CAPACITY);
  compose(material, 'position', () => puffBillboard(world, puffSize));

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

  const puffSphere = vec3(
    PUFF_QUAD_FRAGMENT,
    sqrt(max(0, float(1).sub(dot(PUFF_QUAD_FRAGMENT, PUFF_QUAD_FRAGMENT)))),
  );
  const puffUp = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  compose(material, 'normal', () => normalize(mix(puffSphere, puffUp, PUFF_NORMAL_FLATNESS)));

  const label = 'cyclone spiral';
  material.name = label;
  applyRevealClip(material, label);

  mesh.name = 'cyclone:spiral:puffs';
  mesh.count = SPIRAL_CAPACITY;
  mesh.renderOrder = SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE;
  mesh.frustumCulled = false;
  mesh.visible = false;

  const layout = writeSpiralLayout();
  const identity = new Matrix4();
  // Instancing multiplies this in before the position slot; the slot uniform carries the place.
  for (let index = 0; index < SPIRAL_CAPACITY; index++) mesh.setMatrixAt(index, identity);
  mesh.instanceMatrix.needsUpdate = true;
  geometry.setAttribute('aSlot', new InstancedBufferAttribute(layout.slots, 1));
  geometry.setAttribute('aArm', new InstancedBufferAttribute(layout.arms, 1));
  geometry.setAttribute('aAlong', new InstancedBufferAttribute(layout.alongs, 1));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(layout.seeds, 1));
  geometry.setAttribute('aRise', new InstancedBufferAttribute(layout.rises, 1));

  return {
    mesh,

    advance(elapsed: number): void {
      spinTurns.value = (elapsed * SPIRAL_SPIN_TURNS_PER_SECOND) % 1;
    },

    orderAgainstCamera(cameraWorldY: number): void {
      mesh.renderOrder =
        cameraWorldY >= CYCLONE_DECK_BASE_WORLD_Y
          ? SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE
          : SPIRAL_RENDER_ORDER_CAMERA_BELOW_BASE;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
