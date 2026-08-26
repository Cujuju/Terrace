// The yeti silhouette, as numbers — FOUR of them since 2026-08-26. The sibling
// of ./anatomy.ts (Cthulhu's) and ./kraken-anatomy.ts, and it keeps their
// contract exactly:
//
//   * every dimension of the model lives here rather than inside the builder,
//     because the placement maths needs some of them and a node test can read
//     them without importing three (design §8 — no headless GL rig);
//   * UNITS are WORLD UNITS. HEIGHT_WORLD_SCALE maps one terrace band to one
//     world unit, so a number here is simultaneously world units across the
//     board and terrace bands of height.
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
// WHY THIS FILE IS A BODY-BUILDER AND NOT A LIST OF CONSTANTS ANY MORE
//
// It was a hundred and fifty exported lengths describing ONE animal, and the
// owner's 2026-08-26 decision is that a yeti is one of four bodies the server
// rolls between. Four copies of that list is four places to forget something;
// four sets of overrides on a shared list is worse, because the interesting
// numbers (where the head sits, how far a hand reaches) are then DERIVED from
// the overrides and cannot be read at all.
//
// So the animal is described here as a SPEC — the proportions the owner argued
// about — and `yetiParts` turns a spec into the list of masses, limbs and swept
// tapers the body is actually made of. Two things then read that list:
//
//   * the SOLVER below, which is plain arithmetic over the parts and answers
//     the two questions the rest of the codebase asks — how tall is he (so the
//     scale can be solved for the owner's ceiling) and how far does he reach
//     (so the server can steer him past a cliff);
//   * ./yeti.ts, which turns the same list into geometry.
//
// That is the whole reason the parts are data rather than three calls: a bound
// derived from a DIFFERENT description of the body than the one that gets built
// is not a bound, it is a hope. Every previous version of this file solved the
// scale against five hand-copied numbers and stated the width as a literal, and
// both had to be re-checked by hand every time a mass moved.
//
// WHAT MAKES HIM NOT A THIRD SEA HORROR. Cthulhu is a FIGURE, bilateral and
// hidden. The kraken is RADIAL and low-slung. The yeti is an ANIMAL: he stands
// ON the ground, he is by far the smallest, and his silhouette is a hunched
// biped with arms that hang below his hips. He is white on white, so the
// modelling that has to work hardest is the EDGE — which is why his coat is the
// one textured surface in this plugin and, since 2026-08-26, the one with fur
// SHELLS standing off it (../client/geometry.ts, furStrandAlphaTexture).
// ─────────────────────────────────────────────────────────────────────────────

// The wire contract is this plugin's own (../protocol.ts) and carries no three,
// no node builtins — the one import this numbers file is allowed, and only for
// the variant NAMES, so the per-variant table below cannot fall out of step
// with the set the server may send.
import { YETI_VARIANTS, type YetiVariant } from '../protocol.ts';

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
 * than two times taller than one of the peeps".
 *
 * EVERY VARIANT IS SOLVED TO IT SEPARATELY, and to its own highest point: the
 * ibex's horn tips are the top of that animal, the silverback's crest is the top
 * of his. A single scale shared between the four would have put whichever
 * variant carries the most on its head over the ceiling, silently, with every
 * proportion in its spec still looking right. See YETI_VARIANT_METRICS.
 */
export const YETI_HEIGHT_IN_PEEPS = 2;

/** Ground to the highest point of ANY variant: the owner's ceiling, exactly. */
export const YETI_TOTAL_HEIGHT = PEEP_HEIGHT_WORLD_UNITS * YETI_HEIGHT_IN_PEEPS;

// ── The frame ────────────────────────────────────────────────────────────────

/**
 * A point on the animal, in his own frame: FORWARD is +X (the way he faces),
 * HEIGHT is +Y from the ground between his feet, LATERAL is +Z (his left).
 *
 * Named rather than a bare triple because the last two rebuilds of this model
 * both cost an afternoon to a transposed axis. A number called `lateral` cannot
 * be quietly used as a depth.
 */
export interface YetiPoint {
  readonly forward: number;
  readonly height: number;
  readonly lateral: number;
}

/**
 * The animated handles, and the only ones. Every part of the body is authored
 * in exactly one of these spaces; ./yeti.ts hangs the matching Group off the rig
 * and the gait drives them by name.
 *
 * `upper` and `head` are authored in RIG space (their joints sit at the origin),
 * which is what keeps one continuous noise field running from hip to brow — the
 * head still yaws, about the vertical axis through the body, which is where a
 * scan happens on an animal whose head is carried between its shoulders. The
 * four limb joints are the exception, exactly as the kraken's arms are: each
 * hangs off a joint and its parts are authored in that joint's space.
 */
export type YetiJoint = 'upper' | 'head' | 'leg' | 'ankle' | 'arm';

/** Which surface a part is made of — one material each, in ./yeti.ts. */
export type YetiSurface =
  | 'coat'
  | 'saddle'
  | 'hide'
  | 'face'
  | 'nose'
  | 'maw'
  | 'eye'
  | 'glint'
  | 'horn'
  | 'ivory';

/**
 * How finely a part is tessellated, as a CLASS rather than a segment count: the
 * counts themselves belong to the builder (./yeti.ts owns the resolution knob,
 * this file owns the shape), but which parts deserve them is an anatomical
 * judgement — a skull is looked at, a knuckle is not.
 */
export type YetiPartSize =
  | 'trunk'
  | 'head'
  | 'feature'
  | 'limb'
  /** A ball buried in the end of a limb, closing a bend. Never seen whole. */
  | 'joint'
  | 'digit'
  | 'horn';

/** How far out a part's fur shells stand, and how many there are. */
export interface YetiShells {
  /** Outward push of the OUTERMOST shell, as a fraction of the part's radius. */
  readonly length: number;
  readonly layers: number;
}

interface YetiPartCommon {
  readonly joint: YetiJoint;
  /** +1 his left, -1 his right; 0 for a part on the centre line. */
  readonly side: number;
  readonly surface: YetiSurface;
  readonly size: YetiPartSize;
  /** Null for a bare surface — hide, horn, ivory, eye. */
  readonly shells: YetiShells | null;
}

/** A rounded mass: the trunk, the skull, a cheek, a toe. */
export interface YetiMassPart extends YetiPartCommon {
  readonly kind: 'mass';
  readonly center: YetiPoint;
  /** Semi-axes, not diameters — a radius per axis. */
  readonly radii: YetiPoint;
  /** Rotation about the LATERAL axis, radians: the chest's tilt into the hunch. */
  readonly tilt: number;
}

/** A segment between two joints: a thigh, a forearm, a neck. */
export interface YetiLimbPart extends YetiPartCommon {
  readonly kind: 'limb';
  readonly from: YetiPoint;
  readonly to: YetiPoint;
  readonly rootRadius: number;
  readonly tipRadius: number;
}

/** A curved taper: a horn, a fang, a finger. */
export interface YetiSweepPart extends YetiPartCommon {
  readonly kind: 'sweep';
  readonly path: readonly YetiPoint[];
  readonly rootRadius: number;
  readonly tipRadius: number;
  /** Exponent on the taper: >1 keeps a horn thick for longer before it points. */
  readonly taperPower: number;
}

export type YetiPart = YetiMassPart | YetiLimbPart | YetiSweepPart;

/** Where a joint sits, in the space of its parent joint. */
export interface YetiJointRest {
  readonly leg: YetiPoint;
  readonly ankle: YetiPoint;
  readonly arm: YetiPoint;
}

/** A whole body: its parts, and where its joints rest. */
export interface YetiBody {
  readonly parts: readonly YetiPart[];
  readonly joints: YetiJointRest;
}

// ── The spec: the proportions of one variant ─────────────────────────────────

/** The head, whose three radii most other features on the face are stated in. */
export interface YetiSkull {
  readonly forward: number;
  readonly height: number;
  readonly lateral: number;
}

export interface YetiArmSpec {
  readonly upper: number;
  readonly fore: number;
  /** How far forward of straight-down each segment hangs, radians. */
  readonly upperForward: number;
  readonly foreForward: number;
  readonly elbowFlare: number;
  readonly wristFlare: number;
  readonly shoulderRadius: number;
  readonly elbowRadius: number;
  readonly wristRadius: number;
}

export interface YetiLegSpec {
  readonly thigh: number;
  readonly shin: number;
  readonly thighForward: number;
  readonly shinForward: number;
  readonly kneeFlare: number;
  readonly hipRadius: number;
  readonly kneeRadius: number;
  readonly ankleRadius: number;
  readonly footLength: number;
  readonly footWidth: number;
  readonly footHeight: number;
}

/** Which horns a variant wears, if any. See the three recipes below. */
export type YetiHornStyle = 'none' | 'ram' | 'ibex' | 'stub';

/**
 * ONE VARIANT'S BODY, in the units the four were designed and approved in —
 * roughly two units tall, which is the studio the owner reviewed the concepts
 * in. Nothing here is world units; `YETI_VARIANT_METRICS` solves the factor that
 * makes each of them exactly two peeps tall.
 */
