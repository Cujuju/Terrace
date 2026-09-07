// STEERING — the one movement loop for everything that moves under its own
// power. Owner report 2026-08-20: "my little people seem to get stuck in the
// middle of nowhere, and they also tend to run into each other"; of the fleet,
// "they just kind of spin on top of each other". Four plugins had each grown a
// copy of this sweep and none of them knew another mover existed.
//
// A plugin still owns its speed, goals, give-up policy and state.
//
// DETERMINISM: fixed candidate order, occupants scanned from a caller-supplied
// ARRAY (never a Map or Set — iteration order would follow insertion history),
// no clock and no RNG.

import {
  WORLD_UNIT_CELLS,
  cellsAcross,
} from './constants.ts';
import { findRoute, type RouteCell } from './pathing.ts';
import { canProceedAlong, type TerrainSampler, type TraversalProfile } from './traversal.ts';

const TWO_PI = Math.PI * 2;

/** Wraps an angle into (−π, π] so two headings are always comparable. */
export function normalizeAngle(radians: number): number {
  const wrapped = radians % TWO_PI;
  if (wrapped > Math.PI) return wrapped - TWO_PI;
  if (wrapped <= -Math.PI) return wrapped + TWO_PI;
  return wrapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// The turning circle
// ─────────────────────────────────────────────────────────────────────────────

/** Clamps a turn to `limit` radians while keeping its direction. */
export function limitTurn(turn: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, turn));
}

/**
 * Turns `heading` toward `target` by at most `radiansPerSecond × dt`, and never
 * past it.
 *
 * Owner 2026-08-24: no spinning in place. A sweep returns a direction to WANT;
 * a mover adopts its current heading turned toward it at its own rate.
 *
 * The rate is not here — it is speed ÷ turn radius, measured per plugin.
 */
