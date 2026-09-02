// Turning "there is a tree at cell (x, y)" into "draw a tree at this world
// transform" — the client half's only real logic.
//
// Pure arithmetic: no three, no DOM, so it runs in the same node environment as
// the server tests (the project ships no headless GL rig; design doc puts
// rendering itself under manual verification). The `TreePlacement` import is
// type-only and therefore erased, so nothing here pulls three in at runtime.
//
// HORIZONTAL placement is one multiply: a tree's cell times CELL_WORLD_SIZE is
// its world X/Z. THE RESIDUAL THIS FILE NAMED CAME TRUE (2026-08-21): the
// constant was 1 and this module did nothing at all here, so a cell WAS a world
// coordinate; the world is sampled four times as finely now, the multiply is
// real, and it is imported from @terrace/shared rather than restated so it
// cannot drift. Tree DIMENSIONS (models.ts) are unaffected — they were always
// world units and the world did not change size.
//
// VERTICAL placement is one lookup. A tree stands ON the rendered terrain
// surface — the band-quantised height, the same number a walker's feet get — and
// never moves afterwards, because ANY height change under a tree fells it
// server-side (server/index.ts). So there is no per-frame re-sampling here and
// no sagging-through-the-ground case to handle; the only thing that can be
// temporarily wrong is a cell whose height this client has not been sent yet.

import { CELL_WORLD_SIZE } from '@terrace/shared';
import { treeVariation, type TreeCell } from '../protocol.ts';
import type { TreePlacement } from './models.ts';

/**
 * The rendered terrain surface at a cell, or null when this client has no
 * heights for it (the join snapshot has not arrived, or the chunk was never
 * streamed). Exactly ClientPluginCtx.terrainHeightAt's contract.
 */
export type GroundLookup = (x: number, y: number) => number | null;

export interface PlacementResult {
  readonly placements: TreePlacement[];
  /**
   * How many trees were skipped because their ground is unknown. Non-zero means
   * the caller should try again later — see FLORA_GROUND_RETRY_SECONDS.
   */
  readonly pendingGround: number;
}

/**
 * Places every tree whose ground this client knows.
 *
 * A tree over unknown ground is OMITTED rather than drawn at a guessed height.
 * The two candidate guesses are both worse than nothing: at sea level it is a
 * tree standing in the ocean, and at the cell's last known height it is a tree
 * hanging in the air. An absent tree simply looks like territory that has not
 * been revealed, which is what it is.
 */
export function placementsFor(cells: Iterable<TreeCell>, groundAt: GroundLookup): PlacementResult {
  const placements: TreePlacement[] = [];
  let pendingGround = 0;

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      continue;
    }

    const variation = treeVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
      groundY,
      kind: variation.kind,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingGround };
}
