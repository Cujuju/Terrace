// Where the lightning actually lands.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SERVER PICKS THE CELL AT ALL (2026-08-24).
//
// Until now every bolt in this game was a CLIENT decision: each storm rig ran
// its own LightningSchedule (../client/sky.ts) and flashed on its own random
// clock, so no two players ever saw the same bolt and the server never knew one
// had happened. That was exactly right while lightning was decoration.
//
// It stops being right the moment lightning DOES something. A fire started by a
// bolt the client chose would be a fire the server never authorised; a fire
// started by a bolt the server chose, drawn by a client flashing elsewhere,
// would be a forest going up under a clear patch of sky. There is no version of
// "lightning sets trees alight" that survives two independent RNGs.
//
// So the strike moves to the server, and the client is told. The rig keeps
// everything it was good at — the jag, the flash envelope, the photosensitivity
// governor — and gives up only the choice of when and where.
//
// WHAT THE STRIKE IS NOT: it is not a wire-synced simulation object. A strike is
// an instant, so it travels as a one-shot event and is never re-sent. A client
// that misses one missed a flash, which is the correct amount to care.
// ─────────────────────────────────────────────────────────────────────────────

import { STRIKE_NO_SYSTEM } from '../protocol.ts';
import { randomInRange, rollEvent, weatherRandom } from './rng.ts';
import { livingSystems, type WeatherSystem, type WeatherWorld } from './systems.ts';

/**
 * Strikes per second the WHOLE SKY may throw — a world-wide budget, shared out
 * across the living storms by intensity (owner, issue #232, 2026-09-01).
 *
 * WHY A BUDGET AND NOT A PER-STORM RATE. This constant was per storm until the
 * spawner retune (a5d3b7f) lifted the mean number of storms alive from 0.4 to
 * ~2.1: nothing about lightning changed and the world's bolts — and `fire`'s
 * ignitions from `weather:strikes` — went up ~5×. A per-storm rate makes "how
 * often does lightning start a fire" a function of the system cap, the world
 * size and the spawner tuning, none of which are lightning decisions. The sky
 * coverage target (systems.ts, TARGET_SKY_COVERAGE_FRACTION) already normalises
 * weather per WORLD rather than per system; lightning follows the same rule.
 *
 * HOW IT IS SHARED. Each storm's rate is
 *   STRIKE_BUDGET × intensity_i / max(1, Σ intensity)
 * so a LONE storm behaves exactly as the old per-storm rule did — at full
 * intensity it throws the budget, while gathering or dissipating it throws
 * proportionally less — and the budget only bites when storms STACK: two full
 * storms throw the budget between them, not twice it. The max(1, ·) is what
 * keeps a single half-strength storm from being handed the whole budget.
 *
 * 0.06/s, unchanged in value: sized against ONE storm's own life, a system
 * lives SYSTEM_MEAN_LIFETIME_SECONDS (240 s), so a lone storm still throws
 * something like a dozen bolts over its passage — frequent enough that a storm
 * overhead reads as dangerous, rare enough that each one is an event. Far below
 * the client governor's MIN_FLASH_INTERVAL_SECONDS floor of one flash per 3 s,
 * so the photosensitivity limit stays a backstop. By arithmetic, at the
 * retuned population (~2.1 storms alive): a bolt every ~17 s of storm-time,
 * against ~8 s per-storm and ~40 s before the retune, when a storm was in the
 * sky 40% of the time — the difference from 40 s is that there is more
 * storm-time now, which is the coverage decision, not this one.
 */
export const STRIKE_BUDGET_PER_SECOND = 0.06;

/**
 * Candidate cells sampled inside the storm before one is struck.
 *
 * Lightning hits the tallest thing under it. Sampling several cells and taking
 * the highest is the cheapest honest way to say that, and it is what makes the
 * lone tree on the ridge the one that gets hit — a rule players learn by
 * watching rather than by being told.
 *
 * SIX, because the return diminishes fast: with six samples the struck cell is
 * in the top ~15% of the storm's footprint by height, which reads as "it went
 * for the high ground" without being so deterministic that the same ridge is
 * struck every single time.
 */
export const STRIKE_TARGET_SAMPLES = 6;

