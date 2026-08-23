/**
 * waterApron.ts — the sloped sheet that pours a water region's tread over its
 * downstream lip onto the water below.
 *
 * WHY THIS EXISTS. Water here is drawn as flat per-band regions marched out of
 * the terrain's own contour pipeline. Where a region's boundary steps down onto
 * a lower band, the vertical face between them is bare — a strictly vertical
 * curtain was tried and rejected by measurement (a vertical surface seen from
 * above projects to a line, so a staircase river read as disconnected treads).
 * The apron gives the drop a HORIZONTAL FOOTPRINT so it is visible from above.
 *
 * ITS DEFINING PROPERTY: row 0 of every sheet IS the region's own boundary
 * vertices — the identical coordinates the tread triangles end on — so a top
 * seam cannot exist by construction, only by bug. Row 0 is emitted verbatim,
 * never re-derived through the offset formula.
 *
 * Pure function; no dependency on riverRig.ts or waterTread.ts. The caller
 * supplies the terrain oracle (`probeLipFootBand`) and guarantees determinism.
 */

import type { ContourLoop, ContourPoint } from '../../terrain/contours';
import { CELL_WORLD_SIZE } from '../../config';

/**
 * How far past the lip, in CELLS, the sheet stays up at the source band's
 * water level before descending — the crest of the fall.
 *
 * MEASURED basis, inherited from riverRig.ts's FALL_CREST_CELLS: the terrain's
 * lower tread reaches full width only ~0.65 cell past a band crossing, because
 * the band outline lags at the banks of a channel. The sheet stays at the upper
 * band until there is ground to land on, plus margin for Chaikin disagreement
 * between the water loop and the terrain loop.
 */
export const WATER_APRON_CREST_CELLS = 0.75;

/**
 * The descent run, in CELLS: short enough to read as a drop, not a ramp.
 * Inherited from FALL_CHUTE_CELLS — see that constant's comment for why a
 * chute beat a wall.
 */
export const WATER_APRON_CHUTE_CELLS = 0.25;

/**
 * The steepest a falling sheet of water may be drawn, as world units DOWN per
 * world unit OUT.
 *
 * WHY A SLOPE AND NOT A RUN (2026-08-22, owner: "when going from one band to
 * the next, there needs to be no edges"). WATER_APRON_CHUTE_CELLS fixes the
 * horizontal RUN of the descent, which was inherited from the ribbon code
 * where a fall was one band and only ever one band. It is the wrong invariant:
 * a fixed run means the taller the fall the steeper the sheet, so on a
 * staircase that drops three bands at a time the chute has a quarter of a cell
 * (a sixteenth of a world unit) to lose three quarters of a world unit — a
 * twelve-to-one slope, which is a wall. Drawn from above a wall projects to a
 * line, which is precisely the invisible-curtain failure the apron exists to
 * replace, reintroduced through a constant nobody re-derived.
 *
 * THREE DOWN PER ONE OUT. Steep enough that the water plainly DROPS rather
 * than ramping down a slope the terrain does not have — a terrace riser here
 * is vertical, and a fall that reads as a hillside would be a different lie.
 * Shallow enough that the sheet keeps a real horizontal footprint, so it is
 * visible from overhead. The run it implies is never shorter than
 * WATER_APRON_CHUTE_CELLS: a single-band step keeps exactly the descent it has
 * now, and only taller falls stretch.
 */
export const WATER_APRON_MAX_FALL_SLOPE = 3;

/**
 * The longest horizontal run a chute may take, in CELLS, however far the water
 * has to fall.
 *
 * The slope rule above is the right invariant only while the drop is a terrace
 * step or two. Left unbounded it is the opposite failure: a stamped spire
 * drops dozens of bands, and holding three-to-one down that would throw a
 * skirt of water a dozen cells across the terrace below — water spread over
 * ground the river never touches, which is the one thing the channel width is
 * careful never to claim.
 *
 * ONE CELL, because the footprint is what the slope rule was really buying.
 * A fall is legible from above once its sheet covers about the width of the
 * channel pouring over it, and beyond that a taller cliff SHOULD read as
 * steeper — real water down a tall face falls nearly straight. So the slope
 * governs while the drop is small, and this governs once it is not.
 */
export const WATER_APRON_MAX_CHUTE_CELLS = 1;

/**
 * Rows across the sheet (the sheet has ROWS + 1 rows including both edges).
 * Fewest rows at which the smoothstep silhouette reads curved rather than
 * creased at orbit distance; 8 doubles the triangles for no visible gain.
 */
