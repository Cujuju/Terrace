import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applyLevelFillBrush,
  applySculpt,
  bandOf,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  canSpreadBandTo,
  carveRange,
  cellIndex,
  cellX,
  cellY,
  createHeightmap,
  DEEP_BASALT_BANDS,
  DEEP_BASALT_DEPTH,
  DEEP_LAVA_BANDS,
  DEEP_LAVA_DEPTH,
  DEEP_OBSIDIAN_BANDS,
  DEEP_OBSIDIAN_DEPTH,
  DEEP_STRATA_BANDS,
  DEEP_STRATA_DEPTH,
  DEFAULT_SCULPT_AMOUNT,
  forEachFootprintOffset,
  heightAt,
  isValidHeight,
  isWater,
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_BAND,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  quantizeToBand,
  readSpans,
  RELAX_SLACK,
  SEA_COLUMN_BANDS,
  SEA_COLUMN_DEPTH,
  sculptDisplacementUnits,
  setColumn,
  smooth,
  SMOOTH_PASS_LIMIT,
  SMOOTH_SPREAD_CELLS,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  WORLD_UNIT_CELLS,
  type Heightmap,
  type SculptOptions,
} from '../src/index.ts';

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

function texturedMap(size: number): Heightmap {
  const map = createHeightmap(size);
  for (let i = 0; i < map.cells.length; i++) {
    map.cells[i] = ((i * 7) % 23) - 11;
  }
  return map;
}

const CEILING_BANDS = MAX_HEIGHT / BAND_HEIGHT;