export interface YetiVariantSpec {
  readonly coat: number;
  /** The pile's own shadow — what the innermost shell is tinted towards. */
  readonly underTint: number;
  readonly skin: number;
  readonly faceColor: number;
  /** A lighter mass across the back, or 0 for a variant without one. */
  readonly saddle: number;
  /** Depth of the fur CARVE, relative to the base coat (1 is the base). */
  readonly shag: number;
  /** Outward push of the outermost shell, as a fraction of a part's radius. */
  readonly coatLength: number;
  readonly shellLayers: number;

  readonly hipHeight: number;
  readonly shoulderHeight: number;
  /** Radians the spine leans forward. The whole difference between an ape and a man. */
  readonly hunch: number;
  readonly hipRadii: YetiPoint;
  readonly bellyRadii: YetiPoint;
  /** How far the belly hangs forward of the spine. */
  readonly bellyOut: number;
  readonly chestRadii: YetiPoint;
  readonly chestOut: number;
  readonly shoulderHalfSpan: number;
  readonly shoulderRadius: number;

  readonly neckLength: number;
  readonly neckRadius: number;
  /** Radians the neck drops FURTHER forward than the hunch already carries it. */
  readonly headDrop: number;
  readonly headForward: number;
  readonly skull: YetiSkull;
  /** A sagittal crest, as a fraction of the skull's height. 0 for none. */
  readonly crest: number;
  /** Width of the bare face plate, as a fraction of the skull's. */
  readonly faceWidth: number;
  /** How far the muzzle stands out of the face, in skull depths. */
  readonly muzzleOut: number;
  /** True for a furred muzzle, false for bare skin over it. */
  readonly muzzleFur: boolean;
  /** Length of the upper fangs. 0 for a variant without them. */
  readonly fangs: number;
  readonly horns: YetiHornStyle;

  readonly arm: YetiArmSpec;
  readonly leg: YetiLegSpec;
  readonly stanceHalfWidth: number;
  /** Fingers per hand, beside the thumb. */
  readonly fingers: number;
  /**
   * KNUCKLE-WALKING: the fists rest on the ground, and the forearm's forward
   * reach is SOLVED for it rather than posed by eye — see `yetiParts`.
   */
  readonly knuckle: boolean;
}

/**
 * The base body every variant is stated as a change to.
 *
 * These are the concept study's numbers (the four renders the owner approved on
 * 2026-08-26), restated here as one named field each. They are not a variant on
 * their own: nothing renders this spec, and the four below each override enough
 * of it to be a different animal.
 */
const BASE_SPEC: YetiVariantSpec = {
  coat: 0xdcdfdc,
  underTint: 0x6a7480,
  skin: 0x3a3339,
  faceColor: 0x45393c,
  saddle: 0,
  shag: 1,
  coatLength: 0.09,
  shellLayers: 3,

  hipHeight: 0.86,
  shoulderHeight: 1.62,
  hunch: 0.22,
  hipRadii: { forward: 0.3, height: 0.24, lateral: 0.36 },
  bellyRadii: { forward: 0.34, height: 0.42, lateral: 0.4 },
  bellyOut: 0.04,
  chestRadii: { forward: 0.4, height: 0.4, lateral: 0.5 },
  chestOut: 0.02,
  shoulderHalfSpan: 0.46,
  shoulderRadius: 0.22,

  neckLength: 0.12,
  neckRadius: 0.18,
  headDrop: 0.35,
  headForward: 0.06,
  skull: { forward: 0.28, height: 0.3, lateral: 0.26 },
  crest: 0,
  faceWidth: 0.62,
  muzzleOut: 0.35,
  muzzleFur: false,
  fangs: 0,
  horns: 'none',

  arm: {
    upper: 0.62,
    fore: 0.62,
    // A REAL ELBOW, which the owner's third note asks for: the two angles are
    // measured from straight down, so a forearm that hangs at nearly the upper
    // arm's angle is one straight tube with a lump in it — which is what the
    // arms were. The upper arm leads forward and the forearm drops back under
    // it, and the difference between the two IS the bend.
    upperForward: 0.22,
    foreForward: 0.02,
    elbowFlare: 0.08,
    wristFlare: 0.04,
    shoulderRadius: 0.16,
    elbowRadius: 0.13,
    wristRadius: 0.11,
  },
  leg: {
    thigh: 0.42,
    shin: 0.36,
    thighForward: 0.12,
    shinForward: 0.08,
    kneeFlare: 0.02,
    hipRadius: 0.17,
    kneeRadius: 0.13,
    ankleRadius: 0.11,
    footLength: 0.42,
    footWidth: 0.15,
    footHeight: 0.09,
  },
  stanceHalfWidth: 0.24,
  fingers: 4,
  knuckle: false,
};

/**
 * THE FOUR BODIES the server rolls between (../protocol.ts, YETI_VARIANTS).
 *
 * Each is one of the concepts the owner picked out of the 2026-08-26 study, and
 * the thesis of each is why it is here rather than a fifth grey ape:
 *
 *   * SILVERBACK — mass, not height. Gorilla proportions, a deep hunch, and
 *     hands rolled into knuckle-walking fists that carry the front of him. The
 *     pale saddle gives the shoulders a second read at a hundred cells. He is
 *     the widest of the four, which is why the server's footprint is his.
 *   * RAM — keeps the owner's horns, grown the way horn actually grows: a
 *     keratin sheath curling out and down from bosses on the skull. A curl sits
 *     INSIDE the head's silhouette, so it never competes with the brow for the
 *     skyline, and (owner, on the first attempt) it must not reach the
 *     shoulders — see `ramHornPath`.
 *   * IBEX — the other way to keep horns: tall sweeps that ARE the skyline, on a
 *     leaner, more upright animal that stands up straight to carry them. The
 *     horn tip is the top of this one, so the scale solve has to include it.
 *   * FANGED — keeps the owner's fangs, drops the horns to two stubs. Canines
 *     over a real lip on a wide jaw: the jaw is what makes fangs believable, so
 *     the head is broader through the cheeks and the muzzle is furred.
 */
export const YETI_VARIANT_SPECS: Readonly<Record<YetiVariant, YetiVariantSpec>> = {
  silverback: {
    ...BASE_SPEC,
    coat: 0x5c6068,
    underTint: 0x1e2024,
    skin: 0x26232a,
    faceColor: 0x2c2830,
    saddle: 0xd9dde0,
    shag: 0.89,
    coatLength: 0.07,
    hunch: 0.52,
    headDrop: 0.55,
    hipHeight: 0.8,
    shoulderHeight: 1.5,
    chestRadii: { forward: 0.46, height: 0.4, lateral: 0.58 },
    shoulderHalfSpan: 0.52,
    shoulderRadius: 0.26,
    skull: { forward: 0.27, height: 0.27, lateral: 0.24 },
    crest: 0.55,
    knuckle: true,
    arm: {
      ...BASE_SPEC.arm,
      upper: 0.7,
      fore: 0.7,
      // On a knuckle-walker the forearm's angle is SOLVED (see `knuckle`), so
      // only the upper arm's is a choice: the more vertical it hangs, the
      // further the forearm has to reach forward to put the fist on the ground
      // and the more the elbow reads as an elbow.
      upperForward: 0.15,
      foreForward: 0.35,
      shoulderRadius: 0.19,
      elbowRadius: 0.16,
      wristRadius: 0.13,
    },
    leg: { ...BASE_SPEC.leg, thigh: 0.38, shin: 0.32, hipRadius: 0.19 },
    stanceHalfWidth: 0.27,
  },
  ram: {
    ...BASE_SPEC,
    coat: 0xdcdfdc,
    underTint: 0x6a7480,
    skin: 0x3a3339,
    faceColor: 0x45393c,
    shag: 1.11,
    coatLength: 0.1,
    horns: 'ram',
    fangs: 0.06,
    muzzleFur: true,
    skull: { forward: 0.29, height: 0.3, lateral: 0.27 },
  },
  ibex: {
    ...BASE_SPEC,
    coat: 0xe2e1da,
    underTint: 0x7a7266,
    skin: 0x2b2628,
    faceColor: 0x342c2e,
    shag: 0.78,
    coatLength: 0.07,
    horns: 'ibex',
    hunch: 0.1,
    headDrop: 0.15,
    hipHeight: 0.8,
    shoulderHeight: 1.5,
    chestRadii: { forward: 0.34, height: 0.4, lateral: 0.42 },
    bellyRadii: { forward: 0.28, height: 0.42, lateral: 0.34 },
    shoulderHalfSpan: 0.4,
    shoulderRadius: 0.18,
    skull: { forward: 0.26, height: 0.28, lateral: 0.22 },
    neckLength: 0.18,
    arm: {
      ...BASE_SPEC.arm,
      upper: 0.56,
      fore: 0.56,
      shoulderRadius: 0.13,
      elbowRadius: 0.11,
      wristRadius: 0.09,
    },
    leg: {
      ...BASE_SPEC.leg,
      thigh: 0.4,
      shin: 0.36,
      hipRadius: 0.14,
      kneeRadius: 0.11,
      ankleRadius: 0.09,
      footWidth: 0.13,
    },
  },
  fanged: {
    ...BASE_SPEC,
    coat: 0xe6e2d6,
    underTint: 0x8a7b66,
    skin: 0x3b3236,
    faceColor: 0x4b3d40,
    shag: 1.11,
    coatLength: 0.1,
    faceWidth: 0.7,
    muzzleFur: true,
    fangs: 0.11,
    horns: 'stub',
    skull: { forward: 0.3, height: 0.3, lateral: 0.3 },
    muzzleOut: 0.4,
    hunch: 0.26,
  },
};

