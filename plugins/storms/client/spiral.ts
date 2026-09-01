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
// THAT LAST CLAUSE WAS A LIE FOR A WHILE, and the fix is `layoutDirty` below:
// update() rewrote all six buffers every frame, with no update range, so a
// single 810-puff cyclone re-uploaded all 1 620 capacity slots of all six at
// frame rate to redraw data that had not moved since the push. The one value
// that genuinely does move between pushes is a deck's `strength` while it
// disperses, and that is one float per puff on one buffer — handled on its own
// path, so a steady cyclone once again costs a frame nothing but two uniforms.
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
 * EIGHT HUNDRED AND TEN — ninety per arm across nine arms. It is a big number
 * for one storm and it is still one draw call and one 810-instance matrix
 * buffer, which is under 52 KB. The count is set by COVERAGE, not by taste, and
 * it was RAISED from 480 when the preview harness showed why: at the puff size
 * needed for the arms to be distinguishable from each other, sixty per arm
 * leaves gaps along an arm, and the deck reads as a dotted spiral. Puff size and
 * this count are one decision — shrink one and the other has to grow.
 */
export const ARMS_PER_SPIRAL = 9;
export const PUFFS_PER_ARM = 90;
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
 * cycloneRadiusFor).
 *
 * MEASURED DOWN FROM 0.16, which made a featureless white disc: a puff a sixth
 * of the storm wide is wider than the gap between two arms, so the arms merged
 * into a lid and the eye all but closed. At 0.085 neighbouring puffs along an
 * arm still overlap (see PUFFS_PER_ARM, which had to rise with it) while two
 * adjacent arms do not.
 */
export const PUFF_SIZE_RADIUS_FRACTION = 0.085;

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
 * How much the scene's own light reaches these puffs, in [0, 1] - the uniform
 * that keeps an UNLIT material honest.
 *
 * WHY IT HAS TO EXIST. A ShaderMaterial reads none of the scene's lights, so a
 * cloud deck authored at a fixed brightness keeps that brightness however dark
 * the storm has made the world - and since the storm darkens the world through
 * ./gloom.ts, the deck ends up the BRIGHTEST thing in a scene it is supposed to
 * be the cause of the darkness in. The preview harness showed exactly that: a
 * white disc over a near-black coast.
 *
 * So the plugin's frame loop hands the renderers the same daylight factor it
 * hands the sky, and the puffs are multiplied by it. One number, driven from
 * the one place that knows how dark it is.
 */
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
    // The band an arm covers. Narrowed with the puff size for the same reason:
    // at the old width the scatter alone filled the gaps between arms.
    float scatter = aRadius * (0.012 + 0.045 * aAlong) * fract(aSeed * 7.13 + 0.17);

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
  uniform float uDaylight;

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
    // A STORM TOP IS BRIGHT. Seen from above it is the brightest thing in the
    // picture — white cloud over a sea the same storm has put in shadow — and
    // that contrast is the only thing that makes the arms and the eye readable
    // at all. The eyewall end stays dark so the spiral has structure and the
    // eye reads as a hole.
    //
    // These were once authored dark, on the reasoning that an unlit material
    // must not out-shine a gloomed scene. That reasoning produced a black
    // square with a smear in it; the fix is not a darker cloud, it is
    // uDaylight — which now dims the deck only a quarter as much as the ground
    // (gloom.ts's CLOUD_GLOOM_RESPONSE), because the deck is on the sunny side
    // of its own shadow.
    vec3 wall = vec3(0.24, 0.25, 0.30);
    vec3 rim = vec3(0.86, 0.87, 0.92);
    vec3 color = mix(wall, rim, vAlong) * uDaylight;

    // The outer tenth fades out, so the deck has no edge — the one thing that
    // would give away that this is a finite set of quads rather than a sky.
    float edge = 1.0 - smoothstep(0.85, 1.0, vAlong);

    // NORMAL BLENDING, NEVER ADDITIVE: an overcast's whole job is to DARKEN
    // what is behind it, and additive blending can only lighten (fire's
    // smoke.ts wrote this rule down; the volcano plume paid for relearning it).
    float alpha = puff * edge * vStrength * 0.55;
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
  /** 1 while the server is broadcasting it; falls over SPIRAL_DISPERSE_SECONDS. */
  presence: number;
  intensity: number;
  /**
   * First instance slot this deck occupies, set by the last full rewrite.
   *
   * Remembered rather than recomputed so a frame that only needs to change one
   * deck's strength knows where to write it without walking the others.
   */
  slotBase: number;
  /** The strength value currently sitting in the buffer for those slots. */
  writtenStrength: number;
}

