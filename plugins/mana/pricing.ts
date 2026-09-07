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

import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  FULL_BRUSH_RADIUS,
  chunksPerEdge,
  revealChunkIndices,
  sculptDisplacementUnits,
} from '@terrace/shared';
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
 *
 * `sweepSteps` (2026-09-05): how many discs a drag intent sweeps
 * (shared `sculptSweepSteps`). Each step is the disc the pointermove it stands
 * in for would have sent, so a swept flick costs exactly what the same path
 * cost as one intent per cell — and a hostile sender cannot buy a long sweep
 * for the price of one disc. 1 for every other intent.
 */
export function sculptManaCost(
  manaPerBandCell: number,
  radius: number,
  profile: SculptProfile,
  tool: SculptTool,
  sweepSteps: number = 1,
): number {
  return Math.ceil(
    (manaPerBandCell * sculptDisplacementUnits(radius, profile, tool) * sweepSteps) / BAND_HEIGHT,
  );
}


/**
 * WHAT OPENING ONE FOGGED CHUNK COSTS ON TOP OF THE STROKE ITSELF.
 *
 * THE RULE (owner, 2026-09-06): a chunk costs the same to open however you
 * open it. The full brush pays that price as part of its own stroke and owes
 * nothing extra; every narrower brush pays the difference. So the penalty is
 * `fullBrushStroke − thisStroke`, which is zero at FULL_BRUSH_RADIUS by
 * construction rather than by a special case, and rises as the brush shrinks —
 * exactly the shape the owner asked for ("no penalty at maximum brush size,
 * because that's already going to consume pretty much all of your mana").
 *
 * WHY EXPANSION NEEDS A PRICE AT ALL. Since 2026-09-06 the reveal plugin opens
 * every chunk a stroke's FOOTPRINT covers rather than every chunk its diff
 * reached (plugins/reveal), which is what made the frontier predictable. It
 * also made the cheapest brush as good at claiming territory as the dearest
 * one, since a click is a click: without this, the efficient way to take the
 * map would be to poke at its edge with the 0.25 brush. This restores the
 * proportion the volume price already has everywhere else — land costs mana —
 * to the one act that had escaped it.
 *
 * NOT SCALED BY SWEEP STEPS, unlike the stroke price. A swept drag pays per
 * disc because it makes the edit each of those discs would have made; the
 * chunks it opens are counted once each regardless, so the surcharge is per
 * CHUNK and the sweep has already been paid for.
 *
 * A BRUSH WIDER THAN FULL_BRUSH_RADIUS pays nothing: the subtraction floors at
 * zero. That is reachable only by a plugin widening a stroke (relics' Titan's
 * Hand), and a brush bigger than the one the penalty is measured against has
 * already paid more than the penalty asks.
 *
 * Both halves import this, for the reason the whole module exists: the client
 * gate must refuse exactly the strokes the server would refuse.
 */
export function chunkUnlockPenalty(
  manaPerBandCell: number,
  radius: number,
  profile: SculptProfile,
  tool: SculptTool,
): number {
  const full = sculptManaCost(manaPerBandCell, FULL_BRUSH_RADIUS, profile, tool);
  const own = sculptManaCost(manaPerBandCell, radius, profile, tool);
  return full > own ? full - own : 0;
}

/**
 * How many chunks this stroke would OPEN: the ones within reveal reach of the
 * clicked cell that the sculptor has not already unlocked.
 *
 * `isOpen` is the caller's own view of the sculptor's territory — the server
 * asks its per-token mask (WorldApi.isChunkUnlockedForToken), the client asks
 * what it has been sent (ClientPluginCtx.revealedAt, which IS that mask: a
 * locked chunk is never on the wire). One function so the two counts are the
 * same count, over the same disc the reveal plugin will open (shared's
 * revealChunkIndices).
 *
 * NO RADIUS. The reveal reach is flat across every brush since 2026-09-06, so
 * the brush decides the PRICE of the land (chunkUnlockPenalty above) and never
 * how much of it there is.
 */
export function openedChunkCount(
  worldSize: number,
  x: number,
  y: number,
  isOpen: (cx: number, cy: number) => boolean,
): number {
  const cols = chunksPerEdge(worldSize);
  let opened = 0;
  for (const index of revealChunkIndices(worldSize, x, y)) {
    if (!isOpen(index % cols, Math.floor(index / cols))) opened++;
  }
  return opened;
}

/** A chunk's origin cell — what a cell-granular `isOpen` is asked about. */
export function chunkOriginCell(cx: number, cy: number): { x: number; y: number } {
  return { x: cx * CHUNK_SIZE, y: cy * CHUNK_SIZE };
}
