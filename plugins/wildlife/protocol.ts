export const WILDLIFE_PLUGIN_NAME = 'wildlife';

export const WILDLIFE_ENTITIES_MESSAGE = 'entities';

export const WILDLIFE_HABITAT_SPECIES = [
  'fish',
  'whale',
  'deepsea',
  'grazer',
  'ibex',
  'bison',
  'ray',
  'shark',
  'eel',
  'angelfish',
  'wolf',
] as const;

export type WildlifeHabitatSpecies = (typeof WILDLIFE_HABITAT_SPECIES)[number];

export const WILDLIFE_FLOCK_SPECIES = ['bird'] as const;

export type WildlifeFlockSpecies = (typeof WILDLIFE_FLOCK_SPECIES)[number];

export const WILDLIFE_SPECIES = [
  ...WILDLIFE_HABITAT_SPECIES,
  ...WILDLIFE_FLOCK_SPECIES,
] as const;

export type WildlifeSpecies = (typeof WILDLIFE_SPECIES)[number];

export const WILDLIFE_SIZE_CLASSES = ['small', 'medium', 'large'] as const;

export type WildlifeSizeClass = (typeof WILDLIFE_SIZE_CLASSES)[number];

export const DEFAULT_SIZE_CLASS: WildlifeSizeClass = 'medium';

export const DEFAULT_SIZE_CLASS_INDEX = WILDLIFE_SIZE_CLASSES.indexOf(DEFAULT_SIZE_CLASS);

// Owner rule: half the old ±40% spread, so size classes read as one species.
export const WILDLIFE_SIZE_MODEL_SCALE: Readonly<Record<WildlifeSizeClass, number>> = {
  small: 0.8,
  medium: 1,
  large: 1.2,
};

const SMALLEST_SIZE_MODEL_SCALE = Math.min(...Object.values(WILDLIFE_SIZE_MODEL_SCALE));

export function sizeClassAt(index: number): WildlifeSizeClass {
  return WILDLIFE_SIZE_CLASSES[index] ?? DEFAULT_SIZE_CLASS;
}

export function sizeClassIndex(sizeClass: WildlifeSizeClass): number {
  return WILDLIFE_SIZE_CLASSES.indexOf(sizeClass);
}

export const WHALE_BODIES = ['humpback', 'blue', 'sperm'] as const;

export type WhaleBody = (typeof WHALE_BODIES)[number];

export function whaleBodyOf(variantSeed: number): WhaleBody {
  return WHALE_BODIES[Math.abs(Math.trunc(variantSeed)) % WHALE_BODIES.length]!;
}

export const WHALE_REAL_LENGTH_METRES: Readonly<Record<WhaleBody, number>> = {
  humpback: 14,
  blue: 25,
  sperm: 16,
};

// Nose to tail tip of a medium adult. The server's body length and the client's draw scale both derive from it.
export const SPECIES_REAL_LENGTH_METRES: Readonly<Record<Exclude<WildlifeSpecies, 'whale'>, number>> = {
  fish: 0.5,
  deepsea: 1,
  grazer: 2,
  ibex: 1.5,
  bison: 3,
  ray: 3,
  shark: 4.5,
  eel: 1.5,
  angelfish: 0.3,
  wolf: 1.8,
  bird: 0.8,
};

export const LONGEST_WHALE_REAL_LENGTH_METRES = Math.max(...Object.values(WHALE_REAL_LENGTH_METRES));

export function realLengthMetres(species: WildlifeSpecies, variantSeed: number): number {
  return species === 'whale'
    ? WHALE_REAL_LENGTH_METRES[whaleBodyOf(variantSeed)]
    : SPECIES_REAL_LENGTH_METRES[species];
}

/** Species-wide length, for checks made before a creature exists: the longest whale body. */
export function speciesRealLengthMetres(species: WildlifeSpecies): number {
  return species === 'whale' ? LONGEST_WHALE_REAL_LENGTH_METRES : SPECIES_REAL_LENGTH_METRES[species];
}

