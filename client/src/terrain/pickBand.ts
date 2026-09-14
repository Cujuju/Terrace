import {
  BAND_HEIGHT,
  DRAWN_GROUND_BAND_BIAS,
  drawnBandOfSample,
  drawnLevelThreshold,
  isSpanDrawn,
  spanAt,
  drawnSpanCapHeight,
  spanCount,
  drawnSpanIndexCoveringBand,
  spanUndersideHeight,
  type Heightmap,
} from '@terrace/shared';
import { HEIGHT_WORLD_SCALE } from '../config.ts';
import type { PickFace, TerrainRayPick } from './picking.ts';

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
  const capY = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
  // F4: the underside cue snaps to the drawn ceiling, matching terrainHitInCell.
  const undersideY = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
  // Underside hits report hitY at the drawn ceiling; tread/riser at or below it.
  // Allow a riser entry exactly at the blocky underside through by clamping the
  // lower bound to the drawn bottom only for the reject test.
  const drawnBottomY =
    drawnBandOfSample(spanUndersideHeight(span)) * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
  if (pick.hitY < drawnBottomY || pick.hitY > capY) return null;
  void undersideY;

  // F3: lowest drawn band from the drawn banding (bias + shore).
  const lowestDrawn = drawnBandOfSample(spanUndersideHeight(span)) + 1;

  if (pick.face === 'riser') {
    let struck = Math.ceil(pick.hitY / (HEIGHT_WORLD_SCALE * BAND_HEIGHT));
    // Shore: band 0 draws only at/above the shoreline; below it is water (-1).
    if (
      struck === 0 &&
      pick.hitY + DRAWN_GROUND_BAND_BIAS * HEIGHT_WORLD_SCALE <
        drawnLevelThreshold(0) * HEIGHT_WORLD_SCALE
    ) {
      struck = -1;
    }
    return { face: 'riser', band: struck < lowestDrawn ? lowestDrawn : struck };
  }
  // F3: tread ceilings resolve in the drawn banding, so a bias-shifted cap
  // names the band the mesh emitted.
  if (pick.face === 'tread') return { face: 'tread', band: drawnBandOfSample(span.ceiling) };
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
  // F3: carve reach queries the drawn banding, matching the emitted caps.
  if (drawnSpanIndexCoveringBand(map, pick.x, pick.y, resolved.band) === null) return null;
  return resolved.band;
}
