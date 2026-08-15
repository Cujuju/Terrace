// The dread around the monster, as numbers and as timing maths.
//
// WHAT THIS FILE IS FOR, and why it is not simply inside atmosphere.ts: the same
// split anatomy.ts/models.ts already uses. Everything here is a pure function of
// numbers — how long until the next lightning strike, how bright a strike is
// this many milliseconds in, how far a fade has travelled — so a node test can
// read it without importing three (this project ships no headless GL rig,
// design §8). atmosphere.ts owns the meshes and the resolution they are built
// at; this file owns every value that decides how the effect BEHAVES.
//
// PRESENTATION ONLY, AND CLIENT-ONLY. Nothing here is on the wire and nothing
// here is authoritative: the whole effect is driven by the monster state the
// client already receives plus elapsed time. Two players watching the same
// monster see the same mist and DIFFERENT bolts, deliberately — see
// createStrikeRandom.
//
// UNITS: cells (== world units, CELL_WORLD_SIZE is 1) and seconds.

import {
  CTHULHU_EYE_HEIGHT,
  CTHULHU_LURK_DEPTH,
  CTHULHU_TOTAL_HEIGHT,
  CTHULHU_WIDTH_CELLS,
} from './anatomy.ts';

const TWO_PI = Math.PI * 2;

// ── The mist bank ────────────────────────────────────────────────────────────

/**
 * How much of the silhouette stands above the water when the monster is at its
 * lurking depth — the vertical space the whole effect has to work in.
 *
 * Derived rather than measured, so retuning the anatomy or the lurk depth moves
 * the mist and the bolts with it instead of leaving them at heights that used to
 * be right. ~4.3 cells today.
 */
export const SILHOUETTE_ABOVE_WATER_CELLS = CTHULHU_TOTAL_HEIGHT - CTHULHU_LURK_DEPTH;

/**
 * Height of the eyes above the water at the lurking depth — the ceiling on the
 * mist, not a tuning value.
 *
 * The eyes are the one thing on the model that emits, and the face is the whole
 * reason the model has 18k triangles. A mist bank that drifted over them would
 * be atmosphere bought by hiding the thing the atmosphere is about. A test pins
 * the topmost mist layer (plus its bob) below this line.
 */
export const EYE_HEIGHT_ABOVE_WATER_CELLS = CTHULHU_EYE_HEIGHT - CTHULHU_LURK_DEPTH;

/**
 * Radius of the mist bank, in cells.
 *
 * Stated as a multiple of the footprint the server steers by (7 cells) so the
 * mist stays proportional to the creature if either is retuned. 1.2 footprints
 * — a bank that reads as weather AROUND the monster rather than as a collar on
 * it, while still being local: at ~8.4 cells it covers a fifth of the width of
 * even a small world, so it can never read as scene-wide fog.
 */
export const MIST_SPREAD_FOOTPRINTS = 1.2;
export const MIST_RADIUS_CELLS = CTHULHU_WIDTH_CELLS * MIST_SPREAD_FOOTPRINTS;

/**
 * Cold, desaturated, and LIGHTER than the sea it lies on (the water is 0x2f6f9e,
 * render/water.ts). Not white: white mist over blue water reads as cloud, and
 * this is meant to read as something the water is giving off.
 */
export const MIST_COLOR = 0x9fb2ad;

/** One horizontal sheet of mist. Three of them stack into a bank. */
export interface MistLayerSpec {
  /** Height above the sea surface, in cells, before the bob. */
  readonly height: number;
  /** Radius as a fraction of MIST_RADIUS_CELLS. */
  readonly radiusScale: number;
  /** Peak alpha, reached only when the fade envelope is fully in. */
  readonly opacity: number;
  /**
   * Turns per second about the vertical, signed. Slow enough to be invisible
   * frame to frame and only noticeable over tens of seconds — the same rule the
   * idle animation follows (anatomy.ts: "fast idles are what make a monster look
   * like a toy").
   */
  readonly spinHz: number;
  /** Vertical bob amplitude in cells, and its rate in cycles per second. */
  readonly bobCells: number;
  readonly bobHz: number;
}

