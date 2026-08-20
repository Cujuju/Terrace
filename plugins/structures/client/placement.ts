// Turning "there is a tier-N structure at cell (x, y)" into "draw a building
// at this world transform" — a copy of flora's client/placement.ts logic,
// carrying a tier instead of a tree kind.
//
// Pure arithmetic: no three, no DOM, so it runs in the same node environment
// as the server tests. HORIZONTAL placement needs no code (CELL_WORLD_SIZE is
// 1 — a cell IS its world X/Z). VERTICAL placement is one terrain lookup: a
// structure stands ON the rendered surface and never moves, because any
// height change under it demolishes it server-side.
//
// CARD 33 ("Fishing Villages") ADDITION: every placement now also carries a
// SiteKind (site.ts) — this is where "where does this structure stand"
// meets "what does it look like", so it lives beside the ground lookup
// rather than inside models.ts, which only ever consumes the answer. A
// coastal placement also seeds this settlement's SKIFFS (skiffs.ts) from the
// SAME neighbourhood survey site.ts already did to answer the site question
// — one scan of the search disc, not two.

import { settlementRace, structureVariation, type StructureCell } from '../protocol.ts';
import type { StructurePlacement } from './models.ts';
import { surveySite } from './site.ts';
import { skiffsForSettlement, type SkiffPlacement } from './skiffs.ts';

/**
 * The rendered terrain surface at a cell, or null when this client has not
 * been sent it yet. Exactly ClientPluginCtx.terrainHeightAt's contract.
 */
export type GroundLookup = (x: number, y: number) => number | null;

export interface PlacementResult {
  readonly placements: StructurePlacement[];
  /** This tick's whole skiff fleet, across every coastal settlement — see skiffs.ts. */
  readonly skiffs: SkiffPlacement[];
  /** How many structures were skipped for unknown ground — see FLORA's identical field for the retry contract this mirrors. */
  readonly pendingGround: number;
  /**
   * How many PLACED structures (ground known, so not counted in
   * pendingGround) had an INDETERMINATE site survey — see site.ts's
   * SiteSurvey.pending. Combined with pendingGround by the caller to decide
   * whether to retry: a structure with unknown neighbours still renders now
   * (conservatively, as 'inland'), but may be worth re-surveying once more
   * terrain streams in.
   */
  readonly pendingSite: number;
}

/**
 * Places every structure whose ground this client knows. A structure over
 * unknown ground is OMITTED rather than guessed at — the same reasoning
 * flora's placementsFor states in full: a guessed height is either a building
 * floating in the ocean or hanging in the air, and both are worse than simply
 * not drawing it until its chunk streams in.
 */
export function placementsFor(cells: Iterable<StructureCell>, groundAt: GroundLookup): PlacementResult {
  const placements: StructurePlacement[] = [];
  const skiffs: SkiffPlacement[] = [];
  let pendingGround = 0;
  let pendingSite = 0;

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      continue;
    }

    const survey = surveySite(groundAt, cell.x, cell.y);
    if (survey.pending) pendingSite++;

    const variation = structureVariation(cell.x, cell.y);
    placements.push({
      x: cell.x,
      z: cell.y,
      groundY,
      tier: cell.tier,
      scale: variation.scale,
      yaw: variation.yaw,
      race: settlementRace(cell.x, cell.y),
      site: survey.kind,
    });

    if (survey.kind === 'coastal') {
      skiffs.push(...skiffsForSettlement(cell.tier, survey.waterCells));
    }
  }

  return { placements, skiffs, pendingGround, pendingSite };
}
