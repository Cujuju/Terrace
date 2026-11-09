import {
  DEFAULT_SIZE_CLASS,
  type WildlifeHabitatSpecies,
  type WildlifeSizeClass,
  isWildlifeHabitatSpecies,
  sizeClassAt,
  sizeClassIndex,
} from '../protocol.ts';
import { newStillness } from '@terrace/shared';
import { WILDLIFE_POPULATION_CAP } from './census.ts';
import { incrementIdentity, isAllocatableIdentity, isIdentityCounter } from './identity.ts';
import {
  type WildlifeEntity,
  livingEntities,
  nextEntityIdValue,
  nextSchoolIdValue,
  replacePopulation,
} from './population.ts';

export const WILDLIFE_SLICE_VERSION = 1;

interface PersistedEntity {
  readonly id: number;
  readonly species: WildlifeHabitatSpecies;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly schoolId: number;
  readonly size: number;
}

interface WildlifeSlice {
  readonly version: number;
  readonly nextId: number;
  readonly nextSchoolId: number;
  readonly entities: readonly PersistedEntity[];
}

export function savePopulation(): WildlifeSlice {
  const persisted: PersistedEntity[] = [];

  for (const entity of livingEntities()) {
    persisted.push({
      id: entity.id,
      species: entity.species,
      x: entity.x,
      y: entity.y,
      heading: entity.heading,
      schoolId: entity.schoolId,
      size: sizeClassIndex(entity.size),
    });
  }

  return {
    version: WILDLIFE_SLICE_VERSION,
    nextId: nextEntityIdValue(),
    nextSchoolId: nextSchoolIdValue(),
    entities: persisted,
  };
}

const UNRECORDED_SCHOOL_ID = 0;

export function loadPopulation(data: unknown): void {
  const restored: WildlifeEntity[] = [];
  let maxId = 0;
  let maxSchoolId = 0;
  let persistedNext = 0;
  let persistedNextSchool = 0;

  if (typeof data === 'object' && data !== null) {
    const slice = data as Partial<WildlifeSlice>;
    if (slice.version === WILDLIFE_SLICE_VERSION && Array.isArray(slice.entities)) {
      const seenIds = new Set<number>();

      for (const raw of slice.entities) {
        if (restored.length >= WILDLIFE_POPULATION_CAP) break;
        if (typeof raw !== 'object' || raw === null) continue;

        const entry = raw as Partial<PersistedEntity>;
        const id = entry.id;
        if (!isAllocatableIdentity(id) || seenIds.has(id)) continue;
        if (!isWildlifeHabitatSpecies(entry.species)) continue;
        if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
        if (!Number.isFinite(entry.heading)) continue;

        seenIds.add(id);
        maxId = Math.max(maxId, id);

        const schoolId =
          isAllocatableIdentity(entry.schoolId)
            ? entry.schoolId
            : UNRECORDED_SCHOOL_ID;
        maxSchoolId = Math.max(maxSchoolId, schoolId);

        restored.push({
          id,
          species: entry.species,
          climb: null,
          schoolId,
          size: sizeOf(entry.size),
          x: entry.x as number,
          y: entry.y as number,
          heading: entry.heading as number,
          fleeSecondsRemaining: 0,
          idle: false,
          huntTargetId: null,
          huntSecondsRemaining: 0,
          huntRestSecondsRemaining: 0,
          ...newStillness(entry.x as number, entry.y as number),
        });
      }

      if (isIdentityCounter(slice.nextId)) persistedNext = slice.nextId;
      if (isIdentityCounter(slice.nextSchoolId)) persistedNextSchool = slice.nextSchoolId;
    }
  }

  let nextFreeSchool = Math.max(persistedNextSchool, maxSchoolId + 1, 1);
  for (let i = 0; i < restored.length; i++) {
    if (restored[i].schoolId !== UNRECORDED_SCHOOL_ID) continue;
    restored[i] = { ...restored[i], schoolId: nextFreeSchool };
    nextFreeSchool = incrementIdentity(nextFreeSchool);
  }

  replacePopulation(restored, Math.max(persistedNext, maxId + 1, 1), nextFreeSchool);
}

function sizeOf(index: unknown): WildlifeSizeClass {
  return typeof index === 'number' && Number.isFinite(index)
    ? sizeClassAt(index)
    : DEFAULT_SIZE_CLASS;
}
