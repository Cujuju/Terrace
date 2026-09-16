import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  BEDROCK_REMNANT_CEILING,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  forEachFootprintOffset,
  heightAt,
  MIN_HEIGHT,
  readSpans,
  setColumn,
  smooth,
  type Heightmap,
  type SculptOptions,
} from '../src/index.ts';

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

  function pitWithWall(pitHeight: number): Heightmap {
    const map = createHeightmap(32);
    map.cells.fill(MIN_HEIGHT + 4 * BAND_HEIGHT);
    forEachFootprintOffset(3, (dx, dy) => {
      if (dx <= 0) map.cells[cellIndex(map, 16 + dx, 16 + dy)] = pitHeight;
    });
    return map;
  }

  function cellsTotal(map: Heightmap): number {
    let total = 0;
    for (let i = 0; i < map.cells.length; i++) total += map.cells[i]!;
    return total;
  }

  it('a pit at the world floor stays byte-untouched while the wall above slumps toward it', () => {
    // Frozen cells still never move; Laplacian wall cells need no receiver,
    // so unlike relaxation they descend toward the frozen pit down to target.
    const map = pitWithWall(MIN_HEIGHT);
    const before = Int16Array.from(map.cells);

    const diff = applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, WIRE_SMOOTH_SOFT);

    expect(diff.length).toBeGreaterThan(0);
    forEachFootprintOffset(3, (dx, dy) => {
      const i = cellIndex(map, 16 + dx, 16 + dy);
      if (before[i] === MIN_HEIGHT) expect(map.cells[i]).toBe(MIN_HEIGHT);
    });
    for (let i = 0; i < map.cells.length; i++) {
      expect(map.cells[i]).toBeGreaterThanOrEqual(MIN_HEIGHT);
    }
  });

  it('widening a pit one band above the floor works: the wall descends into it', () => {
    const map = pitWithWall(MIN_HEIGHT + BAND_HEIGHT);
    const before = Int16Array.from(map.cells);
    const total = cellsTotal(map);

    const diff = applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, WIRE_SMOOTH_SOFT);

    expect(diff.length).toBeGreaterThan(0);
    let wallMoved = 0;
    forEachFootprintOffset(3, (dx, dy) => {
      const i = cellIndex(map, 16 + dx, 16 + dy);
      if (before[i]! > MIN_HEIGHT + BAND_HEIGHT && map.cells[i]! < before[i]!) wallMoved++;
    });
    expect(wallMoved).toBeGreaterThan(0);
    expect(Math.abs(cellsTotal(map) - total)).toBeLessThanOrEqual(diff.length * BAND_HEIGHT);
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

  it('the floor a column can actually hold is a no-op too: empty diff, both profiles', () => {
    // A column keeps one unit of bedrock, so MIN_HEIGHT + 1 is as low as a
    // write lands; pressing there must not report a diff it did not make.
    for (const profile of ['soft', 'hard'] as const) {
      const map = createHeightmap(32);
      map.cells.fill(BEDROCK_REMNANT_CEILING);
      const diff = applySculpt(map, 16, 16, 3, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'stamp',
        profile,
        spill: 'banded',
        anchor: 'clicked',
      });
      expect([profile, diff]).toEqual([profile, []]);
    }
  });

  it('lowering a grasped bedrock span leaves the remnant instead of unflooring the column', () => {
    for (const profile of ['soft', 'hard'] as const) {
      const map = createHeightmap(16);
      const lowerCap = BEDROCK_FLOOR + 4;
      const overhang = { floor: BEDROCK_FLOOR + 200, ceiling: BEDROCK_FLOOR + 260 };
      for (let y = 6; y <= 10; y++) {
        for (let x = 6; x <= 10; x++) {
          setColumn(map, x, y, [{ floor: BEDROCK_FLOOR, ceiling: lowerCap }, overhang]);
        }
      }
      const grasped = drawnBandOfSample(lowerCap);
      expect(() =>
        applySculpt(map, 8, 8, 2, -DEFAULT_SCULPT_AMOUNT, {
          tool: 'stamp',
          profile,
          spill: 'banded',
          anchor: 'clicked',
          spanBand: grasped,
        }),
      ).not.toThrow();
      const spans = readSpans(map, 8, 8);
      expect(spans[0]).toEqual({ floor: BEDROCK_FLOOR, ceiling: BEDROCK_REMNANT_CEILING });
      expect(spans[spans.length - 1]).toEqual(overhang);
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
