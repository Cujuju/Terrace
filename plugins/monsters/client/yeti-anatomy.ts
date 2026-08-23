// The yeti silhouette, as numbers. The sibling of ./anatomy.ts (Cthulhu's) and
// ./kraken-anatomy.ts, and it keeps their contract exactly:
//
//   * every dimension of the model lives here rather than inside the builder,
//     because the placement maths needs some of them and a node test can read
//     them without importing three (design §8 — no headless GL rig);
//   * UNITS are WORLD UNITS. HEIGHT_WORLD_SCALE maps one terrace band to one
//     world unit, so a number here is simultaneously world units across the
//     board and terrace bands of height. (It said "cells" until the 2026-08-21
//     re-sample cut a cell to a quarter of a world unit; the numbers never
//     moved, and cellsAcross() is what converts them for the server's half.)
//   * FRAME: the model faces +X. The origin is the PIVOT — and for this one that
//     is BETWEEN THE FEET, ON THE GROUND, because he is a walker: the client
//     places his origin at the terrain height under him, where the two swimmers
//     are hung from the sea surface (./placement.ts).
//
// REACHES ARE MEASURED FROM THE AXIS, always: an arm's "reach" is how far that
// point is from the model's vertical centre line, not how far it is from where
// the arm started. That is the only convention under which the footprint below
// can be checked by adding two numbers, which is what its test does.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT MAKES HIM NOT A THIRD SEA HORROR
//
// Cthulhu is a FIGURE, bilateral and hidden — 61% of him under the water at
// rest. The kraken is RADIAL and low-slung, a crown of arms lying on the sea.
// Both are things that rise out of somewhere you cannot follow them.
//
// The yeti is an ANIMAL, and every choice here says so. He is the only one whose
// whole body is visible, because he stands ON the ground rather than in it; he
// is by far the smallest and the narrowest — 1.575 world units tall and 1.25
// across, against the kraken's 8-by-7 and Cthulhu's 10.9-by-7 (owner decision,
// 2026-08-22; YETI_SCALE is the only place that quarter lives, and every figure
// in the prose below is stated at his ORIGINAL size, as the literals are);
// his mass is in his SHOULDERS and his silhouette is a hunched biped
// with arms that hang below his hips. He is white on white, so the modelling
// that has to work hardest is the SHADING — a snow-coloured mass in sunlight has
// no contrast of its own, which is why the shade variation here is the largest
// of the three creatures and why the ruff of brighter fur exists at all.
//
// At a hundred cells the three read as a standing man, a spider on the water,
// and an ape on a ridge. That is the distance the silhouettes have to hold at.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE SIZE OF THE ANIMAL, as a factor on every length below.
 *
 * Owner decision, 2026-08-22: a quarter of what he was. Every LENGTH in this
 * file is written at its original full-size figure and passed through
 * `scaled()`, so the whole silhouette record still reads in the proportions its
 * prose argues for and one number here is the animal's size. What that prose
 * calls "5 cells wide" and "6.3 tall" is now 1.25 and 1.575 world units — the
 * RATIOS it justifies are all unchanged, because a uniform scale preserves
 * every one of them.
 *
 * WHAT DOES NOT PASS THROUGH IT, and why each is right:
 *   * ANGLES and FRACTIONS (the swings, the lean, the head scan, the eye bulge,
 *     the tuft variation, the shade variation) are dimensionless — a scaled
 *     model rotates through the same angles.
 *   * The two spatial FREQUENCIES divide by it instead (`scaledFrequency`), so
 *     the same NUMBER of wrinkles runs across a body a quarter the size. The
 *     carve is sampled at position × frequency, so scaling the two inversely
 *     reproduces the old surface exactly, four times smaller.
 *   * YETI_AMBLE_HZ and YETI_LEG_SWING_RADIANS are RATIOS of scaled quantities
 *     (speed over stride, stride over leg) and fall out unchanged on their own.
 *     That is the whole reason his gait survives this: his stride shrinks with
 *     his legs and the server's walk speed shrinks with him, so his feet still
 *     travel at exactly the rate the ground passes under them.
 */
export const YETI_SCALE = 0.25;

/** A length, written at full size and delivered at the size he actually is. */
function scaled(fullSizeWorldUnits: number): number {
  return fullSizeWorldUnits * YETI_SCALE;
}

/**
 * A spatial frequency — cycles per world unit — written at full size. It scales
 * INVERSELY, so a feature keeps its size relative to the animal rather than its
 * size in the world. See YETI_SCALE.
 */
