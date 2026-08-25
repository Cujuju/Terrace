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
// is by far the smallest and the narrowest — 1.24 world units tall and 0.90
// across, against the kraken's 8-by-7 and Cthulhu's 10.9-by-7 (owner decisions,
// 2026-08-22 and 2026-08-24; YETI_SCALE is the only place that size lives, and
// every figure in the prose below is stated at his ORIGINAL size, as the
// literals are);
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
 * A PEEP'S OVERALL HEIGHT, world units — the ruler the owner measures this
 * animal against.
 *
 * It is PILGRIM_HEIGHT (plugins/pilgrims/client/models.ts), RESTATED rather
 * than imported, for the same reason the server's half of every monster
 * constant is restated: a monster must not pull another plugin's model module
 * into its bundle to learn one number. A test fails the day the two disagree.
 */
export const PEEP_HEIGHT_WORLD_UNITS = 0.62;

/**
 * How many peeps tall he is allowed to be. OWNER CEILING, 2026-08-24: "no more
 * than two times taller than one of the peeps", and YETI_SCALE below is solved
 * for it rather than guessed at, so the rule is in the code and not in a
 * comment. He is taken to the ceiling exactly — he is still the mountain's
 * monster and the biggest thing a settlement will meet on foot.
 */
const YETI_HEIGHT_IN_PEEPS = 2;

/**
 * The FULL-SIZE figures the scale is solved against — every length in this file
 * is written at full size and passed through `scaled()`, so the solve has to
 * happen up here, before the scale exists.
 *
 * THE HIGHEST POINT ON HIM IS A HORN TIP, not the crown of his head (owner,
 * 2026-08-24: "he needs horns"). That is the whole reason these five constants
 * are hoisted above YETI_SCALE and the horn section below re-uses them rather
 * than restating them: the ceiling the owner set is on the ANIMAL, and an
 * animal's height is the top of whatever sticks up furthest. Solving against
 * the skull and then planting horns above it would have quietly put him at two
 * and a third peeps — which is precisely the failure the solve exists to make
 * impossible.
 *
 * DERIVED, not restated: the total is built from the head and horn figures that
 * actually define it, so a literal 6.88 can never drift out of step with the
 * geometry. The tip RADIUS is in it because a horn is a tube, not a line — its
 * apex is half a hair above the centre-line point the curve ends on.
 */
const FULL_SIZE_HEAD_CENTER_HEIGHT = 5.55;
const FULL_SIZE_HEAD_HEIGHT = 1.5;
const FULL_SIZE_HEAD_TOP = FULL_SIZE_HEAD_CENTER_HEIGHT + FULL_SIZE_HEAD_HEIGHT / 2;
const FULL_SIZE_HORN_TIP_HEIGHT = 6.85;
const FULL_SIZE_HORN_TIP_RADIUS = 0.03;
const FULL_SIZE_TOTAL_HEIGHT = FULL_SIZE_HORN_TIP_HEIGHT + FULL_SIZE_HORN_TIP_RADIUS;

