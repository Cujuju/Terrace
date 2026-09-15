import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  BAND_HEIGHT,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  DRAWN_SHORE_HEIGHT,
  heightAt,
  smooth,
} from '../src/index.ts';
import {
  footprintOf,
  expectGradientLimitHolds,
} from './support/heightmapFixtures.ts';

describe('applySculpt — edge profiles', () => {
  it('hard applies ONE flat delta across the whole footprint, edges included', () => {
    const map = createHeightmap(48);
    const radius = 4;
    const footprint = footprintOf(48, 24, 24, radius);

    applySculpt(map, 24, 24, radius, DEFAULT_SCULPT_AMOUNT, {
      tool: 'stamp',
      profile: 'hard',
    });

    // Flat sea reads as drawn band -1, so one hard raise lands the footprint
    // on the shore (band 0's level), not on raw 16 (which would skip the beach).
    for (const i of footprint) expect(map.cells[i]).toBe(DRAWN_SHORE_HEIGHT);
    expect(heightAt(map, 24 + (radius - 1), 24)).toBe(DRAWN_SHORE_HEIGHT);
    expect(heightAt(map, 24, 24 - (radius - 1))).toBe(DRAWN_SHORE_HEIGHT);
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
    // 16 is drawn band 1's level, so both profiles step cleanly to band 2's.
    soft.cells.fill(BAND_HEIGHT);
    hard.cells.fill(BAND_HEIGHT);
    applySculpt(soft, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    applySculpt(hard, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(soft.cells).toEqual(hard.cells);
  });

  it('lowering mirrors raising under the hard profile too', () => {
    const up = createHeightmap(32);
    const down = createHeightmap(32);
    applySculpt(up, 16, 16, 3, 64, { tool: 'stamp', profile: 'hard' });
    applySculpt(down, 16, 16, 3, -64, { tool: 'stamp', profile: 'hard' });
    // Flat sea is drawn band -1: a raise lands on the shore (band 0), a lower
    // two raw bands down (band -2). The mirror holds in drawn bands.
    const fp = footprintOf(32, 16, 16, 3);
    for (const i of fp) {
      expect(up.cells[i]).toBe(DRAWN_SHORE_HEIGHT);
      expect(down.cells[i]).toBe(-2 * BAND_HEIGHT);
      expect(drawnBandOfSample(up.cells[i])).toBe(0);
      expect(drawnBandOfSample(down.cells[i])).toBe(-2);
    }
  });
});

describe('applySculpt — tools and profiles are orthogonal', () => {
  it('smooth slumps a stamped plateau without adding to it', () => {
    const stamped = createHeightmap(64);
    const slumped = createHeightmap(64);
    const STAMP_HARD_OPTS = { tool: 'stamp', profile: 'hard' } as const;
    applySculpt(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(stamped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, STAMP_HARD_OPTS);
    applySculpt(slumped, 32, 32, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'smooth', profile: 'hard' });

    expect(heightAt(stamped, 35, 32)).toBe(DEFAULT_SCULPT_AMOUNT);
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
