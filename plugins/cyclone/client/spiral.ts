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
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { CYCLONE_DECK_HEIGHT_WORLD_UNITS, CYCLONE_EYE_RADIUS_FRACTION } from '../protocol.ts';
import {
  PUFF_ALPHA_DISCARD_GLSL,
  puffMaskGlsl,
} from '../../../client/src/plugins/kit/puffDeck.ts';
import {
  PUFF_NORMAL_FLATNESS,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import { glslFloat, spliceShader } from '../../../client/src/render/shaderSplice.ts';

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
 * The deck's own colour, before any of the scene's light reaches it — the rim
 * colour this shader used to author directly (0.86, 0.87, 0.92).
 *
 * WHY THERE IS NO LONGER A `uDaylight` (owner, 2026-09-02). A ShaderMaterial
 * reads none of the scene's lights, so this deck used to be handed a daylight
 * factor by ./index.ts and multiplied by it — the plugin re-deriving, badly and
 * without a notion of night, arithmetic the renderer already does. The material
 * is now `MeshLambertMaterial`, so the sun, the sky's fill, the time of day and
 * this storm's OWN gloom (which reaches the deck through the sky rig, exactly
 * as it reaches the ground) all act on it for free. `CLOUD_GLOOM_RESPONSE` went
 * with the uniform: the asymmetry it encoded — a deck on the sunny side of its
 * own shadow — is what a light and a normal produce on their own.
 */
export const CYCLONE_DECK_COLOR = 0xdbdeeb;

/**
 * How dark the EYEWALL end of an arm is, as a fraction of the rim's colour.
 *
 * 0.28 — the ratio the two hand-authored colours this replaced already carried
 * (0.24 against 0.86). DARKEST AT THE EYEWALL, THINNING TO THE RIM: that is
 * where the weather actually is, and it is what gives the deck a centre to
 * read. A uniformly bright disc is an overcast, not a cyclone. It is a
 * MULTIPLIER ON THE ALBEDO and not a finished pixel, so the sun still moves
 * across it.
 */
export const CYCLONE_EYEWALL_SHADE = 0.28;

/**
 * Peak alpha of a puff at full storm strength — the deck's own opacity.
 *
 * 0.55, unchanged from the value this shader carried inline. NORMAL BLENDING,
 * NEVER ADDITIVE: an overcast's whole job is to DARKEN what is behind it, and
 * additive blending can only lighten (fire's smoke.ts wrote this rule down; the
 * volcano plume paid for relearning it).
 */
export const CYCLONE_DECK_PEAK_OPACITY = 0.55;

/**
 * Where an arm's outer fade begins, as a fraction of its length.
 *
 * The outer sixth fades out, so the deck has no edge — the one thing that would
 * give away that this is a finite set of quads rather than a sky.
 */
export const SPIRAL_RIM_FADE_START = 0.85;

/**
 * How much of the light a cyclone's deck takes off the ground under it, at full
 * intensity — `ClientPluginCtx.publishGroundShade`.
 *
 * THE LOWEST OF THE FOUR SHADE PUBLISHERS, and deliberately: this plugin
 * already darkens the whole world through ./gloom.ts, which is a global dimming
 * of up to MAX_GLOOM_LIGHT_LOSS. The disc is not there to make it dark — the
 * gloom has done that — it is there to put an EDGE on the darkness, so a player
 * outside the storm can see where its shadow stops. Stacking a deep disc on top
 * of a deep gloom would take the coast away twice.
 */
export const CYCLONE_SHADE_DARKNESS = 0.15;

/**
 * How much of a cyclone's shade disc holds FULL darkness before the falloff
 * starts, as a fraction of its radius.
 *
 * THE EYE'S OWN FRACTION — and it is a FLAT CORE, not a hole. `GroundShadeDisc`
 * defines `inner` as where the falloff STARTS: everything inside it is at full
 * darkness. A bright hole under the eye would be a different primitive and a
 * different decision (core report item 1, owner 2026-09-02: no eye-hole term is
 * added), and it would also be wrong here — the eye of a hurricane is calm, not
 * sunlit, because the eyewall around it is what stands between it and the sun.
 * Taking the eye's own radius as the flat core is what makes the shadow read as
 * one body rather than as a soft blob.
 */
export const CYCLONE_SHADE_CORE_FRACTION = CYCLONE_EYE_RADIUS_FRACTION;

