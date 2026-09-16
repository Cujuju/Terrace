import { MAX_STEP, RELAX_SLACK, SMOOTH_LAPLACIAN_PASSES, SMOOTH_PASS_LIMIT } from '../constants.ts';
import { drawnBandOfSample } from '../bands.ts';
import { anyColumnLayered, bandFloorHeight } from '../columns.ts';
import { cellX, cellY, type Heightmap } from '../grid.ts';
import { buildLayerView, commitLayerView, LAYER_VIEW_SLACK_ROWS } from './layerView.ts';
import type { LayerView, SpillBand, SpillBoundsOf } from './layerView.ts';

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
): boolean {
  // Red-black Gauss-Seidel: even cells read odd neighbours untouched this
  // pass, then odd cells read the new evens. No snapshot copy is allocated.
  const i = y * size + x;
  const k = i - viewBase;
  let sum = 0;
  let count = 0;
  if (x > 0) {
    sum += cells[k - 1];
    count++;
  }
  if (x < size - 1) {
    sum += cells[k + 1];
    count++;
  }
  if (y > 0) {
    sum += cells[k - size];
    count++;
  }
  if (y < size - 1) {
    sum += cells[k + size];
    count++;
  }
  if (count === 0) return false;
  const avg = Math.trunc(sum / count);
  if (avg === cells[k]) return false;
  // Min-one-unit progress: truncation alone stalls above the gradient
  // limit, leaving terracing the smoother was asked to remove.
  let step = Math.trunc(((avg - cells[k]) * pct) / 100);
  if (step === 0) step = avg > cells[k] ? 1 : -1;
  let next = cells[k] + step;
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
  if (next === cells[k]) return false;
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
): boolean {
  let moved = false;
  for (let parity = 0; parity < 2; parity++) {
    for (let y = minY; y <= maxY; y++) {
      const startX = minX + (((minX + y + parity) & 1) === 0 ? 0 : 1);
      for (let x = startX; x <= maxX; x += 2) {
        if (laplacianCell(cells, viewBase, size, x, y, pct, changed, boundsOf, layer === null ? null : layer.spanCaps)) {
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
        const sampled = drawnBandOfSample(cells[index - viewBase]);
        const lo = bandFloorHeight(sampled);
        band = { lo, hi: bandFloorHeight(sampled + 1) - 1 };
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
      );
    }

    if (!changedThisPass) break;
    adjustingPasses++;
  }
  if (layer !== null) commitLayerView(map, layer, spanBand, changed);
  return adjustingPasses;
}
