// The Cthulhu silhouette, as numbers.
//
// Every dimension of the model lives here rather than inside models.ts for two
// reasons: the placement maths needs some of them (how deep the thing sits is
// derived from where its head is, not guessed), and a node test can read them
// without importing three — this project ships no headless GL rig (design doc),
// so the numbers are the only part of the visual that CAN be tested.
//
// UNITS: cells. CELL_WORLD_SIZE is 1 (client/src/config.ts — "world-space X/Z
// coordinates ARE cell coordinates") and HEIGHT_WORLD_SCALE maps one terrace
// band to one world unit, so a number here is simultaneously cells across the
// board and world units of height.
//
// FRAME: the model faces +X. The origin is the PIVOT, at the base of the visible
// torso — the point the server's cell position is placed at, and the point the
// water closes over. Everything above the origin is the part that can be seen.

/** Torso: a heavy, slightly flattened column from the origin upward. */
export const CTHULHU_TORSO_HEIGHT = 6;
export const CTHULHU_TORSO_LENGTH = 3;
export const CTHULHU_TORSO_WIDTH = 4.2;

/**
 * Shoulders: two masses set wide on either side, high on the torso. They are the
 * widest part of the body and the reason the thing reads as hunched rather than
 * as a snake — a Cthulhu whose shoulders are narrower than its head is a lizard.
 */
export const CTHULHU_SHOULDER_HEIGHT = 5.6;
export const CTHULHU_SHOULDER_OFFSET = 2;
export const CTHULHU_SHOULDER_LENGTH = 2.8;
export const CTHULHU_SHOULDER_THICKNESS = 2.2;
export const CTHULHU_SHOULDER_WIDTH = 2.8;

/**
 * Neck: the mass that fills the gap between the shoulder crowns and the head.
 *
 * It exists because the head is now a SMOOTH-shaded dome rather than a faceted
 * one: a smooth ellipsoid floating above two smooth shoulders reads as a ball
 * balanced on a body, where a faceted one read as a stylisation. It sits below
 * the head's bottom, so it changes neither CTHULHU_HEAD_BOTTOM nor anything
 * derived from it.
 */
export const CTHULHU_NECK_CENTER_HEIGHT = 6.6;
export const CTHULHU_NECK_LENGTH = 2.6;
export const CTHULHU_NECK_HEIGHT = 2.8;
export const CTHULHU_NECK_WIDTH = 2.9;
export const CTHULHU_NECK_FORWARD = 0.25;

/** Bulbous, elongated head, carried forward of the shoulders. */
export const CTHULHU_HEAD_CENTER_HEIGHT = 8.4;
export const CTHULHU_HEAD_LENGTH = 4.6;
export const CTHULHU_HEAD_HEIGHT = 3.8;
export const CTHULHU_HEAD_WIDTH = 3.6;
/** Forward offset of the head's centre from the body axis. */
export const CTHULHU_HEAD_FORWARD = 0.5;

/**
 * HEAD SCULPT. Two factors that narrow the head toward its front, turning the
 * ellipsoid into a brow and a muzzle.
 *
 * Both are CARVING factors: they only ever multiply an extent by something ≤ 1,
 * never > 1. That is the contract that keeps CTHULHU_HEAD_TOP, _BOTTOM, _WIDTH
 * and everything derived from them — CTHULHU_LURK_DEPTH above all — true upper
 * bounds on the geometry rather than approximations of it. The same rule governs
 * the wrinkle displacement below.
 */
export const CTHULHU_HEAD_MUZZLE_TAPER = 0.3;
export const CTHULHU_HEAD_BROW_SLOPE = 0.22;

/** Top of the head above the origin — the derived silhouette height of the skull. */
export const CTHULHU_HEAD_TOP = CTHULHU_HEAD_CENTER_HEIGHT + CTHULHU_HEAD_HEIGHT / 2;
/** Bottom of the head above the origin. This is what sets the lurking depth. */
export const CTHULHU_HEAD_BOTTOM = CTHULHU_HEAD_CENTER_HEIGHT - CTHULHU_HEAD_HEIGHT / 2;

