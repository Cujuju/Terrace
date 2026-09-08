import {
  BAND_HEIGHT,
  GRASSLAND_MAX_HEIGHT,
  GRASSLAND_MIN_HEIGHT,
  LAND_RAMP_ANCHOR_SPACING,
  bandOf,
  isWater,
  quantizeToBand,
} from '@terrace/shared';
import type { FringeSpecies } from '../protocol.ts';

export const FLORA_GREEN_MIN_HEIGHT = GRASSLAND_MIN_HEIGHT;

export const FLORA_GREEN_MAX_HEIGHT = GRASSLAND_MAX_HEIGHT;

export const FLORA_MIN_BAND = bandOf(FLORA_GREEN_MIN_HEIGHT);

export const FLORA_MAX_BAND = bandOf(FLORA_GREEN_MAX_HEIGHT - BAND_HEIGHT);

export interface FloraWorld {
  readonly worldSize: number;
  readonly chunksPerEdge: number;
  heightAt(x: number, y: number): number;
  isChunkUnlocked(cx: number, cy: number): boolean;
  isCellUnlocked(x: number, y: number): boolean;
}

export function isGreenBand(height: number): boolean {
  const bandFloor = quantizeToBand(height);
  return bandFloor >= FLORA_GREEN_MIN_HEIGHT && bandFloor < FLORA_GREEN_MAX_HEIGHT;
}

export function isPlantableCell(world: FloraWorld, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  return isGreenBand(world.heightAt(x, y));
}

export const FLORA_HEATHER_MAX_HEIGHT =
  FLORA_GREEN_MAX_HEIGHT + LAND_RAMP_ANCHOR_SPACING;

export function fringeSpeciesForHeight(height: number): FringeSpecies | null {
  if (isWater(height)) return null;
  const bandFloor = quantizeToBand(height);
  if (bandFloor < FLORA_GREEN_MIN_HEIGHT) return 'reed';
  if (bandFloor >= FLORA_GREEN_MAX_HEIGHT && bandFloor < FLORA_HEATHER_MAX_HEIGHT) {
    return 'heather';
  }
  return null;
}
