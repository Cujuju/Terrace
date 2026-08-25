// How a fire gets from one cell to the next.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE RATE, AND THE TERMS THAT MULTIPLY IT.
//
// Every neighbour of every burning cell has a chance per second of catching:
//
//   rate = BASE_SPREAD_RATE × intensity × wind × slope × diagonal × wet
//
// and `happensWithin` (./rng.ts) turns that rate into a yes or no for the step.
// Nothing else influences it. Keeping it to one product is what makes the
// mechanic tunable at all — every term is a number a player can be taught, and
// a term that cannot be explained in one sentence does not belong in it.
//
//   INTENSITY  a fire that has not taken hold yet, and one that is guttering
//              out, do not throw sparks. See SPREAD_MIN_INTENSITY.
//   WIND       downwind is fast, upwind is slow but never impossible. This is
//              what makes a fire read as alive rather than as a circle.
//   SLOPE      fire runs uphill. On a terraced world this is the term the
//              player can actually see, and it is why the terrain matters.
//   DIAGONAL   a diagonal neighbour is √2 further away, so it catches at
//              1/√2 the rate. Without it a fire spreads as a square.
//   WET        rain on the ground ahead. The same number that puts fires out
//              (./index.ts) also stops them starting, so a front walking into a
//              squall slows before it dies rather than marching on and then
//              vanishing all at once.
//
// WHAT IS NOT A TERM, and does not need to be: fuel. A cell with nothing on it
// simply fails to ignite (Blaze.ignite consults the registry), so water, bare
// rock, a dug trench and a ploughed field all stop a fire for the same reason
// and through the same code path. THE FIREBREAK IS NOT A FEATURE — it is what
// is left when you decline to write a special case.
// ─────────────────────────────────────────────────────────────────────────────

import { BAND_HEIGHT } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { fireIntensity, type FireCellState } from '../protocol.ts';
import type { Blaze } from './blaze.ts';
import { happensWithin } from './rng.ts';
import { currentWind, precipitationAt } from './weather-bridge.ts';

/**
 * Simulated seconds between spread evaluations.
 *
 * NOT every tick (10 Hz): spread is O(burning × 8) and evaluating it a hundred
 * times during one tree's burn buys nothing a player can see, since the outcome
 * is a Poisson process either way (`happensWithin` makes the cadence
 * balance-neutral — see its doc comment). One second is also roughly the pace at
 * which a watching player perceives "it jumped to the next tree" as an event
 * rather than as a continuous glow.
 */
export const SPREAD_INTERVAL_SECONDS = 1;

/**
 * Chance per second that a fire at full intensity, on flat ground, in still
 * air, sets a given adjacent cell alight.
 *
 * Derived from the shape the mechanic has to have, not tuned blind. A tree
 * burns for FLORA_TREE_BURN_SECONDS (22 s) and spends most of that at full
 * intensity, so at 0.08/s each of its eight neighbours gets roughly a 4-in-5
 * chance of catching over the fire's life — a dense stand goes up, and an
 * isolated tree with one neighbour usually takes it with it but not always.
 * Much higher and every fire is total; much lower and fire stops being a threat
 * worth digging a break against.
 */
export const BASE_SPREAD_RATE_PER_SECOND = 0.08;

/**
 * A fire below this intensity does not spread.
 *
 * It is what makes a fire have a FRONT. Without it, the spent core of a burn
 * throws sparks as readily as its leading edge, and a fire expands as a filled
 * disc; with it, the cells still climbing or already dying are inert, and what
 * spreads is the ring that is actually roaring. 0.35 sits inside the plateau of
 * ../protocol.ts's intensity curve, so it excludes the ignition ramp and the
 * long decay tail without cutting into the full-strength middle.
 */
export const SPREAD_MIN_INTENSITY = 0.35;

/**
 * How much the wind matters, as the multiplier a cell directly downwind gets at
 * WIND_REFERENCE_SPEED_CELLS_PER_SECOND. Directly upwind gets the reciprocal
 * side of the same term, floored (see WIND_UPWIND_FLOOR).
 *
 * 2 is chosen so that wind is decisive but not absolute: a fire in a stiff wind
 * moves about four times as fast downwind as up, which is legible from the
 * shape of the burn scar without making upwind cells effectively immune.
 */
export const WIND_DOWNWIND_MULTIPLIER = 2;

/**
 * The wind speed at which WIND_DOWNWIND_MULTIPLIER applies in full. Weather's
 * own wind runs to WIND_MAX_SPEED_CELLS_PER_SECOND (2 cells/s at the shipped
 * scale), so referencing the top of its range means a gale gets the full effect
 * and a breeze gets a proportional part of it.
 */
export const WIND_REFERENCE_SPEED_CELLS_PER_SECOND = 2;

/**
 * The least the wind term can ever be, however hard it blows against.
 *
 * A hard zero would mean a fire can NEVER back into the wind, which is both
 * wrong and a trap: a player would learn that standing upwind is perfect safety
 * and the mechanic would stop being about firebreaks. 0.2 makes upwind spread
 * slow enough to outrun and too likely to ignore.
 */
export const WIND_UPWIND_FLOOR = 0.2;

/**
 * How much faster fire spreads one terrace band UPHILL, and how much slower one
 * band down.
 *
 * Real fires run uphill because the flame front preheats the slope above it;
 * here it is also the term that makes the game's own geometry the mechanic. One
 * band is the smallest relief the world can express (BAND_HEIGHT), so pricing
 * the multiplier per band means a single terrace step is a visible difference —
 * which is exactly the granularity a player sculpts in.
 */
export const SLOPE_UPHILL_MULTIPLIER_PER_BAND = 1.6;

