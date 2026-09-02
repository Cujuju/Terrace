// The lightning, as numbers and as timing maths.
//
// WHAT THIS FILE IS FOR, and why it is not simply inside rig.ts: everything here
// is a pure function of numbers — how long until the next flash, how bright a
// flash is this many milliseconds in — so a node test can read it without
// importing three (this project ships no headless GL rig, docs/DESIGN.md).
// rig.ts owns the meshes and the resolution they are built at; this file owns
// every value that decides how the flash BEHAVES.
//
// PRESENTATION ONLY, AND CLIENT-ONLY. Nothing here is on the wire and nothing
// here is authoritative: WHERE and WHEN a bolt lands is the server's
// (../server/lightning.ts) and arrives as an event. Two players in the same
// storm see the same bolt land in the same cell and different silhouettes.
//
// UNITS: cells (== world units, CELL_WORLD_SIZE is 1) and seconds.

import { WORLD_UNITS_PER_BAND, createSeededRng } from '@terrace/shared';
import { CLOUD_BASE_WORLD_Y } from '../../../client/src/plugins/kit/precipitation.ts';

/**
 * Mean interval between flashes within ONE storm, in seconds.
 *
 * A flash has to stay an event rather than a rhythm: at 9 s a player standing
 * under a storm for half a minute sees three, and one who glances at a storm on
 * the far side of the map usually sees none. Shorter than the monsters plugin's
 * 11 s because a storm is something a player walks into and out of, where the
 * monster's dread is permanent for as long as it is there.
 */
export const MEAN_FLASH_INTERVAL_SECONDS = 9;

/**
 * PHOTOSENSITIVITY FLOOR: the shortest gap allowed between the START of one
 * flash and the start of the next, ANYWHERE ON THIS CLIENT, in seconds. This is
 * a safety limit, not a tuning value.
 *
 * The reasoning is the monsters plugin's MIN_FLASH_INTERVAL_SECONDS verbatim,
 * because it is the same stimulus and the same guidance. WCAG 2.3.1 allows up to
 * three flashes per second; one flash per three seconds is a tenth of that, and
 * since a flash's envelope has exactly two brightness transitions (one rise, one
 * fall — see flashBrightness), the worst case is 0.67 transitions per second.
 * The codebase's other precedent, the mana gauge's MIN_PULSE_PERIOD_S (0.25 s),
 * is deliberately an order of magnitude below this: that cue is a few pixels of
 * falling sand inside a HUD widget, this one is a full-screen change in scene
 * brightness, which is exactly the stimulus the guidance is written about.
 *
 * WHY IT IS ENFORCED BY ONE GOVERNOR AND NOT PER RIG. The monsters plugin has at
 * most one monster, so a per-effect interval floor IS a global one. This plugin
 * can have up to MAX_ACTIVE_SYSTEMS storms at once, and two independent clocks
 * that each honour a 3-second floor can still fire 50 ms apart. A per-rig clamp
 * would therefore have been a floor that quietly stops holding exactly when the
 * sky is busiest. So the floor is enforced by one LightningGovernor for the
 * whole client, and the per-storm schedules only ever PROPOSE — see that class.
 */
export const MIN_FLASH_INTERVAL_SECONDS = 3;

/**
 * Ceiling on the sampled interval, in seconds.
 *
 * The exponential distribution has an unbounded tail: without this, one sample
 * in a hundred leaves a player standing in a thunderstorm watching nothing for a
 * minute and more. e^(−45/9) ≈ 0.7% of intervals hit the clamp and land exactly
 * here, which is a distortion of the tail and is the point of it.
 */
export const MAX_FLASH_INTERVAL_SECONDS = 45;

/**
 * The flash envelope: how long the brightness takes to reach its peak, and how
 * long the whole flash lasts, in seconds.
 *
 * ~50 ms of attack is fast enough to read as a discharge rather than as a lamp
 * being turned up, and is still several frames at 60 Hz so it is a ramp and not
 * a single-frame jump (a one-frame full-brightness step is precisely the
 * strobing this effect must not do).
 *
 * DELIBERATELY NOT MODELLED: the double- and triple-strike flicker real
 * lightning has. It is the most recognisable thing about lightning and it is a
 * 10 Hz brightness oscillation, i.e. the exact waveform that triggers seizures.
 * One flash, one rise, one fall.
 */
export const FLASH_ATTACK_SECONDS = 0.05;
export const FLASH_DURATION_SECONDS = 0.32;

/**
 * Shape of the decay after the peak. 2.2 — steeper than linear, so the flash
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
 * default decay of 2, illuminance is intensity / distance². 520 cd puts ~2.1 at
 * a point 16 cells below the bolt — about the sun's own 2.2 (render/scene.ts) —
 * and ~0.6 at 30 cells. A flash SHOULD overexpose what it lights; the renderer's
 * ACES tone mapping rolls that off instead of clipping it to paper white.
 *
 * The cutoff bounds the light's influence so one storm cannot brighten terrain
 * across the world. 90 cells is a little over the largest system's diameter, and
 * the falloff has already taken the light to 0.06 there — below the hemisphere
 * ambient, so the cutoff is not a visible edge.
 */
