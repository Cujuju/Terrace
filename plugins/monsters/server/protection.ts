import { pointWithinSweep, strokeSweep, type SculptIntent } from '@terrace/shared';
import { groundProtectionRadiusCells, profileOf } from './kinds.ts';
import type { Monster } from './summoning.ts';

const RAISE_DIRECTION = 1;

/** A monster stands at a world point; a sweep is drawn in cell indices. */
const CELL_CENTRE_OFFSET = 0.5;

export const RAISE_BLOCKED_REASON = 'monster occupies the ground';

export function reachesProtectedGround(intent: SculptIntent, monster: Monster): boolean {
  const profile = profileOf(monster.kind);
  if (!profile.protectsGround) return false;
  if (intent.dir !== RAISE_DIRECTION) return false;

  return pointWithinSweep(
    strokeSweep(intent),
    monster.x - CELL_CENTRE_OFFSET,
    monster.y - CELL_CENTRE_OFFSET,
    groundProtectionRadiusCells(profile),
  );
}
