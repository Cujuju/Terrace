// Turning "there is grass at cell (x, y)" into "draw a tuft at this world
// transform" — cropPlacement.ts's logic, restated for the meadow. See that
// file and placement.ts for the reasoning this one shares verbatim: pure
// arithmetic (no three, no DOM), horizontal placement is one multiply by
// CELL_WORLD_SIZE, and vertical placement is one ground lookup with no
// per-frame re-sampling because ANY height change under a tuft uproots it
// server-side (server/index.ts's reactToTerrain).

import { CELL_WORLD_SIZE } from '@terrace/shared';
import { grassKey, grassVariation, type GrassCell } from '../protocol.ts';
import type { GrassPlacement } from './grassModels.ts';

/** Exactly GroundLookup from placement.ts, restated so this module has no cross-file type import to track. */
export type GrassGroundLookup = (x: number, y: number) => number | null;

export interface GrassPlacementResult {
  readonly placements: GrassPlacement[];
  /**
   * WHICH tufts were skipped because their ground is unknown, as packed
   * grassKeys — see FLORA_GROUND_RETRY_SECONDS.
   *
   * The keys rather than a count, because the caller now places tufts a DELTA
   * at a time (GH #256): a count can only be recomputed by walking the whole
   * population, where a set of keys can be maintained by the same delta that
   * placed them.
   */
  readonly pendingCells: number[];
}

/**
 * Places every tuft whose ground this client knows. A tuft over unknown ground
 * is OMITTED rather than drawn at a guessed height — placementsFor's identical
 * reasoning: absent reads as unrevealed territory, which is honest, where any
 * guessed height would not be.
 */
export function grassPlacementsFor(
  cells: Iterable<GrassCell>,
  groundAt: GrassGroundLookup,
): GrassPlacementResult {
  const placements: GrassPlacement[] = [];
  const pendingCells: number[] = [];

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingCells.push(grassKey(cell.x, cell.y));
      continue;
    }

    const variation = grassVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
      cellX: cell.x,
      cellY: cell.y,
      groundY,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingCells };
}