function scaledFrequency(fullSizeCyclesPerWorldUnit: number): number {
  return fullSizeCyclesPerWorldUnit / YETI_SCALE;
}

/**
 * Widest horizontal extent: how far the model may reach from its own vertical
 * axis, doubled.
 *
 * The same 1.25 world units — 5 cells — the SERVER knows as
 * YETI_FOOTPRINT_CELLS (server/kinds.ts), where it sets the steering look-ahead
 * so the body never walks into a cliff the centre point cleared, and from which
 * the minimum size of his snowfield is derived. The two are pinned to each other
 * by a test rather than by an import: the server half must not depend on the
 * client half (it runs in a process that never loads three), so the honest
 * arrangement is one number in each place plus a test that fails the day they
 * disagree. When YETI_SCALE moves, BOTH have to.
 *
 * THE BINDING CONSTRAINT IS A HAND, and it is only binding while he is MOVING:
 * static, the widest thing on him is a hand at 2.04 full-size units from the
 * axis, against the 2.5 half-footprint. The idle animation swings the arms
 * fore-and-aft and leans the upper body side to side, and the worst combination
 * of the two puts a hand 2.36 out. Both figures are pinned by tests — as
 * FRACTIONS of the half-footprint, so they survive a rescale and still fail on a
 * swing amplitude retuned for looks, which is exactly how a limb ends up inside
 * a cliff the server's probe said was clear.
 */
export const YETI_WIDTH_CELLS = scaled(5);

// ── The stance: feet, legs, hips ─────────────────────────────────────────────

/**
 * FEET: broad flat pads, and the only part of the model that touches the
 * ground.
 *
 * The centre height is exactly half the rise, so the SOLE sits exactly on the
 * origin plane — which is the plane the client places at the terrain height
 * under him. That relationship is the walker's equivalent of the two swimmers'
 * waterline bite, and it is why the feet are finished with the SMOOTH skin (no
 * carve): the stated extents of a carved surface are still bounds, but a dent in
 * the sole would lift the one surface the placement maths trusts to be flat.
 */
export const YETI_FOOT_LENGTH = scaled(1.2);
export const YETI_FOOT_RISE = scaled(0.42);
export const YETI_FOOT_WIDTH = scaled(0.8);
/** How far ahead of the ankle a foot's centre sits — he is a plantigrade. */
export const YETI_FOOT_FORWARD = scaled(0.16);
export const YETI_FOOT_CENTER_HEIGHT = YETI_FOOT_RISE / 2;

/**
 * Lateral offset of a hip, an ankle and therefore a foot, from the axis.
 *
 * 0.62 — a wide stance for a body this heavy, and narrow enough that the two
 * feet do not touch (their half-widths are 0.4, so there are 0.44 cells of
 * daylight between them).
 */
export const YETI_STANCE_HALF_WIDTH = scaled(0.62);

/**
 * LEGS: short and thick, and the reason the whole animal reads as heavy. The hip
 * sits at 39% of his total height, where a human's is at 52%: short legs under a
 * deep chest is the proportion that says "built for cold and for climbing".
 */
export const YETI_HIP_HEIGHT = scaled(2.45);
export const YETI_ANKLE_HEIGHT = scaled(0.38);
export const YETI_LEG_ROOT_RADIUS = scaled(0.52);
export const YETI_LEG_ANKLE_RADIUS = scaled(0.34);
/** The knee: a slight forward break, so a leg is a limb and not a post. */
export const YETI_KNEE_HEIGHT = scaled(1.35);
export const YETI_KNEE_FORWARD = scaled(0.18);
/** Straight-line hip-to-ankle distance — what the gait's swing is derived from. */
export const YETI_LEG_LENGTH = YETI_HIP_HEIGHT - YETI_ANKLE_HEIGHT;

/** HIPS: a mass of their own under the torso, so the waist is not a pinch. */
export const YETI_HIPS_CENTER_HEIGHT = scaled(2.6);
export const YETI_HIPS_LENGTH = scaled(1.9);
export const YETI_HIPS_HEIGHT = scaled(1.5);
export const YETI_HIPS_WIDTH = scaled(2.1);

// ── The mass: torso, shoulders ───────────────────────────────────────────────

/**
 * TORSO: a deep barrel, taller than it is long and longer than it is wide, so
 * the chest reads as a chest from the side AND from the front.
 */
