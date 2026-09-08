import { createSeededRng } from '@terrace/shared';

export { worldWithTerrain } from '../../../../server/test/support/world.ts';

export function seededRandom(seed: number): () => number {
  return createSeededRng(seed).next;
}
