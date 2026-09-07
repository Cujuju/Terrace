// THE PILGRIMAGE SIMULATION — settledness, dispatch, the walk, the blessing.
//
// Pure over a narrow world view (PilgrimWorld) so it runs in a node test
// without a server.
//
// DETERMINISTIC END TO END: no RNG — settledness is a timer, the viewpoint is
// an arg-max over a fixed ring, targets are picked nearest-first, ties break
// on scan order. Two servers fed the same streams produce byte-identical
// pilgrim traffic.
//
// SHAPE: a monster settled long enough dispatches one pilgrim per catchment
// settlement; each walks to a viewpoint outside the monster's reach, watches,
// and walks home. A settlement is BLESSED while any of its pilgrims are abroad.

import {
  CELL_CENTRE_OFFSET,
  advanceClimb,
  approachAndClimb as sharedApproachAndClimb,
  climbSeed,
  climbingWalkerProfile,
  isClimbStep,
  ROUTE_NODE_BUDGET,
  WORLD_UNIT_CELLS,
  cellsAcross,
  createRouteBudget,
  findRoute,
  followRoute,
  isWalkableCell as sharedIsWalkableCell,
  steerWithShorteningProbe,
  type FreshwaterMap,
  type ClimbState,
  type Occupant,
  type RouteBudget,
  type RouteCell,
  type RoutedMover,
  type TraversalProfile,
  climbWireOf,
  advanceStillness,
  newStillness,
  stanceWireOf,
} from '@terrace/shared';
import {
  PILGRIMS_CAP,
  settlementRace,
  type PilgrimEntityState,
  type SettlerRace,
} from '../protocol.ts';

/** The slice of the world the sim reads. Matches WorldApi's members 1:1. */
export interface PilgrimWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  /**
   * Rivers/lakes, per cell — consumed by shared/'s traversal predicates.
   *
   * Declared here even though optional: omitting it would still compile and
   * work via WorldApi, but silently regress every test using a stand-in
   * world. Optional so a test may still mean "no fresh water".
   */
  readonly freshwater?: FreshwaterMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — every value derived in its comment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Radius, in cells, a monster must keep to before it counts as settled.
 *
 * 16 world units — one chunk edge. Fastest shipped monster (kraken, 0.6
 * units/s) drifts out of it in under half a minute of ordinary wandering, so
 * only genuine lingering survives the onset timer below.
 *
 * Distances/speeds in this file are in world units, converted via
 * WORLD_UNIT_CELLS — each is a fact about the ground, not the sampling grid.
 */
export const MONSTER_SETTLED_RADIUS_CELLS = cellsAcross(16);

/**
 * Continuous seconds inside the settled circle before pilgrimages begin.
 *
 * 120 — vs monster motion: 4.5 settled-circle diameters for the fastest
 * shipped kind, so a beast merely crossing the area can't qualify. Vs the
 * settlement CA: 8 generations (15s each), so catchment towns exist by the
 * time the first pilgrim leaves.
 */
export const PILGRIMAGE_ONSET_SECONDS = 120;

/**
 * How far from the settled anchor a settlement can be and still dispatch.
 *
 * 64 cells — four chunks. Bounded by the walk: at PILGRIM_WALK_SPEED_CELLS_
 * PER_SECOND, the farthest pilgrim spends ~2 min each way, matching the onset
 * the monster already proved it would sit through.
 */
export const PILGRIMAGE_CATCHMENT_CELLS = cellsAcross(64);

/**
 * Radius of the viewpoint ring, in cells: SETTLED radius + 8.
 *
 * Monster can be anywhere in its settled circle; largest shipped
 * ground-protection aura reaches 4.5 world units beyond a body (measured
 * 2026-08-19: footprint 7/2 + standoff 1) — 8 covers it with margin.
 * Measured, not imported: the bridge rule forbids reading monsters'
 * constants, so drift means a viewpoint a bit too close, never a crash.
 */
export const VIEWPOINT_RING_CELLS = MONSTER_SETTLED_RADIUS_CELLS + cellsAcross(8);

/**
 * Candidate directions sampled on the viewpoint ring: 16, every 22.5°.
 *
 * At ring radius 24, adjacent samples are ~9 world units apart — finer than
 * any terrace feature at the widest sculpt brush, so more samples would just
 * re-find the same ledges.
 */
export const VIEWPOINT_RING_SAMPLES = 16;

/**
 * Walking speed, cells per second: 0.5.
 *
 * A shade faster than the yeti's amble (0.45), slower than a cruising kraken
 * (0.6) — a purposeful walk that still reads as a journey, not a teleport.
 */
export const PILGRIM_WALK_SPEED_CELLS_PER_SECOND = cellsAcross(0.5);

/**
 * Seconds spent watching at the viewpoint: 30 — two CA generations, long
 * enough to be a standing fact of the map, short enough to cycle visibly.
 */
export const PILGRIM_LINGER_SECONDS = 30;

/**
 * Seconds without net progress before a pilgrim gives up on its leg: 20 — 10
 * cells of thwarted travel at full speed. Outbound turns for home; homebound
 * despawns (their town's blessing ends with them).
 */
export const PILGRIM_STUCK_SECONDS = 20;

/**
 * Look-ahead for water avoidance, in seconds of travel — wildlife's
 * LOOKAHEAD_SECONDS reasoning; 0.3 cells of warning at this plugin's speed.
 */
export const LOOKAHEAD_SECONDS = 0.6;

/**
 * A pilgrim counts as arrived within this many cells of its GOAL: 0.75,
 * comfortably under one cell.
 *
 * SCOPE NARROWED 2026-08-20: this used to double as the route-following
 * waypoint test too, which was wrong (see shared/src/steering.ts's
 * `followRoute`). Route progress is now decided by cell containment, in
 * shared; this constant answers only the arrival question.
 */
export const ARRIVAL_RADIUS_CELLS = cellsAcross(0.75);

