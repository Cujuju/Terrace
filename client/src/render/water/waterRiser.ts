/**
 * waterRiser.ts — the sheet that carries a water region's tread down the
 * terrace face onto the water one step below.
 *
 * WHY THIS EXISTS. Water is drawn as flat per-band regions marched out of the
 * terrain's own contour pipeline (water/waterTread.ts). A course crossing a
 * band boundary every few cells is therefore drawn as a row of flat plates,
 * each a whole BAND_HEIGHT under the last. In PLAN VIEW those plates already
 * touch — measured 2026-08-23, walking every course at 1/20 cell: 0 dry
 * samples out of 1280 (meander), 520 (fork), 2412 (stairpools). The
 * separation is purely VERTICAL. This module draws the vertical face.
 *
 * WHAT IT REPLACES, and why the replacement is a different shape of thing.
 * `waterApron.ts` (deleted 2026-08-23) tried to do the same job from a
 * PER-VERTEX averaged normal over maximal RUNS of "lip" vertices. Both halves
 * of that were defects:
 *
 *   * An averaged per-vertex normal is UNDEFINED where it matters most — at
 *     the snout tip of a channel and at a marching-tile seam, the two places
 *     a fall actually lives. A central difference across a tip points along
 *     the channel, not out of it, and the fix for that (excluding fake tile
 *     edges from the difference, then averaging three of the results) added
 *     two more places for the direction to be wrong. A per-SEGMENT normal is
 *     exactly defined for every real segment: the segment has a direction, and
 *     the outward normal is that direction turned ninety degrees.
 *   * Requiring a RUN of >= 2 consecutive lip vertices meant a lip that was
 *     one vertex long — which is what a snout tip is after Chaikin — emitted
 *     nothing at all. The `fork` fixture was measured emitting 1328 flat
 *     triangles and ZERO falling ones because of it.
 *
 * Both failure causes are REMOVED here rather than traded: every qualifying
 * segment emits on its own, from its own exact normal.
 *
 * ITS DEFINING PROPERTY, kept from the apron: the top edge of every sheet IS
 * two consecutive vertices of the region's own smoothed boundary loop, emitted
 * verbatim — the identical coordinates the tread triangles end on. A seam at
 * the top cannot exist by construction, only by bug.
 *
 * Pure function; no dependency on riverRig.ts or waterTread.ts. The caller
 * supplies the water oracle and guarantees determinism (this module iterates
 * loops and segments in the order it is handed them, and reads no clock and no
 * random source).
 */

import {
  RECT_EAST,
  RECT_NORTH,
  RECT_SOUTH,
  RECT_WEST,
  type ContourLoop,
  type ContourPoint,
} from '../../terrain/contours.ts';
import { CELL_WORLD_SIZE } from '../../config.ts';

/**
 * How far OUTSIDE the loop, in CELLS, the classification probe is taken from a
 * segment's midpoint.
 *
 * Half a cell. A contour crossing is clamped into the middle [1/8, 7/8] of its
 * lattice edge (CONTOUR_CELL_CENTRE_GUARD) and smoothing can only move a
 * vertex ALONG the outline, so a boundary point is always within half a cell
 * of the edge between the wet cell and its dry neighbour. Stepping half a cell
 * along the outward normal therefore lands in the NEIGHBOUR cell — the cell
 * the water is about to pour onto — and never as far as the cell past it
 * (that would need a full cell of travel from the shared edge).
 */
export const WATER_RISER_PROBE_CELLS = 0.5;

