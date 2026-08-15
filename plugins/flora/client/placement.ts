// Turning "there is a tree at cell (x, y)" into "draw a tree at this world
// transform" — the client half's only real logic.
//
// Pure arithmetic: no three, no DOM, so it runs in the same node environment as
// the server tests (the project ships no headless GL rig; design §8 puts
// rendering itself under manual verification). The `TreePlacement` import is
// type-only and therefore erased, so nothing here pulls three in at runtime.
//
// HORIZONTAL placement needs no code: CELL_WORLD_SIZE is 1 (client/src/config.ts
// — "world-space X/Z coordinates ARE cell coordinates"), so a tree's cell IS its
// world X/Z. RESIDUAL, stated rather than hidden, exactly as wildlife's
// placement module states it: if CELL_WORLD_SIZE ever stops being 1, every
// dimension in this plugin's client half needs a multiply and nothing will fail
// loudly to say so.
//
// VERTICAL placement is one lookup. A tree stands ON the rendered terrain
// surface — the band-quantised height, the same number a walker's feet get — and
// never moves afterwards, because ANY height change under a tree fells it
// server-side (server/index.ts). So there is no per-frame re-sampling here and
// no sagging-through-the-ground case to handle; the only thing that can be
// temporarily wrong is a cell whose height this client has not been sent yet.

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
      x: cell.x,
      z: cell.y,
      groundY,
      kind: variation.kind,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingGround };
}