/**
 * Bands beyond which extra height stops helping (or hurting).
 *
 * Without a clamp, a cliff would make the multiplier astronomical in one
 * direction and zero in the other, and a fire at the foot of a four-band wall
 * would leap it instantly. Two bands is the relief of ordinary rolling ground,
 * so slope is decisive across terraces a player shapes and inert against cliffs
 * they carve — and a tall enough wall becomes a firebreak in its own right,
 * which is the behaviour worth having.
 */
export const SLOPE_CLAMP_BANDS = 2;

/**
 * How much of the spread rate rain can take away, at full intensity.
 *
 * 0.9 rather than 1: even in a downpour a fire in dense fuel can creep, and a
 * hard zero would make heavy rain an absolute wall that a player could stand
 * behind. The remaining tenth is slow enough to outrun and too visible to
 * ignore, which is the same shape as WIND_UPWIND_FLOOR and chosen for the same
 * reason — no term in this product is ever allowed to be a guarantee.
 */
export const WET_SPREAD_PENALTY = 0.9;

/** 1/√2 — a diagonal neighbour is that much further away. See the header. */
const DIAGONAL_RATE_FACTOR = Math.SQRT1_2;

/** The eight neighbours, in a fixed order so a seeded run is reproducible. */
const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * The wind multiplier for a step in direction (dx, dy).
 *
 * `cos` of the angle between the step and the wind is +1 dead downwind and −1
 * dead upwind, so the term runs smoothly between a boost and the floor with no
 * branch and no direction bucketing — a fire quartering the wind gets a
 * quartering answer.
 */
function windFactor(dx: number, dy: number, heading: number, speed: number): number {
  if (speed <= 0) return 1;

  const stepLength = Math.hypot(dx, dy);
  if (stepLength === 0) return 1;

  const alignment = (dx * Math.cos(heading) + dy * Math.sin(heading)) / stepLength;
  const strength = Math.min(1, speed / WIND_REFERENCE_SPEED_CELLS_PER_SECOND);
  const factor = 1 + alignment * strength * (WIND_DOWNWIND_MULTIPLIER - 1);
  return Math.max(WIND_UPWIND_FLOOR, factor);
}

/**
 * The slope multiplier for a step from height `fromHeight` to `toHeight`, both
 * in raw heightmap units.
 *
 * Symmetric in the exponent, so descending one band is exactly as slow as
 * ascending one band is fast. That symmetry is what stops the term from
 * quietly inflating or deflating the overall spread rate on rough ground.
 */
function slopeFactor(fromHeight: number, toHeight: number): number {
  const bands = (toHeight - fromHeight) / BAND_HEIGHT;
  const clamped = Math.max(-SLOPE_CLAMP_BANDS, Math.min(SLOPE_CLAMP_BANDS, bands));
  return Math.pow(SLOPE_UPHILL_MULTIPLIER_PER_BAND, clamped);
}

/**
 * Chance per second that this fire sets the cell one step away at (dx, dy)
 * alight. Exported because it is the whole mechanic — a test that asserts on
 * spread should assert on this, not on the outcome of a hundred rolls.
 */
export function spreadRate(
  world: WorldApi,
  fire: FireCellState,
  dx: number,
  dy: number,
  wind: { readonly heading: number; readonly speed: number },
): number {
  const intensity = fireIntensity(fire.ageSeconds, fire.burnSeconds);
  if (intensity < SPREAD_MIN_INTENSITY) return 0;

  const distanceFactor = dx !== 0 && dy !== 0 ? DIAGONAL_RATE_FACTOR : 1;
  // The wetness of the TARGET cell, not of the burning one: what matters is
  // whether the thing about to catch is wet, and a fire under a squall's edge
  // should still light the dry ground behind it.
  const wetFactor = 1 - WET_SPREAD_PENALTY * precipitationAt(fire.x + dx, fire.y + dy);
  return (
    BASE_SPREAD_RATE_PER_SECOND *
    intensity *
    windFactor(dx, dy, wind.heading, wind.speed) *
    slopeFactor(world.heightAt(fire.x, fire.y), world.heightAt(fire.x + dx, fire.y + dy)) *
    distanceFactor *
    wetFactor
  );
}

/**
 * One spread step. Returns the cells that caught, for the caller to broadcast.
 *
 * THE SNAPSHOT IS TAKEN FIRST, deliberately: `blaze.fires()` is read once and
 * the newly lit cells are not themselves rolled for in this same step. Without
 * that, a fire would race across the world in a single step in whatever order
 * the map happened to iterate — the classic cellular-automaton bug where the
 * update order becomes the physics.
 *
 * A cell already alight is skipped before the roll rather than after, so a fire
 * surrounded by fire spends no randomness at all — which is what keeps the cost
 * of a large burn proportional to its PERIMETER rather than its area.
 */
export function spreadOnce(world: WorldApi, blaze: Blaze, dt: number): FireCellState[] {
  const wind = currentWind();
  const sources = blaze.fires();
  const caught: FireCellState[] = [];

  for (const fire of sources) {
    for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
      const x = fire.x + dx;
      const y = fire.y + dy;
      if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
      if (blaze.isBurning(x, y)) continue;

      const rate = spreadRate(world, fire, dx, dy, wind);
      if (rate <= 0) continue;
      if (!happensWithin(rate, dt)) continue;

      // May still decline: nothing flammable there, or the world is already
      // burning at FIRE_CELL_CAP. Both are ordinary answers — see Blaze.ignite.
      const lit = blaze.ignite(x, y);
      if (lit !== null) caught.push(lit);
    }
  }

  return caught;
}
