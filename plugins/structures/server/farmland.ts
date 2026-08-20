// FARMLAND, THIS PLUGIN'S HALF — card 28, "Terrace Farming": "Flat terraces
// adjacent to water grow visible crops that feed settlement growth — the CA's
// birth rate rises near fed towns."
//
// The PREDICATE ("is this cell farmland") lives in @terrace/shared's
// farmland.ts, not here. It is pure terrain math with two consumers — this
// plugin's CA birth rule and flora's crop renderer — and shared/ is this
// project's single source of truth for exactly that (CLAUDE.md, design §3.3).
// It briefly shipped as two identical per-plugin copies; read shared/src/
// farmland.ts's header for why that was collapsed, and shared/src/traversal.ts
// for the pilgrim-walking-up-a-cliff bug that duplicated terrain math caused
// the same day.
//
// What stays HERE is the one thing that is genuinely this plugin's business:
// turning "is that cell farmland" into "is this CA birth candidate near a fed
// town". It feeds life.ts's B3/S23 birth rule ONLY, has exactly one consumer,
// and is never broadcast.

import { isFarmlandCell, type FarmlandWorld } from '@terrace/shared';

export type { FarmlandWorld };

/**
 * The Moore neighbourhood (all eight surrounding cells), duplicated from
 * life.ts's MOORE_OFFSETS rather than imported — both files are already
 * intra-plugin, so importing IS legal here, but life.ts's own copy exists
 * specifically to be "the identical neighbourhood B3/S23 itself counts"
 * (see its own header), and this module has no reason to reach into life.ts
 * (the CA module) to borrow a constant that predates and does not depend on
 * it. A two-line offset table is cheaper to duplicate than to couple.
 */
const MOORE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

/**
 * "Near a fed town" — the birth-rate half of the card, made concrete: is
 * (x, y), or any of its eight Moore neighbours, farmland?
 *
 * WHY THE FULL MOORE NEIGHBOURHOOD AND NOT JUST THE CANDIDATE CELL ITSELF.
 * A birth candidate with the relaxed threshold this predicate unlocks
 * (life.ts's B{2,3} rule) already has exactly 2 live Moore neighbours — i.e.
 * it is, by construction, standing right next to a forming or established
 * settlement. Checking the candidate's own Moore neighbourhood for farmland
 * (rather than only its own single cell) is what makes "near a fed town"
 * true to its name: a farm plot one cell from a hamlet feeds the HAMLET, not
 * only a building erected directly on top of the field.
 *
 * COST, MEASURED (ad hoc, this session, not committed — the same "run once,
 * record the number" precedent shared/perf_rivers.ts set for card 27). A
 * full 512² sweep calling this function for EVERY cell — a strict upper
 * bound; the CA only ever calls it for DEAD, buildable cells with EXACTLY 2
 * live neighbours, a small fraction of the board — measured 25.19ms median
 * (10 trials) on an adversarial checkerboard-and-band-mix terrain chosen to
 * defeat every early exit. life.ts's GenerationSurvey already amortises its
 * whole-board pass over CA_GENERATION_INTERVAL_SECONDS (15s) at the shipped
 * TICK_HZ (10), i.e. ~150 ticks per generation: spread evenly, even this
 * worst-case whole-board figure costs 25.19 / 150 ≈ 0.17ms of EXTRA work per
 * tick on average, and even a single tick absorbing the entire 25.19ms in
 * one burst (the sweep's cursor stalled and resumed) spends a quarter of one
 * 100ms tick — comfortably inside budget, and cheaper in every real
 * generation than this bound, since the true call count is bounded by the
 * count of 2-neighbour dead cells, not the whole board.
 */
export function hasNearbyFarmland(world: FarmlandWorld, x: number, y: number): boolean {
  if (isFarmlandCell(world, x, y)) return true;
  for (const [dx, dy] of MOORE_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
    if (isFarmlandCell(world, nx, ny)) return true;
  }
  return false;
}
