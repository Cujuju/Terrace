import {
  drawnSpanCapHeight,
  drawnSpanIndexCoveringBand,
  isSpanDrawn,
  spanAt,
  spanCount,
  type Span,
} from '@terrace/shared';
import { BAND_WORLD_HEIGHT, HEIGHT_WORLD_SCALE } from '../../config.ts';
import { blockyCellCapY, drawnBandAtY, drawnBandCapY } from '../capEmission.ts';
import type { TerrainMirror } from '../mirror.ts';
import { columnOwningBand, drawnCapMet } from './bandOwner.ts';
import { refineRiserToDrawnFace } from './drawnFaceRefine.ts';
import { cellRevealed, scaleRayToCellSpace } from './rayMarch.ts';
import type { DrawnCap, DrawnRisers, TerrainRayPick, Vec3 } from './types.ts';

/**
 * Slack for "the entry sits ON the cap": the entry y is marched, the cap
 * derived. A millionth of a band clears that rounding, far below any
 * aimable depth.
 */
const ON_CAP_WORLD_SLACK = BAND_WORLD_HEIGHT / 1_000_000;

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
    // The span's drawn foot, named once: the bottom of its floor band, which is
    // where the mesher puts that band's wall base.
    const baseY = drawnBandCapY(span.floorBand - 1);
    // F1: test the wall crossing BEFORE the drawnCapMet gate. A grazing ray
    // can enter through the side wall without dipping below the drawn cap.
    let met: DrawnCap | null = null;
    if (k === count - 1 && ray !== null) {
      met = drawnCapMet(mirror, ray, tEnter, tExit);
      if (met === null) {
        const drawnTopY = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
        // Drawn wall foot, not the blocky underside: a carved gap must read
        // as open so the ray passes to the cell beyond.
        const horizontal = ray.dx !== 0 || ray.dz !== 0;
        const entersThroughWall = horizontal && entryY <= drawnTopY && entryY >= baseY;
        if (!entersThroughWall) continue;
      }
    }
    const capY = met === null ? drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE : met.capY;
    const drawnY = met === null ? blockyCellCapY(span.ceiling) : met.drawnY;
    const lowY = entryY < exitY ? entryY : exitY;
    const highY = entryY < exitY ? exitY : entryY;
    if (lowY > drawnY || highY < baseY) continue;
    // F4: snap underside cues to the drawn ceiling. The mesh draws the gap
    // floor as a ceiling polygon there, so reporting it matches the polygon
    // refinement without walking polygons.
    const drawnCeilingY = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
    // F8: an entry ON the column's own drawn cap is a level face. A flat cap
    // picks as tread whatever its height.
    const onOwnCap =
      Math.abs(entryY - drawnY) <= ON_CAP_WORLD_SLACK && drawnY === drawnCeilingY;
    const insideOnEntry = !onOwnCap && entryY <= drawnY && entryY >= baseY;
    const onOrAboveCap = !insideOnEntry && entryY >= drawnY;
    const faceY = insideOnEntry ? entryY : onOrAboveCap ? capY : drawnCeilingY;
    const metY = insideOnEntry ? entryY : onOrAboveCap ? drawnY : drawnCeilingY;
    const planeT = insideOnEntry || dy === 0 ? tEnter : tEnter + (metY - entryY) / dy;
    const t = met !== null && insideOnEntry && planeT < met.t ? met.t : planeT;
    if (t >= hitT) continue;
    // A riser strike delayed to the drawn met sits at the ray's height there,
    // so the owner search tests the layer the ray actually met.
    const strikeY = insideOnEntry ? oy + t * dy : faceY;
    hitT = t;
    const face = insideOnEntry ? 'riser' : onOrAboveCap ? 'tread' : 'underside';
    hit = {
      x: i,
      y: j,
      surfaceY: capY,
      spanIndex: k,
      face,
      // Solid below or behind: the slab holding the strike. Solid above: the span's floor.
      band: face === 'underside' ? span.floorBand : drawnBandAtY(strikeY),
      hitY: strikeY,
      hitX: origin.x + t * direction.x,
      hitZ: origin.z + t * direction.z,
    };
    hitSpan = span;
    hitMet = met;
  }
  if (hit !== null && hitMet !== null && hit.spanIndex === count - 1) {
    // F2: never-null fallback for cap strikes from above. With no neighbour
    // owning the band the hit stays on the entered cell's top span; grazers
    // miss, so carved gaps stay open.
    const covering = drawnSpanIndexCoveringBand(mirror.map, i, j, hitMet.band);
    if (covering !== null) {
      // The span covering the met band, not the column top; surfaceY is that
      // column's cap, and the hit stays on the pointer ray.
      hitSpan = spanAt(mirror.map, i, j, covering);
      hit = {
        ...hit,
        spanIndex: covering,
        surfaceY: drawnSpanCapHeight(hitSpan) * HEIGHT_WORLD_SCALE,
      };
    } else if (direction.y < 0) {
      const found = columnOwningBand(mirror, i, j, hitMet.u, hitMet.v, hitMet.band, hit.hitY) ?? {
        x: i,
        y: j,
        spanIndex: count - 1,
      };
      // Re-homed to a neighbour the ray never entered: it names the cell and
      // surface, never the band. The band stays the one at the hit point.
      hitSpan = spanAt(mirror.map, found.x, found.y, found.spanIndex);
      const ownerY = drawnSpanCapHeight(hitSpan) * HEIGHT_WORLD_SCALE;
      hit = {
        ...hit,
        x: found.x,
        y: found.y,
        spanIndex: found.spanIndex,
        surfaceY: ownerY,
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