export const YETI_TORSO_CENTER_HEIGHT = scaled(3.85);
export const YETI_TORSO_LENGTH = scaled(2.2);
export const YETI_TORSO_HEIGHT = scaled(2.9);
export const YETI_TORSO_WIDTH = scaled(2.5);
export const YETI_TORSO_TOP = YETI_TORSO_CENTER_HEIGHT + YETI_TORSO_HEIGHT / 2;

/**
 * SHOULDERS: two masses set high and wide on the torso — the widest solid part
 * of him, and the whole reason the head reads as small.
 *
 * They are what an ape's trapezius does to a silhouette: the neck disappears,
 * the head sits BETWEEN the shoulders rather than above them, and the animal
 * looks like it could pull a tree over.
 */
export const YETI_SHOULDER_HEIGHT = scaled(4.75);
export const YETI_SHOULDER_HALF_SPAN = scaled(1.18);
export const YETI_SHOULDER_LENGTH = scaled(1.5);
export const YETI_SHOULDER_RISE = scaled(1.3);
export const YETI_SHOULDER_WIDTH = scaled(1.5);

// ── The head ─────────────────────────────────────────────────────────────────

/**
 * HEAD: small for the body, carried low and forward between the shoulders. Its
 * top is the highest point on the model, which is what YETI_TOTAL_HEIGHT is.
 */
export const YETI_HEAD_CENTER_HEIGHT = scaled(5.55);
export const YETI_HEAD_LENGTH = scaled(1.6);
export const YETI_HEAD_HEIGHT = scaled(1.5);
export const YETI_HEAD_WIDTH = scaled(1.45);
export const YETI_HEAD_TOP = YETI_HEAD_CENTER_HEIGHT + YETI_HEAD_HEIGHT / 2;

/** BROW: a heavy ridge over the eyes. Without it the face is a snowball. */
export const YETI_BROW_FORWARD = scaled(0.52);
export const YETI_BROW_HEIGHT = scaled(5.78);
export const YETI_BROW_LENGTH = scaled(0.55);
export const YETI_BROW_RISE = scaled(0.34);
export const YETI_BROW_WIDTH = scaled(1.3);

/** MUZZLE: bare dark skin, pushed forward and DOWN under the brow. */
export const YETI_MUZZLE_FORWARD = scaled(0.72);
export const YETI_MUZZLE_HEIGHT = scaled(5.25);
export const YETI_MUZZLE_LENGTH = scaled(1);
export const YETI_MUZZLE_RISE = scaled(0.7);
export const YETI_MUZZLE_WIDTH = scaled(0.85);

/**
 * EYES: small, set deep under the brow, and the only part of him that emits.
 *
 * Proportionally TINY next to the kraken's lamps (0.14 against 0.42) and that is
 * the point: a lamp is a thing looking for you in the dark, a glint is a thing
 * that has already seen you. The emission is dim and cold rather than bright,
 * because the job it does is not illumination — it is that a white animal
 * against white snow at a hundred cells is a silhouette with nothing to fix the
 * eye on, and two dark sockets with a spark in them are where a player's
 * attention lands.
 */
export const YETI_EYE_RADIUS = scaled(0.14);
export const YETI_EYE_FORWARD = scaled(0.62);
export const YETI_EYE_HEIGHT = scaled(5.66);
export const YETI_EYE_OFFSET = scaled(0.35);
/** How far outside the skin an eye's centre sits, as a fraction of its radius. */
export const YETI_EYE_BULGE = 0.35;

// ── The arms ─────────────────────────────────────────────────────────────────

/**
 * ARMS: long, hanging well below the hips, and jointed at a shoulder set inside
 * the shoulder mass so no gap can open between limb and body.
 *
 * The hand ends at height 1.9 — below YETI_HIP_HEIGHT (2.45) — which is the one
 * proportion that makes a biped read as an APE rather than as a man in a suit.
 * Every reach below is stated from the AXIS, so the footprint test is a sum.
 */
