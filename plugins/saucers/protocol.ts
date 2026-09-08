import {
  CELL_WORLD_SIZE,
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  WORLD_UNITS_PER_BAND,
  cellsAcross,
  isFiniteNumber,
} from '@terrace/shared';

export const SAUCERS_PLUGIN_NAME = 'saucers';

export const SAUCERS_STATE_MESSAGE = 'state';

export const SAUCERS_CRASHED_EVENT = 'crashed';

export const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;

export const MAX_LIVING_ENCOUNTERS = 1;

export const MIN_FACTIONS_PER_ENCOUNTER = 2;
export const MIN_SAUCERS_PER_FACTION = 1;
export const MAX_SAUCERS_PER_FACTION = 3;
export const MIN_SAUCERS_PER_ENCOUNTER = 3;

export const MIN_SAUCERS_PER_FLYBY = 1;
export const MAX_SAUCERS_PER_FLYBY = 5;

export const SAUCER_VARIANT_COUNT = 3;

export const DEFAULT_SAUCER_VARIANT = 0;

export const MAX_FACTIONS_PER_ENCOUNTER = SAUCER_VARIANT_COUNT;

export const MAX_SAUCERS_PER_ENCOUNTER = Math.max(
  MAX_FACTIONS_PER_ENCOUNTER * MAX_SAUCERS_PER_FACTION,
  MAX_SAUCERS_PER_FLYBY,
);

export const SAUCER_PHASES = ['approach', 'dogfight', 'resolve', 'flyby'] as const;
export type SaucerPhase = (typeof SAUCER_PHASES)[number];

export function isSaucerPhase(value: unknown): value is SaucerPhase {
  return (SAUCER_PHASES as readonly string[]).includes(value as string);
}

export const APPROACH_SECONDS = 2.5;
export const DOGFIGHT_SECONDS = 20;
export const RESOLVE_SECONDS = 1.5;
export const DIVE_SECONDS = 1.0;
export const CRASH_WIRE_SECONDS = 2.5;

export const APPROACH_SPEED_CELLS_PER_SECOND = cellsAcross(34);
export const DOGFIGHT_SPEED_CELLS_PER_SECOND = cellsAcross(20);
export const EXIT_SPEED_MAX_CELLS_PER_SECOND = cellsAcross(240);

export const ENTRY_DISTANCE_CELLS = APPROACH_SPEED_CELLS_PER_SECOND * APPROACH_SECONDS;

export const FLYBY_SECONDS = (2 * ENTRY_DISTANCE_CELLS) / APPROACH_SPEED_CELLS_PER_SECOND;

export const ARENA_RADIUS_CELLS = cellsAcross(12);

export const ORBIT_RADIUS_FRACTION_MIN = 0.55;
export const ORBIT_RADIUS_FRACTION_MAX = 1;
export const BREATHE_RADIUS_FRACTION = 0.15;

export const FIGHT_PLAN_SPAN_CELLS =
  2 * ARENA_RADIUS_CELLS * (ORBIT_RADIUS_FRACTION_MAX + BREATHE_RADIUS_FRACTION);

export const ALTITUDE_TIER_WORLD_UNITS = 1;
export const CLIMB_WORLD_UNITS = 0.25;

export const FIGHT_ALTITUDE_SPAN_CELLS =
  ((MAX_SAUCERS_PER_ENCOUNTER - 1) * ALTITUDE_TIER_WORLD_UNITS + 2 * CLIMB_WORLD_UNITS) /
  CELL_WORLD_SIZE;

export const CRUISE_ALTITUDE_BANDS = 24;

export const CRUISE_ALTITUDE_WORLD_UNITS = CRUISE_ALTITUDE_BANDS * WORLD_UNITS_PER_BAND;

export const SAUCER_MAX_HP = 5;

export const LASER_HIT_DAMAGE = 1;

export const LASER_BURST_SHOTS = 3;
export const LASER_SHOT_GAP_SECONDS = 0.1;
export const LASER_BURST_REST_MIN_SECONDS = 0.3;
export const LASER_BURST_REST_MAX_SECONDS = 1.0;

export const LASER_HIT_CHANCE = 0.3;

export const LASER_MISS_OFFSET_MIN_CELLS = 6;
export const LASER_MISS_OFFSET_MAX_CELLS = 12;

export const FIGHT_SPAN_CELLS = Math.hypot(
  FIGHT_PLAN_SPAN_CELLS + LASER_MISS_OFFSET_MAX_CELLS,
  FIGHT_ALTITUDE_SPAN_CELLS,
);

export const LASER_RANGE_CELLS = FIGHT_SPAN_CELLS - LASER_MISS_OFFSET_MAX_CELLS;

export const LASER_BOLT_SPEED_CELLS_PER_SECOND = cellsAcross(50);
export const LASER_BOLT_LENGTH_CELLS = 3.5;
export const LASER_BOLT_LIFETIME_SECONDS = FIGHT_SPAN_CELLS / LASER_BOLT_SPEED_CELLS_PER_SECOND;

export const SAUCER_DIAMETER_CELLS = cellsAcross(1);

export const SAUCER_MUZZLE_DROP_FRACTION = 0.18;

export const LASER_MUZZLE_DROP_WORLD_UNITS =
  (SAUCER_DIAMETER_CELLS / 2) * CELL_WORLD_SIZE * SAUCER_MUZZLE_DROP_FRACTION;

const BURST_SPAN_SECONDS = (LASER_BURST_SHOTS - 1) * LASER_SHOT_GAP_SECONDS;
const BURST_PERIOD_MIN_SECONDS = BURST_SPAN_SECONDS + LASER_BURST_REST_MIN_SECONDS;
export const MAX_LASER_BOLTS =
  MAX_SAUCERS_PER_ENCOUNTER *
  LASER_BURST_SHOTS *
  (Math.ceil(LASER_BOLT_LIFETIME_SECONDS / BURST_PERIOD_MIN_SECONDS) + 1);