/**
 * Where ALONG a segment the classification probes are taken, as fractions of
 * its length: both ends and the middle.
 *
 * THREE, NOT ONE, and this is a correction to the plan this module was built
 * from, which specified a single probe at the midpoint. MEASURED 2026-08-23 in
 * the `fork` fixture: a water region one cell across marches to a blob whose
 * smoothed boundary vertices are about 0.45 cell apart, so a segment's MIDPOINT
 * sits diagonally between cells and the point half a cell out along its normal
 * lands in a cell CORNER-adjacent to the course rather than on it. Every one of
 * band 15's 36 segments was rejected as "no water outside" while the cell
 * directly downstream held water a band lower — 0 of 8 one-cell regions in the
 * fixture emitted a fall.
 *
 * A segment's ENDPOINTS are contour vertices, and on a blob around a single
 * wet cell the vertex facing the outflow lies on the course centre-line, so
 * its probe lands squarely in the downstream cell. Asking at both ends and the
 * middle costs three map lookups per segment and makes the classification
 * robust to where the vertices happen to fall.
 *
 * THIS IS NOT THE APRON'S 3x3 SCAN. That scan asked "is there lower water
 * anywhere AROUND this point", which has no direction in it and fired off
 * banks the water never reached. All three probes here are displaced along the
 * segment's OWN outward normal, so every one of them asks about the water this
 * segment actually faces.
 */
const WATER_RISER_PROBE_FRACTIONS: readonly number[] = [0, 0.5, 1];

/**
 * How far OUT from its top edge, in CELLS, the riser's foot stands — the
 * horizontal footprint of a fall.
 *
 * DECISION (2026-08-23, owner question 1 of the water rebuild): HALF A CELL.
 *
 * WHY IT MUST BE NON-ZERO. A strictly vertical curtain was tried and rejected
 * by measurement: a vertical surface seen from above projects to a LINE, so a
 * staircase river read as a row of disconnected treads with nothing between
 * them (17 curtains present in the `stairpools` mesh, not one of them seen).
 * The fall has to have a plan-view footprint or it is not there from the
 * camera angle the game is played at.
 *
 * WHY HALF. One band is exactly one cell tall in world units — BAND_WORLD_HEIGHT
 * and CELL_WORLD_SIZE are both a quarter of a world unit (client/src/config.ts,
 * and the coincidence is noted there). So half a cell of lean gives a one-band
 * fall a plan-view footprint of half a cell against a channel one cell wide:
 * half the channel's width, which is unmissable from directly overhead.
 *
 * WHY NOT MORE. The terrain's own terrace run is ONE cell per band
 * (`MAX_STEP = BAND_HEIGHT`, docs/DESIGN.md 2026-08-20 — "one cell of run per
 * band, the finest tread that still reads as a terrace"), so the tread the
 * water lands on is about a cell wide and the lower region's plate reaches
 * back roughly three quarters of a cell toward the lip. A foot half a cell out
 * is inside that plate with margin; a foot a full cell out would be standing
 * on the NEXT face down, hanging over ground the water never reaches.
 *
 * WHY NOT LESS. docs/DESIGN.md 2026-08-21 (issue #63) records a residual
 * disagreement of about 0.11 cell between where the smoothed WATER rim lands
 * and where the smoothed ROCK rim lands, because the two are smoothed
 * independently. Any lean under that can come out negative on the bad sign and
 * put the sheet's foot BEHIND the rock face. Half a cell is roughly four and a
 * half times the residual, so the sign can never flip.
 *
 * A MULTI-BAND drop keeps this same lean and is therefore nearly vertical.
 * That is deliberate: it also keeps the sheet INSIDE the rock all the way
 * down, where opaque terrain hides it, instead of cutting out through every
 * tread on the way — which is exactly the clipping a leaning multi-band sheet
 * produced when the apron walked the ground out to three cells. A deep fall is
 * read from its height, not from its footprint.
 */
export const WATER_RISER_LEAN_CELLS = 0.5;

/**
 * Whether the ring segment p→q is a marching-tile BORDER CLOSING EDGE rather
 * than real outline: both endpoints flagged as domain-border points
 * (`ContourPoint.rect`, set by assembleLoops exactly on the tile rectangle)
 * AND sharing the border's axis, since the closing path runs straight along
 * one side of the rectangle — including the inserted domain CORNERS, which are
 * border points on two sides at once.
 *
 * Such a segment is INTERIOR WATER: across it lies the same region's other
 * half, drawn from the neighbouring tile. A riser there would be a wall of
 * water standing in the middle of the river.
 *
 * A genuine waterline edge between two border points would have to run ALONG
 * the tile boundary, which the field rule in waterTread.ts forbids — outside a
 * tile everything is forced under the threshold, so the outline always CROSSES
 * a border, never follows it.
 *
 * (Inherited verbatim from the deleted waterApron.ts, where it was written to
 * repair an averaged normal. Here it decides membership instead, which is the
 * question it was always really answering.)
 */
