// wildlife:shoals — the producer's contract (skiffs arc, S1).
//
// Two things are pinned here and nothing else: that the fishable set is DERIVED
// from the species table's habitat rather than typed out, and that the emitter
// turns a population into one point per school. There is no consumer yet.

import { describe, expect, it } from 'vitest';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { WILDLIFE_HABITAT_SPECIES, type WildlifeHabitatSpecies } from '../protocol.ts';
import { SPECIES_PROFILES } from '../server/species.ts';
import type { WildlifeEntity } from '../server/population.ts';
import {
  FISHABLE_HABITAT,
  FISHABLE_SPECIES,
  SHOALS_EVENT,
  emitShoals,
  shoalCentroids,
} from '../server/shoals.ts';

/** A creature, reduced to the four fields the shoal derivation reads. */
function creature(
  species: WildlifeHabitatSpecies,
  schoolId: number,
  x: number,
  y: number,
): WildlifeEntity {
  return { species, schoolId, x, y } as WildlifeEntity;
}

describe('the fishable species set', () => {
  // THE TEST THAT FAILS IF SOMEONE HARDCODES A LIST. It never names a species:
  // it asserts membership is exactly `habitat === FISHABLE_HABITAT` over the
  // whole table, so a shallow species added tomorrow passes without an edit and
  // a hand-written roster that missed it fails.
  it('is exactly the species whose habitat is shallow, derived from the table', () => {
    for (const species of WILDLIFE_HABITAT_SPECIES) {
      expect(FISHABLE_SPECIES.has(species)).toBe(
        SPECIES_PROFILES[species].habitat === FISHABLE_HABITAT,
      );
    }
    expect(FISHABLE_SPECIES.size).toBe(
      WILDLIFE_HABITAT_SPECIES.filter((s) => SPECIES_PROFILES[s].habitat === FISHABLE_HABITAT)
        .length,
    );
  });

  // Owner, 2026-09-05: sharks ARE fishable. No exclusion list. Asserted
  // explicitly because "derived" would also be satisfied by a set that quietly
  // subtracted one name, and this is the name that would be subtracted.
  it('includes the shark', () => {
    expect(SPECIES_PROFILES.shark.habitat).toBe(FISHABLE_HABITAT);
    expect(FISHABLE_SPECIES.has('shark')).toBe(true);
  });

  it('excludes deep-water and land species', () => {
    expect(FISHABLE_SPECIES.has('whale')).toBe(false);
    expect(FISHABLE_SPECIES.has('deepsea')).toBe(false);
    expect(FISHABLE_SPECIES.has('grazer')).toBe(false);
  });
});

describe('shoalCentroids', () => {
  it('emits one point per school, at the mean of its members', () => {
    const centroids = shoalCentroids([
      creature('fish', 1, 0, 0),
      creature('fish', 1, 4, 2),
      creature('fish', 2, 10, 10),
    ]);
    expect(centroids).toEqual([
      { species: 'fish', x: 2, y: 1, count: 2 },
      { species: 'fish', x: 10, y: 10, count: 1 },
    ]);
  });

  it('ignores every creature that is not fishable', () => {
    expect(
      shoalCentroids([
        creature('whale', 1, 0, 0),
        creature('deepsea', 2, 1, 1),
        creature('grazer', 3, 2, 2),
      ]),
    ).toEqual([]);
  });

  it('counts a school of one as a school', () => {
    expect(shoalCentroids([creature('shark', 9, 3, 4)])).toEqual([
      { species: 'shark', x: 3, y: 4, count: 1 },
    ]);
  });
});

describe('emitShoals', () => {
  function recordingWorld(): { world: WorldApi; emitted: { type: string; payload: unknown }[] } {
    const emitted: { type: string; payload: unknown }[] = [];
    const world = {
      emitEvent(type: string, payload: unknown) {
        emitted.push({ type, payload });
      },
      // Only emitEvent is reached; the rest of WorldApi is irrelevant here.
    } as unknown as WorldApi;
    return { world, emitted };
  }

  it('emits nothing when no population has been spawned', () => {
    const { world, emitted } = recordingWorld();
    emitShoals(world);
    expect(emitted).toEqual([]);
  });

  it('names the event so the host publishes it as wildlife:shoals', () => {
    expect(SHOALS_EVENT).toBe('shoals');
  });
});
