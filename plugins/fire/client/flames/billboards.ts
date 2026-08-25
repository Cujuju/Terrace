// CANDIDATE B — the sprite fire. The classic particle look: a column of
// camera-facing quads, each a soft procedural flame, rising, fading and
// recycling, blended additively so overlaps bloom into a hot core.
//
// WHY THIS IS A CANDIDATE AT ALL, in a world with no textures anywhere else:
// because it is the only one of the four that can render a fire SOFTER than the
// polygons it is made of. Every other candidate's silhouette is its geometry;
// this one's silhouette is an alpha ramp, so it is the only candidate that can
// look like smoke's sibling rather than like a solid object that happens to be
// orange. If the owner wants heat haze and glow, this is the shape of it.
//
// WHERE THE TEXTURE COMES FROM. Nothing is loaded. A 128×128 CanvasTexture is
// PAINTED in this file at construction: a vertical teardrop of alpha with a
// hot white core, bitten into around its rim by a ring of deterministic notches
// so the puff's edge is ragged rather than a perfect ellipse. That raggedness is
// what stops a stack of these reading as a stack of blurred circles.
//
// HOW ONE DRAW CALL STAYS ONE DRAW CALL. Every puff of every fire is an instance
// of the SAME unit quad, in ONE InstancedMesh. The instance matrix carries only
// world position and size; the quad is turned to face the camera in the VERTEX
// SHADER (the offset is added in view space, where "facing the camera" is just
// "leave z alone"), which is also what lets the renderer billboard without ever
// being handed a camera — `update`'s signature does not have one, and going
// looking for one would be a renderer reaching outside its own contract.
//
// BUDGET: one draw call for the whole world's fire, at PUFFS_PER_FIRE ×
// FIRE_CELL_CAP instances of a two-triangle quad.

import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Texture,
} from 'three';
import { FIRE_CELL_CAP } from '../../protocol.ts';
import type { FireInstance, FlameRenderer, FlameRendererBuilder } from './types.ts';

// ── The painted puff ──────────────────────────────────────────────────────
/** Texture edge, in pixels. 128 is past what a ~40 px on-screen puff resolves. */
const PUFF_TEXTURE_SIZE = 128;
/** The puff is taller than it is wide by this much — a flame lick, not a ball. */
const PUFF_ASPECT = 0.62;
/** How many notches are bitten out of the puff's rim. */
const PUFF_NOTCH_COUNT = 13;
/** A notch reaches this far in, as a fraction of the radius, at most. */
const PUFF_NOTCH_DEPTH = 0.3;
/** Alpha ramp stops: [radius fraction, alpha]. Hot flat core, long soft skirt. */
const PUFF_ALPHA_STOPS: readonly (readonly [number, number])[] = [
  [0.0, 1.0],
  [0.26, 0.94],
  [0.5, 0.55],
  [0.78, 0.14],
  [1.0, 0.0],
];
/** The paint is white; all colour comes from the per-instance tint. */
const PUFF_CORE_WHITE = 255;

// ── The column of puffs ───────────────────────────────────────────────────
/**
 * Puffs per fire. Seven is the count at which the column reads as continuous
 * from the game's camera without the additive stack blowing to flat white in
 * the middle — five leaves visible gaps as they rise, ten is a white pillar.
 */
const PUFFS_PER_FIRE = 16;
/** Complete rise-and-recycle cycles per second. */
const PUFF_RISE_RATE = 1.15;
/** A puff rises this many times the flame height over one cycle. */
const PUFF_RISE_SPAN = 0.95;
/** Puff diameter at birth, as a fraction of the flame's width. */
const PUFF_BIRTH_SIZE = 1.0;
/** …and at death. Fire narrows as it climbs, so a puff SHRINKS as it fades. */
const PUFF_DEATH_SIZE = 0.42;
/** Lateral wander amplitude, as a fraction of flame width, at the top of a rise. */
const PUFF_WANDER = 0.55;
/**
 * Where a puff is BORN, as a fraction of flame width from the axis. Non-zero on
 * purpose: a column born on the axis rises through the middle of the tree and
 * is hidden by its own crown, which is exactly what the first pass of this
 * candidate did. Spread around a ring, the puffs climb the OUTSIDE of the fuel
 * and the tree is seen to be inside the fire rather than in front of it.
 */
