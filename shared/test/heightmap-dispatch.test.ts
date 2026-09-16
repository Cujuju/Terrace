import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applySculpt,
  CARVE_DEFAULT_DEPTH_BANDS,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  forEachFootprintOffset,
  heightAt,
  LIBRARY_DEFAULT_SCULPT_OPTIONS,
  LIBRARY_SCULPT_TOOL,
  CHUNK_SIZE,
  MAX_HEIGHT,
  MAX_STEP,
  RELAX_SLACK,
  SCULPT_TOOLS,
  smooth,
  smoothCascadeReachCells,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  WORLD_UNIT_CELLS,
} from '../src/index.ts';
import {
  footprintOf,
  texturedMap,
  expectGradientLimitHolds,
} from './support/heightmapFixtures.ts';

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

  it('a smooth click on flat ground changes nothing: melt deposits no material', () => {
    expect(DEFAULT_SCULPT_AMOUNT).toBe(MAX_STEP * WORLD_UNIT_CELLS);

    const map = createHeightmap(CHUNK_SIZE * 2);
    const centre = CHUNK_SIZE;
    const pointBrush = WORLD_UNIT_CELLS;
    const diff = applySculpt(map, centre, centre, pointBrush, DEFAULT_SCULPT_AMOUNT, {
      tool: 'smooth',
    });
    expect(diff).toEqual([]);
    expect(heightAt(map, centre, centre)).toBe(0);
    for (let ring = pointBrush; ring <= pointBrush + WORLD_UNIT_CELLS; ring++) {
      for (const [dx, dy] of [[-ring, 0], [ring, 0], [0, -ring], [0, ring]] as const) {
        expect(heightAt(map, centre + dx, centre + dy)).toBe(0);
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

  it('an ABSENT options argument is byte-identical to explicit settle+soft', () => {
    const legacy = createHeightmap(64);
    const explicit = createHeightmap(64);

    for (const [x, y, r, amt] of OPS) {
      const legacyDiff = applySculpt(legacy, x, y, r, amt);
      const explicitDiff = applySculpt(explicit, x, y, r, amt, {
        tool: LIBRARY_SCULPT_TOOL,
        profile: 'soft',
        spill: 'free',
        anchor: 'free',
      });
      expect(legacyDiff).toEqual(explicitDiff);
      expect(legacy.cells).toEqual(explicit.cells);
    }
  });

  it('the library default is settle+soft, NOT the wire default and NOT the player melt', () => {
    expect(LIBRARY_SCULPT_TOOL).toBe('settle');
    expect(SCULPT_TOOLS).not.toContain(LIBRARY_SCULPT_TOOL);
    expect(LIBRARY_DEFAULT_SCULPT_OPTIONS).toEqual({
      tool: 'settle',
      depthBands: CARVE_DEFAULT_DEPTH_BANDS,
      profile: 'soft',
      spill: 'free',
      anchor: 'free',
      targetBand: null,
      spanBand: null,
      sweepFrom: null,
      smoothLambda: 50,
    });
  });

  it('settle deposits the soft brush and then relaxes it; smooth does neither', () => {
    const settled = createHeightmap(64);
    const melted = createHeightmap(64);
    const deposited = createHeightmap(64);

    const RADIUS = 5;
    const AMOUNT = DEFAULT_SCULPT_AMOUNT * 4;
    const settleDiff = applySculpt(settled, 32, 32, RADIUS, AMOUNT, {
      tool: LIBRARY_SCULPT_TOOL,
      profile: 'soft',
      spill: 'banded',
    });
    const meltDiff = applySculpt(melted, 32, 32, RADIUS, AMOUNT, {
      tool: 'smooth',
      profile: 'soft',
      spill: 'banded',
    });
    applyBrush(deposited, 32, 32, RADIUS, AMOUNT, new Set(), 'soft');

    expect(meltDiff).toEqual([]);
    expect(settleDiff.length).toBeGreaterThan(0);
    expect(heightAt(settled, 32, 32)).toBeGreaterThan(0);
    expect(heightAt(deposited, 32, 32)).toBe(AMOUNT);
    expect(heightAt(settled, 32, 32)).toBeLessThan(heightAt(deposited, 32, 32));
    for (const i of footprintOf(64, 32, 32, RADIUS)) {
      const x = i % 64;
      const y = (i - x) / 64;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        if (!footprintOf(64, 32, 32, RADIUS).has((y + dy) * 64 + x + dx)) continue;
        expect(Math.abs(heightAt(settled, x + dx, y + dy) - heightAt(settled, x, y)))
          .toBeLessThanOrEqual(MAX_STEP + RELAX_SLACK);
      }
    }
  });

  it('the smooth tool applies relaxation alone, with no brush deposit', () => {
    const viaOptions = texturedMap(48);
    const viaDirect = texturedMap(48);

    for (const [x, y, r, amt] of [[24, 24, 3, 64], [24, 25, 1, -64]] as const) {
      const diff = applySculpt(viaOptions, x, y, r, amt, { tool: 'smooth', profile: 'soft' });

      const seed = new Set<number>();
      forEachFootprintOffset(r, (dx, dy) => {
        seed.add(cellIndex(viaDirect, x + dx, y + dy));
      });
      const changed = new Set<number>();
      smooth(viaDirect, changed, seed, undefined, undefined, null, smoothCascadeReachCells(r));
      const expected = Array.from(changed)
        .sort((a, b) => a - b)
        .map((i) => ({ x: i % 48, y: (i - (i % 48)) / 48, h: viaDirect.cells[i] }));

      expect(diff).toEqual(expected);
      expect(viaOptions.cells).toEqual(viaDirect.cells);
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
