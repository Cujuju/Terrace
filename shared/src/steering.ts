// STEERING — the one movement loop for everything that moves under its own
// power: pick a heading, refuse the ones that would take you somewhere you may
// not be or on top of somebody else, and walk the route you were given one
// certified edge at a time.
//
// ROOT CAUSE THIS FIXES (owner report, 2026-08-20: "my little people seem to
// get stuck in the middle of nowhere, and they also tend to run into each
// other"; and of the fleet, "they just kind of spin on top of each other").
// FOUR plugins had each grown their own copy of the same steer-and-veto
// sweep, and three of them say so in their own comments —
// boats/server/fleet.ts's steerToWater ("Monsters' sweep"),
// monsters/server/lurk.ts's steerToValidHeading ("this is the pattern,
// copied, not an import"), pilgrims/server/pilgrimage.ts's stepWalker
// ("wildlife's veto-the-step shape"), and wildlife/server/movement.ts.
// Duplicating the loop duplicated its gaps: only one of the four ever gained
// route following, and NOT ONE of them knew any other mover existed, so
// walkers walked through each other and every boat converged on the identical
// station circle around one kraken and rotated there. Those are not four bugs
// in four plugins; they are one missing contract, and this file is it.
//
// WHAT LIVES HERE vs. WHAT STAYS IN A PLUGIN. This file owns: which heading
// to commit to, how a planned route is consumed, and what counts as progress.
// A plugin still owns its own speed, its goals, its give-up policy and its
// state — none of which are movement maths. The two entry points are
// `steerAvoiding` (one tick of free steering) and `followRoute` (one tick of
// route following, which calls the former).
//
// DETERMINISM CONTRACT, same as the rest of shared/: a fixed candidate order
// (desired heading first, then alternating left/right by a fixed step), a
// fixed occupant scan order taken from an ARRAY the caller supplies (never a
// Map or Set, whose iteration order is a property of insertion history rather
// than of the world), and no wall clock or RNG anywhere. Two servers fed the
// same movers in the same order steer them identically.

import { findRoute, type RouteCell } from './pathing.ts';
import { canTraverseSegment, isWalkableCell, type TerrainSampler, type TraversalProfile } from './traversal.ts';

const TWO_PI = Math.PI * 2;