/**
 * THE BANK: three sheets, lowest and widest at the waterline, thinning and
 * narrowing upward, all of them below the eyes.
 *
 * Layered sheets rather than a volumetric shader on purpose: three transparent
 * discs of a few hundred vertices cost nothing to draw and nothing to author,
 * and the parallax between sheets at different heights and different spin rates
 * is what actually sells volume to a moving camera. A raymarched volume would
 * buy a better still frame for a fragment-shader cost paid over the whole
 * silhouette, every frame, on one decorative effect.
 *
 * The three spin rates are mutually non-multiple (and counter-rotating), so the
 * sheets never realign into one apparent slab; the same is true of the bob
 * rates. Periods are 50 s, 32 s and 23 s — the whole bank never repeats inside
 * any plausible look.
 */
export const MIST_LAYERS: readonly MistLayerSpec[] = [
  { height: 0.15, radiusScale: 1, opacity: 0.22, spinHz: 0.02, bobCells: 0.06, bobHz: 0.05 },
  { height: 0.65, radiusScale: 0.85, opacity: 0.16, spinHz: -0.031, bobCells: 0.1, bobHz: 0.037 },
  { height: 1.25, radiusScale: 0.66, opacity: 0.11, spinHz: 0.043, bobCells: 0.14, bobHz: 0.029 },
];

/**
 * How irregular a sheet's outline is, as a fraction of its radius, and the two
 * lobe counts that make it so.
 *
 * A perfect circle of haze reads as a targeting decal. Two sine lobes at coprime
 * counts (3 and 5) never repeat inside one turn, which is what makes the outline
 * look torn rather than stamped. Deterministic — this is the SHAPE of the mist,
 * not the weather, and every client should tear it identically.
 */
export const MIST_EDGE_WOBBLE = 0.18;
export const MIST_EDGE_LOBES_A = 3;
export const MIST_EDGE_LOBES_B = 5;
/** Phases, so the two lobe sets do not both peak on the +X axis. */
export const MIST_EDGE_PHASE_A = 0.7;
export const MIST_EDGE_PHASE_B = 2.3;

/**
 * Falloff exponent of a sheet's alpha from its centre to its rim.
 *
 * alpha(u) = (1 - u²)^k. k = 1.8 gives a broad soft core and a rim that reaches
 * zero smoothly, so no sheet ever shows an edge; k = 1 leaves a visible disc
 * boundary and large k shrinks the bank to a dot at its centre.
 */
export const MIST_EDGE_SOFTNESS = 1.8;

/**
 * Seconds for the bank to fade fully in on spawn, or fully out on despawn.
 *
 * Long enough to read as weather gathering rather than as a mesh appearing;
 * short enough that a banished monster does not leave a bank hanging over empty
 * water long enough to be a question. It also sits well above the 1 Hz broadcast
 * interval, so nothing about the fade can be driven by, or aliased against,
 * message arrival.
 */
export const MIST_FADE_SECONDS = 2.5;

// ── Lightning ────────────────────────────────────────────────────────────────

/**
 * Mean interval between strikes, in seconds.
 *
 * "Occasional" is the whole brief: the flash has to be an event, not a rhythm.
 * At 11 s a player who watches the monster for half a minute sees two or three,
 * and one who glances at it usually sees none — which is the difference between
 * dread and a light show.
 */
export const MEAN_FLASH_INTERVAL_SECONDS = 11;

/**
 * PHOTOSENSITIVITY FLOOR: the shortest gap allowed between the START of one
 * strike and the start of the next, in seconds. This is a safety limit, not a
 * tuning value.
 *
 * The mana gauge's MIN_PULSE_PERIOD_S (0.25 s = 4 Hz) is the codebase's
 * precedent for the same reasoning, and this floor is deliberately an order of
 * magnitude above it: that cue is a few pixels of falling sand inside a HUD
 * widget, this one is a full-screen change in scene brightness, which is exactly
 * the stimulus photosensitivity guidance is written about. WCAG 2.3.1 allows up
 * to three flashes per second; one strike per three seconds is a tenth of that,
 * and since a strike's envelope has exactly two brightness transitions (up, then
 * down — see flashBrightness), the worst case is 0.67 transitions per second.
 *
 * It is enforced as a CLAMP on the sampled interval rather than as a "skip this
 * one" rule, because a skip would silently turn a long Poisson tail into a burst
 * the moment the tail ended.
 */