export function turnToward(
  heading: number,
  target: number,
  radiansPerSecond: number,
  dt: number,
): number {
  const remaining = normalizeAngle(target - heading);
  return normalizeAngle(heading + limitTurn(remaining, radiansPerSecond * dt));
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 8 × 45° — the coarsest sweep that still covers the full circle, so "boxed in"
 * means every direction failed rather than every direction sampled.
 */
export const AVOID_TURN_ATTEMPTS = 8;

/** Angle between successive candidates in the sweep. See AVOID_TURN_ATTEMPTS. */
export const AVOID_TURN_STEP_RADIANS = Math.PI / 4;

/** The moving state this file reads and writes. Every mover satisfies it. */
export interface Mover {
  x: number;
  y: number;
  heading: number;
}

/**
 * Somebody else already standing in the way, for the separation term.
 *
 * `radiusCells` lives on the OCCUPANT, not the profile: it is a fact about a
 * body, and a mixed crowd of different-sized bodies is the normal case.
 */
export interface Occupant {
  readonly x: number;
  readonly y: number;
  readonly radiusCells: number;
}

export interface SteerOptions {
  /**
   * Cells travelled along the chosen heading this tick, and the distance the
   * SEPARATION test is taken at (terrain is probed at `lookaheadCells`).
   *
   * REQUIRED, never defaulted to the look-ahead: that was the 2026-08-21 defect.
   * Measured then, minimum separation inside a school of five was 0.04 cells
   * against a 0.42 target — i.e. the test did nothing.
   */
  readonly stepCells: number;
  /**
   * Everyone else, in a FIXED order. A mover must not appear in its own list —
   * it would veto every heading at zero distance. See `withoutSelf`.
   */
  readonly occupants?: readonly Occupant[];
  /** This mover's own personal space, paired against each occupant's. */
  readonly selfRadiusCells?: number;
  /** Candidates beyond the desired heading. Defaults to AVOID_TURN_ATTEMPTS. */
  readonly attempts?: number;
  /** Angle between candidates. Defaults to AVOID_TURN_STEP_RADIANS. */
  readonly stepRadians?: number;
  /**
   * An extra veto a plugin needs — boats' hull pose, monsters' lair pose.
   *
   * RESIDUAL: called only at the probe's far END, not along it. Ground legality
   * is sampled the whole way; a caller's rule is not. A veto that can be true at
   * both ends and false in the middle will be missed.
   *
   * The heading passed is the one the mover would actually HOLD there — judging
   * a hull at its pre-turn heading certified steps whose bow swing clipped the
   * shore.
   */
  readonly permits?: (x: number, y: number, heading: number) => boolean;
}

/**
 * Is the point (x, y) clear of everyone in `occupants`?
 *
 * Squared on both sides so no square root — and so no cross-engine rounding
 * question — enters the movement path.
 */
function isClearOfOccupants(
  x: number,
  y: number,
  occupants: readonly Occupant[],
  selfRadiusCells: number,
): boolean {
  for (const occupant of occupants) {
    const dx = x - occupant.x;
    const dy = y - occupant.y;
    const clearance = selfRadiusCells + occupant.radiusCells;
    if (dx * dx + dy * dy < clearance * clearance) return false;
  }
  return true;
}

/**
 * Picks the heading closest to `desired` that is terrain-legal, permitted, and
 * whose STEP point is clear of everybody else. Null only when every candidate
 * fails all of that.
 *
 * TWO DISTANCES, DELIBERATELY. Terrain is judged at `lookaheadCells` — a mover
 * must see a cliff while there is still room to turn. Bodies are judged at
 * `options.stepCells`, because separation only asks "will I be standing in
 * somebody?". Conflating them was the 2026-08-21 defect.
 *
 * CROWDING MAY NEVER FREEZE A MOVER: bodies overlap for a few ticks while a jam
 * clears rather than anybody standing still. Terrain is different in kind.
 *
 * RESIDUAL, NAMED: `occupants` is a snapshot from the top of the tick, so two
 * movers can end it `selfRadius + theirRadius − 2 × stepCells` apart. That floor
 * goes NEGATIVE for a mover whose step exceeds its own radius — a small fish
 * steps 0.3 cells against a 0.42-cell gap, so two closing head-on pass through
 * each other inside one tick whatever heading either picks. Only sub-stepping
 * the movement would cure it; separation still shapes where they swim.
 *
 * ONE RUNG, NOT A STEER. `steerWithShorteningProbe` is the steer and is the only
 * thing that should call this. The same near-sightedness was diagnosed from
 * scratch four times — fish and boats (owner, 2026-08-24), monsters, then peeps
 * (#215: a burning peep stood against a wall for 4.3 s of an 8 s burn) — because
 * the two functions share a signature. Outside this file `steerAvoiding` has no
 * production callers, and a new one is the bug returning.
 */
export function steerAvoiding(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: Mover,
  desired: number,
  lookaheadCells: number,
  options: SteerOptions,
): number | null {
  const attempts = options.attempts ?? AVOID_TURN_ATTEMPTS;
  const stepRadians = options.stepRadians ?? AVOID_TURN_STEP_RADIANS;
  const occupants = options.occupants ?? [];
  const selfRadius = options.selfRadiusCells ?? 0;
  const separates = occupants.length > 0;

  // Relaxing separation is a FALLBACK, not a second sweep: terrain is the
  // expensive half and is sampled once per candidate.
  let crowded: number | null = null;

  // Candidate 0 is `desired` itself (magnitude 0); the rest alternate right
  // then left at growing magnitude, so the smallest workable turn wins.
  for (let attempt = 0; attempt <= attempts; attempt++) {
    const magnitude = Math.ceil(attempt / 2) * stepRadians;
    const sign = attempt % 2 === 1 ? 1 : -1;
    const heading = desired + sign * magnitude;
    const aheadX = mover.x + Math.cos(heading) * lookaheadCells;
    const aheadY = mover.y + Math.sin(heading) * lookaheadCells;

    if (!canProceedAlong(world, profile, mover.x, mover.y, aheadX, aheadY)) continue;
    if (options.permits !== undefined && !options.permits(aheadX, aheadY, heading)) continue;
    if (separates) {
      // Where it would STAND, not where it can see.
      const stepX = mover.x + Math.cos(heading) * options.stepCells;
      const stepY = mover.y + Math.sin(heading) * options.stepCells;
      if (!isClearOfOccupants(stepX, stepY, occupants, selfRadius)) {
        if (crowded === null) crowded = heading;
        continue;
      }
    }

    return normalizeAngle(heading);
  }

  return crowded === null ? null : normalizeAngle(crowded);
}

/**
 * The smallest divisor that meaningfully shortens the probe while staying well
 * above one tick's travel, so the retry still senses which way the obstacle runs.
 */
export const CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR = 2;

/**
 * THE WHOLE STEER FOR ONE TICK: `steerAvoiding` down a ladder of SHORTENING
 * probes. Null only for a genuine one-cell pocket.
 *
 * WHY THREE RUNGS (owner, 2026-08-24 — fish "stuck in place … presumably because
 * of the contours of the seabed", then boats "constantly getting stuck"). A mover
 * bound to a narrow band of ground meets strips of it narrower than its own
 * look-ahead; every candidate fails at every rung above, and nothing about that
 * changes next tick. It was near-sighted, not boxed in.
 *
 * The last rung probes exactly `options.stepCells` — the same distance a caller's
 * destination re-check judges — so the two can never disagree and stall a mover.
 *
 * The short rungs steer from the CURRENT heading (owner, 2026-08-19: obstacles
 * should deflect a traveller along themselves, not bounce it backward).
 *
 * NOT TURN-LIMITED, deliberately: a whale restricted to its own arc would find
 * the long probe blocked, drop to a short one, find it clear because the wall is
 * still twenty cells off, and swim at it. The long probe exists to say "blocked
 * at range, come about now", which needs a big turn to be sayable.
 *
 * SEPARATION IS OFF ON THE TWO SHORT RUNGS: they only run for a wedged mover,
 * which `steerAvoiding` already relaxes separation for, and the occupant list is
 * the whole population scanned per candidate.
 */
export function steerWithShorteningProbe(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: Mover,
  desired: number,
  lookaheadCells: number,
  options: SteerOptions,
): number | null {
  const full = steerAvoiding(world, profile, mover, desired, lookaheadCells, options);
  if (full !== null) return full;

  // Dropped rather than emptied, so `steerAvoiding` skips the work entirely.
  const { occupants: _ignored, ...alone } = options;

  const contour = steerAvoiding(
    world,
    profile,
    mover,
    mover.heading,
    lookaheadCells / CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR,
    alone,
  );
  if (contour !== null) return contour;

  return steerAvoiding(world, profile, mover, mover.heading, options.stepCells, alone);
}

/**
 * Identity, not position: two movers may legitimately share a position for a
 * tick, and dropping both would disable separation exactly when it matters.
 */
export function withoutSelf<T>(occupants: readonly T[], self: T): readonly T[] {
  return occupants.filter((occupant) => occupant !== self);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route following
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A mover carrying a planned route (pathing.ts's `findRoute` output) and its
 * position along it.
 *
 * THE INVARIANT: `route[routeIndex]` is the cell the mover is standing IN —
 * never one it is near or heading for. Every segment validated here is then
 * exactly one edge A* already certified. The rejoin branch below is the sole
 * exception, and only for a mover allowed to cut corners.
 */
export interface RoutedMover extends Mover {
  route: RouteCell[] | null;
  routeIndex: number;
}

/**
 * How far ahead of `routeIndex` a re-sync looks for the mover's own cell.
 *
 * One cell is all that is strictly needed — no shipped mover crosses more than
 * one boundary per tick (the fastest is boats' 0.36 cells). The rest is margin
 * for a mover nudged off its line by separation. Stated in WORLD units because
 * it is a distance across the ground. Deliberately small: a large window would
 * let a mover "arrive" at a waypoint it never walked to.
 */
const ROUTE_RESYNC_WINDOW_CELLS = cellsAcross(2);

/**
 * How close to a route cell's centre a corner-cutting mover may be and still
 * count as ON the route.
 *
 * Cutting a bend, the chord passes beside the bend cells' centres and
 * containment never fires. One cell is the tightest radius covering that chord.
 *
 * NOT the condemned 0.75-radius proximity advance `followRoute` documents below:
 * that one advanced the index and then walked an UNCERTIFIED shortcut. This one
 * advances and then aims through the same validated loop as every other tick.
 */
const ROUTE_REJOIN_RADIUS_CELLS = 1;

/** The centre of a route cell — where a follower actually aims. */
function cellCentre(cell: RouteCell): { x: number; y: number } {
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

export interface FollowRouteOptions extends SteerOptions {
  /** How far ahead the steering sweep probes. */
  readonly lookaheadCells: number;
  /**
   * The degraded path's target: with no route, this is what it steers at.
   */
  readonly goalX: number;
  readonly goalY: number;
  /**
   * Node budget for the ONE replan a broken route may trigger.
   */
  readonly replanNodeBudget?: number;
  /**
   * Most the heading may change this tick (turn rate × dt). Absent = unlimited.
   */
  readonly maxTurnRadians?: number;
  /**
   * How many route cells ahead the follower may aim directly. A mover with a
   * turning circle cannot track 1-cell waypoints and needs a far target to trace
   * a smooth arc through a jagged 8-direction route. Default 1.
   */
  readonly aimAheadCells?: number;
}

export interface FollowRouteResult {
  /**
   * True when the mover ENTERED A NEW ROUTE CELL this tick.
   *
   * THE PROGRESS SIGNAL A GIVE-UP TIMER MUST USE. Straight-line distance to the
   * goal is wrong in both directions at once: a legitimate detour increases it
   * (live routes run a mean 1.74× and up to 3.57× the straight line, measured
   * 2026-08-20) so real journeys accrue stuck time, and an oscillating mover
   * decreases it every other tick so it is never given up on.
   */
  readonly progressed: boolean;
  /** True once the mover is standing in the route's final cell. */
  readonly arrived: boolean;
  /** True when this tick discarded the route and planned a fresh one. */
  readonly replanned: boolean;
}

/**
 * Advances one mover along its planned route by one tick.
 *
 * A* certified the edges BETWEEN ADJACENT CELLS of the route and nothing else,
 * so a follower may only ever do three things: work out which route cell it is
 * standing in, look at the very next one, and step toward it.
 *
 * WHAT IT REPLACED (pilgrims' old `advanceWalker`): the index advanced on a
 * 0.75-cell proximity radius, but orthogonal waypoints are 1.0 cell apart, so a
 * mover sitting ON waypoint k was already inside k+1's radius and skipped it; it
 * then judged a diagonal shortcut to k+2 the route never contained, which
 * crossed a riser and failed; the failure replanned, and a replan's first cell is
 * the mover's own, so it was sent back where it stood. Traced 2026-08-20: every
 * wanderer in the world was in that 2-cycle within 60 s and none ever left it.
 *
 * So: re-sync BY CONTAINMENT rather than proximity; aim at the NEXT cell, never
 * the current one; validate exactly one route edge (a sculpt can cut a route out
 * from under a mover already abroad); on failure replan once and aim at index 1.
 *
 * The one exception to containment is a mover aiming more than one cell ahead: it
 * legally leaves the corridor cutting a bend, and containment then finds nothing
 * for 100+ ticks (measured), so it rejoins within ROUTE_REJOIN_RADIUS_CELLS.
 *
 * FAILURE DEGRADES, never freezes: with no route the mover steers straight at
 * the goal under the same sweep, and `progressed` lets the caller's timer see it.
 */
export function followRoute(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: RoutedMover,
  options: FollowRouteOptions,
): FollowRouteResult {
  const stepOnce = (targetX: number, targetY: number): void => {
    const desired = Math.atan2(targetY - mover.y, targetX - mover.x);
    // THE LADDER, NOT ONE RUNG OF IT. Route-following is more exposed to the
    // near-sightedness than free steering is, because the mover is aimed at one
    // specific adjacent cell rather than at open ground. A give-up timer is no
    // substitute: it can only retire a mover, and a panicking walker's clock is
    // deliberately not running at all.
    const heading = steerWithShorteningProbe(
      world,
      profile,
      mover,
      desired,
      options.lookaheadCells,
      options,
    );
    // A one-cell pocket: hold, and let the give-up timer run.
    if (heading === null) return;
    if (options.maxTurnRadians === undefined) {
      mover.heading = heading;
      mover.x += Math.cos(heading) * options.stepCells;
      mover.y += Math.sin(heading) * options.stepCells;
      return;
    }
    // The ladder certified `heading`, never the clamped one, so the re-check
    // below is required rather than belt-and-braces. The caller's rule is judged
    // at the ADOPTED heading: at the pre-turn heading it certified steps whose
    // bow swing clipped the shore.
    const adopted = turnToward(mover.heading, heading, options.maxTurnRadians, 1);
    const stepX = mover.x + Math.cos(adopted) * options.stepCells;
    const stepY = mover.y + Math.sin(adopted) * options.stepCells;
    if (
      canProceedAlong(world, profile, mover.x, mover.y, stepX, stepY) &&
      (options.permits === undefined || options.permits(stepX, stepY, adopted))
    ) {
      // Together: the turn only happens by moving.
      mover.heading = adopted;
      mover.x = stepX;
      mover.y = stepY;
      return;
    }
    // Blocked: the heading DOES NOT CHANGE. Committing it while holding position
    // is a pivot, just a stationary one, and a boat never pivots on the spot.
    // Backing astern along the CURRENT heading opens the forward arc without one.
    const backX = mover.x - Math.cos(mover.heading) * options.stepCells;
    const backY = mover.y - Math.sin(mover.heading) * options.stepCells;
    if (
      canProceedAlong(world, profile, mover.x, mover.y, backX, backY) &&
      (options.permits === undefined || options.permits(backX, backY, mover.heading))
    ) {
      mover.x = backX;
      mover.y = backY;
    }
  };

  // ── Degraded: no route. Steer at the goal and report LEAVING THE CELL. ──
  //
  // Not "the distance to the goal shrank", for the reason `progressed` gives. It
  // was survivable only while a wedged mover could not move at all; now that
  // every step goes down the ladder, a mover marooned on one legal cell can inch
  // about inside it and would have inched goalward often enough to never be
  // given up on.
  if (mover.route === null || mover.route.length === 0) {
    const fromCellX = Math.floor(mover.x);
    const fromCellY = Math.floor(mover.y);
    stepOnce(options.goalX, options.goalY);
    const moved = Math.floor(mover.x) !== fromCellX || Math.floor(mover.y) !== fromCellY;
    return { progressed: moved, arrived: false, replanned: false };
  }

  // Needed BEFORE the re-sync: the window must cover the aim.
  const aimAheadCount = Math.max(1, Math.floor(options.aimAheadCells ?? 1));
  // ── 1. Re-sync the index to the cell the mover is actually standing in. ──
  const cellX = Math.floor(mover.x);
  const cellY = Math.floor(mover.y);
  let progressed = false;
  // A window narrower than the aim would lose a mover that did as it was told.
  const limit = Math.min(
    mover.routeIndex + Math.max(ROUTE_RESYNC_WINDOW_CELLS, aimAheadCount),
    mover.route.length - 1,
  );
  let synced = false;
  for (let i = mover.routeIndex + 1; i <= limit; i++) {
    if (mover.route[i].x === cellX && mover.route[i].y === cellY) {
      mover.routeIndex = i;
      progressed = true;
      synced = true;
      break;
    }
  }
  if (!synced && aimAheadCount > 1) {
    // REJOIN: cut a bend, flying beside the corridor. FARTHEST cell in radius,
    // so the aim glides forward instead of snapping back. Squared throughout.
    const rejoinRadiusSquared = ROUTE_REJOIN_RADIUS_CELLS * ROUTE_REJOIN_RADIUS_CELLS;
    for (let i = limit; i > mover.routeIndex; i--) {
      const centre = cellCentre(mover.route[i]);
      const dx = centre.x - mover.x;
      const dy = centre.y - mover.y;
      if (dx * dx + dy * dy <= rejoinRadiusSquared) {
        mover.routeIndex = i;
        progressed = true;
        break;
      }
    }
  }

  if (mover.routeIndex >= mover.route.length - 1) {
    // The route is spent: close the last fraction of a cell directly.
    stepOnce(options.goalX, options.goalY);
    return { progressed, arrived: true, replanned: false };
  }

  // ── 2/3. Aim at the NEXT cell, validating exactly that one route edge. ──
  let current = cellCentre(mover.route[mover.routeIndex]);
  let next = cellCentre(mover.route[mover.routeIndex + 1]);
  let replanned = false;

  if (!isRouteEdgeStillLegal(world, profile, current, next)) {
    // ── 4. One replan, from where the mover actually is. ──
    const plan = findRoute(
      world,
      profile,
      { x: mover.x, y: mover.y },
      { x: options.goalX, y: options.goalY },
      options.replanNodeBudget,
    );
    replanned = true;
    mover.route = plan === null ? null : [...plan.cells];
    mover.routeIndex = 0;
    if (mover.route === null || mover.route.length < 2) {
      stepOnce(options.goalX, options.goalY); // degrade: straight at the goal.
      return { progressed, arrived: false, replanned };
    }
    current = cellCentre(mover.route[0]);
    next = cellCentre(mover.route[1]);
  }

  // Falls back to routeIndex+1, whose edge was validated above and so needs no
  // re-test. Aiming farther changes WHERE the mover walks, not what counts as
  // getting somewhere.
  const aimLimit = Math.min(mover.routeIndex + aimAheadCount, mover.route.length - 1);
  let aimX = next.x;
  let aimY = next.y;
  for (let k = aimLimit; k > mover.routeIndex + 1; k--) {
    const candidate = cellCentre(mover.route[k]);
    if (!canProceedAlong(world, profile, mover.x, mover.y, candidate.x, candidate.y)) continue;
    if (options.permits !== undefined) {
      // The heading a straight sail at the candidate would hold.
      const bearing = Math.atan2(candidate.y - mover.y, candidate.x - mover.x);
      if (!options.permits(candidate.x, candidate.y, bearing)) continue;
    }
    aimX = candidate.x;
    aimY = candidate.y;
    break;
  }

  stepOnce(aimX, aimY);
  return { progressed, arrived: false, replanned };
}

/**
 * Is this one route edge — two adjacent cell centres — still crossable?
 *
 * Both halves, because A* checked both: the destination cell must still be
 * ground this profile accepts (a sculpt can flood it), and the step must not
 * have become a riser. `canProceedAlong` is exactly those two questions, and
 * over a single edge — two adjacent cell centres — its sample loop reduces to
 * the destination cell, so this is the same test it always was in one call
 * rather than two. Deliberately taken between the two CELL CENTRES rather
 * than from the mover's fractional position, so the segment tested is exactly
 * the edge the planner accepted and the two can never disagree.
 */
function isRouteEdgeStillLegal(
  world: TerrainSampler,
  profile: TraversalProfile,
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return canProceedAlong(world, profile, from.x, from.y, to.x, to.y);
}

