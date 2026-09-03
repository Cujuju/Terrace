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
import { CYCLONE_EYE_RADIUS_FRACTION, CYCLONE_RADIUS_CELLS } from '../protocol.ts';
import {
  PUFF_ALPHA_DISCARD_GLSL,
  puffMaskGlsl,
} from '../../../client/src/plugins/kit/puffDeck.ts';
import {
  DECK_BASE_WORLD_Y,
  DECK_RENDER_ORDER_CAMERA_ABOVE_BASE,
  DECK_RENDER_ORDER_CAMERA_BELOW_BASE,
  DECK_THICKNESS_WORLD_UNITS,
  PUFF_NORMAL_FLATNESS,
  PUFF_SOFT_EDGE_FRACTION,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import { glslFloat, spliceShader } from '../../../client/src/render/shaderSplice.ts';

/**
 * Arms, and positions along one arm.
 *
 * NINETY PER ARM ACROSS NINE ARMS. The count is set by COVERAGE, not by taste,
 * and it was RAISED from sixty when the preview harness showed why: at the puff
 * size needed for the arms to be distinguishable from each other, sixty per arm
 * leaves gaps along an arm — the scatter across the band's width pulls
 * neighbours out of line — and the deck reads as a dotted spiral. Puff size and
 * this count are one decision: shrink one and the other has to grow.
 *
 * A POSITION IS NOT A PUFF ANY MORE (#299). Each of these positions carries a
 * STACK of puffs — `tiersAt` below — so the deck has depth; PUFFS_PER_SPIRAL is
 * the sum over the stacks and is derived, never typed.
 */
export const ARMS_PER_SPIRAL = 9;
export const POSITIONS_PER_ARM = 90;

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

// ── THE TOWER (#299) ─────────────────────────────────────────────────────────
//
// WHAT WAS WRONG. Every puff sat at one height, scattered by a tenth of the
// deck height either side of it: a LID. From a low camera a cyclone was a band
// across the sky with the far side of the storm showing straight through it,
// which is the whole of the owner's "extremely weak … a puffy disk" (#299).
//
// WHAT IT IS NOW. The storm keeps its disc footprint and its eye hole, and it
// is built IN DEPTH: an arm rises from a low, wide RIM to a tall, dark EYEWALL
// ring standing around the eye. It is NOT a cone — a funnel is the tornado
// plugin's shape (#233) — it is a wall with a hole in it.
//
// ONE PROFILE DRIVES ALL FOUR THINGS. `wall` is 1 at the eyewall and 0 at the
// rim, and the height, the puff size, the puff's solidity and the shade are all
// read off it, so the dark, tall, solid part of the storm is the same part of
// the storm by construction. Four independently tuned ramps could disagree
// about where the eyewall is; this one cannot.

/**
 * World-space Y of the deck's FLAT BASE — the plane the arms stand on and the
 * plane the rain falls out of.
 *
 * THE KIT'S CLOUD BASE, taken as the import so the two can never be moved
 * apart. It REPLACES this plugin's own `CYCLONE_DECK_HEIGHT_WORLD_UNITS`, which
 * was 10, and that number was wrong twice over (verified 2026-09-03):
 *
 *   1. Its own doc claimed it was "above the tallest land the world can have
 *      (16 units of relief)". Ten is not above sixteen. A player who built a
 *      maximum-height peak had it poking through the storm.
 *   2. The kit's falling column births every particle at CLOUD_BASE_WORLD_Y
 *      (24) and that height is not a profile parameter, so rain hung on a deck
 *      at 10 would have fallen out of empty sky fourteen units above it.
 *
 * The alternative — giving the column contract a base height — was rejected:
 * it would let two clouds in one sky sit at two altitudes with nothing saying
 * which is right, and there is no reason for a hurricane's cloud base to be
 * anywhere but the cloud base. This file's "seen from inside it" design
 * survives the move intact: what makes the deck read from underneath is that it
 * is billboarded puffs with no edge (see the header), not how low it hangs, and
 * the eyewall now rises ABOVE the base rather than the whole deck sitting under
 * the mountains.
 */
export const CYCLONE_DECK_BASE_WORLD_Y = DECK_BASE_WORLD_Y;

/**
 * How much taller the eyewall is than ordinary cloud is deep.
 *
 * THREE. The eyewall is the deepest convection in the storm and the rim is an
 * ordinary overcast, so the ratio is the shape of a hurricane in one number.
 * Three is what makes the wall read as a WALL from a camera at cloud height:
 * at two the ring is barely taller than it is thick and still reads as a band,
 * and beyond three the storm starts to read as a chimney rather than as
 * weather.
 */
export const CYCLONE_EYEWALL_HEIGHT_MULTIPLE = 3;

/**
 * How tall the eyewall and the rim stand above the base, in world units.
 *
 * A LENGTH, AND A MULTIPLE OF THE KIT'S CLOUD DEPTH — never a fraction of the
 * storm's radius, and this is the choice the radius clamp decides
 * (`cycloneRadiusFor`, ../protocol.ts). DECK_THICKNESS_WORLD_UNITS is derived
 * from CLOUD_HEADROOM_WORLD_UNITS, which is derived from MAX_GROUND_WORLD_Y —
 * the world's VERTICAL scale, which the radius clamp does not touch. So on a
 * small world, where a cyclone's radius is clamped to a third of what it would
 * otherwise be, the tower keeps the height that the air gives it; a
 * fraction-of-radius eyewall would flatten into a pancake on exactly the worlds
 * where the storm is already smallest. It is the same argument
 * kit/cumulusDeck.ts makes for its own thickness — a cloud's depth is set by
 * the air, not by the width of the front — applied to the one number that
 * varies here.
 *
 * The rim IS ordinary cloud depth: at its outer edge a hurricane is an
 * overcast, and there is nothing to say about it that the kit has not said.
 */
export const CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS =
  DECK_THICKNESS_WORLD_UNITS * CYCLONE_EYEWALL_HEIGHT_MULTIPLE;
export const CYCLONE_RIM_HEIGHT_WORLD_UNITS = DECK_THICKNESS_WORLD_UNITS;

/**
 * How fast the tower falls from the eyewall to the rim: the exponent in
 * `wall = 1 - along^k`.
 *
 * A HALF — the square root, so half the height is gone by a QUARTER of the way
 * out. Below one the profile drops steeply at the eye and flattens outward,
 * which is the shape wanted: a narrow ring of tall cloud with a broad low deck
 * beyond it. At k = 1 the height ramps evenly across the whole radius and the
 * storm is a cone, which is the tornado's shape and not this one; above 1 the
 * deck stays tall almost to the rim and then falls off a cliff, which is a
 * cylinder with a lid.
 */
export const CYCLONE_TOWER_FALLOFF_EXPONENT = 0.5;

/**
 * How much larger an eyewall puff is than a rim puff.
 *
 * +60 %. THE OCCLUSION REQUIREMENT SETS IT, not taste: the eyewall has to hide
 * the far side of the storm from a low camera, and that needs the puffs at the
 * eye to overlap each other in every direction — along the arm, across the
 * band's width and up the stack — rather than merely touch. Sixty per cent
 * takes the eyewall puff from about a twelfth of the storm's radius to about a
 * sixth, which is wider than the gap between two adjacent arms at that radius,
 * so the ring closes; the rim keeps the size the arms were made distinguishable
 * at (PUFF_SIZE_RADIUS_FRACTION), which is what stops the growth swallowing the
 * gaps between the arms further out.
 */
export const CYCLONE_EYEWALL_PUFF_GROWTH = 0.6;

/**
 * The per-seed size spread, as the two ends of `size * (min … min + span)`.
 *
 * Named out of the shader source rather than left as the bare `0.7 + 0.6 *`
 * this file used to carry, because the arithmetic below reads them: the tier
 * spacing is set by the SMALLEST puff a position can hold, and the band's inner
 * radius by the LARGEST.
 */
export const PUFF_SIZE_SEED_MIN = 0.7;
export const PUFF_SIZE_SEED_SPAN = 0.6;

/**
 * A cyclone's radius in world units before the world-size clamp — the size the
 * tower's vertical spacing is reasoned at.
 *
 * The spacing has to be a LENGTH (see CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS) while
 * a puff's size is a FRACTION of the storm, so the two can only be compared at
 * one stated radius. This is that radius, and it is the one nearly every world
 * gets: the clamp only bites on a world under a hundred cells across.
 *
 * RESIDUAL, NAMED: on a world small enough for the clamp to bite, the puffs
 * shrink with the storm while the tower's height and spacing do not, so a
 * heavily clamped cyclone's stack can separate into visible layers. The
 * alternative — a radius-dependent instance layout — would make the instance
 * count a function of the world size, which is a buffer that cannot be sized
 * once at build.
 */
export const CYCLONE_NOMINAL_RADIUS_WORLD_UNITS = CYCLONE_RADIUS_CELLS * CELL_WORLD_SIZE;

/**
 * How solid a puff is at each end of the profile — where its radial fade starts,
 * as a fraction of its half-width (kit/puffDeck.ts's `puffMaskGlsl`).
 *
 * THE EYEWALL IS SOLID AND THE RIM IS A SMEAR, and both are right for what they
 * are. A puff that fades from its very centre is a smear, which is what an arm
 * of a hurricane seen from high above should be and is the value this deck used
 * everywhere. It is exactly wrong for the eyewall: a hundred overlapping
 * gradients average out into fog you can see the far coast through — the defect
 * kit/cumulusDeck.ts measured and fixed with the same number, so the eyewall
 * takes PUFF_SOFT_EDGE_FRACTION as the import rather than a second copy of it.
 */
export const CYCLONE_EYEWALL_SOFT_EDGE = PUFF_SOFT_EDGE_FRACTION;
export const CYCLONE_RIM_SOFT_EDGE = 0;

/**
 * Where an arm's innermost puff CENTRE sits, as a fraction of the storm's
 * radius.
 *
 * THE EYE, PLUS THE WIDEST PUFF THAT CAN LAND THERE — so the cloud's inner
 * EDGE is the eye and not its centre line. The arms used to start their centres
 * at CYCLONE_EYE_RADIUS_FRACTION, which put half of every eyewall puff INSIDE
 * the eye: at the largest seed the puff reached 0.11 of the radius inward from
 * 0.125, so the hole was all but filled and what was left of it was a soft
 * smudge. The eye being a hole is the one thing about this deck the server also
 * believes (../protocol.ts's CYCLONE_EYE_RADIUS_FRACTION), so it is worth
 * constructing rather than hoping for.
 */
export const CYCLONE_EYEWALL_PUFF_HALF_WIDTH_FRACTION =
  PUFF_SIZE_RADIUS_FRACTION *
  (1 + CYCLONE_EYEWALL_PUFF_GROWTH) *
  (PUFF_SIZE_SEED_MIN + PUFF_SIZE_SEED_SPAN);
export const CYCLONE_BAND_INNER_RADIUS_FRACTION =
  CYCLONE_EYE_RADIUS_FRACTION + CYCLONE_EYEWALL_PUFF_HALF_WIDTH_FRACTION;

/**
 * How far a puff may be lifted off its tier, as a fraction of the tier spacing.
 *
 * HALF A TIER, so a puff wanders inside its own band and can never cross into
 * the next one — the rule kit/cumulusDeck.ts's DECK_TIER_JITTER_WORLD_UNITS
 * states, and what stops a stack reading as a row of shelves.
 *
 * UPWARD ONLY, which the kit's is not, and that is deliberate here: it makes
 * "every puff centre is at or above CYCLONE_DECK_BASE_WORLD_Y" EXACTLY true
 * rather than true to within one jitter, and that statement is the whole of
 * this deck's draw-order argument against its own rain (#300, see
 * `orderAgainstCamera`). The kit names the same gap as a residual because its
 * deck has no rain of its own to be misordered against.
 */
export const CYCLONE_TIER_JITTER_FRACTION = 0.5;

/** How tall the tower stands above the base at `along`, in world units. */
export function towerHeightAt(along: number): number {
  const wall = 1 - Math.pow(along, CYCLONE_TOWER_FALLOFF_EXPONENT);
  return (
    CYCLONE_RIM_HEIGHT_WORLD_UNITS +
    (CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS - CYCLONE_RIM_HEIGHT_WORLD_UNITS) * wall
  );
}

/**
 * The SMALLEST puff a position at `along` can hold, in world units at the
 * nominal radius — which is what the tier spacing has to be, because the
 * requirement is that consecutive tiers OVERLAP for every puff and not merely
 * for the average one.
 */
export function tierRiseAt(along: number): number {
  const wall = 1 - Math.pow(along, CYCLONE_TOWER_FALLOFF_EXPONENT);
  return (
    CYCLONE_NOMINAL_RADIUS_WORLD_UNITS *
    PUFF_SIZE_RADIUS_FRACTION *
    (1 + CYCLONE_EYEWALL_PUFF_GROWTH * wall) *
    PUFF_SIZE_SEED_MIN
  );
}

/**
 * Puffs stacked at `along`: as many as it takes to fill the tower there at that
 * spacing, and never fewer than the two it takes to have a top and a bottom.
 *
 * MORE PUFFS NEAR THE EYE, AND THAT IS THE DECISION (of the brief's two). The
 * other — a fixed stack count everywhere, spaced by a fraction of the local
 * height — spreads the SAME number of puffs over three times the height at the
 * eyewall, so the tallest part of the storm would also be its thinnest and the
 * wall would be see-through exactly where it has to occlude. Dealing the extra
 * puffs where the cloud is deep is what makes the eyewall dense as well as
 * tall, and it is also the cheaper of the two: the rim, which is most of the
 * storm's area, carries three puffs to a position rather than the eyewall's
 * five.
 */
export function tiersAt(along: number): number {
  return Math.round(towerHeightAt(along) / tierRiseAt(along)) + 1;
}

/** The `along` of position `index` — evenly spaced, see `writeLayout`. */
export function alongAt(index: number): number {
  return (index + 0.5) / POSITIONS_PER_ARM;
}

/**
 * Puffs in one arm, and in one whole cyclone — the sum over the stacks.
 *
 * DERIVED, NEVER TYPED, exactly as the old flat 810 was derived from ninety
 * positions on one tier. It is the instance count the buffers are sized from,
 * so it is a COVERAGE decision like PUFF_SIZE_RADIUS_FRACTION and not a budget:
 * shrink the puffs or the tower and it falls on its own.
 */
export const PUFFS_PER_ARM: number = (() => {
  let total = 0;
  for (let index = 0; index < POSITIONS_PER_ARM; index++) total += tiersAt(alongAt(index));
  return total;
})();
export const PUFFS_PER_SPIRAL = ARMS_PER_SPIRAL * PUFFS_PER_ARM;

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
 *
 * IT IS NOW READ OFF THE TOWER PROFILE and no longer off `along` directly
 * (#299). A linear ramp in `along` put its darkest point at the eye and its
 * mid-grey half way out to the rim — a wash across the whole storm, which is
 * why the shade never read as a wall standing anywhere in particular. Driven by
 * `wall`, the dark collapses onto the same narrow ring the height and the puff
 * size do, and the broad low rim beyond it stays the bright overcast it should
 * be.
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
 * Where the deck sits in the transparent pass, and WHY IT DEPENDS ON THE CAMERA
 * (#300, #299).
 *
 * THE KIT'S TWO ORDERS, TAKEN AS THE IMPORT. This deck now has rain of its own
 * falling out of it (./rain.ts), which is the exact pair kit/cumulusDeck.ts's
 * DECK_RENDER_ORDER_CAMERA_ABOVE_BASE settles for the other three sky plugins,
 * and the geometric argument it makes transfers here WORD FOR WORD because both
 * halves now share the kit's plane: every puff centre of this deck is at or
 * above CYCLONE_DECK_BASE_WORLD_Y (exactly — see CYCLONE_TIER_JITTER_FRACTION),
 * and every particle of the column is at or below it. So from above, a puff is
 * nearer on every ray and the deck is drawn LAST; from below, the reverse, and
 * it is drawn FIRST. `orderAgainstCamera` is the one boolean a frame needs.
 *
 * THE FUNNEL RELATION STILL HOLDS, and it is the reason these are half steps
 * rather than a new integer: the deck's orders are 0.5 and 1.5, both strictly
 * under funnel.ts's FUNNEL_RENDER_ORDER of 2, so a tornado under an overcast is
 * still painted over the overcast whichever side of the cloud base the camera
 * is. Both are positive, so the deck still lands after the world-sized
 * transparent sea at 0. The column itself sits at the kit's DISC_RENDER_ORDER
 * (1), exactly between them, which is what the argument above is about.
 */
export const SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE = DECK_RENDER_ORDER_CAMERA_ABOVE_BASE;
export const SPIRAL_RENDER_ORDER_CAMERA_BELOW_BASE = DECK_RENDER_ORDER_CAMERA_BELOW_BASE;

/** A full turn in radians, for the bearings this deck works in turns of. */
const TWO_PI = Math.PI * 2;

/**
 * How wide the band one arm scatters across is, as a fraction of the storm's
 * radius, at each end of the arm.
 *
 * NARROW AT THE EYEWALL AND WIDE AT THE RIM — real arms widen outward, and it
 * is also what keeps the ring around the eye readable as a ring. Written as the
 * two ENDS rather than as the base-and-slope pair (`0.012 + 0.045 * along`)
 * this shader used to carry: the same line, with both of the numbers a reader
 * would want to check actually stated.
 */
const BAND_HALF_WIDTH_EYEWALL_FRACTION = 0.012;
const BAND_HALF_WIDTH_RIM_FRACTION = 0.057;

/**
 * Multipliers that turn one seed into INDEPENDENT 0…1 values in the shader
 * (`fract(aSeed * k)`) and on the CPU: a puff's bearing across its band, how
 * far across the band it goes, its size, and how far it is lifted off its tier.
 *
 * Irrational-looking and far apart, so no two derived values correlate — a puff
 * scattered to the outside of its band must not also reliably be the big one,
 * or the arms grow a visible bright edge. Any such constants work; these are
 * the ones this shader has always used, named so the source carries no bare
 * numbers. Same device, and the same reasoning, as kit/cumulusDeck.ts's pair.
 */
const SEED_HASH_SCATTER_BEARING = 13.7;
const SEED_HASH_SCATTER_SPAN = 7.13;
const SEED_HASH_SCATTER_SPAN_OFFSET = 0.17;
const SEED_HASH_PUFF_SIZE = 5.7;
const SEED_HASH_TIER_JITTER = 7.31;

/**
 * The golden ratio's conjugate — the step that spreads consecutive instance
 * indices over 0…1 without ever repeating or clustering, whatever the count.
 * Named out of the bare `0.6180339887` the layout used to carry inline; the
 * same low-discrepancy trick kit/cumulusDeck.ts names for its own seeds.
 */
const GOLDEN_RATIO_CONJUGATE = 0.6180339887;

/**
 * Stable 0…1 from a puff's own seed, for a value that must not correlate with
 * any other value drawn from it — the CPU's half of `fract(aSeed * k)`, and
 * written the same way so the two cannot drift.
 */
function seedHash(seed: number, multiplier: number): number {
  return (seed * multiplier) % 1;
}

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
varying float vWall;
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
attribute float aStrength;
attribute float aRise;`;

const SPIRAL_PLACEMENT = /* glsl */ `vAlong = aAlong;
    vStrength = aStrength;
    vQuad = position.xy;

    // THE TOWER PROFILE, and everything about this puff that is not its place
    // along the arm is read off it: 1 at the eyewall, 0 at the rim. See the
    // TOWER block above — the height it implies is already in aRise, computed
    // once per layout because the STACK COUNT is what varies with it and a
    // count cannot be produced in a vertex shader.
    float wall = 1.0 - pow(aAlong, ${glslFloat(CYCLONE_TOWER_FALLOFF_EXPONENT)});
    vWall = wall;

    // THE LOGARITHMIC SPIRAL. aAlong runs 0 at the eyewall to 1 at the rim; the
    // radius interpolates from the innermost band's centre line to the storm's
    // edge, and the angle is the arm's own starting angle plus the wrap, plus
    // the whole deck's slow rotation. The inner end is the EYE PLUS A PUFF
    // (CYCLONE_BAND_INNER_RADIUS_FRACTION), so the cloud's inner edge is the
    // eye rather than its centre line.
    float radius = aRadius * mix(${glslFloat(CYCLONE_BAND_INNER_RADIUS_FRACTION)}, 1.0, aAlong);
    float angle = ${glslFloat(TWO_PI)} * (
      aArm +
      aAlong * ${glslFloat(ARM_WRAP_TURNS)} +
      uElapsed * ${glslFloat(SPIRAL_SPIN_TURNS_PER_SECOND)});

    // A scatter across the arm's width, so an arm is a BAND of cloud and not a
    // wire. It widens outward, which is what real arms do and what stops the
    // eyewall being swallowed.
    float scatterAngle = fract(aSeed * ${glslFloat(SEED_HASH_SCATTER_BEARING)}) *
      ${glslFloat(TWO_PI)};
    // The band an arm covers, narrow at the eyewall and wide at the rim. Kept
    // narrow for the reason the puff size is: at a wider band the scatter alone
    // fills the gaps between two arms and the deck is a disc again.
    float scatter = aRadius *
      mix(${glslFloat(BAND_HALF_WIDTH_EYEWALL_FRACTION)},
          ${glslFloat(BAND_HALF_WIDTH_RIM_FRACTION)}, aAlong) *
      fract(aSeed * ${glslFloat(SEED_HASH_SCATTER_SPAN)} +
            ${glslFloat(SEED_HASH_SCATTER_SPAN_OFFSET)});

    // THE OFFSET FROM THE EYE, not the world position: the instance matrix
    // carries the eye and the project_vertex chunk applies it two lines later.
    // The Y is absolute because the matrix carries no height — the deck is a
    // cloud layer at a fixed base, and where the ground under it happens to be
    // is irrelevant (see ./index.ts's header).
    transformed = vec3(
      cos(angle) * radius + cos(scatterAngle) * scatter,
      ${glslFloat(CYCLONE_DECK_BASE_WORLD_Y)} + aRise,
      sin(angle) * radius + sin(scatterAngle) * scatter);

    // BIGGER AT THE EYEWALL, and varying with the seed so the deck is not a
    // grid of clones.
    float puffSize = aRadius * ${glslFloat(PUFF_SIZE_RADIUS_FRACTION)} *
      (1.0 + ${glslFloat(CYCLONE_EYEWALL_PUFF_GROWTH)} * wall) *
      (${glslFloat(PUFF_SIZE_SEED_MIN)} +
       ${glslFloat(PUFF_SIZE_SEED_SPAN)} * fract(aSeed * ${glslFloat(SEED_HASH_PUFF_SIZE)}));`;

/**
 * BILLBOARD IN VIEW SPACE — faces the camera exactly, for free, with no
 * rotation written from the CPU and no chance of lagging it by a frame. The
 * same mechanism kit/puffDeck.ts's PUFF_BILLBOARD_GLSL states; written out here
 * because this one offsets an `mvPosition` three has already computed rather
 * than building its own.
 */
const SPIRAL_BILLBOARD = /* glsl */ `mvPosition.xy += position.xy * puffSize;
    gl_Position = projectionMatrix * mvPosition;`;

const SPIRAL_MASK = /* glsl */ `// SOLID AT THE EYEWALL, A SMEAR AT THE RIM — see CYCLONE_EYEWALL_SOFT_EDGE.
    // This is what makes the wall OCCLUDE rather than merely tint: a puff with
    // a flat core hides what is behind it, and a hundred puffs that are all
    // gradient average out into something the far coast shows through.
    float softEdge = mix(${glslFloat(CYCLONE_RIM_SOFT_EDGE)},
      ${glslFloat(CYCLONE_EYEWALL_SOFT_EDGE)}, vWall);
    ${puffMaskGlsl('softEdge')}

    // DARKEST AT THE EYEWALL, THINNING TO THE RIM — see CYCLONE_EYEWALL_SHADE.
    // A multiplier on the ALBEDO: the deck is lit, so the sun still moves
    // across it and the storm's own gloom still reaches it.
    diffuseColor.rgb *= mix(1.0, ${glslFloat(CYCLONE_EYEWALL_SHADE)}, vWall);

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
  /**
   * Puts the deck in front of or behind this plugin's rain for this frame, from
   * the camera's world Y — see SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE.
   *
   * ONE PROPERTY OF ONE MESH, asked once per frame for the whole plugin, and
   * the answer is the same for every storm under it. Called BEFORE anything is
   * submitted: the deck and the columns are composited in submission order, so
   * the order has to be settled before either goes in.
   */
  orderAgainstCamera(cameraWorldY: number): void;
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
  // The ordinary case, and never left to chance: a deck that was built and then
  // never told about the camera still draws over its rain rather than at
  // three's default 0, which would put it under the sea.
  mesh.renderOrder = SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE;
  mesh.frustumCulled = false;
  root.add(mesh);

  const arms = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const alongs = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const seeds = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const radii = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const rises = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  for (const attribute of [arms, alongs, seeds, radii, strengths, rises]) {
    attribute.setUsage(DynamicDrawUsage);
  }
  geometry.setAttribute('aArm', arms);
  geometry.setAttribute('aAlong', alongs);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aRadius', radii);
  geometry.setAttribute('aStrength', strengths);
  geometry.setAttribute('aRise', rises);

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
    const riseArray = rises.array as Float32Array;
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
        for (let i = 0; i < POSITIONS_PER_ARM; i++) {
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
          const along = alongAt(i);
          // THE STACK. A position carries as many puffs as the tower is tall
          // there, so the eyewall is dense as well as high and the rim is a
          // thin deck — see `tiersAt`. It is dealt HERE and not in the shader
          // because a vertex shader can vary a puff's place and never how many
          // there are; the numbers themselves depend on nothing the server
          // sends, so this is still layout work done per push and not per
          // frame.
          const tiers = tiersAt(along);
          const rise = tierRiseAt(along);
          for (let tier = 0; tier < tiers; tier++) {
            mesh.setMatrixAt(drawn, matrix);
            armArray[drawn] = arm / ARMS_PER_SPIRAL;
            alongArray[drawn] = along;
            const seed = (spiral.seed + drawn * GOLDEN_RATIO_CONJUGATE) % 1;
            seedArray[drawn] = seed;
            radiusArray[drawn] = spiral.radiusWorldUnits;
            strengthArray[drawn] = strength;
            // LIFTED, NEVER DROPPED — CYCLONE_TIER_JITTER_FRACTION states why
            // the jitter is one-sided, and it is what makes every puff centre
            // sit at or above the base plane exactly.
            riseArray[drawn] =
              tier * rise +
              seedHash(seed, SEED_HASH_TIER_JITTER) * rise * CYCLONE_TIER_JITTER_FRACTION;
            drawn++;
          }
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
    markUploaded(rises, drawn);
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

    orderAgainstCamera(cameraWorldY): void {
      mesh.renderOrder =
        cameraWorldY >= CYCLONE_DECK_BASE_WORLD_Y
          ? SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE
          : SPIRAL_RENDER_ORDER_CAMERA_BELOW_BASE;
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
