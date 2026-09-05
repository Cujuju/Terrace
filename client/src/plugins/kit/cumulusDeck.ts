// THE CUMULUS DECK — the cloud a drifting mass falls out of, as a VOLUME of
// puffs rather than a sheet.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT IS FOR (#284). Rain, thunderstorm and snow were born at
// CLOUD_BASE_WORLD_Y out of clear sky: a column of streaks starting in mid-air
// with nothing above it. This is the thing above it. One deck per PLUGIN, not
// one per mass — the same shape ./discRig.ts's pool has, for the same reason.
//
// ─────────────────────────────────────────────────────────────────────────────
// UNIFORMS PER FRAME, NOT BUFFERS.
//
// Everything static about a puff — which mass it belongs to, where on that
// mass's disc it sits, which height tier it is in, its own seed — is a
// per-instance attribute written ONCE when the deck is built. What moves is the
// MASS: its centre, its radius and its intensity, and those are `uMassXZ` and
// `uMassSize`, two small uniform arrays rewritten from the interpolated disc
// every frame. So a deck of a thousand puffs uploads nothing in steady state
// and a moving one uploads a handful of floats.
//
// THIS IS WHY ../../../plugins/cyclone/client/spiral.ts IS NOT REUSED. That
// renderer's design is a matrix rewrite per SERVER PUSH — twice a second — and
// it is correct there because a cyclone's eye only moves when the server says
// so. A rain mass is INTERPOLATED, so it moves every frame, and reusing the
// spiral would rewrite every matrix at frame rate: the exact regression
// spiral.ts's `layoutDirty` was written to fix.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT HAS TO READ AS PUFFS, NOT AS A TRAY (owner, 2026-09-02). Three things
// make that so and all three are visual gate items:
//
//   1. LIT AS SPHERES. `MeshLambertMaterial` — so day/night, a cyclone's gloom
//      and a thunderstorm's own flash light reach the cloud for free, with no
//      daylight uniform to keep honest (spiral.ts's `uDaylight` is the copy of
//      that arithmetic this deliberately does not make). The normal is NOT +Y:
//      each fragment is lit as a point on a small sphere, blended toward up by
//      PUFF_NORMAL_FLATNESS so tops are bright and undersides dark without the
//      deck reading as a tray of billiard balls.
//   2. BUILT IN DEPTH. The puffs occupy DECK_THICKNESS_WORLD_UNITS across
//      DECK_TIERS height tiers — fewer and larger toward the top, narrower
//      toward the top, denser toward the centre — so the deck has a domed top
//      and a flat base the column falls out of.
//   3. NO TWO ALIKE. Size varies per seed and placement is a phyllotaxis
//      spiral, so nothing tiles and nothing clumps.
//
// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC LAYOUT, no `Math.random`. The SHAPE of a cloud is not weather —
// it carries no information the server owns — but two players standing under
// the same front should see the same cloud, exactly as ./hazeBank.ts tears its
// sheets identically on every client. Every puff's place comes from its own
// index.

import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  PlaneGeometry,
  type Object3D,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  PUFF_ALPHA_DISCARD_GLSL,
  puffMaskGlsl,
} from './puffDeck.ts';
import { CLOUD_BASE_WORLD_Y, CLOUD_HEADROOM_WORLD_UNITS } from './precipitation.ts';
import { DISC_RENDER_ORDER } from './discRig.ts';
import { glslFloat, spliceShader } from '../../render/shaderSplice.ts';
import type { GroundShadeDisc } from '../types.ts';
import type { InterpolatedDisc } from './discInterpolator.ts';

const TWO_PI = Math.PI * 2;

// ── The deck's shape ─────────────────────────────────────────────────────────

/**
 * World-space Y of the deck's FLAT BASE.
 *
 * The same height the column's particles are born at (./precipitation.ts), and
 * that identity is the whole feature: the drops now start inside the bottom of
 * a cloud instead of in clear air. Stated as the import rather than as a number
 * so the two can never be moved apart.
 */
export const DECK_BASE_WORLD_Y = CLOUD_BASE_WORLD_Y;

/**
 * HALF A STEP, which is what keeps the deck's two orders out of every other
 * plugin's slot.
 *
 * Every `*_RENDER_ORDER` in this codebase is a whole number, and each one
 * states a relation to another plugin's whole number (tornado's funnel above
 * cyclone's spiral, and so on). The deck needs a place immediately either side
 * of the rig it belongs to, and there is no whole number left between the sea
 * at 0 and DISC_RENDER_ORDER at 1. So the deck steps by a half: both of its
 * orders are strictly inside a gap no integer occupies, which means adding
 * them cannot tie with — or reorder — anything outside this kit.
 */
const DECK_ORDER_HALF_STEP = 0.5;