export const MIN_FLASH_INTERVAL_SECONDS = 3;

/**
 * Ceiling on the sampled interval, in seconds.
 *
 * The exponential distribution has an unbounded tail: without this, one sample
 * in fifty leaves a player who was told there is lightning watching still water
 * for a minute and more. e^(-40/11) ≈ 2.6% of intervals hit the clamp and land
 * exactly here, which is a distortion of the tail and is the point of it.
 */
export const MAX_FLASH_INTERVAL_SECONDS = 40;

/**
 * The strike envelope: how long the brightness takes to reach its peak, and how
 * long the whole strike lasts, in seconds.
 *
 * ~50 ms of attack is fast enough to read as a discharge rather than as a lamp
 * being turned up, and is still several frames at 60 Hz so it is a ramp and not
 * a single-frame jump (a one-frame full-brightness step is precisely the
 * strobing this effect must not do). 320 ms total puts it in the "few hundred
 * ms" the brief asks for.
 *
 * DELIBERATELY NOT MODELLED: the double- and triple-strike flicker real
 * lightning has. It is the most recognisable thing about lightning and it is a
 * 10 Hz brightness oscillation, i.e. the exact waveform that triggers seizures.
 * One strike, one rise, one fall.
 */
export const FLASH_ATTACK_SECONDS = 0.05;
export const FLASH_DURATION_SECONDS = 0.32;

/**
 * Shape of the decay after the peak. 2.2 — steeper than linear, so the strike
 * dies away like a discharge instead of dimming like a fader, without the long
 * near-invisible tail a higher exponent leaves.
 */
export const FLASH_DECAY_EXPONENT = 2.2;

/** Pale blue-white. The one cold light in a scene lit by a warm sun. */
export const FLASH_COLOR = 0xcfe3ff;

/**
 * Peak intensity of the momentary point light, in candela (three's lights have
 * been physical since r155), and the radius at which it is cut off.
 *
 * INVERSE SQUARE, stated because the number is meaningless without it: with the
 * default decay of 2, illuminance is intensity / distance². 420 cd puts ~6.6 at
 * the monster's own head some 8 cells away — about three times the sun's 2.2
 * (render/scene.ts) — and ~0.5 at 30 cells. A flash SHOULD overexpose what it
 * lights; the renderer's ACES tone mapping rolls that off instead of clipping it
 * to paper white.
 *
 * The cutoff radius bounds the light's influence so a strike cannot brighten
 * terrain across the world: 60 cells is where the falloff has already taken it
 * to 0.12, i.e. below the hemisphere ambient, so the cutoff is not a visible
 * edge.
 */
export const FLASH_LIGHT_PEAK_INTENSITY = 420;
export const FLASH_LIGHT_RANGE_CELLS = 60;

/**
 * Height of the flash light above the sea surface, in cells.
 *
 * Just above the top of the silhouette: the light has to rake ACROSS the model
 * to throw the wings and the head into relief. A light at bolt-top height would
 * be a ceiling lamp, and one down in the mist would light nothing but mist.
 */
export const FLASH_LIGHT_HEIGHT_CELLS = SILHOUETTE_ABOVE_WATER_CELLS + 1.5;

/**
 * The bolt's vertical extent above the sea surface, in cells.
 *
 * The top is well clear of the wing tips (~4.3 cells) so the bolt comes out of
 * sky rather than out of frame, and the bottom is the top mist layer, so every
 * bolt terminates IN the bank rather than at a point in mid-air.
 */
export const BOLT_TOP_CELLS = 14;
export const BOLT_BOTTOM_CELLS = MIST_LAYERS[MIST_LAYERS.length - 1]!.height;

