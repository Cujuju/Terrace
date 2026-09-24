import { Box3, Vector3 } from 'three';
import { CELL_WORLD_SIZE, drawnWorldUnits } from '@terrace/shared';
import type { AssetPart } from '../../../client/src/render/staticAsset.ts';
import {
  MAX_STRUCTURE_TIER,
  STRUCTURE_SCALE_MAX,
  STRUCTURE_TIERS,
  structureFootprintRadiusCells,
  type StructureTier,
} from '../protocol.ts';
import { AUTHORED_RADII } from './authoredRadii.ts';

interface RealSize {
  readonly heightMetres: number;
  readonly widthMetres: number;
  readonly depthMetres: number;
}

function size(heightMetres: number, widthMetres: number, depthMetres: number): RealSize {
  return { heightMetres, widthMetres, depthMetres };
}

// Chosen so drawn bulk rises with every tier (owner rule: developed buildings are larger).
const LADDER_REAL_SIZES: readonly RealSize[] = [
  size(2.5, 4, 4),
  size(3.5, 5, 5),
  size(4, 5, 5),
  size(5, 6, 10),
  size(5.5, 5, 16),
  size(7, 7, 10),
  size(7.5, 7, 10),
  size(15, 6, 6),
  size(12, 7, 7),
  size(11, 9, 12),
  size(13, 10, 14),
];

const TOP_TIER_ALTERNATE_REAL_SIZES: Readonly<Record<string, RealSize>> = {
  durands: size(13, 10, 12),
  ricks: size(9, 12, 12),
  'flipper-shrimp': size(9, 12, 12),
};

/** Coastal settlements draw fishing huts up to this tier, then the ladder. */
export const COASTAL_HUT_MAX_TIER: StructureTier = 3;

// A cell centre surveys the half cell around it, so a model may reach half a cell past its radius.
const FOOTPRINT_EDGE_CELLS = 0.5;

function drawnBulk(real: RealSize): number {
  return drawnWorldUnits(real.heightMetres) * drawnWorldUnits(real.widthMetres) * drawnWorldUnits(real.depthMetres);
}

export function authoredBulk(parts: readonly AssetPart[]): number {
  const bounds = new Box3();
  const partBounds = new Box3();
  for (const part of parts) {
    part.geometry.computeBoundingBox();
    for (const local of part.localMatrices) {
      bounds.union(partBounds.copy(part.geometry.boundingBox!).applyMatrix4(local));
    }
  }
  const extent = bounds.getSize(new Vector3());
  return extent.x * extent.y * extent.z;
}

function footprintBudgetCells(tier: StructureTier): number {
  return structureFootprintRadiusCells(tier) + FOOTPRINT_EDGE_CELLS;
}

function assertFitsFootprint(label: string, authoredRadius: number, scale: number, tier: StructureTier): void {
  const reachCells = (authoredRadius * scale * STRUCTURE_SCALE_MAX) / CELL_WORLD_SIZE;
  const budgetCells = footprintBudgetCells(tier);
  if (reachCells > budgetCells) {
    throw new RangeError(
      `structures: ${label} reaches ${reachCells.toFixed(2)} cells at tier ${tier}, ` +
        `past its footprint of ${budgetCells}; raise STRUCTURE_FOOTPRINT_RADIUS_CELLS[${tier}]`,
    );
  }
}

function authoredRadius(id: string): number {
  const radius = AUTHORED_RADII[id];
  if (radius === undefined) throw new Error(`structures: no authored radius for ${id}`);
  return radius;
}

/** Uniform scale that brings a ladder or top-tier building to its real bulk. */
export function buildingDrawScale(id: string, parts: readonly AssetPart[]): number {
  const ladderTier = (STRUCTURE_TIERS as readonly string[]).indexOf(id);
  const real = ladderTier >= 0 ? LADDER_REAL_SIZES[ladderTier] : TOP_TIER_ALTERNATE_REAL_SIZES[id];
  if (real === undefined) throw new Error(`structures: no real size for ${id}`);
  const scale = Math.cbrt(drawnBulk(real) / authoredBulk(parts));
  assertFitsFootprint(id, authoredRadius(id), scale, ladderTier >= 0 ? ladderTier : MAX_STRUCTURE_TIER);
  return scale;
}

/**
 * Fishing-hut scale per coastal tier: mean hut bulk matches that tier's ladder building,
 * capped so the widest hut stays inside the tier's footprint.
 */
export function coastalHutTierScales(huts: ReadonlyArray<{ readonly id: string; readonly parts: readonly AssetPart[] }>): number[] {
  const meanBulk = huts.reduce((sum, hut) => sum + authoredBulk(hut.parts), 0) / huts.length;
  const widestRadius = Math.max(...huts.map((hut) => authoredRadius(hut.id)));
  const scales: number[] = [];
  for (let tier = 0; tier <= COASTAL_HUT_MAX_TIER; tier++) {
    const fitScale = (footprintBudgetCells(tier) * CELL_WORLD_SIZE) / (widestRadius * STRUCTURE_SCALE_MAX);
    scales.push(Math.min(Math.cbrt(drawnBulk(LADDER_REAL_SIZES[tier]!) / meanBulk), fitScale));
  }
  return scales;
}

if (LADDER_REAL_SIZES.length !== STRUCTURE_TIERS.length) {
  throw new RangeError('LADDER_REAL_SIZES needs one real size per structure tier');
}
