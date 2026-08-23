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
export const WATER_APRON_CREST_CELLS = 0.25;





/**
 * How far the falling sheet stands OUT from the terrace face it runs down, in
 * world units — the horizontal twin of the vertical lift water already carries
 * over the ground. Without it the sheet and the riser are coplanar and fight
 * for the depth buffer; much more and the water visibly peels off the rock.
 */
export const WATER_FACE_CLEARANCE_WORLD_UNITS = 1 / 64;

/**
 * How far outward, in CELLS, the fall steps between samples of the ground it
 * is running down. A quarter of a cell: fine enough to meet every tread the
 * terrain draws, coarse enough that a long cascade stays a few dozen rows.
 */
export const WATER_FALL_GROUND_STEP_CELLS = 0.25;

/**
 * How far outward, in CELLS, a fall may follow the ground before it stops.
 * Three cells: past that the water is running along a slope rather than down
 * a face, and the trace will have given it wet cells of its own to be drawn
 * as regions.
 */
export const WATER_FALL_MAX_REACH_CELLS = 3;



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
 * Build one lofted sheet for a maximal lip run `P_start..P_end` (inclusive,
 * indices into `loop`), appending two triangles per quad into `out`.
 *
 * The foot band is the HIGHEST water the run can see below it, so the sheet
 * drops ONE terrace step and stops.
 *
 * IT USED TO TAKE THE LOWEST (2026-08-22, owner: waterfalls "shooting out of
 * the top" of a spire, "literally being projected into space"). The argument
 * for one sheet straight down to the lowest water was that a multi-band cliff
 * is drawn as several stacked skirts and a single sheet covers them all, with
 * whatever passes inside the rock hidden by opaque terrain. That argument has
 * a premise: that there IS rock in the way. On a tall thin spire there is not.
 * The summit's lip probe finds water at the spire's foot, dozens of bands
 * below, and one sheet is lofted from the summit all the way down — a wall of
 * water standing beside a spire too narrow to hide any of it, hanging in open
 * air, which is exactly what the owner photographed.
 *
 * Taking the highest instead makes a fall what the terrain already is: a
 * STAIRCASE. Each region pours onto the water one step below it, that region
 * pours onto the next, and the cascade follows the surface down however far it
 * goes — because every step of it is anchored to water that is really there,
 * rather than to the far-away bottom of a drop the sheet would have to cross
 * unsupported. Where the ground between two steps really is solid, the sheet
 * still passes inside it and is still hidden; nothing about that case changes.
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
  groundWorldYAt: (cellX: number, cellZ: number) => number,
  out: number[],
): void {
  const footY = footWorldYOf(footBand);

  // THE FALL IS A STAIRCASE, BECAUSE THE GROUND IS (2026-08-22, owner: "the
  // water is still drawing as if it's clipping in some places").
  //
  // Drawing the fall on the riser under its lip is right for a drop of ONE
  // terrace. Over several it is not: the sheet was one flat plane from the
  // crest straight down to the foot, while the terraces between them each step
  // further out than the one above. The plane therefore cut through every
  // tread on the way down, which is the clipping in the owner's shot.
  //
  // So the sheet walks OUT from the lip in WATER_FALL_GROUND_STEP_CELLS steps,
  // reading the drawn ground under each one, and turns that walk into an
  // actual staircase: where the ground holds its level the water runs flat
  // across the tread, and where it drops the water drops with it, VERTICALLY,
  // at the same place. Two rows are written per step — one at the level the
  // water arrived with, one at the level the ground has fallen to — so a riser
  // is a strip standing on the face and a tread is a strip lying on it, and
  // there is nothing in between for the terrain to cut through.
  const stepCount = Math.round(WATER_FALL_MAX_REACH_CELLS / WATER_FALL_GROUND_STEP_CELLS);
  // Two rows per step, plus the lip itself.
  const rowCount = stepCount * 2 + 1;
  const verts = end - start + 1;
  const xs = new Float64Array(verts * rowCount);
  const ys = new Float64Array(verts * rowCount);
  const zs = new Float64Array(verts * rowCount);

  const clearanceCells = WATER_FACE_CLEARANCE_WORLD_UNITS / CELL_WORLD_SIZE;

  const ringLength = loop.length;
  for (let v = 0; v < verts; v++) {
    // Ring positions modulo the loop length, for runs that wrapped the seam.
    const ring = (start + v) % ringLength;
    const p = loop[ring];
    const nx = normalsX[ring];
    const nz = normalsZ[ring];

    // Row 0 is the lip VERBATIM — bit-identical to what the tread builder
    // ends on, so no top seam. Compute it literally; do not trust a formula.
    xs[v * rowCount] = p.x * CELL_WORLD_SIZE;
    ys[v * rowCount] = crestWorldY;
    zs[v * rowCount] = p.z * CELL_WORLD_SIZE;

    let carriedY = crestWorldY;
    for (let step = 1; step <= stepCount; step++) {
      // The crest hold: the water carries a little of its speed past the edge
      // before it starts to look for ground (see WATER_APRON_CREST_CELLS).
      const out0 = step * WATER_FALL_GROUND_STEP_CELLS;
      const outCells = Math.max(out0, WATER_APRON_CREST_CELLS) + clearanceCells;
      const cellXCoord = p.x + nx * outCells;
      const cellZCoord = p.z + nz * outCells;
      // Never above the water it left, never below the water it lands on, and
      // never climbing again: ground that rises past the lip is a bank the
      // sheet runs under, not a hill for it to walk up.
      const ground = groundWorldYAt(cellXCoord, cellZCoord);
      const level = Math.min(carriedY, Math.max(footY, Math.min(crestWorldY, ground)));

      const arriving = v * rowCount + step * 2 - 1;
      const landed = arriving + 1;
      // The tread: out to here at the level the water arrived with.
      xs[arriving] = cellXCoord * CELL_WORLD_SIZE;
      ys[arriving] = carriedY;
      zs[arriving] = cellZCoord * CELL_WORLD_SIZE;
      // The riser: same place, dropped to what the ground does here.
      xs[landed] = cellXCoord * CELL_WORLD_SIZE;
      ys[landed] = level;
      zs[landed] = cellZCoord * CELL_WORLD_SIZE;
      carriedY = level;
    }
  }

  // Stitch consecutive lip vertices into quads, two triangles each,
  // counter-clockwise seen from above (matching the tread winding; the
  // material is DoubleSide but be correct anyway).
  for (let v = 0; v < verts - 1; v++) {
    for (let r = 0; r < rowCount - 1; r++) {
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
  groundWorldYAt: (cellX: number, cellZ: number) => number,
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
      // ASKED AT THE POINT ITSELF, not half a cell along the outward normal.
      // Probing in a DIRECTION makes every fall depend on that direction being
      // right, and a smoothed outline has plenty of places — tight corners,
      // tile seams, the tip of a channel's snout — where an averaged normal
      // points somewhere the water below is not. The caller answers "is there
      // lower water AROUND here", which has no direction in it to get wrong.
      const band = probeLipFootBand(p.x, p.z);
      if (band !== null) {
        isLip[i] = true;
        bands[i] = band;
      }
    }

    // Maximal runs. The scan starts after the first non-lip index so a run is
    // never split by the array seam — but a run that REACHES the seam (ends at
    // n−1 while index 0 is a lip too) CONTINUES across it, so its end is
    // extended by `startIdx` indices, and emitRun/emitSheet index the ring
    // modulo n. A run lying wholly in the head, with index n−1 dry, is emitted
    // on its own.
    //
    // MEASURED (2026-08-22): this scan's comment used to claim wrap-around and
    // never wrapped, so a run at the HEAD of the ring was silently dropped. On
    // a loop whose whole south edge is the lip, that is every fall it has —
    // zero triangles emitted — and in the world it is the snout tip of a
    // channel, which is precisely where a fall lives. It is why the `fork`
    // fixture was measured drawing 1328 flat triangles and not one falling.
    let startIdx = 0;
    while (startIdx < n && isLip[startIdx]) startIdx++;
    if (startIdx === n) {
      // Entire loop is a lip — treat as one run covering everything.
      emitRun(loop, 0, n - 1, ax, az, bands, crestWorldY, footWorldYOf, groundWorldYAt, out);
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
      // A run ending on the last index continues into the wrapped head.
      const runEnd = j === n - 1 && isLip[0] ? j + startIdx : j;
      if (runEnd - i + 1 >= MIN_LIP_RUN_VERTICES) {
        emitRun(loop, i, runEnd, ax, az, bands, crestWorldY, footWorldYOf, groundWorldYAt, out);
      }
      i = j + 1;
    }
    // The head run ([0..startIdx−1]) lies BEFORE the scan start, and is only
    // reached through the extension above when it wraps onto the tail. When it
    // does not — index n−1 dry — it is a run of its own.
    if (isLip[0] && !isLip[n - 1] && startIdx >= MIN_LIP_RUN_VERTICES) {
      emitRun(loop, 0, startIdx - 1, ax, az, bands, crestWorldY, footWorldYOf, groundWorldYAt, out);
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
  groundWorldYAt: (cellX: number, cellZ: number) => number,
  out: number[],
): void {
  // Foot band = HIGHEST probed band along the run: this sheet drops ONE
  // terrace step onto water that is really there, and the region it lands on
  // carries the cascade further down (see the doc comment above).
  // Ring positions modulo the loop length: a run that wrapped the seam carries
  // an end index past n−1 (see the run scan).
  const ringLength = loop.length;
  let footBand = -Infinity;
  for (let i = start; i <= end; i++) {
    const b = bands[i % ringLength];
    if (b !== null && b > footBand) footBand = b;
  }
  if (!Number.isFinite(footBand)) return;
  emitSheet(loop, start, end, ax, az, crestWorldY, footBand, footWorldYOf, groundWorldYAt, out);
}
