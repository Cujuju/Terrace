import {
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { FIRE_FLAME_INSTANCE_CAP } from '../protocol.ts';
import { VALUE_NOISE_GLSL } from './valueNoiseGlsl.ts';
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

const SMOKE_VERTEX_SHADER =  `
  uniform float uTime;

  attribute float aSeed;
  attribute float aStrength;

  varying float vHeight;
  varying float vSeed;
  varying float vAngle;
  varying float vStrength;
  varying float vDistanceFade;
  varying float vFacing;

  ${VALUE_NOISE_GLSL}

  void main() {
    // The sleeve is authored with its foot at y = 0 and unit height, so
    // position.y IS the height fraction — no division, no uniform.
    float height = clamp(position.y, 0.0, 1.0);
    vHeight = height;
    vSeed = aSeed;
    vStrength = aStrength;
    vAngle = atan(position.z, position.x);

    // Anchor the foot over the fire, free the top.
    float bias = pow(height, ${SMOKE_DRIFT_HEIGHT_BIAS.toFixed(2)});
    float travel = height * ${SMOKE_DRIFT_FREQUENCY.toFixed(2)} - uTime * ${SMOKE_DRIFT_SCROLL_SPEED.toFixed(2)};

    // Two decorrelated lookups so x and z wander independently — one lookup
    // shared between them would make every column sway along one diagonal.
    float driftX = fnoise(vec2(travel, aSeed * 41.0));
    float driftZ = fnoise(vec2(travel, aSeed * 41.0 + 23.9));
    float swell = fnoise(vec2(travel * 1.9, aSeed * 41.0 + 8.4));

    vec3 warped = position;
    // Neck and swell BEFORE the lean, so the billows are carried sideways with
    // the column rather than being stretched across a shape that already leant.
    warped.xz *= 1.0 + swell * ${SMOKE_BILLOW_RADIUS_AMPLITUDE.toFixed(2)} * bias;
    warped.x += driftX * ${SMOKE_DRIFT_AMPLITUDE.toFixed(2)} * bias;
    warped.z += driftZ * ${SMOKE_DRIFT_AMPLITUDE.toFixed(2)} * bias;
    // The shared draught, on top of the per-column wander: this is what makes a
    // wood full of fires read as one event rather than as many. Swung off that
    // shared bearing by a bounded, seed-stable amount per column, because five
    // columns leaning IDENTICALLY are five parallel pillars and no column of
    // gas has ever been parallel to the one next to it. Two decorrelated hashes
    // so bearing and length do not vary together.
    float bearingJitter = hash21(vec2(aSeed, 3.70)) * 2.0 - 1.0;
    float lengthJitter = hash21(vec2(aSeed, 8.31)) * 2.0 - 1.0;
    float bearing = bearingJitter * ${SMOKE_DRAUGHT_BEARING_SPREAD_RADIANS.toFixed(3)};
    float leanLength =
      ${SMOKE_DRAUGHT_LEAN.toFixed(3)} *
      (1.0 + lengthJitter * ${SMOKE_DRAUGHT_LEAN_SPREAD.toFixed(2)});
    // Rotating the shared unit bearing, rather than jittering x and z apart,
    // keeps every column's lean the same LENGTH it was asked for — a component
    // jitter would quietly make diagonal leans longer than axis-aligned ones.
    vec2 draught = vec2(
      ${SMOKE_DRAUGHT_DIRECTION_X.toFixed(3)} * cos(bearing) - ${SMOKE_DRAUGHT_DIRECTION_Z.toFixed(3)} * sin(bearing),
      ${SMOKE_DRAUGHT_DIRECTION_X.toFixed(3)} * sin(bearing) + ${SMOKE_DRAUGHT_DIRECTION_Z.toFixed(3)} * cos(bearing));
    vec2 lean = draught * leanLength;
    warped.xz += lean * bias;

    // DISTANCE FADE, measured to the COLUMN'S FOOT and not per-vertex: the
    // whole column must fade as one body. A per-vertex distance would fade a
    // column's near side differently from its far side, which is a gradient
    // across a single object that nothing in the world justifies.
    vec4 foot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float cameraDistance = distance(cameraPosition, foot.xyz);
    // ...and it runs from NOTHING at the closest zoom to full at the default
    // orbit. No floor under it: inside SMOKE_SILENT_DISTANCE the flame is a
    // fifth of the frame on its own and the column is only in the way.
    vDistanceFade = smoothstep(
      ${SMOKE_SILENT_DISTANCE.toFixed(2)},
      ${SMOKE_FULL_STRENGTH_DISTANCE.toFixed(2)},
      cameraDistance);

    // HOW SQUARELY THIS PIECE OF WALL FACES THE CAMERA, 0 at the silhouette and
    // 1 head-on. This is the term the whole no-visible-billboard problem rests
    // on, and getting it from the AUTHORED normal — which is what this file
    // shipped first — is why the sleeve read as a quad.
    //
    // The normal that matters is the normal of the surface ACTUALLY DRAWN, and
    // two transforms stand between the two:
    //
    //   THE WARP, which is a SHEAR. Every stretch above displaces xz by an
    //   amount that grows with height, so the wall is not the wall the cone
    //   authored: it is tilted by the rate at which that displacement changes
    //   with height. At the lean this column now carries that is on the order
    //   of fifteen degrees, and it tilts the two sides of the column in
    //   OPPOSITE directions — which is exactly what the renders showed, one
    //   silhouette edge softening correctly and the other staying hard.
    //
    //   THE INSTANCE MATRIX, which is a non-uniform SCALE: this sleeve is
    //   stretched about four times harder up (SMOKE_HEIGHT_PER_FUEL) than out
    //   (SMOKE_TIP_RADIUS_PER_FUEL), and three's normalMatrix is built from the
    //   modelView matrix ALONE, with the instance matrix nowhere in it.
    //
    // Both are undone here, in order, and BOTH ARE EXACT rather than
    // approximated, because a normal is transformed by the INVERSE TRANSPOSE of
    // the map that moved the surface and both maps are known in closed form.
    // The only thing left out is the noise's own dependence on position, which
    // is a second-order wobble on a term feeding a soft falloff — and recovering
    // it would mean three more noise evaluations per vertex.
    //
    // The shear's Jacobian is [[s, gx, 0], [0, 1, 0], [0, gz, s]]: s is the
    // radial swell, and gx/gz are how fast the lateral displacement grows with
    // height — the same drift, swell and lean already computed above, times the
    // slope of the height bias. Its inverse transpose is what the three lines
    // below apply, at the cost of two multiplies and a divide.
    float biasSlope =
      ${SMOKE_DRIFT_HEIGHT_BIAS.toFixed(2)} *
      pow(max(height, 0.0001), ${(SMOKE_DRIFT_HEIGHT_BIAS - 1).toFixed(2)});
    float radialSwell = 1.0 + swell * ${SMOKE_BILLOW_RADIUS_AMPLITUDE.toFixed(2)} * bias;
    float shearX =
      (position.x * swell * ${SMOKE_BILLOW_RADIUS_AMPLITUDE.toFixed(2)} +
        driftX * ${SMOKE_DRIFT_AMPLITUDE.toFixed(2)} + lean.x) * biasSlope;
    float shearZ =
      (position.z * swell * ${SMOKE_BILLOW_RADIUS_AMPLITUDE.toFixed(2)} +
        driftZ * ${SMOKE_DRIFT_AMPLITUDE.toFixed(2)} + lean.y) * biasSlope;
    vec3 surfaceNormal = vec3(
      normal.x / radialSwell,
      normal.y - (shearX * normal.x + shearZ * normal.z) / radialSwell,
      normal.z / radialSwell);
    vec3 instanceScale = vec3(
      length(instanceMatrix[0].xyz),
      length(instanceMatrix[1].xyz),
      length(instanceMatrix[2].xyz));
    vFacing = abs(normalize(normalMatrix * (surfaceNormal / instanceScale)).z);

    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(warped, 1.0);
  }
`;

const SMOKE_FRAGMENT_SHADER =  `
  uniform float uTime;

  varying float vHeight;
  varying float vSeed;
  varying float vAngle;
  varying float vStrength;
  varying float vDistanceFade;
  varying float vFacing;

  ${VALUE_NOISE_GLSL}

  void main() {
    // Sooty at the fire, pale where it has cooled and spread.
    vec3 color = mix(
      vec3(${SMOKE_BASE_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      vec3(${SMOKE_TIP_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      vHeight);

    // In off the foot, out into nothing at the top.
    float body =
      smoothstep(0.0, ${SMOKE_FOOT_FADE_HEIGHT.toFixed(2)}, vHeight) *
      (1.0 - smoothstep(${SMOKE_TOP_FADE_HEIGHT.toFixed(2)}, 1.0, vHeight));

    // Billow, sampled around the column AND up it, so the turning-over crawls
    // across the surface instead of pulsing the whole sleeve at once. Stronger
    // near the top: the foot of a column is a coherent stream, the top is where
    // it breaks up.
    float turn = fnoise(vec2(
      vAngle * 1.4 + vSeed * 17.0,
      vHeight * 2.6 - uTime * ${SMOKE_BILLOW_SPEED.toFixed(2)}));
    float billow = 1.0 - ${SMOKE_BILLOW_DEPTH.toFixed(2)} * vHeight * (0.5 - 0.5 * turn) * 2.0;

    // No hard outline: the column thins to nothing at its silhouette, which is
    // the difference between gas and a pane of grey glass.
    float rim = pow(clamp(vFacing, 0.0, 1.0), ${SMOKE_EDGE_SOFTNESS.toFixed(2)});
    // ...and no outline the eye can TRACE either. the billow noise is the same slow noise
    // the billows are made of, reused rather than sampled again, so the ragged
    // boundary crawls with the body it belongs to instead of shimmering against
    // it. (0.5 - 0.5 * turn) maps the noise's -1…1 onto 0…1, deepest where the
    // noise is darkest.
    float edge = clamp(
      rim - ${SMOKE_EDGE_EROSION.toFixed(2)} * (1.0 - rim) * (0.5 - 0.5 * turn),
      0.0,
      1.0);

    float alpha =
      body * edge * clamp(billow, 0.0, 1.0) * vStrength * vDistanceFade *
      ${SMOKE_ALPHA_PEAK.toFixed(2)};
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

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

  const material = new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: SMOKE_VERTEX_SHADER,
    fragmentShader: SMOKE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const mesh = new InstancedMesh(geometry, material, SMOKE_COLUMN_CAP);
  mesh.name = 'fire:smoke:columns';
  mesh.count = 0;
  mesh.renderOrder = SMOKE_RENDER_ORDER;
  mesh.frustumCulled = false;
  root.add(mesh);

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

      material.uniforms['uTime']!.value = elapsed;

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
