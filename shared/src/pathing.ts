// ROUTING — go AROUND obstacles, not over or through them: A* over the
// traversal.ts contract, preferring gentle ground to steep-but-legal.
// Deterministic by contract — see docs/decisions/movement.md.

import {
  exceedsWalkableGradient,
  isWalkableCell,
  type ClimbRule,
  type TerrainSampler,
  type TraversalProfile,
} from './traversal.ts';
import { WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND, climbSeconds } from './climb.ts';
import {
  CELL_WORLD_SIZE,
  NEIGHBOURHOOD_CELLS,
  WORLD_UNIT_CELLS,
  cellsOverArea,
} from './constants.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Cost model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base cost of one orthogonal step. 10 — the classic integer octile scale,
 * chosen so the diagonal cost below can be an integer too.
 * See docs/decisions/movement.md.
 */
export const ORTHOGONAL_STEP_COST = 10;

/**
 * Base cost of one diagonal step. 14 ≈ 10·√2, the standard octile
 * approximation — 10 would make diagonals dominant, 20 would forbid them.
 * See docs/decisions/movement.md.
 */
export const DIAGONAL_STEP_COST = 14;

/**
 * Extra cost per unit of |height difference| an edge crosses: what makes a
 * route prefer the gentle way round. Derived, and skipped for water profiles
 * (no risers). See docs/decisions/movement.md.
 */
export const SLOPE_COST_PER_HEIGHT_UNIT = WORLD_UNIT_CELLS;

/** Seconds one cell of flat walking takes at that speed — the unit ORTHOGONAL_STEP_COST buys. */
const FLAT_CELL_SECONDS = CELL_WORLD_SIZE / WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND;

/**
 * What one SECOND of climbing costs, in the same units as a walked step. Per
 * second, not per height unit, since climbers have rates of their own.
 * See docs/decisions/movement.md.
 */
const CLIMB_COST_PER_SECOND = ORTHOGONAL_STEP_COST / FLAT_CELL_SECONDS;

// ─────────────────────────────────────────────────────────────────────────────
// Search bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far a route may swing from the straight start–goal line, in cells. Two
 * neighbourhoods: enough to clear a wide obstacle without an unbounded search
 * box. See docs/decisions/movement.md.
 */
export const ROUTE_SEARCH_MARGIN_CELLS = NEIGHBOURHOOD_CELLS * 2;

/**
 * What a route will pay to avoid a CERTAIN death: the widest detour this
 * planner can plan (ROUTE_SEARCH_MARGIN_CELLS of flat walking). Bounded by the
 * search box. See docs/decisions/movement.md.
 */
const CERTAIN_DEATH_COST = ORTHOGONAL_STEP_COST * ROUTE_SEARCH_MARGIN_CELLS;

/**
 * Hard cap on nodes EXPANDED by one `findRoute` call: an unbounded per-walker
 * search cannot exist. Stated per unit of ground so the reachable AREA holds.
 * See docs/decisions/movement.md.
 */
const ROUTE_NODE_BUDGET_PER_WORLD_UNIT_SQUARED = 4096;
export const ROUTE_NODE_BUDGET =
  cellsOverArea(ROUTE_NODE_BUDGET_PER_WORLD_UNIT_SQUARED);

/**
 * A pool of expansions shared by every `findRoute` call in one caller's turn:
 * a count, not a clock, so routes stay deterministic.
 * See docs/decisions/movement.md.
 */
export interface RouteBudget {
  /**
   * Expansions still available. Each `findRoute` handed this object caps
   * itself at this value and subtracts what it spent; 0 makes every further
   * search return null.
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
 * A planned route: start to goal inclusive, in walking order. `cost` is in the
 * cost model's own units — comparable between two routes over the same
 * profile, meaningless elsewhere.
 */
export interface RoutePlan {
  readonly cells: ReadonlyArray<RouteCell>;
  readonly cost: number;
}

/**
 * Fixed neighbour scan order: N, NE, E, SE, S, SW, W, NW. Fixed is the point;
 * it decides only the order edges are relaxed in, never which route wins.
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

/** Admissible octile-distance heuristic on the same integer cost scale as the
 *  edges, so it never overestimates: slope cost only ever ADDS to an edge. */
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
 * Total, deterministic priority order: lower f, then lower h, then lower cell
 * key. `key` is unique per cell, so this is a STRICT total order, independent
 * of push order.
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

/** Cost of one step to an adjacent cell, or null if the step is illegal:
 *  wrong ground, or a slope steeper than the profile's limit. */
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
  if (!Number.isFinite(profile.maxGradientPerCell)) return baseCost; // water: no risers, no slope cost.