// ─────────────────────────────────────────────────────────────────────────────
// DRY LIGHTNING (owner, 2026-08-24: "I would like it to randomly fire even
// without a storm, and it needs to do so over exposed land").
//
// A bolt out of a clear sky, belonging to no system. It is not a rarity for its
// own sake: it is the only thing that starts a fire on a world where no storm
// happens to be crossing woodland, which was the difference between fire being
// a mechanic and fire being something a player might never see.
//
// EXPOSED, and the word is doing real work. A storm's bolt is aimed inside its
// own footprint and takes the tallest of a few samples (chooseStrikeCell); a dry
// bolt has no footprint, so it is aimed at the most EXPOSED cell in the world —
// which is not the same as the highest. A cell on a plateau is high and dull; a
// cell that stands above what surrounds it is the one lightning finds, and it is
// the one a player reads as "of course that got hit".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chance per second that a dry bolt lands somewhere in the world.
 *
 * One every ~4 minutes of simulated time. Sized against the SKY's own output
 * rather than picked: the storms between them throw up to
 * STRIKE_BUDGET_PER_SECOND (0.06/s) whenever one is in the sky, so dry
 * lightning at 1/240 s adds a few percent to the world's total bolts. It is a punctuation mark, not a second weather system:
 * often enough that a long session sees several, rare enough that one is
 * startling.
 */
export const DRY_STRIKE_RATE_PER_SECOND = 1 / 240;

/**
 * Cells sampled before a dry bolt picks its target.
 *
 * Far more than a storm's six, because the search space is the WHOLE WORLD
 * rather than one system's disc — 24 samples over a 512² world is a coarse net,
 * and it is meant to be: a dry bolt should reliably find high exposed ground
 * without always finding the single highest peak, which would make the same
 * ridge the target every time.
 */
export const DRY_STRIKE_TARGET_SAMPLES = 24;

/**
 * How far out prominence is measured, in cells.
 *
 * Four cells is one world unit at the shipped CELL_WORLD_SIZE — the scale a
 * terrace step is shaped at, so a cell that stands a band above its
 * surroundings scores as exposed while a gentle rise does not.
 */
export const EXPOSURE_SAMPLE_RADIUS_CELLS = 4;

/** The four cardinal offsets prominence is measured against. */
const EXPOSURE_OFFSETS: readonly (readonly [number, number])[] = [
  [-EXPOSURE_SAMPLE_RADIUS_CELLS, 0],
  [EXPOSURE_SAMPLE_RADIUS_CELLS, 0],
  [0, -EXPOSURE_SAMPLE_RADIUS_CELLS],
  [0, EXPOSURE_SAMPLE_RADIUS_CELLS],
];

/**
 * How much a cell's PROMINENCE counts next to its raw height.
 *
 * Both matter and neither alone is right: height alone picks the middle of the
 * highest plateau, prominence alone picks a one-cell pimple in a valley. At 2
 * a cell standing one band above its neighbours beats a cell two bands higher
 * on flat ground — which is the ordering the phrase "exposed land" means.
 */
export const EXPOSURE_PROMINENCE_WEIGHT = 2;

/**
 * How exposed this cell is. Raw heightmap units; higher is more likely to be
 * struck. Negative infinity for anything at or below sea level — the sea is not
 * land, and a dry bolt into open water starts nothing and reads as a miss.
 */
export function exposureAt(world: WeatherWorld, x: number, y: number): number {
  const height = world.heightAt(x, y);
  if (height <= 0) return Number.NEGATIVE_INFINITY;

  let surrounding = 0;
  for (const [dx, dy] of EXPOSURE_OFFSETS) {
    const sx = Math.min(world.worldSize - 1, Math.max(0, x + dx));
    const sy = Math.min(world.worldSize - 1, Math.max(0, y + dy));
    surrounding += world.heightAt(sx, sy);
  }
  const prominence = height - surrounding / EXPOSURE_OFFSETS.length;
  return height + prominence * EXPOSURE_PROMINENCE_WEIGHT;
}

/**
 * The most exposed of several random cells, or null if every sample landed in
 * the sea — an ocean world simply gets no dry lightning, which is honest.
 */
export function chooseDryStrikeCell(world: WeatherWorld): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestExposure = Number.NEGATIVE_INFINITY;

  for (let sample = 0; sample < DRY_STRIKE_TARGET_SAMPLES; sample++) {
    const x = Math.floor(randomInRange(0, world.worldSize));
    const y = Math.floor(randomInRange(0, world.worldSize));
    const exposure = exposureAt(world, x, y);
    if (exposure <= bestExposure) continue;
    bestExposure = exposure;
    best = { x, y };
  }

  return best;
}

