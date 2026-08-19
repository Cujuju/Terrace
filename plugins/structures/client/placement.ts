// Turning "there is a tier-N structure at cell (x, y)" into "draw a building
// at this world transform" — a copy of flora's client/placement.ts logic,
// carrying a tier instead of a tree kind.
//
// Pure arithmetic: no three, no DOM, so it runs in the same node environment
// as the server tests. HORIZONTAL placement needs no code (CELL_WORLD_SIZE is
// 1 — a cell IS its world X/Z). VERTICAL placement is one terrain lookup: a
// structure stands ON the rendered surface and never moves, because any
// height change under it demolishes it server-side.

import { structureVariation, type StructureCell } from '../protocol.ts';
import type { StructurePlacement } from './models.ts';

/**
 * The rendered terrain surface at a cell, or null when this client has not
 * been sent it yet. Exactly ClientPluginCtx.terrainHeightAt's contract.
 */
export type GroundLookup = (x: number, y: number) => number | null;

export interface PlacementResult {
  readonly placements: StructurePlacement[];
  /** How many structures were skipped for unknown ground — see FLORA's identical field for the retry contract this mirrors. */
  readonly pendingGround: number;
}

/**
 * Places every structure whose ground this client knows. A structure over
 * unknown ground is OMITTED rather than guessed at — the same reasoning
 * flora's placementsFor states in full: a guessed height is either a building
 * floating in the ocean or hanging in the air, and both are worse than simply
 * not drawing it until its chunk streams in.
 */
export function placementsFor(
  cells: Iterable<StructureCell>,
  groundAt: GroundLookup,
): PlacementResult {
  const placements: StructurePlacement[] = [];
  let pendingGround = 0;

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      continue;
    }

    const variation = structureVariation(cell.x, cell.y);
    placements.push({
      x: cell.x,
      z: cell.y,
      groundY,
      tier: cell.tier,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingGround };
}