/**
 * THE SIZE OF THE ANIMAL, as a factor on every length below.
 *
 * SOLVED, not chosen: it is whatever puts the top of him — a horn tip — exactly
 * on YETI_HEIGHT_IN_PEEPS peeps. 0.1802, down from the 0.25 of the 2026-08-22
 * quarter-size decision, which stood him at 1.575 world units, two and a half
 * peeps. He is now 1.24 to the horns and 1.135 to the crown of his head.
 *
 * Every LENGTH in this file is written at its original full-size figure and
 * passed through `scaled()`, so the whole silhouette record still reads in the
 * proportions its prose argues for and one number here is the animal's size.
 * What that prose calls "5 cells wide" and "6.3 tall" is now 0.90 and 1.135
 * world units — the RATIOS it justifies are all unchanged, because a uniform
 * scale preserves every one of them.
 *
 * WHAT DOES NOT PASS THROUGH IT, and why each is right:
 *   * ANGLES and FRACTIONS (the swings, the lean, the head scan, the eye bulge,
 *     the tuft variation, the shade variation) are dimensionless — a scaled
 *     model rotates through the same angles.
 *   * The two spatial FREQUENCIES divide by it instead (`scaledFrequency`), so
 *     the same NUMBER of wrinkles runs across a body a fifth the size. The
 *     carve is sampled at position × frequency, so scaling the two inversely
 *     reproduces the old surface exactly, smaller.
 *   * YETI_AMBLE_HZ and YETI_LEG_SWING_RADIANS are RATIOS of scaled quantities
 *     (speed over stride, stride over leg) and fall out unchanged on their own.
 *     That is the whole reason his gait survives this: his stride shrinks with
 *     his legs and the server's walk speed shrinks with him, so his feet still
 *     travel at exactly the rate the ground passes under them.
 *
 * WHEN THIS MOVES, THE SERVER MOVES WITH IT. YETI_FOOTPRINT_CELLS and
 * YETI_AMBLE_SPEED_CELLS_PER_SECOND (server/kinds.ts) are this scale's shadow
 * on the other side of the wire, restated as world-unit literals and pinned to
 * these by tests.
 */
export const YETI_SCALE =
  (PEEP_HEIGHT_WORLD_UNITS * YETI_HEIGHT_IN_PEEPS) / FULL_SIZE_TOTAL_HEIGHT;

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
 * The same 0.901 world units — 3.6 cells — the SERVER knows as
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
 * BELLY: a low, forward swell hung under the front of the chest.
 *
 * A barrel torso and a hip mass with nothing between them gives him a waist he
 * should not have — the one place the old silhouette read as two balls stacked
 * rather than as one animal. This fills the front of that gap and only the
 * front: it is offset forward, so it deepens the CHEST LINE seen from the side
 * without widening him seen from the front, which is the axis the footprint
 * bound lives on.
 */
export const YETI_BELLY_FORWARD = scaled(0.34);
export const YETI_BELLY_HEIGHT = scaled(3.25);
export const YETI_BELLY_LENGTH = scaled(2);
export const YETI_BELLY_RISE = scaled(1.7);
export const YETI_BELLY_WIDTH = scaled(2.2);

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
export const YETI_HEAD_CENTER_HEIGHT = scaled(FULL_SIZE_HEAD_CENTER_HEIGHT);
export const YETI_HEAD_LENGTH = scaled(1.6);
export const YETI_HEAD_HEIGHT = scaled(FULL_SIZE_HEAD_HEIGHT);
export const YETI_HEAD_WIDTH = scaled(1.45);
export const YETI_HEAD_TOP = YETI_HEAD_CENTER_HEIGHT + YETI_HEAD_HEIGHT / 2;

/** BROW: a heavy ridge over the eyes. Without it the face is a snowball. */
export const YETI_BROW_FORWARD = scaled(0.52);
export const YETI_BROW_HEIGHT = scaled(5.78);
export const YETI_BROW_LENGTH = scaled(0.55);
export const YETI_BROW_RISE = scaled(0.34);
export const YETI_BROW_WIDTH = scaled(1.3);

// ── The face ─────────────────────────────────────────────────────────────────
//
// REBUILT 2026-08-24, owner: "fix the mouth — it looks more like a walrus with
// fangs than a snow creature".
//
// THE WALRUS WAS THE COLOUR, NOT THE SHAPE. The whole snout used to be one
// ellipsoid of YETI_SKIN_COLOR — a single dark blob the width of the head with
// two tusks under it, which is a walrus however it is proportioned. A snow ape's
// face is FURRED; the only bare skin on it is a nose pad and the inside of the
// mouth. So the muzzle below is fur now, and the dark is spent on two small
// features instead of one large one.
//
// AND THE FACE HAS PARTS. A muzzle alone cannot read as a face at any distance:
// what makes one is the relationship between a brow, a cheek, a nose and a jaw.
// Each is a small mass here, all of them merged into the head's one surface so
// the fur field runs across the whole face and none of them costs a draw call.