/**
 * WHERE THE DECK IS DRAWN, AND WHY IT DEPENDS ON THE CAMERA (#300).
 *
 * The deck is one InstancedMesh for every mass at once, so its object POSITION
 * is the world origin; the rig's column and haze sit at their mass. At equal
 * `renderOrder` three sorts transparent objects by their object centre's view
 * depth, so which of the two is drawn first came down to where the world
 * origin happened to be relative to the mass — arbitrary, and it is what
 * painted rain streaks across the face of the cloud they fall out of.
 *
 * The geometry settles it exactly, with no sort and no per-mass test. Every
 * particle of a column is at or below DECK_BASE_WORLD_Y and every haze sheet
 * is far below it; every puff of a deck is at or above that same plane. So for
 * a camera ABOVE the plane, on any ray whatever, a puff is nearer than a
 * column particle — the deck must therefore be drawn LAST, over the rig. For a
 * camera BELOW it, the reverse holds on every ray, and the deck is drawn
 * FIRST. One boolean per frame decides it for every mass in the plugin.
 *
 * Both are positive, so the deck still lands after the world-sized transparent
 * sea whichever side of the plane the camera is on — the promise
 * DISC_RENDER_ORDER's own doc makes.
 *
 * A PUFF'S DEPTH IS ITS CENTRE'S. The billboard offsets `mvPosition.xy` only
 * (see `billboard` below), so the quad spreads across the screen without ever
 * moving toward or away from the camera — which is what lets the argument above
 * be about puff CENTRES rather than about quad corners.
 *
 * THE ONE RESIDUAL, NAMED. DECK_TIER_JITTER_WORLD_UNITS can drop a
 * bottom-tier puff that far below the base plane, so "every puff is at or above
 * the base" holds to within one jitter and not exactly. What that can misorder
 * is one low puff against the very top of the column at the same height —
 * never the deck against the column as bodies, which is the defect this
 * ordering exists to fix (#300).
 */
export const DECK_RENDER_ORDER_CAMERA_ABOVE_BASE = DISC_RENDER_ORDER + DECK_ORDER_HALF_STEP;
export const DECK_RENDER_ORDER_CAMERA_BELOW_BASE = DISC_RENDER_ORDER - DECK_ORDER_HALF_STEP;

/**
 * How deep the deck is, in world units, from its flat base to its domed top.
 *
 * A CLOUD'S DEPTH IS SET BY THE AIR, NOT BY THE WIDTH OF THE FRONT, which is
 * why this is a length and not a fraction of the mass's radius (the opposite
 * choice from PUFF_SIZE_RADIUS_FRACTION below, and for the opposite reason): a
 * small squall and a broad front over the same landscape have cloud of much the
 * same depth.
 *
 * HALF THE CLEARANCE THE CLOUD BASE ALREADY KEEPS. CLOUD_HEADROOM_WORLD_UNITS
 * is the gap ./precipitation.ts holds between the highest ground this game can
 * contain and the cloud base; taking half of it upward puts the deck's top at
 * one and a half times that clearance above the tallest possible mountain — a
 * cloud with visible depth that still cannot swallow the sky. Four world units
 * today, against a mass radius of six to fourteen.
 */
export const DECK_THICKNESS_WORLD_UNITS = CLOUD_HEADROOM_WORLD_UNITS / 2;

/**
 * Height tiers the puffs are dealt into.
 *
 * FIVE. The tiers are what make the deck a volume rather than a sheet, and the
 * requirement is that consecutive tiers OVERLAP vertically — a puff must be
 * taller than the gap to the tier above it, or the deck reads as stacked
 * plates. Five tiers over DECK_THICKNESS_WORLD_UNITS is a one-unit rise per
 * tier against puffs one to three units across, so every tier overlaps its
 * neighbours. More tiers would only add overdraw: the silhouette is already
 * closed at five.
 */
export const DECK_TIERS: number = 5;

/**
 * How much SMALLER the top tier's share of the puffs is than the bottom's.
 *
 * 0.7 — the top tier gets three tenths of the bottom tier's count. A cumulus is
 * a broad base with a few big heads on it, so the population has to thin
 * upward; an even deal across the tiers gives a slab with parallel sides.
 */
export const DECK_TIER_POPULATION_TAPER = 0.7;

/**
 * The top tier's radius, as a fraction of the deck's.
 *
 * 0.55 — a little over half. Together with the population taper this is what
 * DOMES the deck: each tier is drawn over a smaller disc than the one below,
 * so the silhouette from the side is a mound rather than a cylinder, while the
 * bottom tier's full-width disc keeps the flat base the column falls out of.
 */
export const DECK_TOP_RADIUS_FRACTION = 0.55;

