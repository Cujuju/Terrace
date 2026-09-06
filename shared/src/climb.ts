// Climbing — what a legged mover does when the way on is a wall.
//
// WHY IT EXISTS (owner, 2026-09-05: "peeps need to be able to climb anything …
// and I think I would even like them to be able to slowly climb sheer walls
// with maybe a fifteen percent chance of falling and dying"). Measured on the
// live world (frostwick-hollows, snapshot 990) the land a LAND_WALKER_PROFILE
// leaves connected is shattered: 35 617 separate regions over 66 255 walkable
// cells, 28 157 of them a single isolated cell, and the LARGEST reachable
// region is 4.3 % of the land and spans exactly ONE terrace band. A walker's
// gradient limit is LAND_WALKER_MAX_GRADIENT_PER_CELL (2 height units per
// cell) while relaxation leaves adjacent cells differing by up to
// MAX_STEP + RELAX_SLACK (5) and the renderer draws in steps of BAND_HEIGHT
// (16) — so 68 % of adjacent land pairs are refused outright, and a band
// change, which is every visible step in a terraced world, is EIGHT TIMES the
// limit and can never be crossed at all. That is the "they seem to always be
// confined to one layer" the owner saw.
//
// THE RULE, AND WHERE IT LIVES. A profile that carries a `climb` rule
// (traversal.ts's ClimbRule) may cross ANY rise, up or down, by climbing it
// instead of walking it: slowly, at CLIMB_SECONDS_PER_BAND, and with one roll
// of that rule's `fallChance` at the foot of the wall. Everything about how a
// climb PROGRESSES is here; everything about WHO may climb is a profile, and
// everything about what a climb COSTS a route is pathing.ts. Three files, one
// rule each, so a mover cannot be given the ability without also being priced
// for it.
//
// DESCENT IS A CLIMB TOO. A wall refused on the way up is refused on the way
// down by the same symmetric |dh| test, so a climber that could only go up
// would strand itself on the first ledge it reached. Same speed, same roll:
// letting go of a cliff face is what kills you, and that is as true downward.
//
// DETERMINISM. No `Math.random` anywhere: the fall is decided by hashing a
// caller-supplied seed (rng.ts's `hashToIndex`, the same murmur3 finalizer
// every seeded thing in this repo uses), so two servers fed the same streams
// kill the same peep on the same wall — the property plugins/pilgrims'
// simulation header already promises for everything else it does.

import { BAND_HEIGHT } from './constants.ts';
import { hashToIndex } from './rng.ts';
import { admitsHeight, exceedsWalkableGradient, type TerrainSampler, type TraversalProfile } from './traversal.ts';

/**
 * Seconds a climber spends on one BAND of wall.
 *
 * 4 — owner, 2026-09-05, picking "a brisk scramble" over an ordeal. Against
 * the shipped walk it is what makes a wall a decision rather than a shortcut:
 * a peep covers a cell of flat ground in 0.5 s (PILGRIM_WALK_SPEED_CELLS_PER_
 * SECOND, 0.5 world units/s over a CELL_WORLD_SIZE of 0.25), so one band of
 * wall costs the same time as eight cells of walking — and pathing.ts prices
 * it at exactly that, plus the risk.
 *
 * A BAND IS THE UNIT because a band is what a player sees: the terrain draws
 * quantised to band floors, so every wall in the world is a whole number of
 * these, and "four seconds a band" is a sentence about the picture rather than
 * about the height scale underneath it.
 */
export const CLIMB_SECONDS_PER_BAND = 4;

/** The same speed in the height units the sim actually moves in. */
export const CLIMB_RISE_HEIGHT_UNITS_PER_SECOND = BAND_HEIGHT / CLIMB_SECONDS_PER_BAND;

/**
 * How fast a climber that has let go drops, in height units per second.
 *
 * EIGHT TIMES THE CLIMB, and it is a statement about what the two things ARE
 * rather than a tuned number: climbing is work against the wall and falling is
 * not, so a fall must read as a fall — one band in half a second — where the
 * climb it interrupts took four. Slower and a fall reads as a controlled
 * descent, which is the one thing it must not look like.
 */
export const FALL_DROP_HEIGHT_UNITS_PER_SECOND = CLIMB_RISE_HEIGHT_UNITS_PER_SECOND * 8;

/**
 * Denominator the fall roll is taken over — basis points.
 *
 * A `fallChance` is a fraction and `hashToIndex` returns an integer, so the
 * comparison needs a scale. 10 000 makes every chance the owner has asked for
 * (15 %, 5 %, 1 %) exact rather than rounded, and leaves three more decimal
 * places for any future one.
 */
export const FALL_ROLL_BASIS_POINTS = 10_000;

/**
 * Where up the wall a doomed climber lets go, as a fraction of the rise.
 *
 * NOT AT THE TOP AND NOT AT THE BOTTOM. A climber that always fell from the
 * last inch would read as being pushed off the ledge, and one that fell in the
 * first inch would read as never having started; both make the fall look like
 * a bug rather than a slip. The fraction is HASHED per climb between these two
 * bounds, so consecutive falls on the same wall let go at visibly different
 * heights.
 */
export const FALL_RELEASE_MIN_FRACTION = 0.25;
export const FALL_RELEASE_MAX_FRACTION = 0.9;

/** Steps the release fraction is hashed over between the two bounds above. */
const FALL_RELEASE_STEPS = 64;