/** MUZZLE: furred, pushed forward and DOWN under the brow. Shorter and narrower
 *  than the blob it replaces — the length is in the JAW below it now. */
export const YETI_MUZZLE_FORWARD = scaled(0.66);
export const YETI_MUZZLE_HEIGHT = scaled(5.36);
export const YETI_MUZZLE_LENGTH = scaled(0.9);
export const YETI_MUZZLE_RISE = scaled(0.58);
export const YETI_MUZZLE_WIDTH = scaled(0.78);

/** NOSE PAD: bare skin, and now the ONLY dark mass on the upper face. Proud of
 *  the muzzle's front so it catches its own highlight. */
export const YETI_NOSE_FORWARD = scaled(1.02);
export const YETI_NOSE_HEIGHT = scaled(5.46);
export const YETI_NOSE_LENGTH = scaled(0.3);
export const YETI_NOSE_RISE = scaled(0.24);
export const YETI_NOSE_WIDTH = scaled(0.36);

/**
 * MOUTH: a dark slot between the muzzle and the jaw — wide, and almost flat.
 *
 * It is the feature that does the most work for the least geometry. A gap
 * between two pale masses is a shadow a viewer has to guess at; a dark mass
 * filling that gap is a MOUTH, and it is what the fangs hang out of rather than
 * out of the middle of a snout.
 */
export const YETI_MOUTH_FORWARD = scaled(0.78);
export const YETI_MOUTH_HEIGHT = scaled(5.03);
export const YETI_MOUTH_LENGTH = scaled(0.8);
export const YETI_MOUTH_RISE = scaled(0.13);
export const YETI_MOUTH_WIDTH = scaled(0.7);

/**
 * JAW: a furred lower jaw, set BACK from the muzzle's front.
 *
 * The recession is the point and it is an ape's, not a man's: the upper lip
 * overhangs the chin, which is what puts the fangs in front of the jaw where
 * they can be seen instead of inside it where they cannot.
 */
export const YETI_JAW_FORWARD = scaled(0.56);
export const YETI_JAW_HEIGHT = scaled(4.88);
export const YETI_JAW_LENGTH = scaled(0.86);
export const YETI_JAW_RISE = scaled(0.44);
export const YETI_JAW_WIDTH = scaled(0.7);

/** CHEEKS: a pair of pads under the eyes. Without them the face is a snout
 *  stuck on a sphere; with them the eye sits in something. */
export const YETI_CHEEK_FORWARD = scaled(0.44);
export const YETI_CHEEK_HEIGHT = scaled(5.4);
export const YETI_CHEEK_OFFSET = scaled(0.42);
export const YETI_CHEEK_LENGTH = scaled(0.52);
export const YETI_CHEEK_RISE = scaled(0.44);
export const YETI_CHEEK_WIDTH = scaled(0.38);

/** EARS: small and set low and back, half-buried in the fur. A cold-climate
 *  animal has small ears; big ones would also fight the horns for the skyline. */
export const YETI_EAR_FORWARD = scaled(-0.12);
export const YETI_EAR_HEIGHT = scaled(5.6);
export const YETI_EAR_OFFSET = scaled(0.64);
export const YETI_EAR_LENGTH = scaled(0.24);
export const YETI_EAR_RISE = scaled(0.44);
export const YETI_EAR_WIDTH = scaled(0.2);

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
export const YETI_EYE_RADIUS = scaled(0.16);
export const YETI_EYE_FORWARD = scaled(0.62);
export const YETI_EYE_HEIGHT = scaled(5.66);
export const YETI_EYE_OFFSET = scaled(0.35);
/** How far outside the skin an eye's centre sits, as a fraction of its radius. */
export const YETI_EYE_BULGE = 0.35;

// ── The horns ────────────────────────────────────────────────────────────────

