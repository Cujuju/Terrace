import { type MoverStance } from '@terrace/shared';

export type MoverGait = MoverStance | 'climb' | 'fall';

export const MOVER_GAITS: readonly MoverGait[] = ['walk', 'climb', 'fall', 'stand', 'sit'];

export function moverGaitIndex(gait: MoverGait): number {
  return MOVER_GAITS.indexOf(gait);
}

export function moverGaitOf(
  climbHeight: number | null,
  falling: boolean,
  stance: MoverStance = 'walk',
): MoverGait {
  if (climbHeight === null) return stance;
  return falling ? 'fall' : 'climb';
}