// ── Colour and finish, shared by all four ────────────────────────────────────

/** The inside of the mouth: darker and WARMER than any bare skin on him. */
export const YETI_MAW_COLOR = 0x241416;
/** The nose pad, on every variant. Wet black, not the face's slate. */
export const YETI_NOSE_COLOR = 0x1c1a1c;
/** The eye's own dark shell, so it is a socket and not a floating dot. */
export const YETI_EYE_COLOR = 0x0c0e12;
/**
 * A cold glint, and the only pale thing on the face.
 *
 * It is a SEPARATE bead in front of the eye rather than an emissive on it, which
 * is what makes an eye read as wet: a catchlight is a reflection of the sky at
 * one point on a ball, and an eye that glows all over is a lamp. It takes the
 * ivory material, so it costs no draw call of its own.
 */
export const YETI_GLINT_COLOR = 0xcfe6f5;
/**
 * A trace of emission under the eye — dim, and not illumination. A white animal
 * against white snow is a silhouette with nothing to fix the eye on, and this is
 * what stops the socket going pure black under the brow ridge.
 */
export const YETI_EYE_EMISSIVE = 0x16283a;
/** Old ivory: fangs, claws and the glint. Weathered bone, not a dentist's white. */
export const YETI_IVORY_COLOR = 0xf2ead8;
/** Weathered keratin. Warm, where the bare skin is cold — see the ram's horns. */
export const YETI_HORN_COLOR = 0x6b5c4b;
/** The ibex's are older and darker; the fanged one's stubs darker still. */
export const YETI_IBEX_HORN_COLOR = 0x54473a;
export const YETI_STUB_HORN_COLOR = 0x3c332c;

/**
 * SKIN DETAIL. Same fields as the other two anatomies and the same inward-only
 * rule: the carve may never push a vertex outward, or YETI_TOTAL_HEIGHT and the
 * width below stop being bounds. (The fur SHELLS do stand outward — they are
 * geometry, not a carve, and the solver counts them.)
 *
 * STATED AS FRACTIONS OF HIS HEIGHT rather than as lengths, because that is the
 * only comparison that was ever meant: an absolute depth says nothing across
 * animals of different sizes, and it is what let a rescale silently coarsen this
 * coat once already. 1.7% of his height at 14.4 cycles across it is the same
 * surface the 2026-08-24 pass landed, restated so it cannot drift.
 */
const FUR_WRINKLE_DEPTH_OF_HEIGHT = 0.01744;
const SKIN_WRINKLE_DEPTH_OF_HEIGHT = 0.00581;
const WRINKLE_CYCLES_PER_HEIGHT = 17.888;
const SHADE_CYCLES_PER_HEIGHT = 6.192;
/**
 * Fur tiles down his standing height. Times the FUR_STRAND_COUNT strands a tile
 * carries, that is about a hundred and eighty strands from sole to crown — the
 * count that reads as fur at the distance he is actually seen from.
 */
const FUR_TILES_PER_HEIGHT = 6.88;

export const YETI_FUR_WRINKLE_DEPTH = FUR_WRINKLE_DEPTH_OF_HEIGHT * YETI_TOTAL_HEIGHT;
export const YETI_SKIN_WRINKLE_DEPTH = SKIN_WRINKLE_DEPTH_OF_HEIGHT * YETI_TOTAL_HEIGHT;
export const YETI_WRINKLE_FREQUENCY = WRINKLE_CYCLES_PER_HEIGHT / YETI_TOTAL_HEIGHT;
export const YETI_SHADE_FREQUENCY = SHADE_CYCLES_PER_HEIGHT / YETI_TOTAL_HEIGHT;
export const YETI_FUR_TEXTURE_FREQUENCY = FUR_TILES_PER_HEIGHT / YETI_TOTAL_HEIGHT;
/** ±22%, the largest of the three creatures: a white mass in sunlight has no
 *  contrast of its own, and this is what stops him reading as a paper cut-out. */
export const YETI_SHADE_VARIATION = 0.22;
/**
 * How much finer a SHELL's strands are than the shade tile's, as a whole number
 * of them per strand.
 *
 * The shade tile is painted on a lit surface and is read as texture; a shell is
 * read as SHAPE, one tuft at a time against the sky and against the bare face
 * plate — and at the shade tile's own pitch those tufts are wide enough to look
 * like scratches drawn across the mask rather than like hair over a brow. Three
 * to one, an integer, so a shell's partings still fall on the tile's every third
 * strand instead of beating against them.
 */
export const YETI_SHELL_STRAND_FACTOR = 3;

/**
 * How dark the innermost shell is tinted towards the variant's under-tint, and
 * how that fades outward. The bottom of a pile is in its own shadow; the tips
 * are in the sun.
 */
export const YETI_SHELL_UNDERTINT_STRENGTH = 0.35;

// ── The horns ────────────────────────────────────────────────────────────────
//
// Every horn is a path plus a root and tip radius, stated in SKULL RADII so it
// grows with the head it is on rather than being a prop of fixed size that fits
// one of the four. All three leave a boss on the skull (a mass merged into the
// head, in `yetiParts`) and root INSIDE it: a tube whose opening is visible is
// what an inserted prop looks like, which is the note the owner gave the last
// pair of horns.

/** Root and tip radius of a horn, in skull radii. */
const HORN_ROOT_IN_SKULL = 0.26;
const IBEX_HORN_ROOT_IN_SKULL = 0.22;
const STUB_HORN_ROOT_IN_SKULL = 0.2;
const HORN_TIP_RADIUS = 0.012;
const IBEX_HORN_TIP_RADIUS = 0.01;

function point(forward: number, height: number, lateral: number): YetiPoint {
  return { forward, height, lateral };
}

/**
 * THE RAM'S CURL: out, up, back, down and forward again, ending beside the
 * cheek.
 *
 * SIZED TO THE SKULL, which is the whole reason it is written as a factor: the
 * owner rejected a first version whose tips reached the shoulders. A curl scaled
 * by the head can only ever end beside the head — the lowest point on the path
 * is stated at the boss's own height minus a fifth of a skull, so the tip is
 * level with the cheek whatever size the head is.
 */
function ramHornPath(skull: YetiSkull, side: number): readonly YetiPoint[] {
  const curl = skull.lateral;
  const lateral0 = side * skull.lateral * 0.5;
  const height0 = skull.height * 0.55;
  const forward0 = -skull.forward * 0.1;
  return [
    point(forward0, height0 - 0.02 * curl, lateral0),
    point(forward0 - 0.33 * curl, height0 + 0.33 * curl, lateral0 + side * 0.19 * curl),
    point(forward0 - 0.7 * curl, height0 + 0.15 * curl, lateral0 + side * 0.52 * curl),
    point(forward0 - 0.52 * curl, height0 - 0.37 * curl, lateral0 + side * 0.74 * curl),
    point(forward0 + 0.07 * curl, height0 - 0.56 * curl, lateral0 + side * 0.74 * curl),
    point(forward0 + 0.44 * curl, height0 - 0.3 * curl, lateral0 + side * 0.81 * curl),
  ];
}

/** THE IBEX'S SWEEP: up and back, and it is the top of that animal. */
function ibexHornPath(skull: YetiSkull, side: number): readonly YetiPoint[] {
  const lateral0 = side * skull.lateral * 0.4;
  const height0 = skull.height * 0.7;
  const forward0 = -skull.forward * 0.05;
  return [
    point(forward0, height0 - 0.04, lateral0),
    point(forward0 - 0.12, height0 + 0.25, lateral0 + side * 0.05),
    point(forward0 - 0.35, height0 + 0.5, lateral0 + side * 0.12),
    point(forward0 - 0.6, height0 + 0.62, lateral0 + side * 0.2),
  ];
}

/** THE FANGED ONE'S STUBS: two short cones, well under the crown. */
function stubHornPath(skull: YetiSkull, side: number): readonly YetiPoint[] {
  const lateral0 = side * skull.lateral * 0.5;
  const height0 = skull.height * 0.62;
  return [
    point(0, height0 - 0.04, lateral0),
    point(-0.04, height0 + 0.14, lateral0 + side * 0.06),
    point(-0.1, height0 + 0.24, lateral0 + side * 0.12),
  ];
}

