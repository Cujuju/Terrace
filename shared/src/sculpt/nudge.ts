import { SMOOTH_LAPLACIAN_PASSES, SMOOTH_LAYER_BAND_REACH } from '../constants.ts';
import { drawnBandOfSample } from '../bands.ts';
import { cellIndex, inBounds, type Heightmap } from '../grid.ts';
import { footprintRadiusSquared, forEachFootprintOffset } from './footprint.ts';
import { graspedCeilingRange, layerSpanIndex } from './grasp.ts';
import { buildLayerView, commitLayerView } from './layerView.ts';

// Nudge: footprint-only writes. Across-contour flow spreads bands apart (HUD
// way) or draws them together (the other way); outlines keep their shape.

/** Strength is a percent of a full step. */
const STRENGTH_FULL = 100;

/** A stroke works in 1/64 height units, so sub-unit moves accumulate; heights round once at the end. */
const WORK_FIXED_POINT = 64;

/** Cells past a cell the curvature reads: blurred neighbours one out, each blurring one more. */
const BLUR_REACH_CELLS = 2;

/** The 3x3 binomial kernel's weights sum to 16. */
const BLUR_WEIGHT = 16;

/** Gradient components are shifted under this before squaring, keeping every product inside 2^53. */
const DIRECTION_LIMIT = 4096;

/** Across-contour step divisors: spreading diffuses; drawing together sharpens, which is ill-posed, so it steps gentler. */
const SPREAD_ACROSS_DIVISOR = 2;
const TOGETHER_ACROSS_DIVISOR = 8;

type Sample = (x: number, y: number, here: number) => number;

/** num / den rounded half away from zero, den > 0. */
function roundedQuotient(num: number, den: number): number {
  return num >= 0 ? Math.trunc((2 * num + den) / (2 * den)) : -Math.trunc((-2 * num + den) / (2 * den));
}

/** 3x3 binomial blur at (x, y), times BLUR_WEIGHT. */
function blurred(x: number, y: number, fallback: number, sample: Sample): number {
  const c = sample(x, y, fallback);
  const at = (dx: number, dy: number): number => sample(x + dx, y + dy, c);
  return 4 * c + 2 * (at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1)) + at(-1, -1) + at(1, -1) + at(-1, 1) + at(1, 1);
}

/** Across-contour curvature of the blurred field: nudging moves band spacing, not single-cell detail. */
function acrossCurvature(x: number, y: number, here: number, sample: Sample): number {
  const g = (dx: number, dy: number): number => blurred(x + dx, y + dy, here, sample);
  const gc = g(0, 0);
  const hxx = g(-1, 0) - 2 * gc + g(1, 0);
  const hyy = g(0, -1) - 2 * gc + g(0, 1);
  const hxy4 = g(1, 1) - g(1, -1) - g(-1, 1) + g(-1, -1);
  let gx = g(1, 0) - g(-1, 0);
  let gy = g(0, 1) - g(0, -1);
  while (Math.abs(gx) >= DIRECTION_LIMIT || Math.abs(gy) >= DIRECTION_LIMIT) {
    gx = Math.trunc(gx / 2);
    gy = Math.trunc(gy / 2);
  }
  const gradient = gx * gx + gy * gy;
  if (gradient === 0) return roundedQuotient(hxx + hyy, 2 * BLUR_WEIGHT);
  // Quadrupled cross difference over the matching 4 * |g|² denominator, back out of blur units.
  return roundedQuotient(4 * gx * gx * hxx + 2 * gx * gy * hxy4 + 4 * gy * gy * hyy, 4 * gradient * BLUR_WEIGHT);
}

interface NudgeCell {
  readonly k: number;
  readonly x: number;
  readonly y: number;
  /** R² - d²: hand pressure, full at the centre and nothing at the rim. */
  readonly pressure: number;
  readonly lo: number;
  readonly hi: number;
}

export function applyNudge(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  spreading: boolean,
  strengthPct: number,
  spanBand: number | null,
  changed: Set<number>,
): void {
  const size = map.size;
  const firstRow = Math.max(0, cy - radius - BLUR_REACH_CELLS);
  const lastRow = Math.min(size - 1, cy + radius + BLUR_REACH_CELLS);
  const view = buildLayerView(map, spanBand, firstRow, lastRow, null);
  const heights = view.heights;
  const base = view.base;
  const rimSquared = footprintRadiusSquared(radius);

  const cells: NudgeCell[] = [];
  forEachFootprintOffset(radius, (dx, dy) => {
    const x = cx + dx;
    const y = cy + dy;
    if (!inBounds(map, x, y)) return;
    const i = cellIndex(map, x, y);
    const k = i - base;
    if (view.excluded[k] === 1) return;
    // A wall above the grasped layer is another layer's ground: it votes but holds still.
    if (spanBand !== null && drawnBandOfSample(heights[k]!) - spanBand > SMOOTH_LAYER_BAND_REACH) return;
    const span = map.columnSpans.has(i) ? layerSpanIndex(map, i, spanBand) : 0;
    if (span === null) return;
    const { lo, hi } = graspedCeilingRange(map, i, span);
    cells.push({ k, x, y, pressure: rimSquared - (dx * dx + dy * dy), lo: lo * WORK_FIXED_POINT, hi: hi * WORK_FIXED_POINT });
  });

  const work = new Int32Array(heights.length);
  for (let k = 0; k < heights.length; k++) work[k] = heights[k]! * WORK_FIXED_POINT;

  // A neighbour off the map, outside the view, or of another layer reads as the cell itself.
  const sample = (x: number, y: number, here: number): number => {
    if (x < 0 || x >= size || y < firstRow || y > lastRow) return here;
    const n = y * size + x - base;
    return view.excluded[n] === 1 ? here : work[n]!;
  };

  // A wider hand smooths wider features: one pass per cell of radius.
  const passes = Math.max(SMOOTH_LAPLACIAN_PASSES, radius);
  for (let pass = 0; pass < passes; pass++) {
    // Red-black: a cell reads neighbours of the other colour, settled this pass.
    for (let parity = 0; parity < 2; parity++) {
      for (const c of cells) {
        if (((c.x + c.y) & 1) !== parity) continue;
        const here = work[c.k]!;
        const across = acrossCurvature(c.x, c.y, here, sample);
        const spacing = spreading ? roundedQuotient(across, SPREAD_ACROSS_DIVISOR) : -roundedQuotient(across, TOGETHER_ACROSS_DIVISOR);
        let next = here + roundedQuotient(strengthPct * c.pressure * spacing, STRENGTH_FULL * rimSquared);
        if (!spreading) {
          // Sharpening never overshoots the neighbourhood it reads.
          let lowest = here;
          let highest = here;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const v = sample(c.x + dx, c.y + dy, here);
              if (v < lowest) lowest = v;
              if (v > highest) highest = v;
            }
          }
          if (next < lowest) next = lowest;
          if (next > highest) next = highest;
        }
        if (next < c.lo) next = c.lo;
        if (next > c.hi) next = c.hi;
        work[c.k] = next;
      }
    }
  }

  for (const c of cells) {
    const settled = roundedQuotient(work[c.k]!, WORK_FIXED_POINT);
    if (settled === heights[c.k]) continue;
    heights[c.k] = settled;
    changed.add(c.k + base);
  }
  commitLayerView(map, view, spanBand, changed);
}
