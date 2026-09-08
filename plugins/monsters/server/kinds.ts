import {
  AMPHIBIOUS_WALKER_PROFILE,
  withClimb,
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  MAX_STEP,
  NEIGHBOURHOOD_CELLS,
  OPEN_WATER_PROFILE,
  SEA_COLUMN_BANDS,
  SEA_LEVEL,
  WORLD_UNIT_CELLS,
  cellsAcross,
  type TraversalProfile,
} from '@terrace/shared';
import { MONSTER_KINDS, type MonsterKind } from '../protocol.ts';
import {
  DEEP_WATER_BANDS_BELOW_SEA,
  HABITAT_REGIMES,
  LAND_HABITAT,
  SNOW_LINE_BANDS_ABOVE_SEA,
  WATER_HABITAT,
  habitatBoundaryHeight,
  habitatRangeOf,
  type HabitatRegime,
  type LairFitRule,
} from './habitat.ts';

import { MAX_LIVING_MONSTERS_PER_KIND } from '../protocol.ts';
export { MAX_LIVING_MONSTERS_PER_KIND };

import { MAX_LIVING_MONSTERS } from '../protocol.ts';
export { MAX_LIVING_MONSTERS };

export const SUMMON_MEAN_WAIT_SECONDS = 240;

export const LAIR_MIN_AREA_CHUNKS = 4;
export const MIN_LAIR_DEEP_CELLS =
  LAIR_MIN_AREA_CHUNKS * NEIGHBOURHOOD_CELLS * NEIGHBOURHOOD_CELLS;

export const CTHULHU_LURK_SPEED_CELLS_PER_SECOND = cellsAcross(0.25);

export const CTHULHU_TURN_NOISE_RADIANS_PER_SECOND = 0.1;

export const CTHULHU_IDLE_ONSET_PER_SECOND = 0.05;
export const CTHULHU_IDLE_END_PER_SECOND = 0.12;

export const CTHULHU_FOOTPRINT_CELLS = cellsAcross(7);

export const CTHULHU_MIN_LAIR_FITTING_CELLS = Math.ceil(CTHULHU_FOOTPRINT_CELLS ** 2);

export const KRAKEN_LAIR_MIN_AREA_CHUNKS = 9;
export const KRAKEN_MIN_LAIR_DEEP_CELLS =
  KRAKEN_LAIR_MIN_AREA_CHUNKS * NEIGHBOURHOOD_CELLS * NEIGHBOURHOOD_CELLS;

export const WORLD_WATER_COLUMN_BANDS = SEA_COLUMN_BANDS;

export const GENESIS_DEEP_OCEAN_REFERENCE_DEPTH = 512;
export const GENESIS_DEEP_OCEAN_REFERENCE_BAND =
  GENESIS_DEEP_OCEAN_REFERENCE_DEPTH / BAND_HEIGHT;

export const NATURAL_OCEAN_FLOOR_MIN_DEPTH =
  GENESIS_DEEP_OCEAN_REFERENCE_DEPTH - MAX_STEP / 2;

export const KRAKEN_LAIR_MIN_DEPTH_BANDS = Math.floor(
  NATURAL_OCEAN_FLOOR_MIN_DEPTH / BAND_HEIGHT,
);

export const KRAKEN_RESPAWN_COOLDOWN_SECONDS = 600;

export const KRAKEN_LURK_SPEED_CELLS_PER_SECOND = cellsAcross(0.6);

export const KRAKEN_TURN_NOISE_RADIANS_PER_SECOND = 0.18;

export const KRAKEN_IDLE_ONSET_PER_SECOND = 0.02;
export const KRAKEN_IDLE_END_PER_SECOND = 0.2;

export const KRAKEN_FOOTPRINT_CELLS = cellsAcross(7);

export const KRAKEN_MIN_LAIR_FITTING_CELLS = Math.ceil(KRAKEN_FOOTPRINT_CELLS ** 2);

export const YETI_CLIMB_FALL_CHANCE = 0.05;

export const YETI_FOOTPRINT_CELLS = cellsAcross(1.022681578153609);