/**
 * HORNS: a swept pair rising off the brow ridge, back and out, tapering to a
 * point. Owner request, 2026-08-24 — "he needs fangs and he needs horns".
 *
 * THEY ARE THE TOP OF HIM, and the file is built around that fact: the tip
 * height and tip radius are hoisted to the top of this file so YETI_SCALE can be
 * solved against them (see FULL_SIZE_TOTAL_HEIGHT). Horns added under a scale
 * solved for the skull would have broken the owner's ceiling by a third of a
 * peep, silently, with every number in the file still looking right.
 *
 * WHY SWEPT BACK AND NOT UP. Straight vertical horns on a hunched biped read as
 * a costume; the animal's whole line is forward-and-down, from the shoulder mass
 * through the low-carried head, and a horn that continues that line past the
 * skull extends the silhouette instead of contradicting it. The curve also puts
 * the widest part of the horn — YETI_HORN_MID_OFFSET, out past the ears — where
 * a viewer looking at him head-on can see BOTH horns clear of the skull, which a
 * back-swept pair in the sagittal plane would not do.
 *
 * HOW THEY ARE STITCHED ON, and it took two goes. The first pair started just
 * under the skin at 0.96 of the head ellipsoid's radius, which is enough that no
 * GAP can open — and it still read as two objects inserted into a ball (owner,
 * 2026-08-24: "I don't think they're physically stitched to the head"). A tube
 * that pushes through a surface without disturbing it is exactly what an
 * inserted prop looks like; a real horn grows out of a PEDICLE, a swelling of
 * the skull that the horn is the continuation of.
 *
 * So there are three things holding it on now, and each does a different job:
 *   * the BOSS below — a fur-covered lump merged into the head's own surface, so
 *     the skull bulges up to meet the horn instead of being pierced by it;
 *   * a root sunk to the CENTRE of that boss rather than to just under the skin,
 *     so the tube's opening is buried in solid geometry from every angle;
 *   * an EMERGENCE point between root and mid, wide and close to the boss, which
 *     makes the horn leave the head thick and flare into the taper instead of
 *     starting at its final thickness the moment it clears the fur.
 *
 * Every figure is stated FULL SIZE from the axis, as everything in this file is.
 */
export const YETI_HORN_BOSS_FORWARD = scaled(0.3);
export const YETI_HORN_BOSS_HEIGHT = scaled(5.86);
export const YETI_HORN_BOSS_OFFSET = scaled(0.54);
export const YETI_HORN_BOSS_LENGTH = scaled(0.58);
export const YETI_HORN_BOSS_RISE = scaled(0.34);
export const YETI_HORN_BOSS_WIDTH = scaled(0.56);
export const YETI_HORN_ROOT_FORWARD = scaled(0.32);
export const YETI_HORN_ROOT_HEIGHT = scaled(5.76);
export const YETI_HORN_ROOT_OFFSET = scaled(0.5);
export const YETI_HORN_EMERGE_FORWARD = scaled(0.22);
export const YETI_HORN_EMERGE_HEIGHT = scaled(6.06);
export const YETI_HORN_EMERGE_OFFSET = scaled(0.66);
export const YETI_HORN_MID_FORWARD = scaled(-0.15);
export const YETI_HORN_MID_HEIGHT = scaled(6.45);
export const YETI_HORN_MID_OFFSET = scaled(0.92);
export const YETI_HORN_TIP_FORWARD = scaled(-0.62);
export const YETI_HORN_TIP_HEIGHT = scaled(FULL_SIZE_HORN_TIP_HEIGHT);
export const YETI_HORN_TIP_OFFSET = scaled(0.8);
export const YETI_HORN_ROOT_RADIUS = scaled(0.29);
/** Radius where the horn clears the boss — still fat, already tapering. */
export const YETI_HORN_EMERGE_RADIUS = scaled(0.22);
export const YETI_HORN_TIP_RADIUS = scaled(FULL_SIZE_HORN_TIP_RADIUS);
/** How far from the axis the horns reach at their widest — a bound, like the ruff's. */
export const YETI_HORN_REACH = YETI_HORN_MID_OFFSET;
/**
 * Weathered horn: a warm dark brown-grey.
 *
 * It is the SECOND dark mass on a white animal, after the bare skin, and it is
 * deliberately not the same one. The muzzle, hands and feet are cold slate
 * (YETI_SKIN_COLOR); horn is keratin and reads warm, and the two darks sitting
 * next to each other on the same head are what stop the face becoming one black
 * smudge at the distance the silhouette has to hold at.
 */
