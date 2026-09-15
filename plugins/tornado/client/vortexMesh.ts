import {
  CylinderGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  type Vector4,
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  attribute,
  cos,
  float,
  int,
  mix,
  select,
  sin,
  smoothstep,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
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

const FUNNEL_CLOUD_RADIUS_MULTIPLE = 2.4;
const FUNNEL_CLOUD_RADIUS_WORLD_UNITS =
  FUNNEL_GROUND_RADIUS_WORLD_UNITS * FUNNEL_CLOUD_RADIUS_MULTIPLE;

const FUNNEL_RADIAL_SEGMENTS = 48;
const FUNNEL_HEIGHT_SEGMENTS = 24;

const FUNNEL_TWIST_TURNS = 2;

const FUNNEL_WOBBLE_RADIUS_FRACTION = 0.55;
const FUNNEL_WOBBLE_X_RADIANS_PER_SECOND = 0.7;
const FUNNEL_WOBBLE_Z_RADIANS_PER_SECOND = 0.53;

const FUNNEL_STREAK_COUNT = 9;
const FUNNEL_CLIMB_TWIST_TURNS = 2;
const FUNNEL_CLIMB_TURNS_PER_SECOND = 1.7;
const FUNNEL_CLIMB_FLOOR = 0.74;
const FUNNEL_CLIMB_SWING = 0.26;

const FUNNEL_TEAR_STREAK_COUNT = 5;
const FUNNEL_TEAR_TWIST_TURNS = 3.3;
const FUNNEL_TEAR_TURNS_PER_SECOND = 0.9;
const FUNNEL_TEAR_SEED_TURNS = 2;
const FUNNEL_TEAR_FLOOR = 0.78;
const FUNNEL_TEAR_SWING = 0.22;

const FUNNEL_DIRT_FADE_START = 0.04;
const FUNNEL_DIRT_FADE_END = 0.62;

const FUNNEL_BODY_THINNING = 0.35;
const FUNNEL_TOP_FADE_START = 0.72;

const FUNNEL_PEAK_OPACITY = 0.85;
const FUNNEL_ALPHA_DISCARD = 0.01;

const FUNNEL_RENDER_ORDER = 2;

// One instance per slot, standing where its slot's uniform says. Every
// attribute is written at construction; a frame only moves the uniforms.
export function createVortexMesh(
  stand: Vector4[],
  applyRevealClip: (material: NodeMaterial, label: string) => void,
): FunnelMesh {
  const geometry = new CylinderGeometry(
    1,
    1,
    1,
    FUNNEL_RADIAL_SEGMENTS,
    FUNNEL_HEIGHT_SEGMENTS,
    true,
  );

  const material = new NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;

  const spinTurns = uniform(0);
  const wobbleXRadians = uniform(0);
  const wobbleZRadians = uniform(0);
  const climbTurns = uniform(0);
  const tearTurns = uniform(0);

  const standNode = uniformArray<'vec4'>(stand, 'vec4');
  const slot = int(attribute<'float'>('aSlot', 'float').add(0.5));
  const standing = standNode.element(slot);
  const strength = standing.w;
  const aSeed = attribute<'float'>('aSeed', 'float');

  // A unit open cylinder: uv.y runs 0 at the bottom rim to 1 at the top, uv.x once around.
  const surface = uv();
  const coneLife = surface.y;

  // The taper is quadratic so the funnel is pinched near the ground and flares late.
  const taper = coneLife.mul(coneLife);
  const coneRadius = mix(
    float(FUNNEL_GROUND_RADIUS_WORLD_UNITS),
    FUNNEL_CLOUD_RADIUS_WORLD_UNITS,
    taper,
  );

  // Twist and spin shear the cone into a helix. uv.x is the angle, so the seam's duplicates meet.
  const coneAngle = float(TWO_PI).mul(
    surface.x.add(coneLife.mul(FUNNEL_TWIST_TURNS)).add(spinTurns).add(aSeed),
  );

  // The whole axis wobbles on two incommensurate sines, scaled by the taper so the foot stays put.
  const sway = taper.mul(FUNNEL_GROUND_RADIUS_WORLD_UNITS * FUNNEL_WOBBLE_RADIUS_FRACTION);
  const axis = vec2(
    sin(wobbleXRadians.add(aSeed.mul(TWO_PI))).mul(sway),
    cos(wobbleZRadians.add(aSeed.mul(Math.PI))).mul(sway),
  );

  const mesh = new InstancedMesh(geometry, material, MAX_FUNNELS);
  // A parked slot collapses to its own point, so its triangles are degenerate
  // and cost no fragments at all rather than being discarded one by one.
  const lit = strength.greaterThan(0);
  compose(material, 'position', () =>
    select(
      lit,
      standing.xyz.add(
        vec3(
          cos(coneAngle).mul(coneRadius).add(axis.x),
          coneLife.mul(TORNADO_HEIGHT_WORLD_UNITS),
          sin(coneAngle).mul(coneRadius).add(axis.y),
        ),
      ),
      standing.xyz,
    ),
  );

  // Nothing is drawn off the received map: the column's top can lean over unsent ground.
  applyRevealClip(material, 'tornado funnel');

  // The churn: two streak bands at incommensurate frequencies scrolling in opposite directions.
  const climb = sin(
    float(TWO_PI).mul(
      surface.x
        .mul(FUNNEL_STREAK_COUNT)
        .add(coneLife.mul(FUNNEL_CLIMB_TWIST_TURNS))
        .add(climbTurns)
        .add(aSeed),
    ),
  );
  const tear = sin(
    float(TWO_PI).mul(
      surface.x
        .mul(FUNNEL_TEAR_STREAK_COUNT)
        .sub(coneLife.mul(FUNNEL_TEAR_TWIST_TURNS))
        .add(tearTurns)
        .add(aSeed.mul(FUNNEL_TEAR_SEED_TURNS)),
    ),
  );
  // High floors keep the streaks and give the sheet a body instead of a lattice of gaps.
  const churn = float(FUNNEL_CLIMB_FLOOR)
    .add(climb.mul(FUNNEL_CLIMB_SWING))
    .mul(float(FUNNEL_TEAR_FLOOR).add(tear.mul(FUNNEL_TEAR_SWING)));

  // Dirt at the bottom, cloud at the top; unlit, so the sky never tints it.
  const coneDebris = vec3(0.4, 0.32, 0.23);
  const cloud = vec3(0.62, 0.63, 0.68);
  compose(material, 'color', () =>
    mix(coneDebris, cloud, smoothstep(FUNNEL_DIRT_FADE_START, FUNNEL_DIRT_FADE_END, coneLife)),
  );

  // Denser at the foot, dissolving into the cloud at the top rather than ending on a hard rim.
  const body = float(1)
    .sub(coneLife.mul(FUNNEL_BODY_THINNING))
    .mul(float(1).sub(smoothstep(FUNNEL_TOP_FADE_START, 1, coneLife)));

  const coneAlpha = churn.mul(body).mul(strength).mul(FUNNEL_PEAK_OPACITY);
  discard(material, coneAlpha.lessThanEqual(FUNNEL_ALPHA_DISCARD));
  compose(material, 'opacity', () => coneAlpha);
  composeDisplayedOutput(material);

  mesh.name = 'tornado:funnel:vortex';
  mesh.count = MAX_FUNNELS;
  mesh.renderOrder = FUNNEL_RENDER_ORDER;
  mesh.frustumCulled = false;
  mesh.visible = false;

  const slots = new Float32Array(MAX_FUNNELS);
  const seeds = new Float32Array(MAX_FUNNELS);
  const identity = new Matrix4();
  for (let index = 0; index < MAX_FUNNELS; index++) {
    slots[index] = index;
    seeds[index] = slotSeed(index);
    // Instancing multiplies this in before the position slot; the slot uniform carries the place.
    mesh.setMatrixAt(index, identity);
  }
  mesh.instanceMatrix.needsUpdate = true;
  geometry.setAttribute('aSlot', new InstancedBufferAttribute(slots, 1));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));

  return {
    mesh,

    advance(elapsed: number): void {
      spinTurns.value = (elapsed * FUNNEL_SPIN_TURNS_PER_SECOND) % 1;
      wobbleXRadians.value = (elapsed * FUNNEL_WOBBLE_X_RADIANS_PER_SECOND) % TWO_PI;
      wobbleZRadians.value = (elapsed * FUNNEL_WOBBLE_Z_RADIANS_PER_SECOND) % TWO_PI;
      climbTurns.value = (elapsed * FUNNEL_CLIMB_TURNS_PER_SECOND) % 1;
      tearTurns.value = (elapsed * FUNNEL_TEAR_TURNS_PER_SECOND) % 1;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
