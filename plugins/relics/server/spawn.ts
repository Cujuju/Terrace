import { BAND_HEIGHT, SEA_LEVEL, createSeededRng } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';

export type SpawnWorld = Pick<WorldApi, 'worldSize' | 'heightAt' | 'isCellUnlocked'>;

export const RELIC_RNG_DEFAULT_SEED = 0x9e3779b9;

export const SHORE_HEIGHT_MARGIN = BAND_HEIGHT;

export const RELIC_SPAWN_ATTEMPTS = 64;

export const RELIC_PREFERRED_TERRAIN_ATTEMPTS = RELIC_SPAWN_ATTEMPTS / 2;

export interface RelicRng {
  next(): number;
  state(): number;
}

export function createRelicRng(seed: number): RelicRng {
  return createSeededRng(seed);
}

export type TerrainClass = 'land' | 'shore';

export function terrainClassOf(height: number): TerrainClass | null {
  if (height > SEA_LEVEL + SHORE_HEIGHT_MARGIN) return 'land';
  if (height >= SEA_LEVEL - SHORE_HEIGHT_MARGIN) return 'shore';
  return null;
}

export function chooseRelicCell(
  world: SpawnWorld,
  rng: RelicRng,
  occupied: ReadonlySet<number>,
  preferred: TerrainClass,
): { x: number; y: number } | null {
  const size = world.worldSize;
  if (size <= 0) return null;

  for (let attempt = 0; attempt < RELIC_SPAWN_ATTEMPTS; attempt++) {
    const x = Math.floor(rng.next() * size);
    const y = Math.floor(rng.next() * size);
    if (x >= size || y >= size) continue;

    if (occupied.has(y * size + x)) continue;
    if (!world.isCellUnlocked(x, y)) continue;

    const terrain = terrainClassOf(world.heightAt(x, y));
    if (terrain === null) continue;
    if (attempt < RELIC_PREFERRED_TERRAIN_ATTEMPTS && terrain !== preferred) continue;

    return { x, y };
  }

  return null;
}
