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
  atan,
  attribute,
  cameraProjectionMatrix,
  clamp,
  float,
  mix,
  modelViewMatrix,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { FIRE_FLAME_INSTANCE_CAP } from '../../protocol.ts';
import { fnoise } from '../valueNoise.ts';
import { instanceMatrix } from '../../../../client/src/render/instanceMatrix.ts';
import { radianceForDisplay } from '../../../../client/src/render/displayRadiance.ts';
import type { FireInstance, FlameRenderer, FlameRendererBuilder } from './types.ts';

const PLUME_RADIAL_SEGMENTS = 10;
const PLUME_HEIGHT_SEGMENTS = 18;
const PLUME_TIP_RADIUS_FRACTION = 0.18;

const WARP_FREQUENCY = 3.7;
const WARP_SCROLL_SPEED = 1.35;
const WARP_LATERAL_AMPLITUDE = 0.85;
const WARP_RADIUS_AMPLITUDE = 0.5;
const WARP_HEIGHT_BIAS = 1.5;

const PLUME_CORE_COLOR: readonly [number, number, number] = [1.0, 0.86, 0.5];
const PLUME_MID_COLOR: readonly [number, number, number] = [1.0, 0.42, 0.06];
const PLUME_TIP_COLOR: readonly [number, number, number] = [0.88, 0.22, 0.05];
const PLUME_MID_HEIGHT = 0.42;
const PLUME_GUTTER_HEIGHT = 0.5;
const PLUME_FLICKER_SPEED = 4.7;
const PLUME_FLICKER_DEPTH = 0.45;
const PLUME_WAIST = 0.42;
const PLUME_BELLY_GAIN = 0.75;
const PLUME_BELLY_BIAS = 1.4;
const PLUME_ALPHA_PEAK = 0.92;
const PLUME_GAIN = 1.0;
const PLUME_ALPHA_DISCARD_THRESHOLD = 0.01;

const FLAME_HEIGHT_PER_FUEL = 1.4;
const FLAME_RADIUS_PER_FUEL = 0.24;
const INTENSITY_SIZE_FLOOR = 0.34;
const INTENSITY_BRIGHTNESS_FLOOR = 0.7;

function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

