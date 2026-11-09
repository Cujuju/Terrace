import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, newStillness } from '@terrace/shared';
import { takeCensus, targetsFor, type HabitatWorld } from '../server/census.ts';
import { invalidateCensusIndex } from '../server/census-index.ts';
import { EXHAUSTED_IDENTITY } from '../server/identity.ts';
import { loadPopulation } from '../server/persistence.ts';
import {
  advancePopulation,
  allocateEntityId,
  burnableEntityAt,
  despawnWithCredit,
  livingEntities,
  nextSchoolIdValue,
  pendingCreditsSnapshot,
  populationTargets,
  replacePopulation,
  resetPopulation,
  type WildlifeEntity,
} from '../server/population.ts';
import type { WildlifeHabitatSpecies } from '../protocol.ts';

function creature(id: number, species: WildlifeHabitatSpecies, x = 96, y = 96): WildlifeEntity {
  return {
    id, species, schoolId: id, size: 'medium', x, y, heading: 0, climb: null,
    fleeSecondsRemaining: 0, idle: false, huntTargetId: null,
    huntSecondsRemaining: 0, huntRestSecondsRemaining: 0, ...newStillness(x, y),
  };
}

afterEach(() => {
  resetPopulation();
  invalidateCensusIndex();
  vi.restoreAllMocks();
});

describe('cell-addressed wildlife fuel', () => {
  it('queries the server-frame cell centre and filters eligibility before choosing nearest', () => {
    const closest = creature(1, 'grazer', 10.5, 10.5);
    const eligible = creature(2, 'grazer', 10.75, 10.75);
    replacePopulation([closest, eligible], 3, 3);
    expect(burnableEntityAt(10, 10)?.entity.id).toBe(1);
    const found = burnableEntityAt(10, 10, (id) => id === 2);
    expect(found?.entity.id).toBe(2);
    expect(found?.distanceCells).toBeCloseTo(Math.hypot(0.25, 0.25));
    expect(burnableEntityAt(11, 11)).toBeNull();
  });
});

describe('spawn credits', () => {
  it('redeems only ready credits without increasing living plus pending members', () => {
    const world: HabitatWorld = {
      worldSize: 192, chunksPerEdge: 192 / CHUNK_SIZE, heightAt: () => -64,
      isCellUnlocked: () => true, isChunkUnlocked: () => true,
    };
    const population: WildlifeEntity[] = [];
    let id = 1;
    for (const [species, count] of Object.entries(targetsFor(takeCensus(world).cellsBySpecies))) {
      for (let n = 0; n < count; n++) population.push(creature(id++, species as WildlifeHabitatSpecies));
    }
    replacePopulation(population, id, id);
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    advancePopulation(world, 0);
    const removeFish = () => despawnWithCredit(livingEntities().findIndex((entity) => entity.species === 'fish'));
    removeFish();
    for (let n = 0; n < 10; n++) advancePopulation(world, 0.1);
    for (let n = 0; n < 4; n++) removeFish();
    for (let n = 0; n < 71; n++) advancePopulation(world, 0.1);
    const fishCount = () => livingEntities().filter((entity) => entity.species === 'fish').length;
    const credits = () => pendingCreditsSnapshot().filter((credit) => credit.species === 'fish').length;
    const spawn = () => {
      const schools = new Set(livingEntities().map((entity) => entity.schoolId)).size;
      let draws = 0;
      rng.mockImplementation(() => draws++ < schools ? 0.999 : draws === schools + 1 ? 0 : 0.5);
      advancePopulation(world, 0.1);
      rng.mockReturnValue(0.999);
    };
    spawn();
    expect(fishCount()).toBe(1);
    expect(credits()).toBe(4);
    expect(fishCount() + credits()).toBe(populationTargets().fish);
    for (let n = 0; n < 10; n++) advancePopulation(world, 0.1);
    spawn();
    expect(fishCount()).toBe(populationTargets().fish);
    expect(credits()).toBe(0);
  });
});

describe('restored identity counters', () => {
  it('ignores unsafe rows and counters, and reconstructs safe entity and school successors', () => {
    const row = { id: 7, species: 'fish', x: 10, y: 10, heading: 0, schoolId: 1e20 };
    for (const counter of [1e20, -1, 0, 1.5]) {
      loadPopulation({ version: 1, nextId: counter, nextSchoolId: counter, entities: [row, { ...row, id: counter }] });
      expect(livingEntities().map((entity) => entity.id)).toEqual([7]);
      expect(allocateEntityId()).toBe(8);
      expect(allocateEntityId()).toBe(9);
      expect(nextSchoolIdValue()).toBe(2);
      expect(livingEntities()[0]!.schoolId).toBe(1);
    }
  });

  it('fails explicitly at identity exhaustion rather than reissuing a number', () => {
    replacePopulation([], EXHAUSTED_IDENTITY - 1, 1);
    expect(allocateEntityId()).toBe(EXHAUSTED_IDENTITY - 1);
    expect(() => allocateEntityId()).toThrow('identity space exhausted');
    loadPopulation({ version: 1, nextId: EXHAUSTED_IDENTITY, entities: [] });
    expect(() => allocateEntityId()).toThrow('identity space exhausted');
  });
});
