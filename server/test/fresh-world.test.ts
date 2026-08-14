// What a brand-new world is made of.
//
// These tests exist because the failure they guard against is silent in exactly
// the same way the mask-filter ones are: a world whose seabed sits AT sea level
// looks fine — it renders, it sculpts, it saves — while having no water column
// at all, so anything that classifies water by depth has nothing to classify.
// That is how deep-water wildlife came to have nowhere to live (owner report,
// 2026-08-14). The floor is now a stated property of a fresh world, and this is
// where it is stated in executable form.

import { BAND_HEIGHT, MIN_HEIGHT, SEA_LEVEL, isWater } from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import {
  FRESH_SEABED_BANDS_BELOW_SEA,
  FRESH_SEABED_HEIGHT,
  World,
} from '../src/world/world.ts';
import { worldWithUnlockedChunks } from './support/harness.ts';

const WORLD_SIZE = 64;

describe('the fresh-world seabed', () => {
  it('is a whole number of terrace bands below sea level, inside the sculpt range', () => {
    expect(Number.isInteger(FRESH_SEABED_BANDS_BELOW_SEA)).toBe(true);
    expect(FRESH_SEABED_BANDS_BELOW_SEA).toBeGreaterThan(0);
    expect(FRESH_SEABED_HEIGHT).toBe(SEA_LEVEL - FRESH_SEABED_BANDS_BELOW_SEA * BAND_HEIGHT);
    // Room left below the floor to dig a trench, and above it to raise land.
    expect(FRESH_SEABED_HEIGHT).toBeGreaterThan(MIN_HEIGHT);
    expect(isWater(FRESH_SEABED_HEIGHT)).toBe(true);
  });

  it('fills every cell of a fresh world, unlocked or not', () => {
    const world = World.createFresh(WORLD_SIZE);
    for (const height of world.map.cells) {
      if (height === FRESH_SEABED_HEIGHT) continue;
      throw new Error(`fresh world holds height ${height}, expected ${FRESH_SEABED_HEIGHT}`);
    }
    expect(world.map.cells).toHaveLength(WORLD_SIZE * WORLD_SIZE);
  });

  it('leaves a snapshot-restored world exactly as it was stored', () => {
    // The floor is a property of GENESIS, not of the World class. A world that
    // came back from disk must be byte-identical to what was saved, or every
    // existing self-hosted world would silently gain three bands of ocean on the
    // next restart.
    const stored = new Int16Array(WORLD_SIZE * WORLD_SIZE);
    stored.fill(SEA_LEVEL);
    stored[0] = BAND_HEIGHT;

    const restored = World.restore(WORLD_SIZE, stored, World.createFresh(WORLD_SIZE).mask);

    expect(restored.heightAt(0, 0)).toBe(BAND_HEIGHT);
    expect(restored.heightAt(1, 0)).toBe(SEA_LEVEL);
  });

  it('does not change the flat worlds the test harness builds', () => {
    // The harness fixtures stay pinned at 0 on purpose: tests that reason cell
    // by cell about sculpt arithmetic want a flat datum, not an ocean.
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    expect(world.heightAt(0, 0)).toBe(SEA_LEVEL);
  });

  it('costs exactly FRESH_SEABED_BANDS_BELOW_SEA extra band-steps to reach dry land', () => {
    // The stated price of giving the ocean a volume: raising the first island
    // takes this many more one-band sculpts than it did when the seabed was the
    // shoreline. Asserted so the cost is a decision on record, not a surprise.
    const bandsToDryLand = Math.ceil((SEA_LEVEL + 1 - FRESH_SEABED_HEIGHT) / BAND_HEIGHT);
    expect(bandsToDryLand).toBe(FRESH_SEABED_BANDS_BELOW_SEA + 1);
  });
});
