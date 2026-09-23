import {
  CHUNK_SIZE, MAX_HEIGHT, MIN_HEIGHT, drawnBandOfSample, drawnLayerCapAt,
  drawnSpanCapHeight, drawnSpanIndexCoveringBand, spanAt,
} from '@terrace/shared';
import { BAND_WORLD_HEIGHT, HEIGHT_WORLD_SCALE } from '../../config.ts';
import { intersectRayWithWall } from '../drawnFace.ts';
import { drawnSurface } from '../drawnSurface.ts';
import type { TerrainMirror } from '../mirror.ts';
import { columnOwningBand } from './bandOwner.ts';
import { scaleRayToCellSpace } from './rayMarch.ts';
import type { DrawnRisers, TerrainRayPick, Vec3 } from './types.ts';

/** Intersect the selected visual surface first, then assign a legal raw owner.
 * A raw column's cap is not a candidate plane after the contour has moved.
 */
export function filteredHitInCell(
  mirror: TerrainMirror, i: number, j: number, origin: Vec3, direction: Vec3,
  tEnter: number, tExit: number, risers: DrawnRisers | null,
): TerrainRayPick | null {
  const ray = scaleRayToCellSpace(origin, direction);
  if (!ray) return null;
  const surface = drawnSurface(mirror);
  const y0 = origin.y + tEnter * direction.y, y1 = origin.y + tExit * direction.y;
  const first = Math.max(drawnBandOfSample(MIN_HEIGHT), Math.ceil(Math.min(y0, y1) / BAND_WORLD_HEIGHT));
  const last = Math.min(drawnBandOfSample(MAX_HEIGHT), Math.ceil(Math.max(y0, y1) / BAND_WORLD_HEIGHT));
  const cols = Math.ceil(mirror.map.size / CHUNK_SIZE);
  const cx = Math.floor(i / CHUNK_SIZE), cy = Math.floor(j / CHUNK_SIZE);
  let nearest = Infinity;
  let result: TerrainRayPick | null = null;
  const accept = (t: number, band: number, face: 'riser' | 'tread'): void => {
    if (t < tEnter || t > tExit || t >= nearest) return;
    const u = ray.ox + t * ray.dx, v = ray.oz + t * ray.dz;
    const hitY = origin.y + t * direction.y;
    const own = drawnSpanIndexCoveringBand(mirror.map, i, j, band);
    const owner = own === null ? columnOwningBand(mirror, i, j, u, v, band, hitY)
      : { x: i, y: j, spanIndex: own };
    if (!owner) return;
    nearest = t;
    result = { ...owner, face, band, hitY,
      hitX: origin.x + t * direction.x, hitZ: origin.z + t * direction.z,
      surfaceY: drawnSpanCapHeight(spanAt(mirror.map, owner.x, owner.y, owner.spanIndex)) * HEIGHT_WORLD_SCALE };
  };
  for (let band = first; band <= last; band++) {
    const capY = band * BAND_WORLD_HEIGHT;
    if (direction.y < 0) {
      const t = (capY - origin.y) / direction.y;
      if (t >= tEnter && t <= tExit && t < nearest && drawnLayerCapAt(
        mirror.map, ray.ox + t * ray.dx, ray.oz + t * ray.dz, band, surface,
      ) === band) accept(t, band, 'tread');
    }
    if (!risers) continue;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, z = cy + dz;
        if (x < 0 || z < 0 || x >= cols || z >= cols) continue;
        const segments = risers.segmentsOf(z * cols + x, band);
        if (!segments) continue;
        for (let at = 0; at + 3 < segments.length; at += 4) {
          const t = intersectRayWithWall(origin, direction,
            segments[at]!, segments[at + 1]!, segments[at + 2]!, segments[at + 3]!,
            capY - BAND_WORLD_HEIGHT, capY);
          if (t !== null) accept(t, band, 'riser');
        }
      }
    }
  }
  return result;
}
