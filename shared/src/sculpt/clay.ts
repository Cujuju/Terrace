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

/** The 3x3 binomial kernel's weights sum to 16; blurred values stay scaled by it. */
const BLUR_WEIGHT = 16;

/** 3x3 binomial blur at (x, y), times BLUR_WEIGHT. */
function blurred(x: number, y: number, fallback: number, sample: (x: number, y: number, here: number) => number): number {
  const c = sample(x, y, fallback);
  const at = (dx: number, dy: number): number => sample(x + dx, y + dy, c);
  return 4 * c + 2 * (at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1)) + at(-1, -1) + at(1, -1) + at(-1, 1) + at(1, 1);
}

/** num / den rounded half away from zero, den > 0: a truncated sub-unit step would never move. */
function roundedQuotient(num: number, den: number): number {
  return num >= 0 ? Math.trunc((2 * num + den) / (2 * den)) : -Math.trunc((-2 * num + den) / (2 * den));
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
 * Plain smooth diffuses, spreading bands apart; the other way smooths along
 * contours and sharpens across them, drawing bands together. Both even kinks.
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
  const pressureFull = rimSquared;

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
    const fall = rimSquared - (dx * dx + dy * dy);
    const { lo, hi } = graspedCeilingRange(map, i, span);
    cells.push({ k, x, y, pressure: fall, lo, hi });
  });

  // A neighbour off the map, outside the view, or of another layer reads as the cell itself.
  const sample = (x: number, y: number, here: number): number => {
    if (x < 0 || x >= size || y < firstRow || y > lastRow) return here;
    const n = y * size + x - base;
    return view.excluded[n] === 1 ? here : heights[n]!;
  };

  // A wider hand smooths wider features: one pass per cell of radius.
  const passes = Math.max(SMOOTH_LAPLACIAN_PASSES, radius);
  for (let pass = 0; pass < passes; pass++) {
    // Red-black: a cell reads neighbours of the other colour, settled this pass.
    for (let parity = 0; parity < 2; parity++) {
      for (const c of cells) {
        if (((c.x + c.y) & 1) !== parity) continue;
        const here = heights[c.k]!;
        const w = sample(c.x - 1, c.y, here);
        const e = sample(c.x + 1, c.y, here);
        const n = sample(c.x, c.y - 1, here);
        const s = sample(c.x, c.y + 1, here);
        const nw = sample(c.x - 1, c.y - 1, here);
        const ne = sample(c.x + 1, c.y - 1, here);
        const sw = sample(c.x - 1, c.y + 1, here);
        const se = sample(c.x + 1, c.y + 1, here);
        let flow: number;
        if (spreading) {
          flow = w + e + n + s - 4 * here;
        } else {
          // Direction and curvature from the binomial-blurred field, so noise cannot steer the sharpening.
          const g = (dx: number, dy: number): number => blurred(c.x + dx, c.y + dy, here, sample);
          const gc = g(0, 0);
          const gw = g(-1, 0);
          const ge = g(1, 0);
          const gn = g(0, -1);
          const gs = g(0, 1);
          const hx2 = ge - gw;
          const hy2 = gs - gn;
          const hxx = gw - 2 * gc + ge;
          const hyy = gn - 2 * gc + gs;
          const hxy4 = g(1, 1) - g(1, -1) - g(-1, 1) + g(-1, -1);
          const gradient = hx2 * hx2 + hy2 * hy2;
          // Along-contour minus across-contour curvature, from doubled first and quadrupled cross differences.
          flow = gradient === 0
            ? 0
            : roundedQuotient(
                2 * (hy2 * hy2 - hx2 * hx2) * (hxx - hyy) - 2 * hx2 * hy2 * hxy4,
                2 * gradient * BLUR_WEIGHT,
              );
        }
        const step = roundedQuotient(lambdaPct * c.pressure * flow, LAMBDA_FULL * LAPLACIAN_TO_MEAN * pressureFull);
        if (step === 0) continue;
        let next = here + step;
        if (!spreading) {
          // Sharpening never overshoots the neighbourhood it reads.
          const lowest = Math.min(here, w, e, n, s, nw, ne, sw, se);
          const highest = Math.max(here, w, e, n, s, nw, ne, sw, se);
          if (next < lowest) next = lowest;
          if (next > highest) next = highest;
        }
        if (next < c.lo) next = c.lo;
        if (next > c.hi) next = c.hi;
        if (next === here) continue;
        heights[c.k] = next;
        changed.add(c.k + base);
      }
    }
  }
  commitLayerView(map, view, spanBand, changed);
}
