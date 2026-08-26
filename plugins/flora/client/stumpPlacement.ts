// Turning "there is a stump at cell (x, y)" into "draw it at this world
// transform" — placement.ts's logic, restated for the stumps. See that file for
// the reasoning this one shares verbatim: pure arithmetic (no three, no DOM),
// horizontal placement is one multiply by CELL_WORLD_SIZE, and vertical
// placement is one ground lookup with no per-frame re-sampling.
//
// THE NO-RE-SAMPLING RULE HOLDS HERE FOR A DIFFERENT REASON than it does for
// the living populations. Their guarantee is "any height change under a plant
// uproots it server-side"; a stump's is the same rule reaching it through
// server/index.ts's reactToTerrain, which clears a stump whose cell is edited
// exactly as it clears a tuft of grass. Either way, a drawn stump's ground
// cannot move underneath it without the server first taking the stump away.

import { CELL_WORLD_SIZE } from '@terrace/shared';
import { stumpVariation, type StumpCell } from '../protocol.ts';
import type { StumpPlacement } from './stumpModels.ts';

/** Exactly GroundLookup from placement.ts, restated so this module has no cross-file type import to track. */
export type StumpGroundLookup = (x: number, y: number) => number | null;

export interface StumpPlacementResult {
  readonly placements: StumpPlacement[];
  /** How many stumps were skipped because their ground is unknown — see FLORA_GROUND_RETRY_SECONDS. */
  readonly pendingGround: number;
}

/**
 * Places every stump whose ground this client knows. A stump over unknown
 * ground is OMITTED rather than drawn at a guessed height — placementsFor's
 * identical reasoning.
 */
export function stumpPlacementsFor(
  cells: Iterable<StumpCell>,
  groundAt: StumpGroundLookup,
): StumpPlacementResult {
  const placements: StumpPlacement[] = [];
  let pendingGround = 0;

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      continue;
    }

    const variation = stumpVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
      groundY,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingGround };
}
