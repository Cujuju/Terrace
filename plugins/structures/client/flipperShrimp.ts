import { MAX_STRUCTURE_TIER, hashStructureCell, type StructureTier } from '../protocol.ts';
import { DURANDS_SHARE_OF_256 } from './durands.ts';
import { RICKS_SHARE_OF_256 } from './ricks.ts';

export const FLIPPER_SHRIMP_SHARE_OF_256 = 24;

/** Waterfront clubhouse: only on the two lowest land bands, next to the shore. */
export const FLIPPER_SHRIMP_MAX_BAND = 1;

const FLIPPER_SHRIMP_ROLL_START = DURANDS_SHARE_OF_256 + RICKS_SHARE_OF_256;

export function isFlipperShrimpCell(tier: StructureTier, x: number, y: number, band: number): boolean {
  if (tier !== MAX_STRUCTURE_TIER || band < 0 || band > FLIPPER_SHRIMP_MAX_BAND) return false;
  const selectionRoll = (hashStructureCell(x, y) >>> 24) & 0xff;
  return selectionRoll >= FLIPPER_SHRIMP_ROLL_START && selectionRoll < FLIPPER_SHRIMP_ROLL_START + FLIPPER_SHRIMP_SHARE_OF_256;
}
