import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applyLevelFillBrush,
  applySculpt,
  bandOf,
  BAND_HEIGHT,
  cellIndex,
  cellX,
  cellY,
  createHeightmap,
  DEEP_BASALT_BANDS,
  DEEP_LAVA_BANDS,
  DEEP_OBSIDIAN_BANDS,
  DEEP_STRATA_BANDS,
  DEFAULT_SCULPT_AMOUNT,
  forEachFootprintOffset,
  heightAt,
  isValidHeight,
  isWater,
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  quantizeToBand,
  SEA_COLUMN_BANDS,
  sculptDisplacementUnits,
  smooth,
  SMOOTH_PASS_LIMIT,
  SMOOTH_SPREAD_CELLS,
  type Heightmap,
  type SculptOptions,
} from '../src/index.ts';

/**
 * Cells a brush of this radius covers — the tight integer disc (2026-08-19):
 * dx² + dy² < radius·(radius−1), radius 1 the centre alone. Deliberately an
 * independent re-derivation, NOT an import of forEachFootprintOffset, so a
 * drift in the shipped footprint fails here instead of following it.
 */
function footprintOf(size: number, cx: number, cy: number, radius: number): Set<number> {
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

describe('deep strata constants', () => {
  it('derives MIN_HEIGHT from the strata stack (Deep Strata, 2026-08-19)', () => {
    // The floor IS the bottom of the lava band: sea column (the pre-strata
    // −1024 floor, kept exactly so old snapshots are unchanged), then basalt,
    // obsidian, lava. Restating −1536 as a literal anywhere would let the
    // floor and the strata that define it drift apart — this is the pin.
    expect(SEA_COLUMN_BANDS).toBe(16);
    expect(DEEP_STRATA_BANDS).toBe(
      DEEP_BASALT_BANDS + DEEP_OBSIDIAN_BANDS + DEEP_LAVA_BANDS,
    );
    expect(MIN_HEIGHT).toBe(-(SEA_COLUMN_BANDS + DEEP_STRATA_BANDS) * BAND_HEIGHT);
    expect(MIN_HEIGHT).toBe(-1536);
    // Every pre-strata height remains valid: the old floor sits inside the
    // new range, so no stored world can have gone out of contract.
    expect(isValidHeight(-(SEA_COLUMN_BANDS * BAND_HEIGHT))).toBe(true);
    expect(isValidHeight(MIN_HEIGHT)).toBe(true);
    expect(isValidHeight(MIN_HEIGHT - 1)).toBe(false);
  });

  it('scales the smoothing budget with the widened range', () => {
    // The relaxation travel bound follows the range by derivation; if either
    // side of this drifts to a literal, the deepest cascades truncate.
    expect(SMOOTH_SPREAD_CELLS).toBe(
      Math.floor((MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP),
    );
    expect(SMOOTH_SPREAD_CELLS).toBe(80);
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
    // Orthogonal neighbors are the plus-shaped disc's distance-1 ring.
    expect(heightAt(map, 17, 16)).toBe(32);
    expect(heightAt(map, 16, 15)).toBe(32);
    // Diagonals are OUTSIDE the tight disc (2026-08-19 footprint decision:
    // dx²+dy² = 2 >= 2·1) — they used to receive 32 under floor(sqrt) < r.
    expect(heightAt(map, 17, 17)).toBe(0);
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
        spill: 'free',
        anchor: 'free',
      });
      expect(legacyDiff).toEqual(explicitDiff);
      expect(legacy.cells).toEqual(explicit.cells);
    }
  });

  it('the library default is smooth+soft, NOT the wire default', () => {
    // Stated as a value so the compatibility promise is greppable, and so a
    // future edit to it fails here rather than silently re-tuning plugins.
    expect(LIBRARY_DEFAULT_SCULPT_OPTIONS).toEqual({
      tool: 'smooth',
      profile: 'soft',
      spill: 'free',
      anchor: 'free',
    });
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

  it('radius 1 makes the two profiles identical on band-aligned ground', () => {
    // The footprint is the centre alone, so the falloff and the flat delta
    // coincide. Band-aligned ground is the qualifier the level fill adds (see
    // "the level-fill brush" below): off the band grid, hard snaps to the band
    // boundary while soft adds the full amount.
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

// ────────────────────────────────────────────────────────────────────────────
// THE LEVEL-FILL BRUSH — stamp + hard (owner request, 2026-08-14):
//   "I would also like the hard edge brush to only work at one level at a time
//    until it fills out everything at that level. So if I'm at level 2 and I'm
//    trying to fill out all the ground at a level 2, I don't want it to start
//    building level 3 until everything within that brush edge is level 2."
//
// These are CONTRACT tests: they exercise applySculpt (the one function both the
// server and the client's prediction store call), not the dispatch inside it.
// ────────────────────────────────────────────────────────────────────────────

/** stamp + hard: the one combination the level fill applies to. */
const LEVEL_FILL = { tool: 'stamp', profile: 'hard' } as const;

/**
 * Writes a 3×3 patch of BAND indices centred on (cx, cy) — exactly the
 * footprint of a radius-2 brush, the smallest footprint that can hold more than
 * one band and therefore the smallest one on which a level fill means anything.
 * Heights are written band-aligned (`band * BAND_HEIGHT`), which is the only
 * kind of terrain the stamp tool ever produces.
 */
function paintFootprint3x3(
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

/**
 * Paints the radius-2 footprint — the 5-cell plus the tight disc gives
 * (2026-08-19) — by compass position, in band units.
 */
function paintFootprintPlus(
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

/** The same 3×3 patch read back as band indices, in the same order. */
function readFootprintBands3x3(map: Heightmap, cx: number, cy: number): number[] {
  const bands: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) bands.push(bandOf(heightAt(map, cx + dx, cy + dy)));
  }
  return bands;
}

describe('applySculpt — the level-fill brush (stamp + hard)', () => {
  it('fills the LOWEST band flat before it starts the next one', () => {
    const map = createHeightmap(16);
    // The owner's case, in miniature: ground at three different levels under
    // one brush. Level 3 must not start while level 2 still has holes in it.
    // The radius-2 footprint is the 5-cell plus (2026-08-19 disc), so the
    // fixture paints exactly those cells; the 3×3 read below still shows the
    // corners, which are OUTSIDE the brush and must never move from band 0.
    paintFootprintPlus(map, 8, 8, { n: 0, w: 1, c: 1, e: 2, s: 0 });

    // Stroke 1 — the band-0 cells come up one level. Everything already at or
    // above that level is left completely alone.
    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 1, 0,
                                                      1, 1, 2,
                                                      0, 1, 0]);

    // Stroke 2 — the lowest band under the brush is now 1, so THAT is the
    // level being filled. The cell already on band 2 still does not move.
    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 2, 0,
                                                      2, 2, 2,
                                                      0, 2, 0]);

    // Stroke 3 — only now, with the whole footprint level, does band 3 start.
    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 3, 0,
                                                      3, 3, 3,
                                                      0, 3, 0]);
  });

  it('never lifts a cell THROUGH the level being filled', () => {
    const map = createHeightmap(16);
    // One cell a single unit below the band floor, the rest already on it. A
    // full-amount stroke would carry that cell almost a whole band past the
    // level being filled — which is the step this brush exists to prevent.
    map.cells.fill(BAND_HEIGHT);
    map.cells[cellIndex(map, 8, 8)] = BAND_HEIGHT - 1;

    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    expect(heightAt(map, 8, 8)).toBe(BAND_HEIGHT);
    expect(heightAt(map, 7, 8)).toBe(BAND_HEIGHT); // already there: untouched
  });

  it('advances at most ONE band per stroke, whatever the amount', () => {
    // `amount` is server configuration and a plugin may modify it. Four bands'
    // worth of height still fills exactly one level: "don't start building
    // level 3" is a statement about levels, not about how hard the stroke hits.
    const map = createHeightmap(16);
    applySculpt(map, 8, 8, 2, 4 * BAND_HEIGHT, LEVEL_FILL);
    // The plus fills one band; the 3×3 read's corners are outside the brush.
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 1, 0, 1, 1, 1, 0, 1, 0]);
    expect(heightAt(map, 8, 8)).toBe(BAND_HEIGHT);
  });

  it('on a FLAT footprint is exactly the old flat stamp: one band, uniformly', () => {
    // The natural reading of the request, and the compatibility claim that
    // matters: on ground that is already level — which is all a fresh world has
    // (docs/DESIGN.md genesis) — nothing about the brush changed. The two agree
    // because DEFAULT_SCULPT_AMOUNT is exactly BAND_HEIGHT.
    for (const band of [-3, -1, 0, 5]) {
      const levelled = createHeightmap(16);
      const flatDelta = createHeightmap(16);
      levelled.cells.fill(band * BAND_HEIGHT);
      flatDelta.cells.fill(band * BAND_HEIGHT);

      applySculpt(levelled, 8, 8, 3, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      applyBrush(flatDelta, 8, 8, 3, DEFAULT_SCULPT_AMOUNT, new Set<number>(), 'hard');

      expect(levelled.cells).toEqual(flatDelta.cells);
      expect(heightAt(levelled, 8, 8)).toBe((band + 1) * BAND_HEIGHT);
    }
  });

  it('lowering is the same operation mirrored: the HIGHEST band, one level down', () => {
    const up = createHeightmap(16);
    const down = createHeightmap(16);
    paintFootprint3x3(up, 8, 8, [0, 1, 2,
                                 0, 1, 1,
                                 2, 0, 1]);
    paintFootprint3x3(down, 8, 8, [0, -1, -2,
                                   0, -1, -1,
                                   -2, 0, -1]);

    // Three strokes, so the mirror covers the whole progression: drain the
    // highest level flat, then the next one down, then the level below that.
    for (let stroke = 0; stroke < 3; stroke++) {
      applySculpt(up, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      applySculpt(down, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      // `| 0` only to normalise JavaScript's -0 back to 0 — untouched cells
      // negate to -0, which Object.is separates from the 0 actually stored.
      for (let i = 0; i < up.cells.length; i++) expect(down.cells[i]).toBe(-up.cells[i] | 0);
    }
  });

  it('clamps at the top and the bottom of the height range', () => {
    // One unit below the ceiling: the fill reaches MAX_HEIGHT exactly.
    const nearTop = createHeightmap(16);
    nearTop.cells.fill(MAX_HEIGHT - 1);
    applySculpt(nearTop, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(nearTop, 8, 8)).toBe(MAX_HEIGHT);

    // AT the ceiling there is no level left to fill — the band above MAX_HEIGHT
    // is not a place this world has — so nothing moves and the diff is empty.
    const atTop = createHeightmap(16);
    atTop.cells.fill(MAX_HEIGHT);
    expect(applySculpt(atTop, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL)).toEqual([]);
    expect(atTop.cells.every((h) => h === MAX_HEIGHT)).toBe(true);

    const nearFloor = createHeightmap(16);
    nearFloor.cells.fill(MIN_HEIGHT + 1);
    applySculpt(nearFloor, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(nearFloor, 8, 8)).toBe(MIN_HEIGHT);

    const atFloor = createHeightmap(16);
    atFloor.cells.fill(MIN_HEIGHT);
    expect(applySculpt(atFloor, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL)).toEqual([]);
    expect(atFloor.cells.every((h) => h === MIN_HEIGHT)).toBe(true);
  });

  it('reports only the cells it actually moved', () => {
    const map = createHeightmap(16);
    paintFootprintPlus(map, 8, 8, { n: 0, w: 1, c: 1, e: 1, s: 1 });
    // Four of the five footprint cells are already on the level being filled,
    // so the diff — which is what goes on the wire and what the client's
    // prediction reconciles against — names exactly the one that was not.
    expect(applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL)).toEqual([
      { x: 8, y: 7, h: BAND_HEIGHT },
    ]);
  });

  it('changes nothing outside its footprint', () => {
    const map = texturedMap(48);
    const before = map.cells.slice();
    const footprint = footprintOf(48, 24, 24, 4);

    applySculpt(map, 24, 24, 4, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    for (let i = 0; i < map.cells.length; i++) {
      if (footprint.has(i)) continue;
      expect(map.cells[i]).toBe(before[i]);
    }
    // And inside it, every cell is either untouched (already at or above the
    // level) or moved toward that level without passing it.
    let lowestBand = Number.POSITIVE_INFINITY;
    for (const i of footprint) lowestBand = Math.min(lowestBand, bandOf(before[i]));
    const target = (lowestBand + 1) * BAND_HEIGHT;
    for (const i of footprint) {
      const expected =
        before[i] >= target ? before[i] : Math.min(before[i] + DEFAULT_SCULPT_AMOUNT, target);
      expect(map.cells[i]).toBe(expected);
    }
  });

  it('surveys only in-bounds cells when the brush overhangs the map edge', () => {
    // Off-map cells are not ground, so they must not be surveyed as band-0
    // terrain that holds the fill back. All three in-bounds cells of this
    // corner brush (the plus loses its north and west arms off-map) sit on
    // band 1, so the stroke fills band 2 — if the missing cells counted as
    // band 0, nothing here would move at all.
    const map = createHeightmap(16);
    const corner = [[0, 0], [1, 0], [0, 1]] as const;
    for (const [x, y] of corner) map.cells[cellIndex(map, x, y)] = BAND_HEIGHT;
    // The old 3×3 footprint's fourth corner cell: outside the plus, so it
    // must hold whatever it started with even though the brush box covers it.
    map.cells[cellIndex(map, 1, 1)] = BAND_HEIGHT;

    applySculpt(map, 0, 0, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    for (const [x, y] of corner) expect(heightAt(map, x, y)).toBe(2 * BAND_HEIGHT);
    expect(heightAt(map, 1, 1)).toBe(BAND_HEIGHT);
  });

  it('at radius 1 snaps an off-grid cell onto the band boundary', () => {
    // The footprint is one cell, so its own band is the lowest one and the
    // target is the boundary above it. Only the smooth tool's relaxation makes
    // off-grid heights, so this is a corner case — but it is the terraced
    // answer, and it is why "radius 1 makes the two profiles identical" now
    // carries the qualifier "on band-aligned ground".
    const map = createHeightmap(16);
    map.cells[cellIndex(map, 8, 8)] = 10;
    applySculpt(map, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(map, 8, 8)).toBe(BAND_HEIGHT);
  });

  it('lowering an off-grid cell drops it a RENDERED band, not to its own floor', () => {
    // 70 renders on band 1 (bandOf floors), so one level down must leave it
    // rendering on band 0. A perfect negation mirror of the raise would instead
    // drop it to 64 — still band 1, a stroke with no visible effect. The
    // half-open band convention is the asymmetry, and it is the right one.
    const map = createHeightmap(16);
    map.cells[cellIndex(map, 8, 8)] = 70;
    applySculpt(map, 8, 8, 1, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(map, 8, 8)).toBe(6);
    expect(bandOf(heightAt(map, 8, 8))).toBe(0);
  });

  it('does nothing at all for a zero amount', () => {
    const map = texturedMap(16);
    const before = map.cells.slice();
    expect(applySculpt(map, 8, 8, 3, 0, LEVEL_FILL)).toEqual([]);
    expect(map.cells).toEqual(before);
  });

  it('soft is untouched; hard level-fills under BOTH tools (2026-08-19)', () => {
    const bands = [0, 1, 2, 0, 1, 1, 2, 0, 1];

    // stamp + soft — still the linear falloff, applied to every footprint cell
    // regardless of the band it sits on.
    const soft = createHeightmap(16);
    const softExpected = createHeightmap(16);
    paintFootprint3x3(soft, 8, 8, bands);
    paintFootprint3x3(softExpected, 8, 8, bands);
    applySculpt(soft, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    applyBrush(softExpected, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, new Set<number>(), 'soft');
    expect(soft.cells).toEqual(softExpected.cells);

    // smooth + hard — LEVEL-FILL, then the relaxation pass ("fill, then
    // slump" — the 2026-08-19 supersession in applySculpt's doc). Before
    // that, this combination ran the flat delta, which lifted the footprint's
    // HIGHER-band cells up a band and made the neighbouring level's contour
    // retreat from the click — the owner report the supersession fixed.
    // Byte-compare against the two primitives composed by hand.
    const slumped = createHeightmap(16);
    const slumpedExpected = createHeightmap(16);
    paintFootprint3x3(slumped, 8, 8, bands);
    paintFootprint3x3(slumpedExpected, 8, 8, bands);
    applySculpt(slumped, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, { tool: 'smooth', profile: 'hard' });
    const expectedChanged = new Set<number>();
    applyLevelFillBrush(slumpedExpected, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, expectedChanged);
    smooth(slumpedExpected, expectedChanged);
    expect(slumped.cells).toEqual(slumpedExpected.cells);
  });

  it('THE COMPLAINT AS A CONTRACT: a smooth+hard raise beside a higher level never lifts that level (2026-08-19)', () => {
    // A band-6 plain with a band-7 shelf crossing the right half of the
    // footprint — the owner's "clicking on level six" scenario. The stroke
    // must fill band 6 toward 7 and NEVER push any band-7 cell to band 8:
    // level seven may only ever EXPAND (via cells rising to it), never
    // contract away from the brush.
    const map = createHeightmap(32);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        map.cells[y * 32 + x] = x >= 16 ? 7 * BAND_HEIGHT : 6 * BAND_HEIGHT;
      }
    }
    const sevenBefore = new Set<number>();
    for (let i = 0; i < map.cells.length; i++) {
      if (bandOf(map.cells[i]) === 7) sevenBefore.add(i);
    }

    // Footprint straddles the boundary (centre one cell into band 6, radius 3
    // reaches into the shelf). Explicit banded spill: the player-facing shape.
    applySculpt(map, 14, 16, 3, DEFAULT_SCULPT_AMOUNT, {
      tool: 'smooth',
      profile: 'hard',
      spill: 'banded',
    });

    for (const i of sevenBefore) {
      expect(bandOf(map.cells[i])).toBeLessThanOrEqual(7);
    }
  });

  it('is deterministic: identical inputs → identical maps and diffs', () => {
    const a = texturedMap(32);
    const b = texturedMap(32);
    const strokes = [
      [16, 16, 4, DEFAULT_SCULPT_AMOUNT],
      [16, 16, 4, DEFAULT_SCULPT_AMOUNT],
      [15, 17, 2, -DEFAULT_SCULPT_AMOUNT],
      [16, 16, 3, DEFAULT_SCULPT_AMOUNT],
    ] as const;
    for (const [x, y, r, amount] of strokes) {
      expect(applySculpt(a, x, y, r, amount, LEVEL_FILL)).toEqual(
        applySculpt(b, x, y, r, amount, LEVEL_FILL),
      );
    }
    expect(a.cells).toEqual(b.cells);
  });

  it('rejects exactly what the plain brush rejects', () => {
    const map = createHeightmap(16);
    expect(() => applyLevelFillBrush(map, -1, 0, 2, 64, new Set<number>())).toThrow(RangeError);
    expect(() => applyLevelFillBrush(map, 8, 8, 0, 64, new Set<number>())).toThrow(RangeError);
    expect(() =>
      applyLevelFillBrush(map, 8, 8, MAX_BRUSH_RADIUS + 1, 64, new Set<number>()),
    ).toThrow(RangeError);
    expect(() => applyLevelFillBrush(map, 8, 8, 2, 1.5, new Set<number>())).toThrow(RangeError);
  });
});

describe('applySculpt — tools and profiles are orthogonal', () => {
  it('hard+smooth level-fills a plateau and then lets it slump', () => {
    // On band-aligned flat ground the level fill IS the old flat delta
    // (DESIGN.md: "On flat ground nothing changed"), so this test's numbers
    // survive the 2026-08-19 fill-then-slump supersession unchanged — what it
    // pins is the slump half: same fill, then relaxation pulls the edge out.
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

// ────────────────────────────────────────────────────────────────────────────
// SCULPT VOLUME — the number the mana plugin prices a sculpt by.
//
// The claim under test is not "this formula is implemented correctly", it is
// "this function agrees with applyBrush". So the primary test measures
// applyBrush's OWN output — the terrain it actually left behind — and compares
// the total to sculptDisplacementUnits, for every radius × profile the game
// ships. Re-deriving the expected sum with a copy of the formula would only
// prove the copy matched.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Σ |height change| over the whole map after one brush application: the volume
 * applyBrush moved, observed rather than predicted.
 */
function observedDisplacement(
  radius: number,
  profile: 'soft' | 'hard',
  amount: number,
): number {
  const size = 64;
  // A FLAT MID-RANGE map: every cell starts far enough from MIN_HEIGHT and
  // MAX_HEIGHT that nothing clamps, and the centre is far enough from the
  // border that nothing overhangs. Those are exactly the two exclusions
  // sculptDisplacementUnits documents, so this is the map on which "nominal"
  // and "actual" must coincide.
  const map = createHeightmap(size);
  const start = 128;
  map.cells.fill(start);

  applyBrush(map, 32, 32, radius, amount, new Set<number>(), profile);

  let total = 0;
  for (const h of map.cells) total += Math.abs(h - start);
  return total;
}

describe('sculptDisplacementUnits', () => {
  it('equals the volume applyBrush actually moves, for every radius × profile', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius, profile)).toBe(
          observedDisplacement(radius, profile, DEFAULT_SCULPT_AMOUNT),
        );
      }
    }
  });

  it('prices a lower exactly like the raise that undoes it', () => {
    // Volume is |delta| summed, so direction cannot make a sculpt cheaper —
    // otherwise digging would be the economical way to reshape a world.
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius, profile)).toBe(
          observedDisplacement(radius, profile, -DEFAULT_SCULPT_AMOUNT),
        );
      }
    }
  });

  /**
   * THE LITERAL TABLE. Deliberately hand-written numbers, not a formula: this is
   * the wall that stops a "harmless" refactor of the brush from silently
   * re-pricing the whole economy. Every value is height-units × cells, at
   * DEFAULT_SCULPT_AMOUNT = BAND_HEIGHT = 64.
   *
   * Recomputed 2026-08-19 for the tight-disc footprint (the pre-disc square
   * numbers were 9/25/45 cells → soft 320/736/1280, hard 576/1600/2880):
   *
   *   radius  cells   soft (band-cells)    hard (band-cells)
   *      1      1        64  ( 1    )        64  ( 1 )
   *      2      5       192  ( 3    )       320  ( 5 )
   *      3     21       652  (10.19 )      1344  (21 )
   *      4     37      1152  (18    )      2368  (37 )
   */
  it('matches the published table of displacement volumes', () => {
    expect(sculptDisplacementUnits(1, 'soft')).toBe(64);
    expect(sculptDisplacementUnits(2, 'soft')).toBe(192);
    expect(sculptDisplacementUnits(3, 'soft')).toBe(652);
    expect(sculptDisplacementUnits(4, 'soft')).toBe(1152);

    expect(sculptDisplacementUnits(1, 'hard')).toBe(64);
    expect(sculptDisplacementUnits(2, 'hard')).toBe(320);
    expect(sculptDisplacementUnits(3, 'hard')).toBe(1344);
    expect(sculptDisplacementUnits(4, 'hard')).toBe(2368);
  });

  it('is one band-cell at the point brush, where the two profiles coincide', () => {
    // The unit the price rate is denominated in: one band of height, one cell.
    expect(sculptDisplacementUnits(MIN_BRUSH_RADIUS, 'soft')).toBe(BAND_HEIGHT);
    expect(sculptDisplacementUnits(MIN_BRUSH_RADIUS, 'hard')).toBe(BAND_HEIGHT);
  });

  it('grows with radius, and hard never displaces less than soft', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius < MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius + 1, profile)).toBeGreaterThan(
          sculptDisplacementUnits(radius, profile),
        );
      }
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius, 'hard')).toBeGreaterThanOrEqual(
          sculptDisplacementUnits(radius, 'soft'),
        );
      }
    }
  });

  it('is a pure integer function of radius and profile', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        const units = sculptDisplacementUnits(radius, profile);
        expect(Number.isInteger(units)).toBe(true);
        // Called twice, same answer — no hidden state, nothing terrain-dependent.
        expect(sculptDisplacementUnits(radius, profile)).toBe(units);
      }
    }
  });

  it('rejects a radius the brush itself would reject', () => {
    for (const bad of [0, MAX_BRUSH_RADIUS + 1, 1.5, Number.NaN]) {
      expect(() => sculptDisplacementUnits(bad, 'soft')).toThrow(RangeError);
    }
  });

  it('ignores the relaxation spill, which stays deliberately free', () => {
    // The smooth tool REACHES FURTHER than its footprint: relaxation drags
    // terrain outside the brush and how far depends on the terrain that was
    // already there. None of that is priced — the function takes no `tool`
    // argument at all, so both tools cost the volume of the brush and nothing
    // else, exactly as the flat per-sculpt price it replaced also ignored the
    // spill. What follows is the evidence that there IS a spill being waived.
    const size = 64;
    const stampedCells = new Set<number>();
    const stamped = createHeightmap(size);
    stamped.cells.fill(128);
    applyBrush(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, stampedCells, 'hard');

    const slumped = createHeightmap(size);
    slumped.cells.fill(128);
    const slumpedDiff = applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, {
      tool: 'smooth',
      profile: 'hard',
    });

    // The brush alone touched its 37 footprint cells; the same brush plus
    // relaxation touched strictly more of the world than that.
    expect(slumpedDiff.length).toBeGreaterThan(stampedCells.size);
    // And the price is the brush's volume either way — one number, no tool.
    expect(sculptDisplacementUnits(4, 'hard')).toBe(2368);
  });

  it('prices a LEVEL FILL at the flat-delta volume, deliberately', () => {
    // stamp+hard (applyLevelFillBrush) moves less than the flat delta whenever
    // the ground under the brush is not already level, and is priced the same.
    // DECIDED 2026-08-14, for the reason the `clamping` exclusion exists and one
    // stronger: the mana plugin gates a stroke on the CLIENT before sending it
    // and the server charges the same number, so the price must be a pure
    // function of (radius, profile). A terrain-dependent price would be computed
    // from heights the client holds only as base-plus-predictions — and not at
    // all in a locked chunk — and the gate and the server would then disagree.
    const map = createHeightmap(32);
    map.cells.fill(BAND_HEIGHT);
    map.cells[cellIndex(map, 16, 16)] = 0; // one cell a band low

    const diff = applySculpt(map, 16, 16, MAX_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'stamp',
      profile: 'hard',
    });

    // A one-cell edit, charged as 37 cells of flat delta. That is the trade.
    expect(diff).toHaveLength(1);
    expect(sculptDisplacementUnits(MAX_BRUSH_RADIUS, 'hard')).toBe(2368);
  });
});