/**
 * A* node expansions ONE tick's dispatch may spend, shared across every
 * settled monster and catchment settlement it considers.
 *
 * ROUTE_NODE_BUDGET — one whole search's worth per tick. A route failure is
 * only PROVEN by a search that exhausts a full budget (pathing.ts's A* has no
 * other way to say "no"), and the memo below may only record a proven
 * failure. Smaller would make every unreachable pair "inconclusive" and
 * retried forever. Larger buys nothing: a second exhausted search in one tick
 * blows it (2026-08-29 perf review, D3: 44.9–58.1 ms per exhausted search
 * against a 100 ms tick at TICK_HZ = 10).
 *
 * Bounds the tick to at most one exhausted search regardless of how many
 * settled monsters/cut-off towns exist, vs. one PER cut-off town PER tick
 * before. Successful routes are ~0.3 ms (same measurement).
 */
export const PILGRIM_DISPATCH_EXPANSION_POOL = ROUTE_NODE_BUDGET;

/**
 * Row stride for packing a settlement's (x, y) into one integer memo key:
 * 65536 — structures' own key arithmetic, restated (a plugin builds with its
 * siblings deleted). Exact for every shipped world size (≤ 65536).
 */
const SETTLEMENT_KEY_STRIDE = 65536;

/**
 * What one settled monster's dispatch has already learned about its catchment.
 *
 * WHY (2026-08-29 perf review, D3): `SettlednessTracker.advance` reports the
 * currently-settled set every tick, not newly-settled, so a monster sitting
 * still is offered to dispatch ten times a second. Without memory, every
 * catchment town cut off by a river/lake paid a fresh budget-exhausting A*
 * (44.9–58.1 ms) every tick it stayed — ~50% of a tick from one such town.
 * Remembering the proven failure turns that into one search, once.
 *
 * WHY NOT `floodReachableRegion` (settling.ts's site scan uses it): a flood
 * from the viewpoint would serve every town at once, but reachability over
 * this profile is NOT symmetric — the corner-cutting guard tests a diagonal's
 * flanks against the cell it stands ON, so a corner legal from one end can be
 * illegal from the other (verified: heights base/base+MAX_STEP on the
 * diagonal cells and base−MAX_STEP on both flanks make A* A→B succeed, a
 * flood from A reach B, and a flood from B not reach A). A viewpoint-side
 * flood could prove nothing while claiming to — silently barring a town
 * forever. Flooding per settlement would be worse than one search per town.
 */
interface CatchmentMemo {
  /** Anchor this memo was learned at; a re-anchor drops it (new viewpoint,
   *  new routes) rather than reusing it. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Packed keys of settlements A* has PROVEN unroutable to this viewpoint —
   *  never ones that merely ran out of pooled allowance. Cleared wholesale by
   *  `forgetRouteFailures`. */
  readonly unroutable: Set<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settledness — one anchor tracker per living monster id.
// ─────────────────────────────────────────────────────────────────────────────

interface AnchorRecord {
  x: number;
  y: number;
  settledSeconds: number;
}

/** A settled monster: where pilgrims aim, keyed by monster id. */
export interface SettledMonster {
  readonly monsterId: number;
  readonly x: number;
  readonly y: number;
}

export class SettlednessTracker {
  private readonly anchors = new Map<number, AnchorRecord>();

  /** Feeds one tick of monster positions; returns the currently settled set. */
  advance(
    monsters: ReadonlyArray<{ readonly id: number; readonly x: number; readonly y: number }>,
    dt: number,
  ): SettledMonster[] {
    const seen = new Set<number>();
    const settled: SettledMonster[] = [];

    for (const monster of monsters) {
      seen.add(monster.id);
      const anchor = this.anchors.get(monster.id);
      if (anchor === undefined) {
        this.anchors.set(monster.id, { x: monster.x, y: monster.y, settledSeconds: 0 });
        continue;
      }
      const dx = monster.x - anchor.x;
      const dy = monster.y - anchor.y;
      if (dx * dx + dy * dy > MONSTER_SETTLED_RADIUS_CELLS * MONSTER_SETTLED_RADIUS_CELLS) {
        anchor.x = monster.x;
        anchor.y = monster.y;
        anchor.settledSeconds = 0;
        continue;
      }
      anchor.settledSeconds += dt;
      if (anchor.settledSeconds >= PILGRIMAGE_ONSET_SECONDS) {
        settled.push({ monsterId: monster.id, x: anchor.x, y: anchor.y });
      }
    }

    for (const id of this.anchors.keys()) {
      if (!seen.has(id)) this.anchors.delete(id);
    }
    return settled;
  }