/**
 * The face tentacles. Seven — inside the brief's 6–8, and odd so that one hangs
 * on the centre line and the fan is symmetric about it rather than parted down
 * the middle.
 *
 * Each is TWO tapering segments with a bend between them. The two-segment rig is
 * kept for the ANIMATION — the root joint carries the fan sway and the mid joint
 * the lagged follow-through — but each segment is now a swept tube along a
 * curling arc rather than a cone, so the rest pose is already a curve and the
 * joints only have to add motion to it.
 */
export const CTHULHU_FACE_TENTACLE_COUNT = 7;
/** Where the fan is rooted, forward and low on the head. */
export const CTHULHU_TENTACLE_ROOT_FORWARD = 1.5;
export const CTHULHU_TENTACLE_ROOT_HEIGHT = 7.5;
/** Total angular width of the fan, radians (≈86°). */
export const CTHULHU_TENTACLE_FAN_RADIANS = 1.5;
/** Forward pitch of the whole fan from straight down, radians. */
export const CTHULHU_TENTACLE_PITCH_RADIANS = 0.45;
/** Bend between the two segments, radians. */
export const CTHULHU_TENTACLE_BEND_RADIANS = 0.55;

export const CTHULHU_TENTACLE_UPPER_LENGTH = 1.5;
export const CTHULHU_TENTACLE_UPPER_RADIUS = 0.34;
export const CTHULHU_TENTACLE_LOWER_LENGTH = 1.3;
export const CTHULHU_TENTACLE_LOWER_RADIUS = 0.2;
/** The tip. Not zero: a tube that closes to a true point pinches its shading. */
export const CTHULHU_TENTACLE_TIP_RADIUS = 0.045;

/**
 * How far each segment curls over its own length, in radians of turn.
 *
 * The segment is swept along a CIRCULAR ARC of exactly this total turn, so the
 * curl is stated as a shape rather than as a pile of control-point offsets: the
 * arc's radius is length / turn, and the whole curve falls out of the two
 * numbers. The lower segment turns three times as hard as the upper — that is
 * the hook at the end that stops the fan reading as a beard of straight rope.
 */
export const CTHULHU_TENTACLE_UPPER_CURL_RADIANS = 0.34;
export const CTHULHU_TENTACLE_LOWER_CURL_RADIANS = 1.05;
/** Floor on the turn, so a variation can never divide by a zero curl. */
export const CTHULHU_TENTACLE_MIN_CURL_RADIANS = 0.05;

/**
 * Per-tentacle variation, as a fraction of the nominal value.
 *
 * A fan of seven identical tentacles reads as a machined comb. Each tentacle's
 * curl, free length and sideways drift are scaled by a deterministic per-index
 * value in [-1, 1] times these — never by a random number, so every client
 * renders the same creature.
 */
export const CTHULHU_TENTACLE_CURL_VARIATION = 0.35;
export const CTHULHU_TENTACLE_LENGTH_VARIATION = 0.18;
/** Sideways wander of a segment at its midpoint, in cells, before variation. */
export const CTHULHU_TENTACLE_DRIFT = 0.22;
/** Mid-length swell of the upper segment — a muscle, not a taper. */
export const CTHULHU_TENTACLE_SWELL = 0.12;
/**
 * Taper curve of the lower segment: radius = lerp(lower, tip, t^exponent).
 * Below 1, so the thinning happens early and the last third is a fine point.
 */
export const CTHULHU_TENTACLE_TAPER_EXPONENT = 0.75;

/**
 * WINGS: a folded bat wing per side — an arm from the shoulder to a wrist, a
 * fan of fingers off that wrist, and a membrane draped between them.
 *
 * Everything is built as a FAN OUT OF THE WRIST. The ridges of the fan are, in
 * order: the arm running back down to the shoulder, then the fingers from the
 * most upright to the most drooping, then a free trailing edge falling to the
 * flank. The membrane is one patch between each neighbouring pair of ridges, so
 * the finger ribs sit exactly ON the membrane's seams by construction rather
 * than being laid near them and hoping.
 *
 * The lean and the rake are applied as SLOPES on those ridge points, not as a
 * rotation of a wing group. A rotation would tip the whole wing's height by its
 * cosine and quietly make CTHULHU_WING_TIP_HEIGHT below a wrong number; as
 * slopes, the stated tip height is the exact geometric one.
 *
 * THE FOOTPRINT IS THE BINDING CONSTRAINT on every number below. The wing is
 * the widest and the longest thing on the model in every direction but forward,
 * so CTHULHU_WIDTH_CELLS — the 7 the server steers by — is what caps the
 * offset, the lean, the rake and the chord. Measured against the built
 * geometry the model spans 6.73 cells across and 6.71 fore-and-aft, both inside
 * it, and the three candidates for the widest point are pinned by tests.
 * Widening any of these without re-measuring is how the shoulders end up inside
 * a cliff the server's probe said was clear.
 */