/** The colour of a style's horn, and how thick it leaves the boss. */
function hornFinish(style: YetiHornStyle): { color: number; rootInSkull: number; tip: number } {
  if (style === 'ibex') {
    return { color: YETI_IBEX_HORN_COLOR, rootInSkull: IBEX_HORN_ROOT_IN_SKULL, tip: IBEX_HORN_TIP_RADIUS };
  }
  if (style === 'stub') {
    return { color: YETI_STUB_HORN_COLOR, rootInSkull: STUB_HORN_ROOT_IN_SKULL, tip: HORN_TIP_RADIUS };
  }
  return { color: YETI_HORN_COLOR, rootInSkull: HORN_ROOT_IN_SKULL, tip: HORN_TIP_RADIUS };
}

/** Which of the three the anatomy calls for; 'none' emits nothing. */
export function yetiHornColor(style: YetiHornStyle): number {
  return hornFinish(style).color;
}

// ── Building a body out of a spec ────────────────────────────────────────────

/** The two sides, in a fixed order. +1 is the model's left. */
const SIDES = [1, -1] as const;

/**
 * How the brow, the face plate, the muzzle and the jaw sit on a skull, as
 * fractions of its radii.
 *
 * THIS IS THE FACE THE OWNER ASKED FOR, 2026-08-26: "one head mass, a brow
 * ridge, a bare-skin face plate recessed under the brow, a muzzle, nose pad, a
 * thin mouth line, jaw; eyes deep under the brow with a small glint." The
 * version it replaces was eight separate ellipsoids poking through the fur —
 * cheeks, ears and a mouth disc among them — and the reason that reads as a pile
 * of balls rather than as a face is that none of them was RECESSED: a face is a
 * plate set back under a brow, and everything on it is measured from that plate.
 */
const BROW_HEIGHT_IN_SKULL = 0.25;
const BROW_FORWARD_IN_SKULL = 0.72;
const BROW_RADII_IN_SKULL = { forward: 0.3, height: 0.22, lateral: 0.85 };
/**
 * THE PLATE STANDS PROUD OF THE COAT, for the reason the eyes do: a bare face is
 * a place where the fur STOPS, and a plate set under the shells is a dark patch
 * with white strands lying across it — which rendered as scratches on the mask.
 * Far enough forward that its own surface clears the outermost shell, and still
 * behind the brow ridge above it.
 */
const FACE_PLATE_FORWARD_IN_SKULL = 0.8;
const FACE_PLATE_HEIGHT_IN_SKULL = -0.12;
const FACE_PLATE_DEPTH_IN_SKULL = 0.28;
const FACE_PLATE_HEIGHT_RADIUS_IN_SKULL = 0.62;
const MUZZLE_HEIGHT_IN_SKULL = -0.28;
const MUZZLE_RADII_IN_SKULL = { forward: 0.42, height: 0.36, lateral: 0.5 };
const NOSE_RADII_IN_SKULL = { forward: 0.13, height: 0.14, lateral: 0.26 };
const MOUTH_RADII_IN_SKULL = { forward: 0.16, height: 0.045, lateral: 0.36 };
const JAW_RADII_IN_SKULL = { forward: 0.36, height: 0.24, lateral: 0.42 };
const EYE_RADII_IN_SKULL = { forward: 0.1, height: 0.11, lateral: 0.12 };
const EYE_LATERAL_IN_SKULL = 0.34;
const EYE_HEIGHT_IN_SKULL = 0.06;
/**
 * The catchlight: SMALL, and off-centre. A bead the size of the pupil in the
 * middle of the eye is a cartoon eye; a reflection of the sky sits high and
 * outboard on the ball, which is where a viewer reads "wet" from.
 */
const GLINT_RADIUS_IN_SKULL = 0.028;
const GLINT_HEIGHT_IN_SKULL = 0.13;
const GLINT_LATERAL_IN_SKULL = 0.38;
/**
 * How far in front of the face plate an eye and its glint sit, in skull depths.
 *
 * THE EYE HAS TO CLEAR THE COAT, not just the skin. The shells stand the fur off
 * the skull by up to `coatLength`, so an eye set flush with the plate — where
 * the first pass put it — is looked at THROUGH three layers of alpha-tested
 * hair, and what renders is a dark patch with white strands lying across it. It
 * still has to sit UNDER the brow, whose own ridge reaches further forward
 * again, which is what keeps it a deep-set eye rather than a bulging one.
 */
const EYE_FORWARD_IN_SKULL = 0.24;
const GLINT_FORWARD_IN_SKULL = 0.32;
/** The crest, and the mane-less shoulder saddle, in their own terms. */
const CREST_HEIGHT_IN_SKULL = 0.7;
const CREST_RADII_IN_SKULL = { forward: 0.6, lateral: 0.55 };
/**
 * THE SADDLE, and why it is broad and shallow rather than a mass of its own.
 *
 * It is the silverback's second read at a hundred cells: a band of pale hair
 * ACROSS the back, which is what a silverback's saddle is. Stated deep enough to
 * cover the spine and wide enough to reach both shoulder blades, and shallow in
 * the fore-aft axis so it sits ON the back instead of bulging out of the flank —
 * which is what the first pass rendered, a white egg on his side.
 */
const SADDLE_LENGTH_OF_TORSO = 0.34;
const SADDLE_DROP_OF_TORSO = 0.1;
const SADDLE_WIDTH_OF_CHEST = 1.02;
const SADDLE_DEPTH_OF_CHEST = 0.36;
/**
 * How far BEHIND the chest's own centre the saddle sits, in chest depths.
 *
 * Stated against the chest and not against the shoulder, which is where the
 * first pass measured it from: on a deep hunch the shoulder is a long way
 * forward of the back, so the saddle ended up buried inside the chest with only
 * a corner of it showing over the flank — a white egg on his side. At 0.85 its
 * centre is just inside the chest's back surface and the mass stands proud of
 * the spine, which is where a silverback's saddle is.
 */
const SADDLE_BEHIND_CHEST = 0.85;
const SADDLE_COAT_LENGTH = 0.7;

/** How far in front of the muzzle a fang hangs, in skull depths. */
const FANG_FORWARD_IN_SKULL = 0.34;

/** How long the coat is on the head and on the arms, against the body's. */
const HEAD_COAT_LENGTH = 0.8;
const ARM_COAT_LENGTH = 1.3;
const CREST_COAT_LENGTH = 1.1;
const MUZZLE_COAT_LENGTH = 0.5;
const JAW_COAT_LENGTH = 0.9;
const BROW_COAT_LENGTH = 1.3;

/** Digits: how they fan, how far they curl, and how big a claw-less tip is. */
const FINGER_SPREAD_IN_WRIST = 0.55;
const FINGER_ROOT_RADIUS_IN_WRIST = 0.24;
const FINGER_TIP_RADIUS_IN_WRIST = 0.14;
const FINGER_CURL_WALKING = 1;
const FINGER_CURL_HANGING = 0.45;
const THUMB_RADIUS_IN_WRIST = 0.25;
const TOE_COUNT = 5;
const TOE_SPREAD_IN_FOOT = 0.42;
const TOE_RADII_IN_FOOT = { forward: 0.14, height: 0.36, lateral: 0.2 };
/** A joint ball is a hair inside its limb's end ring, so no bend can open. */
const JOINT_BALL_IN_LIMB = 0.98;

function scalePoint(p: YetiPoint, k: number): YetiPoint {
  return { forward: p.forward * k, height: p.height * k, lateral: p.lateral * k };
}

/**
 * THE ANIMAL, as a list of parts. One pass, in the order a body is built: trunk,
 * head, face, arms, legs.
 *
 * Everything is in the spec's own units and every limb part is already in ITS
 * JOINT'S space, so ./yeti.ts can hand a part straight to a joint's mesh and the
 * solver can put it back in rig space by adding one offset.
 */