  clear(): void {
    this.anchors.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Terrain predicates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The chance a peep's climb ends in a fatal fall — owner, 2026-09-05: "I would
 * even like them to be able to slowly climb sheer walls with maybe a fifteen
 * percent chance of falling and dying"; 15% exactly, confirmed per-wall not
 * per-band.
 *
 * Also prices a climbed edge in pathing.ts, so it decides how far out of its
 * way a peep detours to find a ramp — ~19 cells at 15%, vs. the yeti's 5%
 * (six cells) and ibex's 1% (one cell).
 */
export const PILGRIM_CLIMB_FALL_CHANCE = 0.15;

/**
 * A peep may go anywhere it can reach, climbing what it cannot walk (owner,
 * 2026-09-05: "peeps need to be able to climb anything").
 *
 * Measured need: under plain LAND_WALKER_PROFILE the live world's walkable
 * land was 35,617 disconnected regions over 66,255 cells, 28,157 of them a
 * single isolated cell, largest spanning exactly one terrace band (full
 * measurement: shared/src/climb.ts's header). No gradient tuning fixes it —
 * one band is eight times the limit.
 */
export const PILGRIM_WALKER_PROFILE: TraversalProfile = climbingWalkerProfile(PILGRIM_CLIMB_FALL_CHANCE);

/**
 * Land a walker will stand on: thin adapter over shared's bounds+ground
 * predicate. No gradient term — a standalone cell query has no "from" cell to
 * measure slope against; `stepWalker`/`planRoute` below do.
 */
export function isWalkableCell(world: PilgrimWorld, x: number, y: number): boolean {
  return sharedIsWalkableCell(world, PILGRIM_WALKER_PROFILE, x, y);
}

/** Viewpoint for a settled monster: highest walkable ring cell, or null if
 *  the ring is all water/off-world. Ties break first-sample for determinism. */
export function pickViewpoint(
  world: PilgrimWorld,
  anchorX: number,
  anchorY: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestHeight = -Infinity;
  for (let i = 0; i < VIEWPOINT_RING_SAMPLES; i++) {
    const angle = (i / VIEWPOINT_RING_SAMPLES) * 2 * Math.PI;
    const x = Math.floor(anchorX + Math.cos(angle) * VIEWPOINT_RING_CELLS);
    const y = Math.floor(anchorY + Math.sin(angle) * VIEWPOINT_RING_CELLS);
    if (!isWalkableCell(world, x, y)) continue;
    const height = world.heightAt(x, y);
    if (height > bestHeight) {
      bestHeight = height;
      best = { x: x + 0.5, y: y + 0.5 };
    }
  }
  return best;
}

/**
 * Plans a walking route via shared's A*, preferring gentle slopes over
 * steeper-but-legal ground (owner, 2026-08-19: "attempts to go around
 * obstacles instead of over or through them"). Null when no route exists
 * within shared's search bounds/budget.
 *
 * `budget` is shared's RouteBudget, letting a caller planning several routes
 * in one turn (settling.ts's site scan) cap the turn rather than each call.
 * Omitted = default per-call ROUTE_NODE_BUDGET.
 */
export function planRoute(
  world: PilgrimWorld,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  budget?: RouteBudget,
): RouteCell[] | null {
  const plan = findRoute(
    world,
    PILGRIM_WALKER_PROFILE,
    { x: fromX, y: fromY },
    { x: toX, y: toY },
    budget,
  );
  return plan === null ? null : [...plan.cells];
}

// ─────────────────────────────────────────────────────────────────────────────
// The pilgrims
// ─────────────────────────────────────────────────────────────────────────────

export type PilgrimLeg = 'outbound' | 'lingering' | 'homebound';

/** One id sequence for every walker on the wire, whichever sim spawned it —
 *  the client keys views/interpolation by bare id, so two sims must never
 *  mint the same number. index.ts shares one allocator between them. */
export class WalkerIdAllocator {
  private next = 1;

  allocate(): number {
    return this.next++;
  }

  reset(): void {
    this.next = 1;
  }
}

export interface Pilgrim {
  readonly id: number;
  readonly race: SettlerRace;
  /** The settlement that sent them — also the blessed cell while abroad. */
  readonly homeX: number;
  readonly homeY: number;
  readonly monsterId: number;
  x: number;
  y: number;
  heading: number;
  leg: PilgrimLeg;
  goalX: number;
  goalY: number;
  lingerSeconds: number;
  stuckSeconds: number;
  panicSecondsRemaining: number;
  panicFromX: number;
  panicFromY: number;
  /** Planned route to goal, or null (falls back to stepWalker's local
   *  avoidance). Never sent on the wire. */
  route: RouteCell[] | null;
  /** Index of the next unreached waypoint in `route`. */
  routeIndex: number;
  /** The wall this walker is on (see MovingWalker.climb); set/cleared only
   *  by `advanceWalker`. */
  climb: ClimbState | null;
  /** Stillness tracking (@terrace/shared's stance.ts). Owned by
   *  `advanceStillness`, called first in every sim's walker loop. */
  stillSeconds: number;
  stillX: number;
  stillY: number;
}

/** The moving slice of a walker — what `stepWalker` needs, and nothing more.
 *  Both the pilgrimage and the wandering sims feed their walkers through it. */
export interface MovingWalker {
  x: number;
  y: number;
  heading: number;
  goalX: number;
  goalY: number;
  /**
   * Wall this walker is on, or null on the ground (@terrace/shared's
   * climb.ts). Only `advanceWalker` sets/clears it; x/y don't move while set.
   *
   * On the shared MovingWalker slice, not each sim's own type, so all three
   * sims get climbing from the one function that already moves all three.
   */
  climb: ClimbState | null;
  /**
   * Stillness (@terrace/shared's stance.ts), advanced at the TOP of each
   * sim's walker loop, not the bottom: a walker's tick has a dozen exits, and
   * the stopped state is exactly one a bottom-call would skip.
   */
  stillSeconds: number;
  stillX: number;
  stillY: number;
}

/** What one tick of `advanceWalker` did. 'fell' is terminal — caller must
 *  act on it. */
export type WalkerAdvance = 'progressed' | 'held' | 'fell';

/** A MovingWalker that also carries a planned route — what `advanceWalker`
 *  needs. Both `Pilgrim` and wandering.ts's `Wanderer` satisfy this, and it is
 *  shared's `RoutedMover` (steering.ts) plus this plugin's own goal fields. */
export interface RoutedWalker extends MovingWalker, RoutedMover {}

/**
 * Personal space around one walker, in cells (shared's `steerAvoiding`).
 *
 * 0.17 — measured off the shipped model, here rather than imported (server
 * can't reach into a client model file). Widest part of a settler is the head
 * sphere, radius 0.155 as authored, at PILGRIM_MODEL_SCALE 0.85
 * (pilgrims/client/models.ts) = 0.132, rounded up for limb/tail swing. Two
 * walkers hold 0.34 cells centre to centre.
 *
 * Owner, 2026-08-20 ("they tend to run into each other"): nothing read a
 * second mover's position at all before this, fixed at the contract layer
 * (shared/src/steering.ts) — this constant is only this plugin's body size.
 */
export const WALKER_PERSONAL_SPACE_CELLS = cellsAcross(0.17);

/** Moving population as shared's `Occupant` rows. Assembled by index.ts
 *  across both sims, since neither sim can see the other's list. */
export function walkerOccupants(walkers: Iterable<MovingWalker>): Occupant[] {
  const rows: Occupant[] = [];
  for (const walker of walkers) {
    rows.push({ x: walker.x, y: walker.y, radiusCells: WALKER_PERSONAL_SPACE_CELLS });
  }
  return rows;
}

/**
 * Crowd one walker steers around: everyone else in its own sim plus the
 * caller's foreign list, never itself.
 *
 * `population`/`crowd` are parallel arrays, so self-exclusion is an index
 * lookup, not a position comparison — position comparison would wrongly drop
 * both walkers when two legitimately share a cell for a tick.
 */
function crowdAround(
  self: MovingWalker,
  population: readonly MovingWalker[],
  crowd: readonly Occupant[],
  foreign: readonly Occupant[],
): Occupant[] {
  const rows: Occupant[] = [];
  for (let i = 0; i < population.length; i++) {
    if (population[i] !== self) rows.push(crowd[i]);
  }
  for (const row of foreign) rows.push(row);
  return rows;
}

/** How far ahead a walker probes when steering. See LOOKAHEAD_SECONDS. */
function lookaheadCells(): number {
  return PILGRIM_WALK_SPEED_CELLS_PER_SECOND * LOOKAHEAD_SECONDS;
}

/**
 * One walking step with water/slope/crowd avoidance — thin adapter over
 * shared's `steerWithShorteningProbe`. Defaults `targetX`/`targetY` to the
 * walker's own goal.
 *
 * Moved to the contract layer 2026-08-20 (boats/monsters use it too — see
 * steering.ts's header). Issue #215, 2026-08-26: was on the single-probe
 * rung, measured as a burning peep standing motionless for 4.3s of an 8s burn.
 */
export function stepWalker(
  world: PilgrimWorld,
  pilgrim: MovingWalker,
  dt: number,
  targetX: number = pilgrim.goalX,
  targetY: number = pilgrim.goalY,
  occupants: readonly Occupant[] = [],
  permits?: (x: number, y: number) => boolean,
): void {
  const desired = Math.atan2(targetY - pilgrim.y, targetX - pilgrim.x);
  // One expression for both the move distance and separation-test distance
  // (SteerOptions.stepCells), so the sweep can't reason about a step never taken.
  const stepCells = PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt;
  const heading = steerWithShorteningProbe(
    world,
    PILGRIM_WALKER_PROFILE,
    pilgrim,
    desired,
    lookaheadCells(),
    { stepCells, occupants, selfRadiusCells: WALKER_PERSONAL_SPACE_CELLS, permits },
  );
  // A one-cell pocket: nowhere legal, once the ladder has run. Hold; the
  // stuck timer (or panicStep's lack of one) decides what's next.
  if (heading === null) return;

  pilgrim.heading = heading;
  pilgrim.x += Math.cos(heading) * stepCells;
  pilgrim.y += Math.sin(heading) * stepCells;
}

/**
 * Advances one walker toward its goal for one tick — thin adapter over
 * shared's `followRoute`.
 *
 * 'progressed': entered a new route cell, closed on goal (routeless), or
 * climbed. Caller's stuck timer runs off this, not distance-to-goal (see
 * `followRoute`'s `progressed`).
 *
 * 'fell': walker died off a wall. Caller despawns it — what a death costs
 * (blessing, founding party, wandering slot) is each sim's own business.
 */
export function advanceWalker(
  world: PilgrimWorld,
  walker: RoutedWalker,
  dt: number,
  occupants: readonly Occupant[] = [],
): WalkerAdvance {
  // On a wall: vertical motion only, no steering/separation — x/y must not
  // move or it would climb sideways into the rock.
  if (walker.climb !== null) {
    // Moves the walker as well as raising it (climb.ts's mantle), so
    // 'arrived' means already standing on the cell.
    const outcome = advanceClimb(walker, dt);
    if (outcome === 'fallen') return 'fell';
    if (outcome === 'arrived') walker.climb = null;
    // Climbing counts as progress: a wall takes longer per band than
    // PILGRIM_STUCK_SECONDS allows on anything four bands tall.
    return 'progressed';
  }

  // The way on is a wall: approach and climb rather than let the steering
  // sweep find a walkable heading along its foot forever (measured before
  // this branch existed: 200/200 walkers, none climbing, none arriving).
  const climbing = climbTowardWall(world, walker, routeClimbTargetOf(world, walker), dt);
  if (climbing !== null) return climbing;

  const wasX = walker.x;
  const wasY = walker.y;
  const result = followRoute(world, PILGRIM_WALKER_PROFILE, walker, {
    stepCells: PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt,
    lookaheadCells: lookaheadCells(),
    goalX: walker.goalX,
    goalY: walker.goalY,
    occupants,
    selfRadiusCells: WALKER_PERSONAL_SPACE_CELLS,
  });
  if (result.progressed) return 'progressed';

  // Routeless and wedged (planning failed, no route to read a climb from):
  // not having moved at all is what "wedged" means; a wall is the commonest
  // reason.
  if (walker.x !== wasX || walker.y !== wasY) return 'held';
  return climbTowardWall(world, walker, goalwardNeighbourOf(walker), dt) ?? 'held';
}

/**
 * Approach-and-climb: walk the last fraction of a cell to the wall's foot,
 * then climb. Null when the next step isn't a climb (almost always).
 *
 * The approach is a straight, unsteered walk inside the walker's own cell —
 * already-certified ground, so a sweep would only reintroduce the sideways
 * slide this branch prevents.
 */
function climbTowardWall(
  world: PilgrimWorld,
  walker: RoutedWalker,
  target: RouteCell | null,
  dt: number,
): WalkerAdvance | null {
  if (target === null) return null;
  const outcome = sharedApproachAndClimb(
    world,
    PILGRIM_WALKER_PROFILE,
    walker,
    target,
    PILGRIM_WALK_SPEED_CELLS_PER_SECOND * dt,
    climbSeedFor(walker, target),
  );
  // Walking to the wall's foot counts as progress too — the stuck timer must
  // not fire on either.
  return outcome === null ? null : 'progressed';
}

/**
 * The cell a blocked walker would climb onto: next route cell, or — routeless
 * — the neighbour most directly toward goal.
 *
 * Route is the first answer because A* already decided the wall is worth
 * climbing (prices a climbed edge by the climber's own fall chance).
 */
function routeClimbTargetOf(world: PilgrimWorld, walker: RoutedWalker): RouteCell | null {
  const route = walker.route;
  if (route === null) return null;
  const next = route[walker.routeIndex + 1];
  if (next === undefined) return null;

  const cellX = Math.floor(walker.x);
  const cellY = Math.floor(walker.y);
  const dx = next.x - cellX;
  const dy = next.y - cellY;
  // route[routeIndex] is the cell under the walker's feet, so next should be
  // one step away; anything else means it's off-route and about to re-sync —
  // not a moment to start a climb.
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return null;

  // A diagonal climbs as one of its two orthogonal halves — a body pulls
  // itself over a face, not a corner; A*'s corner guard already certified
  // both flanks.
  if (dx !== 0 && dy !== 0) {
    const alongX = { x: cellX + dx, y: cellY };
    if (isClimbStep(world, PILGRIM_WALKER_PROFILE, walker.x, walker.y, alongX.x, alongX.y)) return alongX;
    const alongY = { x: cellX, y: cellY + dy };
    return isClimbStep(world, PILGRIM_WALKER_PROFILE, walker.x, walker.y, alongY.x, alongY.y)
      ? alongY
      : null;
  }
  return isClimbStep(world, PILGRIM_WALKER_PROFILE, walker.x, walker.y, next.x, next.y) ? next : null;
}

/** Neighbour most directly toward goal — routeless fallback. One cell, on
 *  the dominant axis: a diagonal would pull the walker round an unfaced corner. */
function goalwardNeighbourOf(walker: RoutedWalker): RouteCell | null {
  const dx = walker.goalX - walker.x;
  const dy = walker.goalY - walker.y;
  if (dx === 0 && dy === 0) return null;
  const cellX = Math.floor(walker.x);
  const cellY = Math.floor(walker.y);
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: cellX + Math.sign(dx), y: cellY }
    : { x: cellX, y: cellY + Math.sign(dy) };
}

/**
 * The seed the fall is rolled off — shared's rule (`climbSeed`), discriminated
 * by the ROUTE INDEX: a walker has no id on this slice, and the index is what
 * moves on between one climb and the next on the same journey.
 */
function climbSeedFor(walker: RoutedWalker, target: RouteCell): number {
  return climbSeed(
    walker.routeIndex,
    Math.floor(walker.x),
    Math.floor(walker.y),
    target.x,
    target.y,
  );
}

// PANIC — the walker's reaction to fire (issue #184).
//
// Unlike a wandering animal, a walker is going somewhere (leg, goal, route,
// index), so panic INTERRUPTS the journey rather than editing it: goal
// machinery is skipped while it runs, and only the route — stale because it
// started from a place the walker no longer is — gets replanned when it ends.
//
// Called by all three sims at the TOP of their per-walker loop, before the
// linger/visit branch: a pilgrim standing still watching a monster is exactly
// who needs to hear the world is on fire.

/**
 * Multiplier on walking speed while panicking: ×3, wildlife's
 * FLEE_SPEED_MULTIPLIER, restated rather than imported (a plugin builds with
 * others deleted). Not tuned apart from animals' (design, 2026-08-24: same
 * size, same sort of thing) — ×3 reads as "running" on a peep exactly as on
 * a grazer.
 */
export const WALKER_PANIC_SPEED_MULTIPLIER = 3;

/**
 * How long a bystander's panic lasts (vs. one who is on fire): 2.5s,
 * wildlife's FLEE_DURATION_SECONDS restated. Long enough to see the crowd
 * scatter, short enough the road is orderly again quickly.
 */
export const WALKER_PANIC_SECONDS = 2.5;

/**
 * How far a new flame is felt, in cells: one panic burst's worth — a walker
 * runs at WALKER_PANIC_SPEED_MULTIPLIER for WALKER_PANIC_SECONDS, so every
 * walker the alarm reaches can clear the whole radius before calming.
 * 2 × 3 × 2.5 = 15 cells, just under four world units.
 *
 * Smaller than wildlife's 48-cell alarm, knowingly: that's sized to a grazer
 * running 3× a person's walk. Copying 48 here would panic walkers who
 * couldn't clear it — jogging in place beside the fire, then stopping there.
 *
 * A walker still inside the alarm when fire spreads is simply startled again
 * — correct, no extra rule needed.
 */
export const FIRE_STARTLE_RADIUS_CELLS = Math.round(
  PILGRIM_WALK_SPEED_CELLS_PER_SECOND * WALKER_PANIC_SPEED_MULTIPLIER * WALKER_PANIC_SECONDS,
);

/**
 * A walker that can panic — every walker in this plugin.
 *
 * No separate "is panicking" flag: the countdown (`panicSecondsRemaining`)
 * alone defines the state, same as wildlife's `fleeSecondsRemaining`.
 */
export interface PanickingWalker extends RoutedWalker {
  readonly id: number;
  stuckSeconds: number;
  panicSecondsRemaining: number;
  /**
   * What this walker is running from, in cells — never which way (issue
   * #215). A stored bearing let a walker pace on the spot: pressed against
   * terrain, it alternated between a fixed angle and its reverse, which a
   * two-tick broadcast aliased into a frozen wire position (measured
   * 2026-08-26: 0.6 cells north, 0.6 south, ten times, client saw no change).
   * An anchor recomputes "away" from the CURRENT position every tick, making
   * the retreat measurable — what `panicStep`'s veto needs.
   */
  panicFromX: number;
  panicFromY: number;
}

/**
 * Runs one panicking walker for a tick. True when it panicked — caller skips
 * everything else for this walker.
 *
 * Goes through `stepWalker` like any other step, so terrain/water/other
 * walkers still apply — panic only changes where it wants to go. Speed-up is
 * a longer `dt`, not a second speed constant, keeping the separation-sweep
 * distance and the travelled distance the same expression.
 *
 * The panic bearing is a constant, safe only because of the shortening ladder
 * (issue #215): `stepWalker`'s two short rungs steer from the walker's OWN
 * heading, so a walker pressed against something slides along it even though
 * the bearing it wants stays fixed. Re-deriving the bearing from a stored
 * point alone would not fix this — see `PanickingWalker.panicFromX`.
 *
 * Nothing else watches this walker while it panics: `stuckSeconds` is
 * deliberately not charged (a panic isn't a stuck walk), so a stalled panic
 * needs the steer itself to never near-sightedly give up.
 */
export function panicStep(
  world: PilgrimWorld,
  walker: PanickingWalker,
  dt: number,
  occupants: readonly Occupant[] = [],
): boolean {
  if (walker.panicSecondsRemaining <= 0) return false;

  walker.panicSecondsRemaining = Math.max(0, walker.panicSecondsRemaining - dt);

  // Re-derived each tick (see panicFromX). Standing exactly on the anchor
  // keeps current heading — no "away" to invent.
  const awayX = walker.x - walker.panicFromX;
  const awayY = walker.y - walker.panicFromY;
  const fleeing = awayX !== 0 || awayY !== 0 ? Math.atan2(awayY, awayX) : walker.heading;
  const anchorDistanceSq = awayX * awayX + awayY * awayY;

  stepWalker(
    world,
    walker,
    dt * WALKER_PANIC_SPEED_MULTIPLIER,
    walker.x + Math.cos(fleeing) * FIRE_STARTLE_RADIUS_CELLS,
    walker.y + Math.sin(fleeing) * FIRE_STARTLE_RADIUS_CELLS,
    occupants,
    // Fleeing may only ever increase distance from the anchor — the cure for
    // the two-tick cycle. A reverse step always closes on the anchor, so it
    // can never be chosen; refusing every candidate is honest (fire on all
    // sides holds rather than paces) and can't last, since the fire is
    // what's killing it.
    (x, y) => {
      const dx = x - walker.panicFromX;
      const dy = y - walker.panicFromY;
      return dx * dx + dy * dy > anchorDistanceSq;
    },
  );

  if (walker.panicSecondsRemaining <= 0) {
    // Route is the only stale part (planned from where the walker no longer
    // is); replan to the same goal. Null is the ordinary no-route fallback.
    walker.route = planRoute(world, walker.x, walker.y, walker.goalX, walker.goalY);
    walker.routeIndex = 0;
    // Running, not stuck — don't retire a walker for surviving a fire.
    walker.stuckSeconds = 0;
  }
  return true;
}

/**
 * Startles every walker within `radius` cells of (centerX, centerY), pointed
 * directly away, for WALKER_PANIC_SECONDS. Returns how many.
 *
 * On the centre exactly, keeps current heading (wildlife's `startleNear`
 * rule) — no "away" to invent.
 */
export function startleWalkersNear(
  walkers: Iterable<PanickingWalker>,
  centerX: number,
  centerY: number,
  radius: number,
): number {
  const radiusSquared = radius * radius;
  let startled = 0;

  for (const walker of walkers) {
    const dx = walker.x - centerX;
    const dy = walker.y - centerY;
    if (dx * dx + dy * dy > radiusSquared) continue;

    walker.panicFromX = centerX;
    walker.panicFromY = centerY;
    walker.panicSecondsRemaining = Math.max(walker.panicSecondsRemaining, WALKER_PANIC_SECONDS);
    startled++;
  }
  return startled;
}

/**
 * Puts these walkers into a panic lasting `seconds`, no direction — they bolt
 * facing the way they already were. Returns how many.
 *
 * For a walker who is themself alight (../server/index.ts). Differs from
 * `startleWalkersNear`: no "away" from fire you're carrying, and it lasts the
 * whole burn, not a burst.
 *
 * Set once, not refreshed while burning: a refresh needs an "alight" set, but
 * fire only announces burning-to-death, not being rained out or removed
 * otherwise (entityBlaze.ts's four endings) — such a set would leak. The
 * countdown needs none; the one divergence (a rain-saved walker keeps
 * running out the rest of the panic) is honest, since they were just on fire.
 */
export function panicWalkers(
  walkers: Iterable<PanickingWalker>,
  ids: readonly number[],
  seconds: number,
): number {
  if (seconds <= 0) return 0;

  let panicked = 0;
  // Iterate walkers, not `ids`, to keep this plugin's own fixed order.
  for (const walker of walkers) {
    if (!ids.includes(walker.id)) continue;
    // The place they caught — the only honest anchor for a walker carrying
    // its own fire.
    walker.panicFromX = walker.x;
    walker.panicFromY = walker.y;
    // Never shortens an existing panic.
    walker.panicSecondsRemaining = Math.max(walker.panicSecondsRemaining, seconds);
    panicked++;
  }
  return panicked;
}

/** Squared distance to the current goal. */
function goalDistanceSq(pilgrim: Pilgrim): number {
  const dx = pilgrim.goalX - pilgrim.x;
  const dy = pilgrim.goalY - pilgrim.y;
  return dx * dx + dy * dy;
}

/**
 * The whole population, advanced one tick. Owns dispatch, movement, the
 * linger, the give-up rules, and the blessed-set derivation; the plugin
 * wiring (index.ts) only feeds it and broadcasts what it reports.
 */
export class Pilgrimage {
  private readonly tracker = new SettlednessTracker();
  private readonly pilgrims = new Map<number, Pilgrim>();
  private readonly ids: WalkerIdAllocator;
  /** True when this sim minted its own allocator (then clear() may reset it);
   *  a shared allocator is never reset here — the other sim's walkers live on. */
  private readonly ownsIds: boolean;
  /** One CatchmentMemo per settled monster id, dropped the tick that monster
   *  stops being settled — so the map never outgrows the settled population. */
  private readonly catchmentMemos = new Map<number, CatchmentMemo>();