/** How far back from the arm the membrane's trailing edge reaches. */
export const CTHULHU_WING_CHORD = 2.9;
/** Rise of the wing if it were unfolded — the fingers are a fraction of it. */
export const CTHULHU_WING_SPAN = 4.4;
/** Radius of the leading-edge arm where it leaves the shoulder. */
export const CTHULHU_WING_ARM_RADIUS = 0.28;
export const CTHULHU_WING_OFFSET = 2;
export const CTHULHU_WING_HEIGHT = 7;
export const CTHULHU_WING_BACKSET = 0.6;
/** Outward lean and backward rake of the folded wing, radians. */
export const CTHULHU_WING_LEAN_RADIANS = 0.35;
export const CTHULHU_WING_RAKE_RADIANS = 0.4;
/** How much of the span survives the fold — the fingers' length. */
export const CTHULHU_WING_FOLD_SCALE = 0.55;
/** Height of the wrist above the wing's root on the shoulder. */
export const CTHULHU_WING_FOLD_RISE = 2.6;
export const CTHULHU_WING_FINGER_LENGTH = CTHULHU_WING_SPAN * CTHULHU_WING_FOLD_SCALE;
/**
 * How far the topmost finger's tip rises above the wrist. Half its length, so
 * the finger stands at exactly 60° off vertical — laid back over the shoulder,
 * which is what "folded" looks like from the side.
 */
export const CTHULHU_WING_FINGER_RISE = CTHULHU_WING_FINGER_LENGTH / 2;

/** Four fingers — the top of the brief's 3–4 ridges. */
export const CTHULHU_WING_FINGER_COUNT = 4;
/**
 * Angle of the topmost finger from vertical. DERIVED from the rise above, so
 * the tip lands on CTHULHU_WING_FINGER_RISE exactly however the fold is retuned.
 */
export const CTHULHU_WING_FINGER_FAN_START_RADIANS = Math.acos(
  CTHULHU_WING_FINGER_RISE / CTHULHU_WING_FINGER_LENGTH,
);
/** Angle between consecutive fingers, radians — the fan opens down and back. */
export const CTHULHU_WING_FINGER_FAN_STEP_RADIANS = 0.4;
/** Each finger is this fraction of the one above it. */
export const CTHULHU_WING_FINGER_LENGTH_STEP = 0.86;
/** Outward splay added per finger, in cells — the fan is not flat. */
export const CTHULHU_WING_FINGER_SPREAD = 0.1;
/** Downward bow of a finger at its midpoint, as a fraction of its length. */
export const CTHULHU_WING_FINGER_BOW = 0.1;
export const CTHULHU_WING_FINGER_RADIUS = 0.16;
export const CTHULHU_WING_FINGER_TIP_RADIUS = 0.04;
/** Radius of the arm where it meets the wrist — it tapers along its length. */
export const CTHULHU_WING_WRIST_RADIUS = 0.17;
/**
 * The wrist knuckle, as a multiple of the thickest bone that meets there.
 *
 * Every bone in the fan is a swept tube that STARTS at the wrist, so every one
 * of them has an open mouth there. One ball big enough to swallow all six is
 * both the fix and the joint the hand needs anyway; deriving its size from the
 * bones means it cannot be left behind when one of them is thickened.
 */
export const CTHULHU_WING_KNUCKLE_SWELL = 1.5;

/** Elbow: partway up the arm, bowed forward of the wrist and bulged outboard. */
export const CTHULHU_WING_ELBOW_RISE_FRACTION = 0.55;
export const CTHULHU_WING_ELBOW_BACK_FRACTION = 0.3;
export const CTHULHU_WING_ELBOW_BULGE = 0.35;

