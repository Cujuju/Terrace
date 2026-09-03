// GRASS — the meadow half of this plugin (owner, 2026-08-24: "spawn
// abundantly on all of the green or green-like bands").
//
// TWO QUESTIONS, NOT ONE (issue #289, owner 2026-09-01). WHICH GROUND IS
// MEADOW is `isMeadowCell` below: green-band and not barred — no crop,
// building or stump on it, and not scorched by a fire inside the last
// FLORA_SCORCH_REGROW_SECONDS (./scorch.ts, issues #290 and #297; the bar is
// forest.ts's BarredGround). WHICH MEADOW CELLS CARRY A DRAWN TUFT is that AND
// the thinning roll `grassCoversCell` (../protocol.ts), which keeps ~56% of
// them. This file surveys the second; ../server/index.ts's `floraFuelAt`
// answers the first, so a meadow burns as the continuous bed it looks like
// instead of as the ~56% of it that happens to have a blade rendered on it.
//
// DETERMINISTIC AND UNPERSISTED, exactly like crops.ts and for the same
// reasons: no RNG, no growth hazard, no spacing rule, and therefore NOTHING TO
// PERSIST. Which cells carry grass is a function of the heightmap, of
// grassCoversCell (protocol.ts) and — since #290 — of the scorch record, so
// re-scanning the same persisted heightmap after a restart reproduces the same
// meadow tuft for tuft — see ./index.ts for where this is wired and
// deliberately NOT added to the persistence slice. This survey stopped being a
// PURE function of the heightmap on that day: the scorch record is the one
// piece of memory it consults, and it is memory a restart loses, so the restart
// consequence is named on FLORA_SCORCH_REGROW_SECONDS rather than hidden here.
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
// COST. The per-cell test is: one integer hash, then three occupancy lookups,
// one heightAt and one bandOf. That is cheaper than crops' own isFarmlandPlot
// (which walks a tread ring and a shore ring) and cheaper than the forest's
// (which additionally consults a 1 MB stability map), and the roll rejects
// ~44% of green cells before anything else is asked (FLORA_GRASS_SHARE_OF_256
// is 144 out of 256; this line said ~71% until 2026-08-25 and ~60% until
// 2026-08-29, each true of a threshold that has since moved). Two earlier
// versions of this note claimed the share mattered to FIRE — first because
// 0.398 sits just under the eight-neighbour percolation threshold, then because
// 0.5625 was the density that let a meadow run. Neither survives issue #289:
// the roll no longer decides what is FUEL at all, only what is DRAWN, so the
// share is once again a wire-and-GPU number here and nothing else.
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
import type { BarredGround } from './forest.ts';

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
 * Is this cell MEADOW — ground the meadow covers, whether or not a tuft is
 * drawn on it?
 *
 * TWO QUESTIONS USED TO BE ONE, and separating them is the whole of issue #289
 * (owner, 2026-09-01: "make meadow regions count as fuel on every cell with the
 * tuft roll deciding only what is drawn"). Membership of the meadow is this
 * predicate; whether a BLADE is rendered on a member cell is `grassCoversCell`
 * (../protocol.ts), a thinning roll that keeps ~56% of them. Before #289 the
 * survey was the only asker, so the two were fused in `scanChunk` and the fuel
 * answer (../server/index.ts's `floraFuelAt`) read the drawn set — which left
 * ~44% of every meadow with no fuel in it and made a grass fire spread in
 * splotches around the cells the roll had skipped.
 *
 * THE ONE PREDICATE, ASKED BY BOTH, is therefore the contract: `scanChunk`
 * below asks it after the draw roll, and `floraFuelAt` asks it instead of
 * consulting the drawn set. Neither can drift from the other about what ground
 * is meadow, because there is only one statement of it.
 *
 * THE UNLOCK TEST IS PART OF THE ANSWER, not the survey's private business, and
 * an earlier draft of this comment got that wrong. It claimed fire could never
 * reach locked ground; it can. `spreadToCells`
 * (plugins/fire/server/spread.ts) clamps a neighbour only to `world.worldSize`,
 * so a cell burning on the last row of an unlocked chunk rolls against the cell
 * across the boundary — and lightning is a second path in. That cost nothing
 * before #289, because the survey never planted a tuft on locked ground and so
 * there was no fuel there to catch; the moment the fuel answer stopped reading
 * the drawn set, "unlocked" stopped being enforced by accident and had to be
 * enforced on purpose. It belongs HERE rather than at fire's door for the same
 * reason the occupancy term does: this predicate is the single statement of
 * what ground is meadow, and a caller that could forget the rule is the bug.
 * (bands.ts's isPlantableCell asks `isCellUnlocked` per cell for exactly this
 * reason — it is the same anti-leak rule, stated there for trees.)
 *
 * WHAT IT DOES NOT ASK: the world bounds, because both callers already hold
 * them — the survey walks chunks of this world, and fire's spread clamps to
 * `world.worldSize`.
 *
 * AND, THROUGH THE BAR, WHETHER THE GROUND HAS BURNED (issues #290, #297). The
 * terrain terms have no memory of a fire, which was harmless while the fuel
 * answer read the drawn set — removing the tuft in floraBurnedOut WAS the fuel
 * being consumed. #289 stopped the fuel answer reading that set and did not
 * replace the consumption, so burned meadow became fuel again the instant it
 * burned out and a meadow fire never ended (./scorch.ts's header holds the
 * measurement). #290 put the scorch record in this predicate; #297 found that
 * crops then ignored it and moved it into the bar every survey receives
 * (forest.ts's BarredGround), which is the same anti-leak rule one level up:
 * a population that could forget the rule is the bug. Because the fuel answer
 * and the survey take the same bar, a burned cell stops being fuel and stops
 * being re-planted at the same instant, and regrows into both at the same
 * instant, with no second clock to keep them in step.
 */
export function isMeadowCell(
  world: FloraWorld,
  isBarred: BarredGround,
  x: number,
  y: number,
): boolean {
  if (!world.isCellUnlocked(x, y)) return false;
  // Crops, buildings and stumps win; trees do not (owner, 2026-08-24: grass
  // grows under trees). And burned ground is barred until it regrows (#297).
  // The caller composes that union ONCE — see ./index.ts's barredGround over
  // groundCoverOccupied — so the fuel answer and the survey can never disagree.
  if (isBarred(x, y)) return false;
  return isGreenBand(world.heightAt(x, y));
}

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
    isBarred: BarredGround,
    cx: number,
    cy: number,
  ): void {
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (let dy = 0; dy < CHUNK_SIZE; dy++) {
      const y = baseY + dy;
      for (let dx = 0; dx < CHUNK_SIZE; dx++) {
        const x = baseX + dx;

        // The DRAW roll FIRST: it is a pure integer hash with no memory traffic
        // behind it and it rejects ~44% of cells, so the meadow test below runs
        // on the remainder rather than on all of it (see GRASS_CELLS_PER_TUFT).
        // It is asked ONLY here, because since #289 it decides what is DRAWN
        // and nothing else — the fuel answer skips it (see isMeadowCell).
        if (!grassCoversCell(x, y)) continue;
        if (!isMeadowCell(world, isBarred, x, y)) continue;
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
    isBarred: BarredGround,
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
      //
      // A SKIP, NOT THE RULE (issue #289). The authoritative unlock test is the
      // per-cell one inside isMeadowCell, which every asker goes through; this
      // only avoids walking 256 cells that would all answer false. Deleting it
      // would cost time and change no answer — deleting the one in isMeadowCell
      // would let fire spread onto locked ground.
      if (world.isChunkUnlocked(cx, cy)) this.scanChunk(world, isBarred, cx, cy);
      this.cursor++;
      budget--;
    }
    if (this.cursor < totalChunks) return null;

    // RE-VALIDATED AGAINST THE BAR AT COMMIT (issue #297). The staged set is a
    // snapshot taken chunk by chunk over the whole survey interval, and a cell
    // can burn AFTER its chunk was scanned: it was eligible then, it is
    // scorched now, and installing the stale answer would put the plant back
    // on ground that just burned — measured live as a tuft re-planted one to two
    // seconds after burning out, with the fire still at its edge. Forest.grow
    // re-validates each candidate at planting time for the same reason; this
    // is that rule for a survey that plants its whole staged set at once.
    for (const key of this.staged) {
      const cell = grassCellOf(key);
      if (isBarred(cell.x, cell.y)) this.staged.delete(key);
    }

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
  survey(
    world: GrassWorld,
    isBarred: BarredGround,
  ): GrassSurveyResult {
    return (
      this.advance(world, isBarred, world.chunksPerEdge * world.chunksPerEdge) ??
      EMPTY_RESULT
    );
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