export function yetiParts(spec: YetiVariantSpec): YetiBody {
  const parts: YetiPart[] = [];
  const coatShells = (length: number): YetiShells => ({
    length: spec.coatLength * length,
    layers: spec.shellLayers,
  });

  const torsoLength = spec.shoulderHeight - spec.hipHeight;
  const shoulderForward = Math.sin(spec.hunch) * torsoLength;
  const shoulderHeight = spec.hipHeight + Math.cos(spec.hunch) * torsoLength;

  const coat = (
    joint: YetiJoint,
    side: number,
    center: YetiPoint,
    radii: YetiPoint,
    size: YetiPartSize,
    options: { surface?: YetiSurface; coatLength?: number; tilt?: number } = {},
  ): void => {
    parts.push({
      kind: 'mass',
      joint,
      side,
      surface: options.surface ?? 'coat',
      size,
      shells: coatShells(options.coatLength ?? 1),
      center,
      radii,
      tilt: options.tilt ?? 0,
    });
  };

  const bare = (
    joint: YetiJoint,
    side: number,
    surface: YetiSurface,
    center: YetiPoint,
    radii: YetiPoint,
    size: YetiPartSize,
  ): void => {
    parts.push({ kind: 'mass', joint, side, surface, size, shells: null, center, radii, tilt: 0 });
  };

  /** A furred segment plus the two joint balls that close its ends. */
  const limb = (
    joint: YetiJoint,
    side: number,
    from: YetiPoint,
    to: YetiPoint,
    rootRadius: number,
    tipRadius: number,
    coatLength: number,
  ): void => {
    parts.push({
      kind: 'limb',
      joint,
      side,
      surface: 'coat',
      size: 'limb',
      shells: coatShells(coatLength),
      from,
      to,
      rootRadius,
      tipRadius,
    });
    for (const [at, radius] of [
      [from, rootRadius],
      [to, tipRadius],
    ] as const) {
      parts.push({
        kind: 'mass',
        joint,
        side,
        surface: 'coat',
        size: 'joint',
        shells: null,
        center: at,
        radii: {
          forward: radius * JOINT_BALL_IN_LIMB,
          height: radius * JOINT_BALL_IN_LIMB,
          lateral: radius * JOINT_BALL_IN_LIMB,
        },
        tilt: 0,
      });
    }
  };

  // ── The trunk ──────────────────────────────────────────────────────────────
  coat('upper', 0, point(0, spec.hipHeight, 0), spec.hipRadii, 'trunk');
  const midHeight = spec.hipHeight + torsoLength * 0.45;
  const midForward = Math.sin(spec.hunch) * torsoLength * 0.45;
  coat(
    'upper',
    0,
    point(midForward + spec.bellyOut, midHeight, 0),
    { ...spec.bellyRadii, height: torsoLength * 0.55 },
    'trunk',
  );
  coat(
    'upper',
    0,
    point(
      shoulderForward + spec.chestOut,
      shoulderHeight - spec.chestRadii.height * 0.35,
      0,
    ),
    spec.chestRadii,
    'trunk',
    { tilt: spec.hunch },
  );
  for (const side of SIDES) {
    coat(
      'upper',
      side,
      point(shoulderForward, shoulderHeight, side * spec.shoulderHalfSpan),
      {
        forward: spec.shoulderRadius,
        height: spec.shoulderRadius * 0.9,
        lateral: spec.shoulderRadius,
      },
      'trunk',
    );
  }
  if (spec.saddle !== 0) {
    coat(
      'upper',
      0,
      point(
        shoulderForward + spec.chestOut - spec.chestRadii.forward * SADDLE_BEHIND_CHEST,
        shoulderHeight - torsoLength * SADDLE_DROP_OF_TORSO,
        0,
      ),
      {
        forward: spec.chestRadii.forward * SADDLE_DEPTH_OF_CHEST,
        height: torsoLength * SADDLE_LENGTH_OF_TORSO,
        lateral: spec.chestRadii.lateral * SADDLE_WIDTH_OF_CHEST,
      },
      'trunk',
      { surface: 'saddle', coatLength: SADDLE_COAT_LENGTH },
    );
  }

  // ── Neck and head ──────────────────────────────────────────────────────────
  //
  // THE NECK IS THE OWNER'S FIRST NOTE (2026-08-26): the head centre used to sit
  // BELOW the shoulder mass, which is not a low-slung head, it is no neck at
  // all. It sits on a short thick column ahead of the shoulders now, and
  // `headDrop` is what carries it forward rather than sinking it.
  const skull = spec.skull;
  const headHeight =
    shoulderHeight + spec.neckLength * Math.cos(spec.hunch + spec.headDrop);
  const headForward =
    shoulderForward + spec.neckLength * Math.sin(spec.hunch + spec.headDrop) + spec.headForward;
  limb(
    'head',
    0,
    point(shoulderForward, shoulderHeight, 0),
    point(headForward, headHeight, 0),
    spec.neckRadius,
    spec.neckRadius * 0.9,
    1,
  );
  coat('head', 0, point(headForward, headHeight, 0), skull, 'head', {
    coatLength: HEAD_COAT_LENGTH,
  });
  if (spec.crest !== 0) {
    coat(
      'head',
      0,
      point(
        headForward - skull.forward * 0.15,
        headHeight + skull.height * CREST_HEIGHT_IN_SKULL,
        0,
      ),
      {
        forward: skull.forward * CREST_RADII_IN_SKULL.forward,
        height: skull.height * spec.crest,
        lateral: skull.lateral * CREST_RADII_IN_SKULL.lateral,
      },
      'head',
      { coatLength: CREST_COAT_LENGTH },
    );
  }
  coat(
    'head',
    0,
    point(
      headForward + skull.forward * BROW_FORWARD_IN_SKULL,
      headHeight + skull.height * BROW_HEIGHT_IN_SKULL,
      0,
    ),
    {
      forward: skull.forward * BROW_RADII_IN_SKULL.forward,
      height: skull.height * BROW_RADII_IN_SKULL.height,
      lateral: skull.lateral * BROW_RADII_IN_SKULL.lateral,
    },
    'feature',
    { coatLength: BROW_COAT_LENGTH },
  );

  // ── The face, all of it measured from the plate ────────────────────────────
  const faceForward = headForward + skull.forward * 0.78;
  bare(
    'head',
    0,
    'face',
    point(
      headForward + skull.forward * FACE_PLATE_FORWARD_IN_SKULL,
      headHeight + skull.height * FACE_PLATE_HEIGHT_IN_SKULL,
      0,
    ),
    {
      forward: skull.forward * FACE_PLATE_DEPTH_IN_SKULL,
      height: skull.height * FACE_PLATE_HEIGHT_RADIUS_IN_SKULL,
      lateral: skull.lateral * spec.faceWidth,
    },
    'feature',
  );

  const muzzleHeight = headHeight + skull.height * MUZZLE_HEIGHT_IN_SKULL;
  const muzzleForward = faceForward + skull.forward * spec.muzzleOut;
  const muzzleRadii = {
    forward: skull.forward * MUZZLE_RADII_IN_SKULL.forward,
    height: skull.height * MUZZLE_RADII_IN_SKULL.height,
    lateral: skull.lateral * MUZZLE_RADII_IN_SKULL.lateral,
  };
  const muzzleCenter = point(muzzleForward - skull.forward * 0.1, muzzleHeight, 0);
  if (spec.muzzleFur) {
    coat('head', 0, muzzleCenter, muzzleRadii, 'feature', { coatLength: MUZZLE_COAT_LENGTH });
  } else {
    bare('head', 0, 'face', muzzleCenter, muzzleRadii, 'feature');
  }
  bare(
    'head',
    0,
    'nose',
    point(muzzleForward + skull.forward * 0.3, muzzleHeight + skull.height * 0.1, 0),
    {
      forward: skull.forward * NOSE_RADII_IN_SKULL.forward,
      height: skull.height * NOSE_RADII_IN_SKULL.height,
      lateral: skull.lateral * NOSE_RADII_IN_SKULL.lateral,
    },
    'feature',
  );
  bare(
    'head',
    0,
    'maw',
    point(muzzleForward + skull.forward * 0.2, muzzleHeight - skull.height * 0.2, 0),
    {
      forward: skull.forward * MOUTH_RADII_IN_SKULL.forward,
      height: skull.height * MOUTH_RADII_IN_SKULL.height,
      lateral: skull.lateral * MOUTH_RADII_IN_SKULL.lateral,
    },
    'feature',
  );
  const jawCenter = point(
    muzzleForward - skull.forward * 0.22,
    muzzleHeight - skull.height * 0.36,
    0,
  );
  const jawRadii = {
    forward: skull.forward * JAW_RADII_IN_SKULL.forward,
    height: skull.height * JAW_RADII_IN_SKULL.height,
    lateral: skull.lateral * JAW_RADII_IN_SKULL.lateral,
  };
  if (spec.muzzleFur) {
    coat('head', 0, jawCenter, jawRadii, 'feature', { coatLength: JAW_COAT_LENGTH });
  } else {
    bare('head', 0, 'face', jawCenter, jawRadii, 'feature');
  }

  for (const side of SIDES) {
    bare(
      'head',
      side,
      'eye',
      point(
        faceForward + skull.forward * EYE_FORWARD_IN_SKULL,
        headHeight + skull.height * EYE_HEIGHT_IN_SKULL,
        side * skull.lateral * EYE_LATERAL_IN_SKULL,
      ),
      {
        forward: skull.forward * EYE_RADII_IN_SKULL.forward,
        height: skull.height * EYE_RADII_IN_SKULL.height,
        lateral: skull.lateral * EYE_RADII_IN_SKULL.lateral,
      },
      'feature',
    );
    const glint = skull.lateral * GLINT_RADIUS_IN_SKULL;
    bare(
      'head',
      side,
      'glint',
      point(
        faceForward + skull.forward * GLINT_FORWARD_IN_SKULL,
        headHeight + skull.height * GLINT_HEIGHT_IN_SKULL,
        side * skull.lateral * GLINT_LATERAL_IN_SKULL,
      ),
      point(glint, glint, glint),
      'digit',
    );
  }

  if (spec.fangs !== 0) {
    for (const side of SIDES) {
      const lateral = side * skull.lateral * 0.22;
      // FORWARD OF THE LIP, not level with it. The jaw below is furred on the
      // two variants that have fangs and its shells stand a tenth of a skull
      // proud of it, so a canine rooted flush with the muzzle is a canine inside
      // a beard: the first pass had exactly that, and neither fanged variant
      // showed a tooth.
      const forward = muzzleForward + skull.forward * FANG_FORWARD_IN_SKULL;
      const height = muzzleHeight - skull.height * 0.16;
      parts.push({
        kind: 'sweep',
        joint: 'head',
        side,
        surface: 'ivory',
        size: 'digit',
        shells: null,
        path: [
          point(forward - 0.02, height + 0.02, lateral),
          point(forward + 0.01, height - spec.fangs * 0.6, lateral * 1.05),
          point(forward + 0.02, height - spec.fangs, lateral * 1.1),
        ],
        rootRadius: skull.lateral * 0.09,
        tipRadius: 0.004,
        taperPower: 1,
      });
    }
  }

  if (spec.horns !== 'none') {
    const finish = hornFinish(spec.horns);
    for (const side of SIDES) {
      const path =
        spec.horns === 'ram'
          ? ramHornPath(skull, side)
          : spec.horns === 'ibex'
            ? ibexHornPath(skull, side)
            : stubHornPath(skull, side);
      // THE BOSS: a fur-covered swelling of the skull that the horn is the
      // continuation of, merged into the head's own surface. Without it a horn
      // is a tube pushed through a ball, which is what an inserted prop is.
      const root = path[0]!;
      coat(
        'head',
        side,
        point(headForward + root.forward, headHeight + root.height, root.lateral),
        {
          forward: skull.forward * 0.22,
          height: skull.height * 0.16,
          lateral: skull.lateral * 0.24,
        },
        'feature',
      );
      parts.push({
        kind: 'sweep',
        joint: 'head',
        side,
        surface: 'horn',
        size: 'horn',
        shells: null,
        path: path.map((p) =>
          point(headForward + p.forward, headHeight + p.height, p.lateral),
        ),
        rootRadius: skull.lateral * finish.rootInSkull,
        tipRadius: finish.tip,
        taperPower: spec.horns === 'ram' ? 0.8 : 0.9,
      });
    }
  }

  // ── The arms ───────────────────────────────────────────────────────────────
  //
  // upper arm → elbow → forearm, with a real bend at the elbow: the owner's
  // third note was that these were straight tubes.
  const arm = spec.arm;
  const armJoint = point(
    shoulderForward,
    shoulderHeight - spec.shoulderRadius * 0.15,
    spec.shoulderHalfSpan,
  );
  for (const side of SIDES) {
    const shoulder = point(0, 0, 0);
    const elbow = point(
      arm.upper * Math.sin(arm.upperForward),
      -arm.upper * Math.cos(arm.upperForward),
      side * arm.elbowFlare,
    );
    let wristHeight = elbow.height - arm.fore * Math.cos(arm.foreForward);
    let wristForward = elbow.forward + arm.fore * Math.sin(arm.foreForward);
    if (spec.knuckle) {
      // KNUCKLE-WALKING: the fist rests on the ground, so the forearm's forward
      // reach is whatever a right triangle of the forearm's own length leaves
      // once the drop to ground level is taken out. Posed by eye, this is the
      // pose that floats a hand or drives it through the snow the moment any
      // other number in the spec moves.
      const groundHeight = arm.wristRadius * 1.1 - armJoint.height;
      const drop = Math.min(arm.fore * 0.98, elbow.height - groundHeight);
      wristHeight = elbow.height - drop;
      wristForward = elbow.forward + Math.sqrt(Math.max(0, arm.fore * arm.fore - drop * drop));
    }
    const wrist = point(wristForward, wristHeight, elbow.lateral + side * arm.wristFlare);

    limb('arm', side, shoulder, elbow, arm.shoulderRadius, arm.elbowRadius, ARM_COAT_LENGTH);
    limb('arm', side, elbow, wrist, arm.elbowRadius, arm.wristRadius, ARM_COAT_LENGTH);

    // The hand: a bare palm, four fingers and a thumb. Rolled under into a fist
    // on a knuckle-walker, hanging open otherwise.
    const curl = spec.knuckle ? FINGER_CURL_WALKING : FINGER_CURL_HANGING;
    bare(
      'arm',
      side,
      'hide',
      point(
        wrist.forward + arm.wristRadius * 0.3,
        wrist.height - arm.wristRadius * 0.6,
        wrist.lateral,
      ),
      {
        forward: arm.wristRadius * 1.5,
        height: arm.wristRadius * 0.75,
        lateral: arm.wristRadius * 1.25,
      },
      'limb',
    );
    const middle = (spec.fingers - 1) / 2;
    for (let finger = 0; finger < spec.fingers; finger++) {
      const lateral =
        wrist.lateral + side * (finger - middle) * arm.wristRadius * FINGER_SPREAD_IN_WRIST;
      const rootForward = wrist.forward + arm.wristRadius * 1.5;
      const rootHeight = wrist.height - arm.wristRadius * 0.75;
      parts.push({
        kind: 'sweep',
        joint: 'arm',
        side,
        surface: 'hide',
        size: 'digit',
        shells: null,
        path: [
          point(rootForward, rootHeight, lateral),
          point(
            rootForward + arm.wristRadius * 0.55 * (1 - curl * 0.6),
            rootHeight - arm.wristRadius * 0.5 * curl,
            lateral,
          ),
          point(
            rootForward + arm.wristRadius * 0.75 * (1 - curl * 0.7),
            rootHeight - arm.wristRadius * 1.05 * curl,
            lateral,
          ),
        ],
        rootRadius: arm.wristRadius * FINGER_ROOT_RADIUS_IN_WRIST,
        tipRadius: arm.wristRadius * FINGER_TIP_RADIUS_IN_WRIST,
        taperPower: 1,
      });
    }
    const thumb = arm.wristRadius * THUMB_RADIUS_IN_WRIST;
    bare(
      'arm',
      side,
      'hide',
      point(
        wrist.forward + arm.wristRadius * 0.7,
        wrist.height - arm.wristRadius * 0.5,
        wrist.lateral + side * arm.wristRadius * 1.15,
      ),
      { forward: thumb * 2, height: thumb, lateral: thumb },
      'digit',
    );
  }

  // ── The legs ───────────────────────────────────────────────────────────────
  //
  // thigh → knee → shin, with the haunch mass that holds the leg into the hips,
  // and a plantigrade foot whose sole is FLAT: it is the surface the client's
  // placement maths puts on the ground.
  const leg = spec.leg;
  const legJoint = point(0, spec.hipHeight - spec.hipRadii.height * 0.15, spec.stanceHalfWidth);
  for (const side of SIDES) {
    const hip = point(0, 0, 0);
    const knee = point(
      leg.thigh * Math.sin(leg.thighForward),
      -leg.thigh * Math.cos(leg.thighForward),
      side * leg.kneeFlare,
    );
    const ankle = point(
      knee.forward - leg.shin * Math.sin(leg.shinForward),
      knee.height - leg.shin * Math.cos(leg.shinForward),
      knee.lateral,
    );
    // The haunch, centred on the joint's own origin — which is the whole trick:
    // a body centred on the pivot is unmoved by a rotation about it, so the
    // limb's root ring is swallowed identically at every point of the stride.
    coat(
      'leg',
      side,
      point(0, -leg.thigh * 0.2, 0),
      {
        forward: leg.hipRadius * 1.5,
        height: leg.thigh * 0.55,
        lateral: leg.hipRadius * 1.45,
      },
      'trunk',
    );
    limb('leg', side, hip, knee, leg.hipRadius, leg.kneeRadius, 1);
    limb('leg', side, knee, ankle, leg.kneeRadius, leg.ankleRadius, 1);

    // In ANKLE space: the sole sits on the ground plane, so the foot's own
    // height is measured from there rather than from the ankle.
    const soleHeight = leg.footHeight / 2 - (legJoint.height + ankle.height);
    bare(
      'ankle',
      side,
      'hide',
      point(leg.footLength * 0.28, soleHeight, 0),
      {
        forward: leg.footLength * 0.55,
        height: leg.footHeight / 2,
        lateral: leg.footWidth,
      },
      'limb',
    );
    const middleToe = (TOE_COUNT - 1) / 2;
    for (let toe = 0; toe < TOE_COUNT; toe++) {
      const spread = toe - middleToe;
      bare(
        'ankle',
        side,
        'hide',
        point(
          leg.footLength * 0.78 - Math.abs(spread) * leg.footLength * 0.06,
          soleHeight - leg.footHeight / 2 + leg.footHeight * 0.38,
          side * spread * leg.footWidth * TOE_SPREAD_IN_FOOT,
        ),
        {
          forward: leg.footLength * TOE_RADII_IN_FOOT.forward,
          height: leg.footHeight * TOE_RADII_IN_FOOT.height,
          lateral: leg.footWidth * TOE_RADII_IN_FOOT.lateral,
        },
        'digit',
      );
    }
    // Fur over the top of the foot, so the ankle is not a bare stump.
    coat(
      'ankle',
      side,
      point(
        leg.footLength * 0.05,
        soleHeight + leg.footHeight / 2 + leg.ankleRadius * 0.3,
        0,
      ),
      {
        forward: leg.ankleRadius * 1.3,
        height: leg.ankleRadius * 0.6,
        lateral: leg.ankleRadius * 1.1,
      },
      'limb',
    );
  }

  // The ankle's rest offset inside the LEG's space. Stated for his left side,
  // as the other two joints are; the builder and the solver mirror it.
  const ankleJoint = point(
    leg.thigh * Math.sin(leg.thighForward) - leg.shin * Math.sin(leg.shinForward),
    -(leg.thigh * Math.cos(leg.thighForward) + leg.shin * Math.cos(leg.shinForward)),
    leg.kneeFlare,
  );

  return { parts, joints: { leg: legJoint, ankle: ankleJoint, arm: armJoint } };
}

