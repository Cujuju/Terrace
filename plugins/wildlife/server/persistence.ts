// The on-disk shape of a population, and the defensive read-back.
//
// Separate from population.ts on purpose: that module owns LIVE state and its
// rules; this one owns the SERIALIZED format and its validation. Keeping them
// apart is what stops a future field being added to the live entity and silently
// becoming part of the snapshot contract.

import {
  DEFAULT_SIZE_CLASS,
  type WildlifeHabitatSpecies,
  type WildlifeSizeClass,
  isWildlifeHabitatSpecies,
  sizeClassAt,
  sizeClassIndex,
} from '../protocol.ts';
import { WILDLIFE_POPULATION_CAP } from './census.ts';
import {
  type WildlifeEntity,
  livingEntities,
  nextEntityIdValue,
  nextSchoolIdValue,
  replacePopulation,
} from './population.ts';

/** Schema version of this plugin's persistence slice. */
export const WILDLIFE_SLICE_VERSION = 1;

/**
 * The persisted entity. Deliberately NOT the live WildlifeEntity: it omits
 * `fleeSecondsRemaining`, because a panic that began before a server restart has
 * no meaning after it, and calm is the state a returning player expects to see.
 *
 * `schoolId` and `size` ARE persisted, and both are additive optional fields
 * rather than a version bump. They have to be persisted because neither is
 * recoverable from what is left: school membership is not derivable from
 * position (two schools can pass through each other), so dropping it would turn
 * every restored school into permanent singletons — a restart would silently
 * undo the entire schooling behaviour. They are optional because a slice written
 * before this change is still perfectly good data, and the honest reading of it
 * is "creatures whose schools we no longer know", not "throw the population
 * away": a missing schoolId yields a school of one, a missing size the default
 * class, and the world re-forms schools through ordinary turnover.
 */
interface PersistedEntity {
  readonly id: number;
  readonly species: WildlifeHabitatSpecies;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly schoolId: number;
  /** Index into WILDLIFE_SIZE_CLASSES, as on the wire. */
  readonly size: number;
}

interface WildlifeSlice {
  readonly version: number;
  /** High-water mark of the id counter, so a restore never reuses an id. */
  readonly nextId: number;
  /** High-water mark of the school-id counter. Same contract as `nextId`. */
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

/**
 * Restores a persisted population defensively, in reveal's house style: the row
 * comes from this server's own SQLite file, but a truncated or hand-edited one
 * must degrade to "an empty world that repopulates itself within a census" and
 * never crash a boot.
 *
 * Entities that survive validation are trusted to be where they were; the first
 * tick's habitat sweep (population.despawnInvalidHabitat) removes any the
 * terrain has since outgrown, so a snapshot restored onto a changed world
 * self-corrects rather than needing a validating world argument here.
 */
/**
 * Sentinel school id for a restored entity whose slice carried none. Real school
 * ids start at 1, so 0 cannot collide with one; every sentinel is replaced with
 * a fresh unique id before the population is installed.
 */
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
        if (!Number.isInteger(id) || (id as number) <= 0 || seenIds.has(id as number)) continue;
        // HABITAT species only, deliberately: birds are never written here
        // (see the persistence note in ./index.ts), so a row claiming to be one
        // is a hand-edited or forward-versioned file and is dropped rather than
        // resurrected as an immortal, censusless creature standing on the sea.
        if (!isWildlifeHabitatSpecies(entry.species)) continue;
        if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
        if (!Number.isFinite(entry.heading)) continue;

        seenIds.add(id as number);
        maxId = Math.max(maxId, id as number);

        // A school id must be a positive integer to be believed; anything else
        // (including absent) means "we do not know", and this creature becomes
        // its own school below.
        const schoolId =
          Number.isInteger(entry.schoolId) && (entry.schoolId as number) > 0
            ? (entry.schoolId as number)
            : UNRECORDED_SCHOOL_ID;
        maxSchoolId = Math.max(maxSchoolId, schoolId);

        restored.push({
          id: id as number,
          species: entry.species,
          schoolId,
          size: sizeOf(entry.size),
          x: entry.x as number,
          y: entry.y as number,
          heading: entry.heading as number,
          fleeSecondsRemaining: 0,
        });
      }

      if (Number.isInteger(slice.nextId)) persistedNext = slice.nextId as number;
      if (Number.isInteger(slice.nextSchoolId)) persistedNextSchool = slice.nextSchoolId as number;
    }
  }

  // Every creature that arrived without a school gets one of its own, numbered
  // above everything the slice used, so a pre-schooling snapshot restores as a
  // population of independent wanderers rather than as one giant school.
  let nextFreeSchool = Math.max(persistedNextSchool, maxSchoolId + 1, 1);
  for (let i = 0; i < restored.length; i++) {
    if (restored[i].schoolId !== UNRECORDED_SCHOOL_ID) continue;
    restored[i] = { ...restored[i], schoolId: nextFreeSchool++ };
  }

  // Ids must never be reused, even if the persisted counter was garbage.
  replacePopulation(restored, Math.max(persistedNext, maxId + 1, 1), nextFreeSchool);
}

/** A persisted size index → its class, defaulting anything unusable. */
function sizeOf(index: unknown): WildlifeSizeClass {
  return typeof index === 'number' && Number.isFinite(index)
    ? sizeClassAt(index)
    : DEFAULT_SIZE_CLASS;
}