function expectGradientLimitHolds(map: Heightmap): void {
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
    expect(SEA_COLUMN_DEPTH).toBe(MAX_HEIGHT);
    expect(DEEP_STRATA_DEPTH).toBe(
      DEEP_BASALT_DEPTH + DEEP_OBSIDIAN_DEPTH + DEEP_LAVA_DEPTH,
    );
    expect(MIN_HEIGHT).toBe(-(SEA_COLUMN_DEPTH + DEEP_STRATA_DEPTH));
    expect(MIN_HEIGHT).toBe(-1536);
    expect(isValidHeight(-SEA_COLUMN_DEPTH)).toBe(true);
    expect(isValidHeight(MIN_HEIGHT)).toBe(true);
    expect(isValidHeight(MIN_HEIGHT - 1)).toBe(false);
  });

  it('keeps the strata DEPTHS fixed while their band counts follow BAND_HEIGHT', () => {
    expect(SEA_COLUMN_BANDS).toBe(SEA_COLUMN_DEPTH / BAND_HEIGHT);
    expect(DEEP_BASALT_BANDS).toBe(DEEP_BASALT_DEPTH / BAND_HEIGHT);
    expect(DEEP_OBSIDIAN_BANDS).toBe(DEEP_OBSIDIAN_DEPTH / BAND_HEIGHT);
    expect(DEEP_LAVA_BANDS).toBe(DEEP_LAVA_DEPTH / BAND_HEIGHT);
    expect(DEEP_STRATA_BANDS).toBe(
      DEEP_BASALT_BANDS + DEEP_OBSIDIAN_BANDS + DEEP_LAVA_BANDS,
    );
    for (const bands of [
      SEA_COLUMN_BANDS,
      DEEP_BASALT_BANDS,
      DEEP_OBSIDIAN_BANDS,
      DEEP_LAVA_BANDS,
    ]) {
      expect(Number.isInteger(bands)).toBe(true);
    }
    expect(DEEP_BASALT_DEPTH / DEEP_LAVA_DEPTH).toBe(4);
    expect(DEEP_OBSIDIAN_DEPTH / DEEP_LAVA_DEPTH).toBe(3);
  });

  it('scales the smoothing budget with the range AND the gradient limit', () => {
    expect(SMOOTH_SPREAD_CELLS).toBe(
      Math.floor((MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP),
    );
    expect(SMOOTH_SPREAD_CELLS).toBe(160 * WORLD_UNIT_CELLS);
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
    expect(heightAt(map, 17, 16)).toBe(32);
    expect(heightAt(map, 16, 15)).toBe(32);
    expect(heightAt(map, 17, 17)).toBe(0);
    expect(heightAt(map, 18, 16)).toBe(0);
  });

  it('lowering mirrors raising exactly', () => {
    const up = createHeightmap(32);
    const down = createHeightmap(32);
    applyBrush(up, 16, 16, 3, 64, new Set());
    applyBrush(down, 16, 16, 3, -64, new Set());
    for (let i = 0; i < up.cells.length; i++) {
      expect(down.cells[i]).toBe(-up.cells[i] | 0);
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
    expect(() => applyBrush(map, 8, 8, MAX_BRUSH_RADIUS + 1, 64, new Set())).toThrow(RangeError);
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
    map.cells[0] = 512;
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
    for (const i of actuallyChanged) expect(reported.has(i)).toBe(true);
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

  it('survives a ceiling-burying stack of sculpts: clamped, invariant intact', { timeout: 30_000 }, () => {
    const STACKED_CLICKS = (MAX_HEIGHT * 6) / DEFAULT_SCULPT_AMOUNT;
    const map = createHeightmap(64);
    for (let k = 0; k < STACKED_CLICKS; k++) {
      applySculpt(map, 32, 32, 2, DEFAULT_SCULPT_AMOUNT);
    }
    expect(heightAt(map, 32, 32)).toBeLessThanOrEqual(MAX_HEIGHT);
    expectGradientLimitHolds(map);

    const player = createHeightmap(64);
    for (let k = 0; k < STACKED_CLICKS; k++) {
      applySculpt(player, 32, 32, 2, DEFAULT_SCULPT_AMOUNT, WIRE_DEFAULT_SCULPT_OPTIONS);
    }
    expect(heightAt(player, 32, 32)).toBe(MAX_HEIGHT);
  });

  it('one band-click on flat ground raises ONE crisp terrace and nothing else (the Godus contract)', () => {
    expect(DEFAULT_SCULPT_AMOUNT).toBe(MAX_STEP * WORLD_UNIT_CELLS);

    const map = createHeightmap(CHUNK_SIZE * 2);
    const centre = CHUNK_SIZE;
    const pointBrush = WORLD_UNIT_CELLS;
    applySculpt(map, centre, centre, pointBrush, DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, centre, centre)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(bandOf(heightAt(map, centre, centre))).toBe(1);
    for (let ring = pointBrush; ring <= pointBrush + WORLD_UNIT_CELLS; ring++) {
      for (const [dx, dy] of [[-ring, 0], [ring, 0], [0, -ring], [0, ring]] as const) {
        expect(bandOf(heightAt(map, centre + dx, centre + dy))).toBe(0);
      }
    }
    expectGradientLimitHolds(map);
  });
});

describe('applySculpt options — compatibility with the pre-2026-08-14 contract', () => {
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
    expect(LIBRARY_DEFAULT_SCULPT_OPTIONS).toEqual({
      tool: 'smooth',
      profile: 'soft',
      spill: 'free',
      anchor: 'free',
      targetBand: null,
      spanBand: null,
      sweepFrom: null,
    });
  });

  it('the smooth tool reproduces the old brush→smooth→diff composition exactly', () => {
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
    expect(heightAt(low, 8, 8)).toBe(MIN_HEIGHT + 1);
    expect(quantizeToBand(heightAt(low, 8, 8))).toBe(MIN_HEIGHT);
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
    expect(heightAt(map, 24 + (radius - 1), 24)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 24, 24 - (radius - 1))).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 24 + radius, 24)).toBe(0);
  });

  it('soft is unchanged: full amount at the centre, linear falloff outward', () => {
    const map = createHeightmap(48);
    applySculpt(map, 24, 24, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    expect(heightAt(map, 24, 24)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 25, 24)).toBe((DEFAULT_SCULPT_AMOUNT * 3) / 4);
    expect(heightAt(map, 26, 24)).toBe((DEFAULT_SCULPT_AMOUNT * 2) / 4);
    expect(heightAt(map, 27, 24)).toBe((DEFAULT_SCULPT_AMOUNT * 1) / 4);
    expect(heightAt(map, 28, 24)).toBe(0);
  });

  it('radius 1 makes the two profiles identical on band-aligned ground', () => {
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

const LEVEL_FILL = { tool: 'stamp', profile: 'hard' } as const;

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
    paintFootprintPlus(map, 8, 8, { n: 0, w: 1, c: 1, e: 2, s: 0 });

    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 1, 0,
                                                      1, 1, 2,
                                                      0, 1, 0]);

    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 2, 0,
                                                      2, 2, 2,
                                                      0, 2, 0]);

    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 3, 0,
                                                      3, 3, 3,
                                                      0, 3, 0]);
  });

  it('never lifts a cell THROUGH the level being filled', () => {
    const map = createHeightmap(16);
    map.cells.fill(BAND_HEIGHT);
    map.cells[cellIndex(map, 8, 8)] = BAND_HEIGHT - 1;

    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    expect(heightAt(map, 8, 8)).toBe(BAND_HEIGHT);
    expect(heightAt(map, 7, 8)).toBe(BAND_HEIGHT);
  });

  it('advances at most ONE band per stroke, whatever the amount', () => {
    const map = createHeightmap(16);
    applySculpt(map, 8, 8, 2, 4 * BAND_HEIGHT, LEVEL_FILL);
    expect(readFootprintBands3x3(map, 8, 8)).toEqual([0, 1, 0, 1, 1, 1, 0, 1, 0]);
    expect(heightAt(map, 8, 8)).toBe(BAND_HEIGHT);
  });

  it('on a FLAT footprint is exactly the old flat stamp: one band, uniformly', () => {
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

    for (let stroke = 0; stroke < 3; stroke++) {
      applySculpt(up, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      applySculpt(down, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      for (let i = 0; i < up.cells.length; i++) expect(down.cells[i]).toBe(-up.cells[i] | 0);
    }
  });

  it('clamps at the top and the bottom of the height range', () => {
    const nearTop = createHeightmap(16);
    nearTop.cells.fill(MAX_HEIGHT - 1);
    applySculpt(nearTop, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(nearTop, 8, 8)).toBe(MAX_HEIGHT);

    const atTop = createHeightmap(16);
    atTop.cells.fill(MAX_HEIGHT);
    expect(applySculpt(atTop, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL)).toEqual([]);
    expect(atTop.cells.every((h) => h === MAX_HEIGHT)).toBe(true);

    const nearFloor = createHeightmap(16);
    nearFloor.cells.fill(MIN_HEIGHT + 1);
    applySculpt(nearFloor, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(nearFloor, 8, 8)).toBe(MIN_HEIGHT + 1);
    expect(quantizeToBand(heightAt(nearFloor, 8, 8))).toBe(MIN_HEIGHT);

    const atFloor = createHeightmap(16);
    atFloor.cells.fill(MIN_HEIGHT);
    expect(applySculpt(atFloor, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL)).toEqual([]);
    expect(atFloor.cells.every((h) => h === MIN_HEIGHT)).toBe(true);
  });

  it('reports only the cells it actually moved', () => {
    const map = createHeightmap(16);
    paintFootprintPlus(map, 8, 8, { n: 0, w: 1, c: 1, e: 1, s: 1 });
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
    const map = createHeightmap(16);
    const corner = [[0, 0], [1, 0], [0, 1]] as const;
    for (const [x, y] of corner) map.cells[cellIndex(map, x, y)] = BAND_HEIGHT;
    map.cells[cellIndex(map, 1, 1)] = BAND_HEIGHT;

    applySculpt(map, 0, 0, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    for (const [x, y] of corner) expect(heightAt(map, x, y)).toBe(2 * BAND_HEIGHT);
    expect(heightAt(map, 1, 1)).toBe(BAND_HEIGHT);
  });

  it('at radius 1 snaps an off-grid cell onto the band boundary', () => {
    const map = createHeightmap(16);
    map.cells[cellIndex(map, 8, 8)] = 10;
    applySculpt(map, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(map, 8, 8)).toBe(BAND_HEIGHT);
  });

  it('lowering an off-grid cell drops it a RENDERED band, not to its own floor', () => {
    const OFF_BAND_FLOOR = 6;
    const map = createHeightmap(16);
    map.cells[cellIndex(map, 8, 8)] = BAND_HEIGHT + OFF_BAND_FLOOR;
    applySculpt(map, 8, 8, 1, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(map, 8, 8)).toBe(OFF_BAND_FLOOR);
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

    const soft = createHeightmap(16);
    const softExpected = createHeightmap(16);
    paintFootprint3x3(soft, 8, 8, bands);
    paintFootprint3x3(softExpected, 8, 8, bands);
    applySculpt(soft, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    applyBrush(softExpected, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, new Set<number>(), 'soft');
    expect(soft.cells).toEqual(softExpected.cells);

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
    const stamped = createHeightmap(64);
    const slumped = createHeightmap(64);
    const STAMP_HARD_OPTS = { tool: 'stamp', profile: 'hard' } as const;
    applySculpt(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'smooth', profile: 'hard' });

    expect(heightAt(stamped, 35, 32)).toBe(2 * DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(stamped, 36, 32)).toBe(0);
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
        expect(sculptDisplacementUnits(radius, 'stamp')).toBe(
          observedDisplacement(radius, profile, DEFAULT_SCULPT_AMOUNT),
        );
      }
    }
  });

  it('prices a lower exactly like the raise that undoes it', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
        expect(sculptDisplacementUnits(radius, 'stamp')).toBe(
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

  function stampPlateau(map: Heightmap, x: number, y: number, bands: number): void {
    for (let s = 0; s < bands; s++) {
      applySculpt(map, x, y, 4, DEFAULT_SCULPT_AMOUNT, STAMP);
    }
  }

  it('one smooth stroke fully relaxes a 15-band stamped plateau (the pass-cap repro)', () => {
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS - 1);
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('a fully clamped smooth stroke still relaxes the cliffs under the brush', () => {
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS);
    expect(heightAt(map, C, C)).toBe(MAX_HEIGHT);
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('converges across the full height range: MAX plateau beside a MIN moat', () => {
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS);
    for (let s = 0; s < 16; s++) {
      applySculpt(map, C + 8, C, 4, -DEFAULT_SCULPT_AMOUNT, STAMP);
    }
    applySculpt(map, C + 4, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('reports a convergence-proving pass count strictly below the cap', () => {
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS - 1);
    const changed = new Set<number>();
    applyBrush(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, changed, 'hard');
    const passes = smooth(map, changed);
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    expectGradientLimitHolds(map);
  });
});

describe('applySculpt — banded spill containment (issue #26)', () => {
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
  const CX = 20;
  const CY = 19;
  const RADIUS = 2;
  const STROKES = 6;

  it('never changes the rendered band of a cell outside the footprint (raising)', () => {
    const map = ledgeMap(64);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(64, CX, CY, RADIUS);
    const movedPerStroke: number[] = [];
    const strokes = 20;
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
    expect(movedPerStroke[0]).toBeGreaterThan(0);
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
    const map = ledgeMap(64);
    const fp = footprintOf(64, CX, CY, RADIUS);
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

  function stampPlateau(map: Heightmap, x: number, y: number, bands: number): void {
    for (let s = 0; s < bands; s++) {
      applySculpt(map, x, y, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    }
  }

  const SMOOTH_HARD_BANDED = { tool: 'smooth', profile: 'hard', spill: 'banded' } as const;

  it('pins the standing residual of the #12 plateau scenario: 993 units of excess', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    expect(maxExcess(map)).toBe(987);
  });

  it('banded strokes can NEVER repair the standing ring — the excess does not fall', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    const standing = maxExcess(map);
    for (let s = 0; s < 20; s++) {
      applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    }
    expect(maxExcess(map)).toBeGreaterThanOrEqual(standing);
  });

  it('#12 cascade, banded: one smooth stroke on a 15-band plateau', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(128, 64, 64, 4);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    for (let i = 0; i < map.cells.length; i++) {
      if (!fp.has(i)) expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
  });

  it('#12 cascade, banded: a fully clamped smooth stroke still relaxes under the brush', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS);
    expect(heightAt(map, 64, 64)).toBe(MAX_HEIGHT);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(128, 64, 64, 4);
    const diff = applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    expect(diff.length).toBeGreaterThan(0);
    for (let i = 0; i < map.cells.length; i++) {
      if (!fp.has(i)) expect(bandOf(map.cells[i])).toBe(bandOf(before[i]));
    }
  });

  it('#12 cascade, banded: converges under the pass cap on the worst plateau (10 passes)', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    const changed = new Set<number>();
    applyBrush(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, changed, 'hard');
    const passes = smooth(map, changed, undefined, footprintOf(128, 64, 64, 4));
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    expect(passes).toBe(12);
  });

  it('property: over random maps × radii × profiles, no outside cell ever changes band', () => {
    let seed = 0x2f26;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let trial = 0; trial < 8; trial++) {
      const size = 48;
      const map = createHeightmap(size);
      for (let i = 0; i < map.cells.length; i++) {
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
  const STAMP_SOFT_ANCHORED: SculptOptions = { tool: 'stamp', profile: 'soft', anchor: 'clicked' };
  const STAMP_HARD_ANCHORED: SculptOptions = { tool: 'stamp', profile: 'hard', anchor: 'clicked' };

  const LEDGE_MID_OFFSET = Math.floor(BAND_HEIGHT / 4);
  const LEDGE_LOW_OFFSET = Math.floor(BAND_HEIGHT / 8);
  const LEDGE_FLOOR_OFFSET = 1;

  function unevenLedge(): { map: Heightmap; lower: number[]; higher: number[] } {
    const map = createHeightmap(32);
    map.cells.fill(6 * BAND_HEIGHT + LEDGE_MID_OFFSET);
    const lower: number[] = [];
    const higher: number[] = [];
    forEachFootprintOffset(3, (dx, dy) => {
      if (dy < -1) {
        const i = cellIndex(map, 16 + dx, 16 + dy);
        map.cells[i] = 5 * BAND_HEIGHT + LEDGE_LOW_OFFSET;
        lower.push(i);
      } else if (dy > 1) {
        const i = cellIndex(map, 16 + dx, 16 + dy);
        map.cells[i] = 7 * BAND_HEIGHT + LEDGE_FLOOR_OFFSET;
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
      if (map.cells[i] !== before[i]) expect(map.cells[i]).toBeLessThanOrEqual(target);
      expect(map.cells[i]).toBeLessThanOrEqual(Math.max(before[i], target));
    }
    for (const i of higher) expect(map.cells[i]).toBe(before[i]);
  });

  it('the periphery never ends above the centre when the ground under it started lower', () => {
    const map = createHeightmap(32);
    map.cells.fill(6 * BAND_HEIGHT);
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
    for (const i of lower) expect(map.cells[i]).toBeGreaterThanOrEqual(floor);
  });

  it('hard + clicked anchors the level fill to the clicked band, not the footprint minimum', () => {
    const { map, lower, higher } = unevenLedge();
    const before = Int16Array.from(map.cells);
    const target = 7 * BAND_HEIGHT;

    applySculpt(map, 16, 16, 3, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_ANCHORED);

    for (const i of lower) expect(map.cells[i]).toBe(before[i] + DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 16, 16)).toBe(target);
    for (const i of higher) expect(map.cells[i]).toBe(before[i]);
  });

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

    for (const i of higher) expect(map.cells[i]).toBe(before[i]);
    for (let i = 0; i < map.cells.length; i++) {
      expect(map.cells[i]).toBeLessThanOrEqual(Math.max(before[i], target));
    }
  });

  it('smooth+soft lowering mirrors: cells below the anchored floor are byte-untouched', () => {
    const { map, lower } = unevenLedge();
    const deepened: number[] = [];
    for (const i of lower) {
      map.cells[i] = 4 * BAND_HEIGHT + 8;
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
    const map = createHeightmap(32);
    map.cells.fill(MIN_HEIGHT + 4 * BAND_HEIGHT);
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

    expect(diff.length).toBeGreaterThan(0);
    let wallMoved = 0;
    forEachFootprintOffset(3, (dx, dy) => {
      const i = cellIndex(map, 16 + dx, 16 + dy);
      if (before[i] > MIN_HEIGHT && map.cells[i] < before[i]) wallMoved++;
    });
    expect(wallMoved).toBeGreaterThan(0);
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
      const wire: SculptOptions = { tool: 'smooth', profile: 'soft', spill: 'banded', anchor: 'clicked', targetBand: null, spanBand: null };
      applySculpt(map, 24, 24, 3, DEFAULT_SCULPT_AMOUNT, wire);
      applySculpt(map, 26, 23, 4, -DEFAULT_SCULPT_AMOUNT, wire);
      applySculpt(map, 24, 24, 2, DEFAULT_SCULPT_AMOUNT, wire);
      runs.push(Int16Array.from(map.cells));
    }
    expect(runs[0]).toEqual(runs[1]);
  });
});

describe('a player stroke is never undone by its own relaxation (2026-08-22)', () => {
  const WORLD = 128;

  const rollingHills = (): Heightmap => {
    const map = createHeightmap(WORLD);
    for (let y = 0; y < WORLD; y++) {
      for (let x = 0; x < WORLD; x++) {
        const wx = x / WORLD_UNIT_CELLS;
        const wy = y / WORLD_UNIT_CELLS;
        map.cells[y * WORLD + x] = Math.round(
          (Math.sin(wx / 9) * Math.cos(wy / 7) * 6 + Math.sin((wx + wy) / 13) * 4) *
            BAND_HEIGHT,
        );
      }
    }
    return map;
  };

  const wireSmooth: SculptOptions = {
    tool: 'smooth',
    profile: 'soft',
    spill: 'banded',
    anchor: 'clicked',
  };

  const LADDER = [1, 2, 3, 4].map((worldUnits) => worldUnits * WORLD_UNIT_CELLS);

  for (const radius of LADDER) {
    for (const dir of [1, -1] as const) {
      const way = dir > 0 ? 'raises' : 'lowers';
      it(`one click ${way} the clicked cell by a band at radius ${radius}`, () => {
        for (let t = 0; t < 60; t++) {
          const map = rollingHills();
          const cx = 30 + ((t * 11) % 68);
          const cy = 30 + ((t * 17) % 68);
          const centre = cellIndex(map, cx, cy);
          const before = quantizeToBand(map.cells[centre]);

          applySculpt(map, cx, cy, radius, dir * DEFAULT_SCULPT_AMOUNT, wireSmooth);

          const after = quantizeToBand(map.cells[centre]);
          expect(after).toBe(before + dir * BAND_HEIGHT);
        }
      });
    }
  }

  it('relaxation never carries the CLICKED cell back past the brush', () => {
    for (const dir of [1, -1] as const) {
      for (const radius of LADDER) {
        const brushed = rollingHills();
        const relaxed = rollingHills();
        const cx = 61;
        const cy = 47;
        const centre = cellIndex(brushed, cx, cy);
        const amount = dir * DEFAULT_SCULPT_AMOUNT;
        applySculpt(brushed, cx, cy, radius, amount, { ...wireSmooth, tool: 'stamp' });
        applySculpt(relaxed, cx, cy, radius, amount, wireSmooth);

        if (dir > 0) {
          expect(relaxed.cells[centre]).toBeGreaterThanOrEqual(brushed.cells[centre]);
        } else {
          expect(relaxed.cells[centre]).toBeLessThanOrEqual(brushed.cells[centre]);
        }
      }
    }
  });

  it('still spills beyond its footprint — smooth has not become stamp', () => {
    for (const radius of LADDER) {
      const map = rollingHills();
      const before = Int16Array.from(map.cells);
      const cx = 61;
      const cy = 47;
      const footprint = new Set<number>();
      forEachFootprintOffset(radius, (dx, dy) => {
        footprint.add(cellIndex(map, cx + dx, cy + dy));
      });

      applySculpt(map, cx, cy, radius, DEFAULT_SCULPT_AMOUNT, wireSmooth);

      let movedOutside = 0;
      for (let i = 0; i < map.cells.length; i++) {
        if (map.cells[i] !== before[i] && !footprint.has(i)) movedOutside++;
      }
      expect(movedOutside).toBeGreaterThan(0);
    }
  });
});

function mapWithPlateau(
  size: number,
  height: number,
  blockHeight: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): ReturnType<typeof createHeightmap> {
  const map = createHeightmap(size);
  map.cells.fill(height);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) map.cells[cellIndex(map, x, y)] = blockHeight;
  }
  return map;
}

describe('canSpreadBandTo — the drag anchor’s adjacency rule', () => {
  const BAND = 3;
  const HIGH = BAND * BAND_HEIGHT;

  it('is true beside ground already at the band, in all eight directions', () => {
    for (const [dx, dy] of [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0], [1, 0],
      [-1, 1], [0, 1], [1, 1],
    ] as const) {
      const map = createHeightmap(16);
      map.cells.fill(0);
      map.cells[cellIndex(map, 8 + dx, 8 + dy)] = HIGH;
      expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(true);
    }
  });

  it('is true beside ground ABOVE the band — a lip may spread off a taller shelf', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    map.cells[cellIndex(map, 9, 8)] = HIGH + BAND_HEIGHT * 4;
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(true);
  });

  it('is false in open ground — a forged band conjures no height', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(false);
  });

  it('is false two cells away — the band creeps one cell at a time', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    map.cells[cellIndex(map, 10, 8)] = HIGH;
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(false);
    expect(canSpreadBandTo(map, 9, 8, BAND)).toBe(true);
  });

  it('ignores the cell’s OWN height — adjacency is about neighbours', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    map.cells[cellIndex(map, 8, 8)] = HIGH;
    expect(canSpreadBandTo(map, 8, 8, BAND)).toBe(false);
  });

  it('treats off-map neighbours as absent — the world border holds nothing up', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    expect(canSpreadBandTo(map, 0, 0, BAND)).toBe(false);
    map.cells[cellIndex(map, 1, 1)] = HIGH;
    expect(canSpreadBandTo(map, 0, 0, BAND)).toBe(true);
  });
});