/**
 * Where the deck sits in the transparent pass — BELOW the funnel
 * (funnel.ts's FUNNEL_RENDER_ORDER), so a tornado under an overcast is painted
 * over it. Both are depth-write-off transparent geometry, so submission order
 * IS composite order.
 */
export const SPIRAL_RENDER_ORDER = 1;

// ── The GLSL, spliced into a stock Lambert program ──────────────────────────
//
// THE LAYOUT IS UNCHANGED. The logarithmic spiral, the arm scatter, the deck
// height and the billboard are line for line what this file has always
// evaluated in its own `ShaderMaterial`; what changed is WHERE they are
// evaluated — inside three's `meshlambert` program, so the scene's lights reach
// the deck (owner, 2026-09-02; see CYCLONE_DECK_COLOR).
//
// The mechanism is `<begin_vertex>`'s `transformed`: the placement writes the
// puff's offset FROM THE EYE into it, and `<project_vertex>` then applies the
// instance matrix (which carries the eye) and the model matrix. So every stock
// chunk downstream — and core's `applyRevealClip` splice with them — lands on
// the puff rather than on the quad's own corner, with nothing restated.

/** The header, in both stages. */
const SHADER_COMMON_ANCHOR = '#include <common>';
/** Declares `vec3 transformed`, which the placement writes over. */
const BEGIN_VERTEX_ANCHOR = '#include <begin_vertex>';
/** Declares `vec4 mvPosition` and writes `gl_Position`; the billboard follows. */
const PROJECT_VERTEX_ANCHOR = '#include <project_vertex>';
/** The last chunk to touch `diffuseColor` before the lighting reads it. */
const ALPHATEST_FRAGMENT_ANCHOR = '#include <alphatest_fragment>';
/** Declares `vec3 normal` from `vNormal`; the sphere normal replaces it. */
const NORMAL_FRAGMENT_ANCHOR = '#include <normal_fragment_begin>';

/**
 * The varyings both stages need. ONE BLOCK FOR BOTH: a varying must be declared
 * identically in the two stages or the program fails to link.
 */
const SPIRAL_SHARED_DECLARATIONS = /* glsl */ `
varying float vAlong;
varying float vStrength;
varying vec2 vQuad;
#define PUFF_NORMAL_FLATNESS ${glslFloat(PUFF_NORMAL_FLATNESS)}`;

/**
 * The vertex stage's own, and they CANNOT be shared: `attribute` is a
 * vertex-only qualifier and three rewrites it to `in` in the vertex prefix
 * only, so a fragment shader carrying these fails to compile — quietly, as far
 * as the picture goes, since three logs it and the mesh draws nothing.
 */
const SPIRAL_VERTEX_DECLARATIONS = /* glsl */ `${SPIRAL_SHARED_DECLARATIONS}
uniform float uElapsed;
attribute float aArm;
attribute float aAlong;
attribute float aSeed;
attribute float aRadius;
attribute float aStrength;`;

const SPIRAL_PLACEMENT = /* glsl */ `vAlong = aAlong;
    vStrength = aStrength;
    vQuad = position.xy;

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

    // THE OFFSET FROM THE EYE, not the world position: the instance matrix
    // carries the eye and the project_vertex chunk applies it two lines later.
    transformed = vec3(
      cos(angle) * radius + cos(scatterAngle) * scatter,
      height,
      sin(angle) * radius + sin(scatterAngle) * scatter);

    // Puffs vary in size with their seed so the deck is not a grid of clones.
    float puffSize = aRadius * ${PUFF_SIZE_RADIUS_FRACTION.toFixed(3)} *
      (0.7 + 0.6 * fract(aSeed * 5.7));`;

/**
 * BILLBOARD IN VIEW SPACE — faces the camera exactly, for free, with no
 * rotation written from the CPU and no chance of lagging it by a frame. The
 * same mechanism kit/puffDeck.ts's PUFF_BILLBOARD_GLSL states; written out here
 * because this one offsets an `mvPosition` three has already computed rather
 * than building its own.
 */
const SPIRAL_BILLBOARD = /* glsl */ `mvPosition.xy += position.xy * puffSize;
    gl_Position = projectionMatrix * mvPosition;`;

