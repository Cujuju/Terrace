// THE WORLD'S WIND — one heading and one speed, wandering.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS EXACTLY ONE, AND WHY THE HUB OWNS IT.
//
// Owner, 2026-08-14: "Like regular weather patterns, it should move together in
// large chunks." Across systems that means ONE WIND: every mass in the sky rides
// the same velocity, so two fronts never sail past each other in opposite
// directions — the sky moves as a piece.
//
// REJECTED: per-system velocity. It is one extra pair of numbers and it looks
// wrong immediately — weather that disagrees with itself about which way the
// wind is blowing reads as decoration, not as a climate. The wire still carries
// the velocity per system (shared/src/discWire.ts) because a client needs it as
// a direction; the SIM is what commits to one wind.
//
// After the 2026-09-02 decomposition the four kind plugins are separate,
// independently-deletable folders, so "one wind" can no longer be a module-level
// variable they happen to share. It is a fact of the WORLD, and the hub is the
// plugin that owns facts of the world: each kind reads it through a bridge and
// gets calm if the hub is not running here.
// ─────────────────────────────────────────────────────────────────────────────

import { cellsAcross } from '@terrace/shared';
import { randomInRange, randomSigned, weatherRandom } from './rng.ts';

/**
 * The speed band the single shared wind wanders within, in cells per second —
 * stated in world units per second and converted, like every distance here.
 *
 * The ceiling is the interesting one and it is set by the broadcast, not by
 * meteorology: at the 1 Hz cadence 2 world units/s moves a system 2 units
 * between messages, which is 8% of the SMALLEST system's radius — comfortably
 * inside what a client's interpolation renders as a continuous glide. The floor
 * of 0.6 is the slowest a front can move and still visibly be moving: it crosses
 * a 24-unit radius in 40 s, so a player standing still sees the edge of the rain
 * reach them within a look-around.
 */
export const WIND_MIN_SPEED_CELLS_PER_SECOND = cellsAcross(0.6);
export const WIND_MAX_SPEED_CELLS_PER_SECOND = cellsAcross(2);

/**
 * Maximum magnitude of the wind's random heading change, in radians per second.
 *
 * A BOUNDED RANDOM WALK, not a target it steers toward: real wind veers and
 * backs without a preferred direction, and a restoring force would give the
 * world a prevailing wind that no part of this design has any business choosing.
 *
 * 0.01 rad/s is "slowly veering" quantified. The per-second step is uniform on
 * ±0.01, so its standard deviation is 0.01/√3 ≈ 0.0058 rad; over an hour the
 * heading wanders about 0.0058 × √3600 = 0.35 rad ≈ 20°. A system whose whole
 * life is four minutes therefore flies an essentially straight course (≈2.7° of
 * drift), which is what makes a front look like a front — while a player who
 * leaves a world running all evening finds the wind somewhere else.
 */
export const WIND_VEER_RADIANS_PER_SECOND = 0.01;

/**
 * Maximum magnitude of the wind's random speed change, in cells per second per
 * second.
 *
 * 0.05 traverses the whole 1.4-units/s speed band in ~28 s of one-sided drift,
 * which never happens (the walk is symmetric), so in practice the speed breathes
 * within the band over minutes. The band's ends are hard clamps rather than
 * reflections: a clamp holds the wind at the limit for a moment, which is what a
 * calm or a steady blow looks like, where a reflection would make the wind
 * bounce off its own ceiling.
 */
export const WIND_SPEED_DRIFT_CELLS_PER_SECOND_SQUARED = cellsAcross(0.05);

/** The single wind every system rides. Cells per second, as a polar pair. */
export interface Wind {
  /** Radians. A system moves toward (cos heading, sin heading) in cell space. */
  heading: number;
  speed: number;
}

/**
 * The wind, at rest until the first tick veers it.
 *
 * Seeded from the RNG at reset rather than fixed, so two worlds booted from the
 * same binary do not both start blowing due east — but it is ONE draw for the
 * whole world, not one per system, which is the point of this file.
 */
let wind: Wind = { heading: 0, speed: 0 };

/** The current wind. Read-only to callers; only advanceWind writes it. */
export function currentWind(): Readonly<Wind> {
  return wind;
}

/** Cell-space velocity of the shared wind. */
export function windVelocity(): { vx: number; vy: number } {
  return {
    vx: Math.cos(wind.heading) * wind.speed,
    vy: Math.sin(wind.heading) * wind.speed,
  };
}

/** Draws a fresh wind, so a boot (or a suite) starts from a new one. */
export function resetWind(): void {
  wind = {
    heading: weatherRandom() * Math.PI * 2,
    speed: randomInRange(WIND_MIN_SPEED_CELLS_PER_SECOND, WIND_MAX_SPEED_CELLS_PER_SECOND),
  };
}

// Draw the boot wind immediately, so a host that never calls reset still has a
// wind rather than a dead calm blowing due east.
resetWind();

/**
 * Veers and freshens the one shared wind. Both walks are symmetric and both are
 * clamped, never reflected — see the constants.
 */
export function advanceWind(dt: number): void {
  wind.heading += randomSigned(WIND_VEER_RADIANS_PER_SECOND) * dt;
  // Kept in a canonical range so a world left running for days does not
  // accumulate a heading with no significant bits left in its fraction.
  const twoPi = Math.PI * 2;
  wind.heading = ((wind.heading % twoPi) + twoPi) % twoPi;

  const speed = wind.speed + randomSigned(WIND_SPEED_DRIFT_CELLS_PER_SECOND_SQUARED) * dt;
  wind.speed = Math.min(
    WIND_MAX_SPEED_CELLS_PER_SECOND,
    Math.max(WIND_MIN_SPEED_CELLS_PER_SECOND, speed),
  );
}
