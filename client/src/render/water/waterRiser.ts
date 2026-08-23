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
  CONTOUR_CELL_CENTRE_GUARD,
  type ContourLoop,
  type ContourPoint,
} from '../../terrain/contours.ts';
import { CELL_WORLD_SIZE } from '../../config.ts';

/**
 * How far OUTSIDE the loop, in CELLS, the qualifying probe is taken from a
 * segment's midpoint.
 *
 * AN EIGHTH OF A CELL — deliberately tiny, because the question is
 * "what is on the other side of this segment", and the other side begins
 * immediately. It is `CONTOUR_CELL_CENTRE_GUARD`, the smallest displacement the
 * contour pipeline itself treats as significant (every crossing is clamped and
 * every smoothed vertex pushed by exactly this much), so a probe cannot land
 * back on the boundary it stepped off through floating-point noise, and cannot
 * skip over anything either.
 *
 * IT USED TO BE HALF A CELL, and that was the narrowness defect. With a
 * CELL-MEMBERSHIP test the probe had to travel far enough to leave the source
 * cell, and half a cell along a normal that has swung even 40 degrees off
 * downstream lands in a diagonal neighbour the course never ran through.
 * MEASURED 2026-08-23 in `fork`: a fall's qualifying arc spanned x = 31.76 to
 * 32.24 — 0.48 cell against a channel a full cell wide, so the drawn sheet was
 * half the width of the river it carried. Containment needs no such travel: the
 * margin comes from the lower PLATE, which reaches about 1.13 cells back
 * upstream past the lip it pours from and not at all sideways past a bank.
 */
const WATER_RISER_PROBE_CELLS = CONTOUR_CELL_CENTRE_GUARD;

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
 * One lower band's drawn tread, as the smoothed loops it was marched from,
 * with a bounding box per loop so a containment query rejects almost all of
 * them without touching their points.
 *
 * THE QUALIFYING QUESTION IS "DOES A LOWER PLATE COVER THE POINT JUST OUTSIDE
 * THIS SEGMENT", and it is asked of the plate itself rather than of the set of
 * wet CELLS. The difference is the margin. A lower region's plate reaches about
 * 1.13 cells back upstream past the lip it is poured over — the tread builder's
 * field rule runs the water under the rising bank on that side (waterTread.ts)
 * — and reaches nothing at all sideways past a bank, because there the water
 * simply ends on the terrain's own contour. So containment answers "is this a
 * genuine downstream lip" with a cell of slack in the direction that should
 * qualify and none in the direction that should not, which is exactly the
 * discrimination a fixed-distance cell lookup could not make.
 */
export interface WaterPlate {
  /** The band this plate's tread was drawn at. */
  readonly band: number;
  /** Its smoothed boundary loops, in emission order. */
  readonly loops: readonly ContourLoop[];
  /** [minX, minZ, maxX, maxZ] per loop, in the same order. */
  readonly bounds: Float64Array;
}

/** Index one band's loops for containment queries. Pure; allocation only. */
export function waterPlateOf(band: number, loops: readonly ContourLoop[]): WaterPlate {
  const bounds = new Float64Array(loops.length * 4);
  for (let i = 0; i < loops.length; i++) {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of loops[i]) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    bounds[i * 4] = minX;
    bounds[i * 4 + 1] = minZ;
    bounds[i * 4 + 2] = maxX;
    bounds[i * 4 + 3] = maxZ;
  }
  return { band, loops, bounds };
}

/**
 * Whether `plate` covers the cell-space point, by the EVEN-ODD rule over every
 * one of its loops at once.
 *
 * Even-odd is not a shortcut here, it is the correct rule for this data. A
 * region can arrive as several disjoint lozenges, as two half-loops split by a
 * marching-tile border, and as an outer ring with island HOLES inside it — and
 * even-odd handles all three without being told which is which: a point inside
 * one lozenge crosses one boundary, a point inside an island crosses two.
 *
 * The ray is cast in +x, and a vertex exactly on it is counted once by the
 * half-open `(z0 <= z) !== (z1 <= z)` test rather than twice.
 */
