// How a fire gets from one cell to the next.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE RATE, AND THE TERMS THAT MULTIPLY IT.
//
// Every neighbour of every burning cell is being HEATED, at a rate per second:
//
//   rate = BASE_SPREAD_RATE × intensity × wind × slope × diagonal × wet
//
// and ./heat.ts's ledger integrates that rate over the time the two were
// exposed to each other, summed over every source heating the same target. The
// target catches when the total reaches a threshold it drew once, on its first
// exposure — mean 1, so a constant rate of r per second still means "catches in
// 1/r seconds on average", which is the unit every constant below is quoted in.
// Nothing else influences it. Keeping it to one product is what makes the
// mechanic tunable at all — every term is a number a player can be taught, and
// a term that cannot be explained in one sentence does not belong in it.
//
// THE RATE IS SPENT, NOT ROLLED, and that is issue #288 rather than a detail.
// A per-step roll is memoryless: two equally exposed neighbours caught about
// twelve seconds apart, so a fire threw isolated spots and the burn was a
// percolation cluster instead of an edge that walks. ./heat.ts carries the
// reasoning and the shape constant; nothing else in this file changed because
// of it, which is the point — the product above is untouched.
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
//              SPREAD_MIN_DISTANCE_CELLS. Inside one cell the flame is being
//              TOUCHED rather than radiated at, and the term ramps to
//              CONTACT_SPREAD_RATE_PER_SECOND: no cell is ever that close to
//              another cell's fire, so only something that moves gets there.
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
//
// ─────────────────────────────────────────────────────────────────────────────
// A THING THAT MOVES IS EXPOSED FOR A STRETCH OF TIME, NOT AT AN INSTANT.
//
// A step runs once every SPREAD_INTERVAL_SECONDS and used to ask, of each
// individual, ONE question: are you within reach RIGHT NOW — and then charged
// the answer the whole interval. For a cell that is exact, because a cell was
// where it is for the whole interval and will be there for the next one. For
// anything that walks it is a strobe, and the faster the thing the worse the
// lie, in both directions:
//
//   MISSED ENTIRELY. A grazer crosses at 6.4 cells/s (wildlife's species.ts)
//   and is within SPREAD_REACH_CELLS of a fire for 2·√2/6.4 ≈ 0.44 s of that
//   crossing — so it is inside the flame at sample time on fewer than half its
//   crossings, and fleeing at ×3 on fewer than one in six. Issue #227, owner
//   in-world 2026-08-28: animals run straight through a fire and never catch.
//
//   OVER-CHARGED WHEN NOT MISSED. The crossing that IS sampled is then rolled
//   as though the animal had stood in the flame for a whole second, which is
//   the same error with the other sign.
//
// So exposure is computed along the SWEPT SEGMENT each end travelled since the
// previous step: how long the two were actually within reach of each other
// (the DWELL) and how close they got while they were (the GAP). The dwell is
// the exposure time the rate is charged over (./heat.ts), which is exactly
// what accumulating rate × time promises — half a second beside a flame is
// half a second's worth of heat, whether it arrives as one sample or as two.
//
// WHERE THE PREVIOUS POSITION COMES FROM: this file remembers it. It is not
// asked of the registrants (./entityFuel.ts), and that is the point — the
// sampling cadence is fire's own, so "where was it one sample ago" is fire's
// question to answer. A source that only reports where its individual is now
// cannot forget an obligation it was never handed.
//
// STATIONARY ENDS ARE UNTOUCHED BY THIS, by construction: with no relative
// motion the dwell is the whole interval and the gap is the distance, which is
// the arithmetic that was here before. Cell-to-cell spread does not change.
// ─────────────────────────────────────────────────────────────────────────────

