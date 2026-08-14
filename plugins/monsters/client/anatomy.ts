// The Cthulhu silhouette, as numbers.
//
// Every dimension of the model lives here rather than inside models.ts for two
// reasons: the placement maths needs some of them (how deep the thing sits is
// derived from where its head is, not guessed), and a node test can read them
// without importing three — this project ships no headless GL rig (design §8),
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

/** Bulbous, elongated head, carried forward of the shoulders. */
export const CTHULHU_HEAD_CENTER_HEIGHT = 8.4;
export const CTHULHU_HEAD_LENGTH = 4.6;
export const CTHULHU_HEAD_HEIGHT = 3.8;
export const CTHULHU_HEAD_WIDTH = 3.6;
/** Forward offset of the head's centre from the body axis. */
export const CTHULHU_HEAD_FORWARD = 0.5;

/** Top of the head above the origin — the derived silhouette height of the skull. */
export const CTHULHU_HEAD_TOP = CTHULHU_HEAD_CENTER_HEIGHT + CTHULHU_HEAD_HEIGHT / 2;
/** Bottom of the head above the origin. This is what sets the lurking depth. */
export const CTHULHU_HEAD_BOTTOM = CTHULHU_HEAD_CENTER_HEIGHT - CTHULHU_HEAD_HEIGHT / 2;

/**
 * The face tentacles. Seven — inside the brief's 6–8, and odd so that one hangs
 * on the centre line and the fan is symmetric about it rather than parted down
 * the middle.
 *
 * Each is TWO tapering segments with a bend between them, which is what buys a
 * curve out of straight cones: a single cone per tentacle reads as a spike.
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

/**
 * Wings: two flat angular panels per side, folded back and up in a hunch. Flat
 * on purpose — a membrane has no volume, and two hard-edged quads catch the
 * sun's light at different angles, which is what makes them read as leathery
 * rather than as slabs.
 */
export const CTHULHU_WING_PANEL_LENGTH = 3.6;
export const CTHULHU_WING_PANEL_HEIGHT = 4.4;
export const CTHULHU_WING_PANEL_THICKNESS = 0.28;
export const CTHULHU_WING_OFFSET = 2.4;
export const CTHULHU_WING_HEIGHT = 7;
export const CTHULHU_WING_BACKSET = 1.4;
/** Outward lean and backward rake of the folded wing, radians. */
export const CTHULHU_WING_LEAN_RADIANS = 0.35;
export const CTHULHU_WING_RAKE_RADIANS = 0.5;
/** The second, smaller panel — the fold — sits above and outboard of the first. */
export const CTHULHU_WING_FOLD_SCALE = 0.55;
export const CTHULHU_WING_FOLD_RISE = 2.6;

/** Eye pair: small, close-set, high on the face. */
export const CTHULHU_EYE_RADIUS = 0.22;
export const CTHULHU_EYE_FORWARD = 1.9;
export const CTHULHU_EYE_HEIGHT = 9;
export const CTHULHU_EYE_OFFSET = 0.85;

/**
 * Total modelled height, origin to the tip of the folded wings — the tallest
 * point, which is what makes the hunch read from a distance.
 *
 * ~10.8 cells, inside the brief's 10–14, and worth stating against the world it
 * stands in: one terrace band is one world unit, so this thing is eleven bands
 * tall. The wildlife plugin's whale is 5 cells NOSE TO TAIL and swims flat, so
 * Cthulhu is roughly two whale-lengths of pure vertical.
 */
export const CTHULHU_WING_TIP_HEIGHT =
  CTHULHU_WING_HEIGHT + CTHULHU_WING_FOLD_RISE + CTHULHU_WING_PANEL_HEIGHT * CTHULHU_WING_FOLD_SCALE / 2;
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

/** Dark green-black palette. Flat-shaded, lit only by the scene's own lights. */
export const CTHULHU_BODY_COLOR = 0x1b2a20;
export const CTHULHU_HEAD_COLOR = 0x24382a;
export const CTHULHU_WING_COLOR = 0x111a14;
export const CTHULHU_TENTACLE_COLOR = 0x203024;
/** The eye's own dark shell, so it is not a floating dot when unlit. */
export const CTHULHU_EYE_COLOR = 0x0d1410;
/** Sickly bioluminescent green. The one thing on the model that emits. */
export const CTHULHU_EYE_EMISSIVE = 0x86c34a;

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
