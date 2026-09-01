// ROUTING — go AROUND obstacles, not over or through them (owner, 2026-08-19:
// "anything traveling across the map — whether it be a pilgrim or wildlife —
// attempts to go around obstacles instead of over or through them. That would
// also allow us to add roads that actually look like something").
//
// This is the layer above traversal.ts. traversal.ts answers "may I stand
// here / cross this one step"; this file answers "what SEQUENCE of steps gets
// me from A to B", preferring gentle ground over steep-but-legal ground so
// the chosen route is the one a road would plausibly follow. A greedy
// per-tick local probe (the shape both plugins had before this file existed)
// can only ever react to what is immediately ahead — face a cliff, turn,
// re-approach, oscillate. A* over the traversal contract plans the whole leg
// before a single step is taken.
//
// DETERMINISM CONTRACT: integer-only cost arithmetic (no Euclidean/√2 in the
// cost function — see ORTHOGONAL_STEP_COST/DIAGONAL_STEP_COST below), a fixed
// neighbor scan order, and an explicit, total tie-break in the open-set
// priority queue (f, then h, then a cell-key ascending fallback) — so two
// callers searching the same heights from the same start/goal get a
// byte-identical route, not merely "a shortest route", every time.

import { type TerrainSampler, type TraversalProfile, isWalkableCell } from './traversal.ts';
import {
  NEIGHBOURHOOD_CELLS,
  WORLD_UNIT_CELLS,
  cellsOverArea,
} from './constants.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Cost model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base cost of one orthogonal (N/E/S/W) step. 10 — the classic integer
 * "octile distance" scale (Euclidean step cost ×10, rounded), chosen SPECIFICALLY
 * so the diagonal cost below can be an integer too: √2 has no exact integer
 * ratio to 1, so representing both costs as small integers rather than floats
 * needs a common scale where the rounding error is negligible relative to the
 * cost itself. Kept out of the walker-visible API (RoutePlan.cost is "cost
 * units", not cells or seconds) precisely so this scale is free to change.
 */
export const ORTHOGONAL_STEP_COST = 10;

/**
 * Base cost of one diagonal (NE/NW/SE/SW) step. 14 ≈ 10·√2 (13.94, rounded to
 * the nearest integer) — the standard octile-distance approximation. Chosen
 * over the two obvious alternatives: 10 (equal to orthogonal) would make
 * diagonal movement strictly dominant, producing needlessly diagonal-heavy
 * routes even where a straighter orthogonal jog is just as short; 20 (2×
 * orthogonal) would forbid diagonal cutting entirely, which is worse than
 * Euclidean and produces visible staircase detours around anything a true
 * diagonal could clear in one step.
 */
export const DIAGONAL_STEP_COST = 14;

/**
 * Extra cost added per unit of |height difference| an edge crosses, on top of
 * its base move cost — the term that makes a route prefer the gentle way
 * round even when the steep way is shorter and still legal.
 *
 * Chosen against MAX_STEP-scale climbs, not against the base move costs
 * directly. The ratio that decides route shape is the penalty for climbing one
 * WORLD UNIT at the steepest legal land grade against what it costs to walk
 * one world unit on the flat, and it is 1.6: before the 2026-08-21 re-sample
 * that was +16 (LAND_WALKER_MAX_GRADIENT_PER_CELL over one cell) on a base 10,
 * and it is the same 1.6 now, spread over the four cells a world unit is
 * sampled by. That is enough that two world units of flat detour already beat
 * one world unit of max-gradient climb, and a short flat detour beats a short
 * steep one by a wide, visible margin, without so overwhelming the base cost
 * that gentle rolling terrain (small height differences) gets penalised into
 * looking like a wall.
 *
 * WHY IT IS DERIVED (2026-08-21). Height units did not get finer and steps
 * did: leaving this at a literal 1 would have quartered the slope term's
 * weight against distance, which is a different pathfinder — walkers taking
 * the steep way because the gentle way now counts four times the steps.
 *
 * Skipped entirely for a water-ground profile (maxGradientPerCell = Infinity,
 * traversal.ts): water has no risers, so there is nothing to penalise.
 */
export const SLOPE_COST_PER_HEIGHT_UNIT = WORLD_UNIT_CELLS;

// ─────────────────────────────────────────────────────────────────────────────
// Search bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far a route may swing from the straight line between start and goal,
 * in cells, on either axis.
 *
 * Two NEIGHBOURHOODS — a fixed, generous multiple of the game's own
 * neighbourhood unit (16 world units of ground: 128 cells since the 2026-08-21
 * re-sample, 32 before it, the same swing across the ground either way) —
 * enough room to clear an obstacle several neighbourhoods wide without letting
 * the search box grow unboundedly with trip length. ASSUMPTION, named because it is not measured: no telemetry
 * exists yet on how wide a player-built obstacle typically gets between two
 * points a walker plugin routes between (tens of cells, per pilgrims'
 * PILGRIMAGE_CATCHMENT_CELLS / wanderers' WANDER_RANGE_CELLS). If a shipped
 * world ever shows a walker giving up on a route that a human would call
 * "obviously reachable by walking a bit further out", this is the constant to
 * retune. Until then: a destination that needs a wider swing than this to
 * reach — circumnavigating a whole lake or peninsula — is DELIBERATELY
 * treated the same as truly unreachable (`findRoute` returns null and the
 * caller's failure contract takes over), because every shipped walker's trip
 * is a short local journey (a viewpoint, a neighbouring town), never a
 * cross-continent trek.
 */
export const ROUTE_SEARCH_MARGIN_CELLS = NEIGHBOURHOOD_CELLS * 2;

/**
 * Hard cap on nodes EXPANDED (popped off the open set) by one `findRoute`
 * call — the "bounded work" requirement: a 512² world is 262 144 cells and
 * terrain changes on every sculpt, so an unbounded search per walker per tick
 * cannot be allowed to exist.
 *
 * Cost model, benchmarked against the census's own measured rate (wildlife's
 * HABITAT_CENSUS_INTERVAL_SECONDS: ~262 144 cells in ~1 ms, i.e. roughly
 * 262 elementary cell-ops per microsecond on the reference hardware that
 * figure was measured on). One expansion here does substantially more work
 * than one census cell: up to 8 neighbour edges, each running an
 * isWalkableCell bounds+ground check and (for finite-gradient profiles) a
 * height read and comparison, plus one binary-heap push and sift
 * (O(log budget) ≈ 12 comparisons at this budget) per surviving edge — call
 * it on the order of 100 elementary ops per expansion, ~10× a census cell.
 * At the census's measured rate that puts 4096 expansions × ~100 ops
 * ≈ 410 000 ops at roughly 1.5 ms — well under one 100 ms tick (TICK_HZ = 10)
 * even if several walkers replan on the same tick.
 *
 * That "several walkers on the same tick" case is a burst, not a steady
 * load: routes are computed on GOAL-CHANGE events (a walker is dispatched, or
 * its leg changes — see pilgrims' pilgrimage.ts/wandering.ts), not once per
 * tick per walker, and a goal change happens at most a handful of times over
 * one walker's whole lifetime. Bounded further by each plugin's own
 * population cap (pilgrims: PILGRIMS_CAP + WANDERERS_CAP = 40; wildlife does
 * not use routing — see the movement.ts contour-following note), so the
 * worst single-tick cost is that cap × this budget's ~1.5 ms, itself only
 * reachable if every capped walker's goal changed on the exact same tick.
 *
 * A TEST SEAM: findRoute takes this as an optional last argument so a suite
 * can force budget exhaustion on a small, fast search rather than construct
 * a full-budget maze.
 *
 * SCALED WITH THE SAMPLING DENSITY (2026-08-21). What the budget really buys
 * is a REACHABLE AREA — the ground A* may explore before giving up — and a
 * given patch of ground is now sixteen cells where it was one. Left at 4096
 * the walkers would have kept the number and lost the range: every trip's
 * reachable radius would have quartered, and "obviously reachable by walking a
 * bit further out" would start failing at a quarter of the distance. The
 * budget is therefore stated as expansions per unit of ground and multiplied
 * by WORLD_UNIT_CELLS², holding the area constant at 65 536 expansions.
 *
 * THE COST IS REAL AND IS THE PRICE OF THE RANGE: the cost model above puts
 * one exhausted search at ~24 ms rather than ~1.5, so the burst case it
 * bounds — every capped walker replanning on one tick — no longer fits in a
 * 100 ms tick. It is reachable only by a search that fails, which is why it is
 * accepted here rather than paid for with range; the fix if a shipped world
 * hits it is to spread replans across ticks (a scheduling change in the walker
 * plugins), not to shrink the area a walker can see.
 */
const ROUTE_NODE_BUDGET_PER_WORLD_UNIT_SQUARED = 4096;
export const ROUTE_NODE_BUDGET =
  cellsOverArea(ROUTE_NODE_BUDGET_PER_WORLD_UNIT_SQUARED);

/**
 * A pool of node expansions SHARED by every `findRoute` call in one turn of a
 * caller's work.
 *
 * WHY THE PER-CALL BUDGET WAS NOT ENOUGH (2026-08-29 perf review, D1/D2).
 * ROUTE_NODE_BUDGET bounds ONE search. It says nothing about a caller that
 * runs N searches inside a single synchronous call, and that is exactly what
 * a site scan does — pilgrims' `scanSettleSites` walked 768 anchors and asked
 * A* about each one. Every anchor that was walkable but not connected to the
 * walker cost a WHOLE budget (~29 ms measured), so one temple-placement press
 * blocked the server's event loop for seconds. The bound has to be on the
 * turn, not on the call, and a pool is the smallest thing that expresses that:
 * the caller mints one, hands it to every search it makes, and the total spend
 * across all of them can never exceed what it minted.
 *
 * DETERMINISTIC BY CONSTRUCTION, and that is why it is an expansion COUNT and
 * not an elapsed-time budget. A wall-clock bound inside this file would make
 * the route a walker gets depend on how loaded the machine was — the server
 * and a client replaying the same heights would disagree, which is precisely
 * what this module's determinism contract (see the file header) forbids. An
 * integer pool threaded through calls in a fixed order is a pure function of
 * its inputs: the same world, the same start/goal sequence and the same
 * starting `remaining` give byte-identical routes every time, on any machine.
 * A caller that genuinely wants a WALL-CLOCK ceiling converts it to a pool
 * size at ITS OWN layer (outside `shared/`), where non-determinism is allowed
 * because the number chosen is then part of the input, not read mid-search.
 */
export interface RouteBudget {
  /**
   * Expansions still available to this pool. Each `findRoute` handed this
   * object caps itself at this value and subtracts what it actually spent.
   * An exhausted pool (0) makes every further search return null immediately,
   * which is the caller's signal that its turn's routing allowance is gone.
   */
  remaining: number;
}

/**
 * Mints a pool of `expansions` node expansions to be shared across one turn's
 * searches. Defaults to ROUTE_NODE_BUDGET — "one whole search's worth, however
 * many searches it takes".
 */
export function createRouteBudget(expansions: number = ROUTE_NODE_BUDGET): RouteBudget {
  return { remaining: Math.max(0, Math.floor(expansions)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────

/** One integer cell on a route. */
export interface RouteCell {
  readonly x: number;
  readonly y: number;
}

/**
 * A planned route: start to goal inclusive, in walking order. `cost` is in
 * the cost-model's own units (see ORTHOGONAL_STEP_COST) — comparable between
 * two routes over the same profile, meaningless outside that comparison.
 *
 * EXPOSED so a future roads feature (mechanics card 29: "long-lived
 * neighbouring settlements wear footpaths between themselves along walkable
 * routes") can read the ordered cell list without this file knowing roads
 * exist — this module never renders or persists a route, it only computes
 * one and hands back the list.
 */
export interface RoutePlan {
  readonly cells: ReadonlyArray<RouteCell>;
  readonly cost: number;
}

/**
 * Fixed neighbour scan order: N, NE, E, SE, S, SW, W, NW — clockwise from
 * north, alternating orthogonal/diagonal. Part of the determinism contract
 * only in the sense that it is FIXED (rivers.ts's FLOW_DIRECTIONS precedent);
 * it does not affect which route wins (the open-set tie-break below is what
 * decides that), only the incidental order candidate edges are relaxed in.
 */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [dx: number, dy: number, baseCost: number]> = [
  [0, -1, ORTHOGONAL_STEP_COST],
  [1, -1, DIAGONAL_STEP_COST],
  [1, 0, ORTHOGONAL_STEP_COST],
  [1, 1, DIAGONAL_STEP_COST],
  [0, 1, ORTHOGONAL_STEP_COST],
  [-1, 1, DIAGONAL_STEP_COST],
  [-1, 0, ORTHOGONAL_STEP_COST],
  [-1, -1, DIAGONAL_STEP_COST],
];

/** Admissible octile-distance heuristic, using the same integer cost scale
 *  as the edges themselves (ORTHOGONAL/DIAGONAL_STEP_COST) so it never
 *  overestimates the true remaining cost (slope cost only ever ADDS to an
 *  edge's base cost, never subtracts, so ignoring it here keeps the estimate
 *  a lower bound). */
function octileHeuristic(dx: number, dy: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const diagonalSteps = Math.min(ax, ay);
  const straightSteps = Math.max(ax, ay) - diagonalSteps;
  return diagonalSteps * DIAGONAL_STEP_COST + straightSteps * ORTHOGONAL_STEP_COST;
}

/** One entry in the open-set heap. */
interface OpenEntry {
  readonly key: number;
  readonly x: number;
  readonly y: number;
  readonly g: number;
  readonly f: number;
  readonly h: number;
}

/**
 * Total, deterministic priority order: lower f first: ties broken by lower h
 * (prefer the node closer to the goal); ties broken by lower cell key (a
 * fixed, arbitrary-but-stable ordering over the grid). Because `key` is
 * unique per cell, this is a STRICT total order — no two distinct entries
 * ever compare equal — which is what makes the heap's output independent of
 * push order and therefore reproducible byte-for-byte across runs.
 */
function hasHigherPriority(a: OpenEntry, b: OpenEntry): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h;
  return a.key < b.key;
}

/** Minimal binary min-heap, ordered by `hasHigherPriority`. Array-backed,
 *  fixed sift operations — no dependency on Map/Set iteration order. */
class RouteOpenSet {
  private readonly items: OpenEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(entry: OpenEntry): void {
    this.items.push(entry);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!hasHigherPriority(this.items[i], this.items[parent])) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  pop(): OpenEntry | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (top === undefined) return undefined;
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let smallest = i;
        if (left < n && hasHigherPriority(this.items[left], this.items[smallest])) smallest = left;
        if (right < n && hasHigherPriority(this.items[right], this.items[smallest])) smallest = right;
        if (smallest === i) break;
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Cost of stepping from (fromX, fromY) to the adjacent (toX, toY), or null
 *  if the step is illegal (wrong ground, or a slope steeper than the
 *  profile's limit). Adjacent cells only — a route edge is always one grid
 *  step, so the segment-sampling canTraverseSegment would degenerate to this
 *  same single comparison; this is that degenerate case written directly. */
function edgeCost(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  baseCost: number,
): number | null {
  if (!isWalkableCell(world, profile, toX, toY)) return null;
  const limit = profile.maxGradientPerCell;
  if (!Number.isFinite(limit)) return baseCost; // water-ground: no risers, no slope cost.

  const heightDiff = Math.abs(world.heightAt(toX, toY) - world.heightAt(fromX, fromY));
  if (heightDiff > limit) return null;
  return baseCost + heightDiff * SLOPE_COST_PER_HEIGHT_UNIT;
}

function reconstructPath(
  cameFrom: ReadonlyMap<number, number>,
  startKey: number,
  goalKey: number,
  worldSize: number,
): RouteCell[] {
  const cells: RouteCell[] = [];
  let key: number | undefined = goalKey;
  while (key !== undefined) {
    cells.push({ x: key % worldSize, y: Math.floor(key / worldSize) });
    if (key === startKey) break;
    key = cameFrom.get(key);
  }
  cells.reverse();
  return cells;
}

/**
 * Plans a route from `start` to `goal` over `profile`'s ground, preferring
 * gentle slopes to steep-but-legal ones (see SLOPE_COST_PER_HEIGHT_UNIT).
 * A* with an admissible octile heuristic, an explicit deterministic tie-break
 * (see `hasHigherPriority`), and two hard bounds: `ROUTE_SEARCH_MARGIN_CELLS`
 * (how far the search may swing off the direct line) and `nodeBudget`
 * (CPU). Returns null when no route exists within those bounds — see this
 * module's header and ROUTE_SEARCH_MARGIN_CELLS/ROUTE_NODE_BUDGET for what
 * "within those bounds" means and why that is an accepted scope limit rather
 * than a bug.
 *
 * Diagonal steps may not cut a corner: a diagonal edge is only offered when
 * BOTH of its flanking orthogonal cells are cells the walker could ACTUALLY
 * STEP INTO from here — the standard grid-pathing rule against squeezing
 * diagonally through the corner of an obstacle it could not pass along either
 * straight edge.
 *
 * "Could actually step into" means the full edge test (`edgeCost`), not merely
 * walkable ground, and that distinction is a bug fix (2026-08-20). The ground-
 * only version let A* emit a diagonal whose flanks were legal GROUND but
 * impassable RISERS — e.g. from a cell at height 226 to one at 232 (a 6-unit
 * step, happily legal) with flanks at 258 and 64, both dry land and both far
 * past the gradient limit. On the grid that is a legal move; to anything that
 * moves CONTINUOUSLY it is not, because a body crossing from one cell to its
 * diagonal neighbour passes through one of the two flanks on the way, and both
 * of these are cliffs. A follower handed such a route walks up to the corner
 * and stops — which is exactly the "stuck in the middle of nowhere" the owner
 * reported, arriving by a second road (see shared/src/steering.ts for the
 * first). The planner must only ever emit edges the walker can physically
 * take.
 *
 * `start`/`goal` are floored to their containing cell. Coincident start/goal
 * cells return a trivial one-cell, zero-cost route rather than running the
 * search.
 */
export function findRoute(
  world: TerrainSampler,
  profile: TraversalProfile,
  start: RouteCell,
  goal: RouteCell,
  budget: number | RouteBudget = ROUTE_NODE_BUDGET,
): RoutePlan | null {
  // A bare number is this ONE search's allowance (the original contract and
  // the test seam); a RouteBudget is a pool this search draws from and pays
  // back into, so N searches in one turn share one allowance (see RouteBudget).
  const pool: RouteBudget | null = typeof budget === 'number' ? null : budget;
  const nodeBudget: number = typeof budget === 'number' ? budget : budget.remaining;
  const startX = Math.floor(start.x);
  const startY = Math.floor(start.y);
  const goalX = Math.floor(goal.x);
  const goalY = Math.floor(goal.y);

  if (!isWalkableCell(world, profile, startX, startY)) return null;
  if (!isWalkableCell(world, profile, goalX, goalY)) return null;
  if (startX === goalX && startY === goalY) {
    return { cells: [{ x: startX, y: startY }], cost: 0 };
  }

  const minX = Math.min(startX, goalX) - ROUTE_SEARCH_MARGIN_CELLS;
  const maxX = Math.max(startX, goalX) + ROUTE_SEARCH_MARGIN_CELLS;
  const minY = Math.min(startY, goalY) - ROUTE_SEARCH_MARGIN_CELLS;
  const maxY = Math.max(startY, goalY) + ROUTE_SEARCH_MARGIN_CELLS;

  const worldSize = world.worldSize;
  const cellKey = (x: number, y: number): number => y * worldSize + x;
  const startKey = cellKey(startX, startY);
  const goalKey = cellKey(goalX, goalY);

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const open = new RouteOpenSet();

  gScore.set(startKey, 0);
  const startH = octileHeuristic(goalX - startX, goalY - startY);
  open.push({ key: startKey, x: startX, y: startY, g: 0, f: startH, h: startH });

  let expansions = 0;
  // `finally` rather than a subtraction before each return: the search has four
  // exits (budget, empty heap, goal, open-set exhaustion) and a pool that is
  // only paid back on some of them would drift silently.
  try {
    while (open.size > 0) {
      if (expansions >= nodeBudget) return null; // budget exhausted — see ROUTE_NODE_BUDGET.
      const current = open.pop();
      if (current === undefined) break;
      expansions++;

      // Stale entry: a cheaper path to this cell was already found and (or is
      // about to be) expanded. Lazy deletion — cheaper than a heap decrease-key.
      const bestKnown = gScore.get(current.key);
      if (bestKnown === undefined || current.g > bestKnown) continue;

      if (current.key === goalKey) {
        return { cells: reconstructPath(cameFrom, startKey, goalKey, worldSize), cost: current.g };
      }

      for (const [dx, dy, baseCost] of NEIGHBOR_OFFSETS) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;

        if (dx !== 0 && dy !== 0) {
          // Corner-cutting guard (see this function's doc comment). The SAME
          // edge test the move itself uses, so a flank that is legal ground but
          // an illegal climb blocks the corner exactly as a wall would.
          const alongX = edgeCost(world, profile, current.x, current.y, current.x + dx, current.y, ORTHOGONAL_STEP_COST);
          const alongY = edgeCost(world, profile, current.x, current.y, current.x, current.y + dy, ORTHOGONAL_STEP_COST);
          if (alongX === null || alongY === null) continue;
        }

        const cost = edgeCost(world, profile, current.x, current.y, nx, ny, baseCost);
        if (cost === null) continue;

        const tentativeG = current.g + cost;
        const neighborKey = cellKey(nx, ny);
        const known = gScore.get(neighborKey);
        if (known !== undefined && tentativeG >= known) continue;

        gScore.set(neighborKey, tentativeG);
        cameFrom.set(neighborKey, current.key);
        const h = octileHeuristic(goalX - nx, goalY - ny);
        open.push({ key: neighborKey, x: nx, y: ny, g: tentativeG, f: tentativeG + h, h });
      }
    }

    return null; // open set exhausted inside the search box: no route exists.
  } finally {
    if (pool !== null) pool.remaining -= expansions;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reachability — the question A* should never have been asked
// ─────────────────────────────────────────────────────────────────────────────

/** An integer cell box, inclusive on all four sides. */
export interface RouteBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Which cells one walker can WALK TO — the answer to "is there any route at
 * all", separated from "what is the best route".
 *
 * WHY THIS EXISTS (2026-08-29 perf review, D1/D2). Callers were using
 * `findRoute` as a reachability test, and it is the most expensive possible
 * one: proving a cell unreachable costs a whole node budget, because A* has to
 * exhaust its budget before it can say no. A flood fill answers the same
 * question for a WHOLE BOX at once, in one pass over that box, and then every
 * candidate in the box is an O(1) lookup. A scan that asked A* 768 times now
 * floods once.
 *
 * IT IS A PREFILTER, NOT A REPLACEMENT. `has` true means "a walker can reach
 * this cell somewhere inside the flooded box"; the route itself is still
 * `findRoute`'s to produce, and `findRoute` searches a NARROWER box of its own
 * (ROUTE_SEARCH_MARGIN_CELLS around the start–goal line), so it may still fail
 * on a cell this says is reachable. The reverse cannot happen as long as the
 * caller floods a box containing every search box it will use — see
 * `floodReachableRegion`.
 */
export interface ReachableRegion {
  /** Can the flood's start cell reach the cell containing (x, y)? Cells
   *  outside the flooded box always answer false. */
  has(x: number, y: number): boolean;
}

/**
 * Orthogonal steps in the fixed N, E, S, W order the flood relaxes them in.
 * Separate from NEIGHBOR_OFFSETS because the flood must settle all four
 * orthogonal edges BEFORE the diagonals that depend on them (see below).
 */
const FLOOD_ORTHOGONAL_OFFSETS: ReadonlyArray<readonly [dx: number, dy: number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Diagonal steps, each carrying the INDICES into FLOOD_ORTHOGONAL_OFFSETS of
 * the two flanking orthogonal edges the corner-cutting guard requires. Same
 * rule `findRoute` applies (see its doc comment): a diagonal is only a step if
 * both flanks are steps, because a body crossing to a diagonal neighbour
 * passes through one of them. Precomputing the four flanks once per cell makes
 * this eight edge tests per cell instead of twelve.
 */
const FLOOD_DIAGONAL_OFFSETS: ReadonlyArray<
  readonly [dx: number, dy: number, flankA: number, flankB: number]
> = [
  [1, -1, 0, 1],
  [1, 1, 1, 2],
  [-1, 1, 2, 3],
  [-1, -1, 3, 0],
];

/** A region nothing reached — the answer when the start is off-world, outside
 *  the box, or standing on ground the profile cannot occupy. */
const EMPTY_REACHABLE_REGION: ReachableRegion = { has: () => false };

/**
 * Floods every cell inside `bounds` a walker on `profile` can reach on foot
 * from `start`, using EXACTLY the step rules `findRoute` uses (`edgeCost`, plus
 * the same corner-cutting guard) so the two can never disagree about what a
 * step is.
 *
 * COST IS THE BOX, NOT A BUDGET: one pass, each cell entered at most once,
 * eight edge tests per entered cell — so `bounds` IS the bound, and the caller
 * sizes it. That is the whole point: a bounded, predictable sweep replaces an
 * unbounded number of budget-exhausting searches.
 *
 * TO KEEP A PREFILTER CONSERVATIVE the caller must flood a box that CONTAINS
 * every `findRoute` search box it will subsequently use — i.e. the box around
 * its start and all its candidate goals, grown by ROUTE_SEARCH_MARGIN_CELLS.
 * Then any route A* could have found lies inside this flood, so this flood
 * reaching nothing proves A* would have found nothing, and no site A* would
 * have accepted is ever refused.
 *
 * DETERMINISTIC: integer-only, a fixed neighbour order, an array-backed FIFO —
 * no Map/Set iteration anywhere, and the answer does not depend on visit order
 * in any case.
 *
 * FLOOD FROM THE SEARCH'S OWN START, NEVER FROM ITS GOAL (issue #266). It is
 * tempting to flood once from a shared destination and let many origins ask
 * about it — pilgrims' "which of these towns can reach that viewpoint" is
 * exactly that shape — but reachability over a profile with a finite gradient
 * limit IS NOT SYMMETRIC: the corner-cutting guard above tests a diagonal's
 * flanks against the height of the cell being stood on, so a corner legal
 * from one end can be illegal from the other. Demonstrated with the shipped
 * code: two diagonal neighbours at base and base+MAX_STEP with both flanks at
 * base−MAX_STEP give `findRoute` A→B a route and a flood from B no way back to
 * A. A goal-side flood is therefore NOT a conservative prefilter for
 * origin-side searches, and using it as one silently refuses trips that are
 * walkable. Issue #266 memoises A*'s own answer instead.
 */
export function floodReachableRegion(
  world: TerrainSampler,
  profile: TraversalProfile,
  start: RouteCell,
  bounds: RouteBounds,
): ReachableRegion {
  const startX = Math.floor(start.x);
  const startY = Math.floor(start.y);
  const worldSize = world.worldSize;

  const minX = Math.max(0, bounds.minX);
  const minY = Math.max(0, bounds.minY);
  const maxX = Math.min(worldSize - 1, bounds.maxX);
  const maxY = Math.min(worldSize - 1, bounds.maxY);
  if (maxX < minX || maxY < minY) return EMPTY_REACHABLE_REGION;
  if (startX < minX || startX > maxX || startY < minY || startY > maxY) {
    return EMPTY_REACHABLE_REGION;
  }
  if (!isWalkableCell(world, profile, startX, startY)) return EMPTY_REACHABLE_REGION;

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cells = width * height;
  const reached = new Uint8Array(cells);
  // Every cell is enqueued at most once (it is marked as it is enqueued), so
  // the queue can never outgrow the box — a fixed allocation, no growth checks.
  const queue = new Int32Array(cells);
  let tail = 0;

  // GROUND CLASSIFIED ONCE PER CELL, NOT ONCE PER EDGE. `edgeCost` re-runs
  // isWalkableCell and heightAt on its TARGET cell every time it is called, and
  // a flood looks at every cell from up to eight sides — so calling it per edge
  // pays for the same ground test eight times over. Caching the two facts an
  // edge actually needs (may a walker occupy this cell, and how high is it)
  // leaves the edge test as two array reads and a comparison. Measured on a
  // 421² box over an Int16 heightmap: 40 ms per flood before, single digits
  // after. The PREDICATE is unchanged — this is the same isWalkableCell and the
  // same gradient limit `edgeCost` applies, read from a memo.
  const UNCLASSIFIED = 0;
  const BLOCKED = 1;
  const OCCUPIABLE = 2;
  const ground = new Uint8Array(cells);
  const heights = new Float64Array(cells);
  const limit = profile.maxGradientPerCell;
  // A water-ground profile has no risers to climb, so its edges never consult a
  // height at all — the same branch `edgeCost` takes on a non-finite limit.
  const checksGradient = Number.isFinite(limit);

  const classify = (index: number, cx: number, cy: number): number => {
    const known = ground[index];
    if (known !== UNCLASSIFIED) return known;
    if (!isWalkableCell(world, profile, cx, cy)) {
      ground[index] = BLOCKED;
      return BLOCKED;
    }
    if (checksGradient) heights[index] = world.heightAt(cx, cy);
    ground[index] = OCCUPIABLE;
    return OCCUPIABLE;
  };

  const startIndex = (startY - minY) * width + (startX - minX);
  classify(startIndex, startX, startY);
  reached[startIndex] = 1;
  queue[tail++] = startIndex;

  // Reused across cells so the flood allocates nothing per cell. Index i is
  // FLOOD_ORTHOGONAL_OFFSETS[i]; the diagonals read it by flank index.
  const orthogonalLegal = [false, false, false, false];

  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    // `| 0` is exact integer division here: index and width are both
    // non-negative integers well under 2^31, so this truncates rather than
    // rounds — the same value Math.floor gives, without the call.
    const row = (index / width) | 0;
    const x = minX + (index - row * width);
    const y = minY + row;
    const fromHeight = heights[index];

    for (let i = 0; i < FLOOD_ORTHOGONAL_OFFSETS.length; i++) {
      // Indexed, not destructured: array destructuring in this loop builds an
      // iterator per neighbour per cell, and at ~1.4 million neighbours per
      // flood that machinery outweighed the ground tests it was fetching
      // offsets for (measured: 21 ms per flood with it, 5 ms without).
      const offset = FLOOD_ORTHOGONAL_OFFSETS[i];
      const dx = offset[0];
      const dy = offset[1];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) {
        orthogonalLegal[i] = false;
        continue;
      }
      const neighborIndex = (ny - minY) * width + (nx - minX);
      const legal =
        classify(neighborIndex, nx, ny) === OCCUPIABLE &&
        (!checksGradient || Math.abs(heights[neighborIndex] - fromHeight) <= limit);
      orthogonalLegal[i] = legal;
      if (!legal || reached[neighborIndex] === 1) continue;
      reached[neighborIndex] = 1;
      queue[tail++] = neighborIndex;
    }

    for (let i = 0; i < FLOOD_DIAGONAL_OFFSETS.length; i++) {
      const offset = FLOOD_DIAGONAL_OFFSETS[i];
      // The corner-cutting guard: both flanks must be steps this walker could
      // actually take, exactly as in findRoute.
      if (!orthogonalLegal[offset[2]] || !orthogonalLegal[offset[3]]) continue;
      const nx = x + offset[0];
      const ny = y + offset[1];
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const neighborIndex = (ny - minY) * width + (nx - minX);
      if (reached[neighborIndex] === 1) continue;
      if (classify(neighborIndex, nx, ny) !== OCCUPIABLE) continue;
      if (checksGradient && Math.abs(heights[neighborIndex] - fromHeight) > limit) continue;
      reached[neighborIndex] = 1;
      queue[tail++] = neighborIndex;
    }
  }

  return {
    has(x: number, y: number): boolean {
      const cx = Math.floor(x) - minX;
      const cy = Math.floor(y) - minY;
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) return false;
      return reached[cy * width + cx] === 1;
    },
  };
}
