import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applySculpt,
  bandOf,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  heightAt,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  smooth,
  SMOOTH_PASS_LIMIT,
  type Heightmap,
} from '../src/index.ts';
import {
  footprintOf,
  CEILING_BANDS,
} from './support/heightmapFixtures.ts';

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
      expect(drawnBandOfSample(map.cells[i])).toBe(drawnBandOfSample(before[i]));
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
      expect(drawnBandOfSample(map.cells[i])).toBe(drawnBandOfSample(before[i]));
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

  it('pins the standing residual of the #12 plateau scenario: 988 units of excess', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    expect(maxExcess(map)).toBe(988);
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

  it('#12 cascade, banded: a fully clamped plateau is locked, not relaxed', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS + 1);
    expect(heightAt(map, 64, 64)).toBe(MAX_HEIGHT);
    const before = Int16Array.from(map.cells);
    const fp = footprintOf(128, 64, 64, 4);
    // The brush is clamped at MAX and the sea ring sits at its drawn band's
    // ceiling, so banded spill has no legal move: the diff is empty.
    const diff = applySculpt(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD_BANDED);
    expect(diff).toEqual([]);
    for (let i = 0; i < map.cells.length; i++) {
      if (!fp.has(i)) expect(drawnBandOfSample(map.cells[i])).toBe(drawnBandOfSample(before[i]));
    }
  });

  it('#12 cascade, banded: the drawn box locks the standing ring — zero passes', () => {
    const map = createHeightmap(128);
    stampPlateau(map, 64, 64, CEILING_BANDS - 1);
    const changed = new Set<number>();
    applyBrush(map, 64, 64, 4, DEFAULT_SCULPT_AMOUNT, changed, 'hard');
    // The sea around the plateau sits at its drawn band's ceiling, so the
    // banded spill has nowhere legal to move: the ring cannot be repaired.
    const passes = smooth(map, changed, undefined, footprintOf(128, 64, 64, 4));
    expect(passes).toBe(0);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
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
          if (!fp.has(i) && drawnBandOfSample(map.cells[i]) !== drawnBandOfSample(before[i])) {
            throw new Error(
              `trial ${trial} stroke ${stroke} (${cx},${cy}) r${radius} ${profile} ${amount}: ` +
              `cell ${i} band ${drawnBandOfSample(before[i])} -> ${drawnBandOfSample(map.cells[i])}`,
            );
          }
        }
      }
    }
  });
});
