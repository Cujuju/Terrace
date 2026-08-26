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
//   DISTANCE   fire falls off with how far it has to reach. A cardinal
//              neighbour is 1 cell away and gets the rate whole; a diagonal is
//              √2 away and gets 1/√2 of it. Without this a fire spreads as a
//              square. It is a DISTANCE term rather than a diagonal flag
//              because a thing that moves does not stand on the lattice — see
//              SPREAD_MIN_DISTANCE_CELLS.
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
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT BURNS IS A QUESTION ABOUT DISTANCE, NOT ABOUT REGISTRIES.
//
// This file used to read `blaze.fires()` and light cells through `blaze.ignite`,
// which meant both ends of every spread were cells. Fire therefore could not
// cross between the two fuel registries in either direction: a wildfire burned
// up to a moored boat and stopped, a burning boat sat in a reed bed and lit
// nothing, and a boat alight beside its neighbour in a packed fleet left that
// neighbour untouched. Nothing about a flame justified any of that — the fuel
// was in reach in every case. What decided it was WHICH REGISTRY THE OWNING
// PLUGIN HAPPENED TO REGISTER IN (../server/fuel.ts for things that hold still,
// ../server/entityFuel.ts for things that do not).
//
// So a spread step now takes SOURCES — everything alight, cell or individual —
// and TARGETS — everything flammable near one, cell or individual — and applies
// the SAME product above to all four combinations. `spreadRate` is keyed on a
// fractional offset rather than an integer cell step, which is what lets a
// thing standing at (12.4, 9.9) be a first-class end of a spread.
//
// THE LATTICE IS NOT LOST BY THIS. At the integer steps a cell fire actually
// takes, the distance term reproduces the old diagonal factor exactly (1 at a
// cardinal neighbour, 1/√2 at a corner) and SPREAD_REACH_CELLS is the corner
// distance itself, so cell-to-cell behaviour is unchanged BY CONSTRUCTION
// rather than by assertion.
// ─────────────────────────────────────────────────────────────────────────────

import { BAND_HEIGHT } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { fireIntensity, type FireCellState, type FireEntityState } from '../protocol.ts';
import type { Blaze } from './blaze.ts';
import type { EntityBlaze } from './entityBlaze.ts';
import { entityFuelSources, type FlammableIndividual } from './entityFuel.ts';
import { happensWithin } from './rng.ts';
import { currentWind, precipitationAt } from './weather-bridge.ts';

/**
 * One end of a spread: something alight, wherever it is and however far through
 * its burn it is.
 *
 * A CELL AND AN INDIVIDUAL BOTH SATISFY THIS, which is the point — it is the
 * only thing `spreadRate` needs to know about what is burning, so neither
 * registry has to be named anywhere in the arithmetic.
 */
export interface SpreadSource {
  /** Fractional cell space; a cell passes its own integer coordinates. */
  readonly x: number;
  readonly y: number;
  readonly ageSeconds: number;
  readonly burnSeconds: number;
}

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

/**
 * How far a flame reaches at all, in cells.
 *
 * √2 IS NOT A TUNING CHOICE — it is the distance to the corner of the
 * eight-neighbourhood this file has always used, so adopting it as the reach
 * leaves cell-to-cell spread bit-for-bit what it was while giving things that
 * stand off the lattice a reach defined in the same terms. A target further
 * than this is not a candidate at all and is never rolled for.
 */
export const SPREAD_REACH_CELLS = Math.SQRT2;

/**
 * The distance at which the rate is quoted whole — one cell, because
 * BASE_SPREAD_RATE_PER_SECOND is defined as the chance of setting a given
 * ADJACENT cell alight.
 *
 * It is a FLOOR on the divisor, not a minimum distance: two things can stand a
 * tenth of a cell apart, and without this the 1/d term would quietly multiply
 * the base rate tenfold for a crowd. Nothing burns faster than adjacent.
 */
export const SPREAD_MIN_DISTANCE_CELLS = 1;

/**
 * The distance term: 1/d, floored at one cell.
 *
 * Replaces the flat 1/√2 diagonal factor this file used to carry, and is the
 * same number wherever that one applied — d = 1 cardinally, d = √2 at a corner.
 * Stated as a distance because a boat two-fifths of a cell off a burning pier
 * is a real case and "is it diagonal?" has no answer for it.
 */
function distanceFactor(distanceCells: number): number {
  return SPREAD_MIN_DISTANCE_CELLS / Math.max(SPREAD_MIN_DISTANCE_CELLS, distanceCells);
}

