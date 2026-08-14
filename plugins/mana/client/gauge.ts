// The mana gauge's arithmetic, with no Solid and no JSX in it.
//
// WHY THIS IS ITS OWN MODULE: everything here is a pure function of numbers —
// how far a displayed balance advances in dt seconds, what fraction of the
// vessel that fills, how long one "grain" of the falling-sand cue should take.
// Keeping it out of the component is what makes it testable without a DOM, and
// keeps ManaGauge.tsx to markup plus wiring.
//
// DISPLAY ONLY. Nothing here participates in affordability: the local intent
// gate (state.ts) compares the SERVER-pushed balance against a price it computes
// with the SERVER-pushed rate through the shared pricing function, and none of
// this smoothing or formatting feeds back into it. The worst a bug in this file
// can do is draw a wrong picture.

/** Milliseconds per second — rAF hands out milliseconds, regen is per second. */
export const MS_PER_SECOND = 1000;

/**
 * The largest frame step the smoothing will trust, in seconds.
 *
 * requestAnimationFrame stops firing in a background tab, so the first frame
 * after the player comes back reports the whole hidden interval — minutes, in
 * practice. Advancing by that would paint a full pool from nothing but local
 * guesswork, including in the case where the socket died while the tab was
 * hidden and the server has NOT been refilling anyone. Capping the step means
 * the gauge instead climbs one quarter-second's worth and then keeps climbing
 * from there, i.e. it errs LOW and the next authoritative push corrects it.
 *
 * 0.25 s is chosen as a step a genuinely struggling machine (4 fps) could still
 * produce honestly, so the cap never truncates a real frame on real hardware.
 */
export const MAX_DISPLAY_STEP_S = 0.25;

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

/**
 * The balance to show immediately after an authoritative push (or a local gate
 * debit) — a wholesale resync, clamped into the vessel.
 *
 * The clamp is defensive rather than expected: a balance above capacity or
 * below zero would put the fill level outside the glass, and the server is not
 * the only thing that can reach this state (a truncated payload that still
 * parses, a future plugin that grants an overflow bonus).
 */
export function syncedDisplayBalance(balance: number, capacity: number): number {
  if (!usable(balance) || !usable(capacity) || capacity <= 0) return 0;
  if (balance < 0) return 0;
  return balance > capacity ? capacity : balance;
}

/**
 * One frame of smoothing: the displayed balance, advanced by dt seconds of
 * regen at `regenPerSecond`, capped at capacity.
 *
 * Anything unusable (a NaN dt from a first frame, a rate that never arrived)
 * leaves the displayed value alone — a frozen gauge is a far better failure
 * than a NaN one, which would silently blank the vessel and the numbers.
 */
export function advanceDisplayBalance(
  displayed: number,
  capacity: number,
  regenPerSecond: number,
  dtSeconds: number,
): number {
  if (!usable(displayed)) return 0;
  if (!usable(capacity) || capacity <= 0) return displayed;
  if (!usable(regenPerSecond) || regenPerSecond <= 0) return displayed;
  if (!usable(dtSeconds) || dtSeconds <= 0) return displayed;

  const step = dtSeconds > MAX_DISPLAY_STEP_S ? MAX_DISPLAY_STEP_S : dtSeconds;
  const next = displayed + regenPerSecond * step;
  return next > capacity ? capacity : next;
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
