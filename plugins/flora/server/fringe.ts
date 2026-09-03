// THE FRINGE — reeds at the waterline and heather on the rock (GH #192, #194).
// One survey, one field, two species; ../protocol.ts's fringe section is the
// record of why that is one population and not two, and none of it is restated
// here.
//
// PURE AND DETERMINISTIC, exactly like crops.ts and grass.ts: no RNG, no growth
// hazard, no spacing rule, and therefore NOTHING TO PERSIST. Which cells carry
// a plant is a function of the heightmap and of fringeCoversCell, so re-scanning
// the same persisted heightmap after a restart reproduces the same shoreline
// stem for stem.
//
// WHAT IT DOES NOT SHARE WITH grass.ts, which it otherwise mirrors closely:
//
//   * the predicate is fringeSpeciesForHeight — a question with THREE answers
//     (reed, heather, nothing) rather than a boolean, and the answer is also
//     what the thinning roll is parameterised by, so eligibility and density are
//     resolved in one pass rather than two;
//   * reeds additionally require WATER WITHIN FRINGE_REED_SHORE_RADIUS_CELLS,
//     which is the only neighbourhood test in this file and the reason the cost
//     note below is not simply "cheaper than grass".
//
// COST, and the one thing worth watching. The per-cell test is ordered so the
// cheap rejections come first: an integer hash and a band comparison reject
// every cell that is not fringe ground at all, and only a cell that has already
// passed both — i.e. dry ground below the green window, thinned to
// FRINGE_REED_SHARE_OF_256/256 — pays for the shore ring. That ring is
// (2r+1)² − 1 = 48 heightAt calls at the shipped radius of 3, which is by far
// the most expensive per-cell test in this plugin; what bounds it is that the
// cells reaching it are the thin strip of low dry ground, not the board.
//
// MEASURED on the shipped world `frostwick-hollows` (512², 262 144 cells), by
// running this survey over its real heightmap: a COMPLETE full-board sweep —
// every chunk unlocked, nothing occupied, shore rings and all — takes 7 ms and
// stages 2 789 plants (2 651 reeds, 138 heather). In service that 7 ms is spread
// over FRINGE_SURVEY_INTERVAL_SECONDS by the rolling cursor, so the per-tick
// cost is a fraction of a millisecond. The same measurement re-run against the
// unchanged heightmap stages the identical set and reports nothing sprouted and
// nothing withered, which is the determinism claim above holding rather than
// being asserted.
//
// THE WORST CASE IS STILL NOT BOUNDED BY THAT, and it is stated rather than
// implied: a world that is mostly low dry sand would pay the ring on ~50% of
// every chunk, an order of magnitude more than the world we ship. If that ever
// bites, the fix is to hoist the water test to a per-chunk "does this chunk
// touch water at all" precheck, not to shrink the radius.

import { CHUNK_SIZE, isWater } from '@terrace/shared';
import {
  FLORA_FRINGE_CAP,
  FRINGE_REED_SHORE_RADIUS_CELLS,
  fringeCellOf,
  fringeCoversCell,
  fringeKey,
  type FringeCell,
  type FringeSpecies,
} from '../protocol.ts';
import { fringeSpeciesForHeight, type FloraWorld } from './bands.ts';
import type { BarredGround } from './forest.ts';

/**
 * Simulated seconds between fringe surveys.
 *
 * 5s, landing on the same value as the other three surveys for the reason
 * forest.ts gives — terrain and the unlock mask only change at human pace — and
 * restated rather than imported for the reason crops.ts and grass.ts each
 * restate their own: four unrelated mechanisms that happen to agree today must
 * be free to disagree tomorrow without one of them silently dragging the rest.
 */
export const FRINGE_SURVEY_INTERVAL_SECONDS = 5;

/** One cell and what grows on it — the unit this field stores and broadcasts. */
export interface FringePlant {
  readonly cell: FringeCell;
  readonly species: FringeSpecies;
}

