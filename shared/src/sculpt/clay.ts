import { SMOOTH_LAPLACIAN_PASSES, SMOOTH_LAYER_BAND_REACH } from '../constants.ts';
import { drawnBandOfSample } from '../bands.ts';
import { cellIndex, inBounds, type Heightmap } from '../grid.ts';
import { footprintRadiusSquared, forEachFootprintOffset } from './footprint.ts';
import { graspedCeilingRange, layerSpanIndex } from './grasp.ts';
import { buildLayerView, commitLayerView } from './layerView.ts';

// Player smooth: footprint-only writes. A weighted median moves each contour by
// its curvature; an across-contour term spreads bands apart or together.

/** Lambda is a percent. */
const LAMBDA_FULL = 100;

/** A stroke works in 1/64 height units, so sub-unit moves accumulate; heights round once at the end. */
const WORK_FIXED_POINT = 64;

/** The 3x3 binomial kernel's weights sum to 16. */
const BLUR_WEIGHT = 16;

/** Gradient components are shifted under this before squaring, keeping every product inside 2^53. */
const DIRECTION_LIMIT = 4096;

/** Across-contour step divisors: spreading diffuses, drawing together sharpens more gently (sharpening is ill-posed). */
const SPREAD_ACROSS_DIVISOR = 8;
const TOGETHER_ACROSS_DIVISOR = 32;

/** Median kernel: a two-cell disc, weights falling with distance (index d² → weight). */
const MEDIAN_WEIGHT_BY_DISTANCE_SQUARED: readonly number[] = [4, 3, 2, 0, 1];
const MEDIAN_REACH_CELLS = 2;
const MEDIAN_KERNEL: readonly (readonly [number, number, number])[] = (() => {
  const kernel: [number, number, number][] = [];
  for (let dy = -MEDIAN_REACH_CELLS; dy <= MEDIAN_REACH_CELLS; dy++) {
    for (let dx = -MEDIAN_REACH_CELLS; dx <= MEDIAN_REACH_CELLS; dx++) {
      const weight = MEDIAN_WEIGHT_BY_DISTANCE_SQUARED[dx * dx + dy * dy] ?? 0;
      if (weight > 0) kernel.push([dx, dy, weight]);
    }
  }
  return kernel;
})();
const MEDIAN_TOTAL_WEIGHT = MEDIAN_KERNEL.reduce((sum, [, , w]) => sum + w, 0);

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

const medianValues: number[] = [];
const medianWeights: number[] = [];

/** Weighted median over MEDIAN_KERNEL; insertion order breaks ties, so it is deterministic. */
function weightedMedian(x: number, y: number, here: number, sample: Sample): number {
  medianValues.length = 0;
  medianWeights.length = 0;
  for (const [dx, dy, weight] of MEDIAN_KERNEL) {
    const value = sample(x + dx, y + dy, here);
    let at = medianValues.length;
    while (at > 0 && medianValues[at - 1]! > value) at--;
    medianValues.splice(at, 0, value);
    medianWeights.splice(at, 0, weight);
  }
  let total = 0;
  for (let i = 0; i < medianValues.length; i++) {
    total += medianWeights[i]!;
    if (2 * total >= MEDIAN_TOTAL_WEIGHT) return medianValues[i]!;
  }
  return here;
}

/** Across-contour curvature, direction from the blurred field so noise cannot steer it. */
function acrossCurvature(x: number, y: number, here: number, sample: Sample): number {
  const hxx = sample(x - 1, y, here) - 2 * here + sample(x + 1, y, here);
  const hyy = sample(x, y - 1, here) - 2 * here + sample(x, y + 1, here);
  const hxy4 = sample(x + 1, y + 1, here) - sample(x + 1, y - 1, here) - sample(x - 1, y + 1, here) + sample(x - 1, y - 1, here);
  let gx = blurred(x + 1, y, here, sample) - blurred(x - 1, y, here, sample);
  let gy = blurred(x, y + 1, here, sample) - blurred(x, y - 1, here, sample);
  while (Math.abs(gx) >= DIRECTION_LIMIT || Math.abs(gy) >= DIRECTION_LIMIT) {
    gx = Math.trunc(gx / 2);
    gy = Math.trunc(gy / 2);
  }
  const gradient = gx * gx + gy * gy;
  if (gradient === 0) return roundedQuotient(hxx + hyy, 2);
  // Quadrupled cross difference over the matching 4 * |g|² denominator.
  return roundedQuotient(4 * gx * gx * hxx + 2 * gx * gy * hxy4 + 4 * gy * gy * hyy, 4 * gradient);
}

interface ClayCell {
  readonly k: number;
  readonly x: number;
  readonly y: number;
  /** R² - d²: hand pressure, full at the centre and nothing at the rim. */
  readonly pressure: number;
  readonly lo: number;
  readonly hi: number;
}

export function applyClay(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  spreading: boolean,
  lambdaPct: number,
  spanBand: number | null,
  changed: Set<number>,
): void {
  const size = map.size;
  const firstRow = Math.max(0, cy - radius - MEDIAN_REACH_CELLS);
  const lastRow = Math.min(size - 1, cy + radius + MEDIAN_REACH_CELLS);
  const view = buildLayerView(map, spanBand, firstRow, lastRow, null);
  const heights = view.heights;
  const base = view.base;
  const rimSquared = footprintRadiusSquared(radius);

  const cells: ClayCell[] = [];
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
        const kink = weightedMedian(c.x, c.y, here, sample) - here;
        const across = acrossCurvature(c.x, c.y, here, sample);
        const spacing = spreading ? roundedQuotient(across, SPREAD_ACROSS_DIVISOR) : -roundedQuotient(across, TOGETHER_ACROSS_DIVISOR);
        let next = here + roundedQuotient(lambdaPct * c.pressure * (kink + spacing), LAMBDA_FULL * rimSquared);
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