/**
 * Vertical scatter within a tier, in world units.
 *
 * HALF THE TIER SPACING, so a puff wanders inside its own band and can never
 * cross into the next tier's — which would undo the tier structure the dome is
 * built from. It is what stops the five tiers reading as five lines.
 */
export const DECK_TIER_JITTER_WORLD_UNITS = DECK_THICKNESS_WORLD_UNITS / DECK_TIERS / 2;

/**
 * How the puffs of one tier are spread from its centre to its rim.
 *
 * r = u^k over u in [0, 1). k = 0.5 is UNIFORM AREA — the distribution
 * ./precipitation.ts seeds its drops with, and the right one for rain, which
 * falls evenly. A cloud is not even: it is thick in the middle and ragged at
 * the edge. k = 1 gives a density that falls as 1/r, which is thick in the
 * middle but leaves the rim bare. 0.75 is between them — visibly heavier
 * through the centre with the rim still populated.
 */
export const DECK_RADIAL_EXPONENT = 0.75;

/**
 * Where the deck's own rim fade starts, as a fraction of its radius.
 *
 * The outer fifth fades out, so the deck has no edge — the one thing that
 * would give away that this is a finite set of quads rather than weather.
 * Same device, and the same reasoning, as spiral.ts's rim fade.
 */
export const DECK_RIM_FADE_START = 0.8;

/**
 * How much larger a top-tier puff is than a base-tier one.
 *
 * +60 %. Real cumulus heads are the big rounded lumps; the fine detail is
 * underneath. Growing the puffs upward while thinning their count keeps the
 * upper tiers covering their (narrower) disc with far fewer of them, which is
 * where most of the overdraw saving in this deck comes from.
 */
export const PUFF_SIZE_TOP_GROWTH = 0.6;

/**
 * Per-seed size spread, as a fraction either side of a puff's tier size.
 *
 * ±25 %. Enough that no two neighbours are the same blob — without it the deck
 * reads as a stipple pattern — and not so much that a single puff can span a
 * gap the coverage arithmetic below assumed two would.
 */
export const PUFF_SIZE_SEED_VARIATION = 0.25;

/**
 * How spherically a puff is lit, in [0, 1]: 0 is a full sphere normal, 1 is
 * flat-up.
 *
 * 0.45 — a little under half way. At 0 every puff is lit as a hard ball and the
 * deck is a tray of marbles; at 1 the whole deck is one flat lid with no
 * internal shading at all, which is the sheet this file exists to stop being.
 * Just under the midpoint keeps each puff's own round shading readable while
 * the deck as a whole still reads as one body lit from above.
 */
export const PUFF_NORMAL_FLATNESS = 0.45;

/**
 * Where a puff's soft edge starts, as a fraction of its half-width.
 *
 * A puff that fades from its very centre (spiral.ts's `0.0`) is a smear, which
 * is right for an arm of a hurricane seen from far above and wrong for cloud a
 * player stands under: the deck needs puffs with BODIES so they occlude each
 * other.
 *
 * RAISED FROM 0.35 TO 0.55 at the in-world gate (2026-09-02). At 0.35 two
 * thirds of every puff was gradient, and 139 overlapping gradients average out:
 * the deck read as a bank of fog with the seabed contours legible straight
 * through it. Just over half puts a solid core in each puff and confines the
 * blend to a rim, which is what makes the cauliflower silhouette read from
 * above — and it is also the cheaper end, because the fragments it removes are
 * the faint ones that cost fill and show nothing.
 */
export const PUFF_SOFT_EDGE_FRACTION = 0.55;

/**
 * How far a puff's rim wanders from a circle, as a fraction of its half-width
 * (puffDeck.ts's `PuffLobing.amplitude`).
 *
 * ±18 % (#323, owner 2026-09-04: "they all look like spheres"). Enough that
 * neighbouring puffs stop sharing one outline and the deck's edge reads as
 * lumps rather than as a row of coins; not so much that a lobe can reach past
 * the half-width the coverage arithmetic (`puffsForCoverage`) assumed, since
 * the scale is applied INSIDE the quad — a rim at 1.18 half-widths is simply
 * clipped by the quad's edge. Tune eyes-on, not from here.
 */
export const PUFF_LOBE_AMPLITUDE = 0.18;

/**
 * Per-seed aspect spread: a puff is stretched this far along one axis and
 * squashed the same along the other, as a fraction either way.
 *
 * ±20 %. The lobing above bends the RIM; this bends the solid core too, so a
 * puff seen against another is an oblong lump rather than a lumpy coin. Kept
 * area-neutral (x × 1/x) so the coverage arithmetic still holds on average.
 */
export const PUFF_ASPECT_SEED_VARIATION = 0.2;