describe('applySculpt with the drag anchor — a band extends sideways', () => {
  const BAND = 3;
  const HIGH = BAND * BAND_HEIGHT;
  const DRAG = { tool: 'stamp', profile: 'hard', spill: 'banded', anchor: 'band' } as const;

  it('pulls the grabbed band onto the cell beside it, and stops AT it', () => {
    const map = mapWithPlateau(16, 0, HIGH, 0, 0, 7, 15);
    const diff = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(diff.length).toBe(1);
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(HIGH);
    const again = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(again).toEqual([]);
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(HIGH);
  });

  it('is a NO-OP on a cell that touches no such ground — the anti-cheat rule', () => {
    const map = createHeightmap(16);
    map.cells.fill(0);
    const before = [...map.cells];
    const diff = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(diff).toEqual([]);
    expect([...map.cells]).toEqual(before);
  });

  it('never touches ground already at or above the grabbed band', () => {
    const map = mapWithPlateau(16, 0, HIGH, 0, 0, 7, 15);
    const tall = (BAND + 4) * BAND_HEIGHT;
    map.cells[cellIndex(map, 8, 8)] = tall;
    const diff = applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: BAND,
    });
    expect(diff).toEqual([]);
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(tall);
  });

  it('targets the GRABBED band, not one band off the cell under the cursor', () => {
    const grabbed = 6;
    const map = createHeightmap(16);
    map.cells.fill(0);
    for (let y = 0; y < 16; y++) map.cells[cellIndex(map, 7, y)] = grabbed * BAND_HEIGHT;
    applySculpt(map, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG,
      targetBand: grabbed,
    });
    expect(map.cells[cellIndex(map, 8, 8)]).toBe(grabbed * BAND_HEIGHT);

    const clicked = createHeightmap(16);
    clicked.cells.fill(0);
    for (let y = 0; y < 16; y++) clicked.cells[cellIndex(clicked, 7, y)] = grabbed * BAND_HEIGHT;
    for (let i = 0; i < 20; i++) {
      applySculpt(clicked, 8, 8, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
        tool: 'stamp', profile: 'hard', spill: 'banded', anchor: 'clicked',
      });
    }
    expect(bandOf(clicked.cells[cellIndex(clicked, 8, 8)]!)).toBeGreaterThan(grabbed);
  });

  it('walks: each intent’s result is what makes the next one legal', () => {
    const map = mapWithPlateau(24, 0, HIGH, 0, 0, 7, 23);
    for (let x = 8; x < 14; x++) {
      applySculpt(map, x, 12, MIN_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, {
        ...DRAG,
        targetBand: BAND,
      });
      expect(map.cells[cellIndex(map, x, 12)]).toBe(HIGH);
      expect(map.cells[cellIndex(map, x + 1, 12)]).toBe(0);
    }
  });
});

