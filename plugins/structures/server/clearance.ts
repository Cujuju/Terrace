// KEEP-CLEAR CLEARANCE — the ground a BUILDING reserves around itself
// (owner decision 2026-08-26: "buildings do not spawn on top of each other,
// with the exception of the teepees" — tents cluster, nothing else touches).
//
// THE RULE THIS FILE OWNS: a structure may not be PLACED at any cell within
// Chebyshev STRUCTURE_SEPARATION_CELLS (protocol.ts, which owns the number
// and its derivation) of a standing building (`tier > 0`). Teepee-over-
// teepee overlap stays legal — camps ARE many adjoining tents — so the
// predicate looks only for records with `tier > 0`. One home for both the
// "may I stand here" direction (hasBuildingWithinSeparation) and the "who
// must move out when I DO stand here" direction (livingCellsWithinSeparation),
// so the three placement paths below can never disagree about the square.
//
// WHY IT IS A PLACEMENT RULE AND NOT PART OF suitability.ts'S
// isBuildableCell, even though it reads like one more buildability
// condition: isBuildableCell is not only the placement bar — it is ALSO the
// CA's WALL test, evaluated fresh for every cell of the board EVERY
// GENERATION (life.ts). Folding clearance into it would therefore make the
// rule retroactive in two ways the owner explicitly declined:
//
//   * A building would be judged against ITS OWN square every generation —
//     and since a building has no neighbours by construction once the rule
//     works, any future drift (or a mid-sweep founding racing the sweep)
//     could flip its own wall test and silently demolish standing towns.
//   * Every teepee standing inside an existing building's square in an
//     ALREADY-SAVED world would fail the wall test on its very next
//     generation — the old saves' overlapping piles would be pruned at
//     boot-by-installments. The owner decided (2026-08-26) NOT to reconcile
//     persisted worlds; survival must never consult this file.
//
// So the predicate is called exactly where NEW things appear: life.ts's
// birth rule, its teepee→building tier step, placePatternAt (seeder/stir
// placement authority), and index.ts's canFoundStructure (a settler moving
// in). Old piles stay exactly as they were saved.
//
// DETERMINISM, per CLAUDE.md's terrain-math contract: integer-only cell
// arithmetic, fixed row-major iteration order (dy outer, dx inner), bounds
// clamped the way life.ts's countLiveNeighbors clamps — off-board cells are
// skipped, never wrapped. Identical inputs give identical outputs everywhere.

import { STRUCTURE_SEPARATION_CELLS, structureKey } from '../protocol.ts';
import type { LiveCellRecord } from './life.ts';
import type { StructuresWorld } from './suitability.ts';

/**
 * Is any BUILDING (`tier > 0`) standing within Chebyshev
 * STRUCTURE_SEPARATION_CELLS of (x, y)? (x, y) itself is EXCLUDED — a cell
 * asking to become a building there is not obstructed by its own ambition,
 * and the teepee→building step (life.ts) asks precisely that question.
 *
 * Off-board neighbours are skipped rather than treated as walls, matching
 * countLiveNeighbors: the separation square shrinks honestly at the world
 * edge instead of inventing obstructions nobody placed.
 */
export function hasBuildingWithinSeparation(
  live: ReadonlyMap<number, LiveCellRecord>,
  world: StructuresWorld,
  x: number,
  y: number,
): boolean {
  for (let dy = -STRUCTURE_SEPARATION_CELLS; dy <= STRUCTURE_SEPARATION_CELLS; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= world.worldSize) continue;
    for (let dx = -STRUCTURE_SEPARATION_CELLS; dx <= STRUCTURE_SEPARATION_CELLS; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= world.worldSize) continue;
      const record = live.get(structureKey(nx, ny));
      if (record !== undefined && record.tier > 0) return true;
    }
  }
  return false;
}

/**
 * Packed keys of the LIVE, NON-BUILDING cells within the same square — the
 * cells a newly-founded building DEMOLISHES (life.ts's keep-clear sweep).
 *
 * Two exclusions, both deliberate:
 *   * (x, y) itself — the founder is not on its own demolition list;
 *   * every record with `tier > 0` — a building NEVER demolishes another
 *     building, even a grandfathered one from an unreconciled save standing
 *     illegally close. Demolishing it would be exactly the retroactive save
 *     reconciliation the owner declined; the new building simply refuses to
 *     spawn instead (the teepee→building step checks
 *     hasBuildingWithinSeparation first).
 */
export function livingCellsWithinSeparation(
  live: ReadonlyMap<number, LiveCellRecord>,
  world: StructuresWorld,
  x: number,
  y: number,
): number[] {
  const keys: number[] = [];
  for (let dy = -STRUCTURE_SEPARATION_CELLS; dy <= STRUCTURE_SEPARATION_CELLS; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= world.worldSize) continue;
    for (let dx = -STRUCTURE_SEPARATION_CELLS; dx <= STRUCTURE_SEPARATION_CELLS; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= world.worldSize) continue;
      const key = structureKey(nx, ny);
      const record = live.get(key);
      if (record === undefined || record.tier > 0) continue;
      keys.push(key);
    }
  }
  return keys;
}
