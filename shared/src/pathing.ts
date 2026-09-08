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

export const ORTHOGONAL_STEP_COST = 10;

export const DIAGONAL_STEP_COST = 14;

export const SLOPE_COST_PER_HEIGHT_UNIT = WORLD_UNIT_CELLS;

const FLAT_CELL_SECONDS = CELL_WORLD_SIZE / WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND;

const CLIMB_COST_PER_SECOND = ORTHOGONAL_STEP_COST / FLAT_CELL_SECONDS;

export const ROUTE_SEARCH_MARGIN_CELLS = NEIGHBOURHOOD_CELLS * 2;

const CERTAIN_DEATH_COST = ORTHOGONAL_STEP_COST * ROUTE_SEARCH_MARGIN_CELLS;

const ROUTE_NODE_BUDGET_PER_WORLD_UNIT_SQUARED = 4096;
export const ROUTE_NODE_BUDGET =
  cellsOverArea(ROUTE_NODE_BUDGET_PER_WORLD_UNIT_SQUARED);

export interface RouteBudget {
  remaining: number;
}

export function createRouteBudget(expansions: number = ROUTE_NODE_BUDGET): RouteBudget {
  return { remaining: Math.max(0, Math.floor(expansions)) };
}

export interface RouteCell {
  readonly x: number;
  readonly y: number;
}

export interface RoutePlan {
  readonly cells: ReadonlyArray<RouteCell>;
  readonly cost: number;
}

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

function octileHeuristic(dx: number, dy: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const diagonalSteps = Math.min(ax, ay);
  const straightSteps = Math.max(ax, ay) - diagonalSteps;
  return diagonalSteps * DIAGONAL_STEP_COST + straightSteps * ORTHOGONAL_STEP_COST;
}

interface OpenEntry {
  readonly key: number;
  readonly x: number;
  readonly y: number;
  readonly g: number;
  readonly f: number;
  readonly h: number;
}

function hasHigherPriority(a: OpenEntry, b: OpenEntry): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h;
  return a.key < b.key;
}

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
  if (!Number.isFinite(profile.maxGradientPerCell)) return baseCost;

  const fromHeight = world.heightAt(fromX, fromY);
  const toHeight = world.heightAt(toX, toY);
  const heightDiff = Math.abs(toHeight - fromHeight);
  if (exceedsWalkableGradient(profile, heightDiff)) {
    const rule = profile.climb;
    if (rule === undefined || rule === null) return null;
    return baseCost + climbEdgeCost(rule, fromHeight, toHeight);
  }
  return baseCost + heightDiff * SLOPE_COST_PER_HEIGHT_UNIT;
}

function climbEdgeCost(rule: ClimbRule, fromHeight: number, toHeight: number): number {
  const risk = rule.fallChance * CERTAIN_DEATH_COST;
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

export function findRoute(
  world: TerrainSampler,
  profile: TraversalProfile,
  start: RouteCell,
  goal: RouteCell,
  budget: number | RouteBudget = ROUTE_NODE_BUDGET,
): RoutePlan | null {
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
  try {
    while (open.size > 0) {
      if (expansions >= nodeBudget) return null;
      const current = open.pop();
      if (current === undefined) break;
      expansions++;

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

    return null;
  } finally {
    if (pool !== null) pool.remaining -= expansions;
  }
}

export interface RouteBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface ReachableRegion {
  has(x: number, y: number): boolean;
}

const FLOOD_ORTHOGONAL_OFFSETS: ReadonlyArray<readonly [dx: number, dy: number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

const FLOOD_DIAGONAL_OFFSETS: ReadonlyArray<
  readonly [dx: number, dy: number, flankA: number, flankB: number]
> = [
  [1, -1, 0, 1],
  [1, 1, 1, 2],
  [-1, 1, 2, 3],
  [-1, -1, 3, 0],
];

const EMPTY_REACHABLE_REGION: ReachableRegion = { has: () => false };

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
  const queue = new Int32Array(cells);
  let tail = 0;

  const UNCLASSIFIED = 0;
  const BLOCKED = 1;
  const OCCUPIABLE = 2;
  const ground = new Uint8Array(cells);
  const heights = new Float64Array(cells);
  const limit = profile.maxGradientPerCell;
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

  const orthogonalLegal = [false, false, false, false];

  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    const row = (index / width) | 0;
    const x = minX + (index - row * width);
    const y = minY + row;
    const fromHeight = heights[index];

    for (let i = 0; i < FLOOD_ORTHOGONAL_OFFSETS.length; i++) {
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