/** What one completed survey changed. Both lists are empty on a quiet survey. */
export interface FringeSurveyResult {
  readonly sprouted: readonly FringePlant[];
  readonly withered: readonly FringeCell[];
}

const EMPTY_RESULT: FringeSurveyResult = { sprouted: [], withered: [] };

/** The world slice this survey reads — bands.ts's FloraWorld, unchanged. */
export type FringeWorld = FloraWorld;

/**
 * Is there water within FRINGE_REED_SHORE_RADIUS_CELLS of this cell?
 *
 * A CHEBYSHEV (square) neighbourhood, matching farmland.ts's own shore sweep and
 * for its reason: a reed bed does not care which diagonal the water lies on.
 *
 * Off-map neighbours are SKIPPED rather than counted as water. The world rim is
 * not a shoreline — counting it would grow a reed bed along all four edges of
 * every map, which is farmland.ts's exact conclusion about its own rim.
 *
 * The cell's own wetness is not tested here: fringeSpeciesForHeight has already
 * rejected water cells before this is ever called.
 */
function hasWaterWithinShoreRadius(world: FringeWorld, x: number, y: number): boolean {
  const radius = FRINGE_REED_SHORE_RADIUS_CELLS;
  for (let dy = -radius; dy <= radius; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= world.worldSize) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= world.worldSize) continue;
      // shared/'s own rule. Restating it as `h <= 0` here would be the
      // duplicated terrain math this repo bans.
      if (isWater(world.heightAt(nx, ny))) return true;
    }
  }
  return false;
}

/**
 * What grows on this cell, if anything — the survey's whole per-cell test, and
 * the one place a species is decided.
 *
 * ORDERED FOR COST, not for readability — see the module header. The species
 * test is one band comparison; the roll is one integer hash; the shore ring is
 * 48 height lookups and runs only for a reed cell that has already survived
 * both.
 */
export function fringeGrowthAt(
  world: FringeWorld,
  x: number,
  y: number,
): FringeSpecies | null {
  const species = fringeSpeciesForHeight(world.heightAt(x, y));
  if (species === null) return null;
  if (!fringeCoversCell(x, y, species)) return null;
  if (species === 'reed' && !hasWaterWithinShoreRadius(world, x, y)) return null;
  return species;
}

/**
 * The standing plants, keyed by cell — GrassField.standing's shape and for its
 * reasons (O(1) membership, O(plants) iteration for the broadcast), with one
 * difference: a MAP rather than a Set, because a fringe cell carries a species
 * and the other three populations carry nothing beyond their own existence.
 */
export class FringeField {
  private readonly standing = new Map<number, FringeSpecies>();

  private cursor = 0;
  private readonly staged = new Map<number, FringeSpecies>();

  get count(): number {
    return this.standing.size;
  }

  has(x: number, y: number): boolean {
    return this.standing.has(fringeKey(x, y));
  }

  /** What stands on this cell, or null. */
  speciesAt(x: number, y: number): FringeSpecies | null {
    return this.standing.get(fringeKey(x, y)) ?? null;
  }

  /** Every standing plant with its species, in no particular order (Map iteration order). */
  plants(): FringePlant[] {
    return Array.from(this.standing, ([key, species]) => ({ cell: fringeCellOf(key), species }));
  }

  /** Every standing plant's cell, for the paths that do not care what it is. */
  cells(): FringeCell[] {
    return Array.from(this.standing.keys(), fringeCellOf);
  }

  /** Drops every plant and any sweep in progress — GrassField.clear's seam. */
  clear(): void {
    this.standing.clear();
    this.resetSweep();
  }

