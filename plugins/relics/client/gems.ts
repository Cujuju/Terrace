import {
  CELL_WORLD_SIZE,
  WORLD_UNIT_CELLS,
  cellsAcross,
} from '@terrace/shared';
import type { RelicView, SkillId, SkillKind } from '../protocol.ts';
import { skillInfo } from '../protocol.ts';

export { CELL_WORLD_SIZE };

export const SKILL_KIND_COLOR: Readonly<Record<SkillKind, number>> = {
  passive: 0xffb347,
  active: 0xff5c5c,
  perk: 0x4fc3f7,
};

export function relicColor(skill: SkillId): number {
  return SKILL_KIND_COLOR[skillInfo(skill).kind];
}

export function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export const GEM_RADIUS_CELLS = 0.45;

export const GEM_FOOTPRINT_HALF_EXTENT_CELLS = Math.ceil(GEM_RADIUS_CELLS / CELL_WORLD_SIZE);

export function gemGroundY(
  sample: (cellX: number, cellY: number) => number | null,
  x: number,
  y: number,
): number | null {
  const own = sample(x, y);
  if (own === null) return null;
  let ground = own;
  const reach = GEM_FOOTPRINT_HALF_EXTENT_CELLS;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const sampled = sample(x + dx, y + dy);
      if (sampled !== null && sampled > ground) ground = sampled;
    }
  }
  return ground;
}

export const GEM_HOVER_CELLS = 1.2;

export const GEM_BOB_AMPLITUDE_CELLS = 0.25;

export const GEM_BOB_PERIOD_S = 3;

export const GEM_SPIN_TURNS_PER_S = 1 / 6;

const TAU = Math.PI * 2;

export function gemPhaseFor(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) / 0x100000000) * GEM_BOB_PERIOD_S;
}

export function gemBobOffset(elapsedS: number, phaseS: number): number {
  return Math.sin(((elapsedS + phaseS) / GEM_BOB_PERIOD_S) * TAU) * GEM_BOB_AMPLITUDE_CELLS;
}

export function gemSpinAngle(elapsedS: number, phaseS: number): number {
  return (elapsedS + phaseS) * GEM_SPIN_TURNS_PER_S * TAU;
}

export const RELIC_PICK_RADIUS_CELLS = cellsAcross(4);

export function relicUnderCell(
  relics: readonly RelicView[],
  cell: { x: number; y: number },
): RelicView | null {
  const limitSquared = RELIC_PICK_RADIUS_CELLS * RELIC_PICK_RADIUS_CELLS;

  let best: RelicView | null = null;
  let bestSquared = Number.POSITIVE_INFINITY;

  for (const relic of relics) {
    const dx = relic.x - cell.x;
    const dy = relic.y - cell.y;
    const squared = dx * dx + dy * dy;
    if (squared > limitSquared || squared >= bestSquared) continue;
    best = relic;
    bestSquared = squared;
  }

  return best;
}

export function cooldownLabelSeconds(remainingS: number): number {
  return Math.ceil(remainingS);
}
