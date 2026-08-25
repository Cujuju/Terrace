// CANDIDATE A — the faceted flame. Flat, low-poly tongues of fire, drawn in the
// same idiom as everything else standing on this terrain.
//
// WHY THIS SHAPE. flora's trees are 5- and 6-sided solids (models.ts) and the
// terrain is literal facets; a soft, glowing fire dropped into that world reads
// as an effect pasted on top of it. This candidate is the one that belongs to
// the scene: a fire is a CLUMP OF THREE SOLID TONGUES, each a hand-built lathe
// of 7 sides and 6 rings, opaque, unlit, and shaded by BAKED VERTEX COLOUR
// rather than by a light.
//
// WHY VERTEX COLOUR AND NOT LIGHTING. Fire emits; it is not lit. So the material
// is MeshBasicMaterial and there is no shading gradient to be had from the sun —
// which would leave a solid orange silhouette, i.e. the blob this candidate is
// trying not to be. The detail therefore has to be IN the geometry: every vertex
// carries a colour sampled from a white-hot-base → yellow → orange → deep-red-tip
// ramp, and every facet is nudged a few percent either side of that ramp by a
// hash of its own index. The result is a flame whose faces read individually,
// exactly as a faceted crown does under the sun.
//
// WHY A CLUMP AND NOT CONCENTRIC SHELLS. Nested shells are the obvious way to
// build "deep red outside, white hot inside" — and with an OPAQUE material the
// inner shells are invisible, and with a transparent one the faceted style is
// gone. So the three tongues are splayed instead of nested: one tall central
// tongue and two shorter flanking ones, offset off the axis and leaning out, all
// three counter-rotating about the fire's axis so the silhouette keeps changing
// without a single transparent pixel.
//
// BUDGET. Three InstancedMeshes for the whole world — one per tongue layer —
// so a hundred burning cells is three draw calls, the same three as one.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry as Geometry,
} from 'three';
import { FIRE_CELL_CAP } from '../../protocol.ts';
import type { FireInstance, FlameRenderer, FlameRendererBuilder } from './types.ts';

// ── The tongue solid ──────────────────────────────────────────────────────
/**
 * Sides of one tongue. Seven, not the trunk's five and not a smooth sixteen:
 * an odd count means no two silhouette edges are parallel, so a slowly turning
 * tongue never looks like a spinning prism.
 */
const TONGUE_SIDES = 7;

/**
 * The tongue's profile: radius as a fraction of the tongue's own radius, at a
 * height as a fraction of the tongue's own height. Read bottom to top — it
 * pinches at the foot (fire necks in where it leaves the fuel), swells through
 * the lower third, then tapers to a point. The kink at 0.62 is deliberate: a
 * monotone taper is a cone, and a cone is the primitive this candidate must not
 * be mistaken for.
 */
const TONGUE_PROFILE: readonly (readonly [height: number, radius: number])[] = [
  [0.0, 0.62],
  [0.16, 1.0],
  [0.38, 0.88],
  [0.62, 0.7],
  [0.83, 0.34],
  [1.0, 0.0],
];

/**
 * Every ring is rotated by this fraction of a side relative to the one below,
 * so the quads between rings are skewed rather than rectangular and the facets
 * spiral up the tongue. Half a side would make a clean anti-prism; 0.35 keeps
 * it irregular.
 */
const TONGUE_RING_TWIST_FRACTION = 0.35;

/** The colour ramp a tongue's vertices sample, by height fraction. */
const TONGUE_COLOR_STOPS: readonly (readonly [height: number, color: number])[] = [
  [0.0, 0xfff4d0],
  [0.22, 0xffd257],
  [0.5, 0xff8b1e],
  [0.78, 0xe0400f],
  [1.0, 0x8f1206],
];

/** Per-facet brightness jitter, ± this fraction. Enough to see a face; not a rash. */
const FACET_SHADE_JITTER = 0.14;

