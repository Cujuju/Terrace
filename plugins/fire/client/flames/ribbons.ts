// CANDIDATE D — flame tongues. Not a cone, not a sprite, not a plume: five thin,
// twisted, tapering RIBBONS wrapped around the fire's axis, each curling and
// spinning at its own rate, so what the eye reads is licking — the separate
// strands a real flame is made of, momentarily individual before they merge.
//
// WHY A RIBBON. Every other candidate models fire as a VOLUME and then tries to
// make the volume look unstable. A ribbon is the opposite bet: a flame's
// silhouette is dominated by thin sheets of burning gas, and drawing those
// sheets literally — a strip a few centimetres wide, twisted along its length,
// tapering to nothing — gets the licking motion for free, because a twisted
// strip turning about its axis alternately shows its face and its edge and so
// appears to flare and vanish without changing a vertex.
//
// ONE GEOMETRY, FIVE RIBBONS, DIFFERENT RATES. The ribbons are MERGED into a
// single buffer at build time and every vertex carries `aRibbon`, the index of
// the strip it belongs to. The vertex shader rotates each strip about the fire's
// axis by a rate keyed to that index, so five strips move independently inside
// ONE instanced draw. Splitting them into five InstancedMeshes would have been
// the easy way to vary the rates, and it would have cost five draw calls to buy
// what one attribute buys here.
//
// The curl is authored into the geometry (each strip's centreline already
// spirals) and ANIMATED on top of it: the shader adds a time-varying twist that
// grows with height, so the tips whip while the roots stay planted on the fuel.
//
// BUDGET: one InstancedMesh, one draw call for every fire in the world.

import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { FIRE_CELL_CAP } from '../../protocol.ts';
import type { FireInstance, FlameRenderer, FlameRendererBuilder } from './types.ts';

// ── The strips ────────────────────────────────────────────────────────────
/**
 * Five. Three reads as a fleur-de-lis — a shape, not a fire; seven at this
 * width closes into a solid cone and throws away the point of the candidate.
 */
const RIBBON_COUNT = 5;
/**
 * Quads along one strip. The strip is bent along its whole length by both the
 * authored spiral and the shader's twist, so this is the resolution of the
 * curve, not decoration: at 8 the bend is visibly polygonal.
 */
const RIBBON_SEGMENTS = 14;

/** One strip's authored shape. All fractions of the fire's flame size. */
interface RibbonProfile {
  /** Height reached, as a fraction of the flame height. */
  readonly height: number;
  /** Distance of the strip's root from the axis, as a fraction of flame radius. */
  readonly rootRadius: number;
  /** …and of its tip. Less than the root: the strips close over the fire. */
  readonly tipRadius: number;
  /** Width of the strip at its root, as a fraction of flame radius. */
  readonly width: number;
  /** Turns the strip's centreline makes about the axis from root to tip. */
  readonly curl: number;
  /** Where the strip starts around the axis, in turns. */
  readonly phase: number;
  /** Turns per second this strip makes about the fire's axis. Signed. */
  readonly spinRate: number;
  /** How hard the strip twists about its OWN length, in turns, root to tip. */
  readonly rollTwist: number;
}

/**
 * Deliberately irregular: no two strips share a height, a curl or a rate, and
 * the rates are mutually irrational-ish so the clump's silhouette does not
 * repeat on any short period. The tallest strip is the only one to reach the
 * full flame height — a fire has one leading tongue, not five.
 */
const RIBBON_PROFILES: readonly RibbonProfile[] = [
  { height: 1.0, rootRadius: 0.36, tipRadius: 0.14, width: 0.99, curl: 0.32, phase: 0.0, spinRate: 0.29, rollTwist: 0.62 },
  { height: 0.82, rootRadius: 0.54, tipRadius: 0.22, width: 0.83, curl: -0.44, phase: 0.2, spinRate: -0.43, rollTwist: -0.85 },
  { height: 0.68, rootRadius: 0.70, tipRadius: 0.30, width: 0.75, curl: 0.55, phase: 0.42, spinRate: 0.61, rollTwist: 0.5 },
  { height: 0.9, rootRadius: 0.48, tipRadius: 0.16, width: 0.88, curl: -0.28, phase: 0.63, spinRate: -0.19, rollTwist: 0.74 },
  { height: 0.56, rootRadius: 0.77, tipRadius: 0.41, width: 0.65, curl: 0.7, phase: 0.81, spinRate: 0.83, rollTwist: -0.44 },
];