  constructor(ids?: WalkerIdAllocator) {
    this.ids = ids ?? new WalkerIdAllocator();
    this.ownsIds = ids === undefined;
  }

  advance(
    world: PilgrimWorld,
    monsters: ReadonlyArray<{ readonly id: number; readonly x: number; readonly y: number }>,
    settlements: ReadonlyArray<{ readonly x: number; readonly y: number }>,
    dt: number,
    occupants: readonly Occupant[] = [],
  ): void {
    const settled = this.tracker.advance(monsters, dt);
    const settledById = new Map(settled.map((s) => [s.monsterId, s]));

    // ── Recall: a monster that unsettled (or died) sends its crowd home. ──
    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.leg === 'homebound') continue;
      if (settledById.has(pilgrim.monsterId)) continue;
      pilgrim.leg = 'homebound';
      pilgrim.goalX = pilgrim.homeX + 0.5;
      pilgrim.goalY = pilgrim.homeY + 0.5;
      pilgrim.stuckSeconds = 0;
      pilgrim.route = planRoute(world, pilgrim.x, pilgrim.y, pilgrim.goalX, pilgrim.goalY);
      pilgrim.routeIndex = 0;
    }

    // ── Dispatch: one pilgrim per (settled monster, catchment settlement). ──
    // One pooled routing allowance for the whole tick (PILGRIM_DISPATCH_
    // EXPANSION_POOL): bound is on the tick, not the call, since the loop
    // below runs one search per (monster × settlement) pair.
    const dispatchBudget = createRouteBudget(PILGRIM_DISPATCH_EXPANSION_POOL);
    // Monsters that stopped being settled take their memo with them.
    for (const monsterId of this.catchmentMemos.keys()) {
      if (!settledById.has(monsterId)) this.catchmentMemos.delete(monsterId);
    }

