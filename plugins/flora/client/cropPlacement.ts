// Turning "there is a crop at cell (x, y)" into "draw a crop cluster at this
// world transform" — placement.ts's own logic, restated for crops (card 28).
// See that file's header for the reasoning this one shares verbatim: pure
// arithmetic (no three, no DOM), horizontal placement needs no code because
// CELL_WORLD_SIZE is 1, and vertical placement is one ground lookup with no
// per-frame re-sampling because ANY height change under a crop withers it
// server-side (server/index.ts's reactToTerrain).

import { cropVariation, type CropCell } from '../protocol.ts';
import type { CropPlacement } from './cropModels.ts';

/** Exactly GroundLookup from placement.ts, restated so this module has no cross-file type import to track. */
export type CropGroundLookup = (x: number, y: number) => number | null;

export interface CropPlacementResult {
  readonly placements: CropPlacement[];
  /** How many crops were skipped because their ground is unknown — see FLORA_GROUND_RETRY_SECONDS. */
  readonly pendingGround: number;
}

/**
 * Places every crop whose ground this client knows. A crop over unknown
 * ground is OMITTED rather than drawn at a guessed height — placementsFor's
 * identical reasoning in placement.ts: an absent crop reads as unrevealed
 * territory, which is honest, where any guessed height would not be.
 */
export function cropPlacementsFor(
  cells: Iterable<CropCell>,
  groundAt: CropGroundLookup,
): CropPlacementResult {
  const placements: CropPlacement[] = [];
  let pendingGround = 0;

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      continue;
    }

    const variation = cropVariation(cell.x, cell.y);
    placements.push({
      x: cell.x,
      z: cell.y,
      groundY,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingGround };
}