export const YETI_HORN_COLOR = 0x6e5d4b;

// ── The fangs ────────────────────────────────────────────────────────────────

/**
 * FANGS: a pair of upper canines hanging out of the MOUTH. Owner request,
 * 2026-08-24; shortened and moved the same day, with the mouth rebuild.
 *
 * THE FIRST PAIR WERE TUSKS. They were rooted in the middle of the old dark
 * snout and dropped 0.4 units clear of it, which — next to a snout that was one
 * dark blob — is a walrus and was called one. These are half that length, they
 * root in YETI_MOUTH (the dark slot between muzzle and jaw), and they hang in
 * front of the RECEDING chin rather than beside it. That is a canine showing
 * over a lip, which is the thing a fanged animal actually looks like.
 *
 * THEY ROOT ABOVE THE MOUTH AND END BELOW IT, which is not where a tooth grows
 * from but is what makes one visible. Rooted inside the dark slot, they were
 * invisible from any camera above the horizon — the muzzle overhangs them and
 * dark-on-dark hides the rest. Crossing the slot instead puts ivory against the
 * one black band on the face, and the eye finds it from any angle.
 *
 * IVORY ON DARK, which is why they read at all. Everything pale on this animal
 * is pale-on-pale — white fur against white snow — and needs a broken edge to
 * carry. The fangs are the exception: they hang off the darkest mass on him, so
 * their contrast is the highest anywhere on the model.
 */
export const YETI_FANG_ROOT_FORWARD = scaled(0.84);
export const YETI_FANG_ROOT_HEIGHT = scaled(5.22);
export const YETI_FANG_ROOT_OFFSET = scaled(0.26);
export const YETI_FANG_MID_FORWARD = scaled(0.94);
export const YETI_FANG_MID_HEIGHT = scaled(4.95);
export const YETI_FANG_MID_OFFSET = scaled(0.28);
export const YETI_FANG_TIP_FORWARD = scaled(1.02);
export const YETI_FANG_TIP_HEIGHT = scaled(4.62);
export const YETI_FANG_TIP_OFFSET = scaled(0.3);
export const YETI_FANG_ROOT_RADIUS = scaled(0.11);
export const YETI_FANG_TIP_RADIUS = scaled(0.01);
/** Old ivory — bone that has been out in the weather, not a dentist's white. */
export const YETI_FANG_COLOR = 0xf6f1e2;

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

/**
 * FINGERS AND TOES: three short tapered digits on each hand and each foot.
 *
 * Added 2026-08-24 with the resolution pass (owner: "it does not need to look
 * simple"). THREE, not five: at this size five digits on a 0.42-radius fist
 * merge into a fringe, and three separated by a real gap is what still reads as
 * a hand rather than as a lumpy ball. The same count on the feet, for the same
 * reason and so the two ends of him match.
 *
 * They are authored in the HAND's and the FOOT's own space and merged into those
 * geometries, so they cost no draw call and no joint — they do not articulate,
 * which is honest: nothing in the gait would drive them.
 *
 * THE TOE LENGTH IS BOUNDED, and by something real. The client samples the
 * ground under him over YETI_FOOT_GROUND_HALF_EXTENT (1.02 from the axis), and
 * a toe that reached past that would put part of a foot outside the square the
 * placement maths measured. 0.90 plus a 0.10 tip is exactly 1.00.
 */
