import {
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { FIRE_FLAME_INSTANCE_CAP } from '../protocol.ts';
import { VALUE_NOISE_GLSL } from './valueNoiseGlsl.ts';
import {
  SMOKE_AFTERLIFE_SECONDS,
  SMOKE_CLOSEST_ZOOM_FRAME_HEIGHT_WORLD_UNITS,
  SMOKE_FULL_STRENGTH_DISTANCE,
  SMOKE_MINIMUM_VISIBLE_STRENGTH,
  SMOKE_RENDER_ORDER,
  SMOKE_RISE_SECONDS,
  SMOKE_SILENT_DISTANCE,
} from './smoke.ts';
import { evictFaintest } from './faintestEviction.ts';
import type { FireInstance } from './flames/types.ts';

const SCAR_CAP = FIRE_FLAME_INSTANCE_CAP;

const SCAR_MINIMUM_RADIUS = CELL_WORLD_SIZE;
const SCAR_RADIUS_PER_FUEL = 0.3;
const SCAR_REFERENCE_VIEWPORT_LINES = 1080;
const SCAR_HOVER_SCREEN_PIXELS = 2;
const SCAR_HOVER_HEIGHT =
  (SMOKE_CLOSEST_ZOOM_FRAME_HEIGHT_WORLD_UNITS / SCAR_REFERENCE_VIEWPORT_LINES) *
  SCAR_HOVER_SCREEN_PIXELS;

const SCAR_CORE_FRACTION = 0.45;
const SCAR_RIM_ROUGHNESS = 0.35;
const SCAR_QUAD_HALF_WIDTH = 1 + SCAR_RIM_ROUGHNESS;
const SCAR_OUTLINE_FREQUENCY = 1.5;
const SCAR_MOTTLE_FREQUENCY = 5.2;
const SCAR_CHAR_COLOR: readonly [number, number, number] = [0.07, 0.055, 0.048];
const SCAR_ASH_COLOR: readonly [number, number, number] = [0.3, 0.28, 0.26];
const SCAR_ALPHA_PEAK = 0.82;

const SCAR_RENDER_ORDER = SMOKE_RENDER_ORDER - 1;

function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

const SCAR_VERTEX_SHADER =  `
  attribute float aSeed;
  attribute float aStrength;

  varying vec2 vPlan;
  varying float vSeed;
  varying float vStrength;
  varying float vDistanceFade;

  void main() {
    // The quad is authored two units across and lying in XZ, so position.xz IS
    // the offset from the scar's centre in radii — no division, no uniform.
    vPlan = position.xz;
    vSeed = aSeed;
    vStrength = aStrength;

    // DISTANCE MEASURED TO THE SCAR'S CENTRE, not per-vertex: ./smoke.ts's rule
    // and its reason — the whole mark must fade as one body, and a per-vertex
    // distance would fade a scar's near edge differently from its far one.
    vec4 centre = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float cameraDistance = distance(cameraPosition, centre.xyz);
    // THE EXACT COMPLEMENT OF ./smoke.ts's vDistanceFade, over the same two
    // distances: full inside the closest zoom, where a column is drawn at
    // nothing, and gone by the default orbit, where a column is at full. One
    // signature, two halves, and the sum of the two is what the player sees.
    vDistanceFade = 1.0 - smoothstep(
      ${SMOKE_SILENT_DISTANCE.toFixed(2)},
      ${SMOKE_FULL_STRENGTH_DISTANCE.toFixed(2)},
      cameraDistance);

    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const SCAR_FRAGMENT_SHADER =  `
  varying vec2 vPlan;
  varying float vSeed;
  varying float vStrength;
  varying float vDistanceFade;

  ${VALUE_NOISE_GLSL}

  void main() {
    // Distance from the scar's centre in NOMINAL RADII: the outline sits at 1,
    // the quad reaches SCAR_QUAD_HALF_WIDTH along its axes so the eroded rim can
    // bulge past 1 without being sliced flat, and everything past the outline —
    // including all four corners — discards below.
    float radius = length(vPlan);

    // No hard outline, and no outline the eye can trace either. The noise moves
    // the boundary in and out, so what falls off is a ragged front rather than
    // an arc — a circle is the one shape a fire never burns.
    float outline = fnoise(vPlan * ${SCAR_OUTLINE_FREQUENCY.toFixed(2)} + vSeed);
    float body = 1.0 - smoothstep(
      ${SCAR_CORE_FRACTION.toFixed(2)},
      1.0,
      radius + outline * ${SCAR_RIM_ROUGHNESS.toFixed(2)});
    if (body <= 0.0) discard;

    // Char and ash, mottled. Decorrelated from the outline by frequency AND by
    // seed offset: sampled at the same phase, the pale patches would sit in the
    // same places as the outline's lobes and the whole mark would read as one
    // stencil scaled twice.
    float mottle = fnoise(vPlan * ${SCAR_MOTTLE_FREQUENCY.toFixed(2)} + vSeed + 37.4);
    vec3 color = mix(
      vec3(${SCAR_CHAR_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      vec3(${SCAR_ASH_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      0.5 + 0.5 * mottle);

    float alpha = body * vStrength * vDistanceFade * ${SCAR_ALPHA_PEAK.toFixed(2)};
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

interface BurnScar {
  x: number;
  z: number;
  drawnY: number;
  radius: number;
  seed: number;
  strength: number;
  alive: boolean;
}

export type DrawnGroundAt = (worldX: number, worldZ: number) => number | null;

export interface FireScar {
  readonly root: Group;
  apply(fires: readonly FireInstance[], groundAt: DrawnGroundAt): void;
  readonly drawnCount: number;
  update(dt: number): void;
  dispose(): void;
}

export const createFireScar = (): FireScar => {
  const root = new Group();
  root.name = 'fire:scar';

  const geometry = new PlaneGeometry(
    2 * SCAR_QUAD_HALF_WIDTH,
    2 * SCAR_QUAD_HALF_WIDTH,
    1,
    1,
  );
  geometry.rotateX(-Math.PI / 2);

  const material = new ShaderMaterial({
    uniforms: {},
    vertexShader: SCAR_VERTEX_SHADER,
    fragmentShader: SCAR_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new InstancedMesh(geometry, material, SCAR_CAP);
  mesh.name = 'fire:scar:marks';
  mesh.count = 0;
  mesh.renderOrder = SCAR_RENDER_ORDER;
  mesh.frustumCulled = false;
  root.add(mesh);

  const seeds = new InstancedBufferAttribute(new Float32Array(SCAR_CAP), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(SCAR_CAP), 1);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aStrength', strengths);

  const scars = new Map<number, BurnScar>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  const pending: FireInstance[] = [];
  const pendingDrawnY: number[] = [];

  return {
    root,

    get drawnCount(): number {
      return mesh.count;
    },

    apply(fires: readonly FireInstance[], groundAt: DrawnGroundAt): void {
      for (const scar of scars.values()) scar.alive = false;

      pending.length = 0;
      pendingDrawnY.length = 0;
      for (const fire of fires) {
        const existing = scars.get(fire.key);
        if (existing !== undefined) {
          existing.alive = true;
          continue;
        }
        const drawnY = groundAt(fire.x, fire.z);
        if (drawnY === null) continue;
        pending.push(fire);
        pendingDrawnY.push(drawnY);
      }
      if (pending.length === 0) return;

      const shortfall = pending.length - (SCAR_CAP - scars.size);
      if (shortfall > 0) evictFaintest(scars, shortfall);

      for (let i = 0; i < pending.length; i++) {
        if (scars.size >= SCAR_CAP) break;
        const fire = pending[i]!;
        scars.set(fire.key, {
          x: fire.x,
          z: fire.z,
          drawnY: pendingDrawnY[i]!,
          radius: SCAR_MINIMUM_RADIUS + fire.fuelHeight * SCAR_RADIUS_PER_FUEL,
          seed: fire.seed,
          strength: 0,
          alive: true,
        });
      }
    },

    update(dt: number): void {
      if (scars.size === 0) {
        mesh.count = 0;
        return;
      }

      const seedArray = seeds.array as Float32Array;
      const strengthArray = strengths.array as Float32Array;
      let drawn = 0;

      for (const [key, scar] of scars) {
        if (scar.alive) {
          scar.strength = Math.min(1, scar.strength + dt / SMOKE_RISE_SECONDS);
        } else {
          scar.strength -= dt / SMOKE_AFTERLIFE_SECONDS;
          if (scar.strength < SMOKE_MINIMUM_VISIBLE_STRENGTH) {
            scars.delete(key);
            continue;
          }
        }

        position.set(scar.x, scar.drawnY + SCAR_HOVER_HEIGHT, scar.z);
        scale.set(scar.radius, 1, scar.radius);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(drawn, matrix);

        seedArray[drawn] = unitFromSeed(scar.seed, 9) * 64;
        strengthArray[drawn] = scar.strength;
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
      scars.clear();
    },
  };
};
