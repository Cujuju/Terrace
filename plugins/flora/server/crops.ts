// CROPS — card 28, "Terrace Farming": the visible half. Farmland
// (@terrace/shared's farmland.ts) that has room for a whole crop model and is
// not covered by a building shows a crop. "Room for the model" is
// isFarmlandPlot rather than isFarmlandCell, and the difference is a cell of
// setback from the water's edge — see that function for why a farmland cell is
// not the same thing as a cell of ground. Membership is a PURE, DETERMINISTIC function of terrain — unlike
// Forest (forest.ts), there is no stochastic sprouting, no growth hazard,
// no spacing rule, and therefore no RNG and NOTHING TO PERSIST: a crop
// exists exactly where isFarmlandPlot says it does, exactly the way a river
// exists exactly where computeRiverNetwork says it does
// (shared/src/rivers.ts). Restarting the server and re-scanning the SAME
// (persisted) heightmap reproduces the SAME crop set byte for byte, so
// there is nothing here that a snapshot could lose — see ./index.ts for
// where this is wired and NOT added to the persistence slice.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SURVEY — an amortised, chunk-budgeted full-board sweep, in Forest's
// own shape (forest.ts's advanceSurvey / life.ts's GenerationSurvey.advance):
// a rolling cursor visits every chunk over CROP_SURVEY_INTERVAL_SECONDS,
// never all at once, so a whole-world recompute never costs one tick its
// entire budget. What differs from Forest is what happens once a sweep
// completes: no reservoir sampling, no hazard roll — the STAGED set built
// during the sweep simply IS the next crop set, and the survey reports the
// set difference (sprouted / withered) against what stood before.
//
// COST, MEASURED (ad hoc, this session, not committed — see
// plugins/structures/server/farmland.ts's identical note for the same
// script and methodology). RE-MEASURED 2026-08-23, when the predicate became
// isFarmlandPlot: the tread ring and shore ring cost ~2.7× isFarmlandCell per
// cell on adversarial all-flat ground (5.9ms vs 15.9ms over a 256² board, ad
// hoc, this session), which puts a full 512² sweep at roughly 6.5ms and this
// survey at well under a millisecond of extra work per tick. Both rings bail
// out on their first failing cell, and the orthogonal neighbours — the
// cheapest, most selective test — are checked first, so real broken terrain
// costs far less than that adversarial figure. A full 512² sweep calling the
// predicate for
// EVERY cell — the worst case this survey ever does, since a real sweep
// bails out of most cells at the first isWater/unlocked check exactly like
// Forest's own isGreenBand does — measured 2.43ms median (10 trials) on an
// adversarial terrain chosen to defeat early exits. Amortised over
// CROP_SURVEY_INTERVAL_SECONDS (5s, matching Forest's own cadence) at the
// shipped TICK_HZ (10) — 50 ticks per sweep — that is 2.43 / 50 ≈ 0.05ms of
// EXTRA work per tick on average, and a single tick absorbing the whole
// sweep in one burst (a stalled-then-resumed cursor) spends under 2.5% of
// one 100ms tick. Comfortably inside budget, and cheaper than Forest's own
// per-cell test in absolute count (isFarmlandCell is a handful of extra
// heightAt calls; Forest additionally consults a 1 MB stability map per
// cell, which this survey does not need at all — crops have no "left
// alone" requirement, the card asks only for the terrain condition).
// ─────────────────────────────────────────────────────────────────────────────

import { CHUNK_SIZE } from '@terrace/shared';
import {
  CROP_PLOT_TREAD_RING_CELLS,
  FLORA_CROP_CAP,
  cropCellOf,
  cropKey,
  type CropCell,
} from '../protocol.ts';
import { isFarmlandPlot, type FarmlandWorld } from '@terrace/shared';
import type { OccupancyPredicate } from './forest.ts';

/**
 * Simulated seconds between crop surveys.
 *
 * 5s — matching FLORA_SURVEY_INTERVAL_SECONDS (forest.ts), independently
 * chosen rather than imported (the two mechanisms are unrelated — see
 * life.ts's generationChunksPerTick for the same "restated, not imported"
 * rule applied to a different pair of constants) but landing on the same
 * value for the same reason forest.ts gives: terrain and the unlock mask
 * only change at human pace, so a finer poll would only re-derive the same
 * answer, and the measured per-sweep cost (see the module header) leaves
 * enormous headroom at this cadence.
 */
export const CROP_SURVEY_INTERVAL_SECONDS = 5;

/** What one completed survey changed. Both lists are empty on a quiet survey. */
export interface CropSurveyResult {
  readonly sprouted: readonly CropCell[];
  readonly withered: readonly CropCell[];
}

const EMPTY_RESULT: CropSurveyResult = { sprouted: [], withered: [] };

/**
 * The standing crops, keyed by cell — a Set of packed keys, exactly Forest's
 * own `standing` shape and for the same reasons (O(1) membership, O(crops)
 * iteration for the broadcast, small next to a per-cell grid at the cap).
 */
export class CropField {
  private readonly standing = new Set<number>();

  private cursor = 0;
  private readonly staged = new Set<number>();

  get count(): number {
    return this.standing.size;
  }

  has(x: number, y: number): boolean {
    return this.standing.has(cropKey(x, y));
  }

  /** Every standing crop, in no particular order (Set iteration order). */
  cells(): CropCell[] {
    return Array.from(this.standing, cropCellOf);
  }