function plateCovers(plate: WaterPlate, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0; i < plate.loops.length; i++) {
    const base = i * 4;
    if (
      x < plate.bounds[base] ||
      x > plate.bounds[base + 2] ||
      z < plate.bounds[base + 1] ||
      z > plate.bounds[base + 3]
    ) {
      continue;
    }
    const loop = plate.loops[i];
    for (let a = 0, b = loop.length - 1; a < loop.length; b = a++) {
      const pa = loop[a];
      const pb = loop[b];
      if (pa.z <= z === pb.z <= z) continue;
      const cross = pa.x + ((z - pa.z) / (pb.z - pa.z)) * (pb.x - pa.x);
      if (x < cross) inside = !inside;
    }
  }
  return inside;
}

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
  crestWorldY: number,
  footWorldYOf: (footBand: number) => number,
  lowerPlates: readonly WaterPlate[],
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
    /**
     * Foot band of segment i, meaningful only where `pouring[i]` is 1. A
     * separate flag rather than a sentinel band, because a band index can be
     * NEGATIVE (water below sea level) and any in-band sentinel would one day
     * be a real answer.
     */
    const footBands = new Int32Array(n);
    const pouring = new Uint8Array(n);

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

      // THE QUALIFYING TEST, once, at the point just outside the segment's
      // midpoint. `lowerPlates` is ordered HIGHEST BAND FIRST, so the first
      // plate that covers the point is the water this segment pours onto: the
      // fall drops ONE terrace onto water that is really there, and the region
      // it lands on carries the cascade further down. Taking the lowest instead
      // was measured (2026-08-22, owner: waterfalls "literally being projected
      // into space") to loft a sheet from a spire's summit to its foot,
      // standing in open air beside rock too narrow to hide it.
      const probeX = (p.x + q.x) / 2 + nx * WATER_RISER_PROBE_CELLS;
      const probeZ = (p.z + q.z) / 2 + nz * WATER_RISER_PROBE_CELLS;
      for (const plate of lowerPlates) {
        if (!plateCovers(plate, probeX, probeZ)) continue;
        footBands[i] = plate.band;
        pouring[i] = 1;
        break;
      }
    }

    // PASS TWO: emit. Vertex i is where segments i-1 and i meet, so the foot
    // direction there is the mean of their normals when both pour.
    for (let i = 0; i < n; i++) {
      if (pouring[i] === 0) continue;
      const footBand = footBands[i];

      const p = loop[i];
      const q = loop[(i + 1) % n];
      // The foot direction at each end of this segment — the mean of the two
      // normals meeting there when both pour (see the doc comment above).
      footDirection(normalX, normalZ, pouring, loop, (i - 1 + n) % n, i, i, footDir);
      const startX = footDir[0];
      const startZ = footDir[1];
      footDirection(normalX, normalZ, pouring, loop, i, (i + 1) % n, (i + 1) % n, footDir);
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
  pouring: Uint8Array,
  loop: ContourLoop,
  a: number,
  b: number,
  vertexIndex: number,
  out: Float64Array,
): void {
  let dirX: number;
  let dirZ: number;
  if (pouring[a] === 0) {
    dirX = normalX[b];
    dirZ = normalZ[b];
  } else if (pouring[b] === 0) {
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

  const axis = borderAxisAt(loop, vertexIndex);
  if (axis !== null) {
    // Keep only the component running ALONG the border.
    const along = dirX * axis[0] + dirZ * axis[1];
    if (along !== 0) {
      out[0] = axis[0] * Math.sign(along);
      out[1] = axis[1] * Math.sign(along);
      return;
    }
  }

  out[0] = dirX;
  out[1] = dirZ;
}

/** Scratch for one border axis, [x, z]. Reused; see footDir. */
const borderAxis = new Float64Array(2);

/**
 * The UNIT direction of the marching-tile border a loop vertex sits on, or
 * null where it sits on none.
 *
 * READ OFF THE LOOP, not off `ContourPoint.rect`'s individual bits. `rect` is
 * exported from terrain/contours.ts only as `RECT_NONE`; the four side bits are
 * private there and this module has no business widening a file the terrain and
 * the brush preview share to learn which side a point is on. It does not need
 * to: a vertex on the border is, by construction, an endpoint of the straight
 * CLOSING EDGE that assembleLoops walks along that border, so the closing
 * edge's own direction IS the border's axis. If both of a vertex's edges are
 * closing edges it is a domain CORNER, which has no single axis, and null is
 * the honest answer.
 */
function borderAxisAt(loop: ContourLoop, index: number): Float64Array | null {
  const n = loop.length;
  const here = loop[index];
  if (here.rect === 0) return null;
  const prev = loop[(index - 1 + n) % n];
  const next = loop[(index + 1) % n];
  const prevIsBorder = isTileBorderClosingEdge(prev, here);
  const nextIsBorder = isTileBorderClosingEdge(here, next);
  if (prevIsBorder === nextIsBorder) return null; // neither, or a corner
  const other = prevIsBorder ? prev : next;
  const dx = other.x - here.x;
  const dz = other.z - here.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return null;
  borderAxis[0] = dx / length;
  borderAxis[1] = dz / length;
  return borderAxis;
}