describe('cellX/cellY — the exported inverse of cellIndex (#14)', () => {
  it('round-trips every cell of a small map', () => {
    const map = createHeightmap(7);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const i = cellIndex(map, x, y);
        expect(cellX(map.size, i)).toBe(x);
        expect(cellY(map.size, i)).toBe(y);
      }
    }
  });
});

describe('smooth — cascades from stamped terrain (#12)', () => {
  const SIZE = 128;
  const C = SIZE / 2;
  const STAMP: SculptOptions = { tool: 'stamp', profile: 'hard' };
  const SMOOTH_HARD: SculptOptions = { tool: 'smooth', profile: 'hard' };

  /** Stamps `bands` level-fill strokes at (x, y), radius 4 — the player's default brush. */
  function stampPlateau(map: Heightmap, x: number, y: number, bands: number): void {
    for (let s = 0; s < bands; s++) {
      applySculpt(map, x, y, 4, DEFAULT_SCULPT_AMOUNT, STAMP);
    }
  }

  it('one smooth stroke fully relaxes a 15-band stamped plateau (the pass-cap repro)', () => {
    // 15 strokes: plateau at 960, so the smooth stroke's own brush still moves
    // cells (changed is non-empty) and the cascade must converge inside
    // SMOOTH_PASS_LIMIT — the case the old 64-pass cap truncated.
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, 15);
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('a fully clamped smooth stroke still relaxes the cliffs under the brush', () => {
    // 16 strokes: plateau at MAX_HEIGHT. The smooth stroke's brush is then
    // fully clamped (changed stays empty) — the old code early-returned and
    // left a 1024-unit cliff standing.
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, 16);
    expect(heightAt(map, C, C)).toBe(MAX_HEIGHT);
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('converges across the full height range: MAX plateau beside a MIN moat', () => {
    // Worst single-stroke cascade a player can construct: full 2048-unit
    // relief within one brush's reach. Pins that SMOOTH_PASS_LIMIT's budget
    // (SMOOTH_PASSES_PER_SPREAD_CELL per cell of spread) covers the extreme.
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, 16);
    for (let s = 0; s < 16; s++) {
      applySculpt(map, C + 8, C, 4, -DEFAULT_SCULPT_AMOUNT, STAMP);
    }
    applySculpt(map, C + 4, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('reports a convergence-proving pass count strictly below the cap', () => {
    // smooth returns the number of adjusting passes; < SMOOTH_PASS_LIMIT
    // proves a clean pass ran. Drive the worst repro through the raw API.
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, 15);
    const changed = new Set<number>();
    applyBrush(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, changed, 'hard');
    const passes = smooth(map, changed);
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    expectGradientLimitHolds(map);
  });
});

describe('applySculpt — banded spill containment (issue #26)', () => {
  /**
   * A terrace ledge like the owner's screenshot: a band-2 plateau (h=128)
   * stepping down band by band toward the south-east, every step already
   * respecting MAX_STEP so relaxation starts from a legal map.
   */
  function ledgeMap(size: number): Heightmap {
    const map = createHeightmap(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = x + y;
        let h: number;
        if (t < 40) h = 128;
        else if (t === 40) h = 96;
        else if (t < 50) h = 64;
        else if (t === 50) h = 32;
        else h = 0;
        map.cells[cellIndex(map, x, y)] = h;
      }
    }
    return map;
  }

  const BANDED = { tool: 'smooth', profile: 'soft', spill: 'banded' } as const;
  // Centre one cell inside the plateau edge, radius 2 — the session's repro,
  // which under free spill pushes 12 outside cells across a band boundary.
  const CX = 20;
  const CY = 19;
  const RADIUS = 2;
  const STROKES = 6;

  it('never changes the rendered band of a cell outside the footprint (raising)', () => {
    const map = ledgeMap(64);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(64, CX, CY, RADIUS);
    // Per-stroke outside movement: the containment contract has two phases —
    // early strokes still drag outside terrain (the fabric pull survives),
    // then the band caps fill and the spill SATURATES: later strokes move
    // nothing outside at all. Both phases are the contract, so both are
    // asserted, per stroke rather than as one accumulated count.
    const movedPerStroke: number[] = [];
    const strokes = 12;
    for (let s = 0; s < strokes; s++) {
      const preStroke = Int16Array.from(map.cells);
      applySculpt(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, BANDED);
      let moved = 0;
      for (let i = 0; i < map.cells.length; i++) {
        if (!fp.has(i) && map.cells[i] !== preStroke[i]) moved++;
      }
      movedPerStroke.push(moved);
    }
    for (let i = 0; i < map.cells.length; i++) {
      if (fp.has(i)) continue;
      expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
    // Phase 1: the containment is not "no spill at all".
    expect(movedPerStroke[0]).toBeGreaterThan(0);
    // Phase 2: the caps saturate and outside terrain stops moving entirely.
    expect(movedPerStroke[strokes - 1]).toBe(0);
  });

  it('never changes the rendered band of a cell outside the footprint (lowering)', () => {
    const map = ledgeMap(64);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(64, CX, CY, RADIUS);
    for (let s = 0; s < STROKES; s++) {
      applySculpt(map, CX, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, BANDED);
    }
    for (let i = 0; i < map.cells.length; i++) {
      if (fp.has(i)) continue;
      expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
  });

  it('free spill on the same stroke DOES cross bands outside — the behaviour being contained', () => {
    // Sanity check on the fixture: without containment the same strokes leak
    // a new level outside the brush, so the two tests above are not vacuous.
    const map = ledgeMap(64);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(64, CX, CY, RADIUS);
    for (let s = 0; s < STROKES; s++) {
      applySculpt(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
        ...BANDED,
        spill: 'free',
      });
    }
    let crossed = 0;
    for (let i = 0; i < map.cells.length; i++) {
      if (fp.has(i)) continue;
      if (bandOf(map.cells[i]) !== bandOf(before[i])) crossed++;
    }
    expect(crossed).toBeGreaterThan(0);
  });

  it('still converges within the pass budget when the cap binds', () => {
    const map = ledgeMap(64);
    const changed = new Set<number>();
    applyBrush(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT * 4, changed, 'hard');
    const fp = footprintOf(64, CX, CY, RADIUS);
    const passes = smooth(map, changed, undefined, fp);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
  });

  it('a capped ring never bleeds the mound: banded relaxation alone never nets negative', () => {
    // THE EROSION GUARD, as a relaxation-ONLY run so no brush delta can mask
    // the leak. If clamping were uncoupled — the free side shedding its half
    // while the capped side cannot absorb it — every pass would delete
    // terrain at the ring and the map total would fall. Coupled transfers
    // make every relaxation move net >= 0 for the map total (free pairs may
    // round +1 on an odd excess; banded pairs move both sides equally, net
    // 0), so pure relaxation must never lower the sum.
    const map = ledgeMap(64);
    const fp = footprintOf(64, CX, CY, RADIUS);
    // A hand-built spire on the footprint: tall enough that its ring binds
    // the caps hard and relaxation has many passes in which to leak.
    for (const i of fp) map.cells[i] += DEFAULT_SCULPT_AMOUNT * 8;
    const sum = (m: Heightmap) => m.cells.reduce((a, b) => a + b, 0);
    const before = sum(map);
    smooth(map, new Set<number>(), fp, fp);
    expect(sum(map) - before).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: identical banded strokes give identical maps and diffs', () => {
    const a = ledgeMap(64);
    const b = ledgeMap(64);
    for (let s = 0; s < STROKES; s++) {
      const da = applySculpt(a, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, BANDED);
      const db = applySculpt(b, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, BANDED);
      expect(da).toEqual(db);
    }
    expect(a.cells).toEqual(b.cells);
  });

  it('an explicit free spill is byte-identical to the pre-#26 absent-spill path', () => {
    // The compatibility contract, extended to the new field: plugins that
    // pass no options (or no spill) must keep the unbounded relaxation they
    // were tuned against, bit for bit.
    const absent = ledgeMap(64);
    const explicit = ledgeMap(64);
    for (let s = 0; s < STROKES; s++) {
      const da = applySculpt(absent, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
        tool: 'smooth',
        profile: 'soft',
      });
      const db = applySculpt(explicit, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
        tool: 'smooth',
        profile: 'soft',
        spill: 'free',
      });
      expect(da).toEqual(db);
    }
    expect(absent.cells).toEqual(explicit.cells);
  });

  /** Max gradient excess over MAX_STEP across the whole map. */
  function maxExcess(map: Heightmap): number {
    const { size, cells } = map;
    let worst = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (x < size - 1) worst = Math.max(worst, Math.abs(cells[i] - cells[i + 1]) - MAX_STEP);
        if (y < size - 1) worst = Math.max(worst, Math.abs(cells[i] - cells[i + size]) - MAX_STEP);
      }
    }
    return worst;
  }

  /** The #12 plateau: `bands` level-fill strokes at (x, y), radius 4. */
  function stampPlateau(map: Heightmap, x: number, y: number, bands: number): void {
    for (let s = 0; s < bands; s++) {
      applySculpt(map, x, y, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    }
  }

  const SMOOTH_HARD_BANDED = { tool: 'smooth', profile: 'hard', spill: 'banded' } as const;

  it('pins the standing residual of the #12 plateau scenario: 871 units of excess', () => {
    // The STANDING RESIDUAL made concrete (see movePair's doc): a 15-band
    // stamped plateau smoothed with one banded stroke leaves the ring
    // exceeding MAX_STEP by exactly this much — 871 = 27× MAX_STEP — and
    // banded relaxation can never lower it (next test). A change to this
    // number is a change to the containment maths and must be deliberate.
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, 15);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    expect(maxExcess(map)).toBe(871);
  });

  it('banded strokes can NEVER repair the standing ring — the excess does not fall', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, 15);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    const standing = maxExcess(map);
    for (let s = 0; s < 20; s++) {
      applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    }
    expect(maxExcess(map)).toBeGreaterThanOrEqual(standing);
  });

  // The three #12 cascade scenarios, re-run banded (see the free-path
  // originals in 'smooth — cascades from stamped terrain (#12)'). The free
  // path's assertion — the gradient limit holds everywhere — is exactly what
  // banded gives up at the ring, so here the contract is: outside bands
  // untouched, and convergence stays inside the pass budget (measured: the
  // player-constructible cascades converge FASTER banded, 9 vs 67 passes,
  // because the caps stop the excess from travelling — see SMOOTH_PASS_LIMIT).
  it('#12 cascade, banded: one smooth stroke on a 15-band plateau', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, 15);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(128, 64, 64, 4);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    for (let i = 0; i < map.cells.length; i++) {
      if (!fp.has(i)) expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
  });

  it('#12 cascade, banded: a fully clamped smooth stroke still relaxes under the brush', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, 16);
    expect(heightAt(map, 64, 64)).toBe(MAX_HEIGHT);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(128, 64, 64, 4);
    const diff = applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    // The stroke still does its #12 job (relaxes SOMETHING despite the
    // clamped brush) without leaking a band outside the footprint.
    expect(diff.length).toBeGreaterThan(0);
    for (let i = 0; i < map.cells.length; i++) {
      if (!fp.has(i)) expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
  });

  it('#12 cascade, banded: converges under the pass cap on the worst plateau (8 passes)', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, 15);
    const changed = new Set<number>();
    applyBrush(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, changed, 'hard');
    const passes = smooth(map, changed, undefined, footprintOf(128, 64, 64, 4));
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    // Pinned: the caps stop the excess from travelling, so banded converges in
    // single-digit passes where the free path needed dozens on this scenario.
    // (9 on the pre-disc square footprint; 8 since the 2026-08-19 tight disc
    // rounded the plateau's corners off — re-measured, not derived.)
    expect(passes).toBe(8);
  });

  it('property: over random maps × radii × profiles, no outside cell ever changes band', () => {
    // Deterministic LCG so a failure reproduces exactly.
    let seed = 0x2f26;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let trial = 0; trial < 8; trial++) {
      const size = 48;
      const map = createHeightmap(size);
      for (let i = 0; i < map.cells.length; i++) {
        // anywhere in [MIN, MAX] — derived, so a range retune (Deep Strata
        // widened MIN_HEIGHT to −1536) keeps the property covering all of it
        map.cells[i] = (next() % (MAX_HEIGHT - MIN_HEIGHT + 1)) + MIN_HEIGHT;
      }
      for (let stroke = 0; stroke < 5; stroke++) {
        const cx = next() % size;
        const cy = next() % size;
        const radius = 1 + (next() % 4);
        const profile = next() % 2 === 0 ? 'soft' : 'hard';
        const amount = (next() % 2 === 0 ? 1 : -1) * DEFAULT_SCULPT_AMOUNT;
        const fp = footprintOf(size, cx, cy, radius);
        const before = Int16Array.from(map.cells);
        applySculpt(map, cx, cy, radius, amount, { tool: 'smooth', profile, spill: 'banded' });
        for (let i = 0; i < map.cells.length; i++) {
          if (!fp.has(i) && bandOf(map.cells[i]) !== bandOf(before[i])) {
            throw new Error(
              `trial ${trial} stroke ${stroke} (${cx},${cy}) r${radius} ${profile} ${amount}: ` +
              `cell ${i} band ${bandOf(before[i])} -> ${bandOf(map.cells[i])}`,
            );
          }
        }
      }
    }
  });
});

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
    // The ring the rounding removes vs keeps, spelled out: dx²+dy² < 12.
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