// Owner rule: the smallest size class of any species is no shorter than a third of a peep.
export const WILDLIFE_MIN_LENGTH_OF_PEEP = 1 / 3;

export const WILDLIFE_MIN_DRAWN_LENGTH_WORLD_UNITS = PEEP_HEIGHT_WORLD_UNITS * WILDLIFE_MIN_LENGTH_OF_PEEP;

// The floor lifts the medium body, and the classes scale from it, so a floored species keeps its size spread.
export function drawnLengthWorldUnits(realMetres: number, sizeClass: WildlifeSizeClass): number {
  const medium = Math.max(
    drawnWorldUnits(realMetres),
    WILDLIFE_MIN_DRAWN_LENGTH_WORLD_UNITS / SMALLEST_SIZE_MODEL_SCALE,
  );
  return medium * WILDLIFE_SIZE_MODEL_SCALE[sizeClass];
}

export {
  BROADCAST_POSITION_DECIMALS,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '@terrace/shared';
import {
  PEEP_HEIGHT_WORLD_UNITS,
  drawnWorldUnits,
  isFiniteNumber,
  parseClimbPath,
  type ClimbPath,
} from '@terrace/shared';

export interface WildlifeEntityState {
  readonly id: number;
  readonly species: WildlifeSpecies;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly size: number;
  readonly climbHeight: number | null;
  readonly climbPath?: ClimbPath;
  readonly falling: boolean;
  readonly stance: number | null;
}

export interface WildlifeEntitiesPayload {
  readonly entities: readonly WildlifeEntityState[];
}

export function isWildlifeSpecies(value: unknown): value is WildlifeSpecies {
  return (WILDLIFE_SPECIES as readonly string[]).includes(value as string);
}

export function isWildlifeHabitatSpecies(value: unknown): value is WildlifeHabitatSpecies {
  return (WILDLIFE_HABITAT_SPECIES as readonly string[]).includes(value as string);
}

export function parseEntitiesPayload(payload: unknown): WildlifeEntityState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const entities = (payload as { entities?: unknown }).entities;
  if (!Array.isArray(entities)) return null;

  const parsed: WildlifeEntityState[] = [];
  for (const raw of entities) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<WildlifeEntityState>;
    if (!isFiniteNumber(entry.id)) continue;
    if (!isWildlifeSpecies(entry.species)) continue;
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y)) continue;
    if (!isFiniteNumber(entry.heading)) continue;
    const climbPath = parseClimbPath(entry.climbPath);
    parsed.push({
      id: entry.id,
      species: entry.species,
      x: entry.x,
      y: entry.y,
      heading: entry.heading,
      size: isFiniteNumber(entry.size)
        ? sizeClassIndex(sizeClassAt(entry.size))
        : DEFAULT_SIZE_CLASS_INDEX,
      climbHeight: isFiniteNumber(entry.climbHeight) ? entry.climbHeight : null,
      ...(climbPath === null ? {} : { climbPath }),
      falling: entry.falling === true,
      stance: isFiniteNumber(entry.stance) ? entry.stance : null,
    });
  }
  return parsed;
}

export const IBEX_CLIMB_SECONDS_PER_BAND = 0.8;

// Owner rule: deer leap riser bands like ibex, at most three bands (band one to four).
export const GRAZER_LEAP_SECONDS_PER_BAND = IBEX_CLIMB_SECONDS_PER_BAND;

export const GRAZER_MAX_LEAP_BANDS = 3;

export const WILDLIFE_POPULATION_CAP = 850;

export const BIRDS_PER_FLOCK_MIN = 5;
export const BIRDS_PER_FLOCK_MAX = 9;

export const MAX_CONCURRENT_FLOCKS = 2;

export const MAX_BIRDS_ALOFT = MAX_CONCURRENT_FLOCKS * BIRDS_PER_FLOCK_MAX;
