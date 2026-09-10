import {
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Discard,
  Fn,
  abs,
  atan,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cos,
  distance,
  float,
  length,
  max,
  mix,
  modelNormalMatrix,
  modelViewMatrix,
  modelWorldMatrix,
  normalGeometry,
  normalize,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { FIRE_FLAME_INSTANCE_CAP } from '../protocol.ts';
import { fnoise, hash21 } from './valueNoise.ts';
import { instanceMatrix } from '../../../client/src/render/instanceMatrix.ts';
import { radianceForDisplay } from '../../../client/src/render/displayRadiance.ts';
import { evictFaintest } from './faintestEviction.ts';
import type { FireInstance } from './flames/types.ts';

export const SMOKE_RISE_SECONDS = 4;
export const SMOKE_AFTERLIFE_SECONDS = 30;
const SMOKE_COLUMN_CAP = FIRE_FLAME_INSTANCE_CAP;
export const SMOKE_MINIMUM_VISIBLE_STRENGTH = 0.01;

const SMOKE_RADIAL_SEGMENTS = 8;
const SMOKE_HEIGHT_SEGMENTS = 12;
const SMOKE_FOOT_RADIUS_FRACTION = 0.34;

const SMOKE_HEIGHT_PER_FUEL = 4.5;
const SMOKE_TIP_RADIUS_PER_FUEL = 1.1;
const SMOKE_BASE_HEIGHT_PER_FUEL = 1;

const SMOKE_DRIFT_FREQUENCY = 1.6;
const SMOKE_DRIFT_SCROLL_SPEED = 0.34;
const SMOKE_DRIFT_AMPLITUDE = 0.9;
const SMOKE_BILLOW_RADIUS_AMPLITUDE = 0.62;
const SMOKE_DRIFT_HEIGHT_BIAS = 1.4;
const SMOKE_DRAUGHT_LEAN = 1.2;
const SMOKE_DRAUGHT_DIRECTION_X = 0.82;
const SMOKE_DRAUGHT_DIRECTION_Z = -0.57;
const SMOKE_DRAUGHT_BEARING_SPREAD_RADIANS = 0.35;
const SMOKE_DRAUGHT_LEAN_SPREAD = 0.4;

const SMOKE_BASE_COLOR: readonly [number, number, number] = [0.24, 0.22, 0.21];
const SMOKE_TIP_COLOR: readonly [number, number, number] = [0.74, 0.72, 0.7];
const SMOKE_ALPHA_PEAK = 0.5;
const SMOKE_FOOT_FADE_HEIGHT = 0.1;
const SMOKE_TOP_FADE_HEIGHT = 0.5;
const SMOKE_BILLOW_SPEED = 0.9;
const SMOKE_BILLOW_DEPTH = 0.55;
const SMOKE_EDGE_SOFTNESS = 1.1;
const SMOKE_EDGE_EROSION = 0.7;
const SMOKE_ALPHA_DISCARD_THRESHOLD = 0.004;

export const SMOKE_CLOSEST_ZOOM_FRAME_HEIGHT_WORLD_UNITS = 10;
const SMOKE_CAMERA_FOV_DEGREES = 55;
const SMOKE_DEFAULT_ORBIT_DISTANCE_WORLD_UNITS = 80;
export const SMOKE_SILENT_DISTANCE =
  SMOKE_CLOSEST_ZOOM_FRAME_HEIGHT_WORLD_UNITS /
  (2 * Math.tan((SMOKE_CAMERA_FOV_DEGREES * Math.PI) / 180 / 2));
export const SMOKE_FULL_STRENGTH_DISTANCE = SMOKE_DEFAULT_ORBIT_DISTANCE_WORLD_UNITS;

export const SMOKE_RENDER_ORDER = -1;

function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

interface SmokeColumn {
  x: number;
  z: number;
  groundY: number;
  fuelHeight: number;
  seed: number;
  strength: number;
  alive: boolean;
}

export interface FireSmoke {
  readonly root: Group;
  apply(fires: readonly FireInstance[]): void;
  readonly drawnCount: number;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

export const createFireSmoke = (): FireSmoke => {
  const root = new Group();
  root.name = 'fire:smoke';

  const geometry = new CylinderGeometry(
    1,
    SMOKE_FOOT_RADIUS_FRACTION,
    1,
    SMOKE_RADIAL_SEGMENTS,
    SMOKE_HEIGHT_SEGMENTS,
    true,
  );
  geometry.translate(0, 0.5, 0);

  const material = new NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;

  const mesh = new InstancedMesh(geometry, material, SMOKE_COLUMN_CAP);
  mesh.name = 'fire:smoke:columns';
  mesh.count = 0;
  mesh.renderOrder = SMOKE_RENDER_ORDER;
  mesh.frustumCulled = false;
  root.add(mesh);

  const timeUniform = uniform(0);
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aStrength = attribute<'float'>('aStrength', 'float');
  const matrix4 = instanceMatrix(mesh);

  // The sleeve is authored with its foot at y = 0 and unit height, so position.y is the height fraction.
  const height = clamp(positionGeometry.y, 0.0, 1.0);
  const vHeight = varying(height, 'vHeight');
  const vAngle = varying(atan(positionGeometry.z, positionGeometry.x), 'vAngle');

  // Anchor the foot over the fire, free the top.
  const bias = pow(height, SMOKE_DRIFT_HEIGHT_BIAS);
  const travel = height.mul(SMOKE_DRIFT_FREQUENCY).sub(timeUniform.mul(SMOKE_DRIFT_SCROLL_SPEED));

  // Two decorrelated lookups so x and z wander independently rather than along one diagonal.
  const driftX = fnoise(vec2(travel, aSeed.mul(41.0)));
  const driftZ = fnoise(vec2(travel, aSeed.mul(41.0).add(23.9)));
  const swell = fnoise(vec2(travel.mul(1.9), aSeed.mul(41.0).add(8.4)));

  // The shared draught, swung off its bearing by a bounded seed-stable amount per column.
  const bearingJitter = hash21(vec2(aSeed, 3.7)).mul(2.0).sub(1.0);
  const lengthJitter = hash21(vec2(aSeed, 8.31)).mul(2.0).sub(1.0);
  const bearing = bearingJitter.mul(SMOKE_DRAUGHT_BEARING_SPREAD_RADIANS);
  const leanLength = float(SMOKE_DRAUGHT_LEAN).mul(
    float(1.0).add(lengthJitter.mul(SMOKE_DRAUGHT_LEAN_SPREAD)),
  );
  // Rotating the unit bearing keeps every lean the length it was asked for.
  const draught = vec2(
    cos(bearing).mul(SMOKE_DRAUGHT_DIRECTION_X).sub(sin(bearing).mul(SMOKE_DRAUGHT_DIRECTION_Z)),
    sin(bearing).mul(SMOKE_DRAUGHT_DIRECTION_X).add(cos(bearing).mul(SMOKE_DRAUGHT_DIRECTION_Z)),
  );
  const lean = draught.mul(leanLength);

  // Neck and swell before the lean, so the billows are carried sideways with the column.
  const radialSwell = float(1.0).add(swell.mul(SMOKE_BILLOW_RADIUS_AMPLITUDE).mul(bias));
  const warped = vec3(
    positionGeometry.x
      .mul(radialSwell)
      .add(driftX.mul(SMOKE_DRIFT_AMPLITUDE).mul(bias))
      .add(lean.x.mul(bias)),
    positionGeometry.y,
    positionGeometry.z
      .mul(radialSwell)
      .add(driftZ.mul(SMOKE_DRIFT_AMPLITUDE).mul(bias))
      .add(lean.y.mul(bias)),
  );

  // Distance fade to the column's foot, so the whole column fades as one body.
  const foot = modelWorldMatrix.mul(matrix4.mul(vec4(0.0, 0.0, 0.0, 1.0)));
  const cameraDistance = distance(cameraPosition, foot.xyz);
  const vDistanceFade = varying(
    smoothstep(SMOKE_SILENT_DISTANCE, SMOKE_FULL_STRENGTH_DISTANCE, cameraDistance),
    'vDistanceFade',
  );

  // Facing from the drawn surface: the warp's shear and the instance scale are undone exactly,
  // each by the inverse transpose of its map.
  const biasSlope = float(SMOKE_DRIFT_HEIGHT_BIAS).mul(
    pow(max(height, 0.0001), SMOKE_DRIFT_HEIGHT_BIAS - 1),
  );
  const shearX = positionGeometry.x
    .mul(swell)
    .mul(SMOKE_BILLOW_RADIUS_AMPLITUDE)
    .add(driftX.mul(SMOKE_DRIFT_AMPLITUDE))
    .add(lean.x)
    .mul(biasSlope);
  const shearZ = positionGeometry.z
    .mul(swell)
    .mul(SMOKE_BILLOW_RADIUS_AMPLITUDE)
    .add(driftZ.mul(SMOKE_DRIFT_AMPLITUDE))
    .add(lean.y)
    .mul(biasSlope);
  const surfaceNormal = vec3(
    normalGeometry.x.div(radialSwell),
    normalGeometry.y.sub(shearX.mul(normalGeometry.x).add(shearZ.mul(normalGeometry.z)).div(radialSwell)),
    normalGeometry.z.div(radialSwell),
  );
  const instanceScale = vec3(
    length(matrix4.mul(vec4(1, 0, 0, 0)).xyz),
    length(matrix4.mul(vec4(0, 1, 0, 0)).xyz),
    length(matrix4.mul(vec4(0, 0, 1, 0)).xyz),
  );
  const viewNormal = cameraViewMatrix.mul(
    vec4(modelNormalMatrix.mul(surfaceNormal.div(instanceScale)), 0.0),
  ).xyz;
  const vFacing = varying(abs(normalize(viewNormal).z), 'vFacing');

  material.vertexNode = cameraProjectionMatrix
    .mul(modelViewMatrix)
    .mul(matrix4)
    .mul(vec4(warped, 1.0));

  material.fragmentNode = Fn(() => {
    // Sooty at the fire, pale where it has cooled and spread.
    const color = mix(vec3(...SMOKE_BASE_COLOR), vec3(...SMOKE_TIP_COLOR), vHeight);

    // In off the foot, out into nothing at the top.
    const body = smoothstep(0.0, SMOKE_FOOT_FADE_HEIGHT, vHeight).mul(
      float(1.0).sub(smoothstep(SMOKE_TOP_FADE_HEIGHT, 1.0, vHeight)),
    );

    // Billow sampled around and up the column, so the turning-over crawls; stronger near the top.
    const turn = fnoise(
      vec2(
        vAngle.mul(1.4).add(aSeed.mul(17.0)),
        vHeight.mul(2.6).sub(timeUniform.mul(SMOKE_BILLOW_SPEED)),
      ),
    );
    const billow = float(1.0).sub(
      vHeight.mul(SMOKE_BILLOW_DEPTH).mul(float(0.5).sub(turn.mul(0.5))).mul(2.0),
    );

    // No hard outline: the column thins to nothing at its silhouette.
    const rim = pow(clamp(vFacing, 0.0, 1.0), SMOKE_EDGE_SOFTNESS);
    // ...eroded by the same billow noise, so the ragged boundary crawls with the body.
    const edge = clamp(
      rim.sub(float(1.0).sub(rim).mul(SMOKE_EDGE_EROSION).mul(float(0.5).sub(turn.mul(0.5)))),
      0.0,
      1.0,
    );

    const alpha = body
      .mul(edge)
      .mul(clamp(billow, 0.0, 1.0))
      .mul(aStrength)
      .mul(vDistanceFade)
      .mul(SMOKE_ALPHA_PEAK);
    Discard(alpha.lessThanEqual(SMOKE_ALPHA_DISCARD_THRESHOLD));
    // The GLSL wrote display bytes straight to the framebuffer, bypassing tone mapping.
    return vec4(radianceForDisplay(color), alpha);
  })();

  const seeds = new InstancedBufferAttribute(new Float32Array(SMOKE_COLUMN_CAP), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(SMOKE_COLUMN_CAP), 1);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aStrength', strengths);

  const columns = new Map<number, SmokeColumn>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  const pending: FireInstance[] = [];

  return {
    root,

    get drawnCount(): number {
      return mesh.count;
    },

    apply(fires: readonly FireInstance[]): void {
      for (const column of columns.values()) column.alive = false;

      pending.length = 0;
      for (const fire of fires) {
        const existing = columns.get(fire.key);
        if (existing !== undefined) {
          existing.x = fire.x;
          existing.z = fire.z;
          existing.groundY = fire.groundY;
          existing.fuelHeight = fire.fuelHeight;
          existing.alive = true;
          continue;
        }
        pending.push(fire);
      }
      if (pending.length === 0) return;

      const shortfall = pending.length - (SMOKE_COLUMN_CAP - columns.size);
      if (shortfall > 0) evictFaintest(columns, shortfall);

      for (const fire of pending) {
        if (columns.size >= SMOKE_COLUMN_CAP) break;
        columns.set(fire.key, {
          x: fire.x,
          z: fire.z,
          groundY: fire.groundY,
          fuelHeight: fire.fuelHeight,
          seed: fire.seed,
          strength: 0,
          alive: true,
        });
      }
    },

    update(dt: number, elapsed: number): void {
      if (columns.size === 0) {
        mesh.count = 0;
        return;
      }

      timeUniform.value = elapsed;

      const seedArray = seeds.array as Float32Array;
      const strengthArray = strengths.array as Float32Array;
      let drawn = 0;

      for (const [key, column] of columns) {
        if (column.alive) {
          column.strength = Math.min(1, column.strength + dt / SMOKE_RISE_SECONDS);
        } else {
          column.strength -= dt / SMOKE_AFTERLIFE_SECONDS;
          if (column.strength < SMOKE_MINIMUM_VISIBLE_STRENGTH) {
            columns.delete(key);
            continue;
          }
        }

        position.set(
          column.x,
          column.groundY + column.fuelHeight * SMOKE_BASE_HEIGHT_PER_FUEL,
          column.z,
        );
        const tipRadius = column.fuelHeight * SMOKE_TIP_RADIUS_PER_FUEL;
        scale.set(tipRadius, column.fuelHeight * SMOKE_HEIGHT_PER_FUEL, tipRadius);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(drawn, matrix);

        seedArray[drawn] = unitFromSeed(column.seed, 9) * 64;
        strengthArray[drawn] = column.strength;
        drawn++;
      }

      mesh.count = drawn;
      mesh.instanceMatrix.needsUpdate = true;
      seeds.needsUpdate = true;
      strengths.needsUpdate = true;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
      columns.clear();
    },
  };
};