/** Wraps an angle into (−π, π] so two headings are always comparable. */
export function normalizeAngle(radians: number): number {
  const wrapped = radians % TWO_PI;
  if (wrapped > Math.PI) return wrapped - TWO_PI;
  if (wrapped <= -Math.PI) return wrapped + TWO_PI;
  return wrapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Candidate headings tried, beyond the desired one, when the way ahead is
 * blocked. 8 × 45° — the value all four plugins independently arrived at
 * (each citing the one before it), kept because it is the coarsest sweep that
 * still covers the full circle: with a 45° step, eight tries reach ±180°, so
 * "boxed in" genuinely means every direction failed rather than "every
 * direction I happened to sample".
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
 * `radiusCells` is that mover's own personal space — its body half-extent
 * plus whatever gap should read as a gap. It lives on the OCCUPANT rather
 * than on the profile because it is a fact about a body, not about terrain,
 * and because a mixed crowd is the normal case: a pilgrim, a wanderer and a
 * boat are all things to keep clear of and none of them is the same size.
 */
export interface Occupant {
  readonly x: number;
  readonly y: number;
  readonly radiusCells: number;
}

export interface SteerOptions {
  /**
   * Everyone else, in a FIXED order (see this module's determinism note). A
   * mover must not appear in its own list — comparing a mover against itself
   * would veto every heading at zero distance. Callers that pass one shared
   * population list filter by identity; see `withoutSelf`.
   */
  readonly occupants?: readonly Occupant[];
  /** This mover's own personal space, paired against each occupant's. */
  readonly selfRadiusCells?: number;
  /** Candidates beyond the desired heading. Defaults to AVOID_TURN_ATTEMPTS. */
  readonly attempts?: number;
  /** Angle between candidates. Defaults to AVOID_TURN_STEP_RADIANS. */
  readonly stepRadians?: number;
  /**
   * An extra veto a plugin needs and this file has no business knowing about
   * — boats' "only inside unlocked territory", monsters' whole-body lair
   * pose. Called with the candidate LOOK-AHEAD point. Terrain legality is
   * already checked; this is for everything else.
   */
  readonly permits?: (x: number, y: number) => boolean;
}

/**
 * Is the point (x, y) clear of everyone in `occupants`?
 *
 * Squared-distance comparison against the SUM of the two radii — the standard
 * two-circle overlap test, and squared on both sides so no square root (and
 * therefore no cross-engine rounding question) enters the movement path.
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
 * Picks the heading closest to `desired` whose look-ahead point is somewhere
 * this profile may be, is reachable without crossing a slope it refuses, is
 * permitted by the caller's own extra rule, and is clear of everybody else.
 * Returns null only when EVERY candidate fails all of that — the caller then
 * decides what "boxed in" means for it (hold, reverse, give up).
 *
 * TWO PASSES, and the second one is load-bearing. Separation is applied on
 * the first pass only; if every candidate is rejected, the sweep runs again
 * IGNORING occupants. Crowding must never be able to freeze a mover: the
 * whole reported bug this file exists to fix is movers that stop and never
 * start again, and a rule that can deadlock a knot of walkers into mutual
 * paralysis would be that same bug wearing a new hat. Bodies overlapping for
 * a few ticks while a jam clears is a cosmetic cost; a permanently frozen
 * walker is not. Terrain legality is NOT relaxed on the second pass — a
 * shoreline stays a wall no matter how crowded it gets.
 *
 * RESIDUAL, NAMED: `occupants` is a snapshot of where everyone was at the top
 * of the tick (that is what makes the result independent of who is stepped
 * first — see this module's determinism note), so two movers walking toward
 * each other each choose a heading that clears the OTHER'S OLD position and
 * can end the tick up to their combined step closer than their combined radii.
 * The observable floor is therefore `selfRadius + theirRadius − 2 × stepCells`
 * — at the shipped walker's 0.05 cells/tick, a tenth of a cell of slack on a
 * 0.4-cell gap. Closing it entirely would need a resolution pass over the whole
 * population after everyone has chosen, which buys a tenth of a cell at the
 * price of a second phase and an order-dependent tie-break; not worth it, and
 * the slack is invisible at the scale bodies are drawn.
 */
export function steerAvoiding(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: Mover,
  desired: number,
  lookaheadCells: number,
  options: SteerOptions = {},
): number | null {
  const attempts = options.attempts ?? AVOID_TURN_ATTEMPTS;
  const stepRadians = options.stepRadians ?? AVOID_TURN_STEP_RADIANS;
  const occupants = options.occupants ?? [];
  const selfRadius = options.selfRadiusCells ?? 0;
  const separates = occupants.length > 0;

  for (let pass = 0; pass < (separates ? 2 : 1); pass++) {
    const honourSeparation = pass === 0;
    // Candidate 0 is `desired` itself (magnitude 0); the rest alternate right
    // then left at growing magnitude, so the smallest workable turn wins.
    for (let attempt = 0; attempt <= attempts; attempt++) {
      const magnitude = Math.ceil(attempt / 2) * stepRadians;
      const sign = attempt % 2 === 1 ? 1 : -1;
      const heading = desired + sign * magnitude;
      const aheadX = mover.x + Math.cos(heading) * lookaheadCells;
      const aheadY = mover.y + Math.sin(heading) * lookaheadCells;

      if (!isWalkableCell(world, profile, aheadX, aheadY)) continue;
      if (!canTraverseSegment(world, profile, mover.x, mover.y, aheadX, aheadY)) continue;
      if (options.permits !== undefined && !options.permits(aheadX, aheadY)) continue;
      if (honourSeparation && !isClearOfOccupants(aheadX, aheadY, occupants, selfRadius)) continue;

      return normalizeAngle(heading);
    }
  }
  return null;
}

/**
 * Every occupant except the one at `self`, preserving order — the filter a
 * caller applies when it holds ONE population list and steers each member of
 * it in turn. Identity, not position: two movers may legitimately share a
 * position for a tick, and dropping both would silently disable separation
 * exactly when it matters most.
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
 * THE INVARIANT, which is the whole fix: `route[routeIndex]` is the cell the
 * mover is standing IN. Never a cell it is near, never one it is heading
 * for — the one under its feet. Everything below maintains that, and every
 * segment this file validates is consequently exactly one edge of the route
 * A* already certified.
 */
export interface RoutedMover extends Mover {
  route: RouteCell[] | null;
  routeIndex: number;
}

/**
 * How far ahead of `routeIndex` a re-sync will look for the mover's own cell.
 *
 * 2 — a mover cannot cross more than one cell boundary per tick at any
 * shipped speed (the fastest is boats' 1.5 cells/s against a 10 Hz tick =
 * 0.15 cells), so one is all that is ever needed and two is the margin that
 * lets a mover nudged off its line by the separation term (steerAvoiding,
 * above) re-find the route instead of insisting on a cell it has already
 * passed. Deliberately SMALL: a large window would let a mover "arrive" at a
 * far-ahead waypoint it never walked to, which is precisely the defect this
 * function replaces.
 */
const ROUTE_RESYNC_WINDOW_CELLS = 2;

/** The centre of a route cell — where a follower actually aims. */
function cellCentre(cell: RouteCell): { x: number; y: number } {
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

export interface FollowRouteOptions extends SteerOptions {
  /** Cells of travel this tick. The caller's speed × dt. */
  readonly stepCells: number;
  /** How far ahead the steering sweep probes. */
  readonly lookaheadCells: number;
  /**
   * Where the mover is ultimately going, for the degraded path: with no route
   * (planning failed, or a replan failed) this is what it steers straight at.
   */
  readonly goalX: number;
  readonly goalY: number;
  /**
   * Node budget for the ONE replan a broken route may trigger. Defaults to
   * pathing.ts's own ROUTE_NODE_BUDGET; a test forces exhaustion with it.
   */
  readonly replanNodeBudget?: number;
}

export interface FollowRouteResult {
  /**
   * True when the mover ENTERED A NEW ROUTE CELL this tick (or, with no route,
   * closed on its goal) — i.e. when it genuinely got somewhere.
   *
   * THIS IS THE PROGRESS SIGNAL A GIVE-UP TIMER MUST USE, and getting it
   * wrong is half of the reported freeze. The obvious measure — did the
   * straight-line distance to the goal shrink — is wrong in both directions
   * at once: a legitimate detour AROUND an obstacle increases it for as long
   * as the detour lasts (routes on the live world run a mean 1.74× and up to
   * 3.57× the straight-line distance, measured 2026-08-20), so a real journey
   * accrues stuck time; and an oscillating mover DEcreases it every other
   * tick, so a mover going nowhere resets the timer forever and is never
   * given up on. Route progress has neither failure: a detour makes it, an
   * oscillation does not.
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
 * THE SHAPE, and why it is not what it replaces. A route is a list of CELLS,
 * and A* certified the edges BETWEEN ADJACENT CELLS of that list — nothing
 * else. So a follower may only ever do three things: work out which route
 * cell it is standing in, look at the very next one, and step toward it.
 *
 * The version this replaces (pilgrims' `advanceWalker`) instead advanced its
 * index whenever the mover came within a proximity radius of a waypoint, and
 * then validated a free-space line from wherever the mover happened to be to
 * whichever waypoint the index now named. Both halves were wrong and they
 * compounded: the radius (0.75 cells) exceeded nothing in particular, but
 * orthogonal waypoints are 1.0 cell apart, so a mover sitting ON waypoint k
 * was already inside the radius of k+1 and skipped it untouched; it then
 * judged a diagonal shortcut to k+2 that the route never contained, which
 * crossed a terrace riser and failed; the failure replanned, and the replan's
 * first cell is the mover's OWN cell, so it was sent back to where it stood.
 * Two ticks later it was in the identical state. Traced on the live world
 * 2026-08-20: every wanderer in the world was in that 2-cycle within 60 s,
 * and none ever left it.
 *
 * So, in order:
 *
 *   1. RE-SYNC BY CONTAINMENT, not by proximity. The index advances when the
 *      mover's own floored cell IS the next route cell — it has to actually
 *      be there. `ROUTE_RESYNC_WINDOW_CELLS` bounds the search.
 *   2. AIM AT THE NEXT CELL, never the current one. Aiming at the cell you
 *      are already in is a null instruction at best and, after a replan,
 *      a step backwards.
 *   3. VALIDATE EXACTLY ONE ROUTE EDGE — current cell centre to next cell
 *      centre — which is the same comparison `edgeCost` made when A* accepted
 *      it, so the follower and the planner can no longer disagree about
 *      whether the route is walkable. (This re-check earns its per-tick cost:
 *      a sculpt can cut a route out from under a mover already abroad.)
 *   4. ON FAILURE, REPLAN ONCE, and drop the new route's first cell from
 *      consideration by aiming at index 1 — a replan never orders a mover
 *      back onto its own cell.
 *
 * FAILURE DEGRADES, never freezes: with no route at all, the mover steers
 * straight at `goalX`/`goalY` under the same avoidance sweep. That is worse
 * than a planned route — it can stall against a real obstacle — but the
 * caller's give-up timer, fed by `progressed`, is now able to see it.
 */
export function followRoute(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: RoutedMover,
  options: FollowRouteOptions,
): FollowRouteResult {
  const stepOnce = (targetX: number, targetY: number): void => {
    const desired = Math.atan2(targetY - mover.y, targetX - mover.x);
    const heading = steerAvoiding(world, profile, mover, desired, options.lookaheadCells, options);
    if (heading === null) return; // boxed in: hold, and let the give-up timer run.
    mover.heading = heading;
    mover.x += Math.cos(heading) * options.stepCells;
    mover.y += Math.sin(heading) * options.stepCells;
  };

  // ── Degraded: no route. Steer at the goal and report closing on it. ──
  if (mover.route === null || mover.route.length === 0) {
    const before = squaredDistance(mover.x, mover.y, options.goalX, options.goalY);
    stepOnce(options.goalX, options.goalY);
    const after = squaredDistance(mover.x, mover.y, options.goalX, options.goalY);
    return { progressed: after < before, arrived: false, replanned: false };
  }

  // ── 1. Re-sync the index to the cell the mover is actually standing in. ──
  const cellX = Math.floor(mover.x);
  const cellY = Math.floor(mover.y);
  let progressed = false;
  const limit = Math.min(mover.routeIndex + ROUTE_RESYNC_WINDOW_CELLS, mover.route.length - 1);
  for (let i = mover.routeIndex + 1; i <= limit; i++) {
    if (mover.route[i].x === cellX && mover.route[i].y === cellY) {
      mover.routeIndex = i;
      progressed = true;
      break;
    }
  }

  if (mover.routeIndex >= mover.route.length - 1) {
    // Standing in the final cell: the route is spent. Close the last fraction
    // of a cell to the goal directly.
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

  stepOnce(next.x, next.y);
  return { progressed, arrived: false, replanned };
}

/**
 * Is this one route edge — two adjacent cell centres — still crossable?
 *
 * Both halves, because A* checked both: the destination cell must still be
 * ground this profile accepts (a sculpt can flood it), and the step must not
 * have become a riser. Deliberately taken between the two CELL CENTRES rather
 * than from the mover's fractional position, so the segment tested is exactly
 * the edge the planner accepted and the two can never disagree.
 */
function isRouteEdgeStillLegal(
  world: TerrainSampler,
  profile: TraversalProfile,
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  if (!isWalkableCell(world, profile, to.x, to.y)) return false;
  return canTraverseSegment(world, profile, from.x, from.y, to.x, to.y);
}

function squaredDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
