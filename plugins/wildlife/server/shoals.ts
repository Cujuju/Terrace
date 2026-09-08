import type { WildlifeHabitatSpecies } from '../protocol.ts';
import { WILDLIFE_HABITAT_SPECIES } from '../protocol.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { SPECIES_PROFILES } from './species.ts';
import { livingEntities, type WildlifeEntity } from './population.ts';

export const SHOALS_EVENT = 'shoals';

export const FISHABLE_HABITAT = 'shallow';

export const FISHABLE_SPECIES: ReadonlySet<WildlifeHabitatSpecies> = new Set(
  WILDLIFE_HABITAT_SPECIES.filter(
    (species) => SPECIES_PROFILES[species].habitat === FISHABLE_HABITAT,
  ),
);

export interface ShoalCentroid {
  readonly species: WildlifeHabitatSpecies;
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

export function shoalCentroids(entities: readonly WildlifeEntity[]): ShoalCentroid[] {
  const sums = new Map<number, { species: WildlifeHabitatSpecies; x: number; y: number; count: number }>();

  for (const entity of entities) {
    if (!FISHABLE_SPECIES.has(entity.species)) continue;
    const sum = sums.get(entity.schoolId);
    if (sum === undefined) {
      sums.set(entity.schoolId, { species: entity.species, x: entity.x, y: entity.y, count: 1 });
      continue;
    }
    sum.x += entity.x;
    sum.y += entity.y;
    sum.count++;
  }

  const centroids: ShoalCentroid[] = [];
  for (const sum of sums.values()) {
    centroids.push({
      species: sum.species,
      x: sum.x / sum.count,
      y: sum.y / sum.count,
      count: sum.count,
    });
  }
  return centroids;
}

export function emitShoals(world: WorldApi): void {
  const shoals = shoalCentroids(livingEntities());
  if (shoals.length === 0) return;
  world.emitEvent(SHOALS_EVENT, { shoals });
}
