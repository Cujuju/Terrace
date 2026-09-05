// WHICH BAND A PICK NAMES — the one derivation every consumer of a
// `TerrainRayPick` shares: the pull's grab (`World.highlightLayerEdge`), the
// wire's `spanBand` (`World.graspSpanBand`) and the carve's cut
// (`World.carveBand`).
//
// CRITICAL CODE — this decides which layer a press edits, and a wrong answer
// is an edit the player did not ask for.
//
// PURE, AND SEPARATE FROM world.ts ON PURPOSE (2026-09-04, issue #324). Its
// only inputs are the live heightmap and the pick, so the contract it
// implements — no clamp, null when the pick does not fit the column — can be
// stated against a map fixture instead of against a live renderer.

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

/** Which face of the struck span a pick landed on. */
export type PickFace = 'riser' | 'tread' | 'underside';

/** A pick resolved against the LIVE map: the face it met and the band it named. */
export interface ResolvedPick {
  readonly face: PickFace;
  readonly band: number;
}

/**
 * The band a ray AIMED AT, with the face it aimed at.
 *
 * NULL, NEVER A CLAMP, WHEN THE PICK DOES NOT FIT THE COLUMN (issue #324,
 * 2026-09-04). Every field this reads off the map — the span at `spanIndex`,
 * its cap, its underside — is only a name for what that column held when the
 * pick was marched, so a pick that outlived an edit can arrive with a
 * `spanIndex` a carve or a weld has renumbered, or a `hitY` the span no longer
 * reaches. This used to clamp such a height into the span's drawn range and
 * answer confidently with the band at the end of the clamp; a caller cannot
 * tell that from a real answer. It now says nothing.
 *
 * BELT, NOT THE FIX. `hoverTarget` re-derives its pick from the live map on
 * every read (input/sculptInput.ts), so a stale pick has no way to reach here
 * in the first place; this is what keeps a future caller that caches one from
 * getting a wrong answer instead of no answer.
 */
export function resolvePick(map: Heightmap, pick: TerrainRayPick): ResolvedPick | null {
  const size = map.size;
  if (pick.x < 0 || pick.y < 0 || pick.x >= size || pick.y >= size) return null;
  if (pick.spanIndex < 0 || pick.spanIndex >= spanCount(map, pick.x, pick.y)) return null;
  const span = spanAt(map, pick.x, pick.y, pick.spanIndex);
  // A span too thin to reach a band boundary draws nothing, so it has no face
  // to have been struck — the same test the picking march applies.
  if (!isSpanDrawn(span)) return null;
  const capY = spanCapHeight(span) * HEIGHT_WORLD_SCALE;
  const undersideY = spanUndersideHeight(span) * HEIGHT_WORLD_SCALE;
  // THE PRECONDITION: the struck height still lies in the slab this span
  // draws. Outside it, the face the ray met is not this span's face.
  if (pick.hitY < undersideY || pick.hitY > capY) return null;

  // The slab the renderer draws for band k occupies
  // [(k-1)*BAND_HEIGHT, k*BAND_HEIGHT] (columns.ts `spanUndersideHeight`), so
  // the LOWEST band this span draws is one above the band of its underside.
  const lowestDrawn = bandOf(spanUndersideHeight(span)) + 1;

  if (pick.hitRiser) {
    // A RISER HIT NAMES THE BAND WHOSE SLAB CONTAINS THE STRUCK HEIGHT (owner,
    // 2026-08-26: "if you're grabbing the side of a band, then that is the band
    // that should apply. I would never grab the band below"), so the band
    // containing a height is its CEILING in band units — the whole face of
    // band k, top to bottom, is band k's handle.
    //
    // NOT `round` (which is what this was): rounding made the bottom half of
    // every face grab the band below the one being pointed at. NOT the span's
    // cap band either: a column is drawn solid from its own cap down to its
    // neighbour's, so a cliff that drops five bands at once is ONE span with
    // one five-band-tall riser face carrying five lips, and the cap band would
    // name the clifftop for every one of them (the 2026-08-24 report).
    //
    // THE ONE LEGITIMATE TIE-BREAK is the `max`: a hit landing exactly on the
    // span's UNDERSIDE boundary is where `ceil` is exact and names the band
    // below the face, and that hit belongs to the lowest band the span draws.
    // No upper tie-break is needed — the precondition above already puts
    // `hitY` at or below the cap, and a cap is band-aligned.
    const struck = Math.ceil(pick.hitY / (HEIGHT_WORLD_SCALE * BAND_HEIGHT));
    return { face: 'riser', band: struck < lowestDrawn ? lowestDrawn : struck };
  }
  // A HORIZONTAL FACE at the span's own cap is the TREAD: the band of the cap
  // is the band whose slab the player is standing on top of.
  if (pick.hitY === capY) return { face: 'tread', band: bandOf(spanCapHeight(span)) };
  // Below it, the ray came up through the span's UNDERSIDE — a cave roof seen
  // from below — and the band whose slab it met is the lowest one the span
  // draws. This returned the CAP band until 2026-09-04; unreachable from a
  // descending camera, changed so all three faces name the slab actually met.
  return { face: 'underside', band: lowestDrawn };
}

/** `resolvePick`'s band alone, for the callers that do not care which face. */
export function bandOfPick(map: Heightmap, pick: TerrainRayPick): number | null {
  return resolvePick(map, pick)?.band ?? null;
}

/**
 * The band a CARVE press starting at this pick would cut from, or null when it
 * would cut nothing.
 *
 * D1 (owner, 2026-09-04): "It should work on either the corner edge or the side
 * face."
 *
 *  - SIDE FACE (a riser hit): the band the face belongs to, as always.
 *  - CORNER EDGE (a tread hit): the struck span's cap band, but only when that
 *    band's LIP is actually within reach of where the ray met the tread. A flat
 *    tread far from any lip is not a corner edge and carves nothing.
 *  - UNDERSIDE: the lowest band the span draws, as `resolvePick` says.
 *
 * `lipNear` is asked ONLY for the tread case, and it is the overlay's own
 * distance rule (render/layerEdgeOverlay.ts's `lipNear`, GRAB_RADIUS_WORLD_UNITS
 * from the point the ray met the tread) — passed in rather than reimplemented,
 * so the lip the press takes is the lip the highlight lit.
 *
 * BELT: the band is then re-checked against `spanIndexCoveringBand`, which is
 * the exact test the server applies before it will act on a `spanBand`
 * (shared/src/heightmap.ts's `applySculpt`). The client can therefore never
 * send a band the server would silently no-op.
 *
 * THAT CHECK CANNOT FIRE TODAY, and is kept for the same reason `resolvePick`'s
 * precondition is: the band resolved above always lies between the struck
 * span's lowest drawn band and its cap, and that span covers every band in
 * that range. It is what stops a future change to either derivation from
 * putting a dead band on the wire instead of failing here.
 */
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
