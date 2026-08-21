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
import { CHUNK_SIZE } from './constants.ts';

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
 * 1 — chosen against MAX_STEP-scale climbs, not against the base move costs
 * directly: LAND_WALKER_MAX_GRADIENT_PER_CELL (traversal.ts) is 16, so the
 * steepest legal single-cell climb for a land walker costs +16 on top of its
 * base 10 (orthogonal) or 14 (diagonal) — roughly 2.6×–2.7× the flat rate.
 * That is enough that a 2-cell flat detour (20) already beats a single
 * max-gradient climb (26), and a short flat detour beats a short steep one by
 * a wide, visible margin, without so overwhelming the base cost that gentle
 * rolling terrain (small height differences) gets penalised into looking
 * like a wall. Skipped entirely for a water-ground profile
 * (maxGradientPerCell = Infinity, traversal.ts): water has no risers, so
 * there is nothing to penalise.
 */
export const SLOPE_COST_PER_HEIGHT_UNIT = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Search bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far a route may swing from the straight line between start and goal,
 * in cells, on either axis.
 *
 * 2×CHUNK_SIZE (32) — a fixed, generous multiple of the game's own
 * neighbourhood unit (CHUNK_SIZE = 16), enough room to clear an obstacle
 * several chunks wide without letting the search box grow unboundedly with
 * trip length. ASSUMPTION, named because it is not measured: no telemetry
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
export const ROUTE_SEARCH_MARGIN_CELLS = CHUNK_SIZE * 2;

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
 * a 4096-node maze.
 */
export const ROUTE_NODE_BUDGET = 4096;

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
  nodeBudget: number = ROUTE_NODE_BUDGET,
): RoutePlan | null {
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
}
