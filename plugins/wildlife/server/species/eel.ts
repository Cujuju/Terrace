import { cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  AQUATIC_MAX_GRADIENT_PER_CELL,
  NO_MIN_WATER_DEPTH,
  NO_SPAWN_GROUND_RULE,
  SPAWN_AT_ANY_HEIGHT,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  TURN_RADIUS_BODY_LENGTHS,
  type IdleBouts,
  type SpeciesProfile,
} from './profile.ts';

const EEL_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.04, endPerSecond: 0.10 };

export const EEL_PROFILE: SpeciesProfile = {
  species: 'eel',
  habitat: 'shallow',
  minWaterDepthBands: NO_MIN_WATER_DEPTH,
  cruiseSpeedCellsPerSecond: cellsAcross(0.9),
  turnNoiseRadiansPerSecond: 0.5,
  bodyLengthCells: cellsAcross(1.2),
  habitatCellsPerIndividual: cellsOverArea(1500),
  groupSize: 1,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  idle: EEL_IDLE_BOUTS,
  groupStartle: false,
  spawnGround: NO_SPAWN_GROUND_RULE,
  spawnHeights: SPAWN_AT_ANY_HEIGHT,
};
