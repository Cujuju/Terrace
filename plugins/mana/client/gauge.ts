// The mana gauge's arithmetic, with no Solid and no JSX in it.
//
// WHY THIS IS ITS OWN MODULE: everything here is a pure function of numbers —
// how far a displayed balance advances in dt seconds, what fraction of the
// vessel that fills, how long one "grain" of the falling-sand cue should take.
// Keeping it out of the component is what makes it testable without a DOM, and
// keeps ManaGauge.tsx to markup plus wiring.
//
// DISPLAY ONLY, and since 2026-08-24 that is true in the useful direction as
// well as the dangerous one. This module used to own `advanceDisplayBalance`,
// which advanced the drawn balance every frame from its OWN previous output —
// a second accumulator of the same quantity the intent gate was accumulating,
// with nothing tying the two together. They diverged exactly as you would
// expect: a burst of pull intents drained the gate to nothing while the gauge
// filled to the brim, and the player was shown a full pool that would not
// spend (owner report: "how can the gauge show full and internally it's
// zero"). What the pool holds is now said once, by `liveBalance` in state.ts,
// and this module is left with the arithmetic that is genuinely about drawing:
// how much of the vessel a balance fills, and how the cue is paced.

/** Milliseconds per second — rAF hands out milliseconds, regen is per second. */
export const MS_PER_SECOND = 1000;

/**
 * Bounds on the motion cue's period (see pulsePeriodSeconds).
 *
 * The floor is a legibility AND a safety limit: below ~4 cycles per second a
 * repeating visual stops reading as discrete events and starts reading as
 * flicker, which is also where photosensitivity guidance says to stop. The
 * ceiling is pure legibility in the other direction — a cue slower than one
 * cycle a minute is indistinguishable from a static image, so a longer duration
 * would buy nothing while keeping a compositor layer alive.
 */
export const MIN_PULSE_PERIOD_S = 0.25;
export const MAX_PULSE_PERIOD_S = 60;

/** True for values that can safely be used in the drawing arithmetic. */
function usable(value: number): boolean {
  return Number.isFinite(value);
}

/** How full the vessel is drawn, 0..1. */
export function fillFraction(displayed: number, capacity: number): number {
  if (!usable(displayed) || !usable(capacity) || capacity <= 0) return 0;
  if (displayed <= 0) return 0;
  return displayed >= capacity ? 1 : displayed / capacity;
}

/** Whether the pool is at capacity — the cue pauses here, there is nothing to fill. */
export function isPoolFull(displayed: number, capacity: number): boolean {
  if (!usable(displayed) || !usable(capacity) || capacity <= 0) return false;
  return displayed >= capacity;
}

/**
 * Below this rate the "whole units per second" readout would round to +0/s.
 * A world that IS refilling must never print that, so rates under one unit a
 * second get one decimal place instead of a wrong integer.
 */
export const RATE_DECIMAL_THRESHOLD = 1;

/**
 * The numeric rate shown beside the balance, e.g. "+20/s".
 *
 * Whole units at playable rates — the reader wants an order of magnitude, not
 * 19.7 — with the one-decimal escape hatch above for the slow end of the
 * configurable band. An unusable rate renders as an em dash rather than as a
 * confident wrong number.
 */
export function formatRegenRate(regenPerSecond: number): string {
  if (!usable(regenPerSecond) || regenPerSecond <= 0) return '—';
  const shown =
    regenPerSecond < RATE_DECIMAL_THRESHOLD
      ? regenPerSecond.toFixed(1)
      : String(Math.round(regenPerSecond));
  return `+${shown}/s`;
}

/**
 * The price readout beside the gauge, e.g. "−12/use": what the brush the player
 * is CURRENTLY holding costs to apply once.
 *
 * Whole units always — a price is an integer by construction (sculptManaCost
 * rounds up), so unlike the regen rate there is no slow end that needs a decimal.
 * A minus sign, matching the "+20/s" above it: the two lines are the two
 * directions the pool moves. An unusable or absent price renders as an em dash
 * rather than as a confident "−0/use", which would read as "sculpting is free".
 */
export function formatSculptCost(cost: number): string {
  if (!usable(cost) || cost <= 0) return '—';
  return `−${Math.round(cost)}/use`;
}

/**
 * THE RATE READOUT: seconds per cycle of the falling-grain cue.
 *
 * One cycle is one CURRENT-BRUSH sculpt's worth of regen — cost / regenPerSecond
 * seconds — so the cue is not decoration, it is the unit of the economy made
 * visible. A world configured fast drops grains in a stream; a slow world drips,
 * and since volume pricing (2026-08-14) picking up a radius-4 hard brush slows
 * the same world's rhythm 45× because that is honestly how much longer the
 * player must wait between those sculpts. The player learns "one grain = one
 * more sculpt WITH THIS BRUSH" without being told a number.
 *
 * Clamped into [MIN_PULSE_PERIOD_S, MAX_PULSE_PERIOD_S]; an unusable rate or
 * cost degrades to the slowest period, which is the least distracting thing an
 * unknown rate can do.
 */
export function pulsePeriodSeconds(cost: number, regenPerSecond: number): number {
  if (!usable(cost) || cost <= 0) return MAX_PULSE_PERIOD_S;
  if (!usable(regenPerSecond) || regenPerSecond <= 0) return MAX_PULSE_PERIOD_S;

  const period = cost / regenPerSecond;
  if (period < MIN_PULSE_PERIOD_S) return MIN_PULSE_PERIOD_S;
  if (period > MAX_PULSE_PERIOD_S) return MAX_PULSE_PERIOD_S;
  return period;
}
