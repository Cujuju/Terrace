// CANDIDATE C — the shader plume. ONE tapered, open-ended sleeve of geometry per
// fire, whose silhouette is not modelled at all: the vertex shader pushes every
// ring of it around with value noise, so the plume writhes, necks, gutters and
// leans as a continuous body of gas.
//
// WHY THIS IS THE INTERESTING CANDIDATE. A and D animate by moving whole pieces:
// their vertices are rigid, and what changes is where the pieces are. Fire does
// not do that — fire is a surface being deformed from the inside. That is
// affordable only on the GPU, so this is the candidate where the flame's SHAPE
// is per-vertex and per-frame, and the CPU's entire job per frame is writing one
// float into one uniform.
//
// NO TEXTURE, no canvas, no ramp table: the colour is computed from height in
// the fragment shader, and the flicker from the same noise function the vertex
// shader warps with, evaluated at a different scale.
//
// THE NOISE. Cheap 2D value noise — hash the four lattice corners, smoothstep
// between them. Two octaves, because one octave is a slow wobble and three costs
// more than the silhouette gains at this size on screen. It is fed
// (heightAlongPlume × frequency − time × speed, perInstanceSeed): scrolling the
// FIRST axis downward with time is what makes the deformation travel UP the
// plume, which is the single thing that makes a warped cone read as fire rather
// than as jelly.
//
// BUDGET: one InstancedMesh, one draw call for the world, whatever is burning.

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
import type { FireInstance, FlameRenderer, FlameRendererBuilder } from './types.ts';

// ── The sleeve ────────────────────────────────────────────────────────────
/**
 * Radial and vertical tessellation of the sleeve. The height segments are the
 * expensive number and the one that matters: they are the joints the noise
 * bends the plume at, and at fewer than a dozen the writhe reads as a folded
 * paper bag. 10 × 18 is ~360 quads per fire — cheap on a card, and it is
 * instanced, so it is uploaded exactly once.
 */
const PLUME_RADIAL_SEGMENTS = 10;
const PLUME_HEIGHT_SEGMENTS = 18;
/** Unit sleeve: 1 tall, radius 1 at the foot, tapering to this at the tip. */
const PLUME_TIP_RADIUS_FRACTION = 0.18;

// ── Warp ──────────────────────────────────────────────────────────────────
/** Noise cycles along the plume's height. ~3 lobes of writhe from foot to tip. */
const WARP_FREQUENCY = 3.7;
/** How fast the warp travels up the plume, in noise cycles per second. */
const WARP_SCROLL_SPEED = 1.35;
/** Sideways displacement at the TIP, as a fraction of the plume's foot radius. */
const WARP_LATERAL_AMPLITUDE = 0.85;
/** How hard the noise pinches and swells the plume's radius, as a fraction. */
const WARP_RADIUS_AMPLITUDE = 0.5;
/**
 * The warp is scaled by (height^this) so the FOOT of the plume stays anchored
 * on the fuel. An unweighted warp slides the whole flame off the tree it is
 * supposed to be consuming — the defect this exponent exists to prevent.
 */
const WARP_HEIGHT_BIAS = 1.5;

// ── Colour and alpha ──────────────────────────────────────────────────────
/** The height ramp, as three stops the fragment shader mixes between. */
const PLUME_CORE_COLOR: readonly [number, number, number] = [1.0, 0.86, 0.5];
const PLUME_MID_COLOR: readonly [number, number, number] = [1.0, 0.42, 0.06];
/**
 * TIP, RAISED off near-black red on 2026-08-24. The tip is the only part of a
 * plume that is ever seen against the SKY — everything below it is over grass or
 * over the tree — and 0.62/0.08/0.03 against a pale sky read as soot, not as
 * flame. A hot ember red keeps the ramp's direction (cooling upward) while
 * staying a colour fire actually goes.
 */
const PLUME_TIP_COLOR: readonly [number, number, number] = [0.88, 0.22, 0.05];
/**
 * Height fraction at which the ramp reaches the mid colour.
 *
 * RAISED from 0.26 with the tip colour above: at 0.26 three quarters of the
 * plume was already past orange and sliding into the tip, so the part that
 * clears the crown — the part anyone actually sees — was the coldest part of the
 * flame. 0.42 keeps the body orange up to and through the canopy line.
 */
