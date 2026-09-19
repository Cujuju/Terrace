import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  bandLevelHeight,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
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
    // on the shore band's level (9), not on raw 16 (which would skip the beach).
    for (const i of footprint) expect(map.cells[i]).toBe(bandLevelHeight(0));
    expect(heightAt(map, 24 + (radius - 1), 24)).toBe(bandLevelHeight(0));
    expect(heightAt(map, 24, 24 - (radius - 1))).toBe(bandLevelHeight(0));
    expect(heightAt(map, 24 + radius, 24)).toBe(0);
  });

  it('soft is unchanged: full amount at the centre, linear falloff to a fifth at the ring', () => {
    const map = createHeightmap(48);
    applySculpt(map, 24, 24, 4, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    // Ramp spans dist 0..3: weights 15/15, 11/15, 7/15, 3/15.
    expect(heightAt(map, 24, 24)).toBe(DEFAULT_SCULPT_AMOUNT);
    expect(heightAt(map, 25, 24)).toBe(Math.trunc((DEFAULT_SCULPT_AMOUNT * 11) / 15));
    expect(heightAt(map, 26, 24)).toBe(Math.trunc((DEFAULT_SCULPT_AMOUNT * 7) / 15));
    expect(heightAt(map, 27, 24)).toBe(Math.trunc((DEFAULT_SCULPT_AMOUNT * 3) / 15));
    expect(heightAt(map, 28, 24)).toBe(0);
  });

  it('radius 1 makes the two profiles identical on band-aligned ground', () => {
    const soft = createHeightmap(16);
    const hard = createHeightmap(16);
    // bandLevelHeight(1) is drawn band 1's level, so both profiles step cleanly to band 2's.
    soft.cells.fill(bandLevelHeight(1));
    hard.cells.fill(bandLevelHeight(1));
    applySculpt(soft, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'soft' });
    applySculpt(hard, 8, 8, 1, DEFAULT_SCULPT_AMOUNT, { tool: 'stamp', profile: 'hard' });
    expect(soft.cells).toEqual(hard.cells);
  });

  it('lowering mirrors raising under the hard profile too', () => {
    const up = createHeightmap(32);
    const down = createHeightmap(32);
    applySculpt(up, 16, 16, 3, 64, { tool: 'stamp', profile: 'hard' });
    applySculpt(down, 16, 16, 3, -64, { tool: 'stamp', profile: 'hard' });
    // Flat sea is drawn band -1: a raise lands on the shore band's level,
    // a lower on band -2's level. The mirror holds in drawn bands.
    const fp = footprintOf(32, 16, 16, 3);
    for (const i of fp) {
      expect(up.cells[i]).toBe(bandLevelHeight(0));
      expect(down.cells[i]).toBe(bandLevelHeight(-2));
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

    expect(heightAt(stamped, 35, 32)).toBe(bandLevelHeight(1));
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