const PUFF_BIRTH_RING = 0.52;
/** Turns between consecutive puffs' ring positions — the golden angle, ≈0.382. */
const PUFF_RING_STEP_TURNS = 0.381966;
/** Wander cycles per second. Deliberately not a multiple of PUFF_RISE_RATE. */
const PUFF_WANDER_RATE = 0.73;
/** Puff spin, turns per second, signed per puff so the column does not swirl one way. */
const PUFF_SPIN_RATE = 0.35;
/** Fraction of the rise spent fading IN; the rest fades out. */
const PUFF_FADE_IN_FRACTION = 0.18;

/** The tint ramp a puff walks as it rises: white-hot at birth, deep red at death. */
const PUFF_COLOR_STOPS: readonly (readonly [number, number])[] = [
  [0.0, 0xfff0c0],
  [0.28, 0xffa828],
  [0.6, 0xe8480c],
  [1.0, 0x5e0e03],
];

// ── Scaling a fire to a flame ─────────────────────────────────────────────
/** Column height as a multiple of the fuel's height, at full intensity. */
const FLAME_HEIGHT_PER_FUEL = 1.3;
/** Puff diameter as a multiple of the fuel's height. */
const FLAME_WIDTH_PER_FUEL = 0.62;
/** A dying fire is small but not gone; a dying fire is dim but not black. */
const INTENSITY_SIZE_FLOOR = 0.34;
const INTENSITY_BRIGHTNESS_FLOOR = 0.4;
/** Overall gain on the additive tint. Above 1 because a lone puff must still glow. */
const ADDITIVE_GAIN = 1.45;

const TURN = Math.PI * 2;

/** Stable 0…1 from an integer — see coneStack.ts. Never Math.random(). */
function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/** Linear sample of a [position, hex] ramp into `out`. */
function sampleRamp(
  out: Color,
  scratch: Color,
  stops: readonly (readonly [number, number])[],
  t: number,
): Color {
  for (let i = 1; i < stops.length; i++) {
    const [upper, upperColor] = stops[i]!;
    if (t > upper && i < stops.length - 1) continue;
    const [lower, lowerColor] = stops[i - 1]!;
    const span = upper - lower;
    const k = span <= 0 ? 0 : Math.min(Math.max((t - lower) / span, 0), 1);
    out.setHex(lowerColor);
    scratch.setHex(upperColor);
    return out.lerp(scratch, k);
  }
  return out.setHex(stops[0]![1]);
}

/** Alpha of the puff paint at a given radius fraction, from PUFF_ALPHA_STOPS. */
function puffAlphaAt(radiusFraction: number): number {
  const stops = PUFF_ALPHA_STOPS;
  for (let i = 1; i < stops.length; i++) {
    const [upper, upperAlpha] = stops[i]!;
    if (radiusFraction > upper && i < stops.length - 1) continue;
    const [lower, lowerAlpha] = stops[i - 1]!;
    const span = upper - lower;
    const k = span <= 0 ? 0 : Math.min(Math.max((radiusFraction - lower) / span, 0), 1);
    return lowerAlpha + (upperAlpha - lowerAlpha) * k;
  }
  return 0;
}

/**
 * Paints the puff. White RGB throughout — the colour of a puff is the job of
 * its per-instance tint, because one texture serving every stage of the ramp is
 * what keeps this to one draw call.
 *
 * Written pixel by pixel rather than with a canvas gradient because the shape is
 * not a circle: it is an ellipse whose radius is modulated by a notch function,
 * and no 2D-canvas gradient primitive draws that.
 */
function paintPuffTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = PUFF_TEXTURE_SIZE;
  canvas.height = PUFF_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('fire: 2D context unavailable for puff texture');

  const image = context.createImageData(PUFF_TEXTURE_SIZE, PUFF_TEXTURE_SIZE);
  const data = image.data;
  const half = PUFF_TEXTURE_SIZE / 2;

  // Notch depths, fixed at build time — the rim is ragged the same way every
  // run, which is what makes a screenshot reproducible.
  const notchDepths = new Float32Array(PUFF_NOTCH_COUNT);
  for (let i = 0; i < PUFF_NOTCH_COUNT; i++) {
    notchDepths[i] = unitFromSeed(i, 0x9a17) * PUFF_NOTCH_DEPTH;
  }

  for (let y = 0; y < PUFF_TEXTURE_SIZE; y++) {
    for (let x = 0; x < PUFF_TEXTURE_SIZE; x++) {
      // Normalised offset from centre, with x stretched so the puff is an
      // upright teardrop rather than a disc.
      const nx = (x + 0.5 - half) / (half * PUFF_ASPECT);
      const ny = (y + 0.5 - half) / half;
      const radius = Math.sqrt(nx * nx + ny * ny);
      const angle = Math.atan2(ny, nx);

      // Rim notches: interpolated between neighbouring notch depths so the
      // boundary is scalloped rather than serrated.
      const notchPosition = ((angle / TURN) + 1) * PUFF_NOTCH_COUNT;
      const notchIndex = Math.floor(notchPosition) % PUFF_NOTCH_COUNT;
      const notchBlend = notchPosition - Math.floor(notchPosition);
      const depthA = notchDepths[notchIndex]!;
      const depthB = notchDepths[(notchIndex + 1) % PUFF_NOTCH_COUNT]!;
      const smooth = notchBlend * notchBlend * (3 - 2 * notchBlend);
      const notch = depthA + (depthB - depthA) * smooth;
      // The notches only bite the OUTER half; a flame's core is solid.
      const bite = notch * Math.min(Math.max((radius - 0.4) / 0.6, 0), 1);

      const alpha = puffAlphaAt(Math.min(radius + bite, 1));
      const offset = (y * PUFF_TEXTURE_SIZE + x) * 4;
      data[offset + 0] = PUFF_CORE_WHITE;
      data[offset + 1] = PUFF_CORE_WHITE;
      data[offset + 2] = PUFF_CORE_WHITE;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  context.putImageData(image, 0, 0);

  const texture = new CanvasTexture(canvas);
  // No mipmaps: the puff is drawn at roughly one size, and a mip chain on an
  // additive sprite mostly buys a grey halo where the chain averages the skirt.
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

/**
 * Vertex shader. The quad is expanded in VIEW space around the instance's
 * world position, which is what makes it face the camera; `aRoll` spins it in
 * that plane and `aTint` carries its colour and its fade (additive blending
 * means a dimmer tint IS a fade — there is no separate alpha to animate).
 */
const PUFF_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aTint;
  attribute float aRoll;

  varying vec2 vUv;
  varying vec3 vTint;

  void main() {
    vUv = uv;
    vTint = aTint;

    // Column 3 of the instance matrix is the puff's position in the root's
    // space; column 0's length is its uniform size.
    vec3 instancePosition = instanceMatrix[3].xyz;
    float size = length(instanceMatrix[0].xyz);

    float c = cos(aRoll);
    float s = sin(aRoll);
    vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c);

    vec4 viewPosition = modelViewMatrix * vec4(instancePosition, 1.0);
    viewPosition.xy += corner * size;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

/** Fragment shader: paint × tint, additively. */
const PUFF_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uPuff;

  varying vec2 vUv;
  varying vec3 vTint;

  void main() {
    vec4 paint = texture2D(uPuff, vUv);
    if (paint.a <= 0.004) discard;
    gl_FragColor = vec4(vTint * paint.rgb, paint.a);
  }
`;

/** Candidate B: a rising, recycling column of procedural sprites per fire. */
export const buildBillboardFlames: FlameRendererBuilder = (): FlameRenderer => {
  const root = new Group();
  root.name = 'fire:flames:billboards';

  const texture = paintPuffTexture();
  const geometry = new PlaneGeometry(1, 1);
  const material = new ShaderMaterial({
    uniforms: { uPuff: { value: texture } },
    vertexShader: PUFF_VERTEX_SHADER,
    fragmentShader: PUFF_FRAGMENT_SHADER,
    transparent: true,
    blending: AdditiveBlending,
    // Additive sprites must not write depth: whichever one drew first would
    // otherwise punch a hole in every puff behind it.
    depthWrite: false,
    depthTest: true,
  });

  const capacity = FIRE_CELL_CAP * PUFFS_PER_FIRE;
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'fire:billboards:puffs';
  mesh.count = 0;
  mesh.frustumCulled = false;
  root.add(mesh);

  // Per-instance tint and roll. Written every frame alongside the matrices.
  const tints = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  const rolls = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  tints.setUsage(DynamicDrawUsage);
  rolls.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aTint', tints);
  geometry.setAttribute('aRoll', rolls);

  // The drawn set.
  const fireX = new Float32Array(FIRE_CELL_CAP);
  const fireY = new Float32Array(FIRE_CELL_CAP);
  const fireZ = new Float32Array(FIRE_CELL_CAP);
  const fireHeight = new Float32Array(FIRE_CELL_CAP);
  const fireWidth = new Float32Array(FIRE_CELL_CAP);
  const fireBrightness = new Float32Array(FIRE_CELL_CAP);
  const firePhase = new Float32Array(FIRE_CELL_CAP);
  let fireCount = 0;

  // Scratch.
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  const tint = new Color();
  const tintScratch = new Color();

  return {
    name: 'B — sprite column',
    root,

    apply(fires: readonly FireInstance[]): void {
      fireCount = Math.min(fires.length, FIRE_CELL_CAP);
      for (let i = 0; i < fireCount; i++) {
        const fire = fires[i]!;
        const intensity = Math.min(Math.max(fire.intensity, 0), 1);
        const sizeScale = INTENSITY_SIZE_FLOOR + (1 - INTENSITY_SIZE_FLOOR) * intensity;
        fireX[i] = fire.x;
        fireY[i] = fire.groundY;
        fireZ[i] = fire.z;
        fireHeight[i] = fire.fuelHeight * FLAME_HEIGHT_PER_FUEL * sizeScale;
        fireWidth[i] = fire.fuelHeight * FLAME_WIDTH_PER_FUEL * sizeScale;
        fireBrightness[i] =
          ADDITIVE_GAIN *
          (INTENSITY_BRIGHTNESS_FLOOR + (1 - INTENSITY_BRIGHTNESS_FLOOR) * intensity);
        firePhase[i] = unitFromSeed(fire.seed, 3);
      }
      mesh.count = fireCount * PUFFS_PER_FIRE;
    },

    update(_dt: number, elapsed: number): void {
      if (fireCount === 0) return;

      const tintArray = tints.array as Float32Array;
      const rollArray = rolls.array as Float32Array;
      let instance = 0;

      for (let i = 0; i < fireCount; i++) {
        const width = fireWidth[i]!;
        const height = fireHeight[i]!;
        const phase = firePhase[i]!;

        for (let puff = 0; puff < PUFFS_PER_FIRE; puff++) {
          // Life of this puff, 0 at birth to 1 at recycle. Evenly staggered
          // across the column and offset by the fire's own phase, so no two
          // fires pulse together and no puff is ever born on top of another.
          const raw = elapsed * PUFF_RISE_RATE + phase + puff / PUFFS_PER_FIRE;
          const life = raw - Math.floor(raw);

          // Rise eases off near the top: hot gas decelerates, and a linear
          // rise reads as a conveyor belt.
          const rise = height * PUFF_RISE_SPAN * (1 - (1 - life) * (1 - life));
          // Birth ring plus wander: the ring spaces the puffs around the fuel
          // (golden-angle stepping, so consecutive puffs never share a side),
          // the wander drifts them off it as they climb, and both shrink to
          // nothing as the puff nears the top of its rise — a fire narrows.
          const ringAngle = (phase + puff * PUFF_RING_STEP_TURNS) * TURN;
          const wanderAngle = ringAngle + elapsed * PUFF_WANDER_RATE * TURN;
          const ring = width * PUFF_BIRTH_RING * (1 - life * 0.7);
          const wander = width * PUFF_WANDER * life;

          position.set(
            fireX[i]! + Math.cos(ringAngle) * ring + Math.cos(wanderAngle) * wander,
            fireY[i]! + rise,
            fireZ[i]! + (Math.sin(ringAngle) * ring + Math.sin(wanderAngle) * wander) * 0.7,
          );
          const size = width * (PUFF_BIRTH_SIZE + (PUFF_DEATH_SIZE - PUFF_BIRTH_SIZE) * life);
          scale.setScalar(size);
          matrix.compose(position, rotation, scale);
          mesh.setMatrixAt(instance, matrix);

          // Fade in fast, out slow — the fade is carried entirely by the tint
          // because the blend is additive.
          const fade =
            life < PUFF_FADE_IN_FRACTION
              ? life / PUFF_FADE_IN_FRACTION
              : 1 - (life - PUFF_FADE_IN_FRACTION) / (1 - PUFF_FADE_IN_FRACTION);
          sampleRamp(tint, tintScratch, PUFF_COLOR_STOPS, life);
          const gain = fade * fireBrightness[i]!;
          tintArray[instance * 3 + 0] = tint.r * gain;
          tintArray[instance * 3 + 1] = tint.g * gain;
          tintArray[instance * 3 + 2] = tint.b * gain;

          // Signed spin: even puffs roll one way, odd the other.
          rollArray[instance] =
            (phase + puff) * TURN + elapsed * PUFF_SPIN_RATE * TURN * (puff % 2 === 0 ? 1 : -1);

          instance++;
        }
      }

      mesh.instanceMatrix.needsUpdate = true;
      tints.needsUpdate = true;
      rolls.needsUpdate = true;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      texture.dispose();
      root.clear();
    },
  };
};
