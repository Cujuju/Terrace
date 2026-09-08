import { LAND_WALKER_MAX_GRADIENT_PER_CELL, cellsAcross, cellsOverArea } from '@terrace/shared';
import { IBEX_CLIMB_SECONDS_PER_BAND } from '../../protocol.ts';
import {
  NO_MIN_WATER_DEPTH,
  MOUNTAIN_SPAWN_HEIGHTS,
  SINGLE_SIZE_WEIGHTS,
  SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  TURN_RADIUS_BODY_LENGTHS,
  type IdleBouts,
  type SpeciesProfile,
} from './profile.ts';

export const IBEX_MAX_GRADIENT_PER_CELL = 2 * LAND_WALKER_MAX_GRADIENT_PER_CELL;

export const IBEX_CLIMB_FALL_CHANCE = 0.01;

export const IBEX_SPAWN_STEEP_DIRECTIONS = 3;

const IBEX_IDLE_BOUTS: IdleBouts = { onsetPerSecond: 0.08, endPerSecond: 0.25 };

export const IBEX_PROFILE: SpeciesProfile = {
  species: 'ibex',
  habitat: 'land',
  minWaterDepthBands: NO_MIN_WATER_DEPTH,
  cruiseSpeedCellsPerSecond: cellsAcross(1.2),
  turnNoiseRadiansPerSecond: 1.3,
  bodyLengthCells: cellsAcross(0.9),
  habitatCellsPerIndividual: cellsOverArea(700),
  groupSize: 2,
  sizeWeights: SINGLE_SIZE_WEIGHTS,
  sizeDraw: 'per-group',
  schoolingProbabilityBySize: SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE,
  maxGradientPerCell: IBEX_MAX_GRADIENT_PER_CELL,
  climb: {
    fallChance: IBEX_CLIMB_FALL_CHANCE,
    secondsPerBand: IBEX_CLIMB_SECONDS_PER_BAND,
  },
  turnRadiusBodyLengths: TURN_RADIUS_BODY_LENGTHS,
  idle: IBEX_IDLE_BOUTS,
  groupStartle: false,
  spawnGround: { kind: 'broken', minSteepDirections: IBEX_SPAWN_STEEP_DIRECTIONS },
  spawnHeights: MOUNTAIN_SPAWN_HEIGHTS,
};
