import {
  WORLD_UNIT_CELLS,
  bandOf,
  cellsAcross,
  isWater,
} from '@terrace/shared';

export interface ChartSource {
  readonly size: number;
  heightAt(x: number, y: number): number;
  revealedAt(x: number, y: number): boolean;
}

export const CHART_UNKNOWN = 0;
export const CHART_WATER = 1;
export const CHART_LAND = 2;

export const SINGE_RANGE_CELLS = cellsAcross(5);

export const KRAKEN_MIN_DEPTH_CELLS = SINGE_RANGE_CELLS + cellsAcross(3);

export interface ChartBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface ChartWindow {
  readonly x0: number;
  readonly y0: number;
  readonly span: number;
}

export interface ChartModel {
  readonly size: number;
  readonly kind: Uint8Array;
  readonly band: Int16Array;
  readonly bounds: ChartBounds | null;
  readonly singe: Uint8Array;
  readonly krakenCell: number;
  readonly revealedCount: number;
}

export function hash01(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function buildChartModel(source: ChartSource): ChartModel {
  const size = source.size;
  const cellCount = size * size;
  const kind = new Uint8Array(cellCount);
  const band = new Int16Array(cellCount);
  const singe = new Uint8Array(cellCount);
  const dist = new Int32Array(cellCount).fill(-1);

  let revealedCount = 0;
  let bx0 = size;
  let by0 = size;
  let bx1 = -1;
  let by1 = -1;
  const queue = new Int32Array(cellCount);
  let queueHead = 0;
  let queueTail = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (source.revealedAt(x, y)) {
        revealedCount++;
        const h = source.heightAt(x, y);
        kind[i] = isWater(h) ? CHART_WATER : CHART_LAND;
        band[i] = bandOf(h);
        dist[i] = 0;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }

  if (revealedCount > 0 && revealedCount < cellCount) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (dist[i] !== -1) continue;
        const touchesRevealed =
          (x > 0 && dist[i - 1] === 0) ||
          (x < size - 1 && dist[i + 1] === 0) ||
          (y > 0 && dist[i - size] === 0) ||
          (y < size - 1 && dist[i + size] === 0);
        if (touchesRevealed) {
          dist[i] = 1;
          queue[queueTail++] = i;
        }
      }
    }
    while (queueHead < queueTail) {
      const i = queue[queueHead++];
      const d = dist[i] + 1;
      const x = i % size;
      if (x > 0 && dist[i - 1] === -1) {
        dist[i - 1] = d;
        queue[queueTail++] = i - 1;
      }
      if (x < size - 1 && dist[i + 1] === -1) {
        dist[i + 1] = d;
        queue[queueTail++] = i + 1;
      }
      if (i >= size && dist[i - size] === -1) {
        dist[i - size] = d;
        queue[queueTail++] = i - size;
      }
      if (i < cellCount - size && dist[i + size] === -1) {
        dist[i + size] = d;
        queue[queueTail++] = i + size;
      }
    }
  }

  let krakenCell = -1;
  let krakenDepth = 0;
  for (let i = 0; i < cellCount; i++) {
    const d = dist[i];
    if (d <= 0) continue;
    if (d <= SINGE_RANGE_CELLS) singe[i] = d;
    if (d > krakenDepth) {
      krakenDepth = d;
      krakenCell = i;
    }
  }
  if (krakenDepth < KRAKEN_MIN_DEPTH_CELLS) krakenCell = -1;

  return {
    size,
    kind,
    band,
    singe,
    krakenCell,
    revealedCount,
    bounds: bx1 >= 0 ? { x0: bx0, y0: by0, x1: bx1, y1: by1 } : null,
  };
}

export const WINDOW_PAD_CELLS = SINGE_RANGE_CELLS * 4;

export function chartWindow(model: ChartModel): ChartWindow {
  const size = model.size;
  if (model.bounds === null) return { x0: 0, y0: 0, span: size };
  const { x0, y0, x1, y1 } = model.bounds;
  const w = x1 - x0 + 1 + 2 * WINDOW_PAD_CELLS;
  const h = y1 - y0 + 1 + 2 * WINDOW_PAD_CELLS;
  const span = Math.min(size, Math.max(w, h));
  const centreX = (x0 + x1 + 1) / 2;
  const centreY = (y0 + y1 + 1) / 2;
  const clamp = (v: number): number =>
    Math.max(0, Math.min(size - span, Math.round(v - span / 2)));
  return { x0: clamp(centreX), y0: clamp(centreY), span };
}