/**
 * The cell a fractional position stands on.
 *
 * ROUNDING, not flooring, and it is not a style choice: a cell is the square of
 * side 1 CENTRED on its integer coordinates, which is what the client's own
 * pick does (client/src/terrain/picking.ts) and what @terrace/shared's
 * `nearestWithinReach` is written against. Flooring would offset every lookup
 * by half a cell and put a thing's height and rain reading one cell away from
 * where it is standing.
 *
 * Needed because `WorldApi.heightAt` and the weather bridge both index a grid:
 * handed 12.4 they do not interpolate, so the caller has to say which cell it
 * means.
 */
function cellOf(value: number): number {
  return Math.round(value);
}

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
 * How fierce a thing that is alight is right now, or 0 if it is too early or
 * too late in its burn to throw sparks.
 *
 * ONE DEFINITION FOR BOTH REGISTRIES: a burning boat and a burning tree are the
 * same clock (../protocol.ts's fireIntensity), so the gate that gives a fire a
 * front applies to both without either knowing about the other.
 */
function spreadingIntensity(source: SpreadSource): number {
  const intensity = fireIntensity(source.ageSeconds, source.burnSeconds);
  return intensity < SPREAD_MIN_INTENSITY ? 0 : intensity;
}

/**
 * Chance per second that a fire at `from` sets whatever is at `to` alight.
 *
 * Both ends are in FRACTIONAL CELL SPACE — the space things that move are
 * steered in — so a cell simply passes its integer coordinates. Exported
 * because it is the whole mechanic: a test that asserts on spread should assert
 * on this, not on the outcome of a hundred rolls.
 *
 * `gapCells` is how much of the distance is not flame-to-fuel: a target with a
 * two-cell hull is reached when the flame is two cells from its CENTRE, so the
 * caller subtracts the target's own radius and the rate is quoted on what is
 * left. Zero for a cell, which has no radius to speak of.
 */
export function spreadRate(
  world: WorldApi,
  from: SpreadSource,
  to: { readonly x: number; readonly y: number },
  wind: { readonly heading: number; readonly speed: number },
  gapCells?: number,
): number {
  const intensity = spreadingIntensity(from);
  if (intensity === 0) return 0;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const gap = gapCells ?? Math.hypot(dx, dy);
  if (gap > SPREAD_REACH_CELLS) return 0;

  // The wetness of the TARGET, not of the burning thing: what matters is
  // whether what is about to catch is wet, and a fire under a squall's edge
  // should still light the dry ground behind it.
  const wetFactor = 1 - WET_SPREAD_PENALTY * precipitationAt(cellOf(to.x), cellOf(to.y));
  return (
    BASE_SPREAD_RATE_PER_SECOND *
    intensity *
    windFactor(dx, dy, wind.heading, wind.speed) *
    slopeFactor(
      world.heightAt(cellOf(from.x), cellOf(from.y)),
      world.heightAt(cellOf(to.x), cellOf(to.y)),
    ) *
    distanceFactor(gap) *
    wetFactor
  );
}

/**
 * What one spread step set alight, in both registries.
 *
 * TWO LISTS BECAUSE THEY ARE BROADCAST SEPARATELY (../protocol.ts has a cell
 * message and an entity message), not because the mechanic distinguishes them.
 */
export interface SpreadResult {
  readonly cells: FireCellState[];
  readonly entities: FireEntityState[];
}

/** The eight neighbours plus the cell itself — what a burning INDIVIDUAL can
 * light on the ground. Its own cell is included and a cell fire's is not,
 * because a cell fire is already burning where it stands and a walking one is
 * not: a burning animal crossing dry grass sets the grass under it alight,
 * which is the whole reason a fire that walks is interesting. */
const SELF_AND_NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  ...NEIGHBOUR_OFFSETS,
];

/**
 * Everything flammable that is standing around right now, gathered ONCE.
 *
 * THE COST MODEL IS THE REASON THIS EXISTS rather than a call to
 * `entityFuelAt` per burning cell. That function is the TORCH's question ("of
 * yours, which did the player aim at?") and ./entityFuel.ts promises sources it
 * is asked only at ignition — pilgrims answers it by building three arrays and
 * spreading them, which is fine once per torch and ruinous four hundred times a
 * second. One sweep per source per step is O(individuals); the alternative is
 * O(burning × individuals).
 */
