import { cellsAcross, cellsOverArea } from '@terrace/shared';
import { SWIM_PACE_SCALE } from '../../protocol.ts';
import {
  mediumBodyLengthCells,
  AQUATIC_MAX_GRADIENT_PER_CELL,
  FISH_SCHOOLING_PROBABILITY_BY_SIZE,
  FISH_SIZE_WEIGHTS,
  NO_MIN_WATER_DEPTH,
  NO_SPAWN_GROUND_RULE,
  SPAWN_AT_ANY_HEIGHT,
  TURN_RADIUS_BODY_LENGTHS,
  type SpeciesProfile,
} from './profile.ts';

const ANGELFISH_BEAM_OF_LENGTH = 0.17 / 0.6;

export const ANGELFISH_BODY_LENGTH_CELLS = mediumBodyLengthCells('angelfish');

export const ANGELFISH_PROFILE: SpeciesProfile = {
  species: 'angelfish',
  habitat: 'shallow',
  minWaterDepthBands: NO_MIN_WATER_DEPTH,
  cruiseSpeedCellsPerSecond: cellsAcross(1.6 * SWIM_PACE_SCALE),
  turnNoiseRadiansPerSecond: 1.0,
  bodyLengthCells: ANGELFISH_BODY_LENGTH_CELLS,
  hullBeamCells: ANGELFISH_BODY_LENGTH_CELLS * ANGELFISH_BEAM_OF_LENGTH,
  habitatCellsPerIndividual: cellsOverArea(800),
  groupSize: 3,
  sizeWeights: FISH_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: FISH_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: AQUATIC_MAX_GRADIENT_PER_CELL,
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  groupStartle: false,
  spawnGround: NO_SPAWN_GROUND_RULE,
  spawnHeights: SPAWN_AT_ANY_HEIGHT,
};
