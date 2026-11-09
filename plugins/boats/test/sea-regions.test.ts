import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, DEFAULT_WORLD_SIZE, labelSeaRegions, navigableWaterProfile, type TerrainSampler } from '@terrace/shared';
import { SEA_REGION_STEPS_PER_TICK, SeaRegionIndex } from '../server/sea-regions.ts';

const DRAFT_HEIGHT_UNITS = 9;
const DEEP_WATER = -100;
const SHALLOW_WATER = -1;

describe('budgeted sea connectivity', () => {
  it('matches shared connectivity for divided seas, shallows and diagonal-only contacts', () => {
    const size = CHUNK_SIZE * 2;
    const worlds: TerrainSampler[] = [
      { worldSize: size, heightAt: (x) => x === size / 2 ? SHALLOW_WATER : DEEP_WATER },
      { worldSize: size, heightAt: (x, y) => x === y ? DEEP_WATER : SHALLOW_WATER },
    ];
    for (const world of worlds) {
      const expected = labelSeaRegions(world, navigableWaterProfile(DRAFT_HEIGHT_UNITS));
      const index = new SeaRegionIndex(size, DRAFT_HEIGHT_UNITS);
      const cells = size * size;
      for (let turn = 0; turn <= cells * 2 && !index.complete; turn++) index.advance(world, 1);
      expect(index.complete).toBe(true);
      expect(index.regionCount).toBe(expected.regionCount);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) expect(index.at(x, y)).toBe(expected.labels[y * size + x]);
      }
    }
  });

  it('bounds work independently of map size and exposes no false disconnections while building', () => {
    let reads = 0;
    const world: TerrainSampler = {
      worldSize: DEFAULT_WORLD_SIZE,
      heightAt: () => { reads++; return DEEP_WATER; },
    };
    const index = new SeaRegionIndex(world.worldSize, DRAFT_HEIGHT_UNITS);
    index.advance(world);
    expect(reads).toBeLessThanOrEqual(SEA_REGION_STEPS_PER_TICK * 4);
    expect(index.complete).toBe(false);
    expect(index.at(0, 0)).toBe(1);
    expect(index.at(world.worldSize - 1, world.worldSize - 1)).toBe(0);
  });
});
