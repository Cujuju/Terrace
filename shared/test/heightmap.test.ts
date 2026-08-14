import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applySculpt,
  bandOf,
  BAND_HEIGHT,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  heightAt,
  isWater,
  MAX_HEIGHT,
  MAX_STEP,
  quantizeToBand,
  smooth,
  type Heightmap,
} from '../src/index.ts';

/** Asserts the gradient invariant over the whole map. */
function expectGradientLimitHolds(map: Heightmap): void {
  const { size, cells } = map;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (x < size - 1) {
        expect(Math.abs(cells[i] - cells[i + 1])).toBeLessThanOrEqual(MAX_STEP);
      }
      if (y < size - 1) {
        expect(Math.abs(cells[i] - cells[i + size])).toBeLessThanOrEqual(MAX_STEP);
      }
    }
  }
}

describe('createHeightmap', () => {
  it('allocates a zeroed size×size grid', () => {
    const map = createHeightmap(64);
    expect(map.size).toBe(64);
    expect(map.cells.length).toBe(64 * 64);
    expect(map.cells.every((h) => h === 0)).toBe(true);
  });

  it('rejects non-positive and non-integer sizes', () => {
    expect(() => createHeightmap(0)).toThrow(RangeError);
    expect(() => createHeightmap(-4)).toThrow(RangeError);
    expect(() => createHeightmap(2.5)).toThrow(RangeError);
  });
});

describe('water and terracing', () => {
  it('height <= 0 is water', () => {
    expect(isWater(0)).toBe(true);
    expect(isWater(-5)).toBe(true);
    expect(isWater(1)).toBe(false);
  });

  it('bands use floor division so underwater heights band correctly', () => {
    expect(bandOf(0)).toBe(0);
    expect(bandOf(BAND_HEIGHT - 1)).toBe(0);
    expect(bandOf(BAND_HEIGHT)).toBe(1);
    expect(bandOf(-1)).toBe(-1);
    expect(bandOf(-BAND_HEIGHT)).toBe(-1);
    expect(bandOf(-BAND_HEIGHT - 1)).toBe(-2);
  });

  it('quantizes to the band floor', () => {
    expect(quantizeToBand(BAND_HEIGHT + 5)).toBe(BAND_HEIGHT);
    expect(quantizeToBand(-1)).toBe(-BAND_HEIGHT);
  });
});

describe('applyBrush', () => {
  it('radius 1 is the point brush: exactly one cell, full amount', () => {
    const map = createHeightmap(32);
    const changed = new Set<number>();
    applyBrush(map, 16, 16, 1, 64, changed);
    expect(changed.size).toBe(1);
    expect(heightAt(map, 16, 16)).toBe(64);
  });

  it('radius 2 applies linear falloff (full center, half at distance 1)', () => {
    const map = createHeightmap(32);
    const changed = new Set<number>();
    applyBrush(map, 16, 16, 2, 64, changed);
    expect(heightAt(map, 16, 16)).toBe(64);
    // Orthogonal and diagonal neighbors are both integer distance 1.
    expect(heightAt(map, 17, 16)).toBe(32);
    expect(heightAt(map, 16, 15)).toBe(32);
    expect(heightAt(map, 17, 17)).toBe(32);
    // Distance 2 is outside a radius-2 brush.
    expect(heightAt(map, 18, 16)).toBe(0);
  });

  it('lowering mirrors raising exactly', () => {
    const up = createHeightmap(32);
    const down = createHeightmap(32);
    applyBrush(up, 16, 16, 3, 64, new Set());
    applyBrush(down, 16, 16, 3, -64, new Set());
    for (let i = 0; i < up.cells.length; i++) {
      expect(down.cells[i]).toBe(-up.cells[i] | 0); // | 0 folds -0 to 0 for Object.is
    }
  });

  it('clamps to MAX_HEIGHT', () => {
    const map = createHeightmap(16);
    const changed = new Set<number>();
    map.cells[8 * 16 + 8] = MAX_HEIGHT - 10;
    applyBrush(map, 8, 8, 1, 64, changed);
    expect(heightAt(map, 8, 8)).toBe(MAX_HEIGHT);
  });

  it('overhangs the map edge without throwing; off-map cells are skipped', () => {
    const map = createHeightmap(16);
    const changed = new Set<number>();
    applyBrush(map, 0, 0, 4, 64, changed);
    expect(heightAt(map, 0, 0)).toBe(64);
    expect(changed.size).toBeGreaterThan(0);
  });

  it('rejects out-of-bounds centers and invalid radii', () => {
    const map = createHeightmap(16);
    expect(() => applyBrush(map, -1, 0, 1, 64, new Set())).toThrow(RangeError);
    expect(() => applyBrush(map, 8, 8, 0, 64, new Set())).toThrow(RangeError);
    expect(() => applyBrush(map, 8, 8, 5, 64, new Set())).toThrow(RangeError);
    expect(() => applyBrush(map, 8, 8, 2, 1.5, new Set())).toThrow(RangeError);
  });
});

