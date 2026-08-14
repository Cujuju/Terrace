import { describe, expect, it } from 'vitest';
import { pointerToNdc, worldPointToCell } from '../src/terrain/picking.ts';

const RECT = { left: 100, top: 50, width: 800, height: 400 };

/** toEqual distinguishes -0 from 0, which is noise here. */
function expectNdc(actual: { x: number; y: number } | null, x: number, y: number): void {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(x);
  expect(actual!.y).toBeCloseTo(y);
}

describe('pointerToNdc', () => {
  it('maps the centre of the viewport to the NDC origin', () => {
    expectNdc(pointerToNdc(100 + 400, 50 + 200, RECT), 0, 0);
  });

  it('maps the corners, flipping Y', () => {
    // Top-left of the canvas is (-1, +1) in NDC.
    expectNdc(pointerToNdc(100, 50, RECT), -1, 1);
    // Bottom-right is (+1, -1).
    expectNdc(pointerToNdc(900, 450, RECT), 1, -1);
  });

  it('accounts for the canvas offset within the page', () => {
    // Same client point, different rect origin, different result.
    const shifted = { ...RECT, left: 0, top: 0 };
    expectNdc(pointerToNdc(400, 200, shifted), 0, 0);
    expect(pointerToNdc(400, 200, RECT)).not.toEqual({ x: 0, y: 0 });
  });

  it('reports null for an unlaid-out canvas instead of producing NaN', () => {
    expect(pointerToNdc(10, 10, { left: 0, top: 0, width: 0, height: 400 })).toBeNull();
    expect(pointerToNdc(10, 10, { left: 0, top: 0, width: 800, height: 0 })).toBeNull();
  });
});

describe('worldPointToCell', () => {
  const WORLD = 128;

  it('rounds to the nearest cell, because a vertex is a cell', () => {
    expect(worldPointToCell(10.4, 20.4, WORLD)).toEqual({ x: 10, y: 20 });
    expect(worldPointToCell(10.6, 20.6, WORLD)).toEqual({ x: 11, y: 21 });
  });

  it('maps world X to cell x and world Z to cell y', () => {
    expect(worldPointToCell(3, 7, WORLD)).toEqual({ x: 3, y: 7 });
  });

  it('accepts the half-cell margin at each edge and clamps into the world', () => {
    // Also pins the -0 normalisation: rounding -0.4 gives -0, and a cell index
    // of -0 must never escape (toEqual would distinguish it from 0).
    expect(worldPointToCell(-0.4, -0.4, WORLD)).toEqual({ x: 0, y: 0 });

    expect(worldPointToCell(WORLD - 1 + 0.4, WORLD - 1 + 0.4, WORLD)).toEqual({
      x: WORLD - 1,
      y: WORLD - 1,
    });
  });

  it('rejects points beyond the terrain extent', () => {
    expect(worldPointToCell(-1, 0, WORLD)).toBeNull();
    expect(worldPointToCell(0, -1, WORLD)).toBeNull();
    expect(worldPointToCell(WORLD, 0, WORLD)).toBeNull();
    expect(worldPointToCell(0, WORLD, WORLD)).toBeNull();
  });

  it('rejects non-finite coordinates rather than emitting NaN cells', () => {
    expect(worldPointToCell(Number.NaN, 0, WORLD)).toBeNull();
    expect(worldPointToCell(0, Number.POSITIVE_INFINITY, WORLD)).toBeNull();
  });

  it('never returns a cell outside the map', () => {
    for (let i = 0; i < WORLD * 2; i++) {
      const p = i / 2;
      const cell = worldPointToCell(p, p, WORLD);
      if (cell === null) continue;
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x).toBeLessThan(WORLD);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeLessThan(WORLD);
    }
  });
});