/** Where the free trailing edge lands: down the flank and tucked inboard. */
export const CTHULHU_WING_TRAILING_DROP = 3.4;
export const CTHULHU_WING_TRAILING_TUCK = 0.7;

/**
 * Membrane slack. The scallop pulls the free edge between two ridges back
 * toward the wrist (as a fraction of its distance from it), and the sag pushes
 * the sheet's middle down and inboard, in cells. Together they are what makes a
 * membrane read as skin under its own weight rather than as a taut sail.
 */
export const CTHULHU_WING_MEMBRANE_SCALLOP = 0.16;
export const CTHULHU_WING_MEMBRANE_SAG = 0.5;
/** Direction the sag pushes: mostly down, partly inboard toward the body. */
export const CTHULHU_WING_SAG_DOWN = 1;
export const CTHULHU_WING_SAG_INBOARD = 0.55;

/**
 * Eye pair: small, close-set, high on the face.
 *
 * These three numbers name a DIRECTION on the face, not a final position: the
 * model casts a ray from the head's centre through this point and puts the eye
 * where it meets the sculpted skin. Stating it as a point and letting the model
 * project it is what keeps the eyes ON the face when the head is retuned — a
 * literal position is a position that is inside the skull the day the muzzle
 * taper changes, and an eye inside the skull is an eye you cannot see.
 */
export const CTHULHU_EYE_RADIUS = 0.22;
export const CTHULHU_EYE_FORWARD = 1.9;
export const CTHULHU_EYE_HEIGHT = 9;
export const CTHULHU_EYE_OFFSET = 0.85;
/** How far outside the skin the eye's centre sits, as a fraction of its radius. */
export const CTHULHU_EYE_BULGE = 0.55;
/**
 * The glow around each eye: a second, larger, fainter sphere. Radius as a
 * multiple of the eye's, and how much of the light gets through it.
 */
export const CTHULHU_EYE_HALO_SCALE = 2.8;
export const CTHULHU_EYE_HALO_OPACITY = 0.2;

/**
 * Total modelled height, origin to the tip of the folded wings — the tallest
 * point, which is what makes the hunch read from a distance.
 *
 * ~10.9 cells, inside the brief's 10–14, and worth stating against the world it
 * stands in: one terrace band is one world unit, so this thing is eleven bands
 * tall. The wildlife plugin's whale is 5 cells NOSE TO TAIL and swims flat, so
 * Cthulhu is roughly two whale-lengths of pure vertical.
 *
 * The finger's own tip radius is in the sum because the finger BONE is a swept
 * tube, not a line: without it the tallest vertex on the model would sit a
 * whisker above the height this file claims, and a bound that is nearly true is
 * not a bound.
 */
export const CTHULHU_WING_TIP_HEIGHT =
  CTHULHU_WING_HEIGHT +
  CTHULHU_WING_FOLD_RISE +
  CTHULHU_WING_FINGER_RISE +
  CTHULHU_WING_FINGER_TIP_RADIUS;
export const CTHULHU_TOTAL_HEIGHT = Math.max(CTHULHU_HEAD_TOP, CTHULHU_WING_TIP_HEIGHT);

/**
 * Widest horizontal extent: shoulder to shoulder, tip to tip.
 *
 * This is the same 7 cells the SERVER knows as CTHULHU_FOOTPRINT_CELLS
 * (server/kinds.ts), where it sets the steering look-ahead so the body never
 * swims into a cliff the centre point cleared. The two are pinned to each other
 * by a test rather than by an import: the server half must not depend on the
 * client half (it runs in a process that never loads three), so the honest
 * arrangement is one number in each place plus a test that fails the day they
 * disagree.
 */
export const CTHULHU_WIDTH_CELLS = 7;

/**
 * How much of the head's lower rim the water swallows at rest, in cells.
 *
 * 0.1 — a tenth of a cell. Small, and it is the whole difference between a head
 * that floats above the sea like a balloon and one that is IN it.
 */
export const CTHULHU_WATERLINE_BITE = 0.1;

