import { SEA_LEVEL, cellsAcross } from '@terrace/shared';
import type { MonsterKind } from '../protocol.ts';
import { CTHULHU_LURK_DEPTH } from './anatomy.ts';
import { KRAKEN_LURK_DEPTH } from './kraken-anatomy.ts';
import { YETI_FOOT_GROUND_HALF_EXTENT } from './yeti-anatomy.ts';

export const SEA_SURFACE_WORLD_Y: 0 = SEA_LEVEL;

export const UNKNOWN_TERRAIN_WORLD_Y = 0;

export type MonsterPlacementRule =
  | { readonly placement: 'swimmer'; readonly lurkDepth: number }
  | { readonly placement: 'walker'; readonly footGroundHalfExtentCells: number };

const PLACEMENT_BY_KIND: Readonly<Record<MonsterKind, MonsterPlacementRule>> = {
  cthulhu: { placement: 'swimmer', lurkDepth: CTHULHU_LURK_DEPTH },
  kraken: { placement: 'swimmer', lurkDepth: KRAKEN_LURK_DEPTH },
  yeti: {
    placement: 'walker',
    footGroundHalfExtentCells: cellsAcross(YETI_FOOT_GROUND_HALF_EXTENT),
  },
};

export function placementRuleOf(kind: MonsterKind): MonsterPlacementRule {
  return PLACEMENT_BY_KIND[kind];
}

export function lurkDepthOf(kind: MonsterKind): number {
  const rule = placementRuleOf(kind);
  if (rule.placement !== 'swimmer') {
    throw new Error(`${kind} is not placed in the water`);
  }
  return rule.lurkDepth;
}

export function monsterOriginWorldY(seabedY: number | null, lurkDepth: number): number {
  const preferred = SEA_SURFACE_WORLD_Y - lurkDepth;
  if (seabedY === null) return preferred;
  return Math.max(seabedY, preferred);
}

export function walkerGroundWorldY(
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
  halfExtentCells: number,
): number | null {
  let ground: number | null = null;
  for (const [dx, dy] of [
    [0, 0],
    [-halfExtentCells, -halfExtentCells],
    [-halfExtentCells, halfExtentCells],
    [halfExtentCells, -halfExtentCells],
    [halfExtentCells, halfExtentCells],
  ]) {
    const sampled = sampleRenderedY(Math.floor(x + dx!), Math.floor(y + dy!));
    if (sampled !== null && (ground === null || sampled > ground)) ground = sampled;
  }
  return ground;
}

export function monsterOriginY(
  kind: MonsterKind,
  sampleRenderedY: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
): number {
  const rule = placementRuleOf(kind);
  if (rule.placement === 'walker') {
    const ground = walkerGroundWorldY(sampleRenderedY, x, y, rule.footGroundHalfExtentCells);
    return ground ?? UNKNOWN_TERRAIN_WORLD_Y;
  }
  return monsterOriginWorldY(sampleRenderedY(Math.floor(x), Math.floor(y)), rule.lurkDepth);
}

export function submergedFraction(originY: number, totalHeight: number): number {
  if (totalHeight <= 0) return 0;
  const submerged = SEA_SURFACE_WORLD_Y - originY;
  return Math.min(1, Math.max(0, submerged / totalHeight));
}