/**
 * The annulus a bolt may strike in, as a distance from the monster's centre.
 *
 * The inner radius is the model's own half-footprint plus a cell of clearance,
 * which is what stops a bolt being drawn THROUGH the wings — the bolt is
 * additive and depth-tested, so a strike inside the silhouette would light the
 * inside of the model and look like a bug. The outer radius is the mist's, so
 * the strike always lands within the weather it belongs to.
 */
export const BOLT_CLEARANCE_CELLS = 1;
export const BOLT_MIN_RADIUS_CELLS = CTHULHU_WIDTH_CELLS / 2 + BOLT_CLEARANCE_CELLS;
export const BOLT_MAX_RADIUS_CELLS = MIST_RADIUS_CELLS;

/**
 * The bolt ribbon: how wide it is at the top, how much of that width is left at
 * the tip, and how far each kink throws it sideways — all in cells.
 *
 * A quarter of a cell is about the thinnest a strip can be and still be more
 * than a line at fifty cells of camera distance. The taper is what gives it a
 * direction; the jag is what makes it lightning instead of a laser.
 */
export const BOLT_WIDTH_CELLS = 0.25;
export const BOLT_TIP_WIDTH_FRACTION = 0.35;
export const BOLT_JAG_CELLS = 0.55;

/**
 * How brightly the mist itself lights up during a strike — peak alpha of one
 * extra additive sheet through the middle of the bank.
 *
 * The mist sheets are unlit (MeshBasicMaterial), so the point light cannot touch
 * them; without this the flash would light the monster and the terrain and leave
 * the fog conspicuously dead. 0.45 is under half, so the bank brightens rather
 * than turning into a white disc.
 */
export const FLASH_GLOW_OPACITY = 0.45;
/** Which mist layer the glow sheet sits in: the middle of a three-sheet bank. */
export const FLASH_GLOW_LAYER_INDEX = 1;

// ── Timing maths ─────────────────────────────────────────────────────────────

/**
 * Moves an envelope toward its target at a fixed rate, in [0, 1].
 *
 * Linear rather than exponential so it ARRIVES: an exponential approach never
 * reaches zero, and "the fade has finished" is the condition this plugin frees
 * its GPU resources on. `seconds` is the time a full 0→1 traverse takes.
 */
export function approachEnvelope(
  current: number,
  target: number,
  dt: number,
  seconds: number,
): number {
  if (seconds <= 0) return target;
  const step = Math.max(0, dt) / seconds;
  if (current < target) return Math.min(target, current + step);
  if (current > target) return Math.max(target, current - step);
  return target;
}

/**
 * Turns a uniform sample in [0, 1) into a Poisson-process interval, clamped into
 * [MIN_FLASH_INTERVAL_SECONDS, MAX_FLASH_INTERVAL_SECONDS].
 *
 * -ln(1 - u) · mean is the standard inverse-CDF draw for an exponential, which
 * is what makes strikes MEMORYLESS: the gap since the last one tells you nothing
 * about the next, so the lightning never falls into a rhythm the player can feel
 * coming. The clamps are the photosensitivity floor and the patience ceiling
 * documented on those constants.
 */
export function nextFlashIntervalSeconds(uniform: number): number {
  // A generator that returned exactly 1 (none of ours does) would give Infinity;
  // clamping the input keeps this total for any finite caller.
  const u = Math.min(Math.max(uniform, 0), 1 - Number.EPSILON);
  const interval = -Math.log(1 - u) * MEAN_FLASH_INTERVAL_SECONDS;
  if (interval < MIN_FLASH_INTERVAL_SECONDS) return MIN_FLASH_INTERVAL_SECONDS;
  if (interval > MAX_FLASH_INTERVAL_SECONDS) return MAX_FLASH_INTERVAL_SECONDS;
  return interval;
}

/**
 * Brightness of a strike `since` seconds after it began, in [0, 1]; 0 outside
 * the strike.
 *
 * EXACTLY TWO BRIGHTNESS TRANSITIONS — one rise, one fall — and that is a safety
 * property, not a style: see MIN_FLASH_INTERVAL_SECONDS. Anything that added a
 * flicker here would defeat the interval floor that keeps this within
 * photosensitivity guidance.
 */