  /**
   * Drops every crop and any sweep in progress — the test/reset seam
   * matching Forest.replaceAll([])'s role, with no restore-from-persistence
   * half (crops.ts's header: nothing here is ever persisted, so there is
   * nothing to restore).
   */
  clear(): void {
    this.standing.clear();
    this.resetSweep();
  }

  /** Removes the crop at (x, y), if any. Returns false if there was none. */
  private wither(x: number, y: number): boolean {
    return this.standing.delete(cropKey(x, y));
  }

  /**
   * Fells the crop at (x, y) the instant its OWN cell is edited — the
   * reactive path (./index.ts's reactToTerrain), mirroring Forest.fell's
   * role for trees exactly. Returns the removed cell, or null if there was
   * none.
   *
   * NAMED RESIDUAL, matching structures' life.ts precedent verbatim: a crop
   * whose NEIGHBOUR is edited (filling in the water that made it farmland,
   * say) is not caught here — isFarmlandPlot depends on more than the
   * edited cell's own height, and re-testing every crop's whole
   * neighbourhood on every diff would turn a bounded sculpt-rate cost into
   * an unbounded one. It is caught by the next periodic survey instead, at
   * most CROP_SURVEY_INTERVAL_SECONDS later — the identical "short, bounded
   * wait for a self-correcting mechanism that already runs continuously"
   * life.ts's own header accepts for the CA's wall test.
   */
  reactToEdit(x: number, y: number): CropCell | null {
    return this.wither(x, y) ? { x, y } : null;
  }

  private resetSweep(): void {
    this.cursor = 0;
    this.staged.clear();
  }

  private scanChunk(
    world: FarmlandWorld,
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

        // Buildings always win (the same rule Forest.scanChunk applies to
        // trees, owner 2026-08-19): an occupied cell shows no crop, whatever
        // the ground beneath it would otherwise qualify as.
        if (isOccupied(x, y)) continue;
        // isFarmlandPlot, not isFarmlandCell: farmland promises a dry cell
        // CENTRE, and a terrace lip may run within an eighth of a cell of it,
        // so a plot sited on the lip hangs over the drop. The ring is derived
        // from the model's own reach — see protocol.ts's
        // CROP_PLOT_TREAD_RING_CELLS.
        if (!isFarmlandPlot(world, x, y, CROP_PLOT_TREAD_RING_CELLS)) continue;
        if (this.staged.size >= FLORA_CROP_CAP) continue; // never evict an already-staged cell to make room for a later one in the same sweep
        this.staged.add(cropKey(x, y));
      }
    }
  }

  /**
   * Advances the rolling sweep by at most `chunkBudget` chunks. Returns the
   * survey's outcome only on the tick that COMPLETES a full-board sweep
   * (null otherwise) — Forest.advanceSurvey's and GenerationSurvey.advance's
   * identical contract.
   */
  advance(
    world: FarmlandWorld & { readonly chunksPerEdge: number; isChunkUnlocked(cx: number, cy: number): boolean },
    isOccupied: OccupancyPredicate,
    chunkBudget: number,
  ): CropSurveyResult | null {
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    if (totalChunks <= 0) return null;

    let budget = Math.floor(chunkBudget);
    if (budget <= 0) return null;

    while (budget > 0 && this.cursor < totalChunks) {
      const cx = this.cursor % world.chunksPerEdge;
      const cy = Math.floor(this.cursor / world.chunksPerEdge);
      // Locked chunks contribute no farmland — the same per-chunk unlock
      // gate Forest.scanChunk applies before it ever tests a cell, cheaper
      // than the predicate's own per-cell isCellUnlocked check because it
      // is hoisted out of 256 iterations (see forest.ts's scanChunk for the
      // identical exactness argument: a cell's unlock state IS its chunk's).
      if (world.isChunkUnlocked(cx, cy)) this.scanChunk(world, isOccupied, cx, cy);
      this.cursor++;
      budget--;
    }
    if (this.cursor < totalChunks) return null;

    const sprouted: CropCell[] = [];
    const withered: CropCell[] = [];
    for (const key of this.staged) {
      if (!this.standing.has(key)) sprouted.push(cropCellOf(key));
    }
    for (const key of this.standing) {
      if (!this.staged.has(key)) withered.push(cropCellOf(key));
    }

    this.standing.clear();
    for (const key of this.staged) this.standing.add(key);
    this.resetSweep();

    return sprouted.length === 0 && withered.length === 0 ? EMPTY_RESULT : { sprouted, withered };
  }

  /**
   * One complete survey in a single call — the shape the tests reason in,
   * mirroring Forest.survey / stepGeneration.
   */
  survey(
    world: FarmlandWorld & { readonly chunksPerEdge: number; isChunkUnlocked(cx: number, cy: number): boolean },
    isOccupied: OccupancyPredicate,
  ): CropSurveyResult {
    return this.advance(world, isOccupied, world.chunksPerEdge * world.chunksPerEdge) ?? EMPTY_RESULT;
  }
}

/**
 * Chunk-per-tick budget pacing one sweep to take exactly
 * CROP_SURVEY_INTERVAL_SECONDS, whatever the world size — Forest's own
 * chunksPerTick derivation (server/index.ts), restated rather than imported
 * (the two intervals are independently chosen — see this module's own
 * CROP_SURVEY_INTERVAL_SECONDS comment).
 */
export function cropSurveyChunksPerTick(
  world: { readonly chunksPerEdge: number },
  dt: number,
): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerSurvey = Math.max(1, Math.round(CROP_SURVEY_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerSurvey;
}
