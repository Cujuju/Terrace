// GRASS — the meadow half of this plugin (owner, 2026-08-24: "spawn
// abundantly on all of the green or green-like bands"). Every green cell that
// the thinning roll picks, that no crop or building sits on, carries a tuft.
//
// PURE AND DETERMINISTIC, exactly like crops.ts and for the same reasons: no
// RNG, no growth hazard, no spacing rule, and therefore NOTHING TO PERSIST.
// Which cells carry grass is a function of the heightmap and of
// grassCoversCell (protocol.ts), so re-scanning the same persisted heightmap
// after a restart reproduces the same meadow tuft for tuft — see ./index.ts
// for where this is wired and deliberately NOT added to the persistence slice.
//
// WHAT IT DOES NOT SHARE WITH crops.ts, and why this is a second class rather
// than a parameter on the first:
//
//   * the predicate is bands.ts's isGreenBand, not farmland — a completely
//     different question about a cell;
//   * grass GROWS UNDER TREES (owner's call, 2026-08-24), so the occupancy it
//     yields to is crops-and-buildings, not everything standing;
//   * it is thinned by a per-cell roll, which crops have no equivalent of;
//   * it has its own cap, an order of magnitude larger.
//
// Fusing those into one configurable survey would be four flags and a shared
// Set, which is the "same shape, different contract" trap — the two sweeps
// look alike because a chunk-budgeted rolling cursor is the right shape for
// any full-board scan, not because they are the same mechanism.
//
// COST. The per-cell test is: one occupancy Set lookup, one heightAt, one
// bandOf, one integer hash. That is cheaper than crops' own isFarmlandPlot
// (which walks a tread ring and a shore ring) and cheaper than the forest's
// (which additionally consults a 1 MB stability map), and the roll rejects
// ~60% of green cells before anything is staged (FLORA_GRASS_SHARE_OF_256 is
// 102 out of 256; this line said ~71% until 2026-08-25, which was never true of
// the shipped threshold). The 2026-08-25 version of this note went on to say
// the difference mattered because 0.398 sits just under the eight-neighbour
// percolation threshold; it does not — see FLORA_GRASS_BURN_SECONDS's rewritten
// table (issue #170), where a meadow fire is subcritical at EVERY density
// including a solid bed, because grass's 3 s burn is what starves the bond
// term. The share is a wire-and-GPU number here, not a fire number.
// UNMEASURED as of writing —
// the honest statement is that it is bounded above by the crop sweep's
// measured 2.43ms full-512² worst case, since it does strictly less work per
// cell, and it is amortised over GRASS_SURVEY_INTERVAL_SECONDS the same way.

import { CHUNK_SIZE } from '@terrace/shared';
import {
  FLORA_GRASS_CAP,
  grassCellOf,
  grassCoversCell,
  grassKey,
  type GrassCell,
} from '../protocol.ts';
import { isGreenBand, type FloraWorld } from './bands.ts';
import type { OccupancyPredicate } from './forest.ts';

/**
 * Simulated seconds between grass surveys.
 *
 * 5s, landing on the same value as the tree and crop surveys for the same
 * reason forest.ts gives — terrain and the unlock mask only change at human
 * pace — and restated rather than imported for the same reason crops.ts
 * restates its own: three unrelated mechanisms that happen to agree today
 * must be free to disagree tomorrow without one of them silently dragging the
 * others with it.
 */
export const GRASS_SURVEY_INTERVAL_SECONDS = 5;

/** What one completed survey changed. Both lists are empty on a quiet survey. */
export interface GrassSurveyResult {
  readonly sprouted: readonly GrassCell[];
  readonly withered: readonly GrassCell[];
}

const EMPTY_RESULT: GrassSurveyResult = { sprouted: [], withered: [] };

/** The world slice this survey reads — bands.ts's FloraWorld plus the chunk grid. */
export type GrassWorld = FloraWorld & {
  readonly chunksPerEdge: number;
  isChunkUnlocked(cx: number, cy: number): boolean;
};

/**
 * The standing tufts, keyed by cell — CropField.standing's shape and for its
 * reasons (O(1) membership, O(tufts) iteration for the broadcast).
 */
export class GrassField {
  private readonly standing = new Set<number>();

  private cursor = 0;
  private readonly staged = new Set<number>();

  get count(): number {
    return this.standing.size;
  }

  has(x: number, y: number): boolean {
    return this.standing.has(grassKey(x, y));
  }

  /** Every standing tuft, in no particular order (Set iteration order). */
  cells(): GrassCell[] {
    return Array.from(this.standing, grassCellOf);
  }

