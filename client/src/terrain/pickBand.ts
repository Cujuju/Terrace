import {
  BAND_HEIGHT,
  bandOf,
  isSpanDrawn,
  spanAt,
  spanCapHeight,
  spanCount,
  spanIndexCoveringBand,
  spanUndersideHeight,
  type Heightmap,
} from '@terrace/shared';
import { HEIGHT_WORLD_SCALE } from '../config.ts';
import type { TerrainRayPick } from './picking.ts';

export type PickFace = 'riser' | 'tread' | 'underside';

export interface ResolvedPick {
  readonly face: PickFace;
  readonly band: number;
}

export function resolvePick(map: Heightmap, pick: TerrainRayPick): ResolvedPick | null {
  const size = map.size;
  if (pick.x < 0 || pick.y < 0 || pick.x >= size || pick.y >= size) return null;
  if (pick.spanIndex < 0 || pick.spanIndex >= spanCount(map, pick.x, pick.y)) return null;
  const span = spanAt(map, pick.x, pick.y, pick.spanIndex);
  if (!isSpanDrawn(span)) return null;
  const capY = spanCapHeight(span) * HEIGHT_WORLD_SCALE;
  const undersideY = spanUndersideHeight(span) * HEIGHT_WORLD_SCALE;
  if (pick.hitY < undersideY || pick.hitY > capY) return null;

  const lowestDrawn = bandOf(spanUndersideHeight(span)) + 1;

  if (pick.hitRiser) {
    const struck = Math.ceil(pick.hitY / (HEIGHT_WORLD_SCALE * BAND_HEIGHT));
    return { face: 'riser', band: struck < lowestDrawn ? lowestDrawn : struck };
  }
  if (pick.hitY === capY) return { face: 'tread', band: bandOf(spanCapHeight(span)) };
  return { face: 'underside', band: lowestDrawn };
}

export function bandOfPick(map: Heightmap, pick: TerrainRayPick): number | null {
  return resolvePick(map, pick)?.band ?? null;
}

export function carveBandOfPick(
  map: Heightmap,
  pick: TerrainRayPick,
  lipNear: (band: number) => boolean,
): number | null {
  const resolved = resolvePick(map, pick);
  if (resolved === null) return null;
  if (resolved.face === 'tread' && !lipNear(resolved.band)) return null;
  if (spanIndexCoveringBand(map, pick.x, pick.y, resolved.band) === null) return null;
  return resolved.band;
}
