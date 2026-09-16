import {
  ISOLINE_SAMPLES_PER_CELL,
  drawnBandAt,
  drawnSpanCapHeight,
  isSpanDrawn,
  spanAt,
  spanCoversBand,
  spanCount,
} from '@terrace/shared';
import { BAND_WORLD_HEIGHT, HEIGHT_WORLD_SCALE } from '../../config.ts';
import { drawnBandCapY } from '../capEmission.ts';
import type { TerrainMirror } from '../mirror.ts';
import { CELL_CENTRE_OFFSET } from './rayMarch.ts';
import type { BandOwner, DrawnCap, ScaledRay } from './types.ts';

const DRAWN_CAP_SAMPLES_PER_CELL = 2 * ISOLINE_SAMPLES_PER_CELL;

export function drawnCapMet(
  mirror: TerrainMirror,
  ray: ScaledRay,
  tEnter: number,
  tExit: number,
): DrawnCap | null {
  const reach = tExit - tEnter;
  for (let s = 0; s <= DRAWN_CAP_SAMPLES_PER_CELL; s++) {
    const t = tEnter + (reach * s) / DRAWN_CAP_SAMPLES_PER_CELL;
    const u = ray.ox + t * ray.dx;
    const v = ray.oz + t * ray.dz;
    const band = drawnBandAt(mirror.map, u, v);
    const drawnY = drawnBandCapY(band);
    if (ray.oy + t * ray.dy <= drawnY) {
      return { t, band, capY: band * BAND_WORLD_HEIGHT, drawnY, u, v };
    }
  }
  return null;
}

// F2: the drawn contour can sit diagonally across the cell, so the owner
// search covers all 8 neighbours by centre distance.
const NEIGHBOUR_STEPS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

function spanStruckAt(
  mirror: TerrainMirror,
  x: number,
  y: number,
  band: number,
  faceY: number,
): number | null {
  // F3: coverage is the shared band predicate. The cue floor is the span's own
  // drawn underside, so a wall whose foot was carved keeps its upper bands.
  const count = spanCount(mirror.map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(mirror.map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    if (!spanCoversBand(span, band)) continue;
    const drawnCapWorld = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
    if (faceY < drawnBandCapY(span.floorBand - 1)) continue;
    if (faceY > drawnCapWorld) continue;
    return k;
  }
  return null;
}

export function columnOwningBand(
  mirror: TerrainMirror,
  i: number,
  j: number,
  u: number,
  v: number,
  band: number,
  faceY: number,
): BandOwner | null {
  const last = mirror.map.size - 1;
  let owner: BandOwner | null = null;
  let nearest = Infinity;
  for (const [dx, dz] of NEIGHBOUR_STEPS) {
    const x = i + dx;
    const y = j + dz;
    if (x < 0 || y < 0 || x > last || y > last) continue;
    const spanIndex = spanStruckAt(mirror, x, y, band, faceY);
    if (spanIndex === null) continue;
    const offX = x + CELL_CENTRE_OFFSET - u;
    const offZ = y + CELL_CENTRE_OFFSET - v;
    const distance = offX * offX + offZ * offZ;
    if (distance >= nearest) continue;
    nearest = distance;
    owner = { x, y, spanIndex };
  }
  return owner;
}
