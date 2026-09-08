import type { SculptIntent } from '@terrace/shared';
import { groundProtectionRadiusCells, profileOf } from './kinds.ts';
import type { Monster } from './summoning.ts';

const RAISE_DIRECTION = 1;

export const RAISE_BLOCKED_REASON = 'monster occupies the ground';

export function reachesProtectedGround(intent: SculptIntent, monster: Monster): boolean {
  const profile = profileOf(monster.kind);
  if (!profile.protectsGround) return false;
  if (intent.dir !== RAISE_DIRECTION) return false;

  const reach = intent.radius + groundProtectionRadiusCells(profile);
  const dx = intent.x + 0.5 - monster.x;
  const dy = intent.y + 0.5 - monster.y;
  return dx * dx + dy * dy < reach * reach;
}