// ── The clump ─────────────────────────────────────────────────────────────
/** One tongue of the three-tongue clump: its size, where it sits and how it moves. */
interface TongueLayer {
  /** Height as a fraction of the fire's flame height. */
  readonly heightFraction: number;
  /** Radius as a fraction of the fire's flame radius. */
  readonly radiusFraction: number;
  /** Lateral offset from the fire's axis, as a fraction of flame radius. */
  readonly offsetFraction: number;
  /** Phase of that offset around the axis, radians — spaces the tongues apart. */
  readonly offsetPhase: number;
  /** Outward lean at the tip, radians. */
  readonly lean: number;
  /** Turns about the fire's axis per second. Signed: neighbours counter-rotate. */
  readonly spinRate: number;
  /** Stretch/squash cycles per second, and how deep the stretch goes. */
  readonly pulseRate: number;
  readonly pulseDepth: number;
  /** Multiplies the whole ramp — the flanking tongues burn a shade cooler. */
  readonly brightness: number;
}

const TONGUE_LAYERS: readonly TongueLayer[] = [
  // The body: tallest, widest, on the axis, turning slowly.
  {
    heightFraction: 1.0,
    radiusFraction: 1.0,
    offsetFraction: 0.0,
    offsetPhase: 0.0,
    lean: 0.07,
    spinRate: 0.21,
    pulseRate: 1.9,
    pulseDepth: 0.16,
    brightness: 1.0,
  },
  // Two flanking tongues, off the axis, leaning out, turning the other way at
  // different rates so the three never re-align into one shape.
  {
    heightFraction: 0.74,
    radiusFraction: 0.56,
    offsetFraction: 0.46,
    offsetPhase: 0.0,
    lean: 0.3,
    spinRate: -0.37,
    pulseRate: 2.7,
    pulseDepth: 0.24,
    brightness: 0.9,
  },
  {
    heightFraction: 0.55,
    radiusFraction: 0.44,
    offsetFraction: 0.52,
    offsetPhase: Math.PI * 1.05,
    lean: 0.4,
    spinRate: 0.53,
    pulseRate: 3.4,
    pulseDepth: 0.3,
    brightness: 0.82,
  },
];

// ── Scaling a fire to a flame ─────────────────────────────────────────────
/**
 * A flame stands this many times the height of the thing it is consuming, at
 * full intensity. A 1.5-unit tree therefore burns ~2.0 units tall — visibly
 * over the crown, well under the 2.5-unit ceiling the contract sets.
 */
const FLAME_HEIGHT_PER_FUEL = 1.5;
/** Width of the clump, again relative to the fuel's height. */
const FLAME_RADIUS_PER_FUEL = 0.17;
/**
 * How much of the flame's size intensity actually controls. At intensity 0 a
 * fire is not gone — it is a third of its full height, which is what "just
 * caught" and "nearly out" have to look like.
 */
const INTENSITY_SIZE_FLOOR = 0.34;
/** Same idea for brightness: an ember still glows. */
const INTENSITY_BRIGHTNESS_FLOOR = 0.45;

/** Flicker applied to the whole clump's brightness: rate in Hz, depth as a fraction. */
const FLICKER_RATE = 7.3;
const FLICKER_DEPTH = 0.13;

/** Radians in a turn — the flicker and spin phases are all fractions of one. */
const TURN = Math.PI * 2;

/**
 * A stable 0…1 from an integer, so a seed becomes a phase. The same
 * xorshift-multiply finaliser flora's protocol uses; Math.random() is forbidden
 * here because two clients must draw the same fire the same way.
 */
function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/** Samples TONGUE_COLOR_STOPS at a height fraction, into `out`. */
function sampleRamp(out: Color, heightFraction: number, scratch: Color): Color {
  const stops = TONGUE_COLOR_STOPS;
  for (let i = 1; i < stops.length; i++) {
    const [upperHeight, upperColor] = stops[i]!;
    if (heightFraction > upperHeight && i < stops.length - 1) continue;
    const [lowerHeight, lowerColor] = stops[i - 1]!;
    const span = upperHeight - lowerHeight;
    const t = span <= 0 ? 0 : Math.min(Math.max((heightFraction - lowerHeight) / span, 0), 1);
    out.setHex(lowerColor);
    scratch.setHex(upperColor);
    return out.lerp(scratch, t);
  }
  return out.setHex(stops[0]![1]);
}