describe('relaxation conserves height exactly (issue #108)', () => {
  function cliffMap(size: number, height: number): Heightmap {
    const map = createHeightmap(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size / 2; x++) {
        map.cells[cellIndex(map, x, y)] = height;
      }
    }
    return map;
  }

  function cliffSeed(map: Heightmap, height: number): Set<number> {
    const seed = new Set<number>();
    for (let i = 0; i < map.cells.length; i++) {
      if (map.cells[i] === height) seed.add(i);
    }
    return seed;
  }

  function spireMap(size: number): Heightmap {
    const map = createHeightmap(size);
    map.cells[cellIndex(map, size >> 1, size >> 1)] = MAX_HEIGHT;
    return map;
  }

  function mapTotal(map: Heightmap): number {
    let total = 0;
    for (let i = 0; i < map.cells.length; i++) total += map.cells[i]!;
    return total;
  }

  const CLIFF_HEIGHTS = [100, 401, 1000];

  const CONVERGING_CLIFF_HEIGHTS = [100, 401];

  const CLIFF_TIMEOUT_MS = 30_000;

  for (const height of CLIFF_HEIGHTS) {
    it(`invents nothing relaxing a ${height}-unit cliff on 128x128`, { timeout: CLIFF_TIMEOUT_MS }, () => {
      const map = cliffMap(128, height);
      const before = mapTotal(map);
      const seed = cliffSeed(map, height);
      smooth(map, new Set(seed), seed);
      expect(mapTotal(map)).toBe(before);
    });
  }

  for (const height of CONVERGING_CLIFF_HEIGHTS) {
    it(`converges relaxing a ${height}-unit cliff on 128x128`, { timeout: CLIFF_TIMEOUT_MS }, () => {
      const map = cliffMap(128, height);
      const seed = cliffSeed(map, height);
      const passes = smooth(map, new Set(seed), seed);
      expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    });
  }

  it('invents nothing relaxing a full-height spire', () => {
    const map = spireMap(128);
    const before = mapTotal(map);
    const seed = new Set([cellIndex(map, 64, 64)]);
    smooth(map, new Set(seed), seed);
    expect(mapTotal(map)).toBe(before);
  });

  it('converges relaxing a full-height spire', () => {
    const map = spireMap(128);
    const seed = new Set([cellIndex(map, 64, 64)]);
    expect(smooth(map, new Set(seed), seed)).toBeLessThan(SMOOTH_PASS_LIMIT);
  });

  it('leaves every pair inside the gradient limit plus the slack', { timeout: CLIFF_TIMEOUT_MS }, () => {
    for (const height of CONVERGING_CLIFF_HEIGHTS) {
      const map = cliffMap(128, height);
      const seed = cliffSeed(map, height);
      smooth(map, new Set(seed), seed);
      expectGradientLimitHolds(map);
    }
  });

  it('runs out of pass budget on a 1000-unit cliff — the known boundary', { timeout: CLIFF_TIMEOUT_MS }, () => {
    const map = cliffMap(128, 1000);
    const seed = cliffSeed(map, 1000);
    expect(smooth(map, new Set(seed), seed)).toBe(SMOOTH_PASS_LIMIT);
  });

  it('is deterministic: identical input, identical output', { timeout: CLIFF_TIMEOUT_MS }, () => {
    const a = cliffMap(128, 401);
    const b = cliffMap(128, 401);
    const seedA = cliffSeed(a, 401);
    const seedB = cliffSeed(b, 401);
    const passesA = smooth(a, new Set(seedA), seedA);
    const passesB = smooth(b, new Set(seedB), seedB);
    expect(passesA).toBe(passesB);
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
  });

  function genesisTerraces(size: number): Heightmap {
    const map = createHeightmap(size);
    const LATTICE_CELLS = 16;
    const BAND_SPREAD = 7;
    const LOWEST_BAND = -2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = Math.floor(x / LATTICE_CELLS);
        const gy = Math.floor(y / LATTICE_CELLS);
        let h = (gx * 73856093) ^ (gy * 19349663);
        h = (h ^ (h >>> 13)) >>> 0;
        map.cells[cellIndex(map, x, y)] = ((h % BAND_SPREAD) + LOWEST_BAND) * BAND_HEIGHT;
      }
    }
    return map;
  }

  function brushFootprint(map: Heightmap, cx: number, cy: number, radius: number): Set<number> {
    const cells = new Set<number>();
    forEachFootprintOffset(radius, (dx, dy) => {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= map.size || y >= map.size) return;
      cells.add(cellIndex(map, x, y));
    });
    return cells;
  }

  function mapVolume(map: Heightmap): number {
    let volume = 0;
    for (let y = 0; y < map.size; y++) {
      for (let x = 0; x < map.size; x++) {
        for (const span of readSpans(map, x, y)) volume += span.ceiling - span.floor;
      }
    }
    return volume;
  }

  const TERRACE_SIZE = 96;
  const TERRACE_CENTRE = 48;

  it('the PLAYER smooth tool on genesis terraces: real cascade, pinned', () => {
    const map = genesisTerraces(TERRACE_SIZE);
    const before = Int16Array.from(map.cells);
    const PLAYER_SMOOTH: SculptOptions = { ...WIRE_DEFAULT_SCULPT_OPTIONS, tool: 'smooth' };

    const diff = applySculpt(
      map,
      TERRACE_CENTRE,
      TERRACE_CENTRE,
      4,
      DEFAULT_SCULPT_AMOUNT,
      PLAYER_SMOOTH,
    );
    let moved = 0;
    for (let i = 0; i < map.cells.length; i++) {
      if (map.cells[i] !== before[i]) moved++;
    }
    expect(diff.length).toBe(37);
    expect(moved).toBe(37);

    const counts = [diff.length];
    for (let stroke = 0; stroke < 3; stroke++) {
      counts.push(
        applySculpt(map, TERRACE_CENTRE, TERRACE_CENTRE, 4, DEFAULT_SCULPT_AMOUNT, PLAYER_SMOOTH)
          .length,
      );
    }
    expect(counts).toEqual([37, 58, 74, 94]);
  });

  it('the relaxation pass conserves height exactly on the FREE path', () => {
    const map = genesisTerraces(TERRACE_SIZE);
    const before = mapTotal(map);
    const seed = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const passes = smooth(map, new Set(), seed);
    expect(passes).toBeGreaterThan(0);
    expect(mapTotal(map)).toBe(before);
  });

  it('the relaxation pass conserves height exactly on the BANDED path', () => {
    const map = genesisTerraces(TERRACE_SIZE);
    const before = mapTotal(map);
    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const passes = smooth(map, new Set(), footprint, footprint);
    expect(passes).toBeGreaterThan(0);
    expect(mapTotal(map)).toBe(before);
  });

  it('the relaxation pass conserves height exactly on the ANCHORED path', () => {
    const map = genesisTerraces(TERRACE_SIZE);
    const before = mapTotal(map);
    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const anchorBounds = new Map<number, { lo: number; hi: number }>();
    for (const i of footprint) {
      const h = map.cells[i]!;
      anchorBounds.set(i, { lo: h - BAND_HEIGHT, hi: h + BAND_HEIGHT });
    }
    const passes = smooth(map, new Set(), footprint, footprint, anchorBounds);
    expect(passes).toBeGreaterThan(0);
    expect(mapTotal(map)).toBe(before);
  });

  it('the LAYERED path conserves SOLID VOLUME; its cells-sum is not a conserved quantity', () => {
    const ROOF_GAP_BANDS = 8;
    const map = genesisTerraces(TERRACE_SIZE);
    for (let y = 40; y < 56; y++) {
      for (let x = 40; x < 56; x++) {
        const floorHeight = map.cells[cellIndex(map, x, y)]!;
        setColumn(map, x, y, [
          { floor: BEDROCK_FLOOR, ceiling: floorHeight },
          {
            floor: floorHeight + ROOF_GAP_BANDS * BAND_HEIGHT,
            ceiling: floorHeight + (ROOF_GAP_BANDS + 1) * BAND_HEIGHT,
          },
        ]);
      }
    }
    const volumeBefore = mapVolume(map);
    const cellsBefore = mapTotal(map);
    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const passes = smooth(map, new Set(), footprint, footprint);
    expect(passes).toBeGreaterThan(0);
    expect(mapVolume(map)).toBe(volumeBefore);
    expect(mapTotal(map) - cellsBefore).toBe(-1408);
  });

  it('pins the free-spill peak: 384 library-default clicks build a hill of 87', () => {
    const STACKED_CLICKS = (MAX_HEIGHT * 6) / DEFAULT_SCULPT_AMOUNT;
    const map = createHeightmap(64);
    for (let k = 0; k < STACKED_CLICKS; k++) {
      applySculpt(map, 32, 32, 2, DEFAULT_SCULPT_AMOUNT);
    }
    expect(heightAt(map, 32, 32)).toBe(87);
    expect(mapTotal(map)).toBe(18_432);
  });

  it('never moves a pair APART when a span cap is already violated (the movePair guard)', () => {
    const map = createHeightmap(16);
    const UNDRAWN_FLOOR = 10;
    const UNDRAWN_CEILING = 14;
    setColumn(map, 8, 8, [
      { floor: BEDROCK_FLOOR, ceiling: -100 },
      { floor: UNDRAWN_FLOOR, ceiling: UNDRAWN_CEILING },
    ]);
    const layered = cellIndex(map, 8, 8);
    const neighbour = cellIndex(map, 9, 8);
    const before = Int16Array.from(map.cells);
    const seed = new Set([layered, neighbour]);

    smooth(map, new Set(), seed);

    expect(map.cells[layered]).toBe(UNDRAWN_CEILING);
    expect(Array.from(map.cells)).toEqual(Array.from(before));
  });

  it('invents nothing scouring a head out of steep ground (issue #239)', () => {
    const map = createHeightmap(128);
    for (let i = 0; i < map.cells.length; i++) map.cells[i] = 512;
    const centre = cellIndex(map, 64, 64);
    map.cells[centre] = 512 - 64;
    const before = mapTotal(map);
    const seed = new Set([centre]);
    smooth(map, new Set(seed), seed);
    expect(mapTotal(map)).toBe(before);
    expect(map.cells[centre]!).toBeLessThan(512);
  });
});
describe('smooth builds the layer view only where the sweep meets a layered column', () => {
  const SIZE = 64;
  const GROUND_BAND = 10;
  const CARVED_X = 1;
  const CARVED_Y = 1;
  const CARVE_FLOOR_BAND = 2;
  const CARVE_ROOF_BAND = 6;
  const FAR_X = 48;
  const FAR_Y = 48;
  const STROKE_RADIUS = 8;
  const SMOOTH_STROKE: SculptOptions = {
    tool: 'smooth',
    profile: 'soft',
    spill: 'banded',
    anchor: 'clicked',
  };

  function flatWorld(carved: boolean): Heightmap {
    const map = createHeightmap(SIZE);
    map.cells.fill(GROUND_BAND * BAND_HEIGHT);
    if (carved) {
      carveRange(
        map,
        CARVED_X,
        CARVED_Y,
        CARVE_FLOOR_BAND * BAND_HEIGHT,
        CARVE_ROOF_BAND * BAND_HEIGHT,
      );
    }
    return map;
  }

  function countGridCopies(map: Heightmap): () => number {
    let copies = 0;
    const real = map.cells.slice.bind(map.cells);
    Object.defineProperty(map.cells, 'slice', {
      configurable: true,
      value: (...args: readonly number[]): Int16Array => {
        copies++;
        return real(...args);
      },
    });
    return () => copies;
  }

  it('a carve in the far corner costs a distant stroke nothing, and changes nothing', () => {
    const carved = flatWorld(true);
    expect(carved.columnSpans.size).toBe(1);
    const copies = countGridCopies(carved);
    const carvedDiff = applySculpt(carved, FAR_X, FAR_Y, STROKE_RADIUS, -DEFAULT_SCULPT_AMOUNT, SMOOTH_STROKE);
    expect(copies()).toBe(0);

    const plain = flatWorld(false);
    const plainDiff = applySculpt(plain, FAR_X, FAR_Y, STROKE_RADIUS, -DEFAULT_SCULPT_AMOUNT, SMOOTH_STROKE);
    expect(carvedDiff).toEqual(plainDiff);
    expect(carvedDiff.length).toBeGreaterThan(0);
  });

  it('a stroke whose sweep does reach the carved column still relaxes a view', () => {
    const carved = flatWorld(true);
    const copies = countGridCopies(carved);
    applySculpt(carved, CARVED_X + STROKE_RADIUS, CARVED_Y + STROKE_RADIUS, STROKE_RADIUS, -DEFAULT_SCULPT_AMOUNT, SMOOTH_STROKE);
    expect(copies()).toBe(1);
  });
});