describe('the clicked-cell anchor (owner decision 2026-08-19)', () => {
  /** Wire-style options minus the relaxation, so the BRUSH contract is bare. */
  const STAMP_SOFT_ANCHORED: SculptOptions = { tool: 'stamp', profile: 'soft', anchor: 'clicked' };
  const STAMP_HARD_ANCHORED: SculptOptions = { tool: 'stamp', profile: 'hard', anchor: 'clicked' };

  /**
   * The owner's complaint as a fixture: clicking a band-6 tread whose brush
   * overlaps ground both lower (band 5) and higher (band 7). Centre at 400
   * (band 6) ⇒ a raise targets 7·64 = 448 and nothing under the brush may
   * cross it.
   */
  function unevenLedge(): { map: Heightmap; lower: number[]; higher: number[] } {
    const map = createHeightmap(32);
    map.cells.fill(6 * BAND_HEIGHT + 16); // band 6 (400)
    const lower: number[] = [];
    const higher: number[] = [];
    forEachFootprintOffset(3, (dx, dy) => {
      if (dy < -1) {
        const i = cellIndex(map, 16 + dx, 16 + dy);
        map.cells[i] = 5 * BAND_HEIGHT + 10; // band 5 (330)
        lower.push(i);
      } else if (dy > 1) {
        const i = cellIndex(map, 16 + dx, 16 + dy);
        map.cells[i] = 7 * BAND_HEIGHT + 2; // band 7 (450)
        higher.push(i);
      }
    });
    return { map, lower, higher };
  }

  it('raising never lifts ANY footprint cell past the level above the clicked cell', () => {
    const { map, higher } = unevenLedge();
    const before = Int16Array.from(map.cells);
    const target = 7 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, DEFAULT_SCULPT_AMOUNT, STAMP_SOFT_ANCHORED);

    for (let i = 0; i < map.cells.length; i++) {
      // No cell the stroke moved ends past the target...
      if (map.cells[i] !== before[i]) expect(map.cells[i]).toBeLessThanOrEqual(target);
      // ...and nothing anywhere ends above where it started unless it was
      // below the target (i.e. the periphery can never be pushed past the
      // level the player clicked).
      expect(map.cells[i]).toBeLessThanOrEqual(Math.max(before[i], target));
    }
    // The band-7 cells under the brush are byte-untouched — the exact cells
    // the pre-anchor brush used to shove toward band 8.
    for (const i of higher) expect(map.cells[i]).toBe(before[i]);
  });

  it('the periphery never ends above the centre when the ground under it started lower', () => {
    const map = createHeightmap(32);
    map.cells.fill(6 * BAND_HEIGHT); // band-aligned band 6, everywhere
    // Hold the stroke: several anchored raises. Each stroke re-anchors to the
    // centre's NEW band (the centre climbs one band per stroke), and after
    // every one of them the falloff cells trail the centre — never pass it.
    for (let s = 0; s < 4; s++) {
      applySculpt(map, 16, 16, 3, DEFAULT_SCULPT_AMOUNT, STAMP_SOFT_ANCHORED);
      const centre = heightAt(map, 16, 16);
      forEachFootprintOffset(3, (dx, dy) => {
        expect(heightAt(map, 16 + dx, 16 + dy)).toBeLessThanOrEqual(centre);
      });
    }
    expect(heightAt(map, 16, 16)).toBe((6 + 4) * BAND_HEIGHT);
  });

  it('lowering mirrors: nothing under the brush drops past the level below the clicked cell', () => {
    const { map, lower } = unevenLedge();
    const before = Int16Array.from(map.cells);
    const floor = 5 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, STAMP_SOFT_ANCHORED);

    for (let i = 0; i < map.cells.length; i++) {
      if (map.cells[i] !== before[i]) expect(map.cells[i]).toBeGreaterThanOrEqual(floor);
      expect(map.cells[i]).toBeGreaterThanOrEqual(Math.min(before[i], floor));
    }
    // The band-5 cells (330 > floor 320) may descend to the floor but the
    // ones already AT or below it would be untouched; here they move by at
    // most 10 units — never below 320.
    for (const i of lower) expect(map.cells[i]).toBeGreaterThanOrEqual(floor);
  });

  it('hard + clicked anchors the level fill to the clicked band, not the footprint minimum', () => {
    const { map, lower, higher } = unevenLedge();
    const before = Int16Array.from(map.cells);
    const target = 7 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_ANCHORED);

    // Band-5 holes rise by the full amount toward the CLICKED level — they do
    // not hold the fill back the way the surveyed ('free') fill has it.
    for (const i of lower) expect(map.cells[i]).toBe(before[i] + DEFAULT_SCULPT_AMOUNT);
    // Band-6 ground reaches the target exactly (400 + 64 caps at 448).
    expect(heightAt(map, 16, 16)).toBe(target);
    // Band-7 ground under the brush is byte-untouched.
    for (const i of higher) expect(map.cells[i]).toBe(before[i]);
  });

  // ── The anchor must survive the relaxation pass (owner bug report
  // 2026-08-19, "smooth, soft appears to be broken"). The wire options every
  // player stroke actually carries: smooth + banded + clicked. Before the fix
  // the anchored BRUSH honoured the ceiling and the relaxation immediately
  // broke it — eroding the protected higher terrace down ("it sometimes
  // resets top layers") and lifting just-raised ground past the clicked
  // level. These pin the composed stroke, not the brush pass alone. ──
  const WIRE_SMOOTH_SOFT: SculptOptions = {
    tool: 'smooth',
    profile: 'soft',
    spill: 'banded',
    anchor: 'clicked',
  };

  it('smooth+soft raising: the higher terrace under the brush survives the RELAXATION too', () => {
    const { map, higher } = unevenLedge();
    const before = Int16Array.from(map.cells);
    const target = 7 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, DEFAULT_SCULPT_AMOUNT, WIRE_SMOOTH_SOFT);

    // The band-7 cells are byte-untouched by the WHOLE stroke — brush AND
    // relaxation. This is the exact cell set the pre-fix relaxation eroded.
    for (const i of higher) expect(map.cells[i]).toBe(before[i]);
    // And nothing anywhere ends above the clicked ceiling unless it started
    // there — relaxation may no longer carry ground past the anchor.
    for (let i = 0; i < map.cells.length; i++) {
      expect(map.cells[i]).toBeLessThanOrEqual(Math.max(before[i], target));
    }
  });

  it('smooth+soft lowering mirrors: cells below the anchored floor are byte-untouched', () => {
    const { map, lower } = unevenLedge();
    // Deepen the band-5 pocket to band 4 so the fixture holds ground BELOW
    // the lowering target (band-5 floor = 320) — the mirror of `higher`.
    const deepened: number[] = [];
    for (const i of lower) {
      map.cells[i] = 4 * BAND_HEIGHT + 8; // band 4 (264), below the 320 floor
      deepened.push(i);
    }
    const before = Int16Array.from(map.cells);
    const floor = 5 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, WIRE_SMOOTH_SOFT);

    for (const i of deepened) expect(map.cells[i]).toBe(before[i]);
    for (let i = 0; i < map.cells.length; i++) {
      expect(map.cells[i]).toBeGreaterThanOrEqual(Math.min(before[i], floor));
    }
  });

  it('widening the world floor works: wall cells inside the footprint still descend', () => {
    // A pit already at MIN_HEIGHT with a wall through the footprint — the
    // owner's "make the bottom larger" situation. Lowering anchored at the
    // pit floor targets MIN_HEIGHT (one band down, clamped), so the wall
    // cells must keep moving down while the floor cells stay put.
    const map = createHeightmap(32);
    map.cells.fill(MIN_HEIGHT + 4 * BAND_HEIGHT); // wall ground, 4 bands up
    const floorCells: number[] = [];
    forEachFootprintOffset(3, (dx, dy) => {
      if (dx <= 0) {
        const i = cellIndex(map, 16 + dx, 16 + dy);
        map.cells[i] = MIN_HEIGHT;
        floorCells.push(i);
      }
    });
    const before = Int16Array.from(map.cells);

    const diff = applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, WIRE_SMOOTH_SOFT);

    // The stroke is NOT a no-op: the wall half of the footprint descended.
    expect(diff.length).toBeGreaterThan(0);
    let wallMoved = 0;
    forEachFootprintOffset(3, (dx, dy) => {
      const i = cellIndex(map, 16 + dx, 16 + dy);
      if (before[i] > MIN_HEIGHT && map.cells[i] < before[i]) wallMoved++;
    });
    expect(wallMoved).toBeGreaterThan(0);
    // And nothing anywhere is below the world floor.
    for (let i = 0; i < map.cells.length; i++) {
      expect(map.cells[i]).toBeGreaterThanOrEqual(MIN_HEIGHT);
    }
  });

  it('a footprint entirely at the world floor is a true no-op: empty diff, both profiles, both tools', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (const tool of ['stamp', 'smooth'] as const) {
        const map = createHeightmap(32);
        map.cells.fill(MIN_HEIGHT);
        const diff = applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, {
          tool,
          profile,
          spill: 'banded',
          anchor: 'clicked',
        });
        expect(diff).toEqual([]);
      }
    }
  });

  it('anchored wire options are deterministic: two identical runs, identical worlds', () => {
    const runs: Int16Array[] = [];
    for (let run = 0; run < 2; run++) {
      const map = createHeightmap(48);
      for (let i = 0; i < map.cells.length; i++) map.cells[i] = ((i * 37) % 9 - 4) * BAND_HEIGHT;
      const wire: SculptOptions = { tool: 'smooth', profile: 'soft', spill: 'banded', anchor: 'clicked' };
      applySculpt(map, 24, 24, 3, DEFAULT_SCULPT_AMOUNT, wire);
      applySculpt(map, 26, 23, 4, -DEFAULT_SCULPT_AMOUNT, wire);
      applySculpt(map, 24, 24, 2, DEFAULT_SCULPT_AMOUNT, wire);
      runs.push(Int16Array.from(map.cells));
    }
    expect(runs[0]).toEqual(runs[1]);
  });
});
