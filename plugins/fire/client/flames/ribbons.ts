import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  OneFactor,
  OneMinusSrcAlphaFactor,
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
  attribute,
  cameraProjectionMatrix,
  cos,
  float,
  int,
  mix,
  modelViewMatrix,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  uniform,
  uniformArray,
  vec3,
  vec4,
} from 'three/tsl';
import { FIRE_FLAME_INSTANCE_CAP } from '../../protocol.ts';
import type { FireInstance, FlameRenderer, FlameRendererBuilder } from './types.ts';
import { instanceMatrix } from '../../../../client/src/render/instanceMatrix.ts';
import { radianceForDisplay } from '../../../../client/src/render/displayRadiance.ts';

const RIBBON_COUNT = 5;
const RIBBON_SEGMENTS = 14;

interface RibbonProfile {
  readonly height: number;
  readonly rootRadius: number;
  readonly tipRadius: number;
  readonly width: number;
  readonly curl: number;
  readonly phase: number;
  readonly spinRate: number;
  readonly rollTwist: number;
}

const RIBBON_PROFILES: readonly RibbonProfile[] = [
  { height: 1.0, rootRadius: 0.36, tipRadius: 0.14, width: 0.99, curl: 0.32, phase: 0.0, spinRate: 0.29, rollTwist: 0.62 },
  { height: 0.82, rootRadius: 0.54, tipRadius: 0.22, width: 0.83, curl: -0.44, phase: 0.2, spinRate: -0.43, rollTwist: -0.85 },
  { height: 0.68, rootRadius: 0.70, tipRadius: 0.30, width: 0.75, curl: 0.55, phase: 0.42, spinRate: 0.61, rollTwist: 0.5 },
  { height: 0.9, rootRadius: 0.48, tipRadius: 0.16, width: 0.88, curl: -0.28, phase: 0.63, spinRate: -0.19, rollTwist: 0.74 },
  { height: 0.56, rootRadius: 0.77, tipRadius: 0.41, width: 0.65, curl: 0.7, phase: 0.81, spinRate: 0.83, rollTwist: -0.44 },
];

const RIBBON_WIDEST_AT = 0.32;
const RIBBON_ROOT_WIDTH_FRACTION = 0.3;
const RIBBON_TAPER_EXPONENT = 1.4;

function ribbonWidthAt(t: number): number {
  if (t < RIBBON_WIDEST_AT) return RIBBON_ROOT_WIDTH_FRACTION +
    (1 - RIBBON_ROOT_WIDTH_FRACTION) * (t / RIBBON_WIDEST_AT);
  return 1 - Math.pow((t - RIBBON_WIDEST_AT) / (1 - RIBBON_WIDEST_AT), RIBBON_TAPER_EXPONENT);
}

const WHIP_TURNS = 0.16;
const WHIP_RATE = 1.9;
const WHIP_HEIGHT_BIAS = 2.0;
const BREATHE_DEPTH = 0.13;
const BREATHE_RATE = 2.3;

const RIBBON_ROOT_COLOR: readonly [number, number, number] = [1.0, 0.82, 0.42];
const RIBBON_MID_COLOR: readonly [number, number, number] = [1.0, 0.5, 0.1];
const RIBBON_TIP_COLOR: readonly [number, number, number] = [0.55, 0.06, 0.02];
const RIBBON_MID_HEIGHT = 0.24;
const RIBBON_FADE_START = 0.62;
const RIBBON_FLICKER_RATE = 5.3;
const RIBBON_FLICKER_DEPTH = 0.3;
const RIBBON_GAIN = 1.3;
const RIBBON_ALPHA_PEAK = 0.75;
const RIBBON_ALPHA_DISCARD_THRESHOLD = 0.01;

const FLAME_HEIGHT_PER_FUEL = 1.35;
const FLAME_RADIUS_PER_FUEL = 0.42;
const INTENSITY_SIZE_FLOOR = 0.45;
const INTENSITY_BRIGHTNESS_FLOOR = 0.62;

const RIBBON_VERTICAL_SPREAD_RATIO = FLAME_RADIUS_PER_FUEL / FLAME_HEIGHT_PER_FUEL;

const TURN = Math.PI * 2;

function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

