// WHERE THE FISH ARE, as a server-side world event (2026-09-05, issue #370).
//
// Wildlife has only ever LISTENED (fire-event.ts). This is its first emission,
// and it exists for the skiffs arc: a fishing boat has to know where a shoal
// is, and plugins may not import one another, so the event bus is the seam.
//
// NOT A BROADCAST. WorldApi.emitEvent is server-side only — no wire bytes, and
// the fog-of-war question that governs what CLIENTS learn is untouched. Modelled
// on plugins/monsters/server/index.ts's emitPositions, which is the same shape
// for the same reason.
//
// ONE POINT PER SCHOOL, NOT PER FISH. `WildlifeEntity.schoolId` is first-class
// (./population.ts) and schools are far fewer than creatures — a full 850-strong
// population is a couple of hundred schools at most. That ratio is the whole
// reason this event is cheap enough to fire every tick.

import type { WildlifeHabitatSpecies } from '../protocol.ts';
import { WILDLIFE_HABITAT_SPECIES } from '../protocol.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { SPECIES_PROFILES } from './species.ts';
import { livingEntities, type WildlifeEntity } from './population.ts';

/** The un-namespaced event name; the host publishes it as `wildlife:shoals`. */
export const SHOALS_EVENT = 'shoals';

/**
 * The habitat a species must live in for a skiff to be able to fish it.
 *
 * `'shallow'` is the water a small boat can reach and the fish it can plausibly
 * work: deep-water species (whale, deepsea) live past the shelf, and land
 * species are not fish at all. Named rather than inlined so the decision — "a
 * skiff fishes the shallows" — is stated once and read at the one place it
 * matters.
 */
export const FISHABLE_HABITAT = 'shallow';

/**
 * Every species a skiff can fish, DERIVED FROM THE TABLE AND NEVER TYPED OUT.
 *
 * At the shipped table that is fish, angelfish, eel, ray and shark. Writing
 * those five names here instead would compile forever and be wrong the day a
 * sixth shallow species lands — which is exactly how this plugin's fire alarm
 * went stale twice in one day before it was derived (see
 * SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND in ./species.ts). A shallow species
 * added later is fishable the day it arrives, with no list to forget.
 *
 * SHARKS ARE IN IT, deliberately (owner, 2026-09-05). There is no exclusion
 * list; adding one would put back the hand-maintained roster this set exists to
 * remove.
 *
 * Iterates WILDLIFE_HABITAT_SPECIES, the plugin's fixed order, so membership
 * does not depend on object key order. Computed once at module load.
 */
export const FISHABLE_SPECIES: ReadonlySet<WildlifeHabitatSpecies> = new Set(
  WILDLIFE_HABITAT_SPECIES.filter(
    (species) => SPECIES_PROFILES[species].habitat === FISHABLE_HABITAT,
  ),
);

/** One school, reduced to the single point a boat would steer at. */
export interface ShoalCentroid {
  readonly species: WildlifeHabitatSpecies;
  /** Cell-space mean of the school's living members, fractional. */
  readonly x: number;
  readonly y: number;
  /** Living members averaged into this point. Always at least 1. */
  readonly count: number;
}

/**
 * Collapses a population into one centroid per fishable school.
 *
 * PURE, and takes its entities rather than reading the module's — the derivation
 * is the contract worth testing, and a test should not have to grow a world to
 * reach it.
 *
 * A SINGLE PASS, keyed by schoolId. `schoolMembers()` answers the same question
 * per school, but calling it once per school is a filter over the whole
 * population per school; this walks the population once. Insertion order into
 * the Map is entity order, which is spawn order, so the emitted list is
 * deterministic.
 *
 * A school of one is a legal school (see WildlifeEntity.schoolId): solitary
 * species and non-schooling draws each get one to themselves, and they emit as
 * a shoal of one rather than as nothing.
 */
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

/**
 * Emits `wildlife:shoals` for this tick.
 *
 * SKIPPED ENTIRELY WHEN NOTHING IS FISHABLE, which is the common case on a land
 * world: the cost is then one walk of the population and no fan-out to every
 * installed plugin. Same discipline as monsters' emitPositions, which returns
 * early when nothing is alive.
 *
 * Every tick rather than on the broadcast cadence, for the same reason monsters
 * emits every tick: a consumer steering a hull needs the freshest fix the sim
 * has, and halving the rate would quantise its course for no saving on the wire
 * — there are no wire bytes here to save.
 */
export function emitShoals(world: WorldApi): void {
  const shoals = shoalCentroids(livingEntities());
  if (shoals.length === 0) return;
  world.emitEvent(SHOALS_EVENT, { shoals });
}
