import type { ClimbRule } from '@terrace/shared';
import {
  DEEP_WATER_BANDS_BELOW_SEA,
  DEEP_WATER_MAX_HEIGHT,
  GRASSLAND_MAX_HEIGHT,
  GRASSLAND_MIN_HEIGHT,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  MOUNTAIN_MIN_HEIGHT,
  UNCONSTRAINED_GRADIENT_PER_CELL,
  WORLD_UNIT_CELLS,
  cellsAcross,
  cellsOverArea,
  groundOf,
} from '@terrace/shared';
import {
  DEFAULT_SIZE_CLASS,
  WILDLIFE_SIZE_CLASSES,
  type WildlifeHabitatSpecies,
  type WildlifeSizeClass,
} from '../../protocol.ts';

export type Habitat = 'land' | 'shallow' | 'deep';

export { DEEP_WATER_BANDS_BELOW_SEA, DEEP_WATER_MAX_HEIGHT };

export function habitatOf(height: number): Habitat {
  const ground = groundOf(height);
  return ground === 'dry' ? 'land' : ground;
}

export const AQUATIC_MAX_GRADIENT_PER_CELL = UNCONSTRAINED_GRADIENT_PER_CELL;

export const GRAZER_MAX_GRADIENT_PER_CELL = LAND_WALKER_MAX_GRADIENT_PER_CELL;

export const GRAZER_SPAWN_OPEN_DIRECTIONS = 5;

export const NO_SPAWN_CLEARANCE_REQUIRED = 0;

export const TURN_RADIUS_BODY_LENGTHS = 0.5;

export const FLEE_SPEED_MULTIPLIER = 3;

export type SizeWeights = Readonly<Record<WildlifeSizeClass, number>>;

export const SINGLE_SIZE_WEIGHTS: SizeWeights = Object.fromEntries(
  WILDLIFE_SIZE_CLASSES.map((sizeClass) => [sizeClass, sizeClass === DEFAULT_SIZE_CLASS ? 1 : 0]),
) as SizeWeights;

export const FISH_SIZE_WEIGHTS: SizeWeights = { small: 6, medium: 3, large: 1 };

export const WHALE_SIZE_WEIGHTS: SizeWeights = { small: 3, medium: 5, large: 2 };

export const WHALE_POD_SIZE = 3;

export type SchoolingProbabilities = Readonly<Record<WildlifeSizeClass, number>>;

export const FISH_SCHOOLING_PROBABILITY_BY_SIZE: SchoolingProbabilities = {
  small: 0.9,
  medium: 0.5,
  large: 0.1,
};

export const WHALE_SCHOOLING_PROBABILITY_BY_SIZE: SchoolingProbabilities = {
  small: 1,
  medium: 1,
  large: 0.75,
};

export const SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE: SchoolingProbabilities = {
  small: 1,
  medium: 1,
  large: 1,
};

export const SCHOOL_LOOSENESS_BY_SIZE: Readonly<Record<WildlifeSizeClass, number>> = {
  small: 1,
  medium: 1.5,
  large: 2,
};

export interface SpeciesProfile {
  readonly species: WildlifeHabitatSpecies;
  readonly habitat: Habitat;
  readonly minWaterDepthBands: number | typeof NO_MIN_WATER_DEPTH;

  readonly cruiseSpeedCellsPerSecond: number;

  readonly turnNoiseRadiansPerSecond: number;

  readonly bodyLengthCells: number;

  readonly habitatCellsPerIndividual: number;

  readonly groupSize: number;

  readonly sizeWeights: SizeWeights;

  readonly sizeDraw: 'per-group' | 'per-member';

  readonly schoolingProbabilityBySize: SchoolingProbabilities;

  readonly maxGradientPerCell: number;
  readonly climb?: ClimbRule | null;

  readonly turnRadiusBodyLengths: number;

  readonly idle?: IdleBouts;

  readonly groupStartle: boolean;

  readonly hunts?: Predation;

  readonly spawnGround: SpawnGround;

  readonly spawnHeights: SpawnHeights | typeof SPAWN_AT_ANY_HEIGHT;
}

export interface IdleBouts {
  readonly onsetPerSecond: number;
  readonly endPerSecond: number;
}

export interface Predation {
  readonly preySpecies: readonly WildlifeHabitatSpecies[];
  readonly alarmRadiusCells: number;
  readonly pursuit?: Pursuit;
}

export interface Pursuit {
  readonly detectRadiusCells: number;
  readonly speedMultiplier: number;
  readonly catchRadiusCells: number;
  readonly maxSeconds: number;
  readonly restAfterMissSeconds: number;
  readonly restAfterCatchSeconds: number;
}

export type SpawnGround =
  | { readonly kind: 'open'; readonly minOpenDirections: number }
  | { readonly kind: 'broken'; readonly minSteepDirections: number };

export interface SpawnHeights {
  readonly minHeight: number;
  readonly maxHeightExclusive: number;
}

export const SPAWN_AT_ANY_HEIGHT = null;

export const NO_MIN_WATER_DEPTH = null;

export const GRASSLAND_SPAWN_HEIGHTS: SpawnHeights = {
  minHeight: GRASSLAND_MIN_HEIGHT,
  maxHeightExclusive: GRASSLAND_MAX_HEIGHT,
};

export const MOUNTAIN_SPAWN_HEIGHTS: SpawnHeights = {
  minHeight: MOUNTAIN_MIN_HEIGHT,
  maxHeightExclusive: Number.POSITIVE_INFINITY,
};

export const NO_SPAWN_GROUND_RULE: SpawnGround = {
  kind: 'open',
  minOpenDirections: NO_SPAWN_CLEARANCE_REQUIRED,
};

export function spawnGroundConstrains(rule: SpawnGround): boolean {
  return rule.kind === 'open' ? rule.minOpenDirections > 0 : rule.minSteepDirections > 0;
}