export const YETI_DIGIT_COUNT = 3;
/** Lateral spacing between digit centres, on the hand and on the foot. */
export const YETI_DIGIT_SPACING = scaled(0.2);
export const YETI_FINGER_ROOT_FORWARD = scaled(0.1);
export const YETI_FINGER_ROOT_HEIGHT = scaled(-0.16);
export const YETI_FINGER_TIP_FORWARD = scaled(0.3);
export const YETI_FINGER_TIP_HEIGHT = scaled(-0.56);
export const YETI_FINGER_ROOT_RADIUS = scaled(0.14);
export const YETI_FINGER_TIP_RADIUS = scaled(0.08);
export const YETI_TOE_ROOT_FORWARD = scaled(0.5);
export const YETI_TOE_TIP_FORWARD = scaled(0.9);
export const YETI_TOE_ROOT_RADIUS = scaled(0.15);
export const YETI_TOE_TIP_RADIUS = scaled(0.1);

// ── The mantle ───────────────────────────────────────────────────────────────

/**
 * MANTLE: a shaggy fur collar lying over the shoulders, in the brightest tone on
 * the animal.
 *
 * IT REPLACES THE RUFF, 2026-08-24, owner: "I don't know what the spikes around
 * the neck are supposed to be. Get rid of those." They were seven long thin
 * tufts radiating from a ring — 1.1 units of reach on a 0.22 radius — and at
 * that aspect ratio a tube is a SPINE, whatever the comment above it calls it.
 * Once the animal had real fangs they were worse than ineffective: he appeared
 * to have tusks growing out of his shoulders.
 *
 * WHAT SURVIVES IS THE JOB, WHICH IS REAL. This creature is white on white, so
 * the thing that separates his head from his shoulders at any distance is not a
 * colour change (there is none available) but a BROKEN EDGE. So the collar is
 * still a ring of separate pieces in a lighter tone — and every number about
 * them is inverted: they are FAT rather than thin (0.34 against 0.22 on a body a
 * fifth the size), SHORT rather than long, and they hang DOWN the shoulder
 * nearly twice as far as they reach out from it. A lock of fur is a thing whose
 * thickness is a large fraction of its length; that ratio is the entire
 * difference between a mane and a hedgehog, and it is the only thing that had to
 * change.
 *
 * THIRTEEN, and odd for the reason the seven were: one lock lies on the centre
 * line front and back, so the collar is symmetric about the direction he faces
 * rather than parted down it. The count went up from nine on eyes-on evidence —
 * at nine, a low camera looking up at him saw the locks END-ON and separated,
 * and separated cones on a shoulder are the spikes again by another route. They
 * have to OVERLAP from every angle to read as one shaggy edge, and the tip is
 * blunt (two thirds of the root radius) for the same reason.
 */
export const YETI_MANTLE_LOCK_COUNT = 13;
export const YETI_MANTLE_RING_RADIUS = scaled(1.05);
export const YETI_MANTLE_RING_HEIGHT = scaled(5.25);
/** How far out and how far down a lock reaches, from its root on the ring. */
export const YETI_MANTLE_LOCK_REACH = scaled(0.52);
export const YETI_MANTLE_LOCK_DROP = scaled(1.15);
/** Where the lock's midpoint sits, as a fraction of reach and drop — biased
 *  OUT then DOWN, so the lock lies over the shoulder before it falls off it. */
export const YETI_MANTLE_LOCK_MID_REACH = 0.7;
export const YETI_MANTLE_LOCK_MID_DROP = 0.35;
export const YETI_MANTLE_LOCK_RADIUS = scaled(0.36);
export const YETI_MANTLE_LOCK_TIP_RADIUS = scaled(0.27);
/**
 * Per-lock length variation, as a fraction, and it only ever SHORTENS — the same
 * contract the old ruff kept, for the same reason: YETI_WIDTH_CELLS is a bound
 * the server steers by, so a variation that could lengthen a lock would make the
 * stated footprint a claim the geometry exceeds.
 */
export const YETI_MANTLE_LENGTH_VARIATION = 0.22;
/** How far the mantle reaches from the axis at full length, tip included. */
export const YETI_MANTLE_REACH =
  YETI_MANTLE_RING_RADIUS + YETI_MANTLE_LOCK_REACH + YETI_MANTLE_LOCK_RADIUS;

// ── The whole ────────────────────────────────────────────────────────────────