/**
 * One climb in progress — the vertical state a climbing mover carries while
 * its horizontal position is pinned at the foot (or the lip) of the wall.
 *
 * THE MOVER DOES NOT MOVE HORIZONTALLY WHILE THIS IS SET, and that is the
 * whole reason the target cell is remembered here rather than being re-derived
 * on arrival: a climber pinned at the wall is still standing in its OLD cell,
 * which is what keeps it out of the rock, and the cell it is pulling itself
 * onto is only entered at the moment the climb completes.
 */
export interface ClimbState {
  /** The cell being climbed ONTO — entered only when the climb completes. */
  readonly toX: number;
  readonly toY: number;
  /** Stored height the climb started from and is heading for. */
  readonly fromHeight: number;
  readonly toHeight: number;
  /**
   * Where the climber is right now, in stored height units. Between
   * `fromHeight` and `toHeight` while climbing; falling back toward
   * `fromHeight` once a doomed climb has let go.
   */
  height: number;
  /** Decided once, at the foot of the wall (`beginClimb`). */
  readonly doomed: boolean;
  /** The height a doomed climb lets go at. Meaningless unless `doomed`. */
  readonly releaseHeight: number;
  /** True once it has let go: the height is now dropping, not rising. */
  falling: boolean;
}

/** What one `advanceClimb` tick did. `fallen` means the caller's mover dies. */
export type ClimbOutcome = 'climbing' | 'arrived' | 'fallen';

/**
 * Starts a climb from the mover's own cell onto (toX, toY), or null if that
 * step is not a climb this profile has to make.
 *
 * NULL FOR EVERY REASON A CLIMB IS NOT THE ANSWER, and the caller treats them
 * all the same way (keep walking, or give up): the profile cannot climb, the
 * target is not ground this mover may stand on at all (water, the wrong band,
 * a river — climbing does not make a lake crossable), or the step was never
 * blocked in the first place and is simply walkable.
 *
 * `seed` decides the fall. It must be stable for THIS climb and different for
 * the next one — a mover id mixed with the cell it is climbing onto and a
 * per-mover climb counter is the shape every caller uses; see plugins/pilgrims'
 * `climbSeedFor`.
 */
export function beginClimb(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  seed: number,
): ClimbState | null {
  const rule = profile.climb;
  if (rule === undefined || rule === null) return null;

  const cellX = Math.floor(toX);
  const cellY = Math.floor(toY);
  if (cellX < 0 || cellY < 0 || cellX >= world.worldSize || cellY >= world.worldSize) return null;

  const toHeight = world.heightAt(cellX, cellY);
  // A climb reaches a cell a WALK could have reached had it not been so steep.
  // Every other reason a cell is closed to this mover still closes it.
  if (!admitsHeight(profile, toHeight)) return null;

  const fromHeight = world.heightAt(Math.floor(fromX), Math.floor(fromY));
  if (!exceedsWalkableGradient(profile, toHeight - fromHeight)) return null;

  const doomed = hashToIndex(seed, FALL_ROLL_BASIS_POINTS) < rule.fallChance * FALL_ROLL_BASIS_POINTS;
  // A second, independent draw off the same seed: the first decides WHETHER,
  // this one decides WHERE. `seed + 1` rather than a second seed argument
  // because hashToIndex's mix is an avalanche — consecutive seeds land far
  // apart, which is exactly the property its own comment promises.
  const releaseStep = hashToIndex(seed + 1, FALL_RELEASE_STEPS);
  const releaseFraction =
    FALL_RELEASE_MIN_FRACTION +
    ((FALL_RELEASE_MAX_FRACTION - FALL_RELEASE_MIN_FRACTION) * releaseStep) / (FALL_RELEASE_STEPS - 1);

  return {
    toX: cellX,
    toY: cellY,
    fromHeight,
    toHeight,
    height: fromHeight,
    doomed,
    releaseHeight: fromHeight + (toHeight - fromHeight) * releaseFraction,
    falling: false,
  };
}

/**
 * Advances one climb by `dt` seconds, in place.
 *
 * 'arrived' means the caller moves its mover into (toX, toY) and clears the
 * state; 'fallen' means the climber is back at the foot of the wall having let
 * go, and the caller kills it. Both are terminal — a caller that keeps ticking
 * a finished climb gets the same answer again rather than a moving corpse.
 */
export function advanceClimb(state: ClimbState, dt: number): ClimbOutcome {
  const step = Math.max(0, dt);
  const rising = state.toHeight >= state.fromHeight;
  // Toward the target while climbing, back toward the foot once it has let go.
  const direction = state.falling === rising ? -1 : 1;

  if (state.falling) {
    state.height += direction * FALL_DROP_HEIGHT_UNITS_PER_SECOND * step;
    const hitTheGround = rising ? state.height <= state.fromHeight : state.height >= state.fromHeight;
    if (hitTheGround) {
      state.height = state.fromHeight;
      return 'fallen';
    }
    return 'climbing';
  }

  state.height += direction * CLIMB_RISE_HEIGHT_UNITS_PER_SECOND * step;

  // The release is tested BEFORE arrival: a doomed climb whose release height
  // and target are within one tick of each other must still fall, or a fast
  // enough tick would quietly save it.
  if (state.doomed) {
    const letGo = rising ? state.height >= state.releaseHeight : state.height <= state.releaseHeight;
    if (letGo) {
      state.height = state.releaseHeight;
      state.falling = true;
      return 'climbing';
    }
  }

  const arrived = rising ? state.height >= state.toHeight : state.height <= state.toHeight;
  if (arrived) {
    state.height = state.toHeight;
    return 'arrived';
  }
  return 'climbing';
}