// ── The solver: how tall, and how wide ───────────────────────────────────────

/**
 * The lean, in radians — ~3°, one roll per gait cycle. It is here rather than in
 * the gait block below because the WIDTH solve needs it: a roll about the
 * forward axis is the one thing in the animation that can push a shoulder or a
 * hand further from the axis than the rest pose does.
 *
 * IT IS APPLIED TO THE UPPER BODY ONLY — never to the whole model — which is a
 * placement decision: rolling the rig would take the outer foot below the ground
 * plane the client just placed him on, every cycle, forever.
 */
export const YETI_LEAN_RADIANS = 0.05;

/**
 * One STEP, as a fraction of the leg that takes it. Humans stride about half a
 * leg; a heavy short-legged animal picking its way over snow takes less.
 *
 * THE STRIDE IS PER VARIANT because the four have different legs — a length
 * shared between them would have one of them skating — but the ANGLE that comes
 * out of it is not: half a step over a leg is this fraction over two, whatever
 * the leg. That the swing falls out scale-free is the sign the derivation is the
 * right way round.
 */
const STEP_OF_LEG_LENGTH = 0.39;

/**
 * Peak swing of a leg either side of vertical, in radians. DERIVED from the
 * stride above: 11°.
 *
 * WHY THE ANIMATION PLAYS EVEN WHEN HE IS STANDING STILL. The wire carries no
 * gait flag — deliberately, see protocol.ts — so this cycle runs off elapsed
 * time whatever he is doing. At 11° that reads as an animal shifting its weight
 * from foot to foot when stationary and as a walk when he is travelling, which
 * is the honest best a gait with no gait signal can do. An amplitude tuned for a
 * convincing WALK (25–30°, as a human's) would have made a stationary yeti look
 * like he was marching on the spot.
 */