  const fromHeight = world.heightAt(fromX, fromY);
  const toHeight = world.heightAt(toX, toY);
  const heightDiff = Math.abs(toHeight - fromHeight);
  if (exceedsWalkableGradient(profile, heightDiff)) {
    const rule = profile.climb;
    // Not a climber: the wall is the end of this branch.
    if (rule === undefined || rule === null) return null;
    // Signed, not the magnitude: a descent also turns about and steps off at
    // the bottom, so it is the dearer of the two directions.
    return baseCost + climbEdgeCost(rule, fromHeight, toHeight);
  }
  return baseCost + heightDiff * SLOPE_COST_PER_HEIGHT_UNIT;
}

/**
 * What one climbed edge costs a route: the TIME the climb takes, priced as
 * walking, plus what its risk of death is worth avoiding.
 * See docs/decisions/movement.md.
 */
function climbEdgeCost(rule: ClimbRule, fromHeight: number, toHeight: number): number {
  // Every climb rolls (climb.ts's `beginClimb`), so every climbed edge is
  // priced for the risk. No height gate: the 4:1 sheer rule keeps a knee-high
  // ledge from being a climb.
  const risk = rule.fallChance * CERTAIN_DEATH_COST;
  // THIS CLIMBER'S OWN SECONDS, and ALL of them: `climbSeconds` adds up the
  // legs climb.ts walks, so the planner cannot price a climb that is gone.
  return climbSeconds(rule, fromHeight, toHeight) * CLIMB_COST_PER_SECOND + risk;
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
 * gentle slopes to steep-but-legal ones. Null when no route exists within the
 * margin and node budget. See docs/decisions/movement.md.
 */
export function findRoute(
  world: TerrainSampler,
  profile: TraversalProfile,
  start: RouteCell,
  goal: RouteCell,
  budget: number | RouteBudget = ROUTE_NODE_BUDGET,
): RoutePlan | null {
  // A bare number is this ONE search's allowance and the test seam; a
  // RouteBudget is a pool this search draws from and pays back into.
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
  // `finally` rather than a subtraction before each return: the search has
  // four exits, and a pool paid back on only some of them would drift.
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
          // Corner-cutting guard: a diagonal is offered only when BOTH
          // flanking orthogonal steps are legal, by the SAME edge test the
          // move itself uses.
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
 * Which cells one walker can WALK TO — "is there any route at all", not "what
 * is the best route". A PREFILTER: `findRoute` may still fail.
 * See docs/decisions/movement.md.
 */
export interface ReachableRegion {
  /** Can the flood's start cell reach the cell containing (x, y)? Cells
   *  outside the flooded box always answer false. */
  has(x: number, y: number): boolean;
}

/**
 * Orthogonal steps in the fixed N, E, S, W order the flood relaxes them in.
 * Separate from NEIGHBOR_OFFSETS: all four must settle before the diagonals.
 */
const FLOOD_ORTHOGONAL_OFFSETS: ReadonlyArray<readonly [dx: number, dy: number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Diagonal steps, each carrying the INDICES into FLOOD_ORTHOGONAL_OFFSETS of
 * its two flanking edges — the same corner-cutting guard `findRoute` applies,
 * precomputed once per cell.
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
 * Floods every cell inside `bounds` a walker on `profile` can reach from
 * `start`, by EXACTLY the step rules `findRoute` uses. One pass; `bounds` is
 * the bound. See docs/decisions/movement.md.
 */
export function floodReachableRegion(
  world: TerrainSampler,
  profile: TraversalProfile,
  start: RouteCell,
  bounds: RouteBounds,
): ReachableRegion {
  // Never flood from the goal: reachability is not symmetric under the
  // corner-cutting guard. See docs/decisions/movement.md.
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

  // GROUND CLASSIFIED ONCE PER CELL, NOT ONCE PER EDGE: a flood sees each cell
  // from eight sides. The predicate is `edgeCost`'s, memoised — see
  // docs/decisions/movement.md.
  const UNCLASSIFIED = 0;
  const BLOCKED = 1;
  const OCCUPIABLE = 2;
  const ground = new Uint8Array(cells);
  const heights = new Float64Array(cells);
  const limit = profile.maxGradientPerCell;
  // Neither a water profile nor a CLIMBER is stopped by a rise: reachability
  // asks whether a mover can get there at all. This must admit exactly what
  // `edgeCost` prices.
  const climbs = profile.climb !== undefined && profile.climb !== null;
  const checksGradient = Number.isFinite(limit) && !climbs;

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
    // `| 0` is exact integer division here: index and width are non-negative
    // integers well under 2^31, so this truncates rather than rounds.
    const row = (index / width) | 0;
    const x = minX + (index - row * width);
    const y = minY + row;
    const fromHeight = heights[index];

    for (let i = 0; i < FLOOD_ORTHOGONAL_OFFSETS.length; i++) {
      // Indexed, not destructured: array destructuring here builds an iterator
      // per neighbour per cell, which outweighed the ground tests it fetched
      // offsets for. See docs/decisions/movement.md.
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
