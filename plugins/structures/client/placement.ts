// Turning "there is a tier-N structure at cell (x, y)" into "draw a building
// at this world transform" — a copy of flora's client/placement.ts logic,
// carrying a tier instead of a tree kind.
//
// Pure arithmetic: no three, no DOM, so it runs in the same node environment
// as the server tests. HORIZONTAL placement is one multiply by CELL_WORLD_SIZE
// (it was a no-op while a cell was a world unit, up to the 2026-08-21
// re-sample). VERTICAL placement is one terrain lookup: a
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
//
// TWO GROUND LOOKUPS, NOT ONE (2026-09-04, GH #327). A BUILDING stands on the
// ground and takes the cheap lattice answer (`groundAt`); a moored SKIFF is
// seen against the ground and has to be tested on the drawn cap (`drawnAt`),
// which is why both are passed through to site.ts. See its banner for why the
// two disagree by a whole band at exactly the shoreline, and
// ClientPluginCtx.drawnGroundYAt for the standing-versus-lying-on rule this
// follows. That scan is MEMOISED across
// rebuilds when the caller supplies a SiteSurveyCache (site.ts): the answer
// only moves when the terrain under the disc does, and a delta of one
// structure otherwise pays for a survey of every structure (GH #258).

import { CELL_WORLD_SIZE } from '@terrace/shared';
import { settlementRace, structureVariation, type StructureCell } from '../protocol.ts';
import type { StructurePlacement } from './models.ts';
import { surveySite, type SiteSurveyCache } from './site.ts';
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
export function placementsFor(
  cells: Iterable<StructureCell>,
  groundAt: GroundLookup,
  drawnAt: GroundLookup,
  surveys?: SiteSurveyCache,
): PlacementResult {
  const placements: StructurePlacement[] = [];
  const skiffs: SkiffPlacement[] = [];
  let pendingGround = 0;
  let pendingSite = 0;

  surveys?.beginPass();
  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      continue;
    }

    // THE ONE EXPENSIVE STEP IN THIS LOOP, and the reason the cache exists
    // (GH #258): a survey is 748 ground samples, and this loop runs over every
    // structure on every delta. An uncached caller — the tests, and anything
    // with no terrain-revision source — still gets the identical answer from
    // the identical call.
    const survey =
      surveys === undefined
        ? surveySite(groundAt, drawnAt, cell.x, cell.y)
        : surveys.surveyAt(groundAt, drawnAt, cell.x, cell.y);
    if (survey.pending) pendingSite++;

    const variation = structureVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
      // The cell itself travels with the placement: every per-building
      // cosmetic roll downstream (Durand's skin, the fishing-hut variant)
      // hashes integer CELL coordinates, and x/z above are world units — a
      // quarter of a cell each since the 2026-08-21 re-sample, so hashing
      // them would fold four cells onto one roll. See
      // models.ts's StructurePlacement.cellX.
      cellX: cell.x,
      cellY: cell.y,
      groundY,
      tier: cell.tier,
      scale: variation.scale,
      yaw: variation.yaw,
      race: settlementRace(cell.x, cell.y),
      site: survey.kind,
    });

    if (survey.kind === 'coastal') {
      skiffs.push(...skiffsForSettlement(cell.tier, survey.moorings));
    }
  }

  surveys?.endPass();
  return { placements, skiffs, pendingGround, pendingSite };
}