export const LAIR_BODY_WIDTHS_ACROSS = 4.5;

export const YETI_LAIR_REACHABILITY_DIVISOR = 9;

export const YETI_MIN_LAIR_SNOW_CELLS = Math.floor(
  (LAIR_BODY_WIDTHS_ACROSS * YETI_FOOTPRINT_CELLS) ** 2 / YETI_LAIR_REACHABILITY_DIVISOR,
);

export const YETI_MIN_LAIR_FITTING_CELLS = Math.ceil(YETI_FOOTPRINT_CELLS ** 2);

export const YETI_LAIR_MIN_HEIGHT_BANDS = SNOW_LINE_BANDS_ABOVE_SEA;

export const LAIR_COLLAPSE_HYSTERESIS_DIVISOR = 4;

export const YETI_LAIR_COLLAPSE_SNOW_CELLS = Math.floor(
  YETI_MIN_LAIR_SNOW_CELLS / LAIR_COLLAPSE_HYSTERESIS_DIVISOR,
);

export const YETI_RESPAWN_COOLDOWN_SECONDS = 600;

export const YETI_AMBLE_SPEED_CELLS_PER_SECOND = cellsAcross(0.08110465116279071);

export const YETI_TURN_NOISE_RADIANS_PER_SECOND = 0.35;

export const YETI_IDLE_ONSET_PER_SECOND = 0.08;
export const YETI_IDLE_END_PER_SECOND = 0.25;

export interface BanishmentRule {
  readonly lairCollapseCells: number | null;
  readonly respawnCooldownSeconds: number;
}

export interface MonsterProfile {
  readonly kind: MonsterKind;

  readonly habitat: HabitatRegime;

  readonly range: HabitatRegime;

  readonly minLairCells: number;
  readonly minLairFittingCells: number;
  readonly minLairReachBands: number;

  readonly summonMeanWaitSeconds: number;

  readonly banishment: BanishmentRule | null;

  readonly protectsGround: boolean;

  readonly lurkSpeedCellsPerSecond: number;
  readonly turnNoiseRadiansPerSecond: number;

  readonly idleOnsetPerSecond: number;
  readonly idleEndPerSecond: number;

  readonly footprintCells: number;

  readonly traversal: TraversalProfile;
}

type MonsterProfileRow = Omit<MonsterProfile, 'range'>;

const TRENCH_WALL_CELLS_PER_BAND = BAND_HEIGHT / MAX_STEP;

function bodyReachBands(row: MonsterProfileRow): number {
  return Math.ceil(bodyRadiusCells(row) / TRENCH_WALL_CELLS_PER_BAND);
}

function withRange(row: MonsterProfileRow): MonsterProfile {
  return {
    ...row,
    range: habitatRangeOf(row.habitat, row.minLairReachBands - bodyReachBands(row)),
  };
}

