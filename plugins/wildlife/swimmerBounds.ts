import {
  drawnLengthWorldUnits,
  realLengthMetres,
  speciesRealLengthMetres,
  whaleBodyOf,
  type WhaleBody,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from './protocol.ts';
import { SEA_SURFACE_WORLD_Y, WORLD_UNITS_PER_BAND, bandFloorHeight } from '@terrace/shared';

export interface AuthoredSwimmerBounds {
  readonly noseX: number;
  readonly tailX: number;
  readonly halfWidth: number;
  readonly crownY: number;
  readonly bellyY: number;
}

// Vertex bounds of the shipped GLBs, in their authored frame; fins are included.
export const SHARK_AUTHORED_BOUNDS: AuthoredSwimmerBounds = {
  noseX: 0.7,
  tailX: -1.02,
  halfWidth: 0.42,
  crownY: 0.4,
  bellyY: -0.26,
};

const WHALE_COMMON_BOUNDS = { noseX: 2.525, tailX: -2.525, crownY: 0.67, bellyY: -0.575 };

export const WHALE_AUTHORED_BOUNDS: Readonly<Record<WhaleBody, AuthoredSwimmerBounds>> = {
  humpback: { ...WHALE_COMMON_BOUNDS, halfWidth: 1.871567726135254 },
  blue: { ...WHALE_COMMON_BOUNDS, halfWidth: 0.8962957262992859 },
  sperm: { ...WHALE_COMMON_BOUNDS, halfWidth: 0.768485963344574 },
};

export const SWIM_WATER_MARGIN_WORLD_UNITS = 0.12;

// Without an id, use the widest whale and longest species length conservatively.
export function authoredSwimmerBounds(species: WildlifeSpecies, variantSeed?: number): AuthoredSwimmerBounds | null {
  if (species === 'shark') return SHARK_AUTHORED_BOUNDS;
  if (species !== 'whale') return null;
  return WHALE_AUTHORED_BOUNDS[variantSeed === undefined ? 'humpback' : whaleBodyOf(variantSeed)];
}

export function measuredSwimmerScale(
  species: WildlifeSpecies,
  size: WildlifeSizeClass,
  variantSeed?: number,
): number | null {
  const bounds = authoredSwimmerBounds(species, variantSeed);
  if (bounds === null) return null;
  const metres = variantSeed === undefined ? speciesRealLengthMetres(species) : realLengthMetres(species, variantSeed);
  return drawnLengthWorldUnits(species, metres, size) / (bounds.noseX - bounds.tailX);
}

export function sharkMaxGroundHeight(size: WildlifeSizeClass): number {
  const bounds = SHARK_AUTHORED_BOUNDS;
  const clearanceHeight = bounds.crownY - bounds.bellyY + SWIM_WATER_MARGIN_WORLD_UNITS * 2;
  const maxBand = Math.floor((SEA_SURFACE_WORLD_Y - clearanceHeight * measuredSwimmerScale('shark', size)!) / WORLD_UNITS_PER_BAND);
  return bandFloorHeight(maxBand + 1) - 1;
}