describe('applySculpt — a carve walks inward from a cliff face (2026-09-02)', () => {
  const SIZE = 32;
  const GROUND_BAND = 2;
  const CLIFF_BAND = 10;
  const FACE_X = 10;
  const ROW = 16;
  const LIP_BAND = GROUND_BAND + 1;
  const CELLS_INWARD = 5;

  it('opens the grasped band, so the next pick inside names the same band and the cut continues', () => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        map.cells[cellIndex(map, x, y)] = (x >= FACE_X ? CLIFF_BAND : GROUND_BAND) * BAND_HEIGHT;
      }
    }
    for (let x = FACE_X; x < FACE_X + CELLS_INWARD; x++) {
      const diff = applySculpt(map, x, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'carve',
        spanBand: LIP_BAND,
      });
      expect(diff.length, `cut at x=${x}`).toBe(1);
      const [floor, roof] = readSpans(map, x, ROW);
      expect(floor!.ceiling).toBe(GROUND_BAND * BAND_HEIGHT);
      expect(roof!.floor).toBe((LIP_BAND + 1) * BAND_HEIGHT);
      expect(Math.ceil((roof!.floor - BAND_HEIGHT) / BAND_HEIGHT)).toBe(LIP_BAND);
    }
  });
});

describe('applySculpt — carve grasped at the bottom of the world', () => {
  const SIZE = 32;
  const PIT_X = 10;
  const PIT_Y = 10;
  const RADIUS = 2;

  it('refuses the whole stroke rather than cutting a column off its bedrock', () => {
    const map = createHeightmap(SIZE);
    const strokes = Math.ceil((0 - MIN_HEIGHT) / DEFAULT_SCULPT_AMOUNT);
    for (let n = 0; n < strokes; n++) {
      applySculpt(map, PIT_X, PIT_Y, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'stamp',
        profile: 'hard',
      });
    }
    expect(heightAt(map, PIT_X, PIT_Y)).toBe(MIN_HEIGHT + 1);

    const before = Int16Array.from(map.cells);
    const diff = applySculpt(map, PIT_X, PIT_Y, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: MIN_BAND,
    });

    expect(diff).toEqual([]);
    expect(map.cells).toEqual(before);
    expect(map.columnSpans.size).toBe(0);
  });
});

