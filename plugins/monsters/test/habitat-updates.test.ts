import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHabitatIndex, noteTerrainChangedInIndex, releaseHabitatIndex, syncedHabitatIndex,
} from '../server/habitat-index.ts';
import { releaseSurveyScratch, surveyLairs, WATER_HABITAT } from '../server/habitat.ts';
import { lairFitRulesInHabitat } from '../server/kinds.ts';
import { LairCandidates, SUMMON_CANDIDATE_SAMPLE_CELLS } from '../server/lair-candidates.ts';
import { hashToIndex } from '../server/rng.ts';

const SIZE = 64;
const OCEAN_HEIGHT = -600;
const CENTRE = SIZE / 2;
// Changes cover a new extreme, its removal, and admission loss/restoration without changing body fit.
const CHANGES = [
  { x: CENTRE, y: CENTRE, h: -800 },
  { x: CENTRE, y: CENTRE, h: OCEAN_HEIGHT },
  { x: CENTRE, y: CENTRE, h: -492 },
  { x: CENTRE + 1, y: CENTRE, h: -492 },
  { x: CENTRE, y: CENTRE, h: OCEAN_HEIGHT },
  { x: CENTRE + 1, y: CENTRE, h: OCEAN_HEIGHT },
];

afterEach(() => { releaseHabitatIndex(); releaseSurveyScratch(); });

describe('height aggregates retain connected habitat', () => {
  it.each(CHANGES.map((_change, index) => index + 1))('matches a fresh survey after %i height changes without reflooding', (count) => {
    const heights = new Int32Array(SIZE * SIZE).fill(OCEAN_HEIGHT);
    const world = {
      worldSize: SIZE, isCellUnlocked: () => true,
      heightAt: (x: number, y: number) => heights[y * SIZE + x]!,
    };
    const rules = lairFitRulesInHabitat(WATER_HABITAT);
    const specs = [{ regime: WATER_HABITAT, fitRules: rules }];
    const index = syncedHabitatIndex(world, specs);
    const region = surveyLairs(WATER_HABITAT, world, [], rules, index).regions[0]!;
    const regime = index.regimes.get('water')!;
    let habitatReads = 0;
    Object.defineProperty(regime, 'habitat', { value: new Proxy(regime.habitat, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) habitatReads++;
        return Reflect.get(target, key, target);
      },
    }) });
    for (const change of CHANGES.slice(0, count)) {
      heights[change.y * SIZE + change.x] = change.h;
      noteTerrainChangedInIndex([change]);
      expect(regime.dirtyCells).toHaveLength(0);
      habitatReads = 0;
      expect(surveyLairs(WATER_HABITAT, world, [], rules, index).regions[0]).toBe(region);
      expect(habitatReads).toBe(0);
    }
    const actual = structuredClone(region);
    const rebuilt = buildHabitatIndex(world, specs);
    expect(surveyLairs(WATER_HABITAT, world, [], rules, rebuilt).regions[0]).toEqual(actual);
  });
});

it('preserves the original reservoir through admission loss to zero and restoration', () => {
  const order = Int32Array.from({ length: SUMMON_CANDIDATE_SAMPLE_CELLS * 2 }, (_value, ordinal) => ordinal);
  const qualifies = new Uint8Array(order.length).fill(1);
  const sample = new LairCandidates(0, 0, qualifies);
  // Original streaming reservoir, independent of the mutable rank index.
  const legacySample = (): number[] => {
    const result: number[] = [];
    let ordinal = 0;
    for (const cell of order) {
      if (!qualifies[cell]) continue;
      if (ordinal < SUMMON_CANDIDATE_SAMPLE_CELLS) result.push(cell);
      else {
        const slot = hashToIndex((Math.imul(1, 0x85ebca6b) ^ ordinal) | 0, ordinal + 1);
        if (slot < SUMMON_CANDIDATE_SAMPLE_CELLS) result[slot] = cell;
      }
      ordinal++;
    }
    return result;
  };
  expect(sample.cells(order)).toEqual(legacySample());
  for (const present of [0, 1] as const) {
    for (const cell of order) {
      qualifies[cell] = present;
      sample.update(cell, present === 1 ? 1 : -1);
      expect(sample.cells(order)).toEqual(legacySample());
    }
  }
});