export const YETI_SHOULDER_JOINT_HEIGHT = scaled(4.6);
export const YETI_SHOULDER_JOINT_HALF_SPAN = scaled(1.32);
/** Drop and flare of the elbow, from the shoulder joint. */
export const YETI_ARM_ELBOW_DROP = scaled(1.45);
export const YETI_ARM_ELBOW_FLARE = scaled(0.22);
export const YETI_ARM_ELBOW_FORWARD = scaled(0.1);
/** Drop and flare of the wrist, from the shoulder joint. */
export const YETI_ARM_HAND_DROP = scaled(2.7);
export const YETI_ARM_HAND_FLARE = scaled(0.3);
export const YETI_ARM_HAND_FORWARD = scaled(0.25);
export const YETI_ARM_ROOT_RADIUS = scaled(0.42);
export const YETI_ARM_TIP_RADIUS = scaled(0.3);
/** Height of a hand above the ground, and its distance from the axis. */
export const YETI_HAND_HEIGHT = YETI_SHOULDER_JOINT_HEIGHT - YETI_ARM_HAND_DROP;
export const YETI_HAND_REACH = YETI_SHOULDER_JOINT_HALF_SPAN + YETI_ARM_HAND_FLARE;
/** HANDS: bare skin, and big — a fist he walks on when the slope steepens. */
export const YETI_HAND_RADIUS = scaled(0.42);

// ── The ruff ─────────────────────────────────────────────────────────────────

/**
 * RUFF: a ring of fur tufts around the base of the neck, the brightest tone on
 * the animal.
 *
 * It is doing a specific job rather than decorating one: this creature is white
 * on white, so the thing that separates his head from his shoulders at any
 * distance is not a colour change (there is none available) but a BROKEN EDGE.
 * Seven tufts of a lighter tone, sticking out past the shoulder line, give the
 * silhouette a serrated collar that reads long after the face has stopped
 * resolving.
 *
 * Seven, and odd on purpose: one tuft lies on the centre line front and back, so
 * the collar is symmetric about the direction he faces rather than parted down
 * it. (Cthulhu's face tentacles are odd for exactly the same reason; the
 * kraken's limb ring is even for the opposite one.)
 */
export const YETI_RUFF_TUFT_COUNT = 7;
export const YETI_RUFF_RING_RADIUS = scaled(0.75);
export const YETI_RUFF_RING_HEIGHT = scaled(5);
/** How far out and how far down a tuft reaches, from its root on the ring. */
export const YETI_RUFF_TUFT_REACH = scaled(1.1);
export const YETI_RUFF_TUFT_DROP = scaled(0.85);
/** Where the tuft's midpoint sits, as a fraction of reach and drop. */
export const YETI_RUFF_TUFT_MID_REACH = 0.45;
export const YETI_RUFF_TUFT_MID_DROP = 0.25;
export const YETI_RUFF_TUFT_RADIUS = scaled(0.22);
export const YETI_RUFF_TUFT_TIP_RADIUS = scaled(0.04);
/**
 * Per-tuft length variation, as a fraction, and it only ever SHORTENS — the same
 * contract the kraken's arms keep, for the same reason: YETI_WIDTH_CELLS is a
 * bound the server steers by, so a variation that could lengthen a tuft would
 * make the stated footprint a claim the geometry exceeds.
 */
export const YETI_RUFF_LENGTH_VARIATION = 0.25;
/** How far the ruff reaches from the axis at full length. */
export const YETI_RUFF_REACH = YETI_RUFF_RING_RADIUS + YETI_RUFF_TUFT_REACH;

// ── The whole ────────────────────────────────────────────────────────────────

/**
 * Total modelled height, ground to the crown of the head — 1.575 world units at
 * YETI_SCALE (6.3 at full size), against the kraken's 8 and Cthulhu's 10.9, and
 * still taller than he is wide.
 *
 * He is the SMALLEST of the three by a wide margin and the only one you see all
 * of. What a player can measure him against is the wildlife grazer that shares
 * his hillside, a quarter of a world unit long, and he still stands six times
 * that — the ruler that matters survived the rescale, because the grazer is the
 * only thing standing next to him.
 */
export const YETI_TOTAL_HEIGHT = YETI_HEAD_TOP;

/**
 * Half-extent of the ground his FEET cover, in WORLD UNITS — what the client
 * samples terrain over to decide which band he stands on (./placement.ts).
 *
 * IT WAS NAMED `..._CELLS` AND IT WAS NOT CELLS. Everything in this file has
 * been world units since the 2026-08-21 re-sample cut a cell to a quarter of
 * one, and ./placement.ts adds this straight to a CELL coordinate — so the
 * walker sampled a quarter of the ground his feet actually cover, and a foot
 * could overhang a riser he then stood below. The conversion belongs at that
 * boundary and now happens there (`cellsAcross`, the one conversion every
 * physical distance in this codebase is supposed to go through); the name here
 * says which side of it this number is on, which is the part that let the bug
 * hide for a day.
 *
 * DERIVED from the stance and the foot, not chosen: the outer edge of a foot is
 * exactly the stance offset plus half a foot's width, 1.02 full-size units. It
 * is the FEET and not the body, and that distinction is the whole content of the
 * number: a walker stands on what it steps on. Sampling the shoulders instead
 * (1.93) would have him ride up onto every band his elbow overhangs.
 *
 * The fore-and-aft extent is smaller (0.76), so the square this describes
 * is a slight over-estimate in that axis — deliberately, because the failure it
 * guards against is a body clipping a riser and the safe direction to err in is
 * standing a fraction too high.
 */