/** Where along a strip it is at full width — low, like a flame's shoulders. */
const RIBBON_WIDEST_AT = 0.32;
/** Width at the strip's root, as a fraction of its full width. */
const RIBBON_ROOT_WIDTH_FRACTION = 0.3;
/** Taper above the widest point. Above 1: holds width, then falls away quickly. */
const RIBBON_TAPER_EXPONENT = 1.4;

/**
 * Width profile along a strip: narrow at the root, full width low down, then
 * tapering to a point. A strip that tapers linearly from the root is a triangle
 * and reads as one.
 */
function ribbonWidthAt(t: number): number {
  // Narrow at the root, widest at RIBBON_WIDEST, tapering to a point.
  //
  // The root narrowing is not decoration. A strip that is full width where it
  // meets the ground is a horizontal blade half a unit across lying flat on the
  // terrain, and from this game's overhead-ish camera that is exactly what it
  // looks like — the white slabs the second pass of this candidate rendered
  // around the foot of every tree.
  if (t < RIBBON_WIDEST_AT) return RIBBON_ROOT_WIDTH_FRACTION +
    (1 - RIBBON_ROOT_WIDTH_FRACTION) * (t / RIBBON_WIDEST_AT);
  return 1 - Math.pow((t - RIBBON_WIDEST_AT) / (1 - RIBBON_WIDEST_AT), RIBBON_TAPER_EXPONENT);
}

// ── Animated twist ────────────────────────────────────────────────────────
/** Extra turns about the axis the tip whips through, amplitude and rate. */
const WHIP_TURNS = 0.16;
const WHIP_RATE = 1.9;
/** The whip is weighted by height^this, so roots stay on the fuel. */
const WHIP_HEIGHT_BIAS = 2.0;
/** Vertical breathing: the strips stretch and shrink by this fraction, at this rate. */
const BREATHE_DEPTH = 0.13;
const BREATHE_RATE = 2.3;

// ── Colour ────────────────────────────────────────────────────────────────
const RIBBON_ROOT_COLOR: readonly [number, number, number] = [1.0, 0.82, 0.42];
const RIBBON_MID_COLOR: readonly [number, number, number] = [1.0, 0.5, 0.1];
const RIBBON_TIP_COLOR: readonly [number, number, number] = [0.55, 0.06, 0.02];
const RIBBON_MID_HEIGHT = 0.24;
/** The strip fades out over its last stretch rather than ending in a hard edge. */
const RIBBON_FADE_START = 0.62;
/** Flicker along the strip: cycles per second and depth. */
const RIBBON_FLICKER_RATE = 5.3;
const RIBBON_FLICKER_DEPTH = 0.3;
/** Additive gain. Higher than the plume's: a strip is thin and overlaps less. */
const RIBBON_GAIN = 1.3;
/**
 * Alpha ceiling per strip. Five strips, each drawn front and back, overlap near
 * the axis; without a ceiling that stack saturates and the ramp below is thrown
 * away.
 */
const RIBBON_ALPHA_PEAK = 0.75;

// ── Scaling a fire to a flame ─────────────────────────────────────────────
const FLAME_HEIGHT_PER_FUEL = 1.35;
const FLAME_RADIUS_PER_FUEL = 0.42;
const INTENSITY_SIZE_FLOOR = 0.45;
/**
 * RAISED from 0.4 on 2026-08-24, when these ribbons became the look that owns
 * the LOW end of every fire (./ribbonsToPlume.ts). Intensity should say how much
 * flame there is, not how see-through it is: at 0.4 a catching fire was blended
 * half-and-half with bright green grass, which is how orange becomes brown.
 */
const INTENSITY_BRIGHTNESS_FLOOR = 0.62;

/**
 * How much of a strip's roll shows as VERTICAL spread, relative to horizontal.
 *
 * This is not a taste knob. The geometry is authored in a unit space that the
 * instance matrix scales ANISOTROPICALLY — by the flame's radius across, by its
 * height up — so half a unit of spread rolled into Y comes out several times
 * longer on screen than the same half unit left in XZ. Left uncorrected, a
 * rolled strip renders as a spike twice the height of the tree (it did), which
 * is why the ratio of the two scales is the value here.
 */
const RIBBON_VERTICAL_SPREAD_RATIO = FLAME_RADIUS_PER_FUEL / FLAME_HEIGHT_PER_FUEL;