export const WATER_APRON_ROWS = 4;

/**
 * How far OUTSIDE the loop, in CELLS, to probe for lower water. Crossings are
 * clamped to the middle of their lattice edge, so half a cell always lands in
 * the neighbour — any less could still be inside the source cell from some
 * crossing angles.
 */
export const WATER_LIP_PROBE_CELLS = 0.5;

/**
 * Fewest consecutive lip vertices that count as a fall. A single lip vertex is
 * a classification artefact, not a fall; two consecutive make a segment with a
 * direction.
 */
export const MIN_LIP_RUN_VERTICES = 2;

/**
 * The chute's horizontal run, in CELLS, for a sheet that has to lose
 * `dropWorldY` world units of height.
 *
 * The run WATER_APRON_MAX_FALL_SLOPE asks for, clamped at both ends: never
 * shorter than WATER_APRON_CHUTE_CELLS, so a one-band step descends exactly as
 * it always did; never longer than WATER_APRON_MAX_CHUTE_CELLS, so a tall
 * cliff stays a fall rather than becoming a skirt.
 */
function chuteRunCells(dropWorldY: number): number {
  const slopeRunCells = Math.abs(dropWorldY) / WATER_APRON_MAX_FALL_SLOPE / CELL_WORLD_SIZE;
  return Math.min(
    WATER_APRON_MAX_CHUTE_CELLS,
    Math.max(WATER_APRON_CHUTE_CELLS, slopeRunCells),
  );
}

/** Outward XZ offset of row r from its lip vertex, in cells. */
function rowOffsetCells(r: number, chuteCells: number): number {
  return (r / WATER_APRON_ROWS) * (WATER_APRON_CREST_CELLS + chuteCells);
}

/** Height of row r given crest height, foot height and this row's offset. */
function rowWorldY(r: number, crestY: number, footY: number, chuteCells: number): number {
  const o = rowOffsetCells(r, chuteCells);
  // On the crest the sheet holds the source band's level exactly.
  if (o <= WATER_APRON_CREST_CELLS) return crestY;
  // Through the chute, descend on a smoothstep (3s²−2s³), which is C1 at BOTH
  // ends — no silhouette crease where the chute leaves the crest or lands on
  // the foot. s=0 exactly at the crest's end, s=1 at the foot.
  const s = (o - WATER_APRON_CREST_CELLS) / (chuteCells || Number.EPSILON);
  const t = s * s * (3 - 2 * s);
  return crestY + (footY - crestY) * t;
}

/**
 * Build one lofted sheet for a maximal lip run `P_start..P_end` (inclusive,
 * indices into `loop`), appending two triangles per quad into `out`.
 *
 * The foot band is the MINIMUM of the run's probed bands: a multi-band cliff
 * gets ONE sheet straight down to the lowest water rather than stacked pieces.
 * Where the sheet passes inside terrain it is simply hidden — the ground is
 * opaque, depth-tested, and drawn first (the established idiom here).
 */
