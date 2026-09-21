import { BAND_HEIGHT, MAX_STEP, RELAX_SLACK, SMOOTH_LAPLACIAN_PASSES, SMOOTH_PASS_LIMIT } from '../constants.ts';
import { drawnBandOfSample } from '../bands.ts';
import { anyColumnLayered, bandFloorHeight } from '../columns.ts';
import { cellX, cellY, type Heightmap } from '../grid.ts';
import { buildLayerView, commitLayerView, LAYER_VIEW_SLACK_ROWS } from './layerView.ts';
import type { LayerView, SpillBand, SpillBoundsOf } from './layerView.ts';
import type { SmoothKernel } from './options.ts';

// Reused median voter buffer: smooth() runs synchronously, so sharing one
// avoids an allocation per cell per pass.
const medianScratch: number[] = [];

function movePair(
  cells: Int16Array,
  base: number,
  hiIdx: number,
  loIdx: number,
  e: number,
  boundsOf: SpillBoundsOf | null,
  spanCaps: ReadonlyMap<number, SpillBand> | null,
): boolean {
  const hi = hiIdx - base;
  const lo = loIdx - base;
  let drop = e >> 1;
  let rise = drop;
  if (boundsOf !== null || spanCaps !== null) {
    const hiBand = boundsOf === null ? null : boundsOf(hiIdx);
    const loBand = boundsOf === null ? null : boundsOf(loIdx);
    let dropCap = hiBand === null ? drop : Math.min(drop, cells[hi] - hiBand.lo);
    let riseCap = loBand === null ? rise : Math.min(rise, loBand.hi - cells[lo]);
    const hiSpan = spanCaps === null ? undefined : spanCaps.get(hiIdx);
    const loSpan = spanCaps === null ? undefined : spanCaps.get(loIdx);
    if (hiSpan !== undefined) dropCap = Math.min(dropCap, cells[hi] - hiSpan.lo);
    if (loSpan !== undefined) riseCap = Math.min(riseCap, loSpan.hi - cells[lo]);
    if (dropCap < drop || riseCap < rise) {
      const t = Math.min(dropCap, riseCap);
      // A held side stops the exchange outright: relaxation only moves height.
      if (t <= 0) return false;
      drop = t;
      rise = t;
    }
    if (drop === 0 && rise === 0) return false;
  }
  cells[hi] -= drop;
  cells[lo] += rise;
  return true;
}

function relaxPair(
  cells: Int16Array,
  base: number,
  i: number,
  j: number,
  changed: Set<number>,
  boundsOf: SpillBoundsOf | null,
  layer: LayerView | null,
): boolean {
  if (layer !== null && (layer.excluded[i - base] === 1 || layer.excluded[j - base] === 1)) return false;
  const spanCaps = layer === null ? null : layer.spanCaps;
  const beforeI = cells[i - base];
  const beforeJ = cells[j - base];
  const d = beforeI - beforeJ;
  let moved = false;
  if (d > MAX_STEP + RELAX_SLACK) {
    moved = movePair(cells, base, i, j, d - MAX_STEP, boundsOf, spanCaps);
  } else if (d < -(MAX_STEP + RELAX_SLACK)) {
    moved = movePair(cells, base, j, i, -d - MAX_STEP, boundsOf, spanCaps);
  }
  if (moved) {
    if (cells[i - base] !== beforeI) changed.add(i);
    if (cells[j - base] !== beforeJ) changed.add(j);
  }
  return moved;
}

/** Radial rim shaping for the player melt: full across the footprint. */
export interface SmoothFalloff {
  readonly cx: number;
  readonly cy: number;
  readonly reach: number;
  /** Feather width as percent of reach, 0..100. The centre stays full. */
  readonly feather: number;
  /** Rim clamp taper as percent of reach, 0..100. 0 keeps the band clamp. */
  readonly rim: number;
}

function brushDist(cx: number, cy: number, x: number, y: number): number {
  const dx = x - cx;
  const dy = y - cy;
  return Math.floor(Math.sqrt(dx * dx + dy * dy));
}

// Round-half-even of num/den for den > 0: halves go to the even neighbour,
// killing truncation's drift toward zero. Exact integer math either way.
function divHalfEven(num: number, den: number): number {
  const q = Math.trunc(num / den);
  const twice = (num - q * den) * 2;
  if (twice > den) return q + 1;
  if (twice < -den) return q - 1;
  if (twice === den || twice === -den) {
    if ((q & 1) !== 0) return q + (num >= 0 ? 1 : -1);
  }
  return q;
}

