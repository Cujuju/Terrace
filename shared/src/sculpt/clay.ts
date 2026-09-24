import { SMOOTH_LAPLACIAN_PASSES, SMOOTH_LAYER_BAND_REACH } from '../constants.ts';
import { drawnBandOfSample } from '../bands.ts';
import { cellIndex, inBounds, type Heightmap } from '../grid.ts';
import { footprintRadiusSquared, forEachFootprintOffset } from './footprint.ts';
import { graspedCeilingRange, layerSpanIndex } from './grasp.ts';
import { buildLayerView, commitLayerView } from './layerView.ts';

// Player smooth, "a hand across clay": continuous heights, footprint-only writes.

/** Lambda is a percent; a full step lands a cell on its four-neighbour mean, a quarter of the Laplacian. */
const LAMBDA_FULL = 100;
const LAPLACIAN_TO_MEAN = 4;

/** A stroke works in 1/64 height units, so sub-unit curvature keeps moving; heights round once at the end. */
const WORK_FIXED_POINT = 64;

/** The 3x3 binomial kernel's weights sum to 16. */
const BLUR_WEIGHT = 16;

/** Gradient components are shifted under this before squaring, keeping every product inside 2^53. */
const DIRECTION_LIMIT = 4096;

/** Across-contour flow is a fraction of the along-contour term, so kinks go before spacing changes. */
const SPREAD_ACROSS_DIVISOR = 2;
/** Sharpening is ill-posed: past an eighth it outruns the kink smoothing and carves grid-aligned plateaus. */
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

/**
 * Along-contour curvature plus (spreading) or minus (drawing together) a fraction
 * of the across-contour curvature. Direction from the blurred field; curvature raw.
 */
function contourFlow(
  x: number, y: number, here: number,
  w: number, e: number, n: number, s: number,
  nw: number, ne: number, sw: number, se: number,
  spreading: boolean,
  sample: Sample,
): number {
  const hxx = w - 2 * here + e;
  const hyy = n - 2 * here + s;
  const hxy4 = se - ne - sw + nw;
  let gx = blurred(x + 1, y, here, sample) - blurred(x - 1, y, here, sample);
  let gy = blurred(x, y + 1, here, sample) - blurred(x, y - 1, here, sample);
  while (Math.abs(gx) >= DIRECTION_LIMIT || Math.abs(gy) >= DIRECTION_LIMIT) {
    gx = Math.trunc(gx / 2);
    gy = Math.trunc(gy / 2);
  }
  const gradient = gx * gx + gy * gy;
  let along: number;
  let across: number;
  if (gradient === 0) {
    along = roundedQuotient(hxx + hyy, 2);
    across = along;
  } else {
    // Quadrupled cross difference, so the tangent and normal forms share the 4 * |g|² denominator.
    along = roundedQuotient(4 * gy * gy * hxx - 2 * gx * gy * hxy4 + 4 * gx * gx * hyy, 4 * gradient);
    across = roundedQuotient(4 * gx * gx * hxx + 2 * gx * gy * hxy4 + 4 * gy * gy * hyy, 4 * gradient);
  }
  return along + (spreading ? roundedQuotient(across, SPREAD_ACROSS_DIVISOR) : -roundedQuotient(across, TOGETHER_ACROSS_DIVISOR));
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

/**
 * Plain smooth spreads bands apart; the other way draws them together. Both
 * straighten contours first, so kinks go before spacing changes.
 */
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
  const firstRow = Math.max(0, cy - radius);
  const lastRow = Math.min(size - 1, cy + radius);
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
        const w = sample(c.x - 1, c.y, here);
        const e = sample(c.x + 1, c.y, here);
        const n = sample(c.x, c.y - 1, here);
        const s = sample(c.x, c.y + 1, here);
        const nw = sample(c.x - 1, c.y - 1, here);
        const ne = sample(c.x + 1, c.y - 1, here);
        const sw = sample(c.x - 1, c.y + 1, here);
        const se = sample(c.x + 1, c.y + 1, here);
        const flow = contourFlow(c.x, c.y, here, w, e, n, s, nw, ne, sw, se, spreading, sample);
        let next = here + roundedQuotient(lambdaPct * c.pressure * flow, LAMBDA_FULL * LAPLACIAN_TO_MEAN * rimSquared);
        // Neither flow overshoots the neighbourhood it reads.
        const lowest = Math.min(here, w, e, n, s, nw, ne, sw, se);
        const highest = Math.max(here, w, e, n, s, nw, ne, sw, se);
        if (next < lowest) next = lowest;
        if (next > highest) next = highest;
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
