import type { CellDiff, SculptIntent } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import type { ManaUnlockPolicy } from '../protocol.ts';

// Copied contract: reveal owns both pre-effect bounds and post-effect unlock plans.
interface RevealPolicy {
  sculptUnlockChunks(worldSize: number, intent: SculptIntent, diff?: readonly CellDiff[]): number[];
}

let policy: RevealPolicy | null = null;

export function loadRevealPolicy(world: WorldApi): void {
  const sibling = world.sibling('reveal');
  policy = sibling !== null && typeof sibling.sculptUnlockChunks === 'function'
    ? sibling as unknown as RevealPolicy : null;
}

export function clearRevealPolicy(): void {
  policy = null;
}

export function manaUnlockPolicy(): ManaUnlockPolicy {
  return policy === null ? 'none' : 'reveal';
}

export function activeUnlockChunks(worldSize: number, intent: SculptIntent, diff?: readonly CellDiff[]): number[] {
  return policy?.sculptUnlockChunks(worldSize, intent, diff) ?? [];
}
