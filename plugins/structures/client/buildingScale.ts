import { Box3, Vector3 } from 'three';
import { CELL_WORLD_SIZE, drawnWorldUnits } from '@terrace/shared';
import type { AssetPart } from '../../../client/src/render/staticAsset.ts';
import { STRUCTURE_SCALE_MAX } from '../protocol.ts';
import { BUILDING_MODEL_FOOTPRINT_RADIUS_CELLS, baseModelOf } from '../buildingKinds.ts';
import { AUTHORED_RADII } from './authoredRadii.ts';

interface RealSize {
  readonly heightMetres: number;
  readonly widthMetres: number;
  readonly depthMetres: number;
}

function size(heightMetres: number, widthMetres: number, depthMetres: number): RealSize {
  return { heightMetres, widthMetres, depthMetres };
}

// Real sizes, height first. A model is scaled uniformly until its bulk matches.
const REAL_SIZES: Readonly<Record<string, RealSize>> = {
  camp: size(2.5, 4, 4),
  hut: size(3.5, 5, 5),
  'prehistoric-granary': size(4, 5, 5),
  'roman-granary': size(5, 6, 10),
  longhouse: size(5.5, 5, 16),
  'timber-house': size(7, 7, 10),
  'stone-cottage': size(7.5, 7, 10),
  watchtower: size(15, 6, 6),
  'medieval-dovecote': size(12, 7, 7),
  'renaissance-workshop': size(11, 9, 12),
  'industrial-pump-house': size(13, 10, 14),
  durands: size(13, 10, 12),
  ricks: size(9, 12, 12),
  'flipper-shrimp': size(9, 12, 12),
  'reed-cone': size(3.5, 4, 4),
  'lashed-a-frame': size(3.5, 4, 5),
  'stilted-hut': size(5, 4, 5),
  'windbreak-dome': size(2, 4, 4),
  'upturned-hull': size(3, 3, 6),
  'twin-hut-yard': size(3, 8, 8),
  'drying-rack-long-hut': size(3.5, 5, 6),
  'turf-roof-on-stone': size(4, 5, 6),
  'net-draped-cone': size(3.5, 5, 5),
  'smoke-pit-hut': size(3.5, 5, 5),
};

// Owner styling on top of the real-size rule: these read better drawn larger.
const STYLE_SIZE_MULTIPLIERS: Readonly<Record<string, number>> = {
  longhouse: 1.5,
  ricks: 1.5,
};

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

/**
 * Uniform scale that brings a building model to its real bulk. Throws when the drawn model
 * would outgrow the footprint the server surveys for it (buildingKinds.ts).
 */
export function buildingDrawScale(id: string, parts: readonly AssetPart[]): number {
  const base = baseModelOf(id);
  const real = REAL_SIZES[base];
  const radius = AUTHORED_RADII[id];
  const footprint = BUILDING_MODEL_FOOTPRINT_RADIUS_CELLS[id];
  if (real === undefined || radius === undefined || footprint === undefined) {
    throw new Error(`structures: ${id} needs a real size, an authored radius and a footprint`);
  }
  const scale = Math.cbrt(drawnBulk(real) / authoredBulk(parts)) * (STYLE_SIZE_MULTIPLIERS[base] ?? 1);
  const reachCells = (radius * scale * STRUCTURE_SCALE_MAX) / CELL_WORLD_SIZE;
  if (reachCells > footprint + FOOTPRINT_EDGE_CELLS) {
    throw new RangeError(
      `structures: ${id} reaches ${reachCells.toFixed(2)} cells, past its footprint of ` +
        `${footprint}; raise it in buildingKinds.ts`,
    );
  }
  return scale;
}
