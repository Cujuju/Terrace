import { describe, expect, it } from 'vitest';
import {
  forEachFootprintOffset,
} from '../src/index.ts';

describe('forEachFootprintOffset — the tight-disc footprint (2026-08-19)', () => {
  function offsets(radius: number): string[] {
    const out: string[] = [];
    forEachFootprintOffset(radius, (dx, dy) => out.push(`${dx},${dy}`));
    return out;
  }

  it('radius 1 is the centre cell alone', () => {
    expect(offsets(1)).toEqual(['0,0']);
  });

  it('radius 2 is the 5-cell plus — the old 3×3 minus its corners', () => {
    expect(new Set(offsets(2))).toEqual(new Set(['0,0', '1,0', '-1,0', '0,1', '0,-1']));
  });

  it('radius 3 is the 21-cell disc — 5×5 minus its 4 corners', () => {
    const cells = new Set(offsets(3));
    expect(cells.size).toBe(21);
    for (const corner of ['2,2', '2,-2', '-2,2', '-2,-2']) expect(cells.has(corner)).toBe(false);
    for (const kept of ['2,1', '1,2', '2,0', '0,2', '1,1']) expect(cells.has(kept)).toBe(true);
  });

  it('radius 4 is the 37-cell rounded octagon', () => {
    const cells = new Set(offsets(4));
    expect(cells.size).toBe(37);
    for (const gone of ['3,2', '2,3', '3,3', '-3,2', '2,-3', '-3,-3']) {
      expect(cells.has(gone)).toBe(false);
    }
    for (const kept of ['3,0', '0,3', '3,1', '1,3', '2,2', '-3,-1']) {
      expect(cells.has(kept)).toBe(true);
    }
  });

  it('scan order is row-major ascending, unchanged by the disc rule', () => {
    const seen = offsets(3);
    const sorted = [...seen].sort((a, b) => {
      const [ax, ay] = a.split(',').map(Number);
      const [bx, by] = b.split(',').map(Number);
      return ay - by || ax - bx;
    });
    expect(seen).toEqual(sorted);
  });
});
