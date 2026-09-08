import { cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  AQUATIC_MAX_GRADIENT_PER_CELL,
  NO_MIN_WATER_DEPTH,
  NO_SPAWN_GROUND_RULE,
  SPAWN_AT_ANY_HEIGHT,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  type IdleBouts,
  type SpeciesProfile,
} from './profile.ts';

export const RAY_TURN_RADIUS_BODY_LENGTHS = 1.5;

const RAY_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.05, endPerSecond: 0.15 };

export const RAY_PROFILE: SpeciesProfile = {
  species: 'ray',
  habitat: 'shallow',
  minWaterDepthBands: NO_MIN_WATER_DEPTH,
  cruiseSpeedCellsPerSecond: cellsAcross(1.0),
  turnNoiseRadiansPerSecond: 0.3,
  bodyLengthCells: cellsAcross(1.0),
  habitatCellsPerIndividual: cellsOverArea(1200),
  groupSize: 1,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: RAY_TURN_RADIUS_BODY_LENGTHS,
  idle: RAY_IDLE_BOUTS,
  groupStartle: false,
  spawnGround: NO_SPAWN_GROUND_RULE,
  spawnHeights: SPAWN_AT_ANY_HEIGHT,
};