describe('a soft drag bites its rim at the disc diagonals too (issue #152)', () => {
  const SIZE = 64;
  const PLATEAU_X = 40;
  const TARGET_BAND = 1;
  const RADIUS = 4;
  const CX = 37;
  const CY = 17;
  const BOUNDARY_DX = -2;
  const BOUNDARY_DY = 2;

  it('leaves a refused boundary cell bitten rather than filling it as an enclave', () => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = PLATEAU_X; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = BAND_HEIGHT;
    }

    applySculpt(map, CX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'soft',
      targetBand: TARGET_BAND,
    });

    expect(heightAt(map, CX, CY)).toBe(BAND_HEIGHT);
    expect(heightAt(map, CX + BOUNDARY_DX, CY + BOUNDARY_DY)).toBe(0);
  });
});

describe('a pull carries the one level under it and no further', () => {
  const SIZE = 64;
  const TREAD_CELLS = 2;
  const TOP_BAND = 3;
  const STAIR_X = 20;
  const CY = 32;
  const RADIUS = 2;

  const bandAtX = (x: number): number =>
    x < STAIR_X ? TOP_BAND : Math.max(0, TOP_BAND - (Math.floor((x - STAIR_X) / TREAD_CELLS) + 1));

  it('pushes the step below the grabbed band, and leaves the one under that', () => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = bandAtX(x) * BAND_HEIGHT;
    }

    applySculpt(map, STAIR_X, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'hard',
      targetBand: TOP_BAND,
    });

    expect(bandOf(heightAt(map, STAIR_X, CY))).toBe(TOP_BAND);
    expect(bandOf(heightAt(map, STAIR_X + TREAD_CELLS, CY))).toBe(TOP_BAND - 1);
    expect(bandOf(heightAt(map, STAIR_X + 2 * TREAD_CELLS - 1, CY))).toBe(TOP_BAND - 2);
    expect(bandOf(heightAt(map, STAIR_X + 2 * TREAD_CELLS, CY))).toBe(TOP_BAND - 3);
  });
});