export const YETI_LEG_SWING_RADIANS = Math.asin(STEP_OF_LEG_LENGTH / 2);

/**
 * Arm swing, as a fraction of the leg's. Arms swing opposite the leg on the same
 * side — that is what a contralateral gait is — and less far, because his are
 * heavy and hang from a shoulder doing most of the work of holding him up.
 */
export const YETI_ARM_SWING_FRACTION = 0.7;
export const YETI_ARM_SWING_RADIANS = YETI_LEG_SWING_RADIANS * YETI_ARM_SWING_FRACTION;

/** A part's extreme in each axis, in its joint's space, shells included. */
interface PartBound {
  readonly topHeight: number;
  readonly lateral: number;
  /** How far fore or aft of its joint the part reaches — what a swing trades
   *  for height, and therefore what the lean can then trade for width. */
  readonly forwardExtent: number;
}

function boundOf(part: YetiPart): PartBound {
  const grow = part.shells === null ? 1 : 1 + part.shells.length;
  let topHeight = -Infinity;
  let lateral = 0;
  let forwardExtent = 0;
  const consider = (at: YetiPoint, radius: YetiPoint): void => {
    topHeight = Math.max(topHeight, at.height + radius.height);
    lateral = Math.max(lateral, Math.abs(at.lateral) + radius.lateral);
    forwardExtent = Math.max(forwardExtent, Math.abs(at.forward) + radius.forward);
  };
  if (part.kind === 'mass') {
    // A tilt about the lateral axis mixes forward into height, and the exact
    // extent of the turned ellipsoid is its SUPPORT in that direction — not the
    // hypotenuse of the two radii, which is what the first pass used and which
    // is wrong by enough to matter: on the deep-hunched silverback it made a
    // tilted chest the tallest thing on the animal and shrank the whole body by
    // 5% to keep a chest that is nowhere near his crown under the ceiling.
    const height =
      part.tilt === 0
        ? part.radii.height
        : Math.hypot(
            part.radii.height * Math.cos(part.tilt),
            part.radii.forward * Math.sin(part.tilt),
          );
    consider(part.center, scalePoint({ ...part.radii, height }, grow));
  } else if (part.kind === 'limb') {
    const root = part.rootRadius * grow;
    const tip = part.tipRadius * grow;
    consider(part.from, point(root, root, root));
    consider(part.to, point(tip, tip, tip));
  } else {
    const radius = Math.max(part.rootRadius, part.tipRadius) * grow;
    for (const at of part.path) consider(at, point(radius, radius, radius));
  }
  return { topHeight, lateral, forwardExtent };
}

/** Where a joint rests in RIG space — what a part's own bound is measured from. */
function jointOrigin(body: YetiBody, part: YetiPart): YetiPoint {
  if (part.joint === 'leg') {
    return point(body.joints.leg.forward, body.joints.leg.height, part.side * body.joints.leg.lateral);
  }
  if (part.joint === 'ankle') {
    return point(
      body.joints.leg.forward + body.joints.ankle.forward,
      body.joints.leg.height + body.joints.ankle.height,
      part.side * (body.joints.leg.lateral + body.joints.ankle.lateral),
    );
  }
  if (part.joint === 'arm') {
    return point(body.joints.arm.forward, body.joints.arm.height, part.side * body.joints.arm.lateral);
  }
  return point(0, 0, 0);
}

/**
 * The two bounds the rest of the codebase asks this file for, in the spec's own
 * units: how high the animal reaches, and how far from its axis.
 *
 * THE HEIGHT is the rest pose's, because the only thing the gait does to it is
 * the BOB, which lifts the whole animal off a ground plane rather than growing
 * him.
 *
 * THE WIDTH IS A BOUND OVER EVERY POSE THE GAIT CAN TAKE, not the rest pose's
 * width, and it is built out of the two rotations that exist:
 *
 *   * a SWING about the lateral axis, which trades a part's forward reach for
 *     height (an arm swung forward is a hand held higher);
 *   * the LEAN about the forward axis, which then trades that height for lateral
 *     reach — the one motion on this animal that can put a hand outside the
 *     square the server probed.
 *
 * Both are taken at their peaks at once, which the animation never actually does
 * — the lean is a cosine and the swing a sine of the same wave, so they are a
 * quarter cycle apart — making this a strict upper bound rather than a measured
 * worst case. The LEGS are excluded from the lean for the reason
 * YETI_LEAN_RADIANS gives: it is applied above the hips only.
 */
function solveBounds(body: YetiBody): { apex: number; reach: number } {
  let apex = 0;
  let reach = 0;
  for (const part of body.parts) {
    const bound = boundOf(part);
    const origin = jointOrigin(body, part);
    apex = Math.max(apex, origin.height + bound.topHeight);
    const lateral = Math.abs(origin.lateral) + bound.lateral;
    if (part.joint === 'leg' || part.joint === 'ankle') {
      reach = Math.max(reach, lateral);
      continue;
    }
    const swing = part.joint === 'arm' ? YETI_ARM_SWING_RADIANS : 0;
    const swungTop =
      origin.height +
      bound.topHeight * Math.cos(swing) +
      bound.forwardExtent * Math.sin(swing);
    reach = Math.max(
      reach,
      lateral * Math.cos(YETI_LEAN_RADIANS) + swungTop * Math.sin(YETI_LEAN_RADIANS),
    );
  }
  return { apex, reach };
}

// ── The gait, shared by all four ─────────────────────────────────────────────

/**
 * The server's amble speed, restated (server/kinds.ts,
 * YETI_AMBLE_SPEED_CELLS_PER_SECOND) and pinned to it by a test — world units
 * per second, where the server's copy is cells per second.
 *
 * WRITTEN OUT RATHER THAN DERIVED, unlike everything else in this block, and the
 * pin is why: the two halves compare with `toBe`, and a product of his height
 * and a rounded fraction lands a bit or two away from the literal over there. It
 * works out at 6.5% of his height per second — he covers his own width in about
 * eleven seconds, whichever body was rolled, which is the comparison that
 * justified the number (owner decision, 2026-08-22: a speed is a LENGTH per
 * second, so a smaller animal is a slower one).
 */
