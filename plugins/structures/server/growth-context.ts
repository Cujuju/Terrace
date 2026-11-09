import { MAX_STRUCTURE_TIER, footprintRadiusOfKind } from '../protocol.ts';
import { SETTLEMENT_RULES, categoryAt, kindForTier, nextKindInChain, tierOfKind } from '../settlementRules.ts';
import { CAMP_GRADE_STEP, chainStepAt, hasBuildingWithinSeparation, surveyUpgradeLot } from './clearance.ts';
import type { GrowthCellRecord, GrowthContext, GrowthStage } from './growth-model.ts';
import { isBuildableCell, type StructuresWorld } from './suitability.ts';

const FALLBACK_KIND = SETTLEMENT_RULES.categories[0]!.chain[0]!;

export function resolveGrowthStage(
  world: StructuresWorld,
  x: number,
  y: number,
  tier: number,
  current?: GrowthCellRecord,
): GrowthStage {
  const known = current?.kind;
  if (known !== undefined && tierOfKind(known) === tier) return { kind: known, tier };
  const category = categoryAt(world, x, y);
  const kind = category === null ? known ?? FALLBACK_KIND : kindForTier(category, tier);
  return { kind, tier: tierOfKind(kind) };
}

export function createGrowthContext(world: StructuresWorld): GrowthContext {
  return {
    isBuildable: (x, y, kind) => isBuildableCell(world, x, y,
      kind === undefined ? undefined : footprintRadiusOfKind(kind)),
    resolveStage: (x, y, tier, current) => resolveGrowthStage(world, x, y, tier, current),
    nextStage(x, y, ceiling, current) {
      const stage = resolveGrowthStage(world, x, y, current.tier, current);
      if (ceiling < stage.tier) return resolveGrowthStage(world, x, y, ceiling, current);
      const category = categoryAt(world, x, y);
      const kind = category === null ? null : nextKindInChain(category, stage.kind);
      return kind === null || tierOfKind(kind) > ceiling ? stage : { kind, tier: tierOfKind(kind) };
    },
    maxTier: MAX_STRUCTURE_TIER,
    hasBuildingWithinSeparation: (cells, x, y, kind) =>
      hasBuildingWithinSeparation(cells, world, x, y, footprintRadiusOfKind(kind)),
    absorbedByUpgrade: (cells, x, y, kind) => chainStepAt(world, x, y, kind) <= CAMP_GRADE_STEP
      ? [] : surveyUpgradeLot(cells, world, x, y, CAMP_GRADE_STEP, kind).absorbed,
  };
}
