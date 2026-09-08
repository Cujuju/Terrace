import { MAX_STRUCTURE_TIER, hashStructureCell, type StructureTier } from '../protocol.ts';

export const DURANDS_SHARE_OF_256 = 43;

export function isDurandsCell(tier: StructureTier, x: number, y: number): boolean {
  if (tier !== MAX_STRUCTURE_TIER) return false;
  const hash = hashStructureCell(x, y);
  const selectionRoll = (hash >>> 24) & 0xff;
  return selectionRoll < DURANDS_SHARE_OF_256;
}
