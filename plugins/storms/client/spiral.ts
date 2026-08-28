// THE SPIRAL — a cyclone's cloud deck, seen from inside it and from above it.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE DRAW CALL FOR THE WHOLE STORM, AND THE CPU DOES NOT ANIMATE IT.
//
// Each puff's instance matrix holds only WHERE THE EYE IS. Which arm it belongs
// to, how far out along that arm it sits, how fast the whole deck turns and how
// big the storm is are per-instance attributes and one time uniform; the
// logarithmic spiral is evaluated in the vertex shader. So a cyclone costs one
// matrix write per puff per server push — twice a second — and nothing per
// frame in between.
//
// The alternative, a puff per Sprite, is PUFFS_PER_SPIRAL draw calls of two
// triangles each against a 7 ms frame budget: the project's standing render
// defect (low triangles-per-call over a shared material) in its purest form.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A DECK OF BILLBOARDS AND NOT A TEXTURED DISC.
//
// A disc is right from directly above and wrong from anywhere else — a player
// standing under a hurricane would see a flat lid with an edge. Billboarded
// puffs have no edge from any angle, they self-occlude into something with
// depth as the camera drops, and they cost the same one call.
//
// THE EYE IS A HOLE, and it is the same hole the server spares from wind damage
// (../protocol.ts's CYCLONE_EYE_RADIUS_FRACTION, imported rather than restated).
// A player who works out that the middle is calm has worked out something true;
// two numbers would eventually disagree and make it false.

