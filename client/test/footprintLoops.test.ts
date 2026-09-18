import { describe, expect, it } from 'vitest';
import { footprintFromMark } from '../src/render/brush/brushGeometry.ts';
import { markFromOffsets, markOutline, markOutlineLoops } from '../src/render/brush/footprintMark.ts';

/** Two cells with a gap between them: one mark, two separate loops. */
const SPLIT: readonly (readonly [number, number])[] = [
  [-2, 0],
  [2, 0],
];

const SOLID: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

const RADIUS = 3;

describe('a mark that marches to more than one loop', () => {
  it('is what markOutline refuses, and what markOutlineLoops returns', () => {
    const mark = markFromOffsets(SPLIT);
    expect(() => markOutline(RADIUS, mark)).toThrow(/expected 1/);
    expect(markOutlineLoops(mark)).toHaveLength(2);
  });

  it('returns its loops largest first, so the ring always carries the dominant one', () => {
    const mark = markFromOffsets([[-3, 0], [3, 0], [3, 1], [4, 0], [4, 1]]);
    const loops = markOutlineLoops(mark);
    expect(loops.length).toBeGreaterThan(1);
    for (let k = 1; k < loops.length; k++) {
      expect(loops[k - 1]!.length).toBeGreaterThanOrEqual(loops[k]!.length);
    }
  });

  it('builds a footprint rather than throwing: the ring leads, the rest are segment pairs', () => {
    const footprint = footprintFromMark(RADIUS, markFromOffsets(SPLIT));
    expect(footprint.ringCount).toBeGreaterThan(0);
    // One extra loop, drawn as its own closed run of pairs.
    expect(footprint.extraCount).toBeGreaterThan(0);
  });

  it('leaves a connected mark with nothing extra to draw', () => {
    const footprint = footprintFromMark(RADIUS, markFromOffsets(SOLID));
    expect(footprint.ringCount).toBeGreaterThan(0);
    expect(footprint.extraCount).toBe(0);
  });

  it('keeps every extra vertex inside the mark it came from', () => {
    const mark = markFromOffsets(SPLIT);
    const footprint = footprintFromMark(RADIUS, mark);
    for (let i = 0; i < footprint.extraCount * 2; i++) {
      const x = footprint.extraPoints[i * 2]!;
      const z = footprint.extraPoints[i * 2 + 1]!;
      // Every point sits on a cell boundary of some marked cell.
      const inside = mark.cells.some(
        ([dx, dy]) =>
          x >= dx - 0.5 - 1e-6 && x <= dx + 0.5 + 1e-6 && z >= dy - 0.5 - 1e-6 && z <= dy + 0.5 + 1e-6,
      );
      expect([x, z, inside]).toEqual([x, z, true]);
    }
  });
});
