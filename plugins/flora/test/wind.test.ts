import { afterEach, expect, it } from 'vitest';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { CHUNK_SIZE } from '@terrace/shared';
import { FLORA_GREEN_MIN_HEIGHT } from '../server/bands.ts';
import { currentCropField, currentForest, plugin } from '../server/index.ts';

afterEach(() => plugin.onWorldClose?.({} as WorldApi));

function applyWind(event: string) {
  const size = CHUNK_SIZE * 16;
  const centre = { x: 120, y: 120 };
  const edgeTree = { x: 210, y: 120 };
  const rimTree = { x: 220, y: 120 };
  const crop = { x: 216, y: 120 };
  const world = {
    worldSize: size, chunksPerEdge: size / CHUNK_SIZE,
    sibling: () => null, isCellUnlocked: () => true, isChunkUnlocked: () => true,
    heightAt: (x: number) => x === 214 ? -16 : FLORA_GREEN_MIN_HEIGHT,
    broadcastVisible: () => {},
  } as unknown as WorldApi;
  plugin.onWorldCreate?.(world);
  for (const cell of [centre, edgeTree, rimTree]) currentForest().plant(cell.x, cell.y);
  currentCropField().survey(world, () => false);
  expect(currentCropField().has(crop.x, crop.y)).toBe(true);
  plugin.onWorldEvent?.(world, event, {
    stormId: 1, ...centre, radius: 100, eyeRadius: 0, intensity: 1, durationSeconds: 100,
    cells: [{ ...centre, severity: 1 }],
    windFalloff: event === 'tornado:damage' ? 'eyewall' : 'quadratic',
  });
  return {
    centre: currentForest().has(centre.x, centre.y),
    edgeTree: currentForest().has(edgeTree.x, edgeTree.y),
    rimTree: currentForest().has(rimTree.x, rimTree.y),
    crop: currentCropField().has(crop.x, crop.y),
  };
}

it('consumes tornado wind using its quadratic profile and the existing loss thresholds', () => {
  expect(applyWind('tornado:damage')).toEqual({ centre: false, edgeTree: false, rimTree: true, crop: false });
});

it('preserves cyclone wind behavior and ignores a payload profile override', () => {
  expect(applyWind('cyclone:damage')).toEqual({ centre: true, edgeTree: true, rimTree: true, crop: true });
});
