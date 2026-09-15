import {
  BAND_HEIGHT,
  bandFloorHeight,
  drawnBandOfSample,
  drawnBandOfSpan,
  highestCeilingBelow,
  isSpanDrawn,
  spanAt,
  drawnSpanCapHeight,
  spanCount,
  spanIndexBelowBand,
  drawnSpanIndexCoveringBand,
  spanUndersideHeight,
  type Heightmap,
} from '@terrace/shared';
import { HEIGHT_WORLD_SCALE } from '../config.ts';
import { sampleHeight, type TerrainMirror } from './mirror.ts';
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
    const struck = Math.ceil(pick.hitY / (HEIGHT_WORLD_SCALE * BAND_HEIGHT));
    if (struck < lowestDrawn) return { face: 'riser', band: lowestDrawn };
    // Never name above the struck span's own cap. Raw ceil overshoots two
    // ways at the shore: a skirt hit below a drawn-0 cap names 0-then-water
    // (hitY <= 0 ceils to 0, and the old shore rule mapped that to -1), while
    // the wall's only nearby lip is the drawn band-0 waterline loop. The lip
    // overlay is keyed by drawn band, so the cap's drawn band is the grabbable
    // one — otherwise lipNear misses and the grab silently fails.
    const capDrawn = drawnBandOfSample(span.ceiling);
    const band = capDrawn < struck ? capDrawn : struck;
    // Normalize -0 (ceil of a negative fraction): band ids are compared exactly.
    return { face: 'riser', band: band + 0 };
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

/** Spans a column needs before a stroke can grasp one layer of it. */
const MIN_LAYERED_SPAN_COUNT = 2;

export function graspSpanBandIn(
  map: Heightmap,
  pick: TerrainRayPick,
  atX: number,
  atY: number,
): number | null {
  if (spanCount(map, atX, atY) < MIN_LAYERED_SPAN_COUNT) return null;
  const band = bandOfPick(map, pick);
  if (band === null) return null;
  if (atX === pick.x && atY === pick.y) return band;
  if (drawnSpanIndexCoveringBand(map, atX, atY, band) !== null) return band;
  const below = spanIndexBelowBand(map, atX, atY, band);
  if (below === null) return null;
  const span = spanAt(map, atX, atY, below);
  // The anchor stands at the riser's foot: grasp the tread under it, never the roof over it.
  return isSpanDrawn(span) ? drawnBandOfSpan(span) : null;
}

/**
 * Cap band of the layer holding `spanBand` (the column top when null); after a
 * lower, the layer just beneath it. Reported in the DRAWN banding the pick, the
 * grasp and the drag plane all speak.
 */
export function bandAtCellIn(
  mirror: TerrainMirror,
  x: number,
  y: number,
  spanBand: number | null,
): number | null {
  if (spanBand === null) return drawnBandOfSample(sampleHeight(mirror, x, y));
  const map = mirror.map;
  const k = drawnSpanIndexCoveringBand(map, x, y, spanBand);
  const ceiling =
    k !== null
      ? spanAt(map, x, y, k).ceiling
      : highestCeilingBelow(map, x, y, bandFloorHeight(spanBand));
  return ceiling === null ? null : drawnBandOfSample(ceiling);
}