export const FLASH_LIGHT_PEAK_INTENSITY = 520;
export const FLASH_LIGHT_RANGE_CELLS = 90;

/**
 * The bolt's vertical extent, in world units.
 *
 * It falls from the cloud base — the same altitude the storm's own rain is born
 * at, so the bolt comes out of the cloud the rain comes out of — and stops two
 * bands above sea level, in the haze under the system, rather than at the
 * ground. Terminating at the terrain would need a height lookup at the strike
 * point every flash and would then be WRONG over a locked chunk, where the
 * client's height mirror reads band 0. Ending in the haze is right everywhere
 * and reads as a bolt going into weather.
 */
export const BOLT_TOP_WORLD_Y = CLOUD_BASE_WORLD_Y;
export const BOLT_BOTTOM_WORLD_Y = 2 * WORLD_UNITS_PER_BAND;

/**
 * Where in the system a bolt may fall, as a fraction of the system's radius.
 *
 * Out to 0.85 rather than 1: a bolt on the exact rim would stand outside the
 * visible column of rain, which reads as a bolt from a clear sky. The inner
 * bound is 0 — the centre of a storm is a perfectly good place for lightning.
 */
export const BOLT_MAX_REACH_FRACTION = 0.85;

/**
 * The bolt ribbon: how wide it is at the top, how much of that width is left at
 * the tip, and how far each kink throws it sideways — all in world units.
 *
 * A third of a cell is about the thinnest a strip can be and still be more than
 * a line at the camera's 80-cell orbit; it is wider than the monsters plugin's
 * 0.25 because this bolt is seen from further away and from anywhere on the map.
 * The taper is what gives it a direction; the jag is what makes it lightning
 * instead of a laser.
 */
export const BOLT_WIDTH_WORLD_UNITS = 0.33;
export const BOLT_TIP_WIDTH_FRACTION = 0.35;
export const BOLT_JAG_WORLD_UNITS = 0.9;

/**
 * How brightly the haze under a storm lights up during a flash — peak alpha of
 * one extra additive sheet through the middle of the bank.
 *
 * The sheets are unlit (MeshBasicMaterial), so the point light cannot touch
 * them; without this the flash would light the terrain and leave the weather
 * conspicuously dead. 0.45 is under half, so the bank brightens rather than
 * turning into a white disc.
 */
export const FLASH_GLOW_OPACITY = 0.45;

// ── Timing maths ─────────────────────────────────────────────────────────────

/**
 * Turns a uniform sample in [0, 1) into a Poisson-process interval, clamped into
 * [MIN_FLASH_INTERVAL_SECONDS, MAX_FLASH_INTERVAL_SECONDS].
 *
 * −ln(1 − u) · mean is the standard inverse-CDF draw for an exponential, which
 * is what makes flashes MEMORYLESS: the gap since the last one tells you nothing
 * about the next, so the lightning never falls into a rhythm the player can feel
 * coming. The clamps are the photosensitivity floor and the patience ceiling
 * documented on those constants.
 *
 * The floor is applied as a CLAMP on the sampled interval rather than as a "skip
 * this one" rule, because a skip would silently turn a long Poisson tail into a
 * burst the moment the tail ended. (The governor below DOES drop a proposal, and
 * that is a different case with a different argument — see it.)
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
 * Brightness of a flash `since` seconds after it began, in [0, 1]; 0 outside the
 * flash.
 *
 * EXACTLY TWO BRIGHTNESS TRANSITIONS — one rise, one fall — and that is a safety
 * property, not a style: see MIN_FLASH_INTERVAL_SECONDS. Anything that added a
 * flicker here would defeat the interval floor that keeps this within
 * photosensitivity guidance.
 */
export function flashBrightness(since: number): number {
  if (!(since >= 0) || since >= FLASH_DURATION_SECONDS) return 0;
  if (since < FLASH_ATTACK_SECONDS) return since / FLASH_ATTACK_SECONDS;
  const decaying =
    (since - FLASH_ATTACK_SECONDS) / (FLASH_DURATION_SECONDS - FLASH_ATTACK_SECONDS);
  return Math.pow(1 - decaying, FLASH_DECAY_EXPONENT);
}

/** Where one flash lands inside its system, and how its ribbons are turned. */
export interface Flash {
  /** Bearing from the system's centre, radians. */
  readonly bearing: number;
  /** Distance from the centre as a fraction of the radius, [0, 1). */
  readonly reach: number;
  /** Yaw of the bolt's own crossed ribbons, radians. */
  readonly yaw: number;
}

