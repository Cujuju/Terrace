import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applyLevelFillBrush,
  applySculpt,
  bandLevelHeight,
  bandOf,
  BAND_HEIGHT,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  forEachFootprintOffset,
  heightAt,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MIN_HEIGHT,
  quantizeToBand,
  smooth,
} from '../src/index.ts';
import {
  footprintOf,
  texturedMap,
  LEVEL_FILL,
  paintFootprint3x3,
  paintFootprintPlus,
  readDrawnFootprint3x3,
} from './support/heightmapFixtures.ts';

describe('applySculpt — the level-fill brush (stamp + hard)', () => {
  it('fills the LOWEST band flat before it starts the next one', () => {
    const map = createHeightmap(16);
    paintFootprintPlus(map, 8, 8, { n: 0, w: 2, c: 2, e: 3, s: 0 });

    // Painted raw levels read as drawn bands {-1, 1, 1, 2, -1}; each stroke
    // fills the lowest drawn band flat (sea cells land on the shore first).
    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readDrawnFootprint3x3(map, 8, 8)).toEqual([-1, 0, -1,
                                                      1, 1, 2,
                                                      -1, 0, -1]);

    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readDrawnFootprint3x3(map, 8, 8)).toEqual([-1, 1, -1,
                                                      1, 1, 2,
                                                      -1, 1, -1]);

    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(readDrawnFootprint3x3(map, 8, 8)).toEqual([-1, 2, -1,
                                                      2, 2, 2,
                                                      -1, 2, -1]);
  });

  it('never lifts a cell THROUGH the level being filled', () => {
    const map = createHeightmap(16);
    map.cells.fill(bandLevelHeight(0));
    map.cells[cellIndex(map, 8, 8)] = bandLevelHeight(0) - 1;

    applySculpt(map, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    // The footprint's lowest drawn band is 0, so the fill targets band 1's
    // level: the laggard advances one drawn band and nothing passes the target.
    expect(heightAt(map, 8, 8)).toBe(bandLevelHeight(1) - 1);
    expect(heightAt(map, 7, 8)).toBe(bandLevelHeight(1));
  });

  it('advances at most ONE band per stroke, whatever the amount', () => {
    const map = createHeightmap(16);
    applySculpt(map, 8, 8, 2, 4 * BAND_HEIGHT, LEVEL_FILL);
    expect(readDrawnFootprint3x3(map, 8, 8)).toEqual([-1, 0, -1, 0, 0, 0, -1, 0, -1]);
    expect(heightAt(map, 8, 8)).toBe(bandLevelHeight(0));
  });

  it('on a FLAT footprint is exactly the old flat stamp: one band, uniformly', () => {
    // Flat raw levels read as the same drawn band everywhere except at the
    // shore, where raw band 0 splits into drawn bands -1 and 0.
    for (const band of [-3, -2, 2, 5]) {
      const levelled = createHeightmap(16);
      const flatDelta = createHeightmap(16);
      levelled.cells.fill(bandLevelHeight(band));
      flatDelta.cells.fill(bandLevelHeight(band));

      applySculpt(levelled, 8, 8, 3, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      applyBrush(flatDelta, 8, 8, 3, DEFAULT_SCULPT_AMOUNT, new Set<number>(), 'hard');

      expect(levelled.cells).toEqual(flatDelta.cells);
      expect(heightAt(levelled, 8, 8)).toBe(bandLevelHeight(band + 1));
    }
  });

  it('lowering is the same operation mirrored about the shore: the HIGHEST band, one level down', () => {
    const up = createHeightmap(16);
    const down = createHeightmap(16);
    // Shore-mirrored paints: up reads bands 2-4 throughout, down reads the
    // mirror bands -3..-5, so the two strokes are the same operation mirrored.
    const UP_BANDS = [2, 3, 4,
                      2, 3, 3,
                      4, 2, 3];
    down.cells.fill(2);
    for (let k = 0; k < UP_BANDS.length; k++) {
      const dx = (k % 3) - 1;
      const dy = Math.floor(k / 3) - 1;
      const level = bandLevelHeight(UP_BANDS[k]!);
      up.cells[cellIndex(up, 8 + dx, 8 + dy)] = level;
      down.cells[cellIndex(down, 8 + dx, 8 + dy)] = 2 - level;
    }

    for (let stroke = 0; stroke < 3; stroke++) {
      applySculpt(up, 8, 8, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      applySculpt(down, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
      for (let i = 0; i < up.cells.length; i++) expect(down.cells[i]).toBe(2 - up.cells[i]);
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
    nearFloor.cells.fill(MIN_HEIGHT);
    applySculpt(nearFloor, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(nearFloor, 8, 8)).toBe(MIN_HEIGHT);
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
      { x: 8, y: 7, h: bandLevelHeight(0) },
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
    let lowestDrawn = Number.POSITIVE_INFINITY;
    for (const i of footprint) lowestDrawn = Math.min(lowestDrawn, drawnBandOfSample(before[i]));
    const target = bandLevelHeight(lowestDrawn + 1);
    for (const i of footprint) {
      const expected =
        before[i] >= target ? before[i] : Math.min(before[i] + DEFAULT_SCULPT_AMOUNT, target);
      expect(map.cells[i]).toBe(expected);
    }
  });

  it('surveys only in-bounds cells when the brush overhangs the map edge', () => {
    const map = createHeightmap(16);
    const corner = [[0, 0], [1, 0], [0, 1]] as const;
    for (const [x, y] of corner) map.cells[cellIndex(map, x, y)] = bandLevelHeight(1);
    map.cells[cellIndex(map, 1, 1)] = bandLevelHeight(1);

    applySculpt(map, 0, 0, 2, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);

    for (const [x, y] of corner) expect(heightAt(map, x, y)).toBe(bandLevelHeight(2));
    expect(heightAt(map, 1, 1)).toBe(bandLevelHeight(1));
  });

  it('at radius 1 snaps an off-grid cell onto the band boundary', () => {
    const map = createHeightmap(16);
    map.cells[cellIndex(map, 8, 8)] = bandLevelHeight(1) + 4;
    applySculpt(map, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(map, 8, 8)).toBe(bandLevelHeight(2));
  });

  it('lowering an off-grid cell drops it a RENDERED band, not to its own floor', () => {
    const OFF_BAND_FLOOR = 6;
    const map = createHeightmap(16);
    map.cells[cellIndex(map, 8, 8)] = bandLevelHeight(1) + OFF_BAND_FLOOR;
    applySculpt(map, 8, 8, 1, -DEFAULT_SCULPT_AMOUNT, LEVEL_FILL);
    expect(heightAt(map, 8, 8)).toBe(bandLevelHeight(1) + OFF_BAND_FLOOR - DEFAULT_SCULPT_AMOUNT);
    expect(bandOf(heightAt(map, 8, 8))).toBe(0);
  });

  it('does nothing at all for a zero amount', () => {
    const map = texturedMap(16);
    const before = map.cells.slice();
    expect(applySculpt(map, 8, 8, 3, 0, LEVEL_FILL)).toEqual([]);
    expect(map.cells).toEqual(before);
  });

  it('soft is untouched; hard smooth melts without filling (2026-08-19)', () => {
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
    const seed = new Set<number>();
    forEachFootprintOffset(2, (dx, dy) => {
      seed.add(cellIndex(slumpedExpected, 8 + dx, 8 + dy));
    });
    smooth(slumpedExpected, new Set<number>(), seed);
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