    // Set when the pool can no longer fund a trustworthy search (see the two
    // nulls below); dispatch stops here for the tick but the walk still runs.
    // Next tick starts fresh and resumes at the same candidate (fixed order).
    let dispatchAllowanceSpent = false;

    for (const monster of settled) {
      if (dispatchAllowanceSpent) break;
      const viewpoint = pickViewpoint(world, monster.x, monster.y);
      if (viewpoint === null) continue;

      // What dispatch already proved about this catchment (CatchmentMemo). A
      // re-anchored monster asks a different question, so drop rather than trust.
      let memo = this.catchmentMemos.get(monster.monsterId);
      if (memo !== undefined && (memo.anchorX !== monster.x || memo.anchorY !== monster.y)) {
        this.catchmentMemos.delete(monster.monsterId);
        memo = undefined;
      }

      // Nearest-first, deterministic: tie-break on cell order, not iteration order.
      const candidates = settlements
        .map((cell) => {
          const dx = cell.x - monster.x;
          const dy = cell.y - monster.y;
          return { cell, distanceSq: dx * dx + dy * dy };
        })
        .filter((c) => c.distanceSq <= PILGRIMAGE_CATCHMENT_CELLS * PILGRIMAGE_CATCHMENT_CELLS)
        .sort(
          (a, b) =>
            a.distanceSq - b.distanceSq ||
            a.cell.y - b.cell.y ||
            a.cell.x - b.cell.x,
        );

      for (const { cell } of candidates) {
        if (this.pilgrims.size >= PILGRIMS_CAP) break;
        if (!isWalkableCell(world, cell.x, cell.y)) continue;
        if (this.hasPilgrimFrom(cell.x, cell.y, monster.monsterId)) continue;

        // Cheap question first: already proven unroutable on unchanged terrain.
        const settlementKey = cell.y * SETTLEMENT_KEY_STRIDE + cell.x;
        if (memo !== undefined && memo.unroutable.has(settlementKey)) continue;

        // Never dispatch a pilgrim to a trip it can't walk: plan before
        // minting. No route (walled in, island, budget-exhausted) skips this
        // settlement for the next-nearest candidate rather than failing the
        // whole monster's dispatch.
        const homeX = cell.x + 0.5;
        const homeY = cell.y + 0.5;
        // Read before the search, since a failing search spends its offer
        // either way — this is what makes its "no" trustworthy or not.
        const allowanceBefore = dispatchBudget.remaining;
        const route = planRoute(world, homeX, homeY, viewpoint.x, viewpoint.y, dispatchBudget);
        if (route === null) {
          // Only a search offered a FULL budget and still failing is proven
          // unroutable; one cut short by the pool proved nothing and must not
          // be memoized.
          if (allowanceBefore < ROUTE_NODE_BUDGET) {
            dispatchAllowanceSpent = true;
            break;
          }
          if (memo === undefined) {
            memo = { anchorX: monster.x, anchorY: monster.y, unroutable: new Set<number>() };
            this.catchmentMemos.set(monster.monsterId, memo);
          }
          memo.unroutable.add(settlementKey);
          continue;
        }

        const id = this.ids.allocate();
        this.pilgrims.set(id, {
          id,
          race: settlementRace(cell.x, cell.y),
          homeX: cell.x,
          homeY: cell.y,
          monsterId: monster.monsterId,
          x: homeX,
          y: homeY,
          heading: Math.atan2(viewpoint.y - homeY, viewpoint.x - homeX),
          leg: 'outbound',
          goalX: viewpoint.x,
          goalY: viewpoint.y,
          lingerSeconds: 0,
          stuckSeconds: 0,
          ...newStillness(homeX, homeY),
          panicSecondsRemaining: 0,
          panicFromX: 0,
          panicFromY: 0,
          route,
          routeIndex: 0,
          climb: null,
        });
      }
    }