/**
 * Total modelled height, ground to the highest point on him — 1.24 world units,
 * against the kraken's 8 and Cthulhu's 10.9, and still taller than he is wide.
 *
 * THE HIGHEST POINT IS A HORN TIP, not YETI_HEAD_TOP, which is where this used
 * to point and would now be a lie by nine hundredths of a unit. The apex of a
 * tapered tube is its end point plus its end radius.
 *
 * IT IS THE NUMBER YETI_SCALE IS SOLVED FOR, so it is exactly
 * YETI_HEIGHT_IN_PEEPS peeps and cannot drift off that ceiling: a change to the
 * horn or the head moves the SCALE, not this total.
 *
 * He is the SMALLEST of the three by a wide margin and the only one you see all
 * of. The two rulers a player has for him are the PEEP that walks up the valley
 * to him — he is twice one, which is the owner's ceiling — and the wildlife
 * grazer on his hillside, a quarter of a world unit long, against which he is
 * still five times over.
 */
export const YETI_TOTAL_HEIGHT = YETI_HORN_TIP_HEIGHT + YETI_HORN_TIP_RADIUS;

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
 * him a shape rather than a hole in the ground. The MANTLE is the one tone lighter
 * than the fur, so the collar catches the sun where everything else falls away.
 * Cross-referenced against the palette and not imported, for the reason the snow
 * line itself is (server/habitat.ts).
 */
export const YETI_FUR_COLOR = 0xe4ebf2;
export const YETI_UNDERFUR_COLOR = 0xb6c2d1;
export const YETI_MANTLE_COLOR = 0xf2f5f8;
/**
 * Bare skin: the NOSE PAD, hands and feet. Dark slate.
 *
 * It said "muzzle" until 2026-08-24 and that was the walrus: the whole snout in
 * this colour is a single dark mass the width of the head. The muzzle is furred
 * now and this is spent on a nose the size of a thumbnail, which is how much
 * bare skin a cold-climate animal's face actually has.
 */
export const YETI_SKIN_COLOR = 0x4b4a52;
/**
 * The inside of the mouth. Darker and WARMER than the slate of the bare skin —
 * a mouth is a hole with blood behind it, and the two darks read as two
 * different materials rather than as one shadow with a bite out of it.
 */
export const YETI_MAW_COLOR = 0x2a1f22;
/** The eye's own dark shell, so it is a socket and not a floating dot. */
export const YETI_EYE_COLOR = 0x14161c;
/**
 * A cold glint. Deliberately dim — see YETI_EYE_RADIUS.
 *
 * DIMMED AGAIN 2026-08-24, with the eye made a LIT sphere rather than an
 * unshaded one. Unshaded is what a light source is, and it was drawing the eye
 * as a flat disc of solid blue pasted onto the face: no terminator, no
 * highlight, nothing to say it was a ball in a socket. A yeti's eye is not a
 * lamp — it is a wet dark eye that catches the sky — so it takes the same
 * lighting as the rest of him and keeps a trace of emission underneath, which
 * is what stops it going pure black under the brow ridge.
 */
export const YETI_EYE_EMISSIVE = 0x16283a;

/**
 * SKIN DETAIL. Same fields as the other two anatomies and the same inward-only
 * rule: the carve may never push a vertex outward, or YETI_TOTAL_HEIGHT and
 * YETI_WIDTH_CELLS stop being bounds.
 *
 * The carve is DEEPER and much higher-frequency than either sea creature's
 * RELATIVE TO THE BODY IT IS ON — 0.12 at 2.6 cycles per unit on a 6.3-unit
 * animal, against the kraken's 0.07 at 1.4 on an 8-unit one. Relative is the
 * only fair comparison, and now the only one a test can make: YETI_SCALE takes
 * the depth to 0.022 and the frequency to 14.4, which is the SAME surface five
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
 * decision, 2026-08-22): a shrunken animal that kept the full-size 0.45 would
 * cross its own body proportionally faster than it used to, which is what
 * scurrying looks like. At 0.0811 he covers his own width in the same eleven
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
