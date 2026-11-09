import { BAND_HEIGHT } from './constants.ts';

export interface Heightmap {
  readonly size: number;
  readonly cells: Int16Array;
  readonly columnSpans: Map<number, Int16Array>;
}

export function createHeightmap(size: number): Heightmap {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`world size must be a positive integer, got ${size}`);
  }
  return { size, cells: new Int16Array(size * size), columnSpans: new Map() };
}

export function inBounds(map: Heightmap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.size && y < map.size;
}

export function cellIndex(map: Heightmap, x: number, y: number): number {
  return y * map.size + x;
}

export function cellX(size: number, i: number): number {
  return i % size;
}

export function cellY(size: number, i: number): number {
  return (i - (i % size)) / size;
}

export function bandOf(h: number): number {
  return Math.floor(h / BAND_HEIGHT);
}

export function quantizeToBand(h: number): number {
  return bandOf(h) * BAND_HEIGHT;
}

export function forEachLineCell(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (x: number, y: number) => void,
): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    visit(x, y);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

export function chebyshevDistance(x0: number, y0: number, x1: number, y1: number): number {
  return Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
}

/** Visits the start and every crossed cell; a corner checks both flanks from the preceding cell before its diagonal. */
export function everyCrossedCell(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  visit: (x: number, y: number, previousX: number, previousY: number) => boolean,
): boolean {
  if (![fromX, fromY, toX, toY].every((v) => Number.isSafeInteger(Math.floor(v)))) return false;
  let x = Math.floor(fromX);
  let y = Math.floor(fromY);
  const endX = Math.floor(toX);
  const endY = Math.floor(toY);
  const stepX = Math.sign(toX - fromX);
  const stepY = Math.sign(toY - fromY);
  const width = Math.abs(toX - fromX);
  const height = Math.abs(toY - fromY);
  if (!visit(x, y, x, y)) return false;
  while (x !== endX || y !== endY) {
    // Compare boundary times by cross multiplication, recomputed from the origin to avoid accumulated drift.
    const nextX = x === endX ? Infinity : (stepX > 0 ? x + 1 - fromX : fromX - x) * height;
    const nextY = y === endY ? Infinity : (stepY > 0 ? y + 1 - fromY : fromY - y) * width;
    const crossX = nextX <= nextY;
    const crossY = nextY <= nextX;
    if (crossX && crossY) {
      if (!visit(x + stepX, y, x, y) || !visit(x, y + stepY, x, y)) return false;
    }
    const nx = x + (crossX ? stepX : 0);
    const ny = y + (crossY ? stepY : 0);
    if (!visit(nx, ny, x, y)) return false;
    x = nx;
    y = ny;
  }
  return true;
}