    // ── Walk / linger / arrive. ──
    // Crowd is a start-of-tick snapshot, not "wherever they are by the time we
    // reach them" — avoids path depending on iteration order (determinism).
    const own = [...this.pilgrims.values()];
    const ownCrowd = walkerOccupants(own);

    for (const pilgrim of this.pilgrims.values()) {
      // Stillness first, above even panic (MovingWalker.stillSeconds).
      advanceStillness(pilgrim, dt);

      // Panic first, above the linger branch — a lingering pilgrim is exactly
      // who the linger branch would otherwise `continue` past unseen.
      if (panicStep(world, pilgrim, dt, crowdAround(pilgrim, own, ownCrowd, occupants))) continue;

      if (pilgrim.leg === 'lingering') {
        pilgrim.lingerSeconds += dt;
        // Face the beast while it is watched — the monster may drift.
        const monster = settledById.get(pilgrim.monsterId);
        if (monster !== undefined) {
          pilgrim.heading = Math.atan2(monster.y - pilgrim.y, monster.x - pilgrim.x);
        }
        if (pilgrim.lingerSeconds >= PILGRIM_LINGER_SECONDS) {
          pilgrim.leg = 'homebound';
          pilgrim.goalX = pilgrim.homeX + 0.5;
          pilgrim.goalY = pilgrim.homeY + 0.5;
          pilgrim.stuckSeconds = 0;
          pilgrim.route = planRoute(world, pilgrim.x, pilgrim.y, pilgrim.goalX, pilgrim.goalY);
          pilgrim.routeIndex = 0;
        }
        continue;
      }

      // Route progress, not distance-to-goal, resets the stuck clock — see
      // `advanceWalker`'s `progressed`.
      const advance = advanceWalker(world, pilgrim, dt, crowdAround(pilgrim, own, ownCrowd, occupants));
      // Fell off a wall: gone, and the blessing ends with it — deleting the
      // row IS ending it, since `blessedCellKeys` derives from the live table.
      if (advance === 'fell') {
        this.pilgrims.delete(pilgrim.id);
        continue;
      }
      if (advance === 'progressed') pilgrim.stuckSeconds = 0;
      else pilgrim.stuckSeconds += dt;

      const after = goalDistanceSq(pilgrim);

      if (after <= ARRIVAL_RADIUS_CELLS * ARRIVAL_RADIUS_CELLS) {
        if (pilgrim.leg === 'outbound') {
          pilgrim.leg = 'lingering';
          pilgrim.lingerSeconds = 0;
        } else {
          this.pilgrims.delete(pilgrim.id); // home again — journey complete
        }
        continue;
      }

      if (pilgrim.stuckSeconds >= PILGRIM_STUCK_SECONDS) {
        if (pilgrim.leg === 'outbound') {
          pilgrim.leg = 'homebound';
          pilgrim.goalX = pilgrim.homeX + 0.5;
          pilgrim.goalY = pilgrim.homeY + 0.5;
          pilgrim.stuckSeconds = 0;
          pilgrim.route = planRoute(world, pilgrim.x, pilgrim.y, pilgrim.goalX, pilgrim.goalY);
          pilgrim.routeIndex = 0;
        } else {
          // Stuck going home: despawn rather than wander forever.
          this.pilgrims.delete(pilgrim.id);
        }
      }
    }
  }

