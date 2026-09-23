import {
  ISOLINE_SAMPLES_PER_CELL,
  drawnLayerCapAt,
  drawnSpanCapHeight,
  isSpanDrawn,
  spanAt,
  spanCoversBand,
  spanCount,
} from '@terrace/shared';
import { BAND_WORLD_HEIGHT, HEIGHT_WORLD_SCALE } from '../../config.ts';
import { drawnBandCapY } from '../capEmission.ts';
import { drawnSurface } from '../drawnSurface.ts';
import { isCellReceived } from '../mirror.ts';
import type { TerrainMirror } from '../mirror.ts';
import { CELL_CENTRE_OFFSET } from './rayMarch.ts';
import type { BandOwner, DrawnCap, ScaledRay } from './types.ts';

const DRAWN_CAP_SAMPLES_PER_CELL = 2 * ISOLINE_SAMPLES_PER_CELL;

/** Band whose slab holds world height `y`: ((band - 1) cap, band cap]. */
function bandHoldingY(y: number): number {
  const band = Math.ceil(y / BAND_WORLD_HEIGHT);
  // Division can round a y sitting exactly on a cap into the band above.
  return (drawnBandCapY(band - 1) >= y ? band - 1 : band) + 0;
}

export function drawnCapMet(
  mirror: TerrainMirror,
  ray: ScaledRay,
  tEnter: number,
  tExit: number,
): DrawnCap | null {
  const reach = tExit - tEnter;
  // Layers are banded, so a sample per band crossed keeps a thin slab from
  // falling between samples.
  const bandsCrossed = Math.ceil(Math.abs(reach * ray.dy) / BAND_WORLD_HEIGHT);
  const samples = Math.max(DRAWN_CAP_SAMPLES_PER_CELL, bandsCrossed);
  const surface = drawnSurface(mirror);
  for (let s = 0; s <= samples; s++) {
    const t = tEnter + (reach * s) / samples;
    const u = ray.ox + t * ray.dx;
    const v = ray.oz + t * ray.dz;
    // The layer at the ray's own height: a carved gap under a roof is open.
    const band = drawnLayerCapAt(mirror.map, u, v, bandHoldingY(ray.oy + t * ray.dy), surface);
    if (band !== null) {
      return { t, band, capY: band * BAND_WORLD_HEIGHT, drawnY: drawnBandCapY(band), u, v };
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

// Four query corners plus their filter support fit within two cells of
// the ray's current cell. Tie order is fixed, and ownership stays on raw spans.
const FILTER_NEIGHBOUR_STEPS: readonly (readonly [number, number])[] =
  Array.from({ length: 25 }, (_, i): readonly [number, number] => [Math.floor(i / 5) - 2, i % 5 - 2])
    .filter(([x, y]) => x !== 0 || y !== 0);

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
  const steps = mirror.surfaceMode === 'binomial' ? FILTER_NEIGHBOUR_STEPS : NEIGHBOUR_STEPS;
  for (const [dx, dz] of steps) {
    const x = i + dx;
    const y = j + dz;
    if (x < 0 || y < 0 || x > last || y > last) continue;
    if (!isCellReceived(mirror, x, y)) continue;
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