export const YETI_FOOT_GROUND_HALF_EXTENT = YETI_STANCE_HALF_WIDTH + YETI_FOOT_WIDTH / 2;

// ── Colour ───────────────────────────────────────────────────────────────────

/**
 * Snow tones, and they are chosen against the TERRAIN he stands on rather than
 * against each other: the client's palette draws band 9 and above as 0xf2f4f6,
 * a near-white. An animal painted the same value would vanish into it.
 *
 * So the fur sits a step DARKER than the snow (0xe4ebf2 against 0xf2f4f6) and
 * the shaded parts — belly, limbs — a long way darker still, which is what makes
 * him a shape rather than a hole in the ground. The RUFF is the one tone lighter
 * than the fur, so the collar catches the sun where everything else falls away.
 * Cross-referenced against the palette and not imported, for the reason the snow
 * line itself is (server/habitat.ts).
 */
export const YETI_FUR_COLOR = 0xe4ebf2;
export const YETI_UNDERFUR_COLOR = 0xb6c2d1;
export const YETI_RUFF_COLOR = 0xf2f5f8;
/** Bare skin: muzzle, hands, feet. Dark slate — the only mass that is not white. */
export const YETI_SKIN_COLOR = 0x4b4a52;
/** The eye's own dark shell, so it is a socket and not a floating dot. */
export const YETI_EYE_COLOR = 0x14161c;
/** A cold glint. Deliberately dim — see YETI_EYE_RADIUS. */
export const YETI_EYE_EMISSIVE = 0x2e5570;

/**
 * SKIN DETAIL. Same fields as the other two anatomies and the same inward-only
 * rule: the carve may never push a vertex outward, or YETI_TOTAL_HEIGHT and
 * YETI_WIDTH_CELLS stop being bounds.
 *
 * The carve is DEEPER and much higher-frequency than either sea creature's
 * RELATIVE TO THE BODY IT IS ON — 0.12 at 2.6 cycles per unit on a 6.3-unit
 * animal, against the kraken's 0.07 at 1.4 on an 8-unit one. Relative is the
 * only fair comparison, and now the only one a test can make: YETI_SCALE takes
 * the depth to 0.03 and the frequency to 10.4, which is the SAME surface four
 * times smaller. That is the
 * difference between skin and FUR: skin is a smooth surface with wrinkles in it,
 * fur is a surface that is broken everywhere, and the only tool this workshop
 * has for that is a fine, deep carve. The shade variation is the largest of the
 * three for the reason at the top of this file — a white mass in sunlight has no
 * contrast of its own, and ±22% is what stops him reading as a paper cut-out.
 */
export const YETI_FUR_WRINKLE_DEPTH = scaled(0.12);
export const YETI_SKIN_WRINKLE_DEPTH = scaled(0.04);
export const YETI_WRINKLE_FREQUENCY = scaledFrequency(2.6);
export const YETI_SHADE_VARIATION = 0.22;
export const YETI_SHADE_FREQUENCY = scaledFrequency(0.9);

// ── The gait ─────────────────────────────────────────────────────────────────

/**
 * The server's amble speed, restated (server/kinds.ts,
 * YETI_AMBLE_SPEED_CELLS_PER_SECOND) and pinned to it by a test.
 *
 * IT GOES THROUGH YETI_SCALE, because a speed is a LENGTH per second (owner
 * decision, 2026-08-22): a quarter-size animal that kept the full-size 0.45
 * would cross its own body four times as fast as it used to, which is what
 * scurrying looks like. At 0.1125 he covers his own width in the same eleven
 * seconds he always did, and is still slower than the grazer he shares the
 * hillside with — the two comparisons that justified 0.45 in the first place.
 *
 * It is here because the GAIT IS DERIVED FROM IT: a walk animation whose stride
 * rate has nothing to do with how fast the thing actually travels is the
 * skating-feet bug, and the only way to not have it is for the two numbers to be
 * related on purpose. Restated rather than imported for the usual reason — the
 * client half must not pull the server half into its bundle.
 */