import {
  DoubleSide,
  DynamicDrawUsage,
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
import { CYCLONE_DECK_HEIGHT_WORLD_UNITS, CYCLONE_EYE_RADIUS_FRACTION } from '../protocol.ts';

/**
 * Puffs in one cyclone's deck.
 *
 * FOUR HUNDRED AND EIGHTY — sixty per arm across eight arms. It is a big number
 * for one storm and it is still one draw call and one 480-instance matrix
 * buffer, which is under 31 KB. The count is set by COVERAGE, not by taste: a
 * cyclone's radius is a quarter of the map, and a deck that has to look
 * continuous over that area from underneath needs its puffs to overlap.
 */
export const ARMS_PER_SPIRAL = 8;
export const PUFFS_PER_ARM = 60;
export const PUFFS_PER_SPIRAL = ARMS_PER_SPIRAL * PUFFS_PER_ARM;

/**
 * How many cyclones can be drawn at once — the server's cyclone cap, plus one.
 *
 * The spare is for the same reason the funnel renderer keeps one: a cyclone
 * that has stopped being broadcast is still dispersing here, so at a changeover
 * this renderer legitimately holds one more than the server does.
 */
export const MAX_SPIRALS = 2;

/**
 * How far round the storm one arm wraps, in turns.
 *
 * 0.85 — most of a full turn from the eyewall to the rim. Real cyclone arms
 * wrap between a half turn and a turn and a half; under one turn is what keeps
 * an arm readable as a single sweep rather than as a ring.
 */
export const ARM_WRAP_TURNS = 0.85;

/**
 * Turns per second the whole deck rotates.
 *
 * 0.02 — one revolution every fifty seconds. A hurricane's own rotation is
 * SLOW, and this is the number most likely to be got wrong by eye: a deck
 * spinning at anything like a visible rate reads as a whirlpool graphic. At
 * this rate a player watching for ten seconds sees the arms move, and one
 * glancing up does not see a special effect.
 */
export const SPIRAL_SPIN_TURNS_PER_SECOND = 0.02;

/**
 * How wide one puff is, as a fraction of the storm's own radius.
 *
 * A FRACTION, not a length, because the deck must stay continuous whatever
 * radius the world's size clamp gave this cyclone (../protocol.ts's
 * cycloneRadiusFor). 0.16 of the radius means neighbouring puffs along an arm
 * overlap by roughly half at PUFFS_PER_ARM spacing — enough for the deck to
 * close up, not so much that it becomes a solid lid.
 */
export const PUFF_SIZE_RADIUS_FRACTION = 0.16;

/**
 * How much of the deck's height a puff may sit above or below the mean, as a
 * fraction of the deck height.
 *
 * A tenth. A perfectly flat deck reads as a plane at any camera angle; a tenth
 * of ten world units is enough thickness for the puffs to occlude each other
 * and give the cloud a bottom.
 */
export const DECK_THICKNESS_FRACTION = 0.1;

/**
 * Where the deck sits in the transparent pass — BELOW the funnel
 * (funnel.ts's FUNNEL_RENDER_ORDER), so a tornado under an overcast is painted
 * over it. Both are depth-write-off transparent geometry, so submission order
 * IS composite order.
 */
export const SPIRAL_RENDER_ORDER = 1;

const SPIRAL_VERTEX_SHADER = /* glsl */ `
  uniform float uElapsed;

  attribute float aArm;
  attribute float aAlong;
  attribute float aSeed;
  attribute float aRadius;
  attribute float aStrength;

  varying float vAlong;
  varying float vStrength;
  varying float vSeed;
  varying vec2 vQuad;

  void main() {
    vAlong = aAlong;
    vStrength = aStrength;
    vSeed = aSeed;
    vQuad = position.xy;

    // The instance matrix carries ONLY the eye's world position.
    vec3 base = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

    // THE LOGARITHMIC SPIRAL. aAlong runs 0 at the eyewall to 1 at the rim;
    // the radius interpolates from the eye's edge to the storm's, and the angle
    // is the arm's own starting angle plus the wrap, plus the whole deck's slow
    // rotation.
    float eye = ${CYCLONE_EYE_RADIUS_FRACTION.toFixed(4)};
    float radius = aRadius * mix(eye, 1.0, aAlong);
    float angle = 6.28318 * (
      aArm +
      aAlong * ${ARM_WRAP_TURNS.toFixed(2)} +
      uElapsed * ${SPIRAL_SPIN_TURNS_PER_SECOND.toFixed(3)});

    // A scatter across the arm's width, so an arm is a BAND of cloud and not a
    // wire. It widens outward, which is what real arms do and what stops the
    // eyewall being swallowed.
    float scatterAngle = fract(aSeed * 13.7) * 6.28318;
    float scatter = aRadius * (0.02 + 0.09 * aAlong) * fract(aSeed * 7.13 + 0.17);

    float height = ${CYCLONE_DECK_HEIGHT_WORLD_UNITS.toFixed(2)} *
      (1.0 + ${DECK_THICKNESS_FRACTION.toFixed(2)} * (fract(aSeed * 3.1) * 2.0 - 1.0));

    vec3 world = base + vec3(
      cos(angle) * radius + cos(scatterAngle) * scatter,
      height,
      sin(angle) * radius + sin(scatterAngle) * scatter);

    // BILLBOARD IN VIEW SPACE — faces the camera exactly, for free, with no
    // rotation written from the CPU and no chance of lagging it by a frame.
    // Puffs vary in size with their seed so the deck is not a grid of clones.
    float size = aRadius * ${PUFF_SIZE_RADIUS_FRACTION.toFixed(3)} *
      (0.7 + 0.6 * fract(aSeed * 5.7));
    vec4 viewPosition = viewMatrix * vec4(world, 1.0);
    viewPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const SPIRAL_FRAGMENT_SHADER = /* glsl */ `
  varying float vAlong;
  varying float vStrength;
  varying float vSeed;
  varying vec2 vQuad;

  void main() {
    // A soft round puff. The quad is authored two units across, so vQuad is the
    // offset from its centre in half-widths.
    float radius = length(vQuad);
    float puff = 1.0 - smoothstep(0.0, 1.0, radius);
    if (puff <= 0.0) discard;

    // DARKEST AT THE EYEWALL, THINNING TO THE RIM. That is where the weather
    // actually is, and it is also what gives the deck a centre to read: a
    // uniformly grey disc is an overcast, not a cyclone.
    vec3 wall = vec3(0.20, 0.21, 0.25);
    vec3 rim = vec3(0.55, 0.56, 0.60);
    vec3 color = mix(wall, rim, vAlong);

    // The outer tenth fades out, so the deck has no edge — the one thing that
    // would give away that this is a finite set of quads rather than a sky.
    float edge = 1.0 - smoothstep(0.85, 1.0, vAlong);

    // NORMAL BLENDING, NEVER ADDITIVE: an overcast's whole job is to DARKEN
    // what is behind it, and additive blending can only lighten (fire's
    // smoke.ts wrote this rule down; the volcano plume paid for relearning it).
    float alpha = puff * edge * vStrength * 0.5;
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** One cyclone, as this renderer remembers it. */
interface Spiral {
  x: number;
  z: number;
  /** Cell-space radius, converted to world units at the push. */
  radiusWorldUnits: number;
  readonly seed: number;
  alive: boolean;
  /** 0…1, ramping over SPIRAL_GATHER_SECONDS / SPIRAL_DISPERSE_SECONDS. */
  presence: number;
  intensity: number;
}

/**
 * Seconds a deck takes to gather and to disperse.
 *
 * BOTH SLOW, and much slower than a funnel's, because a cyclone is a slow thing
 * and the deck covers a quarter of the map: a cloud layer that faded in over a
 * second and a half would read as a curtain being raised.
 */
export const SPIRAL_GATHER_SECONDS = 20;
export const SPIRAL_DISPERSE_SECONDS = 30;

/** One live cyclone, as ./index.ts hands it over. */
export interface SpiralSource {
  readonly id: number;
  /** World-space X/Z of the eye. */
  readonly x: number;
  readonly z: number;
  /** The storm's radius, in CELLS, exactly as the server broadcast it. */
  readonly radiusCells: number;
  readonly intensity: number;
}

export interface SpiralRenderer {
  readonly root: Group;
  apply(live: readonly SpiralSource[]): void;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

/** Stable 0…1 from a storm id. */
function unitFromId(id: number): number {
  let h = id >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

export function createSpiral(): SpiralRenderer {
  const root = new Group();
  root.name = 'storms:spiral';

  const capacity = MAX_SPIRALS * PUFFS_PER_SPIRAL;
  const geometry = new PlaneGeometry(2, 2, 1, 1);

  const material = new ShaderMaterial({
    uniforms: { uElapsed: { value: 0 } },
    vertexShader: SPIRAL_VERTEX_SHADER,
    fragmentShader: SPIRAL_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'storms:spiral:puffs';
  mesh.count = 0;
  mesh.renderOrder = SPIRAL_RENDER_ORDER;
  mesh.frustumCulled = false;
  root.add(mesh);

  const arms = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const alongs = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const seeds = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const radii = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  for (const attribute of [arms, alongs, seeds, radii, strengths]) {
    attribute.setUsage(DynamicDrawUsage);
  }
  geometry.setAttribute('aArm', arms);
  geometry.setAttribute('aAlong', alongs);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aRadius', radii);
  geometry.setAttribute('aStrength', strengths);

  const spirals = new Map<number, Spiral>();

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);

  return {
    root,

    apply(live): void {
      for (const spiral of spirals.values()) spiral.alive = false;

      for (const storm of live) {
        const radiusWorldUnits = storm.radiusCells * CELL_WORLD_SIZE;
        const existing = spirals.get(storm.id);
        if (existing !== undefined) {
          existing.alive = true;
          existing.x = storm.x;
          existing.z = storm.z;
          existing.radiusWorldUnits = radiusWorldUnits;
          existing.intensity = storm.intensity;
          continue;
        }
        if (spirals.size >= MAX_SPIRALS) continue;
        spirals.set(storm.id, {
          x: storm.x,
          z: storm.z,
          radiusWorldUnits,
          seed: unitFromId(storm.id),
          alive: true,
          presence: 0,
          intensity: storm.intensity,
        });
      }
    },

    update(dt, elapsed): void {
      material.uniforms.uElapsed!.value = elapsed;

      if (spirals.size === 0) {
        mesh.count = 0;
        return;
      }

      const armArray = arms.array as Float32Array;
      const alongArray = alongs.array as Float32Array;
      const seedArray = seeds.array as Float32Array;
      const radiusArray = radii.array as Float32Array;
      const strengthArray = strengths.array as Float32Array;
      let drawn = 0;

      for (const [id, spiral] of spirals) {
        if (spiral.alive) {
          spiral.presence = Math.min(1, spiral.presence + dt / SPIRAL_GATHER_SECONDS);
        } else {
          spiral.presence -= dt / SPIRAL_DISPERSE_SECONDS;
          if (spiral.presence <= 0) {
            spirals.delete(id);
            continue;
          }
        }

        // THE DECK IS PLACED AT A FIXED HEIGHT, not on the ground: it is a
        // cloud layer, and where the ground under it happens to be is
        // irrelevant. That is also why this renderer never asks for a ground Y
        // — the funnel does, because a funnel stands on something.
        position.set(spiral.x, 0, spiral.z);
        matrix.compose(position, rotation, scale);
        const strength = spiral.presence * spiral.intensity;

        for (let arm = 0; arm < ARMS_PER_SPIRAL; arm++) {
          for (let i = 0; i < PUFFS_PER_ARM; i++) {
            mesh.setMatrixAt(drawn, matrix);
            armArray[drawn] = arm / ARMS_PER_SPIRAL;
            // Square-rooted, so the puffs bunch toward the EYEWALL rather than
            // spreading evenly: the area an arm covers grows with its radius,
            // so an even parameter spacing would thin the cloud out exactly
            // where the storm is strongest.
            alongArray[drawn] = Math.sqrt((i + 0.5) / PUFFS_PER_ARM);
            seedArray[drawn] = (spiral.seed + drawn * 0.6180339887) % 1;
            radiusArray[drawn] = spiral.radiusWorldUnits;
            strengthArray[drawn] = strength;
            drawn++;
          }
        }
      }

      mesh.count = drawn;
      mesh.instanceMatrix.needsUpdate = true;
      arms.needsUpdate = true;
      alongs.needsUpdate = true;
      seeds.needsUpdate = true;
      radii.needsUpdate = true;
      strengths.needsUpdate = true;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
      spirals.clear();
    },
  };
}
