import { describe, expect, it } from 'vitest';
import { bandLevelHeight, CHUNK_SIZE } from '@terrace/shared';
import { buildingKindOf, tierOfKind } from '../settlementRules.ts';
import { createGrowthContext } from '../server/growth-context.ts';
import { stepPopulous } from '../../populous/server/model.ts';
import { structureKey } from '../protocol.ts';
import type { StructuresWorld } from '../server/suitability.ts';

function ground(band: number): StructuresWorld {
  return { worldSize: 64, chunksPerEdge: 64 / CHUNK_SIZE,
    heightAt: () => bandLevelHeight(band), isChunkUnlocked: () => true, isCellUnlocked: () => true };
}

describe('the resolved growth stage contract', () => {
  it('absorbs an earlier retained camp and its emission when a later upgrade claims its lot', () => {
    const world = ground(10);
    world.heightAt = (x, y) => x >= 8 && x <= 25 && y >= 8 && y <= 12 ? 160 : 0;
    const kind = buildingKindOf('reed-cone')!;
    const first = structureKey(10, 10), second = structureKey(14, 10);
    const records = [first, second].map((key) => [key, { kind, tier: tierOfKind(kind), age: 1, population: 7 }] as const);
    for (const order of [records, [...records].reverse()]) {
      const result = stepPopulous(world, new Map(order), createGrowthContext(world));
      expect([...result.nextLive.keys()]).toEqual([second]);
      expect(result.nextLive.get(second)?.kind).toBe(buildingKindOf('upturned-hull'));
      expect(result.died).toEqual([{ x: 10, y: 10 }]);
      expect(result.emitted).not.toContainEqual({ x: 10, y: 10 });
      expect(result.upgraded).toEqual([{ x: 14, y: 10, kind: buildingKindOf('upturned-hull'), tier: 2 }]);
    }
  });
  it('returns the actual model tier for unattainable site ranks', () => {
    const ctx = createGrowthContext(ground(25));
    const stage = ctx.resolveStage(20, 20, ctx.maxTier);
    expect(stage.tier).toBe(tierOfKind(stage.kind));
    expect(stage.tier).toBeLessThan(ctx.maxTier);
  });

  it('validates the proposed model footprint instead of the founding lot', () => {
    const world = ground(10);
    const land = world.heightAt;
    world.heightAt = (x, y) => x === 23 && y === 20 ? 0 : land(x, y);
    const ctx = createGrowthContext(world);
    expect(ctx.isBuildable(20, 20)).toBe(true);
    expect(ctx.isBuildable(20, 20, buildingKindOf('hut')!)).toBe(true);
    expect(ctx.isBuildable(20, 20, buildingKindOf('twin-hut-yard-plain')!)).toBe(false);
  });

  it('advances one authored entry across sparse and equal complexity ranks', () => {
    for (const [band, from, to] of [
      [10, 'timber-house', 'renaissance-workshop'],
      [40, 'windbreak-dome', 'turf-roof-on-stone-plain'],
      [25, 'watchtower', 'medieval-dovecote'],
    ] as const) {
      const ctx = createGrowthContext(ground(band));
      const kind = buildingKindOf(from)!;
      const next = buildingKindOf(to)!;
      const current = { kind, tier: tierOfKind(kind), age: 20 };
      expect(ctx.nextStage(20, 20, ctx.maxTier, current)).toEqual({ kind: next, tier: tierOfKind(next) });
      if (tierOfKind(next) > current.tier) {
        expect(ctx.nextStage(20, 20, current.tier, current)).toEqual({ kind, tier: current.tier });
      }
    }
  });

  it('does not invent landmarks after the last authored chain entry', () => {
    const ctx = createGrowthContext(ground(25));
    const kind = buildingKindOf('medieval-dovecote')!;
    const current = { kind, tier: tierOfKind(kind), age: 20 };
    expect(ctx.nextStage(20, 20, ctx.maxTier, current)).toEqual({ kind, tier: current.tier });
  });
});
