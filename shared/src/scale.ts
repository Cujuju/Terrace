import { WORLD_UNIT_CELLS, cellsAcross } from './constants.ts';

// The one size contract for drawn items: each states its real size in metres and this
// file turns it into world units. Nothing else picks a model size.

export const METRES_PER_CELL = 1;

export const METRES_PER_WORLD_UNIT = METRES_PER_CELL * WORLD_UNIT_CELLS;

export const PEEP_HEIGHT_METRES = 1.5;

export const PEEP_HEIGHT_WORLD_UNITS = PEEP_HEIGHT_METRES / METRES_PER_WORLD_UNIT;

// Above peep height sizes grow as (metres / peep)^k, so trees, whales and halls keep their
// order without dwarfing terrain whose relief tops out at MAX_RELIEF_WORLD_UNITS.
export const SIZE_COMPRESSION_EXPONENT = 0.7;

export function drawnWorldUnits(realMetres: number): number {
  if (realMetres <= PEEP_HEIGHT_METRES) return realMetres / METRES_PER_WORLD_UNIT;
  return PEEP_HEIGHT_WORLD_UNITS * (realMetres / PEEP_HEIGHT_METRES) ** SIZE_COMPRESSION_EXPONENT;
}

export function drawnCells(realMetres: number): number {
  return cellsAcross(drawnWorldUnits(realMetres));
}

/** Uniform scale that brings an authored dimension (world units) to its drawn real size. */
export function scaleToRealSize(authoredWorldUnits: number, realMetres: number): number {
  return drawnWorldUnits(realMetres) / authoredWorldUnits;
}
