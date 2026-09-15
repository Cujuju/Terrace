import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applySculpt,
  BAND_HEIGHT,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  forEachFootprintOffset,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  sculptDisplacementUnits,
  smooth,
} from '../src/index.ts';

function observedDisplacement(
  radius: number,
  profile: 'soft' | 'hard',
  amount: number,
): number {
  const size = 64;
  const map = createHeightmap(size);
  const start = 128;
  map.cells.fill(start);

  const options = { tool: 'stamp', profile, anchor: 'clicked' } as const;
  applySculpt(map, 32, 32, radius, amount, options);

  let total = 0;
  forEachFootprintOffset(radius, (dx, dy) => {
    total += Math.abs(map.cells[(32 + dy) * size + (32 + dx)]! - start);
  });
  return total;
}

describe('sculptDisplacementUnits', () => {
  it('equals the volume applyBrush actually moves, for every radius × profile', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius, 'stamp', profile)).toBe(
          observedDisplacement(radius, profile, DEFAULT_SCULPT_AMOUNT),
        );
      }
    }
  });

  it('prices a lower exactly like the raise that undoes it', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius, 'stamp', profile)).toBe(
          observedDisplacement(radius, profile, -DEFAULT_SCULPT_AMOUNT),
        );
      }
    }
  });

  it('matches the published table of displacement volumes', () => {
    expect(sculptDisplacementUnits(1, 'stamp')).toBe(16);
    expect(sculptDisplacementUnits(2, 'stamp')).toBe(80);
    expect(sculptDisplacementUnits(3, 'stamp')).toBe(336);
    expect(sculptDisplacementUnits(4, 'stamp')).toBe(592);
  });

  it('is one band-cell at the point brush', () => {
    expect(sculptDisplacementUnits(MIN_BRUSH_RADIUS, 'stamp')).toBe(BAND_HEIGHT);
  });

  it('grows with radius', () => {
    for (let radius = MIN_BRUSH_RADIUS; radius < MAX_BRUSH_RADIUS; radius++) {
      expect(sculptDisplacementUnits(radius + 1, 'stamp')).toBeGreaterThan(
        sculptDisplacementUnits(radius, 'stamp'),
      );
    }
  });

  it('is a pure integer function of radius and tool', () => {
    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      const units = sculptDisplacementUnits(radius, 'stamp');
      expect(Number.isInteger(units)).toBe(true);
      expect(sculptDisplacementUnits(radius, 'stamp')).toBe(units);
    }
  });

  it('rejects a radius the brush itself would reject', () => {
    for (const bad of [0, MAX_BRUSH_RADIUS + 1, 1.5, Number.NaN]) {
      expect(() => sculptDisplacementUnits(bad, 'stamp')).toThrow(RangeError);
    }
  });

  it('ignores the relaxation spill, which stays deliberately free', () => {
    const size = 64;
    const stampedCells = new Set<number>();
    const stamped = createHeightmap(size);
    stamped.cells.fill(8 * BAND_HEIGHT);
    applyBrush(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, stampedCells, 'hard');
    applyBrush(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, stampedCells, 'hard');

    const slumped = createHeightmap(size);
    slumped.cells.fill(8 * BAND_HEIGHT);
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    const slumpedDiff = applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, {
      tool: 'smooth',
      profile: 'hard',
    });

    expect(slumpedDiff.length).toBeGreaterThan(stampedCells.size);
    expect(sculptDisplacementUnits(4, 'stamp')).toBe(592);
  });

  it('prices a LEVEL FILL at the flat-delta volume, deliberately', () => {
    const map = createHeightmap(32);
    map.cells.fill(BAND_HEIGHT);
    map.cells[cellIndex(map, 16, 16)] = 0;

    const diff = applySculpt(map, 16, 16, MAX_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'stamp',
      profile: 'hard',
    });

    expect(diff).toHaveLength(1);
    expect(sculptDisplacementUnits(MAX_BRUSH_RADIUS, 'stamp')).toBe(749 * BAND_HEIGHT);
  });
});
