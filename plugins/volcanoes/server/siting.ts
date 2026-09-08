import {
  BAND_HEIGHT,
  DEEP_LAVA_DEPTH,
  MIN_HEIGHT,
  SEA_LEVEL,
  cellsAcross,
  cellsOverArea,
} from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { VENT_MIN_BANDS_ABOVE_SEA } from '../protocol.ts';
import type { VolcanoRng } from './rng.ts';

export type SitingWorld = Pick<WorldApi, 'worldSize' | 'heightAt'>;

export interface Site {
  readonly x: number;
  readonly y: number;
}

export const LAVA_BAND_CEILING = MIN_HEIGHT + DEEP_LAVA_DEPTH;

export const VENT_MIN_HEIGHT = SEA_LEVEL + VENT_MIN_BANDS_ABOVE_SEA * BAND_HEIGHT;

export const VENT_SEPARATION_WORLD_UNITS = 24;
export const VENT_SEPARATION_CELLS = cellsAcross(VENT_SEPARATION_WORLD_UNITS);

export const WORLD_AREA_PER_VENT_SQUARE_WORLD_UNITS = 4096;

export const MIN_VENTS_PER_WORLD = 1;

export const MAX_VENTS_PER_WORLD = 8;

export function genesisVentCount(worldSize: number): number {
  if (!(worldSize > 0)) return 0;
  const cells = worldSize * worldSize;
  const perVent = cellsOverArea(WORLD_AREA_PER_VENT_SQUARE_WORLD_UNITS);
  const count = Math.floor(cells / perVent);
  return Math.min(MAX_VENTS_PER_WORLD, Math.max(MIN_VENTS_PER_WORLD, count));
}

export const VENT_SITE_ATTEMPTS = 128;

export function isSiteClear(site: Site, existing: readonly Site[]): boolean {
  for (const vent of existing) {
    const dx = Math.abs(vent.x - site.x);
    const dy = Math.abs(vent.y - site.y);
    if (Math.max(dx, dy) < VENT_SEPARATION_CELLS) return false;
  }
  return true;
}

export function chooseVentSite(
  world: SitingWorld,
  rng: VolcanoRng,
  existing: readonly Site[],
): Site | null {
  const size = world.worldSize;
  if (size <= 0) return null;

  let best: Site | null = null;
  let bestHeight = SEA_LEVEL;

  for (let attempt = 0; attempt < VENT_SITE_ATTEMPTS; attempt++) {
    const x = Math.floor(rng.next() * size);
    const y = Math.floor(rng.next() * size);
    if (x >= size || y >= size) continue;

    const site = { x, y };
    if (!isSiteClear(site, existing)) continue;

    const height = world.heightAt(x, y);
    if (height >= VENT_MIN_HEIGHT) return site;
    if (height > bestHeight) {
      bestHeight = height;
      best = site;
    }
  }

  return best;
}

export function isLavaExposed(height: number): boolean {
  return height <= LAVA_BAND_CEILING;
}
