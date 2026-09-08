import { cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  AQUATIC_MAX_GRADIENT_PER_CELL,
  NO_MIN_WATER_DEPTH,
  NO_SPAWN_GROUND_RULE,
  SPAWN_AT_ANY_HEIGHT,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  TURN_RADIUS_BODY_LENGTHS,
  type Predation,
  type SpeciesProfile,
} from './profile.ts';

export const SHARK_ALARM_RADIUS_CELLS = cellsAcross(3);

const SHARK_PREY: Predation = {
  preySpecies: ['fish', 'ray', 'eel', 'angelfish'],
  alarmRadiusCells: SHARK_ALARM_RADIUS_CELLS,
};

export const SHARK_PROFILE: SpeciesProfile = {
  species: 'shark',
  habitat: 'shallow',
  minWaterDepthBands: NO_MIN_WATER_DEPTH,
  cruiseSpeedCellsPerSecond: cellsAcross(1.8),
  turnNoiseRadiansPerSecond: 0.6,
  bodyLengthCells: cellsAcross(1.5),
  habitatCellsPerIndividual: cellsOverArea(2500),
  groupSize: 1,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  groupStartle: false,
  hunts: SHARK_PREY,
  spawnGround: NO_SPAWN_GROUND_RULE,
  spawnHeights: SPAWN_AT_ANY_HEIGHT,
};