export const buildShaderPlumeFlames: FlameRendererBuilder = (): FlameRenderer => {
  const root = new Group();
  root.name = 'fire:flames:shaderPlume';

  const geometry = new CylinderGeometry(
    PLUME_TIP_RADIUS_FRACTION,
    1,
    1,
    PLUME_RADIAL_SEGMENTS,
    PLUME_HEIGHT_SEGMENTS,
    true,
  );
  geometry.translate(0, 0.5, 0);

  const material = new NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;

  const mesh = new InstancedMesh(geometry, material, FIRE_FLAME_INSTANCE_CAP);
  mesh.name = 'fire:shaderPlume:plumes';
  mesh.count = 0;
  mesh.frustumCulled = false;
  root.add(mesh);

  const timeUniform = uniform(0);
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aIntensity = attribute<'float'>('aIntensity', 'float');
  const aPresence = attribute<'float'>('aPresence', 'float');

  // The sleeve is authored with its foot at y = 0 and unit height, so position.y is the height fraction.
  const height = clamp(positionGeometry.y, 0.0, 1.0);
  const vHeight = varying(height, 'vHeight');
  const vAngle = varying(atan(positionGeometry.z, positionGeometry.x), 'vAngle');

  // Anchor the foot, free the tip.
  const bias = pow(height, WARP_HEIGHT_BIAS);
  const travel = height.mul(WARP_FREQUENCY).sub(timeUniform.mul(WARP_SCROLL_SPEED));

  // Two decorrelated lookups so x and z lean independently rather than along one diagonal.
  const leanX = fnoise(vec2(travel, aSeed.mul(37.0)));
  const leanZ = fnoise(vec2(travel, aSeed.mul(37.0).add(19.7)));
  const pinch = fnoise(vec2(travel.mul(1.6), aSeed.mul(37.0).add(5.1)));

  // Flame silhouette: waist, belly, taper, applied before the noise so the noise deforms the flame.
  const belly = sin(float(3.14159265).mul(pow(height, PLUME_BELLY_BIAS)));
  const shape = float(PLUME_WAIST).add(belly.mul(PLUME_BELLY_GAIN));

  const radial = shape.mul(float(1.0).add(pinch.mul(WARP_RADIUS_AMPLITUDE).mul(bias)));
  // A fiercer fire is a taller one, here rather than in the matrix so intensity needs no rebuild.
  const warped = vec3(
    positionGeometry.x.mul(radial).add(leanX.mul(WARP_LATERAL_AMPLITUDE).mul(bias)),
    positionGeometry.y.mul(mix(float(0.72), 1.0, aIntensity)),
    positionGeometry.z.mul(radial).add(leanZ.mul(WARP_LATERAL_AMPLITUDE).mul(bias)),
  );

  material.vertexNode = cameraProjectionMatrix
    .mul(modelViewMatrix)
    .mul(instanceMatrix(mesh))
    .mul(vec4(warped, 1.0));

  material.fragmentNode = Fn(() => {
    // Colour by height: white-hot at the fuel, orange through the body, dark red going out.
    const color = select(
      vHeight.lessThan(PLUME_MID_HEIGHT),
      mix(vec3(...PLUME_CORE_COLOR), vec3(...PLUME_MID_COLOR), vHeight.div(PLUME_MID_HEIGHT)),
      mix(
        vec3(...PLUME_MID_COLOR),
        vec3(...PLUME_TIP_COLOR),
        vHeight.sub(PLUME_MID_HEIGHT).div(1 - PLUME_MID_HEIGHT),
      ),
    );

    // The plume thins out towards the tip and is solid at the foot.
    const body = float(1.0).sub(smoothstep(PLUME_GUTTER_HEIGHT, 1.0, vHeight));

    // Flicker sampled around and up the plume so the guttering crawls; stronger near the tip.
    const gutter = fnoise(
      vec2(
        vAngle.mul(1.9).add(aSeed.mul(13.0)),
        vHeight.mul(5.0).sub(timeUniform.mul(PLUME_FLICKER_SPEED)),
      ),
    );
    const flicker = float(1.0).sub(
      vHeight.mul(PLUME_FLICKER_DEPTH).mul(float(0.5).sub(gutter.mul(0.5))).mul(2.0),
    );

    const alpha = body
      .mul(clamp(flicker, 0.0, 1.0))
      .mul(aIntensity)
      .mul(aPresence)
      .mul(PLUME_ALPHA_PEAK);
    Discard(alpha.lessThanEqual(PLUME_ALPHA_DISCARD_THRESHOLD));
    // The GLSL wrote display bytes straight to the framebuffer, bypassing tone mapping.
    return vec4(radianceForDisplay(color.mul(PLUME_GAIN)), alpha);
  })();

  const seeds = new InstancedBufferAttribute(new Float32Array(FIRE_FLAME_INSTANCE_CAP), 1);
  const intensities = new InstancedBufferAttribute(new Float32Array(FIRE_FLAME_INSTANCE_CAP), 1);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aIntensity', intensities);

  const presences = new InstancedBufferAttribute(new Float32Array(FIRE_FLAME_INSTANCE_CAP), 1);
  geometry.setAttribute('aPresence', presences);

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  return {
    name: 'C — noise plume',
    root,

    get drawnCount(): number {
      return mesh.count;
    },

    apply(fires: readonly FireInstance[]): void {
      const count = Math.min(fires.length, FIRE_FLAME_INSTANCE_CAP);
      const seedArray = seeds.array as Float32Array;
      const intensityArray = intensities.array as Float32Array;
      const presenceArray = presences.array as Float32Array;

      for (let i = 0; i < count; i++) {
        const fire = fires[i]!;
        const intensity = Math.min(Math.max(fire.intensity, 0), 1);
        const sizeScale = INTENSITY_SIZE_FLOOR + (1 - INTENSITY_SIZE_FLOOR) * intensity;

        position.set(fire.x, fire.groundY, fire.z);
        scale.set(
          fire.fuelHeight * FLAME_RADIUS_PER_FUEL * sizeScale,
          fire.fuelHeight * FLAME_HEIGHT_PER_FUEL * sizeScale,
          fire.fuelHeight * FLAME_RADIUS_PER_FUEL * sizeScale,
        );
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(i, matrix);

        seedArray[i] = unitFromSeed(fire.seed, 4) * 64;
        intensityArray[i] =
          INTENSITY_BRIGHTNESS_FLOOR + (1 - INTENSITY_BRIGHTNESS_FLOOR) * intensity;
        presenceArray[i] = fire.presence === undefined ? 1 : Math.min(Math.max(fire.presence, 0), 1);
      }

      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      seeds.needsUpdate = true;
      intensities.needsUpdate = true;
      presences.needsUpdate = true;
    },

    update(_dt: number, elapsed: number): void {
      if (mesh.count === 0) return;
      timeUniform.value = elapsed;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
    },
  };
};