function isTileBorderClosingEdge(p: ContourPoint, q: ContourPoint): boolean {
  return p.rect !== 0 && q.rect !== 0 && (p.x === q.x || p.z === q.z);
}

/** Append one triangle (positions only, world units) to `out`. */
function pushTri(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: number[],
): void {
  out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
}

/**
 * Append riser sheets for ONE water region's smoothed boundary loops to the
 * triangle soup `out` (positions only, three floats per vertex, world units).
 *
 * `surfaceBand` is the band this region's tread is drawn at, and `crestWorldY`
 * the world height it was drawn at (lift included) — the two are related by
 * the caller's own band→Y rule, which is why both are passed rather than one
 * derived from the other here.
 *
 * `waterBandAtCell(cellX, cellZ)` must return the surface band of the water
 * standing at the CELL containing that cell-space point, or null where it is
 * dry. It is asked at one point per segment and nowhere else.
 *
 * `footWorldYOf(band)` must be the caller's band→world-Y rule, so the foot of
 * a riser lands at exactly the height the lower region's tread was drawn at.
 *
 * THE CLASSIFICATION, and it is a LOOKUP rather than a search. For each
 * segment of each loop, the cell just outside the segment's midpoint either
 * holds water at a LOWER band — in which case this segment is a lip and pours
 * onto that water — or it does not, in which case nothing is emitted. There is
 * no 3×3 scan and no "highest band nearby": a per-segment normal is exact, so
 * the one cell it points at is the right one to ask about. Water pours onto
 * WATER, never onto dry ground; where there is none the region simply ends on
 * the terrain's own contour, which is the approved lake-rim behaviour
 * (docs/DESIGN.md 2026-08-21, issue #62).
 *
 * A rising bank has no water outside it, so a riser can never fire off the
 * wrong side of a channel — the direction-blindness class of bug is closed by
 * the classification, not by a tuning constant.
 *
 * WHY THE FOOT IS SHARED BETWEEN NEIGHBOURS, and the classification is not.
 * A riser's TOP edge is two loop vertices, so consecutive risers share it
 * exactly. Their FEET would not be shared if each were pushed out along its
 * own segment's normal: two consecutive segments point slightly differently,
 * so the two feet separate by (turn angle x lean). Around the SNOUT of a
 * channel the outline turns through half a circle in a handful of segments,
 * and MEASURED 2026-08-23 in the `stairpools` fixture with the terrain hidden,
 * that made every fall a COMB — narrow strips of water with daylight between
 * them, the gaps as wide as the strips.
 *
 * So a foot vertex is offset along the MEAN of the normals of the two
 * segments that meet there, whenever both of them are pouring. Consecutive
 * quads then share their foot vertices as exactly as they share their top
 * ones, and the sheet is closed. At a snout that mean is the bisector — the
 * direction the water actually spreads.
 *
 * THIS IS NOT THE APRON'S PER-VERTEX NORMAL COMING BACK. The apron averaged
 * before it CLASSIFIED, so a direction that was undefined at a tip decided
 * whether a fall existed at all, and a tip got no fall. Here classification is
 * still one exact per-segment normal per segment; the mean is used only to
 * place a foot that has already been decided on, where an undefined direction
 * can cost a slightly wrong spread and nothing else. Where a neighbouring
 * segment is not pouring (or is a tile-border closing edge) there is nothing
 * to average with, and the segment's own normal is used.
 *
 * NAMED RESIDUAL: two neighbouring segments pouring onto DIFFERENT bands keep
 * their own foot HEIGHTS, so the shared foot vertex is at two heights and a
 * vertical crack of one band's difference stands between them. It lands on the
 * lower region's plate, which is opaque water drawn over it.
 */