/**
 * Builds one tongue: a non-indexed lathe of TONGUE_SIDES × (rings-1) quads,
 * origin at its foot, unit height and unit radius so an instance matrix can
 * scale it to any fire. Non-indexed because every facet wants its OWN colour —
 * shared vertices would average the jitter away, which is the whole point of it.
 */
function buildTongueGeometry(): Geometry {
  const rings = TONGUE_PROFILE.length;
  const quads = TONGUE_SIDES * (rings - 1);
  // Two triangles per quad, three vertices each, three floats each.
  const vertexCount = quads * 6;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  const ramp = new Color();
  const rampScratch = new Color();
  let cursor = 0;

  const write = (
    ringIndex: number,
    sideIndex: number,
    shade: number,
  ): void => {
    const [heightFraction, radiusFraction] = TONGUE_PROFILE[ringIndex]!;
    const twist = ringIndex * TONGUE_RING_TWIST_FRACTION * (TURN / TONGUE_SIDES);
    const angle = (sideIndex / TONGUE_SIDES) * TURN + twist;
    positions[cursor * 3 + 0] = Math.cos(angle) * radiusFraction;
    positions[cursor * 3 + 1] = heightFraction;
    positions[cursor * 3 + 2] = Math.sin(angle) * radiusFraction;

    sampleRamp(ramp, heightFraction, rampScratch);
    colors[cursor * 3 + 0] = ramp.r * shade;
    colors[cursor * 3 + 1] = ramp.g * shade;
    colors[cursor * 3 + 2] = ramp.b * shade;
    cursor++;
  };

  for (let ring = 0; ring < rings - 1; ring++) {
    for (let side = 0; side < TONGUE_SIDES; side++) {
      const next = (side + 1) % TONGUE_SIDES;
      // One shade per QUAD (both triangles), so a facet is a facet and not two.
      const shade =
        1 + (unitFromSeed(ring * TONGUE_SIDES + side, 0x51ed) * 2 - 1) * FACET_SHADE_JITTER;
      // Wound counter-clockwise seen from outside; the material is DoubleSide
      // anyway (a tongue's far wall is part of its look), so this is only
      // consistency, not correctness.
      write(ring, side, shade);
      write(ring, next, shade);
      write(ring + 1, next, shade);
      write(ring, side, shade);
      write(ring + 1, next, shade);
      write(ring + 1, side, shade);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

/** Candidate A: three splayed, faceted, vertex-coloured tongues per fire. */
export const buildConeStackFlames: FlameRendererBuilder = (): FlameRenderer => {
  const root = new Group();
  root.name = 'fire:flames:coneStack';

  const geometries: Geometry[] = [];
  const meshes: InstancedMesh[] = [];
  const material = new MeshBasicMaterial({
    vertexColors: true,
    // Both walls of a tongue: the shape is a thin lathe, and hiding its far
    // side leaves a hollow silhouette wherever a facet turns away.
    side: DoubleSide,
    // No transparency at all — this is the OPAQUE candidate, and the one thing
    // it must prove is that a solid faceted flame can read as fire.
    fog: false,
    toneMapped: false,
  });

  const tongueGeometry = buildTongueGeometry();
  geometries.push(tongueGeometry);

  for (let layer = 0; layer < TONGUE_LAYERS.length; layer++) {
    const mesh = new InstancedMesh(tongueGeometry, material, FIRE_CELL_CAP);
    mesh.name = `fire:coneStack:tongue${layer}`;
    mesh.count = 0;
    mesh.frustumCulled = false;
    meshes.push(mesh);
    root.add(mesh);
  }

  // The drawn set. Copied out of `apply` into plain arrays because `update`
  // walks it every frame and must not hold a reference to caller-owned objects.
  const capacity = FIRE_CELL_CAP;
  const fireX = new Float32Array(capacity);
  const fireY = new Float32Array(capacity);
  const fireZ = new Float32Array(capacity);
  const fireHeight = new Float32Array(capacity);
  const fireRadius = new Float32Array(capacity);
  const fireIntensity = new Float32Array(capacity);
  const firePhase = new Float32Array(capacity);
  const fireSpinPhase = new Float32Array(capacity);
  let fireCount = 0;

  // Scratch, allocated once. `update` runs every frame; nothing below it may
  // allocate.
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const euler = new Euler();
  const scale = new Vector3();
  const tint = new Color();

  return {
    name: 'A — faceted tongues',
    root,

    apply(fires: readonly FireInstance[]): void {
      fireCount = Math.min(fires.length, capacity);
      for (let i = 0; i < fireCount; i++) {
        const fire = fires[i]!;
        const sizeScale =
          INTENSITY_SIZE_FLOOR + (1 - INTENSITY_SIZE_FLOOR) * Math.min(Math.max(fire.intensity, 0), 1);
        fireX[i] = fire.x;
        fireY[i] = fire.groundY;
        fireZ[i] = fire.z;
        fireHeight[i] = fire.fuelHeight * FLAME_HEIGHT_PER_FUEL * sizeScale;
        fireRadius[i] = fire.fuelHeight * FLAME_RADIUS_PER_FUEL * sizeScale;
        fireIntensity[i] = Math.min(Math.max(fire.intensity, 0), 1);
        // Two independent phases per fire: one for the pulse/flicker, one for
        // where in its turn the clump starts. Both from the seed, so the fire
        // in a given cell looks the same on every client and no two fires in a
        // stand breathe together.
        firePhase[i] = unitFromSeed(fire.seed, 1) * TURN;
        fireSpinPhase[i] = unitFromSeed(fire.seed, 2) * TURN;
      }
      for (const mesh of meshes) mesh.count = fireCount;
    },

    update(_dt: number, elapsed: number): void {
      if (fireCount === 0) return;

      for (let layerIndex = 0; layerIndex < TONGUE_LAYERS.length; layerIndex++) {
        const layer = TONGUE_LAYERS[layerIndex]!;
        const mesh = meshes[layerIndex]!;

        for (let i = 0; i < fireCount; i++) {
          const phase = firePhase[i]!;
          const height = fireHeight[i]! * layer.heightFraction;
          const radius = fireRadius[i]! * layer.radiusFraction;

          // Stretch and squash conserve rough volume: a tongue that shoots up
          // narrows as it goes, which is what makes the motion read as fire
          // rather than as a bouncing object.
          const pulse = Math.sin(elapsed * layer.pulseRate * TURN + phase + layerIndex);
          const stretch = 1 + pulse * layer.pulseDepth;
          const spin = fireSpinPhase[i]! + elapsed * layer.spinRate * TURN;

          const offset = radius * layer.offsetFraction;
          position.set(
            fireX[i]! + Math.cos(spin + layer.offsetPhase) * offset,
            fireY[i]!,
            fireZ[i]! + Math.sin(spin + layer.offsetPhase) * offset,
          );

          // Lean is applied as a tilt AWAY from the axis (so a flanking tongue
          // leans outward over its own offset) plus a small wander, and the
          // whole thing is then spun about Y.
          euler.set(
            Math.sin(spin + layer.offsetPhase) * layer.lean,
            spin,
            -Math.cos(spin + layer.offsetPhase) * layer.lean + pulse * layer.lean * 0.4,
            'ZXY',
          );
          rotation.setFromEuler(euler);
          scale.set(radius / stretch, height * stretch, radius / stretch);
          matrix.compose(position, rotation, scale);
          mesh.setMatrixAt(i, matrix);

          const flicker =
            1 + Math.sin(elapsed * FLICKER_RATE * TURN + phase * 3) * FLICKER_DEPTH;
          const brightness =
            layer.brightness *
            flicker *
            (INTENSITY_BRIGHTNESS_FLOOR + (1 - INTENSITY_BRIGHTNESS_FLOOR) * fireIntensity[i]!);
          tint.setScalar(brightness);
          mesh.setColorAt(i, tint);
        }

        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      }
    },

    dispose(): void {
      for (const mesh of meshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      material.dispose();
      root.clear();
    },
  };
};
