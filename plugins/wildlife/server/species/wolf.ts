import { LAND_WALKER_MAX_GRADIENT_PER_CELL, cellsAcross, cellsOverArea } from '@terrace/shared';
import {
  NO_MIN_WATER_DEPTH,
  FLEE_SPEED_MULTIPLIER,
  GRAZER_SPAWN_OPEN_DIRECTIONS,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  SPAWN_AT_ANY_HEIGHT,
  TURN_RADIUS_BODY_LENGTHS,
  type IdleBouts,
  type Predation,
  type SpeciesProfile,
} from './profile.ts';

const WOLF_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.05, endPerSecond: 0.4 };

const WOLF_HABITAT_AREA_PER_INDIVIDUAL = 2000;

const WOLF_DETECT_RADIUS_CELLS = cellsAcross(6);

const WOLF_ALARM_RADIUS_CELLS = cellsAcross(3);

const WOLF_CATCH_RADIUS_CELLS = cellsAcross(1.0);

const WOLF_CHASE_MAX_SECONDS = 4.0;

const WOLF_REST_AFTER_CATCH_SECONDS = 120;

const WOLF_REST_AFTER_MISS_SECONDS = 20;

const WOLF_PREDATION: Predation = {
  preySpecies: ['grazer'],
  alarmRadiusCells: WOLF_ALARM_RADIUS_CELLS,
  pursuit: {
    detectRadiusCells: WOLF_DETECT_RADIUS_CELLS,
    speedMultiplier: FLEE_SPEED_MULTIPLIER,
    catchRadiusCells: WOLF_CATCH_RADIUS_CELLS,
    maxSeconds: WOLF_CHASE_MAX_SECONDS,
    restAfterMissSeconds: WOLF_REST_AFTER_MISS_SECONDS,
    restAfterCatchSeconds: WOLF_REST_AFTER_CATCH_SECONDS,
  },
};

export const WOLF_PROFILE: SpeciesProfile = {
  species: 'wolf',
  habitat: 'land',
  minWaterDepthBands: NO_MIN_WATER_DEPTH,
  cruiseSpeedCellsPerSecond: cellsAcross(1.0),
  turnNoiseRadiansPerSecond: 0.9,
  bodyLengthCells: cellsAcross(1.0),
  habitatCellsPerIndividual: cellsOverArea(WOLF_HABITAT_AREA_PER_INDIVIDUAL),
  groupSize: 2,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  idle: WOLF_IDLE_BOUTS,
  groupStartle: false,
  hunts: WOLF_PREDATION,
  spawnGround: { kind: 'open', minOpenDirections: GRAZER_SPAWN_OPEN_DIRECTIONS },
  spawnHeights: SPAWN_AT_ANY_HEIGHT,
};