// Plateau falloff: full strength inside the footprint so the clicked cell
// co-moves with its patch; only the outer feather percent fades to the rim.
function falloffStrength(pct: number, falloff: SmoothFalloff, x: number, y: number): number {
  const dist = brushDist(falloff.cx, falloff.cy, x, y);
  const widthCells = Math.trunc((falloff.feather * falloff.reach) / 100);
  const featherStart = Math.max(falloff.reach - widthCells, 0);
  if (dist <= featherStart) return pct;
  if (dist >= falloff.reach) return 0;
  return Math.trunc((pct * (falloff.reach - dist)) / (falloff.reach - featherStart));
}

// Rim taper: the halo clamp shrinks from the full drawn band toward the
// sampled height as the reach edge nears. Integer-exact like the taper.
function rimBand(h: number, lo: number, hi: number, dist: number, reach: number, rimPct: number): SpillBand {
  const widthCells = Math.trunc((rimPct * reach) / 100);
  const taperStart = Math.max(reach - widthCells, 0);
  if (dist <= taperStart) return { lo, hi };
  const allow = Math.trunc((BAND_HEIGHT * (reach - dist)) / (reach - taperStart));
  return { lo: Math.max(lo, h - allow), hi: Math.min(hi, h + allow) };
}

function laplacianCell(
  cells: Int16Array,
  viewBase: number,
  size: number,
  x: number,
  y: number,
  pct: number,
  changed: Set<number>,
  boundsOf: SpillBoundsOf | null,
  spanCaps: ReadonlyMap<number, SpillBand> | null,
  falloff: SmoothFalloff | null = null,
  kernel: SmoothKernel = 'cross',
  bilateral = false,
  fullSteps = false,
  unbiased = false,
): boolean {
  // Red-black Gauss-Seidel: even cells read odd neighbours untouched this
  // pass, then odd cells read the new evens. No snapshot copy is allocated.
  const i = y * size + x;
  const k = i - viewBase;
  const here = cells[k];
  // Bilateral gating: neighbours past one band sit out, so terraces blend
  // along themselves instead of dragging across cliffs. The divisor
  // renormalizes over whoever votes.
  const votes = (h: number): boolean => !bilateral || Math.abs(h - here) <= BAND_HEIGHT;
  let avg: number;
  if (kernel === 'gauss') {
    // 3x3 binomial: centre 4, cardinals 2, diagonals 1, divisor 16.
    // Missing edge neighbours drop out; the divisor renormalizes over the
    // remaining voters, keeping the average exact in integer math.
    let num = 4 * here;
    let den = 4;
    if (x > 0 && votes(cells[k - 1])) {
      num += 2 * cells[k - 1];
      den += 2;
    }
    if (x < size - 1 && votes(cells[k + 1])) {
      num += 2 * cells[k + 1];
      den += 2;
    }
    if (y > 0 && votes(cells[k - size])) {
      num += 2 * cells[k - size];
      den += 2;
    }
    if (y < size - 1 && votes(cells[k + size])) {
      num += 2 * cells[k + size];
      den += 2;
    }
    if (x > 0 && y > 0 && votes(cells[k - size - 1])) {
      num += cells[k - size - 1];
      den += 1;
    }
    if (x < size - 1 && y > 0 && votes(cells[k - size + 1])) {
      num += cells[k - size + 1];
      den += 1;
    }
    if (x > 0 && y < size - 1 && votes(cells[k + size - 1])) {
      num += cells[k + size - 1];
      den += 1;
    }
    if (x < size - 1 && y < size - 1 && votes(cells[k + size + 1])) {
      num += cells[k + size + 1];
      den += 1;
    }
    if (den === 4) return false;
    avg = unbiased ? divHalfEven(num, den) : Math.trunc(num / den);
  } else if (kernel === 'median') {
    // Median over the gated 3x3: deletes speckle symmetrically, with no
    // shrink and no drift. Lower median of an even voter count.
    medianScratch.length = 0;
    medianScratch.push(here);
    if (x > 0 && votes(cells[k - 1])) medianScratch.push(cells[k - 1]);
    if (x < size - 1 && votes(cells[k + 1])) medianScratch.push(cells[k + 1]);
    if (y > 0 && votes(cells[k - size])) medianScratch.push(cells[k - size]);
    if (y < size - 1 && votes(cells[k + size])) medianScratch.push(cells[k + size]);
    if (x > 0 && y > 0 && votes(cells[k - size - 1])) medianScratch.push(cells[k - size - 1]);
    if (x < size - 1 && y > 0 && votes(cells[k - size + 1])) medianScratch.push(cells[k - size + 1]);
    if (x > 0 && y < size - 1 && votes(cells[k + size - 1])) medianScratch.push(cells[k + size - 1]);
    if (x < size - 1 && y < size - 1 && votes(cells[k + size + 1])) medianScratch.push(cells[k + size + 1]);
    medianScratch.sort((a, b) => a - b);
    avg = medianScratch[(medianScratch.length - 1) >> 1];
  } else {
    let sum = 0;
    let count = 0;
    if (x > 0 && votes(cells[k - 1])) {
      sum += cells[k - 1];
      count++;
    }
    if (x < size - 1 && votes(cells[k + 1])) {
      sum += cells[k + 1];
      count++;
    }
    if (y > 0 && votes(cells[k - size])) {
      sum += cells[k - size];
      count++;
    }
    if (y < size - 1 && votes(cells[k + size])) {
      sum += cells[k + size];
      count++;
    }
    if (count === 0) return false;
    avg = unbiased ? divHalfEven(sum, count) : Math.trunc(sum / count);
  }
  if (avg === here) return false;
  const eff = falloff === null ? pct : falloffStrength(pct, falloff, x, y);
  if (eff <= 0) return false;
  // Min-one-unit progress: truncation alone stalls above the gradient
  // limit. Full steps gate the dust: sub-unit pulls stay put.
  let step = Math.trunc(((avg - here) * eff) / 100);
  if (step === 0 && !fullSteps) step = avg > here ? 1 : -1;
  let next = here + step;
  const band = boundsOf === null ? null : boundsOf(i);
  if (band !== null) {
    if (next < band.lo) next = band.lo;
    if (next > band.hi) next = band.hi;
  }
  const cap = spanCaps === null ? undefined : spanCaps.get(i);
  if (cap !== undefined) {
    if (next < cap.lo) next = cap.lo;
    if (next > cap.hi) next = cap.hi;
  }
  if (next === here) return false;
  cells[k] = next;
  changed.add(i);
  return true;
}