export const MONSTER_PROFILES: Readonly<Record<MonsterKind, MonsterProfile>> = {
  cthulhu: withRange({
    kind: 'cthulhu',
    habitat: WATER_HABITAT,
    minLairCells: MIN_LAIR_DEEP_CELLS,
    minLairFittingCells: CTHULHU_MIN_LAIR_FITTING_CELLS,
    minLairReachBands: DEEP_WATER_BANDS_BELOW_SEA,
    summonMeanWaitSeconds: SUMMON_MEAN_WAIT_SECONDS,
    banishment: null,
    protectsGround: true,
    lurkSpeedCellsPerSecond: CTHULHU_LURK_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: CTHULHU_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: CTHULHU_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: CTHULHU_IDLE_END_PER_SECOND,
    footprintCells: CTHULHU_FOOTPRINT_CELLS,
    traversal: OPEN_WATER_PROFILE,
  }),
  kraken: withRange({
    kind: 'kraken',
    habitat: WATER_HABITAT,
    minLairCells: KRAKEN_MIN_LAIR_DEEP_CELLS,
    minLairFittingCells: KRAKEN_MIN_LAIR_FITTING_CELLS,
    minLairReachBands: KRAKEN_LAIR_MIN_DEPTH_BANDS,
    summonMeanWaitSeconds: SUMMON_MEAN_WAIT_SECONDS,
    banishment: {
      lairCollapseCells: null,
      respawnCooldownSeconds: KRAKEN_RESPAWN_COOLDOWN_SECONDS,
    },
    protectsGround: false,
    lurkSpeedCellsPerSecond: KRAKEN_LURK_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: KRAKEN_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: KRAKEN_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: KRAKEN_IDLE_END_PER_SECOND,
    footprintCells: KRAKEN_FOOTPRINT_CELLS,
    traversal: OPEN_WATER_PROFILE,
  }),
  yeti: withRange({
    kind: 'yeti',
    habitat: LAND_HABITAT,
    minLairCells: YETI_MIN_LAIR_SNOW_CELLS,
    minLairFittingCells: YETI_MIN_LAIR_FITTING_CELLS,
    minLairReachBands: YETI_LAIR_MIN_HEIGHT_BANDS,
    summonMeanWaitSeconds: SUMMON_MEAN_WAIT_SECONDS,
    banishment: {
      lairCollapseCells: YETI_LAIR_COLLAPSE_SNOW_CELLS,
      respawnCooldownSeconds: YETI_RESPAWN_COOLDOWN_SECONDS,
    },
    protectsGround: false,
    lurkSpeedCellsPerSecond: YETI_AMBLE_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: YETI_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: YETI_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: YETI_IDLE_END_PER_SECOND,
    footprintCells: YETI_FOOTPRINT_CELLS,
    traversal: withClimb(AMPHIBIOUS_WALKER_PROFILE, YETI_CLIMB_FALL_CHANCE),
  }),
};

export function profileOf(kind: MonsterKind): MonsterProfile {
  return MONSTER_PROFILES[kind];
}

export function summonRatePerSecond(profile: MonsterProfile): number {
  return 1 / profile.summonMeanWaitSeconds;
}

export function minLairExtremeHeight(profile: MonsterProfile): number {
  return habitatBoundaryHeight(profile.habitat, profile.minLairReachBands);
}

export const MONSTER_GROUND_STANDOFF_CELLS = DEFAULT_SCULPT_AMOUNT / MAX_STEP - 1;

export function bodyRadiusCells(profile: Pick<MonsterProfile, 'footprintCells'>): number {
  return profile.footprintCells / 2;
}

export function groundProtectionRadiusCells(profile: MonsterProfile): number {
  return profile.footprintCells / 2 + MONSTER_GROUND_STANDOFF_CELLS;
}

export const SUMMON_ORDER: readonly MonsterKind[] = MONSTER_KINDS;

const KINDS_BY_HABITAT: ReadonlyMap<HabitatRegime, readonly MonsterKind[]> = new Map(
  HABITAT_REGIMES.map((regime) => [
    regime,
    SUMMON_ORDER.filter((kind) => MONSTER_PROFILES[kind].habitat === regime),
  ]),
);

export function kindsInHabitat(regime: HabitatRegime): readonly MonsterKind[] {
  return KINDS_BY_HABITAT.get(regime) ?? [];
}

const LAIR_FIT_RULES_BY_HABITAT: ReadonlyMap<HabitatRegime, readonly LairFitRule[]> = new Map(
  HABITAT_REGIMES.map((regime) => [
    regime,
    kindsInHabitat(regime).map((kind) => ({
      radiusCells: bodyRadiusCells(MONSTER_PROFILES[kind]),
      rangeBands: MONSTER_PROFILES[kind].range.thresholdBands,
      minReachBands: MONSTER_PROFILES[kind].minLairReachBands,
    })),
  ]),
);

export function lairFitRulesInHabitat(regime: HabitatRegime): readonly LairFitRule[] {
  return LAIR_FIT_RULES_BY_HABITAT.get(regime) ?? [];
}

export function habitatKindIndex(kind: MonsterKind): number {
  return kindsInHabitat(MONSTER_PROFILES[kind].habitat).indexOf(kind);
}
