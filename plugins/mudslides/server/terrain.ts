import { SEA_LEVEL, type CellDiff, type FreshwaterMap } from '@terrace/shared';
import { footprintUnlocked } from '../../../server/src/plugins/footprint.ts';
import {
  MUDSLIDE_RIM_DROP,
  MUDSLIDE_SLOPE_SPAN_CELLS,
  MUDSLIDE_TRIGGER_DROP,
  type MudslideStop,
} from '../protocol.ts';

export interface MudslideWorld {
  readonly worldSize: number;
  readonly chunksPerEdge: number;
  readonly freshwater: FreshwaterMap;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
  isChunkUnlocked(cx: number, cy: number): boolean;
  sculpt(x: number, y: number, radius: number, amount: number): CellDiff[];
}

const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export function inBounds(world: MudslideWorld, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < world.worldSize && y < world.worldSize;
}

export function cellKey(x: number, y: number): number {
  return x * 0x10000 + y;
}

export { footprintUnlocked };

export const MUDSLIDE_MEASURE_MARGIN_CELLS = 16;

export interface SculptMeasurement {
  readonly net: number;
  readonly changedCells: number;
  readonly unmeasuredCells: number;
}

const NO_SCULPT: SculptMeasurement = { net: 0, changedCells: 0, unmeasuredCells: 0 };

export function sculptGuarded(
  world: MudslideWorld,
  x: number,
  y: number,
  radius: number,
  amount: number,
): SculptMeasurement {
  if (!footprintUnlocked(world, x, y, radius)) return NO_SCULPT;

  const reach = radius + MUDSLIDE_MEASURE_MARGIN_CELLS;
  const minX = Math.max(0, x - reach);
  const maxX = Math.min(world.worldSize - 1, x + reach);
  const minY = Math.max(0, y - reach);
  const maxY = Math.min(world.worldSize - 1, y + reach);

  const width = maxX - minX + 1;
  const before = new Int32Array(width * (maxY - minY + 1));
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      before[(cy - minY) * width + (cx - minX)] = world.heightAt(cx, cy);
    }
  }

  const diff = world.sculpt(x, y, radius, amount);

  let net = 0;
  let unmeasuredCells = 0;
  for (const cell of diff) {
    if (cell.x < minX || cell.x > maxX || cell.y < minY || cell.y > maxY) {
      unmeasuredCells++;
      continue;
    }
    net += cell.h - before[(cell.y - minY) * width + (cell.x - minX)]!;
  }
  return { net, changedCells: diff.length, unmeasuredCells };
}

export function slopeAt(
  world: MudslideWorld,
  x: number,
  y: number,
): {
  readonly drop: number;
  readonly localDrop: number;
  readonly dx: number;
  readonly dy: number;
} | null {
  if (!inBounds(world, x, y)) return null;
  const here = world.heightAt(x, y);
  if (here <= SEA_LEVEL) return null;

  let bestDrop = 0;
  let bestLocalDrop = 0;
  let bestDx = 0;
  let bestDy = 0;
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx * MUDSLIDE_SLOPE_SPAN_CELLS;
    const ny = y + dy * MUDSLIDE_SLOPE_SPAN_CELLS;
    if (inBounds(world, nx, ny)) {
      const drop = here - world.heightAt(nx, ny);
      if (drop > bestDrop) bestDrop = drop;
    }
    const lx = x + dx;
    const ly = y + dy;
    if (!inBounds(world, lx, ly)) continue;
    const localDrop = here - world.heightAt(lx, ly);
    if (localDrop <= bestLocalDrop) continue;
    bestLocalDrop = localDrop;
    bestDx = dx;
    bestDy = dy;
  }

  if (bestLocalDrop < MUDSLIDE_RIM_DROP) return null;
  if (bestDrop < MUDSLIDE_TRIGGER_DROP) return null;
  return { drop: bestDrop, localDrop: bestLocalDrop, dx: bestDx, dy: bestDy };
}

export function freshwaterAdjacent(world: MudslideWorld, x: number, y: number): boolean {
  const half = Math.max(1, Math.floor(MUDSLIDE_SLOPE_SPAN_CELLS / 2));
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    if (dx !== 0 && dy !== 0) continue;
    for (const reach of [half, MUDSLIDE_SLOPE_SPAN_CELLS]) {
      const nx = x + dx * reach;
      const ny = y + dy * reach;
      if (!inBounds(world, nx, ny)) continue;
      if (world.freshwater.at(nx, ny) !== 'none') return true;
    }
  }
  return world.freshwater.at(x, y) !== 'none';
}

export function nextFlowCell(
  world: MudslideWorld,
  x: number,
  y: number,
  visited: ReadonlySet<number>,
): { readonly x: number; readonly y: number } | MudslideStop {
  if (!inBounds(world, x, y)) return 'locked';
  const here = world.heightAt(x, y);

  let bestX = -1;
  let bestY = -1;
  let bestHeight = here;

  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(world, nx, ny)) continue;
    if (visited.has(cellKey(nx, ny))) continue;
    const height = world.heightAt(nx, ny);
    if (height >= bestHeight) continue;
    bestHeight = height;
    bestX = nx;
    bestY = ny;
  }

  if (bestX < 0) return 'basin';
  if (world.freshwater.at(bestX, bestY) !== 'none') return 'water';
  if (!world.isCellUnlocked(bestX, bestY)) return 'locked';

  return { x: bestX, y: bestY };
}
