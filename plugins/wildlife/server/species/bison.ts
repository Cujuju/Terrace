import { LAND_WALKER_MAX_GRADIENT_PER_CELL, cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  NO_MIN_WATER_DEPTH,
  GRASSLAND_SPAWN_HEIGHTS,
  GRAZER_SPAWN_OPEN_DIRECTIONS,
  SINGLE_SIZE_WEIGHTS,
  TURN_RADIUS_BODY_LENGTHS,
  type IdleBouts,
  type SchoolingProbabilities,
  type SpeciesProfile,
} from './profile.ts';

export const HERD_SCHOOLING_PROBABILITY_BY_SIZE: SchoolingProbabilities = {
  small: 1,
  medium: 1,
  large: 1,
};

const BISON_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.05, endPerSecond: 0.1 };

export const BISON_PROFILE: SpeciesProfile = {
  species: 'bison',
  habitat: 'land',
  minWaterDepthBands: NO_MIN_WATER_DEPTH,
  cruiseSpeedCellsPerSecond: cellsAcross(0.6),
  turnNoiseRadiansPerSecond: 0.5,
  bodyLengthCells: cellsAcross(1.6),
  habitatCellsPerIndividual: cellsOverArea(600),
  groupSize: 6,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: HERD_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  idle: BISON_IDLE_BOUTS,
  groupStartle: true,
  spawnGround: { kind: 'open', minOpenDirections: GRAZER_SPAWN_OPEN_DIRECTIONS },
  spawnHeights: GRASSLAND_SPAWN_HEIGHTS,
};