/**
 * Overlap factor in the puff-count arithmetic below.
 *
 * TWO. One puff of half-width fraction `s` covers s² of the disc's area, so
 * 1/s² of them tile it exactly and any real (random, round, overlapping)
 * placement needs more than that to close. Twice is the standard slack for a
 * scattered cover and it is the same reasoning spiral.ts states for its own
 * count — reused as reasoning, NOT as a number.
 */
export const PUFF_COVERAGE_OVERLAP = 2;

/**
 * How many puffs of half-width fraction `sizeFraction` close a deck.
 *
 * Pure arithmetic, exported so a plugin's profile can DERIVE its count from its
 * puff size instead of carrying a second number that has to be kept in step
 * with the first. Puff size and puff count are one decision — shrink one and
 * the other has to grow — and this is that decision written down.
 */
export function puffsForCoverage(sizeFraction: number): number {
  return Math.ceil(PUFF_COVERAGE_OVERLAP / (sizeFraction * sizeFraction));
}

/**
 * How many puffs each tier gets, bottom tier first, summing to `total`.
 *
 * A LINEAR TAPER from the bottom to the top (DECK_TIER_POPULATION_TAPER), with
 * the rounding remainder given to the BOTTOM tier — the widest one, where a
 * puff more or less is least visible. Exported for the test that pins it:
 * "fewer toward the top" and "they all get drawn" are the two claims the dome
 * rests on.
 */
export function tierPopulations(total: number, tiers: number): number[] {
  const weights: number[] = [];
  let sum = 0;
  for (let tier = 0; tier < tiers; tier++) {
    // The bottom tier is 1 and the top is 1 - taper; a single-tier deck is all
    // bottom, which is what the guard on `tiers - 1` protects.
    const up = tiers === 1 ? 0 : tier / (tiers - 1);
    const weight = 1 - DECK_TIER_POPULATION_TAPER * up;
    weights.push(weight);
    sum += weight;
  }

  const counts: number[] = [];
  let dealt = 0;
  for (let tier = 0; tier < tiers; tier++) {
    const count = Math.floor((total * weights[tier]!) / sum);
    counts.push(count);
    dealt += count;
  }
  counts[0] = counts[0]! + (total - dealt);
  return counts;
}

/**
 * The golden angle, in radians — consecutive puffs placed this far apart in
 * bearing never line up into spokes at any count, which is the one failure a
 * fixed angular step has. Same low-discrepancy trick spiral.ts uses to spread
 * its seeds.
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Stable 0…1 from an instance index, for per-puff size and jitter. */
const GOLDEN_RATIO_CONJUGATE = 0.6180339887;

/**
 * Multipliers that turn one seed into two INDEPENDENT 0…1 values in the
 * shader (`fract(aSeed * k)`): one for a puff's height jitter within its tier,
 * one for its size. Irrational-looking and far apart, so the two derived
 * values do not correlate — a puff that sits high in its band must not also
 * be reliably the big one, or the deck's top tier reads as a row of same-size
 * heads. Any two such constants work; these are named so the vertex source
 * carries no bare numbers.
 */
const SEED_HASH_TIER_JITTER = 7.31;
const SEED_HASH_PUFF_SIZE = 5.7;
const SEED_HASH_PUFF_ASPECT = 3.37;

// ── The shade the deck throws ────────────────────────────────────────────────

/**
 * The ground shade one mass's deck casts — `ClientPluginCtx.publishGroundShade`.
 *
 * ONE DISC PER LIVING MASS, at the deck's own base height, over the deck's own
 * radius, darkened by the mass's INTERPOLATED intensity so the shadow gathers
 * and fades with the cloud rather than snapping on with the broadcast.
 *
 * `inner` is 0: a rain cloud's shadow is darkest under its middle and fades to
 * its rim, with no flat core (see `GroundShadeDisc` — `inner` is where the
 * falloff STARTS, not a hole). A cyclone passes a non-zero one; a rain mass has
 * nothing in the middle to spare.
 */
export function deckShadeDisc(disc: InterpolatedDisc, darkness: number): GroundShadeDisc {
  return {
    x: disc.x * CELL_WORLD_SIZE,
    z: disc.y * CELL_WORLD_SIZE,
    y: DECK_BASE_WORLD_Y,
    radius: disc.radius * CELL_WORLD_SIZE,
    darkness: darkness * disc.intensity,
    inner: 0,
  };
}

// ── The deck ─────────────────────────────────────────────────────────────────

