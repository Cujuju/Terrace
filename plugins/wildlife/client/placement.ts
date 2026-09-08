import {
  BAND_HEIGHT,
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  SEA_LEVEL,
  cellsAcross,
} from '@terrace/shared';
import {
  WILDLIFE_SIZE_MODEL_SCALE,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from '../protocol.ts';
import { FISH_ENVELOPE } from './species/fish.ts';
import { RAY_ENVELOPE } from './species/ray.ts';
import { SHARK_ENVELOPE } from './species/shark.ts';
import { EEL_ENVELOPE } from './species/eel.ts';
import { ANGELFISH_ENVELOPE } from './species/angelfish.ts';
import { GRAZER_ENVELOPE, GRAZER_STRIDE_WORLD_UNITS } from './species/grazer.ts';
import { modelScaleFor, speciesModelScale } from './modelScale.ts';
import { followGroundY } from '../../../client/src/plugins/kit/groundFollow.ts';
import { WOLF_ENVELOPE, WOLF_STRIDE_WORLD_UNITS } from './species/wolf.ts';
import { IBEX_ENVELOPE, IBEX_STRIDE_WORLD_UNITS } from './species/ibex.ts';
import { BISON_ENVELOPE, BISON_STRIDE_WORLD_UNITS } from './species/bison.ts';
import { TWO_PI } from './species/speciesModel.ts';
import { DEEPSEA_ENVELOPE } from './species/deepsea.ts';
import { WHALE_ENVELOPE } from './whaleSpecies.ts';
import { BIRD_ENVELOPE } from './models.ts';

const WATER_MARGIN_WORLD_UNITS = 0.12;

const CLEARANCE_SIZE_CLASS: WildlifeSizeClass = 'medium';
const CLEARANCE_MODEL_SCALE = WILDLIFE_SIZE_MODEL_SCALE[CLEARANCE_SIZE_CLASS];

function clearanceFor(halfExtentAtScaleOne: number): number {
  return halfExtentAtScaleOne * CLEARANCE_MODEL_SCALE + WATER_MARGIN_WORLD_UNITS;
}

export const SEA_SURFACE_WORLD_Y: 0 = SEA_LEVEL;

export interface SwimProfile {
  readonly depthFraction: number;
  readonly minClearance: number;
  readonly minSubmergence: number;
  readonly halfLength: number;
  readonly halfWidth: number;
}

export const SWIM_PROFILES: Readonly<Record<WildlifeSpecies, SwimProfile | null>> = {
  fish: {
    depthFraction: 0.2,
    minClearance: clearanceFor(-FISH_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(FISH_ENVELOPE.crownY),
    halfLength: FISH_ENVELOPE.halfLength,
    halfWidth: FISH_ENVELOPE.halfWidth,
  },
  whale: {
    depthFraction: 0.5,
    minClearance: 0.7,
    minSubmergence: 0.7,
    halfLength: 2.53,
    halfWidth: 0.5,
  },
  deepsea: {
    depthFraction: 0.88,
    minClearance: 0.8,
    minSubmergence: 0.5,
    halfLength: 0.5,
    halfWidth: 0.28,
  },
  grazer: null,
  wolf: null,
  ibex: null,
  bison: null,
  ray: {
    depthFraction: 0.85,
    minClearance: clearanceFor(-RAY_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(RAY_ENVELOPE.crownY),
    halfLength: RAY_ENVELOPE.halfLength,
    halfWidth: RAY_ENVELOPE.halfWidth,
  },
  shark: {
    depthFraction: 0.4,
    minClearance: clearanceFor(-SHARK_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(SHARK_ENVELOPE.crownY),
    halfLength: SHARK_ENVELOPE.halfLength,
    halfWidth: SHARK_ENVELOPE.halfWidth,
  },
  eel: {
    depthFraction: 0.8,
    minClearance: clearanceFor(-EEL_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(EEL_ENVELOPE.crownY),
    halfLength: EEL_ENVELOPE.halfLength,
    halfWidth: EEL_ENVELOPE.halfWidth,
  },
  angelfish: {
    depthFraction: 0.3,
    minClearance: clearanceFor(-ANGELFISH_ENVELOPE.bellyY),
    minSubmergence: clearanceFor(ANGELFISH_ENVELOPE.crownY),
    halfLength: ANGELFISH_ENVELOPE.halfLength,
    halfWidth: ANGELFISH_ENVELOPE.halfWidth,
  },
  bird: null,
};

export const MAX_TERRAIN_WORLD_Y = MAX_RELIEF_WORLD_UNITS;

export const BIRD_ALTITUDE_HEADROOM_WORLD_UNITS = MAX_TERRAIN_WORLD_Y / 2;

export const BIRD_FLIGHT_WORLD_Y = MAX_TERRAIN_WORLD_Y + BIRD_ALTITUDE_HEADROOM_WORLD_UNITS;

export const FLIGHT_ALTITUDES: Readonly<Record<WildlifeSpecies, number | null>> = {
  fish: null,
  whale: null,
  deepsea: null,
  grazer: null,
  wolf: null,
  ibex: null,
  bison: null,
  ray: null,
  shark: null,
  eel: null,
  angelfish: null,
  bird: BIRD_FLIGHT_WORLD_Y,
};

export interface BodyColumn {
  readonly bellyY: number;
  readonly crownY: number;
}

export const BODY_COLUMNS: Readonly<Record<WildlifeSpecies, BodyColumn>> = {
  fish: { bellyY: FISH_ENVELOPE.bellyY, crownY: FISH_ENVELOPE.crownY },
  whale: { bellyY: WHALE_ENVELOPE.bellyY, crownY: WHALE_ENVELOPE.crownY },
  deepsea: { bellyY: DEEPSEA_ENVELOPE.bellyY, crownY: DEEPSEA_ENVELOPE.crownY },
  grazer: { bellyY: 0, crownY: GRAZER_ENVELOPE.height },
  wolf: { bellyY: 0, crownY: WOLF_ENVELOPE.height },
  ibex: { bellyY: 0, crownY: IBEX_ENVELOPE.height },
  bison: { bellyY: 0, crownY: BISON_ENVELOPE.height },
  ray: { bellyY: RAY_ENVELOPE.bellyY, crownY: RAY_ENVELOPE.crownY },
  shark: { bellyY: SHARK_ENVELOPE.bellyY, crownY: SHARK_ENVELOPE.crownY },
  eel: { bellyY: EEL_ENVELOPE.bellyY, crownY: EEL_ENVELOPE.crownY },
  angelfish: { bellyY: ANGELFISH_ENVELOPE.bellyY, crownY: ANGELFISH_ENVELOPE.crownY },
  bird: { bellyY: BIRD_ENVELOPE.bellyY, crownY: BIRD_ENVELOPE.crownY },
};

export type PlacementKind = 'flyer' | 'swimmer' | 'walker';

export function placementKindOf(species: WildlifeSpecies): PlacementKind {
  if (FLIGHT_ALTITUDES[species] !== null) return 'flyer';
  return SWIM_PROFILES[species] === null ? 'walker' : 'swimmer';
}

export const UNKNOWN_TERRAIN_WORLD_Y = 0;

export function swimmerWorldY(
  seabedY: number,
  profile: SwimProfile,
  modelScale: number,
): number {
  const bounds = swimmerColumnBounds(seabedY, profile, modelScale);
  const column = SEA_SURFACE_WORLD_Y - seabedY;
  const preferred = SEA_SURFACE_WORLD_Y - profile.depthFraction * column;
  return Math.min(Math.max(preferred, bounds.lowest), bounds.highest);
}

export function swimmerColumnBounds(
  seabedY: number,
  profile: SwimProfile,
  modelScale: number,
): { readonly lowest: number; readonly highest: number } {
  seabedY = Math.min(seabedY, SEA_SURFACE_WORLD_Y);
  const lowest = seabedY + profile.minClearance * modelScale;
  const highest = SEA_SURFACE_WORLD_Y - profile.minSubmergence * modelScale;
  if (highest < lowest) {
    const midpoint = seabedY + (SEA_SURFACE_WORLD_Y - seabedY) / 2;
    return { lowest: midpoint, highest: midpoint };
  }
  return { lowest, highest };
}

export const SWIM_VERTICAL_WORLD_UNITS_PER_SECOND = 0.5;

export function swimmerFrameY(
  previousY: number | null,
  seabedY: number,
  profile: SwimProfile,
  modelScale: number,
  dt: number,
): number {
  const preferred = swimmerWorldY(seabedY, profile, modelScale);
  const bounds = swimmerColumnBounds(seabedY, profile, modelScale);
  if (previousY === null) return preferred;

  const eased = followGroundY(previousY, preferred, dt, SWIM_VERTICAL_WORLD_UNITS_PER_SECOND, Infinity);
  return Math.min(Math.max(eased, bounds.lowest), bounds.highest);
}

const HULL_SAMPLE_ALONG: readonly number[] = [0, 1, -1, 0, 0];
const HULL_SAMPLE_ACROSS: readonly number[] = [0, 0, 0, 1, -1];
const HULL_SAMPLE_COUNT = HULL_SAMPLE_ALONG.length;

export function swimmerSeabedY(
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
  heading: number,
  profile: SwimProfile,
  modelScale: number,
): number | null {
  const along = cellsAcross(profile.halfLength * modelScale);
  const across = cellsAcross(profile.halfWidth * modelScale);
  const forwardX = Math.cos(heading);
  const forwardY = Math.sin(heading);
  const rightX = -forwardY;
  const rightY = forwardX;

  let seabed: number | null = null;
  for (let i = 0; i < HULL_SAMPLE_COUNT; i++) {
    const alongOffset = HULL_SAMPLE_ALONG[i]! * along;
    const acrossOffset = HULL_SAMPLE_ACROSS[i]! * across;
    const sampled = sampleRenderedY(
      Math.floor(x + forwardX * alongOffset + rightX * acrossOffset),
      Math.floor(y + forwardY * alongOffset + rightY * acrossOffset),
    );
    if (sampled === null) continue;
    if (sampled > SEA_SURFACE_WORLD_Y) continue;
    if (seabed === null || sampled > seabed) seabed = sampled;
  }
  return seabed;
}

export function creatureWorldY(
  species: WildlifeSpecies,
  terrainY: number | null,
  sizeClass: WildlifeSizeClass,
  previousY: number | null = null,
  dt = 0,
): number {
  const altitude = FLIGHT_ALTITUDES[species];
  if (altitude !== null) return altitude;

  const surfaceY = terrainY ?? UNKNOWN_TERRAIN_WORLD_Y;
  const profile = SWIM_PROFILES[species];
  return profile === null
    ? followGroundY(previousY, surfaceY, dt)
    : swimmerFrameY(previousY, surfaceY, profile, modelScaleFor(species, sizeClass), dt);
}

export const WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES: Readonly<
  Record<WildlifeSpecies, number | null>
> = {
  fish: null,
  whale: null,
  deepsea: null,
  grazer: GRAZER_ENVELOPE.bodyHalfLength,
  wolf: WOLF_ENVELOPE.bodyHalfLength,
  ibex: IBEX_ENVELOPE.bodyHalfLength,
  bison: BISON_ENVELOPE.bodyHalfLength,
  ray: null,
  shark: null,
  eel: null,
  angelfish: null,
  bird: null,
};

export const WALKER_STRIDE_WORLD_UNITS_BY_SPECIES: Readonly<Record<WildlifeSpecies, number | null>> =
  {
    fish: null,
    whale: null,
    deepsea: null,
    grazer: GRAZER_STRIDE_WORLD_UNITS,
    wolf: WOLF_STRIDE_WORLD_UNITS,
    ibex: IBEX_STRIDE_WORLD_UNITS,
    bison: BISON_STRIDE_WORLD_UNITS,
    ray: null,
    shark: null,
    eel: null,
    angelfish: null,
    bird: null,
  };

export function walkerStrideRadians(species: WildlifeSpecies, distanceWorldUnits: number): number {
  const stride = WALKER_STRIDE_WORLD_UNITS_BY_SPECIES[species];
  if (stride === null) {
    throw new Error(`walkerStrideRadians: "${species}" is not a walker and has no stride`);
  }
  return (distanceWorldUnits / (stride * speciesModelScale(species))) * TWO_PI;
}

export const WALKER_FOOTPRINT_HALF_EXTENT_CELLS_BY_SPECIES: Readonly<
  Record<WildlifeSpecies, number | null>
> = Object.fromEntries(
  Object.entries(WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES).map(([species, halfExtent]) => [
    species,
    halfExtent === null ? null : cellsAcross(halfExtent),
  ]),
) as Readonly<Record<WildlifeSpecies, number | null>>;

const FOOTPRINT_SAMPLE_DX: readonly number[] = [0, -1, -1, 1, 1];
const FOOTPRINT_SAMPLE_DY: readonly number[] = [0, -1, 1, -1, 1];
const FOOTPRINT_SAMPLE_COUNT = FOOTPRINT_SAMPLE_DX.length;

export function walkerGroundY(
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
  species: WildlifeSpecies,
): number | null {
  const halfExtent = WALKER_FOOTPRINT_HALF_EXTENT_CELLS_BY_SPECIES[species];
  if (halfExtent === null) {
    throw new Error(`walkerGroundY: "${species}" is not a walker and has no ground footprint`);
  }
  const drawnHalfExtent = halfExtent * speciesModelScale(species);
  let ground: number | null = null;
  for (let i = 0; i < FOOTPRINT_SAMPLE_COUNT; i++) {
    const sampled = sampleRenderedY(
      Math.floor(x + FOOTPRINT_SAMPLE_DX[i]! * drawnHalfExtent),
      Math.floor(y + FOOTPRINT_SAMPLE_DY[i]! * drawnHalfExtent),
    );
    if (sampled !== null && (ground === null || sampled > ground)) ground = sampled;
  }
  return ground;
}