describe('a drag-lower on a tall face is cut back at the grabbed band (2026-09-02)', () => {
  const CAP_BAND = 5;
  const PLAIN_BAND = 0;
  const RADIUS = 4;
  const SIZE = 32;
  const CX = 16;
  const CY = 16;
  const POLE_REACH = 3;
  const DRAG_LOWER = { tool: 'drag', profile: 'hard', anchor: 'band' } as const;

  const poleOnPlain = (): Heightmap => {
    const map = createHeightmap(SIZE);
    for (let y = CY - POLE_REACH; y <= CY + POLE_REACH; y++) {
      for (let x = CX - POLE_REACH; x <= CX + POLE_REACH; x++) {
        map.cells[cellIndex(map, x, y)] = CAP_BAND * BAND_HEIGHT;
      }
    }
    return map;
  };
  const pullIn = (map: Heightmap, band: number): void => {
    applySculpt(map, CX + POLE_REACH, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      ...DRAG_LOWER,
      targetBand: band,
    });
  };
  const eastEdgeBand = (map: Heightmap): number =>
    bandOf(heightAt(map, CX + POLE_REACH, CY));

  it('grabbing a band below the cap cuts the face back to the band beneath the grab', () => {
    for (let grab = CAP_BAND - 1; grab > PLAIN_BAND; grab--) {
      const map = poleOnPlain();
      pullIn(map, grab);
      expect(eastEdgeBand(map)).toBe(grab - 1);
      expect(heightAt(map, CX + POLE_REACH, CY)).toBe((grab - 1) * BAND_HEIGHT);
    }
  });

  it('grabbing the cap takes off one band only — never the band below (owner 2026-09-05)', () => {
    const map = poleOnPlain();
    pullIn(map, CAP_BAND);
    expect(eastEdgeBand(map)).toBe(CAP_BAND - 1);
    expect(heightAt(map, CX + POLE_REACH, CY)).toBe((CAP_BAND - 1) * BAND_HEIGHT);
  });

  it('the cut sweeps the footprint at the grabbed band and stops at its edge', () => {
    const map = poleOnPlain();
    const grab = 3;
    pullIn(map, grab);
    for (let x = CX; x <= CX + POLE_REACH; x++) {
      expect(bandOf(heightAt(map, x, CY))).toBe(grab - 1);
    }
    expect(bandOf(heightAt(map, CX - 1, CY))).toBe(CAP_BAND);
  });
});

