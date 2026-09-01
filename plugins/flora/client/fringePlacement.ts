// Turning "there is a reed at cell (x, y)" into "draw it at this world
// transform" — grassPlacement.ts's logic, restated for the fringe. See that file
// and placement.ts for the reasoning this one shares verbatim: pure arithmetic
// (no three, no DOM), horizontal placement is one multiply by CELL_WORLD_SIZE,
// and vertical placement is one ground lookup with no per-frame re-sampling
// because ANY height change under a plant uproots it server-side
// (server/index.ts's reactToTerrain).
//
// THE SPECIES IS AN INPUT, NOT A DERIVATION. It arrives on the wire in its own
// list and reaches here as the map's value — this half never asks what height a
// cell is, only where its ground is. ../protocol.ts's fringe section is the
// record of why that direction was chosen; the consequence here is that this
// file has no height windows in it and cannot disagree with the server about
// what grows where.

import { CELL_WORLD_SIZE } from '@terrace/shared';
import { FLORA_CELL_KEY_STRIDE, fringeVariation, type FringeSpecies } from '../protocol.ts';
import type { FringePlacement } from './fringeModels.ts';

/** Exactly GroundLookup from placement.ts, restated so this module has no cross-file type import to track. */
export type FringeGroundLookup = (x: number, y: number) => number | null;

export interface FringePlacementResult {
  readonly placements: FringePlacement[];
  /** WHICH plants were skipped because their ground is unknown, as packed fringeKeys — grassPlacement.ts's reason. */
  readonly pendingCells: number[];
}

/**
 * Places every fringe plant whose ground this client knows. A plant over unknown
 * ground is OMITTED rather than drawn at a guessed height — placementsFor's
 * identical reasoning.
 *
 * TAKES PACKED KEYS, which is exactly the shape of the caller's own
 * `Map<fringeKey, FringeSpecies>` — so the whole population can be passed as
 * the map itself, with no intermediate array of decoded cells to allocate on
 * every rebuild (GH #260).
 */
export function fringePlacementsFor(
  plants: Iterable<readonly [number, FringeSpecies]>,
  groundAt: FringeGroundLookup,
): FringePlacementResult {
  const placements: FringePlacement[] = [];
  const pendingCells: number[] = [];

  for (const [key, species] of plants) {
    // Unpacked inline rather than through fringeCellOf: this is the hot loop
    // over the whole population, and the decoded cell would be one short-lived
    // object per plant for two numbers that are already here.
    const cellX = key % FLORA_CELL_KEY_STRIDE;
    const cellY = Math.floor(key / FLORA_CELL_KEY_STRIDE);
    const groundY = groundAt(cellX, cellY);
    if (groundY === null) {
      pendingCells.push(key);
      continue;
    }

    const variation = fringeVariation(cellX, cellY);
    placements.push({
      x: cellX * CELL_WORLD_SIZE,
      z: cellY * CELL_WORLD_SIZE,
      cellX,
      cellY,
      groundY,
      species,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingCells };
}
