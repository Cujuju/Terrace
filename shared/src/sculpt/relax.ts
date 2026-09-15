import { MAX_STEP, RELAX_SLACK, SMOOTH_PASS_LIMIT } from '../constants.ts';
import { drawnBandOfSample } from '../bands.ts';
import { anyColumnLayered, bandFloorHeight } from '../columns.ts';
import { cellX, cellY, type Heightmap } from '../grid.ts';
import { buildLayerView, commitLayerView, LAYER_VIEW_SLACK_ROWS } from './layerView.ts';
import type { AnchoredMelt, LayerView, SpillBand, SpillBoundsOf } from './layerView.ts';

/**
 * Units the melt may still manufacture at one cell: the free side's headroom,
 * what is left of that cell's one-band budget, and its distance to the ceiling.
 */
function meltGrant(melt: AnchoredMelt, index: number, headroom: number, height: number): number {
  const room = melt.room.get(index);
  if (room === undefined) return 0;
  const spent = melt.spent.get(index) ?? 0;
  const budget = room.hi - room.lo - spent;
  const reach = melt.toward > 0 ? room.hi - height : height - room.lo;
  const grant = Math.min(headroom, budget, reach);
  if (grant <= 0) return 0;
  melt.spent.set(index, spent + grant);
  return grant;
}

function movePair(
  cells: Int16Array,
  base: number,
  hiIdx: number,
  loIdx: number,
  e: number,
  boundsOf: SpillBoundsOf | null,
  spanCaps: ReadonlyMap<number, SpillBand> | null,
  melt: AnchoredMelt | null = null,
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
      if (t <= 0) {
        // A held side stops the exchange; the free side still melts toward the
        // stroke's target, and only a cell the stroke itself bounds may do it.
        if (melt !== null) {
          if (melt.toward > 0 && dropCap <= 0 && riseCap > 0) {
            const gain = meltGrant(melt, loIdx, riseCap, cells[lo]);
            if (gain > 0) {
              cells[lo] += gain;
              return true;
            }
          }
          if (melt.toward < 0 && riseCap <= 0 && dropCap > 0) {
            const loss = meltGrant(melt, hiIdx, dropCap, cells[hi]);
            if (loss > 0) {
              cells[hi] -= loss;
              return true;
            }
          }
        }
        return false;
      }
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
  melt: AnchoredMelt | null = null,
): boolean {
  if (layer !== null && (layer.excluded[i - base] === 1 || layer.excluded[j - base] === 1)) return false;
  const spanCaps = layer === null ? null : layer.spanCaps;
  const beforeI = cells[i - base];
  const beforeJ = cells[j - base];
  const d = beforeI - beforeJ;
  let moved = false;
  if (d > MAX_STEP + RELAX_SLACK) {
    moved = movePair(cells, base, i, j, d - MAX_STEP, boundsOf, spanCaps, melt);
  } else if (d < -(MAX_STEP + RELAX_SLACK)) {
    moved = movePair(cells, base, j, i, -d - MAX_STEP, boundsOf, spanCaps, melt);
  }
  if (moved) {
    if (cells[i - base] !== beforeI) changed.add(i);
    if (cells[j - base] !== beforeJ) changed.add(j);
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
  melt: AnchoredMelt | null = null,
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

  let adjustingPasses = 0;
  for (let pass = 0; pass < SMOOTH_PASS_LIMIT; pass++) {
    const heldMinX = minX, heldMinY = minY, heldMaxX = maxX, heldMaxY = maxY;
    if (minX > 0) minX--;
    if (minY > 0) minY--;
    if (maxX < size - 1) maxX++;
    if (maxY < size - 1) maxY++;

    growLayerView();

    if (minY < heldMinY) adoptLayerView(minX, minY, maxX - minX + 1, 1);
    if (maxY > heldMaxY) adoptLayerView(minX, maxY, maxX - minX + 1, 1);
    if (minX < heldMinX) adoptLayerView(minX, heldMinY, 1, heldMaxY - heldMinY + 1);
    if (maxX > heldMaxX) adoptLayerView(maxX, heldMinY, 1, heldMaxY - heldMinY + 1);

    let changedThisPass = false;

    for (let y = minY; y <= maxY; y++) {
      const row = y * size;
      for (let x = minX; x <= maxX; x++) {
        const i = row + x;
        if (x < maxX && relaxPair(cells, viewBase, i, i + 1, changed, boundsOf, layer, melt)) changedThisPass = true;
        if (y < maxY && relaxPair(cells, viewBase, i, i + size, changed, boundsOf, layer, melt)) changedThisPass = true;
      }
    }

    if (!changedThisPass) break;
    adjustingPasses++;
  }
  if (layer !== null) commitLayerView(map, layer, spanBand, changed);
  return adjustingPasses;
}
