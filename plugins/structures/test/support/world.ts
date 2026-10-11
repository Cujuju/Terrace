import type { StructureCell } from '../../protocol.ts';
import { tierOfKind } from '../../settlementRules.ts';
import { foundingKindAt, type StructuresWorld } from '../../server/suitability.ts';

export { worldWithTerrain } from '../../../../server/test/support/world.ts';

/** The building the server founds here: the first step of the ground's category chain. */
export function foundedAt(world: StructuresWorld, x: number, y: number): StructureCell {
  const kind = foundingKindAt(world, x, y);
  if (kind === null) throw new Error(`no settlement category takes (${x}, ${y})`);
  return { x, y, tier: tierOfKind(kind), kind };
}