export const YETI_AMBLE_SPEED_CELLS_PER_SECOND = 0.08110465116279071;

/**
 * Vertical bob, as a fraction of his height: one per STEP, twice per cycle.
 *
 * IT ONLY EVER LIFTS — the same inward-only discipline the carve keeps, at the
 * other end of the model: the client puts his origin exactly on the ground, so a
 * bob that went negative would sink his feet into the snow half of every step.
 */
const BOB_OF_HEIGHT = 0.00872;
export const YETI_BOB_CELLS = BOB_OF_HEIGHT * YETI_TOTAL_HEIGHT;

/**
 * The head scans on its own unrelated clock, so the two motions never lock into
 * a pattern a player can feel repeating. 0.09 Hz is an eleven-second sweep;
 * ±0.14 rad (8°) is a look, not a search.
 */
export const YETI_HEAD_SCAN_HZ = 0.09;
export const YETI_HEAD_SCAN_RADIANS = 0.14;

// ── What one variant works out to, in world units ────────────────────────────

/**
 * Everything about one variant that is not a part: the scale that puts it on the
 * owner's ceiling, the bounds that fall out of it, and the gait derived from its
 * own legs.
 */
export interface YetiMetrics {
  /** The factor from spec units to world units. SOLVED, never chosen. */
  readonly scale: number;
  /** Ground to the highest point of THIS variant — the ceiling, exactly. */
  readonly totalHeight: number;
  /** How far this body may reach from its own axis, in any pose. */
  readonly reachFromAxis: number;
  /** Twice the above: what the server steers as a footprint. */
  readonly width: number;
  /** Half-extent of the ground his FEET cover — what ./placement.ts samples. */
  readonly footGroundHalfExtent: number;

  readonly hipHeight: number;
  readonly headCenterHeight: number;
  /** The skull's largest semi-axis — what a head-shot is framed on. */
  readonly headRadius: number;
  readonly hipsWidth: number;
  readonly legLength: number;
  readonly handHeight: number;

  /** Rest offsets of the animated joints, world units. */
  readonly legJoint: YetiPoint;
  readonly ankleHeight: number;
  readonly armJoint: YetiPoint;

  /** Ground covered by one full gait cycle (two steps). */
  readonly strideCells: number;
  /** Gait cycles per second: speed over stride, so his feet never skate. */
  readonly ambleHz: number;
  readonly legSwingRadians: number;
  readonly armSwingRadians: number;
}

function metricsOf(spec: YetiVariantSpec): YetiMetrics {
  const body = yetiParts(spec);
  const { apex, reach } = solveBounds(body);
  const scale = YETI_TOTAL_HEIGHT / apex;

  const torsoLength = spec.shoulderHeight - spec.hipHeight;
  const headHeight =
    spec.hipHeight +
    Math.cos(spec.hunch) * torsoLength +
    spec.neckLength * Math.cos(spec.hunch + spec.headDrop);
  // The ankle, in the leg joint's space: the shin's far end.
  const ankleDrop =
    spec.leg.thigh * Math.cos(spec.leg.thighForward) +
    spec.leg.shin * Math.cos(spec.leg.shinForward);
  const legLength = ankleDrop * scale;
  const strideCells = 2 * STEP_OF_LEG_LENGTH * legLength;
  // The hand, at rest: the wrist's drop below the shoulder joint.
  const handDrop =
    spec.arm.upper * Math.cos(spec.arm.upperForward) +
    spec.arm.fore * Math.cos(spec.arm.foreForward);
  const legJoint = scalePoint(body.joints.leg, scale);

  return {
    scale,
    totalHeight: apex * scale,
    reachFromAxis: reach * scale,
    width: 2 * reach * scale,
    footGroundHalfExtent: (spec.stanceHalfWidth + spec.leg.footWidth) * scale,
    hipHeight: spec.hipHeight * scale,
    headCenterHeight: headHeight * scale,
    headRadius:
      Math.max(spec.skull.forward, spec.skull.height, spec.skull.lateral) * scale,
    hipsWidth: 2 * spec.hipRadii.lateral * scale,
    legLength,
    handHeight: (spec.shoulderHeight - spec.shoulderRadius * 0.15 - handDrop) * scale,
    legJoint,
    ankleHeight: legJoint.height - legLength,
    armJoint: scalePoint(body.joints.arm, scale),
    strideCells,
    ambleHz: YETI_AMBLE_SPEED_CELLS_PER_SECOND / strideCells,
    legSwingRadians: YETI_LEG_SWING_RADIANS,
    armSwingRadians: YETI_ARM_SWING_RADIANS,
  };
}

/** One solved body per variant, built once at module load. */
export const YETI_VARIANT_METRICS: Readonly<Record<YetiVariant, YetiMetrics>> = {
  silverback: metricsOf(YETI_VARIANT_SPECS.silverback),
  ram: metricsOf(YETI_VARIANT_SPECS.ram),
  ibex: metricsOf(YETI_VARIANT_SPECS.ibex),
  fanged: metricsOf(YETI_VARIANT_SPECS.fanged),
};

/**
 * The parts of one variant, IN WORLD UNITS — what ./yeti.ts builds. Solved once
 * per variant at module load, from the same description the bounds came from.
 */
export function yetiWorldParts(variant: YetiVariant): YetiBody {
  const body = yetiParts(YETI_VARIANT_SPECS[variant]);
  const scale = YETI_VARIANT_METRICS[variant].scale;
  const scaleRadii = (p: YetiPoint): YetiPoint => scalePoint(p, scale);
  return {
    parts: body.parts.map((part): YetiPart => {
      if (part.kind === 'mass') {
        return { ...part, center: scaleRadii(part.center), radii: scaleRadii(part.radii) };
      }
      if (part.kind === 'limb') {
        return {
          ...part,
          from: scaleRadii(part.from),
          to: scaleRadii(part.to),
          rootRadius: part.rootRadius * scale,
          tipRadius: part.tipRadius * scale,
        };
      }
      return {
        ...part,
        path: part.path.map(scaleRadii),
        rootRadius: part.rootRadius * scale,
        tipRadius: part.tipRadius * scale,
      };
    }),
    joints: {
      leg: scaleRadii(body.joints.leg),
      ankle: scaleRadii(body.joints.ankle),
      arm: scaleRadii(body.joints.arm),
    },
  };
}

// ── The contract with the server ─────────────────────────────────────────────

/**
 * The widest extent of EACH variant, keyed by the name on the wire.
 *
 * DERIVED, not stated: it is the solver's answer over that variant's own parts,
 * so a mass that moves changes this number without anybody remembering to.
 *
 * WHY ONE FOOTPRINT AND NOT FOUR ON THE WIRE. The server's footprint feeds the
 * steering look-ahead and the minimum lair size — both decided before and
 * independently of which body was rolled — and a per-variant lair requirement
 * would mean a snowfield that can host a yeti only if the dice agree. One
 * conservative number (the widest) keeps every variant's steering honest and
 * every qualifying mountain habitable.
 */
export const YETI_VARIANT_WIDTH_CELLS: Readonly<Record<YetiVariant, number>> = {
  silverback: YETI_VARIANT_METRICS.silverback.width,
  ram: YETI_VARIANT_METRICS.ram.width,
  ibex: YETI_VARIANT_METRICS.ibex.width,
  fanged: YETI_VARIANT_METRICS.fanged.width,
};

/**
 * The broadest variant there is — the number the SERVER's YETI_FOOTPRINT_CELLS
 * is pinned to.
 *
 * A max over the table rather than a restatement, so it cannot be left behind
 * when a model turns out wider than the one before it: the pin test then fails
 * against the server's literal, which is exactly the moment somebody must decide
 * whether to widen the server's footprint or narrow the model.
 */
export const YETI_WIDEST_VARIANT_WIDTH_CELLS = Math.max(
  ...YETI_VARIANTS.map((variant) => YETI_VARIANT_WIDTH_CELLS[variant]),
);

/** Kept for the callers that ask "how wide is a yeti" with no variant in hand. */
export const YETI_WIDTH_CELLS = YETI_WIDEST_VARIANT_WIDTH_CELLS;

/**
 * Half-extent of the ground his FEET cover, in WORLD UNITS — what the client
 * samples terrain over to decide which band he stands on (./placement.ts).
 *
 * THE WIDEST VARIANT'S, for the same reason the footprint is: placement runs off
 * a rule looked up by KIND, before a variant is in hand, and the safe direction
 * to err in is standing a fraction too high rather than clipping a riser.
 *
 * It is the FEET and not the body, and that distinction is the whole content of
 * the number: a walker stands on what it steps on. Sampling the shoulders
 * instead would have him ride up onto every band his elbow overhangs.
 */
export const YETI_FOOT_GROUND_HALF_EXTENT = Math.max(
  ...YETI_VARIANTS.map((variant) => YETI_VARIANT_METRICS[variant].footGroundHalfExtent),
);
