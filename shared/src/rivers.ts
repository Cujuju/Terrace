import { SEA_LEVEL } from './constants.ts';
import { bandOf, cellIndex, cellX, cellY, heightAt, type Heightmap } from './heightmap.ts';

export const SPRING_MIN_HEIGHT_ABOVE_SEA = 64;

export const MAX_SPRINGS_PER_NETWORK = 24;

const FLOW_DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

function isTraceable(
  map: Heightmap,
  x: number,
  y: number,
  isActive: (x: number, y: number) => boolean,
): boolean {
  return x >= 0 && y >= 0 && x < map.size && y < map.size && isActive(x, y);
}

function isLocalMaximum(
  map: Heightmap,
  x: number,
  y: number,
  isActive: (x: number, y: number) => boolean,
): boolean {
  const h = heightAt(map, x, y);
  if (h < SEA_LEVEL + SPRING_MIN_HEIGHT_ABOVE_SEA) return false;
  for (const [dx, dy] of FLOW_DIRECTIONS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!isTraceable(map, nx, ny, isActive)) continue;
    if (heightAt(map, nx, ny) >= h) return false;
  }
  return true;
}

function rankSprings(map: Heightmap, candidates: Iterable<number>): number[] {
  const ranked: { index: number; height: number }[] = [];
  for (const index of candidates) ranked.push({ index, height: map.cells[index] });
  ranked.sort((a, b) => (b.height !== a.height ? b.height - a.height : a.index - b.index));
  return ranked.slice(0, MAX_SPRINGS_PER_NETWORK).map((c) => c.index);
}

function selectSprings(
  map: Heightmap,
  isActive: (x: number, y: number) => boolean,
): number[] {
  const candidates: number[] = [];
  for (let y = 0; y < map.size; y++) {
    for (let x = 0; x < map.size; x++) {
      if (!isActive(x, y)) continue;
      if (!isLocalMaximum(map, x, y, isActive)) continue;
      candidates.push(cellIndex(map, x, y));
    }
  }
  return rankSprings(map, candidates);
}

const SPRING_CANDIDACY_REACH_CELLS = 1;

export class SpringIndex {
  private readonly map: Heightmap;
  private readonly isActive: (x: number, y: number) => boolean;
  private readonly candidates = new Set<number>();
  private needsFullScan = true;

  constructor(map: Heightmap, isActive: (x: number, y: number) => boolean = ALWAYS_ACTIVE) {
    this.map = map;
    this.isActive = isActive;
  }

  markStale(): void {
    this.needsFullScan = true;
  }

  noteCellChanged(x: number, y: number): void {
    this.noteRegionChanged(x, y, x, y);
  }

  noteCellsChanged(cells: Iterable<{ readonly x: number; readonly y: number }>): void {
    if (this.needsFullScan) return;
    const size = this.map.size;
    const affected = new Set<number>();
    for (const cell of cells) {
      const minX = Math.max(0, cell.x - SPRING_CANDIDACY_REACH_CELLS);
      const maxX = Math.min(size - 1, cell.x + SPRING_CANDIDACY_REACH_CELLS);
      const minY = Math.max(0, cell.y - SPRING_CANDIDACY_REACH_CELLS);
      const maxY = Math.min(size - 1, cell.y + SPRING_CANDIDACY_REACH_CELLS);
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) affected.add(cellIndex(this.map, x, y));
      }
    }
    for (const index of affected) {
      this.reassess(cellX(size, index), cellY(size, index));
    }
  }

  noteRegionChanged(minX: number, minY: number, maxX: number, maxY: number): void {
    if (this.needsFullScan) return;
    const size = this.map.size;
    const x0 = Math.max(0, minX - SPRING_CANDIDACY_REACH_CELLS);
    const x1 = Math.min(size - 1, maxX + SPRING_CANDIDACY_REACH_CELLS);
    const y0 = Math.max(0, minY - SPRING_CANDIDACY_REACH_CELLS);
    const y1 = Math.min(size - 1, maxY + SPRING_CANDIDACY_REACH_CELLS);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.reassess(x, y);
    }
  }

  springs(): readonly number[] {
    if (this.needsFullScan) this.fullScan();
    return rankSprings(this.map, this.candidates);
  }

  private reassess(x: number, y: number): void {
    const index = cellIndex(this.map, x, y);
    if (this.isActive(x, y) && isLocalMaximum(this.map, x, y, this.isActive)) {
      this.candidates.add(index);
    } else {
      this.candidates.delete(index);
    }
  }

  private fullScan(): void {
    this.candidates.clear();
    for (let y = 0; y < this.map.size; y++) {
      for (let x = 0; x < this.map.size; x++) {
        if (!this.isActive(x, y)) continue;
        if (!isLocalMaximum(this.map, x, y, this.isActive)) continue;
        this.candidates.add(cellIndex(this.map, x, y));
      }
    }
    this.needsFullScan = false;
  }
}