/**
 * A small deterministic PRNG (mulberry32), seeded by the caller.
 *
 * SEEDED CLIENT-SIDE, ON PURPOSE. This is visual weather, not world state:
 * nothing in the simulation, the protocol or any other plugin can observe the
 * silhouette of a bolt, so agreeing on it would mean putting a schedule on the
 * wire to buy nothing. WHERE a bolt lands, which players DO need to agree on, is
 * server state and is untouched by any of this.
 *
 * A named generator rather than Math.random so a test can drive a schedule with
 * a known stream — the interval floor that keeps this effect inside
 * photosensitivity guidance is a property worth asserting, and asserting it
 * needs a reproducible sequence.
 */
export function createFlashRandom(seed: number): () => number {
  return createSeededRng(seed).next;
}

/**
 * THE ONE THING ON THIS CLIENT THAT MAY START A FLASH.
 *
 * Every storm rig owns a LightningSchedule, but no schedule starts anything by
 * itself: it proposes, and this governor decides. The governor holds the time
 * since the last flash ANYWHERE and refuses any proposal inside
 * MIN_FLASH_INTERVAL_SECONDS of it. That is what makes the photosensitivity
 * floor a property of the client rather than of one effect — with up to
 * MAX_ACTIVE_SYSTEMS storms in the sky, per-rig floors would each hold while the
 * thing they exist to prevent happened between them.
 *
 * A REFUSED PROPOSAL IS DROPPED, not deferred, and that is the opposite of the
 * clamp in nextFlashIntervalSeconds — on purpose. A deferral queue would repay
 * the suppressed flashes the instant the floor cleared, which is a burst: the
 * exact failure the floor exists to prevent. Dropping can only ever REMOVE a
 * flash, never add or bunch one, so the floor holds unconditionally and the only
 * cost is that a second storm flashes slightly less often than its own mean.
 *
 * It starts ready: the first flash of a session is not held back, because there
 * is nothing before it to be too close to.
 */
export class LightningGovernor {
  /** Seconds since the last flash started anywhere. Large means "ready". */
  private sinceLastFlash = Number.POSITIVE_INFINITY;

  /** Advances the shared clock. Call exactly once per frame, before any rig. */
  advance(dt: number): void {
    // Guarded rather than trusted: `dt` is host-capped, but an accumulator that
    // takes one NaN never recovers, and this one gates a safety property.
    if (dt > 0 && Number.isFinite(dt)) this.sinceLastFlash += dt;
  }

  /** True if a flash may start now. Records it when it says yes. */
  requestFlash(): boolean {
    if (this.sinceLastFlash < MIN_FLASH_INTERVAL_SECONDS) return false;
    this.sinceLastFlash = 0;
    return true;
  }

  /** Seconds since the last flash. Exposed for tests, not for rigs. */
  secondsSinceLastFlash(): number {
    return this.sinceLastFlash;
  }

  /** Forgets the last flash (used on dispose, and by tests). */
  reset(): void {
    this.sinceLastFlash = Number.POSITIVE_INFINITY;
  }
}

/**
 * One storm's flash envelope: how bright the flash in progress is now.
 *
 * IT DOES NOT DECIDE WHEN. The server picks the cell and the tick
 * (../server/lightning.ts) and this class is TOLD — two independent RNGs cannot
 * agree on where a forest is burning. What it owns is the flash curve, the
 * governor handshake, and knowing nothing about three or about the system it
 * belongs to.
 */
export class LightningSchedule {
  /** Seconds since the current flash began; large means "none in progress". */
  private sinceFlash = Number.POSITIVE_INFINITY;

  /**
   * Advances the decay clock by `dt` seconds. That is its ENTIRE responsibility.
   *
   * There is no `armed` parameter: reduced motion and a storm that is drifting
   * away are both expressed by the caller simply not CALLING `strike`, and a
   * flash already in progress still decays away on its own curve, which is what
   * both cases wanted.
   */
  advance(dt: number): void {
    this.sinceFlash += Math.max(0, dt);
  }

  /**
   * A bolt just landed on this storm: begin a flash, if the governor allows one.
   * Returns whether it started, so the caller can decline to move the bolt for a
   * flash that was refused.
   *
   * The governor has the last word, and a refusal is DROPPED rather than
   * deferred (see LightningGovernor) — the photosensitivity floor is a property
   * of this client and is not up for negotiation by the server. A dropped flash
   * costs a bolt nobody sees; the fire the server started still burns, because
   * that was never this class's decision.
   */
  strike(governor: LightningGovernor): boolean {
    if (!governor.requestFlash()) return false;
    this.sinceFlash = 0;
    return true;
  }

  /** Brightness of the flash in progress, in [0, 1]; 0 between flashes. */
  brightness(): number {
    return flashBrightness(this.sinceFlash);
  }

  /**
   * Forgets any flash in progress. Required before a pooled rig is reused:
   * without it, a schedule returned to the pool mid-flash (or within
   * FLASH_DURATION_SECONDS of one) would replay that stale brightness the
   * instant a NEW storm acquires the rig — a flash the governor never approved,
   * lit at the old storm's bolt position.
   */
  reset(): void {
    this.sinceFlash = Number.POSITIVE_INFINITY;
  }
}