/**
 * How far below the sea surface the model's origin sits when the water is deep
 * enough to allow it.
 *
 * DERIVED, not chosen: it is exactly the depth that puts the bottom of the head
 * a WATERLINE_BITE under the surface. That places the head clear of the water,
 * the crowns of the shoulders breaking it, the tentacle tips trailing into it,
 * and the entire torso — 6.6 of the 10.8 cells, 61% of the silhouette — hidden.
 *
 * Deriving it means retuning the head or the shoulders cannot silently beach the
 * model or sink it; the waterline follows the anatomy.
 */
export const CTHULHU_LURK_DEPTH = CTHULHU_HEAD_BOTTOM + CTHULHU_WATERLINE_BITE;

/**
 * Dark green-black palette, smooth-shaded, lit only by the scene's own lights.
 *
 * Five tones rather than one: the body is the darkest lit surface, the head a
 * step lighter so the face carries, the tentacles lighter again (they are the
 * only part with a wet highlight to catch), the membrane darker than the body,
 * and the wing bones a shade above the membrane so the ribs read against it.
 */
export const CTHULHU_BODY_COLOR = 0x1b2a20;
export const CTHULHU_HEAD_COLOR = 0x24382a;
export const CTHULHU_WING_COLOR = 0x111a14;
export const CTHULHU_WING_RIB_COLOR = 0x1d2a20;
export const CTHULHU_TENTACLE_COLOR = 0x203024;
/** The eye's own dark shell, so it is not a floating dot when unlit. */
export const CTHULHU_EYE_COLOR = 0x0d1410;
/** Sickly bioluminescent green. The one thing on the model that emits. */
export const CTHULHU_EYE_EMISSIVE = 0x86c34a;

/**
 * SKIN DETAIL — the wrinkle and the mottle.
 *
 * One deterministic noise field (models.ts) drives both: it dents the surface
 * inward and it darkens or lightens the vertex under it. No Math.random anywhere
 * in the geometry, so every client builds the same creature down to the wrinkle.
 *
 * The displacement is INWARD-ONLY, for the reason given at the head sculpt: an
 * outward bump would make CTHULHU_HEAD_TOP and CTHULHU_HEAD_BOTTOM — and so the
 * lurk depth and the waterline bite — a claim the geometry could exceed. Carving
 * can only ever leave the model inside the box anatomy.ts describes.
 *
 * Depths in cells, and both are capped by the waterline rather than by taste.
 * The head's is under half the 0.1 waterline bite, so no wrinkle can put a piece
 * of skull through the water the placement maths thinks it lifted clear. The
 * body's is under the 0.1 by which the shoulder crowns clear the surface at the
 * lurking depth (CTHULHU_SHOULDER_HEIGHT + half the thickness, against
 * CTHULHU_LURK_DEPTH), so a dent can never sink a crown the silhouette needs
 * out of the water.
 */
export const CTHULHU_HEAD_WRINKLE_DEPTH = 0.04;
export const CTHULHU_BODY_WRINKLE_DEPTH = 0.08;
/** Spatial frequency of the wrinkle field, in cycles per cell. */
export const CTHULHU_WRINKLE_FREQUENCY = 1.7;
/**
 * Per-vertex shade variation, as a fraction either side of the material's own
 * colour, and the frequency of the mottle that drives it. Low: this is meant to
 * break up a flat expanse of one colour, not to look like camouflage.
 */
export const CTHULHU_SHADE_VARIATION = 0.16;
export const CTHULHU_SHADE_FREQUENCY = 0.55;

/**
 * Idle animation rates, in cycles per second, and their amplitudes.
 *
 * Both are deliberately below the frequency at which motion reads as effort:
 * the tentacles complete a sway every ~4.5 s and the breath every ~9 s, so at a
 * glance the thing looks still and only sustained watching reveals that it is
 * not. Fast idles are what make a monster look like a toy.
 */
export const CTHULHU_TENTACLE_SWAY_HZ = 0.22;
export const CTHULHU_TENTACLE_SWAY_RADIANS = 0.26;
/** Radians of phase between consecutive tentacles, so the fan ripples. */
export const CTHULHU_TENTACLE_PHASE_STEP = 0.9;

export const CTHULHU_BREATH_HZ = 0.11;
/** Vertical travel of the breathing bob, in cells. */
export const CTHULHU_BREATH_RISE = 0.18;
/** Roll accompanying the breath, radians — it keeps the bob from reading as a lift. */
export const CTHULHU_BREATH_ROLL_RADIANS = 0.02;