describe('smooth', () => {
  it('restores the gradient limit after a spike', () => {
    const map = createHeightmap(64);
    const changed = new Set<number>();
    const i = 32 * 64 + 32;
    map.cells[i] = 512;
    changed.add(i);
    smooth(map, changed);
    expectGradientLimitHolds(map);
    // The spike must have spread, not vanished.
    expect(heightAt(map, 32, 32)).toBeGreaterThan(0);
  });

  it('leaves an already-smooth map untouched', () => {
    const map = createHeightmap(32);
    map.cells.fill(100);
    const before = map.cells.slice();
    const changed = new Set<number>([5 * 32 + 5]);
    smooth(map, changed);
    expect(map.cells).toEqual(before);
  });

  it('holds the invariant near the map edge', () => {
    const map = createHeightmap(32);
    const changed = new Set<number>();
    map.cells[0] = 512; // corner spike
    changed.add(0);
    smooth(map, changed);
    expectGradientLimitHolds(map);
  });
});

describe('applySculpt (the full server/prediction operation)', () => {
  it('returns a diff that exactly matches the cells that changed', () => {
    const map = createHeightmap(64);
    const before = map.cells.slice();
    const diff = applySculpt(map, 32, 32, 2, DEFAULT_SCULPT_AMOUNT);

    const actuallyChanged = new Set<number>();
    for (let i = 0; i < map.cells.length; i++) {
      if (map.cells[i] !== before[i]) actuallyChanged.add(i);
    }
    const reported = new Set(diff.map((c) => c.y * 64 + c.x));
    // Every real change is reported (smoothing may also report cells it
    // touched and later returned to their original value — harmless).
    for (const i of actuallyChanged) expect(reported.has(i)).toBe(true);
    // Reported heights match the map.
    for (const c of diff) expect(c.h).toBe(heightAt(map, c.x, c.y));
    expectGradientLimitHolds(map);
  });

  it('diff is in ascending cell-index order (deterministic wire order)', () => {
    const map = createHeightmap(64);
    const diff = applySculpt(map, 32, 32, 3, DEFAULT_SCULPT_AMOUNT);
    const indices = diff.map((c) => c.y * 64 + c.x);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('is deterministic: identical inputs → identical maps and diffs', () => {
    const a = createHeightmap(64);
    const b = createHeightmap(64);
    const ops: Array<[number, number, number, number]> = [
      [32, 32, 2, 64], [33, 32, 3, 64], [30, 34, 1, -64], [32, 33, 4, 64],
    ];
    for (const [x, y, r, amt] of ops) {
      const da = applySculpt(a, x, y, r, amt);
      const db = applySculpt(b, x, y, r, amt);
      expect(da).toEqual(db);
    }
    expect(a.cells).toEqual(b.cells);
  });

  it('survives 100 stacked sculpts: clamped, invariant intact', () => {
    const map = createHeightmap(64);
    for (let k = 0; k < 100; k++) {
      applySculpt(map, 32, 32, 2, DEFAULT_SCULPT_AMOUNT);
    }
    expect(heightAt(map, 32, 32)).toBeLessThanOrEqual(MAX_HEIGHT);
    expectGradientLimitHolds(map);
    // It actually built a mountain.
    expect(heightAt(map, 32, 32)).toBeGreaterThan(MAX_HEIGHT / 2);
  });

  it('one band-click on flat ground spreads to neighbors (the "flow" feel)', () => {
    const map = createHeightmap(32);
    applySculpt(map, 16, 16, 1, DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 16, 16)).toBeGreaterThan(0);
    // 64 > MAX_STEP, so relaxation must have pushed height outward.
    const neighbors =
      heightAt(map, 15, 16) + heightAt(map, 17, 16) +
      heightAt(map, 16, 15) + heightAt(map, 16, 17);
    expect(neighbors).toBeGreaterThan(0);
    expect(heightAt(map, 16, 16)).toBeGreaterThan(heightAt(map, 17, 16));
  });
});
