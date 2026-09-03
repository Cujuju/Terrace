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
 * THE ONE SHAPE THAT MAKES A MOVER TRACE AN ARC INSTEAD OF PIVOTING (owner,
 * 2026-08-24: no spinning in place, for swimmers and then for boats). What a
 * sweep returns is a DIRECTION TO WANT; what a mover adopts is its current
 * heading turned toward that direction by one tick's worth of its own rate.
 * Clamped both by the rate and by the angle actually remaining, so callers can
 * add several such terms without any of them overshooting.
 *
 * IT LIVES IN `shared/` because a turning circle is steering, and it is now the
 * rule for two populations that cannot see each other (wildlife's creatures,
 * boats' hulls). The rate itself is NOT here: it is speed ÷ turn radius, and
 * each plugin measures its own movers’ radius against its own bodies.
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
   * Cells this mover will actually travel along the chosen heading THIS TICK
   * — its speed × dt.
   *
   * REQUIRED, and it is the distance the SEPARATION test is taken at (terrain
   * is still probed at `lookaheadCells`, which is a different question — see
   * `steerAvoiding`). Required rather than optional-with-a-default because the
   * default that would have to exist is the look-ahead distance, and that
   * default is precisely the defect this field was added to remove
   * (2026-08-21): separation used to be tested at the terrain probe point, so
   * whether it did anything at all depended on the accident of a mover's
   * look-ahead being comparable to its body. Pilgrims got that by luck (a
   * 0.3-cell probe against a 0.4-cell gap, so the test read as "is anyone
   * near me"); wildlife did not (a 1.8-cell probe against a 0.42-cell gap, so
   * it only ever fired on a creature almost exactly 1.8 cells dead ahead —
   * measured minimum separation inside a school of five: 0.04 cells against a
   * 0.42 target, i.e. nothing). A caller that does not separate still has to
   * state its step, which costs it one expression it already has in hand and
   * means no future caller can supply occupants and silently get no
   * separation.
   */
  readonly stepCells: number;
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
   * — boats' hull pose, monsters' whole-body lair pose. Called with the
   * candidate LOOK-AHEAD point, which is the far END of the probe and not the
   * path to it: ground legality IS sampled the whole way
   * (canProceedAlong), a caller's own extra rule is not. Stated because it is
   * a gap for any veto that can be true at both ends of a segment and false in
   * the middle — a chunk-granular unlock mask clipped by a corner, say.
   *
   * Called WITH THE HEADING the mover would hold at that point, because a
   * heading-relative body (a hull) can only be judged at the heading it will
   * actually hold. Judging it at the pre-turn heading is what made boats carry
   * a second veto after the commit: the sweep certified the step on the old
   * heading, the commit turned up to maxTurnRadians, and the bow swung into a
   * shore the old pose had cleared. So the sweep passes each CANDIDATE heading
   * here; the turn-limited commit passes the ADOPTED heading for the forward
   * step and the CURRENT heading for the astern step (astern never turns); and
   * the aim-ahead loop passes the bearing from the mover to the candidate cell,
   * which is the heading a straight sail at it would hold. Additive: existing
   * two-argument callers keep compiling.
   */
  readonly permits?: (x: number, y: number, heading: number) => boolean;
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
 * permitted by the caller's own extra rule, and whose STEP point is clear of
 * everybody else. Returns null only when EVERY candidate fails all of that —
 * the caller then decides what "boxed in" means for it (hold, reverse, give
 * up).
 *
 * TWO DISTANCES, DELIBERATELY, and conflating them was a real bug
 * (2026-08-21). Terrain is judged at `lookaheadCells`, because a mover has to
 * see a cliff or a shoreline coming while there is still room to turn; the
 * right distance for that is "as far as I travel in the time it takes me to
 * complete a turn", which is many steps. Bodies are judged at
 * `options.stepCells`, because the only question separation asks is "if I
 * commit to this heading, will I be standing in somebody?" — and the answer
 * depends on where the mover will BE, not on how far it can see. Testing both
 * at the look-ahead distance made separation an accident of the ratio between
 * the two; see `SteerOptions.stepCells` for the measurements.
 *
 * THE WAY AHEAD IS SAMPLED THE WHOLE WAY, not just at the probe's far end
 * (`canProceedAlong`, and see its own doc for the whale that swam into a
 * ridge because nothing looked between it and the open water beyond).
 *
 * CROWDING MAY NEVER FREEZE A MOVER. The whole reported bug this file exists
 * to fix is movers that stop and never start again, and a rule that can
 * deadlock a knot of walkers into mutual paralysis would be that same bug
 * wearing a new hat — so bodies overlap for a few ticks while a jam clears
 * rather than anybody standing still. Terrain is different in kind: a
 * shoreline stays a wall no matter how crowded it gets.
 *
 * SEPARATION RELAXES WITHIN THE SINGLE SWEEP: the smallest terrain-legal
 * candidate that happened to be occupied is remembered and returned if nothing
 * better turns up, so each candidate's terrain is sampled exactly once.
 * Overlapping bodies for a few ticks is the cheapest fault there is, and it is
 * what the residual note below already accepts.
 *
 * WHAT THIS RETURNS IS A DIRECTION TO WANT, NOT NECESSARILY ONE TO ADOPT THIS
 * TICK. It is free to be 90° off the mover's current heading — nothing here
 * knows what a mover's turning circle is, and a mover that HAS one turns
 * toward this answer at its own rate rather than snapping onto it (wildlife's
 * `advanceEntity` and its `maxTurnRadiansPerSecondOf` are the worked example).
 * Deliberately not a knob here: clamping candidates to a turning circle inside
 * this sweep makes a long look-ahead useless, because every candidate then
 * collapses into the same narrow arc and "the way ahead is blocked at range"
 * stops being expressible at all.
 *
 * RESIDUAL, NAMED: `occupants` is a snapshot of where everyone was at the top
 * of the tick (that is what makes the result independent of who is stepped
 * first — see this module's determinism note), so two movers walking toward
 * each other each choose a heading that clears the OTHER'S OLD position and
 * can end the tick up to their combined step closer than their combined radii.
 * The observable floor is therefore `selfRadius + theirRadius − 2 × stepCells`.
 * Closing it entirely would need a resolution pass over the whole population
 * after everyone has chosen, which costs a second phase and an order-dependent
 * tie-break.
 *
 * THAT FLOOR GOES NEGATIVE FOR A MOVER WHOSE STEP EXCEEDS ITS OWN RADIUS, and
 * for those there is no guarantee at all — only a tendency. A pilgrim steps
 * 0.05 cells against a 0.4-cell gap, so its floor is 0.3 and bodies genuinely
 * never merge. A small fish steps 0.3 cells against a 0.42-cell gap, so two
 * fish closing head-on can pass through each other inside one tick no matter
 * what heading either picks: at that speed the body is smaller than the
 * distance it teleports. Separation still shapes where they choose to swim —
 * measurably, and that is what it is for here — but the only cure for the
 * crossing case is sub-stepping the movement itself, which is a decision about
 * simulation cost that nobody has made. Named rather than hidden, because the
 * arithmetic is the same for any future fast, small mover.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS ONE RUNG, NOT A STEER. `steerWithShorteningProbe` below is the
 * steer, and it is the ONLY thing in this repo that should call this.
 *
 * The distinction is the whole of a bug that has now been fixed four separate
 * times, once per mover family, because the two functions sit side by side
 * with identical signatures and nothing but a name to tell a caller which one
 * answers "where do I go this tick?":
 *
 *   fish     — "stuck in place … presumably because of the contours of the
 *              seabed" (owner, 2026-08-24)
 *   boats    — "constantly getting stuck" (owner, 2026-08-24)
 *   monsters — plugins/monsters/server/lurk.ts, moved to the ladder citing
 *              the fish fix
 *   peeps    — issue #215, 2026-08-26: a burning peep pressed into a wall and
 *              stood there for 4.3 s of an 8 s burn, measured on the wire
 *
 * Every one of those was the same near-sightedness — a legal strip of ground
 * narrower than the look-ahead, refused at every candidate — and every one was
 * diagnosed from scratch as if it were that plugin's own defect.
 *
 * THE INVARIANT, and it is grep-checkable rather than a matter of care:
 * outside this file, `steerAvoiding` has NO production callers. The only
 * remaining reference is a test-only helper in wildlife. A new direct caller
 * in a plugin is the bug returning, and reviewing it costs one search.
 * ─────────────────────────────────────────────────────────────────────────
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

  // The smallest-magnitude candidate that is terrain-legal but stands in
  // somebody. Separation is relaxed by FALLING BACK to it rather than by a
  // second sweep, so the terrain work — which is the expensive half, a sampled
  // segment per candidate — is done exactly once per candidate.
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
      // Where this mover would STAND, not where it can see — see the two-
      // distances note above. Computed inside the branch so a caller with no
      // occupants pays nothing for it.
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
 * Divisor for the ladder's middle rung — see `steerWithShorteningProbe`.
 *
 * 2 is the smallest divisor that meaningfully shortens the probe (half
 * distance) while staying well above one tick's own travel, so the retry still
 * senses which way the obstacle runs rather than only re-confirming the mover's
 * own current cell.
 */
export const CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR = 2;

/**
 * THE WHOLE STEER FOR ONE TICK: `steerAvoiding` run down a ladder of SHORTENING
 * probes until one of them finds somewhere to go. Null only when the mover has
 * nowhere to be next tick at all — a one-cell pocket.
 *
 * THREE RUNGS, and the third one is the fix for the stall the owner reported on
 * 2026-08-24 — first for fish "stuck in place … presumably because of the
 * contours of the seabed", then for boats "constantly getting stuck". A mover
 * bound to one narrow band of ground (a fish to the shallows, a hull to open
 * water) meets strips of that band narrower than its own look-ahead. Every
 * candidate at the full probe fails, every candidate at half of it fails, and
 * the ladder-less code then held position — forever, because nothing about the
 * situation changes next tick. The mover was not boxed in; it was near-sighted
 * about a place it could perfectly well have travelled to.
 *
 * The third rung probes at exactly `options.stepCells`, one tick's travel,
 * which is the SAME distance a caller's destination re-check judges. So the
 * ladder can only report "nowhere to go" when there is genuinely no legal cell
 * one step away in any direction, and a heading it does return can never be
 * refused by that re-check — which is what stops the two from disagreeing and
 * stalling a mover that had somewhere to go.
 *
 * The two short rungs steer from the mover's CURRENT heading rather than from
 * `desired` (owner, 2026-08-19: obstacles should deflect a traveller ALONG
 * themselves, not bounce it backward) — sliding along whatever it is pressed
 * against is what "go around" means at the scale of one tick.
 *
 * WHAT IT RETURNS IS A DIRECTION TO WANT, not the heading the mover adopts:
 * the caller turns toward it at its own turning circle (`turnToward`). The
 * ladder must therefore NOT be turn-limited itself — a whale that could only
 * consider headings inside its 1.8°-per-tick arc would find the full probe
 * blocked, drop to the short one, find that clear because the wall is still
 * twenty cells off, and swim straight at it. The long probe exists precisely
 * to say "blocked at range, start coming about now", and it can only say it if
 * the heading it names is allowed to be a big turn.
 *
 * SEPARATION IS OFF ON THE TWO SHORT RUNGS, and that is a decision about cost
 * as much as about behaviour. Behaviourally it is what the ladder already
 * means: the short rungs only run for a mover that is wedged, and
 * `steerAvoiding` relaxes separation before anything else for exactly that
 * mover anyway. The cost is the other half: the occupant list is scanned per
 * candidate and it is the whole population, so scanning it on every rung
 * multiplies the worst case — a dense, boxed-in population, which is precisely
 * when the short rungs fire — by the number of rungs.
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

  // The short rungs: from the mover's own heading, and with no separation term
  // (see the note above). `occupants` is dropped rather than emptied so the
  // fast path inside `steerAvoiding` skips the separation work entirely.
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
 * TWO WORLD UNITS of route ahead. A mover cannot cross more than one cell
 * boundary per tick at any shipped speed (the fastest is boats' 0.9 world
 * units/s = 3.6 cells/s against a 10 Hz tick = 0.36 cells — it was 1.5 until
 * 2026-08-24, and the claim held with more room to spare afterwards), so one
 * cell is all that is ever strictly needed; the rest is the margin that lets a mover
 * nudged off its line by the separation term (steerAvoiding, above) re-find
 * the route instead of insisting on a cell it has already passed. That margin
 * is a distance across the ground, so it is stated in world units: left at 2
 * CELLS through the 2026-08-21 re-sample it would have shrunk to half a world
 * unit and stopped covering the nudge it exists for. Deliberately SMALL: a
 * large window would let a mover "arrive" at a far-ahead waypoint it never
 * walked to, which is precisely the defect this function replaces.
 */
const ROUTE_RESYNC_WINDOW_CELLS = cellsAcross(2);

/**
 * How close to a route cell's centre a corner-cutting mover may be and still
 * count as ON the route — one cell.
 *
 * Adjacent to the corridor counts as on it for a mover that is ALLOWED to cut
 * corners (aimAheadCells > 1): cutting a bend, the chord it sails passes
 * beside the bend cells' centres rather than through them, and containment
 * never fires. One cell is the tightest radius that still covers that chord —
 * the bend cell is a neighbour of the corridor, never far water.
 *
 * THIS IS NOT THE CONDEMNED 0.75-RADIUS PROXIMITY ADVANCE `followRoute`
 * documents below: that one advanced the index and then validated an
 * UNCERTIFIED shortcut to the cell after — a diagonal the route never
 * contained — which failed, replanned, and 2-cycled the mover home. This one
 * advances and then aims through the same `canProceedAlong`-validated
 * aim-ahead loop as every other tick, so no uncertified segment is ever walked.
 */
const ROUTE_REJOIN_RADIUS_CELLS = 1;

/** The centre of a route cell — where a follower actually aims. */
function cellCentre(cell: RouteCell): { x: number; y: number } {
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

export interface FollowRouteOptions extends SteerOptions {
  // `stepCells` is inherited from SteerOptions (2026-08-21). It used to be
  // declared here as well, which was the same number written twice — this file
  // moved the mover by it, and the sweep needed it for separation and did not
  // have it. One field, one meaning: cells of travel this tick.
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
  /**
   * Most the mover's heading may change THIS TICK, in radians (its turn rate × dt).
   * When set, the sweep's answer is a direction to WANT and the heading adopted is
   * turnToward(current, wanted, ...). Absent = unlimited, the previous behaviour.
   */
  readonly maxTurnRadians?: number;
  /**
   * How many route cells past the current one the follower may aim at directly.
   * It aims at the FARTHEST of route[i+1 .. i+aimAheadCells] whose straight segment
   * from the mover's position is legal (canProceedAlong + permits at the far end),
   * falling back to i+1. Default 1 = the previous behaviour. A mover with a
   * turning circle cannot track 1-cell waypoints and needs a far target to trace
   * a smooth arc through a jagged 8-direction route.
   */
  readonly aimAheadCells?: number;
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
 *      be there. `ROUTE_RESYNC_WINDOW_CELLS` bounds the search. ONE EXCEPTION:
 *      a mover aiming aimAheadCells > 1 ahead legally leaves the corridor
 *      cutting a bend, and containment then finds nothing for 100+ ticks
 *      (measured). In that case only, the index rejoins to the FARTHEST window
 *      cell within ROUTE_REJOIN_RADIUS_CELLS and counts it as progress — see
 *      that constant for why this is not the condemned proximity advance.
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
 * than a planned route — it can still fail to make headway against a real
 * obstacle — but the caller's give-up timer, fed by `progressed`, is now able
 * to see it. Since 2026-08-26 every step here goes down the shortening ladder
 * (`steerWithShorteningProbe`), so "no headway" means a one-cell pocket rather
 * than the far commoner case of a legal strip narrower than the look-ahead.
 */
export function followRoute(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: RoutedMover,
  options: FollowRouteOptions,
): FollowRouteResult {
  const stepOnce = (targetX: number, targetY: number): void => {
    const desired = Math.atan2(targetY - mover.y, targetX - mover.x);
    // THE LADDER, NOT ONE RUNG OF IT (`steerWithShorteningProbe`, above).
    //
    // This called `steerAvoiding` directly until 2026-08-26, which is the same
    // near-sightedness that stalled fish, then boats, then monsters, and the
    // reason each of those was moved to the ladder in turn: a follower whose
    // full probe and half probe both fail held position, and nothing about
    // that changes next tick, so it held forever. Route-following is if
    // anything MORE exposed to it than free steering, because the mover is
    // being aimed at one specific adjacent cell rather than at open ground —
    // an aim that a strip of legal ground narrower than the look-ahead refuses
    // at every candidate.
    //
    // The give-up timer this used to defer to is not a substitute. It can only
    // retire the mover; it cannot get one that had somewhere to go moving, and
    // for a walker whose stuck clock is deliberately not running — a panicking
    // one (plugins/pilgrims/server/pilgrimage.ts's `panicStep`) — there is no
    // timer watching at all.
    const heading = steerWithShorteningProbe(
      world,
      profile,
      mover,
      desired,
      options.lookaheadCells,
      options,
    );
    // Null now means a one-cell pocket, not near-sightedness: hold, and let
    // the give-up timer run.
    if (heading === null) return;
    if (options.maxTurnRadians === undefined) {
      mover.heading = heading;
      mover.x += Math.cos(heading) * options.stepCells;
      mover.y += Math.sin(heading) * options.stepCells;
      return;
    }
    // TURN-LIMITED: the sweep's answer is a direction to WANT, and the heading
    // adopted is the current one turned toward it by at most maxTurnRadians
    // (turnToward with dt = 1, so the rate × dt product IS the per-tick cap).
    // The step is then re-checked along the CLAMPED heading: the ladder
    // certified `wanted`, never this, so committing it blind could walk into a
    // wall the sweep refused — the re-check is required, not belt-and-braces.
    // The caller's own rule is judged at the ADOPTED heading, the one the hull
    // will actually hold: judging it at the pre-turn heading certified steps
    // whose bow swing clipped the shore, which is the second veto this
    // replaces (the plugin-level post-commit check is gone — this IS it).
    const adopted = turnToward(mover.heading, heading, options.maxTurnRadians, 1);
    const stepX = mover.x + Math.cos(adopted) * options.stepCells;
    const stepY = mover.y + Math.sin(adopted) * options.stepCells;
    if (
      canProceedAlong(world, profile, mover.x, mover.y, stepX, stepY) &&
      (options.permits === undefined || options.permits(stepX, stepY, adopted))
    ) {
      // Commit heading AND position together: the turn only happens by moving.
      mover.heading = adopted;
      mover.x = stepX;
      mover.y = stepY;
      return;
    }
    // The clamped heading is blocked: the heading DOES NOT CHANGE. A boat
    // never pivots on the spot — committing the heading while holding position
    // (the previous local fix in boats) IS a pivot, just a stationary one.
    // Instead it backs astern one step along its CURRENT heading, which opens
    // the forward arc on a later tick without one. The caller's rule is judged
    // at that same current heading — astern never turns, so it is the heading
    // the hull holds for the whole manoeuvre. Deterministic: no
    // randomness in any branch; a mover that can back out of neither end holds.
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
  // ONE DEFINITION OF PROGRESS FOR BOTH BRANCHES (2026-08-26). This branch used
  // to report "the straight-line distance to the goal shrank", which is the
  // measure `FollowRouteResult.progressed` documents as wrong directly above —
  // an oscillating mover closes that distance every other tick and resets the
  // give-up timer forever. It was survivable only while a wedged mover could
  // not move at all; now that every step goes down the shortening ladder, a
  // mover marooned on a single legal cell CAN inch about inside it (the third
  // rung probes one tick's travel, which never leaves the cell), and it would
  // have inched toward the goal often enough never to be given up on.
  //
  // Entering a new cell is what the routed branch already means by progress,
  // and it is the one measure a detour cannot defeat and a twitch cannot fake.
  // The give-up clock has room for it: at the shipped walk speed one cell is
  // five ticks (0.5 s) against a PILGRIM_STUCK_SECONDS of 20.
  if (mover.route === null || mover.route.length === 0) {
    const fromCellX = Math.floor(mover.x);
    const fromCellY = Math.floor(mover.y);
    stepOnce(options.goalX, options.goalY);
    const moved = Math.floor(mover.x) !== fromCellX || Math.floor(mover.y) !== fromCellY;
    return { progressed: moved, arrived: false, replanned: false };
  }

  // How many route cells past the current one the follower may aim at
  // directly (FollowRouteOptions.aimAheadCells; 1 = the previous behaviour).
  // Needed BEFORE the re-sync below, because the window must cover the aim.
  const aimAheadCount = Math.max(1, Math.floor(options.aimAheadCells ?? 1));
  // ── 1. Re-sync the index to the cell the mover is actually standing in. ──
  const cellX = Math.floor(mover.x);
  const cellY = Math.floor(mover.y);
  let progressed = false;
  // The window covers at least aimAheadCount cells ahead: a mover aiming ahead
  // legally leaves the route's cell corridor while cutting the corner and
  // re-enters at the aimed cell, so a window narrower than the aim would lose
  // a mover that did exactly what it was told.
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
    // REJOIN: the mover cut a bend and is flying beside the corridor, not on
    // it. Take the FARTHEST window cell within ROUTE_REJOIN_RADIUS_CELLS —
    // farthest, so the aim glides forward instead of snapping back — and count
    // it as progress: the mover demonstrably got somewhere. Squared comparison
    // throughout, so no square root enters the movement path (same reason as
    // `isClearOfOccupants`).
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

  // Aim at the FARTHEST cell within the aim window whose straight segment from
  // the mover's position is legal (canProceedAlong + permits at the far end),
  // falling back to routeIndex+1 — whose edge was just validated above, so it
  // is always accepted without re-testing. A mover with a turning circle cannot
  // track 1-cell waypoints and needs the far target to trace a smooth arc
  // through a jagged 8-direction route. `progressed` still means "entered a
  // new route cell": aiming farther changes WHERE the mover walks, not what
  // counts as getting somewhere.
  const aimLimit = Math.min(mover.routeIndex + aimAheadCount, mover.route.length - 1);
  let aimX = next.x;
  let aimY = next.y;
  for (let k = aimLimit; k > mover.routeIndex + 1; k--) {
    const candidate = cellCentre(mover.route[k]);
    if (!canProceedAlong(world, profile, mover.x, mover.y, candidate.x, candidate.y)) continue;
    if (options.permits !== undefined) {
      // The bearing the mover would hold sailing straight at the candidate —
      // the heading a hull would actually have there (see `permits`).
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