export function flashBrightness(since: number): number {
  if (!(since >= 0) || since >= FLASH_DURATION_SECONDS) return 0;
  if (since < FLASH_ATTACK_SECONDS) return since / FLASH_ATTACK_SECONDS;
  const decaying = (since - FLASH_ATTACK_SECONDS) / (FLASH_DURATION_SECONDS - FLASH_ATTACK_SECONDS);
  return Math.pow(1 - decaying, FLASH_DECAY_EXPONENT);
}

/** Where one strike lands and how its ribbons are turned. */
export interface Strike {
  /** Bearing from the monster, radians. */
  readonly bearing: number;
  /** Position along the allowed annulus, [0, 1) — 0 is the inner radius. */
  readonly reach: number;
  /** Yaw of the bolt's own crossed ribbons, radians. */
  readonly yaw: number;
}

/**
 * A small deterministic PRNG (mulberry32), seeded by the caller.
 *
 * SEEDED CLIENT-SIDE, ON PURPOSE, AND THE BOLTS THEREFORE DIFFER BETWEEN
 * PLAYERS. This is visual weather, not world state: nothing in the simulation,
 * the protocol or any other plugin can observe where a bolt fell, so agreeing on
 * it would mean putting a schedule on the wire to buy nothing. The monster's
 * position, which players DO need to agree on, is server state and is untouched
 * by any of this.
 *
 * A named generator rather than Math.random so a test can drive the schedule
 * with a known stream — the interval floor that keeps this effect inside
 * photosensitivity guidance is a property worth asserting, and asserting it
 * needs a reproducible sequence.
 */
export function createStrikeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The lightning clock: decides WHEN a strike starts and how bright it is now.
 *
 * It knows nothing about three, about the monster, or about the user's motion
 * preference — a caller that must not flash simply never advances it, which is
 * what makes "no flashes at all under prefers-reduced-motion" a property of one
 * `if` rather than of every value this class produces.
 *
 * The first strike is scheduled from the same distribution as every other, so a
 * monster does not announce itself with a bolt the instant it surfaces.
 */
export class LightningSchedule {
  private readonly random: () => number;
  /** Seconds remaining until the next strike begins. */
  private untilNext: number;
  /** Seconds since the current strike began; large means "none in progress". */
  private sinceStrike = Number.POSITIVE_INFINITY;

  constructor(random: () => number = createStrikeRandom(Date.now())) {
    this.random = random;
    this.untilNext = nextFlashIntervalSeconds(random());
  }

  /**
   * Advances the clock by `dt` seconds. Returns the strike that STARTED this
   * frame, or null — which is every frame but roughly one in six hundred, so the
   * one small object allocated here is not a per-frame allocation.
   *
   * `armed` false holds the countdown where it is and starts nothing, while
   * still letting a strike already in progress decay away on its own curve —
   * which is what a banished monster wants: it stops summoning lightning, but it
   * does not freeze a lit bolt in mid-air over the water it left.
   *
   * (The OTHER caller of `armed: false` is reduced motion, and there the
   * renderer additionally forces the brightness to zero on the spot: someone who
   * has just asked for less motion should get none, not the tail of a flash.)
   *
   * At most one strike can start per call whatever `dt` is: a long frame (a
   * background tab coming back) shortens the wait to zero and fires once,
   * instead of paying out the whole backlog as a burst.
   */
  advance(dt: number, armed: boolean): Strike | null {
    const step = Math.max(0, dt);
    this.sinceStrike += step;
    if (!armed) return null;
    this.untilNext -= step;
    if (this.untilNext > 0) return null;

    this.untilNext = nextFlashIntervalSeconds(this.random());
    this.sinceStrike = 0;
    return {
      bearing: this.random() * TWO_PI,
      reach: this.random(),
      yaw: this.random() * TWO_PI,
    };
  }

  /** Brightness of the strike in progress, in [0, 1]; 0 between strikes. */
  brightness(): number {
    return flashBrightness(this.sinceStrike);
  }
}
