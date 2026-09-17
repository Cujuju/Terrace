import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  settlementRace,
  structureKey,
  structureVariation,
  type StructureCell,
  type StructureTier,
} from '../protocol.ts';
import type { StructurePlacement } from './models.ts';
import { SKIFF_MOORING_SPACING_CELLS_SQUARED, surveySite, type SiteSurveyCache } from './site.ts';
import { skiffsForSettlement, type SkiffPlacement } from './skiffs.ts';

export type GroundLookup = (x: number, y: number) => number | null;

export interface PlacementResult {
  readonly placements: StructurePlacement[];
  readonly skiffs: SkiffPlacement[];
  readonly pendingGround: number;
  readonly pendingSite: number;
  /** Cells whose ground or site survey awaits terrain the client does not hold yet. */
  readonly pendingCells: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

export function placementsFor(
  cells: Iterable<StructureCell>,
  drawnAt: GroundLookup,
  surveys?: SiteSurveyCache,
): PlacementResult {
  const placements: StructurePlacement[] = [];
  const skiffs: SkiffPlacement[] = [];
  const harbours: Array<{
    key: number;
    tier: StructureTier;
    moorings: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  }> = [];
  let pendingGround = 0;
  let pendingSite = 0;
  const pendingCells: Array<{ x: number; y: number }> = [];

  surveys?.beginPass();
  for (const cell of cells) {
    const groundY = drawnAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      pendingCells.push({ x: cell.x, y: cell.y });
      continue;
    }

    const survey =
      surveys === undefined
        ? surveySite(drawnAt, cell.x, cell.y)
        : surveys.surveyAt(drawnAt, cell.x, cell.y);
    if (survey.pending) {
      pendingSite++;
      pendingCells.push({ x: cell.x, y: cell.y });
    }

    const variation = structureVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
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
      harbours.push({
        key: structureKey(cell.x, cell.y),
        tier: cell.tier,
        moorings: survey.moorings,
      });
    }
  }

  surveys?.endPass();

  harbours.sort((a, b) => a.key - b.key);
  const claimed: Array<{ readonly x: number; readonly y: number }> = [];
  for (const harbour of harbours) {
    const free = harbour.moorings.filter((mooring) =>
      claimed.every((taken) => {
        const dx = mooring.x - taken.x;
        const dy = mooring.y - taken.y;
        return dx * dx + dy * dy >= SKIFF_MOORING_SPACING_CELLS_SQUARED;
      }),
    );
    const fleet = skiffsForSettlement(harbour.tier, free);
    for (const skiff of fleet) claimed.push({ x: skiff.x, y: skiff.z });
    skiffs.push(...fleet);
  }

  return { placements, skiffs, pendingGround, pendingSite, pendingCells };
}