/** What one plugin tells this module about its own cloud. */
export interface CumulusDeckSpec {
  /**
   * Slots in the deck — one per mass that can be alive at once, which is the
   * plugin's OWN cap. The instance capacity is this times the derived puff
   * count, so the buffer is an expression of the plugin's cap exactly as
   * `drawBudget` is.
   */
  readonly maxMasses: number;
  /**
   * A puff's half-width, as a fraction of the mass's radius. A FRACTION, not a
   * length, so the deck stays continuous whatever radius the server gave this
   * mass — spiral.ts's argument, and the one number `puffsForCoverage` reads.
   */
  readonly puffSizeFraction: number;
  /** The cloud's own colour, before any of the scene's light. */
  readonly color: number;
  /** Node name, for legibility in the three.js inspector. */
  readonly name: string;
  /**
   * `ClientPluginCtx.applyRevealClip`, so the deck stops at the frontier and
   * at the world's edge like everything else the plugin draws. Passed in rather
   * than imported: the kit has no context.
   */
  readonly applyRevealClip: (material: MeshLambertMaterial, label: string) => void;
}

/** One plugin's whole cloud: every mass's deck, in one instanced draw. */
export interface CumulusDeck {
  /** Parent this into the plugin's layer. */
  readonly object: Object3D;
  /** Puffs one mass's deck is built from, derived from the puff size. */
  readonly puffsPerMass: number;
  /**
   * Takes the next free slot, or -1 when every slot is taken. A caller holding
   * -1 draws no deck and is a breach of the plugin's own cap, not a crash.
   */
  claimSlot(): number;
  /** One frame of one mass's deck, from its interpolated disc. */
  update(slot: number, disc: InterpolatedDisc): void;
  /** This slot's mass is gone or dark: draw nothing for it. */
  park(slot: number): void;
  /**
   * Puts the deck in front of or behind its plugin's rigs for this frame, from
   * the camera's world Y — see DECK_RENDER_ORDER_CAMERA_ABOVE_BASE.
   *
   * CALLED ONCE PER FRAME FOR THE WHOLE PLUGIN, from
   * ./discSystemsView.ts's frame — never from a rig's `update`. It is one
   * property of one mesh, and the answer is the same for every mass under it.
   */
  orderAgainstCamera(cameraWorldY: number): void;
  dispose(): void;
}

/** Draw objects one deck costs, whatever the population: ONE. */
export const CUMULUS_DECK_DRAW_OBJECTS = 1;