export const RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER = 2;

export interface RiverPoint {
  readonly x: number;
  readonly y: number;
  readonly pooled: boolean;
  readonly poolHeight?: number;
}

export interface Waterfall {
  readonly x: number;
  readonly y: number;
  readonly dropBands: number;
}

export interface RiverCourse {
  readonly points: readonly RiverPoint[];
}

export interface River {
  readonly courses: readonly RiverCourse[];
  readonly waterfalls: readonly Waterfall[];
  readonly reachedSea: boolean;
  readonly truncated: boolean;
}

export interface RiverNetwork {
  readonly rivers: readonly River[];
}

export function riverPoints(river: River): RiverPoint[] {
  const points: RiverPoint[] = [];
  for (const course of river.courses) points.push(...course.points);
  return points;
}

export interface RiverNetworkOptions {
  readonly isActive?: (x: number, y: number) => boolean;
}

const ALWAYS_ACTIVE = (): boolean => true;

class RimHeap {
  private readonly items: { index: number; height: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(index: number, height: number): void {
    const items = this.items;
    items.push({ index, height });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.isLess(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { index: number; height: number } | null {
    const items = this.items;
    if (items.length === 0) return null;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let smallest = i;
        if (left < items.length && this.isLess(left, smallest)) smallest = left;
        if (right < items.length && this.isLess(right, smallest)) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private isLess(a: number, b: number): boolean {
    const ia = this.items[a]!;
    const ib = this.items[b]!;
    return ia.height !== ib.height ? ia.height < ib.height : ia.index < ib.index;
  }

  private swap(a: number, b: number): void {
    const items = this.items;
    const tmp = items[a]!;
    items[a] = items[b]!;
    items[b] = tmp;
  }
}

interface BasinResult {
  readonly cells: number[];
  readonly poolHeight: number;
  readonly spillIndices: number[];
  readonly budgetExhausted: boolean;
  readonly spent: number;
}

function fillBasin(
  map: Heightmap,
  minIndex: number,
  isActive: (x: number, y: number) => boolean,
  budget: number,
): BasinResult {
  const filled = new Set<number>([minIndex]);
  const cells: number[] = [];
  let level = map.cells[minIndex]!;
  let spent = 0;

  const heap = new RimHeap();
  const pushNeighbors = (index: number): void => {
    const x = cellX(map.size, index);
    const y = cellY(map.size, index);
    for (const [dx, dy] of FLOW_DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!isTraceable(map, nx, ny, isActive)) continue;
      const ni = cellIndex(map, nx, ny);
      if (filled.has(ni)) continue;
      heap.push(ni, map.cells[ni]!);
    }
  };
  pushNeighbors(minIndex);

  while (spent < budget) {
    const popped = heap.pop();
    if (popped === null) {
      return { cells, poolHeight: level, spillIndices: [], budgetExhausted: false, spent };
    }
    if (filled.has(popped.index)) continue;
    if (popped.height < level) {
      const spillIndices = [popped.index];
      const seen = new Set<number>([popped.index]);
      for (;;) {
        const next = heap.pop();
        if (next === null || next.height !== popped.height) break;
        if (filled.has(next.index) || seen.has(next.index)) continue;
        seen.add(next.index);
        spillIndices.push(next.index);
      }
      return { cells, poolHeight: level, spillIndices, budgetExhausted: false, spent };
    }
    filled.add(popped.index);
    cells.push(popped.index);
    spent++;
    if (popped.height > level) level = popped.height;
    pushNeighbors(popped.index);
  }
  return { cells, poolHeight: level, spillIndices: [], budgetExhausted: true, spent };
}

interface CourseSeed {
  readonly index: number;
  readonly junction: RiverPoint | null;
}

interface TracedRiver {
  readonly river: River;
  readonly claimed: ReadonlySet<number>;
}

function traceRiver(
  map: Heightmap,
  springIndex: number,
  isActive: (x: number, y: number) => boolean,
): TracedRiver {
  const budget = map.size * RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER;
  const courses: RiverCourse[] = [];
  const waterfallDrops = new Map<number, number>();

  const pointAt = (index: number, pooled: boolean, poolHeight?: number): RiverPoint => ({
    x: cellX(map.size, index),
    y: cellY(map.size, index),
    pooled,
    ...(poolHeight !== undefined ? { poolHeight } : {}),
  });
  const maybeWaterfall = (fromHeight: number, toIndex: number): void => {
    const toHeight = map.cells[toIndex]!;
    const drop = bandOf(fromHeight) - bandOf(toHeight);
    if (drop <= 0) return;
    const existing = waterfallDrops.get(toIndex);
    if (existing === undefined || drop > existing) waterfallDrops.set(toIndex, drop);
  };

  const visited = new Set<number>([springIndex]);
  const queue: CourseSeed[] = [{ index: springIndex, junction: null }];
  let spent = 0;
  let reachedSea = false;
  let truncated = false;

  const claimBranches = (
    candidates: readonly number[],
    junction: RiverPoint | null,
    fromHeight: number,
  ): number | null => {
    let continueWith: number | null = null;
    for (const candidate of candidates) {
      maybeWaterfall(fromHeight, candidate);
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      if (continueWith === null) continueWith = candidate;
      else queue.push({ index: candidate, junction });
    }
    return continueWith;
  };

  while (queue.length > 0) {
    const seed = queue.shift()!;
    const points: RiverPoint[] = [];
    if (seed.junction !== null) points.push(seed.junction);
    let current = seed.index;

    for (;;) {
      const h = map.cells[current]!;
      if (h <= SEA_LEVEL) {
        points.push(pointAt(current, false));
        reachedSea = true;
        break;
      }
      if (spent >= budget) {
        points.push(pointAt(current, false));
        truncated = true;
        break;
      }

      const x = cellX(map.size, current);
      const y = cellY(map.size, current);
      const downhill: number[] = [];
      let lowest = h;
      for (const [dx, dy] of FLOW_DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!isTraceable(map, nx, ny, isActive)) continue;
        const ni = cellIndex(map, nx, ny);
        const nh = map.cells[ni]!;
        if (nh < lowest) {
          lowest = nh;
          downhill.length = 0;
          downhill.push(ni);
        } else if (nh === lowest && lowest < h) {
          downhill.push(ni);
        }
      }

      if (downhill.length > 0) {
        const point = pointAt(current, false);
        points.push(point);
        spent++;
        const next = claimBranches(downhill, point, h);
        if (next === null) {
          points.push(pointAt(downhill[0]!, false));
          break;
        }
        current = next;
        continue;
      }

      const basin = fillBasin(map, current, isActive, budget - spent - 1);
      spent += basin.spent + 1;
      points.push(pointAt(current, true, basin.poolHeight));
      for (const cell of basin.cells) {
        visited.add(cell);
        points.push(pointAt(cell, true, basin.poolHeight));
      }
      if (basin.spillIndices.length === 0) {
        truncated = truncated || basin.budgetExhausted;
        break;
      }
      const next = claimBranches(basin.spillIndices, null, basin.poolHeight);
      if (next === null) break;
      current = next;
    }

    courses.push({ points });
  }

  const waterfalls: Waterfall[] = [];
  for (const [index, dropBands] of waterfallDrops) {
    waterfalls.push({ x: cellX(map.size, index), y: cellY(map.size, index), dropBands });
  }
  return { river: { courses, waterfalls, reachedSea, truncated }, claimed: visited };
}

export function computeRiverNetwork(map: Heightmap, options?: RiverNetworkOptions): RiverNetwork {
  const isActive = options?.isActive ?? ALWAYS_ACTIVE;
  return computeRiverNetworkFromSprings(map, selectSprings(map, isActive), isActive);
}

export function computeRiverNetworkFromSprings(
  map: Heightmap,
  springs: readonly number[],
  isActive: (x: number, y: number) => boolean = ALWAYS_ACTIVE,
): RiverNetwork {
  const rivers = springs.map((springIndex) => traceRiver(map, springIndex, isActive).river);
  return { rivers };
}

export class RiverNetworkIndex {
  private readonly map: Heightmap;
  private readonly isActive: (x: number, y: number) => boolean;
  private readonly traced = new Map<number, CachedRiver>();
  private cachedNetwork: RiverNetwork | null = null;
  private cachedSprings: readonly number[] = [];

  constructor(map: Heightmap, isActive: (x: number, y: number) => boolean = ALWAYS_ACTIVE) {
    this.map = map;
    this.isActive = isActive;
  }

  markStale(): void {
    this.traced.clear();
    this.cachedNetwork = null;
  }

  noteCellsChanged(cells: Iterable<{ readonly x: number; readonly y: number }>): void {
    for (const cell of cells) {
      if (this.traced.size === 0) return;
      this.dropDependents(cell.x, cell.y);
    }
  }

  noteRegionChanged(minX: number, minY: number, maxX: number, maxY: number): void {
    const x0 = minX - RIVER_TRACE_READ_REACH_CELLS;
    const x1 = maxX + RIVER_TRACE_READ_REACH_CELLS;
    const y0 = minY - RIVER_TRACE_READ_REACH_CELLS;
    const y1 = maxY + RIVER_TRACE_READ_REACH_CELLS;
    for (const [spring, cached] of this.traced) {
      if (cached.maxX < x0 || cached.minX > x1 || cached.maxY < y0 || cached.minY > y1) continue;
      let hit = false;
      for (const index of cached.traced.claimed) {
        const x = cellX(this.map.size, index);
        if (x < x0 || x > x1) continue;
        const y = cellY(this.map.size, index);
        if (y < y0 || y > y1) continue;
        hit = true;
        break;
      }
      if (!hit) continue;
      this.traced.delete(spring);
      this.cachedNetwork = null;
    }
  }

  networkFrom(springs: readonly number[]): RiverNetwork {
    let retraced = 0;
    const rivers: River[] = [];
    for (const spring of springs) {
      let cached = this.traced.get(spring);
      if (cached === undefined) {
        cached = cacheEntryFor(this.map, traceRiver(this.map, spring, this.isActive));
        this.traced.set(spring, cached);
        retraced++;
      }
      rivers.push(cached.traced.river);
    }
    if (this.traced.size > springs.length) {
      const live = new Set(springs);
      for (const spring of this.traced.keys()) {
        if (!live.has(spring)) this.traced.delete(spring);
      }
    }
    if (
      this.cachedNetwork !== null &&
      retraced === 0 &&
      sameSpringOrder(this.cachedSprings, springs)
    ) {
      return this.cachedNetwork;
    }
    this.cachedNetwork = { rivers };
    this.cachedSprings = springs.slice();
    return this.cachedNetwork;
  }

  private dropDependents(x: number, y: number): void {
    for (const [spring, cached] of this.traced) {
      if (
        x < cached.minX - RIVER_TRACE_READ_REACH_CELLS ||
        x > cached.maxX + RIVER_TRACE_READ_REACH_CELLS ||
        y < cached.minY - RIVER_TRACE_READ_REACH_CELLS ||
        y > cached.maxY + RIVER_TRACE_READ_REACH_CELLS
      ) {
        continue;
      }
      if (!claimsWithinReach(this.map, cached.traced, x, y)) continue;
      this.traced.delete(spring);
      this.cachedNetwork = null;
    }
  }
}

interface CachedRiver {
  readonly traced: TracedRiver;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function cacheEntryFor(map: Heightmap, traced: TracedRiver): CachedRiver {
  let minX = map.size, minY = map.size, maxX = -1, maxY = -1;
  for (const index of traced.claimed) {
    const x = cellX(map.size, index);
    const y = cellY(map.size, index);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { traced, minX, minY, maxX, maxY };
}

const RIVER_TRACE_READ_REACH_CELLS = 1;

function claimsWithinReach(map: Heightmap, traced: TracedRiver, x: number, y: number): boolean {
  const index = cellIndex(map, x, y);
  if (traced.claimed.has(index)) return true;
  for (const [dx, dy] of FLOW_DIRECTIONS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
    if (traced.claimed.has(cellIndex(map, nx, ny))) return true;
  }
  return false;
}

function sameSpringOrder(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
