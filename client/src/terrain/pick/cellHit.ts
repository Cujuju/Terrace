import {
  BAND_HEIGHT,
  drawnBandOfSample,
  drawnSpanCapHeight,
  drawnSpanIndexCoveringBand,
  isSpanDrawn,
  spanAt,
  spanCount,
  spanUndersideHeight,
  type Span,
} from '@terrace/shared';
import { HEIGHT_WORLD_SCALE } from '../../config.ts';
import { blockyCellCapY } from '../capEmission.ts';
import type { TerrainMirror } from '../mirror.ts';
import { columnOwningBand, drawnCapMet } from './bandOwner.ts';
import { refineRiserToDrawnFace } from './drawnFaceRefine.ts';
import { cellRevealed, scaleRayToCellSpace } from './rayMarch.ts';
import type { DrawnCap, DrawnRisers, TerrainRayPick, Vec3 } from './types.ts';

export function terrainHitInCell(
  mirror: TerrainMirror,
  i: number,
  j: number,
  origin: Vec3,
  direction: Vec3,
  tEnter: number,
  tExit: number,
  risers: DrawnRisers | null,
): TerrainRayPick | null {
  if (!cellRevealed(mirror, i, j)) return null;

  const oy = origin.y;
  const dy = direction.y;
  const entryY = oy + tEnter * dy;
  const exitY = oy + tExit * dy;
  const count = spanCount(mirror.map, i, j);
  const ray = scaleRayToCellSpace(origin, direction);
  let hit: TerrainRayPick | null = null;
  let hitT = Infinity;
  let hitSpan: Span | null = null;
  let hitMet: DrawnCap | null = null;
  for (let k = count - 1; k >= 0; k--) {
    const span = spanAt(mirror.map, i, j, k);
    if (!isSpanDrawn(span)) continue;
    // F1: test the wall crossing BEFORE the drawnCapMet gate. A grazing ray
    // can enter the cell through its side wall inside [baseY, drawnTop] while
    // never dipping below the drawn cap along its chord; the gate is then only
    // the fast path for rays that miss both cap and wall.
    let met: DrawnCap | null = null;
    if (k === count - 1 && ray !== null) {
      met = drawnCapMet(mirror, ray, tEnter, tExit);
      if (met === null) {
        const drawnTopY = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
        // Drawn wall foot, not the blocky underside: a carved gap must read
        // as open so the ray passes to the cell beyond.
        const wallBaseY = drawnBandOfSample(span.floor) * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
        const horizontal = ray.dx !== 0 || ray.dz !== 0;
        const entersThroughWall = horizontal && entryY <= drawnTopY && entryY >= wallBaseY;
        if (!entersThroughWall) continue;
      }
    }
    const capY = met === null ? drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE : met.capY;
    const drawnY = met === null ? blockyCellCapY(span.ceiling) : met.drawnY;
    const baseY = spanUndersideHeight(span) * HEIGHT_WORLD_SCALE;
    const lowY = entryY < exitY ? entryY : exitY;
    const highY = entryY < exitY ? exitY : entryY;
    if (lowY > drawnY || highY < baseY) continue;
    // F4: snap underside cues to the drawn ceiling. The mesh draws the gap
    // floor as a ceiling polygon at the drawn cap, so reporting the drawn cap
    // matches the polygon refinement without walking any polygons.
    const drawnCeilingY = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
    // F8: an entry exactly ON the column's own drawn cap is a level face. A
    // flat cap picks as tread whatever its height.
    const onOwnCap = entryY === drawnY && drawnY === drawnCeilingY;
    const insideOnEntry = !onOwnCap && entryY <= drawnY && entryY >= baseY;
    const onOrAboveCap = !insideOnEntry && entryY >= drawnY;
    const faceY = insideOnEntry ? entryY : onOrAboveCap ? capY : drawnCeilingY;
    const metY = insideOnEntry ? entryY : onOrAboveCap ? drawnY : drawnCeilingY;
    const planeT = insideOnEntry || dy === 0 ? tEnter : tEnter + (metY - entryY) / dy;
    const t = met !== null && insideOnEntry && planeT < met.t ? met.t : planeT;
    if (t >= hitT) continue;
    hitT = t;
    hit = {
      x: i,
      y: j,
      surfaceY: capY,
      spanIndex: k,
      face: insideOnEntry ? 'riser' : onOrAboveCap ? 'tread' : 'underside',
      hitY: faceY,
      hitX: origin.x + t * direction.x,
      hitZ: origin.z + t * direction.z,
    };
    hitSpan = span;
    hitMet = met;
  }
  if (hit !== null && hitMet !== null && hit.spanIndex === count - 1) {
    // F2: never-null fallback for cap strikes from above. drawnBandAt produced
    // this hit, so when no neighbour owns the band the hit stays on the
    // entered cell's top span instead of vanishing. Horizontal grazing rays
    // keep the old miss (null) so a carved gap still reads as open passage.
    if (drawnSpanIndexCoveringBand(mirror.map, i, j, hitMet.band) !== null) {
      hitSpan = spanAt(mirror.map, i, j, hit.spanIndex);
      hit = { ...hit, surfaceY: drawnSpanCapHeight(hitSpan) * HEIGHT_WORLD_SCALE };
    } else if (direction.y < 0) {
      const found = columnOwningBand(mirror, i, j, hitMet.u, hitMet.v, hitMet.band, hit.hitY) ?? {
        x: i,
        y: j,
        spanIndex: count - 1,
      };
      hitSpan = spanAt(mirror.map, found.x, found.y, found.spanIndex);
      hit = {
        ...hit,
        x: found.x,
        y: found.y,
        spanIndex: found.spanIndex,
        surfaceY: drawnSpanCapHeight(hitSpan) * HEIGHT_WORLD_SCALE,
      };
    } else {
      return null;
    }
  }
  const refinable = hit !== null && hit.face !== 'underside';
  if (hit === null || !refinable || risers === null || hitSpan === null) return hit;
  return refineRiserToDrawnFace(
    mirror, i, j, origin, direction, tEnter, tExit, hit, hitSpan, risers,
  );
}