export function appendRiserSurfaces(
  loops: readonly ContourLoop[],
  surfaceBand: number,
  crestWorldY: number,
  footWorldYOf: (footBand: number) => number,
  waterBandAtCell: (cellX: number, cellZ: number) => number | null,
  out: number[],
): void {
  for (const loop of loops) {
    const n = loop.length;
    if (n < 3) continue;

    // PASS ONE: per-segment normal and classification, for the whole ring,
    // before a single triangle is written. The foot of segment i is offset
    // along a normal shared with segments i-1 and i+1, so every segment's
    // answer has to exist before any of them can be placed.
    const normalX = new Float64Array(n);
    const normalZ = new Float64Array(n);
    /** Foot band of segment i, or -1 where segment i is not pouring at all. */
    const footBands = new Int32Array(n).fill(-1);

    for (let i = 0; i < n; i++) {
      const p = loop[i];
      const q = loop[(i + 1) % n];
      // Interior water, not outline — see isTileBorderClosingEdge.
      if (isTileBorderClosingEdge(p, q)) continue;

      // The outward normal of THIS segment, exactly. assembleLoops emits
      // boundaries "inside on the left" (counter-clockwise in the (x,z)
      // plane — see perimeterOf's doc comment in contours.ts, which walks the
      // domain border in the same handedness), so the RIGHT of travel points
      // out of the water: N = (t.z, -t.x).
      const tx = q.x - p.x;
      const tz = q.z - p.z;
      const length = Math.hypot(tx, tz);
      // A zero-length segment has no direction to turn; smoothLoop drops
      // duplicate points, so this is a guard rather than an expected case.
      if (length === 0) continue;
      const nx = tz / length;
      const nz = -tx / length;
      normalX[i] = nx;
      normalZ[i] = nz;

      // The HIGHEST water strictly below this region, over the three probes:
      // the fall drops ONE terrace onto water that is really there, and the
      // region it lands on carries the cascade further down. Taking the lowest
      // instead was measured (2026-08-22, owner: waterfalls "literally being
      // projected into space") to loft a single sheet from a spire's summit to
      // its foot, standing in open air beside rock too narrow to hide it.
      let best = -1;
      let found = false;
      for (const fraction of WATER_RISER_PROBE_FRACTIONS) {
        const alongX = p.x + tx * fraction;
        const alongZ = p.z + tz * fraction;
        const band = waterBandAtCell(
          alongX + nx * WATER_RISER_PROBE_CELLS,
          alongZ + nz * WATER_RISER_PROBE_CELLS,
        );
        if (band === null || band >= surfaceBand) continue;
        if (!found || band > best) {
          best = band;
          found = true;
        }
      }
      if (!found) continue;
      footBands[i] = best;
    }

    // PASS TWO: emit. Vertex i is where segments i-1 and i meet, so the foot
    // direction there is the mean of their normals when both pour.
    for (let i = 0; i < n; i++) {
      const footBand = footBands[i];
      if (footBand < 0) continue;

      const p = loop[i];
      const q = loop[(i + 1) % n];
      // The foot direction at each end of this segment — the mean of the two
      // normals meeting there when both pour (see the doc comment above).
      footDirection(normalX, normalZ, footBands, (i - 1 + n) % n, i, p, footDir);
      const startX = footDir[0];
      const startZ = footDir[1];
      footDirection(normalX, normalZ, footBands, i, (i + 1) % n, q, footDir);
      const endX = footDir[0];
      const endZ = footDir[1];

      const footY = footWorldYOf(footBand);
      // The top edge is the lip VERBATIM — bit-identical to what the tread
      // builder ends on, so there is no top seam. Written literally; never
      // re-derived through the offset formula.
      const topPx = p.x * CELL_WORLD_SIZE;
      const topPz = p.z * CELL_WORLD_SIZE;
      const topQx = q.x * CELL_WORLD_SIZE;
      const topQz = q.z * CELL_WORLD_SIZE;
      const footPx = (p.x + startX * WATER_RISER_LEAN_CELLS) * CELL_WORLD_SIZE;
      const footPz = (p.z + startZ * WATER_RISER_LEAN_CELLS) * CELL_WORLD_SIZE;
      const footQx = (q.x + endX * WATER_RISER_LEAN_CELLS) * CELL_WORLD_SIZE;
      const footQz = (q.z + endZ * WATER_RISER_LEAN_CELLS) * CELL_WORLD_SIZE;

      // The quad p -> q -> q' -> p', as two triangles. This winding puts the
      // face normal OUT and UP — the front face of a sheet sloping down and
      // away from the lip. (The material is DoubleSide, but a surface whose
      // winding disagrees with its shape is a trap for the next reader.)
      pushTri(topPx, crestWorldY, topPz, topQx, crestWorldY, topQz, footQx, footY, footQz, out);
      pushTri(topPx, crestWorldY, topPz, footQx, footY, footQz, footPx, footY, footPz, out);
    }
  }
}