/**
 * Seconds a deck takes to DISPERSE after the server stops broadcasting it.
 *
 * THERE IS NO GATHER TIME, and its absence is the point. A storm's arrival is
 * already faded in by the SERVER: `intensity` on the wire is peakIntensity
 * times the sim's own spin-up envelope, which climbs over CYCLONE_PROFILE's 45
 * seconds. A second envelope here multiplied the two, so a storm the server
 * said was at 78% strength was drawn at a few per cent of that - and in a live
 * world, at software-GL frame rates, "a few per cent" is invisible. The first
 * in-world capture showed 1 620 instances submitted and nothing on screen.
 *
 * A DISPERSAL still needs one, because that direction is NOT on the wire: a
 * storm that has died stops appearing in the list entirely, so the only thing
 * that can fade it out is the renderer.
 */
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
  /**
   * Advances the deck. `daylight` is how much of the scene's light is reaching
   * it, in [0, 1] - see this file's uDaylight note.
   */
  update(dt: number, elapsed: number, daylight: number): void;
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
    uniforms: { uElapsed: { value: 0 }, uDaylight: { value: 1 } },
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

  /**
   * Set whenever the instance LAYOUT stops matching the buffers — a deck
   * added, dropped, or moved/resized by a server push.
   *
   * This is what makes the file's own header true again (see it: "one matrix
   * write per puff per server push — twice a second — and nothing per frame in
   * between"). Everything the six buffers hold is a function of the push:
   * position, arm, distance along the arm, seed and radius. Only `strength`
   * moves between pushes, and only while a deck is dispersing.
   */
  let layoutDirty = false;
  /** Instances the buffers currently describe — mesh.count, remembered. */
  let drawn = 0;

  /**
   * Writes every buffer for every live deck, and records where each one landed.
   *
   * Called only when layoutDirty says the slot assignment or the push data
   * changed, which on a live world is twice a second and not 140 times.
   */
  function writeLayout(): void {
    const armArray = arms.array as Float32Array;
    const alongArray = alongs.array as Float32Array;
    const seedArray = seeds.array as Float32Array;
    const radiusArray = radii.array as Float32Array;
    const strengthArray = strengths.array as Float32Array;
    drawn = 0;

    for (const spiral of spirals.values()) {
      // THE DECK IS PLACED AT A FIXED HEIGHT, not on the ground: it is a
      // cloud layer, and where the ground under it happens to be is
      // irrelevant. That is also why this renderer never asks for a ground Y
      // — the funnel does, because a funnel stands on something.
      position.set(spiral.x, 0, spiral.z);
      matrix.compose(position, rotation, scale);
      const strength = spiral.presence * spiral.intensity;
      spiral.slotBase = drawn;
      spiral.writtenStrength = strength;

      for (let arm = 0; arm < ARMS_PER_SPIRAL; arm++) {
        for (let i = 0; i < PUFFS_PER_ARM; i++) {
          mesh.setMatrixAt(drawn, matrix);
          armArray[drawn] = arm / ARMS_PER_SPIRAL;
          // EVENLY SPACED ALONG THE ARM, which is what makes an arm read as an
          // arm.
          //
          // IT WAS SQUARE-ROOTED FIRST, on the reasoning that area grows with
          // radius so the puffs should bunch outward to keep the density even.
          // That reasoning is right about DENSITY and wrong about this
          // picture: even density is a uniform disc, and the preview showed
          // exactly that — a bright annulus with no arms in it, because sqrt
          // piles most of the puffs into the outer third. Even spacing along
          // the arm keeps each arm a continuous line at every radius, and the
          // gaps between arms are the whole point.
          alongArray[drawn] = (i + 0.5) / PUFFS_PER_ARM;
          seedArray[drawn] = (spiral.seed + drawn * 0.6180339887) % 1;
          radiusArray[drawn] = spiral.radiusWorldUnits;
          strengthArray[drawn] = strength;
          drawn++;
        }
      }
    }

    mesh.count = drawn;
    // NAMED RANGES, not the whole pool. The buffers are capacity-sized
    // (MAX_SPIRALS x PUFFS_PER_SPIRAL) and three's WebGLAttributes.updateBuffer
    // falls back to `bufferSubData(target, 0, array)` for an attribute with no
    // update range, so one 810-puff cyclone used to move all 1 620 slots of
    // all six buffers. Cleared first for the reason lavaFlow.ts's rebuild
    // states: three clears ranges only when it actually uploads, so a rewrite
    // driven by a message rather than by a frame would otherwise stack them.
    markUploaded(mesh.instanceMatrix, drawn);
    markUploaded(arms, drawn);
    markUploaded(alongs, drawn);
    markUploaded(seeds, drawn);
    markUploaded(radii, drawn);
    markUploaded(strengths, drawn);
  }

  /** Queues `instances` worth of `attribute` for upload, and nothing beyond. */
  function markUploaded(attribute: InstancedBufferAttribute, instances: number): void {
    attribute.clearUpdateRanges();
    // In ARRAY ELEMENTS, not instances: three multiplies the start by the
    // array's BYTES_PER_ELEMENT itself, so the count carries the itemSize.
    attribute.addUpdateRange(0, instances * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  return {
    root,

    apply(live): void {
      for (const spiral of spirals.values()) spiral.alive = false;

      for (const storm of live) {
        const radiusWorldUnits = storm.radiusCells * CELL_WORLD_SIZE;
        const existing = spirals.get(storm.id);
        if (existing !== undefined) {
          existing.alive = true;
          // A MOVE OR A RESIZE IS A LAYOUT CHANGE; a change of intensity is
          // not — intensity only reaches the buffers through `strength`, which
          // has its own one-buffer path in update().
          if (existing.x !== storm.x || existing.z !== storm.z || existing.radiusWorldUnits !== radiusWorldUnits) {
            layoutDirty = true;
          }
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
          // BORN AT FULL PRESENCE — see SPIRAL_DISPERSE_SECONDS. The server's
          // own intensity is the fade-in.
          presence: 1,
          intensity: storm.intensity,
          slotBase: 0,
          writtenStrength: Number.NaN,
        });
        layoutDirty = true;
      }
    },

    update(dt, elapsed, daylight): void {
      material.uniforms.uElapsed!.value = elapsed;
      material.uniforms.uDaylight!.value = daylight;

      if (spirals.size === 0) {
        mesh.count = 0;
        drawn = 0;
        return;
      }

      // ── The life cycle, which is the only thing a frame actually advances ──
      for (const [id, spiral] of spirals) {
        if (spiral.alive) {
          // A storm that was dispersing and came back (a dropped message, a
          // reconnect) recovers rather than restarting its life.
          spiral.presence = 1;
        } else {
          spiral.presence -= dt / SPIRAL_DISPERSE_SECONDS;
          if (spiral.presence <= 0) {
            spirals.delete(id);
            layoutDirty = true;
          }
        }
      }

      if (spirals.size === 0) {
        mesh.count = 0;
        drawn = 0;
        layoutDirty = false;
        return;
      }

      if (layoutDirty) {
        writeLayout();
        layoutDirty = false;
        return;
      }

      // ── The steady state: at most one float per puff, and usually none ────
      // A deck that is neither dispersing nor newly pushed has the strength it
      // already has in the buffer, so this writes nothing at all.
      const strengthArray = strengths.array as Float32Array;
      let touched = false;
      for (const spiral of spirals.values()) {
        const strength = spiral.presence * spiral.intensity;
        if (strength === spiral.writtenStrength) continue;
        strengthArray.fill(strength, spiral.slotBase, spiral.slotBase + PUFFS_PER_SPIRAL);
        spiral.writtenStrength = strength;
        touched = true;
      }
      if (touched) markUploaded(strengths, drawn);
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