  private hasPilgrimFrom(homeX: number, homeY: number, monsterId: number): boolean {
    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.homeX === homeX && pilgrim.homeY === homeY && pilgrim.monsterId === monsterId) {
        return true;
      }
    }
    return false;
  }

  /** Wire rows for the broadcast, insertion (spawn) order. */
  states(): PilgrimEntityState[] {
    const rows: PilgrimEntityState[] = [];
    for (const pilgrim of this.pilgrims.values()) {
      rows.push({
        id: pilgrim.id,
        kind: 'pilgrim',
        race: pilgrim.race,
        x: pilgrim.x,
        y: pilgrim.y,
        heading: pilgrim.heading,
        // Only while off the ground; null is the ordinary case and costs the
        // wire nothing once msgpack has dropped it.
        ...climbWireOf(pilgrim.climb),
        ...stanceWireOf(pilgrim),
      });
    }
    return rows;
  }

  /** Packed structure keys of every settlement with a pilgrim abroad (the
   *  total blessed set, structures' replace semantics). Key arithmetic is
   *  structures' own, restated by value. */
  blessedCellKeys(): number[] {
    const keys = new Set<number>();
    for (const pilgrim of this.pilgrims.values()) {
      keys.add(pilgrim.homeY * 65536 + pilgrim.homeX);
    }
    return [...keys];
  }

  populationCount(): number {
    return this.pilgrims.size;
  }

  /** Live walkers, spawn order — index.ts turns these into `Occupant` rows
   *  the other sim steers around. Moving slice only: nothing outside this
   *  file needs a pilgrim's leg, route or blessing. */
  walkers(): readonly PanickingWalker[] {
    return [...this.pilgrims.values()];
  }

  /**
   * Every pilgrim's current route, as an ordered cell list — exposed for a
   * future roads feature (mechanics card 29) without this file knowing roads
   * exist. A routeless pilgrim (degraded to local avoidance) contributes
   * nothing.
   */
  routes(): ReadonlyArray<{ readonly homeX: number; readonly homeY: number; readonly cells: RouteCell[] }> {
    const rows: Array<{ homeX: number; homeY: number; cells: RouteCell[] }> = [];
    for (const pilgrim of this.pilgrims.values()) {
      if (pilgrim.route !== null) {
        rows.push({ homeX: pilgrim.homeX, homeY: pilgrim.homeY, cells: pilgrim.route });
      }
    }
    return rows;
  }

  /**
   * Removes one pilgrim outright — a death, not a homecoming. Nothing else
   * unwinds: tracker is keyed by monster, blessing is derived not stored.
   * fire is the only caller.
   */
  remove(id: number): boolean {
    return this.pilgrims.delete(id);
  }

  /**
   * Forgets every proven route failure (the invalidation half of the memo
   * above). index.ts calls it from `onTerrainChanged`.
   *
   * Deliberately coarse: ANY terrain change clears ALL memos, not just ones
   * whose catchment the changed cells fall inside. A cheap box test would be
   * unsound — rivers are derived from the whole heightmap by flow, so a
   * sculpt in one valley can move a watercourse in another; a wrongly-kept
   * memo bars a town from ever sending a pilgrim again, worse than re-proving.
   *
   * Cost is bounded: re-proving is lazy, at most one exhausted search per
   * tick (PILGRIM_DISPATCH_EXPANSION_POOL). Named residual: dragging a sculpt
   * brush clears the memo every tick, so a cut-off catchment pays one
   * exhausted search (~50ms) per sculpting tick — confined to active sculpting.
   */
  forgetRouteFailures(): void {
    this.catchmentMemos.clear();
  }

  clear(): void {
    this.tracker.clear();
    this.pilgrims.clear();
    this.catchmentMemos.clear();
    if (this.ownsIds) this.ids.reset();
  }
}
