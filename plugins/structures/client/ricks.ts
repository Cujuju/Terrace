import { MAX_STRUCTURE_TIER, hashStructureCell, type StructureTier } from '../protocol.ts';
import { DURANDS_SHARE_OF_256 } from './durands.ts';

export const RICKS_SHARE_OF_256 = 24;

export function isRicksCell(tier: StructureTier, x: number, y: number): boolean {
  if (tier !== MAX_STRUCTURE_TIER) return false;
  const selectionRoll = (hashStructureCell(x, y) >>> 24) & 0xff;
  return selectionRoll >= DURANDS_SHARE_OF_256 && selectionRoll < DURANDS_SHARE_OF_256 + RICKS_SHARE_OF_256;
}
