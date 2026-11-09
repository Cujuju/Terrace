import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE } from '@terrace/shared';
import { STRUCTURES_CAP, structureKey } from '../protocol.ts';
import { buildingKindOf, tierOfKind } from '../settlementRules.ts';
import { GenerationSurvey, stepGeneration, type LiveCellRecord } from '../server/life.ts';
import { isBuildableCell, type StructuresWorld } from '../server/suitability.ts';

function fixture(size = 64): { world: StructuresWorld; edits: Map<number, number> } {
  const edits = new Map<number, number>();
  return { edits, world: {
    worldSize: size, chunksPerEdge: size / CHUNK_SIZE,
    heightAt: (x, y) => edits.get(structureKey(x, y)) ?? 10 * BAND_HEIGHT,
    isCellUnlocked: () => true, isChunkUnlocked: () => true,
  } };
}

function record(id: string, age = 0): LiveCellRecord {
  const kind = buildingKindOf(id)!;
  return { kind, tier: tierOfKind(kind), age };
}

function warm(survey: GenerationSurvey, world: StructuresWorld): void {
  // One whole-map eligibility budget also covers its initial topology labelling.
  expect(survey.advance(world, new Map(), world.chunksPerEdge ** 2)).toBeNull();
}

describe('authoritative incremental generations', () => {
  it('retains standing buildings without exceeding the cap when earlier cells reproduce', () => {
    const { world } = fixture(256);
    const live = new Map<number, LiveCellRecord>();
    for (const [dx, dy] of [[1, 0], [2, 1], [0, 2], [1, 2], [1, 1]]) {
      live.set(structureKey(10 + dx, 10 + dy), record('camp'));
    }
    const campCount = live.size;
    const columns = 32;
    const spacing = 6;
    for (let i = 0; i < STRUCTURES_CAP - campCount; i++) {
      live.set(structureKey(5 + i % columns * spacing, 50 + Math.floor(i / columns) * spacing), record('hut'));
    }
    const result = stepGeneration(world, live);
    expect(result.nextLive.size).toBeLessThanOrEqual(STRUCTURES_CAP);
    for (const [key, previous] of live) {
      if (previous.kind === buildingKindOf('hut')) expect(result.nextLive.has(key)).toBe(true);
    }
  });

  it('reserves in-flight births before another caller founds a structure', () => {
    const { world } = fixture();
    const live = new Map([[structureKey(9, 10), record('camp')],
      [structureKey(10, 10), record('camp')], [structureKey(11, 10), record('camp')]]);
    const survey = new GenerationSurvey();
    warm(survey, world);
    survey.advance(world, live, 1);
    expect(survey.reservedSize(live)).toBe(live.size + 2);
  });

  it('rejects an enlarged lot edited after its anchor was scanned, retaining the supported building', () => {
    const { world, edits } = fixture();
    const key = structureKey(10, 10);
    const live = new Map([[key, record('prehistoric-granary', 11)]]);
    const survey = new GenerationSurvey();
    warm(survey, world);
    expect(survey.advance(world, live, 1)).toBeNull();
    edits.set(structureKey(14, 10), 0);
    survey.forgetStagedBirthsAt(14, 10);
    const result = survey.advance(world, live, world.chunksPerEdge ** 2)!;
    expect(result.nextLive.get(key)?.kind).toBe(buildingKindOf('prehistoric-granary'));
    expect(result.upgraded).toEqual([]);
    expect(isBuildableCell(world, 10, 10, 2)).toBe(true);
    expect(isBuildableCell(world, 10, 10, 4)).toBe(false);
  });

  it('budgets cold eligibility by chunks even on the largest world', () => {
    const readCounts = [64, 2048].map((size) => {
      const { world } = fixture(size);
      let reads = 0;
      const heightAt = world.heightAt;
      world.heightAt = (x, y) => { reads++; return heightAt(x, y); };
      expect(new GenerationSurvey().advance(world, new Map(), 1)).toBeNull();
      return reads;
    });
    expect(readCounts[0]).toBeGreaterThan(0);
    expect(readCounts[1]).toBe(readCounts[0]);
  });
});