export function createCumulusDeck(spec: CumulusDeckSpec): CumulusDeck {
  const puffsPerMass = puffsForCoverage(spec.puffSizeFraction);
  const capacity = spec.maxMasses * puffsPerMass;

  /**
   * Every mass's centre in world units, and every mass's (radius, intensity).
   *
   * TWO SMALL ARRAYS, REWRITTEN IN PLACE — the whole per-frame cost of a deck.
   * They are `Float32Array`s rather than arrays of `Vector2` because three
   * uploads a flat typed array for a `vec2[]` uniform with no per-frame
   * allocation and no per-element read.
   */
  const massXZ = new Float32Array(spec.maxMasses * 2);
  const massSize = new Float32Array(spec.maxMasses * 2);

  // ── The GLSL, spliced into a stock Lambert program ─────────────────────────
  //
  // The uniform ARRAY SIZE has to be a literal in the source, so the shader is
  // built here rather than at module scope. Every other number is a named
  // constant above, formatted through `glslFloat` because GLSL ES refuses to
  // mix an int literal into a float expression.

  /**
   * The varyings and the one tunable both stages need.
   *
   * ONE BLOCK FOR BOTH, because a varying must be declared identically in the
   * two stages or the program fails to LINK — the same reasoning
   * render/revealMask.ts states for its own shared block.
   */
  const sharedDeclarations = /* glsl */ `
varying vec2 vQuad;
varying float vPuffFade;
varying float vSeed;
#define PUFF_NORMAL_FLATNESS ${glslFloat(PUFF_NORMAL_FLATNESS)}`;

  /**
   * The vertex stage's own declarations, and they CANNOT be shared with the
   * fragment stage: `attribute` is a vertex-only qualifier, and three rewrites
   * it to `in` in the vertex prefix only, so a fragment shader carrying these
   * fails to COMPILE. It fails QUIETLY as far as the picture goes — three logs
   * the error and the mesh draws nothing — which is exactly what this deck did
   * on its first in-world run (2026-09-02), 973 instances submitted and not one
   * pixel on screen.
   */
  const vertexDeclarations = /* glsl */ `${sharedDeclarations}
uniform vec2 uMassXZ[${spec.maxMasses}];
uniform vec2 uMassSize[${spec.maxMasses}];
attribute float aSlot;
attribute float aSeed;
attribute float aTier;
attribute vec2 aPolar;`;

  /**
   * The puff's own world position, written over `transformed` BEFORE
   * `<project_vertex>` — which is what makes every stock chunk downstream, and
   * core's `applyRevealClip` splice with them, land on the puff rather than on
   * the quad's own corner. The billboard offset comes after, in view space.
   */
  const placement = /* glsl */ `int massSlot = int(aSlot + 0.5);
    vec2 massCentre = uMassXZ[massSlot];
    float massRadius = uMassSize[massSlot].x;
    float massFade = uMassSize[massSlot].y;

    // A dome: each tier is drawn over a smaller disc than the one below it.
    float tierRadius = massRadius * mix(1.0, ${glslFloat(DECK_TOP_RADIUS_FRACTION)}, aTier);
    float outward = aPolar.x * tierRadius;

    // The rim fades, so the deck has no edge; the mass's own intensity fades
    // the whole thing, so a gathering front costs nothing until it is there.
    vPuffFade = massFade *
      (1.0 - smoothstep(${glslFloat(DECK_RIM_FADE_START)}, 1.0, aPolar.x));
    vQuad = position.xy;
    vSeed = aSeed;

    // NOTHING IS DRAWN FOR A PARKED OR DARK SLOT. Every vertex of the quad
    // lands on the same point outside the clip volume, so the primitive is
    // culled before it reaches a fragment — the deck's equivalent of
    // discRig.ts's "a transparent draw call that contributes nothing is still
    // a transparent draw call".
    if (vPuffFade <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float tierJitter = (fract(aSeed * ${glslFloat(SEED_HASH_TIER_JITTER)}) * 2.0 - 1.0) *
      ${glslFloat(DECK_TIER_JITTER_WORLD_UNITS)};

    transformed = vec3(
      massCentre.x + cos(aPolar.y) * outward,
      ${glslFloat(DECK_BASE_WORLD_Y)} +
        aTier * ${glslFloat(DECK_THICKNESS_WORLD_UNITS)} + tierJitter,
      massCentre.y + sin(aPolar.y) * outward);

    // Bigger toward the top, and never twice the same size in a row.
    float puffSize = massRadius * ${glslFloat(spec.puffSizeFraction)} *
      (1.0 + ${glslFloat(PUFF_SIZE_TOP_GROWTH)} * aTier) *
      (${glslFloat(1 - PUFF_SIZE_SEED_VARIATION)} +
       ${glslFloat(2 * PUFF_SIZE_SEED_VARIATION)} * fract(aSeed * ${glslFloat(SEED_HASH_PUFF_SIZE)}));

    // Oblong, per seed, and area-neutral: stretched along x by the aspect,
    // squashed along y by the same — see PUFF_ASPECT_SEED_VARIATION.
    float aspect = ${glslFloat(1 - PUFF_ASPECT_SEED_VARIATION)} +
      ${glslFloat(2 * PUFF_ASPECT_SEED_VARIATION)} * fract(aSeed * ${glslFloat(SEED_HASH_PUFF_ASPECT)});
    vec2 puffExtent = puffSize * vec2(aspect, 1.0 / aspect);`;

  /**
   * The billboard, in VIEW space, after `<project_vertex>` has put the puff's
   * centre in `mvPosition` — faces the camera exactly, for free, with no
   * rotation written from the CPU and no chance of lagging it by a frame. The
   * same mechanism ./puffDeck.ts's PUFF_BILLBOARD_GLSL states; written out
   * here rather than pasted because this one offsets an mvPosition three has
   * already computed instead of building its own.
   */
  const billboard = /* glsl */ `mvPosition.xy += position.xy * puffExtent;
    gl_Position = projectionMatrix * mvPosition;`;

  /**
   * The puff mask and the deck's alpha, at the fragment.
   *
   * Placed after `<alphatest_fragment>`, so a corner that is not part of the
   * round puff is discarded BEFORE the Lambert lighting is evaluated for it.
   */
  const mask = /* glsl */ `${puffMaskGlsl(glslFloat(PUFF_SOFT_EDGE_FRACTION), {
    amplitude: PUFF_LOBE_AMPLITUDE,
    seedVarying: 'vSeed',
  })}
    float alpha = puff * vPuffFade;
    ${PUFF_ALPHA_DISCARD_GLSL}
    diffuseColor.a *= alpha;`;

  /**
   * THE PUFF IS LIT AS A SPHERE. `vQuad` is the offset from the puff's centre
   * in half-widths, so it IS the x/y of a unit sphere's surface point facing
   * the camera and the z falls out of it — in VIEW space, which is the space
   * `vNormal` is already in. Blended toward view-space up so the deck reads as
   * one body lit from above rather than as a tray of billiard balls.
   *
   * Per FRAGMENT and not per vertex, deliberately: a quad's four corners all
   * sit at |vQuad| >= 1 where the sphere's z is zero, so a per-vertex normal
   * would interpolate to nothing through the middle of every puff.
   *
   * Divided by `lobeScale` (left in scope by the mask above): the sphere is
   * the LOBED one the mask drew, so each lobe gets its own shaded flank rather
   * than a bumpy outline lit as a smooth ball.
   */
  const sphereNormal = /* glsl */ `vec2 lobedQuad = vQuad / lobeScale;
    vec3 puffSphere =
      vec3(lobedQuad, sqrt(max(0.0, 1.0 - dot(lobedQuad, lobedQuad))));
    vec3 puffUp = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    normal = normalize(mix(puffSphere, puffUp, PUFF_NORMAL_FLATNESS));`;

  const material = new MeshLambertMaterial({
    color: spec.color,
    transparent: true,
    // Depth TESTED so the ground and the sea hide a deck behind them, not
    // depth WRITTEN: this is transparent geometry, and the rule this codebase
    // keeps for all of it (hazeBank.ts, precipitation.ts, spiral.ts, fire's
    // smoke) is that transparent things never write depth.
    depthWrite: false,
    // A billboard always presents its front face to the camera, so there is no
    // back face to draw — but the quad's winding is decided after the view
    // transform this shader writes itself, and DoubleSide is what makes that
    // impossible to get wrong. The fragment cost is nil: the far side of a
    // billboard is never rasterised.
    side: DoubleSide,
  });

  const label = `${spec.name} deck`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMassXZ = { value: massXZ };
    shader.uniforms.uMassSize = { value: massSize };

    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        SHADER_COMMON_ANCHOR,
        `${SHADER_COMMON_ANCHOR}\n${vertexDeclarations}`,
        label,
      ),
      BEGIN_VERTEX_ANCHOR,
      `${BEGIN_VERTEX_ANCHOR}\n    ${placement}`,
      label,
    );
    shader.vertexShader = spliceShader(
      shader.vertexShader,
      PROJECT_VERTEX_ANCHOR,
      `${PROJECT_VERTEX_ANCHOR}\n    ${billboard}`,
      label,
    );

    shader.fragmentShader = spliceShader(
      spliceShader(
        spliceShader(
          shader.fragmentShader,
          SHADER_COMMON_ANCHOR,
          `${SHADER_COMMON_ANCHOR}\n${sharedDeclarations}`,
          label,
        ),
        ALPHATEST_FRAGMENT_ANCHOR,
        `${ALPHATEST_FRAGMENT_ANCHOR}\n    ${mask}`,
        label,
      ),
      NORMAL_FRAGMENT_ANCHOR,
      `${NORMAL_FRAGMENT_ANCHOR}\n    ${sphereNormal}`,
      label,
    );
  };
  // three keys a compiled program by material type, parameters and this method
  // — never by `onBeforeCompile` — so without a key of its own a deck could
  // share a program with any other MeshLambertMaterial of the same parameters
  // and whichever compiled first would decide what both drew. Same reasoning,
  // and the same fix, as render/revealMask.ts's.
  const stockCacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${stockCacheKey()}|cumulusDeck:${spec.name}`;

  // The clip is applied AFTER our own patch is assigned, because
  // `applyRevealClip` CHAINS onto whatever `onBeforeCompile` the material
  // already has — assigning ours afterwards would drop it.
  spec.applyRevealClip(material, label);

  // ── The instances ─────────────────────────────────────────────────────────

  const geometry = new PlaneGeometry(2, 2, 1, 1);
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.name = `${spec.name}:puffs`;
  // The ordinary case, and never left to chance: a deck that was built and
  // then never told about the camera still draws over its rig rather than at
  // three's default 0, which would put it under the sea.
  mesh.renderOrder = DECK_RENDER_ORDER_CAMERA_ABOVE_BASE;
  // BORN INVISIBLE. A plugin whose kind is not in the sky this session — snow
  // in a temperate world, say — must submit no draw call at all, and `visible`
  // is only ever turned on by a slot going live below.
  mesh.visible = false;
  // Every vertex is placed in the shader from a uniform, so three's bounding
  // sphere — computed from the undisplaced quad at the origin — describes
  // nothing this draws.
  mesh.frustumCulled = false;

  // THE INSTANCE MATRIX IS IDENTITY AND STAYS IDENTITY. A puff's position comes
  // from `uMassXZ`, not from its matrix, so there is nothing for the matrix to
  // carry — but three fills `instanceMatrix` with ZEROES, not identity, and a
  // zero matrix in `<project_vertex>` would collapse the whole deck to the
  // origin. Written once, at build, and never again.
  const identity = new Matrix4();
  for (let instance = 0; instance < capacity; instance++) mesh.setMatrixAt(instance, identity);
  mesh.instanceMatrix.needsUpdate = true;

  const slots = new Float32Array(capacity);
  const seeds = new Float32Array(capacity);
  const tiers = new Float32Array(capacity);
  const polars = new Float32Array(capacity * 2);

  const perTier = tierPopulations(puffsPerMass, DECK_TIERS);
  for (let slot = 0; slot < spec.maxMasses; slot++) {
    let puff = 0;
    for (let tier = 0; tier < DECK_TIERS; tier++) {
      const inTier = perTier[tier]!;
      // The tier's own height, as a fraction of the deck's thickness. A
      // one-tier deck is all base, which is what the guard protects.
      const tierFraction = DECK_TIERS === 1 ? 0 : tier / (DECK_TIERS - 1);
      for (let index = 0; index < inTier; index++) {
        const instance = slot * puffsPerMass + puff;
        slots[instance] = slot;
        tiers[instance] = tierFraction;
        // The puff's own 0…1, from its index rather than from Math.random —
        // see the header on why a cloud's shape is deterministic.
        seeds[instance] = (instance * GOLDEN_RATIO_CONJUGATE) % 1;
        // A PHYLLOTAXIS SPIRAL over the tier's disc: the radius is the
        // sample's rank taken to DECK_RADIAL_EXPONENT, the bearing steps by
        // the golden angle. Even at every count, clumped nowhere, and with no
        // spokes — which a fixed angular step would produce at any count that
        // divides the turn.
        polars[instance * 2] = Math.pow((index + 0.5) / inTier, DECK_RADIAL_EXPONENT);
        polars[instance * 2 + 1] = index * GOLDEN_ANGLE + tier * TWO_PI * GOLDEN_RATIO_CONJUGATE;
        puff++;
      }
    }
  }

  geometry.setAttribute('aSlot', new InstancedBufferAttribute(slots, 1));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
  geometry.setAttribute('aTier', new InstancedBufferAttribute(tiers, 1));
  geometry.setAttribute('aPolar', new InstancedBufferAttribute(polars, 2));

  let claimed = 0;
  /** Slots with a living, lit mass in them this frame. */
  let live = 0;

  return {
    object: mesh,
    puffsPerMass,

    claimSlot(): number {
      if (claimed >= spec.maxMasses) return -1;
      return claimed++;
    },

    update(slot: number, disc: InterpolatedDisc): void {
      if (slot < 0) return;
      // CLAMPED AT ZERO before it is stored. `live` is kept by comparing the
      // stored intensity against exactly 0, so a negative value — which the
      // interpolator's easing could hand over at the end of a fade — would
      // count as "lit" on the way in and "dark" on every frame after, and the
      // counter would walk below zero and never turn the mesh off again.
      const intensity = Math.max(0, disc.intensity);
      const wasDark = massSize[slot * 2 + 1] === 0;
      massXZ[slot * 2] = disc.x * CELL_WORLD_SIZE;
      massXZ[slot * 2 + 1] = disc.y * CELL_WORLD_SIZE;
      massSize[slot * 2] = disc.radius * CELL_WORLD_SIZE;
      massSize[slot * 2 + 1] = intensity;
      if (wasDark && intensity > 0) live++;
      if (!wasDark && intensity === 0) live--;
      // ONE DRAW CALL FOR NOTHING IS STILL ONE DRAW CALL. A plugin with no
      // mass in the air submits no deck at all, which is the same promise
      // discSystemsView.ts makes for an empty list.
      mesh.visible = live > 0;
    },

    park(slot: number): void {
      if (slot < 0) return;
      if (massSize[slot * 2 + 1] !== 0) live--;
      massSize[slot * 2 + 1] = 0;
      mesh.visible = live > 0;
    },

    orderAgainstCamera(cameraWorldY: number): void {
      mesh.renderOrder =
        cameraWorldY >= DECK_BASE_WORLD_Y
          ? DECK_RENDER_ORDER_CAMERA_ABOVE_BASE
          : DECK_RENDER_ORDER_CAMERA_BELOW_BASE;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      claimed = 0;
      live = 0;
    },
  };
}

// ── The stock-shader anchors this module splices at ─────────────────────────
//
// All four verified present in three 0.185.1's `meshlambert` program
// (client/node_modules/three/src/renderers/shaders/ShaderLib/meshlambert.glsl.js
// lines 6/35/39/60/90/99/102). `spliceShader` throws on the first frame if a
// future upgrade moves one, naming the anchor — the designed failure.

/** The header, in both stages. */
const SHADER_COMMON_ANCHOR = '#include <common>';
/** Declares `vec3 transformed`, which the placement above writes over. */
const BEGIN_VERTEX_ANCHOR = '#include <begin_vertex>';
/** Declares `vec4 mvPosition` and writes `gl_Position`; the billboard follows. */
const PROJECT_VERTEX_ANCHOR = '#include <project_vertex>';
/** The last chunk to touch `diffuseColor` before the lighting reads it. */
const ALPHATEST_FRAGMENT_ANCHOR = '#include <alphatest_fragment>';
/** Declares `vec3 normal` from `vNormal`; the sphere normal replaces it. */
const NORMAL_FRAGMENT_ANCHOR = '#include <normal_fragment_begin>';
