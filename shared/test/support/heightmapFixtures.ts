import { expect } from 'vitest';
import {
  bandOf,
  BAND_HEIGHT,
  cellIndex,
  createHeightmap,
  drawnBandOfSample,
  heightAt,
  MAX_HEIGHT,
  MAX_STEP,
  RELAX_SLACK,
  type Heightmap,
} from '../../src/index.ts';

export function footprintOf(size: number, cx: number, cy: number, radius: number): Set<number> {
  const cells = new Set<number>();
  for (let dy = -(radius - 1); dy <= radius - 1; dy++) {
    for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
      if (radius > 1 && dx * dx + dy * dy >= radius * (radius - 1)) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      cells.add(y * size + x);
    }
  }
  return cells;
}

export function texturedMap(size: number): Heightmap {
  const map = createHeightmap(size);
  for (let i = 0; i < map.cells.length; i++) {
    map.cells[i] = ((i * 7) % 23) - 11;
  }
  return map;
}

export const CEILING_BANDS = MAX_HEIGHT / BAND_HEIGHT;

export function expectGradientLimitHolds(map: Heightmap): void {
  const limit = MAX_STEP + RELAX_SLACK;
  const { size, cells } = map;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (x < size - 1) {
        expect(Math.abs(cells[i] - cells[i + 1])).toBeLessThanOrEqual(limit);
      }
      if (y < size - 1) {
        expect(Math.abs(cells[i] - cells[i + size])).toBeLessThanOrEqual(limit);
      }
    }
  }
}

export const LEVEL_FILL = { tool: 'stamp', profile: 'hard' } as const;

export function paintFootprint3x3(
  map: Heightmap,
  cx: number,
  cy: number,
  bands: readonly number[],
): void {
  for (let k = 0; k < bands.length; k++) {
    const dx = (k % 3) - 1;
    const dy = Math.floor(k / 3) - 1;
    map.cells[cellIndex(map, cx + dx, cy + dy)] = bands[k] * BAND_HEIGHT;
  }
}

export function paintFootprintPlus(
  map: Heightmap,
  cx: number,
  cy: number,
  bands: { n: number; w: number; c: number; e: number; s: number },
): void {
  map.cells[cellIndex(map, cx, cy - 1)] = bands.n * BAND_HEIGHT;
  map.cells[cellIndex(map, cx - 1, cy)] = bands.w * BAND_HEIGHT;
  map.cells[cellIndex(map, cx, cy)] = bands.c * BAND_HEIGHT;
  map.cells[cellIndex(map, cx + 1, cy)] = bands.e * BAND_HEIGHT;
  map.cells[cellIndex(map, cx, cy + 1)] = bands.s * BAND_HEIGHT;
}

export function readFootprintBands3x3(map: Heightmap, cx: number, cy: number): number[] {
  const bands: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) bands.push(bandOf(heightAt(map, cx + dx, cy + dy)));
  }
  return bands;
}

export function readDrawnFootprint3x3(map: Heightmap, cx: number, cy: number): number[] {
  const bands: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) bands.push(drawnBandOfSample(heightAt(map, cx + dx, cy + dy)));
  }
  return bands;
}
