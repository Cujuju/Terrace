import {
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Discard,
  Fn,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  distance,
  float,
  length,
  mix,
  modelViewMatrix,
  modelWorldMatrix,
  positionGeometry,
  smoothstep,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { FIRE_FLAME_INSTANCE_CAP } from '../protocol.ts';
import { fnoise } from './valueNoise.ts';
import { instanceMatrix } from '../../../client/src/render/instanceMatrix.ts';
import { radianceForDisplay } from '../../../client/src/render/displayRadiance.ts';
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
const SCAR_ALPHA_DISCARD_THRESHOLD = 0.004;

const SCAR_RENDER_ORDER = SMOKE_RENDER_ORDER - 1;

function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

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

  const material = new NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;

  const mesh = new InstancedMesh(geometry, material, SCAR_CAP);
  mesh.name = 'fire:scar:marks';
  mesh.count = 0;
  mesh.renderOrder = SCAR_RENDER_ORDER;
  mesh.frustumCulled = false;
  root.add(mesh);

  const aSeed = attribute<'float'>('aSeed', 'float');
  const aStrength = attribute<'float'>('aStrength', 'float');
  const matrix4 = instanceMatrix(mesh);

  // The quad lies in XZ, two units across, so position.xz is the offset from the centre in radii.
  const vPlan = positionGeometry.xz;

  // Distance to the scar's centre, not per vertex, so the whole mark fades as one body.
  const centre = modelWorldMatrix.mul(matrix4.mul(vec4(0.0, 0.0, 0.0, 1.0)));
  const cameraDistance = distance(cameraPosition, centre.xyz);
  // The exact complement of the smoke's fade over the same two distances.
  const vDistanceFade = varying(
    float(1.0).sub(smoothstep(SMOKE_SILENT_DISTANCE, SMOKE_FULL_STRENGTH_DISTANCE, cameraDistance)),
    'vDistanceFade',
  );

  material.vertexNode = cameraProjectionMatrix
    .mul(modelViewMatrix)
    .mul(matrix4)
    .mul(vec4(positionGeometry, 1.0));

  material.fragmentNode = Fn(() => {
    // Nominal radii: the outline sits at 1; the quad reaches past it so the eroded rim can bulge.
    const radius = length(vPlan);

    // Noise moves the boundary in and out, so the edge is a ragged front rather than an arc.
    const outline = fnoise(vPlan.mul(SCAR_OUTLINE_FREQUENCY).add(aSeed));
    const body = float(1.0).sub(
      smoothstep(SCAR_CORE_FRACTION, 1.0, radius.add(outline.mul(SCAR_RIM_ROUGHNESS))),
    );
    Discard(body.lessThanEqual(0.0));

    // Char and ash, mottled, decorrelated from the outline by frequency and seed offset.
    const mottle = fnoise(vPlan.mul(SCAR_MOTTLE_FREQUENCY).add(aSeed).add(37.4));
    const color = mix(
      vec3(...SCAR_CHAR_COLOR),
      vec3(...SCAR_ASH_COLOR),
      float(0.5).add(mottle.mul(0.5)),
    );

    const alpha = body.mul(aStrength).mul(vDistanceFade).mul(SCAR_ALPHA_PEAK);
    Discard(alpha.lessThanEqual(SCAR_ALPHA_DISCARD_THRESHOLD));
    // The GLSL wrote display bytes straight to the framebuffer, bypassing tone mapping.
    return vec4(radianceForDisplay(color), alpha);
  })();

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