const SPIRAL_MASK = /* glsl */ `${puffMaskGlsl('0.0')}

    // DARKEST AT THE EYEWALL, THINNING TO THE RIM — see CYCLONE_EYEWALL_SHADE.
    // A multiplier on the ALBEDO: the deck is lit, so the sun still moves
    // across it and the storm's own gloom still reaches it.
    diffuseColor.rgb *= mix(${glslFloat(CYCLONE_EYEWALL_SHADE)}, 1.0, vAlong);

    // The outer tenth fades out, so the deck has no edge — the one thing that
    // would give away that this is a finite set of quads rather than a sky.
    float edge = 1.0 - smoothstep(${glslFloat(SPIRAL_RIM_FADE_START)}, 1.0, vAlong);

    float alpha = puff * edge * vStrength;
    ${PUFF_ALPHA_DISCARD_GLSL}
    diffuseColor.a *= alpha;`;

/**
 * THE PUFF IS LIT AS A SPHERE — kit/cumulusDeck.ts's normal, and the same
 * PUFF_NORMAL_FLATNESS, because these are the same kind of object and two
 * flatness numbers would eventually disagree about what a cloud looks like.
 * Per FRAGMENT: a quad's four corners all sit where the sphere's z is zero, so
 * a per-vertex normal would interpolate to nothing through the middle.
 */
const SPIRAL_SPHERE_NORMAL = /* glsl */ `vec3 puffSphere =
      vec3(vQuad, sqrt(max(0.0, 1.0 - dot(vQuad, vQuad))));
    vec3 puffUp = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    normal = normalize(mix(puffSphere, puffUp, PUFF_NORMAL_FLATNESS));`;

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
   * Advances the deck. NO DAYLIGHT ARGUMENT: the material is lit by the scene,
   * so the sky's light — including this storm's own gloom — reaches it without
   * this plugin restating it (see CYCLONE_DECK_COLOR).
   */
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

/**
 * `applyRevealClip` is `ClientPluginCtx.applyRevealClip`. The deck is now a
 * STOCK material, so the clip is core's splice rather than pasted snippets —
 * and it lands correctly because the placement above puts the puff's position
 * in `transformed`, which is what core's world-position patch reads.
 */
export function createSpiral(
  applyRevealClip: (material: Material, label: string) => void,
): SpiralRenderer {
  const root = new Group();
  root.name = 'cyclone:spiral';

  const capacity = MAX_SPIRALS * PUFFS_PER_SPIRAL;
  const geometry = new PlaneGeometry(2, 2, 1, 1);

  const material = new MeshLambertMaterial({
    color: CYCLONE_DECK_COLOR,
    opacity: CYCLONE_DECK_PEAK_OPACITY,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  /**
   * The deck's clock, held here because a stock material has no `uniforms` of
   * its own to hang it on: the same `{ value }` box is put into every compiled
   * program, so writing it once per frame reaches the shader.
   */
  const elapsedUniform = { value: 0 };

  const label = 'cyclone spiral';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uElapsed = elapsedUniform;
    shader.vertexShader = spliceShader(
      spliceShader(
        spliceShader(
          shader.vertexShader,
          SHADER_COMMON_ANCHOR,
          `${SHADER_COMMON_ANCHOR}\n${SPIRAL_VERTEX_DECLARATIONS}`,
          label,
        ),
        BEGIN_VERTEX_ANCHOR,
        `${BEGIN_VERTEX_ANCHOR}\n    ${SPIRAL_PLACEMENT}`,
        label,
      ),
      PROJECT_VERTEX_ANCHOR,
      `${PROJECT_VERTEX_ANCHOR}\n    ${SPIRAL_BILLBOARD}`,
      label,
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        spliceShader(
          shader.fragmentShader,
          SHADER_COMMON_ANCHOR,
          `${SHADER_COMMON_ANCHOR}\n${SPIRAL_SHARED_DECLARATIONS}`,
          label,
        ),
        ALPHATEST_FRAGMENT_ANCHOR,
        `${ALPHATEST_FRAGMENT_ANCHOR}\n    ${SPIRAL_MASK}`,
        label,
      ),
      NORMAL_FRAGMENT_ANCHOR,
      `${NORMAL_FRAGMENT_ANCHOR}\n    ${SPIRAL_SPHERE_NORMAL}`,
      label,
    );
  };
  // three keys a compiled program by material type, parameters and this method
  // — never by `onBeforeCompile` — so without a key of its own this deck could
  // share a program with another Lambert material of the same parameters.
  const stockCacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${stockCacheKey()}|cycloneSpiral`;

  // AFTER our own patch is assigned: `applyRevealClip` chains onto whatever
  // `onBeforeCompile` the material already has, so assigning ours second would
  // drop it.
  applyRevealClip(material, label);

  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = 'cyclone:spiral:puffs';
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

    update(dt, elapsed): void {
      elapsedUniform.value = elapsed;

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
