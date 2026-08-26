// mana — THE PRICE OF A SCULPT, in one place, imported by both halves.
//
// WHY THIS IS ITS OWN MODULE AND NOT A FUNCTION IN EACH HALF. The server charges
// for an intent and the client gates the same intent locally (plugins/mana/
// client/state.ts) so an unaffordable stroke is never sent or predicted. Those
// two answers must be IDENTICAL — not "close", identical: a client that thinks a
// sculpt costs 119 while the server charges 120 lets through a stroke the server
// then denies, which is exactly the phantom-stroke-and-clawback the local gate
// exists to remove. Two implementations of one formula drift the moment either
// is touched, so there is one implementation and both sides import it.
//
// It sits at the plugin root beside protocol.ts, next to the wire contract it
// serves: the balance push carries the RATE (mana per band-cell) and this
// function is what turns that rate into a price. protocol.ts describes the
// shapes on the wire; this describes the arithmetic behind one of its fields.

import { BAND_HEIGHT, sculptDisplacementUnits } from '@terrace/shared';
import type { SculptProfile, SculptTool } from '@terrace/shared';

/**
 * What one sculpt intent costs, given the (already perk-adjusted) rate its
 * payer is charged at.
 *
 * TOOL IS AN ARGUMENT BECAUSE ONE TOOL IS PRICED DIFFERENTLY. Three of the four
 * price by the brush cone and are indistinguishable here; `carve` removes a
 * fixed block of bands and prices as that block (see sculptDisplacementUnits).
 * It is required rather than defaulted so a caller cannot omit it and quietly
 * charge a carve at brush rates — which is the free-tool exploit P3 of the
 * step-4 plan names.
 *
 * THE MODEL (owner-settled 2026-08-14: "define the cost of sculpting in terms of
 * mana"): a sculpt costs mana in proportion to the terrain volume its brush
 * nominally displaces. sculptDisplacementUnits (shared/src/heightmap.ts) is that
 * volume in HEIGHT UNITS × cells, computed with applyBrush's own arithmetic;
 * dividing by BAND_HEIGHT restates it in BAND-CELLS — "one terrace band, moved
 * over one cell" — which is the unit `manaPerBandCell` is denominated in and the
 * unit a player can actually see on the terrain.
 *
 * ARITHMETIC ORDER IS LOAD-BEARING. Written as one expression, evaluated left to
 * right: (rate × units) / BAND_HEIGHT. The rate arrives already multiplied by
 * any perk (the server multiplies before it puts the rate on the wire, so the
 * client receives exactly the number the server used), which makes the whole
 * chain rate → perk → volume → band-cells the same sequence of IEEE operations
 * on both sides, and therefore bit-identical on both sides. Reordering these
 * factors — or dividing before multiplying — would be a different sequence and
 * could differ in the last bit for a fractional perk multiplier.
 *
 * Rounded UP, for the same reason the flat price was: the pool is spent in whole
 * units and shown in whole units, and rounding up means the perk floor
 * (MANA_PERK_MIN_MULTIPLIER) cannot be rounded down into a free sculpt.
 *
 * Throws for a radius outside the brush bounds — sculptDisplacementUnits does
 * the validating. Both callers are downstream of validateSculptIntent, which has
 * already rejected an out-of-range radius, so reaching here with one is a
 * programming error rather than untrusted input.
 */
export function sculptManaCost(
  manaPerBandCell: number,
  radius: number,
  profile: SculptProfile,
  tool: SculptTool,
): number {
  return Math.ceil(
    (manaPerBandCell * sculptDisplacementUnits(radius, profile, tool)) / BAND_HEIGHT,
  );
}