  /** Drops every tuft and any sweep in progress — CropField.clear's seam. */
  clear(): void {
    this.standing.clear();
    this.resetSweep();
  }

  /**
   * Removes the tuft at (x, y) the instant its OWN cell is edited or built on
   * — the reactive path (./index.ts), mirroring CropField.reactToEdit exactly.
   * Returns the removed cell, or null if there was none.
   *
   * NO NEIGHBOUR RESIDUAL HERE, unlike crops: grass eligibility reads only the
   * edited cell's own height (isGreenBand) and its own roll, so an edit that
   * changes whether a cell carries grass always changes THAT cell, and this
   * catches it. The one thing the periodic survey is still needed for is the
   * other direction — ground that BECAME green, which no removal path can see.
   */
  reactToEdit(x: number, y: number): GrassCell | null {
    if (!this.standing.delete(grassKey(x, y))) return null;
    return { x, y };
  }

  private resetSweep(): void {
    this.cursor = 0;
    this.staged.clear();
  }

  private scanChunk(
    world: GrassWorld,
    isOccupied: OccupancyPredicate,
    cx: number,
    cy: number,
  ): void {
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (let dy = 0; dy < CHUNK_SIZE; dy++) {
      const y = baseY + dy;
      for (let dx = 0; dx < CHUNK_SIZE; dx++) {
        const x = baseX + dx;

        // The thinning roll FIRST: it is a pure integer hash with no memory
        // traffic behind it and it rejects the large majority of cells, so
        // every other test below runs on ~29% of the board rather than all of
        // it (see GRASS_CELLS_PER_TUFT).
        if (!grassCoversCell(x, y)) continue;
        // Crops and buildings win; trees do not (owner, 2026-08-24: grass
        // grows under trees). The caller composes that union — see
        // ./index.ts's grassOccupiedCells.
        if (isOccupied(x, y)) continue;
        if (!isGreenBand(world.heightAt(x, y))) continue;
        if (this.staged.size >= FLORA_GRASS_CAP) continue; // never evict an already-staged cell for a later one in the same sweep
        this.staged.add(grassKey(x, y));
      }
    }
  }

  /**
   * Advances the rolling sweep by at most `chunkBudget` chunks. Returns the
   * survey's outcome only on the tick that COMPLETES a full-board sweep (null
   * otherwise) — CropField.advance's identical contract.
   */
  advance(
    world: GrassWorld,
    isOccupied: OccupancyPredicate,
    chunkBudget: number,
  ): GrassSurveyResult | null {
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    if (totalChunks <= 0) return null;

    let budget = Math.floor(chunkBudget);
    if (budget <= 0) return null;

    while (budget > 0 && this.cursor < totalChunks) {
      const cx = this.cursor % world.chunksPerEdge;
      const cy = Math.floor(this.cursor / world.chunksPerEdge);
      // Hoisted out of 256 cells, exactly as Forest.scanChunk and
      // CropField.advance hoist it, and exact for the same reason: a cell's
      // unlock state IS its chunk's.
      if (world.isChunkUnlocked(cx, cy)) this.scanChunk(world, isOccupied, cx, cy);
      this.cursor++;
      budget--;
    }
    if (this.cursor < totalChunks) return null;

    const sprouted: GrassCell[] = [];
    const withered: GrassCell[] = [];
    for (const key of this.staged) {
      if (!this.standing.has(key)) sprouted.push(grassCellOf(key));
    }
    for (const key of this.standing) {
      if (!this.staged.has(key)) withered.push(grassCellOf(key));
    }

    this.standing.clear();
    for (const key of this.staged) this.standing.add(key);
    this.resetSweep();

    return sprouted.length === 0 && withered.length === 0 ? EMPTY_RESULT : { sprouted, withered };
  }

  /** One complete survey in a single call — the shape the tests reason in. */
  survey(world: GrassWorld, isOccupied: OccupancyPredicate): GrassSurveyResult {
    return this.advance(world, isOccupied, world.chunksPerEdge * world.chunksPerEdge) ?? EMPTY_RESULT;
  }
}

/**
 * Chunk-per-tick budget pacing one sweep to take exactly
 * GRASS_SURVEY_INTERVAL_SECONDS, whatever the world size — cropSurveyChunksPerTick's
 * derivation, restated for this survey's own independent interval.
 */
export function grassSurveyChunksPerTick(
  world: { readonly chunksPerEdge: number },
  dt: number,
): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerSurvey = Math.max(1, Math.round(GRASS_SURVEY_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerSurvey;
}