const PLUME_MID_HEIGHT = 0.42;
/** Above this height the plume is guttering out; alpha falls to zero by 1.0. */
const PLUME_GUTTER_HEIGHT = 0.5;
/** Flicker: noise cycles per second, and how much of the alpha it eats. */
const PLUME_FLICKER_SPEED = 4.7;
const PLUME_FLICKER_DEPTH = 0.45;
/**
 * SILHOUETTE. The sleeve's own geometry is a straight taper — a cone — and a
 * cone is the primitive this candidate must not read as. These three numbers
 * bend it into a flame profile in the vertex shader: a narrower foot where the
 * gas leaves the fuel, a belly a third of the way up, and a long taper to the
 * tip. `WAIST` is the radius factor at the extremes, `BELLY_GAIN` how far the
 * belly swells past it, and `BELLY_BIAS` places the widest point (an exponent
 * ABOVE 1 on the height pushes it UP; below 1 it slides down to the foot, which
 * renders as a balloon sitting on the ground — the second pass of this
 * candidate did exactly that).
 */
const PLUME_WAIST = 0.42;
const PLUME_BELLY_GAIN = 0.75;
const PLUME_BELLY_BIAS = 1.4;
/**
 * Alpha ceiling.
 *
 * WHY THIS CANDIDATE IS NOT ADDITIVE, unlike B and D. Additive blending adds the
 * flame to whatever is behind it, and what is behind a burning tree in this game
 * is BRIGHT GREEN GRASS. A half-transparent orange added to that grass is a pale
 * yellow-green — which is exactly what the first two passes of this candidate
 * rendered. Normal blending REPLACES instead of adding, so the plume keeps its
 * own colour over any ground, and the writhing silhouette (this candidate's
 * whole point) stays legible instead of dissolving into the terrain.
 */
const PLUME_ALPHA_PEAK = 0.92;
/** Overall additive gain. */
const PLUME_GAIN = 1.0;

// ── Scaling a fire to a flame ─────────────────────────────────────────────
const FLAME_HEIGHT_PER_FUEL = 1.4;
const FLAME_RADIUS_PER_FUEL = 0.24;
const INTENSITY_SIZE_FLOOR = 0.34;
/**
 * Opacity floor, RAISED from 0.4 on 2026-08-24 after the renders showed a
 * catching fire as a brown smudge.
 *
 * Intensity governs a flame's SIZE, and should barely govern its opacity: a
 * small fire is not a see-through fire, it is a small one. At 0.4 the young
 * plume was blended half-and-half with bright green grass, which is how orange
 * becomes brown. 0.7 keeps the young flame's own colour and leaves intensity to
 * say what it should say — how much of it there is.
 */
const INTENSITY_BRIGHTNESS_FLOOR = 0.7;

/** Stable 0…1 from an integer — see coneStack.ts. Never Math.random(). */
function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/**
 * The shared noise, injected into both stages. `vnoise` is bilinear value noise;
 * `fnoise` is two octaves of it, which is what gives the plume both a slow lean
 * and a fine gutter without a second noise function.
 */
const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float vnoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    vec2 smoothed = f * f * (3.0 - 2.0 * f);
    float a = hash21(cell);
    float b = hash21(cell + vec2(1.0, 0.0));
    float c = hash21(cell + vec2(0.0, 1.0));
    float d = hash21(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, smoothed.x), mix(c, d, smoothed.x), smoothed.y) * 2.0 - 1.0;
  }

  float fnoise(vec2 p) {
    return vnoise(p) * 0.65 + vnoise(p * 2.17 + 11.3) * 0.35;
  }