import { BAND_HEIGHT } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import {
  fireEntityKey,
  fireIntensity,
  fireKey,
  type FireCellState,
  type FireEntityState,
} from '../protocol.ts';
import type { Blaze } from './blaze.ts';
import type { EntityBlaze } from './entityBlaze.ts';
import { entityFuelSources, type FlammableIndividual } from './entityFuel.ts';
import { HeatLedger } from './heat.ts';
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
 * is the same integral either way (./heat.ts accumulates rate × time, so how
 * finely the time is chopped cannot change the balance). One second is also
 * roughly the pace at
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
 * intensity, so at 0.08/s each of its eight neighbours got roughly a 4-in-5
 * chance of catching over the fire's life — a dense stand goes up, and an
 * isolated tree with one neighbour usually takes it with it but not always.
 * Much higher and every fire is total; much lower and fire stops being a threat
 * worth digging a break against.
 *
 * RAISED FROM 0.08 TO 0.14 WITH THE HEAT MODEL (./heat.ts), and this ×1.75 is
 * AN EDUCATED GUESS pending an in-world retune (issue #158) — it is written
 * down as a guess rather than presented as derived. WHY IT HAD TO MOVE AT ALL:
 * the old memoryless roll let a target be LUCKY, and on a solid bed the lucky
 * ignitions are what carried the burn outward. A threshold with a coefficient
 * of variation of 0.35 removes most of that luck, and a rig over 60 s on a
 * solid bed measured the burned area falling from 608 cells to 214 at the same
 * 0.08 — the front is the right shape but too slow to be a threat. 1.75 is the
 * factor that puts the burned area back in the neighbourhood of the pace the
 * mechanic was balanced at; what it is NOT is a measurement of the pace the
 * game wants, which is what #158 is for.
 */
export const BASE_SPREAD_RATE_PER_SECOND = 0.14;

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
 * ADJACENT cell alight. Below it the flame is being TOUCHED rather than
 * radiated at, and CONTACT_SPREAD_RATE_PER_SECOND takes over.
 */
export const SPREAD_MIN_DISTANCE_CELLS = 1;

/**
 * How long a thing can be INSIDE a flame before it catches, in seconds.
 *
 * A SECOND MECHANISM, not a tuning of the first, and the distinction is the
 * whole of issue #227. BASE_SPREAD_RATE_PER_SECOND prices a flame HEATING
 * something a cell away for as long as it burns — the tree next door, which
 * stands there for the fire's whole 22-second life and has four fifths of a
 * chance over it. Nothing that holds still is ever any closer than that, so
 * until things that move became fuel there was no reason for the model to know
 * what touching a fire does.
 *
 * A moving thing is only ever in the flame in passing: a grazer crosses a
 * burning cell in 1/6.4 s at cruise and a third of that fleeing (wildlife's
 * species.ts). Priced at the neighbour's rate that is a 1-in-80 chance of
 * catching, which is what the owner saw — animals running clean through a fire.
 * Priced as CONTACT, at 0.15 s, an animal that runs through a fire catches and
 * one that runs PAST it, a cell out, still mostly does not. That is the
 * mechanic the issue asks for, stated as the physical difference it is.
 *
 * 0.15 s is the smallest interval this can be given and still be a chance
 * rather than a certainty: it is roughly one animation frame of a creature at
 * cruise crossing a cell, so "you were in the fire for a moment" is genuinely
 * survivable and "you ran through it" is not.
 */
export const CONTACT_IGNITION_SECONDS = 0.15;

/**
 * Chance per second of catching while in direct contact with a flame.
 *
 * The reciprocal of the time above, which is what a rate IS once ./heat.ts
 * spends it: a thing in contact for CONTACT_IGNITION_SECONDS has taken on
 * exactly one mean threshold of heat, so a moment in the flame is an even
 * chance and a moment longer is not. Derived rather than written down so the
 * two can never drift apart, and so the tunable number is the one that can be
 * explained to a player.
 */
export const CONTACT_SPREAD_RATE_PER_SECOND = 1 / CONTACT_IGNITION_SECONDS;

/**
 * The distance term: 1/d beyond a cell, and a ramp from contact to a cell
 * inside that.
 *
 * BEYOND ONE CELL it is the 1/d this file has always had — the same number
 * wherever the old flat 1/√2 diagonal factor applied (d = 1 cardinally, d = √2
 * at a corner), so cell-to-cell spread is untouched. A cell target is never
 * nearer than one cell to a neighbouring cell fire, so the ramp below cannot
 * reach the lattice at all; only something standing off it can be in there.
 *
 * INSIDE ONE CELL it runs linearly from the contact rate at zero to the
 * neighbour rate at one. Linear because it is the boring monotone choice and
 * nothing here justifies a curve: what the term has to express is that being
 * IN a fire is categorically worse than being beside one, and any monotone ramp
 * says that. The two ends are the two rates that were reasoned about; the
 * middle is interpolation, and is honestly nothing more.
 */
function distanceFactor(distanceCells: number): number {
  if (distanceCells >= SPREAD_MIN_DISTANCE_CELLS) return SPREAD_MIN_DISTANCE_CELLS / distanceCells;

  const contactFactor = CONTACT_SPREAD_RATE_PER_SECOND / BASE_SPREAD_RATE_PER_SECOND;
  const towardsContact =
    (SPREAD_MIN_DISTANCE_CELLS - Math.max(0, distanceCells)) / SPREAD_MIN_DISTANCE_CELLS;
  return 1 + (contactFactor - 1) * towardsContact;
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
 * How fast a fire at `from` heats whatever is at `to`, per second — the rate
 * ./heat.ts integrates, and a chance per second only in the sense that a target
 * takes one mean threshold's worth of it in 1/rate seconds.
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

/** A point in fractional cell space — the space everything that moves lives in. */
interface Position {
  readonly x: number;
  readonly y: number;
}

/**
 * Where every individual this file saw last step was standing, by
 * `fireEntityKey`. Rebuilt whole at the end of each step, so an individual that
 * has gone drops out of it for free.
 *
 * MODULE STATE, and the one piece this file has. It is a memory of the previous
 * SAMPLE, which is a property of the sampling — see the header on why that
 * makes it fire's to keep rather than a registrant's to report.
 */
let previousSweep = new Map<string, Position>();

/**
 * How much heat every flammable thing in reach of a flame has taken on.
 *
 * THE OTHER PIECE OF MODULE STATE, and the reason spread has a memory of its
 * own at all: catching is an accumulation, so the accumulator has to outlive
 * the step. It is reset wherever `previousSweep` is, for the same reason — see
 * `resetSpreadSweep` and ./heat.ts's `clear`.
 */
const heatLedger = new HeatLedger();

/**
 * Forgets the previous sample.
 *
 * Called when the world stops burning and when fire state is reset or rolled
 * back, because in all three cases the next step's "previous position" would
 * not be one interval old — it would be from before a gap of unknown length,
 * or from a world that no longer exists, and the segment between the two is a
 * path nothing walked.
 *
 * The cost of forgetting is bounded and small: with no previous sample an
 * individual is treated as having stood still, which is exactly the behaviour
 * this file had before, for exactly one step.
 */
export function resetSpreadSweep(): void {
  previousSweep.clear();
  // ONE FUNCTION FOR BOTH MEMORIES. Heat and the previous sample are reset in
  // exactly the same circumstances and would be a bug in exactly the same way
  // if either were forgotten, so a caller is never given the chance to reset
  // one and not the other.
  heatLedger.clear();
}

/** Where this individual was one step ago, or `now` when there is no sample. */
function whereItWas(sourceName: string, id: number, now: Position): Position {
  return previousSweep.get(fireEntityKey(sourceName, id)) ?? now;
}

/**
 * A cell does not move, so its swept segment is the point it stands on. Named
 * so that the call sites read as what they are rather than as a duplicated
 * argument.
 */
function stoodStill(at: Position): Position {
  return at;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SPATIAL REJECT, AND WHY IT CANNOT CHANGE A FIRE.
//
// `spreadToIndividuals` used to ask `exposureAlongPaths` about EVERY candidate
// for EVERY source: FIRE_CELL_CAP burning cells against every flammable
// individual in the world is a third of a million quadratics a second — plus
// two template-string map keys per pair, which measured as about half of it —
// for a flame that can only ever reach its own neighbourhood.
//
// WHAT MAKES A CHEAP REJECT SOUND. `exposureAlongPaths` returns non-null only
// when there is some s in [0, 1] with |to(s) - from(s)| <= reach, where reach
// is SPREAD_REACH_CELLS plus the target's radius. At that s the flame stands at
// from(s), a point of the SOURCE's swept segment, and the target stands at
// to(s), a point of the TARGET's swept segment. So
//
//   exposure != null  =>  bbox(source segment) meets bbox(target segment grown
//                         by reach)
//
// and the contrapositive — boxes apart, exposure null — is the reject. The
// converse does NOT hold, which is exactly what makes this a reject and not a
// test: everything it keeps still goes through the same quadratic, unchanged.
//
// THE SEGMENT AND NOT THE POINT is the part that is easy to get wrong. A grazer
// crosses at 6.4 cells/s and at x3 when fleeing, so over one
// SPREAD_INTERVAL_SECONDS it can be twenty cells from where it was; a reject
// built on current positions alone would drop the fast crossings this file was
// rewritten to catch. Both ends are boxed over their whole interval instead.
//
// THE ROLL STREAM IS UNTOUCHED. A rejected pair is one `exposureAlongPaths`
// would have returned null for, and a null exposure spends no randomness
// (./rng.ts is reached only past `exposure !== null` and `rate > 0`). Candidates
// are visited in the order `flammableNow` gathered them, as before. Same
// history, same fires.
//
// THE GRID IS ONLY AN INDEX over that reject: each candidate is filed in every
// bucket its grown box touches, and a source looks in every bucket its own box
// touches. Two overlapping boxes share a point and that point sits in exactly
// one bucket, so nothing the reject would keep can be missed. Bucket size is
// therefore a TUNING number, not a correctness bound.

/**
 * The side of one bucket, in cells.
 *
 * Chosen as a small multiple of the standing reach — SPREAD_REACH_CELLS (root
 * two) plus the largest hull radius anything registers, so about 1.5-2 cells —
 * which is the scale a motionless fire's box has. That keeps a still source
 * inside a 2x2 range of buckets while leaving each bucket sparse enough that
 * the visit is a handful of candidates rather than a scan of the world. Smaller
 * buckets cost more empty lookups per source; larger ones hand back candidates
 * the quadratic then rejects. Neither is a correctness question.
 */
const SPREAD_BUCKET_CELLS = 4;

/**
 * One candidate with everything the pairing loop needs precomputed once per
 * step: its previous sample, its identity key, and the box the reject uses.
 */
interface SweptCandidate {
  readonly individual: FlammableIndividual;
  /** `fireEntityKey` built ONCE per step rather than twice per pair. */
  readonly key: string;
  /** Where it was one step ago — itself, when there is no previous sample. */
  readonly was: Position;
  /** Its swept segment, grown by its own reach. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Boxes every candidate for the step, resolving its previous sample once. */
function sweptCandidates(candidates: readonly FlammableIndividual[]): SweptCandidate[] {
  const swept: SweptCandidate[] = [];
  for (const individual of candidates) {
    const key = fireEntityKey(individual.sourceName, individual.id);
    const was = previousSweep.get(key) ?? individual;
    // The same reach `exposureAlongPaths` will use, so the box is exactly the
    // one the proof above is about rather than an approximation of it.
    const reach = SPREAD_REACH_CELLS + Math.max(0, individual.radiusCells);
    swept.push({
      individual,
      key,
      was,
      minX: Math.min(was.x, individual.x) - reach,
      minY: Math.min(was.y, individual.y) - reach,
      maxX: Math.max(was.x, individual.x) + reach,
      maxY: Math.max(was.y, individual.y) + reach,
    });
  }
  return swept;
}

/** Numeric sort, named so `hits.sort` reads as the ordering it restores. */
function ascending(a: number, b: number): number {
  return a - b;
}

/**
 * A uniform bucket index over one step's candidates. Built once, queried once
 * per source. Lives exactly as long as the step does.
 */
class CandidateGrid {
  readonly candidates: readonly SweptCandidate[];

  private readonly bucketsPerSide: number;
  private readonly buckets = new Map<number, number[]>();
  /** Which query last saw each candidate — dedupes a candidate filed in more
   * than one of the buckets a single source visits, without clearing a set. */
  private readonly seen: Int32Array;
  private queries = 0;
  /** Reused result buffer; valid only until the next `near` call. */
  private readonly hits: number[] = [];

  constructor(worldSize: number, candidates: readonly SweptCandidate[]) {
    this.candidates = candidates;
    this.bucketsPerSide = Math.max(1, Math.ceil(worldSize / SPREAD_BUCKET_CELLS));
    this.seen = new Int32Array(candidates.length);

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const lastX = this.bucketOf(candidate.maxX);
      const lastY = this.bucketOf(candidate.maxY);
      for (let bx = this.bucketOf(candidate.minX); bx <= lastX; bx++) {
        for (let by = this.bucketOf(candidate.minY); by <= lastY; by++) {
          const key = bx * this.bucketsPerSide + by;
          const list = this.buckets.get(key);
          if (list === undefined) this.buckets.set(key, [index]);
          else list.push(index);
        }
      }
    }
  }

  /**
   * Every candidate whose grown box could overlap the segment from `start` to
   * `end`, in `flammableNow` order — which is the order the pairing loop ran in
   * before there was a grid, and therefore the order the seeded rolls come off
   * the stream in.
   */
  near(start: Position, end: Position): readonly number[] {
    const stamp = ++this.queries;
    const hits = this.hits;
    hits.length = 0;

    const lastX = this.bucketOf(Math.max(start.x, end.x));
    const lastY = this.bucketOf(Math.max(start.y, end.y));
    for (let bx = this.bucketOf(Math.min(start.x, end.x)); bx <= lastX; bx++) {
      for (let by = this.bucketOf(Math.min(start.y, end.y)); by <= lastY; by++) {
        const list = this.buckets.get(bx * this.bucketsPerSide + by);
        if (list === undefined) continue;
        for (const index of list) {
          if (this.seen[index] === stamp) continue;
          this.seen[index] = stamp;
          hits.push(index);
        }
      }
    }

    hits.sort(ascending);
    return hits;
  }

  /**
   * Which bucket a coordinate falls in, CLAMPED to the grid.
   *
   * Clamping rather than discarding is what keeps something standing off the
   * edge of the world — or a box grown past it — findable. It is safe because
   * clamping is monotone and both ends of a pair go through it: two overlapping
   * ranges still overlap after clamping, so the reject can only ever hand back
   * MORE pairs at the border, never fewer.
   */
  private bucketOf(coord: number): number {
    const bucket = Math.floor(coord / SPREAD_BUCKET_CELLS);
    if (bucket < 0) return 0;
    if (bucket >= this.bucketsPerSide) return this.bucketsPerSide - 1;
    return bucket;
  }
}

/** How long two things were within reach of each other, and how close. */
interface Exposure {
  /** Seconds of the interval spent within reach. Never 0 — see the null. */
  readonly dwellSeconds: number;
  /** Where the flame was at closest approach. */
  readonly fromX: number;
  readonly fromY: number;
  /** Where the target was at closest approach. */
  readonly toX: number;
  readonly toY: number;
  /** Flame-to-EDGE distance at closest approach, floored at 0. */
  readonly gapCells: number;
}

/**
 * The encounter between two things that each moved in a straight line over
 * `dt` — or null if they were never in reach of one another during it.
 *
 * Both ends are segments, so this covers all four cases in one piece of
 * arithmetic: a fire and an animal, a burning animal and a cell, a burning
 * animal running through a herd, and two things that both stood still. It is
 * expressed in RELATIVE motion, which is why the two moving ends cost nothing
 * extra: what matters is the separation, and the separation is itself a point
 * moving in a straight line.
 *
 * THE RATE IS QUOTED AT CLOSEST APPROACH AND CHARGED FOR THE WHOLE DWELL,
 * which is the encounter's PEAK rate rather than its mean — an upper bound, and
 * stated as one rather than discovered later. The exact answer is the integral
 * of the rate along the pass, and the distance term is 1/d, so the mean over a
 * pass differs from the peak by a transcendental and, for the worst case the
 * reach allows (grazing the boundary at √2 and closing to one cell), by about a
 * fifth. A fifth of a term that is itself one factor of five is not worth an
 * `asinh` in a loop that runs once a second over every burning thing; a
 * different curve on the distance term, or a reach much larger than a cell,
 * would make it worth revisiting.
 *
 * Writing r(s) = d0 + w·s for s in [0, 1] — d0 the separation at the start of
 * the interval, w how much that separation changed over it — "in reach" is
 * |r(s)| ≤ reach + radius, one quadratic in s. Its roots clipped to [0, 1] are
 * the stretch of the interval the two spent together; the vertex, clipped to
 * that same stretch, is their closest approach.
 */
function exposureAlongPaths(
  fromStart: Position,
  fromEnd: Position,
  toStart: Position,
  toEnd: Position,
  radiusCells: number,
  dt: number,
): Exposure | null {
  // Measured to the target's EDGE, so a two-cell hull is in reach from further
  // out than a walker standing at a point — ./entityFuel.ts's radiusCells.
  const reach = SPREAD_REACH_CELLS + Math.max(0, radiusCells);

  const startDx = toStart.x - fromStart.x;
  const startDy = toStart.y - fromStart.y;
  const driftX = toEnd.x - fromEnd.x - startDx;
  const driftY = toEnd.y - fromEnd.y - startDy;

  const driftSquared = driftX * driftX + driftY * driftY;
  const startDotDrift = startDx * driftX + startDy * driftY;
  const startSquared = startDx * startDx + startDy * startDy;

  let enter = 0;
  let leave = 1;
  if (driftSquared === 0) {
    // Nothing moved relative to anything else: they were in reach for the
    // whole interval or for none of it. This is the cell-to-cell case, and it
    // is the reason lattice spread is untouched by any of the above.
    if (startSquared > reach * reach) return null;
  } else {
    const discriminant =
      startDotDrift * startDotDrift - driftSquared * (startSquared - reach * reach);
    if (discriminant <= 0) return null;
    const root = Math.sqrt(discriminant);
    enter = Math.max(0, (-startDotDrift - root) / driftSquared);
    leave = Math.min(1, (-startDotDrift + root) / driftSquared);
    if (leave <= enter) return null;
  }

  // Closest approach, clipped into the stretch they were actually together
  // for: a pass that begins or ends mid-interval is at its closest at the
  // boundary, not at the vertex outside it.
  const closest =
    driftSquared === 0
      ? enter
      : Math.max(enter, Math.min(leave, -startDotDrift / driftSquared));

  const separation = Math.hypot(startDx + driftX * closest, startDy + driftY * closest);
  return {
    dwellSeconds: (leave - enter) * dt,
    fromX: fromStart.x + (fromEnd.x - fromStart.x) * closest,
    fromY: fromStart.y + (fromEnd.y - fromStart.y) * closest,
    toX: toStart.x + (toEnd.x - toStart.x) * closest,
    toY: toStart.y + (toEnd.y - toStart.y) * closest,
    gapCells: Math.max(0, separation - Math.max(0, radiusCells)),
  };
}

/**
 * Heats every individual in reach of one source, and reports the ones that
 * reached their threshold.
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
  fromWas: Position,
  grid: CandidateGrid,
  wind: { readonly heading: number; readonly speed: number },
  dt: number,
  caught: FireEntityState[],
): void {
  // Only the candidates whose swept box could reach this source's — see THE
  // SPATIAL REJECT above for why everything else is provably a null exposure.
  for (const index of grid.near(fromWas, from)) {
    const swept = grid.candidates[index]!;
    const candidate = swept.individual;
    // Still asked per pair, because this changes DURING the step: something lit
    // by an earlier source must not be rolled for again by a later one.
    if (entityBlaze.isBurningKey(swept.key)) continue;

    const exposure = exposureAlongPaths(
      fromWas,
      from,
      swept.was,
      candidate,
      candidate.radiusCells,
      dt,
    );
    if (exposure === null) continue;

    // The rate is quoted at CLOSEST APPROACH — the moment of the encounter
    // that actually decides it — and then charged for however long the
    // encounter lasted. Quoting it at either endpoint instead would price a
    // crossing by where the animal happened to be when the clock ticked,
    // which is the strobe this whole computation exists to remove.
    const rate = spreadRate(
      world,
      { ...from, x: exposure.fromX, y: exposure.fromY },
      { x: exposure.toX, y: exposure.toY },
      wind,
      exposure.gapCells,
    );
    if (rate <= 0) continue;
    // Charged for the DWELL — how long the two were actually within reach —
    // which is the exposure time ./heat.ts's units are quoted in.
    if (!heatLedger.absorb(swept.key, rate, exposure.dwellSeconds)) continue;

    // May still decline — the entity cap is full, or something took it in the
    // meantime. An ordinary answer, exactly as Blaze.ignite's null is.
    const lit = entityBlaze.igniteIndividual(candidate);
    if (lit === null) continue;
    // THE HEAT IS SPENT ONLY ON THE ANSWER "yes" (./heat.ts's absorb/consume
    // pair). FIRE_ENTITY_CAP refuses in exactly the way FIRE_CELL_CAP does, so
    // the same defect lived here: an animal that had stood in the fire long
    // enough to catch, turned away because 48 other things were already alight,
    // used to lose every second of it and start again from a fresh threshold.
    //
    // The cell path additionally ORDERS its refused targets by heat; this one
    // does not, and deliberately. That ordering is what makes a FRONT a front —
    // a geometric claim about a contiguous edge of cells — and a set of at most
    // FIRE_ENTITY_CAP individuals scattered across a world has no edge for it to
    // be about. Retaining the heat is the whole of the fix that applies here.
    heatLedger.consume(swept.key);
    caught.push(lit);
  }
}

/**
 * One cell that has taken enough heat to catch, and is waiting to be let.
 *
 * `excess` is filled in once, when the step's whole set is ordered — see
 * `igniteInHeatOrder`.
 */
interface HeatedCell {
  readonly key: number;
  readonly x: number;
  readonly y: number;
  readonly excess: number;
}

/**
 * Heats the cells around one source's position, and records the ones that
 * reached their threshold.
 *
 * IT DOES NOT LIGHT THEM. Which of the step's crossings actually catch is a
 * decision that cannot be made one source at a time: at FIRE_CELL_CAP there
 * are fewer slots than crossings, and handing them out as the loop happens to
 * reach them makes the burning set's SHAPE a function of `blaze.fires()`
 * iteration order rather than of the fire. So a crossing is filed, keyed by the
 * cell — the same cell crossed for two different sources is one crossing — and
 * `spreadOnce` resolves the whole set at the end of the step.
 */
function spreadToCells(
  world: WorldApi,
  blaze: Blaze,
  from: SpreadSource,
  origin: { readonly x: number; readonly y: number },
  offsets: readonly (readonly [number, number])[],
  wind: { readonly heading: number; readonly speed: number },
  dt: number,
  crossed: Map<number, { readonly x: number; readonly y: number }>,
): void {
  for (const [dx, dy] of offsets) {
    const x = cellOf(origin.x) + dx;
    const y = cellOf(origin.y) + dy;
    if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
    if (blaze.isBurning(x, y)) continue;

    const rate = spreadRate(world, from, { x, y }, wind);
    if (rate <= 0) continue;
    // A cell stands where it is for the whole step, so its exposure is the
    // step. Same ledger, same units as the individual path above.
    const key = fireKey(x, y);
    if (!heatLedger.absorb(key, rate, dt)) continue;

    if (!crossed.has(key)) crossed.set(key, { x, y });
  }
}

/**
 * Lights this step's crossings, HOTTEST FIRST, and reports the ones that took.
 *
 * WHY AN ORDER AT ALL. Below FIRE_CELL_CAP there are always enough slots and
 * the order is invisible. At the cap the burning set is conserved — a cell can
 * only be lit when another burns out — so a step offers a few slots to a
 * crossing list several times longer, and the order IS the policy. Handed out
 * in `blaze.fires()` order (oldest fire first) the slots went to whatever the
 * REAR of the burn happened to be beside, and a front several hundred cells
 * around dissolved into scattered clumps (issue diagnosed 2026-09-02, live).
 *
 * WHY HEAT IS THE RIGHT ORDER. A cell at the leading edge of a dense front is
 * heated by several burning neighbours at once and accumulates fastest; a
 * straggler behind the front is heated by one dying neighbour and accumulates
 * slowest. Excess heat — how far past its own threshold a target has gone
 * (./heat.ts's `excessHeat`, which states why excess and not a ratio) — is
 * therefore a direct reading of how much fire is pressed against a cell, and
 * "the most heated cells first" is what "the front first" means arithmetically.
 * Because a refused crossing now KEEPS its heat, a cell left waiting climbs the
 * order every step, so the rule cannot starve anybody either.
 *
 * DETERMINISTIC. `excess` is read once per cell before the sort rather than
 * inside the comparator, ties break on (x, y), and no two entries share a cell
 * — so the result is a total order fixed by the step's numbers, not by the
 * Map's iteration order (design § determinism).
 *
 * THE LIST IS WALKED TO ITS END rather than stopped at the first refusal.
 * `Blaze.ignite` returns the same null for three unrelated reasons (its own doc
 * comment): cap full, nothing flammable there, already alight. Stopping on it
 * would let one burned-out cell at the head of the order block every real
 * candidate behind it. The list is bounded by the front's perimeter and a
 * refusal is a Map lookup, so walking it whole costs nothing worth the bug.
 */
function igniteInHeatOrder(
  blaze: Blaze,
  crossed: ReadonlyMap<number, { readonly x: number; readonly y: number }>,
): FireCellState[] {
  const caught: FireCellState[] = [];
  if (crossed.size === 0) return caught;

  const ordered: HeatedCell[] = [];
  for (const [key, cell] of crossed) {
    ordered.push({ key, x: cell.x, y: cell.y, excess: heatLedger.excessHeat(key) });
  }
  ordered.sort((a, b) => b.excess - a.excess || a.x - b.x || a.y - b.y);

  for (const cell of ordered) {
    const lit = blaze.ignite(cell.x, cell.y);
    if (lit === null) continue;
    // The heat is spent HERE and only here, on the one answer that means the
    // target actually caught — ./heat.ts's absorb/consume pair.
    heatLedger.consume(cell.key);
    caught.push(lit);
  }
  return caught;
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
 * THE ORDER OF THE PAIRINGS IS FIXED — cells against cells, cells against
 * individuals, then individuals against both, each in its collection's own
 * stable order — because a target's ignition threshold is drawn off one seeded
 * stream (./rng.ts) the first time anything heats it, and a replay that draws
 * them in a different order is a different fire.
 *
 * A thing already alight is skipped BEFORE it is heated rather than after, so a
 * fire surrounded by fire spends no randomness and keeps no ledger entries at
 * all — which is what keeps the cost of a large burn proportional to its
 * PERIMETER rather than its area.
 *
 * HEATING AND LIGHTING ARE TWO PHASES, not one. Every source heats every target
 * first; only then is the set of cells that crossed their threshold resolved
 * into actual fires, hottest first (`igniteInHeatOrder`). Individuals are still
 * lit in place, because their cap is about a scattered set with no edge to
 * order — see `spreadToIndividuals`.
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
  const candidates = sweptCandidates(flammableNow());
  const grid = new CandidateGrid(world.worldSize, candidates);

  // Every cell that reaches its threshold this step, gathered rather than lit
  // as it is found: see `spreadToCells` and `igniteInHeatOrder` for why the
  // decision has to be made over the whole set at once.
  const crossed = new Map<number, { readonly x: number; readonly y: number }>();
  const entities: FireEntityState[] = [];

  for (const fire of cellSources) {
    spreadToCells(world, blaze, fire, fire, NEIGHBOUR_OFFSETS, wind, dt, crossed);
    spreadToIndividuals(world, entityBlaze, fire, stoodStill(fire), grid, wind, dt, entities);
  }

  for (const fire of entitySources) {
    spreadToCells(world, blaze, fire, fire, SELF_AND_NEIGHBOUR_OFFSETS, wind, dt, crossed);
    // A burning individual moved too, so its own previous sample is the start
    // of ITS segment — which is what makes a fire that runs through a herd the
    // same computation as a herd that runs through a fire.
    spreadToIndividuals(
      world,
      entityBlaze,
      fire,
      whereItWas(fire.sourceName, fire.id, fire),
      grid,
      wind,
      dt,
      entities,
    );
  }

  // THE SAMPLE THIS STEP TOOK, kept for the next one. Written after every roll
  // and rebuilt whole rather than patched, so nothing that has left the world
  // lingers in it. Burning individuals are recorded alongside the candidates
  // because they are the SOURCE end of the next step's segments, and a source
  // no registrant still lists in `flammable` would otherwise have no memory.
  const sweep = new Map<string, Position>();
  for (const candidate of candidates) {
    sweep.set(candidate.key, { x: candidate.individual.x, y: candidate.individual.y });
  }
  for (const fire of entitySources) {
    sweep.set(fireEntityKey(fire.sourceName, fire.id), { x: fire.x, y: fire.y });
  }
  previousSweep = sweep;

  // NOW that every source has been offered to every cell, hand out the slots —
  // most-heated first, which is the front's leading edge. Before `endStep`,
  // because a crossing that is refused must still count as touched this step or
  // the ledger would drop the very heat this ordering is built on.
  const cells = igniteInHeatOrder(blaze, crossed);

  // CLOSE THE LEDGER AFTER EVERY SOURCE HAS BEEN OFFERED, never before: a
  // target heated by the last source of the step must count as touched, or it
  // would be dropped and start the next step cold. See ./heat.ts on why one
  // sweep here is the whole of the entry lifetime.
  heatLedger.endStep();

  return { cells, entities };
}