function emitSheet(
  loop: ContourLoop,
  start: number,
  end: number,
  normalsX: Float64Array,
  normalsZ: Float64Array,
  crestWorldY: number,
  footBand: number,
  footWorldYOf: (band: number) => number,
  out: number[],
): void {
  const footY = footWorldYOf(footBand);
  // The descent is sized by the drop it has to make, so a three-band fall gets
  // three times the run of a one-band fall and both are drawn at the same
  // slope (see WATER_APRON_MAX_FALL_SLOPE).
  const chuteCells = chuteRunCells(crestWorldY - footY);

  // Rows are stored per lip vertex; row 0 is the loop vertex VERBATIM —
  // bit-identical to what the tread builder ends on, so no top seam.
  const rowCount = WATER_APRON_ROWS + 1;
  const verts = end - start + 1;
  const xs = new Float64Array(verts * rowCount);
  const ys = new Float64Array(verts * rowCount);
  const zs = new Float64Array(verts * rowCount);

  for (let v = 0; v < verts; v++) {
    const p = loop[start + v];
    const nx = normalsX[start + v];
    const nz = normalsZ[start + v];
    for (let r = 0; r < rowCount; r++) {
      const idx = v * rowCount + r;
      if (r === 0) {
        // The seam contract: compute it literally, do not trust the formula.
        xs[idx] = p.x * CELL_WORLD_SIZE;
        ys[idx] = crestWorldY;
        zs[idx] = p.z * CELL_WORLD_SIZE;
      } else {
        const o = rowOffsetCells(r, chuteCells);
        xs[idx] = (p.x + nx * o) * CELL_WORLD_SIZE;
        ys[idx] = rowWorldY(r, crestWorldY, footY, chuteCells);
        zs[idx] = (p.z + nz * o) * CELL_WORLD_SIZE;
      }
    }
  }

  // Stitch consecutive lip vertices into quads, two triangles each,
  // counter-clockwise seen from above (matching the tread winding; the
  // material is DoubleSide but be correct anyway). With the outward normal
  // N and increasing row r moving outward, the quad corners in order
  // (v,r),(v,r+1),(v+1,r+1),(v+1,r) run around the quad consistently.
  for (let v = 0; v < verts - 1; v++) {
    for (let r = 0; r < WATER_APRON_ROWS; r++) {
      // Quad corners (this vertex / next vertex) × (row r / row r+1). Winding:
      // going along the run while stepping outward keeps the sheet
      // counter-clockwise seen from above.
      const a = (v + 1) * rowCount + r; // next lip vertex, this row
      const b = (v + 1) * rowCount + r + 1; // next lip vertex, next row
      const c = v * rowCount + r + 1; // this lip vertex, next row
      const d = v * rowCount + r; // this lip vertex, this row
      pushTri(xs, ys, zs, d, c, b, out);
      pushTri(xs, ys, zs, d, b, a, out);
    }
  }
}

/**
 * Whether the ring segment p→q is a marching-tile BORDER CLOSING EDGE rather
 * than real outline: both endpoints flagged as domain-border points
 * (`ContourPoint.rect`, set by assembleLoops exactly on the tile rectangle)
 * AND sharing the border's axis, since the closing path runs straight along
 * one side of the rectangle. A genuine waterline edge between two border
 * points would have to run ALONG the tile boundary, which the field rule in
 * waterTread.ts forbids — outside a tile everything is forced under the
 * threshold, so the outline always CROSSES a border, never follows it.
 */
function isTileBorderClosingEdge(p: ContourPoint, q: ContourPoint): boolean {
  return p.rect !== 0 && q.rect !== 0 && (p.x === q.x || p.z === q.z);
}

/** Append one triangle (positions only, world units) to `out`. */
function pushTri(
  xs: Float64Array,
  ys: Float64Array,
  zs: Float64Array,
  i: number,
  j: number,
  k: number,
  out: number[],
): void {
  out.push(xs[i], ys[i], zs[i], xs[j], ys[j], zs[j], xs[k], ys[k], zs[k]);
}

/**
 * Append apron sheets for ONE water region's smoothed boundary loops to the
 * triangle soup `out` (positions only, three floats per vertex, world units).
 *
 * `probeLipFootBand(cellX, cellZ)` must return the surface band of the water
 * just OUTSIDE the loop at that cell point if it holds water at a LOWER band,
 * else null. Determinism is the caller's guarantee.
 */