describe('a lower seed on a plateau interior leaves a lip a lower pull can widen (2026-09-05)', () => {
  const SIZE = 32;
  const PLATEAU_BAND = 4;
  const CX = 16;
  const CY = 16;
  const RADIUS = 2;
  const LOWER_SEED = { tool: 'stamp', profile: 'hard' } as const;
  const DRAG_LOWER = { tool: 'drag', profile: 'hard', anchor: 'band' } as const;

  it('digs one band at the cursor, then a lower drag grabbing the old band eats the rim', () => {
    const map = createHeightmap(SIZE);
    map.cells.fill(PLATEAU_BAND * BAND_HEIGHT);

    applySculpt(map, CX, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, LOWER_SEED);
    const before = PLATEAU_BAND;
    const after = bandOf(heightAt(map, CX, CY));
    expect(after).toBe(before - 1);

    const rimX = CX + RADIUS;
    expect(bandOf(heightAt(map, rimX, CY))).toBe(before);

    applySculpt(map, CX + 1, CY, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      ...DRAG_LOWER,
      targetBand: before,
    });
    expect(bandOf(heightAt(map, rimX, CY))).toBe(after);
    expect(bandOf(heightAt(map, CX + RADIUS + 3, CY))).toBe(before);
  });
});

describe('a drag sweeps its footprint along the cursor path — no gaps on a flick (2026-09-05)', () => {
  const SIZE = 64;
  const PLAIN_BAND = 1;
  const LIP_BAND = 3;
  const CY = 32;
  const LIP_X = 20;
  const RADIUS = 2;
  const FLICK_CELLS = 12;
  const PULL = { tool: 'drag', profile: 'hard', anchor: 'band', targetBand: LIP_BAND } as const;

  const plateauWithLip = (): Heightmap => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        map.cells[cellIndex(map, x, y)] = (x <= LIP_X ? LIP_BAND : PLAIN_BAND) * BAND_HEIGHT;
      }
    }
    return map;
  };
  const toX = LIP_X + FLICK_CELLS;

  it('a point disc landing clear of the lip fills nothing — the gap the sweep exists to close', () => {
    const map = plateauWithLip();
    const diff = applySculpt(map, toX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, PULL);
    expect(diff).toHaveLength(0);
  });

  it('the same cursor cell swept from the lip fills every cell of the path to the grabbed band', () => {
    const map = plateauWithLip();
    applySculpt(map, toX, CY, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      ...PULL,
      sweepFrom: { x: LIP_X, y: CY },
    });
    for (let x = LIP_X; x <= toX; x++) {
      expect(bandOf(heightAt(map, x, CY))).toBe(LIP_BAND);
    }
    expect(bandOf(heightAt(map, toX + RADIUS, CY))).toBe(PLAIN_BAND);
  });
});
