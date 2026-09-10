import {
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { NodeMaterial, type Node } from 'three/webgpu';
import {
  attribute,
  cos,
  float,
  fract,
  mix,
  sin,
  smoothstep,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  puffBillboard,
  puffInstanceBase,
  puffMask,
} from '../../../client/src/plugins/kit/puffDeck.ts';
import { compose, discard } from '../../../client/src/render/materialSlots.ts';
import { instanceMatrix } from '../../../client/src/render/instanceMatrix.ts';
import { radianceForDisplay } from '../../../client/src/render/displayRadiance.ts';
import {
  TORNADO_HEIGHT_WORLD_UNITS,
  TORNADO_RADIUS_CELLS,
  WORLD_UNITS_PER_BAND,
} from '../protocol.ts';

export const MAX_FUNNELS = 3;

export const VISIBLE_VORTEX_FRACTION = 0.5;

export const FUNNEL_GROUND_RADIUS_WORLD_UNITS =
  TORNADO_RADIUS_CELLS * CELL_WORLD_SIZE * VISIBLE_VORTEX_FRACTION;
export const FUNNEL_CLOUD_RADIUS_WORLD_UNITS = FUNNEL_GROUND_RADIUS_WORLD_UNITS * 2.4;

export const FUNNEL_RADIAL_SEGMENTS = 48;
export const FUNNEL_HEIGHT_SEGMENTS = 24;

export const FUNNEL_TWIST_TURNS = 2;

export const FUNNEL_SPIN_TURNS_PER_SECOND = 0.9;

export const FUNNEL_STREAK_COUNT = 9;

export const FUNNEL_DISPERSE_SECONDS = 5;

export const DEBRIS_PER_FUNNEL = 64;

export const DEBRIS_HEIGHT_FRACTION = 1 / 6;
export const DEBRIS_SPREAD_RADII = 3;

export const DEBRIS_LIFE_SECONDS = 1.4;

export const FUNNEL_RENDER_ORDER = 2;
export const DEBRIS_RENDER_ORDER = 3;

interface Funnel {
  x: number;
  groundY: number;
  z: number;
  readonly seed: number;
  alive: boolean;
  presence: number;
  intensity: number;
  coneSlot: number;
  debrisBase: number;
  writtenStrength: number;
}

export interface FunnelSource {
  readonly id: number;
  readonly x: number;
  readonly groundY: number;
  readonly z: number;
  readonly intensity: number;
}

export interface FunnelRenderer {
  readonly root: Group;
  apply(live: readonly FunnelSource[]): void;
  update(dt: number, elapsed: number, daylight: number): void;
  dispose(): void;
}

function unitFromId(id: number): number {
  let h = id >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

// The GLSL wrote display bytes straight to the framebuffer, bypassing tone mapping.
function displayedOutput(previous: Node<'vec4'>): Node<'vec4'> {
  return vec4(radianceForDisplay(previous.rgb), previous.a);
}

export function createFunnel(
  applyRevealClip: (material: NodeMaterial, label: string) => void,
): FunnelRenderer {
  const root = new Group();
  root.name = 'tornado:funnel';

  const coneGeometry = new CylinderGeometry(
    1,
    1,
    1,
    FUNNEL_RADIAL_SEGMENTS,
    FUNNEL_HEIGHT_SEGMENTS,
    true,
  );
  const elapsedUniform = uniform(0);
  const daylightUniform = uniform(1);
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aStrength = attribute<'float'>('aStrength', 'float');

  const coneMaterial = new NodeMaterial();
  coneMaterial.transparent = true;
  coneMaterial.depthWrite = false;
  coneMaterial.side = DoubleSide;

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
  const coneAngle = float(6.28318).mul(
    surface.x
      .add(coneLife.mul(FUNNEL_TWIST_TURNS))
      .add(elapsedUniform.mul(FUNNEL_SPIN_TURNS_PER_SECOND))
      .add(aSeed),
  );

  // The whole axis wobbles on two incommensurate sines, scaled by the taper so the foot stays put.
  const sway = taper.mul(FUNNEL_GROUND_RADIUS_WORLD_UNITS * 0.55);
  const axis = vec2(
    sin(elapsedUniform.mul(0.7).add(aSeed.mul(6.28318))).mul(sway),
    cos(elapsedUniform.mul(0.53).add(aSeed.mul(3.14159))).mul(sway),
  );

  // The instance matrix carries only where the tornado is standing.
  const cone = new InstancedMesh(coneGeometry, coneMaterial, MAX_FUNNELS);
  compose(coneMaterial, 'position', () =>
    puffInstanceBase(instanceMatrix(cone)).add(
      vec3(
        cos(coneAngle).mul(coneRadius).add(axis.x),
        coneLife.mul(TORNADO_HEIGHT_WORLD_UNITS),
        sin(coneAngle).mul(coneRadius).add(axis.y),
      ),
    ),
  );

  // Nothing is drawn off the received map: the column's top can lean over unsent ground.
  applyRevealClip(coneMaterial, 'tornado funnel');

  // The churn: two streak bands at incommensurate frequencies scrolling in opposite directions.
  const climb = sin(
    float(6.28318).mul(
      surface.x
        .mul(FUNNEL_STREAK_COUNT)
        .add(coneLife.mul(2.0))
        .add(elapsedUniform.mul(1.7))
        .add(aSeed),
    ),
  );
  const tear = sin(
    float(6.28318).mul(
      surface.x
        .mul(5.0)
        .sub(coneLife.mul(3.3))
        .add(elapsedUniform.mul(0.9))
        .add(aSeed.mul(2.0)),
    ),
  );
  // High floors keep the streaks and give the sheet a body instead of a lattice of gaps.
  const churn = float(0.74).add(climb.mul(0.26)).mul(float(0.78).add(tear.mul(0.22)));

  // Dirt at the bottom, cloud at the top; unlit, so daylight arrives as a number.
  const coneDebris = vec3(0.4, 0.32, 0.23);
  const cloud = vec3(0.62, 0.63, 0.68);
  compose(coneMaterial, 'color', () =>
    mix(coneDebris, cloud, smoothstep(0.04, 0.62, coneLife)).mul(daylightUniform),
  );

  // Denser at the foot, dissolving into the cloud at the top rather than ending on a hard rim.
  const body = float(1)
    .sub(coneLife.mul(0.35))
    .mul(float(1).sub(smoothstep(0.72, 1.0, coneLife)));

  const coneAlpha = churn.mul(body).mul(aStrength).mul(0.85);
  discard(coneMaterial, coneAlpha.lessThanEqual(0.01));
  compose(coneMaterial, 'opacity', () => coneAlpha);
  compose(coneMaterial, 'output', displayedOutput);

  cone.name = 'tornado:funnel:vortex';
  cone.count = 0;
  cone.renderOrder = FUNNEL_RENDER_ORDER;
  cone.frustumCulled = false;
  root.add(cone);

  const coneSeeds = new InstancedBufferAttribute(new Float32Array(MAX_FUNNELS), 1);
  const coneStrengths = new InstancedBufferAttribute(new Float32Array(MAX_FUNNELS), 1);
  coneGeometry.setAttribute('aSeed', coneSeeds);
  coneGeometry.setAttribute('aStrength', coneStrengths);

  const debrisCapacity = MAX_FUNNELS * DEBRIS_PER_FUNNEL;
  const debrisGeometry = new PlaneGeometry(2, 2, 1, 1);
  const debrisMaterial = new NodeMaterial();
  debrisMaterial.transparent = true;
  debrisMaterial.depthWrite = false;
  debrisMaterial.side = DoubleSide;

  const aPhase = attribute<'float'>('aPhase', 'float');
  const debrisLife = varying(fract(elapsedUniform.div(DEBRIS_LIFE_SECONDS).add(aPhase)), 'vLife');

  // Thrown outward and up, then falling back: a parabola in height against a growing radius.
  const debrisRadius = float(FUNNEL_GROUND_RADIUS_WORLD_UNITS).mul(
    float(0.5).add(debrisLife.mul(DEBRIS_SPREAD_RADII).mul(fract(aSeed.mul(3.7).add(0.2)))),
  );
  const debrisAngle = float(6.28318).mul(
    fract(aSeed.mul(61.7))
      .add(debrisLife.mul(0.35))
      .add(elapsedUniform.mul(FUNNEL_SPIN_TURNS_PER_SECOND * 0.6)),
  );
  const height = float(TORNADO_HEIGHT_WORLD_UNITS * DEBRIS_HEIGHT_FRACTION)
    .mul(4.0)
    .mul(debrisLife)
    .mul(float(1).sub(debrisLife))
    .mul(fract(aSeed.mul(13.1).add(0.5)));

  const debris = new InstancedMesh(debrisGeometry, debrisMaterial, debrisCapacity);
  const world = puffInstanceBase(instanceMatrix(debris)).add(
    vec3(cos(debrisAngle).mul(debrisRadius), height, sin(debrisAngle).mul(debrisRadius)),
  );

  const size = float(WORLD_UNITS_PER_BAND * 0.55).mul(float(0.5).add(fract(aSeed.mul(29.3))));
  compose(debrisMaterial, 'position', () => puffBillboard(world, size));

  // Clipped like the cone: debris thrown across the frontier is over floor never sent.
  applyRevealClip(debrisMaterial, 'tornado debris');

  // Harder-edged than the cloud puffs: this is dirt and chaff, not vapour.
  const chip = puffMask(0.35);
  discard(debrisMaterial, chip.discarded);

  compose(debrisMaterial, 'color', () => vec3(0.34, 0.27, 0.19).mul(daylightUniform));
  // In fast, out slow, and gone before it lands, or the sprites pile into a solid ring.
  const fade = smoothstep(0.0, 0.12, debrisLife).mul(float(1).sub(smoothstep(0.45, 1.0, debrisLife)));
  const debrisAlpha = chip.puff.mul(fade).mul(aStrength).mul(0.8);
  discard(debrisMaterial, debrisAlpha.lessThanEqual(0.01));
  compose(debrisMaterial, 'opacity', () => debrisAlpha);
  compose(debrisMaterial, 'output', displayedOutput);

  debris.name = 'tornado:funnel:debris';
  debris.count = 0;
  debris.renderOrder = DEBRIS_RENDER_ORDER;
  debris.frustumCulled = false;
  root.add(debris);

  const debrisPhases = new InstancedBufferAttribute(new Float32Array(debrisCapacity), 1);
  const debrisSeeds = new InstancedBufferAttribute(new Float32Array(debrisCapacity), 1);
  const debrisStrengths = new InstancedBufferAttribute(new Float32Array(debrisCapacity), 1);
  for (const attribute of [debrisPhases, debrisSeeds, debrisStrengths]) {
  }
  debrisGeometry.setAttribute('aPhase', debrisPhases);
  debrisGeometry.setAttribute('aSeed', debrisSeeds);
  debrisGeometry.setAttribute('aStrength', debrisStrengths);

  const funnels = new Map<number, Funnel>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);

  let layoutDirty = false;
  let drawnCones = 0;
  let drawnDebris = 0;

  function markUploaded(attribute: InstancedBufferAttribute, instances: number): void {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, instances * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  function writeLayout(): void {
    const coneSeedArray = coneSeeds.array as Float32Array;
    const coneStrengthArray = coneStrengths.array as Float32Array;
    const phaseArray = debrisPhases.array as Float32Array;
    const seedArray = debrisSeeds.array as Float32Array;
    const strengthArray = debrisStrengths.array as Float32Array;
    drawnCones = 0;
    drawnDebris = 0;

    for (const funnel of funnels.values()) {
      position.set(funnel.x, funnel.groundY, funnel.z);
      matrix.compose(position, rotation, scale);
      const strength = funnel.presence * funnel.intensity;
      funnel.coneSlot = drawnCones;
      funnel.debrisBase = drawnDebris;
      funnel.writtenStrength = strength;

      cone.setMatrixAt(drawnCones, matrix);
      coneSeedArray[drawnCones] = funnel.seed;
      coneStrengthArray[drawnCones] = strength;
      drawnCones++;

      for (let i = 0; i < DEBRIS_PER_FUNNEL; i++) {
        debris.setMatrixAt(drawnDebris, matrix);
        phaseArray[drawnDebris] = i / DEBRIS_PER_FUNNEL;
        seedArray[drawnDebris] = (funnel.seed + i * 0.6180339887) % 1;
        strengthArray[drawnDebris] = strength;
        drawnDebris++;
      }
    }

    cone.count = drawnCones;
    markUploaded(cone.instanceMatrix, drawnCones);
    markUploaded(coneSeeds, drawnCones);
    markUploaded(coneStrengths, drawnCones);

    debris.count = drawnDebris;
    markUploaded(debris.instanceMatrix, drawnDebris);
    markUploaded(debrisPhases, drawnDebris);
    markUploaded(debrisSeeds, drawnDebris);
    markUploaded(debrisStrengths, drawnDebris);
  }

  return {
    root,

    apply(live): void {
      for (const funnel of funnels.values()) funnel.alive = false;

      for (const storm of live) {
        const existing = funnels.get(storm.id);
        if (existing !== undefined) {
          existing.alive = true;
          if (existing.x !== storm.x || existing.groundY !== storm.groundY || existing.z !== storm.z) {
            layoutDirty = true;
          }
          existing.x = storm.x;
          existing.groundY = storm.groundY;
          existing.z = storm.z;
          existing.intensity = storm.intensity;
          continue;
        }
        if (funnels.size >= MAX_FUNNELS) continue;
        funnels.set(storm.id, {
          x: storm.x,
          groundY: storm.groundY,
          z: storm.z,
          seed: unitFromId(storm.id),
          alive: true,
          presence: 1,
          intensity: storm.intensity,
          coneSlot: 0,
          debrisBase: 0,
          writtenStrength: Number.NaN,
        });
        layoutDirty = true;
      }
    },

    update(dt, elapsed, daylight): void {
      elapsedUniform.value = elapsed;
      daylightUniform.value = daylight;

      if (funnels.size === 0) {
        cone.count = 0;
        debris.count = 0;
        drawnCones = 0;
        drawnDebris = 0;
        return;
      }

      for (const [id, funnel] of funnels) {
        if (funnel.alive) {
          funnel.presence = 1;
        } else {
          funnel.presence -= dt / FUNNEL_DISPERSE_SECONDS;
          if (funnel.presence <= 0) {
            funnels.delete(id);
            layoutDirty = true;
          }
        }
      }

      if (funnels.size === 0) {
        cone.count = 0;
        debris.count = 0;
        drawnCones = 0;
        drawnDebris = 0;
        layoutDirty = false;
        return;
      }

      if (layoutDirty) {
        writeLayout();
        layoutDirty = false;
        return;
      }

      const coneStrengthArray = coneStrengths.array as Float32Array;
      const strengthArray = debrisStrengths.array as Float32Array;
      let touched = false;
      for (const funnel of funnels.values()) {
        const strength = funnel.presence * funnel.intensity;
        if (strength === funnel.writtenStrength) continue;
        coneStrengthArray[funnel.coneSlot] = strength;
        strengthArray.fill(strength, funnel.debrisBase, funnel.debrisBase + DEBRIS_PER_FUNNEL);
        funnel.writtenStrength = strength;
        touched = true;
      }
      if (touched) {
        markUploaded(coneStrengths, drawnCones);
        markUploaded(debrisStrengths, drawnDebris);
      }
    },

    dispose(): void {
      cone.dispose();
      coneGeometry.dispose();
      coneMaterial.dispose();
      debris.dispose();
      debrisGeometry.dispose();
      debrisMaterial.dispose();
      root.clear();
      funnels.clear();
    },
  };
}
