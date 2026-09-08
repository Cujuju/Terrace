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

export const WILDLIFE_SIZE_MODEL_SCALE: Readonly<Record<WildlifeSizeClass, number>> = {
  small: 0.6,
  medium: 1,
  large: 1.4,
};

export function sizeClassAt(index: number): WildlifeSizeClass {
  return WILDLIFE_SIZE_CLASSES[index] ?? DEFAULT_SIZE_CLASS;
}

export function sizeClassIndex(sizeClass: WildlifeSizeClass): number {
  return WILDLIFE_SIZE_CLASSES.indexOf(sizeClass);
}

export {
  BROADCAST_POSITION_DECIMALS,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '@terrace/shared';
import { isFiniteNumber } from '@terrace/shared';

export interface WildlifeEntityState {
  readonly id: number;
  readonly species: WildlifeSpecies;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly size: number;
  readonly climbHeight: number | null;
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
      falling: entry.falling === true,
      stance: isFiniteNumber(entry.stance) ? entry.stance : null,
    });
  }
  return parsed;
}

export const IBEX_CLIMB_SECONDS_PER_BAND = 0.8;

export const WILDLIFE_POPULATION_CAP = 850;

export const BIRDS_PER_FLOCK_MIN = 5;
export const BIRDS_PER_FLOCK_MAX = 9;

export const MAX_CONCURRENT_FLOCKS = 2;

export const MAX_BIRDS_ALOFT = MAX_CONCURRENT_FLOCKS * BIRDS_PER_FLOCK_MAX;
