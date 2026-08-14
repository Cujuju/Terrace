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
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  quantizeToBand,
  smooth,
  type Heightmap,
} from '../src/index.ts';

/** Cells a brush of this radius covers: integer distance strictly under it. */
function footprintOf(size: number, cx: number, cy: number, radius: number): Set<number> {
  const cells = new Set<number>();
  for (let dy = -(radius - 1); dy <= radius - 1; dy++) {
    for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
      if (Math.floor(Math.sqrt(dx * dx + dy * dy)) >= radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      cells.add(y * size + x);
    }
  }
  return cells;
}

/** A deterministic non-flat map, so "unchanged" means something. */
function texturedMap(size: number): Heightmap {
  const map = createHeightmap(size);
  for (let i = 0; i < map.cells.length; i++) {
    // Integer-only, well inside the height range, and varies in both axes.
    map.cells[i] = ((i * 7) % 23) - 11;
  }
  return map;
}

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

// ---------------------------------------------------------------------------
// Brush tools and edge profiles (decision 2026-08-14).
//
// The compatibility suite below is the load-bearing one: the whole change is
// only safe if an options-less call still means exactly what it meant before.
// ---------------------------------------------------------------------------

describe('applySculpt options — compatibility with the pre-2026-08-14 contract', () => {
  /** The same varied workload the determinism test uses, plus radius 4. */
  const OPS: Array<[number, number, number, number]> = [
    [32, 32, 2, 64], [33, 32, 3, 64], [30, 34, 1, -64],
    [32, 33, 4, 64], [20, 20, 4, -128], [32, 32, 1, 64],
  ];

  it('an ABSENT options argument is byte-identical to explicit smooth+soft', () => {
    const legacy = createHeightmap(64);
    const explicit = createHeightmap(64);

    for (const [x, y, r, amt] of OPS) {
      const legacyDiff = applySculpt(legacy, x, y, r, amt);
      const explicitDiff = applySculpt(explicit, x, y, r, amt, {
        tool: 'smooth',
        profile: 'soft',
      });
      expect(legacyDiff).toEqual(explicitDiff);
      expect(legacy.cells).toEqual(explicit.cells);
    }
  });

  it('the library default is smooth+soft, NOT the wire default', () => {
    // Stated as a value so the compatibility promise is greppable, and so a
    // future edit to it fails here rather than silently re-tuning plugins.
    expect(LIBRARY_DEFAULT_SCULPT_OPTIONS).toEqual({ tool: 'smooth', profile: 'soft' });
  });

  it('the smooth tool reproduces the old brush→smooth→diff composition exactly', () => {
    // This test open-codes the pre-change implementation of applySculpt. If the
    // refactor ever changed the composition (order, the changed-set, the diff),
    // the two would part company here.
    const viaOptions = texturedMap(48);
    const viaOldSteps = texturedMap(48);

    for (const [x, y, r, amt] of [[24, 24, 3, 64], [24, 25, 1, -64]] as const) {
      const diff = applySculpt(viaOptions, x, y, r, amt, { tool: 'smooth', profile: 'soft' });

      const changed = new Set<number>();
      applyBrush(viaOldSteps, x, y, r, amt, changed);
      smooth(viaOldSteps, changed);
      const expected = Array.from(changed)
        .sort((a, b) => a - b)
        .map((i) => ({ x: i % 48, y: (i - (i % 48)) / 48, h: viaOldSteps.cells[i] }));

      expect(diff).toEqual(expected);
      expect(viaOptions.cells).toEqual(viaOldSteps.cells);
    }
  });

  it('applyBrush without a profile argument is the soft falloff', () => {
    const implicit = createHeightmap(32);
    const explicit = createHeightmap(32);
    applyBrush(implicit, 16, 16, 4, DEFAULT_SCULPT_AMOUNT, new Set());
    applyBrush(explicit, 16, 16, 4, DEFAULT_SCULPT_AMOUNT, new Set(), 'soft');
    expect(implicit.cells).toEqual(explicit.cells);
  });
});

