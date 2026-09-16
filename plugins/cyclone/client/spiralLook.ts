import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  type Vector2,
  type Vector4,
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
  billboardPuffs,
  puffAlphaDiscard,
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
import { COLUMN_LANES } from './spiralGround.ts';
import {
  ARM_WRAP_TURNS,
  CYCLONE_BAND_INNER_RADIUS_FRACTION,
  CYCLONE_EYEWALL_PUFF_GROWTH,
  CYCLONE_FUNNEL_PROFILE_EXPONENT,
  CYCLONE_RIM_BOTTOM_WORLD_Y,
  CYCLONE_TOP_WORLD_Y,
  KEY_LANES,
  PUFF_SIZE_RADIUS_FRACTION,
  PUFF_SIZE_SEED_MIN,
  PUFF_SIZE_SEED_SPAN,
  SEAT_LANES,
  SPIRAL_CAPACITY,
  writeSpiralLayout,
} from './spiralLayout.ts';

// A full turn every five seconds: the walls visibly race.
export const SPIRAL_SPIN_TURNS_PER_SECOND = 0.2;

export const CYCLONE_EYEWALL_SOFT_EDGE = PUFF_SOFT_EDGE_FRACTION;
export const CYCLONE_RIM_SOFT_EDGE = 0;

export const CYCLONE_DECK_COLOR = 0xdbdeeb;

export const CYCLONE_EYEWALL_SHADE = 0.28;

export const CYCLONE_DECK_PEAK_OPACITY = 0.55;

// Outer rain bands thin out: the rim reaches this fraction of the eyewall's opacity.
// Lower and the outer bands vanish against a night sky.
export const CYCLONE_RIM_OPACITY_FRACTION = 0.6;

// Cloud undersides are darker than tops; a puff at a column's foot carries this albedo.
export const CYCLONE_WALL_BASE_SHADE = 0.55;

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
  // Returns the wrapped spin phase the shader is drawing this frame.
  advance(elapsed: number): number;
  orderAgainstCamera(cameraWorldY: number): void;
  dispose(): void;
}

// One draw for every puff of every slot. Layout attributes are written once; a
// frame moves the slot uniforms, the column grounds and the spin.
export function createSpiralMesh(
  centre: Vector2[],
  size: Vector2[],
  columnGround: Vector4[],
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
  const groundNode = uniformArray<'vec4'>(columnGround, 'vec4');
  const aSeat = attribute<'vec4'>('aSeat', 'vec4');
  const aKey = attribute<'vec2'>('aKey', 'vec2');

  const slot = int(aKey.x.add(0.5));
  const eye = centreNode.element(slot);
  const reach = sizeNode.element(slot);
  const aRadius = reach.x;
  const aStrength = reach.y;

  const column = int(aKey.y.add(0.5));
  const lane = column.mod(int(COLUMN_LANES));
  const laneMask = vec4(
    lane.equal(int(0)).toFloat(),
    lane.equal(int(1)).toFloat(),
    lane.equal(int(2)).toFloat(),
    lane.equal(int(3)).toFloat(),
  );
  const ground = dot(groundNode.element(column.div(int(COLUMN_LANES))), laneMask);

  const aArm = aSeat.x;
  const aAlong = aSeat.y;
  const aSeed = aSeat.z;
  const aTier = aSeat.w;

  // The eyewall profile: 1 at the eyewall, 0 at the rim; depth, size, solidity and shade read off it.
  const wall = varying(float(1).sub(pow(aAlong, CYCLONE_FUNNEL_PROFILE_EXPONENT)), 'vWall');

  // The logarithmic spiral: wrap positive, spin negative, so the arms trail an anticlockwise turn.
  const radius = aRadius.mul(mix(float(CYCLONE_BAND_INNER_RADIUS_FRACTION), 1, aAlong));
  const angle = float(TWO_PI).mul(aArm.add(aAlong.mul(ARM_WRAP_TURNS)).sub(spinTurns));

  // A scatter across the arm's width, narrow at the eyewall and wide at the rim.
  const scatterAngle = fract(aSeed.mul(SEED_HASH_SCATTER_BEARING)).mul(TWO_PI);
  const scatter = aRadius
    .mul(mix(float(BAND_HALF_WIDTH_EYEWALL_FRACTION), BAND_HALF_WIDTH_RIM_FRACTION, aAlong))
    .mul(fract(aSeed.mul(SEED_HASH_SCATTER_SPAN).add(SEED_HASH_SCATTER_SPAN_OFFSET)));

  // Bigger at the eyewall, and varying with the seed so the deck is not a grid of clones.
  const puffSize = aRadius
    .mul(PUFF_SIZE_RADIUS_FRACTION)
    .mul(float(1).add(wall.mul(CYCLONE_EYEWALL_PUFF_GROWTH)))
    .mul(float(PUFF_SIZE_SEED_MIN).add(fract(aSeed.mul(SEED_HASH_PUFF_SIZE)).mul(PUFF_SIZE_SEED_SPAN)));

  // Every column hangs from the flat top; its underside is the ground at the eyewall
  // and rises to the rim bottom outward, never dipping below the ground beneath it.
  const underside = mix(max(ground, float(CYCLONE_RIM_BOTTOM_WORLD_Y)), ground, wall);
  const world = vec3(
    eye.x.add(cos(angle).mul(radius)).add(cos(scatterAngle).mul(scatter)),
    underside.add(aTier.mul(float(CYCLONE_TOP_WORLD_Y).sub(underside))),
    eye.y.add(sin(angle).mul(radius)).add(sin(scatterAngle).mul(scatter)),
  );

  const mesh = new InstancedMesh(geometry, material, SPIRAL_CAPACITY);
  // A parked slot has no extent: its quad is one point, so no fragment is raised.
  const lit = aStrength.greaterThan(0).toFloat();
  billboardPuffs(material, world, puffSize.mul(lit));

  // Solid at the eyewall, a smear at the rim, so the wall occludes rather than tints.
  const softEdge = mix(float(CYCLONE_RIM_SOFT_EDGE), CYCLONE_EYEWALL_SOFT_EDGE, wall);
  const mask = puffMask(softEdge);
  discard(material, mask.discarded);

  // Darkest at the eyewall and at a column's foot: multipliers on the albedo, so the deck is still lit.
  const footShade = mix(float(CYCLONE_WALL_BASE_SHADE), 1, aTier);
  compose(material, 'color', (previous) =>
    previous.mul(mix(float(1), CYCLONE_EYEWALL_SHADE, wall)).mul(footShade),
  );

  // The outer tenth fades out, so the deck has no edge.
  const edge = float(1).sub(smoothstep(SPIRAL_RIM_FADE_START, 1, aAlong));
  const thinness = mix(float(CYCLONE_RIM_OPACITY_FRACTION), 1, wall);
  const alpha = mask.puff.mul(edge).mul(aStrength).mul(thinness);
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
  geometry.setAttribute('aSeat', new InstancedBufferAttribute(layout.seats, SEAT_LANES));
  geometry.setAttribute('aKey', new InstancedBufferAttribute(layout.keys, KEY_LANES));

  return {
    mesh,

    advance(elapsed: number): number {
      spinTurns.value = (elapsed * SPIRAL_SPIN_TURNS_PER_SECOND) % 1;
      return spinTurns.value;
    },

    orderAgainstCamera(cameraWorldY: number): void {
      mesh.renderOrder =
        cameraWorldY >= CYCLONE_TOP_WORLD_Y
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