function flammableNow(): FlammableIndividual[] {
  const found: FlammableIndividual[] = [];
  for (const source of entityFuelSources()) {
    // A source that does not implement this cannot catch by spread — only by
    // torch or by lightning. Degrading here rather than throwing is ./fuel.ts's
    // stance: a registry that half the plugins have not caught up with yet
    // still runs, it just carries less fuel.
    if (source.flammable === undefined) continue;
    for (const individual of source.flammable()) {
      if (individual.fuel.burnSeconds <= 0) continue;
      if (!Number.isFinite(individual.x) || !Number.isFinite(individual.y)) continue;
      found.push(individual);
    }
  }
  return found;
}

/**
 * Rolls one source against every individual in reach of it.
 *
 * The gap is measured EDGE TO CENTRE — the individual's own radius is taken off
 * the distance — so a two-cell hull catches from further out than a walker
 * does. That is what "close enough" means for things with a size, and it is the
 * reason `FlammableIndividual` carries a radius at all.
 */
function spreadToIndividuals(
  world: WorldApi,
  entityBlaze: EntityBlaze,
  from: SpreadSource,
  candidates: readonly FlammableIndividual[],
  wind: { readonly heading: number; readonly speed: number },
  dt: number,
  caught: FireEntityState[],
): void {
  for (const candidate of candidates) {
    if (entityBlaze.isBurning(candidate.sourceName, candidate.id)) continue;

    const gap = Math.max(
      0,
      Math.hypot(candidate.x - from.x, candidate.y - from.y) - candidate.radiusCells,
    );
    if (gap > SPREAD_REACH_CELLS) continue;

    const rate = spreadRate(world, from, candidate, wind, gap);
    if (rate <= 0) continue;
    if (!happensWithin(rate, dt)) continue;

    // May still decline — the entity cap is full, or something took it in the
    // meantime. An ordinary answer, exactly as Blaze.ignite's null is.
    const lit = entityBlaze.igniteIndividual(candidate);
    if (lit !== null) caught.push(lit);
  }
}

/** Rolls one source against the cells around a position. */
function spreadToCells(
  world: WorldApi,
  blaze: Blaze,
  from: SpreadSource,
  origin: { readonly x: number; readonly y: number },
  offsets: readonly (readonly [number, number])[],
  wind: { readonly heading: number; readonly speed: number },
  dt: number,
  caught: FireCellState[],
): void {
  for (const [dx, dy] of offsets) {
    const x = cellOf(origin.x) + dx;
    const y = cellOf(origin.y) + dy;
    if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
    if (blaze.isBurning(x, y)) continue;

    const rate = spreadRate(world, from, { x, y }, wind);
    if (rate <= 0) continue;
    if (!happensWithin(rate, dt)) continue;

    // May still decline: nothing flammable there, or the world is already
    // burning at FIRE_CELL_CAP. Both are ordinary answers — see Blaze.ignite.
    const lit = blaze.ignite(x, y);
    if (lit !== null) caught.push(lit);
  }
}

/**
 * One spread step, across both registries.
 *
 * THE SNAPSHOTS ARE TAKEN FIRST, deliberately: `blaze.fires()`, the burning
 * individuals and the flammable sweep are each read once, and nothing lit
 * during this step is itself rolled for in it. Without that, a fire would race
 * across the world in a single step in whatever order the maps happened to
 * iterate — the classic cellular-automaton bug where the update order becomes
 * the physics.
 *
 * THE ORDER OF THE ROLLS IS FIXED — cells against cells, cells against
 * individuals, then individuals against both, each in its collection's own
 * stable order — because the rolls come off one seeded stream (./rng.ts) and a
 * replay that draws them in a different order is a different fire.
 *
 * A thing already alight is skipped BEFORE the roll rather than after, so a
 * fire surrounded by fire spends no randomness at all — which is what keeps the
 * cost of a large burn proportional to its PERIMETER rather than its area.
 */
export function spreadOnce(
  world: WorldApi,
  blaze: Blaze,
  entityBlaze: EntityBlaze,
  dt: number,
): SpreadResult {
  const wind = currentWind();
  const cellSources = blaze.fires();
  const entitySources = entityBlaze.burningWithAge();
  const candidates = flammableNow();

  const cells: FireCellState[] = [];
  const entities: FireEntityState[] = [];

  for (const fire of cellSources) {
    spreadToCells(world, blaze, fire, fire, NEIGHBOUR_OFFSETS, wind, dt, cells);
    spreadToIndividuals(world, entityBlaze, fire, candidates, wind, dt, entities);
  }

  for (const fire of entitySources) {
    spreadToCells(world, blaze, fire, fire, SELF_AND_NEIGHBOUR_OFFSETS, wind, dt, cells);
    spreadToIndividuals(world, entityBlaze, fire, candidates, wind, dt, entities);
  }

  return { cells, entities };
}
