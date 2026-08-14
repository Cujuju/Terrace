// The on-disk shape of a population, and the defensive read-back.
//
// Separate from population.ts on purpose: that module owns LIVE state and its
// rules; this one owns the SERIALIZED format and its validation. Keeping them
// apart is what stops a future field being added to the live entity and silently
// becoming part of the snapshot contract.

import { WILDLIFE_SPECIES, type WildlifeSpecies } from '../protocol.ts';
import { WILDLIFE_POPULATION_CAP } from './census.ts';
import {
  type WildlifeEntity,
  livingEntities,
  nextEntityIdValue,
  replacePopulation,
} from './population.ts';

/** Schema version of this plugin's persistence slice. */
export const WILDLIFE_SLICE_VERSION = 1;

/**
 * The persisted entity. Deliberately NOT the live WildlifeEntity: it omits
 * `fleeSecondsRemaining`, because a panic that began before a server restart has
 * no meaning after it, and calm is the state a returning player expects to see.
 */
interface PersistedEntity {
  readonly id: number;
  readonly species: WildlifeSpecies;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

interface WildlifeSlice {
  readonly version: number;
  /** High-water mark of the id counter, so a restore never reuses an id. */
  readonly nextId: number;
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
    });
  }

  return {
    version: WILDLIFE_SLICE_VERSION,
    nextId: nextEntityIdValue(),
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
export function loadPopulation(data: unknown): void {
  const restored: WildlifeEntity[] = [];
  let maxId = 0;
  let persistedNext = 0;

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
        if (!(WILDLIFE_SPECIES as readonly string[]).includes(entry.species as string)) continue;
        if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
        if (!Number.isFinite(entry.heading)) continue;

        seenIds.add(id as number);
        maxId = Math.max(maxId, id as number);
        restored.push({
          id: id as number,
          species: entry.species as WildlifeSpecies,
          x: entry.x as number,
          y: entry.y as number,
          heading: entry.heading as number,
          fleeSecondsRemaining: 0,
        });
      }

      if (Number.isInteger(slice.nextId)) persistedNext = slice.nextId as number;
    }
  }

  // Ids must never be reused, even if the persisted counter was garbage.
  replacePopulation(restored, Math.max(persistedNext, maxId + 1, 1));
}