export function appendApronSurfaces(
  loops: readonly ContourLoop[],
  crestWorldY: number,
  footWorldYOf: (footBand: number) => number,
  probeLipFootBand: (cellX: number, cellZ: number) => number | null,
  out: number[],
): void {
  for (const loop of loops) {
    if (loop.length < 3) continue;

    const n = loop.length;

    // --- 1. Outward normal per vertex -------------------------------------
    //
    // assembleLoops emits boundaries "inside on the left" (counter-clockwise
    // in the (x,z) plane — verified against the marching-squares case table
    // and the skirt code that assumes the same handedness), so the RIGHT of
    // travel points outward. Central-difference tangent over the closed ring:
    //   t = normalize(P[i+1] − P[i−1]);  N = (t.z, −t.x)
    // A flipped normal would aim every apron into the hillside and the whole
    // feature would silently disappear, which is why the orientation is
    // asserted here rather than trusted.
    const nx = new Float64Array(n);
    const nz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // Central difference over the closed ring — EXCEPT across fake edges.
      // A region spanning a marching-tile border arrives as one closed loop
      // PER TILE, each closed by a straight segment running ALONG the border
      // (assembleLoops clips every outline to its tile rectangle). That
      // closing segment is INTERIOR WATER, not boundary: across it lies the
      // same region's other half. MEASURED CONSEQUENCE of trusting it
      // (stairpools, fall at cell (32,7)): the smoothed snout tip of the
      // upper pool sits ON the border, its ring neighbours are the real
      // outline on one side and the fake closing edge on the other, the
      // tangent comes out pointing back INTO the water, and the lip probe
      // therefore lands in the region's own last wet cell — the tip fails
      // the lip test on BOTH half-loops at once, and the apron stops short
      // on either side of it, leaving a V-shaped slit of visible lower
      // water exactly at the fall. A segment joining two consecutive points
      // that BOTH sit on their tile border and SHARE that border's axis is
      // such a closing segment; it is excluded from the tangent, which then
      // rides on the real outline alone.
      const p = loop[i];
      const prev = loop[(i - 1 + n) % n];
      const next = loop[(i + 1) % n];
      const prevFake = isTileBorderClosingEdge(p, prev);
      const nextFake = isTileBorderClosingEdge(p, next);
      // Both neighbours fake cannot happen for a real contour (an outline
      // point has at least one real edge); if it ever did, keep the raw
      // central difference rather than inventing a direction.
      let tx: number;
      let tz: number;
      if (prevFake && !nextFake) {
        tx = next.x - p.x;
        tz = next.z - p.z;
      } else if (nextFake && !prevFake) {
        tx = p.x - prev.x;
        tz = p.z - prev.z;
      } else {
        tx = next.x - prev.x;
        tz = next.z - prev.z;
      }
      const len = Math.hypot(tx, tz);
      if (len === 0) {
        tx = 1;
        tz = 0;
      } else {
        tx /= len;
        tz /= len;
      }
      nx[i] = tz;
      nz[i] = -tx;
    }
    // Average each normal with its two neighbours' to bound folding at
    // concave corners, then re-normalize. Ring wraps.
    const ax = new Float64Array(n);
    const az = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const px = nx[(i - 1 + n) % n] + nx[i] + nx[(i + 1) % n];
      const pz = nz[(i - 1 + n) % n] + nz[i] + nz[(i + 1) % n];
      const len = Math.hypot(px, pz);
      ax[i] = len > 0 ? px / len : nx[i];
      az[i] = len > 0 ? pz / len : nz[i];
    }

    // --- 2. Classify lip vertices -----------------------------------------
    //
    // Vertex i is a lip vertex iff there is LOWER water just outside it. Take
    // maximal runs of >= MIN_LIP_RUN_VERTICES consecutive lip vertices,
    // wrapping around the ring; isolated ones are noise.
    const isLip: boolean[] = new Array(n).fill(false);
    const bands: (number | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const p = loop[i];
      const band = probeLipFootBand(p.x + ax[i] * WATER_LIP_PROBE_CELLS,
                                    p.z + az[i] * WATER_LIP_PROBE_CELLS);
      if (band !== null) {
        isLip[i] = true;
        bands[i] = band;
      }
    }

    // Maximal runs, handling wrap-around: rotate the start to a non-lip index
    // if one exists so runs don't straddle the ring seam.
    let startIdx = 0;
    while (startIdx < n && isLip[startIdx]) startIdx++;
    if (startIdx === n) {
      // Entire loop is a lip — treat as one run covering everything.
      emitRun(loop, 0, n - 1, ax, az, bands, crestWorldY, footWorldYOf, out);
      continue;
    }
    let i = startIdx;
    while (i < n) {
      if (!isLip[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && isLip[j + 1]) j++;
      if (j - i + 1 >= MIN_LIP_RUN_VERTICES) {
        emitRun(loop, i, j, ax, az, bands, crestWorldY, footWorldYOf, out);
      }
      i = j + 1;
    }
  }
}

/** Validate a detected run and emit its sheet (or skip short/noise runs). */
function emitRun(
  loop: ContourLoop,
  start: number,
  end: number,
  ax: Float64Array,
  az: Float64Array,
  bands: readonly (number | null)[],
  crestWorldY: number,
  footWorldYOf: (band: number) => number,
  out: number[],
): void {
  // Foot band = MINIMUM probed band along the run: one sheet to the lowest
  // water, not stacked pieces.
  let minBand = Infinity;
  for (let i = start; i <= end; i++) {
    const b = bands[i];
    if (b !== null && b < minBand) minBand = b;
  }
  if (!Number.isFinite(minBand)) return;
  emitSheet(loop, start, end, ax, az, crestWorldY, minBand, footWorldYOf, out);
}