`;

const PLUME_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;

  attribute float aSeed;
  attribute float aIntensity;
  attribute float aPresence;

  varying float vHeight;
  varying float vSeed;
  varying float vAngle;
  varying float vIntensity;
  varying float vPresence;

  ${NOISE_GLSL}

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

const PLUME_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;

  varying float vHeight;
  varying float vSeed;
  varying float vAngle;
  varying float vIntensity;
  varying float vPresence;

  ${NOISE_GLSL}

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

/** Candidate C: one noise-warped, unlit plume per fire, animated entirely on the GPU. */
export const buildShaderPlumeFlames: FlameRendererBuilder = (): FlameRenderer => {
  const root = new Group();
  root.name = 'fire:flames:shaderPlume';

  // Open-ended: the plume has no lid and no floor. Both would be visible as
  // flat discs the moment the camera looked down the axis, which this game's
  // camera does constantly.
  const geometry = new CylinderGeometry(
    PLUME_TIP_RADIUS_FRACTION,
    1,
    1,
    PLUME_RADIAL_SEGMENTS,
    PLUME_HEIGHT_SEGMENTS,
    true,
  );
  // Foot at the origin, so position.y is the height fraction in the shader.
  geometry.translate(0, 0.5, 0);

  const material = new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: PLUME_VERTEX_SHADER,
    fragmentShader: PLUME_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // A sleeve seen from outside still shows its inner far wall through the
    // near one under additive blending; that double-thickness at the
    // silhouette edges is the plume's own depth, and culling it flattens it.
    side: DoubleSide,
  });

  const mesh = new InstancedMesh(geometry, material, FIRE_FLAME_INSTANCE_CAP);
  mesh.name = 'fire:shaderPlume:plumes';
  mesh.count = 0;
  // The warp moves vertices past the geometry's own bounds, so the cached
  // bounding sphere would cull a plume that is still on screen.
  mesh.frustumCulled = false;
  root.add(mesh);

  const seeds = new InstancedBufferAttribute(new Float32Array(FIRE_FLAME_INSTANCE_CAP), 1);
  const intensities = new InstancedBufferAttribute(new Float32Array(FIRE_FLAME_INSTANCE_CAP), 1);
  seeds.setUsage(DynamicDrawUsage);
  intensities.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aIntensity', intensities);

  // PRESENCE — how much of THIS look to draw (../flames/types.ts). Its own
  // attribute rather than folded into aIntensity, because aIntensity also
  // drives the flame's HEIGHT in the vertex shader: folding them would make a
  // half-faded flame a short one, and the compositor's whole contract is that a
  // fading look keeps its size and loses only its opacity.
  const presences = new InstancedBufferAttribute(new Float32Array(FIRE_FLAME_INSTANCE_CAP), 1);
  presences.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aPresence', presences);

  // Scratch — used only by `apply`, but allocated here all the same: `apply`
  // runs on every server delta of a spreading fire, which is often enough.
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  return {
    name: 'C — noise plume',
    root,

    apply(fires: readonly FireInstance[]): void {
      const count = Math.min(fires.length, FIRE_FLAME_INSTANCE_CAP);
      const seedArray = seeds.array as Float32Array;
      const intensityArray = intensities.array as Float32Array;
      const presenceArray = presences.array as Float32Array;

      for (let i = 0; i < count; i++) {
        const fire = fires[i]!;
        const intensity = Math.min(Math.max(fire.intensity, 0), 1);
        const sizeScale = INTENSITY_SIZE_FLOOR + (1 - INTENSITY_SIZE_FLOOR) * intensity;
        // Height and radius do NOT scale together: a young fire is squat and
        // broad, a fierce one is a column. See PLUME_LOW_INTENSITY_SPREAD.


        position.set(fire.x, fire.groundY, fire.z);
        scale.set(
          fire.fuelHeight * FLAME_RADIUS_PER_FUEL * sizeScale,
          fire.fuelHeight * FLAME_HEIGHT_PER_FUEL * sizeScale,
          fire.fuelHeight * FLAME_RADIUS_PER_FUEL * sizeScale,
        );
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(i, matrix);

        // The seed is a phase, not an index: scaled into a range wide enough
        // that two neighbouring cells land in different noise cells entirely.
        seedArray[i] = unitFromSeed(fire.seed, 4) * 64;
        intensityArray[i] =
          INTENSITY_BRIGHTNESS_FLOOR + (1 - INTENSITY_BRIGHTNESS_FLOOR) * intensity;
        // Absent presence means "draw me fully" — a renderer used on its own,
        // with no compositor above it, never sees anything else.
        presenceArray[i] = fire.presence === undefined ? 1 : Math.min(Math.max(fire.presence, 0), 1);
      }

      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      seeds.needsUpdate = true;
      intensities.needsUpdate = true;
      presences.needsUpdate = true;
    },

    update(_dt: number, elapsed: number): void {
      // The whole per-frame cost of this candidate. Everything else the flame
      // does happens on the GPU.
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
