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
import { fringeVariation, type FringeCell, type FringeSpecies } from '../protocol.ts';
import type { FringePlacement } from './fringeModels.ts';

/** Exactly GroundLookup from placement.ts, restated so this module has no cross-file type import to track. */
export type FringeGroundLookup = (x: number, y: number) => number | null;

export interface FringePlacementResult {
  readonly placements: FringePlacement[];
  /** How many plants were skipped because their ground is unknown — see FLORA_GROUND_RETRY_SECONDS. */
  readonly pendingGround: number;
}

/**
 * Places every fringe plant whose ground this client knows. A plant over unknown
 * ground is OMITTED rather than drawn at a guessed height — placementsFor's
 * identical reasoning.
 */
export function fringePlacementsFor(
  plants: Iterable<readonly [FringeCell, FringeSpecies]>,
  groundAt: FringeGroundLookup,
): FringePlacementResult {
  const placements: FringePlacement[] = [];
  let pendingGround = 0;

  for (const [cell, species] of plants) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      continue;
    }

    const variation = fringeVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
      cellX: cell.x,
      cellY: cell.y,
      groundY,
      species,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingGround };
}