/**
 * Scratch for one foot direction, [x, z]. Module-scoped and reused: this runs
 * inside the rig's synchronous rebuild, once per riser end, and allocating a
 * pair there would be a few thousand short-lived objects per rebuild for no
 * reason. Nothing can interleave with the loop that uses it.
 */
const footDir = new Float64Array(2);

/**
 * Writes into `out` the UNIT direction the foot vertex at `vertex` is pushed
 * along, where segments `a` and `b` meet.
 *
 * The normalised MEAN of the two segment normals when both are pouring, so the
 * two risers meeting there put their feet in the same place and the sheet is
 * closed; segment `b`'s own normal when `a` is not pouring (there is nothing to
 * average with), and `a`'s when `b` is not. The exactly-opposed case — a mean
 * of zero length, which needs a half turn inside one smoothed segment — falls
 * back to `b`'s normal rather than inventing a direction.
 *
 * NORMALISED, not merely summed: the sum of two unit vectors is shorter than
 * either at a sharp corner, and an un-normalised foot would pull IN exactly
 * where the outline turns most — the snout tip, which is the one place every
 * fall has.
 *
 * PINNED TO THE BORDER AXIS at a marching-tile border point, which is seam
 * contract S4 extended one level down. A region spanning a tile border arrives
 * as one closed loop PER TILE, and the two halves meet at a point both of them
 * carry exactly (smoothLoop pins border vertices). Their FEET would not meet:
 * the left half's last normal and the right half's first normal are mirror
 * images about the border, so their feet separate by twice the lean's
 * perpendicular component. MEASURED 2026-08-23 in `fork`, whose course runs
 * along x = 32 — a tile border — every fall had a SLIT down its centre-line,
 * one probe column wide, showing the water a band below. Dropping the
 * component perpendicular to the border makes both halves choose the same
 * direction, so both put the foot in the same place; the sheet is vertical
 * exactly at the border and leans its full half-cell within a segment either
 * side. A domain CORNER has no single axis left, and an outline that ran
 * exactly along a border would project to nothing — both fall back to the raw
 * mean rather than to a zero-length direction.
 */
function footDirection(
  normalX: Float64Array,
  normalZ: Float64Array,
  footBands: Int32Array,
  a: number,
  b: number,
  vertex: ContourPoint,
  out: Float64Array,
): void {
  let dirX: number;
  let dirZ: number;
  if (footBands[a] < 0) {
    dirX = normalX[b];
    dirZ = normalZ[b];
  } else if (footBands[b] < 0) {
    dirX = normalX[a];
    dirZ = normalZ[a];
  } else {
    const sumX = normalX[a] + normalX[b];
    const sumZ = normalZ[a] + normalZ[b];
    const length = Math.hypot(sumX, sumZ);
    if (length === 0) {
      dirX = normalX[b];
      dirZ = normalZ[b];
    } else {
      dirX = sumX / length;
      dirZ = sumZ / length;
    }
  }

  const onVertical = (vertex.rect & (RECT_WEST | RECT_EAST)) !== 0;
  const onHorizontal = (vertex.rect & (RECT_NORTH | RECT_SOUTH)) !== 0;
  // Exactly one of the two: a corner keeps neither axis and is left alone.
  if (onVertical !== onHorizontal) {
    // A vertical border (constant x) runs along z, and vice versa.
    const pinnedX = onVertical ? 0 : dirX;
    const pinnedZ = onVertical ? dirZ : 0;
    const length = Math.hypot(pinnedX, pinnedZ);
    if (length > 0) {
      out[0] = pinnedX / length;
      out[1] = pinnedZ / length;
      return;
    }
  }

  out[0] = dirX;
  out[1] = dirZ;
}
