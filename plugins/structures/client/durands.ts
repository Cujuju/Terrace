// durands.ts — client-only cosmetic variant selection for the TOP structure
// tier (MAX_STRUCTURE_TIER, the watchtower). Chooses, per cell, whether the
// standing building renders as the standard model or as "Durand's" — a
// stylised saloon skin with a flashing sign — and nothing else: no wire
// message, no server-side concept of "Durand's" exists anywhere, exactly the
// "client-side only" brief.
//
// Pure function of the cell coordinates, using the SAME hash
// protocol.ts's structureVariation already spends on yaw/scale — the
// identical trick flora's kind roll uses (see flora/protocol.ts's
// hashCell + FLORA_CONIFER_SHARE_OF_256), extended with one more disjoint
// bit-slice so every client renders the identical choice for the identical
// cell with no correlation to that cell's facing or size roll.
//
// Deliberately kept OUT of protocol.ts even though it reuses that file's
// hash: protocol.ts is the wire contract both client and server import, and
// this is a rendering-only decision the server has no reason to know about.

import { MAX_STRUCTURE_TIER, hashStructureCell, type StructureTier } from '../protocol.ts';

/**
 * Share of TOP-TIER cells that render as Durand's, expressed the same way
 * flora's FLORA_CONIFER_SHARE_OF_256 is: a numerator over the 256 values one
 * hash byte can take. 256 / 6 ≈ 42.7; 43 is the nearest integer numerator, so
 * this lands at 43/256 ≈ 16.8% — the closest a single hash byte can get to
 * the "about 1 in 6 top-tier cells" the brief asks for.
 */
export const DURANDS_SHARE_OF_256 = 43;

/**
 * True if the structure standing at cell (x, y) should render as Durand's
 * rather than its tier's standard model.
 *
 * The tier gate is PART OF THIS FUNCTION'S OWN CONTRACT, not something each
 * call site has to remember: passing anything but MAX_STRUCTURE_TIER always
 * returns false, full stop, before the hash is even computed. That is the
 * one property this whole variant must never violate — "only at the top
 * tier" — so it lives in the one place that can make it impossible to get
 * wrong, rather than as a convention every caller has to uphold on its own.
 *
 * Below MAX_STRUCTURE_TIER: reads bits 24-31 of the hash. protocol.ts's
 * structureVariation already spends bits 0-15 on yaw and bits 16-23 on
 * scale; reading a disjoint slice here means a cell's Durand's-or-not roll
 * never correlates with its facing or size, exactly as yaw and scale do not
 * correlate with each other.
 */
export function isDurandsCell(tier: StructureTier, x: number, y: number): boolean {
  if (tier !== MAX_STRUCTURE_TIER) return false;
  const hash = hashStructureCell(x, y);
  const selectionRoll = (hash >>> 24) & 0xff;
  return selectionRoll < DURANDS_SHARE_OF_256;
}