export const YETI_AMBLE_SPEED_CELLS_PER_SECOND = scaled(0.45);

/**
 * Ground covered by one full gait cycle (two steps), in cells.
 *
 * 1.6 — two steps of 0.8, which is 39% of his 2.07-unit leg. That is a walk:
 * humans stride about half a leg length, and a heavy short-legged animal picking
 * its way over snow takes shorter steps than that.
 *
 * Both figures are FULL SIZE and both go through YETI_SCALE, so the 39% — the
 * only part of this that is a gait decision rather than a dimension — is what
 * actually survives. YETI_AMBLE_HZ and YETI_LEG_SWING_RADIANS below are ratios
 * of scaled quantities and come out identical at any scale.
 */
export const YETI_STRIDE_CELLS = scaled(1.6);

/**
 * Gait cycles per second, DERIVED: speed over stride length. 0.28 Hz — a
 * three-and-a-half-second cycle — so his feet travel at exactly the rate the
 * server moves him and never skate.
 */
export const YETI_AMBLE_HZ = YETI_AMBLE_SPEED_CELLS_PER_SECOND / YETI_STRIDE_CELLS;

/**
 * Peak swing of a leg either side of vertical, in radians. DERIVED from the
 * stride: half a step of 0.8 cells is 0.4 cells of foot travel each way, over a
 * 2.07-cell leg, so the angle is asin(0.4 / 2.07) = 0.195 rad ≈ 11°.
 *
 * WHY THE ANIMATION PLAYS EVEN WHEN HE IS STANDING STILL. The wire carries no
 * gait flag — deliberately, see protocol.ts, "the client can SEE that the thing
 * is not moving" — so this cycle runs off elapsed time whatever he is doing. At
 * 11° and 0.28 Hz that reads as an animal shifting its weight from foot to foot
 * when stationary and as a walk when he is travelling, which is the honest best
 * a gait with no gait signal can do. A stride amplitude tuned for a convincing
 * WALK (25–30°, as a human's is) would have made a stationary yeti look like he
 * was marching on the spot.
 */
export const YETI_LEG_SWING_RADIANS = Math.asin(
  YETI_STRIDE_CELLS / 2 / 2 / YETI_LEG_LENGTH,
);

/**
 * Arm swing, as a fraction of the leg's. Arms swing opposite the leg on the same
 * side — that is what a contralateral gait is — and less far, because his are
 * heavy and hang from a shoulder that is doing most of the work of holding him
 * up. 0.7 is enough that the counter-swing is legible at a distance.
 */
export const YETI_ARM_SWING_FRACTION = 0.7;
export const YETI_ARM_SWING_RADIANS = YETI_LEG_SWING_RADIANS * YETI_ARM_SWING_FRACTION;

/**
 * Side-to-side lean of the upper body, in radians. ~3°, one lean per gait cycle,
 * a quarter-cycle behind the legs so he leans over the foot that is planted.
 *
 * IT IS APPLIED TO THE UPPER BODY ONLY — never to the whole model — and that is
 * a placement decision rather than an anatomical one: rolling the rig would take
 * the outer foot 0.05 cells below the ground plane the client just placed him
 * on, every cycle, forever. Nothing above the hips can intersect terrain, so the
 * lean is free there.
 */
export const YETI_LEAN_RADIANS = 0.05;

/**
 * Vertical bob of the whole body, in cells: one per STEP, so twice per gait
 * cycle.
 *
 * IT ONLY EVER LIFTS. The same inward-only discipline the wrinkle carve keeps,
 * for the same reason at the other end of the model: the client puts his origin
 * exactly on the ground, so a bob that went negative would sink his feet into
 * the snow half of every step. Written as (1 - cos)/2, which is 0 at rest and
 * never below it.
 */
export const YETI_BOB_CELLS = scaled(0.06);

/**
 * The head scans: a slow yaw either side of forward, at its own unrelated rate.
 *
 * 0.09 Hz is an eleven-second sweep — nothing like the gait, and deliberately
 * not a multiple of it, so the two never lock into a pattern a player can feel
 * repeating. ±0.14 rad (8°) is a look, not a search.
 */
export const YETI_HEAD_SCAN_HZ = 0.09;
export const YETI_HEAD_SCAN_RADIANS = 0.14;