describe('applySculpt — the stamp tool', () => {
  it('changes ONLY its footprint; every other cell is bit-identical', () => {
    const map = texturedMap(48);
    const before = map.cells.slice();
    const footprint = footprintOf(48, 24, 24, 3);

    applySculpt(map, 24, 24, 3, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });

    for (let i = 0; i < map.cells.length; i++) {
      if (footprint.has(i)) continue;
      expect(map.cells[i]).toBe(before[i]);
    }
    // ...and the footprint really did move (otherwise the above is vacuous).
    for (const i of footprint) expect(map.cells[i]).toBeGreaterThan(before[i]);
  });

  it('reports a diff confined to the footprint', () => {
    const map = texturedMap(48);
    const footprint = footprintOf(48, 24, 24, 4);
    const diff = applySculpt(map, 24, 24, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp' });
    expect(diff.length).toBe(footprint.size);
    for (const c of diff) expect(footprint.has(c.y * 48 + c.x)).toBe(true);
  });

  it('stacks into a true vertical spire: N radius-1 stamps = N × amount', () => {
    const map = createHeightmap(32);
    const stacks = 5;
    for (let k = 0; k < stacks; k++) {
      applySculpt(map, 16, 16, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    }
    expect(heightAt(map, 16, 16)).toBe(stacks * DEFAULT_SCULPT_AMOUNT);
    // The neighbours never moved — this is the whole point of the tool.
    expect(heightAt(map, 15, 16)).toBe(0);
    expect(heightAt(map, 17, 16)).toBe(0);
    expect(heightAt(map, 16, 15)).toBe(0);
    expect(heightAt(map, 16, 17)).toBe(0);
    expect(heightAt(map, 15, 15)).toBe(0);
  });

  it('digs a sheer pit when lowering', () => {
    const map = createHeightmap(32);
    for (let k = 0; k < 3; k++) {
      applySculpt(map, 16, 16, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'stamp' });
    }
    expect(heightAt(map, 16, 16)).toBe(-3 * DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 17, 16)).toBe(0);
  });

  it('still clamps to the height range', () => {
    const high = createHeightmap(16);
    high.cells.fill(MAX_HEIGHT - 1);
    applySculpt(high, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(heightAt(high, 8, 8)).toBe(MAX_HEIGHT);

    const low = createHeightmap(16);
    low.cells.fill(MIN_HEIGHT + 1);
    applySculpt(low, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(heightAt(low, 8, 8)).toBe(MIN_HEIGHT);
  });
});

describe('applySculpt — edge profiles', () => {
  it('hard applies ONE flat delta across the whole footprint, edges included', () => {
    const map = createHeightmap(48);
    const radius = 4;
    const footprint = footprintOf(48, 24, 24, radius);

    applySculpt(map, 24, 24, radius, DEFAULT_SCULPT_AMOUNT, {
      tool: 'stamp',
      profile: 'hard',
    });

    for (const i of footprint) expect(map.cells[i]).toBe(DEFAULT_SCULPT_AMOUNT);
    // The outermost ring of the footprint is at integer distance radius-1 = 3;
    // under the soft profile it would have received a quarter of the amount.
    expect(heightAt(map, 24 + (radius - 1), 24)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 24, 24 - (radius - 1))).toBe(DEFAULT_SCULPT_AMOUNT);
    // ...and nothing outside it moved.
    expect(heightAt(map, 24 + radius, 24)).toBe(0);
  });

  it('soft is unchanged: full amount at the centre, linear falloff outward', () => {
    const map = createHeightmap(48);
    applySculpt(map, 24, 24, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    // trunc(64 * (4 - d) / 4) for d = 0..3 — exactly the pre-change values.
    expect(heightAt(map, 24, 24)).toBe(64);
    expect(heightAt(map, 25, 24)).toBe(48);
    expect(heightAt(map, 26, 24)).toBe(32);
    expect(heightAt(map, 27, 24)).toBe(16);
    expect(heightAt(map, 28, 24)).toBe(0);
  });

  it('radius 1 makes the two profiles identical (footprint is one cell)', () => {
    const soft = createHeightmap(16);
    const hard = createHeightmap(16);
    applySculpt(soft, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    applySculpt(hard, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(soft.cells).toEqual(hard.cells);
  });

  it('lowering mirrors raising under the hard profile too', () => {
    const up = createHeightmap(32);
    const down = createHeightmap(32);
    applySculpt(up, 16, 16, 3, 64, { tool: 'stamp', profile: 'hard' });
    applySculpt(down, 16, 16, 3, -64, { tool: 'stamp', profile: 'hard' });
    for (let i = 0; i < up.cells.length; i++) expect(down.cells[i]).toBe(-up.cells[i] | 0);
  });
});

describe('applySculpt — tools and profiles are orthogonal', () => {
  it('hard+smooth stamps a plateau and then lets it slump', () => {
    const stamped = createHeightmap(64);
    const slumped = createHeightmap(64);
    applySculpt(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'smooth', profile: 'hard' });

    // Same brush, so the plateau's edge is sheer before relaxation...
    expect(heightAt(stamped, 35, 32)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(stamped, 36, 32)).toBe(0);
    // ...and the smooth tool pulled that cliff outward instead.
    expect(heightAt(slumped, 36, 32)).toBeGreaterThan(0);
    expectGradientLimitHolds(slumped);
  });

  it('stays deterministic for every tool/profile combination', () => {
    for (const tool of ['stamp', 'smooth'] as const) {
      for (const profile of ['soft', 'hard'] as const) {
        const a = createHeightmap(64);
        const b = createHeightmap(64);
        for (const [x, y, r, amt] of [[32, 32, 3, 64], [33, 34, 2, -64]] as const) {
          expect(applySculpt(a, x, y, r, amt, { tool, profile })).toEqual(
            applySculpt(b, x, y, r, amt, { tool, profile }),
          );
        }
        expect(a.cells).toEqual(b.cells);
      }
    }
  });
});