function buildRibbonGeometry(): BufferGeometry {
  const quadsPerRibbon = RIBBON_SEGMENTS;
  const verticesPerQuad = 6;
  const vertexCount = RIBBON_COUNT * quadsPerRibbon * verticesPerQuad;

  const positions = new Float32Array(vertexCount * 3);
  const ribbonIndices = new Float32Array(vertexCount);
  const alongs = new Float32Array(vertexCount);
  const edges = new Float32Array(vertexCount);
  let cursor = 0;

  const centre = (profile: RibbonProfile, t: number): [number, number, number] => {
    const angle = (profile.phase + profile.curl * t) * TURN;
    const radius = profile.rootRadius + (profile.tipRadius - profile.rootRadius) * t;
    return [Math.cos(angle) * radius, profile.height * t, Math.sin(angle) * radius];
  };

  for (let ribbon = 0; ribbon < RIBBON_COUNT; ribbon++) {
    const profile = RIBBON_PROFILES[ribbon]!;

    for (let segment = 0; segment < quadsPerRibbon; segment++) {
      const tLow = segment / quadsPerRibbon;
      const tHigh = (segment + 1) / quadsPerRibbon;

      const write = (t: number, edge: number): void => {
        const [cx, cy, cz] = centre(profile, t);
        const angle = (profile.phase + profile.curl * t) * TURN;
        const roll = profile.rollTwist * t * TURN;
        const half = (profile.width * ribbonWidthAt(t)) / 2;
        const tangentX = -Math.sin(angle);
        const tangentZ = Math.cos(angle);
        const spread = half * edge;
        const x = cx + tangentX * spread * Math.cos(roll);
        const z = cz + tangentZ * spread * Math.cos(roll);
        const y = cy + spread * Math.sin(roll) * RIBBON_VERTICAL_SPREAD_RATIO;

        positions[cursor * 3 + 0] = x;
        positions[cursor * 3 + 1] = y;
        positions[cursor * 3 + 2] = z;
        ribbonIndices[cursor] = ribbon;
        alongs[cursor] = t;
        edges[cursor] = edge;
        cursor++;
      };

      write(tLow, -1);
      write(tLow, 1);
      write(tHigh, 1);
      write(tLow, -1);
      write(tHigh, 1);
      write(tHigh, -1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aRibbon', new BufferAttribute(ribbonIndices, 1));
  geometry.setAttribute('aAlong', new BufferAttribute(alongs, 1));
  geometry.setAttribute('aEdge', new BufferAttribute(edges, 1));
  return geometry;
}

const RIBBON_SPIN_RATES = new Float32Array(RIBBON_PROFILES.map((p) => p.spinRate));

export const buildRibbonFlames: FlameRendererBuilder = (): FlameRenderer => {
  const root = new Group();
  root.name = 'fire:flames:ribbons';

  const geometry = buildRibbonGeometry();
  const material = new NodeMaterial();
  material.transparent = true;
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.depthWrite = false;
  material.side = DoubleSide;

  const mesh = new InstancedMesh(geometry, material, FIRE_FLAME_INSTANCE_CAP);
  mesh.name = 'fire:ribbons:tongues';
  mesh.count = 0;
  mesh.frustumCulled = false;
  root.add(mesh);

  const timeUniform = uniform(0);
  const spinRatesUniform = uniformArray<'float'>(Array.from(RIBBON_SPIN_RATES), 'float');
  const aSeed = attribute<'float'>('aSeed', 'float');
  const aIntensity = attribute<'float'>('aIntensity', 'float');
  const aPresence = attribute<'float'>('aPresence', 'float');
  const aRibbon = attribute<'float'>('aRibbon', 'float');
  const aAlong = attribute<'float'>('aAlong', 'float');
  const aEdge = attribute<'float'>('aEdge', 'float');

  const ribbon = int(aRibbon.add(0.5));
  const spin = spinRatesUniform.element(ribbon);

  // Two rotations about the fire's axis, summed: a steady spin, and a whip only the upper strip feels.
  const phase = timeUniform.mul(spin).add(aSeed);
  const whip = sin(timeUniform.mul(WHIP_RATE).add(aSeed.mul(7.0)).add(aRibbon.mul(1.7)))
    .mul(WHIP_TURNS)
    .mul(pow(aAlong, WHIP_HEIGHT_BIAS));
  const angle = phase.add(whip).mul(TURN);

  const c = cos(angle);
  const s = sin(angle);

  // Breathing, weighted the same way: the roots stay where the fuel is.
  const breathe = float(1.0).add(
    sin(timeUniform.mul(BREATHE_RATE).add(aSeed.mul(3.0)).add(aRibbon)).mul(BREATHE_DEPTH),
  );
  const turned = vec3(
    positionGeometry.x.mul(c).sub(positionGeometry.z.mul(s)),
    positionGeometry.y.mul(mix(float(1.0), breathe, aAlong)).mul(mix(float(0.74), 1.0, aIntensity)),
    positionGeometry.x.mul(s).add(positionGeometry.z.mul(c)),
  );

  material.vertexNode = cameraProjectionMatrix
    .mul(modelViewMatrix)
    .mul(instanceMatrix(mesh))
    .mul(vec4(turned, 1.0));

  material.fragmentNode = Fn(() => {
    const color = select(
      aAlong.lessThan(RIBBON_MID_HEIGHT),
      mix(vec3(...RIBBON_ROOT_COLOR), vec3(...RIBBON_MID_COLOR), aAlong.div(RIBBON_MID_HEIGHT)),
      mix(
        vec3(...RIBBON_MID_COLOR),
        vec3(...RIBBON_TIP_COLOR),
        aAlong.sub(RIBBON_MID_HEIGHT).div(1 - RIBBON_MID_HEIGHT),
      ),
    );

    // Fade along the strip and across it, so five overlapping strips do not read as paper.
    const lengthwise = float(1.0).sub(smoothstep(RIBBON_FADE_START, 1.0, aAlong));
    const across = float(1.0).sub(aEdge.mul(aEdge).mul(0.85));

    // Flicker travelling up the strip, keyed to the strip index so no two gutter together.
    const flicker = float(1.0).sub(
      float(0.5)
        .add(
          sin(
            aAlong
              .mul(9.0)
              .sub(timeUniform.mul(RIBBON_FLICKER_RATE))
              .mul(TURN)
              .add(aRibbon.mul(2.1))
              .add(aSeed.mul(5.0)),
          ).mul(0.5),
        )
        .mul(RIBBON_FLICKER_DEPTH),
    );

    const alpha = lengthwise
      .mul(across)
      .mul(flicker)
      .mul(aIntensity)
      .mul(aPresence)
      .mul(RIBBON_ALPHA_PEAK);
    Discard(alpha.lessThanEqual(RIBBON_ALPHA_DISCARD_THRESHOLD));
    // Premultiplied for the ONE/1-srcAlpha blend. The GLSL's display colour is inverted before the
    // premultiply, since WebGPU tone-maps what the GLSL wrote straight to the framebuffer.
    return vec4(radianceForDisplay(color.mul(RIBBON_GAIN)).mul(alpha), alpha);
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
    name: 'D — flame tongues',
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

        seedArray[i] = unitFromSeed(fire.seed, 5);
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