export const CRASH_CRATER_RADIUS_CELLS = cellsAcross(2.5);
export const CRASH_CRATER_DEPTH_BANDS = 2;

export const CRASH_SEABED_CRATER_MAX_DEPTH_BANDS = 5;

export const CRASH_FIRE_RING_RADIUS_CELLS = 2;

export const CRASH_FIRE_RING_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [CRASH_FIRE_RING_RADIUS_CELLS, 0],
  [-CRASH_FIRE_RING_RADIUS_CELLS, 0],
  [0, CRASH_FIRE_RING_RADIUS_CELLS],
  [0, -CRASH_FIRE_RING_RADIUS_CELLS],
  [CRASH_FIRE_RING_RADIUS_CELLS, CRASH_FIRE_RING_RADIUS_CELLS],
  [CRASH_FIRE_RING_RADIUS_CELLS, -CRASH_FIRE_RING_RADIUS_CELLS],
  [-CRASH_FIRE_RING_RADIUS_CELLS, CRASH_FIRE_RING_RADIUS_CELLS],
  [-CRASH_FIRE_RING_RADIUS_CELLS, -CRASH_FIRE_RING_RADIUS_CELLS],
];

export interface SaucerState {
  readonly id: number;
  readonly variant: number;
  readonly x: number;
  readonly y: number;
  readonly alt: number;
  readonly heading: number;
  readonly speed: number;
  readonly phase: SaucerPhase;
  readonly hp: number;
}

export interface LaserBolt {
  readonly from: number;
  readonly to: number;
  readonly x: number;
  readonly y: number;
  readonly alt: number;
  readonly aimX: number;
  readonly aimY: number;
  readonly aimAlt: number;
  readonly age: number;
}

export interface CrashState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly water: boolean;
  readonly age: number;
}

export interface SaucersStatePayload {
  readonly saucers: readonly SaucerState[];
  readonly lasers: readonly LaserBolt[];
  readonly crashes: readonly CrashState[];
}

export function saucerVariantOf(raw: unknown): number {
  if (!isFiniteNumber(raw)) return DEFAULT_SAUCER_VARIANT;
  const index = Math.floor(raw);
  if (index < 0 || index >= SAUCER_VARIANT_COUNT) return DEFAULT_SAUCER_VARIANT;
  return index;
}

export function parseSaucersPayload(payload: unknown): SaucersStatePayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as {
    saucers?: unknown;
    lasers?: unknown;
    crashes?: unknown;
  };
  if (!Array.isArray(raw.saucers)) return null;
  if (!Array.isArray(raw.lasers)) return null;
  if (!Array.isArray(raw.crashes)) return null;

  const saucers: SaucerState[] = [];
  const ids = new Set<number>();
  for (const entry of raw.saucers) {
    const parsed = parseSaucer(entry);
    if (parsed === null) continue;
    saucers.push(parsed);
    ids.add(parsed.id);
  }

  const lasers: LaserBolt[] = [];
  for (const entry of raw.lasers) {
    const parsed = parseBolt(entry, ids);
    if (parsed === null) continue;
    lasers.push(parsed);
  }

  const crashes: CrashState[] = [];
  for (const entry of raw.crashes) {
    const parsed = parseCrash(entry);
    if (parsed === null) continue;
    crashes.push(parsed);
  }

  return { saucers, lasers, crashes };
}

function parseSaucer(entry: unknown): SaucerState | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = entry as Partial<SaucerState>;
  if (!isFiniteNumber(raw.id)) return null;
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
  if (!isFiniteNumber(raw.alt)) return null;
  if (!isFiniteNumber(raw.heading)) return null;
  if (!isFiniteNumber(raw.speed)) return null;
  if (!isFiniteNumber(raw.hp)) return null;
  if (!isSaucerPhase(raw.phase)) return null;
  return {
    id: raw.id,
    variant: saucerVariantOf(raw.variant),
    x: raw.x,
    y: raw.y,
    alt: raw.alt,
    heading: raw.heading,
    speed: raw.speed,
    phase: raw.phase,
    hp: raw.hp,
  };
}

function parseBolt(entry: unknown, ids: ReadonlySet<number>): LaserBolt | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = entry as Partial<LaserBolt>;
  if (!isFiniteNumber(raw.from) || !isFiniteNumber(raw.to)) return null;
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y) || !isFiniteNumber(raw.alt)) return null;
  if (!isFiniteNumber(raw.aimX) || !isFiniteNumber(raw.aimY) || !isFiniteNumber(raw.aimAlt)) {
    return null;
  }
  if (!isFiniteNumber(raw.age)) return null;
  if (!ids.has(raw.from)) return null;
  return {
    from: raw.from,
    to: raw.to,
    x: raw.x,
    y: raw.y,
    alt: raw.alt,
    aimX: raw.aimX,
    aimY: raw.aimY,
    aimAlt: raw.aimAlt,
    age: raw.age,
  };
}

function parseCrash(entry: unknown): CrashState | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = entry as Partial<CrashState>;
  if (!isFiniteNumber(raw.id)) return null;
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
  if (!isFiniteNumber(raw.age)) return null;
  return { id: raw.id, x: raw.x, y: raw.y, water: raw.water === true, age: raw.age };
}

export {
  BROADCAST_POSITION_DECIMALS,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '@terrace/shared';
export { CELL_WORLD_SIZE, WORLD_UNITS_PER_BAND } from '@terrace/shared';