/** A strike, in the cell space everything else in this plugin sims in. */
export interface Strike {
  /** Which system threw it — the client needs it to find the rig to flash. */
  readonly systemId: number;
  readonly x: number;
  readonly y: number;
}

/**
 * A uniformly random cell inside the system's disc, clamped to the world.
 *
 * Uniform over the DISC, not over the radius: drawing r uniformly would pile
 * two thirds of the samples into the middle third of the storm, so the strike
 * would drift toward the eye of every system. `sqrt` of a uniform is the
 * standard correction and it is one call.
 */
function sampleCell(system: WeatherSystem, worldSize: number): { x: number; y: number } | null {
  const angle = weatherRandom() * Math.PI * 2;
  const radius = Math.sqrt(weatherRandom()) * system.radius;
  const x = Math.round(system.x + Math.cos(angle) * radius);
  const y = Math.round(system.y + Math.sin(angle) * radius);
  // A system may sit partly off the edge of the world (systems.ts's spawn
  // margins), so a sample can land outside it. Dropped rather than clamped:
  // clamping would pile every off-world sample onto the world's rim and strike
  // the coastline far more often than the interior.
  if (x < 0 || y < 0 || x >= worldSize || y >= worldSize) return null;
  return { x, y };
}

/**
 * Picks the cell this storm strikes: the highest of several samples (see
 * STRIKE_TARGET_SAMPLES). Null when the storm is far enough off the edge of the
 * world that nothing under it can be sampled.
 */
export function chooseStrikeCell(
  system: WeatherSystem,
  world: WeatherWorld,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestHeight = Number.NEGATIVE_INFINITY;

  for (let sample = 0; sample < STRIKE_TARGET_SAMPLES; sample++) {
    const cell = sampleCell(system, world.worldSize);
    if (cell === null) continue;
    const height = world.heightAt(cell.x, cell.y);
    if (height <= bestHeight) continue;
    bestHeight = height;
    best = cell;
  }

  return best;
}

/** A storm's current strength in [0, 1]: its peak, shaped by its life envelope. */
function stormIntensity(system: { readonly peakIntensity: number; readonly envelope: number }): number {
  return system.peakIntensity * system.envelope;
}

/**
 * Rolls this step's strikes across every living storm. Returns them in system
 * order; the empty array is the overwhelmingly common answer.
 *
 * Only `storm` throws bolts — the kind exists for exactly that reason
 * (../protocol.ts: "`storm` is `rain` plus lightning rather than a
 * `hasLightning` flag on rain"). The storms share STRIKE_BUDGET_PER_SECOND by
 * intensity (see its doc comment), so a system that is still gathering or
 * already dissipating gets proportionally less of it, one at zero gets none,
 * and stacking storms never multiplies the world's bolts.
 */
export function rollStrikes(world: WeatherWorld, dt: number): Strike[] {
  const strikes: Strike[] = [];

  // THE DRY BOLT FIRST, so it is never crowded out by a storm's — the two are
  // independent processes and this one is the rare one.
  if (rollEvent(DRY_STRIKE_RATE_PER_SECOND, dt)) {
    const cell = chooseDryStrikeCell(world);
    if (cell !== null) strikes.push({ systemId: STRIKE_NO_SYSTEM, x: cell.x, y: cell.y });
  }

  // The budget's denominator: total storm intensity in the sky this step, floored
  // at 1 so a lone storm below full strength is not handed the whole budget.
  let totalIntensity = 0;
  for (const system of livingSystems()) {
    if (system.kind !== 'storm') continue;
    totalIntensity += stormIntensity(system);
  }
  const budgetShareDenominator = Math.max(1, totalIntensity);

  for (const system of livingSystems()) {
    if (system.kind !== 'storm') continue;
    const intensity = stormIntensity(system);
    if (intensity <= 0) continue;
    if (!rollEvent((STRIKE_BUDGET_PER_SECOND * intensity) / budgetShareDenominator, dt)) continue;

    const cell = chooseStrikeCell(system, world);
    if (cell === null) continue;
    strikes.push({ systemId: system.id, x: cell.x, y: cell.y });
  }

  return strikes;
}
