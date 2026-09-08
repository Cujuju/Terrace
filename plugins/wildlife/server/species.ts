import { cellsAcross, cellsOverArea } from '@terrace/shared';
import { WILDLIFE_HABITAT_SPECIES, type WildlifeHabitatSpecies } from '../protocol.ts';
import {
  AQUATIC_MAX_GRADIENT_PER_CELL,
  FISH_SCHOOLING_PROBABILITY_BY_SIZE,
  FISH_SIZE_WEIGHTS,
  GRAZER_MAX_GRADIENT_PER_CELL,
  GRAZER_SPAWN_OPEN_DIRECTIONS,
  NO_MIN_WATER_DEPTH,
  NO_SPAWN_GROUND_RULE,
  SPAWN_AT_ANY_HEIGHT,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  TURN_RADIUS_BODY_LENGTHS,
  WHALE_POD_SIZE,
  WHALE_SCHOOLING_PROBABILITY_BY_SIZE,
  WHALE_SIZE_WEIGHTS,
  type SpeciesProfile,
} from './species/profile.ts';
import { BISON_PROFILE } from './species/bison.ts';
import { IBEX_PROFILE } from './species/ibex.ts';
import { RAY_PROFILE } from './species/ray.ts';
import { SHARK_PROFILE } from './species/shark.ts';
import { EEL_PROFILE } from './species/eel.ts';
import { ANGELFISH_PROFILE } from './species/angelfish.ts';
import { WOLF_PROFILE } from './species/wolf.ts';

export * from './species/profile.ts';

export * from './species/bison.ts';
export * from './species/ibex.ts';
export * from './species/ray.ts';
export * from './species/shark.ts';
export * from './species/eel.ts';
export * from './species/angelfish.ts';
export * from './species/wolf.ts';

export const FISH_SCHOOLS_ON_FRESH_SHELF = 1;

export const WHALE_MIN_WATER_DEPTH_BANDS = 15;
export const DEEPSEA_MIN_WATER_DEPTH_BANDS = 20;

export const SPECIES_PROFILES: Readonly<Record<WildlifeHabitatSpecies, SpeciesProfile>> = {
  fish: {
    species: 'fish',
    habitat: 'shallow',
    minWaterDepthBands: NO_MIN_WATER_DEPTH,
    cruiseSpeedCellsPerSecond: cellsAcross(3),
    turnNoiseRadiansPerSecond: 1.4,
    bodyLengthCells: cellsAcross(0.7),
    habitatCellsPerIndividual: cellsOverArea(400),
    groupSize: 5,
    sizeWeights: FISH_SIZE_WEIGHTS,
    sizeDraw: 'per-group',
    schoolingProbabilityBySize: FISH_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
    turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
    groupStartle: false,
    spawnGround: NO_SPAWN_GROUND_RULE,
    spawnHeights: SPAWN_AT_ANY_HEIGHT,
  },
  whale: {
    species: 'whale',
    habitat: 'deep',
    minWaterDepthBands: WHALE_MIN_WATER_DEPTH_BANDS,
    cruiseSpeedCellsPerSecond: cellsAcross(0.8),
    turnNoiseRadiansPerSecond: 0.25,
    bodyLengthCells: cellsAcross(5),
    habitatCellsPerIndividual: cellsOverArea(2000),
    groupSize: WHALE_POD_SIZE,
    sizeWeights: WHALE_SIZE_WEIGHTS,
    sizeDraw: 'per-member',
    schoolingProbabilityBySize: WHALE_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
    turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
    groupStartle: false,
    spawnGround: NO_SPAWN_GROUND_RULE,
    spawnHeights: SPAWN_AT_ANY_HEIGHT,
  },
  deepsea: {
    species: 'deepsea',
    habitat: 'deep',
    minWaterDepthBands: DEEPSEA_MIN_WATER_DEPTH_BANDS,
    cruiseSpeedCellsPerSecond: cellsAcross(1.2),
    turnNoiseRadiansPerSecond: 0.9,
    bodyLengthCells: cellsAcross(1.2),
    habitatCellsPerIndividual: cellsOverArea(1500),
    groupSize: 1,
    sizeWeights: SINGLE_SIZE_WEIGHTS,
    sizeDraw: 'per-group',
    schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
    turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
    groupStartle: false,
    spawnGround: NO_SPAWN_GROUND_RULE,
    spawnHeights: SPAWN_AT_ANY_HEIGHT,
  },
  grazer: {
    species: 'grazer',
    habitat: 'land',
    minWaterDepthBands: NO_MIN_WATER_DEPTH,
    cruiseSpeedCellsPerSecond: cellsAcross(0.8),
    turnNoiseRadiansPerSecond: 1.1,
    bodyLengthCells: cellsAcross(1.1),
    habitatCellsPerIndividual: cellsOverArea(100),
    groupSize: 3,
    sizeWeights: SINGLE_SIZE_WEIGHTS,
    sizeDraw: 'per-group',
    schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
    maxGradientPerCell: GRAZER_MAX_GRADIENT_PER_CELL,
    turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
    groupStartle: false,
    spawnGround: { kind: 'open', minOpenDirections: GRAZER_SPAWN_OPEN_DIRECTIONS },
    spawnHeights: SPAWN_AT_ANY_HEIGHT,
  },
  ibex: IBEX_PROFILE,
  bison: BISON_PROFILE,
  ray: RAY_PROFILE,
  shark: SHARK_PROFILE,
  eel: EEL_PROFILE,
  angelfish: ANGELFISH_PROFILE,
  wolf: WOLF_PROFILE,
};

export function profileOf(species: WildlifeHabitatSpecies): SpeciesProfile {
  return SPECIES_PROFILES[species];
}

export const SCHOOL_SPACING_BASELINE_BODY_LENGTH_CELLS = SPECIES_PROFILES.fish.bodyLengthCells;

export const SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND = (() => {
  let slowest = Number.POSITIVE_INFINITY;
  for (const species of WILDLIFE_HABITAT_SPECIES) {
    const profile = SPECIES_PROFILES[species];
    if (profile.habitat !== 'land') continue;
    slowest = Math.min(slowest, profile.cruiseSpeedCellsPerSecond);
  }
  return slowest;
})();
