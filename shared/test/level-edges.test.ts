import { describe, expect, it } from 'vitest';
import {
  EDGE_UNITS_PER_CELL,
  bandFloorHeight,
  bandLevelHeight,
  createHeightmap,
  drawnBandOfSample,
  encodeLevelEdges,
} from '../src/index.ts';

const SIZE = 48;
const LEVEL_ONE = 256;
/** One edge unit: the encoding's resolution. */
const TOLERANCE_CELLS = 1 / EDGE_UNITS_PER_CELL;

/** Planes no steeper than half a band per cell: the narrowest terrace the encoding draws exactly. */
const PLANES: readonly (readonly [number, number])[] = [
  [0.25, 0],
  [0.2, 0.15],
  [0.35, 0.35],
  [0.1, 0.45],
];

function plane(slopeX: number, slopeY: number): { map: ReturnType<typeof createHeightmap>; level: Int32Array } {
  const map = createHeightmap(SIZE);
  const level = new Int32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = Math.floor((slopeX * x + slopeY * y + 3.3) * LEVEL_ONE);
      level[y * SIZE + x] = v;
      map.cells[y * SIZE + x] = bandLevelHeight(Math.floor(v / LEVEL_ONE));
    }
  }
  return { map, level };
}

describe('encodeLevelEdges', () => {
  it('moves heights only within their bands', () => {
    for (const [sx, sy] of PLANES) {
      const { map, level } = plane(sx, sy);
      const before = Int16Array.from(map.cells);
      encodeLevelEdges(map, level, LEVEL_ONE);
      for (let i = 0; i < before.length; i++) {
        expect(drawnBandOfSample(map.cells[i]!)).toBe(drawnBandOfSample(before[i]!));
      }
    }
  });

  it('draws each band edge within one edge unit of where the field crosses it', () => {
    for (const [sx, sy] of PLANES) {
      const { map, level } = plane(sx, sy);
      encodeLevelEdges(map, level, LEVEL_ONE);
      const gradient = Math.hypot(sx, sy);
      let worst = 0;
      for (const [dx, dy, along] of [[1, 0, sx], [0, 1, sy]] as const) {
        for (let y = 0; y + dy < SIZE; y++) {
          for (let x = 0; x + dx < SIZE; x++) {
            const a = map.cells[y * SIZE + x]!;
            const b = map.cells[(y + dy) * SIZE + x + dx]!;
            if (drawnBandOfSample(a) === drawnBandOfSample(b)) continue;
            const band = Math.max(drawnBandOfSample(a), drawnBandOfSample(b));
            const drawn = (bandFloorHeight(band) - a) / (b - a);
            const va = level[y * SIZE + x]!;
            const vb = level[(y + dy) * SIZE + x + dx]!;
            const exact = (band * LEVEL_ONE - va) / (vb - va);
            // Along-axis error, projected onto the gradient: distance from the true contour.
            worst = Math.max(worst, (Math.abs(drawn - exact) * Math.abs(along)) / gradient);
          }
        }
      }
      expect(worst).toBeLessThanOrEqual(TOLERANCE_CELLS);
    }
  });
});