const TURN = Math.PI * 2;

/** Stable 0…1 from an integer — see coneStack.ts. Never Math.random(). */
function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/**
 * Builds all RIBBON_COUNT strips into ONE geometry, in a unit space: 1 tall,
 * radius 1, so the instance matrix scales it to any fire.
 *
 * Per vertex: position, `aRibbon` (which strip — the shader's key to its rate),
 * `aAlong` (0 at the root, 1 at the tip) and `aEdge` (−1/+1, which side of the
 * strip, so the shader can widen or narrow it without a normal).
 */
function buildRibbonGeometry(): BufferGeometry {
  const quadsPerRibbon = RIBBON_SEGMENTS;
  const verticesPerQuad = 6;
  const vertexCount = RIBBON_COUNT * quadsPerRibbon * verticesPerQuad;

  const positions = new Float32Array(vertexCount * 3);
  const ribbonIndices = new Float32Array(vertexCount);
  const alongs = new Float32Array(vertexCount);
  const edges = new Float32Array(vertexCount);
  let cursor = 0;

  // Centreline of strip `profile` at parameter t, written into (x, y, z).
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
        // The strip is widened along the horizontal normal of its own
        // centreline — the tangent turned a quarter turn — plus a roll about
        // that centreline, which is what twists the face in and out of view.
        const angle = (profile.phase + profile.curl * t) * TURN;
        const roll = profile.rollTwist * t * TURN;
        const half = (profile.width * ribbonWidthAt(t)) / 2;
        // Tangential direction of the spiral, in the horizontal plane.
        const tangentX = -Math.sin(angle);
        const tangentZ = Math.cos(angle);
        // Rolling mixes that horizontal spread with a vertical one, so the
        // strip presents its face, then its edge, then its face again.
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

/** Spin rates, flattened for the shader: one lookup per strip index. */
const RIBBON_SPIN_RATES = new Float32Array(RIBBON_PROFILES.map((p) => p.spinRate));

const RIBBON_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uSpinRates[${RIBBON_COUNT}];

  attribute float aSeed;
  attribute float aIntensity;
  attribute float aPresence;
  attribute float aRibbon;
  attribute float aAlong;
  attribute float aEdge;

  varying float vAlong;
  varying float vEdge;
  varying float vSeed;
  varying float vIntensity;
  varying float vPresence;
  varying float vRibbon;

  void main() {
    vAlong = aAlong;
    vEdge = aEdge;
    vSeed = aSeed;
    vIntensity = aIntensity;
    vPresence = aPresence;
    vRibbon = aRibbon;

    int ribbon = int(aRibbon + 0.5);
    float spin = uSpinRates[ribbon];

    // Two rotations about the fire's axis, summed: a steady spin for the whole
    // strip, and a whip that only the upper part of the strip feels.
    float phase = uTime * spin + vSeed;
    float whip = sin(uTime * ${WHIP_RATE.toFixed(2)} + vSeed * 7.0 + aRibbon * 1.7)
      * ${WHIP_TURNS.toFixed(2)} * pow(aAlong, ${WHIP_HEIGHT_BIAS.toFixed(2)});
    float angle = (phase + whip) * ${TURN.toFixed(6)};

    float c = cos(angle);
    float s = sin(angle);
    vec3 turned = vec3(
      position.x * c - position.z * s,
      position.y,
      position.x * s + position.z * c);

    // Breathing, weighted the same way — the roots stay where the fuel is.
    float breathe = 1.0 + sin(uTime * ${BREATHE_RATE.toFixed(2)} + vSeed * 3.0 + aRibbon)
      * ${BREATHE_DEPTH.toFixed(2)};
    turned.y *= mix(1.0, breathe, aAlong) * mix(0.74, 1.0, aIntensity);

    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(turned, 1.0);
  }
`;

const RIBBON_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;

  varying float vAlong;
  varying float vEdge;
  varying float vSeed;
  varying float vIntensity;
  varying float vPresence;
  varying float vRibbon;

  void main() {
    vec3 color = vAlong < ${RIBBON_MID_HEIGHT.toFixed(2)}
      ? mix(
          vec3(${RIBBON_ROOT_COLOR.map((c) => c.toFixed(3)).join(', ')}),
          vec3(${RIBBON_MID_COLOR.map((c) => c.toFixed(3)).join(', ')}),
          vAlong / ${RIBBON_MID_HEIGHT.toFixed(2)})
      : mix(
          vec3(${RIBBON_MID_COLOR.map((c) => c.toFixed(3)).join(', ')}),
          vec3(${RIBBON_TIP_COLOR.map((c) => c.toFixed(3)).join(', ')}),
          (vAlong - ${RIBBON_MID_HEIGHT.toFixed(2)}) / ${(1 - RIBBON_MID_HEIGHT).toFixed(2)});

    // Fade along the strip, and across it: a burning sheet has no hard side
    // edge either, and feathering the sides is what keeps five overlapping
    // strips from reading as five ribbons of paper.
    float lengthwise = 1.0 - smoothstep(${RIBBON_FADE_START.toFixed(2)}, 1.0, vAlong);
    float across = 1.0 - vEdge * vEdge * 0.85;

    // Flicker travelling UP the strip, keyed to the strip index so no two of
    // the five gutter together.
    float flicker = 1.0 - ${RIBBON_FLICKER_DEPTH.toFixed(2)} *
      (0.5 + 0.5 * sin((vAlong * 9.0 - uTime * ${RIBBON_FLICKER_RATE.toFixed(2)}) * ${TURN.toFixed(6)}
        + vRibbon * 2.1 + vSeed * 5.0));

    float alpha = lengthwise * across * flicker * vIntensity * vPresence * ${RIBBON_ALPHA_PEAK.toFixed(2)};
    if (alpha <= 0.01) discard;
    // Premultiplied: the colour is scaled by its own alpha before it leaves
    // the shader, which is what the ONE/1−srcAlpha blend above expects.
    gl_FragColor = vec4(color * ${RIBBON_GAIN.toFixed(2)} * alpha, alpha);
  }
`;

/** Candidate D: five twisted, tapering, counter-spinning tongues per fire. */
export const buildRibbonFlames: FlameRendererBuilder = (): FlameRenderer => {
  const root = new Group();
  root.name = 'fire:flames:ribbons';

  const geometry = buildRibbonGeometry();
  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSpinRates: { value: RIBBON_SPIN_RATES },
    },
    vertexShader: RIBBON_VERTEX_SHADER,
    fragmentShader: RIBBON_FRAGMENT_SHADER,
    transparent: true,
    // PREMULTIPLIED-ALPHA blending: src ONE, dst 1−srcAlpha. This is additive
    // where the strip is faint and opaque where it is dense, in ONE blend
    // equation — which is the behaviour fire actually needs here. Straight
    // additive was tried first and fails on this world specifically: what a
    // burning tree stands on is BRIGHT GREEN GRASS, and orange added to bright
    // green is a pale yellow whatever the gain, so every strip washed out to
    // the same pastel. Premultiplied keeps the hot cores their own colour and
    // still lets the feathered edges glow into whatever is behind them.
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    depthWrite: false,
    // A strip has two faces and both burn.
    side: DoubleSide,
  });

  const mesh = new InstancedMesh(geometry, material, FIRE_CELL_CAP);
  mesh.name = 'fire:ribbons:tongues';
  mesh.count = 0;
  // The whip and the breathing move vertices past the authored bounds.
  mesh.frustumCulled = false;
  root.add(mesh);

  const seeds = new InstancedBufferAttribute(new Float32Array(FIRE_CELL_CAP), 1);
  const intensities = new InstancedBufferAttribute(new Float32Array(FIRE_CELL_CAP), 1);
  seeds.setUsage(DynamicDrawUsage);
  intensities.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aIntensity', intensities);

  // PRESENCE — how much of THIS look to draw (../flames/types.ts). Its own
  // attribute rather than folded into aIntensity, because aIntensity also
  // drives the flame's HEIGHT in the vertex shader: folding them would make a
  // half-faded flame a short one, and the compositor's whole contract is that a
  // fading look keeps its size and loses only its opacity.
  const presences = new InstancedBufferAttribute(new Float32Array(FIRE_CELL_CAP), 1);
  presences.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aPresence', presences);

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  return {
    name: 'D — flame tongues',
    root,

    apply(fires: readonly FireInstance[]): void {
      const count = Math.min(fires.length, FIRE_CELL_CAP);
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

        // A whole turn of phase offset, so two adjacent fires never present
        // the same strip to the camera at the same moment.
        seedArray[i] = unitFromSeed(fire.seed, 5);
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