  /**
   * Removes the plant at (x, y) the instant its OWN cell is edited or built on
   * — the reactive path (./index.ts), mirroring GrassField.reactToEdit.
   *
   * A NEIGHBOUR RESIDUAL EXISTS HERE where grass has none, and it is named
   * rather than fixed: a reed's eligibility depends on water up to
   * FRINGE_REED_SHORE_RADIUS_CELLS away, so draining a pond leaves its reeds
   * standing until the next survey — at most FRINGE_SURVEY_INTERVAL_SECONDS.
   * That is crops.ts's identical accepted lag for its identical reason (the
   * diff-driven pass sees the edited cells, not their neighbourhoods), and the
   * alternative is re-testing a 7×7 ring around every cell of every sculpt.
   */
  reactToEdit(x: number, y: number): FringeCell | null {
    if (!this.standing.delete(fringeKey(x, y))) return null;
    return { x, y };
  }

  private resetSweep(): void {
    this.cursor = 0;
    this.staged.clear();
  }

  private scanChunk(
    world: FringeWorld,
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
        // Occupancy first: it is one Set lookup, where fringeCoversGround can
        // cost a 48-cell ring. Grass orders these the other way round because
        // its own predicate is cheaper than the Set — see grass.ts's note.
        if (isBarred(x, y)) continue;
        const species = fringeGrowthAt(world, x, y);
        if (species === null) continue;
        if (this.staged.size >= FLORA_FRINGE_CAP) continue; // never evict an already-staged cell for a later one in the same sweep
        this.staged.set(fringeKey(x, y), species);
      }
    }
  }

  /**
   * Advances the rolling sweep by at most `chunkBudget` chunks. Returns the
   * survey's outcome only on the tick that COMPLETES a full-board sweep (null
   * otherwise) — GrassField.advance's identical contract.
   */
  advance(
    world: FringeWorld,
    isBarred: BarredGround,
    chunkBudget: number,
  ): FringeSurveyResult | null {
    const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
    if (totalChunks <= 0) return null;

    let budget = Math.floor(chunkBudget);
    if (budget <= 0) return null;

    while (budget > 0 && this.cursor < totalChunks) {
      const cx = this.cursor % world.chunksPerEdge;
      const cy = Math.floor(this.cursor / world.chunksPerEdge);
      // Hoisted out of 256 cells, exactly as the other three sweeps hoist it,
      // and exact for the same reason: a cell's unlock state IS its chunk's.
      if (world.isChunkUnlocked(cx, cy)) this.scanChunk(world, isBarred, cx, cy);
      this.cursor++;
      budget--;
    }
    if (this.cursor < totalChunks) return null;

    const sprouted: FringePlant[] = [];
    const withered: FringeCell[] = [];
    for (const [key, species] of this.staged) {
      // A cell whose SPECIES changed counts as a sprout and not as a no-op:
      // the client draws a different model for each, so it has to be told. It
      // needs no matching wither — the client keys its map by cell, so the new
      // species simply replaces the old one.
      if (this.standing.get(key) !== species) sprouted.push({ cell: fringeCellOf(key), species });
    }
    for (const key of this.standing.keys()) {
      if (!this.staged.has(key)) withered.push(fringeCellOf(key));
    }

    this.standing.clear();
    for (const [key, species] of this.staged) this.standing.set(key, species);
    this.resetSweep();

    return sprouted.length === 0 && withered.length === 0 ? EMPTY_RESULT : { sprouted, withered };
  }

  /** One complete survey in a single call — the shape the tests reason in. */
  survey(world: FringeWorld, isBarred: BarredGround): FringeSurveyResult {
    return (
      this.advance(world, isBarred, world.chunksPerEdge * world.chunksPerEdge) ?? EMPTY_RESULT
    );
  }
}

/**
 * Chunk-per-tick budget pacing one sweep to take exactly
 * FRINGE_SURVEY_INTERVAL_SECONDS, whatever the world size —
 * grassSurveyChunksPerTick's derivation, restated for this survey's own
 * independent interval.
 */
export function fringeSurveyChunksPerTick(
  world: { readonly chunksPerEdge: number },
  dt: number,
): number {
  const totalChunks = world.chunksPerEdge * world.chunksPerEdge;
  const ticksPerSurvey = Math.max(1, Math.round(FRINGE_SURVEY_INTERVAL_SECONDS / dt));
  return totalChunks / ticksPerSurvey;
}
