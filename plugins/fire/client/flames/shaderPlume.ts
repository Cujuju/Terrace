import {
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { FIRE_FLAME_INSTANCE_CAP } from '../../protocol.ts';
import { VALUE_NOISE_GLSL } from '../valueNoiseGlsl.ts';
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

const PLUME_VERTEX_SHADER =  `
  uniform float uTime;

  attribute float aSeed;
  attribute float aIntensity;
  attribute float aPresence;

  varying float vHeight;
  varying float vSeed;
  varying float vAngle;
  varying float vIntensity;
  varying float vPresence;

  ${VALUE_NOISE_GLSL}

  void main() {
    // The sleeve is authored with its foot at y = 0 and unit height, so
    // position.y IS the height fraction — no division, no uniform.
    float height = clamp(position.y, 0.0, 1.0);
    vHeight = height;
    vSeed = aSeed;
    vIntensity = aIntensity;
    vPresence = aPresence;
    vAngle = atan(position.z, position.x);

    // Anchor the foot, free the tip.
    float bias = pow(height, ${WARP_HEIGHT_BIAS.toFixed(2)});
    float travel = height * ${WARP_FREQUENCY.toFixed(2)} - uTime * ${WARP_SCROLL_SPEED.toFixed(2)};

    // Two decorrelated lookups so x and z lean independently — one lookup
    // shared between them would make the plume sway along a single diagonal.
    float leanX = fnoise(vec2(travel, aSeed * 37.0));
    float leanZ = fnoise(vec2(travel, aSeed * 37.0 + 19.7));
    float pinch = fnoise(vec2(travel * 1.6, aSeed * 37.0 + 5.1));

    // Flame silhouette: waist, belly, taper. Applied before the noise, so
    // the noise deforms the flame shape rather than the cone.
    float belly = sin(3.14159265 * pow(height, ${PLUME_BELLY_BIAS.toFixed(2)}));
    float shape = ${PLUME_WAIST.toFixed(2)} + ${PLUME_BELLY_GAIN.toFixed(2)} * belly;

    vec3 warped = position;
    warped.xz *= shape * (1.0 + pinch * ${WARP_RADIUS_AMPLITUDE.toFixed(2)} * bias);
    warped.x += leanX * ${WARP_LATERAL_AMPLITUDE.toFixed(2)} * bias;
    warped.z += leanZ * ${WARP_LATERAL_AMPLITUDE.toFixed(2)} * bias;

    // A fiercer fire is a taller one, applied here rather than in the instance
    // matrix so intensity can change without a rebuild of the matrices.
    warped.y *= mix(0.72, 1.0, aIntensity);

    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(warped, 1.0);
  }
`;

const PLUME_FRAGMENT_SHADER =  `
  uniform float uTime;

  varying float vHeight;
  varying float vSeed;
  varying float vAngle;
  varying float vIntensity;
  varying float vPresence;

  ${VALUE_NOISE_GLSL}

  void main() {
    // Colour by height: white-hot at the fuel, orange through the body, dark
    // red where it is going out.
    vec3 color = vHeight < ${PLUME_MID_HEIGHT.toFixed(2)}
      ? mix(
          vec3(${PLUME_CORE_COLOR.map((c) => c.toFixed(3)).join(', ')}),
          vec3(${PLUME_MID_COLOR.map((c) => c.toFixed(3)).join(', ')}),
          vHeight / ${PLUME_MID_HEIGHT.toFixed(2)})
      : mix(
          vec3(${PLUME_MID_COLOR.map((c) => c.toFixed(3)).join(', ')}),
          vec3(${PLUME_TIP_COLOR.map((c) => c.toFixed(3)).join(', ')}),
          (vHeight - ${PLUME_MID_HEIGHT.toFixed(2)}) / ${(1 - PLUME_MID_HEIGHT).toFixed(2)});

    // The plume thins out towards the tip and is solid at the foot.
    float body = 1.0 - smoothstep(${PLUME_GUTTER_HEIGHT.toFixed(2)}, 1.0, vHeight);

    // Flicker, sampled around the plume AND up it, so the guttering crawls
    // around the surface instead of pulsing the whole sleeve at once. Stronger
    // near the tip: the foot of a fire is steady, the tip is where it tatters.
    float gutter = fnoise(vec2(
      vAngle * 1.9 + vSeed * 13.0,
      vHeight * 5.0 - uTime * ${PLUME_FLICKER_SPEED.toFixed(2)}));
    float flicker = 1.0 - ${PLUME_FLICKER_DEPTH.toFixed(2)} * vHeight * (0.5 - 0.5 * gutter) * 2.0;

    float alpha = body * clamp(flicker, 0.0, 1.0) * vIntensity * vPresence * ${PLUME_ALPHA_PEAK.toFixed(2)};
    if (alpha <= 0.01) discard;
    gl_FragColor = vec4(color * ${PLUME_GAIN.toFixed(2)}, alpha);
  }
`;

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

  const material = new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: PLUME_VERTEX_SHADER,
    fragmentShader: PLUME_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const mesh = new InstancedMesh(geometry, material, FIRE_FLAME_INSTANCE_CAP);
  mesh.name = 'fire:shaderPlume:plumes';
  mesh.count = 0;
  mesh.frustumCulled = false;
  root.add(mesh);

  const seeds = new InstancedBufferAttribute(new Float32Array(FIRE_FLAME_INSTANCE_CAP), 1);
  const intensities = new InstancedBufferAttribute(new Float32Array(FIRE_FLAME_INSTANCE_CAP), 1);
  seeds.setUsage(DynamicDrawUsage);
  intensities.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aIntensity', intensities);

  const presences = new InstancedBufferAttribute(new Float32Array(FIRE_FLAME_INSTANCE_CAP), 1);
  presences.setUsage(DynamicDrawUsage);
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
      material.uniforms['uTime']!.value = elapsed;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
    },
  };
};