function laplacianPass(
  cells: Int16Array,
  viewBase: number,
  size: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  pct: number,
  changed: Set<number>,
  boundsOf: SpillBoundsOf | null,
  layer: LayerView | null,
  falloff: SmoothFalloff | null = null,
  kernel: SmoothKernel = 'cross',
  bilateral = false,
  fullSteps = false,
  unbiased = false,
): boolean {
  let moved = false;
  for (let parity = 0; parity < 2; parity++) {
    for (let y = minY; y <= maxY; y++) {
      const startX = minX + (((minX + y + parity) & 1) === 0 ? 0 : 1);
      for (let x = startX; x <= maxX; x += 2) {
        if (laplacianCell(cells, viewBase, size, x, y, pct, changed, boundsOf, layer === null ? null : layer.spanCaps, falloff, kernel, bilateral, fullSteps, unbiased)) {
          moved = true;
        }
      }
    }
  }
  return moved;
}

export function smooth(
  map: Heightmap,
  changed: Set<number>,
  bboxSeed?: ReadonlySet<number>,
  spillFree?: ReadonlySet<number>,
  anchorBounds?: ReadonlyMap<number, SpillBand>,
  spanBand: number | null = null,
  reachCells: number | null = null,
  laplacePct: number | null = null,
  falloff: SmoothFalloff | null = null,
  kernel: SmoothKernel = 'cross',
  bilateral = false,
  fullSteps = false,
  cooldown = false,
  unbiased = false,
): number {
  const seed = bboxSeed ?? changed;
  if (seed.size === 0) return 0;

  const { size } = map;
  let layer: LayerView | null = null;
  let cells: Int16Array = map.cells;
  let viewBase = 0;

  const rebuildLayerView = (previous: LayerView | null): void => {
    const slack = previous === null
      ? LAYER_VIEW_SLACK_ROWS
      : Math.max(LAYER_VIEW_SLACK_ROWS, previous.lastRow - previous.firstRow + 1);
    let first = minY;
    let last = maxY;
    if (previous === null) {
      for (const i of changed) {
        const y = cellY(size, i);
        if (y < first) first = y;
        if (y > last) last = y;
      }
    } else {
      if (previous.firstRow < first) first = previous.firstRow;
      if (previous.lastRow > last) last = previous.lastRow;
    }
    first = Math.max(0, first - slack);
    last = Math.min(size - 1, last + slack);
    layer = buildLayerView(map, spanBand, first, last, previous);
    cells = layer.heights;
    viewBase = layer.base;
  };

  const growLayerView = (): void => {
    if (layer === null) return;
    if (minY < layer.firstRow || maxY > layer.lastRow) rebuildLayerView(layer);
  };

  const adoptLayerView = (x0: number, y0: number, width: number, height: number): void => {
    if (layer !== null) return;
    if (spanBand === null && !anyColumnLayered(map, x0, y0, width, height)) return;
    rebuildLayerView(null);
  };

  let boundsOf: SpillBoundsOf | null = null;
  if (spillFree !== undefined || anchorBounds !== undefined) {
    const captured = new Map<number, SpillBand>();
    boundsOf = (index: number): SpillBand | null => {
      const anchored = anchorBounds?.get(index);
      if (anchored !== undefined) return anchored;
      if (spillFree === undefined || spillFree.has(index)) return null;
      let band = captured.get(index);
      if (band === undefined) {
        const h = cells[index - viewBase];
        const sampled = drawnBandOfSample(h);
        const lo = bandFloorHeight(sampled);
        const hi = bandFloorHeight(sampled + 1) - 1;
        if (falloff === null || falloff.rim <= 0) {
          band = { lo, hi };
        } else {
          const dist = brushDist(falloff.cx, falloff.cy, cellX(size, index), cellY(size, index));
          band = rimBand(h, lo, hi, dist, falloff.reach, falloff.rim);
        }
        captured.set(index, band);
      }
      return band;
    };
  }

  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (const i of seed) {
    const x = cellX(size, i);
    const y = cellY(size, i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  adoptLayerView(minX, minY, maxX - minX + 1, maxY - minY + 1);

  // The cascade may leave the seed by at most reachCells. A pair straddling
  // that edge stays as it is, the same accepted residual as the pass cap.
  const reachMinX = reachCells === null ? 0 : Math.max(0, minX - reachCells);
  const reachMinY = reachCells === null ? 0 : Math.max(0, minY - reachCells);
  const reachMaxX = reachCells === null ? size - 1 : Math.min(size - 1, maxX + reachCells);
  const reachMaxY = reachCells === null ? size - 1 : Math.min(size - 1, maxY + reachCells);

  let adjustingPasses = 0;
  const passLimit = laplacePct === null ? SMOOTH_PASS_LIMIT : SMOOTH_LAPLACIAN_PASSES;
  for (let pass = 0; pass < passLimit; pass++) {
    const heldMinX = minX, heldMinY = minY, heldMaxX = maxX, heldMaxY = maxY;
    if (minX > reachMinX) minX--;
    if (minY > reachMinY) minY--;
    if (maxX < reachMaxX) maxX++;
    if (maxY < reachMaxY) maxY++;

    growLayerView();

    if (minY < heldMinY) adoptLayerView(minX, minY, maxX - minX + 1, 1);
    if (maxY > heldMaxY) adoptLayerView(minX, maxY, maxX - minX + 1, 1);
    if (minX < heldMinX) adoptLayerView(minX, heldMinY, 1, heldMaxY - heldMinY + 1);
    if (maxX > heldMaxX) adoptLayerView(maxX, heldMinY, 1, heldMaxY - heldMinY + 1);

    let changedThisPass = false;

    if (laplacePct === null) {
      for (let y = minY; y <= maxY; y++) {
        const row = y * size;
        for (let x = minX; x <= maxX; x++) {
          const i = row + x;
          if (x < maxX && relaxPair(cells, viewBase, i, i + 1, changed, boundsOf, layer)) changedThisPass = true;
          if (y < maxY && relaxPair(cells, viewBase, i, i + size, changed, boundsOf, layer)) changedThisPass = true;
        }
      }
    } else {
      changedThisPass = laplacianPass(
        cells,
        viewBase,
        size,
        minX,
        minY,
        maxX,
        maxY,
        laplacePct,
        changed,
        boundsOf,
        layer,
        falloff,
        kernel,
        bilateral,
        // Cool-down: the first pass melts with unit steps, later passes
        // settle without etching.
        fullSteps || (cooldown && pass > 0),
        unbiased,
      );
    }

    if (!changedThisPass) break;
    adjustingPasses++;
  }
  if (layer !== null) commitLayerView(map, layer, spanBand, changed);
  return adjustingPasses;
}
